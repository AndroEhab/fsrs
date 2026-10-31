/**
 * .apkg (Anki package) parsing and building — SQLite collection reading and
 * writing via Node's built-in `node:sqlite` (DatabaseSync).
 *
 * The `collection.anki2` member is a SQLite database in Anki's collection
 * schema (col/notes/cards/revlog — see genanki / Anki's storage layer).
 * This module:
 *  - IMPORT: extracts the member from the ZIP (bounded), writes it to one
 *    private temp file, opens it READ-ONLY with DatabaseSync, reads notes +
 *    their first card, converts HTML fields to plain text, closes, and
 *    deletes the temp file (finally). Deterministic: notes ordered by note
 *    id, deduped by guid (first wins), one flashcard per note.
 *  - EXPORT: builds a fresh in-memory Anki collection, VACUUM INTOs it to a
 *    private temp file, reads the bytes, deletes the temp file (finally),
 *    and returns the .apkg ZIP (collection.anki2 + media + media map).
 *
 * Why temp files: `node:sqlite` can only open a database from a filesystem
 * path (no byte-buffer VFS), and SQLite refuses to VACUUM INTO an in-memory
 * URI. Temp files are private (random name in os.tmpdir, 0600), bounded by
 * our caps, exist only for the duration of the request, and are unlinked in
 * a finally with a retry — no shelling out, no user-visible paths, and the
 * import database is never opened for writing.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import {
  ANKI_DECK_PATH_MAX, ANKI_IMPORT_CARD_LIMIT, ANKI_MAX_APKG_BYTES,
  ANKI_MAX_APKG_BASE64_LENGTH, ANKI_MAX_FIELD_SOURCE_LENGTH, ANKI_MAX_METADATA_BYTES, ANKI_MAX_TAG_SOURCE_LENGTH,
  ANKI_TAG_MAX_COUNT, ANKI_TAG_MAX_LENGTH, ANKI_MAX_COLLECTION_BYTES,
  ANKI_MAX_EXPORTED_APKG_BYTES, ANKI_EXPORT_CARD_LIMIT, ANKI_MAX_MEDIA_BYTES,
  ANKI_MAX_MEDIA_COUNT, ANKI_MAX_TOTAL_MEDIA_BYTES,
  ImportedCard, ParsedApkgImport, ExportedMedia,
} from './types';
import {
  ankiHtmlToPlainText, isClozeFront, normalizePlainText, normalizeTag,
  plainTextToAnkiHtml, splitAnkiTags, validatePlainText,
} from './text';
import { ApkgFormatError, decodeApkg, encodeApkg } from './zip';

/** The collection member name inside a .apkg. */
const COLLECTION_MEMBER = 'collection.anki2';


/** Export model ids (arbitrary but stable so re-exports are deterministic). */
const MODEL_QA_ID = 1650_000_001;
const MODEL_CLOZE_ID = 1650_000_002;

/* ------------------------------------------------------------------ */
/* Temp-file lifecycle                                                  */
/* ------------------------------------------------------------------ */

/** One private temp dir per request (cleaned up in finally). */
interface TempDir {
  dir: string;
  cleanup(): void;
}

function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), 'fsrs-apkg-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; the OS tmp cleaner eventually reclaims it
      }
    },
  };
}

/** Writes bytes to a temp file path (0600 private). */
function writeTemp(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Validates the top-level import envelope (before any ZIP/SQLite work).
 * Returns the decoded package bytes or an error message. Strict base64 with
 * a decoded-size cap keeps malformed/hostile payloads out before inflate.
 */
export function decodeImportEnvelope(packageB64: string): { bytes: Uint8Array } | { error: string } {
  if (typeof packageB64 !== 'string' || packageB64 === '') {
    return { error: 'package is required (base64-encoded .apkg)' };
  }
  if (packageB64.length > ANKI_MAX_APKG_BASE64_LENGTH) {
    return { error: `package too large (base64 length exceeds ${ANKI_MAX_APKG_BASE64_LENGTH})` };
  }
  if (packageB64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packageB64)) {
    return { error: 'package is not valid base64' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(packageB64, 'base64');
  } catch {
    return { error: 'package is not valid base64' };
  }
  if (bytes.length === 0) return { error: 'package is empty' };
  if (bytes.length > ANKI_MAX_APKG_BYTES) {
    return { error: `package too large (${bytes.length} bytes > ${ANKI_MAX_APKG_BYTES})` };
  }
  return { bytes };
}

function sqliteFormatError(error: unknown): ApkgFormatError | null {
  if (typeof error !== 'object' || error === null) return null;
  const detail = error as { code?: unknown; errcode?: unknown; message?: unknown };
  if (detail.code !== 'ERR_SQLITE_ERROR' || typeof detail.message !== 'string') return null;
  const code = typeof detail.errcode === 'number' ? detail.errcode : 0;
  const primaryCode = code & 0xff;
  const schemaOrCorruption = primaryCode === 11 || primaryCode === 17 || primaryCode === 26;
  const missingSchemaObject = code === 1
    && /^(no such (table|column)|malformed database schema|database disk image is malformed)/i.test(detail.message);
  return schemaOrCorruption || missingSchemaObject
    ? new ApkgFormatError(`Cannot read collection.anki2: ${detail.message}`)
    : null;
}

function rethrowSqliteAsPackageError(error: unknown): never {
  const formatError = sqliteFormatError(error);
  if (formatError) throw formatError;
  throw error;
}
function* packageRows<T>(rows: Iterable<T>): Generator<T> {
  try {
    for (const row of rows) yield row;
  } catch (error) {
    rethrowSqliteAsPackageError(error);
  }
}


/** Opens a collection.anki2 member read-only via a private temp file. */
function openCollectionReadonly(member: Uint8Array, temp: TempDir): DatabaseSync {
  const path = join(temp.dir, 'collection.anki2');
  writeTemp(path, member);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    rethrowSqliteAsPackageError(error);
  }
  try {
    const required: Record<string, Set<string>> = {
      col: new Set(['models', 'decks']),
      notes: new Set(['id', 'guid', 'mid', 'tags', 'flds']),
      cards: new Set(['nid', 'did', 'ord']),
    };
    const objects = new Map(
      (db.prepare('PRAGMA main.table_list').all() as Array<{ name: string; type: string }>)
        .map((row) => [row.name, row.type]),
    );
    for (const [table, columns] of Object.entries(required)) {
      if (objects.get(table) !== 'table') {
        throw new ApkgFormatError(`collection.anki2 is not an Anki collection (invalid ${table} object)`);
      }
      const present = new Set(
        (db.prepare(`PRAGMA main.table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      if ([...columns].some((column) => !present.has(column))) {
        throw new ApkgFormatError(`collection.anki2 is not an Anki collection (invalid ${table} schema)`);
      }
    }
  } catch (error) {
    db.close();
    if (error instanceof ApkgFormatError) throw error;
    rethrowSqliteAsPackageError(error);
  }
  return db;
}

interface BoundedNoteRow {
  id: unknown;
  mid: unknown;
  idType: string;
  midType: string;
  guidType: string;
  tagsType: string;
  fldsType: string;
  tagsBytes: number | null;
  fldsBytes: number | null;
  tags: string | null;
  fldsValue: Uint8Array | null;
  qIndex: unknown;
  aIndex: unknown;
  isCloze: unknown;
  cardOrd: number | null;
  cardOrdType: string | null;
  did: unknown;
  didType: string | null;
  cardCount: number | null;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EMPTY_FIELD_BYTES = new Uint8Array(0);

function selectFieldBytes(source: Uint8Array, qIndex: number, aIndex: number): {
  front: Uint8Array;
  back: Uint8Array;
} {
  let fieldIndex = 0;
  let fieldStart = 0;
  let firstStart = 0;
  let firstEnd = 0;
  let secondStart = 0;
  let secondEnd = 0;
  let questionStart = 0;
  let questionEnd = 0;
  let answerStart = 0;
  let answerEnd = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] !== 0x1f) continue;
    if (fieldIndex === 0) { firstStart = fieldStart; firstEnd = offset; }
    if (fieldIndex === 1) { secondStart = fieldStart; secondEnd = offset; }
    if (fieldIndex === qIndex) { questionStart = fieldStart; questionEnd = offset; }
    if (fieldIndex === aIndex) { answerStart = fieldStart; answerEnd = offset; }
    fieldIndex += 1;
    fieldStart = offset + 1;
  }
  if (fieldIndex === 0) { firstStart = fieldStart; firstEnd = source.length; }
  if (fieldIndex === 1) { secondStart = fieldStart; secondEnd = source.length; }
  if (fieldIndex === qIndex) { questionStart = fieldStart; questionEnd = source.length; }
  if (fieldIndex === aIndex) { answerStart = fieldStart; answerEnd = source.length; }
  const fieldCount = fieldIndex + 1;
  const effectiveQIndex = qIndex >= 0 && qIndex < fieldCount ? qIndex : 0;
  const effectiveAIndex = aIndex >= 0 && aIndex < fieldCount && aIndex !== effectiveQIndex
    ? aIndex
    : fieldCount > 1 ? 1 : -1;
  const front = effectiveQIndex === qIndex
    ? source.subarray(questionStart, questionEnd)
    : source.subarray(firstStart, firstEnd);
  if (effectiveAIndex < 0) return { front, back: EMPTY_FIELD_BYTES };
  const back = effectiveAIndex === aIndex
    ? source.subarray(answerStart, answerEnd)
    : source.subarray(secondStart, secondEnd);
  return { front, back };
}

/** Converts the one active native Anki deletion ordinal to product markers. */
function nativeClozeToProduct(source: string, activeOrdinal: number): string {
  let output = '';
  let index = 0;
  let activeMatches = 0;
  while (index < source.length) {
    if (source.startsWith('}}', index)) {
      throw new ApkgFormatError('Anki cloze text has malformed deletion markup');
    }
    if (source[index] === '[' || source[index] === ']') {
      throw new ApkgFormatError('Anki cloze text contains unsupported literal square brackets');
    }
    if (!source.startsWith('{{', index)) {
      output += source[index];
      index += 1;
      continue;
    }
    if (source[index + 2] !== 'c') {
      throw new ApkgFormatError('Anki cloze text contains unsupported nested or malformed markup');
    }
    let cursor = index + 3;
    const digitsStart = cursor;
    while (cursor < source.length && source.charCodeAt(cursor) >= 48 && source.charCodeAt(cursor) <= 57) {
      cursor += 1;
    }
    if (cursor === digitsStart || !source.startsWith('::', cursor)) {
      throw new ApkgFormatError('Anki cloze text has malformed deletion markup');
    }
    const ordinal = Number(source.slice(digitsStart, cursor));
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new ApkgFormatError('Anki cloze text has an invalid deletion ordinal');
    }
    const answerStart = cursor + 2;
    const end = source.indexOf('}}', answerStart);
    const nestedStart = source.indexOf('{{', answerStart);
    if (end < 0 || (nestedStart >= 0 && nestedStart < end)) {
      throw new ApkgFormatError('Anki cloze text has unsupported nested or malformed deletion markup');
    }
    const answer = source.slice(answerStart, end);
    if (answer.includes('::')) {
      throw new ApkgFormatError('Anki cloze hints are not supported');
    }
    if (answer.includes('[') || answer.includes(']')) {
      throw new ApkgFormatError('Anki cloze answers with square brackets are not supported');
    }
    if (ordinal === activeOrdinal) {
      if (answer.trim() === '') {
        throw new ApkgFormatError('Anki cloze card has an empty active deletion');
      }
      output += `[${answer}]`;
      activeMatches += 1;
    } else {
      output += answer;
    }
    index = end + 2;
  }
  if (activeMatches === 0) {
    throw new ApkgFormatError('Anki cloze card has no deletion for its active ordinal');
  }
  return output;
}


/** Anki tags field (` tag1 tag2 `) → validated product tags (order preserved). */
function tagsToProduct(tagsField: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Stop after finding twenty unique normalized tags; duplicates and invalid
  // tags don't consume the product's tag allowance.
  for (const raw of splitAnkiTags(tagsField, Math.min(tagsField.length, ANKI_MAX_TAG_SOURCE_LENGTH))) {
    const t = normalizeTag(raw, ANKI_TAG_MAX_LENGTH);
    if (t === null || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= ANKI_TAG_MAX_COUNT) break;
  }
  return out;
}

/** Path-normalizes an Anki deck name: trim levels, validate lengths. */
function normalizeDeckPath(path: string): string | null {
  const parts = path.split('::').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return null;
  if (parts.some((p) => p.length > ANKI_DECK_PATH_MAX)) return null;
  const joined = parts.join('::');
  if (joined.length > ANKI_DECK_PATH_MAX) return null;
  return joined;
}

/**
 * Parses a validated .apkg payload into cards. Pure with respect to
 * Firestore. Throws ApkgFormatError for malformed archives. Deterministic:
 * note id ASC; duplicate guids keep the first note.
 */
export async function parseApkgImport(raw: Uint8Array): Promise<ParsedApkgImport> {
  // Extract ONLY the collection database: media members (images/audio in the
  // .apkg) are never inflated during import.
  const entries = await decodeApkg(raw, { relevant: (name) => name === COLLECTION_MEMBER });
  const member = entries.get(COLLECTION_MEMBER);
  if (!member) throw new ApkgFormatError('Not an Anki package: missing collection.anki2');

  const temp = makeTempDir();
  let db: DatabaseSync | null = null;
  try {
    db = openCollectionReadonly(member.data, temp);
    const modelInfo = readModelFieldMap(db);
    const decksById = new Map<number, string>();
    const decksJson = readCollectionMetadata(db, 'decks', 'deck');
    if (decksJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decksJson) as unknown;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        parsed = null;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [idStr, value] of Object.entries(parsed)) {
          const id = Number(idStr);
          if (typeof value === 'object' && value !== null && !Array.isArray(value)
            && Number.isFinite(id) && typeof (value as { name?: unknown }).name === 'string') {
            decksById.set(id, (value as { name: string }).name);
          }
        }
      }
    }

    const modelIndexes = JSON.stringify(
      [...modelInfo].map(([id, info]) => [id, info.qIndex, info.aIndex, info.isCloze ? 1 : 0]),
    );
    let notes: Iterable<BoundedNoteRow>;
    try {
      notes = db.prepare(`
      WITH
      model_fields AS (
        SELECT CAST(json_extract(value, '$[0]') AS INTEGER) AS mid,
          CAST(json_extract(value, '$[1]') AS INTEGER) AS q_index,
          CAST(json_extract(value, '$[2]') AS INTEGER) AS a_index,
          CAST(json_extract(value, '$[3]') AS INTEGER) AS is_cloze
        FROM json_each(?)
      ),
      unique_note_ids AS (
        SELECT MIN(id) AS id
        FROM notes
        WHERE guid IS NOT NULL
        GROUP BY guid
        UNION ALL
        SELECT id FROM notes WHERE guid IS NULL
      ),
      card_counts AS (
        SELECT nid, COUNT(*) AS card_count, MIN(did) AS did, MIN(ord) AS card_ord
        FROM cards
        GROUP BY nid
      )
      SELECT
        CASE WHEN typeof(n.id) = 'integer'
            AND n.id BETWEEN -9007199254740991 AND 9007199254740991 THEN n.id ELSE NULL END AS id,
        CASE WHEN typeof(n.mid) = 'integer'
            AND n.mid BETWEEN -9007199254740991 AND 9007199254740991 THEN n.mid ELSE NULL END AS mid,
        typeof(n.id) AS idType, typeof(n.guid) AS guidType,
        typeof(n.mid) AS midType, typeof(n.tags) AS tagsType, typeof(n.flds) AS fldsType,
        length(CAST(n.tags AS BLOB)) AS tagsBytes,
        length(CAST(n.flds AS BLOB)) AS fldsBytes,
        CASE WHEN typeof(n.tags) = 'text' AND length(CAST(n.tags AS BLOB)) <= ?
          THEN n.tags ELSE NULL END AS tags,
        CASE WHEN card_counts.card_count = 1 AND typeof(n.flds) = 'text'
            AND typeof(n.tags) = 'text' AND length(CAST(n.tags AS BLOB)) <= ?
          THEN CAST(n.flds AS BLOB) ELSE NULL END AS fldsValue,
        COALESCE(model_fields.q_index, 0) AS qIndex,
        COALESCE(model_fields.a_index, -1) AS aIndex,
        COALESCE(model_fields.is_cloze, 0) AS isCloze,
        card_counts.card_count AS cardCount,
        CASE WHEN typeof(card_counts.did) = 'integer'
            AND card_counts.did BETWEEN -9007199254740991 AND 9007199254740991 THEN card_counts.did ELSE NULL END AS did,
        typeof(card_counts.did) AS didType,
        CASE WHEN typeof(card_counts.card_ord) = 'integer'
            AND card_counts.card_ord BETWEEN -9007199254740991 AND 9007199254740991 THEN card_counts.card_ord ELSE NULL END AS cardOrd,
        typeof(card_counts.card_ord) AS cardOrdType
      -- Keep ordering on the ID membership set, not wide rows carrying flds BLOBs.
      FROM notes n
      LEFT JOIN model_fields ON model_fields.mid = n.mid
      LEFT JOIN card_counts ON card_counts.nid = n.id
      WHERE n.id IN (SELECT id FROM unique_note_ids)
      ORDER BY n.id ASC
    `).iterate(
        modelIndexes,
        ANKI_MAX_TAG_SOURCE_LENGTH,
        ANKI_MAX_TAG_SOURCE_LENGTH,
      ) as Iterable<BoundedNoteRow>;
    } catch (error) {
      rethrowSqliteAsPackageError(error);
    }

    const cards: ImportedCard[] = [];
    let skippedNotes = 0;
    let skippedEmpty = 0;
    let skippedOverLimit = 0;
    for (const note of packageRows(notes)) {
      if (note.idType !== 'integer' || note.midType !== 'integer'
        || !Number.isSafeInteger(note.id) || !Number.isSafeInteger(note.mid)) {
        throw new ApkgFormatError('Anki note has invalid integer identifiers');
      }
      if ((note.guidType !== 'null' && note.guidType !== 'text')
        || note.tagsType !== 'text' || note.fldsType !== 'text') {
        throw new ApkgFormatError('Anki note has invalid text fields');
      }
      if (note.isCloze !== 0 && note.isCloze !== 1) {
        throw new ApkgFormatError('Anki note has an invalid model type');
      }
      if (note.cardCount === null) {
        skippedNotes += 1;
        continue;
      }
      if (!Number.isSafeInteger(note.cardCount) || note.cardCount < 0) {
        throw new ApkgFormatError('Anki note has an invalid card count');
      }
      if (note.cardCount !== 1) {
        skippedNotes += 1;
        continue;
      }
      if (note.didType !== 'integer' || !Number.isSafeInteger(note.did)) {
        throw new ApkgFormatError('Anki card has an invalid deck identifier');
      }
      if (note.isCloze === 1
        && (note.cardOrdType !== 'integer' || note.cardOrd === null
          || !Number.isSafeInteger(note.cardOrd) || note.cardOrd < 0 || note.cardOrd >= Number.MAX_SAFE_INTEGER)) {
        throw new ApkgFormatError('Anki cloze card has an invalid ordinal');
      }
      if (note.tagsBytes === null || !Number.isSafeInteger(note.tagsBytes) || note.tagsBytes < 0
        || note.fldsBytes === null || !Number.isSafeInteger(note.fldsBytes) || note.fldsBytes < 0) {
        throw new ApkgFormatError('Anki note has invalid text field lengths');
      }
      if (note.tagsBytes > ANKI_MAX_TAG_SOURCE_LENGTH) {
        skippedEmpty += 1;
        continue;
      }
      if (typeof note.tags !== 'string') {
        throw new ApkgFormatError('Anki note has invalid bounded tags');
      }
      if (!(note.fldsValue instanceof Uint8Array) || note.fldsValue.byteLength !== note.fldsBytes) {
        throw new ApkgFormatError('Anki note has invalid bounded field data');
      }
      if (!Number.isSafeInteger(note.qIndex) || (note.qIndex as number) < 0
        || !Number.isSafeInteger(note.aIndex) || (note.aIndex as number) < -1) {
        throw new ApkgFormatError('Anki note has invalid model field indexes');
      }
      const selected = selectFieldBytes(note.fldsValue, note.qIndex as number, note.aIndex as number);
      if (selected.front.byteLength > ANKI_MAX_FIELD_SOURCE_LENGTH
        || selected.back.byteLength > ANKI_MAX_FIELD_SOURCE_LENGTH) {
        skippedEmpty += 1;
        continue;
      }
      let frontSource: string;
      let backSource: string;
      try {
        frontSource = UTF8_DECODER.decode(selected.front);
        backSource = UTF8_DECODER.decode(selected.back);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new ApkgFormatError('Anki note fields are not valid UTF-8');
        }
        throw error;
      }

      let front = normalizePlainText(ankiHtmlToPlainText(frontSource));
      const back = normalizePlainText(ankiHtmlToPlainText(backSource));
      if (note.isCloze === 1) {
        front = normalizePlainText(nativeClozeToProduct(front, note.cardOrd! + 1));
      }
      const frontErr = validatePlainText(front, 'Front');
      const backErr = back === '' ? null : validatePlainText(back, 'Back');
      if (frontErr !== null || backErr !== null) {
        skippedEmpty += 1;
        continue;
      }
      if (cards.length >= ANKI_IMPORT_CARD_LIMIT) {
        skippedOverLimit += 1;
        continue;
      }
      const deckName = decksById.get(note.did as number);
      cards.push({
        front,
        back,
        deckPath: deckName === undefined ? null : normalizeDeckPath(deckName),
        tags: tagsToProduct(note.tags),
      });
    }
    return { cards, skippedNotes, skippedEmpty, skippedOverLimit };
  } finally {
    try {
      if (db) db.close();
    } finally {
      temp.cleanup();
    }
  }
}

/** Per-note-model question/answer indexes and native note type. */
interface ModelFieldInfo {
  qIndex: number;
  aIndex: number;
  isCloze: boolean;
}

function readCollectionMetadata(db: DatabaseSync, column: 'models' | 'decks', label: 'model' | 'deck'): string | undefined {
  let row: { byteLength?: number | null; value?: unknown } | undefined;
  try {
    row = db.prepare(`SELECT length(CAST(${column} AS BLOB)) AS byteLength,
        CASE WHEN length(CAST(${column} AS BLOB)) <= ? THEN ${column} ELSE NULL END AS value
      FROM col LIMIT 1`).get(ANKI_MAX_METADATA_BYTES) as typeof row;
  } catch (error) {
    rethrowSqliteAsPackageError(error);
  }
  if (!row) return undefined;
  if (row.byteLength !== null && row.byteLength !== undefined
    && (!Number.isSafeInteger(row.byteLength) || row.byteLength < 0)) {
    throw new ApkgFormatError(`Anki ${label} metadata has an invalid size`);
  }
  if ((row.byteLength ?? 0) > ANKI_MAX_METADATA_BYTES) {
    throw new ApkgFormatError(`Anki ${label} metadata exceeds the supported size`);
  }
  if (row.value === null || row.value === undefined || row.value === '') return undefined;
  if (typeof row.value !== 'string') {
    throw new ApkgFormatError(`Anki ${label} metadata is not text`);
  }
  return row.value;
}

function readModelFieldMap(db: DatabaseSync): Map<number, ModelFieldInfo> {
  const out = new Map<number, ModelFieldInfo>();
  const source = readCollectionMetadata(db, 'models', 'model');
  if (source === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return out;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  for (const [idStr, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const model = value as { type?: unknown; sortf?: unknown; flds?: unknown };
    if (!Array.isArray(model.flds) || model.flds.length === 0) continue;
    const fields = model.flds as unknown[];
    const id = Number(idStr);
    if (!Number.isFinite(id)) continue;
    const names = fields.map((field) => {
      if (typeof field !== 'object' || field === null || Array.isArray(field)) return '';
      const name = (field as { name?: unknown }).name;
      return typeof name === 'string' ? name.toLowerCase().trim() : '';
    });
    const sortf = typeof model.sortf === 'number' && fields[model.sortf] ? model.sortf : 0;
    const isCloze = model.type === 1;
    let qIndex = sortf;
    let aIndex = -1;
    if (isCloze) {
      const textIdx = names.findIndex((name) => name === 'text' || name === 'texto');
      if (textIdx >= 0) qIndex = textIdx;
      const extraIdx = names.findIndex((name) => name === 'back extra' || name === 'extra' || name === 'backextra');
      if (extraIdx >= 0) aIndex = extraIdx;
    } else {
      const frontIdx = names.findIndex((name) => name === 'front');
      const backIdx = names.findIndex((name) => name === 'back');
      if (frontIdx >= 0) qIndex = frontIdx;
      if (backIdx >= 0) aIndex = backIdx;
      else if (qIndex === aIndex) aIndex = -1;
      if (aIndex === qIndex) aIndex = -1;
    }
    out.set(id, { qIndex, aIndex, isCloze });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** One export card view: content + deck + tags + scheduling. */
export interface ExportCard {
  id: string;
  /** Owner of the exported card (verified Auth0 `sub` or `'emulator'`). */
  ownerId?: string;
  front: string;
  back: string;
  /** Deck path (null = deck-less → exported under "Imported"). */
  deckPath: string | null;
  tags: string[];
  suspended?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  dueMs: number;
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lastReviewMs?: number;
  lapses: number;
  learningSteps?: number;
  reviewLog: Array<{
    rating: number;
    state: number;
    reviewMs: number;
    dueMs: number;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    learningStepsAfter?: number;
  }>;
}
export interface ExportSchedulerSteps {
  learningSteps: readonly string[];
  relearningSteps: readonly string[];
  progressByCardId: ReadonlyMap<string, number>;
}

const CSS = '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n';
const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const LATEX_POST = '\\end{document}';
/** Positive SQLite-safe Anki ID from a deterministic SHA-256 digest. */
function ankiNumericId(value: string, salt: string): number {
  const digest = createHash('sha256').update(`${salt}:${value}`).digest();
  return (digest.readUInt32BE(0) & 0x7fffffff) || 1;

}

/** Stable collision-resistant Anki note GUID. */
function ankiGuid(cardId: string): string {
  return createHash('sha256').update(`guid:${cardId}`).digest('hex').slice(0, 16);
}

/** Allocate deterministic SQLite-safe IDs with a bounded collision probe. */
function allocateAnkiId(value: string, salt: string, occupied: Set<number>): number {
  let id = ankiNumericId(value, salt);
  for (let probe = 0; probe <= occupied.size; probe += 1) {
    if (!occupied.has(id)) {
      occupied.add(id);
      return id;
    }
    id = id === 0x7fffffff ? 1 : id + 1;
  }
  throw new Error('Unable to allocate a unique Anki id');
}
/** Card and note IDs in Anki are creation-time epoch milliseconds. */
function allocateCreationId(createdAtMs: number, nowMs: number, occupied: Set<number>): number {
  const source = Number.isSafeInteger(createdAtMs) && createdAtMs > 0
    ? createdAtMs
    : Math.trunc(nowMs);
  for (let offset = 0; offset <= occupied.size; offset += 1) {
    const id = source + offset;
    if (Number.isSafeInteger(id) && id > 0 && !occupied.has(id)) {
      occupied.add(id);
      return id;
    }
  }
  throw new Error('Unable to allocate a unique Anki creation timestamp');
}
/** Preserve the epoch-millisecond review time, advancing only on PK collision. */
function allocateReviewId(reviewMs: number, occupied: Set<number>): number {
  const timestamp = Math.trunc(reviewMs);
  for (let offset = 0; offset <= occupied.size; offset += 1) {
    const id = timestamp + offset;
    if (!occupied.has(id)) {
      occupied.add(id);
      return id;
    }
  }
  throw new Error('Unable to allocate a unique Anki review timestamp');
}

/** The exported deck path for a card (deck-less → "Imported"). */
export function exportDeckPath(card: ExportCard): string {
  return card.deckPath && card.deckPath.trim() !== '' ? card.deckPath.trim() : 'Imported';
}

/** The collection models JSON with our two note types. */
function modelsJson(nowSec: number, defaultDid: number): string {
  const mk = (id: number, name: string, type: number, flds: unknown[], tmpls: unknown[]) => ({
    css: CSS, did: defaultDid, id: String(id), latexPost: LATEX_POST, latexPre: LATEX_PRE,
    latexsvg: false, mod: nowSec, name, req: [[0, 'any', [0]]], sortf: 0, tags: [],
    type, usn: -1, vers: [], flds, tmpls,
  });
  const field = (name: string) => ({ name, ord: 0, font: 'Arial', media: [], rtl: false, size: 20, sticky: false });
  const qa = mk(MODEL_QA_ID, 'CueLingua Basic', 0,
    [field('Front'), { ...field('Back'), ord: 1 }],
    [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}', bafmt: '', bqfmt: '', bfont: '', bsize: 0, did: null }]);
  const cloze = mk(MODEL_CLOZE_ID, 'CueLingua Cloze', 1,
    [field('Text'), { ...field('Back Extra'), ord: 1 }],
    [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}', bafmt: '', bqfmt: '', bfont: '', bsize: 0, did: null }]);
  return JSON.stringify({ [String(MODEL_QA_ID)]: qa, [String(MODEL_CLOZE_ID)]: cloze });
}

/** The collection decks JSON (always includes Anki's default deck id 1). */
function decksJson(nowSec: number, extra: Map<number, string>): string {
  const deck = (id: number, name: string) => ({
    collapsed: false, conf: 1, desc: '', dyn: 0, extendNew: 10, extendRev: 50, id,
    lrnToday: [0, 0], mod: nowSec, name, newToday: [0, 0], revToday: [0, 0],
    timeToday: [0, 0], usn: -1,
  });
  const all: Record<string, unknown> = { '1': deck(1, 'Default') };
  for (const [id, name] of extra) all[String(id)] = deck(id, name);
  return JSON.stringify(all);
}
/** Converts ts-fsrs step strings to Anki's learning-delay unit (minutes). */
function ankiStepDelays(steps: readonly string[]): number[] {
  return steps.map((step) => {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(step);
    if (!match) throw new ApkgFormatError('Unsupported FSRS learning-step duration');
    const amount = Number(match[1]);
    const minutesPerUnit: Record<string, number> = { ms: 1 / 60_000, s: 1 / 60, m: 1, h: 60, d: 1_440 };
    const minutes = amount * minutesPerUnit[match[2].toLowerCase()];
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new ApkgFormatError('Invalid FSRS learning-step duration');
    }
    return minutes;
  });
}

function decksConfigJson(nowSec: number, steps: ExportSchedulerSteps): string {
  return JSON.stringify({
    '1': {
      id: 1, mod: nowSec, name: 'Default', usn: -1, maxTaken: 60,
      autoplay: true, timer: 0, replayq: true,
      new: { bury: false, delays: ankiStepDelays(steps.learningSteps), initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: ankiStepDelays(steps.relearningSteps), leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
      dyn: false, newMix: 0, newPerDayMinimum: 0, interdayLearningMix: 0,
      reviewOrder: 0, newSortOrder: 0, newGatherPriority: 0, buryInterdayLearning: false,
      fsrsWeights: [], fsrsParams5: [], fsrsParams6: [], desiredRetention: 0.9,
      ignoreRevlogsBeforeDate: '', easyDaysPercentages: [1, 1, 1, 1, 1, 1, 1],
      stopTimerOnAnswer: false, secondsToShowQuestion: 0, secondsToShowAnswer: 0,
      questionAction: 0, answerAction: 0, waitForAudio: true, sm2Retention: 0.9,
      weightSearch: '',
    },
  });
}


const SCHEMA_SQL = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null,
  conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld text not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
  type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

/** Approximate Anki card interval from FSRS stability days. */
export function stabilityToAnkiInterval(stability: number): number {
  if (!Number.isFinite(stability) || stability <= 0) return 1;
  return Math.max(1, Math.min(36500, Math.round(stability)));
}
/** Revlog interval derived only from the next review's recorded due boundary. */
function nextAnkiInterval(nextDueMs: number, reviewMs: number, nextState: number): number {
  if (!Number.isFinite(nextDueMs) || !Number.isFinite(reviewMs) || nextDueMs <= reviewMs) return 0;
  const elapsedMs = nextDueMs - reviewMs;
  if (nextState === 1 || nextState === 3) return -Math.min(2_147_483_647, Math.max(1, Math.round(elapsedMs / 1000)));
  if (nextState === 2) return Math.min(2_147_483_647, Math.max(1, Math.round(elapsedMs / 86_400_000)));
  return 0;
}
/** Anki revlog last interval, only when retained timestamps prove the boundary. */
function previousAnkiInterval(dueMs: number, previousReviewMs: number | null, state: number): number {
  if (previousReviewMs === null || state === 0 || !Number.isFinite(dueMs) || !Number.isFinite(previousReviewMs)) return 0;
  const elapsedMs = dueMs - previousReviewMs;
  if (elapsedMs <= 0) return 0;
  if (state === 1 || state === 3) return -Math.min(2_147_483_647, Math.max(1, Math.round(elapsedMs / 1000)));
  return Math.min(2_147_483_647, Math.max(1, Math.round(elapsedMs / 86_400_000)));
}

function exportSchedulingState(card: ExportCard): number {
  // Cards created before FSRS state was persisted may still have repetition
  // history; preserve the prior exporter’s reviewed-state fallback.
  return card.state === 0 && card.reps > 0 ? 2 : card.state;
}
/**
 * Builds the full in-memory Anki collection for `cards` and serializes it to
 * a fresh SQLite byte buffer via VACUUM INTO a private temp file (deleted in
 * finally). Returns the collection.anki2 bytes.
 */
export async function buildCollectionBytes(
  cards: ExportCard[],
  nowMs: number,
  cardMediaRefs: ReadonlyMap<string, readonly string[]> = new Map(),
  schedulerSteps?: ExportSchedulerSteps,
): Promise<Uint8Array> {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new ApkgFormatError('Collection time is invalid');
  }
  if (cards.length > ANKI_EXPORT_CARD_LIMIT) {
    throw new ApkgFormatError(`Too many cards to export (${cards.length} > ${ANKI_EXPORT_CARD_LIMIT})`);
  }
  const temp = makeTempDir();
  const db = new DatabaseSync(':memory:');
  const outPath = join(temp.dir, 'out.anki2');
  try {
    db.exec('PRAGMA page_size = 4096');
    db.exec(`PRAGMA max_page_count = ${Math.floor(ANKI_MAX_COLLECTION_BYTES / 4096)}`);
    db.exec(SCHEMA_SQL);
    const nowSec = Math.floor(nowMs / 1000);
    const uniqueCards: ExportCard[] = [];
    const seenCards = new Set<string>();
    for (const card of cards) {
      if (seenCards.has(card.id)) continue;
      if (card.tags.some((tag) => tag === '' || /\s/.test(tag))) {
        throw new ApkgFormatError('Anki tags cannot contain whitespace or be empty');
      }
      const state = exportSchedulingState(card);
      if (![0, 1, 2, 3].includes(state)) {
        throw new ApkgFormatError('Unsupported flashcard scheduling state');
      }
      if (!Number.isFinite(card.dueMs) || card.dueMs < 0 || (state !== 0 && card.dueMs === 0)) {
        throw new ApkgFormatError('Flashcard due time is invalid');
      }
      seenCards.add(card.id);
      uniqueCards.push(card);
    }
    for (const card of uniqueCards) {
      const state = exportSchedulingState(card);
      if (state !== 1 && state !== 3) continue;
      const steps = state === 1 ? schedulerSteps?.learningSteps : schedulerSteps?.relearningSteps;
      const progress = schedulerSteps?.progressByCardId.get(card.id);
      if (!steps || !Number.isInteger(progress) || progress! < 0 || progress! >= steps.length) {
        throw new ApkgFormatError('Learning progress is unavailable; reset scheduling state before export');
      }
    }
    const collectionCrtMs = Math.min(
      nowMs,
      ...uniqueCards.flatMap((card) => [
        Number.isFinite(card.createdAtMs) && card.createdAtMs > 0 ? card.createdAtMs : nowMs,
        ...(exportSchedulingState(card) === 0 ? [] : [card.dueMs]),
      ]),
    );
    const crtSec = Math.floor(collectionCrtMs / 86_400_000) * 86_400;
    db.prepare(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
      VALUES (1, ?, ?, ?, 11, 0, -1, ?, ?, ?, ?, ?, '{}')`)
      .run(
        crtSec, nowSec, nowSec, nowSec, '{}', modelsJson(nowSec, 1), decksJson(nowSec, new Map()),
        schedulerSteps ? decksConfigJson(nowSec, schedulerSteps) : '{}',
      );
    const deckNames = new Map<number, string>();
    const deckIds = new Map<string, number>();
    const creationIds = new Map<string, number>();
    const guids = new Map<string, string>();
    const usedDeckIds = new Set<number>([1]);
    const usedCreationIds = new Set<number>();
    const usedGuids = new Set<string>();
    const usedRevlogIds = new Set<number>();
    const reviewLogs = new Map<string, ExportCard['reviewLog']>();
    const reviewIds = new Map<string, number[]>();
    for (const card of [...uniqueCards].sort((a, b) => a.id.localeCompare(b.id))) {
      creationIds.set(card.id, allocateCreationId(card.createdAtMs, nowMs, usedCreationIds));
      const baseGuid = ankiGuid(card.id);
      let guid = baseGuid;
      for (let probe = 1; usedGuids.has(guid); probe += 1) guid = `${baseGuid}-${probe}`;
      usedGuids.add(guid);
      guids.set(card.id, guid);
      const log = [...card.reviewLog].sort((a, b) => a.reviewMs - b.reviewMs);
      reviewLogs.set(card.id, log);
      reviewIds.set(card.id, log.map((entry) => allocateReviewId(entry.reviewMs, usedRevlogIds)));
    }
    for (const path of [...new Set(uniqueCards.map(exportDeckPath))].sort()) {
      const id = allocateAnkiId(path === 'Imported' || path === '' ? 'Imported' : path, 'deck', usedDeckIds);
      deckIds.set(path, id);
      deckNames.set(id, path);
    }

    const insertNote = db.prepare('INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertCard = db.prepare('INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertRevlog = db.prepare('INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) VALUES (?,?,?,?,?,?,?,?,?)');

    let newPos = 0;
    for (const card of uniqueCards) {
      const deckPath = exportDeckPath(card);
      const did = deckIds.get(deckPath)!;
      const cloze = isClozeFront(card.front);
      const mid = cloze ? MODEL_CLOZE_ID : MODEL_QA_ID;
      const noteId = creationIds.get(card.id)!;
      const cardId = creationIds.get(card.id)!;
      const guid = guids.get(card.id)!;
      const state = exportSchedulingState(card);
      const isNew = state === 0;
      const suspended = card.suspended === true;
      const dueForNew = newPos;
      newPos += 1;
      let type: number; let queue: number; let due: number; let ivl: number; let factor: number; let reps: number; let lapses: number; let left = 0;

      if (isNew) {
        type = 0; queue = suspended ? -1 : 0; due = dueForNew; ivl = 0; factor = 0; reps = 0; lapses = 0;
      } else if (state === 1 || state === 3) {
        type = state === 1 ? 1 : 3; queue = suspended ? -1 : 1;
        due = Math.floor(card.dueMs / 1000); ivl = 0; factor = 0;
        const steps = state === 1 ? schedulerSteps!.learningSteps : schedulerSteps!.relearningSteps;
        left = steps.length - schedulerSteps!.progressByCardId.get(card.id)!;
        reps = Math.max(0, card.reps); lapses = Math.max(0, card.lapses);
      } else {
        type = 2; queue = suspended ? -1 : 2;
        ivl = stabilityToAnkiInterval(card.stability);
        due = Math.floor(card.dueMs / 86_400_000) - Math.floor(crtSec / 86_400);
        // No stored SM-2 ease exists; Anki's new review cards start at 2500‰.
        factor = 2500;
        reps = Math.max(0, card.reps);
        lapses = Math.max(0, card.lapses);
      }
      const mediaFiles = cardMediaRefs.get(card.id) ?? [];
      if (mediaFiles.some((fileName) => !isSafeMediaFileName(fileName))) {
        throw new ApkgFormatError('Anki media reference has an unsafe file name');
      }
      const mediaHtml = mediaFiles.map((fileName) => `<img src="${fileName}">`).join('<br>');
      const backHtml = plainTextToAnkiHtml(card.back);
      const answerHtml = mediaHtml === '' ? backHtml : `${backHtml}${backHtml === '' ? '' : '<br>'}${mediaHtml}`;
      const flds = cloze
        ? `${plainTextToAnkiHtml(card.front, 1)}\x1f${answerHtml}`
        : `${plainTextToAnkiHtml(card.front)}\x1f${answerHtml}`;
      const tags = card.tags.length > 0 ? ` ${card.tags.join(' ')} ` : '';

      insertNote.run(noteId, guid, mid, nowSec, -1, tags, flds, card.front, 0, 0, '');
      insertCard.run(cardId, noteId, did, 0, nowSec, -1, type, queue, due, ivl, factor, reps, lapses, left, 0, 0, 0, '');
      const log = reviewLogs.get(card.id)!;
      const ids = reviewIds.get(card.id)!;
      let previousReviewMs: number | null = null;
      for (let index = 0; index < log.length; index += 1) {
        const entry = log[index];
        const revId = ids[index];
        const ease = Math.max(1, Math.min(4, Math.round(entry.rating)));
        const next = log[index + 1];
        const interval = nextAnkiInterval(next?.dueMs ?? card.dueMs, entry.reviewMs, next?.state ?? card.state);
        const priorInterval = previousAnkiInterval(entry.dueMs, previousReviewMs, entry.state);
        previousReviewMs = entry.reviewMs;
        const type = entry.state === 3 ? 2 : entry.state === 0 || entry.state === 1 ? 0 : 1;
        insertRevlog.run(revId, cardId, -1, ease, interval, priorInterval, 0, 0, type);
      }
    }

    // Update col with the real deck list.
    db.prepare('UPDATE col SET decks = ?').run(decksJson(nowSec, deckNames));

    // Serialize: VACUUM INTO a private temp file, then read + delete.
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    const fileSize = statSync(outPath).size;
    if (fileSize > ANKI_MAX_COLLECTION_BYTES) {
      throw new ApkgFormatError(`Anki collection exceeds the export size cap (${fileSize} > ${ANKI_MAX_COLLECTION_BYTES})`);
    }
    const bytes = readFileSync(outPath);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } finally {
    db.close();
    temp.cleanup();
  }
}

/** Media file names must be safe Anki HTML basenames and ZIP map values. */
function isSafeMediaFileName(fileName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName)
    && fileName !== '.' && fileName !== '..';
}

function validateMediaFiles(media: ExportedMedia[]): void {
  if (media.length > ANKI_MAX_MEDIA_COUNT) {
    throw new ApkgFormatError(`Too many media files (${media.length} > ${ANKI_MAX_MEDIA_COUNT})`);
  }
  const names = new Set<string>();
  let totalBytes = 0;
  for (const item of media) {
    const key = item.fileName.toLowerCase();
    if (!isSafeMediaFileName(item.fileName) || names.has(key)) {
      throw new ApkgFormatError('Anki media file names must be unique safe basenames');
    }
    if (item.data.byteLength === 0 || item.data.byteLength > ANKI_MAX_MEDIA_BYTES) {
      throw new ApkgFormatError('Anki media file is empty or exceeds the per-file size cap');
    }
    names.add(key);
    totalBytes += item.data.byteLength;
    if (totalBytes > ANKI_MAX_TOTAL_MEDIA_BYTES) {
      throw new ApkgFormatError('Anki media exceeds the export size cap');
    }
  }
}

/** The `media` map (file name per index) plus the member list. */
export function mediaMapJson(media: ExportedMedia[]): string {
  validateMediaFiles(media);
  const map: Record<string, string> = {};
  media.forEach((m, i) => { map[String(i)] = m.fileName; });
  return JSON.stringify(map);
}

/**
 * Assembles the .apkg ZIP bytes: collection.anki2 + media members + media map.
 */
export async function assembleApkgBytes(
  collection: Uint8Array,
  media: ExportedMedia[],
): Promise<Uint8Array> {
  if (collection.byteLength > ANKI_MAX_COLLECTION_BYTES) {
    throw new ApkgFormatError('Anki collection exceeds the export size cap');
  }
  validateMediaFiles(media);
  const members: Array<{ name: string; data: Uint8Array }> = [
    { name: COLLECTION_MEMBER, data: collection },
  ];
  for (let i = 0; i < media.length; i++) {
    members.push({ name: String(i), data: media[i].data });
  }
  return encodeApkg(members, mediaMapJson(media), ANKI_MAX_EXPORTED_APKG_BYTES);
}
/** Import-side envelope: strict base64 length for the request schema cap. */

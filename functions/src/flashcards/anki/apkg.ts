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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ANKI_DECK_PATH_MAX, ANKI_IMPORT_CARD_LIMIT, ANKI_MAX_APKG_BYTES,
  ANKI_TAG_MAX_COUNT, ANKI_TAG_MAX_LENGTH,
  ImportedCard, ParsedApkgImport, ExportedMedia,
} from './types';
import {
  ankiHtmlToPlainText, isClozeFront, normalizePlainText, normalizeTag,
  plainTextToAnkiHtml, splitAnkiTags, stableHash, validatePlainText,
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
  return { bytes: new Uint8Array(bytes) };
}

/** Opens a collection.anki2 member read-only via a private temp file. */
function openCollectionReadonly(member: Uint8Array, temp: TempDir): DatabaseSync {
  const path = join(temp.dir, 'collection.anki2');
  writeTemp(path, member);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApkgFormatError(`collection.anki2 is not a readable SQLite database: ${message}`);
  }
  // Verify the expected tables exist before querying.
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('notes','cards','col')").all() as Array<{ name: string }>)
      .map((r) => r.name);
    if (!['notes', 'cards', 'col'].every((t) => tables.includes(t))) {
      db.close();
      throw new ApkgFormatError('collection.anki2 is not an Anki collection (missing notes/cards/col tables)');
    }
  } catch (err) {
    db.close();
    if (err instanceof ApkgFormatError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApkgFormatError(`Cannot read collection.anki2: ${message}`);
  }
  return db;
}

interface RawNote {
  id: number;
  guid: string;
  mid: number;
  tags: string;
  flds: string;
}

interface RawCard {
  nid: number;
  did: number;
  ord: number;
}

/** Anki tags field (` tag1 tag2 `) → validated product tags (order preserved). */
function tagsToProduct(tagsField: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of splitAnkiTags(tagsField)) {
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
  // .apkg) are never inflated during import — this product stores no media
  // bytes, so skipping them bounds decompression memory to the db member.
  const entries = await decodeApkg(raw, { relevant: (name) => name === COLLECTION_MEMBER });
  const member = entries.get(COLLECTION_MEMBER);
  if (!member) throw new ApkgFormatError('Not an Anki package: missing collection.anki2');

  const temp = makeTempDir();
  let db: DatabaseSync | null = null;
  try {
    db = openCollectionReadonly(member.data, temp);
    const modelInfo = readModelFieldMap(db);

    // Decks: id → Anki deck name ("Parent::Child" flat names).
    const decksById = new Map<number, string>();
    try {
      const row = db.prepare('SELECT decks FROM col LIMIT 1').get() as { decks?: string } | undefined;
      if (row && typeof row.decks === 'string' && row.decks !== '') {
        const parsed = JSON.parse(row.decks) as Record<string, { name?: string }>;
        for (const [idStr, d] of Object.entries(parsed)) {
          const id = Number(idStr);
          if (Number.isFinite(id) && d && typeof d.name === 'string') decksById.set(id, d.name);
        }
      }
    } catch {
      // malformed decks JSON → all cards import deck-less (never fatal)
    }

    // One note → one card; take the LOWEST-ord card for the deck assignment
    // (a note's cards share one deck in practice).
    const cardsByNid = new Map<number, RawCard[]>();
    for (const row of db.prepare('SELECT nid, did, ord FROM cards').all() as unknown as RawCard[]) {
      const list = cardsByNid.get(row.nid);
      if (list) list.push(row); else cardsByNid.set(row.nid, [row]);
    }
    const deckForNote = (nid: number): string | null => {
      const rows = cardsByNid.get(nid);
      if (!rows || rows.length === 0) return null;
      let best = rows[0];
      for (const r of rows) if (r.ord < best.ord) best = r;
      const name = decksById.get(best.did);
      if (name === undefined) return null;
      return normalizeDeckPath(name);
    };

    const notes = db.prepare('SELECT id, guid, mid, tags, flds FROM notes ORDER BY id').all() as unknown as RawNote[];
    const cards: ImportedCard[] = [];
    let skippedNotes = 0;
    let skippedEmpty = 0;
    const seenGuids = new Set<string>();
    for (const note of notes) {
      if (cards.length >= ANKI_IMPORT_CARD_LIMIT) break;
      const guid = typeof note.guid === 'string' ? note.guid : String(note.id);
      if (seenGuids.has(guid)) continue;
      seenGuids.add(guid);
      const noteCards = cardsByNid.get(note.id) ?? [];
      if (noteCards.length !== 1) {
        // 0 cards (empty/deleted note) or 2+ (reversed/multi-cloze note):
        // no faithful single flashcard — skip deterministically.
        skippedNotes += 1;
        continue;
      }
      const fields = note.flds.split('\x1f');
      const info = modelInfo.get(note.mid);
      const qIndex = info !== undefined && info.qIndex >= 0 && info.qIndex < fields.length
        ? info.qIndex
        : 0;
      const aIndex = info !== undefined && info.aIndex >= 0 && info.aIndex < fields.length && info.aIndex !== qIndex
        ? info.aIndex
        : (fields.length > 1 ? 1 : -1);
      const front = normalizePlainText(ankiHtmlToPlainText(fields[qIndex] ?? ''));
      const backRaw = aIndex >= 0 ? ankiHtmlToPlainText(fields[aIndex] ?? '') : '';
      const back = normalizePlainText(backRaw);
      const frontErr = validatePlainText(front, 'Front');
      const backErr = back === '' ? null : validatePlainText(back, 'Back');
      if (frontErr !== null || backErr !== null) {
        skippedEmpty += 1;
        continue;
      }
      cards.push({
        front,
        back,
        deckPath: deckForNote(note.id),
        tags: tagsToProduct(note.tags),
      });
    }
    return { cards, skippedNotes, skippedEmpty };
  } finally {
    if (db) db.close();
    temp.cleanup();
  }
}

/** Per-note-model question/answer field indexes (from col.models JSON). */
interface ModelFieldInfo {
  qIndex: number;
  aIndex: number;
}

function readModelFieldMap(db: DatabaseSync): Map<number, ModelFieldInfo> {
  const out = new Map<number, ModelFieldInfo>();
  try {
    const row = db.prepare('SELECT models FROM col LIMIT 1').get() as { models?: string } | undefined;
    if (!row || typeof row.models !== 'string' || row.models === '') return out;
    const parsed = JSON.parse(row.models) as Record<string, {
      type?: number; sortf?: number;
      flds?: Array<{ name?: string }>;
    }>;
    for (const [idStr, model] of Object.entries(parsed)) {
      if (!model || !Array.isArray(model.flds) || model.flds.length === 0) continue;
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      const names = model.flds.map((f) => (f.name ?? '').toLowerCase().trim());
      const sortf = typeof model.sortf === 'number' && model.flds[model.sortf] ? model.sortf : 0;
      const isCloze = model.type === 1;
      let qIndex = sortf;
      let aIndex = -1;
      if (isCloze) {
        const textIdx = names.findIndex((n) => n === 'text' || n === 'texto');
        if (textIdx >= 0) qIndex = textIdx;
        const extraIdx = names.findIndex((n) => n === 'back extra' || n === 'extra' || n === 'backextra');
        if (extraIdx >= 0) aIndex = extraIdx;
      } else {
        const frontIdx = names.findIndex((n) => n === 'front');
        const backIdx = names.findIndex((n) => n === 'back');
        if (frontIdx >= 0) qIndex = frontIdx;
        if (backIdx >= 0) aIndex = backIdx;
        else if (qIndex === aIndex) aIndex = -1;
        if (aIndex === qIndex) aIndex = -1;
      }
      out.set(id, { qIndex, aIndex });
    }
  } catch {
    // malformed models JSON → fall back to 0/1 defaults per note
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
  lapses: number;
  lastReviewMs?: number;
  reviewLog: Array<{
    rating: number;
    state: number;
    reviewMs: number;
    dueMs: number;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
  }>;
}

const CSS = '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n';
const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const LATEX_POST = '\\end{document}';

/** Deterministic stable deck id (positive, < 2^31) for a deck path. */
export function ankiDeckIdForPath(path: string): number {
  const base = path === 'Imported' || path === ''
    ? 0x4355454c
    : stableHash(`deck:${path}`);
  return (base % 0x7fffffff) + 1;
}

/** Deterministic positive entity id for a card id + role salt. */
function ankiEntityId(cardId: string, salt: string): number {
  return (stableHash(`${salt}:${cardId}`) % 0x7fffffff) + 1;
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

/** Anki stability→interval and difficulty→ease conversions. */
export function stabilityToAnkiInterval(stability: number): number {
  if (!Number.isFinite(stability) || stability <= 0) return 1;
  return Math.max(1, Math.min(36500, Math.round(stability)));
}
export function difficultyToAnkiFactor(difficulty: number): number {
  const d = Number.isFinite(difficulty) ? difficulty : 0;
  return Math.max(1000, Math.min(4000, Math.round(2500 - d * 250)));
}

/**
 * Builds the full in-memory Anki collection for `cards` and serializes it to
 * a fresh SQLite byte buffer via VACUUM INTO a private temp file (deleted in
 * finally). Returns the collection.anki2 bytes.
 */
export async function buildCollectionBytes(cards: ExportCard[], nowMs: number): Promise<Uint8Array> {
  const temp = makeTempDir();
  const db = new DatabaseSync(':memory:');
  const outPath = join(temp.dir, 'out.anki2');
  try {
    db.exec(SCHEMA_SQL);
    const nowSec = Math.floor(nowMs / 1000);
    const crtSec = nowSec;
    db.prepare(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
      VALUES (1, ?, ?, ?, 11, 0, -1, ?, ?, ?, ?, '{}', '{}')`)
      .run(crtSec, crtSec, crtSec, crtSec, '{}', modelsJson(nowSec, 1), decksJson(nowSec, new Map()));

    // Register decks actually used (deterministic id per path).
    const deckNames = new Map<number, string>();
    const deckIdFor = (path: string): number => {
      const id = ankiDeckIdForPath(path);
      if (!deckNames.has(id)) deckNames.set(id, path);
      return id;
    };
    for (const card of cards) deckIdFor(exportDeckPath(card));

    const insertNote = db.prepare('INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertCard = db.prepare('INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertRevlog = db.prepare('INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) VALUES (?,?,?,?,?,?,?,?,?)');

    let newPos = 0;
    const seenCards = new Set<string>();
    for (const card of cards) {
      if (seenCards.has(card.id)) continue; // duplicate id → first wins
      seenCards.add(card.id);
      const deckPath = exportDeckPath(card);
      const did = deckIdFor(deckPath);
      const cloze = isClozeFront(card.front);
      const mid = cloze ? MODEL_CLOZE_ID : MODEL_QA_ID;
      const noteId = ankiEntityId(card.id, 'note');
      const cardId = ankiEntityId(card.id, 'card');
      // Anki note guid: stable 8-char from our id.
      const guid = Buffer.from(stableHash('guid:' + card.id).toString(16).padStart(16, '0'), 'utf8')
        .toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'aaaaaaaa';
      const isNew = card.reps <= 0;
      const clozeType = cloze ? 1 : 0;
      const suspended = card.suspended === true;
      const dueForNew = newPos;
      newPos += 1;

      let type: number; let queue: number; let due: number; let ivl: number; let factor: number; let reps: number; let lapses: number;
      if (isNew) {
        type = clozeType; queue = suspended ? -1 : 0; due = dueForNew; ivl = 0; factor = 0; reps = 0; lapses = 0;
      } else {
        type = 2; queue = suspended ? -1 : 2;
        ivl = stabilityToAnkiInterval(card.stability);
        const ordinal = Math.floor(Math.max(0, card.dueMs) / 1000 / 86_400) - Math.floor(crtSec / 86_400);
        due = Math.max(0, ordinal);
        factor = difficultyToAnkiFactor(card.difficulty);
        reps = Math.max(1, card.reps);
        lapses = Math.max(0, card.lapses);
      }
      const flds = cloze
        ? `${plainTextToAnkiHtml(card.front, 1)}\x1f${plainTextToAnkiHtml(card.back)}`
        : `${plainTextToAnkiHtml(card.front)}\x1f${plainTextToAnkiHtml(card.back)}`;
      const tags = card.tags.length > 0 ? ` ${card.tags.join(' ')} ` : '';

      insertNote.run(noteId, guid, mid, nowSec, -1, tags, flds, card.front, 0, 0, '');
      insertCard.run(cardId, noteId, did, 0, nowSec, -1, type, queue, due, ivl, factor, reps, lapses, 0, 0, 0, 0, '');
      const log = [...card.reviewLog].sort((a, b) => a.reviewMs - b.reviewMs);
      for (let i = 0; i < log.length; i++) {
        const entry = log[i];
        const revId = ((ankiEntityId(card.id, 'revlog') + i) % 0x7fffffff) + 1;
        const ease = Math.max(1000, Math.min(4000, Math.round(
          entry.rating === 1 ? 1500 : entry.rating === 2 ? 2200 : entry.rating === 3 ? 2500 : 3000)));
        const interval = stabilityToAnkiInterval(entry.stability);
        const takenSec = Math.max(0, Math.floor((entry.reviewMs - (card.createdAtMs)) / 1000));
        insertRevlog.run(revId, cardId, -1, ease, interval, Math.max(0, interval - 1), ease,
          Math.min(takenSec, 2_147_483_647), entry.rating <= 2 ? 0 : 1);
      }
    }

    // Update col with the real deck list.
    db.prepare('UPDATE col SET decks = ?').run(decksJson(nowSec, deckNames));

    // Serialize: VACUUM INTO a private temp file, then read + delete.
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    const bytes = readFileSync(outPath);
    return new Uint8Array(bytes);
  } finally {
    db.close();
    temp.cleanup();
  }
}

/** The `media` map (file name per index) plus the member list. */
export function mediaMapJson(media: ExportedMedia[]): string {
  const map: Record<string, string> = {};
  media.forEach((m, i) => { map[String(i)] = m.fileName; });
  return JSON.stringify(map);
}

/**
 * Assembles the .apkg ZIP bytes: collection.anki2 + media members + media
 * map. Media bytes are pre-validated by the caller (size caps).
 */
export async function assembleApkgBytes(
  collection: Uint8Array,
  media: ExportedMedia[],
): Promise<Uint8Array> {
  const members: Array<{ name: string; data: Uint8Array }> = [
    { name: COLLECTION_MEMBER, data: collection },
  ];
  for (let i = 0; i < media.length; i++) {
    members.push({ name: String(i), data: media[i].data });
  }
  return encodeApkg(members, mediaMapJson(media));
}

/** Import-side envelope: strict base64 length for the request schema cap. */

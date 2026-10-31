/**
 * Unit tests for the Anki .apkg format layer: ZIP bound/envelope handling,
 * HTML⇄text conversion, and SQLite collection parse/build round-trips.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeImportEnvelope, parseApkgImport, buildCollectionBytes,
  assembleApkgBytes,
} from './apkg';
import { decodeApkg, encodeApkg, ApkgFormatError } from './zip';
import {
  ankiHtmlToPlainText, plainTextToAnkiHtml, decodeHtmlEntities,
  escapeHtmlText, isClozeFront, normalizeTag, splitAnkiTags,
} from './text';
import {
  ANKI_MAX_APKG_BYTES, ANKI_MAX_APKG_BASE64_LENGTH, ANKI_MAX_METADATA_BYTES,
  ANKI_MAX_FIELD_SOURCE_LENGTH, ANKI_MAX_TAG_SOURCE_LENGTH,
} from './types';
import { applyReview, getFSRSStepConfiguration } from '../scheduler';
import { ConvertStepUnitToMinutes, type StepUnit } from 'ts-fsrs';
import { Timestamp } from 'firebase-admin/firestore';
import { Flashcard } from '../types';
import JSZip from 'jszip';

/* ------------------------------------------------------------------ */
/* HTML ⇄ plain-text                                                   */
/* ------------------------------------------------------------------ */

describe('anki text conversion', () => {
  it('converts simple Anki HTML (br/div) to plain text lines', () => {
    expect(ankiHtmlToPlainText('Question<br>line two')).toBe('Question\nline two');
    expect(ankiHtmlToPlainText('<div>First</div><div>Second</div>')).toBe('First\nSecond');
    expect(ankiHtmlToPlainText('<p>Para</p><p>Two</p>')).toBe('Para\nTwo');
  });

  it('decodes entities and drops tags keeping content', () => {
    expect(ankiHtmlToPlainText('a &lt; b &amp; c')).toBe('a < b & c');
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
    expect(ankiHtmlToPlainText('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });
  it('preserves invalid or out-of-range numeric entities without throwing', () => {
    expect(decodeHtmlEntities('&#xD800; &#x110000; &#999999999999999999999999;'))
      .toBe('&#xD800; &#x110000; &#999999999999999999999999;');
  });

  it('escapes stray angle brackets so raw HTML cannot inject markup', () => {
    const out = ankiHtmlToPlainText('5 < 6 > 4');
    expect(out).toBe('5 < 6 > 4'); // no tags survive; not '<' markup
    expect(out).not.toContain('<6');
  });

  it('collapses whitespace deterministically', () => {
    expect(ankiHtmlToPlainText('  a   b\n\n\n  c  ')).toBe('a b\nc');
  });

  it('export escapes text and converts newlines to br', () => {
    expect(plainTextToAnkiHtml('a & b\nc < d')).toBe('a &amp; b<br>c &lt; d');
    expect(escapeHtmlText('<script>')).toBe('&lt;script&gt;');
  });

  it('maps cloze markers to anki cloze markup on export', () => {
    expect(plainTextToAnkiHtml('The capital is [Berlin]', 1))
      .toBe('The capital is {{c1::Berlin}}');
  });

  it('detects cloze fronts', () => {
    expect(isClozeFront('X is [Y]')).toBe(true);
    expect(isClozeFront('plain')).toBe(false);
  });

  it('normalizes tags and splits anki tag strings', () => {
    expect(normalizeTag('  spaced   repetition ', 50)).toBe('spaced repetition');
    expect(normalizeTag('   ', 50)).toBeNull();
    expect(normalizeTag('x'.repeat(51), 50)).toBeNull();
    expect(splitAnkiTags(' tag1  tag2 ')).toEqual(['tag1', 'tag2']);
    expect(splitAnkiTags('')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ZIP / envelope                                                      */
/* ------------------------------------------------------------------ */

/** Builds a minimal collection db with the given notes, returns file bytes. */
function makeCollectionBytes(notes: Array<{ id: number; guid: string; mid: number; tags: string; flds: string }>): Uint8Array {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
      ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
      models text not null, decks text not null, dconf text not null, tags text not null);
    CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
      usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
      flags integer not null, data text not null);
    CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
      mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
      ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
      odue integer not null, odid integer not null, flags integer not null, data text not null);
  `);
  db.prepare(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
    VALUES (1, 1700000000, 1700000000, 0, 11, 0, -1, 0, '{}', '{}', '{}', '{}', '{}')`).run();
  const insNote = db.prepare('INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insCard = db.prepare('INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of notes) {
    insNote.run(n.id, n.guid, n.mid, 1700000000, -1, n.tags, n.flds, 0, 0, 0, '');
    insCard.run(n.id * 10 + 1, n.id, 1, 0, 1700000000, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '');
  }
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const schema = ['col', 'notes', 'cards', 'revlog', 'graves'].map((t) => {
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(t) as { sql?: string })?.sql ?? '';
    return sql;
  }).filter(Boolean).join(';\n');
  const lines: string[] = [];
  for (const t of rows) {
    const data = db.prepare(`SELECT * FROM ${t.name}`).all() as Array<Record<string, unknown>>;
    if (data.length === 0) continue;
    const cols = Object.keys(data[0]);
    for (const r of data) {
      lines.push(`INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`);
    }
  }
  db.close();
  const buf = Buffer.from(`${schema};\n${lines.join('\n')}`, 'utf8');
  // Write to a real temp db so sqlite parses it (tests run on real node:sqlite).
      const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
  const p = join(dir, 'c.anki2');
  const db2 = new DatabaseSync(p);
  db2.exec('BEGIN');
  db2.exec(schema);
  db2.exec(lines.join('\n'));
  db2.exec('COMMIT');
  db2.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  void buf;
  return bytes;
}

function lit(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function makeApkg(notes: Array<{ id: number; guid: string; mid: number; tags: string; flds: string }>): Promise<Uint8Array> {
  const collection = makeCollectionBytes(notes);
  const zip = new JSZip();
  zip.file('collection.anki2', collection as unknown as ArrayBuffer, { binary: true });
  zip.file('media', JSON.stringify({}));
  const out = await zip.generateAsync({ type: 'uint8array' });
  return out;
}
function cloneZipWithDuplicateCentralEntry(bytes: Uint8Array): Uint8Array {
  const copy = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = copy.length - 22; offset >= Math.max(0, copy.length - 22 - 0xffff); offset -= 1) {
    if (copy.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + copy.readUInt16LE(offset + 20) === copy.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('fixture ZIP has no end-of-central-directory record');
  const directoryOffset = copy.readUInt32LE(eocd + 16);
  const directorySize = copy.readUInt32LE(eocd + 12);
  const duplicate = Buffer.from(copy.subarray(directoryOffset, directoryOffset + directorySize));
  const result = Buffer.concat([copy.subarray(0, eocd), duplicate, copy.subarray(eocd)]);
  const newEocd = eocd + duplicate.length;
  result.writeUInt16LE(copy.readUInt16LE(eocd + 8) + 1, newEocd + 8);
  result.writeUInt16LE(copy.readUInt16LE(eocd + 10) + 1, newEocd + 10);
  result.writeUInt32LE(directorySize + duplicate.length, newEocd + 12);
  return result;
}


function cloneZipWithDeclaredSize(bytes: Uint8Array, declaredSize: number, name = 'selected'): Uint8Array {
  const copy = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = copy.length - 22; offset >= Math.max(0, copy.length - 22 - 0xffff); offset -= 1) {
    if (copy.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + copy.readUInt16LE(offset + 20) === copy.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('fixture ZIP has no end-of-central-directory record');
  const directoryOffset = copy.readUInt32LE(eocd + 16);
  const directoryEnd = directoryOffset + copy.readUInt32LE(eocd + 12);
  for (let offset = directoryOffset; offset + 46 <= directoryEnd;) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) throw new Error('malformed fixture central directory');
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const memberName = copy.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (memberName === name) {
      copy.writeUInt32LE(declaredSize, offset + 24);
      return copy;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture ZIP has no ${name} member`);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('decodeImportEnvelope', () => {
  it('accepts a valid base64 package', () => {
    const r = decodeImportEnvelope(b64(new Uint8Array([1, 2, 3])));
    expect('error' in r ? r.error : null).toBeNull();
  });

  it('rejects empty/missing', () => {
    const r = decodeImportEnvelope('');
    expect('error' in r).toBe(true);
  });

  it('rejects malformed base64', () => {
    const r = decodeImportEnvelope('!!!not-base64!!!');
    expect('error' in r).toBe(true);
  });

  it('rejects oversized payloads by decoded byte count', () => {
    const big = Buffer.alloc(ANKI_MAX_APKG_BYTES + 1, 7);
    const r = decodeImportEnvelope(big.toString('base64'));
    expect('error' in r).toBe(true);
  });

  it('rejects an oversized base64 string before decoding it', () => {
    const encoded = 'A'.repeat(ANKI_MAX_APKG_BASE64_LENGTH + 1);
    const result = decodeImportEnvelope(encoded);
    expect('error' in result).toBe(true);
  });
});

function makeZip64LocalHeader(bytes: Uint8Array): Buffer {
  const classic = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = classic.length - 22; offset >= 0; offset -= 1) {
    if (classic.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + classic.readUInt16LE(offset + 20) === classic.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('fixture ZIP has no end-of-central-directory record');
  const zip64 = Buffer.concat([
    classic.subarray(0, eocd),
    Buffer.alloc(56),
    Buffer.alloc(20),
    classic.subarray(eocd),
  ]);
  const record = eocd;
  const count = classic.readUInt16LE(eocd + 10);
  const directorySize = classic.readUInt32LE(eocd + 12);
  const directoryOffset = classic.readUInt32LE(eocd + 16);
  zip64.writeUInt32LE(0x06064b50, record);
  zip64.writeBigUInt64LE(44n, record + 4);
  zip64.writeUInt16LE(45, record + 12);
  zip64.writeUInt16LE(45, record + 14);
  zip64.writeBigUInt64LE(BigInt(count), record + 24);
  zip64.writeBigUInt64LE(BigInt(count), record + 32);
  zip64.writeBigUInt64LE(BigInt(directorySize), record + 40);
  zip64.writeBigUInt64LE(BigInt(directoryOffset), record + 48);
  const locator = record + 56;
  zip64.writeUInt32LE(0x07064b50, locator);
  zip64.writeBigUInt64LE(BigInt(record), locator + 8);
  zip64.writeUInt32LE(1, locator + 16);
  const zip64Eocd = eocd + 76;
  zip64.writeUInt16LE(0xffff, zip64Eocd + 8);
  zip64.writeUInt16LE(0xffff, zip64Eocd + 10);
  zip64.writeUInt32LE(0xffffffff, zip64Eocd + 12);
  zip64.writeUInt32LE(0xffffffff, zip64Eocd + 16);
  return zip64;
}

describe('zip decodeApkg', () => {
  it('reads ZIP64 archives with local size sentinels and extra-field sizes', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', Buffer.from('zip64-small-fixture'));
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    const eocd = bytes.readUInt32LE(bytes.length - 22) === 0x06054b50
      ? bytes.length - 22
      : bytes.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const centralOffset = bytes.readUInt32LE(eocd + 16);
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    const nameLength = bytes.readUInt16LE(localOffset + 26);
    const extraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
    const localZip64 = Buffer.alloc(20);
    localZip64.writeUInt16LE(0x0001, 0);
    localZip64.writeUInt16LE(16, 2);
    localZip64.writeBigUInt64LE(BigInt(uncompressedSize), 4);
    localZip64.writeBigUInt64LE(BigInt(compressedSize), 12);
    const withLocalExtra = Buffer.concat([bytes.subarray(0, dataOffset), localZip64, bytes.subarray(dataOffset)]);
    withLocalExtra.writeUInt16LE(extraLength + localZip64.length, localOffset + 28);
    const classicEocd = withLocalExtra.length - 22;
    withLocalExtra.writeUInt32LE(centralOffset + localZip64.length, classicEocd + 16);
    const zip64 = makeZip64LocalHeader(withLocalExtra);
    const result = await decodeApkg(zip64);
    expect(Buffer.from(result.get('collection.anki2')!.data).toString()).toBe('zip64-small-fixture');
  });
  it('reads a small force-ZIP64 streaming descriptor archive', async () => {
    const bytes = Buffer.from(
      'UEsDBC0ACAAAAAAAIQAAAAAA//////////8QABQAY29sbGVjdGlvbi5hbmtpMgEAEAAAAAAAAAAAAAAAAAAAAAAAZm9yY2UgWklQNjQgc3RyZWFtaW5nIGRhdGEgZGVzY3JpcHRvclBLBwh5Xqy6JQAAAAAAAAAlAAAAAAAAAFBLAQItAC0ACAAAAAAAIQB5Xqy6JQAAACUAAAAQAAAAAAAAAAAAAACAAQAAAABjb2xsZWN0aW9uLmFua2kyUEsFBgAAAAABAAEAPgAAAH8AAAAAAA==',
      'base64',
    );
    const result = await decodeApkg(bytes);
    expect(Buffer.from(result.get('collection.anki2')!.data).toString())
      .toBe('force ZIP64 streaming data descriptor');
  });
  it('rejects non-zip bytes', async () => {
    await expect(decodeApkg(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('round-trips members with media map', async () => {
    const mediaJson = JSON.stringify({ 0: 'a.png' });
    const bytes = await encodeApkg([{ name: 'collection.anki2', data: Buffer.from('sqlite-bytes') }], mediaJson);
    const entries = await decodeApkg(bytes);
    expect(entries.get('collection.anki2')?.name).toBe('collection.anki2');
    expect(entries.get('media')?.name).toBe('media');
    const text = Buffer.from(entries.get('media')!.data).toString('utf8');
    expect(text).toContain('a.png');
  });
  it('bounds actual ZIP output even when member input is smaller than the cap', async () => {
    await expect(encodeApkg(
      [{ name: 'small', data: new Uint8Array([1]) }],
      undefined,
      1,
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('rejects a member larger than the cap', async () => {
    const zip = new JSZip();
    zip.file('big', new Uint8Array(21 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(bytes)).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('never treats member names as paths (no traversal surface)', async () => {
    const zip = new JSZip();
    zip.file('../../evil.txt', 'x');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const entries = await decodeApkg(bytes);
    // The name is preserved as an opaque key only; nothing writes to disk.
    expect([...entries.keys()].some((k) => k.includes('evil.txt'))).toBe(true);
  });

  it('rejects duplicate names actually present in the central directory', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', 'one');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(cloneZipWithDuplicateCentralEntry(bytes))).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('rejects a small entry whose declared size exceeds the member cap before extraction', async () => {
    const zip = new JSZip();
    zip.file('selected', Buffer.from('small payload'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(cloneZipWithDeclaredSize(bytes, 21 * 1024 * 1024, 'selected')))
      .rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('does not inflate an irrelevant over-limit member', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', Buffer.from('sqlite-db-bytes'));
    zip.file('media/0', Buffer.from('small'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const hostileMedia = cloneZipWithDeclaredSize(bytes, 21 * 1024 * 1024, 'media/0');
    const entries = await decodeApkg(hostileMedia, { relevant: (name) => name === 'collection.anki2' });
    expect([...entries.keys()]).toEqual(['collection.anki2']);
    expect(Buffer.from(entries.get('collection.anki2')!.data).toString('utf8')).toBe('sqlite-db-bytes');
  });
  it('rejects compressed data that expands beyond its declared output size', async () => {
    const zip = new JSZip();
    zip.file('selected', Buffer.alloc(256 * 1024, 7));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const malformed = cloneZipWithDeclaredSize(bytes, 1, 'selected');
    await expect(decodeApkg(malformed, { relevant: (name) => name === 'selected' }))
      .rejects.toBeInstanceOf(ApkgFormatError);
  });
  it('skips irrelevant members when a relevance filter is given (never inflates media)', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', Buffer.from('sqlite-db-bytes'));
    // A huge media member that must NOT be inflated when the caller only
    // wants collection.anki2.
    zip.file('0', Buffer.alloc(30 * 1024 * 1024, 7));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const entries = await decodeApkg(bytes, { relevant: (n) => n === 'collection.anki2' });
    expect([...entries.keys()]).toEqual(['collection.anki2']);
    expect(Buffer.from(entries.get('collection.anki2')!.data).toString('utf8')).toBe('sqlite-db-bytes');
  });
});

/* ------------------------------------------------------------------ */
/* Import parse                                                        */
/* ------------------------------------------------------------------ */

const BASIC_MID = 1001;
const MODEL_BASIC = JSON.stringify({
  [String(BASIC_MID)]: {
    name: 'Basic', type: 0, sortf: 0,
    flds: [{ name: 'Front' }, { name: 'Back' }],
  },
});

const CLOZE_MID = 1002;
const MODEL_CLOZE = JSON.stringify({
  [String(CLOZE_MID)]: {
    name: 'Cloze', type: 1, sortf: 0,
    flds: [{ name: 'Text' }, { name: 'Back Extra' }],
  },
});

function colWith(models: string, decks?: string): Uint8Array {
      const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
  const p = join(dir, 'c.anki2');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer,
    dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text,
      flds text, sfld integer, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer,
      type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer,
      left integer, odue integer, odid integer, flags integer, data text);`);
  db.prepare('INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1,0,0,0,11,0,-1,0,\'{}\',?,?,\'{}\',\'{}\')')
    .run(models, decks ?? '{}');
  db.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Builds a real .apkg with specified note/card rows. */
async function parseNotesApkg(
  notes: Array<Record<string, unknown>>,
  models: string,
  decks?: string,
  afterInsert?: (db: DatabaseSync) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
  const p = join(dir, 'c.anki2');
  writeFileSync(p, colWith(models, decks));
  const db = new DatabaseSync(p);
  const insN = db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,?,0,-1,?,?,0,0,0,\'\')');
  const insC = db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,1,?,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')');
  for (const note of notes) {
    insN.run(Number(note.id), note.guid === null ? null : String(note.guid), Number(note.mid), String(note.tags ?? ''), String(note.flds ?? ''));
    const cardCount = Number(note.cardCount ?? 1);
    for (let order = 0; order < cardCount; order += 1) {
      insC.run(Number(note.id) * 10 + order + 1, Number(note.id), order);
    }
  }
  afterInsert?.(db);
  db.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  const zip = new JSZip();
  zip.file('collection.anki2', bytes as unknown as ArrayBuffer, { binary: true });
  return parseApkgImport(await zip.generateAsync({ type: 'uint8array' }));
}

async function makeUnsafeIntegerApkg(
  field: 'id' | 'mid' | 'did' | 'ord',
  value: bigint,
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'fsrs-int64-test-'));
  const p = join(dir, 'c.anki2');
  let db: DatabaseSync | null = null;
  try {
    writeFileSync(p, colWith(field === 'ord' ? MODEL_CLOZE : MODEL_BASIC));
    db = new DatabaseSync(p);
    const noteId = field === 'id' ? value : 1n;
    const mid = field === 'mid' ? value : BigInt(field === 'ord' ? CLOZE_MID : BASIC_MID);
    const did = field === 'did' ? value : 1n;
    const ord = field === 'ord' ? value : 0n;
    db.prepare(`INSERT INTO notes
      (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,?,0,-1,'','Question\x1fAnswer','Question',0,0,'')`)
      .run(noteId, 'unsafe-int64-note', mid);
    db.prepare(`INSERT INTO cards
      (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data)
      VALUES (11,?,?,?,0,-1,0,0,0,0,0,0,0,0,0,0,0,'')`)
      .run(noteId, did, ord);
    db.close();
    db = null;
    const zip = new JSZip();
    zip.file('collection.anki2', readFileSync(p), { binary: true });
    zip.file('media', '{}');
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseApkgImport', () => {
  it('parses basic notes into cards (front/back/tags)', async () => {
    const result = await parseNotesApkg(
      [
        { id: 1, guid: 'g1', mid: BASIC_MID, tags: ' math basic ', flds: 'What is 2+2?\x1f4' },
        { id: 2, guid: 'g2', mid: BASIC_MID, tags: '', flds: 'Capital of France?\x1fParis' },
      ],
      MODEL_BASIC,
    );
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0]).toEqual({
      front: 'What is 2+2?', back: '4', deckPath: null, tags: ['math', 'basic'],
    });
    expect(result.cards[1].front).toBe('Capital of France?');
    expect(result.cards[1].back).toBe('Paris');
    expect(result.skippedNotes).toBe(0);
    expect(result.skippedEmpty).toBe(0);
  });

  it('imports only the active cloze ordinal and preserves Back Extra', async () => {
    const result = await parseNotesApkg([
      { id: 1, guid: 'cloze-c2-only', mid: CLOZE_MID, tags: '', flds: 'Only {{c2::Paris}}\x1fExtra one' },
      { id: 2, guid: 'cloze-active-c2', mid: CLOZE_MID, tags: '', flds: 'Both {{c1::one}} and {{c2::two}}\x1fExtra two' },
    ], MODEL_CLOZE, undefined, (db) => {
      db.prepare('UPDATE cards SET ord = 1 WHERE nid IN (1, 2)').run();
    });
    expect(result.cards).toEqual([
      { front: 'Only [Paris]', back: 'Extra one', deckPath: null, tags: [] },
      { front: 'Both one and [two]', back: 'Extra two', deckPath: null, tags: [] },
    ]);
    expect(result.cards.every((card) => isClozeFront(card.front))).toBe(true);
  });

  it('imports every matching c1 deletion marker as product cloze markers', async () => {
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'cloze-multiple-c1', mid: CLOZE_MID, tags: '', flds: 'A {{c1::first}} and {{c1::second}}\x1fExtra' }],
      MODEL_CLOZE,
    );
    expect(result.cards[0]).toEqual({
      front: 'A [first] and [second]', back: 'Extra', deckPath: null, tags: [],
    });
  });

  it('keeps cloze-like braces literal for Basic models', async () => {
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'basic-cloze-like-text', mid: BASIC_MID, tags: '', flds: '{{c1::literal}}\x1fBack' }],
      MODEL_BASIC,
    );
    expect(result.cards[0].front).toBe('{{c1::literal}}');
    expect(isClozeFront(result.cards[0].front)).toBe(false);
  });

  it.each([
    ['cloze hints', '{{c1::Paris::city}}'],
    ['nested clozes', '{{c1::outer {{c2::inner}}}}'],
    ['malformed clozes', '{{c1::Paris'],
    ['literal brackets in cloze answers', '{{c1::[Paris]}}'],
    ['literal product markers outside clozes', 'A [literal] {{c1::Paris}}'],
    ['empty active clozes', '{{c1::}}'],
    ['whitespace-only active clozes', '{{c1::   }}'],
    ['empty active marker mixed with a non-empty marker', '{{c1::}} and {{c1::answer}}'],
  ])('rejects unsupported %s instead of importing as Basic', async (_label, text) => {
    await expect(parseNotesApkg(
      [{ id: 1, guid: 'unsupported-cloze', mid: CLOZE_MID, tags: '', flds: `${text}\x1fExtra` }],
      MODEL_CLOZE,
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('truthfully counts multi-card cloze notes as skipped notes', async () => {
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'multi-card-cloze', mid: CLOZE_MID, tags: '', flds: '{{c1::one}} {{c2::two}}\x1fExtra', cardCount: 2 }],
      MODEL_CLOZE,
    );
    expect(result.cards).toHaveLength(0);
    expect(result.skippedNotes).toBe(1);
  });

  it.each([
    ['note id above safe range', 'id', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['note id below safe range', 'id', BigInt(Number.MIN_SAFE_INTEGER) - 1n],
    ['model id above safe range', 'mid', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['model id below safe range', 'mid', BigInt(Number.MIN_SAFE_INTEGER) - 1n],
    ['deck id above safe range', 'did', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['deck id below safe range', 'did', BigInt(Number.MIN_SAFE_INTEGER) - 1n],
    ['cloze ordinal above safe range', 'ord', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['cloze ordinal below safe range', 'ord', BigInt(Number.MIN_SAFE_INTEGER) - 1n],
  ] as const)('rejects %s as an unsupported SQLite integer', async (_label, field, value) => {
    const archive = await makeUnsafeIntegerApkg(field, value);
    await expect(parseApkgImport(archive)).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('rejects model metadata over the UTF-8 byte limit before parsing', async () => {
    const basic = JSON.parse(MODEL_BASIC) as Record<string, unknown>;
    const padding = '😀'.repeat(Math.floor(ANKI_MAX_METADATA_BYTES / 4) + 1);
    expect(padding.length).toBeLessThan(ANKI_MAX_METADATA_BYTES);
    const metadata = JSON.stringify({
      ...basic,
      [String(BASIC_MID)]: {
        ...(basic[String(BASIC_MID)] as Record<string, unknown>),
        padding,
      },
    });
    expect(Buffer.byteLength(metadata, 'utf8')).toBeGreaterThan(ANKI_MAX_METADATA_BYTES);
    await expect(parseNotesApkg(
      [{ id: 1, guid: 'oversized-model-metadata', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      metadata,
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('rejects deck metadata over the UTF-8 byte limit before parsing', async () => {
    const decks = JSON.stringify({
      1: { name: '😀'.repeat(Math.floor(ANKI_MAX_METADATA_BYTES / 4) + 1) },
    });
    expect(decks.length).toBeLessThan(ANKI_MAX_METADATA_BYTES);
    expect(Buffer.byteLength(decks, 'utf8')).toBeGreaterThan(ANKI_MAX_METADATA_BYTES);
    await expect(parseNotesApkg(
      [{ id: 1, guid: 'oversized-deck-metadata', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      decks,
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });
  it('bounds selected field text by UTF-8 bytes before HTML parsing', async () => {
    const front = '😀'.repeat(Math.floor(ANKI_MAX_FIELD_SOURCE_LENGTH / 4) + 1);
    expect(front.length).toBeLessThan(ANKI_MAX_FIELD_SOURCE_LENGTH);
    expect(Buffer.byteLength(front, 'utf8')).toBeGreaterThan(ANKI_MAX_FIELD_SOURCE_LENGTH);
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'oversized-field-bytes', mid: BASIC_MID, tags: '', flds: `${front}\x1fA` }],
      MODEL_BASIC,
    );
    expect(result.cards).toHaveLength(0);
    expect(result.skippedEmpty).toBe(1);
  });
  it('bounds tag text by UTF-8 bytes before transferring the SQLite value', async () => {
    const tags = '😀'.repeat(Math.floor(ANKI_MAX_TAG_SOURCE_LENGTH / 4) + 1);
    expect(tags.length).toBeLessThan(ANKI_MAX_TAG_SOURCE_LENGTH);
    expect(Buffer.byteLength(tags, 'utf8')).toBeGreaterThan(ANKI_MAX_TAG_SOURCE_LENGTH);
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'oversized-tag-bytes', mid: BASIC_MID, tags, flds: 'Q\x1fA' }],
      MODEL_BASIC,
    );
    expect(result.cards).toHaveLength(0);
    expect(result.skippedEmpty).toBe(1);
  });

  it('accepts a custom model when an unused field exceeds the selected-field bound', async () => {
    const model = JSON.stringify({
      [String(BASIC_MID)]: {
        name: 'ThreeFields', type: 0, sortf: 0,
        flds: [{ name: 'Front' }, { name: 'Back' }, { name: 'Unused' }],
      },
    });
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'unused-large-field', mid: BASIC_MID, tags: '', flds: `Q\x1fA\x1f${'x'.repeat(300_000)}` }],
      model,
    );
    expect(result.cards).toEqual([{ front: 'Q', back: 'A', deckPath: null, tags: [] }]);
  });

  it('selects indexed fields from bounded raw field bytes in model order', async () => {
    const model = JSON.stringify({
      [String(BASIC_MID)]: {
        name: 'Reordered', type: 0, sortf: 0,
        flds: [{ name: 'Extra' }, { name: 'Back' }, { name: 'Front' }],
      },
    });
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'reordered-fields', mid: BASIC_MID, tags: '', flds: 'unused\x1fAnswer\x1fQuestion' }],
      model,
    );
    expect(result.cards).toEqual([{ front: 'Question', back: 'Answer', deckPath: null, tags: [] }]);
  });

  it('preserves literal JSON-escape-like backslashes in note fields', async () => {
    const front = String.raw`one \u001f`;
    const back = String.raw`two \\u001f`;
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'literal-backslashes', mid: BASIC_MID, tags: '', flds: `${front}\x1f${back}` }],
      MODEL_BASIC,
    );
    expect(result.cards).toEqual([{ front, back, deckPath: null, tags: [] }]);
  });

  it('scans bounded raw field bytes without expanding large NUL-containing fields', async () => {
    const model = JSON.stringify({
      [String(BASIC_MID)]: {
        name: 'ThreeFields', type: 0, sortf: 0,
        flds: [{ name: 'Front' }, { name: 'Back' }, { name: 'Unused' }],
      },
    });
    const result = await parseNotesApkg([
      {
        id: 1,
        guid: 'unused-nuls',
        mid: BASIC_MID,
        tags: '',
        flds: `Q\x1fA\x1f${'\0'.repeat(128 * 1024)}`,
      },
      {
        id: 2,
        guid: 'selected-nuls',
        mid: BASIC_MID,
        tags: '',
        flds: `${'\0'.repeat(128 * 1024)}\x1fA\x1funused`,
      },
    ], model);
    expect(result.cards).toEqual([{ front: 'Q', back: 'A', deckPath: null, tags: [] }]);
    expect(result.skippedEmpty).toBe(1);
  });

  it('converts field HTML to plain text', async () => {
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'g', mid: BASIC_MID, tags: '', flds: '<b>Bold</b> Q<br>line\x1fA &amp; B' }],
      MODEL_BASIC,
    );
    expect(result.cards[0].front).toBe('Bold Q\nline');
    expect(result.cards[0].back).toBe('A & B');
  });

  it('skips multi-card notes (reversed models)', async () => {
    // Build a note with TWO cards by hand.
    const dbBytes = colWith(MODEL_BASIC);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
    const p = join(dir, 'c.anki2');
    writeFileSync(p, dbBytes);
    const db = new DatabaseSync(p);
    db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (1,\'g\',?,0,-1,\'\',\'Q\x1fA\',0,0,0,\'\')').run(BASIC_MID);
    db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (11,1,1,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')').run();
    db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (12,1,1,1,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')').run();
    db.close();
    const colBytes = new Uint8Array(readFileSync(p));
    rmSync(dir, { recursive: true, force: true });
    const z = new JSZip();
    z.file('collection.anki2', colBytes as unknown as ArrayBuffer, { binary: true });
    const bytes = await z.generateAsync({ type: 'uint8array' });
    const result = await parseApkgImport(bytes);
    expect(result.cards).toHaveLength(0);
    expect(result.skippedNotes).toBe(1);
  });
  it('skips notes with zero or multiple cards in the set-based card summary', async () => {
    const result = await parseNotesApkg([
      { id: 1, guid: 'no-card', mid: BASIC_MID, tags: '', flds: 'Q\x1fA', cardCount: 0 },
      { id: 2, guid: 'two-cards', mid: BASIC_MID, tags: '', flds: 'Q\x1fA', cardCount: 2 },
    ], MODEL_BASIC);
    expect(result.cards).toHaveLength(0);
    expect(result.skippedNotes).toBe(2);
  });

  it('rejects a required SQLite view even when it exposes the expected columns', async () => {
    await expect(parseNotesApkg(
      [{ id: 1, guid: 'view-note', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      undefined,
      (db) => {
        db.exec(`DROP TABLE notes;
          CREATE VIEW notes AS SELECT 1 AS id, 'view-note' AS guid, ${BASIC_MID} AS mid,
            0 AS mod, -1 AS usn, '' AS tags, 'Q' || char(31) || 'A' AS flds,
            0 AS sfld, 0 AS csum, 0 AS flags, '' AS data`);
      },
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });
  it('reports missing required SQLite columns as malformed packages', async () => {
    await expect(parseNotesApkg(
      [{ id: 1, guid: 'missing-column', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      undefined,
      (db) => db.exec('ALTER TABLE notes DROP COLUMN tags'),
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });


  it('keeps distinct null-GUID notes while rejecting malformed row types as package errors', async () => {
    const result = await parseNotesApkg([
      { id: 1, guid: null, mid: BASIC_MID, tags: '', flds: 'First\x1f1' },
      { id: 2, guid: null, mid: BASIC_MID, tags: '', flds: 'Second\x1f2' },
    ], MODEL_BASIC);
    expect(result.cards.map((card) => card.front)).toEqual(['First', 'Second']);

    await expect(parseNotesApkg(
      [{ id: 3, guid: 'bad-mid', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      undefined,
      (db) => db.exec("UPDATE notes SET mid = 'not-an-integer' WHERE id = 3"),
    )).rejects.toBeInstanceOf(ApkgFormatError);
    await expect(parseNotesApkg(
      [{ id: 4, guid: 'bad-tags', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      undefined,
      (db) => db.exec("UPDATE notes SET tags = CAST('not-text' AS BLOB) WHERE id = 4"),
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });


  it('skips empty-field notes', async () => {
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'g1', mid: BASIC_MID, tags: '', flds: '\x1f4' }],
      MODEL_BASIC,
    );
    expect(result.cards).toHaveLength(0);
    expect(result.skippedEmpty).toBe(1);
  });

  it('deduplicates notes by guid (first wins) and orders by note id', async () => {
    const result = await parseNotesApkg(
      [
        { id: 2, guid: 'same', mid: BASIC_MID, tags: '', flds: 'Second\x1f2' },
        { id: 1, guid: 'same', mid: BASIC_MID, tags: '', flds: 'First\x1f1' },
      ],
      MODEL_BASIC,
    );
    expect(result.cards.map((c) => c.front)).toEqual(['First']);
  });

  it('assigns deck paths from card deck ids', async () => {
    const decks = JSON.stringify({
      1: { name: 'Default' },
      5: { name: 'Spanish::Verbs' },
    });
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'g', mid: BASIC_MID, tags: '', flds: 'Q\x1fA' }],
      MODEL_BASIC,
      decks,
    );
    // The helper inserts every card with did=1 → Default.
    expect(result.cards[0].deckPath).toBe('Default');
  });

  it('throws ApkgFormatError when collection.anki2 is absent', async () => {
    const zip = new JSZip();
    zip.file('other', 'x');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(parseApkgImport(bytes)).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('throws when collection.anki2 is not a sqlite db', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', 'this is not sqlite at all........');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(parseApkgImport(bytes)).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('imports at most the product-supported 20 tags per card', async () => {
    const tags = Array.from({ length: 24 }, (_, index) => ` tag${index} `).join(' ');
    const result = await parseNotesApkg(
      [{ id: 1, guid: 'many-tags', mid: BASIC_MID, tags, flds: 'Question\x1fAnswer' }],
      MODEL_BASIC,
    );
    expect(result.cards[0].tags).toEqual(Array.from({ length: 20 }, (_, index) => `tag${index}`));
  });
  it('caps retained cards and counts only valid notes beyond the limit', async () => {
    jest.setTimeout(60000);
    const notes = Array.from({ length: 1002 }, (_, i) => ({
      id: i + 1, guid: `g${i}`, mid: BASIC_MID, tags: '',
      flds: i === 1001 ? '\x1f' : `Q${i}\x1fA${i}`,
    }));
    const result = await parseApkgImport(await makeApkg(notes));
    expect(result.cards).toHaveLength(1000);
    expect(result.skippedOverLimit).toBe(1);
    expect(result.skippedEmpty).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Export build                                                        */
/* ------------------------------------------------------------------ */

describe('export collection build', () => {
  const card = (over: Partial<import('./apkg').ExportCard> = {}): import('./apkg').ExportCard => ({
    id: 'c1', front: 'Front?', back: 'Back', deckPath: null, tags: ['t1'],
    createdAtMs: 1700000000000, updatedAtMs: 1700000000000, dueMs: 1700000000000,
    state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [],
    ...over,
  });

  it('builds a collection that re-opens and contains the card', async () => {
    const bytes = await buildCollectionBytes([card()], 1700000000000);
    expect(bytes.length).toBeGreaterThan(100);
    // Write bytes to temp and open read-only (same mechanism as import).
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
    const p = join(dir, 'c.anki2');
    writeFileSync(p, bytes);
    const db = new DatabaseSync(p, { readOnly: true });
    const note = db.prepare('SELECT flds, tags, mid FROM notes').get() as { flds: string; tags: string; mid: number };
    expect(note.flds).toContain('Front?');
    expect(note.flds).toContain('Back');
    expect(note.tags).toContain('t1');
    const crd = db.prepare('SELECT type, queue, reps, lapses FROM cards').get() as { type: number; queue: number; reps: number; lapses: number };
    expect(crd.type).toBe(0);
    expect(crd.queue).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps cloze cards to the cloze model', async () => {
    const bytes = await buildCollectionBytes([card({ front: 'The capital is [Berlin]' })], 1700000000000);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
    const p = join(dir, 'c.anki2');
    writeFileSync(p, bytes);
    const db = new DatabaseSync(p, { readOnly: true });
    const models = db.prepare('SELECT models FROM col').get() as { models: string };
    expect(models.models).toContain('CueLingua Cloze');
    const note = db.prepare('SELECT mid, flds FROM notes').get() as { mid: number; flds: string };
    expect(note.flds).toContain('{{c1::Berlin}}');
    const crd = db.prepare('SELECT type FROM cards').get() as { type: number };
    expect(crd.type).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a product cloze through the real APKG builder and importer', async () => {
    const collection = await buildCollectionBytes(
      [card({ front: 'The capital is [Paris]', back: 'France' })],
      1700000000000,
    );
    const archive = await assembleApkgBytes(collection, []);
    const imported = await parseApkgImport(archive);
    expect(imported.cards).toEqual([
      { front: 'The capital is [Paris]', back: 'France', deckPath: 'Imported', tags: ['t1'] },
    ]);
    expect(isClozeFront(imported.cards[0].front)).toBe(true);
  });

  it('preserves learning, relearning, overdue review, suspended, and cloze scheduling fields', async () => {
    const nowMs = 1700000000000;
    const nowDayMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const stepConfig = getFSRSStepConfiguration();
    const bytes = await buildCollectionBytes([
      card({ id: 'new-cloze', front: 'X is [Y]', back: 'Cloze answer' }),
      card({ id: 'learning', state: 1, reps: 2, learningSteps: 1, dueMs: nowMs + 60_000, back: 'Learning answer' }),
      card({ id: 'relearning', state: 3, reps: 5, lapses: 1, learningSteps: 0, dueMs: nowMs + 120_000, back: 'Relearning answer' }),
      card({ id: 'overdue', state: 2, reps: 4, stability: 30, dueMs: nowDayMs - 2 * 86_400_000, back: 'Overdue answer' }),
      card({ id: 'suspended', state: 2, reps: 3, stability: 5, suspended: true, dueMs: nowDayMs + 86_400_000, back: 'Suspended answer' }),
    ], nowMs, new Map(), {
      ...stepConfig,
      progressByCardId: new Map([['learning', 1], ['relearning', 0]]),
    });
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-export-states-'));
    const path = join(dir, 'collection.anki2');
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT n.flds, n.mid, c.type, c.queue, c.due, c.reps, c.lapses, c.left
        FROM cards c JOIN notes n ON n.id = c.nid`).all() as Array<Record<string, number | string>>;
      const byBack = new Map(rows.map((row) => [String(row.flds).split('\x1f')[1], row]));
      const learning = byBack.get('Learning answer')!;
      const relearning = byBack.get('Relearning answer')!;
      const overdue = rows.find((row) => row.type === 2 && row.queue === 2)!;
      const suspended = rows.find((row) => row.queue === -1)!;
      const cloze = rows.find((row) => row.mid === 1650_000_002)!;
      expect([learning.type, learning.queue, learning.due, learning.left]).toEqual([1, 1, Math.floor((nowMs + 60_000) / 1000), 1]);
      expect([relearning.type, relearning.queue, relearning.due, relearning.left]).toEqual([3, 1, Math.floor((nowMs + 120_000) / 1000), 1]);
      const dconf = JSON.parse((db.prepare('SELECT dconf FROM col').get() as { dconf: string }).dconf) as
        Record<string, { new: { delays: number[] }; lapse: { delays: number[] } }>;
      expect(dconf['1'].new.delays).toEqual(stepConfig.learningSteps.map((step) => ConvertStepUnitToMinutes(step as StepUnit)));
      expect(dconf['1'].lapse.delays).toEqual(stepConfig.relearningSteps.map((step) => ConvertStepUnitToMinutes(step as StepUnit)));
      const crtSec = (db.prepare('SELECT crt FROM col').get() as { crt: number }).crt;
      expect(overdue.due).toBe(Math.floor((nowDayMs - 2 * 86_400_000) / 86_400_000) - Math.floor(crtSec / 86_400));
      expect(overdue.due).toBeLessThan(Math.floor(nowMs / 86_400_000) - Math.floor(crtSec / 86_400));
      expect([suspended.type, suspended.queue]).toEqual([2, -1]);
      expect([cloze.type, cloze.queue]).toEqual([0, 0]);
      expect(String(cloze.flds)).toContain('{{c1::Y}}');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses active learning export when progress cannot be reconstructed', async () => {
    const stepConfig = getFSRSStepConfiguration();
    await expect(buildCollectionBytes(
      [card({ id: 'legacy-learning', state: 1, dueMs: 1700000060000 })],
      1700000000000,
      new Map(),
      { ...stepConfig, progressByCardId: new Map() },
    )).rejects.toBeInstanceOf(ApkgFormatError);
  });


  it('rejects tags containing whitespace rather than corrupting their tokenization', async () => {
    await expect(buildCollectionBytes([card({ tags: ['two words'] })], 1700000000000))
      .rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('embeds only successful media references in the answer/back field', async () => {
    const fileName = 'image-1.png';
    const collection = await buildCollectionBytes(
      [card({ front: 'Front', back: 'Answer' })],
      1700000000000,
      new Map([['c1', [fileName]]]),
    );
    const pkg = await assembleApkgBytes(collection, [
      { fileName, data: new Uint8Array([1, 2, 3]), sourceUrl: 'https://images.example/image-1.png' },
    ]);
    const entries = await decodeApkg(pkg);
    const media = JSON.parse(Buffer.from(entries.get('media')!.data).toString('utf8')) as Record<string, string>;
    expect(media['0']).toBe(fileName);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-export-media-'));
    const path = join(dir, 'collection.anki2');
    writeFileSync(path, entries.get('collection.anki2')!.data);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const flds = (db.prepare('SELECT flds FROM notes').get() as { flds: string }).flds.split('\x1f');
      expect(flds[0]).not.toContain('<img');
      expect(flds[1]).toContain('<img src="image-1.png">');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or colliding media names before ZIP assembly', async () => {
    const collection = await buildCollectionBytes([card()], 1700000000000);
    await expect(assembleApkgBytes(collection, [
      { fileName: '../pic.png', data: new Uint8Array([1]), sourceUrl: 'https://images.example/pic.png' },
    ])).rejects.toBeInstanceOf(ApkgFormatError);
    await expect(assembleApkgBytes(collection, [
      { fileName: 'pic.png', data: new Uint8Array([1]), sourceUrl: 'https://a/pic.png' },
      { fileName: 'PIC.PNG', data: new Uint8Array([2]), sourceUrl: 'https://b/PIC.PNG' },
    ])).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('carries review scheduling (type/queue/due/reps/revlog)', async () => {
    const reviewed = card({
      reps: 4, lapses: 1, state: 2, stability: 30, difficulty: 5,
      dueMs: 1700000000000 + 30 * 86400000,
      lastReviewMs: 1690000000000,
      reviewLog: [
        { rating: 3, state: 0, reviewMs: 1690000000000, dueMs: 1690000000000, stability: 2, difficulty: 4, reps: 1, lapses: 0 },
      ],
    });
    const bytes = await buildCollectionBytes([reviewed], 1700000000000);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
    const p = join(dir, 'c.anki2');
    writeFileSync(p, bytes);
    const db = new DatabaseSync(p, { readOnly: true });
    const crd = db.prepare('SELECT type, queue, due, ivl, factor, reps, lapses FROM cards').get() as Record<string, number>;
    expect(crd.type).toBe(2);
    expect(crd.queue).toBe(2);
    expect(crd.ivl).toBe(30);
    expect(crd.reps).toBe(4);
    expect(crd.lapses).toBe(1);
    const revlog = db.prepare('SELECT count(*) c FROM revlog').get() as { c: number };
    expect(revlog.c).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assembleApkgBytes produces a decodable zip with media map', async () => {
    const collection = await buildCollectionBytes([card()], 1700000000000);
    const pkg = await assembleApkgBytes(collection, [
      { fileName: 'pic.png', data: new Uint8Array([1, 2, 3]), sourceUrl: 'https://x/pic.png' },
    ]);
    const entries = await decodeApkg(pkg);
    expect(entries.has('collection.anki2')).toBe(true);
    const media = JSON.parse(Buffer.from(entries.get('media')!.data).toString('utf8')) as Record<string, string>;
    expect(media['0']).toBe('pic.png');
  });

  it('uses Anki default ease when exported FSRS state has no SM-2 ease', async () => {
    const reviewed = card({ id: 'reviewed-factor', state: 2, reps: 1, difficulty: 10, stability: 4 });
    const bytes = await buildCollectionBytes([reviewed], 1700000000000);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
    const path = join(dir, 'c.anki2');
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const result = db.prepare('SELECT factor FROM cards').get() as { factor: number };
      expect(result.factor).toBe(2500);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('encodes a learning review interval from the next retained due boundary, not stability', async () => {
    const reviewAt = new Date('2026-08-28T00:00:00.000Z');
    const created = Timestamp.fromDate(reviewAt);
    const source: Flashcard = {
      id: 'fsrs-learning-history', front: 'Learning?', back: 'Learning answer', tags: [],
      createdAt: created, updatedAt: created, due: created, state: 0, stability: 0,
      difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [],
    };
    const first = applyReview(source, 3, reviewAt);
    const second = applyReview({ ...source, ...first.scheduling, reviewLog: [first.logEntry] }, 3,
      new Date('2026-08-28T00:10:00.000Z'));
    const exported = card({
      id: source.id, reps: second.scheduling.reps, state: second.scheduling.state,
      stability: second.scheduling.stability, dueMs: second.scheduling.due.toMillis(),
      reviewLog: [first.logEntry, second.logEntry].map((entry) => ({
        rating: entry.rating, state: entry.state, reviewMs: entry.review.toMillis(), dueMs: entry.due.toMillis(),
        stability: entry.stability, difficulty: entry.difficulty, reps: entry.reps, lapses: entry.lapses,
      })),
    });
    expect(first.scheduling.state).toBe(1);
    expect(first.scheduling.due.toMillis() - first.logEntry.review.toMillis()).toBe(600_000);
    const bytes = await buildCollectionBytes([exported], second.scheduling.due.toMillis());
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-learning-revlog-'));
    const path = join(dir, 'collection.anki2');
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT ivl, lastIvl, type FROM revlog ORDER BY id').all() as Array<Record<string, number>>;
      expect(rows.map((row) => row.ivl)).toEqual([-600, 2]);
      expect(rows.map((row) => row.lastIvl)).toEqual([0, -600]);
      expect(rows.map((row) => row.type)).toEqual([0, 0]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('round-trips every exported card with distinct GUIDs and collision-safe IDs', async () => {
    const first = card({ id: 'nYUyJt8GKU', front: 'First', deckPath: '6IYnXmPBMg', createdAtMs: 1690000000000 });
    const second = card({ id: 'APy4Z8mlmV', front: 'Second', deckPath: 'jbsoKLSxuD', createdAtMs: 1690000000000 });
    const reviewed = card({
      id: 'same-ms-reviews', front: 'Reviewed', deckPath: 'Reviews', reps: 2,
      createdAtMs: 1700000000000,
      stability: 4, difficulty: 5, dueMs: 1701000000000,
      reviewLog: [
        { rating: 1, state: 0, reviewMs: 1699999999000, dueMs: 1699999999000, stability: 1, difficulty: 5, reps: 1, lapses: 1 },
        { rating: 4, state: 1, reviewMs: 1699999999000, dueMs: 1700000000000, stability: 4, difficulty: 5, reps: 2, lapses: 1 },
      ],
    });
    const bytes = await buildCollectionBytes([first, second, reviewed], 1700000000000);
    const dir = mkdtempSync(join(tmpdir(), 'fsrs-export-roundtrip-'));
    const path = join(dir, 'collection.anki2');
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const notes = db.prepare('SELECT id, guid, flds FROM notes ORDER BY flds').all() as Array<{ id: number; guid: string; flds: string }>;
      const cards = db.prepare('SELECT id, nid, did, factor, reps FROM cards ORDER BY nid').all() as Array<{ id: number; nid: number; did: number; factor: number; reps: number }>;
      const decks = JSON.parse((db.prepare('SELECT decks FROM col').get() as { decks: string }).decks) as Record<string, { name: string }>;
      const revlog = db.prepare('SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id').all() as Array<Record<string, number>>;
      expect(notes).toHaveLength(3);
      expect(new Set(notes.map((note) => note.guid)).size).toBe(3);
      expect(new Set(cards.map((item) => item.id)).size).toBe(3);
      expect(new Set(cards.map((item) => item.nid)).size).toBe(3);
      expect(new Set(cards.map((item) => item.did)).size).toBe(3);
      expect(cards.filter((item) => item.reps > 0).map((item) => item.factor)).toEqual([2500]);
      expect(cards.map((item) => Math.floor(item.id / 1000)).sort((a, b) => a - b)).toEqual([1690000000, 1690000000, 1700000000]);
      expect(cards.filter((item) => Math.floor(item.id / 1000) === 1690000000).map((item) => item.id).sort((a, b) => a - b)).toEqual([1690000000000, 1690000000001]);
      expect(Object.values(decks).map((deck) => deck.name).sort()).toEqual(['6IYnXmPBMg', 'Default', 'Reviews', 'jbsoKLSxuD']);
      expect(revlog.map((entry) => entry.id)).toEqual([1699999999000, 1699999999001]);
      expect(revlog.map((entry) => entry.lastIvl)).toEqual([0, -1]);
      expect(revlog.map((entry) => entry.time)).toEqual([0, 0]);
      expect(revlog.map((entry) => entry.factor)).toEqual([0, 0]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    const packageBytes = await assembleApkgBytes(bytes, []);
    const imported = await parseApkgImport(packageBytes);
    expect(imported.cards.map((item) => item.front).sort()).toEqual(['First', 'Reviewed', 'Second']);
    expect(imported.cards.map((item) => item.deckPath).sort()).toEqual(['6IYnXmPBMg', 'Reviews', 'jbsoKLSxuD']);
  });
});

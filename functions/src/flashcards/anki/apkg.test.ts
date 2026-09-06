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
  assembleApkgBytes, ankiDeckIdForPath,
} from './apkg';
import { decodeApkg, encodeApkg, ApkgFormatError } from './zip';
import {
  ankiHtmlToPlainText, plainTextToAnkiHtml, decodeHtmlEntities,
  escapeHtmlText, isClozeFront, normalizeTag, splitAnkiTags,
} from './text';
import { ANKI_MAX_APKG_BYTES, ANKI_MAX_ZIP_AGGREGATE_BYTES } from './types';
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

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('decodeImportEnvelope', () => {
  it('accepts a valid base64 package', () => {
    const r = decodeImportEnvelope(b64(new Uint8Array([1, 2, 3])));
    expect('error' in r ? r.error : null).toBeNull();
  });

  it('rejects empty/missing', () => {
    expect('error' in decodeImportEnvelope('') ? (decodeImportEnvelope('') as { error: string }).error : '').toContain('required');
  });

  it('rejects malformed base64', () => {
    const r = decodeImportEnvelope('!!!not-base64!!!');
    expect('error' in r ? r.error : '').toContain('base64');
  });

  it('rejects oversized payloads by decoded byte count', () => {
    const big = Buffer.alloc(ANKI_MAX_APKG_BYTES + 1, 7);
    const r = decodeImportEnvelope(big.toString('base64'));
    expect('error' in r ? r.error : '').toContain('too large');
  });

  it('guards empty/missing base64 payloads', () => {
    expect('error' in decodeImportEnvelope('') ? (decodeImportEnvelope('') as { error: string }).error : '').toMatch(/required|empty/);
  });
});

describe('zip decodeApkg', () => {
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

  it('rejects a member larger than the cap', async () => {
    const zip = new JSZip();
    zip.file('big', new Uint8Array(21 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(bytes)).rejects.toThrow(/member too large/);
  });

  it('never treats member names as paths (no traversal surface)', async () => {
    const zip = new JSZip();
    zip.file('../../evil.txt', 'x');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const entries = await decodeApkg(bytes);
    // The name is preserved as an opaque key only; nothing writes to disk.
    expect([...entries.keys()].some((k) => k.includes('evil.txt'))).toBe(true);
  });

  it('rejects duplicate members that normalize to the same key (spoofing)', async () => {
    // Two RAW entries ('collection.anki2' and './collection.anki2') normalize
    // to the same key; jszip itself collapses exact dupes on load, but a
    // leading-./ pair that survives as distinct keys must be rejected, not
    // silently last-wins. Build the archive so both entries exist as distinct
    // jszip keys: 'collection.anki2' and 'sub/../collection.anki2' both key to
    // 'collection.anki2' only if jszip does not collapse 'sub/..' — use a name
    // jszip preserves literally but our normalize collapses.
    const zip = new JSZip();
    zip.file('collection.anki2', 'A');
    // jszip exposes this second file under key '/collection.anki2' (leading
    // slash preserved) — our normalize maps both to 'collection.anki2'.
    zip.file('/collection.anki2', 'B');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(bytes)).rejects.toBeInstanceOf(ApkgFormatError);
    await expect(decodeApkg(bytes)).rejects.toThrow(/Duplicate archive member/);
  });

  it('rejects an aggregate zip bomb by declared size before inflating', async () => {
    const zip = new JSZip();
    // Highly compressible members whose DECLARED total exceeds the aggregate
    // cap; each member is under the per-member cap, so only the aggregate
    // guard can catch this. 45 x ~1 MiB declared (> 40 MiB aggregate).
    // Exceed the aggregate cap with many per-member-legal 1 MiB chunks.
    const perChunk = 1024 * 1024;
    const count = Math.floor(ANKI_MAX_ZIP_AGGREGATE_BYTES / perChunk) + 2;
    const chunk = Buffer.alloc(perChunk, 65); // 1 MiB of 'A'
    for (let i = 0; i < count; i++) zip.file('member-' + i + '.bin', chunk);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(decodeApkg(bytes)).rejects.toThrow(/inflated bytes >/);
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

/** Builds a real .apkg with the given notes (one card each, did=1). */
async function parseNotesApkg(notes: Array<Record<string, unknown>>, models: string, decks?: string) {
      const dir = mkdtempSync(join(tmpdir(), 'fsrs-test-'));
  const p = join(dir, 'c.anki2');
  writeFileSync(p, colWith(models, decks));
  const db = new DatabaseSync(p);
  const insN = db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,?,0,-1,?,?,0,0,0,\'\')');
  const insC = db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,1,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')');
  for (const n of notes) {
    insN.run(Number(n.id), String(n.guid), Number(n.mid), String(n.tags ?? ''), String(n.flds ?? ''));
    insC.run(Number(n.id) * 10 + 1, Number(n.id));
  }
  db.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  const zip = new JSZip();
  zip.file('collection.anki2', bytes as unknown as ArrayBuffer, { binary: true });
  return parseApkgImport(await zip.generateAsync({ type: 'uint8array' }));
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
    await expect(parseApkgImport(bytes)).rejects.toThrow(/collection\.anki2/);
  });

  it('throws when collection.anki2 is not a sqlite db', async () => {
    const zip = new JSZip();
    zip.file('collection.anki2', 'this is not sqlite at all........');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(parseApkgImport(bytes)).rejects.toBeInstanceOf(ApkgFormatError);
  });

  it('caps the imported card count', async () => {
    jest.setTimeout(60000);
    const notes = Array.from({ length: 1001 }, (_, i) => ({
      id: i + 1, guid: `g${i}`, mid: BASIC_MID, tags: '', flds: `Q${i}\x1fA${i}`,
    }));
    const result = await parseApkgImport(await makeApkg(notes));
    expect(result.cards.length).toBeLessThanOrEqual(1000);
    expect(result.cards).toHaveLength(1000);
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
    expect(crd.type).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
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

  it('derives stable deterministic deck ids', () => {
    expect(ankiDeckIdForPath('Spanish')).toBe(ankiDeckIdForPath('Spanish'));
    expect(ankiDeckIdForPath('Spanish')).not.toBe(ankiDeckIdForPath('French'));
  });
});

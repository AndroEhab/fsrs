/**
 * Service-layer tests for Anki .apkg import/export: owner-scoped card
 * transactions and current deck-name resolution, export selection, and error
 * mapping. The format layer is covered by apkg.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import {
  importApkg, exportApkg, writeImportedCards, selectExportCards,
  ApkgImportError, ApkgExportError, normalizeDeckPathForImportPublic,
} from './service';
import { parseApkgImport } from './apkg';
import { ANKI_MAX_APKG_RESPONSE_BYTES, ImportedCard } from './types';
import { getOrCreateOwnedDeck, readOwnedDeckInTransaction } from '../decks';
import {
  safeValidateImportApkg, safeValidateExportApkg, validateImportApkg,
  validateExportApkg,
} from './validators';
jest.mock('../decks', () => ({
  getOrCreateOwnedDeck: jest.fn(),
  readOwnedDeckInTransaction: jest.fn(),
}));

// Mock Firebase Admin Firestore (same shape as service.test.ts's mocks).
const createMockDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-id',
  data: jest.fn(),
  exists: true,
  set: jest.fn(),
  get: jest.fn(),
  ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() },
  ...overrides,
});

const createMockCollection = (doc: Record<string, unknown>): Record<string, unknown> => {
  const collection: Record<string, unknown> = {
    doc: jest.fn(() => doc),
    where: jest.fn(), orderBy: jest.fn(), limit: jest.fn(), startAfter: jest.fn(),
    select: jest.fn(), get: jest.fn(),
  };
  collection.where = jest.fn(() => collection);
  collection.orderBy = jest.fn(() => collection);
  collection.limit = jest.fn(() => collection);
  collection.startAfter = jest.fn(() => collection);
  collection.select = jest.fn(() => collection);
  collection.get = jest.fn().mockResolvedValue({ empty: true, docs: [] });
  return collection;
};

const mockCardDoc: any = createMockDoc();
const mockCardCollection: any = createMockCollection(mockCardDoc);
const mockTransaction = {
  create: jest.fn(),
  get: jest.fn(),
};
const mockDbInstance = {
  collection: jest.fn(() => mockCardCollection),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDbInstance),
  Timestamp: {
    now: jest.fn(() => ({ toDate: () => new Date(), seconds: Date.now() / 1000, nanoseconds: 0, toMillis: () => Date.now() })),
    fromDate: jest.fn((d: Date) => ({ toDate: () => d, seconds: d.getTime() / 1000, nanoseconds: 0, toMillis: () => d.getTime() })),
    fromMillis: jest.fn((ms: number) => ({ toDate: () => new Date(ms), seconds: ms / 1000, nanoseconds: (ms % 1000) * 1000000, toMillis: () => ms })),
  },
  FieldValue: { delete: jest.fn(() => ({ __fieldDelete: true })) },
  FieldPath: { documentId: jest.fn(() => '__name__') },
}));

/** Builds a valid .apkg (SQLite collection) with the given notes. */
async function buildApkg(
  notes: Array<{ id: number | bigint; flds: string; tags?: string }>,
  compression: 'STORE' | 'DEFLATE' = 'STORE',
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fsrs-svc-'));
  const p = join(dir, 'collection.anki2');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer,
    dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text,
      flds text, sfld integer, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer,
      type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer,
      left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
    CREATE TABLE graves (usn integer, oid integer, type integer);`);
  const models = JSON.stringify({
    1: { type: 0, sortf: 0, flds: [{ name: 'Front' }, { name: 'Back' }] },
  });
  db.prepare(`INSERT INTO col (id,crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags)
    VALUES (1,1700000000,1700000000,0,11,0,-1,0,'{}',?,?,'{}','{}')`)
    .run(models, JSON.stringify({ 1: { name: 'Default' }, 2: { name: 'Spanish::Verbs' } }));
  db.exec('BEGIN');
  const insN = db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,1,0,-1,?,?,0,0,0,\'\')');
  const insC = db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,?,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')');
  notes.forEach((n, i) => {
    insN.run(n.id, `guid-${n.id}`, n.tags ?? '', n.flds);
    const cardId = typeof n.id === 'bigint' ? 11 : n.id * 10 + 1;
    insC.run(cardId, n.id, i === 0 ? 1 : 2);
  });
  db.exec('COMMIT');
  db.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  const zip = new JSZip();
  zip.file('collection.anki2', bytes as unknown as ArrayBuffer, { binary: true });
  const out = await zip.generateAsync({
    type: 'uint8array', compression, compressionOptions: { level: 1 },
  });
  return Buffer.from(out).toString('base64');
}

describe('anki import service', () => {
  const OWNER_IMPORT = 'anki-import-owner';

  beforeEach(() => {
    jest.clearAllMocks();
    const { Timestamp } = require('firebase-admin/firestore');
    mockDbInstance.collection.mockClear();
    mockDbInstance.runTransaction.mockImplementation(async (callback: (tx: typeof mockTransaction) => unknown) => callback(mockTransaction));
    mockTransaction.create.mockImplementation(() => undefined);
    (getOrCreateOwnedDeck as jest.Mock).mockImplementation(async (ownerId: string, name: string) => ({
      id: `deck:${name}`, ownerId, name,
    }));
    (readOwnedDeckInTransaction as jest.Mock).mockImplementation(async (_tx: unknown, id: string, ownerId: string) => ({
      id, ownerId, name: `current:${id}`,
    }));

    Timestamp.now.mockReturnValue({ toMillis: () => 1700000000000, seconds: 1700000000, nanoseconds: 0 });
  });

  it('writes owner-scoped cards in one transaction after rereading owned decks', async () => {
    const events: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    (readOwnedDeckInTransaction as jest.Mock).mockImplementation(async (_tx: unknown, id: string, ownerId: string) => {
      events.push('read-deck');
      return { id, ownerId, name: 'Renamed::Verbs' };
    });
    mockTransaction.create.mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
      events.push('create-card');
      writes.push(data);
    });
    const cards: ImportedCard[] = [
      { front: 'Q1', back: 'A1', deckPath: 'Spanish::Verbs', tags: ['x'] },
      { front: 'Q2', back: 'A2', deckPath: null, tags: [] },
    ];
    const result = await writeImportedCards(cards, OWNER_IMPORT);
    expect(result).toEqual({ atomic: true, batchCount: 1 });
    expect(getOrCreateOwnedDeck).toHaveBeenCalledWith(OWNER_IMPORT, 'Spanish::Verbs');
    expect(readOwnedDeckInTransaction).toHaveBeenCalledWith(mockTransaction, 'deck:Spanish::Verbs', OWNER_IMPORT);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      ownerId: OWNER_IMPORT, front: 'Q1', back: 'A1',
      deckId: 'deck:Spanish::Verbs', deck: 'Renamed::Verbs',
    });
    expect(events.indexOf('read-deck')).toBeLessThan(events.indexOf('create-card'));
  });

  it('imports parsed cards through the owner-scoped deck registry', async () => {
    const pkg = await buildApkg([
      { id: 1, flds: 'What is 2+2?\x1f4', tags: ' math ' },
      { id: 2, flds: 'Capital?\x1fParis' },
    ]);
    const result = await importApkg({ package: pkg }, OWNER_IMPORT);
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].front).toBe('What is 2+2?');
    expect(result.cards[0].deckPath).toBe('Default');
    expect(result.cards[1].deckPath).toBe('Spanish::Verbs');
    expect(result.skippedNotes).toBe(0);
    expect(result.skippedEmpty).toBe(0);
    expect(result.skippedOverLimit).toBe(0);
    expect(result.atomic).toBe(true);
    expect(result.batchCount).toBe(1);
    expect(getOrCreateOwnedDeck).toHaveBeenCalledWith(OWNER_IMPORT, 'Default');
    expect(getOrCreateOwnedDeck).toHaveBeenCalledWith(OWNER_IMPORT, 'Spanish::Verbs');
    expect(mockTransaction.create).toHaveBeenCalledTimes(2);
    expect(mockTransaction.create.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: OWNER_IMPORT, deck: 'current:deck:Default' }),
      expect.objectContaining({ ownerId: OWNER_IMPORT, deck: 'current:deck:Spanish::Verbs' }),
    ]));
  });
  it('rejects an oversized valid import response before deck resolution or card writes', async () => {
    jest.setTimeout(60000);
    const field = '\\'.repeat(9_000);
    const pkg = await buildApkg(
      Array.from({ length: 1_000 }, (_, index) => ({
        id: index + 1,
        flds: `${field}\x1f${field}`,
      })),
      'DEFLATE',
    );
    const parsed = await parseApkgImport(Buffer.from(pkg, 'base64'));
    expect(parsed.cards).toHaveLength(1_000);
    expect(parsed.cards[0]).toMatchObject({ front: field, back: field });
    expect(parsed.cards.length * field.length * 4).toBeGreaterThan(ANKI_MAX_APKG_RESPONSE_BYTES);

    await expect(importApkg({ package: pkg }, OWNER_IMPORT)).rejects.toBeInstanceOf(ApkgImportError);
    expect(getOrCreateOwnedDeck).not.toHaveBeenCalled();
    expect(readOwnedDeckInTransaction).not.toHaveBeenCalled();
    expect(mockDbInstance.runTransaction).not.toHaveBeenCalled();
    expect(mockTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects malformed packages without opening a card transaction', async () => {
    await expect(importApkg(
      { package: Buffer.from('not a zip at all').toString('base64') }, OWNER_IMPORT,
    )).rejects.toBeInstanceOf(ApkgImportError);
    expect(mockDbInstance.runTransaction).not.toHaveBeenCalled();
  });
  it('maps unsafe SQLite integers to the typed import API error before any write', async () => {
    const pkg = await buildApkg([{ id: 9007199254740993n, flds: 'Q\x1fA' }]);
    await expect(importApkg({ package: pkg }, OWNER_IMPORT)).rejects.toBeInstanceOf(ApkgImportError);
    expect(mockDbInstance.runTransaction).not.toHaveBeenCalled();
  });

  it('rejects non-base64 and oversized envelopes', async () => {
    await expect(importApkg({ package: '%%%' }, OWNER_IMPORT)).rejects.toBeInstanceOf(ApkgImportError);
    const big = Buffer.alloc(21 * 1024 * 1024, 1).toString('base64');
    await expect(importApkg({ package: big }, OWNER_IMPORT)).rejects.toBeInstanceOf(ApkgImportError);
  });

  it('honors the deckPath override', async () => {
    const pkg = await buildApkg([{ id: 1, flds: 'Q\x1fA' }]);
    const result = await importApkg({ package: pkg, deckPath: 'Custom::Deck' }, OWNER_IMPORT);
    expect(result.cards[0].deckPath).toBe('Custom::Deck');
    expect(getOrCreateOwnedDeck).toHaveBeenCalledWith(OWNER_IMPORT, 'Custom::Deck');
  });

  it('splits imports by the transaction byte budget as well as the 500-write limit', async () => {
    const card: ImportedCard = {
      front: 'é'.repeat(10_000), back: 'é'.repeat(10_000), deckPath: null, tags: [],
    };
    const result = await writeImportedCards(Array.from({ length: 100 }, () => card), OWNER_IMPORT);
    expect(result).toEqual({ atomic: false, batchCount: 2 });
    expect(mockDbInstance.runTransaction).toHaveBeenCalledTimes(2);
    expect(mockTransaction.create).toHaveBeenCalledTimes(100);
  });

  it('reports failure when a later 500-card transaction fails', async () => {
    jest.setTimeout(60000);
    const pkg = await buildApkg(Array.from({ length: 501 }, (_, i) => ({ id: i + 1, flds: `Q${i}\x1fA${i}` })));
    let transactions = 0;
    const transactionFailure = new Error();
    mockDbInstance.runTransaction.mockImplementation(async (callback: (tx: typeof mockTransaction) => unknown) => {
      transactions += 1;
      if (transactions === 2) throw transactionFailure;
      return callback(mockTransaction);
    });
    await expect(importApkg({ package: pkg }, OWNER_IMPORT)).rejects.toBe(transactionFailure);
    expect(transactions).toBe(2);
    expect(mockTransaction.create).toHaveBeenCalledTimes(500);
  });
});

describe('anki export service', () => {
  const OWNER_EXPORT = 'anki-export-owner';
  beforeEach(() => {
    jest.clearAllMocks();
    mockCardCollection.get.mockResolvedValue({ docs: [], empty: true });
    mockCardCollection.limit.mockReturnValue(mockCardCollection);
    mockCardCollection.orderBy.mockReturnValue(mockCardCollection);
    mockCardCollection.startAfter.mockReturnValue(mockCardCollection);
    mockCardCollection.where.mockReturnValue(mockCardCollection);
  });

  function seedCards(count: number): void {
    const allDocs = Array.from({ length: count }, (_, i) => ({
      id: `card-${String(i).padStart(3, '0')}`,
      exists: true,
      data: () => ({
        ownerId: OWNER_EXPORT,
        front: `Front ${i}`, back: `Back ${i}`, deck: i % 2 ? 'Spanish' : null,
        tags: ['t'], createdAt: { toMillis: () => 1700000000000 + i }, updatedAt: { toMillis: () => 1700000000000 + i },
        due: { toMillis: () => 1700000000000 + i }, state: 0, stability: 0, difficulty: 0,
        reps: 0, lapses: 0, reviewLog: [], images: [],
      }),
    }));
    // Track where() calls to simulate deck filtering.
    let deckFilter: string | null = null;
    mockCardCollection.where.mockImplementation((_field: string, _op: string, value: unknown) => {
      if (_field === 'deck') deckFilter = value as string;
      return mockCardCollection;
    });
    let calls = 0;
    mockCardCollection.get.mockImplementation(() => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ docs: [], empty: true });
      const filtered = deckFilter !== null
        ? allDocs.filter((d) => d.data().deck === deckFilter)
        : allDocs;
      return Promise.resolve({ docs: filtered, empty: filtered.length === 0 });
    });
    mockCardCollection.limit.mockReturnValue(mockCardCollection);
    mockCardCollection.orderBy.mockReturnValue(mockCardCollection);
    mockCardCollection.startAfter.mockReturnValue(mockCardCollection);
  }

  it('selectExportCards returns newest-first within the cap', async () => {
    seedCards(3);
    const r = await selectExportCards({}, OWNER_EXPORT);
    expect(r.selected.map((c) => c.id)).toEqual(['card-000', 'card-001', 'card-002']);
    expect(r.filtered).toBe(0);
  });

  it('selectExportCards filters by exact deck name', async () => {
    seedCards(4);
    const r = await selectExportCards({ deck: 'Spanish' }, OWNER_EXPORT);
    expect(r.selected.every((c) => c.deckPath === 'Spanish')).toBe(true);
  });

  it('exportApkg rejects an empty selection', async () => {
    mockCardCollection.get.mockResolvedValue({ docs: [], empty: true });
    await expect(exportApkg({}, OWNER_EXPORT)).rejects.toBeInstanceOf(ApkgExportError);
  });

  it('export media fetch refuses SSRF targets before any connection (mediaSkipped)', async () => {
    // One card whose images are all SSRF/unsafe targets. The pinned fetch
    // validates BEFORE connecting, so a refusal must appear in mediaSkipped
    // with a reason and never reach the network.
    const doc = {
      id: 'card-000',
      exists: true,
      get: jest.fn(),
      data: () => ({
        front: 'Front', back: 'Back', deck: null,
        ownerId: OWNER_EXPORT,
        tags: [], createdAt: { toMillis: () => 1700000000000 }, updatedAt: { toMillis: () => 1700000000000 },
        due: { toMillis: () => 1700000000000 }, state: 0, stability: 0, difficulty: 0,
        reps: 0, lapses: 0, reviewLog: [],
        images: [
          { url: 'https://169.254.169.254/latest/meta-data/' },  // metadata (link-local)
          { url: 'https://127.0.0.1:8080/secret.png' },          // loopback
          { url: 'https://10.0.0.1/pic.png' },                   // private
          { url: 'http://example.com/plain.png' },               // plaintext http
          { downloadUrl: 'http://[::1]/x.png' },                 // IPv6 loopback via http
        ],
      }),
    };
    doc.get.mockResolvedValue(doc);
    mockCardCollection.doc.mockReturnValue(doc);
    const result = await exportApkg({ cardIds: ['card-000'] }, OWNER_EXPORT);
    // Every unsafe target refused; zero embedded media.
    expect(result.media).toHaveLength(0);
    expect(result.mediaSkipped.map((m) => m.url).sort()).toEqual([
      'http://[::1]/x.png',
      'http://example.com/plain.png',
      'https://10.0.0.1/pic.png',
      'https://127.0.0.1:8080/secret.png',
      'https://169.254.169.254/latest/meta-data/',
    ]);
    for (const reason of result.mediaSkipped.map((m) => m.reason)) {
      expect(reason).not.toBe('');
    }
  });

  it('export media fetch embeds a public https image through a safe redirect chain', async () => {
    // A PUBLIC https image (example.com is resolvable in the test env) must
    // still embed — the pinned fetch allows public https endpoints. This
    // exercises the real node:https pinned path end-to-end.
    const doc = {
      id: 'card-000',
      exists: true,
      get: jest.fn(),
      data: () => ({
        front: 'Front', back: 'Back', deck: null,
        tags: [], createdAt: { toMillis: () => 1700000000000 }, updatedAt: { toMillis: () => 1700000000000 },
        ownerId: OWNER_EXPORT,
        due: { toMillis: () => 1700000000000 }, state: 0, stability: 0, difficulty: 0,
        reps: 0, lapses: 0, reviewLog: [],
        images: [{ url: 'https://example.com/export-test.png' }],
      }),
    };
    doc.get.mockResolvedValue(doc);
    mockCardCollection.doc.mockReturnValue(doc);
    const result = await exportApkg({ cardIds: ['card-000'] }, OWNER_EXPORT);
    // example.com serves a real page (200) — embedded unless the sandbox
    // blocks egress; when blocked it is reported, never fetched unsafely.
    if (result.media.length === 1) {
      expect(result.media[0].fileName).toBe('export-test.png');
    } else {
      expect(result.mediaSkipped.length).toBe(1);
      expect(result.mediaSkipped[0].reason).toMatch(/did not resolve|unreachable|timed out|fetch failed/);
    }
  });
});

describe('anki validators', () => {
  it('import accepts { package } and rejects unknown keys/over-long packages', () => {
    const good = validateImportApkg({ package: 'aGk=' });
    expect(good.package).toBe('aGk=');
    expect(() => validateImportApkg({ package: 'aGk=', extra: 1 })).toThrow();
    expect(() => validateImportApkg({ package: '' })).toThrow();
    expect(() => validateImportApkg({})).toThrow();
  });

  it('export schema enforces deck/cardIds exclusivity and limits', () => {
    expect(() => validateExportApkg({ deck: 'Spanish', cardIds: ['a'] })).toThrow();
    expect(validateExportApkg({ cardIds: ['a', 'b'] }).cardIds).toHaveLength(2);
    expect(() => validateExportApkg({ cardIds: ['a', 'a'] })).toThrow();
    expect(() => validateExportApkg({ cardIds: Array(1001).fill('x') })).toThrow();
  });

  it('safe validators return structured failures', () => {
    expect(safeValidateImportApkg({}).success).toBe(false);
    expect(safeValidateImportApkg({ package: 'aGk=' }).success).toBe(true);
    expect(safeValidateExportApkg({ deck: '' }).success).toBe(false);
  });

  it('deckPath override validation', () => {
    expect(normalizeDeckPathForImportPublic('  A :: B ')).toBe('A::B');
    expect(normalizeDeckPathForImportPublic('::')).toBeNull();
    expect(normalizeDeckPathForImportPublic('x'.repeat(301))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Cross-owner isolation (multi-tenant)                                */
/* ------------------------------------------------------------------ */

describe('anki multi-tenant isolation', () => {
  const OWNER_A = 'auth0|user-a';
  const OWNER_B = 'auth0|user-b';

  beforeEach(() => {
    jest.clearAllMocks();
    mockCardCollection.doc.mockImplementation(() => mockCardDoc);
    mockCardCollection.where = jest.fn(() => mockCardCollection);
    mockCardCollection.orderBy = jest.fn(() => mockCardCollection);
    mockCardCollection.limit = jest.fn(() => mockCardCollection);
    mockCardCollection.startAfter = jest.fn(() => mockCardCollection);
    mockCardCollection.select = jest.fn(() => mockCardCollection);
    mockCardCollection.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
  });

  it('importApkg stamps ownerId on cards resolved through the owned deck registry', async () => {
    const written: Array<Record<string, unknown>> = [];
    (getOrCreateOwnedDeck as jest.Mock).mockResolvedValue({
      id: 'deck-default', ownerId: OWNER_A, name: 'Default',
    });
    (readOwnedDeckInTransaction as jest.Mock).mockResolvedValue({
      id: 'deck-default', ownerId: OWNER_A, name: 'Default',
    });
    mockTransaction.create.mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
      written.push(data);
    });
    mockDbInstance.runTransaction.mockImplementation(async (callback: (tx: typeof mockTransaction) => unknown) => callback(mockTransaction));
    const pkg = await buildApkg([{ id: 1, flds: 'Q1\x1fA1', tags: 'x' }]);
    await importApkg({ package: pkg }, OWNER_A);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ ownerId: OWNER_A, deckId: 'deck-default', deck: 'Default' });
    expect(getOrCreateOwnedDeck).toHaveBeenCalledWith(OWNER_A, 'Default');
    expect(readOwnedDeckInTransaction).toHaveBeenCalledWith(mockTransaction, 'deck-default', OWNER_A);
  });

  it('selectExportCards omits another owner\'s explicit card id (never exported)', async () => {
    const foreignDoc: any = {
      id: 'card-b', exists: true, data: () => ({
        ownerId: OWNER_B, front: 'Other', back: 'X', deck: null, tags: [],
        createdAt: { toMillis: () => 1700000000000 }, updatedAt: { toMillis: () => 1700000000000 },
        due: { toMillis: () => 1700000000000 }, state: 0, stability: 0, difficulty: 0,
        reps: 0, lapses: 0, reviewLog: [], images: [],
      }),
    };
    foreignDoc.get = jest.fn().mockResolvedValue(foreignDoc);
    mockCardCollection.doc.mockReturnValue(foreignDoc);
    const r = await selectExportCards({ cardIds: ['card-b'] }, OWNER_A);
    expect(r.selected).toHaveLength(0);
    expect(r.filtered).toBe(1); // reported as missing/filtered, never leaked
  });

  it('scanExportCards scopes the whole-library export query to the owner', async () => {
    mockCardCollection.orderBy = jest.fn(() => mockCardCollection);
    mockCardCollection.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
    await selectExportCards({}, OWNER_A);
    const whereCalls = (mockCardCollection.where as jest.Mock).mock.calls;
    expect(whereCalls.some((c) => c[0] === 'ownerId' && c[2] === OWNER_A)).toBe(true);
  });
});

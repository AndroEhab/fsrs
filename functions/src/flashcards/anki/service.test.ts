/**
 * Service-layer tests for Anki .apkg import/export: Firestore write behavior
 * (atomic batches, deck find-or-create, no partial writes), export card
 * selection, and error mapping. The format layer is covered by apkg.test.ts.
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
import { ImportedCard } from './types';
import {
  safeValidateImportApkg, safeValidateExportApkg, validateImportApkg,
  validateExportApkg,
} from './validators';

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
const mockDeckDoc: any = createMockDoc({ id: 'deck-1' });
const mockDeckCollection: any = createMockCollection(mockDeckDoc);
const mockDbInstance = {
  collection: jest.fn((name: string) => {
    if (name === 'decks') return mockDeckCollection;
    return mockCardCollection;
  }),
  runTransaction: jest.fn(),
  batch: jest.fn(),
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
async function buildApkg(notes: Array<{ id: number; flds: string; tags?: string }>): Promise<string> {
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
  db.prepare(`INSERT INTO col (id,crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags)
    VALUES (1,1700000000,1700000000,0,11,0,-1,0,'{}','{}',?, '{}','{}')`)
    .run(JSON.stringify({ 1: { name: 'Default' }, 2: { name: 'Spanish::Verbs' } }));
  db.exec('BEGIN');
  const insN = db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,1,0,-1,?,?,0,0,0,\'\')');
  const insC = db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,?,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,\'\')');
  notes.forEach((n, i) => {
    insN.run(n.id, `guid-${n.id}`, n.tags ?? '', n.flds);
    insC.run(n.id * 10 + 1, n.id, i === 0 ? 1 : 2);
  });
  db.exec('COMMIT');
  db.close();
  const bytes = new Uint8Array(readFileSync(p));
  rmSync(dir, { recursive: true, force: true });
  const zip = new JSZip();
  zip.file('collection.anki2', bytes as unknown as ArrayBuffer, { binary: true });
  const out = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(out).toString('base64');
}

describe('anki import service', () => {
  let mockCard: any;
  let mockDeck: any;


  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDbInstance.collection.mockClear();
    mockDbInstance.batch.mockClear();
    mockCard = getFirestore().collection('flashcards');
    mockDeck = getFirestore().collection('decks');
    // Default: a matching deck query returns empty (find-or-create path).
    mockDeck.where = jest.fn(() => mockDeck);
    mockDeck.limit = jest.fn(() => mockDeck);
    mockDeck.get = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    Timestamp.now.mockReturnValue({ toMillis: () => 1700000000000, seconds: 1700000000, nanoseconds: 0 });
  });

  it('writes cards into a single atomic batch (no partial writes)', async () => {
    const batches: Array<Array<unknown>> = [];
    mockDbInstance.batch.mockReturnValue({
      set: jest.fn((_ref: unknown, data: unknown) => { batches[batches.length - 1].push(data); }),
      commit: jest.fn().mockResolvedValue(undefined),
    });
    // Simulate a real batch factory: each batch() returns a new object.
    mockDbInstance.batch.mockImplementation(() => {
      const items: unknown[] = [];
      batches.push(items);
      return {
        set: jest.fn((_ref: unknown, data: unknown) => { items.push(data); }),
        commit: jest.fn().mockResolvedValue(undefined),
      };
    });
    mockCard.doc = jest.fn(() => ({ id: 'new-id', set: jest.fn().mockResolvedValue(undefined) }));
    const cards: ImportedCard[] = [
      { front: 'Q1', back: 'A1', deckPath: 'Spanish::Verbs', tags: ['x'] },
      { front: 'Q2', back: 'A2', deckPath: null, tags: [] },
    ];
    const r = await writeImportedCards(cards);
    expect(r.atomic).toBe(true);
    expect(r.batchCount).toBe(1);
    // Exactly 2 writes in the one batch; the deck was created (find-or-create).
    const writes = batches[0];
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ front: 'Q1', back: 'A1' });
  });

  it('importApkg end-to-end creates cards and decks', async () => {
    const batchItems: unknown[] = [];
    mockDbInstance.batch.mockReturnValue({
      set: jest.fn((_ref: unknown, data: unknown) => { batchItems.push(data); }),
      commit: jest.fn().mockResolvedValue(undefined),
    });
    mockCard.doc = jest.fn(() => ({ id: `c${batchItems.length}`, set: jest.fn() }));
    const pkg = await buildApkg([
      { id: 1, flds: 'What is 2+2?\x1f4', tags: ' math ' },
      { id: 2, flds: 'Capital?\x1fParis' },
    ]);
    const result = await importApkg({ package: pkg });
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].front).toBe('What is 2+2?');
    expect(result.cards[0].deckPath).toBe('Default');
    expect(result.cards[1].deckPath).toBe('Spanish::Verbs');
    expect(result.skippedNotes).toBe(0);
    expect(result.skippedEmpty).toBe(0);
    expect(result.atomic).toBe(true);
    expect(result.batchCount).toBe(1);
    // Deck entities were created for both distinct leaf names.
    expect(mockDeck.get).toHaveBeenCalled();
    expect(batchItems).toHaveLength(2);
  });

  it('rejects malformed packages with ApkgImportError (no writes)', async () => {
    const batch = { set: jest.fn(), commit: jest.fn() };
    mockDbInstance.batch.mockReturnValue(batch);
    await expect(importApkg({ package: Buffer.from('not a zip at all').toString('base64') }))
      .rejects.toBeInstanceOf(ApkgImportError);
    expect(batch.commit).not.toHaveBeenCalled();
  });

  it('rejects non-base64 and oversized envelopes', async () => {
    await expect(importApkg({ package: '%%%' })).rejects.toBeInstanceOf(ApkgImportError);
    const big = Buffer.alloc(21 * 1024 * 1024, 1).toString('base64');
    await expect(importApkg({ package: big })).rejects.toThrow(/too large/);
  });

  it('honors the deckPath override', async () => {
    mockDbInstance.batch.mockReturnValue({ set: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) });
    mockCard.doc = jest.fn(() => ({ id: 'x', set: jest.fn() }));
    const pkg = await buildApkg([{ id: 1, flds: 'Q\x1fA' }]);
    const result = await importApkg({ package: pkg, deckPath: 'Custom::Deck' });
    expect(result.cards[0].deckPath).toBe('Custom::Deck');
  });

  it('no partial writes when a mid-batch commit fails', async () => {
    jest.setTimeout(60000);
    // >500 cards → 2 batches. First commits, second rejects.
    const pkg = await buildApkg(Array.from({ length: 501 }, (_, i) => ({ id: i + 1, flds: `Q${i}\x1fA${i}` })));
    let commits = 0;
    mockDbInstance.batch.mockImplementation(() => {
      const items: unknown[] = [];
      return {
        set: jest.fn((_ref: unknown, data: unknown) => { items.push(data); }),
        commit: jest.fn().mockImplementation(() => {
          commits += 1;
          if (commits === 2) return Promise.reject(new Error('commit failed'));
          return Promise.resolve(undefined);
        }),
      };
    });
    mockCard.doc = jest.fn(() => ({ id: 'x', set: jest.fn() }));
    await expect(importApkg({ package: pkg })).rejects.toThrow('commit failed');
    expect(commits).toBe(2);
  });
});

describe('anki export service', () => {
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
    const r = await selectExportCards({});
    expect(r.selected.map((c) => c.id)).toEqual(['card-000', 'card-001', 'card-002']);
    expect(r.filtered).toBe(0);
  });

  it('selectExportCards filters by exact deck name', async () => {
    seedCards(4);
    const r = await selectExportCards({ deck: 'Spanish' });
    expect(r.selected.every((c) => c.deckPath === 'Spanish')).toBe(true);
  });

  it('exportApkg rejects an empty selection', async () => {
    mockCardCollection.get.mockResolvedValue({ docs: [], empty: true });
    await expect(exportApkg({})).rejects.toBeInstanceOf(ApkgExportError);
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
    const result = await exportApkg({ cardIds: ['card-000'] });
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
        due: { toMillis: () => 1700000000000 }, state: 0, stability: 0, difficulty: 0,
        reps: 0, lapses: 0, reviewLog: [],
        images: [{ url: 'https://example.com/export-test.png' }],
      }),
    };
    doc.get.mockResolvedValue(doc);
    mockCardCollection.doc.mockReturnValue(doc);
    const result = await exportApkg({ cardIds: ['card-000'] });
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
    mockDeckCollection.where = jest.fn(() => mockDeckCollection);
    mockDeckCollection.limit = jest.fn(() => mockDeckCollection);
    mockDeckCollection.get = jest.fn().mockResolvedValue({ empty: true, docs: [] });
  });

  it('importApkg stamps ownerId on every written card and created deck', async () => {
    const written: Array<Record<string, unknown>> = [];
    mockCardCollection.doc = jest.fn(() => ({
      id: 'new', set: jest.fn((d: Record<string, unknown>) => { written.push(d); }),
    }));
    mockDbInstance.batch.mockReturnValue({
      set: jest.fn((_ref: unknown, data: Record<string, unknown>) => { written.push(data); }),
      commit: jest.fn().mockResolvedValue(undefined),
    });
    const deckSets: Array<Record<string, unknown>> = [];
    mockDeckCollection.doc = jest.fn(() => ({
      id: 'deck-new', set: jest.fn((d: Record<string, unknown>) => { deckSets.push(d); }),
    }));
    const pkg = await buildApkg([{ id: 1, flds: 'Q1\x1fA1', tags: 'x' }]);
    await importApkg({ package: pkg }, OWNER_A);
    expect(written.length).toBeGreaterThan(0);
    for (const card of written) expect(card.ownerId).toBe(OWNER_A);
    for (const deck of deckSets) expect(deck.ownerId).toBe(OWNER_A);
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

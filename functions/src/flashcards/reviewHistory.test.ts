/**
 * Tests for the review-event analytics surface (corrected schema):
 *  - event document construction (buildEventBody) with actorId, stateBefore,
 *    dueBefore/dueAfter, recordedAt, cardFrontSnapshot <= 300, sessionId
 *  - trimEmbeddedReviewLog bounded window
 *  - analytics pure counters/retention under the exact definitions
 *  - history item read model (eventToHistoryItem) normalized fields
 */

import {
  buildEventBody, trimEmbeddedReviewLog, legacySessionEventId,
  cardFromSnapshot, frontSnapshot,
} from './reviewHistory';
import {
  eventCounters, sumEventCounters, maturityBucket, ratingPercentagesOf,
  observedRetentionOf, matureRetentionOf, RATING_KEY,
} from './analytics';
import {
  ReviewLogEntry, MAX_EMBEDDED_REVIEW_LOG,
} from './types';

const mockTimestamp = (d: Date) => ({ toDate: () => d, seconds: d.getTime() / 1000, nanoseconds: 0, toMillis: () => d.getTime() });

jest.mock('firebase-admin/firestore', () => {
  const actual = jest.requireActual('firebase-admin/firestore');
  return {
    ...actual,
    getFirestore: jest.fn(() => ({ collection: jest.fn(), runTransaction: jest.fn(), batch: jest.fn(), getAll: jest.fn() })),
    Timestamp: {
      now: jest.fn(() => mockTimestamp(new Date('2026-08-28T00:00:00.000Z'))),
      fromDate: jest.fn((d: Date) => mockTimestamp(d)),
      fromMillis: jest.fn((ms: number) => ({ toDate: () => new Date(ms), seconds: ms / 1000, nanoseconds: (ms % 1000) * 1000000, toMillis: () => ms })),
    },
    FieldPath: { documentId: jest.fn(() => '__name__') },
    FieldValue: { delete: jest.fn(() => ({ __fieldDelete: true })), serverTimestamp: jest.fn() },
  };
});

interface FlashcardFixture {
  id: string;
  front: string;
  back: string;
  deckId?: string;
  deck?: string;
  tags: string[];
  createdAt: { toDate(): Date; toMillis(): number };
  updatedAt: { toDate(): Date; toMillis(): number };
  due: { toDate(): Date; toMillis(): number };
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: { toDate(): Date; toMillis(): number };
  reviewLog: ReviewLogEntry[];
  images: unknown[];
}

function cardFixture(overrides: Partial<FlashcardFixture> = {}): FlashcardFixture {
  return {
    id: 'card-1',
    front: 'Front text',
    back: 'Back',
    tags: [],
    createdAt: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')),
    updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')),
    due: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')),
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    reviewLog: [],
    images: [],
    ...overrides,
  };
}

const baseContext = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ownerId: 'Key A',
  rating: 3,
  card: cardFixture(),
  scheduling: {
    state: 1, stability: 3.2, difficulty: 5, reps: 1, lapses: 0,
    due: mockTimestamp(new Date('2026-08-10T00:10:00.000Z')),
    lastReview: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')),
  },
  reviewedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')),
  recordedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')),
  ...overrides,
});

describe('buildEventBody (corrected schema)', () => {
  it('records actorId, cardId, stateBefore, dueBefore/dueAfter, after-fields, reviewedAt/recordedAt and deck context', () => {
    const card = cardFixture({ deckId: 'deck-x', deck: 'Spanish', state: 2, due: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')) });
    const body = buildEventBody(baseContext({
      ownerId: 'stable-key-id',
      card,
      rating: 2,
      scheduling: { state: 2, stability: 9, difficulty: 4, reps: 5, lapses: 1, due: mockTimestamp(new Date('2026-08-20T00:00:00.000Z')) },
    }) as never);
    const b = body as {
      cardId: string; actorId: string; rating: number; stateBefore: number;
      stabilityAfter: number; difficultyAfter: number; repsAfter: number; lapsesAfter: number;
      deckId?: string; deckName?: string; cardFrontSnapshot: string;
      dueBefore: { toMillis(): number }; dueAfter: { toMillis(): number };
      reviewedAt: { toMillis(): number }; recordedAt: { toMillis(): number };
    };
    expect(b.cardId).toBe('card-1');
    expect(b.actorId).toBe('stable-key-id');
    expect(b.rating).toBe(2);
    expect(b.stateBefore).toBe(2);
    expect(b.dueBefore.toMillis()).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
    expect(b.dueAfter.toMillis()).toBe(Date.parse('2026-08-20T00:00:00.000Z'));
    expect(b.stabilityAfter).toBe(9);
    expect(b.difficultyAfter).toBe(4);
    expect(b.repsAfter).toBe(5);
    expect(b.lapsesAfter).toBe(1);
    expect(b.deckId).toBe('deck-x');
    expect(b.deckName).toBe('Spanish');
    expect(b.cardFrontSnapshot).toBe('Front text');
    expect(b.reviewedAt.toMillis()).toBe(Date.parse('2026-08-10T00:00:00.000Z'));
    expect(b.recordedAt.toMillis()).toBe(Date.parse('2026-08-10T00:00:00.000Z'));
  });

  it('session events carry sessionId and requestId; direct events omit them', () => {
    const session = buildEventBody(baseContext({ sessionId: 'sess-1', requestId: 'req-abc' }) as never);
    expect(session.sessionId).toBe('sess-1');
    expect(session.requestId).toBe('req-abc');
    expect(legacySessionEventId('req-abc')).toBe('evt-req-abc');
    const direct = buildEventBody(baseContext() as never);
    expect(direct.sessionId).toBeUndefined();
    expect(direct.requestId).toBeUndefined();
  });

  it('truncates the front snapshot to 300 chars', () => {
    const long = 'x'.repeat(500);
    const card = cardFixture({ front: long });
    const body = buildEventBody(baseContext({ card }) as never);
    expect(body.cardFrontSnapshot.length).toBeLessThanOrEqual(300);
    expect(body.cardFrontSnapshot.startsWith('x'.repeat(299))).toBe(true);
    expect(frontSnapshot('short')).toBe('short');
  });

  it('computes deltaDays from lastReview', () => {
    const card = cardFixture({ lastReview: mockTimestamp(new Date('2026-08-05T00:00:00.000Z')) });
    const body = buildEventBody(baseContext({ card }) as never);
    expect(body.deltaDays).toBe(5);
  });
});

describe('trimEmbeddedReviewLog', () => {
  function entry(reps: number, day: number): ReviewLogEntry {
    const ts = mockTimestamp(new Date(Date.UTC(2026, 0, day))) as unknown as ReviewLogEntry['review'];
    return { rating: 3, state: 0, review: ts, due: ts, stability: 1, difficulty: 1, reps, lapses: 0 };
  }
  it('keeps arrays within the bound unchanged', () => {
    expect(trimEmbeddedReviewLog([entry(1, 1), entry(2, 2)])).toHaveLength(2);
  });
  it('trims to the newest MAX_EMBEDDED_REVIEW_LOG entries', () => {
    const log = Array.from({ length: MAX_EMBEDDED_REVIEW_LOG + 25 }, (_, i) => entry(i + 1, i + 1));
    const trimmed = trimEmbeddedReviewLog(log);
    expect(trimmed).toHaveLength(MAX_EMBEDDED_REVIEW_LOG);
    expect(trimmed[0].reps).toBe(26);
    expect(trimmed[trimmed.length - 1].reps).toBe(125);
  });
});

describe('analytics counters / retention (corrected definitions)', () => {
  it('eventCounters names histograms again/hard/good/easy and marks mature pre-states', () => {
    expect(eventCounters({ rating: 1, stateBefore: 2 })).toEqual({
      total: 1,
      ratingCounts: { again: 1, hard: 0, good: 0, easy: 0 },
      mature: 1,
      matureRatingCounts: { again: 1, hard: 0, good: 0, easy: 0 },
    });
    expect(eventCounters({ rating: 3, stateBefore: 3 })).toEqual({
      total: 1,
      ratingCounts: { again: 0, hard: 0, good: 1, easy: 0 },
      mature: 1,
      matureRatingCounts: { again: 0, hard: 0, good: 1, easy: 0 },
    });
    // Learning (1) is not mature
    expect(eventCounters({ rating: 1, stateBefore: 1 }).mature).toBe(0);
    expect(RATING_KEY[1]).toBe('again');
    expect(RATING_KEY[4]).toBe('easy');
  });

  it('observedRetention = successful(2/3/4)/total; matureRetention = successful mature/mature', () => {
    const counters = sumEventCounters([
      eventCounters({ rating: 1, stateBefore: 2 }), // mature again
      eventCounters({ rating: 3, stateBefore: 2 }), // mature good
      eventCounters({ rating: 4, stateBefore: 0 }), // non-mature easy
      eventCounters({ rating: 2, stateBefore: 1 }), // non-mature hard
    ]);
    expect(counters.totalReviews).toBe(4);
    expect(counters.ratingCounts).toEqual({ again: 1, hard: 1, good: 1, easy: 1 });
    expect(observedRetentionOf(counters)).toBe(0.75); // 3 successful / 4
    expect(counters.matureReviews).toBe(2);
    expect(matureRetentionOf(counters)).toBe(0.5); // 1 successful mature / 2
    expect(ratingPercentagesOf(counters)).toEqual({ again: 0.25, hard: 0.25, good: 0.25, easy: 0.25 });
  });

  it('returns null retention when denominator is zero and 0 percentages on empty', () => {
    const empty = sumEventCounters([]);
    expect(observedRetentionOf(empty)).toBeNull();
    expect(matureRetentionOf(empty)).toBeNull();
    expect(ratingPercentagesOf(empty)).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it('maturityBucket maps FSRS states and defaults invalid to New', () => {
    expect(maturityBucket(2)).toBe(2);
    expect(maturityBucket(undefined)).toBe(0);
    expect(maturityBucket(9)).toBe(0);
  });
});

describe('cardFromSnapshot', () => {
  it('maps a card document with legacy-safe defaults', () => {
    const card = cardFromSnapshot({
      id: 'c1',
      data: () => ({
        front: 'F', back: 'B', tags: ['a'],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        deckId: 'd1', deck: 'Spanish',
        state: 3, stability: 2, difficulty: 1, reps: 4, lapses: 2,
        reviewLog: [], images: [],
      }),
      exists: true,
    } as never);
    expect(card.id).toBe('c1');
    expect(card.state).toBe(3);
    expect(card.deck).toBe('Spanish');
  });
});
describe('migrateLegacyReviewEvents (idempotency + resume cursor)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const firestoreMock = require('firebase-admin/firestore');
  const { Timestamp } = firestoreMock;

  interface CardDoc {
    id: string;
    data: () => Record<string, unknown>;
  }
  function buildDb(cardDocs: CardDoc[], eventSeeded: string[] = []) {
    const events = new Set<string>(eventSeeded);
    const batches: Array<Array<{ ref: string; data: Record<string, unknown> }>> = [];
    const cards = [...cardDocs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let cursorStart = 0;
    const db = {
      collection: (name: string) => {
        if (name === 'flashcards') {
          const q: Record<string, unknown> = {
            orderBy: () => q,
            limit: (n: number) => {
              // remember the limit for the get() snapshot window
              (q as { _limit?: number })._limit = n;
              return q;
            },
            startAfter: (doc: { id: string }) => {
              cursorStart = cards.findIndex((c) => c.id === doc.id) + 1;
              return q;
            },
            get: async () => {
              const n = (q as { _limit?: number })._limit ?? 100;
              const slice = cards.slice(cursorStart, cursorStart + n);
              return { docs: slice.map((c) => ({ id: c.id, data: c.data, exists: true })), empty: slice.length === 0 };
            },
            doc: (id: string) => ({
              get: async () => {
                const found = cards.find((c) => c.id === id);
                return { exists: !!found, id, data: () => (found ? found.data() : {}) };
              },
            }),
          };
          return q;
        }
        // reviewEvents
        return {
          doc: (id: string) => ({
            id,
            get: async () => ({ exists: events.has(id), id, data: () => ({}) }),
          }),
        };
      },
      batch: () => {
        const b: { set: jest.Mock; commit: jest.Mock } = {
          set: jest.fn((ref: { id: string }, data: Record<string, unknown>) => {
            events.add(ref.id);
            batches.push([{ ref: ref.id, data }]);
          }),
          commit: jest.fn().mockResolvedValue(undefined),
        };
        return b;
      },
    };
    return { db, events, batches };
  }

  function ts(iso: string) {
    return Timestamp.fromMillis(Date.parse(iso));
  }

  it('is idempotent across runs and returns a resume cursor for the next page', async () => {
    const entry = (iso: string, rating: number, reps: number) => ({
      rating, state: 0,
      review: ts(iso), due: ts(iso),
      stability: 1, difficulty: 1, reps, lapses: 0,
    });
    const cardDocs: CardDoc[] = [
      { id: 'card-a', data: () => ({ front: 'A', reviewLog: [entry('2026-01-01T00:00:00Z', 3, 1)], due: ts('2026-01-02T00:00:00Z') }) },
      { id: 'card-b', data: () => ({ front: 'B', reviewLog: [entry('2026-02-01T00:00:00Z', 1, 1)], due: ts('2026-02-03T00:00:00Z') }) },
      { id: 'card-c', data: () => ({ front: 'C', reviewLog: [], due: ts('2026-03-01T00:00:00Z') }) },
    ];
    const { db, events, batches } = buildDb(cardDocs);
    firestoreMock.getFirestore.mockReturnValue(db);
    // getDb() memoizes per module instance, so load a FRESH copy of the
    // service for this test (isolated module registry) to bind the new mock.
    let mod: typeof import('./reviewHistory');
    jest.isolateModules(() => {
      mod = require('./reviewHistory');
    });
    const migrated = mod!;

    // Run 1: pageSize 1 -> scans card-a only.
    const r1 = await migrated.migrateLegacyReviewEvents({ pageSize: 1, operatorOwnerId: 'auth0|operator' });
    expect(r1.cardsMigrated).toBe(1);
    expect(r1.eventsWritten).toBe(1);
    expect(r1.hasMore).toBe(true);
    expect(r1.nextResumeAfterCardId).toBe('card-a');
    expect(events.has(migrated.legacyEventId('card-a', Date.parse('2026-01-01T00:00:00Z'), 0))).toBe(true);
    // The newest entry's dueAfter fell back to the card's CURRENT due.
    const written = batches.flat()[0].data;
    expect((written.dueAfter as { toMillis(): number }).toMillis()).toBe(Date.parse('2026-01-02T00:00:00Z'));

    // Run 2: resume after card-a -> scans card-b (skips empty card-c later).
    const r2 = await migrated.migrateLegacyReviewEvents({ pageSize: 1, operatorOwnerId: 'auth0|operator', resumeAfterCardId: 'card-a' });
    expect(r2.cardsMigrated).toBe(1);
    expect(r2.nextResumeAfterCardId).toBe('card-b');
    expect(r2.hasMore).toBe(true);

    // Run 3: re-run page 1 (idempotent) — the already-migrated event is skipped.
    const r3 = await migrated.migrateLegacyReviewEvents({ pageSize: 1, operatorOwnerId: 'auth0|operator' });
    expect(r3.cardsMigrated).toBe(0);
    expect(r3.eventsWritten).toBe(0);
  });
});
/* ------------------------------------------------------------------ */
/* Behavioral tests: getReviewHistory / getStudyStats / getTopLapsed   */
/* ------------------------------------------------------------------ */

/**
 * Deterministic in-memory Firestore harness covering the query surface the
 * analytics service uses: equality/`in`/range predicates, orderBy (with the
 * document-id tie-break), limit/startAfter cursors, count() aggregation,
 * select() projection, and per-doc get(). Each test re-mocks getFirestore
 * AND reloads a fresh reviewHistory module (getDb() memoizes per instance).
 */
describe('analytics service behavior (history / stats / top-lapsed)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const firestoreMock = require('firebase-admin/firestore');

  interface StoredDoc {
    id: string;
    data: Record<string, unknown>;
  }

  function buildHarness(events: StoredDoc[], cards: StoredDoc[]) {
    const eventMap = new Map(events.map((e) => [e.id, { ...e.data }]));
    const cardMap = new Map(cards.map((c) => [c.id, { ...c.data }]));

    function makeQuery(collectionName: string) {
      const preds: Array<(d: StoredDoc) => boolean> = [];
      let sort: ((a: StoredDoc, b: StoredDoc) => number) | null = null;
      let qLimit = Infinity;
      let after: string | null = null;
      let projection: string[] | null = null;

      const q: Record<string, unknown> = {
        where: (field: string, op: string, value: unknown) => {
          preds.push((d) => {
            const v = (d.data as Record<string, unknown>)[field] as
              | { toMillis?: () => number }
              | string
              | number
              | undefined;
            const toMs = (x: unknown): number | undefined =>
              (x as { toMillis?: () => number } | undefined)?.toMillis?.();
            const vMs = toMs(v);
            const valMs = toMs(value);
            if (op === '==') return v === value;
            if (op === 'in') return Array.isArray(value) && value.includes(v);
            if (op === '>') {
              if (typeof v === 'number' && typeof value === 'number') return v > value;
              return vMs !== undefined && valMs !== undefined && vMs > valMs;
            }
            if (op === '>=') return vMs !== undefined && valMs !== undefined && vMs >= valMs;
            if (op === '<') return vMs !== undefined && valMs !== undefined && vMs < valMs;
            return true;
          });
          return q;
        },
        orderBy: (field: string, dir: string) => {
          const mult = dir === 'desc' ? -1 : 1;
          const inner = sort;
          sort = (a, b) => {
            const av = (a.data as Record<string, unknown>)[field] as { toMillis?: () => number } | string | number | undefined;
            const bv = (b.data as Record<string, unknown>)[field] as { toMillis?: () => number } | string | number | undefined;
            const am = toMs2(av); const bm = toMs2(bv);
            let cmp = 0;
            if (typeof av === 'number' && typeof bv === 'number') cmp = av < bv ? -1 : av > bv ? 1 : 0;
            else if (am !== undefined && bm !== undefined) cmp = am < bm ? -1 : am > bm ? 1 : 0;
            else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
            cmp *= mult;
            if (cmp !== 0) return cmp;
            if (field === '__name__' || field === 'reviewedAt') {
              // document-id tie-break is applied by the explicit orderBy('__name__')
              // handled below; keep first sort stable by id asc for reviewedAt.
            }
            return inner ? inner(a, b) : 0;
          };
          if (field === '__name__') {
            const base = sort;
            sort = (a, b) => { const c = base ? base(a, b) : 0; if (c !== 0) return c; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; };
          }
          return q;
        },
        limit: (n: number) => { qLimit = n; return q; },
        startAfter: (...args: unknown[]) => {
          // The service passes (reviewedAtTimestamp, lastDocId); identify the
          // LAST argument that looks like a document id (the tie-break value).
          const last = args[args.length - 1];
          after = typeof last === 'string' && last.length > 0 && !/^[0-9]/.test(last) ? last
            : (args[0] as { id?: string } | undefined)?.id ?? null;
          return q;
        },
        select: (...fields: string[]) => { projection = fields as string[]; return q; },
        count: () => ({ get: async () => ({ data: () => ({ count: apply().length }) }) }),
        get: async () => {
          const list = apply();
          const rows = list.slice(0, qLimit).map((d) => {
            const data = projection ? Object.fromEntries(projection.map((f) => [f, (d.data as Record<string, unknown>)[f]])) : d.data;
            return { id: d.id, data: () => data, exists: true, ref: { id: d.id, path: `${collectionName}/${d.id}` } };
          });
          return { docs: rows, size: rows.length, empty: rows.length === 0 };
        },
      };

      function apply(): StoredDoc[] {
        let list = [...(collectionName === 'reviewEvents' ? eventMap : cardMap).entries()].map(([id, data]) => ({ id, data }));
        for (const p of preds) list = list.filter(p);
        if (sort) list = [...list].sort(sort);
        if (after !== null) {
          const idx = list.findIndex((d) => d.id === after);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        return list;
      }
      return q;
    }

    const db = {
      collection: jest.fn((name: string) => {
        if (name === 'reviewEvents' || name === 'flashcards') return makeQuery(name);
        return makeQuery(name);
      }),
      runTransaction: jest.fn(),
      batch: jest.fn(),
      getAll: jest.fn(),
    };
    return { db, eventMap, cardMap };
  }

  function toMs2(v: unknown): number | undefined {
    return (v as { toMillis?: () => number } | undefined)?.toMillis?.();
  }

  function ev(overrides: Record<string, unknown>): StoredDoc {
    return { id: overrides.id as string, data: {
      ownerId: 'Key A', actorId: 'Key A', cardId: 'card-1', rating: 3, stateBefore: 0,
      reviewedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')),
      dueBefore: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')),
      dueAfter: mockTimestamp(new Date('2026-08-10T00:10:00.000Z')),
      stabilityAfter: 1, difficultyAfter: 5, repsAfter: 1, lapsesAfter: 0,
      recordedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')),
      cardFrontSnapshot: 'F', deckId: 'd1', deckName: 'Spanish',
      ...overrides,
    } };
  }

  async function freshModule(): Promise<typeof import('./reviewHistory')> {
    let mod: typeof import('./reviewHistory');
    jest.isolateModules(() => { mod = require('./reviewHistory'); });
    return mod!;
  }

  it('getReviewHistory is actor-scoped and applies [from,to) + card/deck/ratings filters', async () => {
    const events: StoredDoc[] = [
      ev({ id: 'e1', actorId: 'Key A', cardId: 'c1', deckId: 'd1', rating: 3, reviewedAt: mockTimestamp(new Date('2026-08-03T00:00:00.000Z')) }),
      ev({ id: 'e2', actorId: 'Key A', cardId: 'c1', deckId: 'd1', rating: 1, reviewedAt: mockTimestamp(new Date('2026-08-05T00:00:00.000Z')) }),
      ev({ id: 'e3', actorId: 'Key A', cardId: 'c2', deckId: 'd2', rating: 3, reviewedAt: mockTimestamp(new Date('2026-08-09T00:00:00.000Z')) }),
      ev({ id: 'e4', ownerId: 'Key B', actorId: 'Key B', cardId: 'c1', deckId: 'd1', rating: 3, reviewedAt: mockTimestamp(new Date('2026-08-07T00:00:00.000Z')) }),
    ];
    const { db } = buildHarness(events, []);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();

    // cardId + deckId + ratings [1,3] + window Aug 2..Aug 10, scoped to Key A.
    const res = await mod.getReviewHistory({ from: '2026-08-02', to: '2026-08-10', cardId: 'c1', deckId: 'd1', ratings: [1, 3] }, 'Key A');
    expect(res.events.map((e) => e.id)).toEqual(['e2', 'e1']); // reviewedAt DESC
    expect(res.events.every((e) => e.actorId === 'Key A')).toBe(true);
    // e3 wrong card; e4 is Key B (actor-scoped out).
    expect(res.events.some((e) => e.id === 'e3')).toBe(false);
    expect(res.events.some((e) => e.id === 'e4')).toBe(false);
  });

  it('getReviewHistory paginates stably (reviewedAt DESC, id ASC) with opaque tokens; a mismatched token is rejected', async () => {
    const events: StoredDoc[] = [
      ev({ id: 'b', reviewedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')) }),
      ev({ id: 'a', reviewedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')) }),
      ev({ id: 'c', reviewedAt: mockTimestamp(new Date('2026-08-10T00:00:00.000Z')) }),
      ev({ id: 'd', reviewedAt: mockTimestamp(new Date('2026-08-09T00:00:00.000Z')) }),
      ev({ id: 'e', reviewedAt: mockTimestamp(new Date('2026-08-08T00:00:00.000Z')) }),
    ];
    const { db } = buildHarness(events, []);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();

    const p1 = await mod.getReviewHistory({ pageSize: 2 }, 'Key A');
    expect(p1.events.map((e) => e.id)).toEqual(['a', 'b']); // id ASC within the tie
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = await mod.getReviewHistory({ pageSize: 2, pageToken: p1.nextPageToken! }, 'Key A');
    expect(p2.events.map((e) => e.id)).toEqual(['c', 'd']);
    const p3 = await mod.getReviewHistory({ pageSize: 2, pageToken: p2.nextPageToken! }, 'Key A');
    expect(p3.events.map((e) => e.id)).toEqual(['e']);
    expect(p3.nextPageToken).toBeNull();

    await expect(mod.getReviewHistory({ pageSize: 2, pageToken: p1.nextPageToken!, cardId: 'other' }, 'Key A'))
      .rejects.toThrow('pageToken does not match');
  });

  it('getStudyStats aggregates count/percentages/null/maturity and attaches top-lapsed', async () => {
    const events: StoredDoc[] = [
      ev({ id: 'e1', cardId: 'c1', rating: 1, stateBefore: 2, reviewedAt: mockTimestamp(new Date('2026-08-01T00:00:00.000Z')) }),
      ev({ id: 'e2', cardId: 'c1', rating: 3, stateBefore: 2, reviewedAt: mockTimestamp(new Date('2026-08-03T00:00:00.000Z')) }),
      ev({ id: 'e3', cardId: 'c1', rating: 4, stateBefore: 0, reviewedAt: mockTimestamp(new Date('2026-08-05T00:00:00.000Z')) }),
      ev({ id: 'e4', cardId: 'c1', rating: 1, stateBefore: 1, reviewedAt: mockTimestamp(new Date('2026-08-07T00:00:00.000Z')) }),
    ];
    const cards: StoredDoc[] = [
      { id: 'c1', data: { front: 'F', lapses: 3, reps: 5, deckId: 'd1', deck: 'Spanish', ownerId: 'Key A' } },
    ];
    const { db } = buildHarness(events, cards);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();

    const stats = await mod.getStudyStats({ from: '2026-08-01', to: '2026-08-31', topLimit: 10 }, 'Key A');
    expect(stats.from).toBe('2026-08-01T00:00:00.000Z');
    expect(stats.to).toBe('2026-08-31T00:00:00.000Z');
    expect(stats.totalReviews).toBe(4);
    expect(stats.ratingCounts).toEqual({ again: 2, hard: 0, good: 1, easy: 1 });
    expect(stats.ratingPercentages).toEqual({ again: 0.5, hard: 0, good: 0.25, easy: 0.25 });
    expect(stats.observedRetention).toBe(0.5); // 2 successful / 4
    expect(stats.matureReviews).toBe(2); // stateBefore 2
    expect(stats.matureRatingCounts).toEqual({ again: 1, hard: 0, good: 1, easy: 0 });
    expect(stats.matureRetention).toBe(0.5); // 1 successful mature / 2
    expect(stats.topLapsedCards).toEqual([
      expect.objectContaining({ cardId: 'c1', lapses: 3, reps: 5, front: 'F', deckName: 'Spanish' }),
    ]);
  });

  it('getStudyStats returns null retentions when there are no reviews / no mature reviews', async () => {
    const { db } = buildHarness([], []);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();
    const stats = await mod.getStudyStats({ from: '2026-08-01', to: '2026-08-31' }, 'Key A');
    expect(stats.totalReviews).toBe(0);
    expect(stats.observedRetention).toBeNull();
    expect(stats.matureRetention).toBeNull();
    expect(stats.ratingPercentages).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
    expect(stats.topLapsedCards).toEqual([]);
  });

  it('getTopLapsedCards excludes zero-lapse cards, orders by lapses desc, honors limit and deckId', async () => {
    const cards: StoredDoc[] = [
      { id: 'zero', data: { front: 'Z', lapses: 0, reps: 2, deckId: 'd1', ownerId: 'Key A' } },
      { id: 'high', data: { front: 'H', lapses: 9, reps: 12, deckId: 'd1', ownerId: 'Key A' } },
      { id: 'low', data: { front: 'L', lapses: 2, reps: 4, deckId: 'd1', ownerId: 'Key A' } },
      { id: 'other-deck', data: { front: 'O', lapses: 7, reps: 9, deckId: 'd2', ownerId: 'Key A' } },
    ];
    const { db } = buildHarness([], cards);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();

    const res = await mod.getTopLapsedCards({ limit: 10 }, 'Key A');
    // zero excluded; without a deck filter every non-zero card ranks (9,7,2).
    expect(res.cards.map((c) => c.cardId)).toEqual(['high', 'other-deck', 'low']);
    const all = await mod.getTopLapsedCards({ limit: 10, deckId: 'd1' }, 'Key A');
    expect(all.cards.map((c) => c.cardId)).toEqual(['high', 'low']);
    expect(all.cards[0].lapses).toBe(9);
    const capped = await mod.getTopLapsedCards({ limit: 1, deckId: 'd1' }, 'Key A');
    expect(capped.cards.map((c) => c.cardId)).toEqual(['high']);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-owner isolation (multi-tenant)                                */
/* ------------------------------------------------------------------ */

describe('multi-tenant isolation (review history / stats / top-lapsed)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const firestoreMock = require('firebase-admin/firestore');
  const OWNER_A = 'auth0|user-a';
  const OWNER_B = 'auth0|user-b';

  interface StoredDoc {
    id: string;
    data: Record<string, unknown>;
  }

  function buildHarness(events: StoredDoc[], cards: StoredDoc[]) {
    const eventMap = new Map<string, Record<string, unknown>>(events.map((e) => [e.id, { ...e.data }]));
    const cardMap = new Map<string, Record<string, unknown>>(cards.map((c) => [c.id, { ...c.data }]));

    function makeQuery(collectionName: string) {
      const preds: Array<(d: StoredDoc) => boolean> = [];
      let sort: ((a: StoredDoc, b: StoredDoc) => number) | null = null;
      let qLimit = Infinity;
      let after: string | null = null;
      let projection: string[] | null = null;
      const q: Record<string, unknown> = {
        where: (field: string, op: string, value: unknown) => {
          preds.push((d) => {
            const v = (d.data as Record<string, unknown>)[field];
            if (op === '==') return v === value;
            if (op === 'in') return (value as unknown[]).includes(v);
            if (op === '>') return (v as number) > (value as number);
            if (op === '>=') return (v as { toMillis: () => number }).toMillis() >= (value as { toMillis: () => number }).toMillis();
            if (op === '<') return (v as { toMillis: () => number }).toMillis() < (value as { toMillis: () => number }).toMillis();
            return true;
          });
          return q;
        },
        orderBy: (field: string, dir?: string) => {
          sort = (a, b) => {
            const av = (a.data as Record<string, unknown>)[field];
            const bv = (b.data as Record<string, unknown>)[field];
            const am = (av as { toMillis?: () => number })?.toMillis?.() ?? (av as number);
            const bm = (bv as { toMillis?: () => number })?.toMillis?.() ?? (bv as number);
            const cmp = am < bm ? -1 : am > bm ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          };
          return q;
        },
        limit: (n: number) => { qLimit = n; return q; },
        startAfter: (...args: unknown[]) => { after = (args[args.length - 1] as { id?: string })?.id ?? null; return q; },
        select: (...fields: string[]) => { projection = fields as string[]; return q; },
        count: () => ({ get: async () => ({ data: () => ({ count: apply().length }) }) }),
        get: async () => {
          const list = apply();
          const rows = list.slice(0, qLimit).map((d) => {
            const data = projection ? Object.fromEntries(projection.map((f) => [f, (d.data as Record<string, unknown>)[f]])) : d.data;
            return { id: d.id, data: () => data, exists: true, ref: { id: d.id, path: `${collectionName}/${d.id}` } };
          });
          return { docs: rows, size: rows.length, empty: rows.length === 0 };
        },
      };
      function apply(): StoredDoc[] {
        let list = [...(collectionName === 'reviewEvents' ? eventMap : cardMap).entries()].map(([id, data]) => ({ id, data }));
        for (const p of preds) list = list.filter(p);
        if (sort) list = [...list].sort(sort);
        if (after !== null) {
          const idx = list.findIndex((d) => d.id === after);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        return list;
      }
      return q;
    }

    const db = {
      collection: jest.fn((name: string) => makeQuery(name)),
      runTransaction: jest.fn(),
      batch: jest.fn(),
      getAll: jest.fn(),
    };
    return { db, eventMap, cardMap };
  }

  function ts(ms: number) {
    return mockTimestamp(new Date(ms));
  }

  function ev(id: string, ownerId: string, reviewedMs: number): StoredDoc {
    return {
      id,
      data: {
        ownerId, actorId: ownerId, cardId: 'c1', rating: 3, stateBefore: 2,
        reviewedAt: ts(reviewedMs), recordedAt: ts(reviewedMs),
        stabilityAfter: 1, difficultyAfter: 5, repsAfter: 1, lapsesAfter: 0,
        cardFrontSnapshot: 'F', deckId: 'd1', deckName: 'Spanish',
      },
    };
  }

  async function freshModule(): Promise<typeof import('./reviewHistory')> {
    let mod: typeof import('./reviewHistory');
    jest.isolateModules(() => { mod = require('./reviewHistory'); });
    return mod!;
  }

  it('getReviewHistory never returns another owner\'s events', async () => {
    const events: StoredDoc[] = [
      ev('a1', OWNER_A, Date.parse('2026-08-05T00:00:00Z')),
      ev('a2', OWNER_A, Date.parse('2026-08-06T00:00:00Z')),
      ev('b1', OWNER_B, Date.parse('2026-08-07T00:00:00Z')),
      ev('unowned', 'LEGACY', Date.parse('2026-08-08T00:00:00Z')), // pre-multi-tenant (no verified owner)
    ];
    const { db } = buildHarness(events, []);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();
    const res = await mod.getReviewHistory({}, OWNER_A);
    expect(res.events.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
    expect(res.events.some((e) => e.id === 'b1')).toBe(false);
    expect(res.events.some((e) => e.id === 'unowned')).toBe(false);
  });

  it('getStudyStats and getTopLapsedCards are owner-scoped', async () => {
    const events: StoredDoc[] = [
      ev('a1', OWNER_A, Date.parse('2026-08-05T00:00:00Z')),
      ev('b1', OWNER_B, Date.parse('2026-08-07T00:00:00Z')),
    ];
    const cards: StoredDoc[] = [
      { id: 'card-a', data: { ownerId: OWNER_A, front: 'A', lapses: 9, reps: 5, deckId: 'd1', deck: 'Spanish' } },
      { id: 'card-b', data: { ownerId: OWNER_B, front: 'B', lapses: 99, reps: 5, deckId: 'd1', deck: 'Spanish' } },
    ];
    const { db } = buildHarness(events, cards);
    firestoreMock.getFirestore.mockReturnValue(db);
    const mod = await freshModule();

    const stats = await mod.getStudyStats({ from: '2026-08-01', to: '2026-08-31' }, OWNER_A);
    expect(stats.totalReviews).toBe(1); // only OWNER_A's event

    const top = await mod.getTopLapsedCards({ limit: 10 }, OWNER_A);
    expect(top.cards.map((c) => c.cardId)).toEqual(['card-a']); // never OWNER_B's 99-lapse card
  });
});

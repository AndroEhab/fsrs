/**
 * Enrollment service tests — resumable, idempotent, server-side chunked bulk
 * enrollment with Firestore trigger-based processing.
 *
 * Regression tests for:
 *  - Parent ordering: job doc exists before chunk triggers fire
 *  - Concurrent/repeated trigger: same chunk processed twice is idempotent
 *  - Scheduling preservation: existing card scheduling state untouched
 *  - Card key metadata sensitivity (deck/topic/suspended)
 *  - Immediate response pattern
 *  - Owner scoping
 */

import { createHash } from 'crypto';

/* ------------------------------------------------------------------ */
/* Mock Firebase Admin                                                */
/* ------------------------------------------------------------------ */

const jobWrites = new Map<string, Record<string, unknown>>();
const chunkWrites = new Map<string, Record<string, unknown>>();
const flashcardWrites = new Map<string, Record<string, unknown>>();

function makeSnapshot(docId: string, data: Record<string, unknown> | undefined) {
  return {
    id: docId,
    exists: data !== undefined,
    data: data ? () => ({ ...data }) : () => undefined,
  };
}

const mockBatch = {
  set: jest.fn(),
  commit: jest.fn().mockResolvedValue(undefined),
};

const mockFlashcardCollection = {
  _queryFilters: [] as Array<{ field: string; value: unknown }>,
  doc: jest.fn((id?: string) => {
    const docId = id || 'auto';
    return {
      id: docId, exists: true,
      data: jest.fn(),
      set: jest.fn(),
      get: jest.fn().mockImplementation(() => {
        const d = flashcardWrites.get(docId);
        return Promise.resolve(makeSnapshot(docId, d));
      }),
      ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() },
    };
  }),
  where: jest.fn().mockImplementation(function (this: Record<string, unknown>, field: string, _op: string, value: unknown) {
    (this as typeof mockFlashcardCollection)._queryFilters.push({ field, value });
    return this;
  }),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  startAfter: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  get: jest.fn().mockImplementation(function (this: typeof mockFlashcardCollection) {
    // Apply stored where filters to flashcardWrites
    const filters = this._queryFilters;
    let docs = [...flashcardWrites.entries()].map(([id, data]) => ({
      id, data: () => ({ ...data }),
    }));
    for (const f of filters) {
      docs = docs.filter((d) => {
        const snap = makeSnapshot(d.id, d.data());
        const dData = snap.data();
        return dData && dData[f.field] === f.value;
      });
    }
    return Promise.resolve({ empty: docs.length === 0, docs });
  }),
  add: jest.fn(),
};

const mockDeckCollection = {
  doc: jest.fn((id?: string) => {
    const docId = id || 'auto';
    const isDeck1 = docId === 'deck-1';
    return {
      id: docId,
      exists: isDeck1,
      data: jest.fn().mockReturnValue(isDeck1 ? { name: 'Test Deck', ownerId: 'test-owner' } : undefined),
      set: jest.fn(),
      get: jest.fn().mockResolvedValue(
        makeSnapshot(docId, isDeck1 ? { name: 'Test Deck', ownerId: 'test-owner' } : undefined),
      ),
      ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() },
    };
  }),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  startAfter: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
  add: jest.fn(),
};

const mockJobCollection = {
  doc: jest.fn((id?: string) => {
    const docId = id || 'auto-job';
    return {
      id: docId,
      exists: jobWrites.has(docId),
      data: jobWrites.has(docId) ? jest.fn().mockReturnValue({ ...jobWrites.get(docId) }) : jest.fn().mockReturnValue(undefined),
      set: jest.fn().mockImplementation((data: Record<string, unknown>) => {
        jobWrites.set(docId, { ...data, id: docId });
      }),
      update: jest.fn().mockImplementation((data: Record<string, unknown>) => {
        const prev = jobWrites.get(docId) || {};
        jobWrites.set(docId, { ...prev, ...data, id: docId });
      }),
      get: jest.fn().mockImplementation(() => {
        const d = jobWrites.get(docId);
        return Promise.resolve(makeSnapshot(docId, d));
      }),
      collection: jest.fn((subName: string) => {
        if (subName === 'chunks') {
          return {
            doc: jest.fn((chunkId?: string) => {
              const cid = chunkId || 'auto-chunk';
              return {
                id: cid,
                parent: { id: 'chunks' },
                exists: chunkWrites.has(cid),
                data: chunkWrites.has(cid) ? jest.fn().mockReturnValue(chunkWrites.get(cid)) : jest.fn().mockReturnValue(undefined),
                set: jest.fn().mockImplementation((data: Record<string, unknown>) => {
                  chunkWrites.set(cid, data);
                }),
                update: jest.fn().mockImplementation((data: Record<string, unknown>) => {
                  const prev = chunkWrites.get(cid) || {};
                  chunkWrites.set(cid, { ...prev, ...data });
                }),
                get: jest.fn().mockImplementation(() => {
                  const d = chunkWrites.get(cid);
                  return Promise.resolve(makeSnapshot(cid, d));
                }),
              };
            }),
          };
        }
        return { doc: jest.fn() };
      }),
    };
  }),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  startAfter: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
  add: jest.fn(),
};

const mockDbInstance = {
  collection: jest.fn((name: string) => {
    if (name === 'decks') return mockDeckCollection;
    if (name === 'bulkEnrollmentJobs') return mockJobCollection;
    return mockFlashcardCollection;
  }),
  batch: jest.fn(() => mockBatch),
  runTransaction: jest.fn(async (fn: (t: { get: jest.Mock; update: jest.Mock }) => Promise<void>) => {
    // FieldValue.increment() is atomic server-side — it operates on the
    // LATEST state, not the snapshot value. We simulate this by applying
    // increments immediately after each t.update() call (before fn
    // resumes from any internal await), ensuring subsequent reads see
    // the incremented values.
    const t = {
      get: jest.fn().mockImplementation(async (ref: { id?: string; parent?: { id?: string } }) => {
        const docId = ref?.id ?? '';
        // Determine collection from parent path: chunk docs have
        // parent.id='chunks', job docs are top-level.
        const isChunk = ref?.parent?.id === 'chunks';
        const store = isChunk ? chunkWrites : jobWrites;
        const d = store.get(docId);
        return makeSnapshot(docId, d);
      }),
      update: jest.fn().mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
        const docId = (_ref as { id?: string; parent?: { id?: string } })?.id ?? '';
        const isChunk = (_ref as { parent?: { id?: string } })?.parent?.id === 'chunks';
        const store = isChunk ? chunkWrites : jobWrites;
        const prev = store.get(docId) || {};
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && '_op' in v && (v as { _op?: string })._op === 'increment') {
            prev[k] = ((prev[k] as number) ?? 0) + ((v as { _increment?: number })._increment ?? 0);
          } else {
            prev[k] = v;
          }
        }
        prev.id = docId;
        store.set(docId, prev);
      }),
    };
    await fn(t);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDbInstance),
  Timestamp: {
    now: jest.fn(() => ({ toDate: () => new Date(), seconds: Date.now() / 1000, nanoseconds: 0, toMillis: () => Date.now() })),
    fromDate: jest.fn((d: Date) => ({ toDate: () => d, seconds: d.getTime() / 1000, nanoseconds: 0, toMillis: () => d.getTime() })),
  },
  FieldValue: class FieldValue {
    static delete() { return new FieldValue(); }
    static serverTimestamp() { return new FieldValue(); }
    static increment(n: number) { return { _increment: n, _op: 'increment' }; }
  },
  FieldPath: { documentId: jest.fn(() => '__name__') },
}));

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));

/* ------------------------------------------------------------------ */
/* Import after mocks                                                 */
/* ------------------------------------------------------------------ */

import {
  computeCardKey,
  bulkEnrollCards,
  getEnrollmentStatus,
  onEnrollmentChunkWritten,
} from './enrollment';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const OWNER = 'test-owner';

function makeCard(front: string, back: string, tags: string[] = [], overrides: Record<string, unknown> = {}) {
  return { front, back, tags, ...overrides };
}

function expectedCardKey(
  ownerId: string, front: string, back: string, tags: string[],
  deckId?: string | null, topic?: string | null, suspended?: boolean,
): string {
  const normFront = front.trim();
  const normBack = back.trim();
  const sortedTags = [...tags].sort().join(',');
  const normDeckId = (deckId ?? '').trim();
  const normTopic = (topic ?? '').trim();
  const suspendedStr = suspended === true ? '1' : '0';
  const payload = `${ownerId}|${normFront}|${normBack}|${sortedTags}|${normDeckId}|${normTopic}|${suspendedStr}`;
  return createHash('sha256').update(payload).digest('hex');
}

function makeChunkEvent(jobId: string, chunkId: string, chunkData: Record<string, unknown>) {
  return {
    data: {
      after: {
        data: () => chunkData,
        ref: {
          id: chunkId,
          parent: { id: 'chunks', parent: { id: jobId } },
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('computeCardKey', () => {
  it('differs for different deckIds', () => {
    expect(computeCardKey('o', 'Q', 'A', [], 'd1')).not.toBe(computeCardKey('o', 'Q', 'A', [], 'd2'));
  });
  it('differs for different topics', () => {
    expect(computeCardKey('o', 'Q', 'A', [], undefined, 'math')).not.toBe(
      computeCardKey('o', 'Q', 'A', [], undefined, 'science'),
    );
  });
  it('differs for different suspended states', () => {
    expect(computeCardKey('o', 'Q', 'A', [], undefined, undefined, false)).not.toBe(
      computeCardKey('o', 'Q', 'A', [], undefined, undefined, true),
    );
  });
  it('treats null/undefined identically to absent', () => {
    expect(computeCardKey('o', 'Q', 'A', [])).toBe(computeCardKey('o', 'Q', 'A', [], null));
  });
});

describe('bulkEnrollCards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jobWrites.clear();
    chunkWrites.clear();
    flashcardWrites.clear();
    mockBatch.set.mockClear();
    mockBatch.commit.mockClear();
    mockBatch.commit.mockResolvedValue(undefined);
  });

  it('returns immediately with status=processing', async () => {
    const result = await bulkEnrollCards(
      { cards: [makeCard('Q1', 'A1', []), makeCard('Q2', 'A2', [])] },
      OWNER,
    );
    expect(result.jobId).toBeDefined();
    expect(result.status).toBe('processing');
    expect(result.completedChunks).toBe(0);
  });

  it('is idempotent: same cards produce same jobId', async () => {
    const cards = [makeCard('Q1', 'A1', ['t']), makeCard('Q2', 'A2', [])];
    const r1 = await bulkEnrollCards({ cards }, OWNER);
    const r2 = await bulkEnrollCards({ cards }, OWNER);
    expect(r2.jobId).toBe(r1.jobId);
  });

  it('creates job doc BEFORE chunks (parent ordering)', async () => {
    await bulkEnrollCards({ cards: [makeCard('Q1', 'A1', [])] }, OWNER);

    // Verify job doc was created
    const jobKeys = [...jobWrites.keys()];
    expect(jobKeys.length).toBe(1);
    const jobId = jobKeys[0];
    expect(jobWrites.get(jobId)?.status).toBe('processing');

    // Verify chunks were written via batch (single commit)
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    expect(mockBatch.set).toHaveBeenCalledTimes(1);
    // Chunk data is in the batch call args
    const chunkCall = mockBatch.set.mock.calls[0];
    expect(chunkCall[1].status).toBe('pending');
  });

  it('RESUME RACE: completed job not regressed to processing', async () => {
    const cards = [makeCard('Q1', 'A1', [])];
    const r = await bulkEnrollCards({ cards }, OWNER);

    // Mark as completed (simulates trigger finishing before resume)
    jobWrites.set(r.jobId, {
      ...jobWrites.get(r.jobId),
      status: 'completed', completedChunks: 1, createdCount: 1,
    });

    // Resume call — should NOT regress status to 'processing'
    const r2 = await bulkEnrollCards({ cards }, OWNER);
    expect(r2.status).toBe('completed');
    expect(r2.createdCount).toBe(1);
  });

  it('resume picks up from last completed chunk', async () => {
    const cards = Array.from({ length: 250 }, (_, i) => makeCard(`Q${i}`, `A${i}`, []));
    const r = await bulkEnrollCards({ cards }, OWNER);
    expect(r.totalChunks).toBe(3);
    jobWrites.set(r.jobId, {
      ...jobWrites.get(r.jobId),
      completedChunks: 1, createdCount: 100, failedCount: 0, status: 'processing',
    });
    const r2 = await bulkEnrollCards({ cards }, OWNER);
    expect(r2.completedChunks).toBe(1);
  });
});

describe('onEnrollmentChunkWritten (trigger)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jobWrites.clear();
    chunkWrites.clear();
    flashcardWrites.clear();
    mockFlashcardCollection._queryFilters = [];
    mockBatch.set.mockClear();
    mockBatch.commit.mockClear();
    mockBatch.commit.mockResolvedValue(undefined);
  });

  it('processes a chunk and updates job progress', async () => {
    const jobId = 'test-job-1';
    const chunkId = '00000';
    const cards = [makeCard('Q1', 'A1', []), makeCard('Q2', 'A2', [])];
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 2, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set(chunkId, {
      chunkIndex: 0, cards, cardCount: 2, status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));

    expect(mockBatch.set).toHaveBeenCalledTimes(2);
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    expect(chunkWrites.get(chunkId)?.status).toBe('completed');
    const job = jobWrites.get(jobId);
    expect(job?.completedChunks).toBe(1);
    expect(job?.createdCount).toBe(2);
    expect(job?.status).toBe('completed');
  });

  it('short-circuits if chunk is already completed (reads CURRENT state)', async () => {
    const jobId = 'done-job';
    const chunkId = '00000';
    // Seed chunk as already completed in Firestore
    chunkWrites.set(chunkId, {
      chunkIndex: 0, cards: [], cardCount: 0, status: 'completed', ownerId: OWNER,
    });
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 0, totalChunks: 1, completedChunks: 1,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));
    // Transaction sees status='completed' → no-op, no card writes
    expect(mockBatch.set).not.toHaveBeenCalled();
    expect(mockBatch.commit).not.toHaveBeenCalled();
  });

  it('DUPLICATE EVENT: second invocation with stale pending snapshot no-ops', async () => {
    const jobId = 'dup-job';
    const chunkId = '00000';
    const cards = [makeCard('Q1', 'A1', [])];
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    // Chunk starts as pending
    chunkWrites.set(chunkId, {
      chunkIndex: 0, cards, cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    // First event — processes the chunk
    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    expect(chunkWrites.get(chunkId)?.status).toBe('completed');
    expect(jobWrites.get(jobId)?.status).toBe('completed');

    // Second event with STALE snapshot (still says 'pending')
    // The transaction reads CURRENT state → sees 'completed' → no-op
    mockBatch.set.mockClear();
    mockBatch.commit.mockClear();
    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, {
      chunkIndex: 0, cards, cardCount: 1, status: 'pending', ownerId: OWNER,
    }));
    expect(mockBatch.set).not.toHaveBeenCalled();
    expect(mockBatch.commit).not.toHaveBeenCalled();
    // Job counters unchanged
    expect(jobWrites.get(jobId)?.createdCount).toBe(1);
  });

  it('RETRY INCOMPLETE JOB: resume re-writes pending chunks, trigger fires via onDocumentWritten', async () => {
    const jobId = 'retry-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 2, totalChunks: 2, completedChunks: 1,
      createdCount: 1, skippedCount: 0, failedCount: 0,
    });
    // First chunk already completed
    chunkWrites.set('00000', {
      chunkIndex: 0, cards: [makeCard('Q0', 'A0', [])], cardCount: 1,
      status: 'completed', createdCount: 1, skippedCount: 0, failedCount: 0, ownerId: OWNER,
    });
    // Second chunk pending (from original write)
    chunkWrites.set('00001', {
      chunkIndex: 1, cards: [makeCard('Q1', 'A1', [])], cardCount: 1,
      status: 'pending', ownerId: OWNER,
    });

    // Resume re-writes the pending chunk (simulates .set() in resume path)
    // onDocumentWritten fires because .set() on existing doc is an update
    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00001', chunkWrites.get('00001')!));

    const job = jobWrites.get(jobId);
    expect(job?.completedChunks).toBe(2);
    expect(job?.createdCount).toBe(2);
    expect(job?.status).toBe('completed');
  });

  it('REPEAT TRIGGER on same chunk: idempotent (no duplicate writes)', async () => {
    const jobId = 'repeat-job';
    const chunkId = '00000';
    const cards = [makeCard('Q1', 'A1', [])];
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set(chunkId, {
      chunkIndex: 0, cards, cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    // First trigger
    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    const jobAfterFirst = jobWrites.get(jobId);
    expect(jobAfterFirst?.createdCount).toBe(1);

    // Mark chunk as completed (simulating trigger's update)
    chunkWrites.set(chunkId, { ...chunkWrites.get(chunkId)!, status: 'completed' });

    // Second trigger on same chunk — should short-circuit
    mockBatch.set.mockClear();
    mockBatch.commit.mockClear();
    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));
    expect(mockBatch.set).not.toHaveBeenCalled();
    expect(mockBatch.commit).not.toHaveBeenCalled();
  });

  it('TWO CHUNKS processed in sequence: progress accumulates correctly via FieldValue.increment()', async () => {
    const jobId = 'concurrent-job';
    const cards0 = [makeCard('Q0', 'A0', [])];
    const cards1 = [makeCard('Q1', 'A1', [])];
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 2, totalChunks: 2, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0, cards: cards0, cardCount: 1, status: 'pending', ownerId: OWNER,
    });
    chunkWrites.set('00001', {
      chunkIndex: 1, cards: cards1, cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    // Fire both triggers concurrently
    await Promise.all([
      onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!)),
      onEnrollmentChunkWritten(makeChunkEvent(jobId, '00001', chunkWrites.get('00001')!)),
    ]);

    const job = jobWrites.get(jobId);
    // Both chunks completed — progress should reflect both
    expect(job?.completedChunks).toBe(2);
    expect(job?.createdCount).toBe(2);
    expect(job?.status).toBe('completed');
  });

  it('LEGACY RECONCILIATION: random-ID card in same deck is skipped, not duplicated', async () => {
    // Simulate a legacy card created by bulk_create with random ID
    const legacyDocId = 'random-legacy-id-12345';
    flashcardWrites.set(legacyDocId, {
      ownerId: OWNER,
      front: 'What is photosynthesis?',
      back: 'Process converting light to chemical energy',
      tags: ['biology', 'science'],
      deckId: 'deck-1',
      topic: 'biology',
      suspended: false,
      createdAt: { toDate: () => new Date('2026-01-01') },
    });

    // Also set up the deck document for resolution
    jobWrites.clear();
    chunkWrites.clear();

    const jobId = 'legacy-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0,
      cards: [makeCard('What is photosynthesis?', 'Process converting light to chemical energy',
        ['biology', 'science'], { deckId: 'deck-1', topic: 'biology' })],
      cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!));

    // Card should be SKIPPED (legacy match found in deck), not created
    expect(mockBatch.set).not.toHaveBeenCalled();
    expect(mockBatch.commit).not.toHaveBeenCalled();
    const job = jobWrites.get(jobId);
    expect(job?.skippedCount).toBe(1);
    expect(job?.createdCount).toBe(0);
  });

  it('LEGACY RECONCILIATION: different content in same deck IS created', async () => {
    // Pre-seed a legacy card
    flashcardWrites.set('legacy-other', {
      ownerId: OWNER, front: 'Old Question', back: 'Old Answer',
      tags: [], deckId: 'deck-1', suspended: false,
    });

    jobWrites.clear();
    chunkWrites.clear();
    const jobId = 'legacy-new-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0,
      cards: [makeCard('Brand New Question', 'Brand New Answer', [], { deckId: 'deck-1' })],
      cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!));

    // Different content → should be created
    expect(mockBatch.set).toHaveBeenCalledTimes(1);
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    const job = jobWrites.get(jobId);
    expect(job?.createdCount).toBe(1);
    expect(job?.skippedCount).toBe(0);
  });

  it('SCHEDULING PRESERVATION: existing card scheduling NOT reset', async () => {
    const cardKey = expectedCardKey(OWNER, 'Q1', 'A1', []);
    // Pre-seed card with mature scheduling state
    flashcardWrites.set(cardKey, {
      ownerId: OWNER, front: 'Q1', back: 'A1', tags: [],
      state: 2, stability: 15.5, difficulty: 0.3, reps: 10, lapses: 2,
      reviewLog: [{ rating: 3, reviewedAt: '2026-01-01' }],
      images: [{ url: 'img.png' }],
      createdAt: { toDate: () => new Date('2026-01-01') },
    });

    const jobId = 'scheduling-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0, cards: [makeCard('Q1', 'A1', [])], cardCount: 1,
      status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!));

    // Card already exists for same owner — should be SKIPPED (not written)
    expect(mockBatch.set).not.toHaveBeenCalled();
    expect(mockBatch.commit).not.toHaveBeenCalled();

    // Job should count it as skipped
    const job = jobWrites.get(jobId);
    expect(job?.skippedCount).toBe(1);
    expect(job?.createdCount).toBe(0);
  });

  it('new card gets fresh scheduling', async () => {
    const jobId = 'fresh-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0, cards: [makeCard('NEW', 'CARD', [])], cardCount: 1,
      status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!));

    expect(mockBatch.set).toHaveBeenCalledTimes(1);
    const job = jobWrites.get(jobId);
    expect(job?.createdCount).toBe(1);
    expect(job?.skippedCount).toBe(0);
  });

  it('transaction reads both chunk and job before any writes (read-before-write)', async () => {
    const jobId = 'rbw-job';
    const chunkId = '00000';
    const cards = [makeCard('Q1', 'A1', [])];
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 1, totalChunks: 1, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set(chunkId, {
      chunkIndex: 0, cards, cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    // Track t.get and t.update call order
    const callOrder: string[] = [];
    const origRunTransaction = mockDbInstance.runTransaction;
    mockDbInstance.runTransaction = jest.fn(async (fn: (t: { get: jest.Mock; update: jest.Mock }) => Promise<void>) => {
      const t = {
        get: jest.fn().mockImplementation(async (ref: { id?: string; parent?: { id?: string } }) => {
          callOrder.push('get');
          const docId = ref?.id ?? '';
          const isChunk = ref?.parent?.id === 'chunks';
          const store = isChunk ? chunkWrites : jobWrites;
          const d = store.get(docId);
          return makeSnapshot(docId, d);
        }),
        update: jest.fn().mockImplementation((_ref: unknown, data: Record<string, unknown>) => {
          callOrder.push('update');
          const docId = (_ref as { id?: string; parent?: { id?: string } })?.id ?? '';
          const isChunk = (_ref as { parent?: { id?: string } })?.parent?.id === 'chunks';
          const store = isChunk ? chunkWrites : jobWrites;
          const prev = store.get(docId) || {};
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && '_op' in v && (v as { _op?: string })._op === 'increment') {
              prev[k] = ((prev[k] as number) ?? 0) + ((v as { _increment?: number })._increment ?? 0);
            } else {
              prev[k] = v;
            }
          }
          prev.id = docId;
          store.set(docId, prev);
        }),
      };
      await fn(t);
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, chunkId, chunkWrites.get(chunkId)!));

    // All gets must precede all updates (Firestore tx constraint)
    const firstUpdateIdx = callOrder.indexOf('update');
    const allGetsBeforeFirstUpdate = callOrder.slice(0, firstUpdateIdx).every((c) => c === 'get');
    expect(allGetsBeforeFirstUpdate).toBe(true);
    // Should have exactly 2 gets (chunk + job) before any updates
    expect(callOrder.slice(0, firstUpdateIdx)).toEqual(['get', 'get']);

    mockDbInstance.runTransaction = origRunTransaction;
  });

  it('processes multiple chunks for a multi-chunk job', async () => {
    const jobId = 'multi-job';
    jobWrites.set(jobId, {
      id: jobId, ownerId: OWNER, status: 'processing',
      totalCards: 2, totalChunks: 2, completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0,
    });
    chunkWrites.set('00000', {
      chunkIndex: 0, cards: [makeCard('Q0', 'A0', [])], cardCount: 1, status: 'pending', ownerId: OWNER,
    });
    chunkWrites.set('00001', {
      chunkIndex: 1, cards: [makeCard('Q1', 'A1', [])], cardCount: 1, status: 'pending', ownerId: OWNER,
    });

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00000', chunkWrites.get('00000')!));
    let job = jobWrites.get(jobId);
    expect(job?.completedChunks).toBe(1);
    expect(job?.status).toBe('processing');

    await onEnrollmentChunkWritten(makeChunkEvent(jobId, '00001', chunkWrites.get('00001')!));
    job = jobWrites.get(jobId);
    expect(job?.completedChunks).toBe(2);
    expect(job?.status).toBe('completed');
  });
});

describe('getEnrollmentStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jobWrites.clear();
  });

  it('returns null for unknown job', async () => {
    expect(await getEnrollmentStatus('nope', OWNER)).toBeNull();
  });

  it('returns status with skippedCount', async () => {
    const now = { toDate: () => new Date(), seconds: Date.now() / 1000, nanoseconds: 0, toMillis: () => Date.now() };
    jobWrites.set('j1', {
      id: 'j1', ownerId: OWNER, status: 'completed',
      totalCards: 100, totalChunks: 1, completedChunks: 1,
      createdCount: 80, skippedCount: 20, failedCount: 0,
      createdAt: now, updatedAt: now,
    });
    const r = await getEnrollmentStatus('j1', OWNER);
    expect(r).not.toBeNull();
    expect(r!.createdCount).toBe(80);
    expect(r!.skippedCount).toBe(20);
  });

  it('returns null for another owner', async () => {
    const now = { toDate: () => new Date(), seconds: Date.now() / 1000, nanoseconds: 0, toMillis: () => Date.now() };
    jobWrites.set('j2', {
      id: 'j2', ownerId: 'other', status: 'completed',
      totalCards: 50, totalChunks: 1, completedChunks: 1,
      createdCount: 50, skippedCount: 0, failedCount: 0,
      createdAt: now, updatedAt: now,
    });
    expect(await getEnrollmentStatus('j2', OWNER)).toBeNull();
  });
});

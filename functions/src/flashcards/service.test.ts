import { SESSION_QUEUE_CHUNK_SIZE, SESSION_MAX_ALLOWLIST_IDS } from './types';
import {
  ReviewSessionBuildFailedError,
  ReviewSessionSelectionTooLargeError,
} from './service';
import {
  createFlashcard,
  getFlashcard,
  updateFlashcard,
  deleteFlashcard,
  listFlashcards,
  dueFlashcards,
  reviewFlashcard,
  resetFlashcards,
  setFlashcardDueDate,
  suspendFlashcards,
  unsuspendFlashcards,
  verifyApiKey,
  bulkCreateFlashcards,
  bulkUpdateFlashcards,
  bulkDeleteFlashcards,
  listTags,
  renameTag,
  deleteTag,
  mergeTags,
  uploadImage,
  validateImageUrl,
  startReviewSession,
  getReviewSession,
  submitSessionReview,
  endReviewSession,
  searchCards,
  countFlashcards,
  ImageValidationError,
  ReviewSessionForbiddenError,
  ReviewExpectedCardMismatchError,
} from './service';
import { DeckNotFoundError } from './decks';
import { InvalidPageTokenError } from './documentPageTokens';
import { CreateFlashcardInput, UpdateFlashcardInput, ListFlashcardsQuery, DueFlashcardsQuery, ReviewFlashcardInput, SearchCardsQuery } from './types';

// Mock Firebase Admin with separate mocks for flashcards and apiKeys collections
const createMockDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-id',
  data: jest.fn(),
  exists: true,
  set: jest.fn(),
  get: jest.fn(),
  ref: {
    update: jest.fn(),
    delete: jest.fn(),
    set: jest.fn(),
  },
  ...overrides,
});

const createMockCollection = (doc: Record<string, unknown>): Record<string, unknown> => {
  const collection: Record<string, unknown> = {
    doc: jest.fn(() => doc),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    startAfter: jest.fn(),
    select: jest.fn(),
    get: jest.fn(),
    add: jest.fn(),
  };
  // Self-referential chain: chained query builders return the SAME collection,
  // and a default empty result keeps query-shaped code (find-or-create, etc.)
  // working without per-test wiring.
  collection.where = jest.fn(() => collection);
  collection.orderBy = jest.fn(() => collection);
  collection.limit = jest.fn(() => collection);
  collection.startAfter = jest.fn(() => collection);
  collection.select = jest.fn(() => collection);
  collection.get = jest.fn().mockResolvedValue({ empty: true, docs: [] });
  return collection;
};

const mockFlashcardDoc = createMockDoc({ data: jest.fn().mockReturnValue({ ownerId: 'Test Key' }) });
const mockFlashcardCollection = createMockCollection(mockFlashcardDoc);

const mockApiKeyDoc = createMockDoc();
const mockApiKeyCollection = createMockCollection(mockApiKeyDoc);

const mockDeckDoc = createMockDoc({ id: 'deck-1', data: jest.fn().mockReturnValue({ name: 'Test Deck', ownerId: 'Test Key' }) });
const mockDeckCollection = createMockCollection(mockDeckDoc);

const mockSessionDoc = createMockDoc({ id: 'session-1' });
const mockSessionCollection = createMockCollection(mockSessionDoc);
mockSessionCollection.doc = jest.fn((id: string) => ({ ...mockSessionDoc, id }));

const mockEventDoc = createMockDoc({ id: 'event-1' });
const mockEventCollection = createMockCollection(mockEventDoc);

// Single stable db instance: getDb() memoizes the first getFirestore() result,
// so the mock returns the SAME object every call (referenced lazily inside the
// factory arrow, matching how the collection mocks are referenced).
const mockDbInstance = {
  collection: jest.fn((name: string) => {
    if (name === 'apiKeys') return mockApiKeyCollection;
    if (name === 'decks') return mockDeckCollection;
    if (name === 'reviewSessions') return mockSessionCollection;
    if (name === 'reviewEvents') return mockEventCollection;
    return mockFlashcardCollection;
  }),
  runTransaction: jest.fn(),
  batch: jest.fn(),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDbInstance),
  Timestamp: Object.assign(
    class MockTimestamp {
      constructor(public seconds: number, public nanoseconds = 0) {}
      toDate() { return new Date(this.toMillis()); }
      toMillis() { return this.seconds * 1000 + this.nanoseconds / 1_000_000; }
    },
    {
      now: jest.fn(() => ({ toDate: () => new Date(), seconds: Date.now() / 1000, nanoseconds: 0 })),
      fromDate: jest.fn((d: Date) => ({ toDate: () => d, seconds: d.getTime() / 1000, nanoseconds: 0 })),
      fromMillis: jest.fn((ms: number) => ({ toDate: () => new Date(ms), seconds: ms / 1000, nanoseconds: (ms % 1000) * 1000000, toMillis: () => ms })),
    },
  ),
  FieldValue: class FieldValue {
    static delete() { return new FieldValue(); }
    static serverTimestamp() { return new FieldValue(); }
    static increment(n: number) { return Object.assign(new FieldValue(), { _increment: n }); }
  },
  FieldPath: {
    documentId: jest.fn(() => '__name__'),
  },
}));
const mockStorageBucket = {
  getFiles: jest.fn().mockResolvedValue([[]]),
};

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: jest.fn(() => mockStorageBucket) })),
}));


const mockTimestamp = (d: Date) => ({ toDate: () => d, seconds: d.getTime() / 1000, nanoseconds: 0, toMillis: () => d.getTime() });
const mockOwnedDeckRef = (id: string, name: string) => {
  const snapshot = {
    id,
    exists: true,
    data: () => ({
      ownerId: 'Test Key',
      name,
      createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
    }),
  };
  return { id, get: jest.fn().mockResolvedValue(snapshot) };
};

/**
 * Adds the no-op transaction operations used for immutable review events and
 * request claims in tests that only assert card/session behavior.
 */
function withEventTx<T extends Record<string, unknown>>(
  base: T,
): T & { set: jest.Mock; create: jest.Mock; delete: jest.Mock } {
  return {
    ...base,
    set: (base.set as jest.Mock | undefined) ?? jest.fn(),
    create: (base.create as jest.Mock | undefined) ?? jest.fn(),
    delete: (base.delete as jest.Mock | undefined) ?? jest.fn(),
  };
}

describe('Flashcard Service', () => {
  let mockDb: any;
  let mockFlashcardCollectionRef: any;
  let mockFlashcardDocRef: any;
  let mockApiKeyCollectionRef: any;
  let mockDeckCollectionRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockFlashcardCollectionRef.doc.mockImplementation(() => mockFlashcardDoc);
    mockFlashcardDocRef = mockFlashcardCollectionRef.doc();
    mockApiKeyCollectionRef = mockDb.collection('apiKeys');
    mockDeckCollectionRef = mockDb.collection('decks');
    // clearAllMocks keeps mockReturnValue implementations from prior tests, so
    // restore the base doc()/query behavior explicitly.
    mockDeckCollectionRef.doc.mockImplementation(() => mockDeckDoc);
    mockDeckDoc.id = 'deck-1';
    mockDeckDoc.data.mockReturnValue({ name: 'Test Deck', ownerId: 'Test Key' });
    mockDeckDoc.get.mockResolvedValue(mockDeckDoc);
    // Keep the scheduler's Timestamp.now() deterministic for due/review tests.
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T00:00:00.000Z')));
  });

  describe('createFlashcard', () => {
    function configureDeckTransaction(deckId: string, name: string, cardId: string) {
      const deckSnap = { id: deckId, exists: true, data: () => ({ name, ownerId: 'Test Key' }) };
      const deckRef = { id: deckId, get: jest.fn().mockResolvedValue(deckSnap) };
      const cardRef = { id: cardId };
      const transaction = { get: jest.fn().mockResolvedValue(deckSnap), create: jest.fn() };
      mockDeckCollectionRef.doc.mockReturnValue(deckRef);
      mockFlashcardCollectionRef.doc.mockReturnValue(cardRef);
      mockDb.runTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction));
      return { transaction, cardRef };
    }
    it('creates a flashcard with all fields using the deck name re-read in the transaction', async () => {
      const input: CreateFlashcardInput = {
        front: 'What is 2+2?',
        back: '4',
        deckId: 'math-deck',
        tags: ['arithmetic'],
      };
      const { transaction } = configureDeckTransaction('math-deck', 'Math', 'new-card-id');

      const result = await createFlashcard(input, 'Test Key');

      expect(result.id).toBe('new-card-id');
      expect(result.front).toBe('What is 2+2?');
      expect(result.back).toBe('4');
      expect(result.deckId).toBe('math-deck');
      expect(result.deck).toBe('Math');
      expect(result.tags).toEqual(['arithmetic']);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.due).toBeDefined();
      expect(transaction.create).toHaveBeenCalledWith({ id: 'new-card-id' }, expect.objectContaining({
        front: 'What is 2+2?',
        back: '4',
        deck: 'Math',
        tags: ['arithmetic'],
      }));
    });

    it('assigns an owned deck id and reads its current name transactionally', async () => {
      const input: CreateFlashcardInput = { front: 'F', back: 'B', deckId: 'deck-xyz' };
      const { transaction } = configureDeckTransaction('deck-xyz', 'Spanish current', 'card-d1');

      const result = await createFlashcard(input, 'Test Key');

      expect(result.deckId).toBe('deck-xyz');
      expect(result.deck).toBe('Spanish current');
      expect(transaction.create).toHaveBeenCalledWith({ id: 'card-d1' }, expect.objectContaining({
        deckId: 'deck-xyz', deck: 'Spanish current',
      }));
    });

    it('rejects a non-existent deckId with a typed DeckNotFoundError (client 404)', async () => {
      const input: CreateFlashcardInput = { front: 'F', back: 'B', deckId: 'missing-deck' };
      mockDeckCollectionRef.doc.mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: false }) });

      await expect(createFlashcard(input, 'Test Key')).rejects.toBeInstanceOf(DeckNotFoundError);
      await expect(createFlashcard(input, 'Test Key')).rejects.toThrow('Deck not found: missing-deck');
    });
  });

  describe('getFlashcard', () => {
    it('returns flashcard when found', async () => {
      const mockData = {
        ownerId: 'Test Key',
        front: 'Front',
        back: 'Back',
        deck: 'Deck',
        tags: ['tag1'],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
      };
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(mockData);
      mockFlashcardDocRef.id = 'card-123';
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await getFlashcard('card-123', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('card-123');
      expect(result!.front).toBe('Front');
    });

    it('returns null when not found', async () => {
      mockFlashcardDocRef.exists = false;
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await getFlashcard('nonexistent', 'Test Key');

      expect(result).toBeNull();
    });
  });

  describe('updateFlashcard', () => {
    it('updates flashcard and returns updated', async () => {
      const existingData = {
        ownerId: 'Test Key',
        front: 'Old Front',
        back: 'Back',
        deck: 'Deck',
        tags: ['tag1'],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
      };

      const snap = { exists: true, id: 'card-123', data: () => existingData };
      const cardRef = { id: 'card-123' };
      const transaction = { get: jest.fn().mockResolvedValue(snap), update: jest.fn() };
      mockFlashcardCollectionRef.doc.mockReturnValue(cardRef);
      mockDb.runTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction));

      const input: UpdateFlashcardInput = { front: 'New Front' };
      const result = await updateFlashcard('card-123', input, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.front).toBe('New Front');
      expect(transaction.update).toHaveBeenCalledWith(cardRef, expect.objectContaining({
        front: 'New Front',
        updatedAt: expect.any(Object),
      }));
    });

    it('rejects deckId null (every card must belong to a deck)', async () => {
      const existingData = {
        ownerId: 'Test Key',
        front: 'F',
        back: 'B',
        deckId: 'deck-1',
        deck: 'Spanish',
        tags: [],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
      };
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(existingData);
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      // deckId: null is no longer accepted — must cast to bypass TS for the mock call
      await expect(
        updateFlashcard('card-1', { deckId: null as unknown as string }, 'Test Key'),
      ).rejects.toThrow('Cannot detach a card from its deck');
    });
  });

  describe('explicit scheduling management (reset / set-due / suspend / unsuspend)', () => {
    function reviewedCardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        ownerId: 'Test Key',
        front: 'Front',
        back: 'Back',
        deckId: 'deck-1',
        deck: 'Spanish',
        tags: ['verb'],
        topic: 'grammar',
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-09-10T00:00:00Z')),
        state: 2,
        stability: 12.3,
        difficulty: 5.2,
        reps: 4,
        lapses: 1,
        lastReview: mockTimestamp(new Date('2026-09-05T00:00:00Z')),
        reviewLog: [
          { rating: 3, state: 0, review: mockTimestamp(new Date('2026-08-01T00:00:00Z')), due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), stability: 2.3, difficulty: 6.4, reps: 1, lapses: 0 },
        ],
        images: [],
        ...overrides,
      };
    }
    // Helper: run a service scheduling function against the shared doc mock
    // with the given stored card data, capturing the transaction update.
    async function runWithCard(
      fn: (ids: string[], ownerId: string) => Promise<{ ids: string[]; count: number; cards: unknown[] }>,
      ids: string[],
      stored: Record<string, unknown>,
      ownerId = 'Test Key',
    ): Promise<{ result: { ids: string[]; count: number; cards: unknown[] }; txnUpdates: Record<string, unknown>[] }> {
      // Each requested id maps to its own docRef/snapshot so the executor's
      // existence check distinguishes missing ids from existing ones. The
      // service calls `t.get(collection.doc(id))` — the Map is keyed by the
      // DOC object (the same object collection.doc returns).
      type Snap = { id: string; exists: boolean; data: () => Record<string, unknown> | undefined; ref: { update: jest.Mock; id: string; path: string } };
      const existingDoc: Snap = {
        id: 'card-1', exists: true, data: () => stored,
        ref: { update: jest.fn(), id: 'card-1', path: 'flashcards/card-1' },
      };
      const missingDoc: Snap = {
        id: 'missing', exists: false, data: () => undefined,
        ref: { update: jest.fn(), id: 'missing', path: 'flashcards/missing' },
      };
      const docsByRef = new Map<unknown, Snap>([
        [existingDoc, existingDoc],
        [missingDoc, missingDoc],
      ]);
      // Save the collection doc() implementation BEFORE overriding it and
      // restore it afterwards: jest.clearAllMocks() does NOT reset
      // implementations, so a leaked override would corrupt the doc() default
      // every later test relies on (the shared mock's closure).
      const prevDocImpl = mockFlashcardCollectionRef.doc.getMockImplementation();
      mockFlashcardCollectionRef.doc.mockImplementation((id?: string) => {
        if (id === 'missing') return missingDoc;
        return existingDoc;
      });
      const txnUpdates: Record<string, unknown>[] = [];
      const txn = {
        get: jest.fn(async (ref: unknown): Promise<Snap> => docsByRef.get(ref) ?? { id: 'x', exists: false, data: () => undefined, ref: { update: jest.fn(), id: 'x', path: 'flashcards/x' } }),
        update: jest.fn((_ref: unknown, data: Record<string, unknown>) => { txnUpdates.push(data); }),
      };
      mockDb.runTransaction = jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(txn));
      try {
        const result = await fn(ids, ownerId);
        return { result, txnUpdates };
      } finally {
        if (prevDocImpl) mockFlashcardCollectionRef.doc.mockImplementation(prevDocImpl);
      }
    }

    it('resetFlashcards resets scheduling to a fresh New/due-now state in one transaction and keeps content + suspension', async () => {
      const { result, txnUpdates } = await runWithCard(resetFlashcards as never, ['card-1'], reviewedCardData());
      expect(result.ids).toEqual(['card-1']);
      expect(result.count).toBe(1);
      const card = result.cards[0] as Record<string, unknown>;
      expect(card.state).toBe(0);
      expect(card.stability).toBe(0);
      expect(card.difficulty).toBe(0);
      expect(card.reps).toBe(0);
      expect(card.lapses).toBe(0);
      expect(card.reviewLog).toEqual([]);
      expect(card.lastReview).toBeUndefined();
      // Content fields preserved.
      expect(card.front).toBe('Front');
      expect(card.deckId).toBe('deck-1');
      expect(card.suspended).toBe(false); // absent field reads as false; reset never touches it
      const update = txnUpdates[0];
      expect(update.reps).toBe(0);
      expect(update.lastReview).toEqual(expect.anything()); // FieldValue.delete marker
      expect(update.updatedAt).toBeDefined();
    });

    it('resetFlashcards returned card omits lastReview (FieldValue.delete sentinel is stripped, not serialized)', async () => {
      // Regression: stripFieldDeleteSentinels used to duck-type on __fieldDelete,
      // which the real Firestore SDK's DeleteTransform does NOT carry — only the
      // test mock did. The fix uses instanceof FieldValue; this test proves the
      // returned card's lastReview is genuinely absent (not an [object Object]).
      const { result } = await runWithCard(resetFlashcards as never, ['card-1'], reviewedCardData());
      const card = result.cards[0] as Record<string, unknown>;
      expect('lastReview' in card).toBe(false);
      // Confirm the sentinel was correctly consumed (not leaked as a raw object).
      expect(card.lastReview).toBeUndefined();
      // Confirm JSON.stringify would omit the field entirely.
      expect(JSON.parse(JSON.stringify(card))).not.toHaveProperty('lastReview');
    });

    it('resetFlashcards returns due: now (the deterministic Timestamp.now of the test) so the card is due immediately', async () => {
      const { result } = await runWithCard(resetFlashcards as never, ['card-1'], reviewedCardData());
      const card = result.cards[0] as { due: { toMillis(): number } };
      expect(card.due.toMillis()).toBe(new Date('2026-08-28T00:00:00.000Z').getTime()); // Timestamp.now mock
    });

    it('resetFlashcards omits ids that do not exist (never an error) and commits atomically', async () => {
      const { result, txnUpdates } = await runWithCard(resetFlashcards as never, ['missing', 'card-1'], reviewedCardData());
      expect(result.ids).toEqual(['card-1']);
      expect(result.count).toBe(1);
      expect(txnUpdates).toHaveLength(1);
    });

    it('setFlashcardDueDate writes the parsed due timestamp and preserves the FSRS state', async () => {
      const { result, txnUpdates } = await runWithCard(
        (ids, ownerId) => setFlashcardDueDate(ids, '2026-09-15T08:30:00.000Z', ownerId),
        ['card-1'],
        reviewedCardData(),
      );
      expect(result.ids).toEqual(['card-1']);
      expect(result.count).toBe(1);
      const update = txnUpdates[0];
      expect((update.due as { toMillis(): number }).toMillis()).toBe(Date.parse('2026-09-15T08:30:00.000Z'));
      const card = result.cards[0] as Record<string, unknown>;
      expect(card.state).toBe(2); // state untouched
      expect(card.reps).toBe(4);  // scheduling memory preserved
      expect(card.reviewLog).toHaveLength(1);
    });

    it('suspendFlashcards sets suspended: true and preserves scheduling', async () => {
      const { result, txnUpdates } = await runWithCard(suspendFlashcards as never, ['card-1'], reviewedCardData());
      const update = txnUpdates[0];
      expect(update.suspended).toBe(true);
      const card = result.cards[0] as Record<string, unknown>;
      expect(card.suspended).toBe(true);
      expect(card.state).toBe(2);
      expect(card.due).toBeDefined();
    });

    it('unsuspendFlashcards removes the suspended field (FieldValue.delete marker) and returns suspended: false (logical boolean)', async () => {
      const { result, txnUpdates } = await runWithCard(unsuspendFlashcards as never, ['card-1'], { ...reviewedCardData(), suspended: true });
      const update = txnUpdates[0];
      expect(update.suspended).toEqual(expect.anything()); // FieldValue.delete marker
      const card = result.cards[0] as Record<string, unknown>;
      expect(card.suspended).toBe(false); // logical boolean, not absent — matches docToFlashcard absent-field semantics
    });
  });

  describe('deleteFlashcard', () => {
    it('deletes flashcard and returns true', async () => {
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.delete = jest.fn().mockResolvedValue(undefined);
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await deleteFlashcard('card-123', 'Test Key');

      expect(result).toBe(true);
      expect(mockFlashcardDocRef.delete).toHaveBeenCalled();
    });

    it('returns false when flashcard not found', async () => {
      mockFlashcardDocRef.exists = false;
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await deleteFlashcard('nonexistent', 'Test Key');
      expect(result).toBe(false);
    });
  });

  describe('listFlashcards', () => {
    it('returns paginated results', async () => {
      const mockDocs = [
        { id: '1', data: () => ({ ownerId: 'Test Key', front: 'F1', back: 'B1', tags: [], createdAt: {}, updatedAt: {}, due: {}, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] }) },
        { id: '2', data: () => ({ ownerId: 'Test Key', front: 'F2', back: 'B2', tags: [], createdAt: {}, updatedAt: {}, due: {}, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] }) },
      ];

      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: mockDocs });

      const query: ListFlashcardsQuery = { pageSize: 2 };
      const result = await listFlashcards(query, 'Test Key');

      expect(result.cards).toHaveLength(2);
      expect(result.nextPageToken).toBeNull();
    });

    it('filters by deckId when provided', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [] });

      await listFlashcards({ deckId: 'deck-1' }, 'Test Key');

      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('deckId', '==', 'deck-1');
    });
  });

  describe('dueFlashcards', () => {
    it('queries due<=now ordered by due asc and returns cards', async () => {
      const mockDocs = [
        { id: '1', data: () => ({ ownerId: 'Test Key', front: 'F1', back: 'B1', tags: [], createdAt: {}, updatedAt: {}, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] }) },
      ];

      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: mockDocs });

      const query: DueFlashcardsQuery = { pageSize: 2 };
      const result = await dueFlashcards(query, 'Test Key');

      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('due', '<=', expect.anything());
      expect(mockFlashcardCollectionRef.orderBy).toHaveBeenCalledWith('due', 'asc');
      expect(result.cards).toHaveLength(1);
      expect(result.nextPageToken).toBeNull();
    });

    it('returns the requested page when more results exist', async () => {
      const mockDocs = [1, 2, 3].map((n) => ({
        id: String(n),
        data: () => ({ ownerId: 'Test Key', front: `F${n}`, back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] }),
      }));

      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: mockDocs });

      const result = await dueFlashcards({ pageSize: 2 }, 'Test Key');

      expect(result.cards).toHaveLength(2);
    });

    it('excludes suspended cards while retaining active due cards', async () => {
      const mockDocs = [
        { id: 'suspended', data: () => ({ ownerId: 'Test Key', front: 'Suspended', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], suspended: true }) },
        { id: 'active', data: () => ({ ownerId: 'Test Key', front: 'Active', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] }) },
      ];
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: mockDocs });

      const result = await dueFlashcards({ pageSize: 20 }, 'Test Key');

      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].id).toBe('active');
      expect(result.cards[0].suspended).toBe(false);
    });

    it('filters due cards by deckId', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [] });

      await dueFlashcards({ deckId: 'deck-1', pageSize: 20 }, 'owner-1');

      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('ownerId', '==', 'owner-1');
      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('deckId', '==', 'deck-1');
    });
  });

  describe('reviewFlashcard', () => {
    function reviewedCardData(): Record<string, unknown> {
      return {
        ownerId: 'Test Key',
        front: 'Front',
        back: 'Back',
        deck: 'Deck',
        tags: ['tag1'],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-28T00:00:00Z')),
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
      };
    }

    it('applies the review inside a transaction, persists scheduling + reviewLog, returns card + log item', async () => {
      // The transaction's get reads the pre-review card; the update is applied
      // to the same mock doc so the returned card reflects the new state.
      const base = reviewedCardData();
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(base);
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);

      const transaction = withEventTx({
        get: jest.fn().mockResolvedValue(mockFlashcardDocRef),
        update: jest.fn((_ref: unknown, patch: Record<string, unknown>) => {
          Object.assign(base, patch);
          mockFlashcardDocRef.data.mockReturnValue(base);
          return Promise.resolve();
        }),
      });
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const input: ReviewFlashcardInput = { rating: 3, reviewAt: '2026-08-28T00:00:00.000Z' };
      const result = await reviewFlashcard('card-123', input, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.reviewLogItem.rating).toBe(3);
      expect(result!.card.reviewLog).toHaveLength(1);
      // FSRS: the first Good schedules the next review 10 minutes out (Learning step).
      expect(result!.card.due.toDate().toISOString()).toBe('2026-08-28T00:10:00.000Z');
      expect(result!.card.state).toBe(1);
      expect(result!.card.reps).toBe(1);

      const updateCall = transaction.update.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({ state: 1, reps: 1, reviewLog: expect.any(Array) });
      expect((updateCall.reviewLog as unknown[]).length).toBe(1);
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns null when flashcard not found', async () => {
      mockFlashcardDocRef.exists = false;
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx({
        get: jest.fn().mockResolvedValue(mockFlashcardDocRef),
        update: jest.fn(),
      })));

      const result = await reviewFlashcard('nonexistent', { rating: 3 }, 'Test Key');
      expect(result).toBeNull();
    });

    it('REVIEW_TEST_MODE does NOT mutate the card and does NOT write a review event (direct review)', async () => {
      const prev = process.env.REVIEW_TEST_MODE;
      process.env.REVIEW_TEST_MODE = 'true';
      try {
        const base = reviewedCardData();
        mockFlashcardDocRef.exists = true;
        mockFlashcardDocRef.data.mockReturnValue(base);
        mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);

        const transaction = withEventTx({
          get: jest.fn().mockResolvedValue(mockFlashcardDocRef),
          update: jest.fn(),
          set: jest.fn(),
        });
        mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

        const result = await reviewFlashcard('card-123', { rating: 3, reviewAt: '2026-08-28T00:00:00.000Z' }, 'Test Key');

        // The FSRS outcome is returned (what WOULD happen)…
        expect(result).not.toBeNull();
        expect(result!.reviewLogItem.rating).toBe(3);
        expect(result!.card.reviewLog).toHaveLength(1);
        // …but NOTHING is persisted: no card update, no event write.
        expect(transaction.update).not.toHaveBeenCalled();
        expect(transaction.set).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
      }
    });

    it('direct review writes ONE event in the same transaction (fresh auto ref) with actorId', async () => {
      const base = reviewedCardData();
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(base);
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);

      const transaction = withEventTx({
        get: jest.fn().mockResolvedValue(mockFlashcardDocRef),
        update: jest.fn((_ref: unknown, patch: Record<string, unknown>) => {
          Object.assign(base, patch);
          mockFlashcardDocRef.data.mockReturnValue(base);
          return Promise.resolve();
        }),
      });
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

      await reviewFlashcard('card-123', { rating: 3, reviewAt: '2026-08-28T00:00:00.000Z' }, 'Test Key');

      // The card update AND the single event set happen inside the same
      // transaction: exactly one update + one set.
      expect(transaction.update).toHaveBeenCalledTimes(1);
      expect(transaction.set).toHaveBeenCalledTimes(1);
      const body = transaction.set.mock.calls[0][1] as Record<string, unknown>;
      expect(body).toMatchObject({
        actorId: 'Test Key',
        rating: 3,
        cardId: 'card-123',
        stateBefore: 0,
        cardFrontSnapshot: 'Front',
      });
      expect((body.recordedAt as { toMillis(): number }).toMillis()).toBe(Date.parse('2026-08-28T00:00:00.000Z'));
    });

    it('a transaction retry reuses the SAME direct event ref (one event per committed review)', async () => {
      const base = reviewedCardData();
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(base);
      mockFlashcardCollectionRef.doc.mockReturnValue(mockFlashcardDocRef);

      const seenRefs: unknown[] = [];
      const transaction = withEventTx({
        get: jest.fn().mockResolvedValue(mockFlashcardDocRef),
        update: jest.fn((_ref: unknown, patch: Record<string, unknown>) => {
          Object.assign(base, patch);
          mockFlashcardDocRef.data.mockReturnValue(base);
          return Promise.resolve();
        }),
      });
      transaction.set.mockImplementation((ref: unknown) => { seenRefs.push(ref); });
      // Simulate a Firestore retry: the callback runs twice (first attempt
      // aborts, second commits) — the event ref must be IDENTICAL both times.
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        await fn(transaction);
        await fn(transaction);
      });

      await reviewFlashcard('card-123', { rating: 3 }, 'Test Key');

      expect(seenRefs).toHaveLength(2);
      expect(seenRefs[0]).toBe(seenRefs[1]); // same ref across retries
      expect(transaction.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('verifyApiKey', () => {
    it('returns key name when valid', async () => {
      const mockKeyDoc: { exists: boolean; data: () => unknown; ref: { update: jest.Mock }; get?: jest.Mock } = {
        exists: true,
        data: () => ({ name: 'Test Key', revoked: false }),
        ref: { update: jest.fn() },
      };
      mockApiKeyCollectionRef.doc.mockReturnValue(mockKeyDoc);
      mockKeyDoc.get = jest.fn().mockResolvedValue(mockKeyDoc);

      const result = await verifyApiKey('valid-key');

      expect(result).toBe('Test Key');
    });

    it('returns null when key not found', async () => {
      const mockKeyDoc: { exists: boolean; get?: jest.Mock } = { exists: false };
      mockApiKeyCollectionRef.doc.mockReturnValue(mockKeyDoc);
      mockKeyDoc.get = jest.fn().mockResolvedValue(mockKeyDoc);

      const result = await verifyApiKey('invalid-key');
      expect(result).toBeNull();
    });

    it('returns null when key revoked', async () => {
      const mockKeyDoc: { exists: boolean; data?: () => unknown; get?: jest.Mock } = {
        exists: true,
        data: () => ({ name: 'Revoked Key', revoked: true }),
      };
      mockApiKeyCollectionRef.doc.mockReturnValue(mockKeyDoc);
      mockKeyDoc.get = jest.fn().mockResolvedValue(mockKeyDoc);

      const result = await verifyApiKey('revoked-key');
      expect(result).toBeNull();
    });
    it('rejects malformed credential values before looking up a document', async () => {
      for (const key of ['nested/path', '', '.', '..', '__reserved__', 'é'.repeat(751)]) {
        await expect(verifyApiKey(key)).resolves.toBeNull();
      }
      await expect(verifyApiKey(['valid-key'] as unknown as string)).resolves.toBeNull();
      expect(mockApiKeyCollectionRef.doc).not.toHaveBeenCalled();
    });

    it('preserves Firestore verification errors for the HTTP boundary to classify as unavailable', async () => {
      const resourcePath = 'apiKeys/secret-value';
      mockApiKeyCollectionRef.doc.mockImplementationOnce(() => { throw new Error(`Firestore unavailable: ${resourcePath}`); });
      await expect(verifyApiKey('valid-key')).rejects.toThrow(`Firestore unavailable: ${resourcePath}`);
    });
  });
});

describe('Bulk Flashcard Service', () => {
  let mockDb: any;
  let mockFlashcardCollectionRef: any;
  let mockDeckCollectionRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockDeckCollectionRef = mockDb.collection('decks');
    mockDeckCollectionRef.doc.mockImplementation(() => mockDeckDoc);
  });

  describe('bulkCreateFlashcards', () => {
    function configureBulkDeckTransaction(deckId: string, name: string, cardIds: string[]) {
      const deckSnap = { id: deckId, exists: true, data: () => ({ name, ownerId: 'Test Key' }) };
      const deckRef = { id: deckId, get: jest.fn().mockResolvedValue(deckSnap) };
      const cardRefs = cardIds.map((id) => ({ id }));
      const transaction = { get: jest.fn().mockResolvedValue(deckSnap), create: jest.fn() };
      mockDeckCollectionRef.doc.mockReturnValue(deckRef);
      mockFlashcardCollectionRef.doc.mockImplementation(() => cardRefs.shift());
      mockDb.runTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction));
      return transaction;
    }
    it('creates all cards atomically with the current deck state', async () => {
      const ids = ['id-1', 'id-2'];
      const transaction = configureBulkDeckTransaction('math-deck', 'Math current', ids);
      const result = await bulkCreateFlashcards({
        cards: [
          { front: 'F1', back: 'B1', deckId: 'math-deck', tags: ['a'] },
          { front: 'F2', back: 'B2', deckId: 'math-deck' },
        ],
      }, 'Test Key');

      expect(result.cards).toHaveLength(2);
      expect(result.cards.map((card) => card.id)).toEqual(ids);
      expect(result.cards[0]).toMatchObject({ front: 'F1', deck: 'Math current', deckId: 'math-deck', tags: ['a'] });
      expect(result.cards[1]).toMatchObject({ tags: [], deck: 'Math current', deckId: 'math-deck' });
      expect(transaction.create).toHaveBeenCalledTimes(2);
      expect(result.cards[0].due).toBeDefined();
      expect(result.cards[0].state).toBe(0);
      expect(result.cards[0].reps).toBe(0);
    });

    it('rejects the whole operation when a referenced deckId does not exist', async () => {
      mockDeckCollectionRef.doc.mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: false }) });

      await expect(bulkCreateFlashcards({ cards: [{ front: 'F', back: 'B', deckId: 'missing' }] }, 'Test Key'))
        .rejects.toBeInstanceOf(DeckNotFoundError);
      expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    it('persists the deck name read inside the transaction', async () => {
      const transaction = configureBulkDeckTransaction('deck-math', 'Math current', ['b1']);
      const result = await bulkCreateFlashcards({
        cards: [{ front: 'F', back: 'B', deckId: 'deck-math' }],
      }, 'Test Key');

      expect(result.cards[0]).toMatchObject({ deckId: 'deck-math', deck: 'Math current' });
      expect(transaction.create).toHaveBeenCalledWith({ id: 'b1' }, expect.objectContaining({
        deckId: 'deck-math', deck: 'Math current',
      }));
    });
  });

  describe('bulkUpdateFlashcards', () => {
    function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
      ownerId: 'Test Key',
        front: 'Front',
        back: 'Back',
        deck: 'Deck',
        tags: ['tag1'],
        createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
        ...overrides,
      };
    }

    it('updates each card inside one transaction and returns updated cards in input order', async () => {
      const baseA = cardData();
      const baseB = cardData({ front: 'B-Front' });

      const mockSnapA = { exists: true, data: () => baseA, id: 'card-a' };
      const mockSnapB = { exists: true, data: () => baseB, id: 'card-b' };
      const mockSnapMissing = { exists: false, data: () => undefined, id: 'card-x' };

      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({ id }));

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSnapA)
          .mockResolvedValueOnce(mockSnapB)
          .mockResolvedValueOnce(mockSnapMissing),
        update: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const input = {
        cards: [
          { id: 'card-a', front: 'New A' },
          { id: 'card-b', back: 'New B' },
          { id: 'card-x', front: 'Ghost' },
        ],
      };

      const result = await bulkUpdateFlashcards(input, 'Test Key');

      expect(result.cards).toHaveLength(2);
      expect(result.cards[0].id).toBe('card-a');
      expect(result.cards[0].front).toBe('New A');
      expect(result.cards[1].id).toBe('card-b');
      expect(result.cards[1].back).toBe('New B');
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
      expect(transaction.update).toHaveBeenCalledTimes(2);
      const updateCall = transaction.update.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({ front: 'New A', updatedAt: expect.any(Object) });
      expect(Math.max(...transaction.get.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...transaction.update.mock.invocationCallOrder),
      );
    });

    it('rejects deckId null in bulk update (every card must belong to a deck)', async () => {
      await expect(
        bulkUpdateFlashcards({ cards: [{ id: 'card-a', deckId: null as unknown as string }] }, 'Test Key'),
      ).rejects.toThrow('Cannot detach a card from its deck');
    });
  });

  describe('bulkDeleteFlashcards', () => {
    it('deletes existing ids in one transaction and returns only deleted ids', async () => {
      const mockSnapA = { exists: true, id: 'card-a', data: () => ({ ownerId: 'Test Key' }) };
      const mockSnapMissing = { exists: false, id: 'card-x' };
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({ id }));

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSnapA)
          .mockResolvedValueOnce(mockSnapMissing),
        delete: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await bulkDeleteFlashcards({ ids: ['card-a', 'card-x'] }, 'Test Key');

      expect(result.deletedIds).toEqual(['card-a']);
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
      expect(transaction.delete).toHaveBeenCalledTimes(1);
      expect(transaction.delete).toHaveBeenCalledWith({ id: 'card-a' });
    });

    it('performs ALL transaction reads before ANY delete (Firestore no-read-after-write invariant)', async () => {
      // Two existing ids: the transaction must read BOTH before the first
      // delete — the old implementation deleted mid-loop and then read, which
      // live Firestore rejects.
      const snapA = { exists: true, id: 'card-a', data: () => ({ ownerId: 'Test Key' }) };
      const snapB = { exists: true, id: 'card-b', data: () => ({ ownerId: 'Test Key' }) };
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({ id }));

      const ops: string[] = [];
      const transaction = {
        get: jest.fn()
          .mockImplementation(async (ref: { id?: string }) => { ops.push(`read:${(ref as { id?: string }).id ?? '?'}`); return (ref as { id?: string }).id === 'card-a' ? snapA : snapB; }),
        delete: jest.fn().mockImplementation((ref: { id?: string }) => { ops.push(`delete:${(ref as { id?: string }).id ?? '?'}`); return undefined; }),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await bulkDeleteFlashcards({ ids: ['card-a', 'card-b'] }, 'Test Key');

      expect(result.deletedIds).toEqual(['card-a', 'card-b']);
      expect(ops).toEqual(['read:card-a', 'read:card-b', 'delete:card-a', 'delete:card-b']);
    });
  });
});


describe('Tag Management Service', () => {
  let mockDb: any;
  let mockFlashcardCollectionRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    // Ensure the fluent query chain (where→orderBy→limit→startAfter) returns
    // the collection itself so tests only need to mock get(). clearAllMocks()
    // preserves implementations, but re-set explicitly for safety.
    mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.startAfter.mockReturnValue(mockFlashcardCollectionRef);
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T00:00:00.000Z')));
  });

  function tagCard(id: string, tags: string[] | undefined, overrides: Record<string, unknown> = {}) {
    const ref = { id, update: jest.fn(), path: `flashcards/${id}` };
    return { id, ref, data: () => ({ ownerId: 'Test Key', tags, ...overrides }) };
  }
  type TagQueryDoc = { id: string; ref: object };
  function prepareTagAction(cards: TagQueryDoc[], currentCards: TagQueryDoc[] = cards) {
    mockFlashcardCollectionRef.get.mockResolvedValue({ docs: cards, empty: cards.length === 0 });
    const transaction = {
      getAll: jest.fn(async (...refsAndOptions: unknown[]) => currentCards.filter((card) => refsAndOptions.includes(card.ref))),
      update: jest.fn(),
    };
    mockDb.runTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction));
    return transaction;
  }

  describe('listTags', () => {
    it('lists distinct case-sensitive tags with card counts, sorted by name', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      // Override root.get so the fluent chain resolves to tag docs.
      mockFlashcardCollectionRef.get.mockReset();
      mockFlashcardCollectionRef.get.mockResolvedValue({
        docs: [
          tagCard('c1', ['b', 'a']),
          tagCard('c2', ['c']), // a distinct tag counted once per card
          tagCard('c3', ['a', 'a']), // duplicates within one card count once
          tagCard('c4', undefined),       // legacy doc without a tags field
        ],
      });

      const result = await listTags({}, 'Test Key');

      expect(mockFlashcardCollectionRef.select).toHaveBeenCalledWith('tags');
      expect(mockFlashcardCollectionRef.orderBy).toHaveBeenCalledWith('__name__');
      expect(result.tags).toEqual([
        { name: 'a', cardCount: 2 },
        { name: 'b', cardCount: 1 },
        { name: 'c', cardCount: 1 },
      ]);
      expect(result.nextPageToken).toBeNull();
    });

    it('paginates by tag name with listDecks-style pageSize', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockReset();
      mockFlashcardCollectionRef.get.mockResolvedValue({
        docs: [
          tagCard('c1', ['a', 'b']),
          tagCard('c2', ['c', 'd']),
        ],
      });

      const page1 = await listTags({ pageSize: 2 }, 'Test Key');
      expect(page1.tags.map((t) => t.name)).toEqual(['a', 'b']);

      const page2 = await listTags({ pageSize: 2, pageToken: page1.nextPageToken! }, 'Test Key');
      expect(page2.tags.map((t) => t.name)).toEqual(['c', 'd']);
      expect(page2.nextPageToken).toBeNull();
    });

    it('returns an empty page for a pageToken past the last tag', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [tagCard('c1', ['a'])] });

      const result = await listTags({ pageSize: 20, pageToken: 'zzz' }, 'Test Key');
      expect(result.tags).toEqual([]);
      expect(result.nextPageToken).toBeNull();
    });

    it('returns no tags when the library has none', async () => {
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [] });

      const result = await listTags({}, 'Test Key');
      expect(result.tags).toEqual([]);
      expect(result.nextPageToken).toBeNull();
    });

    it('keeps scanning full 500-doc pages until the collection is exhausted', async () => {
      const page1 = Array.from({ length: 500 }, (_, i) => tagCard(`c${i}`, ['bulk']));
      mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.startAfter.mockReturnValue(mockFlashcardCollectionRef);
      mockFlashcardCollectionRef.get
        .mockResolvedValueOnce({ docs: page1 })
        .mockResolvedValueOnce({ docs: [tagCard('tail', ['tail-tag'])] });

      const result = await listTags({}, 'Test Key');

      expect(mockFlashcardCollectionRef.startAfter).toHaveBeenCalled();
      expect(result.tags).toEqual([
        { name: 'bulk', cardCount: 500 },
        { name: 'tail-tag', cardCount: 1 },
      ]);
    });
  });

  describe('renameTag', () => {
    it('replaces exact names, dedupes tags, and counts actual changed cards', async () => {
      const cardA = tagCard('card-a', ['spanish', 'verbs']);
      const cardB = tagCard('card-b', ['spanish', 'spanish']);
      const transaction = prepareTagAction([cardA, cardB]);

      const result = await renameTag({ from: 'spanish', to: 'espanol' }, 'Test Key');

      expect(mockFlashcardCollectionRef.where).toHaveBeenNthCalledWith(1, 'ownerId', '==', 'Test Key');
      expect(mockFlashcardCollectionRef.where).toHaveBeenNthCalledWith(2, 'tags', 'array-contains', 'spanish');
      expect(result).toEqual({ affectedCards: 2 });
      expect(transaction.update).toHaveBeenCalledWith(cardA.ref, expect.objectContaining({
        tags: ['espanol', 'verbs'], updatedAt: expect.anything(),
      }));
      expect(transaction.update).toHaveBeenCalledWith(cardB.ref, expect.objectContaining({ tags: ['espanol'] }));
    });

    it('counts source removal when the destination tag already exists', async () => {
      const card = tagCard('card-a', ['from', 'to', 'keep']);
      const transaction = prepareTagAction([card]);

      expect(await renameTag({ from: 'from', to: 'to' }, 'Test Key')).toEqual({ affectedCards: 1 });
      expect(transaction.update).toHaveBeenCalledWith(card.ref, expect.objectContaining({ tags: ['to', 'keep'] }));
    });

    it('does not count a card moved to another owner before the transaction read', async () => {
      const queryCard = tagCard('card-a', ['source']);
      const movedCard = tagCard('card-a', ['source'], { ownerId: 'Other Owner' });
      const transaction = prepareTagAction([queryCard], [movedCard]);

      expect(await renameTag({ from: 'source', to: 'target' }, 'Test Key')).toEqual({ affectedCards: 0 });
      expect(transaction.update).not.toHaveBeenCalled();
    });
    it('skips deleted cards and cards no longer carrying the source tag', async () => {
      const deletedQueryCard = tagCard('deleted-card', ['source']);
      const changedQueryCard = tagCard('changed-card', ['source']);
      const deletedCard = { id: deletedQueryCard.id, ref: deletedQueryCard.ref, data: () => undefined };
      const changedCard = tagCard('changed-card', ['other']);
      const transaction = prepareTagAction([deletedQueryCard, changedQueryCard], [deletedCard, changedCard]);

      expect(await renameTag({ from: 'source', to: 'target' }, 'Test Key')).toEqual({ affectedCards: 0 });
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('returns zero without starting a transaction when no card matches', async () => {
      prepareTagAction([]);

      expect(await renameTag({ from: 'missing', to: 'target' }, 'Test Key')).toEqual({ affectedCards: 0 });
      expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });
  });

  describe('deleteTag', () => {
    it('removes an exact literal tag and dedupes the remaining array', async () => {
      const cardA = tagCard('card-a', [' literal,tag ', 'keep', 'keep']);
      const cardB = tagCard('card-b', ['literal', 'tag', 'keep']);
      const transaction = prepareTagAction([cardA]);

      expect(await deleteTag({ name: ' literal,tag ' }, 'Test Key')).toEqual({ affectedCards: 1 });
      expect(transaction.update).toHaveBeenCalledWith(cardA.ref, expect.objectContaining({ tags: ['keep'] }));
      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('tags', 'array-contains', ' literal,tag ');
      expect(cardB.data().tags).toEqual(['literal', 'tag', 'keep']);
    });
  });

  describe('mergeTags', () => {
    it('removes the source and keeps one destination in stable order', async () => {
      const card = tagCard('card-a', ['source, tag ', 'target', 'target', 'keep']);
      const transaction = prepareTagAction([card]);

      expect(await mergeTags({ from: 'source, tag ', to: 'target' }, 'Test Key')).toEqual({ affectedCards: 1 });
      expect(transaction.update).toHaveBeenCalledWith(card.ref, expect.objectContaining({ tags: ['target', 'keep'] }));
      expect(mockFlashcardCollectionRef.where).toHaveBeenCalledWith('tags', 'array-contains', 'source, tag ');
    });
  });
});

describe('Image URL validation', () => {
  describe('validateImageUrl', () => {
    it('accepts https URLs with a known image extension', () => {
      expect(() => validateImageUrl('https://example.com/pic.jpg')).not.toThrow();
      expect(() => validateImageUrl('http://example.com/a.png?x=1')).not.toThrow();
    });

    it('accepts a declared allowed MIME type even without an extension', () => {
      expect(() => validateImageUrl('https://example.com/pic', 'image/png')).not.toThrow();
    });

    it('rejects non-http(s) schemes', () => {
      expect(() => validateImageUrl('ftp://example.com/pic.jpg')).toThrow(ImageValidationError);
      expect(() => validateImageUrl('file:///tmp/pic.jpg')).toThrow(ImageValidationError);
    });

    it('rejects unsupported extensions and MIME types', () => {
      expect(() => validateImageUrl('https://example.com/pic.exe')).toThrow(ImageValidationError);
      expect(() => validateImageUrl('https://example.com/pic', 'text/html')).toThrow(ImageValidationError);
    });

    it('rejects malformed and oversized URLs', () => {
      expect(() => validateImageUrl('not a url')).toThrow(ImageValidationError);
      expect(() => validateImageUrl(`https://example.com/${'a'.repeat(3000)}.jpg`)).toThrow(ImageValidationError);
      expect(() => validateImageUrl('')).toThrow(ImageValidationError);
    });
  });

});

describe('Image Upload Service input validation', () => {
  const VALID_B64 = Buffer.from('fake-image-bytes').toString('base64');

  it('rejects upload filenames over the allowed length', async () => {
    await expect(uploadImage('card-1', {
      data: VALID_B64,
      fileName: `${'a'.repeat(256)}.jpg`,
      contentType: 'image/jpeg',
    }, 'Test Key')).rejects.toThrow(ImageValidationError);
  });

  it('rejects unsupported MIME types (SVG excluded from uploads)', async () => {
    await expect(uploadImage('card-1', {
      data: VALID_B64,
      fileName: 'pic.svg',
      contentType: 'image/svg+xml',
    }, 'Test Key')).rejects.toThrow(ImageValidationError);
  });

  it('rejects malformed base64', async () => {
    await expect(uploadImage('card-1', {
      data: 'not!base64!!',
      fileName: 'pic.jpg',
      contentType: 'image/jpeg',
    }, 'Test Key')).rejects.toThrow(ImageValidationError);
  });

  it('rejects oversized payloads over 10 MiB', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    await expect(uploadImage('card-1', {
      data: big,
      fileName: 'big.jpg',
      contentType: 'image/jpeg',
    }, 'Test Key')).rejects.toThrow(ImageValidationError);
  });
});

describe('Review Session Service', () => {
  let mockDb: any;
  let mockSessionCollectionRef: any;
  let mockSessionDocRef: any;
  let mockFlashcardCollectionRef: any;
  let mockFlashcardDocRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockDb.collection('decks').doc.mockImplementation((id = 'deck-1') => mockOwnedDeckRef(id, 'Spanish'));
    mockSessionCollectionRef = mockDb.collection('reviewSessions');
    // The session's queued-card records support reads and writes.
    const chunkDocs: Record<string, any> = {};
    const chunkCollection: any = {
      doc: jest.fn((id: string) => {
        if (!chunkDocs[id]) {
          chunkDocs[id] = {
            id, exists: false, data: jest.fn(() => undefined),
            set: jest.fn(async (data: Record<string, unknown>) => { chunkDocs[id].data.mockReturnValue(data); chunkDocs[id].exists = true; }),
            update: jest.fn(async (patch: Record<string, unknown>) => { const cur: Record<string, unknown> = chunkDocs[id].data() ?? {}; chunkDocs[id].data.mockReturnValue({ ...cur, ...patch }); chunkDocs[id].exists = true; }),
            get: jest.fn(async () => chunkDocs[id]),
          };
        }
        return chunkDocs[id];
      }),
      orderBy: jest.fn(() => chunkCollection),
      limit: jest.fn(() => chunkCollection),
      startAt: jest.fn(() => chunkCollection),
      startAfter: jest.fn(() => chunkCollection),
      get: jest.fn(async () => ({ docs: Object.keys(chunkDocs).sort().map((k) => chunkDocs[k]) })),
    };
    mockSessionDocRef = {
      id: 'session-1', exists: true, data: jest.fn(() => undefined),
      set: jest.fn(async (data: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue(data); mockSessionDocRef.exists = true; }),
      update: jest.fn(async (patch: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue({ ...(mockSessionDocRef.data() ?? {}), ...patch }); mockSessionDocRef.exists = true; }),
      get: jest.fn(async () => mockSessionDocRef), collection: jest.fn(),
    };
    mockSessionCollectionRef.doc.mockImplementation((id?: string) => {
      if (id !== undefined) mockSessionDocRef.id = id;
      return mockSessionDocRef;
    });
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        return await ref.get();
      }),
      update: jest.fn(async (ref: any, patch: Record<string, unknown>) => ref.update(patch)),
      set: jest.fn(async (ref: any, data: Record<string, unknown>) => ref.set(data)),
      delete: jest.fn(async (ref: any) => ref.delete()),
    }));
    mockSessionDocRef.collection.mockImplementation(() => chunkCollection);
    // Collect writes until the mock batch is committed.
    const batchSets: Array<{ ref: any; data: unknown }> = [];
    mockDb.batch = jest.fn(() => ({
      set: jest.fn((ref: any, data: unknown) => { batchSets.push({ ref, data }); }),
      update: jest.fn(),
      commit: jest.fn(async () => {
        for (const b of batchSets) { if (b.ref.set) await b.ref.set(b.data); }
      }),
    }));
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockFlashcardDocRef = { id: 'card-1', data: jest.fn(), exists: true, set: jest.fn(), get: jest.fn(), update: jest.fn(), ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() } };
    mockFlashcardCollectionRef.doc.mockImplementation(() => mockFlashcardDocRef);
    mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
  });

  function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ownerId: 'Test Key',
      front: 'F',
      back: 'B',
      tags: [],
      createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
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

  function sessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const ownerId = Object.prototype.hasOwnProperty.call(overrides, 'ownerId') ? overrides.ownerId : 'Test Key';
    return {
      ownerId,
      status: 'active',
      mode: 'spaced_repetition',
      limit: 1,
      dueCount: 1,
      cardIds: ['card-1'],
      currentIndex: 0,
      reviewedCount: 0,
      truncated: false,
      continuationAvailable: false,
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
      startedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
      ...overrides,
    };
  }

  describe('startReviewSession', () => {
    it('returns a session with its first due card', async () => {
      const dueDocs = [
        { id: 'card-1', data: () => cardData({ front: 'First' }) },
        { id: 'card-2', data: () => cardData({ front: 'Second' }) },
      ];
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
      // Exact due-count via Firestore count() aggregation.
      mockFlashcardCollectionRef.count = jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 2 }) }),
      }));
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'First' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await startReviewSession({}, 'Test Key');

      expect(result.session.id).toBe('session-1');
      expect(result.session.status).toBe('active');
      expect(result.session.mode).toBe('spaced_repetition');
      expect(result.session.limit).toBe(2);
      expect(result.session.dueCount).toBe(2);
      expect(result.session.storageVersion).toBe(2);
      expect(result.session.position).toBe(2);
      expect(result.session.remainingQueueCount).toBe(2);
      expect(result.queueWindow).toEqual({ currentPosition: 0, currentCardId: 'card-1', cardIds: [{ cardId: 'card-1', position: 0 }, { cardId: 'card-2', position: 1 }] });
      expect(result.session.currentIndex).toBe(0);
      expect(result.session.reviewedCount).toBe(0);
      expect(result.session.remainingCount).toBe(2);
      expect(result.session.ratingCounts).toEqual({ again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } });
      expect(result.session.truncated).toBe(false);
      expect(result.session.continuationAvailable).toBe(false);
      expect(result.card).not.toBeNull();
      expect(result.card!.id).toBe('card-1');
    });


    it('REVIEW_TEST_MODE queues ALL cards (no due filter) without mutating anything', async () => {
      const prev = process.env.REVIEW_TEST_MODE;
      process.env.REVIEW_TEST_MODE = 'true';
      try {
        const dueDocs = [
          { id: 'card-due', data: () => cardData({ front: 'Due' }) },
          { id: 'card-future', data: () => cardData({ front: 'Future', due: mockTimestamp(new Date('2030-01-01T00:00:00.000Z')) }) },
        ];
        mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
        mockFlashcardCollectionRef.count = jest.fn(() => ({
          get: jest.fn().mockResolvedValue({ data: () => ({ count: 2 }) }),
        }));
        const cardRefs = new Set<object>();
        mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
          const source = dueDocs.find((doc) => doc.id === id);
          const snap = source
            ? { id, exists: true, data: source.data }
            : { id, exists: false, data: () => undefined };
          const ref = { id, get: jest.fn().mockResolvedValue(snap), update: jest.fn() };
          cardRefs.add(ref);
          return ref;
        });
        const transactionUpdates = jest.fn(async (ref: any, patch: Record<string, unknown>) => ref.update(patch));
        mockDb.runTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
          get: async (ref: any) => await ref.get(),
          update: transactionUpdates,
          set: async (ref: any, data: Record<string, unknown>) => ref.set(data),
          create: jest.fn(),
          delete: async (ref: any) => ref.delete(),
        }));
        mockSessionDocRef.id = 'session-test';
        mockSessionDocRef.data.mockReturnValue(undefined);

        const result = await startReviewSession({}, 'Test Key');

        // A future-due card is included in test mode because the full
        // library is returned, not just the due subset.
        expect(result.session.dueCount).toBe(2);
        expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-due', position: 0 }, { cardId: 'card-future', position: 1 }]);
        expect(result.session.storageVersion).toBe(2);
        // Test mode is visible on the returned session.
        expect(result.session.testMode).toBe(true);
        // No card documents were updated.
        expect(transactionUpdates.mock.calls.some(([ref]) => cardRefs.has(ref))).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
      }
    });

    it('includes more than 100 matching due cards', async () => {
      const dueDocs = Array.from({ length: 150 }, (_, i) => ({ id: 'card-' + (i + 1), data: () => cardData({ front: 'c' + (i + 1) }) }));
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
      mockFlashcardCollectionRef.count = jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 150 }) }),
      }));
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'card-1' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await startReviewSession({}, 'Test Key');

      expect(result.session.limit).toBe(150);
      expect(result.session.dueCount).toBe(150);
      expect(result.session.position).toBe(150);
      expect(result.session.remainingQueueCount).toBe(150);
      expect(result.queueWindow!.currentPosition).toBe(0);
      expect(result.queueWindow!.cardIds[0].cardId).toBe('card-1');
      expect(result.session.truncated).toBe(false);
      expect(result.session.continuationAvailable).toBe(false);
      expect(result.session.remainingCount).toBe(150);
      expect(result.card!.id).toBe('card-1');
    });

    it('preloads the remaining session cards in queue order', async () => {
      // The returned queue window and preload cover every upcoming card.
      const dueDocs = Array.from({ length: 12 }, (_, i) => ({ id: 'card-' + (i + 1), data: () => cardData({ front: 'Q' + (i + 1) }) }));
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
      mockFlashcardCollectionRef.count = jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 12 }) }),
      }));
      // Per-id card docs so every preloaded read resolves its own content.
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
        const n = Number(id.replace('card-', ''));
        const ref = { id, exists: true, data: () => cardData({ front: 'Q' + n }), get: jest.fn() };
        ref.get.mockResolvedValue(ref);
        return ref;
      });

      const result = await startReviewSession({}, 'Test Key');

      expect(result.session.limit).toBe(12);
      expect(result.session.storageVersion).toBe(2);
      // The returned queue window covers the current card and preload.
      expect(result.queueWindow!.cardIds).toHaveLength(12);
      expect(result.preloaded).toHaveLength(11);
      // Ordered and full — the widget's monotonic buffer covers the session.
      expect(result.preloaded[0]).toMatchObject({ id: 'card-2', front: 'Q2' });
      expect(result.preloaded[10]).toMatchObject({ id: 'card-12', front: 'Q12' });
      expect(result.preloaded.map((p) => p.id)).toEqual(
        Array.from({ length: 11 }, (_, i) => 'card-' + (i + 2)),
      );
    });

    it('starts an active session with an empty queue (no due cards) and card null', async () => {
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [], empty: true });
      mockFlashcardCollectionRef.count = jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
      }));
      mockSessionDocRef.id = 'session-empty';
      mockSessionDocRef.data.mockReturnValue(undefined);

      const result = await startReviewSession({}, 'Test Key');

      expect(result.session.status).toBe('active');
      expect(result.session.mode).toBe('spaced_repetition');
      expect(result.session.storageVersion).toBe(2);
      expect(result.session.limit).toBe(0);
      expect(result.session.dueCount).toBe(0);
      expect(result.session.currentIndex).toBe(0);
      expect(result.session.truncated).toBe(false);
      expect(result.session.continuationAvailable).toBe(false);
      expect(result.session.remainingCount).toBe(0);
      expect(result.queueWindow).toEqual({ currentPosition: null, currentCardId: null, cardIds: [] });
      expect(result.card).toBeNull();
    });
  });

  describe('getReviewSession', () => {
    it('returns the session with its current card', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData());
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'Current' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await getReviewSession('session-1', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('active');
      expect(result!.session.currentIndex).toBe(0);
      expect(result!.card!.front).toBe('Current');
    });

    it('returns null card when the current card was deleted', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData());
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockFlashcardDocRef.exists = false;
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await getReviewSession('session-1', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.card).toBeNull();
    });

    it('returns null card for a completed session (queue exhausted)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ status: 'completed', currentIndex: 1, endedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')) }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const result = await getReviewSession('session-1', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('completed');
      expect(result!.card).toBeNull();
    });

    it('returns null when the session does not exist', async () => {
      mockSessionDocRef.exists = false;
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const result = await getReviewSession('missing', 'Test Key');
      expect(result).toBeNull();
    });
    it('forbids rating an ownerless legacy session even when the API-key name matches', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue({ ...sessionData(), ownerId: undefined, apiKeyName: 'Test Key' });

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn(),
        set: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

      await expect(submitSessionReview('session-1', { rating: 3 }, 'Test Key'))
        .rejects.toBeInstanceOf(ReviewSessionForbiddenError);
      expect(transaction.update).not.toHaveBeenCalled();
      expect(transaction.set).not.toHaveBeenCalled();
    });
    it('forbids reading an ownerless session (quarantined legacy data)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue({ ...sessionData(), ownerId: undefined, apiKeyName: 'Test Key' });
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      await expect(getReviewSession('session-1', 'Test Key')).rejects.toBeInstanceOf(ReviewSessionForbiddenError);
    });

    it('forbids reading a session started by a different API key (403)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ ownerId: 'Key A' }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData());
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      await expect(getReviewSession('session-1', 'Key B')).rejects.toBeInstanceOf(ReviewSessionForbiddenError);
      // The owner can always read their own session.
      const own = await getReviewSession('session-1', 'Key A');
      expect(own).not.toBeNull();
    });

    it('allows access via ownerId match (multi-tenant session ownership)', async () => {
      // Session owned by 'Key A'; the caller must present the same ownerId.
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ ownerId: 'Key A' }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData());
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const result = await getReviewSession('session-1', 'Key A');
      expect(result).not.toBeNull();
    });
  });

  describe('submitSessionReview', () => {
    it('applies FSRS to the current card and advances the session atomically', async () => {
      const baseCard = cardData({ front: 'Q', due: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')) });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData());
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(baseCard);
      mockFlashcardDocRef.update = jest.fn().mockResolvedValue(undefined);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)   // session read
          .mockResolvedValueOnce(mockFlashcardDocRef), // current card read
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('completed'); // single-card queue exhausted
      expect(result!.session.currentIndex).toBe(1);
      expect(result!.session.reviewedCount).toBe(1);
      expect(result!.session.remainingCount).toBe(0);
      expect(result!.session.ratingCounts).toEqual({ again: 0, hard: 0, good: 1, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 } });
      expect(result!.session.endedAt).toBeDefined();
      expect(result!.card).toBeNull();

      const cardUpdate = transaction.update.mock.calls[0][1] as Record<string, unknown>;
      expect(cardUpdate).toMatchObject({ state: 1, reps: 1, reviewLog: expect.any(Array) });
      expect((cardUpdate.reviewLog as unknown[]).length).toBe(1);

      const sessionUpdate = transaction.update.mock.calls[1][1] as Record<string, unknown>;
      expect(sessionUpdate).toMatchObject({ currentIndex: 1, reviewedCount: 1, status: 'completed', endedAt: expect.anything() });
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
    });

    it('keeps the session active and returns the NEXT card when the queue has more', async () => {
      const session = sessionData({ cardIds: ['card-1', 'card-2'] });
      const card1 = cardData({ front: 'One' });
      const card2 = cardData({ front: 'Two' });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(card2); // post-update read for the next card
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)
          .mockResolvedValueOnce({ ...mockFlashcardDocRef, data: () => card1 }) // current card read
          .mockResolvedValueOnce(mockFlashcardDocRef), // next card read
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 4 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('active');
      expect(result!.session.currentIndex).toBe(1);
      expect(result!.session.reviewedCount).toBe(1);
      expect(result!.session.ratingCounts.good).toBe(0);
      expect(result!.session.ratingCounts.easy).toBe(1);
      expect(result!.session.lastReviewedAt).toBeDefined();
      expect(result!.session.remainingCount).toBe(1);
      expect(result!.session.endedAt).toBeUndefined();
      expect(result!.card).not.toBeNull();
      expect(result!.card!.front).toBe('Two');
    });

    it('returns the NEXT live card when the immediate next snapshot card was deleted (no stall)', async () => {
      // Snapshot: card-1 (current, live), card-2 (deleted), card-3 (live).
      // After rating card-1, the session must stay ACTIVE pointing at card-3
      // and return it — never card:null while cards remain.
      const session = sessionData({ cardIds: ['card-1', 'card-2', 'card-3'] });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      const card1Data = cardData({ front: 'One' });
      const card3Data = cardData({ front: 'Three' });
      const card3Ref = { id: 'card-3', data: () => card3Data, exists: true, get: jest.fn() };
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'card-1') return { ...mockFlashcardDocRef, data: () => card1Data };
        if (id === 'card-2') return { ...mockFlashcardDocRef, exists: false, data: () => undefined };
        return card3Ref;
      });

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef) // session
          .mockResolvedValueOnce({ ...mockFlashcardDocRef, data: () => card1Data }) // card-1 (target)
          .mockResolvedValueOnce({ ...mockFlashcardDocRef, exists: false, data: () => undefined }) // card-2 deleted
          .mockResolvedValueOnce(card3Ref), // card-3 (next live)
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('active'); // NOT completed, NOT stalled
      expect(result!.session.currentIndex).toBe(2); // points past the deleted card-2
      expect(result!.session.reviewedCount).toBe(1); // deleted card-2 never counted
      expect(result!.session.remainingCount).toBe(1);
      expect(result!.card).not.toBeNull();
      expect(result!.card!.id).toBe('card-3'); // the next LIVE card is returned
      expect(result!.card!.front).toBe('Three');
      // Only card-1 was written (the deleted card-2 was never written).
      const cardWrites = transaction.update.mock.calls.map((c: unknown[]) => (c[0] as { id?: string }).id);
      expect(cardWrites.filter((id: string | undefined) => id !== undefined && id !== 'session-1')).toEqual(['card-1']);
    });

    it('completes the session when every remaining card was deleted', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1', 'card-2'] }));
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      const missing = { exists: false, data: () => undefined };
      mockFlashcardCollectionRef.doc.mockReturnValue(missing);

      const transaction = {
        get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValue(missing),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('completed');
      expect(result!.session.reviewedCount).toBe(0);
      expect(result!.card).toBeNull();
      expect(transaction.update).toHaveBeenCalledTimes(1); // session update only, no card write
    });

    it('returns null when the session does not exist', async () => {
      mockSessionDocRef.exists = false;
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('missing', { rating: 3 }, 'Test Key');
      expect(result).toBeNull();
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('forbids rating a session started by a different API key (403, no writes)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ ownerId: 'Key A' }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      await expect(submitSessionReview('session-1', { rating: 3 }, 'Key B'))
        .rejects.toBeInstanceOf(ReviewSessionForbiddenError);
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('performs ALL transaction reads before ANY write (Firestore no-read-after-write invariant)', async () => {
      // Multi-card session: reads = session + card-1 (target) + card-2 (next).
      const session = sessionData({ cardIds: ['card-1', 'card-2'] });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'Two' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const readOrder: string[] = [];
      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef) // session read
          .mockImplementationOnce(async () => { readOrder.push('card-1'); return { ...mockFlashcardDocRef, data: () => cardData({ front: 'One' }) }; })
          .mockImplementationOnce(async () => { readOrder.push('card-2'); return mockFlashcardDocRef; }),
        update: jest.fn().mockImplementation((ref: unknown) => {
          // The card doc refs are the shared flashcard mock (id 'card-1'); the
          // session ref is the session mock (id 'session-1').
          let id = 'session';
          if (ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string') {
            id = ref.id;
          }
          readOrder.push(`write:${id}`);
          return Promise.resolve();
        }),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('active'); // rating card-1 of 2: still active, next is card-2
      expect(result!.card!.front).toBe('Two');
      // All reads (session, card-1, card-2) happened before the first write.
      const firstWrite = readOrder.findIndex((op) => op.startsWith('write:'));
      expect(firstWrite).toBeGreaterThanOrEqual(0);
      expect(readOrder.slice(0, firstWrite)).toEqual(['card-1', 'card-2']);
      // The session write is the LAST write (no read follows it).
      expect(readOrder[readOrder.length - 1]).toBe('write:session-1');
    });

    it('throws ReviewSessionNotActiveError when the session is completed or ended', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ status: 'completed', endedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')) }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      await expect(submitSessionReview('session-1', { rating: 3 }, 'Test Key'))
        .rejects.toThrow('is not active');
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('marks the session completed (no card write) when the queue is already exhausted', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1'], currentIndex: 1 }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('completed');
      expect(result!.card).toBeNull();
      const sessionUpdate = transaction.update.mock.calls[0][1] as Record<string, unknown>;
      expect(sessionUpdate).toMatchObject({ status: 'completed', endedAt: expect.anything() });
    });
  });

  describe('endReviewSession', () => {
    it('ends an active session with status ended and endedAt', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData());
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await endReviewSession('session-1', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('ended');
      expect(result!.endedAt).toBeDefined();
      const updateCall = transaction.update.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({ status: 'ended', endedAt: expect.anything() });
    });

    it('is idempotent: ending an already-terminated session is a no-op', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ status: 'ended', endedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')) }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await endReviewSession('session-1', 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('ended');
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('returns null when the session does not exist', async () => {
      mockSessionDocRef.exists = false;
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn(),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await endReviewSession('missing', 'Test Key');
      expect(result).toBeNull();
    });

    it('forbids ending a session started by a different API key (403, no writes)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ ownerId: 'Key A' }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      await expect(endReviewSession('session-1', 'Key B'))
        .rejects.toBeInstanceOf(ReviewSessionForbiddenError);
      expect(transaction.update).not.toHaveBeenCalled();
      // The owner can end their own session.
      const own = await endReviewSession('session-1', 'Key A');
      expect(own).not.toBeNull();
      expect(own!.status).toBe('ended');
    });
  });

  describe('session presentation + preload + idempotency', () => {
    it('returns cardType and name as session metadata', async () => {
      mockFlashcardCollectionRef.get.mockResolvedValue({ docs: [], empty: true });
      mockFlashcardCollectionRef.count = jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
      }));
      mockSessionDocRef.id = 'session-ct';
      mockSessionDocRef.data.mockReturnValue(undefined);

      const result = await startReviewSession({ cardType: 'cloze', name: 'Spanish Vocab' }, 'Test Key');

      expect(result.session.cardType).toBe('cloze');
      expect(result.session.name).toBe('Spanish Vocab');
    });

    it('getReviewSession returns the FULL ordered preloaded queue after the current card', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1', 'card-2', 'card-3'], currentIndex: 0 }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      // current card
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'Current' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);
      // preloaded cards via collection.doc()
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'card-2') {
          const ref = { id, exists: true, data: () => cardData({ front: 'Next2', deck: 'Spanish' }), get: jest.fn() };
          ref.get.mockResolvedValue(ref);
          return ref;
        }
        if (id === 'card-3') {
          const ref = { id, exists: true, data: () => cardData({ front: 'Next3' }), get: jest.fn() };
          ref.get.mockResolvedValue(ref);
          return ref;
        }
        return mockFlashcardDocRef;
      });

      const result = await getReviewSession('session-1', 'Test Key');
      expect(result!.preloaded).toHaveLength(2);
      expect(result!.preloaded[0]).toMatchObject({ id: 'card-2', front: 'Next2', deck: 'Spanish' });
      expect(result!.preloaded[1].id).toBe('card-3');
      // The full remaining queue is returned (2 upcoming for 3 cardIds) in
      // cardIds order — the widget's monotonic buffer.
      expect(result!.preloaded.map((p) => p.id)).toEqual(['card-2', 'card-3']);
    });

    it('submitSessionReview echoes requestId and idempotently no-ops on retry with the same key', async () => {
      const session = sessionData({ cardIds: ['card-1', 'card-2'], lastRequestId: 'req-123', currentIndex: 1 });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(cardData({ front: 'Two' }));
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValue(mockFlashcardDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3, requestId: 'req-123' }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.requestId).toBe('req-123');
      // No card write happened (idempotent no-op).
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('does NOT perform preload reads on submit (returns additive empty preload; widget holds the full buffer)', async () => {
      // Regression: the full-session preload must NOT be recomputed on every
      // submit — that was up to 99 serial Firestore reads per concurrent
      // rating. The widget already holds the complete monotonic queue from
      // start/get and merges additive updates, so submit returns an EMPTY
      // preload array and performs ZERO card reads after the transaction.
      const session = sessionData({ cardIds: ['card-1', 'card-2', 'card-3'], currentIndex: 0 });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      const card1 = cardData({ front: 'One' });
      const card2 = cardData({ front: 'Two' });
      mockFlashcardDocRef.exists = true;
      mockFlashcardDocRef.data.mockReturnValue(card2);
      mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef) // session
          .mockResolvedValueOnce({ ...mockFlashcardDocRef, data: () => card1 }) // card-1 target
          .mockResolvedValueOnce(mockFlashcardDocRef), // card-2 next
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 4 }, 'Test Key');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('active');
      expect(result!.session.currentIndex).toBe(1);
      // EMPTY preload: additive — the widget's monotonic queue is preserved.
      expect(result!.preloaded).toEqual([]);
      // The ONLY card reads are inside the transaction (session + target +
      // next). No post-commit preload loop may touch card docs.
      const docCalls = (mockFlashcardCollectionRef.doc as jest.Mock).mock.calls;
      expect(docCalls.length).toBeLessThanOrEqual(3);
    });

    it('rejects a stale expectedCardId with 409 (never rates the wrong card)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1', 'card-2'], currentIndex: 1 }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const transaction = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      await expect(submitSessionReview('session-1', { rating: 3, expectedCardId: 'card-1' }, 'Test Key'))
        .rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('applies FSRS once for an out-of-order (parallel) expectedCardId and records the claim', async () => {
      // Parallel rating model: the session's current card is card-1, but a
      // sibling request rates card-2 first (expectedCardId=card-2). The
      // rating must apply to card-2 exactly once, record the claim, and keep
      // currentIndex at card-1 (still unrated) so the queue never stalls.
      const session = sessionData({
        cardIds: ['card-1', 'card-2', 'card-3'],
        currentIndex: 0,
        reviewedCardIds: [],
      });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);

      const card1Data = cardData({ front: 'One' });
      const card2Data = cardData({ front: 'Two' });
      const card3Data = cardData({ front: 'Three' });
      const card1Ref = { id: 'card-1', exists: true, data: () => card1Data, get: jest.fn() };
      const card2Ref = { id: 'card-2', exists: true, data: () => card2Data, get: jest.fn() };
      const card3Ref = { id: 'card-3', exists: true, data: () => card3Data, get: jest.fn() };
      card1Ref.get.mockResolvedValue(card1Ref);
      card2Ref.get.mockResolvedValue(card2Ref);
      card3Ref.get.mockResolvedValue(card3Ref);
      mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'card-1') return card1Ref;
        if (id === 'card-2') return card2Ref;
        return card3Ref;
      });

      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)   // session
          .mockResolvedValueOnce(card1Ref)            // target scan: card-1 (not the claim, skip)
          .mockResolvedValueOnce(card2Ref)            // target scan: card-2 → target
          .mockResolvedValueOnce(card1Ref)            // next scan: card-1 still live + unrated → next
          .mockResolvedValueOnce(card3Ref),           // (not reached: next is card-1)
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3, requestId: 'req-parallel', expectedCardId: 'card-2' }, 'Test Key');

      expect(result).not.toBeNull();
      // FSRS applied to card-2 exactly once (single card write).
      const cardWrites = transaction.update.mock.calls
        .filter((c: unknown[]) => (c[0] as { id?: string }).id === 'card-2');
      expect(cardWrites).toHaveLength(1);
      expect(cardWrites[0][1]).toMatchObject({ state: 1, reps: 1, reviewLog: expect.any(Array) });

      // Claim recorded; currentIndex stays at the FIRST unrated live card.
      const sessionUpdate = transaction.update.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id?: string }).id === 'session-1',
      )[0][1] as Record<string, unknown>;
      expect(sessionUpdate).toMatchObject({
        currentIndex: 0, // card-1 unrated — the queue does NOT stall or skip it
        reviewedCount: 1,
        reviewedCardIds: ['card-2'],
        lastRequestId: 'req-parallel',
        lastRatedCardId: 'card-2',
        processedRequestIds: ['req-parallel'],
      });
      expect(result!.session.reviewedCardIds).toEqual(['card-2']);
      expect(result!.session.remainingCount).toBe(2); // card-1 + card-3
      expect(result!.card!.id).toBe('card-1'); // the next card the client should rate
    });

    it('rejects an expectedCardId that was already reviewed (reordered retry with a different key)', async () => {
      // Session has rated card-1 (currentIndex=1) and a retry claims card-1
      // again — stale, must be rejected rather than re-rated.
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({
        cardIds: ['card-1', 'card-2'], currentIndex: 1, reviewedCount: 1,
        lastRequestId: 'other-req', lastRatedCardId: 'card-1',
      }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const txn = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)   // session
          .mockResolvedValueOnce(mockSessionDocRef),  // target scan: card-2 (live, not the claim)
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(txn)));

      await expect(submitSessionReview('session-1', { rating: 3, expectedCardId: 'card-1' }, 'Test Key'))
        .rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('rejects an expectedCardId that is not the LIVE target when the snapshot current card was deleted (stale/deleted id)', async () => {
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1', 'card-2'], currentIndex: 0 }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

      const deleted = { exists: false, data: () => undefined, get: jest.fn() };
      const card2 = { id: 'card-2', exists: true, data: () => cardData({ front: 'Two' }), get: jest.fn() };
      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)   // session
          .mockResolvedValueOnce(deleted)             // target scan: card-1 DELETED (skipped)
          .mockResolvedValueOnce(card2),              // target scan: card-2 LIVE → target
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      // The client believes card-1 is current, but it was deleted — the live
      // target is card-2, so claiming card-1 is stale and REJECTED (the
      // client must re-sync; it can rate card-2 with expectedCardId=card-2).
      await expect(submitSessionReview('session-1', { rating: 3, expectedCardId: 'card-1' }, 'Test Key'))
        .rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('accepts an expectedCardId matching the preloaded LIVE next card when the snapshot current card was deleted', async () => {
      // getReviewSession returned card:null + preloaded [card-2] (card-1 was
      // deleted since the snapshot); the widget promoted card-2 and submits
      // with expectedCardId=card-2. The target scan skips deleted card-1 and
      // finds card-2 as the live target — the submission must SUCCEED.
      const session = sessionData({ cardIds: ['card-1', 'card-2'], currentIndex: 0 });
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(session);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
      const deleted = { exists: false, data: () => undefined, get: jest.fn() };
      const card2 = { id: 'card-2', exists: true, data: () => cardData({ front: 'Two' }), get: jest.fn() };
      const transaction = {
        get: jest.fn()
          .mockResolvedValueOnce(mockSessionDocRef)   // session
          .mockResolvedValueOnce(deleted)             // target scan: card-1 DELETED (skipped)
          .mockResolvedValueOnce(card2)               // target scan: card-2 LIVE → target
          .mockResolvedValueOnce(deleted),            // next scan: nothing after card-2
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(transaction)));

      const result = await submitSessionReview('session-1', { rating: 3, expectedCardId: 'card-2' }, 'Test Key');
      expect(result).not.toBeNull();
      expect(result!.session.currentIndex).toBe(2);   // advanced past card-1 (deleted) + card-2
      expect(result!.session.reviewedCount).toBe(1);  // card-1 never counted
      expect(result!.session.status).toBe('completed');
    });

    it('handles queue exhaustion with expectedCardId without doc(undefined) (completes, never looks up a card)', async () => {
      // currentIndex is at the end (exhausted) — the guard must NOT run a
      // t.get on cardIds[currentIndex] === undefined.
      mockSessionDocRef.exists = true;
      mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1'], currentIndex: 1 }));
      mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
      mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);

      const txn = {
        get: jest.fn().mockResolvedValue(mockSessionDocRef), // session only — NO card doc lookup
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(txn)));

      const result = await submitSessionReview('session-1', { rating: 3, expectedCardId: 'card-1' }, 'Test Key');
      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('completed');
      // Only the session was read; no card doc was ever fetched.
      expect(txn.get).toHaveBeenCalledTimes(1);
    });

    it('REVIEW_TEST_MODE advances the session but SKIPS the card FSRS write', async () => {
      const prev = process.env.REVIEW_TEST_MODE;
      process.env.REVIEW_TEST_MODE = 'true';
      try {
        const baseCard = cardData({ front: 'Q', due: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')) });
        mockSessionDocRef.exists = true;
        mockSessionDocRef.data.mockReturnValue(sessionData());
        mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
        mockFlashcardDocRef.exists = true;
        mockFlashcardDocRef.data.mockReturnValue(baseCard);
        mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);
        mockFlashcardDocRef.update = jest.fn().mockResolvedValue(undefined);

        const txn = {
          get: jest.fn()
            .mockResolvedValueOnce(mockSessionDocRef)   // session
            .mockResolvedValueOnce(mockFlashcardDocRef), // current card
          update: jest.fn().mockResolvedValue(undefined),
        };
        mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(txn)));

        const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

        expect(result).not.toBeNull();
        // Session mechanics advanced:
        expect(result!.session.currentIndex).toBe(1);
        expect(result!.session.reviewedCount).toBe(1);
        expect(result!.session.status).toBe('completed'); // single-card queue
        // The session doc WAS updated:
        expect(txn.update).toHaveBeenCalledWith(mockSessionDocRef, expect.anything());
        // The CARD doc was NEVER written (no FSRS scheduling/reviewLog):
        expect(mockFlashcardDocRef.update).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
      }
    });
    it('a session persisted with testMode:true skips the card FSRS write even after the env flag is disabled', async () => {
      const prev = process.env.REVIEW_TEST_MODE;
      delete process.env.REVIEW_TEST_MODE; // flag is OFF — the persisted field must carry the mode
      try {
        const baseCard = cardData({ front: 'Q' });
        mockSessionDocRef.exists = true;
        mockSessionDocRef.data.mockReturnValue(sessionData({ testMode: true }));
        mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
        mockFlashcardDocRef.exists = true;
        mockFlashcardDocRef.data.mockReturnValue(baseCard);
        mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);
        mockFlashcardDocRef.update = jest.fn().mockResolvedValue(undefined);

        const txn = {
          get: jest.fn()
            .mockResolvedValueOnce(mockSessionDocRef)   // session
            .mockResolvedValueOnce(mockFlashcardDocRef), // current card
          update: jest.fn().mockResolvedValue(undefined),
        };
        mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(txn)));

        const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

        expect(result).not.toBeNull();
        expect(result!.session.currentIndex).toBe(1);
        expect(result!.session.status).toBe('completed');
        expect(txn.update).toHaveBeenCalledWith(mockSessionDocRef, expect.anything());
        expect(mockFlashcardDocRef.update).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
      }
    });

    it('a normal session (no testMode) applies FSRS when the env flag is off', async () => {
      const prev = process.env.REVIEW_TEST_MODE;
      delete process.env.REVIEW_TEST_MODE;
      try {
        const baseCard = cardData({ front: 'Q' });
        mockSessionDocRef.exists = true;
        mockSessionDocRef.data.mockReturnValue(sessionData({ testMode: false }));
        mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
        mockFlashcardDocRef.exists = true;
        mockFlashcardDocRef.data.mockReturnValue(baseCard);
        mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);
        mockFlashcardDocRef.update = jest.fn().mockResolvedValue(undefined);

        const txn = {
          get: jest.fn()
            .mockResolvedValueOnce(mockSessionDocRef)   // session
            .mockResolvedValueOnce(mockFlashcardDocRef), // current card
          update: jest.fn().mockResolvedValue(undefined),
        };
        mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(withEventTx(txn)));

        const result = await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

        expect(result).not.toBeNull();
        // The CARD doc WAS written via the transaction (FSRS scheduling):
        expect(txn.update.mock.calls.some((c: unknown[]) => c[0] === mockFlashcardDocRef)).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
      }
    });
});
});

describe('Review Session Service — reviewEvents writes (focused)', () => {
  let mockDb: any;
  let mockSessionCollectionRef: any;
  let mockSessionDocRef: any;
  let mockFlashcardCollectionRef: any;
  let mockFlashcardDocRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockSessionCollectionRef = mockDb.collection('reviewSessions');
    mockSessionDocRef = {
      id: 'session-1', data: jest.fn(() => undefined), exists: true,
      set: jest.fn(async (data: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue(data); mockSessionDocRef.exists = true; }),
      update: jest.fn(async (patch: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue({ ...(mockSessionDocRef.data() ?? {}), ...patch }); mockSessionDocRef.exists = true; }),
      get: jest.fn(async () => mockSessionDocRef),
    };
    mockSessionCollectionRef.doc.mockImplementation(() => mockSessionDocRef);
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: async (ref: any) => await ref.get(),
      update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
      set: async (ref: any, data: Record<string, unknown>) => ref.set(data),
      delete: async (ref: any) => ref.delete(),
    }));
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockFlashcardDocRef = { id: 'card-1', data: jest.fn(), exists: true, set: jest.fn(), get: jest.fn(), update: jest.fn(), ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() } };
    mockFlashcardDocRef.get = jest.fn(async () => mockFlashcardDocRef);
    mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T00:00:00.000Z')));
  });

  function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ownerId: 'Test Key',
      front: 'F', back: 'B', tags: [], createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')), due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [],
      ...overrides,
    };
  }
  function sessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const ownerId = Object.prototype.hasOwnProperty.call(overrides, 'ownerId') ? overrides.ownerId : 'Test Key';
    return {
      ownerId,
      status: 'active', mode: 'spaced_repetition', limit: 1, dueCount: 1,
      cardIds: ['card-1'], currentIndex: 0, reviewedCount: 0, truncated: false, continuationAvailable: false,
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
      startedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
      ...overrides,
    };
  }

  it('session review writes ONE event (sessionId, no requestId path) inside the transaction', async () => {
    const baseCard = cardData();
    mockSessionDocRef.exists = true;
    mockSessionDocRef.data.mockReturnValue(sessionData());
    mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
    mockFlashcardDocRef.exists = true;
    mockFlashcardDocRef.data.mockReturnValue(baseCard);
    mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

    const transaction = withEventTx({
      get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValueOnce(mockFlashcardDocRef),
      update: jest.fn().mockResolvedValue(undefined),
    });
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    await submitSessionReview('session-1', { rating: 3 }, 'Test Key');

    // Exactly one event set inside the transaction, with the session actor,
    // sessionId and the FSRS after-state.
    expect(transaction.set).toHaveBeenCalledTimes(1);
    const setCall = transaction.set.mock.calls[0];
    const body = setCall[1] as Record<string, unknown>;
    // No requestId: the set is a plain 2-arg set (no merge option).
    expect(setCall[2]).toBeUndefined();
    expect(body).toMatchObject({
      actorId: 'Test Key',
      sessionId: 'session-1',
      rating: 3,
      cardId: 'card-1',
    });
    expect((body.recordedAt as { toMillis(): number }).toMillis()).toBe(Date.parse('2026-08-28T00:00:00.000Z'));
    // The event ref is the deterministic requestId-keyed one when a requestId
    // is present — here none was given, so a reviewEvents collection doc ref.
    expect(setCall[0]).toBeDefined();
  });

  it('session review with requestId uses the owner-scoped evt ref and merge:false (no double set on retry)', async () => {
    const baseCard = cardData();
    mockSessionDocRef.exists = true;
    mockSessionDocRef.data.mockReturnValue(sessionData({ cardIds: ['card-1'], lastRequestId: 'req-1', currentIndex: 1, reviewedCount: 1, processedRequestIds: ['req-1'] }));
    mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
    mockFlashcardDocRef.exists = true;
    mockFlashcardDocRef.data.mockReturnValue(baseCard);
    mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

    const transaction = withEventTx({
      get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValueOnce(mockFlashcardDocRef),
      update: jest.fn().mockResolvedValue(undefined),
    });
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    // A duplicate requestId is a NO-OP (idempotency path) — no event set at all.
    await submitSessionReview('session-1', { rating: 3, requestId: 'req-1' }, 'Test Key');
    expect(transaction.set).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();

    // A fresh requestId applies and sets exactly one owner-scoped event ref
    // with merge:false.
    mockSessionDocRef.data.mockReturnValue(sessionData());
    const transaction2 = withEventTx({
      get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValueOnce(mockFlashcardDocRef),
      update: jest.fn().mockResolvedValue(undefined),
    });
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction2));
    await submitSessionReview('session-1', { rating: 3, requestId: 'req-new' }, 'Test Key');
    expect(transaction2.set).toHaveBeenCalledTimes(1);
    const body = transaction2.set.mock.calls[0][1] as Record<string, unknown>;
    expect(body.requestId).toBe('req-new');
  });

  it('a failed transaction never commits the event (atomicity)', async () => {
    const baseCard = cardData();
    mockSessionDocRef.exists = true;
    mockSessionDocRef.data.mockReturnValue(sessionData());
    mockFlashcardDocRef.exists = true;
    mockFlashcardDocRef.data.mockReturnValue(baseCard);
    mockFlashcardDocRef.get = jest.fn().mockResolvedValue(mockFlashcardDocRef);

    // The transaction callback THROWS (e.g. concurrent write conflict) — the
    // event set is issued on the transaction object but never committed
    // because runTransaction rejects; simulate by having the mock reject.
    const transaction = withEventTx({
      get: jest.fn().mockResolvedValueOnce(mockSessionDocRef).mockResolvedValueOnce(mockFlashcardDocRef),
      update: jest.fn().mockResolvedValue(undefined),
    });
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(transaction);
      throw new Error('transaction aborted');
    });

    await expect(submitSessionReview('session-1', { rating: 3 }, 'Test Key')).rejects.toThrow('transaction aborted');
    // The card update and event set were attempted inside the txn, but the
    // runTransaction mock aborted: nothing committed. This asserts the
    // service never performs a standalone event write AFTER the transaction.
    expect(transaction.set).toHaveBeenCalledTimes(1); // issued inside txn only
    const eventRef = transaction.set.mock.calls[0][0] as { path?: string };
    expect(eventRef.path || eventRef).toBeDefined();
  });
});



describe('Review Session Service — selectors', () => {
  let mockDb: any;
  let mockSessionCollectionRef: any;
  let mockSessionDocRef: any;
  let mockFlashcardCollectionRef: any;
  let mockFlashcardDocRef: any;

  // Stateful query builder: where()/limit()/orderBy() return NEW query
  // objects that actually APPLY the filters against a doc store, so chained
  // composite queries (deck + tags intersection) behave like Firestore.
  let docStore: Array<{ id: string; data: () => Record<string, unknown> }> = [];
  let queryChain: Array<{ field: string; op: string; value: unknown }> = [];

  function makeQuery(): any {
    const q: any = {
      where: jest.fn((field: string, op: string, value: unknown) => {
        queryChain.push({ field, op, value });
        return makeQuery();
      }),
      orderBy: jest.fn(() => makeQuery()),
      limit: jest.fn(() => makeQuery()),
      startAfter: jest.fn(() => makeQuery()),
      select: jest.fn(() => makeQuery()),
      get: jest.fn(async () => {
        let docs = docStore;
        for (const cond of queryChain) {
          if (cond.field === 'due' && cond.op === '<=') {
            docs = docs.filter((d) => {
              const due = d.data().due as { toMillis: () => number };
              return due.toMillis() <= (cond.value as { toMillis: () => number }).toMillis();
            });
          } else if (cond.field === 'deckId' && cond.op === '==') {
            docs = docs.filter((d) => d.data().deckId === cond.value);
          } else if (cond.field === 'deck' && cond.op === '==') {
            docs = docs.filter((d) => d.data().deck === cond.value);
          } else if (cond.field === 'tags' && cond.op === 'array-contains-any') {
            const anyTags = cond.value as string[];
            docs = docs.filter((d) => {
              const tags = d.data().tags as string[] | undefined;
              return (tags ?? []).some((t: string) => anyTags.includes(t));
            });
          }
        }
        // due ascending, ties by id (deterministic — matches the service).
        docs = [...docs].sort((a, b) => {
          const da = (a.data().due as { toMillis: () => number }).toMillis();
          const db = (b.data().due as { toMillis: () => number }).toMillis();
          return (da - db) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        return { docs, empty: docs.length === 0 };
      }),
    };
    return q;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockDb.collection('decks').doc.mockImplementation((id = 'deck-1') => mockOwnedDeckRef(id, 'Spanish'));
    mockSessionCollectionRef = mockDb.collection('reviewSessions');
    mockSessionDocRef = {
      id: 'session-1', exists: true, data: jest.fn(() => undefined),
      set: jest.fn(async (data: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue(data); mockSessionDocRef.exists = true; }),
      update: jest.fn(async (patch: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue({ ...(mockSessionDocRef.data() ?? {}), ...patch }); mockSessionDocRef.exists = true; }),
      get: jest.fn(async () => mockSessionDocRef), collection: jest.fn(),
    };
    mockSessionCollectionRef.doc.mockImplementation((id?: string) => {
      if (id !== undefined) mockSessionDocRef.id = id;
      return mockSessionDocRef;
    });
    // Session subcollection and batch stubs for the mock datastore.
    const chunkDocs2: Record<string, any> = {};
    const chunkCollection2: any = {
      doc: jest.fn((id: string) => {
        if (!chunkDocs2[id]) {
          chunkDocs2[id] = {
            id, exists: false, data: jest.fn(() => undefined),
            set: jest.fn(async (data: Record<string, unknown>) => { chunkDocs2[id].data.mockReturnValue(data); chunkDocs2[id].exists = true; }),
            update: jest.fn(async (patch: Record<string, unknown>) => { const cur: Record<string, unknown> = chunkDocs2[id].data() ?? {}; chunkDocs2[id].data.mockReturnValue({ ...cur, ...patch }); chunkDocs2[id].exists = true; }),
            get: jest.fn(async () => chunkDocs2[id]),
          };
        }
        return chunkDocs2[id];
      }),
      orderBy: jest.fn(() => chunkCollection2),
      limit: jest.fn(() => chunkCollection2),
      startAt: jest.fn(() => chunkCollection2),
      startAfter: jest.fn(() => chunkCollection2),
      get: jest.fn(async () => ({ docs: Object.keys(chunkDocs2).sort().map((kk) => chunkDocs2[kk]) })),
    };
    mockSessionDocRef.collection = jest.fn(() => chunkCollection2);
    mockSessionCollectionRef.collection = jest.fn(() => chunkCollection2);
    const batchSets2: Array<{ ref: any; data: unknown }> = [];
    mockDb.batch = jest.fn(() => ({
      set: jest.fn((ref: any, data: unknown) => { batchSets2.push({ ref, data }); }),
      update: jest.fn(),
      commit: jest.fn(async () => {
        for (const b of batchSets2) { if (b.ref.set) await b.ref.set(b.data); }
      }),
    }));
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockFlashcardDocRef = { id: 'card-1', data: jest.fn(), exists: true, set: jest.fn(), get: jest.fn(), update: jest.fn(), ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() } };
    docStore = [];
    queryChain = [];
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({
      id,
      get: jest.fn(async () => {
        const found = docStore.find((d) => d.id === id);
        return found ? { ...found, exists: true } : { exists: false, id, data: () => ({}) };
      }),
    }));
    // The collection itself behaves like a query root (orderBy chain start).
    const root = makeQuery();
    mockFlashcardCollectionRef.where = root.where;
    mockFlashcardCollectionRef.orderBy = root.orderBy;
    mockFlashcardCollectionRef.limit = root.limit;
    mockFlashcardCollectionRef.get = root.get;
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T00:00:00.000Z')));
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: async (ref: any) => await ref.get(),
      update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
      set: async (ref: any, data: Record<string, unknown>) => ref.set(data),
      delete: async (ref: any) => ref.delete(),
    }));
  });

  function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ownerId: 'Test Key',
      front: 'F',
      back: 'B',
      tags: [],
      createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
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

  it('no selectors returns only due cards', async () => {
    docStore = [
      { id: 'card-1', data: () => cardData({ front: 'Due-1' }) },
      { id: 'future-card', data: () => cardData({ front: 'Future', due: mockTimestamp(new Date('2030-01-01T00:00:00.000Z')) }) },
    ];
    const root = mockFlashcardCollectionRef;
    root.count = jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ data: () => ({ count: 1 }) }),
    }));

    const result = await startReviewSession({}, 'Test Key');

    expect(result.session.source).toEqual({ type: 'due' });
    expect(result.session.storageVersion).toBe(2);
    expect(result.session.dueCount).toBe(1);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-1', position: 0 }]);
  });

  it('deck-only by deckId → source deck with the deck name, non-due cards included', async () => {
    // The deck entity exists; its name is the display name.
    mockDb.collection('decks').doc.mockReturnValue(mockOwnedDeckRef('deck-1', 'Spanish'));
    // One due card and one FUTURE-due card of the deck — both are included
    // because a deck selection may include non-due cards.
    docStore = [
      { id: 'card-due', data: () => cardData({ deckId: 'deck-1', deck: 'Spanish' }) },
      { id: 'card-future', data: () => cardData({ deckId: 'deck-1', deck: 'Spanish', due: mockTimestamp(new Date('2030-01-01T00:00:00.000Z')) }) },
    ];

    const result = await startReviewSession({ deckId: 'deck-1' }, 'Test Key');

    expect(result.session.source).toEqual({ type: 'deck', deckId: 'deck-1', deckName: 'Spanish' });
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-due', position: 0 }, { cardId: 'card-future', position: 1 }]);
  });

  it('deck-only by NAME → matches the denormalized deck field, source deck with the name', async () => {
    // No deck entity exists — name matching follows the list/due `deck`
    // filter semantics (legacy name-only cards included).
    mockDb.collection('decks').where.mockReturnValue(mockDb.collection('decks'));
    mockDb.collection('decks').limit.mockReturnValue(mockDb.collection('decks'));
    mockDb.collection('decks').get.mockResolvedValue({ empty: true, docs: [] });
    docStore = [
      { id: 'legacy-card', data: () => cardData({ deck: 'Spanish' }) },
    ];

    const result = await startReviewSession({ deck: 'Spanish' }, 'Test Key');

    expect(result.session.source).toEqual({ type: 'deck', deckName: 'Spanish' });
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'legacy-card', position: 0 }]);
  });

  it('tags → source custom, ANY-of semantics (a card matching any tag is included)', async () => {
    docStore = [
      { id: 'card-tagA', data: () => cardData({ tags: ['tag-a'] }) },
      { id: 'card-tagB', data: () => cardData({ tags: ['tag-b'] }) },
      { id: 'card-none', data: () => cardData({ tags: [] }) },
    ];

    const result = await startReviewSession({ tags: ['tag-a', 'tag-b'] }, 'Test Key');

    expect(result.session.source).toEqual({ type: 'custom', tags: ['tag-a', 'tag-b'] });
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-tagA', position: 0 }, { cardId: 'card-tagB', position: 1 }]);
  });

  it('deck + tags → INTERSECTION, source custom with both selectors recorded', async () => {
    mockDb.collection('decks').doc.mockReturnValue(mockOwnedDeckRef('deck-1', 'Spanish'));
    const allDocs = [
      { id: 'in-deck-tag', data: () => cardData({ deckId: 'deck-1', deck: 'Spanish', tags: ['vocab'] }) },
      { id: 'in-deck-no-tag', data: () => cardData({ deckId: 'deck-1', deck: 'Spanish', tags: [] }) },
      { id: 'other-deck-tag', data: () => cardData({ deckId: 'deck-2', deck: 'Math', tags: ['vocab'] }) },
    ];
    docStore = allDocs;

    const result = await startReviewSession({ deckId: 'deck-1', tags: ['vocab'] }, 'Test Key');

    expect(result.session.source).toEqual({ type: 'custom', deckId: 'deck-1', deckName: 'Spanish', tags: ['vocab'] });
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'in-deck-tag', position: 0 }]);
  });

  it('explicit cardIds → source custom, deduped and validated; missing id FAILS', async () => {
    // Card docs by id: card-1 and card-2 exist, card-3 does not.
    const byId: Record<string, { exists: boolean; id: string; data: () => Record<string, unknown> }> = {
      'card-1': { exists: true, id: 'card-1', data: () => cardData({ id: 'card-1' }) },
      'card-2': { exists: true, id: 'card-2', data: () => cardData({ id: 'card-2' }) },
      'card-3': { exists: false, id: 'card-3', data: () => ({}) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({
      id,
      get: jest.fn().mockResolvedValue(byId[id] ?? { exists: false, id, data: () => ({}) }),
    }));

    await expect(startReviewSession({ cardIds: ['card-1', 'card-3'] }, 'Test Key')).rejects.toThrow('Card not found: card-3');

    // Now with all-existing ids (including a duplicate) → deduped, ordered by due.
    const result = await startReviewSession({ cardIds: ['card-2', 'card-1', 'card-2'] }, 'Test Key');
    expect(result.session.source).toEqual({ type: 'custom' });
    // Deterministic ordering by due ascending (card-1 due earlier than card-2).
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-1', position: 0 }, { cardId: 'card-2', position: 1 }]);
  });

  it('cardIds + deck + tags → intersection in-memory, missing id still fails, source custom', async () => {
    mockDb.collection('decks').doc.mockReturnValue(mockOwnedDeckRef('deck-1', 'Spanish'));
    const byId: Record<string, { exists: boolean; id: string; data: () => Record<string, unknown> }> = {
      'card-1': { exists: true, id: 'card-1', data: () => cardData({ id: 'card-1', deckId: 'deck-1', deck: 'Spanish', tags: ['vocab'] }) },
      'card-2': { exists: true, id: 'card-2', data: () => cardData({ id: 'card-2', deckId: 'deck-1', deck: 'Spanish', tags: ['other'] }) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({
      id,
      get: jest.fn().mockResolvedValue(byId[id] ?? { exists: false, id, data: () => ({}) }),
    }));

    const result = await startReviewSession({ deckId: 'deck-1', tags: ['vocab'], cardIds: ['card-1', 'card-2'] }, 'Test Key');
    expect(result.session.source).toEqual({ type: 'custom', deckId: 'deck-1', deckName: 'Spanish', tags: ['vocab'] });
    // Only card-1 matches BOTH the allowlist and the deck+tag intersection.
    expect(result.session.storageVersion).toBe(2);
    expect(result.queueWindow!?.cardIds).toEqual([{ cardId: 'card-1', position: 0 }]);
  });

  it('REVIEW_TEST_MODE does NOT widen an explicit selection (deck query is authoritative)', async () => {
    const prev = process.env.REVIEW_TEST_MODE;
    process.env.REVIEW_TEST_MODE = 'true';
    try {
      mockDb.collection('decks').doc.mockReturnValue(mockOwnedDeckRef('deck-1', 'Spanish'));
      docStore = [];
      mockFlashcardDocRef.exists = false;

      await startReviewSession({ deckId: 'deck-1' }, 'Test Key');

      // The deck filter was applied (no due filter, but the selector query):
      expect(queryChain.some((c) => c.field === 'deckId' && c.op === '==' && c.value === 'deck-1')).toBe(true);
      // The session is still scoped to the deck — test mode never widened it.
      expect(mockSessionDocRef.set).toHaveBeenCalledWith(expect.objectContaining({
        source: { type: 'deck', deckId: 'deck-1', deckName: 'Spanish' },
      }));
    } finally {
      if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
    }
  });

  it('includes more than 100 selector-matched cards', async () => {
    mockDb.collection('decks').doc.mockReturnValue(mockOwnedDeckRef('deck-1', 'Huge'));
    docStore = Array.from({ length: 150 }, (_, i) => ({
      id: 'card-' + (i + 1),
      data: () => cardData({ deckId: 'deck-1', deck: 'Huge' }),
    }));

    const result = await startReviewSession({ deckId: 'deck-1' }, 'Test Key');

    expect(result.session.limit).toBe(150);
    expect(result.session.storageVersion).toBe(2);
    expect(result.session.continuationAvailable).toBe(false);
    expect(result.session.dueCount).toBe(150);
  });
});


describe('searchCards (rich query service)', () => {
  let mockDb: any;
  let mockFlashcardCollectionRef: any;

  let docStore: Array<{ id: string; data: () => Record<string, unknown> }> = [];
  let queryChain: Array<{ field: string; op: string; value: unknown }> = [];

  function makeQuery(): any {
    let cursor: { id: string; createdAtMs: number | null } | null = null;
    const q: any = {
      where: jest.fn((field: string, op: string, value: unknown) => {
        queryChain.push({ field, op, value });
        return q;
      }),
      orderBy: jest.fn(() => {
        // A new service call starts a fresh query chain (orderBy is the root).
        queryChain = [];
        cursor = null;
        return q;
      }),
      limit: jest.fn(() => q),
      startAfter: jest.fn((first: { id?: string; toMillis?: () => number }, second?: string) => {
        cursor = second === undefined
          ? { id: first.id!, createdAtMs: null }
          : { id: second, createdAtMs: first.toMillis!() };
        return q;
      }),
      get: jest.fn(async () => {
        let docs = docStore;
        for (const cond of queryChain) {
          if (cond.field === 'createdAt' && cond.op === '>=') {
            const lo = (cond.value as { toMillis: () => number }).toMillis();
            docs = docs.filter((d) => (d.data().createdAt as { toMillis: () => number }).toMillis() >= lo);
          } else if (cond.field === 'createdAt' && cond.op === '<=') {
            const hi = (cond.value as { toMillis: () => number }).toMillis();
            docs = docs.filter((d) => (d.data().createdAt as { toMillis: () => number }).toMillis() <= hi);
          }
        }
        // createdAt desc, ties by id asc — the service's explicit order
        // (orderBy createdAt desc + orderBy documentId) and Firestore's
        // native tie-break.
        docs = [...docs].sort((a, b) => {
          const da = (a.data().createdAt as { toMillis: () => number }).toMillis();
          const db = (b.data().createdAt as { toMillis: () => number }).toMillis();
          return (db - da) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        if (cursor?.createdAtMs === null) {
          const at = docs.findIndex((d) => d.id === cursor!.id);
          docs = at === -1 ? [] : docs.slice(at + 1);
        } else if (cursor) {
          docs = docs.filter((d) => {
            const createdAt = (d.data().createdAt as { toMillis: () => number }).toMillis();
            return createdAt < cursor!.createdAtMs! || (createdAt === cursor!.createdAtMs && d.id > cursor!.id);
          });
        }
        return { docs, empty: docs.length === 0 };
      }),
    };
    return q;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    docStore = [];
    queryChain = [];
    const root = makeQuery();
    mockFlashcardCollectionRef.where = root.where;
    mockFlashcardCollectionRef.orderBy = root.orderBy;
    mockFlashcardCollectionRef.limit = root.limit;
    mockFlashcardCollectionRef.startAfter = root.startAfter;
    mockFlashcardCollectionRef.get = root.get;
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T12:00:00.000Z')));
  });

  function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ownerId: 'Test Key',
      front: 'F',
      back: 'B',
      tags: [],
      createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
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

  function put(id: string, data: Record<string, unknown>): void {
    docStore.push({ id, data: () => cardData({ id, ...data }) });
  }

  const q: SearchCardsQuery = {};

  it('orders createdAt desc and paginates with a cursor (boundaries)', async () => {
    put('c1', { front: 'One', createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')) });
    put('c2', { front: 'Two', createdAt: mockTimestamp(new Date('2026-08-02T00:00:00Z')) });
    put('c3', { front: 'Three', createdAt: mockTimestamp(new Date('2026-08-03T00:00:00Z')) });

    const page1 = await searchCards({ pageSize: 2 }, 'Test Key');
    expect(page1.cards.map((c) => c.id)).toEqual(['c3', 'c2']);

    const page2 = await searchCards({ pageSize: 2, pageToken: page1.nextPageToken! }, 'Test Key');
    expect(page2.cards.map((c) => c.id)).toEqual(['c1']);
    expect(page2.nextPageToken).toBeNull();
    void q;
  });

  it('does not duplicate or skip cards when several share createdAt (id tiebreak)', async () => {
    put('a', { createdAt: mockTimestamp(new Date('2026-08-10T00:00:00Z')) });
    put('b', { createdAt: mockTimestamp(new Date('2026-08-10T00:00:00Z')) });
    put('c', { createdAt: mockTimestamp(new Date('2026-08-10T00:00:00Z')) });
    put('d', { createdAt: mockTimestamp(new Date('2026-08-11T00:00:00Z')) });

    const p1 = await searchCards({ pageSize: 2 }, 'Test Key');
    expect(p1.cards.map((c) => c.id)).toEqual(['d', 'a']);
    const p2 = await searchCards({ pageSize: 2, pageToken: p1.nextPageToken! }, 'Test Key');
    expect(p2.cards.map((c) => c.id)).toEqual(['b', 'c']);
    expect(p2.nextPageToken).toBeNull();
  });

  it('combined filters: tagsAll + deck + suspended false + review due', async () => {
    put('hit', { deckId: 'deck-1', deck: 'Spanish', tags: ['verb', 'irregular'], suspended: false, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')) });
    put('miss-tag', { deckId: 'deck-1', deck: 'Spanish', tags: ['verb'], suspended: false, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')) });
    put('miss-deck', { deckId: 'deck-2', deck: 'French', tags: ['verb', 'irregular'], suspended: false, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')) });
    put('miss-suspended', { deckId: 'deck-1', deck: 'Spanish', tags: ['verb', 'irregular'], suspended: true, due: mockTimestamp(new Date('2026-08-01T00:00:00Z')) });
    put('miss-notdue', { deckId: 'deck-1', deck: 'Spanish', tags: ['verb', 'irregular'], suspended: false, due: mockTimestamp(new Date('2026-09-01T00:00:00Z')) });

    const result = await searchCards({ tagsAll: ['verb', 'irregular'], decks: ['deck-1'], suspended: false, review: 'due' }, 'Test Key');
    expect(result.cards.map((c) => c.id)).toEqual(['hit']);
    expect(result.nextPageToken).toBeNull();
  });

  it('tagsNot excludes, tagsAny includes across the deck-family union', async () => {
    put('any1', { deck: 'Spanish', tags: ['x'] });
    put('any2', { deckId: 'deck-9', tags: ['y'] });
    put('no', { deck: 'Spanish', tags: ['blocked'] });
    const result = await searchCards({ tagsAny: ['x', 'y'], tagsNot: ['blocked'] }, 'Test Key');
    // tagsAny + tagsNot together are mutually exclusive → validator rejects; here only tagsAny should apply on family.
    expect(result.cards.map((c) => c.id).sort()).toEqual(['any1', 'any2']);

    const byName = await searchCards({ deckNames: ['Spanish'], tagsNot: ['blocked'] }, 'Test Key');
    expect(byName.cards.map((c) => c.id).sort()).toEqual(['any1']);
  });

  it('search matches topic OR front OR back; new/reviewed split on reps', async () => {
    put('topic-hit', { topic: 'European capitals', front: 'What is X?', back: 'Y', reps: 0 });
    put('back-hit', { front: 'Question', back: 'The capital is Lisbon', reps: 1 });
    put('front-hit', { front: 'Berlin is the capital of…', back: '…', reps: 2 });
    put('none', { front: 'Q', back: 'A', reps: 4 });

    const bySearch = await searchCards({ search: 'capital' }, 'Test Key');
    expect(bySearch.cards.map((c) => c.id).sort()).toEqual(['back-hit', 'front-hit', 'topic-hit']);

    const fresh = await searchCards({ review: 'new' }, 'Test Key');
    expect(fresh.cards.map((c) => c.id).sort()).toEqual(['topic-hit']);
    const reviewed = await searchCards({ review: 'reviewed' }, 'Test Key');
    expect(reviewed.cards.map((c) => c.id).sort()).toEqual(['back-hit', 'front-hit', 'none']);
  });

  it('applies inclusive createdAt date bounds to search results', async () => {
    put('early', { createdAt: mockTimestamp(new Date('2026-07-20T00:00:00Z')) });
    put('mid', { createdAt: mockTimestamp(new Date('2026-08-15T00:00:00Z')) });
    put('late', { createdAt: mockTimestamp(new Date('2026-09-05T00:00:00Z')) });

    const result = await searchCards({ createdFrom: '2026-08-01', createdTo: '2026-08-31' }, 'Test Key');
    expect(result.cards.map((c) => c.id)).toEqual(['mid']);
  });

  it('suspended:true returns only suspended cards; default excludes nothing', async () => {
    put('s1', { suspended: true });
    put('a1', {});
    const only = await searchCards({ suspended: true }, 'Test Key');
    expect(only.cards.map((c) => c.id)).toEqual(['s1']);
    const both = await searchCards({}, 'Test Key');
    expect(both.cards.map((c) => c.id).sort()).toEqual(['a1', 's1']);
  });

  it('updatedFrom/updatedTo filter on updatedAt in memory', async () => {
    put('u1', { updatedAt: mockTimestamp(new Date('2026-07-10T00:00:00Z')) });
    put('u2', { updatedAt: mockTimestamp(new Date('2026-09-10T00:00:00Z')) });
    const result = await searchCards({ updatedFrom: '2026-08-01' }, 'Test Key');
    expect(result.cards.map((c) => c.id)).toEqual(['u2']);
  });

  it('returns an empty page when nothing matches', async () => {
    put('x', { tags: [] });
    const result = await searchCards({ tagsAll: ['never'] }, 'Test Key');
    expect(result.cards).toEqual([]);
    expect(result.nextPageToken).toBeNull();
  });

  it('same-createdAt cards page without skip or duplicate (id asc tiebreak + cursor agreement)', async () => {
    // Six cards sharing one createdAt: pagination must walk id asc
    // (a,b,c,d,e,f) across pages with no gaps or repeats.
    const same = mockTimestamp(new Date('2026-08-10T00:00:00Z'));
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      put(id, { createdAt: same });
    }
    const ids = (r: { cards: Array<{ id: string }> }) => r.cards.map((c) => c.id);

    // createdAt equal for all → the id-asc tiebreak fully determines the
    // order: a, b, c, d, e, f. Pages of 2 walk that order with no gaps.
    const p1 = await searchCards({ pageSize: 2 }, 'Test Key');
    expect(ids(p1)).toEqual(['a', 'b']);
    const p2 = await searchCards({ pageSize: 2, pageToken: p1.nextPageToken! }, 'Test Key');
    expect(ids(p2)).toEqual(['c', 'd']);
    const p3 = await searchCards({ pageSize: 2, pageToken: p2.nextPageToken! }, 'Test Key');
    expect(ids(p3)).toEqual(['e', 'f']);
    expect(p3.nextPageToken).toBeNull();
  });

  it('reaches deep pages past 500 sparse candidates (no scan cap)', async () => {
    // 1100 cards at increasing createdAt; only every 10th matches the tag.
    // Page 2 of 5 per page requires scanning well past the first 500 docs —
    // an arbitrary scan cap would return an empty page 2.
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 1100; i += 1) {
      const id = 'card-' + String(i).padStart(4, '0');
      put(id, {
        createdAt: mockTimestamp(new Date(base + i * 1000)),
        tags: i % 10 === 0 ? ['needle'] : [],
      });
    }
    const p1 = await searchCards({ tagsAny: ['needle'], pageSize: 5 }, 'Test Key');
    expect(p1.cards).toHaveLength(5);
    const p2 = await searchCards({ tagsAny: ['needle'], pageSize: 5, pageToken: p1.nextPageToken! }, 'Test Key');
    expect(p2.cards).toHaveLength(5);
    // createdAt desc: the needle cards continue downward from p1 (1050…) —
    // reaching card-1000 requires scanning ~2000 candidates past the first
    // 500-doc Firestore page, which a capped scan would never return.
    expect(p2.cards.map((c) => c.id)).toEqual(['card-1040', 'card-1030', 'card-1020', 'card-1010', 'card-1000']);
  });

  it('rejects a pageToken minted for different filters', async () => {
    put('x', { front: 'alpha front' });
    put('y', { front: 'another alpha' });
    const p1 = await searchCards({ search: 'alpha', pageSize: 1 }, 'Test Key');
    expect(p1.cards).toHaveLength(1);
    // Same shape, DIFFERENT filter value: service must refuse the token.
    await expect(searchCards({ search: 'beta', pageSize: 1, pageToken: p1.nextPageToken! }, 'Test Key'))
      .rejects.toThrow(InvalidPageTokenError);
    // Malformed token also refused.
    await expect(searchCards({ search: 'alpha', pageSize: 1, pageToken: 'garbage' }, 'Test Key'))
      .rejects.toThrow(InvalidPageTokenError);
  });

  it('orders by explicit createdAt desc + document id (two orderBy calls, deterministic)', async () => {
    put('z1', { createdAt: mockTimestamp(new Date('2026-08-05T00:00:00Z')) });
    put('a9', { createdAt: mockTimestamp(new Date('2026-08-05T00:00:00Z')) });
    const result = await searchCards({}, 'Test Key');
    // Same createdAt → id asc within the page.
    expect(result.cards.map((c) => c.id)).toEqual(['a9', 'z1']);
  });

  it('issues the createdAt desc + document id ASC order that the deployed composite index serves', async () => {
    put('only', { createdAt: mockTimestamp(new Date('2026-08-05T00:00:00Z')) });
    await searchCards({}, 'Test Key');
    // searchCards MUST order by createdAt desc with an explicit document-id
    // ASC secondary sort. Firestore requires a composite index for exactly
    // this shape — (createdAt DESC, __name__ ASC), declared in
    // firestore.indexes.json. Dropping the secondary order (or flipping it)
    // would change the id-asc tie-break pagination contract AND make the
    // live query 500 with "query requires an index" (or silently reorder
    // same-createdAt pages). The FieldPath.documentId() mock resolves to
    // '__name__', matching the Firestore-reserved field name.
    expect(mockFlashcardCollectionRef.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mockFlashcardCollectionRef.orderBy).toHaveBeenCalledWith('__name__');
  });
});





describe('countFlashcards (aggregate counts)', () => {
  let mockDb: any;
  let mockFlashcardCollectionRef: any;
  let mockDeckCollectionRef: any;

  /**
   * Every aggregate query's OWN predicate set at count() time. Firestore
   * Query objects are immutable: where() returns a NEW query carrying its
   * predicates, so each count() sees exactly the composite it was built
   * with. The stub mirrors that (the collection root starts empty; each
   * where() forks a new stub that appends the predicate to its own list).
   */
  let countSnapshots: Array<Array<{ field: string; op: string; value: unknown }>> = [];

  /**
   * Ordered count() results. Each bucket set is built as
   * [total, new (state 0), learning (state 1), mature (state in [2,3]),
   * due (due <= now)] and the five count() calls happen synchronously in
   * that order, so an ordered queue deterministically maps each aggregate
   * to its bucket value.
   */
  let countValues: number[] = [];
  const queueCounts = (...values: number[]): void => {
    countValues.push(...values);
  };

  /** Builds a query stub carrying the given accumulated predicate list. */
  function makeQuery(predicates: Array<{ field: string; op: string; value: unknown }> = []): any {
    const countImpl = jest.fn(() => {
      // Snapshot the composite predicates AT count()-construction time.
      countSnapshots.push([...predicates]);
      return {
        get: jest.fn(async () => {
          const value = countValues.length > 0 ? countValues.shift() as number : 0;
          return { data: () => ({ count: value }) };
        }),
      };
    });
    const q: any = {
      where: jest.fn((field: string, op: string, value: unknown) => {
        // Immutable: a NEW query carrying the previous predicates + this one.
        return makeQuery([...predicates, { field, op, value }]);
      }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      startAfter: jest.fn(() => q),
      get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
      count: countImpl,
    };
    return q;
  }

  /** Deck documents served by the groupBy deck-entity scan. */
  let deckDocs: Array<{ id: string; data: () => { name: string } }> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockDeckCollectionRef = mockDb.collection('decks');
    countSnapshots = [];
    countValues = [];
    deckDocs = [];
    // The flashcards collection reference IS the empty root query (no
    // predicates yet); applyCountFilters().where(...) forks immutable child
    // queries from it.
    const root = makeQuery();
    mockFlashcardCollectionRef.where = root.where;
    mockFlashcardCollectionRef.orderBy = root.orderBy;
    mockFlashcardCollectionRef.limit = root.limit;
    mockFlashcardCollectionRef.startAfter = root.startAfter;
    mockFlashcardCollectionRef.get = root.get;
    mockFlashcardCollectionRef.count = root.count;
    // Deck collection scan: get() reads the CURRENT deckDocs (lazily, so
    // tests can assign deckDocs after beforeEach). Forked stubs created by
    // makeQuery have their own get() mock; patch them to delegate to the
    // root so where().get() returns deckDocs instead of the default empty.
    const deckRoot = makeQuery();
    const deckRootGet = jest.fn(async () => ({ docs: deckDocs, empty: deckDocs.length === 0 }));
    deckRoot.get = deckRootGet;
    const origDeckWhere = deckRoot.where;
    deckRoot.where = jest.fn((...args: unknown[]) => {
      const forked = origDeckWhere(...(args as [string, string, unknown]));
      forked.get = deckRootGet;
      return forked;
    });
    mockDeckCollectionRef.where = deckRoot.where;
    mockDeckCollectionRef.get = deckRootGet;
    mockDeckCollectionRef.limit = deckRoot.limit;
    mockDeckCollectionRef.startAfter = deckRoot.startAfter;
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T12:00:00.000Z')));
  });

  it('counts every bucket via count() aggregates — never fetches card documents', async () => {
    // Bucket-set order: total, learning, mature, due. `new` is DERIVED
    // (total - learning - mature), never aggregated.
    queueCounts(30, 5, 15, 20);
    mockFlashcardCollectionRef.get.mockClear();

    const result = await countFlashcards({}, 'Test Key');

    expect(result).toEqual({
      counts: { total: 30, new: 10, learning: 5, mature: 15, due: 20 },
    });
    expect(result.byDeck).toBeUndefined();
    // Aggregation path only — NO flashcards document-fetch .get() at all.
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
    // Exactly FOUR aggregate queries ran, with the documented predicates:
    // unfiltered total; state == 1 (learning); state in [2,3] (mature);
    // due <= now (a Timestamp bound). There is NO `state == 0` aggregate —
    // new is derived so legacy cards without a persisted state (which
    // docToFlashcard reads as New) still land in the new bucket.
    expect(countSnapshots).toHaveLength(4);
    expect(countSnapshots[0]).toEqual([{ field: 'ownerId', op: '==', value: 'Test Key' }]);
    expect(countSnapshots[1]).toEqual([{ field: 'ownerId', op: '==', value: 'Test Key' }, { field: 'state', op: '==', value: 1 }]);
    expect(countSnapshots[2]).toEqual([{ field: 'ownerId', op: '==', value: 'Test Key' }, { field: 'state', op: 'in', value: [2, 3] }]);
    expect(countSnapshots[3]).toHaveLength(2);
    expect(countSnapshots[3][1]).toMatchObject({ field: 'due', op: '<=' });
    expect(typeof (countSnapshots[3][1].value as { toMillis: () => number }).toMillis).toBe('function');
    // No state == 0 aggregate was ever issued (derivation, not aggregation).
    expect(countSnapshots.every((snap) => snap.every((c) => !(c.field === 'state' && c.op === '==' && c.value === 0)))).toBe(true);
  });

  it('new is derived as total - learning - mature, so legacy no-state cards are never lost (partition invariant)', async () => {
    // 5 cards: 1 learning, 1 mature, and 3 New — where the 3 include legacy
    // documents that carry NO persisted `state` field (Firestore `state == 0`
    // would miss them; docToFlashcard reads them as New).
    queueCounts(5, 1, 1, 5); // total, learning, mature, due

    const result = await countFlashcards({}, 'Test Key');

    // new == 5 - 1 - 1 == 3 (all non-learning/mature cards, including the
    // field-less legacy ones), so new + learning + mature == total holds.
    expect(result.counts).toEqual({ total: 5, new: 3, learning: 1, mature: 1, due: 5 });
    expect(result.counts.new + result.counts.learning + result.counts.mature).toBe(result.counts.total);
    // Proves the endpoint never relied on a state == 0 equality aggregate.
    expect(countSnapshots.every((snap) => snap.every((c) => !(c.field === 'state' && c.op === '==' && c.value === 0)))).toBe(true);
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('applies deckId and tags filters to every aggregate', async () => {
    queueCounts(7, 1, 4, 3); // one bucket set, all filtered; new = 7-1-4 = 2

    const result = await countFlashcards({ deckId: 'deck-1', tags: 'verb,irregular' }, 'Test Key');

    expect(result.counts).toEqual({ total: 7, new: 2, learning: 1, mature: 4, due: 3 });
    // Each of the four aggregates carries the deckId + tags predicates
    // (they are the base scope of every composite count).
    expect(countSnapshots).toHaveLength(4);
    for (const snap of countSnapshots) {
      expect(snap[0]).toMatchObject({ field: 'ownerId', op: '==', value: 'Test Key' });
      expect(snap[1]).toMatchObject({ field: 'deckId', op: '==', value: 'deck-1' });
      expect(snap[2]).toMatchObject({ field: 'tags', op: 'array-contains-any', value: ['verb', 'irregular'] });
    }
    // No deck-entity scan, no card doc fetch.
    expect(mockDeckCollectionRef.get).not.toHaveBeenCalled();
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('applies deckId when BOTH deckId and deck are given (deckId wins — list/due convention)', async () => {
    queueCounts(4, 1, 1, 2); // one bucket set

    const result = await countFlashcards({ deckId: 'deck-9', deck: 'Spanish' }, 'Test Key');

    expect(result.counts.total).toBe(4);
    // Only the deckId predicate is applied; the legacy deck name is ignored.
    expect(countSnapshots).toHaveLength(4);
    for (const snap of countSnapshots) {
      expect(snap[0]).toMatchObject({ field: 'ownerId', op: '==', value: 'Test Key' });
      expect(snap[1]).toMatchObject({ field: 'deckId', op: '==', value: 'deck-9' });
    }
    expect(countSnapshots.every((snap) => snap.every((c) => c.field !== 'deck'))).toBe(true);
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('filters by the legacy deck name on the denormalized deck field', async () => {
    queueCounts(11, 2, 3, 9); // new = 11-2-3 = 6

    const result = await countFlashcards({ deck: 'Spanish' }, 'Test Key');

    expect(result.counts).toEqual({ total: 11, new: 6, learning: 2, mature: 3, due: 9 });
    // The deck NAME filter uses `deck` equality — the same way deck-name
    // list/due filters match legacy name-only cards. No deckId predicate.
    expect(countSnapshots).toHaveLength(4);
    for (const snap of countSnapshots) {
      expect(snap[0]).toMatchObject({ field: 'ownerId', op: '==', value: 'Test Key' });
      expect(snap[1]).toMatchObject({ field: 'deck', op: '==', value: 'Spanish' });
    }
    expect(countSnapshots.every((snap) => snap.every((c) => c.field !== 'deckId'))).toBe(true);
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('groupBy=deck counts each deck ENTITY via deck-name aggregates and derives the deck-less remainder — zero card fetches', async () => {
    // Two deck entities: Spanish (id deck-1) and French (id deck-2).
    deckDocs = [
      { id: 'deck-1', data: () => ({ name: 'Spanish' }) },
      { id: 'deck-2', data: () => ({ name: 'French' }) },
    ];
    // Whole-library bucket set: total 6, learning 0, mature 3, due 4
    // (new = 6 - 0 - 3 = 3).
    queueCounts(6, 0, 3, 4);
    // Per-deck bucket sets in deck-entity order (as the service iterates):
    // deck == 'Spanish' first (decks.get() doc order = deckDocs order):
    // total 3, learning 0, mature 2, due 2 (new = 1); then deck == 'French':
    // total 1, learning 0, mature 0, due 1 (new = 1).
    queueCounts(3, 0, 2, 2);
    queueCounts(1, 0, 0, 1);
    // deck-less remainder derived arithmetically: 6 - 3 - 1 = 2 total etc.

    const result = await countFlashcards({ groupBy: 'deck' }, 'Test Key');

    expect(result.counts.total).toBe(6);
    expect(result.counts.new).toBe(3);
    // 2 decks + a derived deck-less remainder entry (no card scans).
    expect(result.byDeck).toEqual([
      // byDeck is sorted by deck name (French < Spanish); the per-deck
      // bucket values are those queued for deck == 'French' and
      // deck == 'Spanish'.
      { deckId: 'deck-2', deck: 'French', counts: { total: 1, new: 1, learning: 0, mature: 0, due: 1 } },
      { deckId: 'deck-1', deck: 'Spanish', counts: { total: 3, new: 1, learning: 0, mature: 2, due: 2 } },
      { deckId: null, deck: null, counts: { total: 2, new: 1, learning: 0, mature: 1, due: 1 } },
    ]);
    // CRITICAL honesty checks: the flashcards collection was NEVER fetched
    // (no .get() on it), and the deck scan only read the DECKS collection
    // metadata. Every deck bucket was a `deck == <name>` equality aggregate.
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
    const deckNameAggs = countSnapshots.filter((snap) => snap.some((c) => c.field === 'deck' && c.op === '=='));
    expect(deckNameAggs).toHaveLength(8); // 4 aggregates x 2 deck entities
    expect(countSnapshots.some((snap) => snap.some((c) => c.field === 'deckId'))).toBe(false);
    // Remainder = whole minus attributed, per bucket.
    const remainder = result.byDeck![2].counts;
    expect(remainder.new).toBe(3 - 1 - 1);
    expect(remainder.mature).toBe(3 - 2 - 0);
    expect(remainder.due).toBe(4 - 2 - 1);
  });

  it('groupBy=deck omits the remainder entry when every card is attributed', async () => {
    deckDocs = [{ id: 'deck-1', data: () => ({ name: 'Spanish' }) }];
    queueCounts(3, 0, 2, 2); // whole library (new = 1)
    queueCounts(3, 0, 2, 2); // deck == 'Spanish' — same as whole

    const result = await countFlashcards({ groupBy: 'deck' }, 'Test Key');

    expect(result.byDeck).toEqual([
      { deckId: 'deck-1', deck: 'Spanish', counts: { total: 3, new: 1, learning: 0, mature: 2, due: 2 } },
    ]);
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('refuses to count when the runtime lacks count() — never falls back to fetching cards', async () => {
    // The endpoint contract is "counts without retrieving the cards": if the
    // Firestore count() aggregation is unavailable, the request MUST fail
    // loudly instead of silently paging card documents. Remove count() from
    // the query root. Override count on the collection ref AND every
    // forked stub created by makeQuery to throw.
    const countUnavailable = jest.fn(() => {
      throw new Error('count() aggregation is not available on this Firestore runtime; refusing to fall back to fetching card documents');
    });
    mockFlashcardCollectionRef.count = countUnavailable;
    // Patch the original makeQuery-created where so forked stubs also throw.
    const origWhere = mockFlashcardCollectionRef.where;
    mockFlashcardCollectionRef.where = jest.fn((...args: unknown[]) => {
      const forked = origWhere(...(args as [string, string, unknown]));
      forked.count = countUnavailable;
      return forked;
    });
    mockFlashcardCollectionRef.get.mockClear();

    await expect(countFlashcards({}, 'Test Key')).rejects.toThrow('count()');
    // No card documents were fetched in the failed attempt.
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });

  it('returns zeroed counts for an empty filtered set without groupBy', async () => {
    queueCounts(0, 0, 0, 0);
    mockFlashcardCollectionRef.get.mockClear();

    const result = await countFlashcards({ deck: 'NoSuchDeck' }, 'Test Key');

    expect(result.counts).toEqual({ total: 0, new: 0, learning: 0, mature: 0, due: 0 });
    expect(result.byDeck).toBeUndefined();
    expect(mockFlashcardCollectionRef.get).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Review Session Service queue behavior tests                        */
/* ------------------------------------------------------------------ */

/** Applies Firestore dotted field paths in the session test double. */
function mergeNested2(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur: Record<string, unknown> = out;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const next = cur[parts[i]];
        if (next && typeof next === 'object' && !Array.isArray(next)) cur[parts[i]] = { ...(next as Record<string, unknown>) };
        else cur[parts[i]] = {};
        cur = cur[parts[i]] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('Review Session Service — queue behavior', () => {
  let mockDb: any;
  let mockSessionCollectionRef: any;
  let mockSessionDocRef: any;
  let mockFlashcardCollectionRef: any;
  let mockFlashcardDocRef: any;
  /** Per-session queue records used by the mock datastore. */
  let chunkDocs: Record<string, any>;
  /** Queue-record collection facade for the mock datastore. */
  let chunkCollection: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockSessionCollectionRef = mockDb.collection('reviewSessions');
    mockSessionDocRef = {
      id: 'session-v2',
      data: jest.fn(() => undefined),
      exists: true,
      set: jest.fn(async (data: Record<string, unknown>) => { mockSessionDocRef.data.mockReturnValue(data); mockSessionDocRef.exists = true; }),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        mockSessionDocRef.data.mockReturnValue(mergeNested2(mockSessionDocRef.data() ?? {}, patch));
        mockSessionDocRef.exists = true;
      }),
      get: jest.fn(async () => mockSessionDocRef),
      collection: jest.fn(),
    };
    mockSessionDocRef.collection.mockImplementation(() => chunkCollection);
    mockSessionCollectionRef.doc.mockImplementation((id?: string) => {
      if (id === undefined || id === mockSessionDocRef.id) return mockSessionDocRef;
      return { ...mockSessionDocRef, id };
    });
    chunkDocs = {};
    chunkCollection = {
      doc: jest.fn((id: string) => {
        if (!chunkDocs[id]) {
          chunkDocs[id] = {
            id,
            exists: false,
            data: jest.fn(() => undefined),
            set: jest.fn(async (data: Record<string, unknown>) => { chunkDocs[id].data.mockReturnValue(data); chunkDocs[id].exists = true; }),
            update: jest.fn(async (patch: Record<string, unknown>) => { const cur: Record<string, unknown> = chunkDocs[id].data() ?? {}; chunkDocs[id].data.mockReturnValue({ ...cur, ...patch }); chunkDocs[id].exists = true; }),
            get: jest.fn(async () => chunkDocs[id]),
            collection: jest.fn(() => chunkCollection),
          };
        }
        return chunkDocs[id];
      }),
      orderBy: jest.fn(() => chunkCollection),
      limit: jest.fn(() => chunkCollection),
      startAt: jest.fn(() => chunkCollection),
      startAfter: jest.fn(() => chunkCollection),
      get: jest.fn(async () => ({ docs: Object.keys(chunkDocs).sort().map((k) => chunkDocs[k]) })),
    };
    mockSessionDocRef.collection = jest.fn(() => chunkCollection);
    mockSessionCollectionRef.collection = jest.fn(() => chunkCollection);
    const batchSets: Array<{ ref: any; data: Record<string, unknown> }> = [];
    mockDb.batch = jest.fn(() => ({
      set: jest.fn((ref: any, data: Record<string, unknown>) => { batchSets.push({ ref, data }); }),
      update: jest.fn(),
      commit: jest.fn(async () => {
        for (const b of batchSets) { if (b.ref.set) await b.ref.set(b.data); }
      }),
    }));
    mockDb.runTransaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        return await ref.get();
      },
      update: async (ref: any, patch: Record<string, unknown>) => ref.update(patch),
      set: async (ref: any, data: Record<string, unknown>) => ref.set(data),
      delete: async (ref: any) => ref.delete(),
    }));
    mockFlashcardCollectionRef = mockDb.collection('flashcards');
    mockFlashcardDocRef = { id: 'card-1', data: jest.fn(), exists: true, set: jest.fn(), get: jest.fn(), update: jest.fn(), ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() } };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
      const ref: any = { ...mockFlashcardDocRef, id, get: jest.fn(async () => ref) };
      return ref;
    });
    mockFlashcardCollectionRef.where.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.orderBy.mockReturnValue(mockFlashcardCollectionRef);
    mockFlashcardCollectionRef.limit.mockReturnValue(mockFlashcardCollectionRef);
    Timestamp.now.mockReturnValue(mockTimestamp(new Date('2026-08-28T00:00:00.000Z')));
  });


  function cardData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ownerId: 'Test Key',
      front: 'F',
      back: 'B',
      tags: [],
      createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
      due: mockTimestamp(new Date('2026-08-01T00:00:00Z')),
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

  /** Builds a session fixture sized for the given queue. */
  function v2SessionData(cardIds: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const limit = cardIds.length;
    return {
      ownerId: 'Test Key',
      status: 'active',
      mode: 'spaced_repetition',
      storageVersion: 2,
      requestClaimsVersion: 1,
      buildStatus: 'ready',
      limit,
      totalCount: limit,
      dueCount: limit,
      chunkCount: Math.ceil(Math.max(limit, 1) / SESSION_QUEUE_CHUNK_SIZE),
      completedChunks: 0,
      queueChunksPrefix: 'queueChunks',
      position: limit,
      deletedCount: 0,
      remainingQueueCount: limit,
      remainingCount: limit,
      currentIndex: 0,
      currentPosition: limit > 0 ? 0 : 0,
      currentChunkIndex: limit > 0 ? 0 : -1,
      reviewedCount: 0,
      truncated: false,
      continuationAvailable: false,
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
      startedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
      ...overrides,
    };
  }

  /** Creates a persisted v2 session fixture for the service tests. */
  async function seedV2Session(cardIds: string[], overrides: Record<string, unknown> = {}): Promise<void> {
    const root = v2SessionData(cardIds, overrides);
    mockSessionDocRef.data.mockReturnValue(root);
    mockSessionDocRef.exists = true;
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
    const count = Math.ceil(cardIds.length / SESSION_QUEUE_CHUNK_SIZE);
    for (let c = 0; c < count; c += 1) {
      const start = c * SESSION_QUEUE_CHUNK_SIZE;
      const items = cardIds.slice(start, start + SESSION_QUEUE_CHUNK_SIZE).map((cardId) => ({ cardId, status: 'pending' }));
      await chunkCollection.doc(String(c).padStart(10, '0')).set({
        chunkIndex: c,
        startPosition: start,
        itemCount: items.length,
        pendingCount: items.length,
        status: 'active',
        items,
      });
    }
  }

  /** Per-id card doc resolution for a card list. */
  function wireCards(cards: Array<{ id: string; front?: string }>): void {
    mockFlashcardCollectionRef.doc.mockImplementation((id: string): any => {
      const found = cards.find((c) => c.id === id);
      const ref: any = {
        id,
        exists: !!found,
        data: jest.fn(() => (found ? cardData({ front: found.front ?? found.id }) : undefined)),
        get: jest.fn(async () => ref),
        update: jest.fn(async () => undefined),
        set: jest.fn(async () => undefined),
        ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() },
      };
      return ref;
    });
  }

  it('returns the current card and its preloaded queue', async () => {
    const dueDocs = [
      { id: 'card-1', data: () => cardData({ front: 'First' }) },
      { id: 'card-2', data: () => cardData({ front: 'Second' }) },
    ];
    mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
    wireCards([
      { id: 'card-1', front: 'First' },
      { id: 'card-2', front: 'Second' },
    ]);

    const result = await startReviewSession({}, 'Test Key');

    expect(result.card!.id).toBe('card-1');
    expect(result.preloaded.map((card) => card.id)).toEqual(['card-2']);
    expect(result.queueWindow!.currentCardId).toBe('card-1');
  });

  it.each([2, '1', null])('rejects unsupported request-claim format %p without mutation after ownership check', async (version) => {
    await seedV2Session(['card-1'], { requestClaimsVersion: version });
    const rootBefore = mockSessionDocRef.data();
    const chunkBefore = chunkDocs['0000000000'].data();

    await expect(submitSessionReview('session-v2', { rating: 3, requestId: 'future-claim-format' }, 'Wrong Owner'))
      .rejects.toBeInstanceOf(ReviewSessionForbiddenError);
    await expect(submitSessionReview('session-v2', { rating: 3, requestId: 'future-claim-format' }, 'Test Key'))
      .rejects.toBeInstanceOf(ReviewSessionBuildFailedError);

    expect(mockDb.runTransaction).not.toHaveBeenCalled();
    expect(mockSessionDocRef.data()).toEqual(rootBefore);
    expect(chunkDocs['0000000000'].data()).toEqual(chunkBefore);
  });


  it('returns the bounded session window for a large queue', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 'card-' + (i + 1));
    const dueDocs = ids.map((id, i) => ({ id, data: () => cardData({ front: 'c' + (i + 1) }) }));
    mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });
    mockFlashcardCollectionRef.count = jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ data: () => ({ count: 450 }) }),
    }));
    wireCards(ids.map((id, i) => ({ id, front: 'c' + (i + 1) })));
    mockSessionDocRef.id = 'session-big';
    mockSessionCollectionRef.doc.mockReturnValue(mockSessionDocRef);

    const result = await startReviewSession({}, 'Test Key');

    expect(result.session.limit).toBe(450);
    expect(result.queueWindow!.currentPosition).toBe(0);
    expect(result.queueWindow!.cardIds[0].cardId).toBe('card-1');
  });

  it('applies FSRS and updates session state in one transaction (v2)', async () => {
    await seedV2Session(['card-1', 'card-2']);
    const card1 = cardData({ front: 'One' });
    const card2 = cardData({ front: 'Two' });
    const byId: Record<string, any> = {
      'card-1': { id: 'card-1', exists: true, data: () => card1, get: jest.fn() },
      'card-2': { id: 'card-2', exists: true, data: () => card2, get: jest.fn() },
    };
    byId['card-1'].get.mockResolvedValue(byId['card-1']);
    byId['card-2'].get.mockResolvedValue(byId['card-2']);
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => byId[id] ?? { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) });

    const transaction = {
      get: jest.fn(async (ref: any) => {
        // Route t.get by the referenced doc: session root, chunk docs, cards.
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (byId[id]) return byId[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      create: jest.fn(),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3, requestId: 'req-abc' }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.status).toBe('active');
    expect(result!.session.reviewedCount).toBe(1);
    expect(result!.session.currentIndex).toBe(1);
    expect(result!.session.remainingQueueCount).toBe(1);
    expect(result!.card!.id).toBe('card-2');
    // The card FSRS write happened exactly once.
    expect(transaction.create).toHaveBeenCalledTimes(1);
    expect(transaction.create.mock.calls[0][1]).toMatchObject({
      requestId: 'req-abc', position: 0, cardId: 'card-1', outcome: 'reviewed',
    });
    const cardWrites: any[][] = transaction.update.mock.calls.filter((c: unknown[]) => (c[0] as any).id === 'card-1');
    expect(cardWrites).toHaveLength(1);
    expect((cardWrites[0][1] as Record<string, unknown>).reviewLog).toHaveLength(1);
  });

  it('completes when the queue is exhausted', async () => {
    await seedV2Session(['card-1']);
    const card1 = cardData({ front: 'One' });
    const byId: Record<string, any> = {
      'card-1': { id: 'card-1', exists: true, data: () => card1, get: jest.fn(async () => byId['card-1']) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => byId[id] ?? { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) });

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (byId[id]) return byId[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.status).toBe('completed');
    expect(result!.session.currentIndex).toBe(1);
    expect(result!.card).toBeNull();
  });

  it('skips a deleted snapshot card without FSRS or review event', async () => {
    await seedV2Session(['card-1', 'card-2']);
    const card2 = cardData({ front: 'Two' });
    const byId: Record<string, any> = {
      'card-1': { id: 'card-1', exists: false, data: () => undefined, get: jest.fn(async () => byId['card-1']) },
      'card-2': { id: 'card-2', exists: true, data: () => card2, get: jest.fn(async () => byId['card-2']) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => byId[id]);

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (byId[id]) return byId[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.reviewedCount).toBe(0); // deleted card never counted
    expect(result!.session.deletedCount).toBe(1);
    expect(result!.session.remainingQueueCount).toBe(1);
    expect(result!.session.status).toBe('active');
    expect(result!.card!.id).toBe('card-2');
    // NO FSRS write and NO event for the deleted card.
    const cardWrites: any[][] = transaction.update.mock.calls.filter((c: unknown[]) => (c[0] as any).id === 'card-1');
    expect(cardWrites).toHaveLength(0);
    expect(transaction.set).not.toHaveBeenCalled();
  });

  it('an idempotent retry with the same requestId does not apply twice', async () => {
    await seedV2Session(['card-1', 'card-2'], { currentIndex: 1, reviewedCount: 1, remainingQueueCount: 1, lastRequestId: 'req-x' });
    // The original request's result is recorded for position 0.
    const items = [
      { cardId: 'card-1', status: 'reviewed', rating: 3, requestId: 'req-x' },
      { cardId: 'card-2', status: 'pending' },
    ];
    chunkCollection.doc('0000000000').set({ chunkIndex: 0, startPosition: 0, itemCount: 2, pendingCount: 1, status: 'active', items });
    mockSessionDocRef.data.mockReturnValue(v2SessionData(['card-1', 'card-2'], { currentIndex: 1, reviewedCount: 1, remainingQueueCount: 1, lastRequestId: 'req-x' }));
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    const card2 = cardData({ front: 'Two' });
    const byId: Record<string, any> = {
      'card-1': { id: 'card-1', exists: true, data: () => cardData(), get: jest.fn(async () => byId['card-1']) },
      'card-2': { id: 'card-2', exists: true, data: () => card2, get: jest.fn(async () => byId['card-2']) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => byId[id]);

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (byId[id]) return byId[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    // Retrying that request returns its recorded result without applying it twice.
    const result = await submitSessionReview('session-v2', { rating: 3, requestId: 'req-x', expectedPosition: 0 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.requestId).toBe('req-x');
    // No writes at all (idempotent no-op).
    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.set).not.toHaveBeenCalled();
  });

  it('surfaces queue persistence failures and records failed status', async () => {
    mockSessionDocRef.id = 'session-fail';
    mockSessionCollectionRef.doc.mockReturnValue(mockSessionDocRef);
    mockSessionDocRef.set.mockResolvedValue(undefined);
    // Chunk doc .set() throws (simulating a mid-build write failure).
    chunkCollection.doc = jest.fn((id: string) => {
      if (!chunkDocs[id]) {
        chunkDocs[id] = {
          id, exists: false, data: jest.fn(() => undefined),
          set: jest.fn(async () => { throw new Error('chunk write failed'); }),
          update: jest.fn(async () => undefined),
          get: jest.fn(async () => chunkDocs[id]),
        };
      }
      return chunkDocs[id];
    });
    const dueDocs = [{ id: 'card-1', data: () => cardData() }];
    mockFlashcardCollectionRef.get.mockResolvedValue({ docs: dueDocs, empty: false });

    await expect(startReviewSession({}, 'Test Key')).rejects.toThrow('chunk write failed');
    expect((mockSessionDocRef.data() as Record<string, unknown>).status).toBe('failed');
  });
  it('rating a later position leaves the first live card current', async () => {
    await seedV2Session(['card-1', 'card-2', 'card-3']);
    const cards: Record<string, any> = {};
    for (const id of ['card-1', 'card-2', 'card-3']) {
      const ref = { id, exists: true, data: () => cardData({ front: id }), get: jest.fn() };
      ref.get.mockResolvedValue(ref);
      cards[id] = ref;
    }
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => cards[id] ?? { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) });

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (cards[id]) return cards[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    // Claim card-2 (position 1) out of order with a position claim.
    const result = await submitSessionReview('session-v2', { rating: 3, expectedPosition: 1 }, 'Test Key');

    expect(result).not.toBeNull();
    // currentIndex stays at the FIRST live unrated card (card-1, position 0).
    expect(result!.session.currentIndex).toBe(0);
    expect(result!.session.reviewedCount).toBe(1);
    expect(result!.session.remainingQueueCount).toBe(2);
    expect(result!.card!.id).toBe('card-1');
  });

  it('rejects a request for a position claimed by a different requestId', async () => {
    await seedV2Session(['card-1', 'card-2']);
    // Position 0 already reviewed by req-other.
    const items = [
      { cardId: 'card-1', status: 'reviewed', rating: 3, requestId: 'req-other' },
      { cardId: 'card-2', status: 'pending' },
    ];
    await chunkCollection.doc('0000000000').set({ chunkIndex: 0, startPosition: 0, itemCount: 2, pendingCount: 1, status: 'active', items });
    mockSessionDocRef.data.mockReturnValue(v2SessionData(['card-1', 'card-2']));
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
    const card2 = { id: 'card-2', exists: true, data: () => cardData(), get: jest.fn() };
    card2.get.mockResolvedValue(card2);
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => (id === 'card-2' ? card2 : { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) }));

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    // A NEW requestId claiming the already-claimed position 0 is a stale 409 —
    // the position is owned by req-other and can never be rated again.
    await expect(submitSessionReview('session-v2', { rating: 3, requestId: 'req-new', expectedPosition: 0 }, 'Test Key'))
      .rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('returns the current card and a bounded queue window', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 'card-' + (i + 1));
    await seedV2Session(ids);
    const cardRefs: Record<string, any> = {};
    for (const id of ids) {
      const ref = { id, exists: true, data: () => cardData({ front: id }), get: jest.fn() };
      ref.get.mockResolvedValue(ref);
      cardRefs[id] = ref;
    }
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => cardRefs[id] ?? { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) });
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    const result = await getReviewSession('session-v2', 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.currentPosition).toBe(0);
    expect(result!.queueWindow!.cardIds[0].cardId).toBe('card-1');
    // Bounded: never the full 250-id queue.
    expect(result!.queueWindow!.cardIds.length).toBeLessThanOrEqual(1 + 100);
    expect(result!.card!.id).toBe('card-1');
    expect(result!.preloaded.length).toBeLessThanOrEqual(100);
  });
  it('skips a deleted queue head and returns the next live card at its stable position', async () => {
    await seedV2Session(['card-1', 'card-2', 'card-3']);
    const cards: Record<string, any> = {
      'card-1': { id: 'card-1', exists: false, data: () => undefined },
      'card-2': { id: 'card-2', exists: true, data: () => cardData({ front: 'Second' }) },
      'card-3': { id: 'card-3', exists: true, data: () => cardData({ front: 'Third' }) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
      const data = cards[id];
      return { id, exists: data?.exists ?? false, data: () => data?.data(), get: jest.fn(async function (this: any) { return this; }) };
    });
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    const result = await getReviewSession('session-v2', 'Test Key');

    expect(result!.card!.id).toBe('card-2');
    expect(result!.currentPosition).toBe(1);
    expect(result!.queueWindow!.cardIds[0]).toEqual({ cardId: 'card-2', position: 1 });
    expect(result!.preloaded.map((card) => ({ id: card.id, position: card.position }))).toEqual([{ id: 'card-3', position: 2 }]);
    expect(result!.session).toMatchObject({ currentIndex: 1, currentPosition: 1, deletedCount: 1, remainingQueueCount: 2 });
  });

  it('advances through deleted cards to the live tail', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `card-${i + 1}`);
    await seedV2Session(ids);
    const liveIds = new Set(ids.slice(400));
    const cards = new Map<string, any>();
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
      let ref = cards.get(id);
      if (!ref) {
        const exists = liveIds.has(id);
        ref = { id, exists, data: () => (exists ? cardData({ front: id }) : undefined), get: jest.fn(async function (this: any) { return this; }) };
        cards.set(id, ref);
      }
      return ref;
    });
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    const result = await getReviewSession('session-v2', 'Test Key');

    expect(result!.session).toMatchObject({ status: 'active', currentIndex: 400, currentPosition: 400, deletedCount: 400, remainingQueueCount: 50 });
    expect(result!.card!.id).toBe('card-401');
    expect(result!.currentPosition).toBe(400);
    expect(result!.queueWindow!.cardIds[0]).toEqual({ cardId: 'card-401', position: 400 });
    expect(result!.preloaded[0]).toMatchObject({ id: 'card-402', position: 401 });
  });

  it('completes when all queued cards are deleted', async () => {
    const ids = ['card-1', 'card-2', 'card-3'];
    await seedV2Session(ids);
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => ({
      id, exists: false, data: () => undefined, get: jest.fn(async function (this: any) { return this; }),
    }));
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    const result = await getReviewSession('session-v2', 'Test Key');

    expect(result!.session).toMatchObject({ status: 'completed', currentIndex: 3, deletedCount: 3, remainingQueueCount: 0 });
    expect(result!.card).toBeNull();
    expect(result!.currentPosition).toBeNull();
    expect(result!.queueWindow).toEqual({ currentPosition: null, currentCardId: null, cardIds: [] });
  });


  it('getReviewSession rejects a session whose queue build failed (typed 409)', async () => {
    mockSessionDocRef.data.mockReturnValue(v2SessionData(['card-1'], {
      status: 'failed',
      buildFailed: true,
      buildError: 'chunk write failed',
      endedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
    }));
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);

    await expect(getReviewSession('session-v2', 'Test Key')).rejects.toBeInstanceOf(ReviewSessionBuildFailedError);
  });

  it('continues a session with the same queue and lineage', async () => {
    // The completed prior session has one reviewed card; Continue returns it
    // in the new session's active queue without an unrelated fresh selection.
    const priorChunkRef = {
      id: '0000000000', exists: true,
      data: () => ({
        chunkIndex: 0, startPosition: 0, itemCount: 1, pendingCount: 0, status: 'completed',
        items: [{ cardId: 'card-1', status: 'reviewed', rating: 3, requestId: 'req-old' }],
      }),
      get: jest.fn(async function (this: any) { return this; }),
    };
    const priorCollection = {
      doc: jest.fn(() => priorChunkRef),
      orderBy: jest.fn(),
      limit: jest.fn(),
      get: jest.fn(async () => ({ docs: [priorChunkRef] })),
    };
    const newDocRef: any = {
      ...mockSessionDocRef, id: 'session-continue',
      data: jest.fn(() => undefined),
      set: jest.fn(async (d: Record<string, unknown>) => { newDocRef.data.mockReturnValue(d); }),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        const cur: Record<string, unknown> = newDocRef.data() ?? {};
        newDocRef.data.mockReturnValue({ ...cur, ...patch });
      }),
      get: jest.fn(async () => newDocRef),
      collection: jest.fn(() => ({ doc: jest.fn((id: string) => {
        if (!chunkDocs[id]) {
          chunkDocs[id] = { id, exists: false, data: jest.fn(() => undefined), set: jest.fn(async (d: Record<string, unknown>) => { chunkDocs[id].data.mockReturnValue(d); chunkDocs[id].exists = true; }), update: jest.fn(async () => undefined), get: jest.fn(async () => chunkDocs[id]) };
        }
        return chunkDocs[id];
      }) })),
    };
    mockSessionCollectionRef.doc.mockImplementation((id: string) => {
      if (id === 'session-old') {
        return {
          ...mockSessionDocRef,
          id: 'session-old',
          exists: true,
          data: () => ({
            ownerId: 'Test Key', status: 'completed', mode: 'spaced_repetition',
            storageVersion: 2, buildStatus: 'ready', limit: 1, dueCount: 1, chunkCount: 1, completedChunks: 1,
            queueChunksPrefix: 'queueChunks', position: 1, deletedCount: 0, remainingQueueCount: 0,
            currentIndex: 1, currentPosition: 1, currentChunkIndex: 1, reviewedCount: 1,
            truncated: false, continuationAvailable: false,
            source: { type: 'due' },
            ratingCounts: { again: 0, hard: 0, good: 1, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 } },
            startedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
            endedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
          }),
          get: jest.fn(async function (this: any) { return this; }),
          collection: jest.fn(() => priorCollection),
        };
      }
      return newDocRef;
    });
    // Card doc for the response read.
    const card1 = { id: 'card-1', exists: true, data: () => cardData(), get: jest.fn(async function (this: any) { return this; }) };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => (id === 'card-1' ? card1 : { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) }));

    const result = await startReviewSession({ repeatSessionId: 'session-old' }, 'Test Key');

    // The new session exposes the same total and provenance.
    expect(result.session.limit).toBe(1);
    expect(result.session.totalCount).toBe(1);
    expect(result.session.source).toEqual({ type: 'due' });
    expect(result.session.repeatSessionId).toBe('session-old');
    // The NEW session is active with its first card.
    expect(result.session.status).toBe('active');
    expect(result.session.currentPosition).toBe(0);
    expect(result.card!.id).toBe('card-1');
  });

  it('reviews an owned session without a storage version', async () => {
    // Existing sessions without a version continue to use their stored queue.
    mockSessionDocRef.data.mockReturnValue({
      ownerId: 'Test Key', status: 'active', mode: 'spaced_repetition',
      limit: 1, dueCount: 1, cardIds: ['card-1'], currentIndex: 0,
      reviewedCount: 0, truncated: false, continuationAvailable: false,
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
      startedAt: mockTimestamp(new Date('2026-08-28T00:00:00.000Z')),
      // NO storageVersion field — a pre-v2 document.
    });
    mockSessionDocRef.get = jest.fn().mockResolvedValue(mockSessionDocRef);
    mockSessionDocRef.update = jest.fn().mockResolvedValue(undefined);
    const card1 = { id: 'card-1', exists: true, data: () => cardData(), get: jest.fn() };
    card1.get.mockResolvedValue(card1);
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => (id === 'card-1' ? card1 : { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) }));

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (id === 'card-1') return card1;
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      create: jest.fn(),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3, requestId: 'req-legacy' }, 'Test Key');

    expect(result).toMatchObject({
      session: {
        status: 'completed',
        currentIndex: 1,
        reviewedCount: 1,
        reviewedCardIds: ['card-1'],
        processedRequestIds: ['req-legacy'],
      },
      card: null,
      requestId: 'req-legacy',
    });
    expect(transaction.update).toHaveBeenCalledWith(card1, expect.objectContaining({
      state: expect.any(Number),
      reps: expect.any(Number),
      updatedAt: expect.anything(),
      reviewLog: expect.any(Array),
    }));
    const sessionUpdate: any[] | undefined = transaction.update.mock.calls.find((call: unknown[]) => call[0] === mockSessionDocRef);
    expect(sessionUpdate?.[1]).toMatchObject({
      currentIndex: 1,
      status: 'completed',
      reviewedCardIds: ['card-1'],
      processedRequestIds: ['req-legacy'],
    });
  });



  it('v2 expectedCardId WITHOUT expectedPosition accepts ONLY the current authoritative card (409 on any other)', async () => {
    await seedV2Session(['card-1', 'card-2', 'card-3']);
    const cards: Record<string, any> = {};
    for (const id of ['card-1', 'card-2', 'card-3']) {
      const ref = { id, exists: true, data: () => cardData({ front: id }), get: jest.fn() };
      ref.get.mockResolvedValue(ref);
      cards[id] = ref;
    }
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => cards[id] ?? { id, exists: false, data: () => undefined, get: jest.fn(async () => ({ exists: false })) });

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (cards[id]) return cards[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    // The current card is card-1: claiming card-2 (a later card) WITHOUT an
    // expectedPosition is REJECTED — v2 never scans ahead for out-of-order
    // cards without an explicit position.
    await expect(submitSessionReview('session-v2', { rating: 3, expectedCardId: 'card-2' }, 'Test Key'))
      .rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('skips a deleted next card and returns the following live card', async () => {
    // card-2 (position 1, the immediate next after card-1) was deleted.
    await seedV2Session(['card-1', 'card-2', 'card-3']);
    const cards: Record<string, any> = {
      'card-1': { id: 'card-1', exists: true, data: () => cardData(), get: jest.fn(async function (this: any) { return this; }) },
      'card-2': { id: 'card-2', exists: false, data: () => undefined, get: jest.fn(async function (this: any) { return this; }) },
      'card-3': { id: 'card-3', exists: true, data: () => cardData({ front: 'Three' }), get: jest.fn(async function (this: any) { return this; }) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => cards[id]);

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (cards[id]) return cards[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.reviewedCount).toBe(1);
    expect(result!.session.deletedCount).toBe(1); // card-2 skip persisted
    expect(result!.session.remainingQueueCount).toBe(1);
    expect(result!.session.currentIndex).toBe(2); // advanced past deleted card-2
    expect(result!.card!.id).toBe('card-3');
  });

  it('stays active when deleted cards are followed by live cards', async () => {
    // The response must not report completion while live cards remain.
    const ids = Array.from({ length: 450 }, (_, i) => 'card-' + (i + 1));
    await seedV2Session(ids);
    const liveChunk2 = new Set(ids.slice(400));
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
      const live = liveChunk2.has(id);
      const ref = {
        id, exists: live,
        data: () => (live ? cardData({ front: id }) : undefined),
        get: jest.fn(async function (this: any) { return this; }),
      };
      return ref;
    });

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (liveChunk2.has(id)) return { id, exists: true, data: () => cardData({ front: id }) };
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.status).toBe('active');
    expect(result!.session.remainingQueueCount).toBe(50);
    expect(result!.session.deletedCount).toBe(400);
    // currentPosition advanced toward the chunk after the scanned pair
    // (chunk 2), never marked exhausted.
    expect(result!.session.currentIndex).toBeGreaterThanOrEqual(400);
    expect(result!.session.currentIndex).toBeLessThan(450);
  });

  it('returns the current live card after deleted cards are skipped', async () => {
    // The queue has 400 deleted cards followed by 50 live cards.
    const ids = Array.from({ length: 450 }, (_, i) => 'card-' + (i + 1));
    await seedV2Session(ids);
    const liveChunk2 = new Set(ids.slice(400));
    const cardDoc = (id: string, live: boolean) => ({
      id, exists: live,
      data: () => (live ? cardData({ front: id }) : undefined),
      get: jest.fn(async function (this: any) { return this; }),
    });
    const docByCard: Record<string, any> = {};
    for (const id of ids) docByCard[id] = cardDoc(id, liveChunk2.has(id));
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => docByCard[id] ?? cardDoc(id, false));

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (docByCard[id]) return docByCard[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    expect(result!.session.status).toBe('active');
    expect(result!.session.remainingQueueCount).toBe(50);
    // The response includes the first live card after skipping deleted cards.
    expect(result!.card).not.toBeNull();
    expect(result!.card!.id).toBe('card-401');
    expect(result!.currentPosition).toBe(400);
    expect(result!.preloaded.length).toBeGreaterThan(0);
    expect(result!.preloaded[0].position).toBe(401);
  });

  it('completes after the final pending card is skipped', async () => {
    await seedV2Session(['card-1', 'card-2']);
    const cards: Record<string, any> = {
      'card-1': { id: 'card-1', exists: true, data: () => cardData(), get: jest.fn(async function (this: any) { return this; }) },
      // card-2 is deleted, so the queue completes after skipping it.
      'card-2': { id: 'card-2', exists: false, data: () => undefined, get: jest.fn(async function (this: any) { return this; }) },
    };
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => cards[id]);

    const transaction = {
      get: jest.fn(async (ref: any) => {
        if (ref === mockSessionDocRef) return mockSessionDocRef;
        const id = ref && ref.id;
        if (chunkDocs[id]) return chunkDocs[id];
        if (cards[id]) return cards[id];
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(transaction));

    const result = await submitSessionReview('session-v2', { rating: 3 }, 'Test Key');

    expect(result).not.toBeNull();
    // card-1 reviewed + card-2 deleted skip: remainingQueueCount 0 -> completed.
    expect(result!.session.status).toBe('completed');
    expect(result!.session.remainingQueueCount).toBe(0);
  });

  it('an allowlist above SESSION_MAX_ALLOWLIST_IDS is REJECTED with a clear 400 (never truncated)', async () => {
    const many = Array.from({ length: SESSION_MAX_ALLOWLIST_IDS + 1 }, (_, i) => 'card-' + (i + 1));
    // No card docs need to exist: the cap check happens before any fetch.
    await expect(startReviewSession({ cardIds: many }, 'Test Key'))
      .rejects.toBeInstanceOf(ReviewSessionSelectionTooLargeError);
    // Rejection occurs before creating a session.
    expect(mockSessionDocRef.set).not.toHaveBeenCalled();
  });

  it('preserves due order and reports a missing card in a large allowlist', async () => {
    // 750 explicit IDs include every card; a missing ID must still fail.
    const ids = Array.from({ length: 750 }, (_, i) => 'card-' + String(i + 1).padStart(4, '0'));
    // Assign due: later ids get EARLIER due so the sort must reorder by due.
    const dueMs = (i: number) => 1750000000000 + (ids.length - i); // card-0750 earliest
    const byId: Record<string, { exists: boolean; id: string; data: () => Record<string, unknown> }> = {};
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      byId[id] = { exists: true, id, data: () => cardData({ due: mockTimestamp(new Date(dueMs(i))) }) };
    }
    mockFlashcardCollectionRef.doc.mockImplementation((id: string) => {
      const found = byId[id];
      if (found) return { id, get: jest.fn(async () => found) };
      return { id, exists: false, data: () => ({}), get: jest.fn(async function (this: any) { return this; }) };
    });
    mockSessionDocRef.id = 'session-allow750';
    mockSessionCollectionRef.doc.mockReturnValue(mockSessionDocRef);

    const result = await startReviewSession({ cardIds: ids }, 'Test Key');

    expect(result.session.totalCount).toBe(750);
    expect(result.session.limit).toBe(750);
    // The earliest-due card appears first in the returned queue window.
    expect(result.queueWindow!.cardIds[0]).toEqual({ cardId: 'card-0750', position: 0 });

    // Missing ID still returns the documented not-found error.
    await expect(startReviewSession({ cardIds: ['card-0001', 'missing-card'] }, 'Test Key'))
      .rejects.toThrow('Card not found: missing-card');
  });
});

/* ------------------------------------------------------------------ */
/* Cross-owner isolation (multi-tenant)                                */
/*                                                                     */
/* Every owner-scoped service op must never read/write/leak another    */
/* owner's (or an ownerless legacy) document when called with an       */
/* ownerId. The production handler layer ALWAYS passes a verified      */
/* ownerId; these tests lock the service contract for that path.       */
/* ------------------------------------------------------------------ */

describe('Multi-tenant isolation (owner-scoped calls)', () => {
  let mockDb: any;
  let mockCards: any;
  let mockCardDoc: any;
  let mockDecks: any;
  let mockDeckDoc: any;
  let mockSessions: any;
  let mockSessionDoc: any;
  let mockEvents: any;
  let mockEventDoc: any;

  const OWNER_A = 'auth0|user-a';
  const OWNER_B = 'auth0|user-b';

  /** A document stub whose get() returns itself (readable) with owner data. */
  function ownedDoc(ownerId: string | undefined, extra: Record<string, unknown> = {}) {
    const data = { ownerId, front: 'F', back: 'B', tags: [], createdAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')), updatedAt: mockTimestamp(new Date('2026-08-01T00:00:00Z')), due: mockTimestamp(new Date('2026-08-01T00:00:00Z')), state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [], ...extra };
    const doc: any = {
      id: 'doc-1', exists: ownerId !== '__missing__', data: jest.fn(() => data),
      set: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined), get: jest.fn(),
    };
    doc.get.mockResolvedValue(doc);
    return doc;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    const { getFirestore } = require('firebase-admin/firestore');
    mockDb = getFirestore();
    mockCards = mockDb.collection('flashcards');
    mockCardDoc = ownedDoc(OWNER_A);
    mockCards.doc.mockImplementation(() => mockCardDoc);
    // Query root returns the collection itself (self-chaining) with empty results.
    mockCards.where = jest.fn(() => mockCards);
    mockCards.orderBy = jest.fn(() => mockCards);
    mockCards.limit = jest.fn(() => mockCards);
    mockCards.startAfter = jest.fn(() => mockCards);
    mockCards.select = jest.fn(() => mockCards);
    mockCards.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
    mockCards.count = undefined;

    mockDecks = mockDb.collection('decks');
    mockDeckDoc = ownedDoc(OWNER_A, { name: 'Spanish' });
    mockDecks.doc.mockImplementation(() => mockDeckDoc);
    mockDecks.where = jest.fn(() => mockDecks);
    mockDecks.orderBy = jest.fn(() => mockDecks);
    mockDecks.limit = jest.fn(() => mockDecks);
    mockDecks.startAfter = jest.fn(() => mockDecks);
    mockDecks.get = jest.fn().mockResolvedValue({ docs: [], empty: true });

    mockSessions = mockDb.collection('reviewSessions');
    mockSessionDoc = ownedDoc(OWNER_A, { status: 'active', mode: 'spaced_repetition', limit: 1, dueCount: 1, cardIds: ['card-1'], currentIndex: 0, reviewedCount: 0, truncated: false, continuationAvailable: false, ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } }, startedAt: mockTimestamp(new Date('2026-08-28T00:00:00Z')) });
    mockSessions.doc.mockImplementation(() => mockSessionDoc);
    mockSessions.where = jest.fn(() => mockSessions);
    mockSessions.orderBy = jest.fn(() => mockSessions);
    mockSessions.limit = jest.fn(() => mockSessions);
    mockSessions.get = jest.fn().mockResolvedValue({ docs: [], empty: true });

    mockEvents = mockDb.collection('reviewEvents');
    mockEventDoc = ownedDoc(OWNER_A);
    mockEvents.doc.mockImplementation(() => mockEventDoc);
    mockEvents.where = jest.fn(() => mockEvents);
    mockEvents.orderBy = jest.fn(() => mockEvents);
    mockEvents.limit = jest.fn(() => mockEvents);
    mockEvents.startAfter = jest.fn(() => mockEvents);
    mockEvents.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
    mockEvents.count = () => ({ get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }) });
  });

  describe('flashcards', () => {
    it('getFlashcard returns null for another owner', async () => {
      mockCardDoc.data.mockReturnValue({ ...mockCardDoc.data(), ownerId: OWNER_B });
      expect(await getFlashcard('doc-1', OWNER_A)).toBeNull();
    });

    it('updateFlashcard returns null for another owner (no write)', async () => {
      mockCardDoc.data.mockReturnValue({ ...mockCardDoc.data(), ownerId: OWNER_B });
      const result = await updateFlashcard('doc-1', { front: 'Hacked' }, OWNER_A);
      expect(result).toBeNull();
      expect(mockCardDoc.update).not.toHaveBeenCalled();
    });

    it('deleteFlashcard returns false for another owner (no delete)', async () => {
      mockCardDoc.data.mockReturnValue({ ...mockCardDoc.data(), ownerId: OWNER_B });
      expect(await deleteFlashcard('doc-1', OWNER_A)).toBe(false);
      expect(mockCardDoc.delete).not.toHaveBeenCalled();
    });

    it('reviewFlashcard returns null for another owner (no event write)', async () => {
      mockCardDoc.data.mockReturnValue({ ...mockCardDoc.data(), ownerId: OWNER_B });
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({
        get: jest.fn(async () => mockCardDoc), update: jest.fn(), set: jest.fn(),
      }));
      const result = await reviewFlashcard('doc-1', { rating: 3 }, OWNER_A);
      expect(result).toBeNull();
    });

    it('bulkDeleteFlashcards skips cards owned by another owner (no delete)', async () => {
      const otherOwnerCard = ownedDoc(OWNER_B);
      mockCards.doc.mockImplementation(() => otherOwnerCard);
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        const t = { get: jest.fn(async (_ref: unknown) => otherOwnerCard), delete: jest.fn() };
        return fn(t);
      });
      const result = await bulkDeleteFlashcards({ ids: ['doc-1'] }, OWNER_A);
      expect(result.deletedIds).toEqual([]);
    });

    it('listFlashcards scopes the query to the caller ownerId', async () => {
      mockCards.orderBy = jest.fn(() => mockCards);
      mockCards.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
      await listFlashcards({}, OWNER_A);
      expect(mockCards.where).toHaveBeenCalledWith('ownerId', '==', OWNER_A);
    });
 
    it('listFlashcards applies the deckId filter within the caller owner scope', async () => {
      await listFlashcards({ deckId: 'deck-1' }, OWNER_A);
      expect(mockCards.where).toHaveBeenNthCalledWith(1, 'ownerId', '==', OWNER_A);
      expect(mockCards.where).toHaveBeenNthCalledWith(2, 'deckId', '==', 'deck-1');
    });
  });


  describe('review sessions', () => {
    it('getReviewSession forbids another owner (403)', async () => {
      mockSessionDoc.data.mockReturnValue({ ...mockSessionDoc.data(), ownerId: OWNER_B });
      await expect(getReviewSession('session-1', OWNER_A)).rejects.toBeInstanceOf(ReviewSessionForbiddenError);
    });

    it('endReviewSession forbids another owner (no write)', async () => {
      mockSessionDoc.data.mockReturnValue({ ...mockSessionDoc.data(), ownerId: OWNER_B });
      mockDb.runTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({
        get: jest.fn(async () => mockSessionDoc), update: jest.fn(), set: jest.fn(),
      }));
      await expect(endReviewSession('session-1', OWNER_A)).rejects.toBeInstanceOf(ReviewSessionForbiddenError);
    });
  });

  describe('tag/ownership scoping', () => {
    it('listTags scopes the scan to the caller ownerId', async () => {
      mockCards.orderBy = jest.fn(() => mockCards);
      mockCards.get = jest.fn().mockResolvedValue({ docs: [], empty: true });
      await listTags({}, OWNER_A);
      expect(mockCards.where).toHaveBeenCalledWith('ownerId', '==', OWNER_A);
    });
  });
});

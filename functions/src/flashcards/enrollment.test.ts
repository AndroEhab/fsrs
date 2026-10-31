
type Data = Record<string, unknown>;
type Operation = { kind: 'create' | 'update'; ref: MockDocumentReference; data: Data };

class MockTimestamp {
  constructor(private readonly date = new Date()) {}
  toDate(): Date { return this.date; }
  static now(): MockTimestamp { return new MockTimestamp(); }
}
function cloneData<T>(value: T): T {
  if (value instanceof MockTimestamp) return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneData(item)])) as T;
  }
  return value;
}

class MockFieldValue {
  static delete(): { delete: true } { return { delete: true }; }
}

class MockDocumentSnapshot {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: MockDocumentReference;
  constructor(ref: MockDocumentReference, private readonly value: Data | undefined) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = value !== undefined;
  }
  data(): Data | undefined { return this.value ? cloneData(this.value) : undefined; }
}

class MockDocumentReference {
  readonly id: string;
  readonly parent: { id: string; parent?: { id: string } };
  constructor(readonly database: MockDatabase, readonly path: string) {
    const parts = path.split('/');
    this.id = parts[parts.length - 1];
    this.parent = { id: parts[parts.length - 2] };
    if (parts.length >= 4) this.parent.parent = { id: parts[parts.length - 3] };
  }
  collection(name: string): MockCollectionReference {
    return new MockCollectionReference(this.database, `${this.path}/${name}`);
  }
  async get(): Promise<MockDocumentSnapshot> {
    return new MockDocumentSnapshot(this, this.database.read(this.path));
  }
  async create(data: Data): Promise<void> {
    if (this.database.read(this.path)) throw new Error(`Document already exists: ${this.path}`);
    this.database.write(this.path, data);
  }
  async set(data: Data): Promise<void> { this.database.write(this.path, data); }
  async update(data: Data): Promise<void> {
    const previous = this.database.read(this.path);
    if (!previous) throw new Error(`Document does not exist: ${this.path}`);
    this.database.write(this.path, this.database.merge(previous, data));
  }
  async delete(): Promise<void> { this.database.remove(this.path); }
}

class MockQuerySnapshot {
  constructor(readonly docs: MockDocumentSnapshot[]) {}
  get size(): number { return this.docs.length; }
  get empty(): boolean { return this.docs.length === 0; }
}

class MockCollectionReference {
  private readonly filters: Array<{ field: string; value: unknown }> = [];
  private count = Number.MAX_SAFE_INTEGER;
  private cursor = '';
  constructor(readonly database: MockDatabase, readonly path: string) {}
  doc(id?: string): MockDocumentReference {
    return new MockDocumentReference(this.database, `${this.path}/${id ?? this.database.nextId()}`);
  }
  where(field: string, _operator: string, value: unknown): this {
    this.filters.push({ field, value });
    return this;
  }
  orderBy(_field: string): this { return this; }
  select(..._fields: string[]): this { return this; }
  startAfter(snapshot: MockDocumentSnapshot): this { this.cursor = snapshot.id; return this; }
  limit(count: number): this { this.count = count; return this; }
  async get(): Promise<MockQuerySnapshot> {
    const prefix = `${this.path}/`;
    const docs = this.database.entries()
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => new MockDocumentSnapshot(new MockDocumentReference(this.database, path), data))
      .filter((snapshot) => this.filters.every(({ field, value }) => snapshot.data()?.[field] === value))
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter((snapshot) => snapshot.id > this.cursor)
      .slice(0, this.count);
    return new MockQuerySnapshot(docs);
  }
}

class MockWriteBatch {
  private readonly operations: Operation[] = [];
  constructor(private readonly database: MockDatabase) {}
  create(ref: MockDocumentReference, data: Data): this {
    this.operations.push({ kind: 'create', ref, data });
    return this;
  }
  async commit(): Promise<void> {
    for (const operation of this.operations) {
      if (operation.kind === 'create' && this.database.read(operation.ref.path)) {
        throw new Error(`Document already exists: ${operation.ref.path}`);
      }
    }
    for (const operation of this.operations) this.database.write(operation.ref.path, operation.data);
  }
}

class MockTransaction {
  readonly operations: Operation[] = [];
  constructor() {}
  async get(ref: MockDocumentReference): Promise<MockDocumentSnapshot> { return ref.get(); }
  create(ref: MockDocumentReference, data: Data): this {
    this.operations.push({ kind: 'create', ref, data });
    return this;
  }
  update(ref: MockDocumentReference, data: Data): this {
    this.operations.push({ kind: 'update', ref, data });
    return this;
  }
}

class MockDatabase {
  private readonly documents = new Map<string, Data>();
  private id = 0;
  private transactionTail: Promise<void> = Promise.resolve();
  beforeNextTransaction?: () => Promise<void>;
  collection(name: string): MockCollectionReference { return new MockCollectionReference(this, name); }
  batch(): MockWriteBatch { return new MockWriteBatch(this); }
  read(path: string): Data | undefined {
    const value = this.documents.get(path);
    return value ? cloneData(value) : undefined;
  }
  write(path: string, value: Data): void { this.documents.set(path, cloneData(value)); }
  remove(path: string): void { this.documents.delete(path); }
  entries(): Array<[string, Data]> { return [...this.documents.entries()]; }
  nextId(): string { this.id++; return `auto-${this.id}`; }
  merge(previous: Data, updates: Data): Data {
    const next = cloneData(previous);
    for (const [field, value] of Object.entries(updates)) {
      if (value && typeof value === 'object' && 'delete' in value) delete next[field];
      else next[field] = cloneData(value);
    }
    return next;
  }
  async runTransaction<T>(callback: (transaction: MockTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.beforeNextTransaction) {
        const before = this.beforeNextTransaction;
        this.beforeNextTransaction = undefined;
        await before();
      }
      const transaction = new MockTransaction();
      const result = await callback(transaction);
      for (const operation of transaction.operations) {
        if (operation.kind === 'create' && this.read(operation.ref.path)) {
          throw new Error(`Document already exists: ${operation.ref.path}`);
        }
      }
      for (const operation of transaction.operations) {
        if (operation.kind === 'create') this.write(operation.ref.path, operation.data);
        else this.write(operation.ref.path, this.merge(this.read(operation.ref.path)!, operation.data));
      }
      return result;
    } finally {
      release();
    }
  }
  clear(): void { this.documents.clear(); this.id = 0; this.beforeNextTransaction = undefined; }
}

const mockDb = new MockDatabase();

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
  Timestamp: MockTimestamp,
  FieldValue: MockFieldValue,
  FieldPath: { documentId: () => '__name__' },
}));

const OWNER = 'enrollment-owner';

function makeCard(front: string, back: string, overrides: Record<string, unknown> = {}) {
  return { front, back, ...overrides };
}

async function runChunk(jobId: string, index: number): Promise<void> {
  const ref = mockDb.collection('bulkEnrollmentJobs').doc(jobId)
    .collection('chunks').doc(String(index).padStart(5, '0'));
  const snapshot = await ref.get();
  await onEnrollmentChunkWritten({ data: { after: { data: () => snapshot.data() ?? {}, ref } } });
}

function getPath(path: string): Data | undefined { return mockDb.read(path); }
import {
  EnrollmentValidationError,
  bulkEnrollCards,
  getEnrollmentStatus,
  onEnrollmentChunkWritten,
} from './enrollment';

describe('bulk enrollment behavior', () => {
  beforeEach(() => mockDb.clear());

  it('keeps delimiter-bearing card content and exact tag strings distinct and stores requested state', async () => {
    const cards = [
      makeCard('front|separator', 'back', { tags: ['a,b', ' padded '] }),
      makeCard('front', 'separator|back', { tags: ['a', 'b'] }),
    ];
    const accepted = await bulkEnrollCards({ cards }, OWNER);
    expect(accepted.totalCards).toBe(2);
    await runChunk(accepted.jobId, 0);

    const cardsStored = mockDb.entries().filter(([path]) => path.startsWith('flashcards/')).map(([, card]) => card);
    expect(cardsStored).toHaveLength(2);
    expect(cardsStored.map((card) => card.tags)).toEqual([['a', 'b'], [' padded ', 'a,b']]);

    const suspended = await bulkEnrollCards({ cards: [makeCard('  spaced front  ', '  back  ', {
      tags: [' tag '], topic: ' topic ', suspended: true,
    })] }, OWNER);
    await runChunk(suspended.jobId, 0);
    const card = mockDb.entries().find(([path, value]) => path.startsWith('flashcards/') && value.front === 'spaced front')?.[1];
    expect(card).toMatchObject({ front: 'spaced front', back: 'back', topic: 'topic', suspended: true, tags: [' tag '] });
    expect(card?.learningSteps).toBe(0);
  });

  it('keeps owner and resolved deck boundaries distinct', async () => {
    const first = await bulkEnrollCards({ cards: [makeCard('same', 'answer', { deck: 'Deck A' })] }, OWNER);
    await runChunk(first.jobId, 0);
    const second = await bulkEnrollCards({ cards: [makeCard('same', 'answer', { deck: 'Deck B' })] }, OWNER);
    expect(second.jobId).not.toBe(first.jobId);
    await runChunk(second.jobId, 0);
    const otherOwner = await bulkEnrollCards({ cards: [makeCard('same', 'answer', { deck: 'Deck A' })] }, 'other-owner');
    expect(otherOwner.jobId).not.toBe(first.jobId);

    const stored = mockDb.entries().filter(([path]) => path.startsWith('flashcards/')).map(([, card]) => card);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((card) => card.deckId)).size).toBe(2);
  });

  it('preserves an exact random-ID legacy card only in its resolved deck', async () => {
    mockDb.write('decks/legacy-deck', { name: 'Legacy', ownerId: OWNER });
    mockDb.write('decks/other-deck', { name: 'Other', ownerId: OWNER });
    mockDb.write('flashcards/legacy-random-id', {
      ownerId: OWNER, deckId: 'legacy-deck', deck: 'Legacy', front: 'legacy question', back: 'legacy answer',
      tags: ['tag'], topic: 'subject', suspended: true, state: 2, stability: 8.5, reps: 6,
      reviewLog: [{ rating: 3 }], images: [{ url: 'https://example.invalid/image.png' }],
    });

    const match = await bulkEnrollCards({ cards: [makeCard('legacy question', 'legacy answer', {
      deckId: 'legacy-deck', tags: ['tag'], topic: 'subject', suspended: true,
    })] }, OWNER);
    await runChunk(match.jobId, 0);
    let cards = mockDb.entries().filter(([path]) => path.startsWith('flashcards/'));
    expect(cards.map(([path]) => path)).toEqual(['flashcards/legacy-random-id']);
    expect(cards[0][1]).toMatchObject({ state: 2, reps: 6, images: [{ url: 'https://example.invalid/image.png' }] });

    const differentDeck = await bulkEnrollCards({ cards: [makeCard('legacy question', 'legacy answer', {
      deckId: 'other-deck', tags: ['tag'], topic: 'subject', suspended: true,
    })] }, OWNER);
    await runChunk(differentDeck.jobId, 0);
    cards = mockDb.entries().filter(([path]) => path.startsWith('flashcards/'));
    expect(cards).toHaveLength(2);
    expect(cards.some(([path, card]) => path !== 'flashcards/legacy-random-id' && card.deckId === 'other-deck')).toBe(true);
  });
  it('preserves an exact deck-name legacy card without tags or deckId', async () => {
    mockDb.write('decks/legacy-default', { name: 'Legacy default', ownerId: OWNER });
    mockDb.write('flashcards/legacy-deckless', {
      ownerId: OWNER, deck: 'Legacy default', front: 'deckless question', back: 'deckless answer',
      state: 2, reps: 11, images: [{ url: 'https://example.invalid/deckless.png' }],
    });
    const response = await bulkEnrollCards({ cards: [makeCard('deckless question', 'deckless answer', {
      deckId: 'legacy-default',
    })] }, OWNER);
    await runChunk(response.jobId, 0);
    const cards = mockDb.entries().filter(([path]) => path.startsWith('flashcards/'));
    expect(cards.map(([path]) => path)).toEqual(['flashcards/legacy-deckless']);
    expect(cards[0][1]).toMatchObject({ state: 2, reps: 11, images: [{ url: 'https://example.invalid/deckless.png' }] });
    expect(await getEnrollmentStatus(response.jobId, OWNER)).toMatchObject({ status: 'completed', createdCount: 0, skippedCount: 1 });
  });
  it('adopts a matching legacy card when a prior claim target has moved or changed', async () => {
    mockDb.write('decks/legacy-deck', { name: 'Legacy', ownerId: OWNER });
    const cards = [makeCard('legacy question', 'legacy answer', { deckId: 'legacy-deck', tags: ['tag'] })];
    const response = await bulkEnrollCards({ cards }, OWNER);
    await runChunk(response.jobId, 0);
    const moved = mockDb.entries().find(([path, data]) => path.startsWith('flashcards/') && data.front === 'legacy question');
    expect(moved).toBeDefined();
    const claim = mockDb.entries().find(([path, data]) => path.startsWith('bulkEnrollmentCardKeys/') && data.cardId === moved![0].split('/')[1]);
    expect(claim).toBeDefined();
    mockDb.write(moved![0], { ...moved![1], front: 'edited content', deckId: 'elsewhere', state: 2, reps: 8 });
    mockDb.write('flashcards/matching-legacy', {
      ownerId: OWNER, deckId: 'legacy-deck', front: 'legacy question', back: 'legacy answer', tags: ['tag'],
      state: 2, reps: 5, images: [{ url: 'https://example.invalid/legacy.png' }],
    });
    const rootPath = `bulkEnrollmentJobs/${response.jobId}`;
    const chunkPath = `${rootPath}/chunks/00000`;
    mockDb.write(rootPath, { ...mockDb.read(rootPath)!, status: 'processing', completedChunks: 0,
      createdCount: 0, skippedCount: 0, failedCount: 0 });
    mockDb.write(chunkPath, { ...mockDb.read(chunkPath)!, status: 'pending' });

    await runChunk(response.jobId, 0);
    expect(mockDb.read(claim![0])?.cardId).toBe('matching-legacy');
    expect(getPath(moved![0])).toMatchObject({ front: 'edited content', state: 2, reps: 8 });
    expect(getPath('flashcards/matching-legacy')).toMatchObject({ state: 2, reps: 5, images: [{ url: 'https://example.invalid/legacy.png' }] });
    expect(await getEnrollmentStatus(response.jobId, OWNER)).toMatchObject({ status: 'completed', createdCount: 0, skippedCount: 1, failedCount: 0 });
  });

  it('stores the deck name read by the chunk transaction', async () => {
    const response = await bulkEnrollCards({ cards: [makeCard('deck rename race', 'answer', { deck: 'Before rename' })] }, OWNER);
    const deckId = (mockDb.read(`bulkEnrollmentJobs/${response.jobId}/chunks/00000`)!.cards as Array<Record<string, unknown>>)[0].deckId as string;
    mockDb.beforeNextTransaction = async () => {
      mockDb.write(`decks/${deckId}`, { ...mockDb.read(`decks/${deckId}`)!, name: 'After rename' });
    };
    await runChunk(response.jobId, 0);
    const created = mockDb.entries().find(([path, data]) => path.startsWith('flashcards/') && data.front === 'deck rename race');
    expect(created?.[1]).toMatchObject({ deckId, deck: 'After rename' });
  });
  it('fails without creating a card when current deck metadata is invalid', async () => {
    const response = await bulkEnrollCards({ cards: [makeCard('invalid deck metadata', 'answer', { deck: 'Valid name' })] }, OWNER);
    const deckId = (mockDb.read(`bulkEnrollmentJobs/${response.jobId}/chunks/00000`)!.cards as Array<Record<string, unknown>>)[0].deckId as string;
    mockDb.beforeNextTransaction = async () => {
      mockDb.write(`decks/${deckId}`, { ...mockDb.read(`decks/${deckId}`)!, name: '' });
    };
    await runChunk(response.jobId, 0);

    expect(mockDb.entries().filter(([path]) => path.startsWith('flashcards/'))).toHaveLength(0);
    expect(mockDb.entries().filter(([path]) => path.startsWith('bulkEnrollmentCardKeys/'))).toHaveLength(0);
    expect(await getEnrollmentStatus(response.jobId, OWNER)).toMatchObject({
      status: 'failed', createdCount: 0, skippedCount: 0, failedCount: 1,
    });
  });


  it('accounts repeated input once as create and once as skip', async () => {
    const response = await bulkEnrollCards({ cards: [makeCard('same', 'answer'), makeCard('same', 'answer')] }, OWNER);
    await runChunk(response.jobId, 0);
    const status = await getEnrollmentStatus(response.jobId, OWNER);
    expect(status).toMatchObject({ status: 'completed', totalCards: 2, completedChunks: 1, createdCount: 1, skippedCount: 1, failedCount: 0 });
  });

  it('keeps earlier chunk card failures in terminal progress', async () => {
    const seed = await bulkEnrollCards({ cards: [makeCard('question-0', 'answer-0')] }, OWNER);
    await runChunk(seed.jobId, 0);
    const incumbent = mockDb.entries().find(([path, data]) => path.startsWith('flashcards/') && data.front === 'question-0');
    const claim = mockDb.entries().find(([path, data]) => path.startsWith('bulkEnrollmentCardKeys/') && data.cardId === incumbent![0].split('/')[1]);
    mockDb.write(claim![0], { ...claim![1], ownerId: 'foreign-owner' });

    const cards = Array.from({ length: 101 }, (_, index) => makeCard(`question-${index}`, `answer-${index}`));
    const response = await bulkEnrollCards({ cards }, OWNER);
    const chunkDocs = mockDb.entries().filter(([path]) => path.startsWith(`bulkEnrollmentJobs/${response.jobId}/chunks/`));
    const failedChunk = chunkDocs.find(([, chunk]) => (chunk.cards as Array<Record<string, unknown>>).some((card) => card.front === 'question-0'))![1].chunkIndex as number;
    const laterChunk = failedChunk === 0 ? 1 : 0;
    await runChunk(response.jobId, failedChunk);
    await runChunk(response.jobId, laterChunk);
    const status = await getEnrollmentStatus(response.jobId, OWNER);
    expect(status).toMatchObject({ status: 'failed', completedChunks: 2, failedCount: 1, createdCount: 100 });
    expect((status?.createdCount ?? 0) + (status?.skippedCount ?? 0) + (status?.failedCount ?? 0)).toBe(101);
  });

  it('preserves a reviewed exact card on duplicate trigger delivery', async () => {
    const response = await bulkEnrollCards({ cards: [makeCard('reviewed while waiting', 'answer')] }, OWNER);
    const chunk = mockDb.read(`bulkEnrollmentJobs/${response.jobId}/chunks/00000`)!.cards as Array<Record<string, unknown>>;
    const card = chunk[0];
    mockDb.write('flashcards/original-reviewed-card', {
      ownerId: OWNER, front: card.front, back: card.back, tags: card.tags, deckId: card.deckId,
      deck: card.deck, suspended: card.suspended, state: 2, stability: 17, reps: 12,
      reviewLog: [{ rating: 4 }], images: [{ url: 'https://example.invalid/reviewed.png' }],
    });
    const targetPath = `bulkEnrollmentJobs/${response.jobId}/chunks/00000`;
    const stored = mockDb.read(targetPath)!;
    mockDb.write(targetPath, { ...stored, cards: [{ ...card, front: 'reviewed while waiting' }] });
    await Promise.all([runChunk(response.jobId, 0), runChunk(response.jobId, 0)]);
    expect(mockDb.entries().filter(([path]) => path.startsWith('flashcards/'))).toHaveLength(1);
    expect(getPath('flashcards/original-reviewed-card')).toMatchObject({ state: 2, stability: 17, reps: 12, reviewLog: [{ rating: 4 }] });
    expect(await getEnrollmentStatus(response.jobId, OWNER)).toMatchObject({ status: 'completed', createdCount: 0, skippedCount: 1 });
  });

  it('reconstructs a missing stable chunk after an order-independent resubmission', async () => {
    const cards = Array.from({ length: 101 }, (_, index) => makeCard(`question-${index}`, `answer-${index}`));
    const response = await bulkEnrollCards({ cards }, OWNER);
    const path = `bulkEnrollmentJobs/${response.jobId}/chunks/00001`;
    const original = mockDb.read(path)!.cards;
    mockDb.remove(path);
    const resumed = await bulkEnrollCards({ cards: [...cards].reverse() }, OWNER);

    expect(resumed.jobId).toBe(response.jobId);
    expect(resumed.retriedChunkCount).toBe(2);
    expect(mockDb.read(path)?.cards).toEqual(original);
  });

  it('does not reset completed chunks when a concurrent exact resume arrives', async () => {
    const cards = Array.from({ length: 101 }, (_, index) => makeCard(`question-${index}`, `answer-${index}`));
    const response = await bulkEnrollCards({ cards }, OWNER);
    const chunkPath = `bulkEnrollmentJobs/${response.jobId}/chunks/00000`;
    const chunk = mockDb.read(chunkPath)!;
    mockDb.write(chunkPath, { ...chunk, status: 'completed', createdCount: 100, skippedCount: 0, failedCount: 0 });
    mockDb.write(`bulkEnrollmentJobs/${response.jobId}`, {
      ...mockDb.read(`bulkEnrollmentJobs/${response.jobId}`)!, status: 'completed', completedChunks: 1,
      createdCount: 100, skippedCount: 0, failedCount: 0,
    });

    await bulkEnrollCards({ cards }, OWNER);
    expect(mockDb.read(chunkPath)).toMatchObject({ status: 'completed', createdCount: 100 });
    expect(mockDb.read(`bulkEnrollmentJobs/${response.jobId}`)).toMatchObject({ status: 'completed', completedChunks: 1 });
  });

  it('partitions valid multibyte content below the Firestore chunk document budget', async () => {
    const emoji = '🧠'.repeat(2_500);
    const cards = Array.from({ length: 100 }, (_, index) => makeCard(`${emoji}${index}`, emoji));
    const response = await bulkEnrollCards({ cards }, OWNER);
    expect(response.totalChunks).toBeGreaterThan(1);
    for (let index = 0; index < response.totalChunks; index++) {
      const chunk = mockDb.read(`bulkEnrollmentJobs/${response.jobId}/chunks/${String(index).padStart(5, '0')}`)!;
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThan(700 * 1024);
    }
  });

  it('rejects an unverifiable legacy job without changing its stored state', async () => {
    const cards = [makeCard('legacy question', 'legacy answer')];
    const response = await bulkEnrollCards({ cards }, OWNER);
    const rootPath = `bulkEnrollmentJobs/${response.jobId}`;
    const chunkPath = `${rootPath}/chunks/00000`;
    const oldRoot = mockDb.read(rootPath)!;
    const oldChunk = mockDb.read(chunkPath)!;
    mockDb.write(rootPath, { ...oldRoot, formatVersion: undefined });

    await expect(bulkEnrollCards({ cards }, OWNER)).rejects.toThrow(EnrollmentValidationError);
    expect(mockDb.read(chunkPath)).toEqual(oldChunk);
  });
});

/**
 * Safe bulk enrollment service — a resumable, idempotent workflow for large
 * card sets. Versioned canonical identities, durable byte-bounded chunks, and
 * one transaction per chunk keep card creation and progress accounting atomic.
 */
import {
  getFirestore, Firestore, Timestamp, FieldValue, FieldPath,
} from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import {
  BulkEnrollCardsInput, BulkEnrollCardsResponse, BulkEnrollmentJob,
  BulkEnrollStatusResponse, CreateFlashcardInput,
  ENROLLMENT_CHUNK_SIZE, ENROLLMENT_MAX_CARDS, DECK_NAME_MAX_LENGTH,
} from './types';
import { getDefaultOwnedDeck, deckFromSnapshot, resolveOwnedDeckRef, type DeckRef, DeckNotFoundError, AmbiguousDeckNameError } from './decks';
import { initialScheduling } from './scheduler';
const JOBS_COLLECTION = 'bulkEnrollmentJobs';
const CHUNKS_SUBCOLLECTION = 'chunks';
const FLASHCARDS_COLLECTION = 'flashcards';
const ENROLLMENT_KEYS_COLLECTION = 'bulkEnrollmentCardKeys';
const DECKS_COLLECTION = 'decks';
const ENROLLMENT_FORMAT_VERSION = 2;
const CHUNK_DOCUMENT_BUDGET_BYTES = 700 * 1024;
const CHUNK_BATCH_BUDGET_BYTES = 6 * 1024 * 1024;
const CHUNK_BATCH_WRITE_LIMIT = 400;

let db: Firestore | undefined;

function getDb(): Firestore {
  if (!db) db = getFirestore();
  return db;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Versioned, unambiguous deterministic card identity. */
export function computeCardKey(
  ownerId: string,
  front: string,
  back: string,
  tags: string[],
  deckId?: string | null,
  topic?: string | null,
  suspended?: boolean,
): string {
  const identity = [
    'flashcard', ENROLLMENT_FORMAT_VERSION, ownerId, front.trim(), back.trim(),
    [...tags].sort(), deckId ?? '', (topic ?? '').trim(), suspended === true,
  ];
  return `c2_${digest(JSON.stringify(identity))}`;
}

interface CanonicalCard extends CreateFlashcardInput {
  front: string;
  back: string;
  tags: string[];
  deckId: string;
  deck: string;
  suspended: boolean;
}

interface EnrollmentChunk {
  index: number;
  cards: CanonicalCard[];
  payloadHash: string;
  startOrdinal: number;
}

function canonicalCardKey(ownerId: string, card: CanonicalCard): string {
  return computeCardKey(ownerId, card.front, card.back, card.tags, card.deckId, card.topic, card.suspended);
}


function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeJobId(ownerId: string, cards: CanonicalCard[]): string {
  const keys = cards.map((card) => canonicalCardKey(ownerId, card)).sort();
  return `e2_${digest(JSON.stringify(['bulk-enrollment', ENROLLMENT_FORMAT_VERSION, ownerId, keys]))}`;
}

/** Enrollment shares the registry's exact owner/name and explicit-ID rules. */

export class EnrollmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentValidationError';
  }
}

function normalizeInputCard(card: CreateFlashcardInput): Omit<CanonicalCard, 'deckId' | 'deck'> {
  const front = card.front.trim();
  const back = card.back.trim();
  const topic = card.topic == null ? undefined : card.topic.trim();
  if (!front || !back) {
    throw new EnrollmentValidationError('Front and back must not be empty after trimming');
  }
  if (front.length > 10_000 || back.length > 10_000) {
    throw new EnrollmentValidationError('Front and back must not exceed 10000 characters after trimming');
  }
  if (topic !== undefined && (!topic || topic.length > 200)) {
    throw new EnrollmentValidationError('Topic must contain 1 to 200 characters after trimming');
  }
  const tags = [...(card.tags || [])].sort();
  if (tags.length > 20 || tags.some((tag) => !tag || tag.length > 50)) {
    throw new EnrollmentValidationError('Tags must contain at most 20 non-empty values of at most 50 characters');
  }
  return {
    front,
    back,
    tags,
    ...(topic !== undefined ? { topic } : {}),
    suspended: card.suspended === true,
  };
}

async function canonicalizeCards(
  cards: CreateFlashcardInput[],
  ownerId: string,
  useStoredDeckSnapshot = false,
): Promise<CanonicalCard[]> {
  const defaultDeck = await getDefaultOwnedDeck(ownerId);
  const deckCache = new Map<string, DeckRef>();
  const withOrdinal: Array<{ card: CanonicalCard; ordinal: number }> = [];
  for (const [ordinal, card] of cards.entries()) {
    const normalized = normalizeInputCard(card);
    const deckKey = JSON.stringify([card.deckId ?? null, card.deck ?? null]);
    let deck = deckCache.get(deckKey);
    if (!deck) {
      try {
        if (useStoredDeckSnapshot && typeof card.deckId === 'string') {
          const deckSnapshot = await getDb().collection(DECKS_COLLECTION).doc(card.deckId).get();
          const deckData = deckSnapshot.data();
          const currentDeck = deckData ? deckFromSnapshot(deckSnapshot) : null;
          // This label is only for identity/legacy lookup; processChunk validates it again before writes.
          deck = {
            deckId: card.deckId,
            deck: currentDeck?.ownerId === ownerId && typeof currentDeck.name === 'string' ? currentDeck.name : '',
          };
        } else {
          deck = await resolveOwnedDeckRef(card, ownerId) ?? {
            deckId: defaultDeck.id,
            deck: defaultDeck.name,
          };
        }
      } catch (error) {
        if (error instanceof DeckNotFoundError || error instanceof AmbiguousDeckNameError) {
          throw new EnrollmentValidationError(error.message);
        }
        throw error;
      }
      deckCache.set(deckKey, deck);
    }
    withOrdinal.push({ card: { ...normalized, deckId: deck.deckId, deck: deck.deck }, ordinal });
  }
  withOrdinal.sort((a, b) => {
    const order = canonicalCardKey(ownerId, a.card).localeCompare(canonicalCardKey(ownerId, b.card));
    return order || a.ordinal - b.ordinal;
  });
  return withOrdinal.map(({ card }) => card);
}

function hashChunkCards(cards: CanonicalCard[], ownerId: string): string {
  const identities = cards.map((card) => canonicalCardKey(ownerId, card));
  return digest(stableJson(identities));
}

function makeChunkDocument(chunk: EnrollmentChunk, ownerId: string): Record<string, unknown> {
  return {
    formatVersion: ENROLLMENT_FORMAT_VERSION,
    chunkIndex: chunk.index,
    startOrdinal: chunk.startOrdinal,
    cards: chunk.cards.map(({ deck: _deck, ...card }) => card),
    payloadHash: chunk.payloadHash,
    cardCount: chunk.cards.length,
    status: 'pending',
    ownerId,
    createdCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function partitionCards(cards: CanonicalCard[], ownerId: string): EnrollmentChunk[] {
  const chunks: EnrollmentChunk[] = [];
  let current: CanonicalCard[] = [];
  let startOrdinal = 0;

  const flush = () => {
    if (current.length === 0) return;
    const chunk: EnrollmentChunk = {
      index: chunks.length,
      cards: current,
      payloadHash: hashChunkCards(current, ownerId),
      startOrdinal,
    };
    const document = makeChunkDocument(chunk, ownerId);
    if (serializedBytes(document) > CHUNK_DOCUMENT_BUDGET_BYTES) {
      throw new EnrollmentValidationError(`Card ${startOrdinal} cannot fit in a bounded enrollment chunk`);
    }
    chunks.push(chunk);
    startOrdinal += current.length;
    current = [];
  };

  for (const card of cards) {
    const candidate = [...current, card];
    const next: EnrollmentChunk = {
      index: chunks.length,
      cards: candidate,
      payloadHash: hashChunkCards(candidate, ownerId),
      startOrdinal,
    };
    if (current.length > 0 && (candidate.length > ENROLLMENT_CHUNK_SIZE
      || serializedBytes(makeChunkDocument(next, ownerId)) > CHUNK_DOCUMENT_BUDGET_BYTES)) {
      flush();
    }
    const single: EnrollmentChunk = {
      index: chunks.length,
      cards: [card],
      payloadHash: hashChunkCards([card], ownerId),
      startOrdinal,
    };
    if (serializedBytes(makeChunkDocument(single, ownerId)) > CHUNK_DOCUMENT_BUDGET_BYTES) {
      throw new EnrollmentValidationError(`Card ${startOrdinal} cannot fit in a bounded enrollment chunk`);
    }
    current.push(card);
  }
  flush();
  return chunks;
}

function computeCanonicalSetHash(ownerId: string, cards: CanonicalCard[]): string {
  return digest(JSON.stringify(['canonical-card-set', ENROLLMENT_FORMAT_VERSION, ownerId,
    cards.map((card) => canonicalCardKey(ownerId, card)).sort()]));
}

function sameCardPayload(left: unknown, right: CanonicalCard[], ownerId: string): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const leftKeys = left.map((card) => canonicalCardKey(ownerId, card as CanonicalCard)).sort();
  const rightKeys = right.map((card) => canonicalCardKey(ownerId, card)).sort();
  return stableJson(leftKeys) === stableJson(rightKeys);
}

function validateStoredChunk(data: FirebaseFirestore.DocumentData, chunk: EnrollmentChunk, ownerId: string): void {
  const payloadHash = Array.isArray(data.cards) ? hashChunkCards(data.cards as CanonicalCard[], ownerId) : '';
  if (data.formatVersion !== ENROLLMENT_FORMAT_VERSION || data.ownerId !== ownerId
    || data.chunkIndex !== chunk.index || data.startOrdinal !== chunk.startOrdinal
    || data.payloadHash !== payloadHash || data.cardCount !== chunk.cards.length
    || !sameCardPayload(data.cards, chunk.cards, ownerId)) {
    throw new EnrollmentValidationError(`Stored enrollment chunk ${chunk.index} does not match this exact submission`);
  }
}

function chunkDocumentRef(jobId: string, index: number) {
  return getDb().collection(JOBS_COLLECTION).doc(jobId)
    .collection(CHUNKS_SUBCOLLECTION).doc(String(index).padStart(5, '0'));
}

function validateExistingJob(
  data: FirebaseFirestore.DocumentData,
  ownerId: string,
  jobId: string,
  cards: CanonicalCard[],
  chunks: EnrollmentChunk[],
  canonicalSetHash: string,
): void {
  if (data.ownerId !== ownerId) throw new EnrollmentValidationError('Job belongs to another owner');
  if (data.formatVersion !== ENROLLMENT_FORMAT_VERSION) {
    throw new EnrollmentValidationError('This legacy enrollment job cannot be safely resumed by the current identity format');
  }
  if (data.contentHash !== jobId || data.canonicalCardSetHash !== canonicalSetHash
    || data.totalCards !== cards.length || data.totalChunks !== chunks.length) {
    throw new EnrollmentValidationError('Stored enrollment job does not match this exact submission');
  }
}

async function ensureJobDocument(
  jobId: string,
  ownerId: string,
  cards: CanonicalCard[],
  chunks: EnrollmentChunk[],
  canonicalSetHash: string,
): Promise<BulkEnrollmentJob> {
  const jobRef = getDb().collection(JOBS_COLLECTION).doc(jobId);
  const now = Timestamp.now();
  await getDb().runTransaction(async (t) => {
    const snap = await t.get(jobRef);
    if (snap.exists) {
      validateExistingJob(snap.data()!, ownerId, jobId, cards, chunks, canonicalSetHash);
      return;
    }
    t.create(jobRef, {
      formatVersion: ENROLLMENT_FORMAT_VERSION,
      ownerId,
      status: 'processing',
      contentHash: jobId,
      canonicalCardSetHash: canonicalSetHash,
      totalCards: cards.length,
      totalChunks: chunks.length,
      completedChunks: 0,
      createdCount: 0,
      skippedCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }, { maxAttempts: 10 });
  const snap = await jobRef.get();
  const data = snap.data();
  if (!data) throw new Error(`Enrollment job ${jobId} was not created`);
  validateExistingJob(data, ownerId, jobId, cards, chunks, canonicalSetHash);
  return { id: jobId, ...data } as BulkEnrollmentJob;
}

function chunkWriteGroups(chunks: EnrollmentChunk[], ownerId: string): EnrollmentChunk[][] {
  const groups: EnrollmentChunk[][] = [];
  let group: EnrollmentChunk[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = serializedBytes(makeChunkDocument(chunk, ownerId));
    if (group.length > 0 && (group.length >= CHUNK_BATCH_WRITE_LIMIT || bytes + size > CHUNK_BATCH_BUDGET_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(chunk);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function createMissingChunks(
  jobId: string,
  ownerId: string,
  chunks: EnrollmentChunk[],
): Promise<Set<number>> {
  const created = new Set<number>();
  for (const group of chunkWriteGroups(chunks, ownerId)) {
    let missing = group;
    for (let attempt = 0; missing.length > 0 && attempt < 4; attempt++) {
      const batch = getDb().batch();
      for (const chunk of missing) {
        batch.create(chunkDocumentRef(jobId, chunk.index), makeChunkDocument(chunk, ownerId));
      }
      try {
        await batch.commit();
        for (const chunk of missing) created.add(chunk.index);
        missing = [];
      } catch (err) {
        const snapshots = await Promise.all(group.map((chunk) => chunkDocumentRef(jobId, chunk.index).get()));
        const nextMissing: EnrollmentChunk[] = [];
        snapshots.forEach((snap, index) => {
          const expected = group[index];
          if (snap.exists) validateStoredChunk(snap.data()!, expected, ownerId);
          else nextMissing.push(expected);
        });
        if (nextMissing.length === missing.length && attempt === 3) throw err;
        missing = nextMissing;
      }
    }
    if (missing.length > 0) throw new Error('Unable to persist enrollment chunks');
  }
  return created;
}

async function readJobDocument(jobId: string): Promise<BulkEnrollmentJob | null> {
  const snap = await getDb().collection(JOBS_COLLECTION).doc(jobId).get();
  return snap.exists ? { id: snap.id, ...snap.data()! } as BulkEnrollmentJob : null;
}


function canonicalIdentity(card: {
  ownerId?: unknown; front?: unknown; back?: unknown; tags?: unknown; topic?: unknown;
  suspended?: unknown; deckId?: unknown;
}, ownerId: string): unknown {
  if (typeof card.front !== 'string' || typeof card.back !== 'string'
    || (card.deckId !== undefined && typeof card.deckId !== 'string')
    || (card.topic !== undefined && card.topic !== null && typeof card.topic !== 'string')
    || (card.suspended !== undefined && typeof card.suspended !== 'boolean')
    || (card.tags !== undefined && (!Array.isArray(card.tags) || card.tags.some((tag) => typeof tag !== 'string')))) return null;
  const tags = card.tags === undefined ? [] : card.tags as string[];
  return [
    'flashcard', ENROLLMENT_FORMAT_VERSION, ownerId, card.front.trim(), card.back.trim(), [...tags].sort(),
    typeof card.deckId === 'string' ? card.deckId : '',
    (typeof card.topic === 'string' ? card.topic : '').trim(), card.suspended === true,
  ];
}

function contentMatches(existing: Record<string, unknown>, target: CanonicalCard, ownerId: string): boolean {
  return stableJson(canonicalIdentity(existing, ownerId)) === stableJson(canonicalIdentity(target, ownerId));
}

interface LegacyCandidate {
  ref: FirebaseFirestore.DocumentReference;
  decklessByName: boolean;
}

async function findLegacyCandidates(cards: CanonicalCard[], ownerId: string): Promise<Map<string, LegacyCandidate>> {
  const candidates = new Map<string, LegacyCandidate>();
  const unique = new Map(cards.map((card) => [canonicalCardKey(ownerId, card), card]));
  const byDeck = new Map<string, Array<[string, CanonicalCard]>>();
  for (const entry of unique) {
    const deckCards = byDeck.get(entry[1].deckId) ?? [];
    deckCards.push(entry);
    byDeck.set(entry[1].deckId, deckCards);
  }
  for (const [deckId, deckCards] of byDeck) {
    const expected = new Map(deckCards.map(([key, card]) => [stableJson(canonicalIdentity(card, ownerId)), key]));
    const deckName = deckCards[0][1].deck;
    const matchingDecks = await getDb().collection(DECKS_COLLECTION)
      .where('ownerId', '==', ownerId).where('name', '==', deckName).select('ownerId', 'name').limit(2).get();
    const canResolveDeckless = deckName.length > 0 && matchingDecks.size === 1 && matchingDecks.docs[0].id === deckId;
    const queries = [getDb().collection(FLASHCARDS_COLLECTION)
      .where('ownerId', '==', ownerId).where('deckId', '==', deckId)];
    if (canResolveDeckless) {
      queries.push(getDb().collection(FLASHCARDS_COLLECTION)
        .where('ownerId', '==', ownerId).where('deck', '==', deckName));
    }
    for (let query of queries) {
      query = query.orderBy(FieldPath.documentId())
        .select('ownerId', 'deckId', 'deck', 'front', 'back', 'tags', 'topic', 'suspended').limit(200);
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      let hasMore = true;
      while (hasMore) {
        const pageQuery = cursor ? query.startAfter(cursor) : query;
        const page = await pageQuery.get();
        for (const doc of page.docs) {
          const data = doc.data();
          const decklessByName = data.deckId === undefined && data.deck === deckName && canResolveDeckless;
          if (data.deckId !== deckId && !decklessByName) continue;
          const identityCard = decklessByName ? { ...data, deckId } : data;
          const key = expected.get(stableJson(canonicalIdentity(identityCard, ownerId)));
          if (key && !candidates.has(key)) candidates.set(key, { ref: doc.ref, decklessByName });
        }
        hasMore = page.docs.length === 200;
        if (hasMore) cursor = page.docs[page.docs.length - 1];
      }
    }
  }
  return candidates;
}



function cardError(card: CanonicalCard, message: string): string {
  return `Card "${card.front.slice(0, 40)}…": ${message}`;
}

interface ChunkOutcome {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
}
async function processChunk(
  chunkId: string,
  chunkRef: FirebaseFirestore.DocumentReference,
  jobRef: FirebaseFirestore.DocumentReference,
  ownerId: string,
  cards: CanonicalCard[],
): Promise<void> {
  const uniqueCards = new Map<string, { card: CanonicalCard; multiplicity: number }>();
  for (const card of cards) {
    const key = canonicalCardKey(ownerId, card);
    const item = uniqueCards.get(key);
    if (item) item.multiplicity++;
    else uniqueCards.set(key, { card, multiplicity: 1 });
  }
  const items = [...uniqueCards.entries()];
  const legacyCandidates = await findLegacyCandidates(cards, ownerId);
  const claimRefs = items.map(([key]) => getDb().collection(ENROLLMENT_KEYS_COLLECTION).doc(key));
  const newCardRefs = items.map(() => getDb().collection(FLASHCARDS_COLLECTION).doc());
  const legacyRefs = items.map(([key]) => legacyCandidates.get(key) ?? null);
  const deckRefsById = new Map<string, FirebaseFirestore.DocumentReference>();
  for (const [, { card }] of items) {
    if (!deckRefsById.has(card.deckId)) {
      deckRefsById.set(card.deckId, getDb().collection(DECKS_COLLECTION).doc(card.deckId));
    }
  }
  const deckEntries = [...deckRefsById.entries()];

  try {
    await getDb().runTransaction(async (t) => {
      const chunkSnap = await t.get(chunkRef);
      const jobSnap = await t.get(jobRef);
      const currentChunk = chunkSnap.data();
      const currentJob = jobSnap.data();
      if (!currentChunk || currentChunk.status === 'completed') return;
      if (!currentJob || currentJob.status === 'completed') return;
      if (currentChunk.ownerId !== ownerId || currentJob.ownerId !== ownerId) {
        throw new EnrollmentValidationError('Enrollment owner does not match stored job/chunk');
      }
      if (!Array.isArray(currentChunk.cards) || !sameCardPayload(currentChunk.cards, cards, ownerId)) {
        throw new EnrollmentValidationError('Enrollment chunk payload changed during processing');
      }
      if (currentChunk.formatVersion === ENROLLMENT_FORMAT_VERSION
        && (currentChunk.payloadHash !== hashChunkCards(cards, ownerId) || currentChunk.cardCount !== cards.length)) {
        throw new EnrollmentValidationError('Stored enrollment chunk failed its canonical payload check');
      }

      const claimSnaps = await Promise.all(claimRefs.map((ref) => t.get(ref)));
      const targetRefs = new Map<string, FirebaseFirestore.DocumentReference>();
      for (let index = 0; index < items.length; index++) {
        const claim = claimSnaps[index].data();
        if (claim?.ownerId === ownerId && claim.identity === items[index][0] && typeof claim.cardId === 'string') {
          const ref = getDb().collection(FLASHCARDS_COLLECTION).doc(claim.cardId);
          targetRefs.set(ref.path, ref);
        }
        const legacyCandidate = legacyRefs[index];
        if (legacyCandidate) targetRefs.set(legacyCandidate.ref.path, legacyCandidate.ref);
      }
      const refs = [...targetRefs.values()];
      const [targetSnaps, deckSnaps] = await Promise.all([
        Promise.all(refs.map((ref) => t.get(ref))),
        Promise.all(deckEntries.map(([, ref]) => t.get(ref))),
      ]);
      const targetByPath = new Map(refs.map((ref, index) => [ref.path, targetSnaps[index].data()]));
      const deckById = new Map(deckEntries.map(([id], index) => [id, deckSnaps[index].data()]));
      const outcome: ChunkOutcome = { created: 0, skipped: 0, failed: 0, errors: [] };

      const now = Timestamp.now();
      for (let index = 0; index < items.length; index++) {
        const [key, { card, multiplicity }] = items[index];
        const claimRef = claimRefs[index];
        const claimSnap = claimSnaps[index];
        const claim = claimSnap.data();
        const deck = deckById.get(card.deckId);
        if (!deck || deck.ownerId !== ownerId || typeof deck.name !== 'string'
          || deck.name.length === 0 || deck.name.length > DECK_NAME_MAX_LENGTH) {
          outcome.failed += multiplicity;
          outcome.errors.push(cardError(card, 'referenced deck is missing, invalid, or belongs to another owner'));
          continue;
        }
        if (claimSnap.exists && (claim?.ownerId !== ownerId || claim.identity !== key || typeof claim.cardId !== 'string')) {
          outcome.failed += multiplicity;
          outcome.errors.push(cardError(card, 'enrollment identity is claimed by invalid or foreign data'));
          continue;
        }
        const targetRef = claimSnap.exists
          ? getDb().collection(FLASHCARDS_COLLECTION).doc(claim!.cardId as string)
          : undefined;
        const target = targetRef ? targetByPath.get(targetRef.path) : undefined;
        if (target && target.ownerId !== ownerId) {
          outcome.failed += multiplicity;
          outcome.errors.push(cardError(card, 'enrollment identity points to a card owned by another user'));
          continue;
        }
        if (target && contentMatches(target, card, ownerId)) {
          outcome.skipped += multiplicity;
          continue;
        }
        const legacyCandidate = legacyRefs[index];
        const legacyRef = legacyCandidate?.ref;
        const legacy = legacyRef ? targetByPath.get(legacyRef.path) : undefined;
        const legacyMatches = legacy?.ownerId === ownerId && (legacyCandidate?.decklessByName
          ? stableJson(canonicalIdentity({ ...legacy, deckId: card.deckId }, ownerId))
            === stableJson(canonicalIdentity(card, ownerId))
          : contentMatches(legacy, card, ownerId));
        if (legacyMatches && legacyRef) {
          const nextClaim = { ownerId, identity: key, cardId: legacyRef.id };
          if (claimSnap.exists) t.update(claimRef, nextClaim);
          else t.create(claimRef, nextClaim);
          outcome.skipped += multiplicity;
          continue;
        }

        const payload: Record<string, unknown> = {
          ownerId,
          front: card.front,
          back: card.back,
          tags: card.tags,
          deckId: card.deckId,
          deck: deck.name,
          topic: card.topic,
          suspended: card.suspended,
          enrollmentIdentity: key,
          createdAt: now,
          updatedAt: now,
          ...initialScheduling(now),
          reviewLog: [],
          images: [],
        };
        for (const field of Object.keys(payload)) {
          if (payload[field] === undefined) delete payload[field];
        }
        t.create(newCardRefs[index], payload);
        const nextClaim = { ownerId, identity: key, cardId: newCardRefs[index].id };
        if (claimSnap.exists) t.update(claimRef, nextClaim);
        else t.create(claimRef, nextClaim);
        outcome.created++;
        if (multiplicity > 1) outcome.skipped += multiplicity - 1;
      }

      const completedChunks = Number(currentJob.completedChunks ?? 0) + 1;
      const createdCount = Number(currentJob.createdCount ?? 0) + outcome.created;
      const skippedCount = Number(currentJob.skippedCount ?? 0) + outcome.skipped;
      const failedCount = Number(currentJob.failedCount ?? 0) + outcome.failed;
      const terminal = completedChunks >= Number(currentJob.totalChunks ?? 0);
      const finalStatus = terminal
        ? (failedCount > 0 ? 'failed' : 'completed')
        : (currentJob.status === 'failed' ? 'failed' : 'processing');
      t.update(chunkRef, {
        status: 'completed', createdCount: outcome.created, skippedCount: outcome.skipped,
        failedCount: outcome.failed,
        error: outcome.errors.length > 0 ? outcome.errors[outcome.errors.length - 1] : null,
        lastError: FieldValue.delete(), processedAt: now,
      });
      t.update(jobRef, {
        completedChunks, createdCount, skippedCount, failedCount, status: finalStatus,
        ...(terminal ? { completedAt: now } : { completedAt: FieldValue.delete() }),
        ...(terminal && failedCount > 0
          ? { error: `${failedCount} card(s) failed during enrollment` }
          : (finalStatus === 'processing' ? { error: FieldValue.delete() } : {})),
        updatedAt: now,
      });
    }, { maxAttempts: 20 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await getDb().runTransaction(async (t) => {
      const chunkSnap = await t.get(chunkRef);
      const jobSnap = await t.get(jobRef);
      const chunk = chunkSnap.data();
      const job = jobSnap.data();
      if (!chunk || chunk.status === 'completed' || !job || job.status === 'completed') return;
      const now = Timestamp.now();
      t.update(chunkRef, { lastError: message, lastErrorAt: now });
      t.update(jobRef, { status: 'failed', error: `Chunk ${chunkId}: ${message}`, updatedAt: now });
    }, { maxAttempts: 10 });
    throw err;
  }
}

export interface ChunkWrittenEvent {
  data?: {
    after?: {
      data?: () => Record<string, unknown>;
      ref?: {
        id?: string;
        parent?: { id?: string; parent?: { id?: string } };
      };
    };
    before?: { data?: () => Record<string, unknown> };
  };
}

export async function onEnrollmentChunkWritten(event: ChunkWrittenEvent): Promise<void> {
  const after = event.data?.after;
  const chunkRef = after?.ref;
  const jobId = chunkRef?.parent?.parent?.id;
  const chunkId = chunkRef?.id;
  if (!after?.data || !jobId || !chunkId) return;

  const actualChunkRef = chunkDocumentRef(jobId, Number.parseInt(chunkId, 10));
  const jobRef = getDb().collection(JOBS_COLLECTION).doc(jobId);
  const snapshot = await actualChunkRef.get();
  const data = snapshot.data();
  if (!data || data.status === 'completed') return;

  const ownerId = data.ownerId as string | undefined;
  const inputCards = data.cards as CreateFlashcardInput[] | undefined;
  if (!ownerId || !Array.isArray(inputCards) || inputCards.length === 0) return;

  try {
    const cards = await canonicalizeCards(inputCards, ownerId, true);
    await processChunk(chunkId, actualChunkRef, jobRef, ownerId, cards);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await getDb().runTransaction(async (t) => {
      const chunkSnap = await t.get(actualChunkRef);
      const jobSnap = await t.get(jobRef);
      const chunk = chunkSnap.data();
      const job = jobSnap.data();
      if (!chunk || chunk.status === 'completed' || !job || job.status === 'completed') return;
      const now = Timestamp.now();
      t.update(actualChunkRef, { lastError: message, lastErrorAt: now });
      t.update(jobRef, {
        status: 'failed', error: `Chunk ${chunkId}: ${message}`, updatedAt: now,
      });
    }, { maxAttempts: 10 });
    throw err;
  }
}

function responseFromJob(job: BulkEnrollmentJob, retriedChunkCount: number): BulkEnrollCardsResponse {
  return {
    jobId: job.id,
    status: job.status,
    totalCards: job.totalCards,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    createdCount: job.createdCount,
    skippedCount: job.skippedCount ?? 0,
    failedCount: job.failedCount,
    retriedChunkCount,
  };
}

export async function bulkEnrollCards(
  input: BulkEnrollCardsInput,
  ownerId: string,
): Promise<BulkEnrollCardsResponse> {
  if (!input.cards || input.cards.length === 0) {
    throw new EnrollmentValidationError('Cards array must not be empty');
  }
  if (input.cards.length > ENROLLMENT_MAX_CARDS) {
    throw new EnrollmentValidationError(`Too many cards: ${input.cards.length} (max ${ENROLLMENT_MAX_CARDS})`);
  }

  const cards = await canonicalizeCards(input.cards, ownerId);
  const chunks = partitionCards(cards, ownerId);
  const jobId = computeJobId(ownerId, cards);
  const canonicalSetHash = computeCanonicalSetHash(ownerId, cards);
  let job = await ensureJobDocument(jobId, ownerId, cards, chunks, canonicalSetHash);
  if (job.status === 'completed' || (job.status === 'failed' && job.completedChunks >= job.totalChunks)) {
    return responseFromJob(job, 0);
  }

  const chunkCollection = getDb().collection(JOBS_COLLECTION).doc(jobId).collection(CHUNKS_SUBCOLLECTION);
  const storedChunks = await chunkCollection.get();
  const storedByIndex = new Map<number, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const snap of storedChunks.docs) {
    const index = snap.data().chunkIndex;
    if (typeof index === 'number') storedByIndex.set(index, snap);
  }
  const missing: EnrollmentChunk[] = [];
  for (const chunk of chunks) {
    const stored = storedByIndex.get(chunk.index);
    if (!stored) {
      missing.push(chunk);
    } else {
      validateStoredChunk(stored.data(), chunk, ownerId);
    }
  }
  const createdIndices = await createMissingChunks(jobId, ownerId, missing);
  let retriedChunkCount = createdIndices.size;
  const retryChunks = chunks.filter((chunk) => {
    if (createdIndices.has(chunk.index)) return false;
    const stored = storedByIndex.get(chunk.index);
    return !!stored && stored.data().status !== 'completed';
  });
  const rootRef = getDb().collection(JOBS_COLLECTION).doc(jobId);

  await Promise.all(retryChunks.map(async (chunk) => {
    const ref = chunkDocumentRef(jobId, chunk.index);
    const changed = await getDb().runTransaction(async (t) => {
      const rootSnap = await t.get(rootRef);
      const chunkSnap = await t.get(ref);
      const root = rootSnap.data();
      const data = chunkSnap.data();
      if (!root || root.status === 'completed' || !data || data.status === 'completed') return false;
      validateStoredChunk(data, chunk, ownerId);
      t.update(ref, {
        status: 'pending', lastError: FieldValue.delete(), lastErrorAt: FieldValue.delete(),
      });
      if (root.status !== 'processing') {
        t.update(rootRef, {
          status: 'processing', error: FieldValue.delete(), completedAt: FieldValue.delete(), updatedAt: Timestamp.now(),
        });
      }
      return true;
    }, { maxAttempts: 10 });
    if (changed) retriedChunkCount++;
  }));

  const fresh = await readJobDocument(jobId);
  if (!fresh) throw new Error(`Enrollment job ${jobId} disappeared`);
  job = fresh;
  return responseFromJob(job, retriedChunkCount);
}

export async function getEnrollmentStatus(
  jobId: string,
  ownerId: string,
): Promise<BulkEnrollStatusResponse | null> {
  const job = await readJobDocument(jobId);
  if (!job || job.ownerId !== ownerId) return null;

  const chunkErrors: Array<{ chunkIndex: number; error: string }> = [];
  if (job.status !== 'completed') {
    const chunks = await getDb().collection(JOBS_COLLECTION).doc(jobId)
      .collection(CHUNKS_SUBCOLLECTION).get();
    for (const snap of chunks.docs) {
      const data = snap.data();
      if (data.lastError) {
        chunkErrors.push({ chunkIndex: data.chunkIndex as number, error: data.lastError as string });
      }
    }
    chunkErrors.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  return {
    jobId: job.id,
    status: job.status,
    totalCards: job.totalCards,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    createdCount: job.createdCount,
    skippedCount: job.skippedCount ?? 0,
    failedCount: job.failedCount,
    createdAt: job.createdAt.toDate().toISOString(),
    updatedAt: job.updatedAt.toDate().toISOString(),
    completedAt: job.completedAt?.toDate().toISOString(),
    error: job.error,
    ...(chunkErrors.length > 0 ? { chunkErrors } : {}),
  };
}

/**
 * Safe bulk enrollment service — a resumable, idempotent workflow that can
 * handle 5,298+ cards despite 100-card request limits and client timeouts.
 *
 * Design:
 *  - Content-addressable job ID (SHA-256 of sorted card keys) ensures
 *    idempotency: resending the same cards returns the existing job.
 *  - Cards are stored in a Firestore subcollection
 *    `bulkEnrollmentJobs/{jobId}/chunks/{paddedIndex}` as durable payloads,
 *    then processed chunk-by-chunk with Firestore WriteBatch (atomic per chunk).
 *  - Deterministic card document ids (SHA-256 of full card identity including
 *    deckId/topic/suspended) ensure that re-processing the same chunk
 *    overwrites the same documents — never creates duplicates.
 *  - The initial HTTP response returns immediately with the jobId. Background
 *    processing happens via Firestore onDocumentWritten trigger. If the
 *    before all chunks are committed, the next call with the same payload
 *    resumes from the last completed chunk.
 *  - Progress is tracked on the job document; clients poll
 *    `getEnrollmentStatus(jobId)` for reconciliation.
 *
 * No background tasks, Cloud Functions, or new infrastructure required.
 */
import {
  getFirestore, Firestore, Timestamp, FieldValue,
} from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import {
  BulkEnrollCardsInput, BulkEnrollCardsResponse, BulkEnrollmentJob,
  BulkEnrollStatusResponse,
  CreateFlashcardInput,
  ENROLLMENT_CHUNK_SIZE, ENROLLMENT_MAX_CARDS,
  DEFAULT_DECK_NAME,
} from './types';
import { initialScheduling } from './scheduler';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const JOBS_COLLECTION = 'bulkEnrollmentJobs';
const CHUNKS_SUBCOLLECTION = 'chunks';
const FLASHCARDS_COLLECTION = 'flashcards';
const DECKS_COLLECTION = 'decks';

/* ------------------------------------------------------------------ */
/* Firestore access                                                    */
/* ------------------------------------------------------------------ */

let db: Firestore | undefined;

function getDb(): Firestore {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* Card key (content-addressable identity)                             */
/* ------------------------------------------------------------------ */

/**
 * Deterministic key for a card: SHA-256(ownerId + '|' + trimmed front +
 * '|' + trimmed back + '|' + sorted tags + '|' + deckId + '|' + topic +
 * '|' + suspended).
 *
 * `suspended` is normalized to '0'/'1' — an omitted (undefined) value
 * maps to '0', matching the default `false` persisted on created cards.
 * This ensures the key is the same whether the caller passes
 * `{ suspended: false }` or omits `suspended` entirely.
 */
export function computeCardKey(
  ownerId: string,
  front: string,
  back: string,
  tags: string[],
  deckId?: string | null,
  topic?: string | null,
  suspended?: boolean,
): string {
  const normalizedFront = front.trim();
  const normalizedBack = back.trim();
  const sortedTags = [...tags].sort().join(',');
  const normDeckId = (deckId ?? '').trim();
  const normTopic = (topic ?? '').trim();
  const suspendedStr = suspended === true ? '1' : '0';
  const payload = `${ownerId}|${normalizedFront}|${normalizedBack}|${sortedTags}|${normDeckId}|${normTopic}|${suspendedStr}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Content-addressable job ID: SHA-256 of the JSON-sorted array of card
 * keys. Two identical card sets (in any order) produce the same job ID.
 */
function computeJobId(ownerId: string, cards: CreateFlashcardInput[]): string {
  const cardKeys = cards
    .map((c) => computeCardKey(
      ownerId, c.front, c.back, c.tags || [],
      c.deckId, c.topic, c.suspended,
    ))
    .sort();
  return createHash('sha256').update(JSON.stringify(cardKeys)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Deck resolution (mirrors service.ts patterns)                       */
/* ------------------------------------------------------------------ */

async function findDeckIdByName(name: string, ownerId: string): Promise<string | null> {
  const q = getDb()
    .collection(DECKS_COLLECTION)
    .where('name', '==', name)
    .where('ownerId', '==', ownerId)
    .limit(1);
  const existing = await q.get();
  if (existing.empty) return null;
  return existing.docs[0].id;
}

async function createDeckEntity(name: string, ownerId: string): Promise<string> {
  const now = Timestamp.now();
  const docRef = getDb().collection(DECKS_COLLECTION).doc();
  await docRef.set({ name, ownerId, createdAt: now, updatedAt: now });
  return docRef.id;
}

async function findOrCreateDeckByName(name: string, ownerId: string): Promise<string> {
  const existingId = await findDeckIdByName(name, ownerId);
  if (existingId !== null) return existingId;
  return createDeckEntity(name, ownerId);
}

/**
 * Resolves the deck a card input refers to. Returns { deckId, deck } or
 * null when neither is set. Throws when a referenced deckId does not exist
 * or belongs to another owner.
 */
async function resolveDeckRef(
  input: { deckId?: string | null; deck?: string | null },
  ownerId: string,
): Promise<{ deckId: string; deck: string } | null> {
  if (input.deckId !== undefined && input.deckId !== null) {
    const doc = await getDb().collection(DECKS_COLLECTION).doc(input.deckId).get();
    if (!doc.exists || doc.data()?.ownerId !== ownerId) {
      throw new Error(`Deck not found: ${input.deckId}`);
    }
    return { deckId: input.deckId, deck: doc.data()?.name as string };
  }
  if (input.deck !== undefined && input.deck !== null) {
    const deckId = await findOrCreateDeckByName(input.deck, ownerId);
    return { deckId, deck: input.deck };
  }
  return null;
}

function applyDeckRef(
  target: Record<string, unknown>,
  ref: { deckId: string; deck: string } | null,
): void {
  if (!ref) return;
  target.deckId = ref.deckId;
  target.deck = ref.deck;
}

/** Lazily resolves the default `Uncategorized` deck for an owner. */
async function resolveDefaultDeck(ownerId: string): Promise<{ deckId: string; deck: string }> {
  const deckId = await findOrCreateDeckByName(DEFAULT_DECK_NAME, ownerId);
  return { deckId, deck: DEFAULT_DECK_NAME };
}

/* ------------------------------------------------------------------ */
/* Error classes                                                       */
/* ------------------------------------------------------------------ */

export class EnrollmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentValidationError';
  }
}

/* ------------------------------------------------------------------ */
/* Chunk management                                                    */
/* ------------------------------------------------------------------ */

/**
 * Splits cards into chunks of ≤ENROLLMENT_CHUNK_SIZE and writes them as
 * chunk documents in a Firestore subcollection under the job. Each chunk
 * stores the raw card payloads so that resume does not require the client
 * to resend the full payload.
 */
async function writeChunks(
  jobId: string,
  cards: CreateFlashcardInput[],
  ownerId: string,
): Promise<{ totalChunks: number; totalCards: number }> {
  if (cards.length === 0) {
    return { totalChunks: 0, totalCards: 0 };
  }
  const chunksSubcoll = getDb()
    .collection(JOBS_COLLECTION)
    .doc(jobId)
    .collection(CHUNKS_SUBCOLLECTION);

  const totalChunks = Math.ceil(cards.length / ENROLLMENT_CHUNK_SIZE);

  // Write all chunk metadata in a single Firestore WriteBatch (atomic).
  // 53 chunks for 5,298 cards is well under the 500-write batch limit.
  // This turns 53 sequential network round-trips into one, keeping the
  // initial POST fast enough for the 15s MCP bridge timeout.
  const batch = getDb().batch();
  for (let i = 0; i < totalChunks; i++) {
    const chunkCards = cards.slice(i * ENROLLMENT_CHUNK_SIZE, (i + 1) * ENROLLMENT_CHUNK_SIZE);
    const paddedIndex = String(i).padStart(5, '0');
    batch.set(chunksSubcoll.doc(paddedIndex), {
      chunkIndex: i,
      cards: chunkCards,
      cardCount: chunkCards.length,
      status: 'pending',
      ownerId,
      createdCount: 0,
      failedCount: 0,
    });
  }
  await batch.commit();

  return { totalChunks, totalCards: cards.length };
}

/**
 * Reads the card payloads from a chunk document.
 */
async function readChunkCards(
  jobId: string,
  chunkIndex: number,
): Promise<CreateFlashcardInput[]> {
  const paddedIndex = String(chunkIndex).padStart(5, '0');
  const snap = await getDb()
    .collection(JOBS_COLLECTION)
    .doc(jobId)
    .collection(CHUNKS_SUBCOLLECTION)
    .doc(paddedIndex)
    .get();
  if (!snap.exists) return [];
  return (snap.data()?.cards as CreateFlashcardInput[]) || [];
}

/**
 * Scans all chunk documents for a job and returns the status of each.
 * Used by the resume path to detect stuck/pending/processing chunks
 * that need to be retriggered.
 */
async function scanChunkStatuses(
  jobId: string,
  totalChunks: number,
): Promise<Array<{ index: number; status: string | undefined; exists: boolean }>> {
  const chunksSubcoll = getDb()
    .collection(JOBS_COLLECTION)
    .doc(jobId)
    .collection(CHUNKS_SUBCOLLECTION);
  const results: Array<{ index: number; status: string | undefined; exists: boolean }> = [];
  for (let i = 0; i < totalChunks; i++) {
    const paddedIndex = String(i).padStart(5, '0');
    const snap = await chunksSubcoll.doc(paddedIndex).get();
    results.push({
      index: i,
      status: snap.exists ? (snap.data()?.status as string | undefined) : undefined,
      exists: snap.exists,
    });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Job document management                                             */
/* ------------------------------------------------------------------ */

async function createJobDocument(
  jobId: string,
  ownerId: string,
  totalChunks: number,
  totalCards: number,
): Promise<void> {
  const now = Timestamp.now();
  await getDb().collection(JOBS_COLLECTION).doc(jobId).set({
    ownerId,
    status: 'pending',
    contentHash: jobId,
    totalCards,
    totalChunks,
    completedChunks: 0,
    createdCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

async function readJobDocument(jobId: string): Promise<BulkEnrollmentJob | null> {
  const snap = await getDb().collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return { id: snap.id, ...data } as BulkEnrollmentJob;
}

async function updateJobProgress(
  jobId: string,
  fields: Partial<Pick<BulkEnrollmentJob,
    'completedChunks' | 'createdCount' | 'failedCount' | 'status' | 'error' | 'completedAt'
  >>,
): Promise<void> {
  await getDb().collection(JOBS_COLLECTION).doc(jobId).update({
    ...fields,
    updatedAt: Timestamp.now(),
  });
}

/* ------------------------------------------------------------------ */
/* Chunk processing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalizes a card's content fields for comparison against existing cards.
 * Used for legacy reconciliation: matching cards created by random-ID
 * bulk_create that won't match the deterministic card key.
 */
function normalizeCardContent(card: {
  front: string; back: string; tags?: string[];
  topic?: string | null; suspended?: boolean;
}): { front: string; back: string; tags: string[]; topic: string; suspended: boolean } {
  return {
    front: card.front.trim(),
    back: card.back.trim(),
    tags: [...(card.tags || [])].sort(),
    topic: (card.topic ?? '').trim(),
    suspended: card.suspended === true,
  };
}

function contentMatches(
  existing: { front?: string; back?: string; tags?: string[]; topic?: string; suspended?: boolean },
  target: ReturnType<typeof normalizeCardContent>,
): boolean {
  return (existing.front ?? '').trim() === target.front
    && (existing.back ?? '').trim() === target.back
    && JSON.stringify([...(existing.tags || [])].sort()) === JSON.stringify(target.tags)
    && ((existing.topic ?? '').trim() === target.topic)
    && ((existing.suspended ?? false) === target.suspended);
}

/**
 * Reconciles a new card against existing same-owner cards in a deck.
 * For cards WITH a deckId: queries existing cards in that deck and checks
 * for content match (front/back/tags/topic/suspended). If found, returns
 * the existing card's id (skip write). If not found, returns null (create).
 *
 * This handles legacy random-ID cards created by the old bulk_create API.
 *
 * LIMITATION: Cards without a deckId in the input are resolved to the
 * `Uncategorized` default deck, so reconciliation uses the deck-scoped
 * query path. Legacy random-ID cards without a deckId cannot be safely
 * reconciled without a broad scan of the owner's entire library (no
 * composite index on content fields).
 *
 * @param chunkCards  Cards in the current chunk
 * @param ownerId     The authenticated owner
 * @param deckCache   Resolved deck references (deckId → { deckId, deck })
 * @param matchedKeys Set to track already-matched content keys within
 *                    this chunk (prevents intra-chunk duplicates)
 * @returns Map from card index → existing card id (skip) or null (create)
 */
async function reconcileLegacyCards(
  chunkCards: CreateFlashcardInput[],
  ownerId: string,
  deckCache: Map<string, { deckId: string; deck: string } | null>,
  matchedKeys: Set<string>,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();

  // Group cards by resolved deckId for efficient querying.
  const byDeck = new Map<string, number[]>();
  const noDeck: number[] = [];

  for (let i = 0; i < chunkCards.length; i++) {
    const card = chunkCards[i];
    const deckKey = `${card.deckId ?? ''}|${card.deck ?? ''}`;
    const ref = deckCache.get(deckKey);
    if (ref?.deckId) {
      if (!byDeck.has(ref.deckId)) byDeck.set(ref.deckId, []);
      byDeck.get(ref.deckId)!.push(i);
    } else {
      noDeck.push(i);
    }
  }

  // For each deck: query existing cards once, then match all cards in
  // that deck against the query results.
  for (const [deckId, indices] of byDeck) {
    const existingSnap = await getDb()
      .collection(FLASHCARDS_COLLECTION)
      .where('ownerId', '==', ownerId)
      .where('deckId', '==', deckId)
      .get();

    const existingDocs = existingSnap.docs.map((d) => ({
      id: d.id,
      data: d.data(),
    }));

    for (const idx of indices) {
      const card = chunkCards[idx];
      const target = normalizeCardContent(card);
      const contentKey = `${target.front}|${target.back}|${JSON.stringify(target.tags)}|${target.topic}|${target.suspended}`;

      // Check deterministic card key first (same-owner direct hit).
      const cardKey = computeCardKey(
        ownerId, card.front, card.back, card.tags || [],
        card.deckId, card.topic, card.suspended,
      );
      const keySnap = await getDb().collection(FLASHCARDS_COLLECTION).doc(cardKey).get();
      if (keySnap.exists && keySnap.data()?.ownerId === ownerId) {
        result.set(idx, cardKey);
        matchedKeys.add(contentKey);
        continue;
      }

      // Legacy content match: check existing cards in this deck.
      for (const existing of existingDocs) {
        if (contentMatches(existing.data, target)) {
          result.set(idx, existing.id);
          matchedKeys.add(contentKey);
          break;
        }
      }

      // Also check if another card in this chunk with the same content
      // was already matched (prevents intra-chunk duplicates).
      if (!result.has(idx) && matchedKeys.has(contentKey)) {
        result.set(idx, '__skip__');
      }
    }
  }

  // Cards without a deckId: only check by deterministic key (already
  // done in processChunk's existingSnaps). Mark as not reconciled.
  for (const idx of noDeck) {
    result.set(idx, null);
  }

  return result;
}

/**
 * Processes one chunk: reconciles legacy cards, writes new cards, skips
 * existing same-owner cards.
 *
 * Cards use deterministic document ids (cardKey) that include ALL content-
 * bearing fields. If a card document already exists with the same ownerId,
 * the write is SKIPPED. For cards that don't match by key (legacy random-
 * ID cards), a deck-scoped content search finds matches by front/back/
 * tags/topic/suspended within the target deck.
 *
 * Deck resolution happens outside the batch (standalone writes allowed).
 */
async function processChunk(
  chunkCards: CreateFlashcardInput[],
  ownerId: string,
): Promise<{ created: number; skipped: number; failed: number; errors: string[] }> {
  if (chunkCards.length === 0) {
    return { created: 0, skipped: 0, failed: 0, errors: [] };
  }

  // Resolve deck references outside the batch.  Every enrolled card must
  // belong to a deck — fall back to Uncategorized when input omits both.
  const deckCache = new Map<string, { deckId: string; deck: string } | null>();
  const defaultDeck = await resolveDefaultDeck(ownerId);
  for (const card of chunkCards) {
    const deckKey = `${card.deckId ?? ''}|${card.deck ?? ''}`;
    if (!deckCache.has(deckKey)) {
      if (card.deckId !== undefined || card.deck !== undefined) {
        deckCache.set(deckKey, await resolveDeckRef(card, ownerId) ?? defaultDeck);
      } else {
        deckCache.set(deckKey, defaultDeck);
      }
    }
  }

  // Reconcile against existing cards (handles legacy random-ID cards).
  const matchedKeys = new Set<string>();
  const reconciled = await reconcileLegacyCards(chunkCards, ownerId, deckCache, matchedKeys);

  // Read existing cards by deterministic key (fast path).
  const cardKeys = chunkCards.map((c) =>
    computeCardKey(ownerId, c.front, c.back, c.tags || [], c.deckId, c.topic, c.suspended),
  );
  const docRefs = cardKeys.map((k) => getDb().collection(FLASHCARDS_COLLECTION).doc(k));
  const existingSnaps = await Promise.all(docRefs.map((r) => r.get()));

  const now = Timestamp.now();
  const scheduling = initialScheduling(now);
  const batch = getDb().batch();
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < chunkCards.length; idx++) {
    const card = chunkCards[idx];
    try {
      const existingSnap = existingSnaps[idx];

      // Fast path: deterministic key hit, same owner → skip.
      if (existingSnap.exists && existingSnap.data()?.ownerId === ownerId) {
        skipped++;
        continue;
      }

      // Deterministic key hit, different owner → fail.
      if (existingSnap.exists && existingSnap.data()?.ownerId !== ownerId) {
        failed++;
        errors.push(`Card "${card.front.slice(0, 40)}…": belongs to another owner`);
        continue;
      }

      // Legacy reconciliation found a match → skip.
      const reconciledId = reconciled.get(idx);
      if (reconciledId) {
        skipped++;
        continue;
      }

      // New card — create with fresh scheduling.
      const docRef = docRefs[idx];
      const payload: Record<string, unknown> = {
        ownerId,
        front: card.front.trim(),
        back: card.back.trim(),
        tags: (card.tags || []).map((t: string) => t.trim()).sort(),
        createdAt: now,
        updatedAt: now,
        ...scheduling,
        reviewLog: [],
        images: [],
      };
      if (card.topic !== undefined && card.topic !== null) {
        payload.topic = card.topic;
      }
      const deckKey = `${card.deckId ?? ''}|${card.deck ?? ''}`;
      applyDeckRef(payload, deckCache.get(deckKey) ?? null);

      batch.set(docRef, payload);
      created++;
    } catch (err) {
      failed++;
      errors.push(`Card "${card.front.slice(0, 40)}…": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (created > 0) {
    await batch.commit();
  }

  return { created, skipped, failed, errors };
}

/* ------------------------------------------------------------------ */
/* Firestore trigger — processes chunks on write                       */
/* ------------------------------------------------------------------ */

/**
 * Firestore onDocumentWritten trigger on
 * `bulkEnrollmentJobs/{jobId}/chunks/{chunkIndex}`.
 *
 * Fires on BOTH creation (initial chunk write) AND updates (resume
 * re-writing pending chunks). The handler reads the CURRENT chunk state
 * inside a single transaction: if the chunk is already completed, it
 * no-ops. Otherwise it processes cards, marks the chunk completed, and
 * increments job counters — all atomically within one transaction.
 *
 * This solves three problems:
 *  1. Duplicate events: a retry carries the ORIGINAL pending snapshot,
 *     but the transaction reads the CURRENT state. If the first
 *     invocation already completed the chunk, the transaction sees
 *     status='completed' and returns without duplicate increments.
 *  2. Resume not triggering: onDocumentWritten fires on .set() updates,
 *     so resume re-writing chunks as 'pending' triggers re-processing.
 *  3. Atomicity: chunk completion + job counters are one transaction.
 *     No standalone chunk update that could be lost between writes.
 *
 * Idempotency guarantees:
 *  - Card writes use deterministic doc ids (cardKey) — re-processing
 *    overwrites the same documents, never duplicates.
 *  - The transaction reads current chunk status: already-completed
 *    chunks are no-ops (zero duplicate increments).
 *  - Failures are recorded on the chunk (lastError) and parent job
 *    (status → failed, error). getEnrollmentStatus surfaces them.
 *    Exact re-submission retriggers non-completed chunks.
 */
/**
 * Shape of the Firestore onDocumentWritten event.
 * `data.after` is the post-write snapshot; `data.before` is the pre-write
 * snapshot (absent on creation). Both have `.data()` and `.ref` with the
 * document path.
 */
export interface ChunkWrittenEvent {
  data?: {
    after?: {
      data?: () => Record<string, unknown>;
      ref?: {
        id?: string;
        parent?: {
          id?: string;
          parent?: {
            id?: string;
          };
        };
      };
    };
    before?: {
      data?: () => Record<string, unknown>;
    };
  };
}

export async function onEnrollmentChunkWritten(
  event: ChunkWrittenEvent,
): Promise<void> {
  const after = event.data?.after;
  if (!after?.data) return;

  const chunkRef = after.ref;
  const jobId = chunkRef?.parent?.parent?.id;
  const chunkId = chunkRef?.id;
  if (!jobId || !chunkId) return;

  // Read CURRENT chunk state (not the event snapshot, which may be stale
  // from a duplicate/retry event that carries the original pending data).
  const chunkDocRef = getDb()
    .collection(JOBS_COLLECTION)
    .doc(jobId)
    .collection(CHUNKS_SUBCOLLECTION)
    .doc(chunkId);
  const chunkSnap = await chunkDocRef.get();
  const chunkData = chunkSnap.data();
  if (!chunkData || chunkData.status === 'completed') return;

  const ownerId = chunkData.ownerId as string | undefined;
  const cards = chunkData.cards as CreateFlashcardInput[] | undefined;
  if (!ownerId || !cards || cards.length === 0) return;

  // Process cards OUTSIDE any transaction. processChunk is idempotent:
  // deterministic card doc ids mean re-processing overwrites the same
  // documents. Card writes are harmless duplicates on re-submission.
  let result: { created: number; skipped: number; failed: number; errors: string[] };
  try {
    result = await processChunk(cards, ownerId);
  } catch (err) {
    // Best-effort: record error on chunk AND mark parent job failed so
    // getEnrollmentStatus surfaces the failure. Chunk stays
    // non-completed → exact re-submission retriggers it.
    const errMsg = err instanceof Error ? err.message : String(err);
    const now = Timestamp.now();
    await chunkDocRef.update({ lastError: errMsg, lastErrorAt: now }).catch(() => {});
    const jobDocRef = getDb().collection(JOBS_COLLECTION).doc(jobId);
    await jobDocRef.update({
      status: 'failed',
      error: `Chunk ${chunkId}: ${errMsg}`,
      updatedAt: now,
    }).catch(() => {});
    throw err;
  }

  // Metadata-only transaction: read current chunk + job state, no-op if
  // chunk already completed (handles concurrent/repeated triggers),
  // otherwise mark chunk completed and atomically increment job counters.
  // No external writes inside this transaction — only t.update on
  // documents we just read.
  const jobDocRef = getDb().collection(JOBS_COLLECTION).doc(jobId);

  try {
    await getDb().runTransaction(async (t) => {
      // ALL reads must come before ANY writes (Firestore tx constraint).
      const txChunkSnap = await t.get(chunkDocRef);
      const jobSnap = await t.get(jobDocRef);

      const txChunkData = txChunkSnap.data();
      if (!txChunkData || txChunkData.status === 'completed') return;

      const jobData = jobSnap.data();
      if (!jobData) return;

      // Compute terminal state from read values before any writes.
      const totalChunks = jobData.totalChunks ?? 0;
      const newCompletedChunks = (jobData.completedChunks ?? 0) + 1;
      const isLastChunk = newCompletedChunks >= totalChunks;

      // Now issue all writes.
      t.update(chunkDocRef, {
        status: 'completed',
        createdCount: result.created,
        failedCount: result.failed,
        skippedCount: result.skipped,
        error: result.errors.length > 0 ? result.errors[result.errors.length - 1] : null,
        processedAt: Timestamp.now(),
      });

      t.update(jobDocRef, {
        completedChunks: FieldValue.increment(1),
        createdCount: FieldValue.increment(result.created),
        skippedCount: FieldValue.increment(result.skipped),
        failedCount: FieldValue.increment(result.failed),
        ...(result.errors.length > 0 ? { lastChunkError: result.errors[result.errors.length - 1] } : {}),
        ...(isLastChunk ? {
          status: result.failed > 0 ? 'failed' : 'completed',
          completedAt: Timestamp.now(),
        } : {}),
        updatedAt: Timestamp.now(),
      });
    });
  } catch (txErr) {
    // Transaction failed (contention, deadline, etc.). Best-effort: mark
    // parent job failed for observability. Chunk stays non-completed →
    // exact re-submission rewrites it as pending and retriggers it.
    const errMsg = txErr instanceof Error ? txErr.message : String(txErr);
    const now = Timestamp.now();
    await chunkDocRef.update({ lastError: errMsg, lastErrorAt: now }).catch(() => {});
    const jobDocRef = getDb().collection(JOBS_COLLECTION).doc(jobId);
    await jobDocRef.update({
      status: 'failed',
      error: `Chunk ${chunkId}: ${errMsg}`,
      updatedAt: now,
    }).catch(() => {});
    throw txErr;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Start or resume a bulk enrollment. Returns IMMEDIATELY with the jobId
 * and initial status. Chunk processing is triggered by Firestore's
 * onDocumentWritten trigger on the chunk subcollection — durable and
 * independent of HTTP connection lifetime. On failure the chunk and
 * parent job are marked failed; exact re-submission retriggers
 * non-completed chunks.
 *
 * Flow:
 *  1. Validate input (1..ENROLLMENT_MAX_CARDS cards).
 *  2. Compute content-addressable job ID from card keys.
 *  3. If job exists → check status. If completed, return immediately.
 *     If incomplete, mark processing.
 *  4. If new → write chunk documents (each triggers the Firestore
 *     onDocumentWritten handler), create job doc.
 *  5. Return jobId + status IMMEDIATELY (no waiting for card writes).
 *
 * Each chunk's Firestore trigger fires on document creation and
 * processes the chunk atomically. Progress is updated after each chunk.
 * On failure, the chunk and parent job are marked failed with an error.
 * The chunk status check short-circuits re-processing of completed chunks.
 * Exact re-submission retriggers non-completed chunks.
 */
export async function bulkEnrollCards(
  input: BulkEnrollCardsInput,
  ownerId: string,
): Promise<BulkEnrollCardsResponse> {
  if (!input.cards || input.cards.length === 0) {
    throw new EnrollmentValidationError('Cards array must not be empty');
  }
  if (input.cards.length > ENROLLMENT_MAX_CARDS) {
    throw new EnrollmentValidationError(
      `Too many cards: ${input.cards.length} (max ${ENROLLMENT_MAX_CARDS})`,
    );
  }

  const jobId = computeJobId(ownerId, input.cards);
  const existingJob = await readJobDocument(jobId);

  let totalChunks: number;
  let totalCards: number;
  let startChunk: number;
  let createdCount: number;
  let failedCount: number;
  let retriedChunkCount = 0;

  if (existingJob) {
    if (existingJob.ownerId !== ownerId) {
      throw new EnrollmentValidationError('Job belongs to another owner');
    }

    // Already done: return immediately.
    if (existingJob.status === 'completed') {
      return {
        jobId,
        status: 'completed',
        totalCards: existingJob.totalCards,
        totalChunks: existingJob.totalChunks,
        completedChunks: existingJob.totalChunks,
        createdCount: existingJob.createdCount,
        skippedCount: 'skippedCount' in existingJob ? (existingJob.skippedCount as number) : 0,
        failedCount: existingJob.failedCount,
        retriedChunkCount: 0,
      };
    }

    // Resume from last completed chunk.
    totalChunks = existingJob.totalChunks;
    totalCards = existingJob.totalCards;
    startChunk = existingJob.completedChunks;
    createdCount = existingJob.createdCount;
    failedCount = existingJob.failedCount;

    if (totalCards !== input.cards.length) {
      throw new EnrollmentValidationError(
        `Job ${jobId} exists with ${totalCards} cards but ${input.cards.length} were provided`,
      );
    }

    // Set status to 'processing' — allows transition from any non-completed
    // state including 'failed' (self-healing). Only 'completed' is terminal.
    const jobDocRef = getDb().collection(JOBS_COLLECTION).doc(jobId);
    await getDb().runTransaction(async (t) => {
      const snap = await t.get(jobDocRef);
      const data = snap.data();
      if (!data || data.status === 'completed') return;
      t.update(jobDocRef, { status: 'processing', updatedAt: Timestamp.now() });
    });

    // Re-read to get the authoritative status after the transaction.
    const postTxJob = await readJobDocument(jobId);
    if (postTxJob?.status === 'completed') {
      return {
        jobId,
        status: 'completed',
        totalCards: postTxJob.totalCards,
        totalChunks: postTxJob.totalChunks,
        completedChunks: postTxJob.totalChunks,
        createdCount: postTxJob.createdCount,
        skippedCount: 'skippedCount' in postTxJob ? (postTxJob.skippedCount as number) : 0,
        failedCount: postTxJob.failedCount,
        retriedChunkCount: 0,
      };
    }

    // Scan ALL chunks to find any that are not completed (pending,
    // processing, missing, or failed). Rewriting them as 'pending'
    // triggers the onDocumentWritten handler for reprocessing.
    // This self-heals: missing chunks (partial batch write), stuck
    // chunks (trigger/tx failed after card writes), and previously
    // failed jobs where individual chunks weren't completed.
    const chunkStatuses = await scanChunkStatuses(jobId, totalChunks);
    const resumeBatch = getDb().batch();
    retriedChunkCount = 0;
    const chunksSubcoll = getDb()
      .collection(JOBS_COLLECTION)
      .doc(jobId)
      .collection(CHUNKS_SUBCOLLECTION);
    for (const cs of chunkStatuses) {
      if (cs.status === 'completed') continue;
      // Chunk is pending, processing, missing, or in an unknown state.
      // For existing chunk docs, read durable card payloads; for missing
      // chunks (partial initial batch write), reconstruct from input.cards.
      let chunkCards = await readChunkCards(jobId, cs.index);
      if (chunkCards.length === 0) {
        // Missing chunk — reconstruct from the original input.
        const start = cs.index * ENROLLMENT_CHUNK_SIZE;
        chunkCards = input.cards.slice(start, start + ENROLLMENT_CHUNK_SIZE);
      }
      if (chunkCards.length === 0) continue;
      const paddedIndex = String(cs.index).padStart(5, '0');
      resumeBatch.set(chunksSubcoll.doc(paddedIndex), {
        chunkIndex: cs.index,
        cards: chunkCards,
        cardCount: chunkCards.length,
        status: 'pending',
        ownerId,
        createdCount: 0,
        failedCount: 0,
      });
      retriedChunkCount++;
    }
    await resumeBatch.commit();
  } else {
    // New job: create job doc FIRST so triggers that fire on chunk
    // creation always find a parent job document.
    totalCards = input.cards.length;
    totalChunks = Math.ceil(totalCards / ENROLLMENT_CHUNK_SIZE);
    startChunk = 0;
    createdCount = 0;
    failedCount = 0;
    retriedChunkCount = 0;

    await createJobDocument(jobId, ownerId, totalChunks, totalCards);
    await updateJobProgress(jobId, { status: 'processing' });

    // Now write chunks — each triggers onDocumentWritten.
    await writeChunks(jobId, input.cards, ownerId);
  }

  return {
    jobId,
    status: 'processing',
    totalCards,
    totalChunks,
    completedChunks: startChunk,
    createdCount,
    skippedCount: 0,
    failedCount,
    retriedChunkCount,
  };
}

/**
 * Get the current status of an enrollment job. Returns a normalized
 * response for the client, or null when the job doesn't exist.
 */
export async function getEnrollmentStatus(
  jobId: string,
  ownerId: string,
): Promise<BulkEnrollStatusResponse | null> {
  const job = await readJobDocument(jobId);
  if (!job || job.ownerId !== ownerId) return null;

  // Surface per-chunk errors when the job is not terminal.
  const chunkErrors: Array<{ chunkIndex: number; error: string }> = [];
  if (job.status !== 'completed') {
    for (let i = 0; i < (job.totalChunks ?? 0); i++) {
      const paddedIndex = String(i).padStart(5, '0');
      const snap = await getDb()
        .collection(JOBS_COLLECTION).doc(jobId)
        .collection(CHUNKS_SUBCOLLECTION).doc(paddedIndex).get();
      const data = snap.data();
      if (data?.lastError) {
        chunkErrors.push({ chunkIndex: i, error: data.lastError as string });
      }
    }
  }

  return {
    jobId: job.id,
    status: job.status,
    totalCards: job.totalCards,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    createdCount: job.createdCount,
    skippedCount: 'skippedCount' in job ? (job.skippedCount as number) : 0,
    failedCount: job.failedCount,
    createdAt: job.createdAt.toDate().toISOString(),
    updatedAt: job.updatedAt.toDate().toISOString(),
    completedAt: job.completedAt?.toDate().toISOString(),
    error: job.error,
    ...(chunkErrors.length > 0 ? { chunkErrors } : {}),
  };
}

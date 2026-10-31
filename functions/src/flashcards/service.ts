import { createHash, randomUUID } from 'node:crypto';
import { getFirestore, Firestore, Timestamp, FieldValue, QueryDocumentSnapshot, DocumentSnapshot, DocumentData, DocumentReference, FieldPath } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  Flashcard, CreateFlashcardInput, UpdateFlashcardInput, ListFlashcardsQuery, ListFlashcardsResponse,
  Deck,
  DueFlashcardsQuery, DueFlashcardsResponse, ReviewFlashcardInput, ReviewFlashcardResponse,
  BulkCreateFlashcardsInput, BulkCreateFlashcardsResponse, BulkUpdateFlashcardsInput,
  BulkUpdateFlashcardsResponse, BulkDeleteFlashcardsInput, BulkDeleteFlashcardsResponse,
  ListTagsQuery, ListTagsResponse, RenameTagInput, TagActionResult,
  DeleteTagInput, MergeTagsInput,
  AttachImageInput, AttachImageResponse, ListImagesResponse, RemoveImageResponse,
  UploadImageInput, UploadImageResponse,
  ReviewSession, StartReviewSessionInput, ReviewSessionWithCard, SubmitSessionReviewInput,
  SubmitSessionReviewResult, PreloadedCard, SessionQueueItem, SessionChunkDocument, SessionQueueWindow, SessionQueueWindowEntry,
  SESSION_PRELOAD, SESSION_STORAGE_VERSION, SESSION_QUEUE_CHUNK_SIZE, SESSION_BUILD_PAGE_SIZE, SESSION_MAX_ALLOWLIST_IDS, CardType,
  SessionStatus, SessionMode, SessionRatingCounts, SESSION_MODES, ReviewSessionSource,
  SearchCardsQuery, SearchCardsResponse,
  CountFlashcardsQuery, CountFlashcardsResponse, FlashcardCounts, CountByDeck,
  MAX_CARD_IMAGES, MAX_IMAGE_URL_LENGTH, MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_DATA_LENGTH, MAX_IMAGE_FILE_NAME_LENGTH, CardImage,
  CARD_STATES,
  SchedulingActionResponse,
} from './types';
import {
  DeckNotFoundError, findOwnedDeckByExactName, getDefaultOwnedDeck, getDeck,
  readOwnedDeckInTransaction, resolveOwnedDeckRef,
} from './decks';
import {
  InvalidPageTokenError, makeDocumentPageToken, timestampFromDocumentPageCursor,
  validateDocumentPageToken, canonicalScopeFingerprint,
} from './documentPageTokens';
import { applyReview, initialScheduling, legacyScheduling, resolveReviewTime } from './scheduler';
import { buildEventBody, trimEmbeddedReviewLog, sessionEventId } from './reviewHistory';
import {
  cardMatchesFilters, makeSearchPageToken,
  normalizeSearchFilters, readSearchPageToken, searchFiltersKey,
} from './search';


let db: Firestore | undefined;

function getDb(): Firestore {
  if (!db) {
    db = getFirestore();
  }
  return db;
}
/**
 * REVIEW_TEST_MODE is a TEMPORARY, env-gated widget-testing mode (default
 * OFF; do not enable in production). When on:
 *  - startReviewSession queues ALL cards (not only `due <= now`) — a query
 *    override, never a bulk mutation of due fields.
 *  - submitSessionReview advances the SESSION mechanics (currentIndex,
 *    reviewedCount, ratingCounts, status) but SKIPS the card FSRS
 *    scheduling / reviewLog write, so no card is mutated by ratings.
 * Normal review_flashcard / dueFlashcards behavior is untouched.
 * To disable: unset REVIEW_TEST_MODE (or set to anything but 'true') and
 * redeploy the function.
 */
export function isReviewTestMode(): boolean {
  return process.env.REVIEW_TEST_MODE === 'true';
}

const COLLECTION = 'flashcards';
const DECKS_COLLECTION = 'decks';
const SESSIONS_COLLECTION = 'reviewSessions';
/** Private request-idempotency claims under each bounded v2 session. */
const SESSION_REQUEST_CLAIMS_COLLECTION = 'requestClaims';
/** Child collection under each v2 session document owning the queue chunks. */
const SESSION_QUEUE_CHUNKS_COLLECTION = 'queueChunks';
const PAGE_SIZE_MAX = 100;


function listFlashcardsCursorFilters(query: ListFlashcardsQuery): unknown {
  const tags = query.tags?.split(',').map((tag) => tag.trim()).filter(Boolean);
  return {
    deckId: query.deckId || null,
    deck: query.deckId ? null : query.deck || null,
    tags: tags?.length ? [...new Set(tags)].sort() : [],
  };
}

function dueFlashcardsCursorFilters(query: DueFlashcardsQuery): unknown {
  return {
    deckId: query.deckId || null,
    deck: query.deckId ? null : query.deck || null,
  };
}
const PAGE_SIZE_DEFAULT = 20;
function docToFlashcard(doc: DocumentSnapshot<DocumentData>): Flashcard {
  const data = doc.data();
  if (!data) {
    throw new Error('Document data is undefined');
  }
  const legacy = legacyScheduling();
  return {
    id: doc.id,
    ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
    front: data.front,
    back: data.back,
    ...(data.deck !== undefined ? { deck: data.deck as string } : {}),
    ...(data.deckId !== undefined ? { deckId: data.deckId as string } : {}),
    tags: data.tags || [],
    ...(data.topic !== undefined ? { topic: data.topic as string } : {}),
    // Legacy documents (written before suspension existed) have no
    // `suspended` field — they read as NOT suspended (false).
    ...(data.suspended !== undefined ? { suspended: data.suspended as boolean } : { suspended: false }),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    due: data.due as Timestamp,
    // FSRS scheduling fields; defaults keep pre-FSRS documents readable.
    state: CARD_STATES.includes(data.state) ? data.state : legacy.state,
    stability: typeof data.stability === 'number' ? data.stability : legacy.stability,
    difficulty: typeof data.difficulty === 'number' ? data.difficulty : legacy.difficulty,
    reps: typeof data.reps === 'number' ? data.reps : legacy.reps,
    lapses: typeof data.lapses === 'number' ? data.lapses : legacy.lapses,
    ...(typeof data.learningSteps === 'number' ? { learningSteps: data.learningSteps as number } : {}),
    ...(data.lastReview ? { lastReview: data.lastReview as Timestamp } : {}),
    reviewLog: Array.isArray(data.reviewLog) ? data.reviewLog : [],
    images: Array.isArray(data.images) ? data.images : [],
  };
}



/**
 * Strips Firestore `FieldValue.delete()` sentinels from an object. These
 * internal markers must never leak into API responses — a deleted field
 * reads as ABSENT, not as an opaque object. Applied after every in-memory
 * merge that may include delete sentinels (unsuspend's `suspended`, reset's
 * `lastReview`, deck detaches, etc.).
 */
function stripFieldDeleteSentinels(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value instanceof FieldValue) {
      delete obj[key];
    }
  }
}

/**
 * Builds the card object returned to API clients after an in-memory merge
 * with an update payload. Firestore `FieldValue.delete()` sentinels must NOT
 * leak into responses: a deleted field reads as ABSENT on the returned card,
 * matching what a re-read of the document would produce.
 */
function mergeCardForResponse(snap: DocumentSnapshot<DocumentData>, updateData: Partial<Flashcard>): Flashcard {
  const merged = { ...docToFlashcard(snap), ...updateData };
  stripFieldDeleteSentinels(merged as Record<string, unknown>);
  return merged;
}

/** Explicit null deck references are rejected to preserve the every-card-has-a-deck invariant. */
export class CardDeckRequiredError extends Error {
  constructor() {
    super('Cannot detach a card from its deck; every card must belong to a deck');
    this.name = 'CardDeckRequiredError';
  }
}








/**
 * Tag rewrites scan and transact over bounded pages. Each transaction reads
 * and conditionally updates at most this many cards.
 */
const TAG_ACTION_PAGE_SIZE = 400;

/* ------------------------------------------------------------------ */
/* Tag management (list / rename / delete / merge)                     */
/* ------------------------------------------------------------------ */
/**
 * Dedupes a card's `tags` array preserving FIRST-OCCURRENCE order. Stored
 * arrays may contain duplicates (validators accept them and never dedupe),
 * so every rewrite that touches tags produces a clean array.
 */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Lists the distinct tags in the library: every distinct, exact,
 * case-sensitive name appearing in any flashcard's `tags` array, with the
 * number of cards carrying it.
 *
 * Tags are DERIVED — there is no tag collection — so the whole `tags`
 * arrays of every flashcard are scanned once (paged by document id, like
 * migrateLegacyDeckNames) and aggregated in memory; a Firestore `count()`
 * aggregate cannot enumerate distinct values. The response is sorted by tag
 * name ASCENDING and paginated with the listDecks convention (`pageSize`
 * 1–100, default 20): `pageToken` is the LAST tag name of the previous
 * page, and the next page resumes strictly after it. Tags are naturally
 * unique and sort-stable, so the name cursor never skips or duplicates a
 * tag, even when cards change between pages.
 */
export async function listTags(query: ListTagsQuery, ownerId: string): Promise<ListTagsResponse> {
  const counts = new Map<string, number>();
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  for (;;) {
    let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
    q = q.where('ownerId', '==', ownerId);
    q = q.select('tags').orderBy('__name__').limit(500);
    if (lastDoc) q = q.startAfter(lastDoc);
    const page = await q.get();
    if (page.docs.length === 0) break;
    lastDoc = page.docs[page.docs.length - 1];
    for (const doc of page.docs) {
      const tags = Array.isArray(doc.data().tags) ? doc.data().tags as string[] : [];
      // A card contributes at most once to each tag count, even if legacy or
      // accepted input data contains repeated values.
      for (const tag of new Set(tags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    if (page.docs.length < 500) break;
  }

  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const all = [...counts.entries()]
    .map(([name, cardCount]) => ({ name, cardCount }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let start = 0;
  if (query.pageToken) {
    // Resume strictly after the last tag name of the previous page (tags
    // have no document id; the lexicographic name order is the cursor).
    start = all.findIndex((t) => t.name > query.pageToken!);
    if (start < 0) start = all.length;
  }

  const tags = all.slice(start, start + pageSize);
  const hasMore = start + pageSize < all.length;
  return { tags, nextPageToken: hasMore ? tags[tags.length - 1].name : null };
}

/**
 * Applies a derived tag rewrite in bounded, owner-scoped pages. Each page is
 * re-read and updated transactionally so overlapping tag actions compose on
 * the latest stored tags rather than overwriting one another's changes.
 */
async function runTagAction(
  sourceTag: string,
  rewrite: (tags: string[]) => string[],
  ownerId: string,
): Promise<TagActionResult> {
  let affectedCards = 0;
  let cursor: string | undefined;

  for (;;) {
    let query: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION)
      .where('ownerId', '==', ownerId)
      .where('tags', 'array-contains', sourceTag)
      .orderBy(FieldPath.documentId())
      .select('ownerId', 'tags')
      .limit(TAG_ACTION_PAGE_SIZE);
    if (cursor !== undefined) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;
    cursor = page.docs[page.docs.length - 1].id;
    const refs = page.docs.map((doc) => doc.ref);
    const changedInPage = await getDb().runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(...refs, { fieldMask: ['ownerId', 'tags'] });
      const now = Timestamp.now();
      let changed = 0;
      for (const snapshot of snapshots) {
        const card = snapshot.data();
        if (!card || card.ownerId !== ownerId || !Array.isArray(card.tags)) continue;
        const currentTags = card.tags as string[];
        if (!currentTags.includes(sourceTag)) continue;
        const nextTags = dedupeTags(rewrite(currentTags));
        if (currentTags.length === nextTags.length
            && currentTags.every((tag, index) => tag === nextTags[index])) continue;
        transaction.update(snapshot.ref, { tags: nextTags, updatedAt: now });
        changed += 1;
      }
      return changed;
    });
    affectedCards += changedInPage;
    if (page.docs.length < TAG_ACTION_PAGE_SIZE) break;
  }

  return { affectedCards };
}

/**
 * Renames a tag: every card carrying `from` (exact, case-sensitive) has it
 * replaced by `to`. When a card already carries `to`, the result is a single
 * `to` (the arrays are deduped — the same effective semantics as merge for
 * that card). `from` and `to` must differ (validator-enforced). A `from`
 * that no card carries is a successful no-op (`affectedCards: 0`); every
 * matched card's source tag is removed even when the target already exists.
 */
export async function renameTag(input: RenameTagInput, ownerId: string): Promise<TagActionResult> {
  return runTagAction(input.from, (tags) => tags.map((t) => (t === input.from ? input.to : t)), ownerId);
}

/**
 * Deletes a tag: removes it from every card carrying it (the cards
 * themselves — content, deck, scheduling — are untouched, mirroring the
 * deleteDeck philosophy). A name that no card carries is a successful
 * no-op (`affectedCards: 0`). Cards whose array becomes empty keep an empty
 * `tags` array (the same representation create writes for untagged cards).
 */
export async function deleteTag(input: DeleteTagInput, ownerId: string): Promise<TagActionResult> {
  return runTagAction(input.name, (tags) => tags.filter((t) => t !== input.name), ownerId);
}

/**
 * Merges tags with UNION semantics: `from` is removed from every card
 * carrying it and `to` is ensured on every such card (cards already
 * carrying `to` keep a single clean copy). The result equals a rename whose
 * `to` may already exist — `from` disappears and every affected card ends
 * up carrying `to`. `from` and `to` must differ (validator-enforced). A
 * `from` that no card carries is a successful no-op (`affectedCards: 0`).
 */
export async function mergeTags(input: MergeTagsInput, ownerId: string): Promise<TagActionResult> {
  return runTagAction(input.from, (tags) => {
    const hasFrom = tags.includes(input.from);
    if (!hasFrom) return tags;
    return [...tags.filter((t) => t !== input.from), input.to];
  }, ownerId);
}

/* ------------------------------------------------------------------ */
/* Flashcards                                                          */
/* ------------------------------------------------------------------ */

export async function createFlashcard(input: CreateFlashcardInput, ownerId: string): Promise<Flashcard> {
  const resolved = await resolveOwnedDeckRef(input, ownerId);
  const deck = resolved ?? await getDefaultOwnedDeck(ownerId);
  const deckId = 'id' in deck ? deck.id : deck.deckId;
  const docRef = getDb().collection(COLLECTION).doc();

  return getDb().runTransaction(async (transaction) => {
    const currentDeck = await readOwnedDeckInTransaction(transaction, deckId, ownerId);
    const now = Timestamp.now();
    const flashcard: Omit<Flashcard, 'id'> = {
      ownerId,
      front: input.front,
      back: input.back,
      tags: input.tags || [],
      ...(input.topic !== undefined && input.topic !== null ? { topic: input.topic } : {}),
      ...(input.suspended !== undefined ? { suspended: input.suspended } : { suspended: false }),
      deckId: currentDeck.id,
      deck: currentDeck.name,
      createdAt: now,
      updatedAt: now,
      ...initialScheduling(now),
      reviewLog: [],
      images: [],
    };
    transaction.create(docRef, flashcard);
    return { id: docRef.id, ...flashcard };
  }, { maxAttempts: 20 });
}

export async function getFlashcard(id: string, ownerId: string): Promise<Flashcard | null> {
  const doc = await getDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  if (doc.data()?.ownerId !== ownerId) return null;
  return docToFlashcard(doc as QueryDocumentSnapshot<DocumentData>);
}

export async function updateFlashcard(id: string, input: UpdateFlashcardInput, ownerId: string): Promise<Flashcard | null> {
  if (input.deckId === null || input.deck === null) throw new CardDeckRequiredError();
  const resolved = input.deckId !== undefined || input.deck !== undefined
    ? await resolveOwnedDeckRef({ deckId: input.deckId, deck: input.deck }, ownerId)
    : null;
  const cardRef = getDb().collection(COLLECTION).doc(id);

  return getDb().runTransaction(async (transaction) => {
    const snap = await transaction.get(cardRef);
    if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
    const currentDeck = resolved ? await readOwnedDeckInTransaction(transaction, resolved.deckId, ownerId) : null;
    const updateData: Record<string, unknown> = { updatedAt: Timestamp.now() };
    if (input.front !== undefined) updateData.front = input.front;
    if (input.back !== undefined) updateData.back = input.back;
    if (input.topic === null) updateData.topic = FieldValue.delete();
    else if (input.topic !== undefined) updateData.topic = input.topic;
    if (input.suspended !== undefined) updateData.suspended = input.suspended;
    if (input.tags !== undefined) updateData.tags = input.tags;
    if (currentDeck) {
      updateData.deckId = currentDeck.id;
      updateData.deck = currentDeck.name;
    }
    transaction.update(cardRef, updateData);
    return mergeCardForResponse(snap, updateData as Partial<Flashcard>);
  }, { maxAttempts: 20 });
}

export async function deleteFlashcard(id: string, ownerId: string): Promise<boolean> {
  const docRef = getDb().collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return false;
  if (doc.data()?.ownerId !== ownerId) return false;
  await docRef.delete();
  // Best-effort cleanup of stored image objects (never blocks the delete).
  await cleanupCardImages(id);
  return true;
}

export async function listFlashcards(query: ListFlashcardsQuery, ownerId: string): Promise<ListFlashcardsResponse> {
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  q = q.where('ownerId', '==', ownerId);
  q = q.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');

  if (query.deckId) {
    q = q.where('deckId', '==', query.deckId);
  } else if (query.deck) {
    q = q.where('deck', '==', query.deck);
  }

  if (query.tags) {
    const tagList = query.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      q = q.where('tags', 'array-contains-any', tagList);
    }
  }

  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const filters = listFlashcardsCursorFilters(query);
  if (query.pageToken) {
    const cursor = validateDocumentPageToken(query.pageToken, 'listFlashcards', ownerId, filters);
    q = q.startAfter(timestampFromDocumentPageCursor(cursor), cursor.id);
  }

  const snapshot = await q.limit(pageSize + 1).get();
  const docs = snapshot.docs;
  const hasMore = docs.length > pageSize;
  const cards = docs.slice(0, pageSize).map(docToFlashcard);
  const last = hasMore ? docs[pageSize - 1] : undefined;
  return {
    cards,
    nextPageToken: last
      ? makeDocumentPageToken('listFlashcards', ownerId, filters, last.get('createdAt') as Timestamp, last.id)
      : null,
  };
}

/**
 * Lists active cards due for review now, ordered by due ascending and document
 * id ascending. Suspended cards are filtered in memory so legacy cards with no
 * suspended field remain eligible. Cursor scope excludes the request clock.
 */
export async function dueFlashcards(query: DueFlashcardsQuery, ownerId: string): Promise<DueFlashcardsResponse> {
  const now = Timestamp.now();
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  q = q.where('ownerId', '==', ownerId);
  q = q.where('due', '<=', now).orderBy('due', 'asc').orderBy(FieldPath.documentId(), 'asc');

  if (query.deckId) {
    q = q.where('deckId', '==', query.deckId);
  } else if (query.deck) {
    q = q.where('deck', '==', query.deck);
  }

  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const filters = dueFlashcardsCursorFilters(query);
  if (query.pageToken) {
    const tokenCursor = validateDocumentPageToken(query.pageToken, 'dueFlashcards', ownerId, filters);
    q = q.startAfter(timestampFromDocumentPageCursor(tokenCursor), tokenCursor.id);
  }

  // Suspended is intentionally filtered in memory: Firestore's inequality
  // would also exclude legacy cards where the field is absent.
  const cards: Flashcard[] = [];
  let scanCursor: QueryDocumentSnapshot<DocumentData> | undefined;
  while (cards.length <= pageSize) {
    const snapshot = await q.limit(pageSize + 1).get();
    if (snapshot.docs.length === 0) break;

    for (const doc of snapshot.docs) {
      scanCursor = doc as QueryDocumentSnapshot<DocumentData>;
      const card = docToFlashcard(doc);
      if (card.suspended) continue;
      cards.push(card);
      if (cards.length > pageSize) break;
    }

    if (cards.length > pageSize || snapshot.docs.length < pageSize + 1 || !scanCursor) break;
    q = q.startAfter(scanCursor);
  }

  const hasMore = cards.length > pageSize;
  const page = cards.slice(0, pageSize);
  const last = hasMore ? page[page.length - 1] : undefined;
  return {
    cards: page,
    nextPageToken: last
      ? makeDocumentPageToken('dueFlashcards', ownerId, filters, last.due, last.id)
      : null,
  };
}


/* ------------------------------------------------------------------ */
/* Card counts                                                         */
/* ------------------------------------------------------------------ */

/**
 * Applies the count filters (deckId / legacy deck name / tags ANY-of) to a
 * Firestore query. Semantics mirror the listFlashcards/dueFlashcards deck
 * filters (deckId and deck are alternatives) and tag filters (comma
 * separated, ANY-of via array-contains-any).
 */
function applyCountFilters(
  q: FirebaseFirestore.Query,
  query: Pick<CountFlashcardsQuery, 'deckId' | 'deck' | 'tags'>,
  ownerId: string,
): FirebaseFirestore.Query {
  q = q.where('ownerId', '==', ownerId);
  if (query.deckId) {
    q = q.where('deckId', '==', query.deckId);
  } else if (query.deck) {
    q = q.where('deck', '==', query.deck);
  }
  if (query.tags) {
    const tagList = query.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      q = q.where('tags', 'array-contains-any', tagList);
    }
  }
  return q;
}

/**
 * Counts ONE aggregate result: the exact number of documents a (possibly
 * filter-scoped) query matches, WITHOUT fetching a single card document.
 *
 * Requires the Firestore `count()` aggregation (server-side, exact, no
 * paging — the same primitive the review-session due count uses). There is
 * deliberately NO document-fetch fallback: this endpoint's contract is
 * "counts without retrieving the cards", so a runtime without `count()`
 * fails loudly instead of silently reading card documents.
 */
async function runCountQuery(q: FirebaseFirestore.Query): Promise<number> {
  if (typeof q.count !== 'function') {
    throw new Error('count() aggregation is not available on this Firestore runtime; refusing to fall back to fetching card documents');
  }
  const snap = await q.count().get();
  const count = snap.data().count;
  if (typeof count !== 'number') {
    throw new Error('count() aggregation did not return a numeric count');
  }
  return count;
}

/** One bucket predicate applied on top of an already filter-scoped query. */
type CountPredicate = (q: FirebaseFirestore.Query) => FirebaseFirestore.Query;

/**
 * Runs the parallel count() aggregations that make up a bucket set over one
 * (already deck/tag-filtered) base query. ZERO card documents are read:
 * learning = state == 1, mature = state in [2,3], total = every card, and
 * due = `due <= now` (the same due filter the dueFlashcards endpoint and
 * review sessions use).
 *
 * `new` is DERIVED as `total - learning - mature`, never aggregated as
 * `state == 0`. This is deliberate and matches docToFlashcard's read
 * semantics exactly: a legacy document WITHOUT a persisted `state` field
 * (or with an invalid one) reads as New (state 0) — a Firestore
 * `state == 0` equality would exclude those documents from the `new`
 * bucket, inflating `total` while leaving them in no state bucket and
 * breaking the documented `new + learning + mature == total`. Aggregating
 * only the non-zero states and subtracting keeps every card in exactly one
 * state bucket (New = not Learning, not Review/Relearning) with strict
 * count()-only behavior.
 */
async function countBuckets(base: FirebaseFirestore.Query, now: Timestamp): Promise<FlashcardCounts> {
  const predicate = (fn: CountPredicate): Promise<number> => runCountQuery(fn(base));
  const [total, learningCount, matureCount, dueCount] = await Promise.all([
    predicate((q) => q),
    predicate((q) => q.where('state', '==', 1)),
    predicate((q) => q.where('state', 'in', [2, 3])),
    predicate((q) => q.where('due', '<=', now)),
  ]);
  const newCount = total - learningCount - matureCount;
  return { total, new: newCount, learning: learningCount, mature: matureCount, due: dueCount };
}

/**
 * Counts flashcards WITHOUT retrieving a single card record.
 *
 * Answers "how many cards are in Spanish?" (or a tag set, or the whole
 * library) with counts only: total, new (never reviewed — FSRS state New,
 * including legacy documents that lack a persisted state), learning (state
 * 1), mature (states 2 + 3 — Review and the lapse-relearning path of a
 * reviewed card), and due (`due <= now` — the exact dueFlashcards/review-
 * session due filter; new cards are due immediately, so `new` cards are
 * always due). `new + learning + mature` always equals `total` — `new` is
 * DERIVED as `total - learning - mature` (never aggregated as `state == 0`)
 * so legacy cards without a stored `state` (which docToFlashcard reads as
 * New) still land in exactly one state bucket. `due` overlaps the state
 * buckets (it is a time predicate, not a state bucket).
 *
 * COST — pure aggregation, ZERO card fetches: every bucket is a Firestore
 * `count()` query over a filter-scoped collection query (four parallel
 * aggregates per bucket set; `new` is derived, not aggregated). Filters
 * (deckId / legacy deck name / tags ANY-of) combine by AND and push down
 * into every aggregate. `count()` is REQUIRED — there is no document-fetch
 * fallback, so a runtime without the aggregation fails the request rather
 * than reading cards.
 *
 * groupBy=deck — whole-library per-deck breakdown, ALSO without card reads:
 * the distinct decks come from the DECKS collection (deck metadata documents
 * only: id + name; never the flashcards collection), and each deck's buckets
 * are four count() aggregates over `deck == <entity name>` (`new` derived). That single
 * equality scope covers every card of the deck: deckId-referencing cards
 * carry the denormalized deck name (create/update write both; deck rename
 * rewrites the name on its cards; deck delete detaches them), and migrated /
 * name-only legacy cards match by the same stored name — so one deck is
 * never split across keys and no card is double counted (deck names are
 * unique). The remainder — whole-library counts minus the sum of every
 * deck-entity's counts, per bucket — is derived arithmetically (never
 * scanned) and reported as a final `{ deckId: null, deck: null }` entry when
 * non-zero: legacy unmigrated cards whose `deck` string has no corresponding
 * deck entity (pre-entity documents). All newly created cards belong to a
 * deck, so this remainder shrinks over time as legacy cards are migrated.
 *
 * groupBy is mutually exclusive with the deck/tag filters (validator
 * enforced): a filtered breakdown is not expressible as count() aggregates,
 * so groupBy always describes the whole library.
 */
export async function countFlashcards(query: CountFlashcardsQuery, ownerId: string): Promise<CountFlashcardsResponse> {
  const now = Timestamp.now();
  const whole = await countBuckets(applyCountFilters(getDb().collection(COLLECTION), query, ownerId), now);

  if (query.groupBy !== 'deck') {
    return { counts: whole };
  }

  // groupBy=deck: iterate the OWNER's deck ENTITIES (metadata only) and
  // count each deck's cards via `deck == name` equality aggregates (plus the
  // owner predicate). No flashcards collection documents are ever fetched.
  const deckQuery: FirebaseFirestore.Query<DocumentData> = getDb().collection(DECKS_COLLECTION);
  const deckSnap = await deckQuery.where('ownerId', '==', ownerId).get();
  const decks = deckSnap.docs.map((doc) => ({ id: doc.id, name: doc.data().name as string }));

  const attributed = { total: 0, new: 0, learning: 0, mature: 0, due: 0 };
  const byDeck: CountByDeck[] = [];
  for (const deck of decks) {
    let deckQ: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION).where('deck', '==', deck.name);
    deckQ = deckQ.where('ownerId', '==', ownerId);
    const counts = await countBuckets(deckQ, now);
    byDeck.push({ deckId: deck.id, deck: deck.name, counts });
    attributed.total += counts.total;
    attributed.new += counts.new;
    attributed.learning += counts.learning;
    attributed.mature += counts.mature;
    attributed.due += counts.due;
  }
  // The remainder entry (deck: null) sorts last, so sort only the entity
  // entries here and append the deck-less remainder after them.
  byDeck.sort((a, b) => ((a.deck ?? '') < (b.deck ?? '') ? -1 : (a.deck ?? '') > (b.deck ?? '') ? 1 : 0));

  const remainder: FlashcardCounts = {
    total: whole.total - attributed.total,
    new: whole.new - attributed.new,
    learning: whole.learning - attributed.learning,
    mature: whole.mature - attributed.mature,
    due: whole.due - attributed.due,
  };
  if (remainder.total > 0) {
    byDeck.push({ deckId: null, deck: null, counts: remainder });
  }

  return { counts: whole, byDeck };
}

/**
 * The rich flashcard query (`searchCards`).
 *
 * Combines every requested filter family by INTERSECTION (AND):
 * free-text search (topic/front/back), tag semantics (ANY/ALL/NOT — at most
 * one mode per request), review state (due/notDue/new/reviewed), deck
 * combinations (stable deck ids and/or legacy deck names, ANY-of within the
 * family), suspended state, createdAt/updatedAt date ranges, plus
 * cursor-based deterministic pagination.
 *
 * QUERY STRATEGY (Firestore where feasible): the query pushes the
 * server-side expressible constraint down — `createdFrom` (`createdAt >=`)
 * and `createdTo` (`createdAt <=` the final nanosecond of its last
 * millisecond, including the full bound millisecond without exceeding the
 * maximum Firestore Timestamp) — and orders by `createdAt` desc with an
 * explicit document-id ascending secondary order (Firestore's native
 * tie-break). The remaining predicates that Firestore cannot express in one
 * composite query (case-insensitive substring search, ALL/NOT tag semantics,
 * review-state tests, suspended defaults, updatedAt bounds, deck-name/id
 * unions) are applied in memory over the ordered candidate stream. The scan
 * advances one bounded Firestore page (≤500 docs) at a time and stops as soon
 * as the page is filled or the candidate stream is exhausted — there is no
 * arbitrary scan cap, so filtered pagination can reach any depth of the
 * collection.
 *
 * PAGINATION uses a bounded opaque token bound to the authenticated owner,
 * query kind, and canonical active-filter fingerprint. It resumes strictly
 * after `(createdAt seconds, nanoseconds, id)` in createdAt DESC/id ASC order
 * using Firestore's ordered cursor; exact timestamp precision makes
 * same-millisecond ties stable.
 */

export async function searchCards(query: SearchCardsQuery, ownerId: string): Promise<SearchCardsResponse> {
  const now = Timestamp.now();
  const nowMs = now.toMillis();
  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const filters = normalizeSearchFilters(query);

  let cursor: {
    lastId: string;
    lastCreatedAtSeconds: number;
    lastCreatedAtNanoseconds: number;
  } | null = null;
  if (query.pageToken) {
    const payload = readSearchPageToken(query.pageToken);
    if (
      !payload
      || payload.ownerKey !== canonicalScopeFingerprint(['searchCards', ownerId])
      || payload.filtersKey !== searchFiltersKey(filters)
    ) {
      throw new InvalidPageTokenError('pageToken does not match the current owner, query, or cursor type');
    }
    cursor = {
      lastId: payload.lastId,
      lastCreatedAtSeconds: payload.lastCreatedAtSeconds,
      lastCreatedAtNanoseconds: payload.lastCreatedAtNanoseconds,
    };
  }

  // Firestore pushdown is limited to the ORDERED field: `createdAt` range
  // bounds need no extra composite index (they ride the same single-field
  // index as orderBy createdAt desc). `updatedAt` bounds and every other
  // non-indexable predicate are applied in memory by cardMatchesFilters.
  // The initial token cursor is passed to Firestore as the exact timestamp
  // and document-id tuple. Subsequent bounded scans continue after snapshots.
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  q = q.where('ownerId', '==', ownerId);
  q = q.orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId());
  if (filters.createdFromMs !== undefined) q = q.where('createdAt', '>=', Timestamp.fromMillis(filters.createdFromMs));
  // The upper bound includes every nanosecond represented by the final
  // millisecond. Using <= the last nanosecond of that millisecond also stays
  // within Firestore's maximum Timestamp for a 9999-12-31 bound.
  if (filters.createdToMs !== undefined) {
    const upperSeconds = Math.floor(filters.createdToMs / 1000);
    const upperNanoseconds = (filters.createdToMs - upperSeconds * 1000) * 1_000_000 + 999_999;
    q = q.where('createdAt', '<=', new Timestamp(upperSeconds, upperNanoseconds));
  }

  const collected: Flashcard[] = [];
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  let done = false;
  // Scan forward until the page is filled or the candidate stream is
  // exhausted. There is NO arbitrary page cap: filtered pagination must be
  // able to reach any depth of the collection (each Firestore page reads at
  // most 500 docs; the loop advances the cursor after every page, so the
  // total work is O(candidates before the first full page) — never repeated
  // work, never truncated results).
  for (;;) {
    let pageQuery = q.limit(500);
    if (lastDoc) {
      pageQuery = pageQuery.startAfter(lastDoc);
    } else if (cursor) {
      pageQuery = pageQuery.startAfter(
        new Timestamp(cursor.lastCreatedAtSeconds, cursor.lastCreatedAtNanoseconds),
        cursor.lastId,
      );
    }
    const snap = await pageQuery.get();
    if (snap.docs.length === 0) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      const card = docToFlashcard(doc);
      if (!cardMatchesFilters(card, filters, nowMs)) continue;
      collected.push(card);
      if (collected.length === pageSize + 1) {
        done = true;
        break;
      }
    }
    if (done) break;
  }

  const hasMore = collected.length > pageSize;
  const cards = collected.slice(0, pageSize);
  let nextPageToken: string | null = null;
  if (hasMore && cards.length > 0) {
    const last = cards[cards.length - 1];
    nextPageToken = makeSearchPageToken(
      filters,
      ownerId,
      last.id,
      last.createdAt.seconds,
      last.createdAt.nanoseconds,
    );
  }
  return { cards, nextPageToken };
}

/**
 * Records one review for a flashcard: applies the FSRS scheduler to the
 * card's persisted state, persists the new scheduling state plus the review
 * log entry, and returns the updated card.
 *
 * The read-modify-write of scheduling state runs inside a Firestore
 * transaction: when two reviews of the same card race, the loser retries
 * against the state committed by the winner, so every review is scheduled
 * from the latest card state and no reviewLog entry is lost.
 */
export async function reviewFlashcard(
  id: string,
  input: ReviewFlashcardInput,
  ownerId: string,
): Promise<ReviewFlashcardResponse | null> {
  const docRef = getDb().collection(COLLECTION).doc(id);
  // The event document ref is created OUTSIDE the transaction callback (the
  // direct review has no requestId, so the id is a fresh auto id allocated
  // once per request).
  const eventRef = getDb().collection('reviewEvents').doc();
  const reviewTime = resolveReviewTime(input.reviewAt, new Date());
  const updatedAt = Timestamp.now();

  return getDb().runTransaction(async (t) => {
    const snap = await t.get(docRef);
    if (!snap.exists) return null;

    const card = docToFlashcard(snap);
    // Owner-scoped callers may only review their OWN cards: a card that is
    // ownerless (pre-multi-tenant legacy) or owned by another tenant reads as
    // not found (404) — never a cross-tenant review or an existence leak.
    if (card.ownerId !== ownerId) return null;

    // REVIEW_TEST_MODE: like session submissions, a direct review in test
    // mode must NOT mutate the card and must NOT write a review event — the
    // mode is a non-mutating widget-testing path (the FSRS outcome is
    // computed and returned so the caller sees what WOULD happen, but
    // nothing is persisted). Transaction atomicity guarantees a failed
    // transaction writes neither the card update nor the event.
    if (isReviewTestMode()) {
      const { scheduling, logEntry } = applyReview(card, input.rating, reviewTime);
      const updateData = {
        ...scheduling,
        updatedAt,
        reviewLog: trimEmbeddedReviewLog([...card.reviewLog, logEntry]),
      };
      return { card: { ...card, ...updateData }, reviewLogItem: logEntry };
    }

    const { scheduling, logEntry } = applyReview(card, input.rating, reviewTime);

    // The embedded reviewLog is a bounded window (newest 100); the event
    // written below is the FULL history record, so trimming the array here
    // never loses a review.
    const reviewLog = trimEmbeddedReviewLog([...card.reviewLog, logEntry]);
    const updateData = {
      ...scheduling,
      updatedAt,
      reviewLog,
    };
    await t.update(docRef, updateData);

    // Immutable review event, written in the SAME transaction as the card
    // state (event + card state can never diverge). Direct reviews have no
    // requestId, so each writes one event owned by the verified caller.
    t.set(eventRef, buildEventBody({
      ownerId,
      rating: input.rating,
      card,
      scheduling,
      reviewedAt: Timestamp.fromMillis(reviewTime.getTime()),
      recordedAt: updatedAt,
    }) as unknown as Record<string, unknown>);

    return { card: { ...card, ...updateData }, reviewLogItem: logEntry };
  });
}

/* ------------------------------------------------------------------ */
/* Explicit scheduling management                                      */
/* ------------------------------------------------------------------ */

/**
 * Shared executor of the explicit scheduling-management operations
 * (resetFlashcards / setFlashcardDueDate / suspendFlashcards /
 * unsuspendFlashcards).
 *
 * Semantics (mirror the atomic bulk APIs):
 *  - Every targeted card is read inside ONE Firestore transaction, and the
 *    per-card updates commit atomically — either every existing card is
 *    updated or none are (no partial silent success). Missing ids are NOT an
 *    error and NOT silently substituted: they are omitted from the result
 *    (the established bulk delete/update convention).
 *  - `ids` in the input must be unique (the validators reject duplicates);
 *    the returned `ids`/`cards` preserve the INPUT order of the existing
 *    cards.
 *  - A transaction may contain at most 500 operations. The validators bound
 *    the input to SCHEDULING_ACTION_LIMIT (= BULK_LIMIT = 100) ids, and each
 *    id costs exactly one read + one write (200 ops worst case), so a single
 *    transaction is always sufficient.
 *  - Firestore transactions forbid reads AFTER writes, so the executor reads
 *    every targeted card first and only then applies the writes.
 */
async function runSchedulingAction(
  ids: string[],
  patch: (card: Flashcard) => Record<string, unknown>,
  ownerId: string,
): Promise<SchedulingActionResponse> {
  return getDb().runTransaction(async (t) => {
    // All reads happen BEFORE any write (Firestore transactions cannot read
    // after writing). Read every target first, dropping missing ids AND any
    // id that is not owned by the caller (ownerless legacy cards are only
    // reachable by unscoped/operator calls — an owner-scoped request can
    // never mutate another tenant's card).
    const existing: Array<{ snap: DocumentSnapshot<DocumentData>; card: Flashcard }> = [];
    for (const id of ids) {
      const snap = await t.get(getDb().collection(COLLECTION).doc(id));
      if (!snap.exists) continue;
      if (snap.data()?.ownerId !== ownerId) continue;
      existing.push({ snap, card: docToFlashcard(snap) });
    }
    const updatedAt = Timestamp.now();
    const cards: Flashcard[] = [];
    for (const { snap, card } of existing) {
      const updateData = { ...patch(card), updatedAt };
      t.update(snap.ref, updateData);
      // Firestore FieldValue.delete() sentinels must NOT leak into the
      // response: a deleted field (reset's lastReview, unsuspend's
      // suspended) reads as ABSENT on the returned card, matching what a
      // re-read of the document would produce.
      const merged = { ...card, ...updateData };
      stripFieldDeleteSentinels(merged as Record<string, unknown>);
      // `suspended` is a persisted boolean: a never-suspended card has
      // absent field → false (docToFlashcard semantics), and unsuspend
      // deletes the field. The response MUST expose the logical boolean
      // so clients don't see an absent key where a boolean is contractually
      // expected. Other deleted fields (lastReview, deck, deckId) are
      // genuinely absent-by-design.
      if (!('suspended' in merged)) {
        (merged as Record<string, unknown>).suspended = false;
      }
      cards.push(merged);
    }
    return { ids: existing.map((e) => e.snap.id), count: existing.length, cards };
  });
}

/**
 * Resets the FSRS scheduling state of one or more flashcards to a
 * brand-new-card state: `state` New (0), due immediately at the server's
 * current time, zeroed stability/difficulty/reps/lapses/learningSteps, an EMPTY reviewLog,
 * and `lastReview` removed. Content fields (front/back/deck/tags/topic),
 * images, and the `suspended` flag are untouched. The `updatedAt` timestamp
 * is refreshed.
 *
 * The reset is a deliberate, authoritative operation — the scheduling
 * history is cleared (not archived) and cannot be undone; a subsequent
 * review starts from New exactly as if the card had just been created. Due
 * queues, review sessions, search facets and counts all read the reset card
 * as New/due-immediately.
 *
 * Returns the updated cards (existing ids only, in input order). The
 * reviewEvents log is deliberately NOT touched: events are immutable
 * records of what happened, and a reset is a scheduling reset — history
 * stays queryable (stats keep counting the reset card's past reviews).
 */
export async function resetFlashcards(ids: string[], ownerId: string): Promise<SchedulingActionResponse> {
  return runSchedulingAction(ids, () => {
    const now = Timestamp.now();
    const fresh = initialScheduling(now);
    return {
      state: fresh.state,
      stability: fresh.stability,
      difficulty: fresh.difficulty,
      reps: fresh.reps,
      lapses: fresh.lapses,
      learningSteps: fresh.learningSteps,
      due: fresh.due,
      lastReview: FieldValue.delete() as unknown as Timestamp,
      reviewLog: [],
    };
  }, ownerId);
}

/**
 * Sets the exact next-review time (`due`) of one or more flashcards. Only the
 * card's `due` field changes: the FSRS state (state/stability/difficulty/
 * reps/lapses/lastReview/reviewLog) is preserved exactly, so the card keeps
 * its scheduling memory and the next `review_flashcard` schedules from the
 * persisted state with the new due time as its starting point. The
 * `updatedAt` timestamp is refreshed.
 *
 * The `due` input is validated by the API boundary as a full ISO 8601
 * date-time or a YYYY-MM-DD date (UTC midnight) and converted to a Firestore
 * Timestamp here (defense in depth: a non-parseable string falls back to the
 * server's current time, mirroring resolveReviewTime). Returns the updated
 * cards (existing ids only, in input order).
 */
export async function setFlashcardDueDate(ids: string[], due: string, ownerId: string): Promise<SchedulingActionResponse> {
    const parsed = new Date(due);
    const dueTs = Timestamp.fromMillis(Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime());
    return runSchedulingAction(ids, () => ({ due: dueTs }), ownerId);
}
/**
 * Suspends one or more flashcards: sets the persisted `suspended: true`
 * flag. A suspended card keeps ALL its content and scheduling state (due,
 * FSRS fields, reviewLog — nothing is lost or rescheduled); it is excluded
 * from due-card queues while remaining visible to list and review-session
 * surfaces. Semantics per the suspension contract:
 *  - `search_cards` can select suspended cards explicitly with
 *    `suspended: true`; with no `suspended` filter it returns both states, and
 *    suspended cards NEVER match its `review` facet.
 *  - `dueFlashcards` excludes suspended cards. Review-session queues and
 *    `review_flashcard` do NOT read the flag; suspending never mutates
 *    scheduling, and a card suspended mid-session keeps its place in an
 *    already-snapshotted session.
 * Returns the updated cards (existing ids only, in input order).
 */
export async function suspendFlashcards(ids: string[], ownerId: string): Promise<SchedulingActionResponse> {
    return runSchedulingAction(ids, () => ({ suspended: true }), ownerId);
}
/**
 * Unsuspends one or more flashcards: clears the persisted suspension by
 * removing the `suspended` field (an absent field reads as `false`
 * everywhere — the same representation a never-suspended legacy card has).
 * The card becomes eligible for the `search_cards` `suspended: false`/
 * review facets again; its content and scheduling state are untouched.
 * Returns the updated cards (existing ids only, in input order).
 */
export async function unsuspendFlashcards(ids: string[], ownerId: string): Promise<SchedulingActionResponse> {
    return runSchedulingAction(ids, () => ({ suspended: FieldValue.delete() }), ownerId);
}
/**
 * Bulk creates flashcards. Inputs are validated by the caller, owner-scoped
 * deck references are re-read in the transaction, and all cards commit
 * atomically. Returns the created cards with their Firestore ids.
 */
export async function bulkCreateFlashcards(input: BulkCreateFlashcardsInput, ownerId: string): Promise<BulkCreateFlashcardsResponse> {
  const defaultDeck = input.cards.some((card) => card.deckId == null && card.deck == null)
    ? await getDefaultOwnedDeck(ownerId) : null;
  const destinations = await Promise.all(input.cards.map(async (item) => (
    await resolveOwnedDeckRef(item, ownerId)
      ?? { deckId: defaultDeck!.id, deck: defaultDeck!.name }
  )));
  const docRefs = input.cards.map(() => getDb().collection(COLLECTION).doc());
  const deckIds = [...new Set(destinations.map((destination) => destination.deckId))];

  const cards = await getDb().runTransaction(async (transaction) => {
    const decks = new Map<string, Awaited<ReturnType<typeof readOwnedDeckInTransaction>>>();
    await Promise.all(deckIds.map(async (deckId) => {
      decks.set(deckId, await readOwnedDeckInTransaction(transaction, deckId, ownerId));
    }));
    const now = Timestamp.now();
    return input.cards.map((item, index) => {
      const currentDeck = decks.get(destinations[index].deckId)!;
      const flashcard: Omit<Flashcard, 'id'> = {
        ownerId,
        front: item.front,
        back: item.back,
        tags: item.tags || [],
        ...(item.topic !== undefined && item.topic !== null ? { topic: item.topic } : {}),
        ...(item.suspended !== undefined ? { suspended: item.suspended } : { suspended: false }),
        deckId: currentDeck.id,
        deck: currentDeck.name,
        createdAt: now,
        updatedAt: now,
        ...initialScheduling(now),
        reviewLog: [],
        images: [],
      };
      transaction.create(docRefs[index], flashcard);
      return { id: docRefs[index].id, ...flashcard };
    });
  }, { maxAttempts: 20 });
  return { cards };
}
/**
 * Bulk updates flashcards. Each item is validated by the caller before this
 * runs; referenced deck ids are checked to exist. Reads and writes run inside
 * a single Firestore transaction: the transaction commits atomically, so
 * either every update lands or none do — no partial silent success. Returns
 * the updated cards in input order; ids that did not exist are omitted from
 * the result (they failed the per-item existence check and were not written).
 */
export async function bulkUpdateFlashcards(input: BulkUpdateFlashcardsInput, ownerId: string): Promise<BulkUpdateFlashcardsResponse> {
  for (const item of input.cards) {
    if (item.deckId === null || item.deck === null) throw new CardDeckRequiredError();
  }
  const resolvedRefs = new Map<string, { deckId: string; deck: string } | null>();
  for (const item of input.cards) {
    if (item.deckId !== undefined || item.deck !== undefined) {
      resolvedRefs.set(item.id, await resolveOwnedDeckRef({ deckId: item.deckId, deck: item.deck }, ownerId));
    }
  }

  return getDb().runTransaction(async (transaction) => {
    const existing: Array<{
      item: BulkUpdateFlashcardsInput['cards'][number];
      docRef: DocumentReference<DocumentData>;
      snap: DocumentSnapshot<DocumentData>;
    }> = [];
    for (const item of input.cards) {
      const docRef = getDb().collection(COLLECTION).doc(item.id);
      const snap = await transaction.get(docRef);
      if (snap.exists && snap.data()?.ownerId === ownerId) existing.push({ item, docRef, snap });
    }

    const deckIds = [...new Set(existing
      .map(({ item }) => resolvedRefs.get(item.id)?.deckId)
      .filter((deckId): deckId is string => deckId !== undefined))];
    const decks = new Map<string, Deck>();
    await Promise.all(deckIds.map(async (deckId) => {
      decks.set(deckId, await readOwnedDeckInTransaction(transaction, deckId, ownerId));
    }));

    const now = Timestamp.now();
    const results: Flashcard[] = [];
    for (const { item, docRef, snap } of existing) {
      const updateData: Record<string, unknown> = { updatedAt: now };
      if (item.front !== undefined) updateData.front = item.front;
      if (item.back !== undefined) updateData.back = item.back;
      if (item.topic === null) updateData.topic = FieldValue.delete();
      else if (item.topic !== undefined) updateData.topic = item.topic;
      if (item.suspended !== undefined) updateData.suspended = item.suspended;
      if (item.tags !== undefined) updateData.tags = item.tags;
      const destination = resolvedRefs.get(item.id);
      if (destination) {
        const currentDeck = decks.get(destination.deckId)!;
        updateData.deckId = currentDeck.id;
        updateData.deck = currentDeck.name;
      }
      transaction.update(docRef, updateData);
      results.push(mergeCardForResponse(snap, updateData as Partial<Flashcard>));
    }
    return { cards: results };
  }, { maxAttempts: 20 });
}
/**
 * Bulk deletes flashcards. Existence is checked inside a single Firestore
 * transaction and the deletes commit atomically: either every id present in
 * the collection is deleted or none are — no partial silent success. Returns
 * the ids actually deleted; ids that did not exist are omitted.
 */
export async function bulkDeleteFlashcards(input: BulkDeleteFlashcardsInput, ownerId: string): Promise<BulkDeleteFlashcardsResponse> {
    const result = await getDb().runTransaction(async (t) => {
        const deletedIds = [];
        // Firestore transactions forbid reads AFTER writes: read every target
        // first, then delete the existing ones in a second pass. Owner-scoped
        // callers may only delete their OWN cards.
        const existing = [];
        for (const id of input.ids) {
            const docRef = getDb().collection(COLLECTION).doc(id);
            const snap = await t.get(docRef);
            if (snap.exists && snap.data()?.ownerId === ownerId)
                existing.push(docRef);
        }
        for (const docRef of existing) {
            t.delete(docRef);
            deletedIds.push(docRef.id);
        }
        return { deletedIds };
    });
    // Best-effort cleanup of stored image objects for the deleted cards.
    await Promise.all(result.deletedIds.map((id) => cleanupCardImages(id)));
    return result;
}
export async function verifyApiKey(key: unknown): Promise<string | null> {
    if (typeof key !== 'string' || key.length === 0 || key.includes('/')
        || key === '.' || key === '..' || /^__.*__$/.test(key)
        || Buffer.byteLength(key, 'utf8') > 1500) return null;
    const doc = await getDb().collection('apiKeys').doc(key).get();
    if (!doc.exists)
        return null;
    const data = doc.data();
    if (data?.revoked)
        return null;
    await doc.ref.update({ lastUsedAt: Timestamp.now() });
    return data?.name || 'unknown';
}
/* ------------------------------------------------------------------ */
/* Review sessions                                                     */
/* ------------------------------------------------------------------ */
/**
 * Thrown when a rating is submitted against a session that is no longer
 * active (already completed or ended). The client should start a new session.
 */
export class ReviewSessionNotActiveError extends Error {
    constructor(sessionId: string, status: SessionStatus) {
        super(`Review session ${sessionId} is not active (status: ${status})`);
        this.name = 'ReviewSessionNotActiveError';
    }
}
/**
 * Thrown when a caller attempts to access a session owned by another identity
 * (client-visible 403).
 */
export class ReviewSessionForbiddenError extends Error {
    constructor(sessionId: string) {
        super(`Review session access denied: ${sessionId}`);
        this.name = 'ReviewSessionForbiddenError';
    }
}
/**
 * Thrown when a rating submission declares an `expectedCardId` that does not
 * match the session's actual current card (client-visible 409). The client
 * is stale and must re-sync via get_review_session before rating — this
 * guard prevents a background retry from rating the wrong card.
 */
export class ReviewExpectedCardMismatchError extends Error {
    constructor(sessionId: string, expectedCardId: string, actualCardId: string | undefined) {
        super(`Review session ${sessionId} current card mismatch: expected ${expectedCardId}, actual ${actualCardId ?? '(none)'}`);
        this.name = 'ReviewExpectedCardMismatchError';
    }
}
/**
 * Thrown when a session-start selector names a card id that does not exist
 * (client-visible 404). An explicit allowlist must never silently substitute
 * missing ids — the request fails so the caller can fix the selection.
 */
export class ReviewSessionCardNotFoundError extends Error {
    constructor(cardId: string) {
        super(`Card not found: ${cardId}`);
        this.name = 'ReviewSessionCardNotFoundError';
    }
}
/**
 * Thrown when a start-review-session explicit cardIds allowlist exceeds
 * SESSION_MAX_ALLOWLIST_IDS (client-visible 400). The allowlist must be
 * deterministically ordered (due ASC, id ASC), which requires comparing the
 * due of every allowlisted card; above the documented bound the request is
 * rejected with a clear error — never silently truncated.
 */
export class ReviewSessionSelectionTooLargeError extends Error {
    constructor(count: number, max: number) {
        super(`Review session card selection too large: ${count} card ids (max ${max}). Use deck/tag selectors or a smaller explicit list.`);
        this.name = 'ReviewSessionSelectionTooLargeError';
    }
}
/** A legacy session's request-id history cannot be proven complete. */
export class ReviewSessionRetryHistoryUnavailableError extends Error {
    constructor(sessionId: string) {
        super(`Review session ${sessionId} cannot safely retry this request id. Start a new review session.`);
        this.name = 'ReviewSessionRetryHistoryUnavailableError';
    }
}
/** Thrown when a v2 session is accessed whose queue build failed. */
export class ReviewSessionBuildFailedError extends Error {
    constructor(sessionId: string, buildError?: string) {
        super(`Review session ${sessionId} failed to build and is not reviewable. Start a new review session${buildError ? ` (${buildError})` : ''}.`);
        this.name = 'ReviewSessionBuildFailedError';
    }
}
/** Throws when the caller does not own the session. */
function assertSessionOwnership(session: ReviewSession, ownerId: string): void {
  if (session.ownerId !== ownerId) {
    throw new ReviewSessionForbiddenError(session.id);
  }
}
/** Reject roots with unsupported storage or request-claim versions. */
function assertSessionVersionsSupported(
    session: ReviewSession,
    snapshot: DocumentSnapshot<DocumentData>,
): void {
    const data = snapshot.data();
    if (!data) return;
    const storageVersion = data.storageVersion;
    if (Object.prototype.hasOwnProperty.call(data, 'storageVersion')
        && storageVersion !== 1
        && storageVersion !== SESSION_STORAGE_VERSION) {
        throw new ReviewSessionBuildFailedError(session.id, 'unsupported storage version; start a new review session');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'requestClaimsVersion')
        && (data.requestClaimsVersion !== 1 || storageVersion !== SESSION_STORAGE_VERSION)) {
        throw new ReviewSessionBuildFailedError(session.id, 'unsupported request claim version; start a new review session');
    }
}

/**
 * Strips the explicit allowlist card ids from persisted session provenance
 * when it would leak the queue on the wire: v2 sessions NEVER expose
 * source.cardIds (the snapshot lives chunked; Continue copies it via
 * repeatSessionId). Legacy v1/no-version documents keep their selector
 * provenance so Continue can replay the exact selection.
 */
function sanitizeSessionSource(source: ReviewSessionSource, isV2: boolean): ReviewSessionSource {
    if (!isV2) return source;
    if (!Array.isArray(source.cardIds)) return source;
    const out: ReviewSessionSource = { ...source };
    delete out.cardIds;
    return out;
}

/** Deserializes a stored session document into the ReviewSession entity. */
function docToReviewSession(doc: DocumentSnapshot<DocumentData>): ReviewSession {
    const data = doc.data();
    if (!data) {
        throw new Error('Document data is undefined');
    }
    return {
        id: doc.id,
        ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
        status: data.status as SessionStatus,
        mode: (SESSION_MODES.includes(data.mode) ? data.mode : 'spaced_repetition') as SessionMode,
        ...(data.source !== undefined
            ? {
                source: sanitizeSessionSource(data.source as ReviewSessionSource, data.storageVersion === SESSION_STORAGE_VERSION),
            }
            : {}),
        ...(data.cardType !== undefined ? { cardType: data.cardType as CardType } : {}),
        ...(data.name !== undefined ? { name: data.name as string } : {}),
        ...(data.storageVersion !== undefined ? { storageVersion: data.storageVersion as number } : {}),
        ...(Object.prototype.hasOwnProperty.call(data, 'requestClaimsVersion')
            ? { requestClaimsVersion: data.requestClaimsVersion }
            : {}),
        ...(data.lastRequestId !== undefined ? { lastRequestId: data.lastRequestId } : {}),
        ...(data.lastRatedCardId !== undefined ? { lastRatedCardId: data.lastRatedCardId } : {}),
        ...(data.testMode === true ? { testMode: true } : {}),
        limit: data.limit,
        dueCount: data.dueCount,
        // v2 roots are BOUNDED: the queue arrays below are ABSENT and the
        // v2 metadata fields carry the state.
        ...(data.repeatSessionId !== undefined ? { repeatSessionId: data.repeatSessionId } : {}),
        ...(data.storageVersion === SESSION_STORAGE_VERSION ? {
            completedChunks: data.completedChunks,
            queueChunksPrefix: data.queueChunksPrefix,
            remainingQueueCount: data.remainingQueueCount,
            ...(typeof data.position === 'number' ? { position: data.position } : {}),
            ...(typeof data.totalCount === 'number' ? { totalCount: data.totalCount } : {}),
            ...(typeof data.currentPosition === 'number' ? { currentPosition: data.currentPosition } : {}),
            ...(typeof data.currentChunkIndex === 'number' ? { currentChunkIndex: data.currentChunkIndex } : {}),
            ...(typeof data.deletedCount === 'number' ? { deletedCount: data.deletedCount } : {}),
            ...(data.buildStatus === 'building' || data.buildStatus === 'ready' || data.buildStatus === 'failed'
                ? { buildStatus: data.buildStatus as 'building' | 'ready' | 'failed' }
                : {}),
            ...(data.buildFailed === true ? { buildFailed: true } : {}),
            ...(typeof data.buildError === 'string' ? { buildError: data.buildError } : {}),
        } : {}),
        // v2 roots are BOUNDED: the queue arrays are ABSENT (never synthesized
        // as empty arrays on the wire); legacy documents keep them.
        ...(Array.isArray(data.cardIds) ? { cardIds: data.cardIds } : {}),
        currentIndex: data.currentIndex,
        reviewedCount: data.reviewedCount,
        truncated: data.truncated === true,
        continuationAvailable: data.continuationAvailable === true || data.truncated === true,
        ratingCounts: data.ratingCounts,
        ...(Array.isArray(data.reviewedCardIds) ? { reviewedCardIds: data.reviewedCardIds } : {}),
        ...(Array.isArray(data.processedRequestIds) ? { processedRequestIds: data.processedRequestIds } : {}),
        startedAt: data.startedAt,
        ...(data.lastReviewedAt ? { lastReviewedAt: data.lastReviewedAt } : {}),
        ...(data.endedAt ? { endedAt: data.endedAt } : {}),
    };
}
/** Zeroed rating counters for a fresh session. */
function emptyRatingCounts(): SessionRatingCounts {
    return {
        again: 0,
        hard: 0,
        good: 0,
        easy: 0,
        ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    };
}
/** Applies one rating to the counters (both the named field and the numeric map). */
function bumpRatingCounts(counts: SessionRatingCounts, rating: number): SessionRatingCounts {
    const name = RATING_NAMES[rating];
    return {
        ...counts,
        [name]: counts[name] + 1,
        ratingCounts: { ...counts.ratingCounts, [rating]: (counts.ratingCounts[rating] ?? 0) + 1 },
    };
}
const RATING_NAMES: Record<number, 'again' | 'hard' | 'good' | 'easy'> = {
    1: 'again',
    2: 'hard',
    3: 'good',
    4: 'easy',
};
/**
 * Exact number of cards still awaiting review: `cardIds.length - currentIndex`
 * minus claims at indices AFTER `currentIndex` (out-of-order/parallel ratings
 * already committed past the current position). Computed on responses, never
 * persisted.
 */
function sessionRemainingCount(session: ReviewSession): number {
    // v1/no-version legacy documents always carry the in-root arrays; v2
    // roots never call this (they use the persisted remainingQueueCount).
    const cardIds = session.cardIds ?? [];
    const reviewedCardIds = session.reviewedCardIds ?? [];
    let out = cardIds.length - session.currentIndex;
    for (let i = session.currentIndex; i < cardIds.length; i += 1) {
        if (reviewedCardIds.includes(cardIds[i]))
            out -= 1;
    }
    return Math.max(0, out);
}
/* ------------------------------------------------------------------ */
/* v2 chunked-storage helpers                                          */
/*                                                                     */
/* v2 sessions (storageVersion === 2) keep a BOUNDED root document and */
/* shard the queue into `reviewSessions/{sessionId}/queueChunks/<idx>` */
/* child documents.                                                     */
/*                                                                     */
/* CHUNK DOCUMENT SHAPE (v2):                                           */
/*   { chunkIndex: number, startPosition, itemCount, pendingCount,     */
/*     status: 'active'|'completed',                                   */
/*     items: [{ cardId, status: 'pending'|'reviewed'|'deleted',       */
/*              rating?, requestId?, reviewedAt?, deletedAt? }] }      */
/*   - chunkIndex is NUMERIC (the doc id is its zero-padded form).     */
/*   - items is bounded (≤ SESSION_QUEUE_CHUNK_SIZE).                  */
/*   - pendingCount is exact and maintained with each claim.           */
/*   - status 'active' until every item is reviewed/deleted.           */
/*                                                                     */
/* BUILD PROTOCOL (bounded memory):                                    */
/*   1. write the root FIRST with buildStatus 'building', status       */
/*      'active' (accepting no claims until finalized — submit checks  */
/*      buildStatus), totalCount/reviewedCount/remainingCount 0;       */
/*   2. page the selector query (due ASC, document id ASC, id+due      */
/*      projection via .select()); each full 200-item chunk is flushed */
/*      to Firestore AS IT FILLS (never accumulate the whole queue);   */
/*      at most ONE partial chunk is retained in memory between pages; */
/*   3. finalize the root: exact totalCount, chunkCount,               */
/*      remainingCount, buildStatus 'ready'.                           */
/*   On failure: update root buildStatus 'failed' + status 'failed'.   */
/* ------------------------------------------------------------------ */

/** Whether a session document uses the v2 (chunked) storage layout. */
function isV2Session(session: ReviewSession): boolean {
    return session.storageVersion === SESSION_STORAGE_VERSION;
}

/** Whether a v2 session root is fully built and reviewable. */
function isV2Ready(session: ReviewSession): boolean {
    return isV2Session(session)
        && session.buildStatus !== 'building'
        && session.buildStatus !== 'failed'
        && session.status !== 'failed';
}

/** Chunk ordinal that owns a queue position (floor(position / CHUNK_SIZE)). */
function chunkOrdinalFor(position: number): number {
    return Math.floor(position / SESSION_QUEUE_CHUNK_SIZE);
}

/** Zero-padded fixed-width chunk document id (positions sort lexically). */
function chunkDocId(chunkIndex: number): string {
    return String(chunkIndex).padStart(10, '0');
}

/** Local item index within a chunk for an absolute queue position. */
function chunkLocalIndex(position: number): number {
    return position % SESSION_QUEUE_CHUNK_SIZE;
}

/** The queueChunks subcollection of a v2 session. */
function sessionChunksCollection(sessionId: string): FirebaseFirestore.CollectionReference<DocumentData> {
    return getDb()
        .collection(SESSIONS_COLLECTION).doc(sessionId)
        .collection(SESSION_QUEUE_CHUNKS_COLLECTION);
}

/** Request ids are scoped to the owning session; hash them into safe doc ids. */
function sessionRequestClaimRef(sessionId: string, ownerId: string, requestId: string): DocumentReference<DocumentData> {
    const hash = createHash('sha256').update(JSON.stringify([ownerId, requestId])).digest('hex');
    return getDb()
        .collection(SESSIONS_COLLECTION).doc(sessionId)
        .collection(SESSION_REQUEST_CLAIMS_COLLECTION).doc(hash);
}

/** Loads ONE chunk document; null when missing/invalid. */
async function readChunk(sessionId: string, chunkIndex: number): Promise<SessionChunkDocument | null> {
    const doc = await sessionChunksCollection(sessionId).doc(chunkDocId(chunkIndex)).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (!data || !Array.isArray(data.items)) return null;
    return {
        chunkIndex: typeof data.chunkIndex === 'number' ? data.chunkIndex : chunkIndex,
        startPosition: typeof data.startPosition === 'number' ? data.startPosition : chunkIndex * SESSION_QUEUE_CHUNK_SIZE,
        itemCount: typeof data.itemCount === 'number' ? data.itemCount : (data.items as unknown[]).length,
        pendingCount: typeof data.pendingCount === 'number' ? data.pendingCount : (data.items as unknown[]).length,
        status: data.status === 'completed' ? 'completed' : 'active',
        items: data.items as SessionQueueItem[],
    };
}

/** Loads ONE chunk document's items (null when missing). */
async function readChunkItems(sessionId: string, chunkIndex: number): Promise<SessionQueueItem[] | null> {
    const chunk = await readChunk(sessionId, chunkIndex);
    return chunk ? chunk.items : null;
}

/** Reads the queue items covering positions `[from, to)` (chunk-scoped). */
async function loadV2Items(session: ReviewSession, from: number, to: number): Promise<SessionQueueItem[] | null> {
    if (to <= from) return [];
    const first = chunkOrdinalFor(from);
    const last = chunkOrdinalFor(to - 1);
    const out: SessionQueueItem[] = [];
    for (let c = first; c <= last; c += 1) {
        const chunk = await readChunkItems(session.id, c);
        if (!chunk) return null;
        const chunkStart = c * SESSION_QUEUE_CHUNK_SIZE;
        for (let p = Math.max(from, chunkStart); p < Math.min(to, chunkStart + chunk.length); p += 1) {
            const item = chunk[p - chunkStart];
            if (!item || typeof item.cardId !== 'string') return null;
            out.push(item);
        }
    }
    return out;
}

/** Whether a queue item is live (pending). */
function itemLive(item: SessionQueueItem | undefined | null): boolean {
    return !!item && typeof item.cardId === 'string' && item.status === 'pending';
}


/**
 * Loads a bounded slice of the v2 queue: the current (first live) card id
 * plus up to SESSION_PRELOAD upcoming live card ids, each with its REQUIRED
 * stable queue position. BOUNDED: starts from the root's
 * currentChunkIndex/currentPosition metadata (the ACTIVE chunk) and reads at
 * most that chunk PLUS the next chunk (a ≤200-item chunk + ≤100 preload never
 * spans more than two chunks). Exhausted chunks (metadata status 'completed'
 * or pendingCount 0) are skipped via their metadata — never a scan across
 * many chunks. Returns null when a covering chunk is missing (a partial
 * build is NEVER served).
 */
async function loadV2QueueWindow(session: ReviewSession, currentPosition: number): Promise<SessionQueueWindow | null> {
    const limit = session.limit ?? 0;
    if (!isSessionActive(session) || currentPosition >= limit) {
        return { currentPosition: null, currentCardId: null, cardIds: [] };
    }
    // Start from the ACTIVE chunk (root metadata) — never scan from 0.
    const startChunk = typeof session.currentChunkIndex === 'number' && session.currentChunkIndex >= 0
        ? session.currentChunkIndex
        : chunkOrdinalFor(currentPosition);
    // Bounded candidate scan: the active chunk then, at most, the next chunk.
    const candidateChunks: number[] = [];
    for (let c = startChunk; c <= startChunk + 1 && c * SESSION_QUEUE_CHUNK_SIZE < limit; c += 1) {
        candidateChunks.push(c);
    }
    let p = -1;
    let headItem: SessionQueueItem | null = null;
    for (const cIdx of candidateChunks) {
        const chunk = await readChunk(session.id, cIdx);
        if (!chunk) return null; // missing chunk — partial build never served
        if (chunk.status === 'completed' || chunk.pendingCount <= 0) continue; // metadata skip
        // Within this chunk, find the first live item at/after the requested
        // position (bounded to the chunk's items).
        const fromLocal = Math.max(0, currentPosition - chunk.startPosition);
        for (let li = fromLocal; li < chunk.items.length; li += 1) {
            const item = chunk.items[li];
            if (!item || typeof item.cardId !== 'string') return null;
            if (!itemLive(item)) continue;
            p = chunk.startPosition + li;
            headItem = item;
            break;
        }
        if (headItem) break;
        // Active chunk exhausted without a live item: its metadata should be
        // 'completed' — the NEXT candidate chunk is the current one.
        currentPosition = (cIdx + 1) * SESSION_QUEUE_CHUNK_SIZE;
    }
    if (!headItem || p < 0 || p >= limit) {
        return { currentPosition: null, currentCardId: null, cardIds: [] };
    }
    const to = Math.min(limit, p + 1 + SESSION_PRELOAD);
    const items = await loadV2Items(session, p, to);
    if (!items) return null;
    const cardIds: SessionQueueWindowEntry[] = [];
    for (let i = 0; i < items.length && cardIds.length < 1 + SESSION_PRELOAD; i += 1) {
        const item = items[i];
        if (!itemLive(item)) continue;
        cardIds.push({ cardId: item.cardId, position: p + i });
    }
    return {
        currentPosition: cardIds.length > 0 ? p : null,
        currentCardId: cardIds.length > 0 ? cardIds[0].cardId : null,
        cardIds,
    };
}

/**
 * Projected-page cursor for building a session queue: ordered by due ASC
 * then document id ASC, reading ONLY the id+due fields via Firestore field
 * projection (`.select('due')` — the doc id comes free). Each page is
 * bounded by SESSION_BUILD_PAGE_SIZE and resumes after the last document —
 * deterministic and resumable.
 */
interface BuildCursor {
    lastDue: Timestamp | null;
    lastDocId: string | null;
}

/** Resolves the selector query for a queue build. `deck` name selectors
 *  match the denormalized field; a missing deck entity is not an error
 *  (name-only legacy cards still match). Deck by STABLE ID must exist
 *  (validated earlier by resolveSessionDeck). */
function scopedQueueQuery(selectors: QueueBuildSelectors): FirebaseFirestore.Query {
    let q = getDb().collection(COLLECTION) as FirebaseFirestore.Query;
    q = q.where('ownerId', '==', selectors.ownerId);
    // Field projection: only `due` is read per card (the id is returned for
    // every doc regardless); the build never fetches full card documents.
    q = q.select('due');
    q = q.orderBy('due', 'asc');
    // Explicit document-id tie-break keeps paging deterministic when many
    // cards share a due instant.
    q = q.orderBy(FieldPath.documentId(), 'asc');
    if (selectors.byNameDeck) {
        if (selectors.deck !== undefined) q = q.where('deck', '==', selectors.deck);
    } else if (selectors.deckId !== undefined && selectors.deckId !== '') {
        q = q.where('deckId', '==', selectors.deckId);
    }
    if (selectors.tags && selectors.tags.length > 0) {
        q = q.where('tags', 'array-contains-any', selectors.tags);
    }
    if (!selectors.byNameDeck && !selectors.deckId && !selectors.deck && !(selectors.tags && selectors.tags.length > 0)) {
        // Default due-only queue (REVIEW_TEST_MODE widens ONLY the default).
        if (!selectors.testMode) {
            q = q.where('due', '<=', selectors.now);
        }
    }
    return q;
}

interface QueueBuildSelectors {
    deckId?: string;
    deck?: string;
    tags?: string[];
    allowlist: string[];
    byNameDeck: boolean;
    testMode: boolean;
    now: Timestamp;
    /** The queue query is scoped to this owner's cards. */
    ownerId: string;
}

/** One in-memory chunk accumulator during a build. */
interface ChunkAccumulator {
    chunkIndex: number;
    items: SessionQueueItem[];
}

/** Flushes a full chunk accumulator to Firestore (single doc set). */
async function flushChunk(sessionId: string, acc: ChunkAccumulator): Promise<void> {
    const startPosition = acc.chunkIndex * SESSION_QUEUE_CHUNK_SIZE;
    await sessionChunksCollection(sessionId).doc(chunkDocId(acc.chunkIndex)).set({
        chunkIndex: acc.chunkIndex,
        startPosition,
        itemCount: acc.items.length,
        pendingCount: acc.items.length,
        status: 'active',
        items: acc.items,
    });
}

/**
 * Builds a v2 session queue by PAGED PROJECTION with BOUNDED MEMORY: pages
 * read ≤ SESSION_BUILD_PAGE_SIZE (due ASC, doc id ASC) id+due rows via
 * `.select('due')`; each 200-item chunk is flushed to Firestore AS IT FILLS
 * (at most one partial chunk is retained between pages). Returns the exact
 * total (the sum of matched pages) — no separate count query, no full-queue
 * array. The session ROOT must already exist with buildStatus 'building'
 * (see startReviewSession); this function only writes chunk documents.
 */
async function buildV2QueueChunks(
    sessionId: string,
    selectors: QueueBuildSelectors,
    onProgress?: (flushedChunks: number, totalCount: number) => void,
): Promise<{ totalCount: number; chunkCount: number }> {
    const allowlist = selectors.allowlist;
    let totalCount = 0;
    let chunkCount = 0;
    let partial: ChunkAccumulator | null = null;

    const appendId = async (cardId: string): Promise<void> => {
        totalCount += 1;
        if (!partial) {
            partial = { chunkIndex: chunkCount, items: [] };
        }
        partial.items.push({ cardId, status: 'pending' });
        if (partial.items.length >= SESSION_QUEUE_CHUNK_SIZE) {
            // Flush as it fills: bounded memory, incremental writes.
            const acc = partial;
            partial = null;
            chunkCount += 1;
            await flushChunk(sessionId, acc);
            if (onProgress) onProgress(chunkCount, totalCount);
        }
    };

    if (allowlist.length > 0) {
        // Explicit allowlist: BOUNDED, deterministic, exact-missing semantics.
        //   - hard cap: requests above SESSION_MAX_ALLOWLIST_IDS are rejected
        //     with a clear error (never silent truncation);
        //   - streaming: allowlist card docs are fetched in bounded sequential
        //     batches (SESSION_BUILD_PAGE_SIZE at a time) — never a
        //     Promise.all over the whole list, never all snapshots resident;
        //   - memory: only compact {id, due, include} rows accumulate (O(k)
        //     small tuples — proportional to the client request, the
        //     information floor for a deterministic due+id sort) plus one
        //     batch of snapshots at a time;
        //   - missing ids FAIL exactly (first missing -> typed 404), matching
        //     the previous behavior;
        //   - deck/tag filters are applied per doc (intersection), and the
        //     surviving ids are ordered deterministically by due ASC then
        //     document id ASC before being chunked.
        if (allowlist.length > SESSION_MAX_ALLOWLIST_IDS) {
            throw new ReviewSessionSelectionTooLargeError(allowlist.length, SESSION_MAX_ALLOWLIST_IDS);
        }
        const rows: Array<{ id: string; due: number; include: boolean }> = [];
        for (let b = 0; b < allowlist.length; b += SESSION_BUILD_PAGE_SIZE) {
            const batch = allowlist.slice(b, b + SESSION_BUILD_PAGE_SIZE);
            const snaps = await Promise.all(batch.map((id) => getDb().collection(COLLECTION).doc(id).get()));
            for (let i = 0; i < batch.length; i += 1) {
                const snap = snaps[i];
                if (!snap.exists) {
                    throw new ReviewSessionCardNotFoundError(batch[i]);
                }
                const data = snap.data();
                // Owner-scoped sessions may never snapshot another tenant's
                // card: an explicit allowlist id that is not owned by the
                // caller reads as missing (404), like a nonexistent card.
                if (data?.ownerId !== selectors.ownerId) {
                    throw new ReviewSessionCardNotFoundError(batch[i]);
                }
                const due = (data?.due as Timestamp | undefined)?.toMillis?.() ?? 0;
                let include = true;
                if (selectors.deckId !== undefined && selectors.deckId !== '') {
                    if (selectors.byNameDeck) {
                        if (data?.deck !== selectors.deck && data?.deckId !== selectors.deckId) include = false;
                    } else if (data?.deckId !== selectors.deckId) {
                        include = false;
                    }
                }
                if (include && selectors.tags && selectors.tags.length > 0) {
                    const tags = Array.isArray(data?.tags) ? data.tags : [];
                    if (!selectors.tags.some((t) => tags.includes(t))) include = false;
                }
                rows.push({ id: batch[i], due, include });
            }
        }
        // Deterministic order: due ASC, ties by document id ASC. Note: the
        // (id, due) compact rows are bounded by the request size (itself
        // capped above), so this in-memory sort is bounded.
        rows.sort((a, b) => (a.due - b.due) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const row of rows) {
            if (!row.include) continue;
            await appendId(row.id);
        }
    } else {
        // Paged query build    } else {
        // Paged query build with projection. Each page resumes after the
        // last (due, docId) of the previous page.
        const query = scopedQueueQuery(selectors);
        const cursor: BuildCursor = { lastDue: null, lastDocId: null };
        for (;;) {
            let page = query;
            if (cursor.lastDue !== null && cursor.lastDocId !== null) {
                page = page.startAfter(cursor.lastDue, cursor.lastDocId);
            }
            const snap = await page.limit(SESSION_BUILD_PAGE_SIZE).get();
            if (snap.docs.length === 0) break;
            for (const doc of snap.docs) {
                const data = doc.data();
                const due = data?.due as Timestamp | undefined;
                cursor.lastDue = due ?? Timestamp.fromMillis(0);
                cursor.lastDocId = doc.id;
                // Bounded: flush full chunks as they fill (await keeps chunk
                // writes ordered and memory at one partial chunk).
                totalCount += 1;
                if (!partial) partial = { chunkIndex: chunkCount, items: [] };
                partial.items.push({ cardId: doc.id, status: 'pending' });
                if (partial.items.length >= SESSION_QUEUE_CHUNK_SIZE) {
                    const acc = partial;
                    partial = null;
                    chunkCount += 1;
                    await flushChunk(sessionId, acc);
                    if (onProgress) onProgress(chunkCount, totalCount);
                }
            }
            if (snap.docs.length < SESSION_BUILD_PAGE_SIZE) break;
        }
    }

    // Flush the final partial chunk (if any).
    if (partial && partial.items.length > 0) {
        const acc = partial;
        partial = null;
        chunkCount += 1;
        await flushChunk(sessionId, acc);
        if (onProgress) onProgress(chunkCount, totalCount);
    }

    return { totalCount, chunkCount };
}
async function resolveSessionDeck(input: { deckId?: string; deck?: string }, ownerId: string): Promise<{ deckId?: string; deckName: string; byName: boolean }> {
    if (input.deckId !== undefined && input.deckId !== '') {
        const deck = await getDeck(input.deckId, ownerId);
        if (!deck) throw new DeckNotFoundError(input.deckId);
        return { deckId: deck.id, deckName: deck.name, byName: false };
    }
    if (input.deck !== undefined && input.deck !== '') {
        const deck = await findOwnedDeckByExactName(ownerId, input.deck);
        return { deckId: deck?.id, deckName: input.deck, byName: true };
    }
    return { deckName: '', byName: false };
}
/**
 * Computes the persisted session source metadata from the given selectors.
 * Semantics (explicit, never widening):
 *  - NO selectors            -> { type: 'due' }
 *  - deck-only (deckId and/or deck) -> { type: 'deck', deckId, deckName }
 *  - ANY tags and/or cardIds -> { type: 'custom', ... } — every MIXED
 *    selection (deck + tags, deck + cardIds, tags + cardIds, all three) is
 *    'custom' so the widget can never claim a filtered session was a plain
 *    "due cards" or single-deck session. Selector details are recorded so
 *    Continue can replay the exact selection.
 */
function buildSessionSource(input: Pick<StartReviewSessionInput, 'deckId' | 'deck' | 'tags' | 'cardIds'>, deckRef: { deckId?: string; deckName: string; byName: boolean }, allowlist: string[]): ReviewSessionSource {
    const hasDeck = deckRef.byName || (deckRef.deckId !== undefined && deckRef.deckId !== '');
    const hasTags = Array.isArray(input.tags) && input.tags.length > 0;
    const hasCardIds = allowlist.length > 0;
    if (!hasDeck && !hasTags && !hasCardIds) {
        return { type: 'due' };
    }
    if (hasDeck && !hasTags && !hasCardIds) {
        const deckOnly: ReviewSessionSource = { type: 'deck', deckName: deckRef.deckName };
        if (deckRef.deckId !== undefined && deckRef.deckId !== '') deckOnly.deckId = deckRef.deckId;
        return deckOnly;
    }
    const source: ReviewSessionSource = { type: 'custom' };
    if (hasDeck) {
        if (deckRef.deckId !== undefined && deckRef.deckId !== '') source.deckId = deckRef.deckId;
        source.deckName = deckRef.deckName;
    }
    if (hasTags) {
        source.tags = [...(input.tags as string[])];
    }
    // STRICT INVARIANT: session provenance NEVER carries the card-id list on
    // v2 sessions (the queue lives chunked; Continue copies it via
    // repeatSessionId). hasCardIds above still classifies the source as
    // 'custom'; the ids themselves are deliberately NOT recorded — they would
    // leak the full session snapshot through source on every response.
    return source;
}

/**
 * Deduplicates opaque Firestore card IDs by exact value while preserving
 * first-occurrence order. Never trim or otherwise normalize an ID.
 */
function normalizeCardIdAllowlist(cardIds: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of cardIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export async function startReviewSession(input: StartReviewSessionInput, ownerId: string): Promise<ReviewSessionWithCard> {
    const now = Timestamp.now();
    const testMode = isReviewTestMode();
    const allowlist = normalizeCardIdAllowlist(input.cardIds ?? []);
    // Validate the explicit allowlist bound BEFORE any root/chunk write: an
    // oversized selection is rejected with a clear 400 (never truncated, and
    // never a failed-building root).
    if (allowlist.length > SESSION_MAX_ALLOWLIST_IDS) {
        throw new ReviewSessionSelectionTooLargeError(allowlist.length, SESSION_MAX_ALLOWLIST_IDS);
    }
    const selectorsPresent = input.deckId !== undefined
        || (input.deck !== undefined && input.deck !== '')
        || (Array.isArray(input.tags) && input.tags.length > 0)
        || allowlist.length > 0;

    const docRef = getDb().collection(SESSIONS_COLLECTION).doc();
    const sessionId = docRef.id;

    // ── Continue lineage (repeatSessionId) ────────────────────────────────
    // A session started with repeatSessionId and NO other selectors copies
    // the REFERENCED session's queue chunks verbatim (Continue replays the
    // same snapshot — the previous session's exact card set — instead of
    // re-running a fresh due/selector query that could differ).
    const repeatSessionId = input.repeatSessionId !== undefined && input.repeatSessionId !== null && input.repeatSessionId !== ''
        ? input.repeatSessionId
        : undefined;
    const continueCopy = repeatSessionId !== undefined && !selectorsPresent;
    let priorSnapshot: DocumentSnapshot<DocumentData> | undefined;
    let priorSession: ReviewSession | undefined;
    if (continueCopy) {
        priorSnapshot = await getDb().collection(SESSIONS_COLLECTION).doc(repeatSessionId as string).get();
        if (priorSnapshot.exists) {
            priorSession = docToReviewSession(priorSnapshot);
            assertSessionOwnership(priorSession, ownerId);
            assertSessionVersionsSupported(priorSession, priorSnapshot);
        }
    }

    let source: ReviewSessionSource;
    const deckRef = selectorsPresent ? await resolveSessionDeck(input, ownerId) : { deckName: '', byName: false } as { deckId?: string; deckName: string; byName: boolean };
    if (!selectorsPresent) {
        source = { type: 'due' as const };
    } else {
        source = buildSessionSource(input, deckRef, allowlist);
    }

    // ── Bounded v2 root written FIRST (build lifecycle) ───────────────────
    // The root exists immediately with buildStatus 'building' + status
    // 'active' but totalCount/reviewedCount/remainingCount 0; it is NOT
    // reviewable until the build finalizes (buildStatus 'ready', exact
    // counts). A failed build updates the SAME root to buildStatus 'failed'
    // + status 'failed' — the session is explicitly non-reviewable, and a
    // retry starts a fresh session (cleanup: delete the session root and its
    // queueChunks subcollection).
    const rootBuilding: Record<string, unknown> = {
        ownerId,
        status: 'active',
        storageVersion: SESSION_STORAGE_VERSION,
        mode: 'spaced_repetition',
        ...(input.deckId !== undefined ? { deckId: input.deckId } : {}),
        ...(input.name !== undefined && input.name !== null ? { name: input.name } : {}),
        ...(input.cardType !== undefined && input.cardType !== null ? { cardType: input.cardType } : {}),
        source,
        requestClaimsVersion: 1,
        buildStatus: 'building',
        limit: 0,
        totalCount: 0,
        dueCount: 0,
        chunkCount: 0,
        completedChunks: 0,
        queueChunksPrefix: SESSION_QUEUE_CHUNKS_COLLECTION,
        position: 0,
        deletedCount: 0,
        remainingQueueCount: 0,
        currentIndex: 0,
        currentPosition: 0,
        currentChunkIndex: -1,
        remainingCount: 0,
        reviewedCount: 0,
        truncated: false,
        continuationAvailable: false,
        ratingCounts: emptyRatingCounts(),
        startedAt: now,
        ...(testMode ? { testMode: true } : {}),
        ...(repeatSessionId !== undefined ? { repeatSessionId } : {}),
    };
    await docRef.set(rootBuilding);

    let totalCount = 0;
    let chunkCount = 0;
    try {
        if (continueCopy) {
            if (!priorSnapshot?.exists || !priorSession) {
                throw new ReviewSessionCardNotFoundError(repeatSessionId as string);
            }
            const prior = priorSession;
            if (!isV2Session(prior) || !isV2Ready(prior)) {
                throw new ReviewSessionBuildFailedError(sessionId, 'cannot copy a session that is not a finalized v2 session; replay its selectors instead');
            }
            // Propagate the prior session's provenance.
            if (prior.source) source = prior.source;
            const priorLimit = prior.limit ?? 0;
            const priorChunkCount = prior.chunkCount ?? Math.ceil(Math.max(priorLimit, 1) / SESSION_QUEUE_CHUNK_SIZE);
            const targetCollection = sessionChunksCollection(sessionId);
            for (let c = 0; c < priorChunkCount; c += 1) {
                const chunk = await readChunk(repeatSessionId as string, c);
                if (!chunk) {
                    throw new ReviewSessionBuildFailedError(repeatSessionId as string, 'queue chunks missing');
                }
                // Continue RE-REVIEWS the same card set: the copied chunk is
                // reset to a fresh state (every item pending, chunk active)
                // even when the prior session was fully reviewed.
                const freshItems = chunk.items.map((it) => ({ cardId: it.cardId, status: 'pending' as const }));
                await targetCollection.doc(chunkDocId(c)).set({
                    chunkIndex: chunk.chunkIndex,
                    startPosition: chunk.startPosition,
                    itemCount: freshItems.length,
                    pendingCount: freshItems.length,
                    status: 'active',
                    items: freshItems,
                });
                chunkCount += 1;
            }
            totalCount = priorLimit;
        } else {
            // Chunked, paged projection build with BOUNDED memory: each
            // 200-item chunk is flushed to Firestore as it fills; the exact
            // total comes from the sum of matched pages (no count query).
            const result = await buildV2QueueChunks(sessionId, {
                deckId: deckRef.deckId,
                deck: selectorsPresent ? input.deck ?? deckRef.deckName : undefined,
                tags: input.tags,
                allowlist,
                byNameDeck: deckRef.byName,
                testMode: !selectorsPresent && testMode,
                now,
                ownerId,
            });
            totalCount = result.totalCount;
            chunkCount = result.chunkCount;
        }

        // ── Finalize the root with exact counts ────────────────────────────
        await docRef.update({
            buildStatus: 'ready',
            limit: totalCount,
            totalCount,
            dueCount: totalCount,
            chunkCount,
            position: totalCount,
            remainingQueueCount: totalCount,
            remainingCount: totalCount,
            currentPosition: totalCount > 0 ? 0 : 0,
            currentChunkIndex: totalCount > 0 ? 0 : -1,
        });
    } catch (err) {
        // The root already exists (buildStatus 'building'): mark it FAILED so
        // the session is explicitly non-reviewable (get/submit throw
        // ReviewSessionBuildFailedError). Retry = fresh session; cleanup =
        // delete the session root + queueChunks subcollection.
        const buildError = err instanceof Error ? err.message : String(err);
        try {
            await docRef.update({
                status: 'failed',
                buildStatus: 'failed',
                buildFailed: true,
                buildError,
                endedAt: Timestamp.now(),
            });
        } catch (updateErr) {
            // Best-effort marker; the original error is what the caller sees.
        }
        if (err instanceof ReviewSessionBuildFailedError
            || err instanceof ReviewSessionCardNotFoundError
            || err instanceof ReviewSessionForbiddenError) {
            throw err;
        }
        throw new ReviewSessionBuildFailedError(sessionId, buildError);
    }

    const limit = totalCount;
    const progressed = await advanceV2PastDeleted(sessionId, ownerId);
    if (!progressed) throw new ReviewSessionBuildFailedError(sessionId, 'session disappeared while hydrating its queue');
    const readySession = progressed;

    // Build the current-card + preload response from the persisted live queue
    // head (deleted positions were already claimed by bounded advancement).
    // Each preload carries its REQUIRED stable queue position.
    const window = await loadV2QueueWindow(readySession, readySession.currentPosition ?? readySession.currentIndex ?? 0);
    let card: Flashcard | null = null;
    const preloaded: PreloadedCard[] = [];
    if (window && window.cardIds.length > 0) {
        const entries = window.cardIds.slice(0, 1 + SESSION_PRELOAD);
        const snaps = await Promise.all(entries.map((w) => getDb().collection(COLLECTION).doc(w.cardId).get()));
        for (let i = 0; i < snaps.length; i += 1) {
            if (!snaps[i] || !snaps[i].exists || snaps[i].data()?.ownerId !== ownerId) continue;
            const c = docToFlashcard(snaps[i]);
            if (!card) {
                card = c;
                continue;
            }
            if (preloaded.length >= SESSION_PRELOAD) continue;
            preloaded.push({
                id: c.id,
                front: c.front,
                back: c.back,
                ...(c.deck !== undefined ? { deck: c.deck } : {}),
                tags: c.tags,
                position: entries[i].position,
            });
        }
    }
    const currentEntry = window?.cardIds.find((entry) => entry.cardId === card?.id);
    const queueWindow: SessionQueueWindow = currentEntry
        ? {
            currentPosition: currentEntry.position,
            currentCardId: currentEntry.cardId,
            cardIds: [currentEntry, ...window!.cardIds.filter((entry) => entry.position > currentEntry.position)],
        }
        : { currentPosition: null, currentCardId: null, cardIds: [] };
    const currentChunkPosition = currentEntry?.position;
    const respSession: ReviewSession = {
        ...readySession,
        remainingQueueCount: readySession.remainingQueueCount ?? limit,
        remainingCount: readySession.remainingQueueCount ?? limit,
        ...(currentChunkPosition !== undefined ? { currentPosition: currentChunkPosition, currentChunkIndex: chunkOrdinalFor(currentChunkPosition) } : { currentChunkIndex: -1 }),
    };
    return {
        session: respSession,
        card,
        preloaded,
        currentPosition: currentChunkPosition ?? null,
        queueWindow,
    };
}

/**
 * Builds the preloaded-card queue for a session response: the upcoming cards
 * after `currentIndex` (skipping deleted snapshot ids), up to the
 * SESSION_PRELOAD window. This window is a bounded render-ahead buffer for
 * clients; the authoritative queue remains the session's cardIds +
 * currentIndex (the full, uncapped snapshot).
 *
 * Reads are BATCHED (parallel Promise.all, preserving cardIds order) instead
 * of serial — one round of concurrent document fetches.
 */
async function loadPreloaded(session: ReviewSession, ownerId: string, startIndex: number): Promise<PreloadedCard[]> {
    // v1/no-version legacy documents always carry the in-root cardIds; a
    // defensive read keeps a malformed root from crashing get/submit.
    const ids = (session.cardIds ?? []).slice(startIndex, startIndex + SESSION_PRELOAD);
    if (ids.length === 0)
        return [];
    const snapshots = await Promise.all(ids.map((id) => getDb().collection(COLLECTION).doc(id).get()));
    const out = [];
    for (let i = 0; i < snapshots.length; i += 1) {
        const cardDoc = snapshots[i];
        if (!cardDoc.exists || cardDoc.data()?.ownerId !== ownerId)
            continue;
        const c = docToFlashcard(cardDoc);
        out.push({
            id: c.id,
            front: c.front,
            back: c.back,
            ...(c.deck !== undefined ? { deck: c.deck } : {}),
            tags: c.tags,
        });
    }
    return out;
}
/** Whether a session is still accepting ratings. */
function isSessionActive(session: ReviewSession): boolean {
    return session.status === 'active';
}
/**
 * Loads the card a session is currently pointing at. A card that was deleted
 * since the snapshot is skipped (the session advances past it on the next
 * submission); a card that became not-due (e.g. reviewed through the normal
 * API) is reported as-is. Returns null when the queue is exhausted.
 */
async function loadSessionCard(session: ReviewSession, ownerId: string): Promise<Flashcard | null> {
    // v1/no-version legacy documents always carry the in-root cardIds; a
    // defensive read keeps a malformed root from crashing get/submit.
    const cardIds = session.cardIds ?? [];
    if (!isSessionActive(session) || session.currentIndex >= cardIds.length) {
        return null;
    }
    const cardDoc = await getDb().collection(COLLECTION).doc(cardIds[session.currentIndex]).get();
    if (!cardDoc.exists || cardDoc.data()?.ownerId !== ownerId)
        return null;
    return docToFlashcard(cardDoc);
}
/**
 * Retrieves a session (any status) plus its current card. Only its owner may
 * read it.
 *
 * v2 sessions return the current card from the queue window (never the full
 * queue) plus `currentPosition`/`queueWindow`; legacy v1/no-version sessions
 * keep the existing full-array response unchanged.
 */
export async function getReviewSession(sessionId: string, ownerId: string): Promise<ReviewSessionWithCard | null> {
    const docRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await docRef.get();
    if (!snap.exists)
        return null;
    const session = docToReviewSession(snap);
    assertSessionOwnership(session, ownerId);
    assertSessionVersionsSupported(session, snap);
    if (isV2Session(session)) {
        return getV2ReviewSession(session, ownerId);
    }
    return loadSessionCard(session, ownerId).then(async (card) => ({
        session: { ...session, remainingCount: sessionRemainingCount(session) },
        card,
        preloaded: await loadPreloaded(session, ownerId, session.currentIndex + 1),
    }));
}
/**
 * Persisted v2 deleted-card progress for GET/submit hydration. Each transaction
 * inspects at most one queue chunk (200 cards), claims only the missing prefix,
 * and advances the root before another chunk is considered. This keeps every
 * Firestore transaction bounded while ensuring no deleted run can strand the
 * client with an active session and no card.
 */
async function advanceV2PastDeleted(sessionId: string, ownerId: string): Promise<ReviewSession | null> {
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    for (;;) {
        const step = await getDb().runTransaction(async (t) => {
            const snap = await t.get(sessionRef);
            if (!snap.exists) return { session: null, continue: false };
            const live = docToReviewSession(snap);
            assertSessionOwnership(live, ownerId);
            assertSessionVersionsSupported(live, snap);
            if (!isV2Ready(live)) {
                throw new ReviewSessionBuildFailedError(sessionId, live.buildError ?? 'queue snapshot is corrupt or session is not ready; start a new review session');
            }
            if (!isSessionActive(live)) return { session: live, continue: false };

            const limit = live.limit ?? 0;
            const remaining = live.remainingQueueCount ?? 0;
            const startPosition = live.currentPosition ?? live.currentIndex ?? 0;
            if (limit <= 0 || remaining <= 0) return { session: live, continue: false };
            if (startPosition >= limit) {
                throw new ReviewSessionBuildFailedError(sessionId, 'queue counters are inconsistent; start a new review session');
            }

            const q = txQueueReader(t, sessionId, limit);
            const chunk = await q.chunkFor(startPosition);
            if (!chunk) throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing');
            const firstLocal = Math.max(0, startPosition - chunk.startPosition);
            const pendingPositions: number[] = [];
            for (let local = firstLocal; local < chunk.items.length; local += 1) {
                if (chunk.items[local].status === 'pending') pendingPositions.push(chunk.startPosition + local);
            }

            if (pendingPositions.length === 0) {
                const nextPosition = chunk.startPosition + chunk.itemCount;
                if (nextPosition >= limit) {
                    throw new ReviewSessionBuildFailedError(sessionId, 'queue counters are inconsistent; start a new review session');
                }
                const patch: Partial<ReviewSession> = {
                    currentIndex: nextPosition,
                    currentPosition: nextPosition,
                    currentChunkIndex: chunkOrdinalFor(nextPosition),
                };
                t.update(sessionRef, patch);
                return { session: { ...live, ...patch }, continue: true };
            }

            const refs = pendingPositions.map((position) => getDb().collection(COLLECTION).doc(chunk.items[chunkLocalIndex(position)].cardId));
            let skipped = 0;
            let currentPosition: number | null = null;
            let nextRemaining = remaining;
            let nextDeletedCount = live.deletedCount ?? 0;
            for (let index = 0; index < refs.length; index += 1) {
                const cardSnap = await t.get(refs[index]);
                if (cardSnap.exists && cardSnap.data()?.ownerId === ownerId) {
                    currentPosition = pendingPositions[index];
                    break;
                }
                const position = pendingPositions[index];
                q.claim(position, { status: 'deleted', deletedAt: Timestamp.now() });
                skipped += 1;
                nextRemaining -= 1;
                nextDeletedCount += 1;
            }

            if (currentPosition !== null) {
                if (skipped === 0 && currentPosition === startPosition) return { session: live, continue: false };
                const patch: Partial<ReviewSession> = {
                    currentIndex: currentPosition,
                    currentPosition,
                    currentChunkIndex: chunkOrdinalFor(currentPosition),
                    remainingQueueCount: nextRemaining,
                    remainingCount: nextRemaining,
                    deletedCount: nextDeletedCount,
                };
                q.flush();
                t.update(sessionRef, patch);
                return { session: { ...live, ...patch }, continue: false };
            }

            const nextPosition = chunk.startPosition + chunk.itemCount;
            if (nextRemaining > 0 && nextPosition >= limit) {
                throw new ReviewSessionBuildFailedError(sessionId, 'queue counters are inconsistent; start a new review session');
            }
            const complete = nextRemaining === 0;
            const patch: Partial<ReviewSession> = {
                currentIndex: nextPosition,
                currentChunkIndex: complete ? -1 : chunkOrdinalFor(nextPosition),
                remainingQueueCount: nextRemaining,
                remainingCount: nextRemaining,
                deletedCount: nextDeletedCount,
                ...(complete ? { status: 'completed' as const, endedAt: Timestamp.now() } : { currentPosition: nextPosition }),
            };
            q.flush();
            t.update(sessionRef, patch);
            return { session: { ...live, ...patch }, continue: !complete };
        });
        if (!step.session || !step.continue) return step.session;
    }
}

/** v2 get: reads the current card + bounded preload from the queue chunks.
 *  A session whose build is incomplete (buildStatus 'building') or failed is
 *  NOT reviewable — the typed error is surfaced (never a partial queue). */
async function getV2ReviewSession(session: ReviewSession, ownerId: string): Promise<ReviewSessionWithCard> {
    if (!isV2Ready(session)) {
        throw new ReviewSessionBuildFailedError(session.id, session.buildError ?? 'session not ready');
    }
    const progressed = await advanceV2PastDeleted(session.id, ownerId);
    if (!progressed) throw new ReviewSessionBuildFailedError(session.id, 'session disappeared while advancing its queue');
    session = progressed;
    const currentPosition = session.currentPosition ?? session.currentIndex ?? 0;
    const window = await loadV2QueueWindow(session, currentPosition);
    if (!window) {
        // A covering chunk is missing — the build was partial. Surface the
        // typed error rather than serving a partial queue.
        throw new ReviewSessionBuildFailedError(session.id, 'queue chunks missing');
    }
    let card: Flashcard | null = null;
    let currentEntry: SessionQueueWindowEntry | null = null;
    const preloaded: PreloadedCard[] = [];
    if (window.cardIds.length > 0) {
        const entries = window.cardIds.slice(0, 1 + SESSION_PRELOAD);
        const snaps = await Promise.all(entries.map((w) => getDb().collection(COLLECTION).doc(w.cardId).get()));
        for (let i = 0; i < snaps.length; i += 1) {
            if (!snaps[i] || !snaps[i].exists || snaps[i].data()?.ownerId !== ownerId) continue;
            const c = docToFlashcard(snaps[i]);
            if (!card) {
                card = c;
                currentEntry = entries[i];
                continue;
            }
            if (preloaded.length >= SESSION_PRELOAD) continue;
            preloaded.push({ id: c.id, front: c.front, back: c.back, ...(c.deck !== undefined ? { deck: c.deck } : {}), tags: c.tags, position: entries[i].position });
        }
    }
    const liveWindow: SessionQueueWindow = currentEntry
        ? {
            currentPosition: currentEntry.position,
            currentCardId: currentEntry.cardId,
            cardIds: [currentEntry, ...window.cardIds.filter((entry) => entry.position > currentEntry!.position)],
        }
        : { currentPosition: null, currentCardId: null, cardIds: [] };
    const respSession: ReviewSession = {
        ...session,
        remainingQueueCount: session.remainingQueueCount ?? 0,
        remainingCount: session.remainingQueueCount ?? 0,
        ...(currentEntry ? { currentPosition: currentEntry.position, currentChunkIndex: chunkOrdinalFor(currentEntry.position) } : { currentChunkIndex: -1 }),
    };
    return {
        session: respSession,
        card,
        preloaded,
        currentPosition: currentEntry?.position ?? null,
        queueWindow: liveWindow,
    };
}

/**
 * Submits a rating for a card of a review session.
 *
 * New v2 roots stamp requestClaimsVersion: 1 when created. Each requestId is
 * recorded in its private per-session claim document in the same transaction
 * as queue/root progress; live normal-mode reviews also update the card and
 * event, while test-mode/deleted-target skips do not.
 * Unmarked legacy roots keep logical event, queue-item, and latest-root replay
 * fallbacks. If deletion/test-mode history cannot be reconstructed, submit
 * fails closed with a typed restart error rather than claiming ledger completeness.
 */
export async function submitSessionReview(sessionId: string, input: SubmitSessionReviewInput, ownerId: string): Promise<SubmitSessionReviewResult | null> {
    // Route by the persisted root metadata. Never downgrade a failed/missing read
    // into legacy mode: that mode is only valid for roots with no storageVersion.
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await sessionRef.get();
    if (!snap.exists) return null;
    const session = docToReviewSession(snap);
    assertSessionOwnership(session, ownerId);
    assertSessionVersionsSupported(session, snap);
    if (session.storageVersion === undefined || session.storageVersion === 1) {
        return submitLegacySessionReview(sessionId, input, ownerId);
    }
    return submitV2SessionReview(session, input, ownerId);
}

/** Per-transaction reader over a v2 session's queueChunks documents. Every
 *  chunk read goes through `t.get` with a cache so the transaction's snapshot
 *  is used consistently and a concurrent claim of the same chunk forces a
 *  transaction retry (at-most-once is preserved). */
interface TxQueueReader {
    /** Reads the full chunk doc owning `position` (null when missing/corrupt). */
    chunkFor(position: number): Promise<SessionChunkDocument | null>;
    /** Reads one queue item at `position` (null when missing/corrupt). */
    item(position: number): Promise<SessionQueueItem | null>;
    /** Marks an item in the cached array; dirty chunks flush after all reads. */
    claim(position: number, patch: { status: 'reviewed' | 'deleted'; rating?: number; requestId?: string; reviewedAt?: Timestamp; deletedAt?: Timestamp }): void;
    /** Writes each dirty chunk exactly once; callers invoke after their last transaction read. */
    flush(): void;
}

function txQueueReader(t: FirebaseFirestore.Transaction, sessionId: string, limit: number): TxQueueReader {
    const chunkCache = new Map<number, SessionChunkDocument>();
    const chunkRefs = new Map<number, DocumentReference<DocumentData>>();
    const loaded = new Set<number>();
    const dirty = new Set<number>();
    return {
        async chunkFor(position: number) {
            const chunkIndex = chunkOrdinalFor(position);
            if (!loaded.has(chunkIndex)) {
                loaded.add(chunkIndex);
                const ref = sessionChunksCollection(sessionId).doc(chunkDocId(chunkIndex));
                chunkRefs.set(chunkIndex, ref);
                const doc = await t.get(ref);
                if (!doc.exists) return null;
                const data = doc.data();
                const startPosition = chunkIndex * SESSION_QUEUE_CHUNK_SIZE;
                if (!data || !Array.isArray(data.items)) return null;
                const items = data.items as SessionQueueItem[];
                const expectedCount = Math.min(SESSION_QUEUE_CHUNK_SIZE, limit - startPosition);
                if (expectedCount <= 0 || items.length !== expectedCount
                    || items.some((item) => !item || typeof item.cardId !== 'string' || !['pending', 'reviewed', 'deleted'].includes(item.status))) return null;
                const actualPending = items.filter((item) => item.status === 'pending').length;
                if (data.itemCount !== items.length || data.pendingCount !== actualPending
                    || (data.status !== 'active' && data.status !== 'completed')
                    || data.status !== (actualPending === 0 ? 'completed' : 'active')
                    || data.chunkIndex !== chunkIndex || data.startPosition !== startPosition) return null;
                const chunk: SessionChunkDocument = {
                    chunkIndex,
                    startPosition,
                    itemCount: items.length,
                    pendingCount: actualPending,
                    status: actualPending === 0 ? 'completed' : 'active',
                    items,
                };
                chunkCache.set(chunkIndex, chunk);
            }
            return chunkCache.get(chunkIndex) ?? null;
        },
        async item(position: number) {
            const chunk = await this.chunkFor(position);
            if (!chunk) return null;
            const local = position - chunk.startPosition;
            if (local < 0 || local >= chunk.items.length) return null;
            const item = chunk.items[local];
            return item ?? null;
        },
        claim(position: number, patch: { status: 'reviewed' | 'deleted'; rating?: number; requestId?: string; reviewedAt?: Timestamp; deletedAt?: Timestamp }) {
            const chunkIndex = chunkOrdinalFor(position);
            const chunk = chunkCache.get(chunkIndex);
            const local = chunkLocalIndex(position);
            if (!chunk || !chunk.items[local] || chunk.items[local].status !== 'pending') {
                throw new ReviewSessionBuildFailedError(sessionId, 'queue snapshot is corrupt or already claimed; start a new review session');
            }
            chunk.items[local] = { ...chunk.items[local], ...patch };
            chunk.pendingCount -= 1;
            chunk.status = chunk.pendingCount === 0 ? 'completed' : 'active';
            dirty.add(chunkIndex);
        },
        flush() {
            for (const chunkIndex of dirty) {
                const chunk = chunkCache.get(chunkIndex);
                const ref = chunkRefs.get(chunkIndex);
                if (!chunk || !ref) throw new ReviewSessionBuildFailedError(sessionId, 'queue snapshot is corrupt; start a new review session');
                t.update(ref, {
                    chunkIndex: chunk.chunkIndex,
                    startPosition: chunk.startPosition,
                    itemCount: chunk.itemCount,
                    pendingCount: chunk.pendingCount,
                    status: chunk.status,
                    items: chunk.items,
                });
            }
        },
    };
}


/**
 * v2 submit core. The whole claim (card FSRS + event + chunk item marker +
 * session counters) commits inside ONE transaction. All chunk/card reads use
 * the transaction (snapshot-consistent, retry-on-conflict), so two concurrent
 * submissions can never claim the same queue position:
 *   - the target chunk doc is read via `t.get` BEFORE the claim write, so a
 *     concurrent claim of the SAME chunk aborts one transaction (retry);
 *   - the session root read + update gives the second conflict line.
 *
 * BOUNDED READS (never a scan to the limit):
 *   - `expectedCardId` -> direct lookups within the ACTIVE chunk and, at
 *     most, the NEXT chunk (the window a client can legally hold is the
 *     bounded preload ≤ SESSION_PRELOAD positions);
 *   - neither -> the CURRENT authoritative position only (the root's
 *     currentChunkIndex/currentPosition; the active chunk's first live item).
 * Advancement never tail-scans: the next current position is the first live
 * item of the ACTIVE chunk, else of the chunk that follows it, using the
 * chunk metadata (status/pendingCount) — the root currentChunkIndex is
 * advanced only when the active chunk completes.
 *
 * DUPLICATE-requestId IDEMPOTENCY: every committed requestId claim is stored
 * in a private per-session requestClaims document in the same transaction as
 * its queue/root mutation. Historical event lookup remains for legacy roots.
 * Claim reads happen before status guards and writes, so same-key retries
 * return a bounded no-op even after the session is complete.
 *
 */
async function submitV2SessionReview(session: ReviewSession, input: SubmitSessionReviewInput, ownerId: string): Promise<SubmitSessionReviewResult | null> {
    const sessionId = session.id;
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const reviewTime = resolveReviewTime(input.reviewAt, new Date());
    const updatedAt = Timestamp.now();
    const requestId = input.requestId;
    const sessionEventRef = requestId !== undefined
        ? getDb().collection('reviewEvents').doc(sessionEventId(ownerId, sessionId, requestId))
        : getDb().collection('reviewEvents').doc();
    const sessionEventQuery = requestId !== undefined
        ? getDb().collection('reviewEvents')
            .where('ownerId', '==', ownerId)
            .where('sessionId', '==', sessionId)
            .where('requestId', '==', requestId)
            .limit(1)
        : null;

    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const live = docToReviewSession(snap);
        assertSessionOwnership(live, ownerId);
        assertSessionVersionsSupported(live, snap);
        if (!isV2Ready(live)) {
            throw new ReviewSessionBuildFailedError(sessionId, live.buildError ?? 'queue snapshot is corrupt or session is not ready; start a new review session');
        }
        const limit = live.limit ?? 0;
        const startPosition = live.currentIndex ?? 0;
        const q = txQueueReader(t, sessionId, limit);

        if (requestId !== undefined) {
            const requestClaim = await t.get(sessionRequestClaimRef(sessionId, ownerId, requestId));
            if (requestClaim.exists) {
                const claim = requestClaim.data();
                if (!claim || claim.requestId !== requestId || typeof claim.position !== 'number' || typeof claim.cardId !== 'string') {
                    throw new ReviewSessionBuildFailedError(sessionId, 'request claim is corrupt; start a new review session');
                }
                const cur = await loadV2CurrentCard(live, ownerId);
                return {
                    session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                    card: cur.card,
                    currentPosition: cur.position,
                    requestId,
                };
            }

            // Old v2 roots may predate the complete claim ledger. A matching
            // event proves a rated request; the root proves its latest claim.
            // Deletion-only and test-mode history cannot be reconstructed.
            if (live.requestClaimsVersion !== 1 && live.lastRequestId === requestId) {
                const cur = await loadV2CurrentCard(live, ownerId);
                return {
                    session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                    card: cur.card,
                    currentPosition: cur.position,
                    requestId,
                };
            }
            if (live.requestClaimsVersion !== 1 && sessionEventQuery) {
                const events = await t.get(sessionEventQuery);
                if (!events.empty) {
                    const cur = await loadV2CurrentCard(live, ownerId);
                    return {
                        session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                        card: cur.card,
                        currentPosition: cur.position,
                        requestId,
                    };
                }
            }
            if (live.requestClaimsVersion !== 1 && input.expectedPosition !== undefined
                && Number.isInteger(input.expectedPosition) && input.expectedPosition >= 0 && input.expectedPosition < limit) {
                const item = await q.item(input.expectedPosition);
                if (item?.requestId === requestId && item.status === 'reviewed') {
                    const cur = await loadV2CurrentCard(live, ownerId);
                    return {
                        session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                        card: cur.card,
                        currentPosition: cur.position,
                        requestId,
                    };
                }
            }
            if (live.requestClaimsVersion !== 1
                && ((live.deletedCount ?? 0) > 0 || (live.testMode === true && live.reviewedCount > 0))) {
                throw new ReviewSessionRetryHistoryUnavailableError(sessionId);
            }
        }

        // ── Queue exhausted / not active ───────────────────────────────────
        if (!isSessionActive(live) || startPosition >= limit) {
            if (!isSessionActive(live)) {
                throw new ReviewSessionNotActiveError(sessionId, live.status);
            }
            const finalState: Partial<ReviewSession> = { status: 'completed', endedAt: updatedAt };
            t.update(sessionRef, finalState);
            return {
                session: { ...live, ...finalState, remainingCount: 0 },
                card: null,
                currentPosition: null,
                ...(requestId !== undefined ? { requestId } : {}),
            };
        }

        // ── Resolve the claim target (bounded) ─────────────────────────────
        let targetPosition = -1;
        let targetCardId: string | null = null;

        // A. expectedPosition: DIRECT lookup of that position's chunk.
        if (input.expectedPosition !== undefined && Number.isInteger(input.expectedPosition)) {
            if (input.expectedPosition < 0 || input.expectedPosition >= limit) {
                throw new ReviewExpectedCardMismatchError(sessionId, String(input.expectedPosition), undefined);
            }
            const e = await q.item(input.expectedPosition);
            if (!e) throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing');
            if (e.status !== 'pending') {
                if (requestId !== undefined && e.requestId === requestId && e.status === 'reviewed') {
                    // Same-request retry of a committed position: no-op.
                    targetPosition = input.expectedPosition;
                    targetCardId = e.cardId;
                } else {
                    // Legacy v2 roots may use event history because they
                    // predate the private requestClaims ledger.
                    if (requestId !== undefined && live.requestClaimsVersion !== 1) {
                        const evt = await t.get(sessionEventRef);
                        if (evt && evt.exists) {
                            const cur = await loadV2CurrentCard(live, ownerId);
                            return {
                                session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                                card: cur.card,
                                currentPosition: cur.position,
                                requestId,
                            };
                        }
                    }
                    throw new ReviewExpectedCardMismatchError(sessionId, String(input.expectedPosition), undefined);
                }
            } else {
                // Live item. Positions strictly before the current index are
                // already consumed (stale client — 409, re-sync).
                if (input.expectedPosition < startPosition) {
                    throw new ReviewExpectedCardMismatchError(sessionId, String(input.expectedPosition), undefined);
                }
                targetPosition = input.expectedPosition;
                targetCardId = e.cardId;
            }
        }

        if (input.expectedPosition !== undefined && input.expectedCardId !== undefined
            && targetPosition >= 0 && targetCardId !== input.expectedCardId) {
            throw new ReviewExpectedCardMismatchError(sessionId, input.expectedCardId, targetCardId ?? undefined);
        }

        // B. expectedCardId WITHOUT expectedPosition: v2 accepts ONLY the
        //    CURRENT authoritative position. The client's expectedCardId is a
        //    confirmation of the card it believes is current — resolve the
        //    current position and verify the id matches (a mismatch is a 409;
        //    NEVER a scan through later chunks for an out-of-order card — v2
        //    parallel/out-of-order claims require expectedPosition).
        if (targetPosition < 0 && input.expectedCardId !== undefined) {
            const startChunk = chunkOrdinalFor(startPosition);
            const chunk = await q.chunkFor(startPosition);
            if (!chunk) throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing');
            let currentPos = -1;
            let currentCard: string | null = null;
            for (let li = startPosition - chunk.startPosition; li < chunk.items.length; li += 1) {
                const pos = chunk.startPosition + li;
                if (pos >= limit) break;
                const it = chunk.items[li];
                if (!it || typeof it.cardId !== 'string') break;
                if (it.status !== 'pending') continue;
                currentPos = pos;
                currentCard = it.cardId;
                break;
            }
            // When the active chunk is exhausted, the current position is the
            // first live item of the NEXT chunk (its metadata) — bounded.
            if (currentPos < 0 && startChunk + 1 < Math.ceil(limit / SESSION_QUEUE_CHUNK_SIZE)) {
                const next = await q.chunkFor((startChunk + 1) * SESSION_QUEUE_CHUNK_SIZE);
                if (!next) {
                    throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing; start a new review session');
                }
                for (let li = 0; li < next.items.length; li += 1) {
                    const pos = next.startPosition + li;
                    if (pos >= limit) break;
                    const it = next.items[li];
                    if (!it || typeof it.cardId !== 'string') break;
                    if (it.status !== 'pending') continue;
                    currentPos = pos;
                    currentCard = it.cardId;
                    break;
                }
            }
            if (currentPos < 0) {
                // Queue exhausted (no live current card).
                const finalState: Partial<ReviewSession> = { status: 'completed', endedAt: updatedAt };
                t.update(sessionRef, finalState);
                return {
                    session: { ...live, ...finalState, remainingCount: 0 },
                    card: null,
                    currentPosition: null,
                    ...(requestId !== undefined ? { requestId } : {}),
                };
            }
            if (currentCard !== input.expectedCardId) {
                throw new ReviewExpectedCardMismatchError(sessionId, input.expectedCardId, currentCard ?? undefined);
            }
            targetPosition = currentPos;
            targetCardId = currentCard;
        }

        // C. Neither: the CURRENT authoritative position only (the root's
        //    current index within its active chunk). If the head is deleted,
        //    ordinary bounded advancement below skips it atomically instead
        //    of silently rating a later card.
        if (targetPosition < 0) {
            const chunk = await q.chunkFor(startPosition);
            if (!chunk) throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing');
            for (let li = Math.max(0, startPosition - chunk.startPosition); li < chunk.items.length; li += 1) {
                const position = chunk.startPosition + li;
                if (position >= limit) break;
                const item = chunk.items[li];
                if (!item || typeof item.cardId !== 'string') break;
                if (position !== startPosition) {
                    throw new ReviewSessionBuildFailedError(sessionId, 'queue head is stale; start a new review session');
                }
                if (item.status !== 'pending') continue;
                targetPosition = position;
                targetCardId = item.cardId;
                break;
            }
            if (targetPosition < 0) {
                throw new ReviewSessionBuildFailedError(sessionId, 'queue head is exhausted; start a new review session');
            }
        }

        if (targetPosition < 0 || targetPosition >= limit || !targetCardId) {
            throw new ReviewExpectedCardMismatchError(sessionId, input.expectedCardId ?? String(input.expectedPosition), undefined);
        }

        // ── Duplicate requestId already committed (pre-write) ─────────────
        // New v2 roots use the requestClaims ledger; only legacy roots need
        // queue-item/event fallbacks after target resolution.
        if (requestId !== undefined) {
            const targetItemNow = await q.item(targetPosition);
            if (targetItemNow && targetItemNow.status === 'reviewed') {
                if (targetItemNow.requestId === requestId) {
                    const cur = await loadV2CurrentCard(live, ownerId);
                    return {
                        session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                        card: cur.card,
                        currentPosition: cur.position,
                        ...(requestId !== undefined ? { requestId } : {}),
                    };
                }
                throw new ReviewExpectedCardMismatchError(sessionId, targetItemNow.cardId, undefined);
            }
            if (live.requestClaimsVersion !== 1) {
                const evt = await t.get(sessionEventRef);
                if (evt && evt.exists) {
                    const cur = await loadV2CurrentCard(live, ownerId);
                    return {
                        session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                        card: cur.card,
                        currentPosition: cur.position,
                        requestId,
                    };
                }
            }
        }

        // ── Card read (ALL reads BEFORE any write) ─────────────────────────
        const cardSnap = await t.get(getDb().collection(COLLECTION).doc(targetCardId));
        const targetDeleted = !cardSnap.exists || cardSnap.data()?.ownerId !== ownerId;

        // Counter locals declared BEFORE the advance scan (the scan persists
        // deleted-card skips and decrements these in the same transaction).
        let ratingCounts = live.ratingCounts;
        let reviewedCount = live.reviewedCount;
        let deletedCount = live.deletedCount ?? 0;
        let remainingQueueCount = live.remainingQueueCount ?? 0;

        // Advance: the next current position is the first LIVE card at/after
        // the start position within the ACTIVE + NEXT chunks (bounded, never
        // a tail scan). Deleted cards encountered while advancing are
        // PERSISTED as skips IN THIS TRANSACTION — each is marked
        // status 'deleted' with its chunk pendingCount decremented and the
        // root deletedCount/remainingQueueCount decremented — so
        // pendingCount/remaining stay exact and the advance can never land on
        // or jump over an unmarked deleted item (which would otherwise leave
        // a stale pendingCount and falsely report the chunk complete).
        let nextLivePosition = limit;
        let nextCard: Flashcard | null = null;
        {
            const fromChunk = chunkOrdinalFor(startPosition);
            for (let cIdx = fromChunk; cIdx <= fromChunk + 1 && cIdx * SESSION_QUEUE_CHUNK_SIZE < limit; cIdx += 1) {
                const chunk = await q.chunkFor(cIdx * SESSION_QUEUE_CHUNK_SIZE);
                if (!chunk) {
                    throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing; start a new review session');
                }
                for (let li = Math.max(0, startPosition - chunk.startPosition); li < chunk.items.length; li += 1) {
                    const pos = chunk.startPosition + li;
                    if (pos >= limit) break;
                    const it = chunk.items[li];
                    if (!it || typeof it.cardId !== 'string') break;
                    if (it.status !== 'pending') continue;
                    if (pos === targetPosition) continue; // consumed by this claim
                    const nSnap = await t.get(getDb().collection(COLLECTION).doc(it.cardId));
                    if (!nSnap.exists || nSnap.data()?.ownerId !== ownerId) {
                        // Deleted since the snapshot: persist the skip NOW so
                        // the chunk metadata and root counters stay exact.
                        q.claim(pos, { status: 'deleted', deletedAt: updatedAt });
                        deletedCount += 1;
                        remainingQueueCount = Math.max(0, remainingQueueCount - 1);
                        continue;
                    }
                    nextLivePosition = pos;
                    nextCard = docToFlashcard(nSnap);
                    break;
                }
                if (nextLivePosition < limit) break;
            }
            // The bounded scan covered at most the ACTIVE + NEXT chunks. When
            // no live card was found there but the root remainingQueueCount is
            // STILL > 0, there are pending items in a LATER chunk (a run of
            // >2 consecutive all-deleted chunks): the session must NOT be
            // marked completed. The advance points currentPosition at the
            // chunk AFTER the scanned pair (the earliest chunk that may still
            // hold pending items — its pendingCount > 0 because remaining is
            // exact), and the NEXT submit continues the bounded advance from
            // there. Completion is only ever reached when remainingQueueCount
            // has been driven to 0 by the exact per-item skips/claims above.
            if (nextLivePosition >= limit && remainingQueueCount > 0) {
                const nextChunkStart = Math.min(limit, (fromChunk + 2) * SESSION_QUEUE_CHUNK_SIZE);
                if (nextChunkStart < limit) {
                    nextLivePosition = nextChunkStart;
                }
                // If nextChunkStart >= limit but remaining > 0, the queue
                // metadata is inconsistent (a pending chunk beyond limit is
                // impossible) — leave nextLivePosition at limit; the session
                // update below only completes when remainingQueueCount === 0.
            }
        }

        const testMode = live.testMode === true || isReviewTestMode();

        if (targetDeleted) {
            // Deleted since the snapshot: mark the item deleted (no rating,
            // no event) and decrement remaining.
            q.claim(targetPosition, {
                status: 'deleted',
                ...(requestId !== undefined ? { requestId } : {}),
                deletedAt: updatedAt,
            });
            deletedCount += 1;
            remainingQueueCount = Math.max(0, remainingQueueCount - 1);
        } else {
            const fsrsCard = cardSnap.exists ? docToFlashcard(cardSnap) : null;
            if (!testMode && fsrsCard) {
                const { scheduling, logEntry } = applyReview(fsrsCard, input.rating, reviewTime);
                const reviewLog = trimEmbeddedReviewLog([...fsrsCard.reviewLog, logEntry]);
                t.update(getDb().collection(COLLECTION).doc(targetCardId), {
                    ...scheduling,
                    updatedAt,
                    reviewLog,
                });
                const eventBody = buildEventBody({
                    ownerId,
                    rating: input.rating,
                    card: fsrsCard,
                    scheduling,
                    reviewedAt: Timestamp.fromMillis(reviewTime.getTime()),
                    recordedAt: updatedAt,
                    sessionId,
                    ...(requestId !== undefined ? { requestId } : {}),
                }) as unknown as Record<string, unknown>;
                if (requestId !== undefined) {
                    t.set(sessionEventRef, eventBody, { merge: false });
                } else {
                    t.set(sessionEventRef, eventBody);
                }
            }
            ratingCounts = bumpRatingCounts(ratingCounts, input.rating);
            reviewedCount += 1;
            remainingQueueCount = Math.max(0, remainingQueueCount - 1);
            q.claim(targetPosition, {
                status: 'reviewed',
                rating: input.rating,
                ...(requestId !== undefined ? { requestId } : {}),
                reviewedAt: updatedAt,
            });
        }

        const currentIndex = nextLivePosition;
        // NEVER mark completed unless the exact remaining counter is 0: a
        // session whose bounded advance found no live card but still has
        // pending items in a later chunk stays active (see above).
        const nextStatus: SessionStatus = (currentIndex >= limit && remainingQueueCount <= 0) ? 'completed' : 'active';
        const sessionUpdate: Partial<ReviewSession> = {
            currentIndex,
            currentChunkIndex: nextStatus === 'active' ? chunkOrdinalFor(currentIndex) : -1,
            ...(nextStatus === 'active' ? { currentPosition: currentIndex } : {}),
            reviewedCount,
            ratingCounts,
            remainingQueueCount,
            remainingCount: remainingQueueCount,
            deletedCount,
            lastReviewedAt: updatedAt,
            ...(requestId !== undefined ? { lastRequestId: requestId } : {}),
            ...(!targetDeleted ? { lastRatedCardId: targetCardId } : {}),
        };
        if (nextStatus !== 'active') {
            sessionUpdate.status = nextStatus;
            sessionUpdate.endedAt = updatedAt;
        }
        q.flush();
        if (requestId !== undefined) {
            t.create(sessionRequestClaimRef(sessionId, ownerId, requestId), {
                requestId,
                position: targetPosition,
                cardId: targetCardId,
                outcome: targetDeleted ? 'deleted' : 'reviewed',
                claimedAt: updatedAt,
            });
        }
        t.update(sessionRef, sessionUpdate);
        const updatedSession = { ...live, ...sessionUpdate, remainingCount: remainingQueueCount };
        return {
            session: updatedSession,
            card: nextStatus === 'active' ? nextCard : null,
            currentPosition: nextStatus === 'active' ? currentIndex : null,
            ...(requestId !== undefined ? { requestId } : {}),
        };
    }).then(async (result) => {
        if (!result)
            return null;
        // Bounded preload: EMPTY (additive) — the widget already holds its
        // monotonic buffer and merges additive updates; the authoritative
        // next card rides in `card`.
        const base = { ...result, preloaded: [] as PreloadedCard[], queueWindow: undefined as SessionQueueWindow | undefined };
        // POST-TRANSACTION BOUNDED HYDRATION: when the bounded advance skipped
        // a long run of deleted chunks, the transaction's next-card scan
        // (active+next chunks only) can leave the session ACTIVE with no card
        // in the result — a client would have no current card to submit. In
        // that case load the bounded window + current card from the advanced
        // position (chunk metadata + at most the active/next chunk; never the
        // full queue) and return that exact card/preload/position so the
        // widget can continue. Reads here are outside the transaction, which
        // is allowed (only the claim itself needed transaction atomicity).
        if (base.session.status === 'active' && base.card === null && base.session.storageVersion === SESSION_STORAGE_VERSION) {
            const pos = base.session.currentPosition ?? base.session.currentIndex ?? 0;
            const window = await loadV2QueueWindow(base.session, pos);
            if (window && window.cardIds.length > 0) {
                const first = window.cardIds[0];
                const firstSnap = await getDb().collection(COLLECTION).doc(first.cardId).get();
                if (firstSnap.exists && firstSnap.data()?.ownerId === ownerId) {
                    const c = docToFlashcard(firstSnap);
                    base.card = c;
                    base.currentPosition = window.currentPosition;
                    base.queueWindow = window;
                    // Preload: the window's remaining entries (each with its
                    // required stable position), fetched in one bounded batch.
                    const rest = window.cardIds.slice(1, 1 + SESSION_PRELOAD);
                    if (rest.length > 0) {
                        const snaps = await Promise.all(rest.map((w) => getDb().collection(COLLECTION).doc(w.cardId).get()));
                        for (let i = 0; i < snaps.length; i += 1) {
                            if (!snaps[i] || !snaps[i].exists || snaps[i].data()?.ownerId !== ownerId) continue;
                            const pc = docToFlashcard(snaps[i]);
                            base.preloaded.push({
                                id: pc.id,
                                front: pc.front,
                                back: pc.back,
                                ...(pc.deck !== undefined ? { deck: pc.deck } : {}),
                                tags: pc.tags,
                                position: rest[i].position,
                            });
                        }
                    }
                }
            }
        }
        return base;
    });
}

/** Loads the v2 current card (skip deleted/reviewed) for idempotent-no-op
 *  responses. Bounded: reads the ACTIVE chunk (from the root's
 *  currentChunkIndex), then at most the next chunk. */
async function loadV2CurrentCard(session: ReviewSession, ownerId: string): Promise<{ card: Flashcard | null; position: number | null }> {
    const limit = session.limit ?? 0;
    const startChunk = typeof session.currentChunkIndex === 'number' && session.currentChunkIndex >= 0
        ? session.currentChunkIndex
        : chunkOrdinalFor(session.currentIndex ?? 0);
    for (let cIdx = startChunk; cIdx <= startChunk + 1 && cIdx * SESSION_QUEUE_CHUNK_SIZE < limit; cIdx += 1) {
        const chunk = await readChunk(session.id, cIdx);
        if (!chunk) break;
        for (let li = 0; li < chunk.items.length; li += 1) {
            const pos = chunk.startPosition + li;
            if (pos >= limit) break;
            const it = chunk.items[li];
            if (!it || typeof it.cardId !== 'string') break;
            if (it.status !== 'pending') continue;
            const snap = await getDb().collection(COLLECTION).doc(it.cardId).get();
            if (!snap.exists || snap.data()?.ownerId !== ownerId) continue; // missing or foreign: skip without exposing content
            return { card: docToFlashcard(snap), position: pos };
        }
    }
    return { card: null, position: null };
}
async function submitLegacySessionReview(sessionId: string, input: SubmitSessionReviewInput, ownerId: string): Promise<SubmitSessionReviewResult | null> {
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const reviewTime = resolveReviewTime(input.reviewAt, new Date());
    const updatedAt = Timestamp.now();
    const requestId = input.requestId;
    const sessionEventRef = requestId !== undefined
        ? getDb().collection('reviewEvents').doc(sessionEventId(ownerId, sessionId, requestId))
        : getDb().collection('reviewEvents').doc();
    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const session = docToReviewSession(snap);
        assertSessionOwnership(session, ownerId);
        assertSessionVersionsSupported(session, snap);
        const cardIds = session.cardIds ?? [];
        const reviewedCardIds = session.reviewedCardIds ?? [];
        if (requestId !== undefined
            && (session.processedRequestIds?.includes(requestId) || session.lastRequestId === requestId)) {
            const cachedCard = await loadSessionCard(session, ownerId);
            return {
                session: { ...session, remainingCount: sessionRemainingCount(session) },
                card: cachedCard,
                requestId,
            };
        }
        if (!isSessionActive(session)) {
            throw new ReviewSessionNotActiveError(sessionId, session.status);
        }
        if (session.currentIndex >= cardIds.length) {
            const finalState: Partial<ReviewSession> = { status: 'completed', endedAt: updatedAt };
            t.update(sessionRef, finalState);
            return {
                session: { ...session, ...finalState, remainingCount: 0 },
                card: null,
                ...(requestId !== undefined ? { requestId } : {}),
            };
        }
        let targetIndex = -1;
        let targetCard: Flashcard | null = null;
        for (let i = session.currentIndex; i < cardIds.length; i += 1) {
            const id = cardIds[i];
            if (reviewedCardIds.includes(id))
                continue;
            const cardSnap = await t.get(getDb().collection(COLLECTION).doc(id));
            if (!cardSnap.exists || cardSnap.data()?.ownerId !== ownerId)
                continue;
            if (input.expectedCardId !== undefined && id !== input.expectedCardId) {
                continue;
            }
            targetIndex = i;
            targetCard = docToFlashcard(cardSnap);
            break;
        }
        if (targetIndex < 0) {
            if (input.expectedCardId !== undefined) {
                throw new ReviewExpectedCardMismatchError(sessionId, input.expectedCardId, undefined);
            }
            const finalState: Partial<ReviewSession> = { status: 'completed', endedAt: updatedAt };
            t.update(sessionRef, finalState);
            return {
                session: { ...session, ...finalState, remainingCount: 0 },
                card: null,
                ...(requestId !== undefined ? { requestId } : {}),
            };
        }
        let nextIndex = cardIds.length;
        let nextCard: Flashcard | null = null;
        for (let i = session.currentIndex; i < cardIds.length; i += 1) {
            const id = cardIds[i];
            if (i === targetIndex)
                continue;
            if (reviewedCardIds.includes(id))
                continue;
            const nextSnap = await t.get(getDb().collection(COLLECTION).doc(id));
            if (!nextSnap.exists || nextSnap.data()?.ownerId !== ownerId)
                continue;
            nextIndex = i;
            nextCard = docToFlashcard(nextSnap);
            break;
        }
        const card = targetCard as Flashcard;
        const testMode = session.testMode === true || isReviewTestMode();
        if (!testMode) {
            const { scheduling, logEntry } = applyReview(card, input.rating, reviewTime);
            const reviewLog = trimEmbeddedReviewLog([...card.reviewLog, logEntry]);
            t.update(getDb().collection(COLLECTION).doc(cardIds[targetIndex]), {
                ...scheduling,
                updatedAt,
                reviewLog,
            });
            const eventBody = buildEventBody({
                ownerId,
                rating: input.rating,
                card,
                scheduling,
                reviewedAt: Timestamp.fromMillis(reviewTime.getTime()),
                recordedAt: updatedAt,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(requestId !== undefined ? { requestId } : {}),
            }) as unknown as Record<string, unknown>;
            if (requestId !== undefined) {
                t.set(sessionEventRef, eventBody, { merge: false });
            } else {
                t.set(sessionEventRef, eventBody);
            }
        }
        const ratingCounts = bumpRatingCounts(session.ratingCounts, input.rating);
        const reviewedCount = session.reviewedCount + 1;
        const nextStatus: SessionStatus = nextIndex >= cardIds.length ? 'completed' : 'active';
        const newReviewedCardIds = [...reviewedCardIds, card.id];
        const sessionUpdate: Partial<ReviewSession> = {
            currentIndex: nextIndex,
            reviewedCount,
            ratingCounts,
            reviewedCardIds: newReviewedCardIds,
            ...(requestId !== undefined
                ? { lastRequestId: requestId, lastRatedCardId: card.id, processedRequestIds: [...(session.processedRequestIds ?? []), requestId] }
                : {}),
            lastReviewedAt: updatedAt,
        };
        if (nextStatus !== 'active') {
            sessionUpdate.status = nextStatus;
            sessionUpdate.endedAt = updatedAt;
        }
        t.update(sessionRef, sessionUpdate);
        const updatedSession = {
            ...session,
            ...sessionUpdate,
            remainingCount: sessionRemainingCount({ ...session, ...sessionUpdate }),
        };
        return {
            session: updatedSession,
            card: nextStatus === 'active' ? nextCard : null,
            ...(requestId !== undefined ? { requestId } : {}),
        };
    }).then(async (result) => {
        if (!result)
            return null;
        return { ...result, preloaded: [] };
    });
}

/**
 * Ends an active session without rating the remaining cards. Only its owner
 * may end it. Idempotent: ending an already terminated session is a no-op
 * that returns it unchanged. v2 and legacy sessions share the root-only write.
 */
export async function endReviewSession(sessionId: string, ownerId: string): Promise<ReviewSession | null> {
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const now = Timestamp.now();
    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const session = docToReviewSession(snap);
        assertSessionOwnership(session, ownerId);
        assertSessionVersionsSupported(session, snap);
        if (!isSessionActive(session)) {
            return { ...session, remainingCount: sessionRemainingCount(session) };
        }
        const update: Partial<ReviewSession> = {
            status: 'ended' as SessionStatus,
            endedAt: now,
        };
        t.update(sessionRef, update);
        if (isV2Session(session)) {
            return { ...session, ...update, remainingCount: session.remainingQueueCount ?? 0 };
        }
        return { ...session, ...update, remainingCount: sessionRemainingCount(session) };
    });
}
/* ------------------------------------------------------------------ */
/* Card images                                                         */
/* ------------------------------------------------------------------ */
/** Thrown when an image attachment fails validation (client-visible 400). */
export class ImageValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageValidationError';
    }
}
/** Image MIME types accepted for URL attachment (declared MIME or inferred
 * from the URL path extension). SVG is allowed for external URL references
 * (rendered by the client), but NOT for cloud uploads (see below). */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml',
]);
const EXTENSION_TO_MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
/**
 * Raster image MIME types accepted for cloud upload. SVG is deliberately
 * excluded: it is a vector format whose contents can embed scripts and
 * external references, which makes server-stored SVG a stored-XSS risk when
 * served back to clients.
 */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
]);
export function validateImageUrl(url: string, mimeType?: string): void {
    if (!url || typeof url !== 'string' || url.length > MAX_IMAGE_URL_LENGTH) {
        throw new ImageValidationError('Image URL must be a valid http(s) URL');
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new ImageValidationError('Image URL must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ImageValidationError('Image URL must be http(s)');
    }
    if (mimeType !== undefined) {
        if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
            throw new ImageValidationError(`Unsupported image MIME type: ${mimeType}`);
        }
        // A valid declared MIME type waives the URL-extension requirement.
        return;
    }
    const ext = parsed.pathname.toLowerCase().split('.').pop() || '';
    if (!EXTENSION_TO_MIME[ext]) {
        throw new ImageValidationError('Image URL must end in a supported image extension or declare a mimeType');
    }
}
function isOwnedStoragePath(cardId: string, path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  return parts.length === 3 && parts[0] === 'card-images' && parts[1] === cardId
    && /^[A-Za-z0-9._-]+$/.test(parts[2]) && parts[2] !== '.' && parts[2] !== '..';
}

function ownedStorageFile(cardId: string, image: CardImage, bucket = getStorage().bucket()) {
  return isOwnedStoragePath(cardId, image.storagePath) ? bucket.file(image.storagePath) : null;
}

function sameStorageObjectUrl(url: string, file: { publicUrl(): string }): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(file.publicUrl());
    if (parsed.username || parsed.password || parsed.hash || parsed.origin !== expected.origin) return false;
    return decodeURIComponent(parsed.pathname) === decodeURIComponent(expected.pathname);
  } catch {
    return false;
  }
}

/** Expiry is trusted only after the URL's configured SDK endpoint/object match. */
function signedUrlExpiresAt(url: string, file: { publicUrl(): string }): number | null {
  try {
    const parsed = new URL(url);
    if (!sameStorageObjectUrl(url, file)) return null;
    const v2Expiry = parsed.searchParams.getAll('Expires');
    const v2AccessId = parsed.searchParams.getAll('GoogleAccessId');
    const v2Signature = parsed.searchParams.getAll('Signature');
    if (v2Expiry.length === 1 && v2AccessId.length === 1 && v2AccessId[0] !== ''
        && v2Signature.length === 1 && v2Signature[0] !== '') {
      if (!/^[0-9]+$/.test(v2Expiry[0])) return null;
      const seconds = Number(v2Expiry[0]);
      const expiry = seconds * 1000;
      return Number.isSafeInteger(seconds) && Number.isSafeInteger(expiry) && seconds > 0 ? expiry : null;
    }
    const date = parsed.searchParams.getAll('X-Goog-Date');
    const duration = parsed.searchParams.getAll('X-Goog-Expires');
    const signature = parsed.searchParams.getAll('X-Goog-Signature');
    const algorithm = parsed.searchParams.getAll('X-Goog-Algorithm');
    if (date.length !== 1 || duration.length !== 1 || signature.length !== 1 || signature[0] === ''
        || algorithm.length !== 1 || algorithm[0] !== 'GOOG4-RSA-SHA256'
        || !/^[0-9]{8}T[0-9]{6}Z$/.test(date[0])) return null;
    const stamp = date[0];
    const start = Date.UTC(
      Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)),
      Number(stamp.slice(9, 11)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)),
    );
    if (!/^[0-9]+$/.test(duration[0])) return null;
    const seconds = Number(duration[0]);
    const expiry = start + seconds * 1000;
    const expiryDate = new Date(start);
    return Number.isSafeInteger(start) && Number.isSafeInteger(seconds) && Number.isSafeInteger(expiry) && seconds > 0
      && expiryDate.getUTCFullYear() === Number(stamp.slice(0, 4))
      && expiryDate.getUTCMonth() + 1 === Number(stamp.slice(4, 6))
      && expiryDate.getUTCDate() === Number(stamp.slice(6, 8))
      && expiryDate.getUTCHours() === Number(stamp.slice(9, 11))
      && expiryDate.getUTCMinutes() === Number(stamp.slice(11, 13))
      && expiryDate.getUTCSeconds() === Number(stamp.slice(13, 15))
      ? expiry
      : null;
  } catch {
    return null;
  }
}

/**
 * Renews expired Storage URLs for an already owner-scoped card. Signing is
 * outside Firestore callbacks; a small metadata transaction merges only URL
 * fields onto images still attached under the same owner/id/path.
 */
export async function refreshOwnedCardImageUrls<T extends Pick<Flashcard, 'id' | 'ownerId' | 'images'>>(card: T, ownerId: string): Promise<T> {
  if (card.ownerId !== ownerId) return { ...card, images: [] } as T;
  const images = card.images ?? [];
  if (!images.some((image) => isOwnedStoragePath(card.id, image.storagePath))) return card;
  const bucket = getStorage().bucket();
  const refreshes = new Map<string, { url: string }>();
  const minValidityMs = 60_000;
  const now = Date.now();
  await Promise.all(images.map(async (image) => {
    const storagePath = image.storagePath;
    if (!isOwnedStoragePath(card.id, storagePath)) return;
    const file = bucket.file(storagePath);
    const currentUrl = [image.downloadUrl, image.url].find((candidate) =>
      typeof candidate === 'string'
        && (signedUrlExpiresAt(candidate, file) ?? 0) > now + minValidityMs);
    const key = `${image.id}:${storagePath}`;
    if (currentUrl) {
      if (image.url !== currentUrl || image.downloadUrl !== currentUrl) {
        refreshes.set(key, { url: currentUrl });
      }
      return;
    }
    const [url] = await file.getSignedUrl({ action: 'read', expires: now + 60 * 60 * 1000 });
    refreshes.set(key, { url });
  }));
  if (refreshes.size === 0) return card;

  const cardRef = getDb().collection(COLLECTION).doc(card.id);
  const result = await getDb().runTransaction(async (t) => {
    const snap = await t.get(cardRef);
    if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
    const data = snap.data();
    const currentImages: CardImage[] = Array.isArray(data?.images) ? data.images : [];
    let changed = false;
    const updatedImages = currentImages.map((image) => {
      const refresh = refreshes.get(`${image.id}:${image.storagePath}`);
      if (!refresh) return image;
      changed = true;
      return { ...image, url: refresh.url, downloadUrl: refresh.url };
    });
    if (changed) t.update(cardRef, { images: updatedImages });
    return updatedImages;
  });
  return { ...card, images: result ?? [] } as T;
}

export async function attachImage(cardId: string, input: AttachImageInput, ownerId: string): Promise<AttachImageResponse | null> {
    validateImageUrl(input.url, input.mimeType);
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const updatedAt = Timestamp.now();
    const image: CardImage = {
        id: `img_${randomUUID()}`,
        url: input.url,
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        addedAt: Timestamp.now(),
    };
    const result = await getDb().runTransaction(async (t) => {
        const snap = await t.get(cardRef);
        if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
        const current = docToFlashcard(snap);
        if (current.images.length >= MAX_CARD_IMAGES) {
            throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
        }
        const images = [...current.images, image];
        t.update(cardRef, { images, updatedAt });
        return { card: { ...current, images, updatedAt }, image };
    });
    if (!result) return null;
    return { ...result, card: await refreshOwnedCardImageUrls(result.card, ownerId) };
}

export async function listImages(cardId: string, ownerId: string): Promise<ListImagesResponse | null> {
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const card = await cardRef.get();
    if (!card.exists)
        return null;
    if (card.data()?.ownerId !== ownerId)
        return null;
    const refreshed = await refreshOwnedCardImageUrls(docToFlashcard(card), ownerId);
    return { cardId, images: refreshed.images };
}

function removeUrlMatchesImage(url: string, cardId: string, image: CardImage): boolean {
    if (image.url === url) return true;
    if (!isOwnedStoragePath(cardId, image.storagePath)) return false;
    const file = ownedStorageFile(cardId, image);
    return file !== null && signedUrlExpiresAt(url, file) !== null;
}

export async function removeImage(cardId: string, url: string, ownerId: string): Promise<RemoveImageResponse | null> {
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const updatedAt = Timestamp.now();
    const result = await getDb().runTransaction(async (t) => {
        const snap = await t.get(cardRef);
        if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
        const current = docToFlashcard(snap);
        const removedIndexes = new Set<number>();
        current.images.forEach((image, index) => {
            if (removeUrlMatchesImage(url, cardId, image)) removedIndexes.add(index);
        });
        const removedImages = current.images.filter((_, index) => removedIndexes.has(index));
        if (removedImages.length > 0) {
            t.update(cardRef, {
                images: current.images.filter((_, index) => !removedIndexes.has(index)),
                updatedAt,
            });
        }
        return { removedImages };
    });
    if (!result) return null;
    await Promise.all(result.removedImages.map(async (image) => {
        if (!isOwnedStoragePath(cardId, image.storagePath)) return;
        const file = ownedStorageFile(cardId, image);
        if (file) await file.delete().catch(() => undefined);
    }));
    return { cardId, removed: result.removedImages.length > 0 };
}

export async function uploadImage(cardId: string, input: UploadImageInput, ownerId: string): Promise<UploadImageResponse | null> {
    if (!input.fileName || input.fileName.length > MAX_IMAGE_FILE_NAME_LENGTH) {
        throw new ImageValidationError('Invalid file name');
    }
    if (input.data.length > MAX_IMAGE_DATA_LENGTH) {
        throw new ImageValidationError(`Image data too large (max ${MAX_IMAGE_UPLOAD_BYTES} bytes)`);
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(input.contentType)) {
        throw new ImageValidationError(`Content type not allowed for upload: ${input.contentType}`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 === 1) {
        throw new ImageValidationError('Invalid base64 image data');
    }
    const padding = input.data.endsWith('==') ? 2 : input.data.endsWith('=') ? 1 : 0;
    const decodedSize = Math.floor((input.data.length - padding) * 3 / 4);
    if (decodedSize > MAX_IMAGE_UPLOAD_BYTES) {
        throw new ImageValidationError(`Image too large (max ${MAX_IMAGE_UPLOAD_BYTES} bytes)`);
    }
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const existingSnap = await cardRef.get();
    if (!existingSnap.exists || existingSnap.data()?.ownerId !== ownerId) return null;
    const existingCard = docToFlashcard(existingSnap);
    if (existingCard.images.length >= MAX_CARD_IMAGES) {
        throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
    }
    let data: Buffer;
    try {
        data = Buffer.from(input.data, 'base64');
    }
    catch {
        throw new ImageValidationError('Invalid base64 image data');
    }
    const MIME_TO_EXT: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
    };
    const ext = MIME_TO_EXT[input.contentType] ?? 'bin';
    const rawName = input.fileName.split(/[\\/]/).pop() || 'image';
    const dot = rawName.lastIndexOf('.');
    const base = (dot > 0 ? rawName.slice(0, dot) : rawName)
        .replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'image';
    const imageId = randomUUID();
    const storagePath = `card-images/${cardId}/${imageId}-${base}.${ext}`;
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    try {
        await file.save(data, { contentType: input.contentType });
    }
    catch {
        await file.delete().catch(() => undefined);
        throw new ImageValidationError('Failed to store image');
    }
    let downloadUrl: string;
    try {
        [downloadUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
    }
    catch (err) {
        await file.delete().catch(() => undefined);
        throw err;
    }
    const image: CardImage = {
        id: imageId,
        url: downloadUrl,
        storagePath,
        downloadUrl,
        mimeType: input.contentType,
        sizeBytes: data.length,
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
        addedAt: Timestamp.now(),
    };
    const updatedAt = Timestamp.now();
    let result: UploadImageResponse | null;
    try {
        result = await getDb().runTransaction(async (t) => {
            const snap = await t.get(cardRef);
            if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
            const current = docToFlashcard(snap);
            if (current.images.length >= MAX_CARD_IMAGES) {
                throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
            }
            const images = [...current.images, image];
            t.update(cardRef, { images, updatedAt });
            return { card: { ...current, images, updatedAt }, image };
        });
    }
    catch (err) {
        await file.delete().catch(() => undefined);
        throw err;
    }
    if (!result) {
        await file.delete().catch(() => undefined);
        return null;
    }
    return { ...result, card: await refreshOwnedCardImageUrls(result.card, ownerId) };
}

async function cleanupCardImages(cardId: string): Promise<void> {
    try {
        const [files] = await getStorage().bucket().getFiles({ prefix: `card-images/${cardId}/` });
        await Promise.all(files.map((f) => f.delete().catch(() => undefined)));
    }
    catch {
        // best-effort
    }
}
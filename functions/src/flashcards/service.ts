import { getFirestore, Firestore, Timestamp, FieldValue, QueryDocumentSnapshot, DocumentSnapshot, DocumentData, DocumentReference, FieldPath } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  Flashcard, CreateFlashcardInput, UpdateFlashcardInput, ListFlashcardsQuery, ListFlashcardsResponse,
  DueFlashcardsQuery, DueFlashcardsResponse, ReviewFlashcardInput, ReviewFlashcardResponse,
  BulkCreateFlashcardsInput, BulkCreateFlashcardsResponse, BulkUpdateFlashcardsInput,
  BulkUpdateFlashcardsResponse, BulkDeleteFlashcardsInput, BulkDeleteFlashcardsResponse,
  Deck, CreateDeckInput, UpdateDeckInput, ListDecksQuery, ListDecksResponse, DeleteDeckResult,
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
  MAX_CARD_IMAGES, MAX_IMAGE_URL_LENGTH, MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_DATA_LENGTH, MAX_IMAGE_FILE_NAME_LENGTH,
  CARD_STATES, BULK_LIMIT,
  SchedulingActionResponse,
} from './types';
import { applyReview, initialScheduling, legacyScheduling, resolveReviewTime } from './scheduler';
import { buildEventBody, trimEmbeddedReviewLog, sessionEventId, legacySessionEventId } from './reviewHistory';
import {
  cardAfterCursor, cardMatchesFilters, makeSearchPageToken,
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
/** Child collection under each v2 session document owning the queue chunks. */
const SESSION_QUEUE_CHUNKS_COLLECTION = 'queueChunks';
const PAGE_SIZE_MAX = 100;
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
    ...(data.lastReview ? { lastReview: data.lastReview as Timestamp } : {}),
    reviewLog: Array.isArray(data.reviewLog) ? data.reviewLog : [],
    images: Array.isArray(data.images) ? data.images : [],
  };
}


function docToDeck(doc: DocumentSnapshot<DocumentData>): Deck {
  const data = doc.data();
  if (!data) {
    throw new Error('Document data is undefined');
  }
  return {
    id: doc.id,
    ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
    name: data.name as string,
    ...(data.description !== undefined ? { description: data.description as string } : {}),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
  };
}

/**
 * Builds the card object returned to API clients after an in-memory merge
 * with an update payload. Firestore `FieldValue.delete()` sentinels must NOT
 * leak into responses: a detach (`deckId: null`) removes the fields entirely.
 */
function mergeCardForResponse(snap: DocumentSnapshot<DocumentData>, updateData: Partial<Flashcard>): Flashcard {
  const merged = { ...docToFlashcard(snap), ...updateData };
  if (merged.deckId && typeof merged.deckId === 'object' && (merged.deckId as { __fieldDelete?: boolean }).__fieldDelete) {
    delete merged.deckId;
  }
  if (merged.deck && typeof merged.deck === 'object' && (merged.deck as { __fieldDelete?: boolean }).__fieldDelete) {
    delete merged.deck;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Deck reference resolution                                           */
/* ------------------------------------------------------------------ */

/**
 * Thrown when creating/renaming a deck would collide with an existing deck
 * name. Deck names are unique because legacy card `deck` strings resolve to
 * a single deck entity by name (find-or-create) — ambiguity would make that
 * resolution unsafe.
 */
export class DeckNameConflictError extends Error {
  constructor(name: string) {
    super(`A deck named "${name}" already exists`);
    this.name = 'DeckNameConflictError';
  }
}

/**
 * Thrown when a card references a `deckId` that does not exist (create,
 * update, or bulk operations). A client-visible 404, distinct from internal
 * errors.
 */
export class DeckNotFoundError extends Error {
  constructor(deckId: string) {
    super(`Deck not found: ${deckId}`);
    this.name = 'DeckNotFoundError';
  }
}

/**
 * Finds a deck by exact name, or creates it when missing (case-sensitive
 * match). Used by the legacy `deck` name path on create/update so cards can
 * keep referencing decks by name while the deck entity itself gets a stable
 * id. Returns the deck's id.
 */
async function findOrCreateDeckByName(name: string, ownerId?: string): Promise<string> {
  const existingId = await findDeckIdByName(name, ownerId);
  if (existingId !== null) return existingId;
  const now = Timestamp.now();
  const docRef = getDb().collection(DECKS_COLLECTION).doc();
  const deck: Record<string, unknown> = { name, createdAt: now, updatedAt: now };
  if (ownerId !== undefined) deck.ownerId = ownerId;
  await docRef.set(deck);
  return docRef.id;
}

/** Returns the id of an existing deck with the given name, or null. When
 *  `ownerId` is given the name lookup is scoped to that owner's decks (deck
 *  names are unique per owner). */
async function findDeckIdByName(name: string, ownerId?: string): Promise<string | null> {
  let q = getDb().collection(DECKS_COLLECTION).where('name', '==', name);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  const existing = await q.limit(1).get();
  if (existing.empty) return null;
  return existing.docs[0].id;
}

/**
 * Resolves the deck a card input refers to, honoring the new `deckId`
 * reference first and falling back to the legacy `deck` name
 * (find-or-create). Returns the stable deck id and its name, or null when the
 * input carries neither (or explicitly nulls the deck).
 *
 * Throws when a referenced `deckId` does not exist.
 */
async function resolveDeckRef(
  input: { deckId?: string | null; deck?: string | null },
  ownerId?: string,
): Promise<{ deckId?: string; deck?: string } | null> {
  if (input.deckId !== undefined && input.deckId !== null) {
    const deckDoc = await getDb().collection(DECKS_COLLECTION).doc(input.deckId).get();
    if (!deckDoc.exists) {
      throw new DeckNotFoundError(input.deckId);
    }
    // Owner-scoped callers may only reference their own decks (a deck id of
    // an unowned/other-owner deck must not resolve — it would attach the
    // card to a deck the caller does not own).
    if (ownerId !== undefined && deckDoc.data()?.ownerId !== ownerId) {
      throw new DeckNotFoundError(input.deckId);
    }
    const data = deckDoc.data();
    return { deckId: input.deckId, deck: data?.name as string | undefined };
  }
  if (input.deck !== undefined && input.deck !== null) {
    const deckId = await findOrCreateDeckByName(input.deck, ownerId);
    return { deckId, deck: input.deck };
  }
  return null;
}

/** Stores a resolved deckId+deck pair on a card payload (no-op when null). */
function applyDeckRef(target: Record<string, unknown>, ref: { deckId?: string; deck?: string } | null): void {
  if (!ref) return;
  if (ref.deckId !== undefined) target.deckId = ref.deckId;
  if (ref.deck !== undefined) target.deck = ref.deck;
}

/** Throws when any referenced deck id does not exist (used by bulk create/update).
 *  Owner-scoped callers may only reference their own decks. */
async function validateDeckIds(deckIds: Array<string | null | undefined>, ownerId?: string): Promise<void> {
  const unique = [...new Set(deckIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  for (const id of unique) {
    const doc = await getDb().collection(DECKS_COLLECTION).doc(id).get();
    if (!doc.exists || (ownerId !== undefined && doc.data()?.ownerId !== ownerId)) {
      throw new DeckNotFoundError(id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Decks                                                               */
/* ------------------------------------------------------------------ */

export async function createDeck(input: CreateDeckInput, ownerId?: string): Promise<Deck> {
  // Deck names are unique PER OWNER: legacy card `deck` strings resolve to a
  // single deck by name, so a duplicate would make that resolution ambiguous.
  const existingId = await findDeckIdByName(input.name, ownerId);
  if (existingId !== null) {
    throw new DeckNameConflictError(input.name);
  }

  const now = Timestamp.now();
  const docRef = getDb().collection(DECKS_COLLECTION).doc();
  const deck: Omit<Deck, 'id'> = {
    ...(ownerId !== undefined ? { ownerId } : {}),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await docRef.set(deck);
  return { id: docRef.id, ...deck };
}

export async function getDeck(id: string, ownerId?: string): Promise<Deck | null> {
  const doc = await getDb().collection(DECKS_COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  // Owner-scoped callers may only read their OWN decks (ownerless legacy or
  // another tenant's deck reads as not found — no existence leak).
  if (ownerId !== undefined && doc.data()?.ownerId !== ownerId) return null;
  return docToDeck(doc as QueryDocumentSnapshot<DocumentData>);
}

export async function updateDeck(id: string, input: UpdateDeckInput, ownerId?: string): Promise<Deck | null> {
  const docRef = getDb().collection(DECKS_COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return null;
  // Owner-scoped callers may only update their OWN decks.
  if (ownerId !== undefined && doc.data()?.ownerId !== ownerId) return null;

  // Renaming must not collide with another of the owner's deck names.
  if (input.name !== undefined) {
    const existingId = await findDeckIdByName(input.name, ownerId);
    if (existingId !== null && existingId !== id) {
      throw new DeckNameConflictError(input.name);
    }
  }

  const updateData: Partial<Deck> = { updatedAt: Timestamp.now() };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;

  const oldName = doc.data()?.name as string | undefined;
  const renaming = input.name !== undefined && oldName !== undefined && input.name !== oldName;

  // A rename must keep the denormalized `deck` name on cards coherent, so
  // name-based listing/filtering (listFlashcards?deck=<name>) and card
  // responses stay correct. Cards are processed in chunked WriteBatches (like
  // deleteDeck) so decks of any size can be renamed. The deck document itself
  // is renamed LAST, after every card's denormalized name is rewritten — so a
  // card never transiently carries a name that no deck has (and never keeps a
  // stale old name after the deck rename lands). If a card chunk fails, the
  // error propagates with explicit partial progress (earlier chunks
  // committed, deck NOT yet renamed); retrying completes the rewrite.
  if (renaming) {
    const byIdQuery = getDb().collection(COLLECTION).where('deckId', '==', id);
    const byId = await (ownerId !== undefined ? byIdQuery.where('ownerId', '==', ownerId) : byIdQuery).get();
    await updateCardsChunked(byId.docs, () => ({ deck: input.name as string }));
    if (oldName !== undefined) {
      const byNameQuery = getDb().collection(COLLECTION).where('deck', '==', oldName);
      const byName = await (ownerId !== undefined ? byNameQuery.where('ownerId', '==', ownerId) : byNameQuery).get();
      await updateCardsChunked(
        byName.docs.filter((cardDoc) => cardDoc.data().deckId !== id),
        () => ({ deck: input.name as string }),
      );
    }
    await docRef.update(updateData);
    const renamed = await docRef.get();
    return docToDeck(renamed as QueryDocumentSnapshot<DocumentData>);
  }

  await docRef.update(updateData);
  const updated = await docRef.get();
  return docToDeck(updated as QueryDocumentSnapshot<DocumentData>);
}

/**
 * Firestore limits one WriteBatch to 500 writes, so operations that must touch
 * arbitrarily many cards (deck detach on delete, deck rename) process cards in
 * chunked batches. Returns the total number of cards updated.
 */
const BATCH_WRITE_LIMIT = 500;

/**
 * Applies `patch` to every card in `refs` using chunked WriteBatches (≤500
 * writes each). If any chunk fails, the error propagates after earlier chunks
 * were already committed — callers treat this as explicit partial progress and
 * re-run for the remaining cards. Deduplicates refs by document path.
 */
async function updateCardsChunked(
  refs: Array<{ ref: DocumentReference<DocumentData>; data?: () => DocumentData }>,
  patch: (cardData: DocumentData | undefined) => Record<string, unknown>,
): Promise<number> {
  const seen = new Set<string>();
  const unique = refs.filter((c) => {
    const path = c.ref.path;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });

  let updated = 0;
  for (let i = 0; i < unique.length; i += BATCH_WRITE_LIMIT) {
    const chunk = unique.slice(i, i + BATCH_WRITE_LIMIT);
    const batch = getDb().batch();
    const now = Timestamp.now();
    for (const c of chunk) {
      batch.update(c.ref, { ...patch(c.data?.()), updatedAt: now });
    }
    await batch.commit();
    updated += chunk.length;
  }
  return updated;
}

/**
 * Deletes a deck. Cards are NOT deleted — the deck is independent of its
 * cards. Deleting a deck detaches every referencing card (removes its
 * `deckId` and matching `deck` name fields) so no card keeps pointing at the
 * deleted deck, and the cards themselves (including all FSRS scheduling
 * state) are preserved.
 *
 * Firestore transactions/batches are limited to 500 writes, so a deck with an
 * arbitrary number of cards is processed in **chunked WriteBatches** (≤500
 * detach writes each), not a single transaction. Semantics:
 *   1. Detach cards referencing by `deckId` (chunked).
 *   2. Detach legacy name-only cards (no deckId) carrying the deck name
 *      (chunked, deduped against step 1).
 *   3. Only after all detach batches succeed is the deck document deleted.
 *   4. A final sweep re-detaches any card that raced into the deck between
 *      step 2 and the deck delete (guarded so it never deletes a deck that a
 *      concurrent createDeck reused — the deck is deleted inside this final
 *      transaction after re-verifying the document still has the same name
 *      it started with).
 * If any detach chunk fails, the error propagates with explicit partial
 * progress (earlier chunks committed): the deck is NOT deleted, and retrying
 * the operation completes the remaining detaches. Returns the number of cards
 * detached.
 */
export async function deleteDeck(id: string, ownerId?: string): Promise<DeleteDeckResult | null> {
  const deckRef = getDb().collection(DECKS_COLLECTION).doc(id);

  const preDeck = await deckRef.get();
  if (!preDeck.exists) return null;
  // Owner-scoped callers may only delete their OWN decks.
  if (ownerId !== undefined && preDeck.data()?.ownerId !== ownerId) return null;
  const deckName = preDeck.data()?.name as string | undefined;

  let detachedCards = 0;

  // 1. Detach by stable reference (chunked), scoped to the owner's cards.
  const byIdQuery = getDb().collection(COLLECTION).where('deckId', '==', id);
  const byId = await (ownerId !== undefined ? byIdQuery.where('ownerId', '==', ownerId) : byIdQuery).get();
  detachedCards += await updateCardsChunked(byId.docs, (cardData) => {
    const patch: Record<string, unknown> = { deckId: FieldValue.delete() };
    if (deckName !== undefined && cardData?.deck === deckName) {
      patch.deck = FieldValue.delete();
    }
    return patch;
  });

  // 2. Detach legacy name-only cards (no deckId) carrying the deck name.
  if (deckName !== undefined) {
    const byNameQuery = getDb().collection(COLLECTION).where('deck', '==', deckName);
    const byName = await (ownerId !== undefined ? byNameQuery.where('ownerId', '==', ownerId) : byNameQuery).get();
    detachedCards += await updateCardsChunked(
      byName.docs.filter((doc) => doc.data().deckId !== id),
      () => ({ deck: FieldValue.delete() }),
    );
  }

  // 3. Delete the deck only after all detaches committed.
  // 4. Final race sweep: inside one small transaction, re-verify the deck doc
  //    still exists with the SAME name (guards against a reused id), detach
  //    any card that slipped in since step 2 (bounded — the sweep must fit
  //    the 500-op transaction budget), then delete the deck.
  await getDb().runTransaction(async (t) => {
    const deckInTxn = await t.get(deckRef);
    if (!deckInTxn.exists) return;
    const txnName = deckInTxn.data()?.name as string | undefined;
    if (txnName !== deckName) {
      // A new deck reused this id — do not delete it; the cards it owns are
      // its own. (Document ids are random, so this is a defensive guard.)
      return;
    }
    const sweepByIdQuery = getDb().collection(COLLECTION).where('deckId', '==', id);
    const sweepById = await t.get(ownerId !== undefined ? sweepByIdQuery.where('ownerId', '==', ownerId) : sweepByIdQuery);
    for (const doc of sweepById.docs) {
      const patch: Record<string, unknown> = { deckId: FieldValue.delete(), updatedAt: Timestamp.now() };
      if (txnName !== undefined && doc.data().deck === txnName) {
        patch.deck = FieldValue.delete();
      }
      t.update(doc.ref, patch);
      detachedCards += 1;
    }
    if (txnName !== undefined) {
      const sweepByNameQuery = getDb().collection(COLLECTION).where('deck', '==', txnName);
      const sweepByName = await t.get(ownerId !== undefined ? sweepByNameQuery.where('ownerId', '==', ownerId) : sweepByNameQuery);
      for (const doc of sweepByName.docs) {
        if (doc.data().deckId === id) continue;
        t.update(doc.ref, { deck: FieldValue.delete(), updatedAt: Timestamp.now() });
        detachedCards += 1;
      }
    }
    t.delete(deckRef);
  });

  return { deleted: true, detachedCards };
}

/**
 * Explicit migration: backfills `deckId` onto cards that still only carry the
 * legacy `deck` name string (cards created before deck entities existed).
 * For each distinct legacy name, a deck entity is found-or-created and the
 * card's `deckId` is set to it (the `deck` name field is kept for readable
 * filtering).
 *
 * Cards that already have a `deckId` are skipped, and pages are iterated with
 * an id cursor until unmigrated cards are found or the collection is
 * exhausted — so a first page of already-migrated cards cannot mask later
 * unmigrated ones. Commits ≤500 writes per batch. Returns how many cards were
 * backfilled in this call; repeated calls complete the rest (maintenance
 * route, paged by `pageSize`).
 */
export async function migrateLegacyDeckNames(pageSize = BULK_LIMIT): Promise<{ migrated: number }> {
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  let migrated = 0;
  let hasMore = true;

  while (hasMore) {
    // Firestore cannot express "deckId missing" directly, so we page cards
    // that carry a non-empty legacy `deck` name and skip the ones that
    // already have a `deckId`.
    let q = getDb().collection(COLLECTION)
      .where('deck', '!=', '')
      .orderBy('__name__')
      .limit(pageSize);
    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }
    const page = await q.get();
    if (page.empty) break;

    const batch = getDb().batch();
    const now = Timestamp.now();
    let batchWrites = 0;

    for (const doc of page.docs) {
      if (doc.data().deckId !== undefined) continue; // already migrated
      const name = doc.data().deck as string;
      const deckId = await findOrCreateDeckByName(name);
      batch.update(doc.ref, { deckId, updatedAt: now });
      migrated += 1;
      batchWrites += 1;
      if (batchWrites >= 500) {
        await batch.commit();
        batchWrites = 0;
      }
    }
    if (batchWrites > 0) {
      await batch.commit();
    }

    lastDoc = page.docs[page.docs.length - 1];
    // Stop once a full page contained no unmigrated cards AND we found some
    // this call? No — keep scanning: a page may be a mix, and pages after it
    // may still hold unmigrated cards. Only stop when the collection is
    // exhausted (page smaller than pageSize).
    if (page.docs.length < pageSize) {
      hasMore = false;
    }
  }

  return { migrated };
}

export async function listDecks(query: ListDecksQuery, ownerId?: string): Promise<ListDecksResponse> {
  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);

  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(DECKS_COLLECTION);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  q = q.orderBy('createdAt', 'desc');
  if (query.pageToken) {
    const tokenDoc = await getDb().collection(DECKS_COLLECTION).doc(query.pageToken).get();
    if (tokenDoc.exists) {
      q = q.startAfter(tokenDoc);
    }
  }

  const snapshot = await q.limit(pageSize + 1).get();
  const docs = snapshot.docs;

  const hasMore = docs.length > pageSize;
  const decks = docs.slice(0, pageSize).map(docToDeck);

  let nextPageToken: string | null = null;
  if (hasMore) {
    nextPageToken = docs[pageSize - 1].id;
  }

  return { decks, nextPageToken };
}

/* ------------------------------------------------------------------ */
/* Tag management (list / rename / delete / merge)                     */
/* ------------------------------------------------------------------ */

/**
 * Collects the cards that carry a tag under ANY of the given names (exact,
 * case-sensitive — the same matching semantics as every existing tag
 * filter), deduplicated by document path. Each name is matched with a
 * `tags array-contains <name>` equality (single-value form — no composite
 * index beyond what listFlashcards' `array-contains-any` already relies
 * on). Cards already carrying BOTH names (e.g. a rename/merge whose target
 * is already present) appear exactly once, so a caller that rewrites a card
 * once never counts it twice.
 */
async function cardsWithAnyTag(names: string[], ownerId?: string): Promise<Array<QueryDocumentSnapshot<DocumentData>>> {
  const seen = new Set<string>();
  const docs: Array<QueryDocumentSnapshot<DocumentData>> = [];
  for (const name of names) {
    let q = getDb().collection(COLLECTION).where('tags', 'array-contains', name);
    if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
    const snap = await q.get();
    for (const doc of snap.docs) {
      if (seen.has(doc.ref.path)) continue;
      seen.add(doc.ref.path);
      docs.push(doc);
    }
  }
  return docs;
}

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
export async function listTags(query: ListTagsQuery, ownerId?: string): Promise<ListTagsResponse> {
  const counts = new Map<string, number>();
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  for (;;) {
    let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
    if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
    q = q.orderBy('__name__').limit(500);
    if (lastDoc) q = q.startAfter(lastDoc);
    const page = await q.get();
    if (page.docs.length === 0) break;
    lastDoc = page.docs[page.docs.length - 1];
    for (const doc of page.docs) {
      const tags = Array.isArray(doc.data().tags) ? doc.data().tags as string[] : [];
      for (const tag of tags) {
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
 * Shared executor of the tag-management mutations (renameTag / deleteTag /
 * mergeTags). Each operation is a derived-tags rewrite: affected cards are
 * located by `array-contains` queries, their new `tags` array is computed in
 * memory, and the writes commit in chunked WriteBatches (≤500 writes each —
 * the same updateCardsChunked convention as deck detach/rename), refreshing
 * `updatedAt` on every rewritten card.
 *
 * Semantics shared by every mutation:
 *  - A tag name that no card carries is a successful NO-OP
 *    (`affectedCards: 0`) — matching a missing tag is never an error.
 *  - Rewrites dedupe each card's tags preserving order (stored arrays may
 *    contain duplicates), so a card that already carries the target keeps a
 *    single clean copy of it and is rewritten only when its array actually
 *    changes.
 *  - On a chunk failure the error propagates with explicit partial progress
 *    (earlier chunks already committed); retrying completes the rewrite.
 */
async function runTagAction(
  names: string[],
  rewrite: (tags: string[]) => string[],
  ownerId?: string,
): Promise<TagActionResult> {
  const docs = await cardsWithAnyTag(names, ownerId);
  const refs = docs.map((doc) => ({ ref: doc.ref, data: () => doc.data() }));
  // Every matched card necessarily changes: it carries one of `names`, and
  // each rewrite removes/replaces that name (`from !== to` is
  // validator-enforced for rename/merge). updateCardsChunked stamps
  // `updatedAt` and counts exactly the unique refs it writes.
  const changed = await updateCardsChunked(refs, (cardData) => {
    const tags = Array.isArray(cardData?.tags) ? cardData.tags as string[] : [];
    return { tags: dedupeTags(rewrite(tags)) };
  });
  return { affectedCards: changed };
}

/**
 * Renames a tag: every card carrying `from` (exact, case-sensitive) has it
 * replaced by `to`. When a card already carries `to`, the result is a single
 * `to` (the arrays are deduped — the same effective semantics as merge for
 * that card). `from` and `to` must differ (validator-enforced). A `from`
 * that no card carries is a successful no-op (`affectedCards: 0`); `to`
 * already existing on all of them is likewise a no-op (nothing changed).
 */
export async function renameTag(input: RenameTagInput, ownerId?: string): Promise<TagActionResult> {
  return runTagAction([input.from], (tags) => tags.map((t) => (t === input.from ? input.to : t)), ownerId);
}

/**
 * Deletes a tag: removes it from every card carrying it (the cards
 * themselves — content, deck, scheduling — are untouched, mirroring the
 * deleteDeck philosophy). A name that no card carries is a successful
 * no-op (`affectedCards: 0`). Cards whose array becomes empty keep an empty
 * `tags` array (the same representation create writes for untagged cards).
 */
export async function deleteTag(input: DeleteTagInput, ownerId?: string): Promise<TagActionResult> {
  return runTagAction([input.name], (tags) => tags.filter((t) => t !== input.name), ownerId);
}

/**
 * Merges tags with UNION semantics: `from` is removed from every card
 * carrying it and `to` is ensured on every such card (cards already
 * carrying `to` keep a single clean copy). The result equals a rename whose
 * `to` may already exist — `from` disappears and every affected card ends
 * up carrying `to`. `from` and `to` must differ (validator-enforced). A
 * `from` that no card carries is a successful no-op (`affectedCards: 0`).
 */
export async function mergeTags(input: MergeTagsInput, ownerId?: string): Promise<TagActionResult> {
  return runTagAction([input.from], (tags) => {
    const hasFrom = tags.includes(input.from);
    if (!hasFrom) return tags;
    return [...tags.filter((t) => t !== input.from), input.to];
  }, ownerId);
}

/* ------------------------------------------------------------------ */
/* Flashcards                                                          */
/* ------------------------------------------------------------------ */

export async function createFlashcard(input: CreateFlashcardInput, ownerId?: string): Promise<Flashcard> {
  const now = Timestamp.now();
  const scheduling = initialScheduling(now);
  const deckRef = await resolveDeckRef(input, ownerId);

  const docRef = getDb().collection(COLLECTION).doc();
  const flashcard: Omit<Flashcard, 'id'> = {
    ...(ownerId !== undefined ? { ownerId } : {}),
    front: input.front,
    back: input.back,
    tags: input.tags || [],
    ...(input.topic !== undefined && input.topic !== null ? { topic: input.topic } : {}),
    // New cards are active by default; `suspended: false` is written
    // explicitly so queries can rely on the field after creation.
    ...(input.suspended !== undefined ? { suspended: input.suspended } : { suspended: false }),
    createdAt: now,
    updatedAt: now,
    ...scheduling,
    reviewLog: [],
    images: [],
  };
  applyDeckRef(flashcard, deckRef);

  await docRef.set(flashcard);

  return { id: docRef.id, ...flashcard };
}

export async function getFlashcard(id: string, ownerId?: string): Promise<Flashcard | null> {
  const doc = await getDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  if (ownerId !== undefined && doc.data()?.ownerId !== ownerId) return null;
  return docToFlashcard(doc as QueryDocumentSnapshot<DocumentData>);
}

export async function updateFlashcard(id: string, input: UpdateFlashcardInput, ownerId?: string): Promise<Flashcard | null> {
  const docRef = getDb().collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return null;
  if (ownerId !== undefined && doc.data()?.ownerId !== ownerId) return null;

  const updateData: Partial<Flashcard> = {
    updatedAt: Timestamp.now(),
  };

  if (input.front !== undefined) updateData.front = input.front;
  if (input.back !== undefined) updateData.back = input.back;
  if (input.topic === null) {
    updateData.topic = FieldValue.delete() as unknown as string;
  } else if (input.topic !== undefined) {
    updateData.topic = input.topic;
  }
  if (input.suspended !== undefined) updateData.suspended = input.suspended;
  if (input.tags !== undefined) updateData.tags = input.tags;

  // Deck reference handling: null detaches (removes both fields), a value
  // resolves to a stable deck id + name.
  if (input.deckId === null || input.deck === null) {
    updateData.deckId = FieldValue.delete() as unknown as string;
    updateData.deck = FieldValue.delete() as unknown as string;
  } else if (input.deckId !== undefined || input.deck !== undefined) {
    const deckRef = await resolveDeckRef({ deckId: input.deckId, deck: input.deck }, ownerId);
    if (deckRef) {
      if (deckRef.deckId !== undefined) updateData.deckId = deckRef.deckId;
      if (deckRef.deck !== undefined) updateData.deck = deckRef.deck;
    }
  }

  await docRef.update(updateData);

  const updated = await docRef.get();
  return docToFlashcard(updated as QueryDocumentSnapshot<DocumentData>);
}

export async function deleteFlashcard(id: string, ownerId?: string): Promise<boolean> {
  const docRef = getDb().collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return false;
  if (ownerId !== undefined && doc.data()?.ownerId !== ownerId) return false;
  await docRef.delete();
  // Best-effort cleanup of stored image objects (never blocks the delete).
  await cleanupCardImages(id);
  return true;
}

export async function listFlashcards(query: ListFlashcardsQuery, ownerId?: string): Promise<ListFlashcardsResponse> {
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  q = q.orderBy('createdAt', 'desc');

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

  if (query.pageToken) {
    const tokenDoc = await getDb().collection(COLLECTION).doc(query.pageToken).get();
    if (tokenDoc.exists) {
      q = q.startAfter(tokenDoc);
    }
  }

  const snapshot = await q.limit(pageSize + 1).get();
  const docs = snapshot.docs;

  const hasMore = docs.length > pageSize;
  const cards = docs.slice(0, pageSize).map(docToFlashcard);

  let nextPageToken: string | null = null;
  if (hasMore) {
    nextPageToken = docs[pageSize - 1].id;
  }

  return { cards, nextPageToken };
}

/**
 * Lists cards that are due for review right now: cards that have never been
 * reviewed (New, due immediately) plus cards whose scheduled `due` time has
 * arrived (Learning/Review/Relearning). Optionally restricted to one deck
 * (by stable deckId or legacy deck name).
 *
 * Cards are ordered by due time ascending (earliest due first) and paginated
 * with the same id-cursor convention as listFlashcards (pageToken = last card
 * id of the previous page).
 */
export async function dueFlashcards(query: DueFlashcardsQuery, ownerId?: string): Promise<DueFlashcardsResponse> {
  const now = Timestamp.now();

  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  q = q.where('due', '<=', now)
    .orderBy('due', 'asc');

  if (query.deckId) {
    q = q.where('deckId', '==', query.deckId);
  } else if (query.deck) {
    q = q.where('deck', '==', query.deck);
  }

  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);

  if (query.pageToken) {
    const tokenDoc = await getDb().collection(COLLECTION).doc(query.pageToken).get();
    if (tokenDoc.exists) {
      q = q.startAfter(tokenDoc);
    }
  }

  const snapshot = await q.limit(pageSize + 1).get();
  const docs = snapshot.docs;

  const hasMore = docs.length > pageSize;
  const cards = docs.slice(0, pageSize).map(docToFlashcard);

  let nextPageToken: string | null = null;
  if (hasMore) {
    nextPageToken = docs[pageSize - 1].id;
  }

  return { cards, nextPageToken };
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
  ownerId?: string,
): FirebaseFirestore.Query {
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
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
 * non-zero: cards with no deck at all, plus legacy cards whose `deck` string
 * has no deck entity (unmigrated pre-entity documents).
 *
 * groupBy is mutually exclusive with the deck/tag filters (validator
 * enforced): a filtered breakdown is not expressible as count() aggregates,
 * so groupBy always describes the whole library.
 */
export async function countFlashcards(query: CountFlashcardsQuery, ownerId?: string): Promise<CountFlashcardsResponse> {
  const now = Timestamp.now();
  const whole = await countBuckets(applyCountFilters(getDb().collection(COLLECTION), query, ownerId), now);

  if (query.groupBy !== 'deck') {
    return { counts: whole };
  }

  // groupBy=deck: iterate the OWNER's deck ENTITIES (metadata only) and
  // count each deck's cards via `deck == name` equality aggregates (plus the
  // owner predicate). No flashcards collection documents are ever fetched.
  const deckQuery: FirebaseFirestore.Query<DocumentData> = getDb().collection(DECKS_COLLECTION);
  const deckSnap = await (ownerId !== undefined ? deckQuery.where('ownerId', '==', ownerId) : deckQuery).get();
  const decks = deckSnap.docs.map((doc) => ({ id: doc.id, name: doc.data().name as string }));

  const attributed = { total: 0, new: 0, learning: 0, mature: 0, due: 0 };
  const byDeck: CountByDeck[] = [];
  for (const deck of decks) {
    let deckQ: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION).where('deck', '==', deck.name);
    if (ownerId !== undefined) deckQ = deckQ.where('ownerId', '==', ownerId);
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
 * and `createdTo` (`createdAt < createdToMs + 1ms` — strict, so the bound's
 * final millisecond is included at full nanosecond resolution; see the
 * pushdown below) — and orders by `createdAt` desc with an explicit
 * document-id ascending secondary order (Firestore's native tie-break). The
 * remaining predicates that Firestore cannot express in one composite query
 * (case-insensitive substring search, ALL/NOT tag semantics, review-state
 * tests, suspended defaults, updatedAt bounds, deck-name/id unions) are
 * applied in memory over the ordered candidate stream. The scan advances one
 * bounded Firestore page (≤500 docs) at a time and stops as soon as the page
 * is filled or the candidate stream is exhausted — there is no arbitrary
 * scan cap, so filtered pagination can reach any depth of the collection.
 *
 * PAGINATION: `nextPageToken` is an opaque cursor = base64url(JSON) of
 * { filtersKey (canonical fingerprint of the ACTIVE filters), lastId,
 * lastCreatedAtMs }. The next page MUST present the exact same filters: the
 * service re-checks the token's fingerprint against the normalized filters
 * and rejects a mismatch (the HTTP handler rejects it at validation too).
 * The page resumes strictly AFTER `(lastCreatedAtMs, lastId)` in the total
 * order (createdAt desc, id asc) — identical to the Firestore cursor, so
 * cards sharing a createdAt are never skipped or duplicated across pages.
 */
export async function searchCards(query: SearchCardsQuery, ownerId?: string): Promise<SearchCardsResponse> {
  const now = Timestamp.now();
  const nowMs = now.toMillis();
  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const filters = normalizeSearchFilters(query);

  let cursor: { lastId: string; lastCreatedAtMs: number } | null = null;
  if (query.pageToken) {
    const payload = readSearchPageToken(query.pageToken);
    if (!payload) {
      // Unreachable through the validated handler; guard anyway (defense in
      // depth for direct service callers).
      throw new Error('Invalid pageToken');
    }
    // The token embeds the fingerprint of the filters that produced it. A
    // token requested with DIFFERENT filters would silently paginate a
    // different result set — reject it here (the handler also rejects it at
    // validation, but the service enforces the invariant on its own).
    if (payload.filtersKey !== searchFiltersKey(filters)) {
      throw new Error('pageToken does not match the given filters');
    }
    cursor = { lastId: payload.lastId, lastCreatedAtMs: payload.lastCreatedAtMs };
  }

  // Firestore pushdown is limited to the ORDERED field: `createdAt` range
  // bounds need no extra composite index (they ride the same single-field
  // index as orderBy createdAt desc). `updatedAt` bounds and every other
  // non-indexable predicate are applied in memory by cardMatchesFilters.
  // The explicit document-id secondary order (ASC — Firestore's native
  // tie-break for orderBy createdAt desc) makes Firestore cursors, the
  // in-memory matcher (cardAfterCursor) and the page token agree exactly, so
  // cards sharing a createdAt can never be skipped or duplicated across
  // pages.
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(COLLECTION);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  q = q.orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId());
  if (filters.createdFromMs !== undefined) q = q.where('createdAt', '>=', Timestamp.fromMillis(filters.createdFromMs));
  // Upper bound is INCLUSIVE at the represented (millisecond) precision: a
  // card whose `createdAt` sits anywhere inside the bound's final millisecond
  // (raw nanoseconds 0..999999 beyond the ms — display/`toMillis()` truncate
  // it to exactly the bound) must match. `<= Timestamp.fromMillis(createdToMs)`
  // would compare RAW nanoseconds and exclude every such card (its nanos
  // exceed the bound's zero-extra nanos), so the in-memory matcher (truncated
  // ms `<=`) and Firestore would disagree. Firestore has no "inclusive up to
  // a whole millisecond" operator, so the pushdown is the STRICT upper bound
  // of the bound's millisecond: `< fromMillis(createdToMs + 1)` — exactly the
  // first instant after every document whose truncated ms is <= createdToMs.
  // (Parsed bounds are always whole-millisecond: date-times via Date.parse,
  // date-only end-of-day = 23:59:59.999, so +1 is never a rounding artifact.)
  if (filters.createdToMs !== undefined) q = q.where('createdAt', '<', Timestamp.fromMillis(filters.createdToMs + 1));

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
    if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);
    const snap = await pageQuery.get();
    if (snap.docs.length === 0) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      const card = docToFlashcard(doc);
      if (cursor && !cardAfterCursor(card, cursor.lastId, cursor.lastCreatedAtMs)) continue;
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
    nextPageToken = makeSearchPageToken(filters, last.id, last.createdAt.toMillis());
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
  ownerId?: string,
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
    if (ownerId !== undefined && card.ownerId !== ownerId) return null;

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
    // state (event + card state can never diverge). The direct review API
    // has no requestId, so the event document gets a fresh auto id and every
    // review writes exactly one event. The event owner is the verified
    // caller identity ('unknown' when no owner was supplied — the legacy
    // dev/emulator convention).
    t.set(eventRef, buildEventBody({
      ownerId: ownerId ?? 'unknown',
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
  ownerId?: string,
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
      if (ownerId !== undefined && snap.data()?.ownerId !== ownerId) continue;
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
      for (const key of Object.keys(merged)) {
        const value = (merged as Record<string, unknown>)[key];
        if (value && typeof value === 'object' && (value as { __fieldDelete?: boolean }).__fieldDelete) {
          delete (merged as Record<string, unknown>)[key];
        }
      }
      cards.push(merged);
    }
    return { ids: existing.map((e) => e.snap.id), count: existing.length, cards };
  });
}

/**
 * Resets the FSRS scheduling state of one or more flashcards to a
 * brand-new-card state: `state` New (0), due immediately at the server's
 * current time, zeroed stability/difficulty/reps/lapses, an EMPTY reviewLog,
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
export async function resetFlashcards(ids: string[], ownerId?: string): Promise<SchedulingActionResponse> {
  return runSchedulingAction(ids, () => {
    const now = Timestamp.now();
    const fresh = initialScheduling(now);
    return {
      state: fresh.state,
      stability: fresh.stability,
      difficulty: fresh.difficulty,
      reps: fresh.reps,
      lapses: fresh.lapses,
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
export async function setFlashcardDueDate(ids: string[], due: string, ownerId?: string): Promise<SchedulingActionResponse> {
    const parsed = new Date(due);
    const dueTs = Timestamp.fromMillis(Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime());
    return runSchedulingAction(ids, () => ({ due: dueTs }), ownerId);
}
/**
 * Suspends one or more flashcards: sets the persisted `suspended: true`
 * flag. A suspended card keeps ALL its content and scheduling state (due,
 * FSRS fields, reviewLog — nothing is lost or rescheduled); it is simply
 * excluded from the surfaces that honor the flag. Semantics per the existing
 * suspension contract:
 *  - `search_cards` is the ONLY query surface that reads the flag:
 *    `suspended: true` selects these cards; with no `suspended` filter they
 *    still appear (absent = both states); they NEVER match the `review`
 *    facet (due/notDue/new/reviewed).
 *  - The due endpoints (`dueFlashcards`), review-session queues and
 *    `review_flashcard` do NOT read the flag and behave exactly as before —
 *    suspending never mutates scheduling, and a card suspended mid-session
 *    keeps its place in an already-snapshotted session.
 * Returns the updated cards (existing ids only, in input order).
 */
export async function suspendFlashcards(ids: string[], ownerId?: string): Promise<SchedulingActionResponse> {
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
export async function unsuspendFlashcards(ids: string[], ownerId?: string): Promise<SchedulingActionResponse> {
    return runSchedulingAction(ids, () => ({ suspended: FieldValue.delete() }), ownerId);
}
/**
 * Bulk creates flashcards. Every input is validated by the caller before this
 * runs; referenced deck ids are checked to exist, then the whole operation is
 * committed in a single Firestore batch so it is all-or-nothing — no partial
 * silent success. Returns the created cards with their Firestore ids.
 */
export async function bulkCreateFlashcards(input: BulkCreateFlashcardsInput, ownerId?: string): Promise<BulkCreateFlashcardsResponse> {
    const now = Timestamp.now();
    const batch = getDb().batch();
    const cards = [];
    await validateDeckIds(input.cards.map(c => c.deckId), ownerId);
    for (const item of input.cards) {
        const docRef = getDb().collection(COLLECTION).doc();
        const scheduling = initialScheduling(now);
        const flashcard = {
            ...(ownerId !== undefined ? { ownerId } : {}),
            front: item.front,
            back: item.back,
            tags: item.tags || [],
            ...(item.topic !== undefined && item.topic !== null ? { topic: item.topic } : {}),
            ...(item.suspended !== undefined ? { suspended: item.suspended } : { suspended: false }),
            createdAt: now,
            updatedAt: now,
            ...scheduling,
            reviewLog: [],
            images: [],
        };
        applyDeckRef(flashcard, await resolveDeckRef(item, ownerId));
        batch.set(docRef, flashcard);
        cards.push({ id: docRef.id, ...flashcard });
    }
    await batch.commit();
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
export async function bulkUpdateFlashcards(input: BulkUpdateFlashcardsInput, ownerId?: string): Promise<BulkUpdateFlashcardsResponse> {
    await validateDeckIds(input.cards.map(c => c.deckId), ownerId);
    // Resolve deck references up front: resolution may create legacy-name decks
    // (a standalone write) which is not allowed inside a transaction callback.
    const resolvedRefs = new Map();
    for (const item of input.cards) {
        if (item.deckId === null || item.deck === null) {
            resolvedRefs.set(item.id, null); // explicit detach handled in-transaction
        }
        else if (item.deckId !== undefined || item.deck !== undefined) {
            resolvedRefs.set(item.id, await resolveDeckRef({ deckId: item.deckId, deck: item.deck }, ownerId));
        }
    }
    return getDb().runTransaction(async (t) => {
        const results = [];
        for (const item of input.cards) {
            const docRef = getDb().collection(COLLECTION).doc(item.id);
            const snap = await t.get(docRef);
            if (!snap.exists)
                continue;
            // Owner-scoped callers may only update their OWN cards (an
            // unowned/other-owner card is omitted — never silently updated).
            if (ownerId !== undefined && snap.data()?.ownerId !== ownerId)
                continue;
            const updateData: Record<string, unknown> = {
                updatedAt: Timestamp.now(),
            };
            if (item.front !== undefined)
                updateData.front = item.front;
            if (item.back !== undefined)
                updateData.back = item.back;
            if (item.topic === null) {
                updateData.topic = FieldValue.delete();
            }
            else if (item.topic !== undefined) {
                updateData.topic = item.topic;
            }
            if (item.suspended !== undefined)
                updateData.suspended = item.suspended;
            if (item.tags !== undefined)
                updateData.tags = item.tags;
            if (item.deckId === null || item.deck === null) {
                updateData.deckId = FieldValue.delete();
                updateData.deck = FieldValue.delete();
            }
            else {
                const deckRef = resolvedRefs.get(item.id) ?? undefined;
                if (deckRef) {
                    if (deckRef.deckId !== undefined)
                        updateData.deckId = deckRef.deckId;
                    if (deckRef.deck !== undefined)
                        updateData.deck = deckRef.deck;
                }
            }
            t.update(docRef, updateData);
            results.push(mergeCardForResponse(snap, updateData));
        }
        return { cards: results };
    });
}
/**
 * Bulk deletes flashcards. Existence is checked inside a single Firestore
 * transaction and the deletes commit atomically: either every id present in
 * the collection is deleted or none are — no partial silent success. Returns
 * the ids actually deleted; ids that did not exist are omitted.
 */
export async function bulkDeleteFlashcards(input: BulkDeleteFlashcardsInput, ownerId?: string): Promise<BulkDeleteFlashcardsResponse> {
    const result = await getDb().runTransaction(async (t) => {
        const deletedIds = [];
        // Firestore transactions forbid reads AFTER writes: read every target
        // first, then delete the existing ones in a second pass. Owner-scoped
        // callers may only delete their OWN cards.
        const existing = [];
        for (const id of input.ids) {
            const docRef = getDb().collection(COLLECTION).doc(id);
            const snap = await t.get(docRef);
            if (snap.exists && (ownerId === undefined || snap.data()?.ownerId === ownerId))
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
export async function verifyApiKey(key: string): Promise<string | null> {
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
 * Thrown when a session is accessed with a different API key name than the
 * one that started it (client-visible 403). Sessions are scoped to the API
 * key that created them.
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
/**
 * Thrown when a v2 session is accessed whose queue build failed
 * (client-visible 409). The root was created but its queueChunks children
 * could not be fully written, so the session is NOT reviewable: retrying
 * starts a NEW session (the failed id is never reused). The failed root (and
 * any partial chunk documents under `reviewSessions/{sessionId}/queueChunks`)
 * can be cleaned up by deleting the session document with its subcollection.
 */
export class ReviewSessionBuildFailedError extends Error {
    constructor(sessionId: string, buildError?: string) {
        super(`Review session ${sessionId} failed to build and is not reviewable. Start a new review session${buildError ? ` (${buildError})` : ''}.`);
        this.name = 'ReviewSessionBuildFailedError';
    }
}
/**
 * Throws when the caller's owner does not match the session owner.
 *
 * Ownership model: a session started by an owner-scoped request carries
 * `ownerId` (the verified identity); access requires the caller's ownerId to
 * equal it. A session that predates owner scoping carries only `apiKeyName`;
 * when the caller presents no ownerId, the legacy key-name check applies
 * (dev/emulator compatibility). Production always authenticates before
 * reaching the service, so a real request always carries an ownerId.
 */
function assertSessionOwnership(session: ReviewSession, ownerId?: string, apiKeyName?: string): void {
    if (ownerId !== undefined) {
        // Owner-scoped session: the caller must own it. A LEGACY session that
        // predates owner scoping carries only apiKeyName — the pre-multi-tenant
        // shared-key world; the owner-equivalence accepts the recorded key
        // name so dev/emulator tests (which pass the fixture key name) keep
        // working, while a REAL ownerId never equals a fixture key name and
        // legacy unowned sessions stay reachable only by unscoped calls.
        const matchesOwner = session.ownerId === ownerId
            || (session.ownerId === undefined && session.apiKeyName === ownerId);
        if (!matchesOwner) {
            throw new ReviewSessionForbiddenError(session.id);
        }
        return;
    }
    if (!apiKeyName)
        return;
    if (session.apiKeyName !== apiKeyName) {
        throw new ReviewSessionForbiddenError(session.id);
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
        apiKeyName: data.apiKeyName,
        status: data.status as SessionStatus,
        mode: (SESSION_MODES.includes(data.mode) ? data.mode : 'spaced_repetition') as SessionMode,
        ...(data.source !== undefined
            ? {
                source: sanitizeSessionSource(data.source as ReviewSessionSource, data.storageVersion === SESSION_STORAGE_VERSION),
            }
            : {}),
        ...(data.cardType !== undefined ? { cardType: data.cardType as CardType } : {}),
        ...(data.storageVersion !== undefined ? { storageVersion: data.storageVersion as number } : {}),
        ...(data.lastRequestId !== undefined ? { lastRequestId: data.lastRequestId } : {}),
        ...(data.lastRatedCardId !== undefined ? { lastRatedCardId: data.lastRatedCardId } : {}),
        ...(data.testMode === true ? { testMode: true } : {}),
        limit: data.limit,
        dueCount: data.dueCount,
        // v2 roots are BOUNDED: the queue arrays below are ABSENT and the
        // v2 metadata fields carry the state.
        ...(data.repeatSessionId !== undefined ? { repeatSessionId: data.repeatSessionId } : {}),
        ...(data.storageVersion === SESSION_STORAGE_VERSION ? {
            chunkCount: data.chunkCount,
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
    let startChunk = typeof session.currentChunkIndex === 'number' && session.currentChunkIndex >= 0
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
    if (selectors.ownerId !== undefined) q = q.where('ownerId', '==', selectors.ownerId);
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
    /** When set, the queue query is scoped to this owner's cards only. */
    ownerId?: string;
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
                if (selectors.ownerId !== undefined && data?.ownerId !== selectors.ownerId) {
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
        let cursor: BuildCursor = { lastDue: null, lastDocId: null };
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
async function resolveSessionDeck(input: { deckId?: string; deck?: string }, ownerId?: string): Promise<{ deckId?: string; deckName: string; byName: boolean }> {
    if (input.deckId !== undefined && input.deckId !== '') {
        const deckDoc = await getDb().collection(DECKS_COLLECTION).doc(input.deckId).get();
        if (!deckDoc.exists || (ownerId !== undefined && deckDoc.data()?.ownerId !== ownerId)) {
            throw new DeckNotFoundError(input.deckId);
        }
        const name = deckDoc.data()?.name;
        return { deckId: input.deckId, deckName: name ?? input.deck ?? input.deckId, byName: false };
    }
    if (input.deck !== undefined && input.deck !== '') {
        const deckId = await findDeckIdByName(input.deck, ownerId);
        return { deckId: deckId ?? undefined, deckName: input.deck, byName: true };
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
 * Normalizes the explicit card-id allowlist: trims, drops empty ids, and
 * dedupes while preserving FIRST-OCCURRENCE order — the same stable
 * deterministic ordering used for the session snapshot, so the same input
 * always produces the same queue.
 */
function normalizeCardIdAllowlist(cardIds: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of cardIds) {
        const id = raw.trim();
        if (id === '') continue;
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
        apiKeyName: ownerId,
        status: 'active',
        mode: 'spaced_repetition',
        ...(input.deckId !== undefined ? { deckId: input.deckId } : {}),
        ...(input.name !== undefined && input.name !== null ? { name: input.name } : {}),
        ...(input.cardType !== undefined && input.cardType !== null ? { cardType: input.cardType } : {}),
        source,
        storageVersion: SESSION_STORAGE_VERSION,
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
            // Copy the referenced session's chunks into the new session.
            const priorRef = getDb().collection(SESSIONS_COLLECTION).doc(repeatSessionId as string);
            const priorSnap = await priorRef.get();
            if (!priorSnap.exists) {
                throw new ReviewSessionCardNotFoundError(repeatSessionId as string);
            }
            const prior = docToReviewSession(priorSnap);
            if (prior.ownerId !== undefined ? prior.ownerId !== ownerId : prior.apiKeyName !== ownerId) {
                throw new ReviewSessionForbiddenError(repeatSessionId as string);
            }
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
    const stored: ReviewSession = {
        id: sessionId,
        ownerId,
        apiKeyName: ownerId,
        status: 'active',
        mode: 'spaced_repetition',
        ...(input.deckId !== undefined ? { deckId: input.deckId } : {}),
        ...(input.name !== undefined && input.name !== null ? { name: input.name } : {}),
        ...(input.cardType !== undefined && input.cardType !== null ? { cardType: input.cardType } : {}),
        source,
        storageVersion: SESSION_STORAGE_VERSION,
        buildStatus: 'ready',
        limit,
        totalCount: limit,
        dueCount: limit,
        currentPosition: 0,
        currentChunkIndex: limit > 0 ? 0 : -1,
        chunkCount,
        completedChunks: 0,
        queueChunksPrefix: SESSION_QUEUE_CHUNKS_COLLECTION,
        position: limit,
        deletedCount: 0,
        remainingQueueCount: limit,
        currentIndex: 0,
        reviewedCount: 0,
        truncated: false,
        continuationAvailable: false,
        ratingCounts: emptyRatingCounts(),
        startedAt: now,
        ...(testMode ? { testMode: true } : {}),
        ...(repeatSessionId !== undefined ? { repeatSessionId } : {}),
    };

    // Build the current-card + preload response. The v2 queue is bounded, so
    // the preload is the current card plus up to SESSION_PRELOAD upcoming ids
    // (each carrying its REQUIRED stable queue position).
    const window = await loadV2QueueWindow(stored, 0);
    let card: Flashcard | null = null;
    const preloaded: PreloadedCard[] = [];
    if (window && window.cardIds.length > 0) {
        const entries = window.cardIds.slice(0, 1 + SESSION_PRELOAD);
        const snaps = await Promise.all(entries.map((w) => getDb().collection(COLLECTION).doc(w.cardId).get()));
        let currentIdx = -1;
        for (let i = 0; i < snaps.length; i += 1) {
            if (snaps[i] && snaps[i].exists) { currentIdx = i; break; }
        }
        if (currentIdx >= 0) {
            card = docToFlashcard(snaps[currentIdx]);
            for (let i = currentIdx + 1; i < snaps.length && preloaded.length < SESSION_PRELOAD; i += 1) {
                if (!snaps[i] || !snaps[i].exists) continue;
                const c = docToFlashcard(snaps[i]);
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
    }
    const queueWindow: SessionQueueWindow = window
        ? window
        : { currentPosition: null, currentCardId: null, cardIds: [] };
    const respSession: ReviewSession = {
        ...stored,
        remainingQueueCount: limit,
        remainingCount: limit,
        ...(window && window.currentPosition !== null ? { currentPosition: window.currentPosition, currentChunkIndex: chunkOrdinalFor(window.currentPosition) } : {}),
    };
    return {
        session: respSession,
        card,
        preloaded,
        currentPosition: window ? window.currentPosition : null,
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
async function loadPreloaded(session: ReviewSession, startIndex: number): Promise<PreloadedCard[]> {
    // v1/no-version legacy documents always carry the in-root cardIds; a
    // defensive read keeps a malformed root from crashing get/submit.
    const ids = (session.cardIds ?? []).slice(startIndex, startIndex + SESSION_PRELOAD);
    if (ids.length === 0)
        return [];
    const snapshots = await Promise.all(ids.map((id) => getDb().collection(COLLECTION).doc(id).get()));
    const out = [];
    for (let i = 0; i < snapshots.length; i += 1) {
        const cardDoc = snapshots[i];
        if (!cardDoc.exists)
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
async function loadSessionCard(session: ReviewSession): Promise<Flashcard | null> {
    // v1/no-version legacy documents always carry the in-root cardIds; a
    // defensive read keeps a malformed root from crashing get/submit.
    const cardIds = session.cardIds ?? [];
    if (!isSessionActive(session) || session.currentIndex >= cardIds.length) {
        return null;
    }
    const cardDoc = await getDb().collection(COLLECTION).doc(cardIds[session.currentIndex]).get();
    if (!cardDoc.exists)
        return null;
    return docToFlashcard(cardDoc);
}
/**
 * Retrieves a session (any status) plus its current card. Only the API key
 * that started the session may read it (unless no key was supplied — dev /
 * emulator compatibility).
 *
 * v2 sessions return the current card from the queue window (never the full
 * queue) plus `currentPosition`/`queueWindow`; legacy v1/no-version sessions
 * keep the existing full-array response unchanged.
 */
export async function getReviewSession(sessionId: string, ownerId?: string): Promise<ReviewSessionWithCard | null> {
    const docRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const snap = await docRef.get();
    if (!snap.exists)
        return null;
    const session = docToReviewSession(snap);
    assertSessionOwnership(session, ownerId);
    if (isV2Session(session)) {
        return getV2ReviewSession(session);
    }
    return loadSessionCard(session).then(async (card) => ({
        session: { ...session, remainingCount: sessionRemainingCount(session) },
        card,
        preloaded: await loadPreloaded(session, session.currentIndex + 1),
    }));
}

/** v2 get: reads the current card + bounded preload from the queue chunks.
 *  A session whose build is incomplete (buildStatus 'building') or failed is
 *  NOT reviewable — the typed error is surfaced (never a partial queue). */
async function getV2ReviewSession(session: ReviewSession): Promise<ReviewSessionWithCard> {
    if (!isV2Ready(session)) {
        throw new ReviewSessionBuildFailedError(session.id, session.buildError ?? 'session not ready');
    }
    const currentPosition = session.currentPosition ?? session.currentIndex ?? 0;
    const window = await loadV2QueueWindow(session, currentPosition);
    if (!window) {
        // A covering chunk is missing — the build was partial. Surface the
        // typed error rather than serving a partial queue.
        throw new ReviewSessionBuildFailedError(session.id, 'queue chunks missing');
    }
    let card: Flashcard | null = null;
    const preloaded: PreloadedCard[] = [];
    if (window.cardIds.length > 0) {
        const entries = window.cardIds.slice(0, 1 + SESSION_PRELOAD);
        const snaps = await Promise.all(entries.map((w) => getDb().collection(COLLECTION).doc(w.cardId).get()));
        const first = snaps[0];
        if (first && first.exists) {
            card = docToFlashcard(first);
        } else if (window.cardIds.length > 0) {
            // Current card was deleted since the snapshot — advance to the
            // first live preloaded card (deleted cards are skipped without
            // counting; a later submit persists the skip).
            for (let i = 1; i < snaps.length; i += 1) {
                if (snaps[i] && snaps[i].exists) {
                    card = docToFlashcard(snaps[i]);
                    break;
                }
            }
        }
        for (let i = 1; i < snaps.length; i += 1) {
            if (!snaps[i] || !snaps[i].exists) continue;
            const c = docToFlashcard(snaps[i]);
            preloaded.push({ id: c.id, front: c.front, back: c.back, ...(c.deck !== undefined ? { deck: c.deck } : {}), tags: c.tags, position: entries[i].position });
        }
    }
    const respSession: ReviewSession = {
        ...session,
        remainingQueueCount: session.remainingQueueCount ?? 0,
        remainingCount: session.remainingQueueCount ?? 0,
        ...(window.currentPosition !== null ? { currentPosition: window.currentPosition, currentChunkIndex: chunkOrdinalFor(window.currentPosition) } : { currentChunkIndex: -1 }),
    };
    return {
        session: respSession,
        card,
        preloaded,
        currentPosition: window.currentPosition,
        queueWindow: window,
    };
}

/**
 * Submits a rating for a card of a review session.
 *
 * v2 (all NEW sessions): the rating commits in ONE Firestore transaction —
 * the FSRS scheduling of the card, the session counters (reviewedCount,
 * ratingCounts, currentIndex, remainingQueueCount, deletedCount, status) and
 * the queueChunks claim (the item's `status:'reviewed'` + `requestId` marker) all
 * land together, so concurrent submissions and client retries can never
 * double-apply a review, lose progress, or rate the wrong card. Duplicate
 * requestId detection reads the item's `requestId` in the
 * chunk document — NEVER a root array — and a review event is written in the
 * SAME transaction (requestId-keyed with a merge:false set so a retry aborts
 * rather than double-writing).
 *
 * The legacy v1/no-version path (documents written before v2) is routed to
 * the unchanged legacy implementation below.
 */
export async function submitSessionReview(sessionId: string, input: SubmitSessionReviewInput, ownerId?: string): Promise<SubmitSessionReviewResult | null> {
    // Route by the PERSISTED storage version. A direct root read picks the
    // v2 path (chunked storage); legacy mocks/tests that only wire the
    // transaction fall back to the unchanged legacy path (documents written
    // before v2 always carry the in-root arrays the legacy path needs).
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    try {
        const snap = await sessionRef.get();
        if (snap.exists) {
            const session = docToReviewSession(snap);
            assertSessionOwnership(session, ownerId);
            if (isV2Session(session)) {
                return submitV2SessionReview(session, input);
            }
        }
    } catch (err) {
        // Direct read unavailable (emulator/legacy mocks): the legacy path
        // performs its own transactional session read.
    }
    return submitLegacySessionReview(sessionId, input, ownerId);
}

/** Per-transaction reader over a v2 session's queueChunks documents. Every
 *  chunk read goes through `t.get` with a cache so the transaction's snapshot
 *  is used consistently and a concurrent claim of the same chunk forces a
 *  transaction retry (at-most-once is preserved). */
interface TxQueueReader {
    /** Reads the full chunk doc owning `position` (null when missing). */
    chunkFor(position: number): Promise<SessionChunkDocument | null>;
    /** Reads one queue item at `position` (null when the chunk is missing). */
    item(position: number): Promise<SessionQueueItem | null>;
    /** Marks one item claimed in its chunk and maintains chunk metadata:
     *  sets items.<i>.{status,...}, decrements pendingCount, and flips the
     *  chunk status to 'completed' when its pendingCount reaches 0. */
    claim(position: number, patch: { status: 'reviewed' | 'deleted'; rating?: number; requestId?: string; reviewedAt?: Timestamp; deletedAt?: Timestamp }): void;
}

function txQueueReader(t: FirebaseFirestore.Transaction, sessionId: string): TxQueueReader {
    const chunkCache = new Map<number, SessionChunkDocument>();
    const loaded = new Set<number>();
    // Per-chunk claim count within this transaction (for the completed flip).
    const txClaims = new Map<number, number>();
    return {
        async chunkFor(position: number) {
            const chunkIndex = chunkOrdinalFor(position);
            if (!loaded.has(chunkIndex)) {
                loaded.add(chunkIndex);
                const doc = await t.get(sessionChunksCollection(sessionId).doc(chunkDocId(chunkIndex)));
                if (!doc.exists) return null;
                const data = doc.data();
                if (!data || !Array.isArray(data.items)) return null;
                const chunk: SessionChunkDocument = {
                    chunkIndex: typeof data.chunkIndex === 'number' ? data.chunkIndex : chunkIndex,
                    startPosition: typeof data.startPosition === 'number' ? data.startPosition : chunkIndex * SESSION_QUEUE_CHUNK_SIZE,
                    itemCount: typeof data.itemCount === 'number' ? data.itemCount : (data.items as unknown[]).length,
                    pendingCount: typeof data.pendingCount === 'number' ? data.pendingCount : (data.items as unknown[]).length,
                    status: data.status === 'completed' ? 'completed' : 'active',
                    items: data.items as SessionQueueItem[],
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
            if (!item || typeof item.cardId !== 'string') return null;
            return item;
        },
        claim(position: number, patch: { status: 'reviewed' | 'deleted'; rating?: number; requestId?: string; reviewedAt?: Timestamp; deletedAt?: Timestamp }) {
            const chunkIndex = chunkOrdinalFor(position);
            const chunkRef = sessionChunksCollection(sessionId).doc(chunkDocId(chunkIndex));
            const local = chunkLocalIndex(position);
            const field = `items.${local}`;
            const update: Record<string, unknown> = {
                [`${field}.status`]: patch.status,
            };
            if (patch.rating !== undefined) update[`${field}.rating`] = patch.rating;
            if (patch.requestId !== undefined) update[`${field}.requestId`] = patch.requestId;
            if (patch.reviewedAt !== undefined) update[`${field}.reviewedAt`] = patch.reviewedAt;
            if (patch.deletedAt !== undefined) update[`${field}.deletedAt`] = patch.deletedAt;
            // pendingCount decrement is atomic (Firestore server-side
            // increment) so concurrent claims in the same chunk stay exact.
            update.pendingCount = FieldValue.increment(-1);
            // Track per-chunk claims made IN THIS TRANSACTION: multiple claims
            // to the same chunk must all count toward the completed flip, so
            // the chunk status is set to 'completed' when the cached
            // pendingCount minus the in-transaction claim count reaches 0 —
            // not merely cached.pendingCount - 1 (which would miss the final
            // item when the same transaction already claimed another item of
            // that chunk).
            const cached = chunkCache.get(chunkIndex);
            const txnClaims = txClaims.get(chunkIndex) ?? 0;
            const nextClaims = txnClaims + 1;
            txClaims.set(chunkIndex, nextClaims);
            const newPending = (cached ? cached.pendingCount : 0) - nextClaims;
            if (cached && newPending <= 0) {
                update.status = 'completed';
            }
            t.update(chunkRef, update);
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
 *   - `expectedPosition` -> DIRECT chunk lookup of that position;
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
 * DUPLICATE-requestId IDEMPOTENCY: the target item's `requestId` is checked
 * first (same-position retry). When the retried position is before the
 * active chunk (already consumed), the review-event document
 * (`reviewEvents/evt-<requestId>`) is read DETERMINISTICALLY inside the
 * transaction BEFORE any write — its existence returns the recorded bounded
 * state as a no-op instead of a 409.
 */
async function submitV2SessionReview(session: ReviewSession, input: SubmitSessionReviewInput): Promise<SubmitSessionReviewResult | null> {
    if (!isV2Ready(session)) {
        throw new ReviewSessionBuildFailedError(session.id, session.buildError ?? 'session not ready');
    }
    const sessionId = session.id;
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const reviewTime = resolveReviewTime(input.reviewAt, new Date());
    const updatedAt = Timestamp.now();
    const requestId = input.requestId;
    const ownerId = session.ownerId;
    const sessionEventRef = requestId !== undefined
        ? getDb().collection('reviewEvents').doc(sessionEventId(ownerId ?? 'unknown', requestId))
        : getDb().collection('reviewEvents').doc();

    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const live = docToReviewSession(snap);
        if (!isV2Ready(live)) {
            throw new ReviewSessionBuildFailedError(sessionId, live.buildError ?? 'session not ready');
        }
        const limit = live.limit ?? 0;
        const startPosition = live.currentIndex ?? 0;
        const q = txQueueReader(t, sessionId);

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
                    // Claimed/deleted by someone else. Before a 409, check
                    // whether THIS requestId already committed (deterministic
                    // event read inside the transaction, before any write).
                    if (requestId !== undefined) {
                        const evt = await t.get(sessionEventRef).catch(() => null);
                        if (evt && evt.exists) {
                            const cur = await loadV2CurrentCard(live);
                            return {
                                session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                                card: cur.card,
                                currentPosition: cur.position,
                                ...(requestId !== undefined ? { requestId } : {}),
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
                if (next) {
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
        //    currentChunkIndex + the first live item of that chunk). Never
        //    scans past the active chunk's end.
        if (targetPosition < 0) {
            const startChunk = chunkOrdinalFor(startPosition);
            const chunk = await q.chunkFor(startPosition);
            if (!chunk) throw new ReviewSessionBuildFailedError(sessionId, 'queue chunks missing');
            let foundPos = -1;
            for (let li = startPosition - chunk.startPosition; li < chunk.items.length; li += 1) {
                const pos = chunk.startPosition + li;
                if (pos >= limit) break;
                const it = chunk.items[li];
                if (!it || typeof it.cardId !== 'string') break;
                if (it.status !== 'pending') continue;
                foundPos = pos;
                targetCardId = it.cardId;
                break;
            }
            if (foundPos < 0 && startChunk + 1 < Math.ceil(limit / SESSION_QUEUE_CHUNK_SIZE)) {
                // Active chunk exhausted: consult the NEXT chunk's metadata
                // (earliest active chunk query is a bounded single read).
                const next = await q.chunkFor((startChunk + 1) * SESSION_QUEUE_CHUNK_SIZE);
                if (next) {
                    for (let li = 0; li < next.items.length; li += 1) {
                        const pos = next.startPosition + li;
                        if (pos >= limit) break;
                        const it = next.items[li];
                        if (!it || typeof it.cardId !== 'string') break;
                        if (it.status !== 'pending') continue;
                        foundPos = pos;
                        targetCardId = it.cardId;
                        break;
                    }
                }
            }
            if (foundPos < 0) {
                // Queue genuinely exhausted: complete.
                const finalState: Partial<ReviewSession> = { status: 'completed', endedAt: updatedAt };
                t.update(sessionRef, finalState);
                return {
                    session: { ...live, ...finalState, remainingCount: 0 },
                    card: null,
                    currentPosition: null,
                    ...(requestId !== undefined ? { requestId } : {}),
                };
            }
            targetPosition = foundPos;
        }

        if (targetPosition < 0 || targetPosition >= limit || !targetCardId) {
            throw new ReviewExpectedCardMismatchError(sessionId, input.expectedCardId ?? String(input.expectedPosition), undefined);
        }

        // ── Duplicate requestId already committed (event read, pre-write) ──
        // Reached only when the target is live but the requestId may have
        // committed at a DIFFERENT position (a retry racing after the session
        // advanced). The review event is deterministic (evt-<id>); reading it
        // inside the transaction BEFORE any write keeps retries idempotent.
        if (requestId !== undefined) {
            const targetItemNow = await q.item(targetPosition);
            if (targetItemNow && targetItemNow.status === 'reviewed') {
                if (targetItemNow.requestId === requestId) {
                    const cur = await loadV2CurrentCard(live);
                    return {
                        session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                        card: cur.card,
                        currentPosition: cur.position,
                        ...(requestId !== undefined ? { requestId } : {}),
                    };
                }
                throw new ReviewExpectedCardMismatchError(sessionId, targetItemNow.cardId, undefined);
            }
            const evt = await t.get(sessionEventRef).catch(() => null);
            if (evt && evt.exists) {
                // This requestId already applied a review: idempotent no-op.
                const cur = await loadV2CurrentCard(live);
                return {
                    session: { ...live, remainingCount: live.remainingQueueCount ?? 0 },
                    card: cur.card,
                    currentPosition: cur.position,
                    ...(requestId !== undefined ? { requestId } : {}),
                };
            }
        }

        // ── Card read (ALL reads BEFORE any write) ─────────────────────────
        const cardSnap = await t.get(getDb().collection(COLLECTION).doc(targetCardId));
        const targetDeleted = !cardSnap.exists;

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
            let scannedDeleted = 0;
            for (let cIdx = fromChunk; cIdx <= fromChunk + 1 && cIdx * SESSION_QUEUE_CHUNK_SIZE < limit; cIdx += 1) {
                const chunk = await q.chunkFor(cIdx * SESSION_QUEUE_CHUNK_SIZE);
                if (!chunk) break;
                for (let li = Math.max(0, startPosition - chunk.startPosition); li < chunk.items.length; li += 1) {
                    const pos = chunk.startPosition + li;
                    if (pos >= limit) break;
                    const it = chunk.items[li];
                    if (!it || typeof it.cardId !== 'string') break;
                    if (it.status !== 'pending') continue;
                    if (pos === targetPosition) continue; // consumed by this claim
                    const nSnap = await t.get(getDb().collection(COLLECTION).doc(it.cardId));
                    if (!nSnap.exists) {
                        // Deleted since the snapshot: persist the skip NOW so
                        // the chunk metadata and root counters stay exact.
                        q.claim(pos, { status: 'deleted', deletedAt: updatedAt });
                        scannedDeleted += 1;
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
            q.claim(targetPosition, { status: 'deleted', deletedAt: updatedAt });
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
                    ownerId: live.ownerId ?? live.apiKeyName ?? 'unknown',
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
            currentPosition: nextStatus === 'active' ? currentIndex : undefined,
            currentChunkIndex: nextStatus === 'active' ? chunkOrdinalFor(currentIndex) : -1,
            reviewedCount,
            ratingCounts,
            remainingQueueCount,
            remainingCount: remainingQueueCount,
            deletedCount,
            lastReviewedAt: updatedAt,
            ...(requestId !== undefined && !targetDeleted ? { lastRequestId: requestId, lastRatedCardId: targetCardId } : {}),
        };
        if (nextStatus !== 'active') {
            sessionUpdate.status = nextStatus;
            sessionUpdate.endedAt = updatedAt;
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
                if (firstSnap.exists) {
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
                            if (!snaps[i] || !snaps[i].exists) continue;
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
async function loadV2CurrentCard(session: ReviewSession): Promise<{ card: Flashcard | null; position: number | null }> {
    const limit = session.limit ?? 0;
    let startChunk = typeof session.currentChunkIndex === 'number' && session.currentChunkIndex >= 0
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
            if (!snap.exists) continue; // deleted: skip logically
            return { card: docToFlashcard(snap), position: pos };
        }
    }
    return { card: null, position: null };
}
async function submitLegacySessionReview(sessionId: string, input: SubmitSessionReviewInput, ownerId?: string): Promise<SubmitSessionReviewResult | null> {
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const reviewTime = resolveReviewTime(input.reviewAt, new Date());
    const updatedAt = Timestamp.now();
    const requestId = input.requestId;
    const sessionEventRef = requestId !== undefined
        ? getDb().collection('reviewEvents').doc(legacySessionEventId(requestId))
        : getDb().collection('reviewEvents').doc();
    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const session = docToReviewSession(snap);
        assertSessionOwnership(session, ownerId);
        const cardIds = session.cardIds ?? [];
        const reviewedCardIds = session.reviewedCardIds ?? [];
        if (requestId !== undefined
            && (session.processedRequestIds?.includes(requestId) || session.lastRequestId === requestId)) {
            const cachedCard = await loadSessionCard(session);
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
            if (!cardSnap.exists)
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
            if (!nextSnap.exists)
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
                ownerId: session.ownerId ?? session.apiKeyName ?? 'unknown',
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
 * Ends an active session without rating the remaining cards. Only the API key
 * that started the session may end it. Idempotent: ending an already
 * terminated session is a no-op that returns it unchanged. v2 and legacy
 * sessions share the root-only status write.
 */
export async function endReviewSession(sessionId: string, ownerId?: string): Promise<ReviewSession | null> {
    const sessionRef = getDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const now = Timestamp.now();
    return getDb().runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (!snap.exists)
            return null;
        const session = docToReviewSession(snap);
        assertSessionOwnership(session, ownerId);
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
export async function attachImage(cardId: string, input: AttachImageInput, ownerId?: string): Promise<AttachImageResponse | null> {
    validateImageUrl(input.url, input.mimeType);
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const card = await cardRef.get();
    if (!card.exists)
        return null;
    if (ownerId !== undefined && card.data()?.ownerId !== ownerId)
        return null;
    const image = {
        id: `img_${Date.now().toString(36)}`,
        url: input.url,
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        addedAt: Timestamp.now(),
    };
    const current = docToFlashcard(card);
    if ((current.images ?? []).length >= MAX_CARD_IMAGES) {
        throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
    }
    await cardRef.update({ images: [...(current.images ?? []), image], updatedAt: Timestamp.now() });
    const updated = await cardRef.get();
    return { card: docToFlashcard(updated), image };
}
export async function listImages(cardId: string, ownerId?: string): Promise<ListImagesResponse | null> {
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const card = await cardRef.get();
    if (!card.exists)
        return null;
    if (ownerId !== undefined && card.data()?.ownerId !== ownerId)
        return null;
    return { cardId, images: docToFlashcard(card).images ?? [] };
}
export async function removeImage(cardId: string, url: string, ownerId?: string): Promise<RemoveImageResponse | null> {
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const card = await cardRef.get();
    if (!card.exists)
        return null;
    if (ownerId !== undefined && card.data()?.ownerId !== ownerId)
        return null;
    const current = docToFlashcard(card);
    const removedImage = (current.images ?? []).find((img) => img.url === url);
    const images = (current.images ?? []).filter((img) => img.url !== url);
    const removed = removedImage !== undefined;
    if (removed) {
        await cardRef.update({ images, updatedAt: Timestamp.now() });
        // Cloud images own a Storage object — delete it best-effort (never blocks
        // the removal).
        if (removedImage.storagePath) {
            await getStorage().bucket().file(removedImage.storagePath).delete().catch(() => undefined);
        }
    }
    return { cardId, removed };
}
export async function uploadImage(cardId: string, input: UploadImageInput, ownerId?: string): Promise<UploadImageResponse | null> {
    if (!input.fileName || input.fileName.length > MAX_IMAGE_FILE_NAME_LENGTH) {
        throw new ImageValidationError('Invalid file name');
    }
    if (input.data.length > MAX_IMAGE_DATA_LENGTH) {
        throw new ImageValidationError(`Image data too large (max ${MAX_IMAGE_UPLOAD_BYTES} bytes)`);
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(input.contentType)) {
        throw new ImageValidationError(`Content type not allowed for upload: ${input.contentType}`);
    }
    // Strict base64: reject strings that are not well-formed base64 (Node's
    // Buffer.from(base64) silently decodes garbage, so a round-trip check is
    // required to catch malformed payloads).
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 === 1) {
        throw new ImageValidationError('Invalid base64 image data');
    }
    let data;
    try {
        data = Buffer.from(input.data, 'base64');
    }
    catch {
        throw new ImageValidationError('Invalid base64 image data');
    }
    if (data.length > MAX_IMAGE_UPLOAD_BYTES) {
        throw new ImageValidationError(`Image too large (max ${MAX_IMAGE_UPLOAD_BYTES} bytes)`);
    }
    const cardRef = getDb().collection(COLLECTION).doc(cardId);
    const card = await cardRef.get();
    if (!card.exists)
        return null;
    if (ownerId !== undefined && card.data()?.ownerId !== ownerId)
        return null;
    // Canonical extension from the declared MIME type.
    const MIME_TO_EXT: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
    };
    const ext = MIME_TO_EXT[input.contentType] ?? 'bin';
    // Sanitized file base name: keep the original basename (no path separators),
    // strip unsafe characters, and cap the length so the Storage path can never
    // traverse or exceed limits.
    const rawName = input.fileName.split(/[\\/]/).pop() || 'image';
    const base = rawName.replace(/[^A-Za-z0-9._-]/g, '').replace(/\.[^.]+$/, '').slice(0, 40) || 'image';
    // 20-char random image id.
    const imageId = Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    const storagePath = `card-images/${cardId}/${imageId}-${base}.${ext}`;
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    try {
        await file.save(data, { contentType: input.contentType });
    }
    catch {
        throw new ImageValidationError('Failed to store image');
    }
    let downloadUrl;
    try {
        [downloadUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 1000 * 60 * 60 * 24 * 365 });
    }
    catch (err) {
        await file.delete().catch(() => undefined);
        throw err;
    }
    const image = {
        id: imageId,
        url: downloadUrl,
        storagePath,
        downloadUrl,
        mimeType: input.contentType,
        sizeBytes: data.length,
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
        addedAt: Timestamp.now(),
    };
    // Transactional capacity check + metadata update: re-read the card inside a
    // transaction so concurrent uploads can never exceed MAX_CARD_IMAGES, and
    // the card write commits atomically with the capacity verdict. On ANY
    // failure (capacity, card missing, write error) the stored object is
    // deleted best-effort (no orphan). When the runtime has no transaction
    // support (no-op mock / dev), runTransaction returns undefined and we fall
    // back to a direct read+update.
    let txnResult;
    try {
        txnResult = await getDb().runTransaction(async (t) => {
            const snap = await t.get(cardRef);
            if (!snap.exists)
                return null;
            const current = docToFlashcard(snap);
            if ((current.images ?? []).length >= MAX_CARD_IMAGES) {
                throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
            }
            t.update(cardRef, { images: [...(current.images ?? []), image], updatedAt: Timestamp.now() });
            return { card: { ...current, images: [...(current.images ?? []), image] }, image };
        });
    }
    catch (err) {
        // Any transaction failure (capacity, card missing, write error) cleans up
        // the stored object best-effort so no orphan is left behind.
        await file.delete().catch(() => undefined);
        throw err;
    }
    if (txnResult !== undefined) {
        return txnResult;
    }
    // No-op transaction runtime: direct read + update (same guarantees minus
    // concurrency atomicity, which the no-op runtime cannot provide anyway).
    try {
        const before = docToFlashcard(card);
        if ((before.images ?? []).length >= MAX_CARD_IMAGES) {
            await file.delete().catch(() => undefined);
            throw new ImageValidationError(`Card already has the maximum of ${MAX_CARD_IMAGES} images`);
        }
        await cardRef.update({ images: [...(before.images ?? []), image], updatedAt: Timestamp.now() });
        const updated = await cardRef.get();
        return { card: docToFlashcard(updated), image };
    }
    catch (err) {
        await file.delete().catch(() => undefined);
        throw err;
    }
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
/**
 * Review-event persistence helpers and read services (history / study
 * stats / top-lapsed) plus the explicit legacy reviewLog backfill
 * migration.
 *
 * WHY EVENTS EXIST: the card document keeps only the newest
 * MAX_EMBEDDED_REVIEW_LOG (100) embedded reviewLog entries, so older
 * reviews would be unrecoverable. Every successful NON-TEST direct review
 * and session review therefore also appends ONE immutable `reviewEvents`
 * document, written in the SAME Firestore transaction that applies the FSRS
 * scheduling — the event log and the card state can never diverge. Session
 * events are keyed by the submission's requestId (`evt-<requestId>`) with a
 * merge:false set, so a retried submission can never double-write.
 *
 * SCOPING: every event records `actorId` = the stable immutable identity of
 * the authenticated API key that performed the review (`'unknown'` without
 * one). History and stats are scoped to the caller's actorId.
 *
 * Card documents are mapped inline (never importing service.ts's private
 * docToFlashcard) with identical read defaults.
 */

import {
  getFirestore, Firestore, Timestamp, FieldPath,
  QueryDocumentSnapshot, DocumentSnapshot, DocumentData,
} from 'firebase-admin/firestore';
import {
  ReviewEvent, ReviewHistoryItem, ReviewHistoryQuery, ReviewHistoryResponse,
  StudyStatsQuery, StudyStatsResponse,
  TopLapsedCard, TopLapsedQuery, TopLapsedResponse,
  ReviewLogEntry, Flashcard, CardState, ReviewRating,
  MAX_EMBEDDED_REVIEW_LOG, TOP_LAPSED_LIMIT,
} from './types';
import {
  HistoryFilters,
  historyFiltersKey, makeHistoryPageToken, readHistoryPageToken,
  tsToDate, eventToHistoryItem, buildStudyStats, AggregatedCounters,
} from './analytics';

const EVENTS_COLLECTION = 'reviewEvents';
const CARDS_COLLECTION = 'flashcards';
const HISTORY_PAGE_SIZE_MAX = 100;
const HISTORY_PAGE_SIZE_DEFAULT = 50;
const BATCH_WRITE_LIMIT = 500;
const FRONT_SNAPSHOT_MAX = 300;

let db: Firestore | undefined;
function getDb(): Firestore {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* Card snapshot mapping (same read semantics as service.docToFlashcard) */
/* ------------------------------------------------------------------ */

/** Maps a card document to the entity the analytics surfaces need. */
export function cardFromSnapshot(doc: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>): Flashcard {
  const data = doc.data();
  if (!data) {
    throw new Error('Document data is undefined');
  }
  return {
    id: doc.id,
    ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
    front: data.front,
    back: data.back,
    ...(data.deck !== undefined ? { deck: data.deck as string } : {}),
    ...(data.deckId !== undefined ? { deckId: data.deckId as string } : {}),
    tags: Array.isArray(data.tags) ? data.tags as string[] : [],
    ...(data.topic !== undefined ? { topic: data.topic as string } : {}),
    ...(data.suspended !== undefined ? { suspended: data.suspended as boolean } : { suspended: false }),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
    due: data.due as Timestamp,
    state: (data.state === 0 || data.state === 1 || data.state === 2 || data.state === 3) ? data.state as CardState : 0,
    stability: typeof data.stability === 'number' ? data.stability : 0,
    difficulty: typeof data.difficulty === 'number' ? data.difficulty : 0,
    reps: typeof data.reps === 'number' ? data.reps : 0,
    lapses: typeof data.lapses === 'number' ? data.lapses : 0,
    ...(data.lastReview ? { lastReview: data.lastReview as Timestamp } : {}),
    reviewLog: Array.isArray(data.reviewLog) ? data.reviewLog as ReviewLogEntry[] : [],
    images: Array.isArray(data.images) ? data.images : [],
  };
}

/** Deserializes a stored event document into the ReviewEvent entity. */
function eventFromSnapshot(doc: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>): ReviewEvent {
  const data = doc.data();
  if (!data) {
    throw new Error('Document data is undefined');
  }
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    id: doc.id,
    ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
    cardId: data.cardId as string,
    actorId: data.actorId as string,
    rating: (data.rating as ReviewRating),
    stateBefore: (data.stateBefore ?? data.state ?? 0) as CardState,
    ...(data.dueBefore !== undefined || data.due !== undefined ? { dueBefore: (data.dueBefore ?? data.due) as Timestamp } : {}),
    ...(data.dueAfter !== undefined ? { dueAfter: data.dueAfter as Timestamp } : {}),
    stabilityAfter: num(data.stabilityAfter ?? data.stability),
    difficultyAfter: num(data.difficultyAfter ?? data.difficulty),
    repsAfter: num(data.repsAfter ?? data.reps),
    lapsesAfter: num(data.lapsesAfter ?? data.lapses),
    reviewedAt: data.reviewedAt as Timestamp,
    // recordedAt defaults to reviewedAt only when both legacy fallbacks are
    // absent (never the epoch) — a faithful approximation for ancient docs.
    recordedAt: (data.recordedAt ?? data.createdAt ?? data.reviewedAt) as Timestamp,
    ...(data.deckId !== undefined ? { deckId: data.deckId as string } : {}),
    ...(data.deckName !== undefined ? { deckName: data.deckName as string } : {}),
    cardFrontSnapshot: typeof data.cardFrontSnapshot === 'string' ? data.cardFrontSnapshot : '',
    ...(data.sessionId !== undefined ? { sessionId: data.sessionId as string } : {}),
    ...(data.requestId !== undefined ? { requestId: data.requestId as string } : {}),
    ...(typeof data.deltaDays === 'number' ? { deltaDays: data.deltaDays as number } : {}),
  };
}

/** Truncates the front snapshot to the bounded length. */
export function frontSnapshot(front: string): string {
  if (front.length <= FRONT_SNAPSHOT_MAX) return front;
  return `${front.slice(0, FRONT_SNAPSHOT_MAX - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* Event document construction (used INSIDE the review transactions)   */
/* ------------------------------------------------------------------ */

/** Deterministic document id for a session event: `evt-<ownerId>-<requestId>`,
 *  scoped to the session owner so a requestId can never collide across
 *  tenants. New (v2) sessions always carry an owner and use this form. */
export function sessionEventId(ownerId: string, requestId: string): string {
  return `evt-${ownerId}-${requestId}`;
}

/** Deterministic document id for a LEGACY (v1/no-owner) session event:
 *  `evt-<requestId>` — the historical id format, preserved so retries of
 *  pre-owner-scoping sessions keep finding their recorded events. */
export function legacySessionEventId(requestId: string): string {
  return `evt-${requestId}`;
}

/** The inputs the review transactions pass to buildEventBody. */
export interface ReviewEventContext {
  /** The owner performing the review (verified Auth0 `sub`, or `'emulator'`). */
  ownerId: string;
  rating: ReviewRating;
  card: Flashcard;
  /** FSRS scheduling fields AFTER the review. */
  scheduling: Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'due' | 'lastReview'>;
  reviewedAt: Timestamp;
  recordedAt: Timestamp;
  sessionId?: string;
  requestId?: string;
}

/**
 * Builds the immutable event document body from a review outcome. Pure —
 * the transaction callers serialize the result with a merge:false set.
 */
export function buildEventBody(context: ReviewEventContext): Omit<ReviewEvent, 'id'> {
  const card = context.card;
  const reviewedMs = tsToDate(context.reviewedAt).getTime();
  let refMs: number | undefined;
  if (card.lastReview) {
    refMs = tsToDate(card.lastReview).getTime();
  } else if (card.createdAt) {
    refMs = tsToDate(card.createdAt).getTime();
  }
  const delta = refMs !== undefined
    ? Math.round(((reviewedMs - refMs) / 86_400_000) * 10) / 10
    : undefined;
  return {
    cardId: card.id,
    ownerId: context.ownerId,
    // `actorId` is retained on the wire/document for backward compatibility
    // (pre-owner-scoped events and clients); going forward it equals the
    // ownerId (the verified identity that performed the review).
    actorId: context.ownerId,
    rating: context.rating,
    stateBefore: card.state,
    dueBefore: card.due,
    dueAfter: context.scheduling.due,
    stabilityAfter: context.scheduling.stability,
    difficultyAfter: context.scheduling.difficulty,
    repsAfter: context.scheduling.reps,
    lapsesAfter: context.scheduling.lapses,
    reviewedAt: context.reviewedAt,
    recordedAt: context.recordedAt,
    ...(card.deckId !== undefined ? { deckId: card.deckId } : {}),
    ...(card.deck !== undefined ? { deckName: card.deck } : {}),
    cardFrontSnapshot: frontSnapshot(card.front),
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(delta !== undefined ? { deltaDays: delta } : {}),
  };
}

/**
 * Bounds a card's embedded reviewLog to the newest MAX_EMBEDDED_REVIEW_LOG
 * entries (oldest-first order preserved). Older entries are recoverable
 * from the reviewEvents collection.
 */
export function trimEmbeddedReviewLog(log: ReviewLogEntry[]): ReviewLogEntry[] {
  if (log.length <= MAX_EMBEDDED_REVIEW_LOG) return log;
  return log.slice(log.length - MAX_EMBEDDED_REVIEW_LOG);
}

/* ------------------------------------------------------------------ */
/* Review history (GET)                                                */
/* ------------------------------------------------------------------ */

/**
 * Reads a page of the owner's review events, newest first.
 *
 * SCOPING: `ownerId` is always the first predicate. FILTERS combine by AND
 * (`cardId`, `deckId`, `rating`, `reviewedAt` `[from, to)` — from
 * INCLUSIVE, to EXCLUSIVE). PAGINATION: `pageToken` is an opaque base64url
 * cursor encoding the last boundary `(lastReviewedAtMs, lastId)` plus a
 * fingerprint of the filters — a token combined with different filters is
 * rejected. Ordering is reviewedAt DESC with document-id ASC tie-break;
 * each page reads at most pageSize + 1 event documents.
 */
export async function getReviewHistory(
  query: ReviewHistoryQuery,
  ownerId: string,
): Promise<ReviewHistoryResponse> {
  const pageSize = Math.min(query.pageSize ?? HISTORY_PAGE_SIZE_DEFAULT, HISTORY_PAGE_SIZE_MAX);
  const ratings = Array.isArray(query.ratings) && query.ratings.length > 0
    ? [...new Set(query.ratings)].sort((a, b) => a - b)
    : undefined;
  const filters: HistoryFilters = {
    ...(query.from !== undefined ? { fromMs: Date.parse(query.from) } : {}),
    ...(query.to !== undefined ? { toMs: Date.parse(query.to) } : {}),
    ...(query.cardId !== undefined && query.cardId !== '' ? { cardId: query.cardId } : {}),
    ...(query.deckId !== undefined && query.deckId !== '' ? { deckId: query.deckId } : {}),
    ...(ratings !== undefined ? { ratings } : {}),
  };

  let cursor: { lastReviewedAtMs: number; lastId: string } | null = null;
  if (query.pageToken) {
    const payload = readHistoryPageToken(query.pageToken);
    if (!payload) {
      throw new Error('Invalid pageToken');
    }
    if (payload.filtersKey !== historyFiltersKey(filters)) {
      throw new Error('pageToken does not match the given filters');
    }
    cursor = { lastReviewedAtMs: payload.lastReviewedAtMs, lastId: payload.lastId };
  }

  let q = getDb().collection(EVENTS_COLLECTION)
    .where('ownerId', '==', ownerId)
    .orderBy('reviewedAt', 'desc')
    .orderBy(FieldPath.documentId());
  if (filters.cardId !== undefined) q = q.where('cardId', '==', filters.cardId);
  if (filters.deckId !== undefined) q = q.where('deckId', '==', filters.deckId);
  if (filters.ratings !== undefined) q = q.where('rating', 'in', filters.ratings);
  if (filters.fromMs !== undefined) q = q.where('reviewedAt', '>=', Timestamp.fromMillis(filters.fromMs));
  if (filters.toMs !== undefined) q = q.where('reviewedAt', '<', Timestamp.fromMillis(filters.toMs));
  if (cursor) {
    q = q.startAfter(Timestamp.fromMillis(cursor.lastReviewedAtMs), cursor.lastId);
  }

  const snap = await q.limit(pageSize + 1).get();
  const docs = snap.docs;
  const hasMore = docs.length > pageSize;
  const pageDocs = docs.slice(0, pageSize);

  const events: ReviewHistoryItem[] = pageDocs.map((doc) => eventToHistoryItem(eventFromSnapshot(doc)));

  let nextPageToken: string | null = null;
  if (hasMore && pageDocs.length > 0) {
    const lastEvent = eventFromSnapshot(pageDocs[pageDocs.length - 1]);
    nextPageToken = makeHistoryPageToken(filters, tsToDate(lastEvent.reviewedAt).getTime(), lastEvent.id);
  }
  return { events, nextPageToken };
}

/* ------------------------------------------------------------------ */
/* Study stats (read-time aggregation)                                 */
/* ------------------------------------------------------------------ */

/**
 * Computes the study stats of a scope by read-time AGGREGATION over the
 * actor's `reviewEvents` — Firestore count() aggregations over the filtered
 * scope, NEVER downloading every matching event. The scope is the whole
 * library, one card (`cardId`), or one deck (`deckId`), optionally bounded
 * by `[from, to)` on reviewedAt. Rating histograms are named
 * (again/hard/good/easy); retention definitions are exact:
 *  - observedRetention = successful reviews (2/3/4) / totalReviews.
 *  - matureReviews = events with stateBefore in [2, 3].
 *  - matureRetention = successful mature reviews / matureReviews.
 * The top-lapsed ranking is attached from the flashcards collection (an
 * indexed query, at most TOP_LAPSED_LIMIT rows) — never an event scan.
 */
export async function getStudyStats(
  query: StudyStatsQuery,
  ownerId: string,
): Promise<StudyStatsResponse> {
  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  const scopeQ = (base: FirebaseFirestore.Query): FirebaseFirestore.Query => {
    let q = base.where('ownerId', '==', ownerId);
    if (query.deckId !== undefined) q = q.where('deckId', '==', query.deckId);
    q = q.where('reviewedAt', '>=', Timestamp.fromMillis(fromMs));
    q = q.where('reviewedAt', '<', Timestamp.fromMillis(toMs));
    return q;
  };

  const runCount = async (q: FirebaseFirestore.Query): Promise<number> => {
    if (typeof q.count !== 'function') {
      throw new Error('count() aggregation is not available on this Firestore runtime');
    }
    const snap = await q.count().get();
    const c = snap.data().count;
    return typeof c === 'number' ? c : 0;
  };

  const events = () => getDb().collection(EVENTS_COLLECTION);
  const ratingCount = async (rating: ReviewRating): Promise<number> =>
    runCount(scopeQ(events()).where('rating', '==', rating));
  const matureCount = async (rating?: ReviewRating): Promise<number> => {
    let q = scopeQ(events()).where('stateBefore', 'in', [2, 3]);
    if (rating !== undefined) q = q.where('rating', '==', rating);
    return runCount(q);
  };

  const [totalReviews, rAgain, rHard, rGood, rEasy, matureReviews] = await Promise.all([
    runCount(scopeQ(events())),
    ratingCount(1), ratingCount(2), ratingCount(3), ratingCount(4),
    matureCount(),
  ]);
  const [mAgain, mHard, mGood, mEasy] = await Promise.all([
    matureCount(1), matureCount(2), matureCount(3), matureCount(4),
  ]);

  const counters: AggregatedCounters = {
    totalReviews,
    ratingCounts: { again: rAgain, hard: rHard, good: rGood, easy: rEasy },
    matureReviews,
    matureRatingCounts: { again: mAgain, hard: mHard, good: mGood, easy: mEasy },
  };

  const topLimit = query.topLimit ?? 10;
  const topLapsedCards = (await getTopLapsedCards({ deckId: query.deckId, limit: topLimit }, ownerId)).cards;
  return buildStudyStats(counters, { from: fromIso, to: toIso }, topLapsedCards);
}
/* ------------------------------------------------------------------ */
/* Top-lapsed cards (current all-time ranking)                         */
/* ------------------------------------------------------------------ */

/**
 * Ranks the cards by their CURRENT all-time lapse count — the cards'
 * PERSISTED `lapses` field (the exact ts-fsrs lapse counter), read at
 * request time via an INDEXED orderBy query on the flashcards collection.
 * Zero-lapse cards are excluded (lapses > 0 predicate), at most
 * TOP_LAPSED_LIMIT (25) rows. The optional deck filter (`deckId`) applies
 * to the card query. Cost: one indexed query + <= limit document reads
 * (each ranked row IS its document — never an N+1 over per-card event
 * reads, never an event scan).
 */
export async function getTopLapsedCards(
  query: TopLapsedQuery,
  ownerId: string,
): Promise<TopLapsedResponse> {
  const limit = Math.min(query.limit ?? 10, TOP_LAPSED_LIMIT);
  const deckId = query.deckId !== undefined && query.deckId !== '' ? query.deckId : undefined;

  // PROJECTED read: fetch ONLY the fields the ranking needs (front, deck
  // references, lapses, reps, lastReview) — never whole card documents, and
  // no assumption that the card's scheduling fields are present. The query
  // is owner-scoped (a card-state ranking never crosses tenants).
  let q = getDb().collection(CARDS_COLLECTION)
    .where('ownerId', '==', ownerId)
    .where('lapses', '>', 0)
    .orderBy('lapses', 'desc')
    .select('front', 'deckId', 'deck', 'lapses', 'reps', 'lastReview');
  if (deckId !== undefined) q = q.where('deckId', '==', deckId);
  const snap = await q.limit(limit).get();
  const cards: TopLapsedCard[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as {
      front?: unknown; deckId?: unknown; deck?: unknown;
      lapses?: unknown; reps?: unknown; lastReview?: unknown;
    };
    cards.push({
      cardId: doc.id,
      lapses: typeof d.lapses === 'number' ? d.lapses : 0,
      reps: typeof d.reps === 'number' ? d.reps : 0,
      front: typeof d.front === 'string' ? d.front : '',
      ...(typeof d.deckId === 'string' && d.deckId !== '' ? { deckId: d.deckId } : {}),
      ...(typeof d.deck === 'string' && d.deck !== '' ? { deckName: d.deck } : {}),
      ...(d.lastReview !== undefined && d.lastReview !== null ? { lastReview: tsToDate(d.lastReview).toISOString() } : {}),
    });
  }
  return { cards };
}

/* ------------------------------------------------------------------ */
/* Legacy reviewLog backfill migration                                 */
/* ------------------------------------------------------------------ */

/** Deterministic event id for a migrated legacy log entry. */
export function legacyEventId(cardId: string, reviewedAtMs: number, index: number): string {
  return `legacy-${cardId}-${reviewedAtMs}-${index}`;
}

/** Result of one migrateLegacyReviewEvents call. */
export interface MigrateReviewEventsResult {
  cardsMigrated: number;
  eventsWritten: number;
  hasMore: boolean;
  /**
   * Resume cursor for the next call: the id of the LAST card document
   * scanned this call (the last doc of the page). Pass it as
   * `resumeAfterCardId` to continue safely without guessing — pages advance
   * by document id, so this is the exact exclusive lower bound of the next
   * page. Null when nothing was scanned (empty page).
   */
  nextResumeAfterCardId: string | null;
}

/**
 * Explicit, idempotent, paged migration: backfills `reviewEvents` documents
 * from card-embedded `reviewLog` arrays written before the event model
 * shipped. The embedded log is bounded to the newest MAX_EMBEDDED_REVIEW_LOG
 * entries per card (older entries were already trimmed and are
 * unrecoverable), so the migration covers exactly the recoverable window.
 *
 * The event actor is the VERIFIED OPERATOR IDENTITY (`operatorOwnerId`,
 * derived from the authenticated request's Auth0 `sub` — never a
 * caller-supplied string) and is recorded as both `ownerId` and `actorId`,
 * so migrated entries never enter another tenant's history/stats scope.
 * Each migrated event uses the deterministic id
 * `legacy-<cardId>-<reviewedAtMs>-<index>`,
 * a pre-write existence check skips already-migrated events (idempotent),
 * and pages advance with an id cursor. `dueAfter` is derived from the next
 * (newer) log entry's due when one exists; for a card's NEWEST entry it
 * falls back to the card's CURRENT `due` (that entry's scheduling outcome)
 * when available, else it is omitted (never defaulted to the epoch).
 *
 * The result carries `nextResumeAfterCardId` (the id of the last card doc
 * scanned this call): pass it as `resumeAfterCardId` on the next call to
 * continue exactly where this call stopped — no guessing.
 *
 * Cards are paged by document id ONLY (no `reviewLog` query predicate):
 * the reviewLog field has NO single-field index (see firestore.indexes.json
 * fieldOverrides — it is display/history data, never filtered or sorted), so
 * the migration scans cards and skips those with an empty embedded log in
 * memory.
 */
export async function migrateLegacyReviewEvents(
  options: { pageSize?: number; operatorOwnerId: string; resumeAfterCardId?: string },
): Promise<MigrateReviewEventsResult> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const operatorOwnerId = options.operatorOwnerId;

  // Page cards by document id ONLY — no reviewLog predicate, so the
  // reviewLog field carries no single-field index (see firestore.indexes.json
  // fieldOverrides). Cards whose embedded log is empty are skipped in memory.
  let q = getDb().collection(CARDS_COLLECTION)
    .orderBy(FieldPath.documentId())
    .limit(pageSize);
  if (options.resumeAfterCardId) {
    const resumeDoc = await getDb().collection(CARDS_COLLECTION).doc(options.resumeAfterCardId).get();
    if (resumeDoc.exists) q = q.startAfter(resumeDoc);
  }
  const snap = await q.get();
  const docs = snap.docs;
  const hasMore = docs.length >= pageSize;

  const now = Timestamp.now();
  const toWrite: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  let cardsMigrated = 0;

  for (const doc of docs) {
    const data = doc.data();
    const log = Array.isArray(data?.reviewLog) ? data.reviewLog as ReviewLogEntry[] : [];
    if (log.length === 0) continue;
    const refs = log.map((entry, index) => getDb().collection(EVENTS_COLLECTION)
      .doc(legacyEventId(doc.id, tsToDate(entry.review).getTime(), index)));
    const existingSnaps = await Promise.all(refs.map((ref) => ref.get()));
    let wroteCard = false;
    for (let i = 0; i < log.length; i += 1) {
      if (existingSnaps[i].exists) continue;
      const entry = log[i];
      const nextEntry = log[i + 1];
      // dueAfter: the next (newer) log entry's due when one exists; for the
      // NEWEST entry the card's CURRENT due is its scheduling outcome, so it
      // is the faithful dueAfter when available; else omitted (never defaulted).
      const dueAfter = nextEntry ? nextEntry.due
        : (i === log.length - 1 ? (data?.due as Timestamp | undefined) : undefined);
      const record: Record<string, unknown> = {
        cardId: doc.id,
        ownerId: operatorOwnerId,
        actorId: operatorOwnerId,
        rating: entry.rating,
        stateBefore: entry.state,
        dueBefore: entry.due,
        ...(dueAfter !== undefined ? { dueAfter } : {}),
        stabilityAfter: entry.stability,
        difficultyAfter: entry.difficulty,
        repsAfter: entry.reps,
        lapsesAfter: entry.lapses,
        reviewedAt: entry.review,
        recordedAt: now,
        cardFrontSnapshot: typeof data?.front === 'string' ? frontSnapshot(data.front as string) : '',
      };
      toWrite.push({ ref: refs[i], data: record });
      wroteCard = true;
    }
    if (wroteCard) cardsMigrated += 1;
  }

  for (let i = 0; i < toWrite.length; i += BATCH_WRITE_LIMIT) {
    const chunk = toWrite.slice(i, i + BATCH_WRITE_LIMIT);
    const batch = getDb().batch();
    for (const w of chunk) {
      batch.set(w.ref, w.data, { merge: false });
    }
    await batch.commit();
  }
  const lastCardId = docs.length > 0 ? docs[docs.length - 1].id : null;
  return { cardsMigrated, eventsWritten: toWrite.length, hasMore, nextResumeAfterCardId: lastCardId };
}

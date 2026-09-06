import { Timestamp } from 'firebase-admin/firestore';

/** FSRS rating for a review (mirrors ts-fsrs Rating): 1=Again, 2=Hard, 3=Good, 4=Easy. */
export const REVIEW_RATINGS = [1, 2, 3, 4] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

/** FSRS scheduling state of a card (mirrors ts-fsrs State): 0=New, 1=Learning, 2=Review, 3=Relearning. */
export const CARD_STATES = [0, 1, 2, 3] as const;
export type CardState = (typeof CARD_STATES)[number];

/** Content type of a flashcard (drives rendering and review interaction). */
export const CARD_TYPES = ['qa', 'cloze'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Full name of the card-type review modes, for human-readable tags. */
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  qa: 'Q&A',
  cloze: 'Cloze',
};

/**
 * A cloze deletion marker embedded in `front` text, e.g. `[Berlin]` in
 * "The capital of Germany is [Berlin]". Canonical form: exactly one
 * `[answer]` token; all other brackets are treated as literal text.
 */
export const CLOZE_MARKER_RE = /\[([^[\]]+)\]/;

/** A response the user gives while reviewing a card (typed input, not a rating). */
export interface SelfTestAnswer {
  /** The user's typed response (text), already trimmed. */
  text: string;
  /** True when the user opted to reveal the answer instead of answering. */
  revealed?: boolean;
}
/**
 * Result of locally evaluating a user's typed response against the card's
 * answer (exact/normalized comparison). Deterministic and pure: the verdict
 * is produced by string normalization + equality, never by a semantic judge.
 * Every submitted answer gets an explicit outcome — the caller never falls
 * back to an AI/semantic evaluation.
 */
export type Evaluation =
  | { kind: 'correct'; expected: string }
  | { kind: 'incorrect'; expected: string }
  | { kind: 'revealed' }
  | { kind: 'empty' }
  | { kind: 'no-answer' };

/** One FSRS review record, persisted in the card's `reviewLog` array (oldest first). */
export interface ReviewLogEntry {
  /** The rating given: 1=Again, 2=Hard, 3=Good, 4=Easy. */
  rating: ReviewRating;
  /** Card state before this review: 0=New, 1=Learning, 2=Review, 3=Relearning. */
  state: CardState;
  /** When the review was performed (server time unless the client supplied reviewAt). */
  review: Timestamp;
  /** The card's due time before this review. */
  due: Timestamp;
  /** Stability after this review. */
  stability: number;
  /** Difficulty after this review. */
  difficulty: number;
  /** Number of repetitions completed after this review. */
  reps: number;
  /** Number of lapses (forgotten reviews) after this review. */
  lapses: number;
}

/** Maximum number of image attachments allowed on a single card. */
export const MAX_CARD_IMAGES = 5;

/** Maximum length of an image URL (validated). */
export const MAX_IMAGE_URL_LENGTH = 2048;

/** Maximum decoded image size accepted for upload (10 MiB). */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Maximum base64 payload length for uploads (10 MiB decoded → ~14 MiB base64, with slack). */
export const MAX_IMAGE_DATA_LENGTH = Math.ceil(MAX_IMAGE_UPLOAD_BYTES * 4 / 3) + 8;

/** Maximum upload file name length. */
export const MAX_IMAGE_FILE_NAME_LENGTH = 255;

/**
 * An image attachment on a flashcard.
 *
 * For external URLs (attachImage): the backend stores only the validated URL
 * reference plus optional metadata — never the image bytes.
 *
 * For cloud uploads (uploadImage): the backend stores the bytes in Firebase
 * Storage and persists metadata — id, storagePath, downloadUrl, contentType,
 * sizeBytes, alt, addedAt — with `url` set to the download URL. No image
 * bytes are stored in Firestore.
 */
export interface CardImage {
  /** Stable image id (server-assigned; the Storage object name suffix for cloud images). */
  id: string;
  /** The image URL: the external https(s) URL for URL attachments, or the download URL for cloud images. */
  url: string;
  /** Optional short description / alt text. */
  alt?: string;
  /** Image MIME type, e.g. image/jpeg. Optional for URL attachments; required for cloud images. */
  mimeType?: string;
  /** When the image was attached. */
  addedAt: Timestamp;
  /** Firebase Storage object path (cloud images only), e.g. card-images/{cardId}/{imageId}.jpg. */
  storagePath?: string;
  /** Signed download URL for cloud images. */
  downloadUrl?: string;
  /** Decoded byte size (cloud images only). */
  sizeBytes?: number;
}

export interface AttachImageInput {
  url: string;
  alt?: string;
  mimeType?: string;
}

export interface UploadImageInput {
  /** Base64-encoded image data (decoded size <= MAX_IMAGE_UPLOAD_BYTES). */
  data: string;
  /** Original file name (used for the extension; length <= MAX_IMAGE_FILE_NAME_LENGTH). */
  fileName: string;
  /** Image MIME type (allowed raster types only). */
  contentType: string;
  alt?: string;
}

export interface UploadImageResponse {
  card: Flashcard;
  image: CardImage;
}

export interface RemoveImageInput {
  url: string;
}

export interface AttachImageResponse {
  card: Flashcard;
  image: CardImage;
}

export interface ListImagesResponse {
  cardId: string;
  images: CardImage[];
}

export interface RemoveImageResponse {
  cardId: string;
  /** True when the image was found and removed. */
  removed: boolean;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  /**
   * The owner of this card: the verified Auth0 `sub` (or the fixed
   * `'emulator'` owner in the emulator). Every card document written by a
   * user request carries it, and every user read/list/search/count is
   * scoped to it. Absent on pre-multi-tenant (legacy/unowned) documents —
   * see the ownership backfill policy in README.
   */
  ownerId?: string;
  /**
   * Stable deck reference: the id of a document in the `decks` collection.
   * Absent when the card has no deck. Legacy cards carry a `deck` name string
   * instead (see `deck`); newly written cards always use `deckId` and also
   * store the deck name on `deck` for readable/legacy filtering.
   */
  deckId?: string;
  /**
   * Deck name. Kept on the card for backward compatibility and readable
   * filtering: `listFlashcards?deck=<name>` continues to match cards whose
   * stored `deck` string equals the name, even before migration backfills
   * `deckId`.
   */
  deck?: string;
  tags: string[];
  /**
   * Optional topic label (subject-area grouping) for the card, e.g.
   * "geography" or "spanish-vocab". Optional by design: existing cards never
   * had a topic, and the topic participates in text/topic search (a card
   * matches a search term when it appears in the topic OR front OR back).
   * There is NO separate topic entity/collection — the topic is a free-form
   * string on the card (unlike decks, which are first-class entities).
   * Absent on cards that have no topic.
   */
  topic?: string;
  /**
   * Whether the card is suspended. Default false; ABSENT on documents
   * written before this field existed, in which case it reads as false (see
   * docToFlashcard). Suspended cards are excluded from dueFlashcards, while
   * listFlashcards and review-session queues continue to expose them. The
   * field is also queryable through `search_cards` (`suspended: true|false`);
   * suspended cards never match its `review` facet.
   */
  suspended?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Next review time. New cards are due immediately; reviews advance it via the FSRS scheduler. */
  due: Timestamp;
  /** FSRS scheduling state: 0=New, 1=Learning, 2=Review, 3=Relearning. */
  state: CardState;
  /** FSRS stability (interval in days when the card is in Review/Relearning). */
  stability: number;
  /** FSRS difficulty. */
  difficulty: number;
  /** Number of completed reviews. */
  reps: number;
  /** Number of lapses (forgotten reviews). */
  lapses: number;
  /** Time of the last review, if any. */
  lastReview?: Timestamp;
  /** Full FSRS review history, oldest first. */
  reviewLog: ReviewLogEntry[];
  /** Image attachments (URL references + metadata only; bounded by MAX_CARD_IMAGES). */
  images: CardImage[];
}

export interface CreateFlashcardInput {
  front: string;
  back: string;
  /** Stable deck reference (id of a document in the `decks` collection). `null` explicitly means "no deck". */
  deckId?: string | null;
  /**
   * Legacy deck name. Kept for backward compatibility: when `deckId` is absent
   * and `deck` is provided, a deck with that name is found-or-created and the
   * card is assigned to it. `deckId` takes precedence when both are present.
   */
  deck?: string | null;
  /** Optional free-form topic label (subject-area grouping), e.g. "geography". */
  topic?: string | null;
  /** Sets the persisted suspended attribute (boolean, default false); queryable via search_cards. */
  suspended?: boolean;
  tags?: string[];
}

export interface UpdateFlashcardInput {
  front?: string;
  back?: string;
  /** Stable deck reference. `null` detaches the card from its deck (fields removed). */
  deckId?: string | null;
  /** Legacy deck name (same find-or-create semantics as create). `null` detaches. */
  deck?: string | null;
  /** Optional free-form topic label. `null` removes the topic (field removed). */
  topic?: string | null;
  /** Sets/clears the persisted suspended attribute; queryable via search_cards. */
  suspended?: boolean;
  tags?: string[];
}

export interface ListFlashcardsQuery {
  /** Filter by stable deck id (cards whose `deckId` equals this). */
  deckId?: string;
  /** Legacy filter by deck name (cards whose stored `deck` string equals this). */
  deck?: string;
  tags?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListFlashcardsResponse {
  cards: Flashcard[];
  nextPageToken: string | null;
}

export interface DueFlashcardsQuery {
  /** Filter by stable deck id. */
  deckId?: string;
  /** Legacy filter by deck name. */
  deck?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface DueFlashcardsResponse {
  cards: Flashcard[];
  nextPageToken: string | null;
}

/* ------------------------------------------------------------------ */
/* Card counts (countFlashcards)                                       */
/* ------------------------------------------------------------------ */

/**
 * The count buckets reported by the count endpoint. Bucket definitions
 * mirror the persisted FSRS scheduling state (CARD_STATES in this file:
 * 0=New, 1=Learning, 2=Review, 3=Relearning):
 *  - `new`:      never reviewed — FSRS state New (0), due immediately. This
 *    INCLUDES legacy documents that lack a persisted `state` field (or carry
 *    an invalid one): docToFlashcard reads them as New, and the count
 *    endpoint mirrors that by DERIVING `new = total - learning - mature`
 *    instead of aggregating `state == 0` (a Firestore equality would miss
 *    field-less documents and break the partition invariant).
 *  - `learning`: in short-term learning — FSRS state Learning (1).
 *  - `mature`:   past learning — FSRS state Review (2) OR Relearning (3).
 *    Relearning is the mature-review relapse path (an interval that fell
 *    back to minutes after a lapse), so it is grouped with Review as
 *    "not new, not learning" rather than reported as a separate state.
 *  - `due`:      due for review RIGHT NOW (`due <= now`), matching the
 *    dueFlashcards/review-session due filter exactly. New cards are due
 *    immediately, so they are due; a scheduled card is due once its
 *    `due` instant has arrived, regardless of bucket. `new`/`learning`/
 *    `mature` are exhaustive and partition the collection; `due` overlaps
 *    them (it is a time-based predicate, not a state bucket).
 *  - `total`:    every card matching the filters.
 * `new + learning + mature` always equals `total` by construction.
 */
export interface FlashcardCounts {
  total: number;
  new: number;
  learning: number;
  mature: number;
  /** Cards whose `due` instant has arrived (new cards included). */
  due: number;
}

/**
 * How to break a count down. `deck` produces a WHOLE-LIBRARY per-deck
 * breakdown: one entry per deck ENTITY (its stable `deckId` and current
 * `name`, read from the decks collection) plus a final deck-less remainder
 * entry (`deckId: null`/`deck: null`) for cards that belong to no deck
 * entity. Legacy name-only cards are attributed to their deck via the
 * `deck`-name equality aggregate, never split into separate keys.
 */
export const COUNT_GROUP_BY_MODES = ['deck'] as const;
export type CountGroupByMode = (typeof COUNT_GROUP_BY_MODES)[number];

/**
 * Input for the count endpoint. Deck/tag FILTERS combine by INTERSECTION
 * (AND), with the same semantics as the list/due `deckId`/`deck`/`tags`
 * filters: deckId and deck may BOTH be given, and deckId wins when both are
 * present (the stable reference takes precedence over the legacy name — the
 * list/due convention); tags is ANY-of, comma-separated. Counting never reads card
 * documents — every bucket is a Firestore `count()` aggregation over the
 * filtered set, so it answers "how many cards are in Spanish?" with
 * aggregation only.
 *
 * `groupBy=deck` is a WHOLE-LIBRARY breakdown and is therefore mutually
 * exclusive with the `deckId`/`deck`/`tags` filters (the validator rejects
 * combining them): per-deck counts cannot be expressed as count()
 * aggregations over an already deck/tag-filtered set, so a breakdown never
 * narrows a filter — it REPLACES it. Deck/tag filtering ("how many Spanish
 * cards?", "how many verb-tagged cards?") and deck grouping ("per-deck
 * totals") are separate questions and separate requests.
 */
export interface CountFlashcardsQuery {
  /** Restrict to cards of this deck (stable deck id). */
  deckId?: string;
  /** Restrict to cards whose stored deck name equals this (legacy name filter). */
  deck?: string;
  /** Restrict to cards carrying ANY of these comma-separated tags. */
  tags?: string;
  /** Break the whole-library counts down per deck (see COUNT_GROUP_BY_MODES). */
  groupBy?: CountGroupByMode;
}

/** One deck's counts in a groupBy=deck breakdown. */
export interface CountByDeck {
  /** The stable deck id (`deckId` of the deck entity). `null` = the
   *  remainder entry for cards that belong to no deck entity. */
  deckId: string | null;
  /** The deck's current name (read from the deck entity document). `null`
   *  for the deck-less remainder entry. */
  deck: string | null;
  counts: FlashcardCounts;
}

export interface CountFlashcardsResponse {
  /** Counts over the full filtered set. */
  counts: FlashcardCounts;
  /**
   * Per-deck counts when groupBy=deck was requested (whole-library
   * breakdown). Deck-less cards are reported in a final `deckId: null`
   * entry when any exist. The per-deck `total`s plus the deck-less
   * `total` sum to the top-level `counts.total` (legacy name-only cards
   * are attributed to their deck via the `deck`-name union — never a
   * separate key). Absent otherwise.
   */
  byDeck?: CountByDeck[];
}

/* ------------------------------------------------------------------ */
/* Rich card query (searchCards)                                       */
/* ------------------------------------------------------------------ */

/** Review-state facet of the rich card query. */
export type SearchReviewFilter = 'due' | 'notDue' | 'new' | 'reviewed';

/** Tag semantics for the rich card query. */
export const TAG_MATCH_MODES = ['any', 'all', 'not'] as const;
export type TagMatchMode = (typeof TAG_MATCH_MODES)[number];

/**
 * Input for the rich flashcard query. ALL given filter families combine by
 * INTERSECTION (AND). Within a family:
 *  - `tagsAny`/`tagsAll`/`tagsNot` are mutually exclusive (at most ONE of the
 *    three may be present — a 400 otherwise):
 *      tagsAny:  a card matches when it carries AT LEAST ONE listed tag.
 *      tagsAll:  a card matches only when it carries EVERY listed tag.
 *      tagsNot:  a card matches only when it carries NONE of the listed tags.
 *  - `review` is a single value: due | notDue | new | reviewed.
 *  - `decks` is a list of deck ids (cards whose deckId is any listed value);
 *    `deckNames` matches the denormalized deck name instead. Both families
 *    combine with the other filters by intersection; a deck filter matches
 *    cards with NO deck only when the value never matches them (no-deck cards
 *    never match a positive deck/deckNames filter).
 *  - `suspended` (true = only suspended, false = only active) is honored;
 *    when ABSENT, BOTH suspended and active cards are returned (the rich
 *    query is the only surface that exposes suspended cards).
 *  - `search` matches case-insensitively against the card's `topic` OR
 *    `front` OR `back` (topic is a first-class card field; there is no
 *    separate topic entity).
 *  - `createdFrom`/`createdTo` bound the card `createdAt` timestamp
 *    (inclusive); `updatedFrom`/`updatedTo` bound `updatedAt`. Accepted as
 *    ISO 8601 date-times or plain 'YYYY-MM-DD' dates: date-only LOWER bounds
 *    (`createdFrom`/`updatedFrom`) mean UTC midnight of that day; date-only
 *    UPPER bounds (`createdTo`/`updatedTo`) mean the END of that UTC day
 *    (23:59:59.999). Invalid calendar dates (e.g. 2026-02-31) are rejected.
 *
 * PAGINATION CONTRACT (stable, cursor-based, deterministic): every page
 * returns the page's cards plus an opaque `nextPageToken`. The token encodes
 * the id of the LAST card of the page plus the FULL filter set of the
 * original request (URL-safe base64url JSON), so page 2 re-applies the exact
 * same filters and the ordering is deterministic even when the dataset or the
 * filters change between calls. Ordering: `createdAt` descending, ties by
 * card id ASCENDING — the same total order Firestore applies natively to an
 * `orderBy('createdAt', 'desc')` query (document id is its implicit
 * secondary sort key). The service repeats that secondary order explicitly
 * (`orderBy(FieldPath.documentId())`), so Firestore cursors, the in-memory
 * matcher and the token agree on every boundary. `pageToken` is the ONLY
 * pagination input; a token combined with different filters yields a 400
 * (token-filters mismatch).
 */
export interface SearchCardsQuery {
  /** Free-text search over topic OR front OR back (case-insensitive substring). */
  search?: string;
  /** Tag filters — AT MOST ONE of tagsAny / tagsAll / tagsNot may be present. */
  tagsAny?: string[];
  tagsAll?: string[];
  tagsNot?: string[];
  /** Review-state filter: due | notDue | new | reviewed. */
  review?: SearchReviewFilter;
  /**
   * Stable deck ids, ANY-of. A card matches the deck family when it carries a
   * listed deckId OR a listed deck name (deckNames) — the two lists are
   * alternative identifiers of the same family and UNION within it; the
   * family still combines with every other filter by AND.
   */
  decks?: string[];
  /** Legacy denormalized deck names, ANY-of (same union semantics as `decks`). */
  deckNames?: string[];
  /** true = only suspended cards, false = only active cards. Absent = both. */
  suspended?: boolean;
  /** Inclusive lower bound on createdAt (ISO 8601 or YYYY-MM-DD). */
  createdFrom?: string;
  /** Inclusive upper bound on createdAt (ISO 8601 or YYYY-MM-DD). */
  createdTo?: string;
  /** Inclusive lower bound on updatedAt (ISO 8601 or YYYY-MM-DD). */
  updatedFrom?: string;
  /** Inclusive upper bound on updatedAt (ISO 8601 or YYYY-MM-DD). */
  updatedTo?: string;
  pageSize?: number;
  /** Opaque cursor from a previous response. Must pair with identical filters. */
  pageToken?: string;
}

/** The card entity with the exact filters that produced this page. */
export interface SearchCardsResponse {
  cards: Flashcard[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextPageToken: string | null;
}

export interface ReviewFlashcardInput {
  rating: ReviewRating;
  /** Optional review time (ISO 8601). Defaults to the server's current time. */
  reviewAt?: string;
}

export interface ReviewFlashcardResponse {
  card: Flashcard;
  reviewLogItem: ReviewLogEntry;
}

/* ------------------------------------------------------------------ */
/* Scheduling management (reset / set-due / suspend / unsuspend)       */
/* ------------------------------------------------------------------ */

/**
 * Target card ids of an explicit scheduling-management operation
 * (resetFlashcards / setFlashcardDueDate / suspendFlashcards /
 * unsuspendFlashcards). Each card id may appear at most once — duplicates
 * are rejected at validation (a duplicate would make the "ids in input
 * order" result ambiguous, so they are never silently deduped).
 */
export interface SchedulingActionInput {
  ids: string[];
}

/** Input for `setFlashcardDueDate`: the target card ids plus the new due instant. */
export interface SetFlashcardDueDateInput extends SchedulingActionInput {
  /** The due time to write: a full ISO 8601 date-time (e.g.
   *  `2026-09-10T08:00:00.000Z`) or a plain `YYYY-MM-DD` (UTC midnight of
   *  that day). Must be a valid calendar date. */
  due: string;
}

/**
 * Shared response of the explicit scheduling-management operations. Follows
 * the established bulk-op convention: the operation commits atomically in
 * one transaction over the cards that EXIST — ids that do not exist are
 * omitted from the result (never an error, never a partial failure), and
 * `ids`/`count`/`cards` describe exactly the cards that were changed, in
 * input order.
 */
export interface SchedulingActionResponse {
  /** The ids the operation applied to, in input order (existing cards only). */
  ids: string[];
  /** Number of cards changed — always `ids.length`. */
  count: number;
  /** The updated cards, in input order. */
  cards: Flashcard[];
}

/**
 * Maximum number of card ids accepted by one scheduling-management call
 * (resetFlashcards / setFlashcardDueDate / suspendFlashcards /
 * unsuspendFlashcards). These operations perform one read + one write per
 * card inside a single transaction, so the bound mirrors BULK_LIMIT — the
 * same predictable cap as the bulk create/update/delete APIs.
 */
export const SCHEDULING_ACTION_LIMIT = 100;

/** Maximum number of items allowed in one bulk operation (create/update/delete).
 * Stays well under Firestore's 500-operation batch/transaction limit (bulk
 * update/delete do one read + one write per item), keeps request payloads
 * modest, and gives clients a single predictable bound across all bulk ops. */
export const BULK_LIMIT = 100;

/** Input for atomic bulk create: every card is validated before any write. */
export interface BulkCreateFlashcardsInput {
  cards: CreateFlashcardInput[];
}

export interface BulkCreateFlashcardsResponse {
  cards: Flashcard[];
}

/** One bulk update item: the target card id plus an optional partial patch. */
export type BulkUpdateFlashcardItem = { id: string } & UpdateFlashcardInput;

export interface BulkUpdateFlashcardsInput {
  cards: BulkUpdateFlashcardItem[];
}

export interface BulkUpdateFlashcardsResponse {
  cards: Flashcard[];
}

export interface BulkDeleteFlashcardsInput {
  ids: string[];
}

export interface BulkDeleteFlashcardsResponse {
  deletedIds: string[];
}

/* ------------------------------------------------------------------ */
/* Deck entities                                                       */
/* ------------------------------------------------------------------ */

/** A deck: a named grouping of flashcards (cards reference it by `deckId`). */
export interface Deck {
  id: string;
  /**
   * The owner of this deck (verified Auth0 `sub`, or `'emulator'` in the
   * emulator). All user deck reads/mutations are owner-scoped; absent on
   * pre-multi-tenant (legacy/unowned) documents.
   */
  ownerId?: string;
  name: string;
  /** Optional human-readable description. */
  description?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateDeckInput {
  name: string;
  description?: string;
}

export interface UpdateDeckInput {
  name?: string;
  description?: string;
}

export interface ListDecksQuery {
  pageSize?: number;
  pageToken?: string;
}

export interface ListDecksResponse {
  decks: Deck[];
  nextPageToken: string | null;
}

/** Result of deleting a deck: the deck is removed and its cards are detached. */
export interface DeleteDeckResult {
  deleted: boolean;
  /** Number of cards that were detached from the deck (their `deckId`/`deck` fields removed). */
  detachedCards: number;
}

/* ------------------------------------------------------------------ */
/* Tag management (list / rename / delete / merge)                     */
/* ------------------------------------------------------------------ */

/**
 * Lower/upper bound of a tag name, shared by the tag-management endpoints
 * (list/rename/delete/merge) and identical to the per-tag bound enforced on
 * every card's `tags` array by the create/update/bulk validators (1–50
 * characters). There is NO tag entity/collection: a tag is a derived
 * distinct value inside the `tags` string array of flashcard documents, and
 * the tag-management endpoints operate on exactly those stored names.
 */
export const MIN_TAG_NAME_LENGTH = 1;
export const MAX_TAG_NAME_LENGTH = 50;

/** One distinct tag derived from the flashcards' `tags` arrays. */
export interface TagSummary {
  /** The exact, case-sensitive tag name as stored on cards. */
  name: string;
  /** Number of cards carrying this tag. */
  cardCount: number;
}

export interface ListTagsQuery {
  pageSize?: number;
  pageToken?: string;
}

export interface ListTagsResponse {
  tags: TagSummary[];
  nextPageToken: string | null;
}

/** Input for renaming a tag: replace `from` with `to` on every card carrying `from`. */
export interface RenameTagInput {
  from: string;
  to: string;
}

/**
 * Result of a tag-management mutation (rename/delete/merge). There is no tag
 * entity to report on: every operation rewrites the `tags` arrays of
 * flashcards, so the result is the number of CARD documents that were
 * changed. A tag name that no card carries is a successful no-op
 * (`affectedCards: 0`) — matching a missing tag is never an error.
 */
export interface TagActionResult {
  /** Number of card documents whose `tags` array was rewritten. */
  affectedCards: number;
}

/** Input for deleting a tag: remove it from every card carrying it. */
export interface DeleteTagInput {
  name: string;
}

/** Input for merging tags: union `from` into `to` (remove `from`, ensure `to`). */
export interface MergeTagsInput {
  from: string;
  to: string;
}

/* ------------------------------------------------------------------ */
/* Review session entities                                             */
/* ------------------------------------------------------------------ */

/**
 * The review session mode. Only `spaced_repetition` exists today; the field
 * is structured so future modes (e.g. cramming) can be added without
 * breaking the wire contract.
 */
export const SESSION_MODES = ['spaced_repetition'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/**
 * Lifecycle of a review session:
 *  - `active`: started, has a current card (or an exhausted queue), awaiting ratings.
 *  - `completed`: every snapshot card was reviewed (reached the end of the queue).
 *  - `ended`: abandoned by the client before the queue was exhausted.
 */
export const SESSION_STATUSES = ['active', 'completed', 'ended', 'failed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Ratings applied during a review session, keyed by FSRS rating
 * (1=Again, 2=Hard, 3=Good, 4=Easy). `again`/`hard`/`good`/`easy` are
 * always present (0 when unused); `ratingCounts` repeats the same numbers
 * keyed by rating for machine-friendly access.
 */
export interface SessionRatingCounts {
  again: number;
  hard: number;
  good: number;
  easy: number;
  /** The same counters keyed by FSRS rating number (1=Again, 2=Hard, 3=Good, 4=Easy). */
  ratingCounts: Record<number, number>;
}

/**
 * A persistent review session. The session snapshots the card ids that were
 * due when it started (ordered by due time ascending) so the queue is stable
 * across restarts; each rating
 * atomically applies FSRS scheduling to ONE claimed card and records the
 * claim on the session, so concurrent submissions and retries can never
 * double-apply a review, lose progress, or rate the wrong card.
 *
 * Ratings are addressed by CARD (the card the client is looking at), not by
 * "the current card": a submission may claim any live, unrated card in
 * `cardIds`. `reviewedCardIds` records every claimed card (each card can be
 * claimed exactly once — enforced inside the same transaction that applies
 * the rating). `currentIndex` always points at the FIRST unrated live card,
 * so out-of-order ratings (card N+1 committed before card N) never stall the
 * queue and never corrupt the counters: `reviewedCount` == the number of
 * claims, `ratingCounts` accumulates every applied rating exactly once.
 *
 * Sessions are scoped to the API-key model: every session records the API key
 * name that started it (the same `X-API-Key` used by all other handlers, the
 * `apiKeys` collection) — there is no user identity concept.
 */
export interface ReviewSession {
  id: string;
  /**
   * The owner of this session (verified Auth0 `sub`, or `'emulator'` in the
   * emulator). Session idempotency/ownership checks are owner-scoped; absent
   * on pre-multi-tenant (legacy/unowned) documents.
   */
  ownerId?: string;
  /** The API key name that started the session (from the `apiKeys` collection). */
  apiKeyName: string;
  /** Lifecycle status: active | completed | ended. */
  status: SessionStatus;
  /** Session mode; currently always 'spaced_repetition'. */
  mode: SessionMode;
  /** Optional deck restriction captured at start (card ids were due within it). */
  deckId?: string;
  /**
   * Optional session display name (e.g. the deck name) captured at start.
   * Presentation only — never stored on cards.
   */
  name?: string;
  /**
   * Persisted provenance of the session's card set: what selectors defined
   * the snapshot ('due' | 'deck' | 'custom') plus the selector details
   * (deck id/name, tags, explicit card ids). Echoed on every response so the
   * widget can show the source ("Due cards" / deck name / "Custom") and
   * Continue can replay the exact selection. Absent on sessions created
   * before this field.
   */
  source?: ReviewSessionSource;
  /**
   * Session presentation card type: 'qa' (default) or 'cloze'. Presentation
   * ONLY — the stored card is never modified; the session carries the mode
   * so get/submit/continue resume the same presentation. Persisted on the
   * session document at start and echoed on every response.
   */
  cardType?: CardType;
  /**
   * Storage layout version of the session document. v2 (SESSION_STORAGE_VERSION)
   * roots are BOUNDED: no queue arrays live on the root (cardIds,
   * reviewedCardIds, processedRequestIds are ABSENT); the queue lives in
   * `queueChunks/{paddedChunkIndex}` child documents. Legacy sessions (no
   * field, or 1) keep the full in-root arrays and are routed through the
   * legacy code path unchanged. Absent on v1/no-version documents.
   *
   * v1/v2 TYPE NOTES: on v2 roots `cardIds`, `reviewedCardIds` and
   * `processedRequestIds` are undefined at rest; the type keeps them optional
   * so BOTH layouts share one entity. The legacy v1 code path asserts the
   * arrays are present (documents written before the v2 layout always carry
   * them); the v2 path never reads them.
   */
  storageVersion?: number;
  /** Number of cards snapshotted into this session (v1: equals `cardIds.length`; v2: equals the total queued positions across chunks). */
  limit: number;
  /** Exact number of cards that were due when the session started. */
  dueCount: number;
  /**
   * Number of queue positions still awaiting review (unrated, non-deleted).
   * v1 computes this from the in-root arrays; v2 maintains an EXACT persisted
   * counter on the root (incremented/decremented atomically with each claim
   * and skip), so a bounded response never needs to scan chunks to report
   * remaining progress. v1 sessions do not persist it (computed on responses).
   */
  remainingQueueCount?: number;
  /**
   * v2 total queue positions (equals `limit`; canonical root name totalCount).
   * Present on v2 roots only.
   */
  position?: number;
  /** v2 canonical total queue positions (== limit == position). */
  totalCount?: number;
  /** v2 queue position of the current (next live) card (== currentIndex).
   *  Present on v2 roots only. */
  currentPosition?: number;
  /** v2 chunk ordinal owning `currentPosition` (the ACTIVE chunk; -1 when the
   *  queue is empty). Present on v2 roots only. */
  currentChunkIndex?: number;
  /**
   * v2 exact count of snapshot positions skipped because their card was
   * deleted (maintained atomically with each claim). Present on v2 roots
   * only.
   */
  deletedCount?: number;
  /**
   * Id of the session this session REPEATS — set when a session is started
   * with `repeatSessionId` (the widget's Continue action): the selector
   * provenance is copied from the repeated session and this id records the
   * lineage. v2 keeps the id on the root ONLY (a single string, never an
   * array), so an arbitrarily long Continue chain never grows the document.
   * Legacy sessions that predate the field omit it.
   */
  repeatSessionId?: string;
  /**
   * v2 root fields (BOUNDED metadata — see the storage-layout section):
   *  - `chunkCount`: number of queueChunks child documents (ceil(limit / 200)).
   *  - `completedChunks`: number of chunks whose positions are all rated or
   *    skipped; the first non-completed chunk is the one the next claim or
   *    skip touches. Never read for correctness (the chunk data is
   *    authoritative); kept so start/get can jump straight to the live chunk
   *    without scanning.
   *  - `queueChunksPrefix`: fixed child-collection name ('queueChunks').
   *  - `position` (alias of `totalCount`): total queue positions (= limit).
   *  - `deletedCount`: number of snapshot positions whose card was deleted
   *    (skipped without a rating) — exact, maintained on claims.
   *  - `buildFailed`/`buildError`: when a v2 queue build fails after the root
   *    was written, the root is marked FAILED (status 'failed', buildFailed
   *    true) and is NOT reviewable — start returns null/throws rather than
   *    serving a partial queue.
   *
   * CANONICAL v2 root names (the API mapping exposes these; the legacy
   * aliases limit/currentIndex/remainingQueueCount/position are RETAINED on
   * the stored root for wire compatibility, never root arrays):
   *  - `totalCount`        = total queue positions (== limit).
   *  - `currentPosition`   = queue position of the current (next live) card.
   *  - `currentChunkIndex` = chunk ordinal owning `currentPosition`.
   *  - `remainingCount`    = live unrated positions left (== remainingQueueCount).
   */
  chunkCount?: number;
  completedChunks?: number;
  queueChunksPrefix?: string;
  /** v2 build lifecycle: 'building' (root written, chunks being written —
   *  NOT reviewable), 'ready' (finalized, reviewable), 'failed' (build
   *  failed — NOT reviewable). Present on v2 roots only. */
  buildStatus?: 'building' | 'ready' | 'failed';
  buildFailed?: boolean;
  buildError?: string;
  /**
   * Snapshot of the session card ids, ordered by due time ascending — every
   * matching card, never capped. LEGACY (v1/no-version) sessions ONLY: v2
   * roots deliberately OMIT this array (the queue lives in queueChunks child
   * documents — see `queueChunksPrefix`/chunk summaries). Always present on
   * v1 documents; absent on v2 roots.
   */
  cardIds?: string[];
  /**
   * Index into `cardIds` of the FIRST unrated, non-deleted card — the next
   * card a client should rate. Out-of-order ratings (a later card committed
   * first) keep `currentIndex` at the earliest unrated card until it is
   * claimed, so the queue never stalls and remaining progress is exact.
   */
  currentIndex: number;
  /**
   * Number of cards successfully rated in this session. Always equals
   * `reviewedCardIds.length` (deleted snapshot cards are never claimed and
   * never counted).
   */
  reviewedCount: number;
  /**
   * Number of cards still awaiting review in this session's snapshot:
   * `cardIds.length - currentIndex - (claims at indices > currentIndex)`.
   * Computed on responses, not persisted.
   */
  remainingCount?: number;
  /** True when the snapshot was capped at start (legacy sessions only — new sessions never cap, so this is always false). */
  truncated: boolean;
  /**
   * True when the snapshot was capped at start (a NEW spaced-repetition
   * session could be started after this one completes to cover the rest).
   * Always false on sessions started after the cap was removed; legacy
   * capped sessions keep their stored value. Equal to `truncated`; kept as a
   * named field for clients.
   */
  continuationAvailable: boolean;
  /** Ratings applied so far, keyed by name and by rating number. */
  ratingCounts: SessionRatingCounts;
  /**
   * The cards rated in this session, in claim order. Each card id appears at
   * most once — a claim is recorded atomically with the rating that applied
   * it, so concurrent submissions can never rate the same card twice and a
   * client can never rate a card that was already rated by a sibling request.
   * Parallel submissions may claim cards OUT OF ORDER — any live, unrated
   * card at or after `currentIndex` — and `currentIndex` always advances to
   * the FIRST unrated live card, so the queue never stalls. The widget uses
   * this set (plus its own in-flight submissions) to know exactly which card
   * to display next, independent of response ordering.
   *
   * LEGACY (v1/no-version) sessions ONLY — v2 roots are BOUNDED and omit
   * this array: v2 claim records live in the queueChunks child documents
   * (each queue item carries its rating's `requestId`), so the root
   * never grows with the session. Absent on v2 roots.
   */
  reviewedCardIds?: string[];
  /**
   * Every requestId that has already been applied, in claim order. A retried
   * submission whose requestId is listed here (or equals `lastRequestId`) is
   * a no-op returning the recorded result — a duplicate requestId can never
   * double-apply a rating, even after the session advanced past the rated
   * card. Absent on sessions created before this field.
   *
   * LEGACY (v1/no-version) sessions ONLY — v2 roots are BOUNDED and omit
   * this array: duplicate-requestId detection reads the item's `requestId`
   * in the queueChunks document, never a root array.
   * Absent on v2 roots.
   */
  processedRequestIds?: string[];
  /**
   * Idempotency bookkeeping: the requestId and card id of the most recently
   * applied claim. A retried submission with the same requestId is a no-op
   * (the recorded result is returned), and a retry of ANY earlier requestId
   * is recognized via `processedRequestIds`.
   */
  lastRequestId?: string;
  lastRatedCardId?: string;
  /** When the session was started. */
  startedAt: Timestamp;
  /** When the last rating was applied (active sessions only). */
  lastReviewedAt?: Timestamp;
  /** When the session became completed or ended. */
  endedAt?: Timestamp;
  /**
   * Persisted REVIEW_TEST_MODE flag captured at start. A session started in
   * test mode stays non-mutating (submit skips the card FSRS write) even if
   * the env flag is later disabled mid-session; sessions started normally
   * remain normal. Never present on cards.
   */
  testMode?: boolean;
}

/**
 * What defined the card set of a review session. `due` = the standard due
 * queue (no selectors were given); `deck` = a deck-only selection (by stable
 * deck id and/or deck name); `custom` = any tag and/or explicit card id
 * selection (and every MIXED selection, e.g. deck + tags). The widget shows
 * `due` as "Due cards", `deck` as the deck name, and `custom` as "Custom".
 */
export const SESSION_SOURCE_TYPES = ['due', 'deck', 'custom'] as const;
export type SessionSourceType = (typeof SESSION_SOURCE_TYPES)[number];

/**
 * Persisted provenance of a review session's card set (stored on the session
 * document at start and echoed on every response). The queue is a snapshot:
 * card ids are captured once at start and never re-evaluated.
 */
export interface ReviewSessionSource {
  /** Which selector(s) defined the snapshot: 'due' | 'deck' | 'custom'. */
  type: SessionSourceType;
  /** Stable deck id used as a selector (deck-only selections; also recorded
   *  for mixed selections so the widget can show the deck name). */
  deckId?: string;
  /** Deck name used as a selector — the exact name the user asked for (a
   *  deck-only selection displays this name verbatim in the widget). */
  deckName?: string;
  /**
   * The tag selectors as given (ANY-of semantics — a card matching ANY of
   * them is eligible). Absent when no tag selector was given.
   */
  tags?: string[];
  /**
   * The explicit card-id allowlist as given (deduped, validated to exist,
   * ordered deterministically by the backend). Absent when no ids were given.
   */
  cardIds?: string[];
}

/** Input for starting a review session: optional selectors plus session presentation config (cardType/name). */
export interface StartReviewSessionInput {
  /** Restrict the snapshot to cards of this deck (stable deck id). */
  deckId?: string;
  /**
   * Legacy deck filter by name. Resolved to a stable deck id at start; when
   * given WITHOUT `deckId`, the matching deck's name becomes the session
   * source display name. `deckId` takes precedence when both are present
   * (deck + tags is an intersection; a mixed selection is source 'custom').
   */
  deck?: string;
  /** Restrict the snapshot to cards carrying ANY of these tags (ANY-of,
   *  matching listFlashcards tag semantics). Combined with a deck selector
   *  by intersection; any tag selector makes the source 'custom'. */
  tags?: string[];
  /**
   * Explicit card-id allowlist (deduped; every id must exist or the request
   * fails — missing ids never silently substitute). Any cardIds makes the
   * source 'custom'; combined with deck/tags by INTERSECTION (a card must be
   * in the allowlist AND match the other selectors). May include non-due
   * cards.
   */
  cardIds?: string[];
  /**
   * Session presentation card type: 'qa' (default) or 'cloze'. Presentation
   * ONLY — the stored card is never modified; the session carries the mode
   * so get/submit/continue resume the same presentation.
   */
  cardType?: CardType | null;
  /**
   * Optional user-facing session name (e.g. a deck display name). Shown by
   * clients; never stored on cards. NOTE: the widget always shows the
   * CURRENT CARD's own deck name separately, so a session name can never
   * hide which deck a card belongs to.
   */
  name?: string | null;
  /**
   * Continue lineage: when a session is started as the widget's Continue of
   * a previous (completed) session, this carries the previous session id.
   * v2 keeps the id on the root ONLY — a single bounded string, never an
   * array — so an arbitrarily long Continue chain never grows the document.
   * Legacy sessions that predate the field omit it.
   */
  repeatSessionId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Review-session storage layout (v2)                                  */
/* ------------------------------------------------------------------ */

/**
 * Storage-version marker for the reviewSessions collection. Documents
 * WITHOUT this field (or with storageVersion 1) are the LEGACY layout: the
 * full queue lives on the root document (`cardIds`, `reviewedCardIds`,
 * `processedRequestIds`). Documents with storageVersion 2 store a bounded
 * root plus sharded `queueChunks/{paddedChunkIndex}` child documents that
 * own the queue positions. The field is a positive integer so future
 * layouts can bump it without guessing.
 *
 * Routing rule (service.ts): the v2 path is used ONLY for sessions that
 * PERSISTED with storageVersion === 2. Every other document — legacy v1 and
 * no-version (sessions written before the field existed) — is read and
 * advanced through the legacy in-root code path, byte-for-byte unchanged.
 * The v2 write path never downgrades a document.
 */
export const SESSION_STORAGE_VERSION = 2;

/**
 * Fixed number of queue positions per queue chunk document
 * (`reviewSessions/{sessionId}/queueChunks/<paddedChunkIndex>`). A chunk
 * covers the position range `[chunkIndex * SESSION_QUEUE_CHUNK_SIZE,
 * (chunkIndex + 1) * SESSION_QUEUE_CHUNK_SIZE)`; each chunk stores its
 * card ids at array positions 0..199 (position p lives at
 * chunk.p / SESSION_QUEUE_CHUNK_SIZE, index p % SESSION_QUEUE_CHUNK_SIZE),
 * so a card id is NEVER duplicated across chunks and a chunk document is
 * never rewritten once a later position is claimed.
 *
 * WHY 200: Firestore documents are bounded at 1 MiB, and a queue entry is a
 * card id (~20–60 bytes) plus a claim marker. 200 positions keep every
 * chunk document far under the limit (typically < 20 KiB even with the
 * largest ids), while bounding the number of chunk documents a 25k-card
 * session needs to 125 (25_000 / 200) — a full session sweep at 500
 * positions per page therefore costs ~125 chunk reads. Larger chunks (e.g.
 * 1000) would shave reads but push single writes closer to the document
 * limit and make a chunk rewrite (which never happens in v2) more
 * expensive; smaller chunks would multiply document count and per-page
 * read cost without improving the bound.
 */
export const SESSION_QUEUE_CHUNK_SIZE = 200;

/**
 * Number of upcoming queue positions loaded for the preload window of a
 * v2 start/get/submit response, in ADDITION to the current card.
 *
 * WHY 100: v1 defined SESSION_PRELOAD = 100 for the same wire contract, so
 * keeping the value preserves client behavior exactly while the v2 store
 * changes underneath. The window is bounded by SESSION_QUEUE_CHUNK_SIZE
 * (100 < 200), so a preload never spans more than two chunk documents.
 */
export const SESSION_PRELOAD = 100;

/**
 * Page size used while BUILDING a v2 session's queue: due/selector queries
 * fetch up to 500 card documents per page (projected fields only), append
 * their ids in query order (due ASC, document-id ASC tie-break), and the
 * builder resumes after the last document of each page until the queue is
 * complete.
 *
 * WHY 500: Firestore batches/transactions are capped at 500 operations and
 * a single query result is capped at ~14–17 MiB; 500 projected rows is well
 * within both, keeps each page well under the response limits, and keeps a
 * 25k-card session at ~50 pages (~1s of sequential reads in practice).
 * Smaller pages would multiply round trips for large libraries without
 * improving any bound; larger pages approach the 500-op batch ceiling and
 * inflate per-page transfer for no gain.
 */
export const SESSION_BUILD_PAGE_SIZE = 500;
/**
 * Hard bound on an explicit start-review-session `cardIds` allowlist. The
 * allowlist is an INTERSECTION selector whose cards must be ordered
 * deterministically (due ASC, document id ASC), which requires comparing the
 * due of every allowlisted card — O(k) compact rows is the information floor.
 * Fetching k full card documents simultaneously would be unbounded memory, so
 * the service streams the allowlist in bounded batches and rejects requests
 * above this documented bound with a clear 400 (never silent truncation).
 */
export const SESSION_MAX_ALLOWLIST_IDS = 5000;

/** One queue ITEM within a v2 queueChunks document (a snapshotted card at one
 *  queue position). Lifecycle: `status` is 'pending' (unrated, live),
 *  'reviewed' (rated), or 'deleted' (card deleted since the snapshot, skipped
 *  without a rating). A reviewed item records the submission `requestId`
 *  (idempotency key) and `reviewedAt`; a deleted item records `deletedAt`.
 */
export interface SessionQueueItem {
  /** The snapshotted card id at this queue position. */
  cardId: string;
  /** 'pending' | 'reviewed' | 'deleted' — the item lifecycle status. */
  status: 'pending' | 'reviewed' | 'deleted';
  /** The rating that claimed this item (1=Again..4=Easy) when reviewed. */
  rating?: number;
  /** The review event id / session submission idempotency key (reviewed items
   *  that carried a requestId). Deterministic duplicate-requestId lookup. */
  requestId?: string;
  /** When the review was applied (reviewed items). */
  reviewedAt?: Timestamp;
  /** When the item was skipped because its card was deleted. */
  deletedAt?: Timestamp;
}

/** A queueChunks child document as PERSISTED. Top-level fields are numeric
 *  (chunkIndex), positional (startPosition/itemCount), and lifecycle
 *  (status/pendingCount); the bounded `items` array (≤ SESSION_QUEUE_CHUNK_SIZE)
 *  holds the queue items in position order. */
export interface SessionChunkDocument {
  /** Numeric chunk ordinal (0-based; also the zero-padded doc id). */
  chunkIndex: number;
  /** Absolute queue position of this chunk's first item. */
  startPosition: number;
  /** Number of items in this chunk (≤ SESSION_QUEUE_CHUNK_SIZE). */
  itemCount: number;
  /** Chunk lifecycle: 'active' (may receive claims) or 'completed' (every
   *  item reviewed/deleted). */
  status: 'active' | 'completed';
  /** Live (pending) items remaining in this chunk (exact, maintained). */
  pendingCount: number;
  /** The queue items in position order (index i holds the item at
   *  startPosition + i). */
  items: SessionQueueItem[];
}

/** Summary of one queueChunks document for a bounded v2 response. */
export interface SessionChunkSummary {
  /** Chunk ordinal (0-based). */
  chunkIndex: number;
  /** Absolute queue position of this chunk's first item. */
  startPosition: number;
  /** Number of items in this chunk. */
  itemCount: number;
  /** Live (pending) items remaining. */
  pendingCount: number;
  /** Chunk lifecycle. */
  status: 'active' | 'completed';
  /** Live (non-deleted, unrated) card ids in queue order (never padded). */
  cardIds: string[];
  /** Position of the first live, unrated item, or null when all are rated. */
  firstUnratedIndex: number | null;
  /** The card id at the current (first live, unrated) position. */
  currentCardId: string | null;
}

/** One entry of a bounded v2 queue window: a card id plus its STABLE queue
 *  position (required numeric for v2 responses). */
export interface SessionQueueWindowEntry {
  cardId: string;
  /** 0-based queue position — REQUIRED on v2 responses (the claim target). */
  position: number;
}

/** Bounded v2 session response queue: the current card + a bounded preload
 *  window. NEVER the full queue and NEVER a root cardIds array — the full
 *  queue lives only in the queueChunks child documents. */
export interface SessionQueueWindow {
  /** Position of the session's current card within the FULL queue, or null
   *  when the queue is exhausted (no current card). Stable across chunk
   *  boundaries. */
  currentPosition: number | null;
  /** The current card id (first live, unrated position), or null when the
   *  queue is exhausted. */
  currentCardId: string | null;
  /** The current card plus the upcoming preload window (up to
   *  SESSION_PRELOAD upcoming cards after the current one), ordered by queue
   *  position; each entry carries its REQUIRED stable queue position. */
  cardIds: SessionQueueWindowEntry[];
}

/**
 * A preloaded upcoming card: the card id plus the presentation-relevant
 * fields (front/back/tags/deck name) so a client can render the next cards
 * without extra round-trips. The preload window (up to SESSION_PRELOAD
 * upcoming cards) lets a client render ahead; the authoritative queue
 * remains the session's `cardIds` + `currentIndex`, and
 * `submitSessionReview` still returns the exact next card.
 */
export interface PreloadedCard {
  id: string;
  front: string;
  back: string;
  deck?: string;
  tags: string[];
  /** Stable queue position of this upcoming card (v2 responses always carry
   *  it; absent on legacy v1/no-version responses). */
  position?: number;
}

/** A session plus the card awaiting review and a bounded preloaded queue. */
export interface ReviewSessionWithCard {
  session: ReviewSession;
  /** The current card to review, or null when there is no card left. */
  card: Flashcard | null;
  /** Upcoming cards (after `card`), ordered, the SESSION_PRELOAD-card preload window. */
  preloaded: PreloadedCard[];
  /**
   * Stable position of the session's current card within the FULL queue
   * (0-based, null when the queue is exhausted). v2 responses always carry
   * it; absent on legacy v1/no-version responses.
   */
  currentPosition?: number | null;
  /**
   * Bounded v2 queue window (current position + preload ids) so clients can
   * render ahead WITHOUT the full queue or a root `cardIds` array. Absent on
   * legacy v1/no-version responses (which keep the full root `cardIds`).
   */
  queueWindow?: SessionQueueWindow;
}
/** Input for rating a card of a session (same shape as reviewFlashcard). */
export interface SubmitSessionReviewInput {
  rating: ReviewRating;
  /** Optional review time (ISO 8601). Defaults to the server's current time. */
  reviewAt?: string;
  /**
   * Stable idempotency key (client-generated, e.g. a UUID). When provided,
   * the backend records it on the session and a retried submission with the
   * SAME key is a no-op returning the recorded result — background retries
   * and parallel submissions can never double-apply a rating.
   */
  requestId?: string;
  /**
   * The card id this rating applies to — any LIVE, unrated snapshot card at
   * or after `currentIndex` (parallel submissions may rate cards out of
   * order). When provided, the backend verifies the card exists, is unrated,
   * and is not already claimed; a mismatch or already-rated card fails with a
   * 409-style error so a stale client can never rate the wrong card. Omitted
   * (or absent on a fresh session) falls back to the session's current card.
   */
  expectedCardId?: string;
  /**
   * v2 alternative to `expectedCardId`: the queue POSITION (0-based) the
   * rating applies to. The backend resolves it to the position's card id and
   * applies the same live/unrated/not-claimed guards; it exists so a v2
   * client that does NOT hold full card ids (only `currentPosition` /
   * `queueWindow.cardIds`) can still claim the exact card it displayed.
   * When both are present `expectedCardId` wins after the position is
   * resolved to an id. Absent on v1/no-version sessions.
   */
  expectedPosition?: number;
}
/** Result of a submitted rating, including the idempotency echo and preload. */
export interface SubmitSessionReviewResult {
  session: ReviewSession;
  card: Flashcard | null;
  preloaded: PreloadedCard[];
  /**
   * The queue position of the rating that was just applied (0-based), or of
   * the current card for an idempotent no-op retry. v2 responses always
   * carry it; absent on legacy v1/no-version responses.
   */
  ratedPosition?: number;
  /** Echo of the requestId that produced this result (for idempotent retries). */
  requestId?: string;
  /** v2 stable queue position of the NEXT current card (null when exhausted). */
  currentPosition?: number | null;
  /** v2 bounded queue window after this rating (current + preload ids). */
  queueWindow?: SessionQueueWindow;
}


/* ------------------------------------------------------------------ */
/* Review events (append-only history)                                 */
/* ------------------------------------------------------------------ */

/**
 * One immutable review fact, persisted in its own `reviewEvents` collection
 * document. Every successful NON-TEST direct review (`reviewFlashcard`) and
 * session review (`submitSessionReview`) writes one event in the SAME
 * transaction that applies the FSRS scheduling, so the event log and the
 * card state can never diverge. Event documents are immutable: a retried
 * idempotent session submission NEVER rewrites an event (the write is keyed
 * by the stable requestId and uses a merge:false set that throws when the
 * document exists — the transaction aborts and the duplicate requestId
 * no-ops).
 */
export interface ReviewEvent {
  /** Stable, unique event id (server-generated; the document id). */
  id: string;
  /**
   * The owner of the reviewed card (verified Auth0 `sub`, or `'emulator'`
   * in the emulator). Event history/stats and idempotency lookups are
   * owner-scoped; absent on legacy/migrated unowned events.
   */
  ownerId?: string;
  /** The card that was reviewed. */
  cardId: string;
  /**
   * Stable, immutable authenticated API-key identity of the actor that
   * performed the review: the apiKeys document id (the key itself) when the
   * key is the stable identity, else its immutable key id. Falls back to
   * `'unknown'` when no key was supplied (dev/emulator). Review history and
   * stats are scoped to this actor.
   */
  actorId: string;
  /** The rating given: 1=Again, 2=Hard, 3=Good, 4=Easy. */
  rating: ReviewRating;
  /** Card state BEFORE this review: 0=New, 1=Learning, 2=Review, 3=Relearning. */
  stateBefore: CardState;
  /** The card's due time BEFORE this review (absent when unrecoverable). */
  dueBefore?: Timestamp;
  /** The card's due time AFTER this review (the FSRS-scheduled next review).
   *  Absent when the migration could not recover it (legacy log tail). */
  dueAfter?: Timestamp;
  /** Stability AFTER this review. */
  stabilityAfter: number;
  /** Difficulty AFTER this review. */
  difficultyAfter: number;
  /** Repetitions completed AFTER this review. */
  repsAfter: number;
  /** Lapses AFTER this review. */
  lapsesAfter: number;
  /** When the review was performed (server time, or a client reviewAt). */
  reviewedAt: Timestamp;
  /** When the event document was recorded (server time). */
  recordedAt: Timestamp;
  /** Stable deck id of the card at review time (absent when no deck). */
  deckId?: string;
  /** Deck NAME of the card at review time (absent when no deck). */
  deckName?: string;
  /**
   * Front-text snapshot at review time (trimmed to 300 chars) so history
   * stays readable even after the card is edited or deleted.
   */
  cardFrontSnapshot: string;
  /** Session id when the review happened inside a review session. */
  sessionId?: string;
  /** The session submission's idempotency key (session reviews only). */
  requestId?: string;
  /** Days since the card's previous review (or createdAt) at review time. */
  deltaDays?: number;
}

/** Maximum number of embedded reviewLog entries kept on a card document. */
export const MAX_EMBEDDED_REVIEW_LOG = 100;

/** Input for reading a page of review events. */
export interface ReviewHistoryQuery {
  /** Inclusive lower bound on reviewedAt (ISO 8601 or YYYY-MM-DD). */
  from?: string;
  /** Exclusive upper bound on reviewedAt ([from, to)). */
  to?: string;
  /** Restrict to events of one card. */
  cardId?: string;
  /** Restrict to events recorded while the card was in one deck. */
  deckId?: string;
  /** Restrict to events of ANY of these ratings (1=Again..4=Easy). */
  ratings?: ReviewRating[];
  /** Page size, 1..100 (default 50). */
  pageSize?: number;
  /** Opaque cursor from a previous response. */
  pageToken?: string;
}

/** One review event as returned by the history endpoint (read model). */
export interface ReviewHistoryItem {
  id: string;
  cardId: string;
  actorId: string;
  rating: ReviewRating;
  stateBefore: CardState;
  /** ISO 8601 (whole-millisecond). */
  reviewedAt: string;
  /** ISO 8601 (whole-millisecond). */
  recordedAt: string;
  stabilityAfter: number;
  difficultyAfter: number;
  repsAfter: number;
  lapsesAfter: number;
  /** ISO 8601 of the due time BEFORE this review (absent when unrecoverable). */
  dueBefore?: string;
  /** ISO 8601 of the due time AFTER this review (absent when unrecoverable). */
  dueAfter?: string;
  /** Deck the card belonged to at review time. */
  deckId?: string;
  deckName?: string;
  /** Front-text snapshot at review time (<= 300 chars). */
  cardFrontSnapshot: string;
  sessionId?: string;
}

export interface ReviewHistoryResponse {
  events: ReviewHistoryItem[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextPageToken: string | null;
}

/* ------------------------------------------------------------------ */
/* Study statistics                                                    */
/* ------------------------------------------------------------------ */

/**
 * Read-time study statistics for one scope (whole library, one card, or one
 * deck) over the actor's `reviewEvents`.
 *
 * Definitions (per review):
 *  - A review is SUCCESSFUL when rated 2, 3, or 4 (not Again).
 *  - `observedRetention` = successful reviews / totalReviews (0..1), null
 *    when there are no reviews in scope.
 *  - A review is MATURE when the card's pre-review state was Review (2) or
 *    Relearning (3) (`stateBefore` in [2, 3]).
 *  - `matureRetention` = successful mature reviews / matureReviews (0..1),
 *    null when there are no mature reviews in scope.
 * Rating histograms/percentages are over ALL reviews in scope
 * (percentages = counts / totalReviews, 0..1, 3-decimal rounded).
 */
export interface StudyStats {
  /** Inclusive lower bound of the window aggregated (normalized ISO 8601). */
  from: string;
  /** Exclusive upper bound of the window aggregated (normalized ISO 8601). */
  to: string;
  /** Total events in the scope/window. */
  totalReviews: number;
  /** Rating histogram (again/hard/good/easy) over all reviews. */
  ratingCounts: { again: number; hard: number; good: number; easy: number };
  /** ratingCounts / totalReviews (0..1, 3-decimal; zeros when no reviews). */
  ratingPercentages: { again: number; hard: number; good: number; easy: number };
  /** Successful reviews (2/3/4) / totalReviews; null when no reviews. */
  observedRetention: number | null;
  /** Reviews whose pre-review state was Review (2) or Relearning (3). */
  matureReviews: number;
  /** Rating histogram over the mature reviews. */
  matureRatingCounts: { again: number; hard: number; good: number; easy: number };
  /** Successful mature reviews / matureReviews; null when none mature. */
  matureRetention: number | null;
  /**
   * Current all-time top-lapsed cards (by the cards' PERSISTED `lapses`
   * field, read at request time; zero-lapse cards excluded), at most 25.
   */
  topLapsedCards: TopLapsedCard[];
}

export interface StudyStatsQuery {
  /** Inclusive lower bound on reviewedAt (ISO 8601 date-time or YYYY-MM-DD). REQUIRED. */
  from: string;
  /** Exclusive upper bound on reviewedAt ([from, to)). REQUIRED. */
  to: string;
  /** Restrict to events recorded while the card was in one deck. */
  deckId?: string;
  /** Number of top-lapsed entries, 1..TOP_LAPSED_LIMIT (default 10). */
  topLimit?: number;
}

/** The study stats response IS the flat stats object. */
export type StudyStatsResponse = StudyStats;

/* ------------------------------------------------------------------ */
/* Top-lapsed cards                                                    */
/* ------------------------------------------------------------------ */

/**
 * A card ranked by its CURRENT all-time lapse count: the card's PERSISTED
 * `lapses` field (the exact ts-fsrs lapse counter) read at request time.
 * Zero-lapse cards are excluded; ranking is bounded (at most
 * TOP_LAPSED_LIMIT = 25) and served by an indexed orderBy query on the
 * flashcards collection — never an N+1 over per-card reads.
 */
export interface TopLapsedCard {
  cardId: string;
  /** The card's persisted all-time lapse count. */
  lapses: number;
  /** The card's persisted review count (reps). */
  reps: number;
  /** The card's CURRENT front (read at request time). */
  front: string;
  deckId?: string;
  deckName?: string;
  /** ISO 8601 of the card's last review, when any. */
  lastReview?: string;
}

export interface TopLapsedQuery {
  /** Restrict to cards currently in one deck. */
  deckId?: string;
  /** Number of entries, 1..TOP_LAPSED_LIMIT (default 10). */
  limit?: number;
}

/** Maximum ranking depth (indexed query cap; each row is one card doc). */
export const TOP_LAPSED_LIMIT = 25;

export interface TopLapsedResponse {
  cards: TopLapsedCard[];
}

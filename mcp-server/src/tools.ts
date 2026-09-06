/**
 * Tool definitions and handlers for the FSRS flashcard MCP server.
 * Each tool mirrors one operation of the deployed Firebase API contract
 * (chatgpt/openapi.yaml, functions/src/index.ts).
 *
 * Output schemas describe the `structuredContent` returned by each handler
 * (timestamps normalized from the backend's Firestore wire format
 * { _seconds, _nanoseconds } to ISO 8601 strings).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FirebaseBridge, FirebaseBridgeError, type Flashcard, type Deck, type CardImage, type ReviewSession, type ReviewSessionWithCard, type SearchCardsQuery, type CountFlashcardsQuery, type CountFlashcardsResponse, type FlashcardCounts, type TagSummary, type ListTagsResponse, type TagActionResult, type ReviewHistoryResponse, type StudyStatsResponse, type TopLapsedResponse, type MigrateReviewEventsResponse } from './bridge.js';
import { REVIEW_WIDGET_URI } from './widget.js';
import { loadConfig } from './config.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Human-readable wire-format timestamp ({_seconds,_nanoseconds}) → ISO 8601.
 *
 * Includes the FULL sub-second precision carried by the backend: the
 * millisecond part of `_nanoseconds` is added to the whole-second instant
 * before formatting, so a card stored at `{_seconds:1788393231,
 * _nanoseconds:373000000}` serializes as `2026-09-02T23:53:51.373Z` — never
 * the truncated `…51.000Z`. Dropping the fraction made displayed
 * `createdAt`/`updatedAt`/`due` values unusable as `createdTo`/`updatedTo`
 * search bounds (the backend filters on the true instant, so a query bound
 * equal to the truncated display excluded the very card just shown).
 * Firestore timestamps are stored at microsecond resolution in practice, but
 * truncation to whole milliseconds is lossless for every value the backend
 * can write (nanos are always a whole multiple of 1_000_000), so the result
 * is exact to the millisecond.
 */
export function formatTimestamp(value: unknown): string {
  if (value && typeof value === 'object' && '_seconds' in value) {
    const seconds = value._seconds;
    if (typeof seconds === 'number') {
      const nanoseconds = '_nanoseconds' in value ? value._nanoseconds : undefined;
      const ns = typeof nanoseconds === 'number' && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      const date = new Date(seconds * 1000 + Math.floor(ns / 1_000_000));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  if (typeof value === 'string') return value;
  return String(value ?? '');
}

export interface CardImageSummary {
  /** Stable image id (server-assigned). */
  id: string;
  /** The image URL (external for URL attachments, download URL for cloud images). */
  url: string;
  alt?: string;
  mimeType?: string;
  addedAt: string;
  /** Firebase Storage object path (cloud images only). */
  storagePath?: string;
  /** Signed download URL (cloud images only). */
  downloadUrl?: string;
  /** Decoded byte size (cloud images only). */
  sizeBytes?: number;
  [key: string]: unknown;
}

export function cardImageSummary(image: CardImage): CardImageSummary {
  return {
    id: image.id,
    url: image.url,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
    addedAt: formatTimestamp(image.addedAt),
    ...(image.storagePath !== undefined ? { storagePath: image.storagePath } : {}),
    ...(image.downloadUrl !== undefined ? { downloadUrl: image.downloadUrl } : {}),
    ...(image.sizeBytes !== undefined ? { sizeBytes: image.sizeBytes } : {}),
  };
}

export interface CardSummary {
  id: string;
  front: string;
  back: string;
  /** Stable deck reference; absent when the card has no deck. */
  deckId?: string;
  /** Denormalized deck name; kept for readable/legacy filtering. */
  deck?: string;
  /** Optional topic label (subject-area grouping); matched by search_cards search. */
  topic?: string;
  /** Whether the card is suspended (persisted; filterable via search_cards). */
  suspended?: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  due: string;
  /** FSRS scheduling state: 0=New, 1=Learning, 2=Review, 3=Relearning. */
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: string;
  reviewLog: Array<{
    rating: number;
    state: number;
    review: string;
    due: string;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
  }>;
  /** Image attachments (external URL refs and cloud uploads with metadata). */
  images: CardImageSummary[];

  [key: string]: unknown;
}

export function cardSummary(card: Flashcard): CardSummary {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    ...(card.deckId !== undefined ? { deckId: card.deckId } : {}),
    ...(card.deck !== undefined ? { deck: card.deck } : {}),
    ...(card.topic !== undefined ? { topic: card.topic } : {}),
    ...(card.suspended !== undefined ? { suspended: card.suspended } : {}),
    tags: card.tags,
    createdAt: formatTimestamp(card.createdAt),
    updatedAt: formatTimestamp(card.updatedAt),
    due: formatTimestamp(card.due),
    state: card.state ?? 0,
    stability: card.stability ?? 0,
    difficulty: card.difficulty ?? 0,
    reps: card.reps ?? 0,
    lapses: card.lapses ?? 0,
    ...(card.lastReview !== undefined ? { lastReview: formatTimestamp(card.lastReview) } : {}),
    reviewLog: (card.reviewLog ?? []).map((entry) => ({
      rating: entry.rating,
      state: entry.state,
      review: formatTimestamp(entry.review),
      due: formatTimestamp(entry.due),
      stability: entry.stability,
      difficulty: entry.difficulty,
      reps: entry.reps,
      lapses: entry.lapses,
    })),
    images: (card.images ?? []).map((img) => cardImageSummary(img)),
  };
}

/* ------------------------------------------------------------------ */
/* Deck helpers                                                        */
/* ------------------------------------------------------------------ */

export interface DeckSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export function deckSummary(deck: Deck): DeckSummary {
  return {
    id: deck.id,
    name: deck.name,
    ...(deck.description !== undefined ? { description: deck.description } : {}),
    createdAt: formatTimestamp(deck.createdAt),
    updatedAt: formatTimestamp(deck.updatedAt),
  };
}

/* ------------------------------------------------------------------ */
/* Tag helpers                                                        */
/* ------------------------------------------------------------------ */

/** One distinct tag with the number of cards carrying it. */
export interface TagSummaryOutput {
  /** The exact, case-sensitive tag name as stored on cards. */
  name: string;
  /** Number of cards carrying this tag. */
  cardCount: number;
  [key: string]: unknown;
}

export function tagSummary(tag: TagSummary): TagSummaryOutput {
  return {
    name: tag.name,
    cardCount: tag.cardCount,
  };
}

/* ------------------------------------------------------------------ */
/* Review session helpers                                              */
/* ------------------------------------------------------------------ */

export interface SessionRatingCountsSummary {
  again: number;
  hard: number;
  good: number;
  easy: number;
  ratingCounts: Record<number, number>;
  [key: string]: unknown;
}

export interface ReviewSessionSummary {
  id: string;
  /** The API key name that started the session (backend-enforced ownership). */
  apiKeyName: string;
  /** Lifecycle status: active | completed | ended | failed. */
  status: 'active' | 'completed' | 'ended' | 'failed';
  /** Session mode; currently always 'spaced_repetition'. */
  mode: 'spaced_repetition';
  /**
   * Human-readable mode tag for the assistant to repeat verbatim to the user,
   * e.g. "[Spaced repetition review · 12 cards due]". Exposed in structured
   * content so UIs that render structuredContent (ChatGPT) see it even when
   * the text content is hidden.
   */
  modeTag: string;
  /**
   * Short human-readable status phrase, e.g. "active · 2 reviewed, 10
   * remaining of 100". On completion includes the Finish/Continue choice.
   */
  visibleStatus: string;
  /** Optional deck restriction captured at start. */
  deckId?: string;
  /** Optional session display name (e.g. the deck name). */
  name?: string;
  /** Persisted provenance of the session's card set ('due' | 'deck' | 'custom') + selector details. */
  source?: {
    type: 'due' | 'deck' | 'custom';
    deckId?: string;
    deckName?: string;
    tags?: string[];
    cardIds?: string[];
  };
  /** Session presentation card type ('qa' default | 'cloze'). Never stored on cards. */
  cardType?: 'qa' | 'cloze';
  /** Storage layout version: 2 = bounded root + queueChunks; absent/1 = legacy. */
  storageVersion?: number;
  /** Continue lineage: the session id this session repeats (root-only, bounded). */
  repeatSessionId?: string;
  /** v2 bounded metadata. */
  chunkCount?: number;
  completedChunks?: number;
  queueChunksPrefix?: string;
  position?: number;
  deletedCount?: number;
  remainingQueueCount?: number;
  buildFailed?: boolean;
  buildError?: string;
  /** Number of cards snapshotted into the session (v1: cardIds.length; v2: total queue positions). */
  limit: number;
  /** Exact number of cards that were due when the session started. */
  dueCount: number;
  /** Snapshot card ids (LEGACY v1/no-version ONLY — v2 roots omit this; the bounded queueWindow replaces it). */
  cardIds?: string[];
  /** Index into cardIds of the card awaiting the next rating (v1) / current queue position (v2). */
  currentIndex: number;
  /** Number of cards successfully rated in this session. */
  reviewedCount: number;
  /** Number of cards still awaiting review. */
  remainingCount: number;
  /** v2 canonical total queue positions (== limit). */
  totalCount?: number;
  /** v2 canonical chunk ordinal owning the current position (-1 when empty). */
  currentChunkIndex?: number;
  /** v2 build lifecycle: 'building' | 'ready' | 'failed'. */
  buildStatus?: 'building' | 'ready' | 'failed';
  /** The queue position of the current card (v2, stable across chunks). */
  currentPosition?: number | null;
  /** Bounded v2 queue window: current card + preload ids (never the full queue). */
  queueWindow?: { currentPosition: number | null; currentCardId?: string | null; cardIds: Array<{ cardId: string; position: number }> };
  /**
   * The cards rated in this session (LEGACY v1/no-version ONLY — v2 roots
   * omit it; queueChunks claims are authoritative). Full-state only: kept OUT
   * of the minimal model-facing structuredContent.
   */
  reviewedCardIds?: string[];
  /**
   * Every requestId that has already been applied (LEGACY v1/no-version ONLY).
   * Full-state only (idempotent retry dedupe for the widget).
   */
  processedRequestIds?: string[];
  /** True when the snapshot was capped at start (legacy sessions only — new sessions never cap). */
  truncated: boolean;
  /** True when the snapshot was capped at start (a new session can be started after this one completes). Legacy sessions only. */
  continuationAvailable: boolean;
  /** Ratings applied so far. */
  ratingCounts: SessionRatingCountsSummary;
  startedAt: string;
  lastReviewedAt?: string;
  endedAt?: string;
  [key: string]: unknown;
}

export function sessionSummary(session: ReviewSession): ReviewSessionSummary {
  // The total queue size: the persisted `limit` is authoritative for BOTH
  // layouts (v1 roots persist limit == cardIds.length; v2 roots persist the
  // total chunked position count). Fall back to cardIds.length only for
  // legacy documents that never persisted limit.
  const total = session.limit != null ? session.limit : (session.cardIds?.length ?? 0);
  const remaining = session.remainingQueueCount
    ?? session.remainingCount
    ?? (session.cardIds ? Math.max(0, session.cardIds.length - session.currentIndex) : 0);
  // Source label: what defined this session's card set. `due` → "Due cards";
  // `deck` → the deck name (verbatim); `custom` → "Custom" (any tags/ids/
  // mixed selection). A session can never claim to be "due cards" when it
  // was selector-defined.
  const sourceLabel = session.source?.type === 'deck'
    ? session.source.deckName ?? session.name ?? 'Deck'
    : session.source?.type === 'custom'
      ? 'Custom'
      : 'Due cards';
  const modeTag = `[Spaced repetition review · ${session.dueCount} cards · ${sourceLabel}]`;
  // Status denominator: v1 shows the full root cardIds length (the queue the
  // client can see); v2 roots are BOUNDED so the persisted limit is the total.
  const statusTotal = Array.isArray(session.cardIds) && session.cardIds.length
    ? session.cardIds.length
    : total;
  const baseStatus = `${session.status} · ${session.reviewedCount} reviewed, ${remaining} remaining of ${statusTotal}`;
  const visibleStatus = session.status === 'completed'
    ? session.continuationAvailable
      ? 'completed · choose Finish or Continue review (Continue = start a NEW spaced-repetition session)'
      : 'completed · choose Finish (all due cards were reviewed)'
    : baseStatus;
  // Provenance sanitization: the strict response invariant forbids exposing
  // any session card-id list through the API/MCP/widget summaries. v2
  // sessions NEVER carry source.cardIds (the full snapshot lives chunked and
  // Continue copies it via repeatSessionId); legacy v1 documents keep their
  // selector provenance for Continue replay.
  const isV2Summary = session.storageVersion === 2
    || (!Array.isArray(session.cardIds) && session.limit != null && session.chunkCount != null);
  let sourceOut: ReviewSessionSummary['source'];
  if (session.source !== undefined) {
    sourceOut = { ...session.source };
    if (isV2Summary && Array.isArray(sourceOut.cardIds)) {
      delete sourceOut.cardIds;
    }
  }
  return {
    id: session.id,
    apiKeyName: session.apiKeyName,
    status: session.status,
    mode: session.mode,
    modeTag,
    visibleStatus,
    ...(session.deckId !== undefined ? { deckId: session.deckId } : {}),
    ...(session.name !== undefined ? { name: session.name } : {}),
    ...(sourceOut !== undefined ? { source: sourceOut } : {}),
    ...(session.cardType !== undefined ? { cardType: session.cardType } : {}),
    ...(session.storageVersion !== undefined ? { storageVersion: session.storageVersion } : {}),
    ...(session.repeatSessionId !== undefined ? { repeatSessionId: session.repeatSessionId } : {}),
    ...(session.chunkCount !== undefined ? { chunkCount: session.chunkCount } : {}),
    ...(session.completedChunks !== undefined ? { completedChunks: session.completedChunks } : {}),
    ...(session.queueChunksPrefix !== undefined ? { queueChunksPrefix: session.queueChunksPrefix } : {}),
    ...(session.position !== undefined ? { position: session.position } : {}),
    ...(session.deletedCount !== undefined ? { deletedCount: session.deletedCount } : {}),
    ...(session.remainingQueueCount !== undefined ? { remainingQueueCount: session.remainingQueueCount } : {}),
    ...(session.totalCount !== undefined ? { totalCount: session.totalCount } : {}),
    ...(session.currentChunkIndex !== undefined ? { currentChunkIndex: session.currentChunkIndex } : {}),
    ...(session.buildStatus !== undefined ? { buildStatus: session.buildStatus } : {}),
    ...(session.buildFailed === true ? { buildFailed: true } : {}),
    ...(typeof session.buildError === 'string' ? { buildError: session.buildError } : {}),
    limit: total,
    dueCount: session.dueCount,
    // STRICT v2 RESPONSE INVARIANT: v2 summaries NEVER carry the legacy
    // in-root queue arrays (cardIds / reviewedCardIds / processedRequestIds) —
    // even when a malformed/older v2 root or a defensive test supplies them.
    // All three are omitted for isV2Summary; legacy v1/no-version documents
    // keep them unchanged.
    ...(!isV2Summary && Array.isArray(session.cardIds) ? { cardIds: session.cardIds } : {}),
    currentIndex: session.currentIndex,
    ...(session.currentPosition !== undefined ? { currentPosition: session.currentPosition } : {}),
    reviewedCount: session.reviewedCount,
    remainingCount: remaining,
    ...(isV2Summary
      ? {}
      : { reviewedCardIds: Array.isArray(session.reviewedCardIds) ? session.reviewedCardIds : [] }),
    ...(!isV2Summary && Array.isArray(session.processedRequestIds) ? { processedRequestIds: session.processedRequestIds } : {}),
    truncated: session.truncated,
    continuationAvailable: session.continuationAvailable,
    ratingCounts: {
      again: session.ratingCounts.again,
      hard: session.ratingCounts.hard,
      good: session.ratingCounts.good,
      easy: session.ratingCounts.easy,
      ratingCounts: session.ratingCounts.ratingCounts,
    },
    startedAt: formatTimestamp(session.startedAt),
    ...(session.lastReviewedAt !== undefined ? { lastReviewedAt: formatTimestamp(session.lastReviewedAt) } : {}),
    ...(session.endedAt !== undefined ? { endedAt: formatTimestamp(session.endedAt) } : {}),
    ...(session.testMode === true ? { testMode: true } : {}),
  };
}

/** A review session plus its current card (null when the queue is exhausted). */
export interface PreloadedCardSummary {
  id: string;
  front: string;
  back: string;
  deck?: string;
  tags: string[];
  /** Stable queue position of this upcoming card (v2 responses). */
  position?: number;
  [key: string]: unknown;
}

export interface ReviewSessionWithCardSummary {
  session: ReviewSessionSummary;
  card: CardSummary | null;
  /** Upcoming cards (after `card`), bounded, from the backend response. */
  preloaded: PreloadedCardSummary[];
  /** v2: stable queue position of the current card. */
  currentPosition?: number | null;
  /** v2 bounded queue window (current card + preload ids). */
  queueWindow?: { currentPosition: number | null; currentCardId?: string | null; cardIds: Array<{ cardId: string; position: number }> };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Raw shape for input schemas (SDK converts shapes to zod objects). */
const flashcardShape = {
  id: z.string(),
  front: z.string(),
  back: z.string(),
  deckId: z.string().optional(),
  deck: z.string().optional(),
  topic: z.string().optional(),
  suspended: z.boolean().optional(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  due: z.string(),
  state: z.number(),
  stability: z.number(),
  difficulty: z.number(),
  reps: z.number(),
  lapses: z.number(),
  lastReview: z.string().optional(),
  reviewLog: z.array(z.object({
    rating: z.number(),
    state: z.number(),
    review: z.string(),
    due: z.string(),
    stability: z.number(),
    difficulty: z.number(),
    reps: z.number(),
    lapses: z.number(),
  })),
  images: z.array(z.object({
    id: z.string(),
    url: z.string(),
    alt: z.string().optional(),
    mimeType: z.string().optional(),
    addedAt: z.string(),
    storagePath: z.string().optional(),
    downloadUrl: z.string().optional(),
    sizeBytes: z.number().optional(),
  })),
};

/** Full zod object — used where an actual schema instance is needed. */
const flashcardObjectSchema = z.object(flashcardShape);

const flashcardInputShape = {
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long'),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long'),
  /** Stable deck reference (decks collection). */
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').nullable().optional(),
  /** Legacy deck name (find-or-create). Kept for backward compatibility. */
  deck: z.string().max(100, 'Deck name too long').nullable().optional(),
  /** Optional topic label (subject-area grouping). null clears it. */
  topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
  /** Suspends (true) / unsuspends (false) the card. */
  suspended: z.boolean().optional(),
  tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
};

/** Deck output shape (timestamps normalized to ISO 8601 by deckSummary). */
const deckShape = {
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** Deck input shape for create/update tools. */
const deckInputShape = {
  name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long'),
  description: z.string().max(500, 'Description too long').optional(),
};

/** Tag output shape: one distinct tag (exact, case-sensitive name) + its card count. */
const tagOutputShape = {
  name: z.string(),
  cardCount: z.number(),
};

/**
 * Tag name input bound shared by the tag-management tools: the SAME 1–50
 * character bound the create/update/bulk schemas enforce per tag, matching
 * the backend validator. Names are never trimmed — matching is exact and
 * case-sensitive, so a name differing by whitespace is a different tag.
 */
const tagNameInputShape = z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long');

/** Mutation input for rename_tag/merge_tags (from and to must differ). */
const tagFromToInputShape = {
  from: tagNameInputShape,
  to: tagNameInputShape,
};

/** Card image output shape: external-URL and cloud-upload fields. */
const cardImageOutputShape = {
  id: z.string(),
  url: z.string(),
  alt: z.string().optional(),
  mimeType: z.string().optional(),
  addedAt: z.string(),
  storagePath: z.string().optional(),
  downloadUrl: z.string().optional(),
  sizeBytes: z.number().optional(),
};

/** Review session output shape (timestamps normalized to ISO 8601 by sessionSummary). */
const sessionShape = {
  id: z.string(),
  apiKeyName: z.string(),
  status: z.union([z.literal('active'), z.literal('completed'), z.literal('ended'), z.literal('failed')]),
  mode: z.literal('spaced_repetition'),
  modeTag: z.string(),
  visibleStatus: z.string(),
  deckId: z.string().optional(),
  name: z.string().optional(),
  source: z.object({
    type: z.union([z.literal('due'), z.literal('deck'), z.literal('custom')]),
    deckId: z.string().optional(),
    deckName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    cardIds: z.array(z.string()).optional(),
  }).optional(),
  cardType: z.enum(['qa', 'cloze']).optional(),
  storageVersion: z.number().optional(),
  repeatSessionId: z.string().optional(),
  chunkCount: z.number().optional(),
  completedChunks: z.number().optional(),
  queueChunksPrefix: z.string().optional(),
  position: z.number().optional(),
  totalCount: z.number().optional(),
  currentChunkIndex: z.number().optional(),
  buildStatus: z.union([z.literal('building'), z.literal('ready'), z.literal('failed')]).optional(),
  deletedCount: z.number().optional(),
  remainingQueueCount: z.number().optional(),
  buildFailed: z.boolean().optional(),
  buildError: z.string().optional(),
  currentPosition: z.number().nullable().optional(),
  queueWindow: z.object({
    currentPosition: z.number().nullable(),
    currentCardId: z.string().nullable().optional(),
    cardIds: z.array(z.object({
      cardId: z.string(),
      position: z.number(),
    })),
  }).optional(),
  limit: z.number(),
  dueCount: z.number(),
  cardIds: z.array(z.string()).optional(),
  currentIndex: z.number(),
  reviewedCount: z.number(),
  remainingCount: z.number(),
  reviewedCardIds: z.array(z.string()).optional(),
  processedRequestIds: z.array(z.string()).optional(),
  truncated: z.boolean(),
  continuationAvailable: z.boolean(),
  ratingCounts: z.object({
    again: z.number(),
    hard: z.number(),
    good: z.number(),
    easy: z.number(),
    ratingCounts: z.record(z.number()),
  }),
  startedAt: z.string(),
  lastReviewedAt: z.string().optional(),
  endedAt: z.string().optional(),
};

/**
 * MINIMAL model-facing output shape for the session tools (quiet mode). The
 * model sees only session id/status/mode/counters and the current card id —
 * NO front/back, NO progress prose, NO preloaded cards — so it cannot
 * narrate the session or current card. The FULL state (front/back,
 * preloaded) rides in the hidden Apps SDK `_meta['ui/widgetState']`
 * consumed by the review widget.
 */
const sessionWithCardMinimalShape = {
  session: z.object({
    id: z.string(),
    status: z.union([z.literal('active'), z.literal('completed'), z.literal('ended'), z.literal('failed')]),
    mode: z.literal('spaced_repetition'),
    storageVersion: z.number().optional(),
    buildStatus: z.union([z.literal('building'), z.literal('ready'), z.literal('failed')]).optional(),
    currentIndex: z.number(),
    currentPosition: z.number().nullable().optional(),
    currentChunkIndex: z.number().optional(),
    totalCount: z.number().optional(),
    reviewedCount: z.number(),
    remainingCount: z.number(),
  }),
  card: z.object({ id: z.string() }).nullable(),
};

/**
 * Apps SDK UI linkage metadata attached ONLY to the start_review_session tool
 * registration `_meta` (the supported extension point in this SDK version):
 * tells widget-capable hosts to MOUNT the review widget (`ui://review-session-v5`)
 * with the tool's structuredContent as input. get_review_session and
 * submit_review are intentionally data-only (no linkage) so the widget is
 * mounted exactly once; they still deliver the hidden `_meta['ui/widgetState']`
 * for the already-mounted widget to hydrate from.
 */
const REVIEW_WIDGET_TOOL_META = {
  // Current Apps SDK (MCP Apps) linkage: the tool's output renders the
  // ui://review-session-v5 resource.
  ui: { resourceUri: REVIEW_WIDGET_URI },
  // MCP Apps SDK 1.x compatibility alias.
  'ui/resourceUri': REVIEW_WIDGET_URI,
  // Legacy ChatGPT Apps SDK alias.
  'openai/outputTemplate': REVIEW_WIDGET_URI,
};

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerFlashcardTools(server: McpServer, bridge: FirebaseBridge): void {
  const noKey = 'CUELINGUA_API_KEY is not set. Set it in the environment (see mcp-server/.env.example) to call the deployed Firebase API.';

  const requireKey = (): void => {
    if (!bridge.hasApiKey) {
      throw new Error(noKey);
    }
  };

  /* health — public, no API key required */
  server.registerTool(
    'health',
    {
      title: 'Check flashcard service health',
      description:
        'Starts a persistent review session: the backend snapshots EVERY selector/default-matching card into the session queue (never capped, no pagination). NO selectors -> the standard DUE queue (new + scheduled cards, earliest due first). Optional selectors (any combination): deckId (stable id) and/or deck (legacy name; deckId wins), tags (ANY-of - a card matching ANY listed tag qualifies), cardIds (explicit allowlist, deduped, every id must exist; combined with deck/tags by INTERSECTION). A selector-defined session may include NON-due cards - the selector query is authoritative; REVIEW_TEST_MODE only widens the DEFAULT due filter, never an explicit selection. The review widget renders the session, cards, source, and progress - DO NOT narrate, summarize, or repeat the session, its cards, its mode tag, progress, source, or the current card in your reply unless the user explicitly asks; the UI owns display. Returns the MINIMAL model-facing state: session id, status, mode, counters, and the current card id (full widget state incl. card content is delivered to the widget). When the session completes, the widget shows the Finish/Continue choice - do not narrate it. ALWAYS repeat the session modeTag to the user verbatim (e.g. "[Spaced repetition review - 12 cards - Due cards]") and report progress from visibleStatus ("X reviewed, Y remaining of N") - never invent or omit these. The queue is stable across retries: cards that become due later are NOT added. Sessions are scoped to the API key that starts them; only that key can get/submit/end them. Use this when the user wants to study a set of cards, e.g. "start a review session for my spanish deck" or "review my vocab-tagged cards".',
      inputSchema: {},
      outputSchema: { status: z.string(), timestamp: z.string() },
    },
    async () => {
      const result = await bridge.health();
      return {
        content: [{ type: 'text' as const, text: `Service status: ${result.status} (server time ${result.timestamp}).` }],
        structuredContent: result,
      };
    },
  );

  /* create */
  server.registerTool(
    'create_flashcard',
    {
      title: 'Create a flashcard',
      description:
        'Creates a flashcard with a front (question), a back (answer), and optional deck, tags, topic, and suspended state. Assign the card to a deck with deckId (the stable deck id from create_deck/list_decks) — the recommended way — or with a legacy deck name (deck) which the backend finds-or-creates. topic is an optional free-form subject label (searchable via search_cards); suspended (boolean, default false) is a persisted attribute you can filter on with search_cards. The backend assigns a server-generated id and initial FSRS scheduling state (new cards are due immediately). Returns the created card including its id. Create one card per call.',
      inputSchema: flashcardInputShape,
      outputSchema: flashcardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { front: string; back: string; deckId?: string | null; deck?: string | null; topic?: string | null; suspended?: boolean; tags?: string[] }) => {
      requireKey();
      const card = await bridge.createFlashcard({
        front: args.front,
        back: args.back,
        ...(args.deckId !== undefined ? { deckId: args.deckId } : {}),
        ...(args.deck !== undefined ? { deck: args.deck } : {}),
        ...(args.topic !== undefined ? { topic: args.topic } : {}),
        ...(args.suspended !== undefined ? { suspended: args.suspended } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      });
      const summary = cardSummary(card);
      return {
        content: [{ type: 'text' as const, text: `Created flashcard ${summary.id}: "${summary.front}" → "${summary.back}"${summary.deck ? ` (deck: ${summary.deck})` : ''}.` }],
        structuredContent: summary,
      };
    },
  );

  /* list */
  server.registerTool(
    'list_flashcards',
    {
      title: 'List flashcards',
      description:
        'Lists flashcards, most recently created first. Optionally filter by deckId (stable deck id — preferred) or legacy deck name (deck), by tags (cards matching ANY of the given tags, comma-separated), and paginate with pageSize (1-100, default 20) and pageToken (pass the nextPageToken from a previous response to get the next page).',
      inputSchema: {
        deckId: z.string().max(100).optional(),
        deck: z.string().max(100).optional(),
        tags: z.string().max(500).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        cards: z.array(flashcardObjectSchema),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { deckId?: string; deck?: string; tags?: string; pageSize?: number; pageToken?: string }) => {
      requireKey();
      const result = await bridge.listFlashcards(args);
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const lines = cards.length === 0
        ? 'No flashcards found.'
        : cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}"${c.deck ? ` (deck: ${c.deck})` : ''}`).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call list_flashcards again with pageToken "${result.nextPageToken}".`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { cards, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* get due */
  server.registerTool(
    'get_due_flashcards',
    {
      title: 'Get due flashcards',
      description:
        'Returns flashcards that are due for review right now: new cards (never reviewed) plus cards whose scheduled FSRS due time has arrived, ordered earliest-due first. Optionally restrict to one deck by deckId (stable deck id — preferred) or legacy deck name (deck), and paginate with pageSize (1-100, default 20) and pageToken (pass the nextPageToken from a previous response to get the next page). Use this when the user wants to review or study their cards. Read-only; does not modify scheduling.',
      inputSchema: {
        deckId: z.string().max(100).optional(),
        deck: z.string().max(100).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        cards: z.array(flashcardObjectSchema),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { deckId?: string; deck?: string; pageSize?: number; pageToken?: string }) => {
      requireKey();
      const result = await bridge.getDueFlashcards(args);
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const lines = cards.length === 0
        ? 'No flashcards are due right now.'
        : cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}"${c.deck ? ` (deck: ${c.deck})` : ''} (due ${c.due})`).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call get_due_flashcards again with pageToken "${result.nextPageToken}".`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { cards, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* search cards — rich query */
  server.registerTool(
    'search_cards',
    {
      title: 'Search flashcards (rich query)',
      description:
        'Searches flashcards with combined filters (AND across filter families). Filters: search (free text, case-insensitive, matches topic OR front OR back — cards can carry an optional topic label set at create/update); tagsAny / tagsAll / tagsNot (exactly ONE of the three: ANY-of, ALL-of, or NONE-of tag semantics); review (due | notDue | new | reviewed; suspended cards never match review filters — query them with suspended); decks (stable deck ids) and deckNames (legacy deck names) — the two UNION as ANY-of within the deck family, and the family ANDs with everything else; suspended (true = suspended only, false = active only, absent = both); createdFrom/createdTo/updatedFrom/updatedTo (inclusive date bounds; ISO 8601 date-time or YYYY-MM-DD). All filters combine by intersection. Results are ordered createdAt descending, ties by document id ascending (the Firestore native tie-break) and paginated with pageSize (1-100, default 20) and an OPAQUE cursor pageToken: pass back the nextPageToken from the previous response WITH THE EXACT SAME FILTERS to get the next page (a token with different filters is rejected). Read-only.',
      inputSchema: {
        search: z.string().max(500).optional(),
        tagsAny: z.array(z.string().min(1).max(50)).max(20).optional(),
        tagsAll: z.array(z.string().min(1).max(50)).max(20).optional(),
        tagsNot: z.array(z.string().min(1).max(50)).max(20).optional(),
        review: z.enum(['due', 'notDue', 'new', 'reviewed']).optional(),
        decks: z.array(z.string().min(1).max(100)).max(20).optional(),
        deckNames: z.array(z.string().min(1).max(100)).max(20).optional(),
        suspended: z.boolean().optional(),
        createdFrom: z.string().optional(),
        createdTo: z.string().optional(),
        updatedFrom: z.string().optional(),
        updatedTo: z.string().optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        cards: z.array(flashcardObjectSchema),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: SearchCardsQuery) => {
      requireKey();
      const result = await bridge.searchCards(args);
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const lines = cards.length === 0
        ? 'No flashcards match the query.'
        : cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}"${c.deck ? ` (deck: ${c.deck})` : ''}${c.topic ? ` [topic: ${c.topic}]` : ''}${c.suspended ? ' (suspended)' : ''}`).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call search_cards again with the same filters and pageToken "${result.nextPageToken}".`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { cards, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* count_flashcards — lightweight deck statistics (aggregate counts only) */
  const countsText = (counts: FlashcardCounts): string =>
    `${counts.total} total · ${counts.new} new · ${counts.learning} learning · ${counts.mature} mature · ${counts.due} due`;
  server.registerTool(
    'count_flashcards',
    {
      title: 'Count flashcards (deck statistics)',
      description:
        'Returns lightweight deck statistics: how many flashcards exist (total), are new (never reviewed), learning, mature (Review or Relearning), and due right now — WITHOUT fetching any card records (the backend uses Firestore count aggregations). Answer questions like "how many cards are in Spanish?" by filtering with deckId (stable deck id, preferred) or the legacy deck name deck (deckId wins when both are given — the list/due convention), and/or tags (cards carrying ANY of the comma-separated tags); each bucket counts the filtered set. Set groupBy=deck (standalone — cannot be combined with the deck/tag filters) to break the WHOLE LIBRARY down per deck: every deck entity gets its own counts plus a final deck-less remainder entry (deckId/deck null). Counts are exact as of the request; due is evaluated against the current time.',
      inputSchema: {
        deckId: z.string().max(100).optional(),
        deck: z.string().max(100).optional(),
        tags: z.string().max(500).optional(),
        groupBy: z.enum(['deck']).optional(),
      },
      outputSchema: {
        counts: z.object({
          total: z.number(),
          new: z.number(),
          learning: z.number(),
          mature: z.number(),
          due: z.number(),
        }),
        byDeck: z.array(z.object({
          deckId: z.string().nullable(),
          deck: z.string().nullable(),
          counts: z.object({
            total: z.number(),
            new: z.number(),
            learning: z.number(),
            mature: z.number(),
            due: z.number(),
          }),
        })).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: CountFlashcardsQuery) => {
      requireKey();
      const result: CountFlashcardsResponse = await bridge.countFlashcards({
        ...(args.deckId !== undefined ? { deckId: args.deckId } : {}),
        ...(args.deck !== undefined ? { deck: args.deck } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.groupBy !== undefined ? { groupBy: args.groupBy } : {}),
      });
      const { counts } = result;
      let text = countsText(counts);
      if (result.byDeck && result.byDeck.length > 0) {
        text += '\n\nBy deck:';
        for (const entry of result.byDeck) {
          text += `\n- ${entry.deck ?? '(no deck)'}: ${countsText(entry.counts)}`;
        }
      }
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* review */
  server.registerTool(
    'review_flashcard',
    {
      title: 'Review a flashcard',
      description:
        'Records a review of one flashcard by id with an FSRS rating: 1=Again (forgot), 2=Hard, 3=Good, 4=Easy. The backend applies the FSRS scheduler and returns the updated card with its new due time, plus the review log entry. Call this after the user answers a card retrieved via get_due_flashcards. Optionally pass reviewAt (ISO 8601) as the review time; defaults to the server time.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        reviewAt: z.string().datetime({ offset: true }).optional(),
      },
      outputSchema: z.object({
        card: flashcardObjectSchema,
        reviewLogItem: z.object({
          rating: z.number(),
          state: z.number(),
          review: z.string(),
          due: z.string(),
          stability: z.number(),
          difficulty: z.number(),
          reps: z.number(),
          lapses: z.number(),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; rating: 1 | 2 | 3 | 4; reviewAt?: string }) => {
      requireKey();
      const result = await bridge.reviewFlashcard(args.id, {
        rating: args.rating,
        ...(args.reviewAt !== undefined ? { reviewAt: args.reviewAt } : {}),
      });
      const summary = cardSummary(result.card as Flashcard);
      return {
        content: [{ type: 'text' as const, text: `Reviewed flashcard ${summary.id} (rating ${args.rating}). Next review due ${summary.due}.` }],
        structuredContent: {
          card: summary,
          reviewLogItem: {
            rating: result.reviewLogItem.rating,
            state: result.reviewLogItem.state,
            review: formatTimestamp(result.reviewLogItem.review),
            due: formatTimestamp(result.reviewLogItem.due),
            stability: result.reviewLogItem.stability,
            difficulty: result.reviewLogItem.difficulty,
            reps: result.reviewLogItem.reps,
            lapses: result.reviewLogItem.lapses,
          },
        },
      };
    },
  );

  /* scheduling: reset */
  server.registerTool(
    'reset_flashcards',
    {
      title: 'Reset flashcards to new',
      description:
        'Resets the FSRS scheduling state of one or more flashcards by id (up to 100, unique ids). Each card becomes EXACTLY like a brand-new card: state New, due immediately (now), zeroed stability/difficulty/reps/lapses, empty reviewLog, and no lastReview — so it reads as new/due everywhere (due queues, review sessions, search facets, counts). Content fields (front/back/deck/tags/topic/images) and the suspended flag are untouched. The scheduling history is cleared (not archived) and cannot be undone. The backend commits atomically in one transaction; ids that do not exist are omitted (never an error). Returns the reset cards in input order. Use this when the user wants to "start over" a card or move it back into the new queue.',
      inputSchema: {
        ids: z.array(z.string().min(1, 'id is required')).min(1, 'At least one id is required').max(100, 'No more than 100 ids per request').refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
      },
      outputSchema: z.object({
        ids: z.array(z.string()),
        count: z.number(),
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { ids: string[] }) => {
      requireKey();
      const result = await bridge.resetFlashcards({ ids: args.ids });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const textContent = `Reset ${result.count} flashcard${result.count === 1 ? '' : 's'} to new${result.count < args.ids.length ? ` (${args.ids.length - result.count} id(s) did not exist and were skipped)` : ''}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}" (now due immediately)`).join('\n');
      return {
        content: [{ type: 'text' as const, text: textContent }],
        structuredContent: { ids: result.ids, count: result.count, cards },
      };
    },
  );

  /* scheduling: set due date */
  server.registerTool(
    'set_due_date',
    {
      title: 'Set a flashcard due date',
      description:
        'Sets the exact next-review time (`due`) of one or more flashcards by id (up to 100, unique ids). ONLY the due time changes: the FSRS state (state/stability/difficulty/reps/lapses/lastReview/reviewLog) is preserved exactly, so the card keeps its scheduling memory and the next review schedules from the persisted state. `due` is a full ISO 8601 date-time (e.g. 2026-09-15T08:30:00.000Z) or a plain YYYY-MM-DD date (UTC midnight of that day). Use this to reschedule a card to a specific day — e.g. postpone a card the user wants to see tomorrow or on a particular date. The backend commits atomically in one transaction; ids that do not exist are omitted (never an error). Returns the updated cards in input order.',
      inputSchema: {
        ids: z.array(z.string().min(1, 'id is required')).min(1, 'At least one id is required').max(100, 'No more than 100 ids per request').refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
        due: z.string().min(1, 'due is required').max(64, 'due too long'),
      },
      outputSchema: z.object({
        ids: z.array(z.string()),
        count: z.number(),
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { ids: string[]; due: string }) => {
      requireKey();
      const result = await bridge.setFlashcardDueDate({ ids: args.ids, due: args.due });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const textContent = `Set due date on ${result.count} flashcard${result.count === 1 ? '' : 's'} to ${args.due}${result.count < args.ids.length ? ` (${args.ids.length - result.count} id(s) did not exist and were skipped)` : ''}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}" (now due ${formatTimestamp((c as Flashcard).due)})`).join('\n');
      return {
        content: [{ type: 'text' as const, text: textContent }],
        structuredContent: { ids: result.ids, count: result.count, cards },
      };
    },
  );

  /* scheduling: suspend */
  server.registerTool(
    'suspend_flashcards',
    {
      title: 'Suspend flashcards',
      description:
        'Suspends one or more flashcards by id (up to 100, unique ids): sets the persisted `suspended: true` flag. A suspended card keeps ALL content and scheduling state (due, FSRS fields, reviewLog — nothing is lost or rescheduled); it is simply excluded from active review surfaces: search_cards with `suspended: true` selects them, they never match its review facet, and with no suspended filter they still appear. NOTE: the legacy due/review endpoints (get_due_flashcards, review sessions) do NOT read the flag and behave exactly as before — suspending never reschedules or hides a card from an already-started session. The backend commits atomically in one transaction; ids that do not exist are omitted (never an error). Returns the updated cards in input order. Use suspend_flashcards to pause cards the user does not want to review right now (e.g. too-hard or skipped cards), and unsuspend_flashcards to resume them.',
      inputSchema: {
        ids: z.array(z.string().min(1, 'id is required')).min(1, 'At least one id is required').max(100, 'No more than 100 ids per request').refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
      },
      outputSchema: z.object({
        ids: z.array(z.string()),
        count: z.number(),
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { ids: string[] }) => {
      requireKey();
      const result = await bridge.suspendFlashcards({ ids: args.ids });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const textContent = `Suspended ${result.count} flashcard${result.count === 1 ? '' : 's'}${result.count < args.ids.length ? ` (${args.ids.length - result.count} id(s) did not exist and were skipped)` : ''}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}" (suspended)`).join('\n');
      return {
        content: [{ type: 'text' as const, text: textContent }],
        structuredContent: { ids: result.ids, count: result.count, cards },
      };
    },
  );

  /* scheduling: unsuspend */
  server.registerTool(
    'unsuspend_flashcards',
    {
      title: 'Unsuspend flashcards',
      description:
        'Unsuspends one or more flashcards by id (up to 100, unique ids): removes the persisted `suspended` field (an absent field reads as false everywhere — the same representation a never-suspended card has). The card becomes eligible for search_cards `suspended: false` and the review facets again; content and scheduling state are untouched. The backend commits atomically in one transaction; ids that do not exist are omitted (never an error). Returns the updated cards in input order. Use unsuspend_flashcards to resume cards that were paused with suspend_flashcards.',
      inputSchema: {
        ids: z.array(z.string().min(1, 'id is required')).min(1, 'At least one id is required').max(100, 'No more than 100 ids per request').refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
      },
      outputSchema: z.object({
        ids: z.array(z.string()),
        count: z.number(),
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { ids: string[] }) => {
      requireKey();
      const result = await bridge.unsuspendFlashcards({ ids: args.ids });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const textContent = `Unsuspended ${result.count} flashcard${result.count === 1 ? '' : 's'}${result.count < args.ids.length ? ` (${args.ids.length - result.count} id(s) did not exist and were skipped)` : ''}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}" (active again)`).join('\n');
      return {
        content: [{ type: 'text' as const, text: textContent }],
        structuredContent: { ids: result.ids, count: result.count, cards },
      };
    },
  );

  /* get */
  server.registerTool(
    'get_flashcard',
    {
      title: 'Get a flashcard',
      description:
        'Returns one flashcard by its server-assigned id. Use this when the user references a specific card (by id or by quoting its front).',
      inputSchema: { id: z.string().min(1, 'id is required') },
      outputSchema: flashcardShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { id: string }) => {
      requireKey();
      const card = await bridge.getFlashcard(args.id);
      const summary = cardSummary(card);
      return {
        content: [{ type: 'text' as const, text: `${summary.id}: "${summary.front}" → "${summary.back}"${summary.deck ? ` (deck: ${summary.deck})` : ''}` }],
        structuredContent: summary,
      };
    },
  );

  /* update */
  server.registerTool(
    'update_flashcard',
    {
      title: 'Update a flashcard',
      description:
        'Updates editable fields of an existing flashcard by id. Only the fields present in the arguments are changed; omitted fields keep their current values. Assign or move the card with deckId (stable deck id — preferred) or legacy deck name (deck); pass deckId: null (or deck: null) to detach the card from its deck. Pass tags to replace the full tag set; topic sets/updates the subject label (topic: null clears it); suspended toggles the persisted suspended attribute (queryable via search_cards). Changing front or back does not reset scheduling.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
        back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
        deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').nullable().optional(),
        deck: z.string().max(100, 'Deck name too long').nullable().optional(),
        topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
        suspended: z.boolean().optional(),
        tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
      },
      outputSchema: flashcardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; front?: string; back?: string; deckId?: string | null; deck?: string | null; topic?: string | null; suspended?: boolean; tags?: string[] }) => {
      requireKey();
      const { id, ...input } = args;
      const card = await bridge.updateFlashcard(id, input);
      const summary = cardSummary(card);
      return {
        content: [{ type: 'text' as const, text: `Updated flashcard ${summary.id}: "${summary.front}" → "${summary.back}"${summary.deck ? ` (deck: ${summary.deck})` : ''}.` }],
        structuredContent: summary,
      };
    },
  );

  /* delete */
  server.registerTool(
    'delete_flashcard',
    {
      title: 'Delete a flashcard',
      description:
        'Permanently removes a flashcard by its server-assigned id. Use this only when the user explicitly asks to delete a card. Returns the id of the deleted card.',
      inputSchema: { id: z.string().min(1, 'id is required') },
      outputSchema: { id: z.string(), deleted: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string }) => {
      requireKey();
      await bridge.deleteFlashcard(args.id);
      return {
        content: [{ type: 'text' as const, text: `Deleted flashcard ${args.id}.` }],
        structuredContent: { id: args.id, deleted: true },
      };
    },
  );

  /* bulk create */
  server.registerTool(
    'bulk_create_flashcards',
    {
      title: 'Create multiple flashcards',
      description:
        'Atomically creates up to 100 flashcards in one request. Each item has a front (question), a back (answer), and optional deck (deckId — stable deck id preferred — or legacy deck name), tags, topic (free-form subject label), and suspended (boolean, default false). The backend validates every item (including that referenced deck ids exist) before writing and commits the whole batch in a single Firestore batch — either all cards are created or none are (no partial success). Returns every created card with its server-assigned id. Prefer this over calling create_flashcard repeatedly when the user asks for several cards at once.',
      inputSchema: {
        cards: z.array(z.object(flashcardInputShape)).min(1, 'At least one card is required').max(100, 'No more than 100 cards per request'),
      },
      outputSchema: z.object({
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { cards: Array<{ front: string; back: string; deckId?: string | null; deck?: string | null; topic?: string | null; suspended?: boolean; tags?: string[] }> }) => {
      requireKey();
      const result = await bridge.bulkCreateFlashcards({
        cards: args.cards.map((c) => ({
          front: c.front,
          back: c.back,
          ...(c.deckId !== undefined ? { deckId: c.deckId } : {}),
          ...(c.deck !== undefined ? { deck: c.deck } : {}),
          ...(c.topic !== undefined ? { topic: c.topic } : {}),
          ...(c.suspended !== undefined ? { suspended: c.suspended } : {}),
          ...(c.tags !== undefined ? { tags: c.tags } : {}),
        })),
      });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const text = `Created ${cards.length} flashcard${cards.length === 1 ? '' : 's'}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}"${c.deck ? ` (deck: ${c.deck})` : ''}`).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { cards },
      };
    },
  );

  /* bulk update */
  server.registerTool(
    'bulk_update_flashcards',
    {
      title: 'Update multiple flashcards',
      description:
        'Atomically updates up to 100 existing flashcards in one request. Each item must include the card id plus any of front/back/deckId/deck/topic/suspended/tags to change (omitted fields keep their current values). Move cards between decks with deckId (stable deck id — preferred) or legacy deck name (deck); pass deckId: null (or deck: null) to detach a card from its deck; topic: null clears the topic; suspended sets the persisted suspended attribute (queryable via search_cards). The backend validates every item (including referenced deck ids), checks every id inside a single Firestore transaction, and commits atomically — either every update lands or none do. Returns the updated cards (ids that did not exist are omitted). Use this when several cards need the same fix (e.g. retagging or deck moves).',
      inputSchema: {
        cards: z.array(z.object({
          id: z.string().min(1, 'id is required'),
          front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
          back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
          deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').nullable().optional(),
          deck: z.string().max(100, 'Deck name too long').nullable().optional(),
          topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
          suspended: z.boolean().optional(),
          tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
        })).min(1, 'At least one card is required').max(100, 'No more than 100 cards per request'),
      },
      outputSchema: z.object({
        cards: z.array(flashcardObjectSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { cards: Array<{ id: string; front?: string; back?: string; deckId?: string | null; deck?: string | null; topic?: string | null; suspended?: boolean; tags?: string[] }> }) => {
      requireKey();
      const result = await bridge.bulkUpdateFlashcards({
        cards: args.cards.map((c) => {
          const { id, ...patch } = c;
          return { id, ...patch };
        }),
      });
      const cards = result.cards.map((c) => cardSummary(c as Flashcard));
      const text = `Updated ${cards.length} flashcard${cards.length === 1 ? '' : 's'}:\n` +
        cards.map((c) => `- ${c.id}: "${c.front}" → "${c.back}"${c.deck ? ` (deck: ${c.deck})` : ''}`).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { cards },
      };
    },
  );

  /* bulk delete */
  server.registerTool(
    'bulk_delete_flashcards',
    {
      title: 'Delete multiple flashcards',
      description:
        'Atomically deletes up to 100 flashcards by id in one request. The backend checks every id inside a single Firestore transaction and commits atomically — either every existing id is deleted or none are. Returns the ids actually deleted (ids that did not exist are omitted). Use this only when the user explicitly asks to delete several cards at once. To remove an entire deck, use delete_deck instead — it deletes the deck and detaches (does NOT delete) its cards.',
      inputSchema: {
        ids: z.array(z.string().min(1, 'id is required')).min(1, 'At least one id is required').max(100, 'No more than 100 ids per request'),
      },
      outputSchema: z.object({
        deletedIds: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { ids: string[] }) => {
      requireKey();
      const result = await bridge.bulkDeleteFlashcards({ ids: args.ids });
      const text = result.deletedIds.length === 0
        ? 'No flashcards were deleted (none of the given ids existed).'
        : `Deleted ${result.deletedIds.length} flashcard${result.deletedIds.length === 1 ? '' : 's'}: ${result.deletedIds.join(', ')}.`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* deck: create */
  server.registerTool(
    'create_deck',
    {
      title: 'Create a deck',
      description:
        'Creates a deck: a named group that flashcards reference by stable deckId. Deck names are unique — creating a deck with an existing name fails. Returns the created deck with its server-assigned id. Use this when the user wants to organize cards into a named deck, then create_flashcard/update_flashcard with that deckId.',
      inputSchema: deckInputShape,
      outputSchema: deckShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { name: string; description?: string }) => {
      requireKey();
      const deck = await bridge.createDeck({
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
      });
      const summary = deckSummary(deck);
      return {
        content: [{ type: 'text' as const, text: `Created deck ${summary.id}: "${summary.name}"${summary.description ? ` (${summary.description})` : ''}.` }],
        structuredContent: summary,
      };
    },
  );

  /* deck: list */
  server.registerTool(
    'list_decks',
    {
      title: 'List decks',
      description:
        'Lists decks, most recently created first, paginated with pageSize (1-100, default 20) and pageToken (pass the nextPageToken from a previous response to get the next page). Use this to find a deck id for filtering cards or assigning cards to a deck.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        decks: z.array(z.object(deckShape)),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { pageSize?: number; pageToken?: string }) => {
      requireKey();
      const result = await bridge.listDecks(args);
      const decks = result.decks.map((d) => deckSummary(d));
      const lines = decks.length === 0
        ? 'No decks found.'
        : decks.map((d) => `- ${d.id}: "${d.name}"${d.description ? ` (${d.description})` : ''}`).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call list_decks again with pageToken "${result.nextPageToken}".`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { decks, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* deck: get */
  server.registerTool(
    'get_deck',
    {
      title: 'Get a deck',
      description:
        'Returns one deck by its server-assigned id. Use this when the user references a specific deck (by id or by name — resolve the name to an id with list_decks first).',
      inputSchema: { id: z.string().min(1, 'id is required') },
      outputSchema: deckShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { id: string }) => {
      requireKey();
      const deck = await bridge.getDeck(args.id);
      const summary = deckSummary(deck);
      return {
        content: [{ type: 'text' as const, text: `${summary.id}: "${summary.name}"${summary.description ? ` (${summary.description})` : ''}` }],
        structuredContent: summary,
      };
    },
  );

  /* deck: update */
  server.registerTool(
    'update_deck',
    {
      title: 'Update a deck',
      description:
        'Updates a deck\'s name and/or description by id. Only the fields present in the arguments are changed; omitted fields keep their current values. Deck names are unique — renaming to a name used by another deck fails. When a deck is renamed, the backend also rewrites the deck name on all of its cards so filters and card summaries stay coherent. Returns the updated deck.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
        description: z.string().max(500, 'Description too long').optional(),
      },
      outputSchema: deckShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; name?: string; description?: string }) => {
      requireKey();
      const { id, ...input } = args;
      const deck = await bridge.updateDeck(id, input);
      const summary = deckSummary(deck);
      return {
        content: [{ type: 'text' as const, text: `Updated deck ${summary.id}: "${summary.name}"${summary.description ? ` (${summary.description})` : ''}.` }],
        structuredContent: summary,
      };
    },
  );

  /* deck: delete */
  server.registerTool(
    'delete_deck',
    {
      title: 'Delete a deck',
      description:
        'Deletes a deck by its server-assigned id. This is destructive to the DECK but NOT to its cards: the deck is removed and every card that referenced it is DETACHED (its deckId/deck fields are removed), leaving the cards themselves intact with all FSRS scheduling preserved. Cards are detached in chunked batches, so decks of any size can be deleted; if a batch fails partway, earlier detaches are already committed (the deck is not deleted) and retrying completes the rest. Returns { deleted: true, detachedCards: N }. Use this only when the user explicitly asks to delete a deck.',
      inputSchema: { id: z.string().min(1, 'id is required') },
      outputSchema: z.object({
        deleted: z.boolean(),
        detachedCards: z.number(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string }) => {
      requireKey();
      const result = await bridge.deleteDeck(args.id);
      return {
        content: [{ type: 'text' as const, text: `Deleted deck ${args.id}. Detached ${result.detachedCards} card${result.detachedCards === 1 ? '' : 's'} (cards preserved).` }],
        structuredContent: result,
      };
    },
  );

  /* image: attach */
  server.registerTool(
    'attach_image',
    {
      title: 'Attach an image to a flashcard',
      description:
        'Attaches an image to a flashcard by URL. The backend stores ONLY the URL reference plus optional alt text and MIME type — never the image bytes. The URL must be http(s) and point to an allowed image type: a declared mimeType in {image/jpeg, image/png, image/gif, image/webp, image/avif, image/bmp, image/svg+xml}, or a URL path ending in .jpg/.jpeg/.png/.gif/.webp/.avif/.bmp/.svg. A card can have at most 5 images. Does not affect FSRS scheduling. Returns the updated card and the attached image. Use this when the user provides an image link for a card.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        url: z.string().min(1, 'Image URL is required').max(2048, 'Image URL too long'),
        alt: z.string().max(500, 'Alt text too long').optional(),
        mimeType: z.string().max(100, 'MIME type too long').optional(),
      },
      outputSchema: z.object({
        card: flashcardObjectSchema,
        image: z.object(cardImageOutputShape),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; url: string; alt?: string; mimeType?: string }) => {
      requireKey();
      const { id, ...input } = args;
      const result = await bridge.attachImage(id, input);
      const summary = cardSummary(result.card);
      return {
        content: [{ type: 'text' as const, text: `Attached image to flashcard ${summary.id}: ${input.url}. Card now has ${summary.images.length} image(s).` }],
        structuredContent: {
          card: summary,
          image: cardImageSummary(result.image),
        },
      };
    },
  );

  /* image: upload */
  server.registerTool(
    'upload_image',
    {
      title: 'Upload an image to a flashcard (Firebase Storage)',
      description:
        'Uploads an image for a flashcard as base64 data. The backend decodes the bytes (max 10 MiB), validates the content type (allowed raster types: image/jpeg, image/png, image/gif, image/webp, image/avif, image/bmp — SVG is NOT accepted for upload), writes them to Firebase Storage under a card-scoped path, and persists metadata on the card: id, storagePath, downloadUrl (signed URL), contentType, sizeBytes, alt, addedAt. A card can have at most 5 images. Does not affect FSRS scheduling. Returns the updated card and the uploaded image with its cloud metadata. Use this when the user provides an image file or embedded/base64 image for a card.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        data: z.string().min(1, 'Image data is required').max(14000012, 'Image data too large'),
        fileName: z.string().min(1, 'fileName is required').max(255, 'fileName too long'),
        contentType: z.string().min(1, 'contentType is required').max(100, 'contentType too long'),
        alt: z.string().max(500, 'Alt text too long').optional(),
      },
      outputSchema: z.object({
        card: flashcardObjectSchema,
        image: z.object(cardImageOutputShape),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; data: string; fileName: string; contentType: string; alt?: string }) => {
      requireKey();
      const { id, ...input } = args;
      const result = await bridge.uploadImage(id, input);
      const summary = cardSummary(result.card);
      const img = cardImageSummary(result.image);
      return {
        content: [{ type: 'text' as const, text: `Uploaded image to flashcard ${summary.id} (${img.sizeBytes ?? '?'} bytes, ${img.mimeType ?? 'unknown'}): ${img.url}. Card now has ${summary.images.length} image(s).` }],
        structuredContent: {
          card: summary,
          image: img,
        },
      };
    },
  );

  /* image: list */
  server.registerTool(
    'list_card_images',
    {
      title: 'List a flashcard\'s images',
      description:
        'Lists the image attachments on a flashcard by id. Each image includes its id and url (the external URL for URL attachments, or the signed download URL for cloud uploads), optional alt/mimeType and addedAt, plus cloud metadata for uploaded images: storagePath, downloadUrl, and sizeBytes. Read-only. Use this to show the user which images are attached to a card or to get URLs for remove_image.',
      inputSchema: { id: z.string().min(1, 'id is required') },
      outputSchema: z.object({
        cardId: z.string(),
        images: z.array(z.object(cardImageOutputShape)),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { id: string }) => {
      requireKey();
      const result = await bridge.listImages(args.id);
      const images = result.images.map((img) => cardImageSummary(img));
      const lines = images.length === 0
        ? `Flashcard ${result.cardId} has no images attached.`
        : `Flashcard ${result.cardId} images (${images.length}):\n` + images.map((img) => `- ${img.url}${img.alt ? ` (${img.alt})` : ''}`).join('\n');
      return {
        content: [{ type: 'text' as const, text: lines }],
        structuredContent: { cardId: result.cardId, images },
      };
    },
  );

  /* image: remove */
  server.registerTool(
    'remove_image',
    {
      title: 'Remove an image from a flashcard',
      description:
        'Removes an image attachment from a flashcard by its URL. The URL must exactly match an attached image\'s url (get it from list_card_images or the card\'s images field). Returns { cardId, removed: true/false } — removed is false when no image with that URL was attached. The image file itself (hosted externally) is NOT deleted; only the card\'s reference to it is removed. Use this when the user asks to remove an image from a card.',
      inputSchema: {
        id: z.string().min(1, 'id is required'),
        url: z.string().min(1, 'Image URL is required').max(2048, 'Image URL too long'),
      },
      outputSchema: z.object({
        cardId: z.string(),
        removed: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { id: string; url: string }) => {
      requireKey();
      const result = await bridge.removeImage(args.id, { url: args.url });
      const text = result.removed
        ? `Removed image ${args.url} from flashcard ${result.cardId}.`
        : `No image with URL ${args.url} was attached to flashcard ${result.cardId} (nothing removed).`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* session: start */
  server.registerTool(
    'start_review_session',
    {
      title: 'Start a review session',
      description:
        'Starts a persistent review session: the backend snapshots EVERY selector/default-matching card into the session queue (never capped, no pagination). NO selectors -> the standard DUE queue (new + scheduled cards, earliest due first). Optional selectors (any combination): deckId (stable id) and/or deck (legacy name; deckId wins), tags (ANY-of - a card matching ANY listed tag qualifies), cardIds (explicit allowlist, deduped, every id must exist; combined with deck/tags by INTERSECTION). A selector-defined session may include NON-due cards - the selector query is authoritative; REVIEW_TEST_MODE only widens the DEFAULT due filter, never an explicit selection. The review widget renders the session, cards, source, and progress - DO NOT narrate, summarize, or repeat the session, its cards, its mode tag, progress, source, or the current card in your reply unless the user explicitly asks; the UI owns display. Returns the MINIMAL model-facing state: session id, status, mode, counters, and the current card id (full widget state incl. card content is delivered to the widget). When the session completes, the widget shows the Finish/Continue choice - do not narrate it. ALWAYS repeat the session modeTag to the user verbatim (e.g. "[Spaced repetition review - 12 cards - Due cards]") and report progress from visibleStatus ("X reviewed, Y remaining of N") - never invent or omit these. The queue is stable across retries: cards that become due later are NOT added. Sessions are scoped to the API key that starts them; only that key can get/submit/end them. Use this when the user wants to study a set of cards, e.g. "start a review session for my spanish deck" or "review my vocab-tagged cards".',
      inputSchema: {
        deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
        deck: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
        tags: z.array(z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long')).min(1).max(20).optional(),
        cardIds: z.array(z.string().min(1, 'Card id cannot be empty').max(200, 'Card id too long')).min(1).optional(),
        cardType: z.enum(['qa', 'cloze']).optional(),
        name: z.string().min(1, 'Session name cannot be empty').max(200, 'Session name too long').optional(),
        repeatSessionId: z.string().min(1, 'repeatSessionId cannot be empty').max(200, 'repeatSessionId too long').optional(),
      },
      outputSchema: z.object(sessionWithCardMinimalShape),
      _meta: REVIEW_WIDGET_TOOL_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { deckId?: string; deck?: string; tags?: string[]; cardIds?: string[]; cardType?: 'qa' | 'cloze'; name?: string; repeatSessionId?: string }) => {
      requireKey();
      const result = await bridge.startReviewSession({
        ...(args.deckId !== undefined ? { deckId: args.deckId } : {}),
        ...(args.deck !== undefined ? { deck: args.deck } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.cardIds !== undefined ? { cardIds: args.cardIds } : {}),
        ...(args.cardType !== undefined ? { cardType: args.cardType } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.repeatSessionId !== undefined ? { repeatSessionId: args.repeatSessionId } : {}),
      });
      return sessionWithCardText(result, 'Started review session', true);
    },
  );

  /* session: get */
  server.registerTool(
    'get_review_session',
    {
      title: 'Get a review session',
      description:
        'Retrieves a review session by id (any status: active, completed, or ended) plus the current card id (null when the queue is exhausted or the session is finished). The review widget renders the session state, mode tag, progress, and current card — DO NOT narrate, repeat the mode tag, or summarize progress in your reply unless the user explicitly asks; the UI owns display. Returns the MINIMAL model-facing state: session id, status, mode, counters, and the current card id. Only the API key that started the session can read it. Use this to resume an interrupted review flow (the widget hydrates from the hidden state); if the user asks for the actual card content, call get_flashcard.',
      inputSchema: {
        sessionId: z.string().min(1, 'sessionId is required'),
      },
      outputSchema: z.object(sessionWithCardMinimalShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { sessionId: string }) => {
      requireKey();
      const result = await bridge.getReviewSession(args.sessionId);
      return sessionWithCardText(result, `Review session ${result.session.id}`, false);
    },
  );

  /* session: submit review */
  server.registerTool(
    'submit_review',
    {
      title: 'Submit a rating for the current card of a review session',
      description:
        'Submits an FSRS rating (1=Again, 2=Hard, 3=Good, 4=Easy) for the EXPECTED current card of a review session (the card returned by start_review_session or get_review_session). The backend atomically applies the FSRS scheduler to that card AND advances the session (currentIndex, reviewedCount, ratingCounts, status) in one transaction, so retries and concurrent submissions can never double-apply a review or lose progress. Returns the MINIMAL model-facing state: session id, status, mode, counters, and the next current card id (full widget state is delivered to the widget — DO NOT narrate, repeat the mode tag, or summarize progress unless the user explicitly asks; the UI owns display). When the session completes, the widget shows the Finish/Continue choice — do not narrate it. If a snapshot card was deleted in the meantime it is skipped automatically. A session that is already completed or ended rejects the submission — start a new session. Optionally pass reviewAt (ISO 8601) as the review time; defaults to server time. Use this after the user answers the current card.',
      inputSchema: {
        sessionId: z.string().min(1, 'sessionId is required'),
        rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        reviewAt: z.string().datetime({ offset: true }).optional(),
        requestId: z.string().min(8, 'requestId too short').max(128, 'requestId too long').optional(),
        expectedCardId: z.string().min(1, 'expectedCardId cannot be empty').max(200, 'expectedCardId too long').optional(),
        expectedPosition: z.number().int().min(0, 'expectedPosition cannot be negative').optional(),
      },
      outputSchema: z.object(sessionWithCardMinimalShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { sessionId: string; rating: 1 | 2 | 3 | 4; reviewAt?: string; requestId?: string; expectedCardId?: string; expectedPosition?: number }) => {
      requireKey();
      const result = await bridge.submitSessionReview(args.sessionId, {
        rating: args.rating,
        ...(args.reviewAt !== undefined ? { reviewAt: args.reviewAt } : {}),
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
        ...(args.expectedCardId !== undefined ? { expectedCardId: args.expectedCardId } : {}),
        ...(args.expectedPosition !== undefined ? { expectedPosition: args.expectedPosition } : {}),
      });
      return sessionWithCardText(result, `Rated card (${args.rating}) in session ${result.session.id}`, false);
    },
  );

  /* session: end */
  server.registerTool(
    'end_review_session',
    {
      title: 'End a review session',
      description:
        'Ends an active review session without rating the remaining cards: the session status becomes ended with an endedAt timestamp, and it no longer accepts ratings. Idempotent — ending an already-completed or already-ended session is a no-op that returns it unchanged. Only the API key that started the session can end it. Use this when the user wants to stop studying before the queue is finished (or after a session started with an empty due queue).',
      inputSchema: {
        sessionId: z.string().min(1, 'sessionId is required'),
      },
      outputSchema: z.object(sessionShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { sessionId: string }) => {
      requireKey();
      const session = await bridge.endReviewSession(args.sessionId);
      const summary = sessionSummary(session);
      return {
        // Empty model-facing content — the widget renders the ended state.
        content: [],
        structuredContent: summary,
      };
    },
  );

  /* tag: list — derived whole-library tag census, sorted by name ascending */
  server.registerTool(
    'list_tags',
    {
      title: 'List all tags',
      description:
        'Lists the DISTINCT tags in the whole library (exact, case-sensitive names derived from every flashcard\'s tags array — there is no tag collection), each with the number of cards carrying it, sorted by tag name ASCENDING and paginated with pageSize (1-100, default 20) and pageToken (pass the nextPageToken — the last tag name of the previous page — to get the next page). Use this to enumerate existing tag names before rename_tag/delete_tag/merge_tags, or to show the user which tags exist and how many cards carry each. Read-only.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        tags: z.array(z.object(tagOutputShape)),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { pageSize?: number; pageToken?: string }) => {
      requireKey();
      const result: ListTagsResponse = await bridge.listTags(args);
      const tags = result.tags.map((t) => tagSummary(t));
      const lines = tags.length === 0
        ? 'No tags found.'
        : tags.map((t) => `- ${t.name} (${t.cardCount} card${t.cardCount === 1 ? '' : 's'})`).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call list_tags again with pageToken "${result.nextPageToken}".`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { tags, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* tag: rename — replaces one exact tag name with another on every card carrying it */
  server.registerTool(
    'rename_tag',
    {
      title: 'Rename a tag',
      description:
        'Renames a tag across the WHOLE library: every card carrying `from` (matched EXACTLY, case-sensitive — no normalization, lowercasing, or trimming) has that entry replaced by `to` in its tags array. When a card already carries `to`, the result is a single clean `to` (the backend deduplicates each card\'s tags preserving order — the outcome equals merge_tags for that card). Cards themselves are otherwise untouched (content, deck, topic, images, suspension, and FSRS scheduling are preserved); their `updatedAt` is refreshed. `from` and `to` must differ and each is 1-50 characters — tag names may contain spaces. A `from` that no card carries is a successful no-op (affectedCards: 0) — matching a missing tag is never an error. Returns the number of CARD documents rewritten. Use this when the user wants to fix or standardize a tag name, e.g. "rename the tag \'vocab \' to \'vocabulary\'" (note: the trailing space makes it a DIFFERENT exact name — list_tags shows the exact stored names).',
      inputSchema: tagFromToInputShape,
      outputSchema: { affectedCards: z.number() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { from: string; to: string }) => {
      requireKey();
      if (args.from === args.to) {
        throw new Error('from and to must be different tag names');
      }
      const result: TagActionResult = await bridge.renameTag({ from: args.from, to: args.to });
      const text = result.affectedCards === 0
        ? `No cards carried "${args.from}" — nothing renamed.`
        : `Renamed tag "${args.from}" → "${args.to}" on ${result.affectedCards} card${result.affectedCards === 1 ? '' : 's'}.`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* tag: delete — removes one exact tag from every card carrying it */
  server.registerTool(
    'delete_tag',
    {
      title: 'Delete a tag',
      description:
        'Deletes a tag across the WHOLE library: `name` is removed from the tags array of every card carrying it (matched EXACTLY, case-sensitive — no normalization, lowercasing, or trimming). The CARDS themselves are completely untouched: content, deck, topic, images, suspension, and FSRS scheduling are preserved; only the tag entry disappears (a card whose array becomes empty keeps an empty tags array) and the rewritten cards\' `updatedAt` is refreshed. `name` is 1-50 characters and may contain spaces. A name that no card carries is a successful no-op (affectedCards: 0) — matching a missing tag is never an error. DESTRUCTIVE and irreversible: the tag is removed from every card in the library at once, with no per-card undo. To only reorganize, prefer rename_tag or merge_tags; use this only when the user explicitly asks to remove a tag everywhere (e.g. "delete the tag \'old\' from all my cards"). Returns the number of CARD documents rewritten.',
      inputSchema: { name: tagNameInputShape },
      outputSchema: { affectedCards: z.number() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { name: string }) => {
      requireKey();
      const result: TagActionResult = await bridge.deleteTag({ name: args.name });
      const text = result.affectedCards === 0
        ? `No cards carried "${args.name}" — nothing deleted.`
        : `Deleted tag "${args.name}" from ${result.affectedCards} card${result.affectedCards === 1 ? '' : 's'} (cards themselves untouched).`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* tag: merge — unions one exact tag into another across the whole library */
  server.registerTool(
    'merge_tags',
    {
      title: 'Merge a tag into another',
      description:
        'Merges `from` into `to` across the WHOLE library with UNION semantics: every card carrying `from` (matched EXACTLY, case-sensitive — no normalization, lowercasing, or trimming) has `from` removed from its tags array and `to` ensured on it (deduplicated — a card already carrying `to` keeps a single clean copy; cards carrying neither are untouched). Cards themselves are otherwise preserved (content, deck, topic, images, suspension, FSRS scheduling) except that rewritten cards\' `updatedAt` is refreshed. `from` and `to` must differ and each is 1-50 characters — tag names may contain spaces. After the merge `from` no longer exists anywhere and every affected card carries `to` — the per-tag counts combine (card counts reflect the single surviving tag). A `from` that no card carries is a successful no-op (affectedCards: 0) — matching a missing tag is never an error. Returns the number of CARD documents rewritten. Use this when the user wants to combine two tags into one, e.g. "merge the tag \'vocab\' into \'vocabulary\'" — the union outcome is the same as rename_tag when `to` already exists; merge_tags is the explicit whole-library choice.',
      inputSchema: tagFromToInputShape,
      outputSchema: { affectedCards: z.number() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { from: string; to: string }) => {
      requireKey();
      if (args.from === args.to) {
        throw new Error('from and to must be different tag names');
      }
      const result: TagActionResult = await bridge.mergeTags({ from: args.from, to: args.to });
      const text = result.affectedCards === 0
        ? `No cards carried "${args.from}" — nothing merged.`
        : `Merged tag "${args.from}" into "${args.to}" on ${result.affectedCards} card${result.affectedCards === 1 ? '' : 's'}.`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );



  /* analytics: review history (actor-scoped, cursor-paginated) */
  server.registerTool(
    'get_review_history',
    {
      title: 'Get review history',
      description:
        'Reads the ACTOR\'S review-event history (the current API key\'s own reviews) — newest first, cursor-paginated. Filters (all optional, combined by AND): from (inclusive reviewedAt lower bound, ISO 8601 or YYYY-MM-DD), to (EXCLUSIVE upper bound — [from, to); a date-only `to` excludes the whole day it names), cardId, deckId, ratings (array of 1=Again..4=Easy; ANY-of), pageSize (1-100, default 50). Each event: id, cardId, actorId, rating, stateBefore, reviewedAt/recordedAt (ISO), stabilityAfter/difficultyAfter/repsAfter/lapsesAfter, dueBefore/dueAfter (ISO), deckId/deckName, cardFrontSnapshot (<=300 chars), sessionId. Pass nextPageToken with the SAME filters for the next page. Read-only.',
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        cardId: z.string().optional(),
        deckId: z.string().optional(),
        ratings: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])).min(1).max(4).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      outputSchema: z.object({
        events: z.array(z.object({
          id: z.string(),
          cardId: z.string(),
          actorId: z.string(),
          rating: z.number(),
          stateBefore: z.number(),
          reviewedAt: z.string(),
          recordedAt: z.string(),
          stabilityAfter: z.number(),
          difficultyAfter: z.number(),
          repsAfter: z.number(),
          lapsesAfter: z.number(),
          dueBefore: z.string().optional(),
          dueAfter: z.string().optional(),
          deckId: z.string().optional(),
          deckName: z.string().optional(),
          cardFrontSnapshot: z.string(),
          sessionId: z.string().optional(),
        })),
        nextPageToken: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: {
      from?: string; to?: string; cardId?: string; deckId?: string;
      ratings?: number[]; pageSize?: number; pageToken?: string;
    }) => {
      requireKey();
      const result: ReviewHistoryResponse = await bridge.getReviewHistory(args);
      const lines = result.events.length === 0
        ? 'No review events found.'
        : result.events.map((e) => {
          const deck = e.deckName !== undefined ? ` [${e.deckName}]` : '';
          return `- ${e.reviewedAt} ${e.cardFrontSnapshot}${deck} rating=${e.rating} stateBefore=${e.stateBefore}`;
        }).join('\n');
      let text = lines;
      if (result.nextPageToken) text += `\n\nMore results available. Call get_review_history again with pageToken "${result.nextPageToken}" (same filters).`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { events: result.events, nextPageToken: result.nextPageToken },
      };
    },
  );

  /* analytics: study stats (read-time aggregation) */
  server.registerTool(
    'get_study_stats',
    {
      title: 'Get study statistics',
      description:
        'Computes study statistics for the ACTOR\'S reviews by read-time aggregation over the reviewEvents collection within a REQUIRED reviewedAt window [from, to) (from inclusive, to exclusive; ISO 8601 or YYYY-MM-DD). Optional deckId restricts to events of one deck; optional topLimit (1-25, default 10) sizes the top-lapsed ranking. Returns the FLAT stats object: from, to, totalReviews, ratingCounts (again/hard/good/easy), ratingPercentages (0..1), observedRetention (successful 2/3/4 divided by totalReviews), matureReviews (pre-review state Review/Relearning), matureRatingCounts, matureRetention (successful mature / mature), topLapsedCards. LAPSE DEFINITION: ratingCounts.again counts EVERY Again rating (Learning/New/Relearning included); the persisted card `lapses` field and topLapsedCards count ONLY FSRS mature failures — Again ratings from the Review state (2), the exact ts-fsrs lapse rule. NOTE: the attached topLapsedCards are a CURRENT library/card-state ranking (the same semantics as get_top_lapsed_cards) and are NOT attributed by event actor, unlike the actor-scoped event aggregates in this response. Read-only.',
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        deckId: z.string().optional(),
        topLimit: z.number().int().min(1).max(25).optional(),
      },
      outputSchema: z.object({
        from: z.string(),
        to: z.string(),
        totalReviews: z.number(),
        ratingCounts: z.object({ again: z.number(), hard: z.number(), good: z.number(), easy: z.number() }),
        ratingPercentages: z.object({ again: z.number(), hard: z.number(), good: z.number(), easy: z.number() }),
        observedRetention: z.number().nullable(),
        matureReviews: z.number(),
        matureRatingCounts: z.object({ again: z.number(), hard: z.number(), good: z.number(), easy: z.number() }),
        matureRetention: z.number().nullable(),
        topLapsedCards: z.array(z.object({
          cardId: z.string(), lapses: z.number(), reps: z.number(), front: z.string(),
          deckId: z.string().optional(), deckName: z.string().optional(), lastReview: z.string().optional(),
        })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { from: string; to: string; deckId?: string; topLimit?: number }) => {
      requireKey();
      const result: StudyStatsResponse = await bridge.getStudyStats(args);
      const pct = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
      const text = [
        `Total reviews: ${result.totalReviews}`,
        `Ratings: ${result.ratingCounts.again} again / ${result.ratingCounts.hard} hard / ${result.ratingCounts.good} good / ${result.ratingCounts.easy} easy`,
        `Observed retention: ${pct(result.observedRetention)} (successful / total)`,
        `Mature reviews: ${result.matureReviews} (mature retention ${pct(result.matureRetention)})`,
        `Top-lapsed: ${result.topLapsedCards.length === 0 ? 'none' : result.topLapsedCards.map((c) => `${c.cardId} (${c.lapses})`).join(', ')}`,
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* analytics: top-lapsed cards (current all-time ranking) */
  server.registerTool(
    'get_top_lapsed_cards',
    {
      title: 'Get top-lapsed cards',
      description:
        'Ranks the library\'s cards by CURRENT all-time lapse count: the cards\' persisted `lapses` field, which counts ONLY FSRS MATURE FAILURES — Again ratings from the Review state (2), the exact ts-fsrs lapse rule (Learning/New/Relearning Again ratings never increment it) — read at request time. Zero-lapse cards are excluded; the ranking is served by an indexed query (lapses > 0, orderBy lapses desc) and bounded to `limit` (1-25, default 10). Optional deckId restricts to cards currently in one deck. Each entry: cardId, lapses, reps, front (current), deckId/deckName, lastReview. Read-only.',
      inputSchema: {
        deckId: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      outputSchema: z.object({
        cards: z.array(z.object({
          cardId: z.string(), lapses: z.number(), reps: z.number(), front: z.string(),
          deckId: z.string().optional(), deckName: z.string().optional(), lastReview: z.string().optional(),
        })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { deckId?: string; limit?: number }) => {
      requireKey();
      const result: TopLapsedResponse = await bridge.getTopLapsedCards(args);
      const text = result.cards.length === 0
        ? 'No cards with lapses found.'
        : result.cards.map((c) => `- ${c.cardId} (${c.lapses} lapse${c.lapses === 1 ? '' : 's'}, ${c.reps} reviews)${c.deckName ? ` [${c.deckName}]` : ''}`).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* analytics: explicit legacy reviewLog backfill migration */
  server.registerTool(
    'migrate_review_events',
    {
      title: 'Migrate legacy review events',
      description:
        'EXPLICIT, operator-invoked maintenance migration: backfills `reviewEvents` documents from card-embedded reviewLog arrays written before the event model shipped (the embedded log is bounded to the newest 100 entries per card — older entries were already trimmed and are unrecoverable). REQUIRED body: legacyActorId — the operator-supplied actor id recorded on migrated events (never hardcoded). Optional: pageSize (1-100 cards per call, default 100) and resumeAfterCardId (resume a previous run at a card cursor). Idempotent: deterministic event ids + pre-write existence checks mean re-runs never duplicate. Returns { cardsMigrated, eventsWritten, hasMore }; call repeatedly (passing resumeAfterCardId as needed) until hasMore is false. NEVER call automatically.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional(),
        legacyActorId: z.string().min(1),
        resumeAfterCardId: z.string().optional(),
      },
      outputSchema: z.object({
        cardsMigrated: z.number(),
        eventsWritten: z.number(),
        hasMore: z.boolean(),
        nextResumeAfterCardId: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { pageSize?: number; legacyActorId: string; resumeAfterCardId?: string }) => {
      requireKey();
      const result: MigrateReviewEventsResponse = await bridge.migrateReviewEvents(args);
      const resume = result.nextResumeAfterCardId !== null ? ` Pass resumeAfterCardId "${result.nextResumeAfterCardId}" on the next call.` : '';
      const text = `Migrated ${result.cardsMigrated} cards (${result.eventsWritten} events written).${result.hasMore ? ' More cards remain.' + resume : (result.nextResumeAfterCardId !== null ? resume : '')}`;
            return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* anki: import .apkg */
  server.registerTool(
    'import_apkg',
    {
      title: 'Import flashcards from an Anki .apkg package',
      description:
        'Imports a standard Anki package (.apkg — a ZIP containing a SQLite collection.anki2) into the library. Pass the WHOLE package file base64-encoded in `package` (base64 of the .apkg bytes; the request is bounded to 20 MiB decoded and the import to 1000 cards). Each Anki note becomes one flashcard: the note model\'s Front/Back (or Cloze Text/Extra) fields are converted from HTML to plain text, tags are kept (max 30 per card), and each note\'s deck is found-or-created (deck names may be nested like "Spanish::Verbs"). Deterministic and safe: malformed packages are rejected with no partial writes (a single batch commits atomically up to 500 cards); notes with 0 or 2+ cards (reversed/multi-cloze) and empty-field notes are SKIPPED and reported in skippedNotes/skippedEmpty. Optional deckPath overrides the deck for every imported card. After import, list_flashcards/search_cards shows the new cards. Returns the imported cards plus skip counts.',
      inputSchema: {
        package: z.string().min(1, 'package (base64 .apkg) is required').max(33554448, 'package too large (max 20 MiB decoded)'),
        deckPath: z.string().min(1, 'deckPath cannot be empty').max(300, 'deckPath too long (max 300 chars)').optional(),
      },
      outputSchema: z.object({
        cards: z.array(z.object({
          front: z.string(),
          back: z.string(),
          deckPath: z.string().nullable(),
          tags: z.array(z.string()),
        })),
        skippedNotes: z.number(),
        skippedEmpty: z.number(),
        skippedOverLimit: z.number(),
        atomic: z.boolean(),
        batchCount: z.number(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { package: string; deckPath?: string }) => {
      requireKey();
      const result = await bridge.importApkg(args);
      const n = result.cards.length;
      const skipped = result.skippedNotes + result.skippedEmpty;
      const text = `Imported ${n} flashcard${n === 1 ? '' : 's'} from the .apkg package${skipped > 0 ? ` (${skipped} note${skipped === 1 ? '' : 's'} skipped: ${result.skippedNotes} multi-card/empty-notes, ${result.skippedEmpty} empty-field)` : ''}${result.skippedOverLimit > 0 ? `; ${result.skippedOverLimit} over the 1000-card limit were not imported` : ''}. Atomic write: ${result.atomic ? 'yes' : `no (${result.batchCount} batches)`}.`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );

  /* anki: export .apkg */
  server.registerTool(
    'export_apkg',
    {
      title: 'Export flashcards to an Anki .apkg package',
      description:
        'Exports flashcards into a valid Anki .apkg package. The response `package` field is the base64 encoding of the whole .apkg ZIP (a collection.anki2 + embedded media) — decode and save it with a .apkg extension to open in Anki. Selection (exactly one): NO arguments exports the newest 1000 cards; `deck` exports every card of that deck (exact deck name, may be nested like "Spanish::Verbs"); `cardIds` exports the listed cards (max 1000, missing ids are omitted and counted in filteredCards). Review cards carry their scheduling where Anki-compatible (state/interval/due day-ordinal, reps/lapses, and the FSRS review history becomes Anki revlog); cloze cards (front contains [answer]) export as Anki cloze notes. Stored card images are embedded ONLY from public https URLs (server-side fetches are DNS-pinned (only public addresses are connected to), refuse private/link-local/metadata/loopback targets and plaintext http, and never auto-follow redirects to them — an SSRF guard), bounded (4 MiB/file, 100 files, 8 MiB total); refused/unreachable/oversized images are listed in mediaSkipped with reasons. Content round-trips as text (formatting is not preserved). Returns the base64 package plus counts and media details.',
      inputSchema: {
        deck: z.string().min(1, 'deck cannot be empty').max(300, 'deck too long (max 300 chars)').optional(),
        cardIds: z.array(z.string().min(1, 'card id cannot be empty').max(200, 'card id too long'))
          .min(1, 'At least one card id is required')
          .max(1000, 'No more than 1000 card ids per request')
          .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' })
          .optional(),
      },
      outputSchema: z.object({
        package: z.string(),
        cardCount: z.number(),
        filteredCards: z.number(),
        decks: z.array(z.string().nullable()),
        media: z.array(z.object({ fileName: z.string(), sourceUrl: z.string() })),
        mediaSkipped: z.array(z.object({ url: z.string(), reason: z.string() })),
        schedulingExported: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { deck?: string; cardIds?: string[] }) => {
      requireKey();
      const result = await bridge.exportApkg(args);
      const text = `Exported ${result.cardCount} card${result.cardCount === 1 ? '' : 's'} to a valid .apkg package (base64 in \`package\`; decode and save as *.apkg).${result.filteredCards > 0 ? ` ${result.filteredCards} card${result.filteredCards === 1 ? '' : 's'} excluded by the selection.` : ''}${result.media.length > 0 ? ` Embedded ${result.media.length} media file${result.media.length === 1 ? '' : 's'}.` : ''}${result.mediaSkipped.length > 0 ? ` ${result.mediaSkipped.length} image${result.mediaSkipped.length === 1 ? '' : 's'} not embedded (${result.mediaSkipped.map((m) => m.reason).join('; ')}).` : ''}`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: result,
      };
    },
  );
}

/** Builds a QUIET session-with-card response.
 *
 * Model-facing content/structuredContent are MINIMAL (session id, status,
 * current card id, counters) so the assistant does not narrate the session or
 * the current card's front/back/progress. The FULL session/card/preload
 * state rides in a hidden `_meta['ui/widgetState']` consumed by the Apps SDK
 * review widget. */
function sessionWithCardText(
  result: ReviewSessionWithCard,
  _label: string,
  link: boolean,
): { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown>; _meta: Record<string, unknown> } {
  const s = sessionSummary(result.session);
  const card = result.card !== null && result.card !== undefined ? cardSummary(result.card as Flashcard) : null;
  // Model-facing CONTENT is EMPTY (no transcript text): the widget owns all
  // display, and the model must not narrate the session/card/progress. The
  // MINIMAL structuredContent (session id/status/mode/counters + card id)
  // gives explicit context when the model needs it.
  const structuredContent = {
    session: {
      id: s.id,
      status: s.status,
      mode: s.mode,
      ...(s.storageVersion !== undefined ? { storageVersion: s.storageVersion } : {}),
      ...(s.buildStatus !== undefined ? { buildStatus: s.buildStatus } : {}),
      currentIndex: s.currentIndex,
      ...(s.currentPosition !== undefined ? { currentPosition: s.currentPosition } : {}),
      ...(s.currentChunkIndex !== undefined ? { currentChunkIndex: s.currentChunkIndex } : {}),
      reviewedCount: s.reviewedCount,
      remainingCount: s.remainingCount,
      ...(s.totalCount !== undefined ? { totalCount: s.totalCount } : {}),
    },
    card: card ? { id: card.id } : null,
    ...(loadConfig().reviewTestMode ? { testMode: true } : {}),
  };
  // FULL widget state (session, card, preloaded) in the hidden Apps SDK
  // _meta['ui/widgetState'] consumed by the review widget.
  const widgetState: ReviewSessionWithCardSummary = {
    session: s,
    card,
    preloaded: (result.preloaded ?? []).map((p) => ({
      id: p.id,
      front: p.front,
      back: p.back,
      ...(p.deck !== undefined ? { deck: p.deck } : {}),
      tags: p.tags ?? [],
      ...((p as { position?: number }).position !== undefined ? { position: (p as { position?: number }).position } : {}),
    })),
    ...(result.currentPosition !== undefined ? { currentPosition: result.currentPosition } : {}),
    ...(result.queueWindow !== undefined ? { queueWindow: result.queueWindow } : {}),
    ...((result as { requestId?: string }).requestId !== undefined ? { requestId: (result as { requestId?: string }).requestId } : {}),
  };
  return {
    content: [],
    structuredContent,
    _meta: {
      // ONLY start_review_session advertises the UI resource linkage (it
      // mounts the persistent widget once). get/submit are data-only: they
      // still carry the hidden widgetState so an ALREADY-mounted widget can
      // hydrate from their direct callTool results, but they must NOT cause a
      // duplicate widget to render.
      ...(link ? { ui: { resourceUri: REVIEW_WIDGET_URI }, 'ui/resourceUri': REVIEW_WIDGET_URI, 'openai/outputTemplate': REVIEW_WIDGET_URI } : {}),
      'ui/widgetState': widgetState,
      ...(loadConfig().reviewTestMode ? { 'review/testMode': true } : {}),
    },
  };
}

export { asError as extractError };

function asError(err: unknown): { isMcpError: boolean; message: string } {
  if (err instanceof FirebaseBridgeError) {
    return { isMcpError: true, message: err.message };
  }
  if (err instanceof Error) {
    return { isMcpError: false, message: err.message };
  }
  return { isMcpError: false, message: String(err) };
}

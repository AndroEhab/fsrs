/**
 * Pure helpers for the review-history and study-statistics surfaces.
 *
 * Firestore CAN express the history filter set as a composite query
 * (`actorId` + optional `cardId`/`deckId`/`rating` + `reviewedAt` range,
 * ordered by reviewedAt desc then document id asc), so history uses real
 * cursor pagination. Study stats use Firestore read-time AGGREGATION queries
 * (count()/sum() over the actor's event scope) — the pure helpers here only
 * derive per-document counters from a single event doc's stored fields and
 * shape the response, never by downloading every matching event.
 */

import {
  CardState, ReviewEvent, ReviewHistoryItem, ReviewHistoryQuery, ReviewRating, StudyStats, TopLapsedCard,
} from './types';

/**
 * Normalized, comparable form of a history query's filters. Time bounds are
 * whole-millisecond instants; page tokens embed a fingerprint of exactly
 * these filters.
 */
export interface HistoryFilters {
  /** Inclusive lower bound (ms, UTC). */
  fromMs?: number;
  /** Exclusive upper bound (ms, UTC) — [from, to). */
  toMs?: number;
  cardId?: string;
  deckId?: string;
  /** Restrict to events of ANY of these ratings (canonicalized, sorted). */
  ratings?: ReviewRating[];
}

/** Decoded cursor payload of a history page token. */
export interface HistoryTokenPayload {
  filtersKey: string;
  lastReviewedAtMs: number;
  lastId: string;
}

/**
 * Parses an accepted date bound (search_cards format). YYYY-MM-DD → UTC
 * midnight of that day; full ISO 8601 date-times pass through Date.parse.
 * History `to` is EXCLUSIVE — a date-only `to` excludes the whole day it
 * names. Returns undefined for malformed input.
 */
export function parseHistoryBound(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const day = Date.UTC(y, mo - 1, d);
    const check = new Date(day);
    if (Number.isNaN(day) || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return undefined;
    }
    return day;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Normalizes a validated history query into its canonical filter form. */
export function normalizeHistoryFilters(query: ReviewHistoryQuery): HistoryFilters {
  const fromMs = parseHistoryBound(query.from);
  const toMs = parseHistoryBound(query.to);
  const cardId = query.cardId !== undefined && query.cardId !== '' ? query.cardId : undefined;
  const deckId = query.deckId !== undefined && query.deckId !== '' ? query.deckId : undefined;
  const ratings = Array.isArray(query.ratings) && query.ratings.length > 0
    ? [...new Set(query.ratings)].sort((a, b) => a - b)
    : undefined;
  return {
    ...(fromMs !== undefined ? { fromMs } : {}),
    ...(toMs !== undefined ? { toMs } : {}),
    ...(cardId !== undefined ? { cardId } : {}),
    ...(deckId !== undefined ? { deckId } : {}),
    ...(ratings !== undefined ? { ratings } : {}),
  };
}

/** Canonical JSON key of a history filter set — equal sets iff keys match. */
export function historyFiltersKey(filters: HistoryFilters): string {
  return JSON.stringify({
    fromMs: filters.fromMs ?? null,
    toMs: filters.toMs ?? null,
    cardId: filters.cardId ?? null,
    deckId: filters.deckId ?? null,
    ratings: filters.ratings ?? null,
  });
}

/** Encodes a cursor token: base64url(JSON{ filtersKey, lastReviewedAtMs, lastId }). */
export function makeHistoryPageToken(filters: HistoryFilters, lastReviewedAtMs: number, lastId: string): string {
  const payload: HistoryTokenPayload = { filtersKey: historyFiltersKey(filters), lastReviewedAtMs, lastId };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Decodes a cursor token; returns null when malformed. */
export function readHistoryPageToken(token: string): HistoryTokenPayload | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as Partial<HistoryTokenPayload>;
    if (typeof parsed.filtersKey !== 'string' || typeof parsed.lastReviewedAtMs !== 'number' || typeof parsed.lastId !== 'string') {
      return null;
    }
    return parsed as HistoryTokenPayload;
  } catch {
    return null;
  }
}

/**
 * True when an event sorts strictly AFTER the cursor in the total order
 * (reviewedAt DESC, document id ASC — Firestore's native tie-break).
 */
export function eventAfterCursor(
  reviewedAtMs: number,
  id: string,
  lastReviewedAtMs: number,
  lastId: string,
): boolean {
  if (reviewedAtMs !== lastReviewedAtMs) return reviewedAtMs < lastReviewedAtMs;
  return id > lastId;
}

/**
 * Converts a Firestore Timestamp-shaped raw value (or Date) to a Date.
 * Anything unrecognizable falls back to the epoch. Runtime-narrowed.
 */
export function tsToDate(value: unknown): Date {
  if (value !== null && typeof value === 'object' && 'toDate' in value) {
    const toDate = (value as { toDate: unknown }).toDate;
    if (typeof toDate === 'function') {
      const d = toDate.call(value);
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
  }
  if (value instanceof Date) return value;
  return new Date(0);
}

/**
 * The maturity bucket of a card's CURRENT FSRS state (0=New, 1=Learning,
 * 2=Review, 3=Relearning). Legacy documents without a persisted state read
 * as New. Stable domain definition.
 */
export function maturityBucket(state: number | undefined): CardState {
  if (state === 0 || state === 1 || state === 2 || state === 3) {
    return state as CardState;
  }
  return 0;
}

/** True when a pre-review card state is a MATURE state (Review or Relearning). */
export function isMaturePreState(state: number | undefined): boolean {
  return state === 2 || state === 3;
}

/** Rating histogram shape (named keys: again/hard/good/easy). */
export interface RatingHistogram {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

/** Maps an FSRS rating (1..4) to its named histogram key. */
export const RATING_KEY: Record<number, keyof RatingHistogram> = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

/** A zeroed rating histogram. */
export function emptyHistogram(): RatingHistogram {
  return { again: 0, hard: 0, good: 0, easy: 0 };
}

/**
 * The rating-derived counters of ONE event document:
 *  - ratingCounts: the rating histogram over all reviews.
 *  - mature: the pre-review state was Review (2) or Relearning (3).
 *  - matureRatingCounts: the rating histogram over mature reviews.
 * A review is SUCCESSFUL when rated 2/3/4; successful mature reviews are
 * mature reviews rated 2/3/4.
 */
export interface EventCounters {
  total: number;
  ratingCounts: RatingHistogram;
  mature: number;
  matureRatingCounts: RatingHistogram;
}

/** Derives the counters of one stored event. Pure and directly testable. */
export function eventCounters(event: {
  rating?: unknown; stateBefore?: unknown; state?: unknown;
}): EventCounters {
  const rating = typeof event.rating === 'number' ? (event.rating as ReviewRating) : 0;
  const pre = typeof event.stateBefore === 'number' ? event.stateBefore
    : typeof event.state === 'number' ? event.state : 0;
  const mature = isMaturePreState(pre);
  const hist = emptyHistogram();
  if (rating >= 1 && rating <= 4) hist[RATING_KEY[rating]] = 1;
  return {
    total: 1,
    ratingCounts: hist,
    mature: mature ? 1 : 0,
    matureRatingCounts: mature ? hist : emptyHistogram(),
  };
}

/** The summed counters over an event set. */
export interface AggregatedCounters {
  totalReviews: number;
  ratingCounts: RatingHistogram;
  matureReviews: number;
  matureRatingCounts: RatingHistogram;
}

/** Sums per-event counters. */
export function sumEventCounters(events: EventCounters[]): AggregatedCounters {
  const out: AggregatedCounters = {
    totalReviews: 0,
    ratingCounts: emptyHistogram(),
    matureReviews: 0,
    matureRatingCounts: emptyHistogram(),
  };
  for (const e of events) {
    out.totalReviews += e.total;
    for (const key of ['again', 'hard', 'good', 'easy'] as const) {
      out.ratingCounts[key] += e.ratingCounts[key];
      out.matureRatingCounts[key] += e.matureRatingCounts[key];
    }
    out.matureReviews += e.mature;
  }
  return out;
}

/** 3-decimal rounding of a fraction (0..1); 0 when the denominator is 0. */
export function round3(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** ratingCounts expressed as fractions of totalReviews (0..1, 3-decimal). */
export function ratingPercentagesOf(counters: AggregatedCounters): RatingHistogram {
  const out = emptyHistogram();
  for (const key of ['again', 'hard', 'good', 'easy'] as const) {
    out[key] = round3(counters.ratingCounts[key], counters.totalReviews);
  }
  return out;
}

/** Successful reviews (2/3/4) / totalReviews; null when none. */
export function observedRetentionOf(counters: AggregatedCounters): number | null {
  if (counters.totalReviews === 0) return null;
  const successful = counters.ratingCounts.hard + counters.ratingCounts.good + counters.ratingCounts.easy;
  return round3(successful, counters.totalReviews);
}

/** Successful mature reviews / matureReviews; null when none mature. */
export function matureRetentionOf(counters: AggregatedCounters): number | null {
  if (counters.matureReviews === 0) return null;
  const successful = counters.matureRatingCounts.hard + counters.matureRatingCounts.good + counters.matureRatingCounts.easy;
  return round3(successful, counters.matureReviews);
}

/** True when an event document's stored timestamp falls in [fromMs, toMs). */
export function tsInWindow(value: unknown, fromMs?: number, toMs?: number): boolean {
  const ms = tsToDate(value).getTime();
  if (fromMs !== undefined && ms < fromMs) return false;
  if (toMs !== undefined && ms >= toMs) return false;
  return true;
}

/** Builds a StudyStats from derived counters (response shaping). */
export function buildStudyStats(
  counters: AggregatedCounters,
  scope: { from: string; to: string },
  topLapsedCards: TopLapsedCard[] = [],
): StudyStats {
  return {
    from: scope.from,
    to: scope.to,
    totalReviews: counters.totalReviews,
    ratingCounts: counters.ratingCounts,
    ratingPercentages: ratingPercentagesOf(counters),
    observedRetention: observedRetentionOf(counters),
    matureReviews: counters.matureReviews,
    matureRatingCounts: counters.matureRatingCounts,
    matureRetention: matureRetentionOf(counters),
    topLapsedCards,
  };
}

/** Normalizes a stored event into the read model the history endpoint returns. */
export function eventToHistoryItem(event: ReviewEvent): ReviewHistoryItem {
  return {
    id: event.id,
    cardId: event.cardId,
    actorId: event.actorId,
    rating: event.rating,
    stateBefore: event.stateBefore,
    reviewedAt: tsToDate(event.reviewedAt).toISOString(),
    recordedAt: tsToDate(event.recordedAt).toISOString(),
    stabilityAfter: event.stabilityAfter,
    difficultyAfter: event.difficultyAfter,
    repsAfter: event.repsAfter,
    lapsesAfter: event.lapsesAfter,
    ...(event.dueBefore ? { dueBefore: tsToDate(event.dueBefore).toISOString() } : {}),
    ...(event.dueAfter ? { dueAfter: tsToDate(event.dueAfter).toISOString() } : {}),
    ...(event.deckId !== undefined ? { deckId: event.deckId } : {}),
    ...(event.deckName !== undefined ? { deckName: event.deckName } : {}),
    cardFrontSnapshot: event.cardFrontSnapshot,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
  };
}

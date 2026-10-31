/**
 * Pure helpers for the rich flashcard query (`searchCards`).
 *
 * Why a dedicated module: the rich query needs deterministic pagination that
 * survives data changes between pages (cursor = last card id + exact sort key
 * + canonical filter fingerprint), and cross-field validation rules (tag modes
 * are mutually exclusive; tokens must pair with their filters). Filter and
 * token helpers are shared with validators and the query service.
 *
 * Firestore cannot express the full filter set natively (case-insensitive
 * substring search, ALL/NOT tag semantics, review-state predicates,
 * updated-at ranges, suspended defaults), so the service fetches the
 * candidate docs (optionally pruned server-side by createdAt bounds + the
 * createdAt desc ordering) and applies the remaining predicates in memory
 * with this module. That is the documented "safe in-memory filtering" path.
 */

import { canonicalScopeFingerprint, isValidFirestoreDocumentId, isValidFirestoreTimestamp } from './documentPageTokens';
import { SearchCardsQuery, SearchReviewFilter } from './types';

/**
 * The normalized, comparable form of a rich query's filters. Arrays are
 * canonicalized (deduped, sorted) so that semantically identical queries
 * produce identical fingerprints regardless of argument order/formatting.
 */
export interface SearchFilters {
  /** Lowercased, trimmed free-text search. */
  search?: string;
  tagsAny: string[];
  tagsAll: string[];
  tagsNot: string[];
  review?: SearchReviewFilter;
  decks: string[];
  deckNames: string[];
  /** true = suspended only, false = active only, absent = both. */
  suspended?: boolean;
  /** Millisecond (UTC) inclusive bounds. */
  createdFromMs?: number;
  createdToMs?: number;
  updatedFromMs?: number;
  updatedToMs?: number;
}

/**
 * The subset of a card the matcher needs, duck-typed so both Firestore
 * `Flashcard` objects (Timestamp fields expose `toMillis()`) and lightweight
 * test fixtures can be matched without importing Firestore.
 */
export interface SearchTimestamp {
  toMillis(): number;
  seconds?: number;
  nanoseconds?: number;
}

export interface SearchableCard {
  id: string;
  front: string;
  back: string;
  deck?: string;
  deckId?: string;
  tags: string[];
  topic?: string;
  suspended?: boolean;
  createdAt: SearchTimestamp | number;
  updatedAt: SearchTimestamp | number;
  due: SearchTimestamp | number;
  state?: number;
  reps?: number;
}

/**
 * Parses a documented date bound as an ISO date-time or YYYY-MM-DD.
 * Date-only values are UTC; upper date-only bounds mean the last millisecond
 * of that UTC day. Date-time values retain Date.parse's millisecond precision.
 */
export function parseSearchBound(value: string | undefined, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let ms: number;
  if (date) {
    const dayStart = utcDayStart(Number(date[1]), Number(date[2]), Number(date[3]));
    if (dayStart === undefined) return undefined;
    ms = endOfDay ? dayStart + 86_400_000 - 1 : dayStart;
  } else {
    const dateTime = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
    if (!dateTime || utcDayStart(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3])) === undefined) {
      return undefined;
    }
    ms = Date.parse(value);
    if (Number.isNaN(ms)) return undefined;
  }
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms - seconds * 1000) * 1_000_000;
  return isValidFirestoreTimestamp(seconds, nanoseconds) ? ms : undefined;
}

function utcDayStart(year: number, month: number, day: number): number | undefined {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.getTime();
}

/** Normalizes a validated query into its canonical filter form. */
export function normalizeSearchFilters(query: SearchCardsQuery): SearchFilters {
  const uniqSorted = (xs: string[] | undefined): string[] => [...new Set(xs ?? [])].sort();
  const createdFromMs = parseSearchBound(query.createdFrom);
  const createdToMs = parseSearchBound(query.createdTo, true);
  const updatedFromMs = parseSearchBound(query.updatedFrom);
  const updatedToMs = parseSearchBound(query.updatedTo, true);
  return {
    ...(query.search !== undefined && query.search.trim() !== '' ? { search: query.search.trim().toLowerCase() } : {}),
    tagsAny: uniqSorted(query.tagsAny),
    tagsAll: uniqSorted(query.tagsAll),
    tagsNot: uniqSorted(query.tagsNot),
    ...(query.review !== undefined ? { review: query.review } : {}),
    decks: uniqSorted(query.decks),
    deckNames: uniqSorted(query.deckNames),
    ...(query.suspended !== undefined ? { suspended: query.suspended } : {}),
    ...(createdFromMs !== undefined ? { createdFromMs } : {}),
    ...(createdToMs !== undefined ? { createdToMs } : {}),
    ...(updatedFromMs !== undefined ? { updatedFromMs } : {}),
    ...(updatedToMs !== undefined ? { updatedToMs } : {}),
  };
}

/** Fixed-size SHA-256 fingerprint of the canonical active filter set. */
export function searchFiltersKey(filters: SearchFilters): string {
  return canonicalScopeFingerprint({
    search: filters.search ?? null,
    tagsAny: filters.tagsAny,
    tagsAll: filters.tagsAll,
    tagsNot: filters.tagsNot,
    review: filters.review ?? null,
    decks: filters.decks,
    deckNames: filters.deckNames,
    suspended: filters.suspended ?? null,
    createdFromMs: filters.createdFromMs ?? null,
    createdToMs: filters.createdToMs ?? null,
    updatedFromMs: filters.updatedFromMs ?? null,
    updatedToMs: filters.updatedToMs ?? null,
  });
}

/** True when two normalized filter sets are semantically identical. */
export function searchFiltersEqual(a: SearchFilters, b: SearchFilters): boolean {
  return searchFiltersKey(a) === searchFiltersKey(b);
}

/** Decoded cursor payload. */
export interface SearchTokenPayload {
  /** Canonical filter fingerprint the token was minted for. */
  filtersKey: string;
  /** Owner binding keeps cursors private to their authenticated library. */
  ownerKey: string;
  kind: 'searchCards';
  lastId: string;
  lastCreatedAtSeconds: number;
  lastCreatedAtNanoseconds: number;
}

function searchOwnerKey(ownerId: string): string {
  return canonicalScopeFingerprint(['searchCards', ownerId]);
}

/** Encodes a bounded base64url cursor with canonical filter and exact sort keys. */
export function makeSearchPageToken(
  filters: SearchFilters,
  ownerId: string,
  lastId: string,
  lastCreatedAtSeconds: number,
  lastCreatedAtNanoseconds: number,
): string {
  const payload: SearchTokenPayload = {
    filtersKey: searchFiltersKey(filters),
    ownerKey: searchOwnerKey(ownerId),
    kind: 'searchCards',
    lastId,
    lastCreatedAtSeconds,
    lastCreatedAtNanoseconds,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Decodes a bounded cursor token; returns null when malformed. */
export function readSearchPageToken(token: string): SearchTokenPayload | null {
  if (token.length > 3000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<SearchTokenPayload>;
    if (
      typeof parsed.filtersKey !== 'string'
      || typeof parsed.ownerKey !== 'string'
      || parsed.kind !== 'searchCards'
      || !isValidFirestoreDocumentId(parsed.lastId)
      || !isValidFirestoreTimestamp(parsed.lastCreatedAtSeconds, parsed.lastCreatedAtNanoseconds)
    ) {
      return null;
    }
    return parsed as SearchTokenPayload;
  } catch {
    return null;
  }
}

function msOf(value: SearchTimestamp | number): number {
  return typeof value === 'number' ? value : value.toMillis();
}
/** Date filters are millisecond-precision; avoid fractional/rounded toMillis values. */
function dateBoundMsOf(value: SearchTimestamp | number): number {
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value.seconds === 'number' && Number.isSafeInteger(value.seconds)
      && typeof value.nanoseconds === 'number' && Number.isInteger(value.nanoseconds)) {
    return value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
  }
  return Math.floor(value.toMillis());
}

/**
 * The review-state predicate, used ONLY by search_cards. Semantics:
 *  - Suspended cards never match the search_cards review facet — the
 *    `suspended` filter is the only way to select them (a suspended card is
 *    not "due", "not due", "new", or "reviewed" within THIS query's facets;
 *    dueFlashcards also excludes suspended cards, while review-session
 *    endpoints retain their existing snapshot semantics).
 *  - `due`: due time has arrived (new cards are due immediately at
 *    creation — their `due` equals creation time).
 *  - `notDue`: scheduled strictly in the future.
 *  - `new`: never reviewed (state 0 / reps 0).
 *  - `reviewed`: at least one completed review (reps > 0).
 */
export function cardReviewStateMatch(card: SearchableCard, filter: SearchReviewFilter, nowMs: number): boolean {
  if (card.suspended === true) return false;
  const dueMs = msOf(card.due);
  const reps = typeof card.reps === 'number' ? card.reps : 0;
  switch (filter) {
    case 'due':
      return dueMs <= nowMs;
    case 'notDue':
      return dueMs > nowMs;
    case 'new':
      return reps === 0;
    case 'reviewed':
      return reps > 0;
  }
}

/** Applies every filter family to one card (AND across families). Pure. */
export function cardMatchesFilters(card: SearchableCard, filters: SearchFilters, nowMs: number): boolean {
  const tags = card.tags ?? [];

  // Free text: topic OR front OR back, case-insensitive substring.
  if (filters.search !== undefined) {
    const haystack = `${card.topic ?? ''}\n${card.front}\n${card.back}`.toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }

  // Tags (at most one family present — enforced by the validator).
  if (filters.tagsAny.length > 0 && !filters.tagsAny.some((t) => tags.includes(t))) return false;
  if (filters.tagsAll.length > 0 && !filters.tagsAll.every((t) => tags.includes(t))) return false;
  if (filters.tagsNot.length > 0 && filters.tagsNot.some((t) => tags.includes(t))) return false;

  // Review state.
  if (filters.review !== undefined && !cardReviewStateMatch(card, filters.review, nowMs)) return false;

  // Deck family: stable deckId OR denormalized deck name, ANY-of (union).
  if (filters.decks.length > 0 || filters.deckNames.length > 0) {
    const byId = filters.decks.includes(card.deckId ?? '');
    const byName = filters.deckNames.includes(card.deck ?? '');
    if (!byId && !byName) return false;
  }

  // Suspended state. Absent = both; `false` excludes suspended (an absent
  // field on legacy documents means "not suspended").
  if (filters.suspended === true && card.suspended !== true) return false;
  if (filters.suspended === false && card.suspended === true) return false;

  // Date bounds (inclusive).
  const createdMs = dateBoundMsOf(card.createdAt);
  const updatedMs = dateBoundMsOf(card.updatedAt);
  if (filters.createdFromMs !== undefined && createdMs < filters.createdFromMs) return false;
  if (filters.createdToMs !== undefined && createdMs > filters.createdToMs) return false;
  if (filters.updatedFromMs !== undefined && updatedMs < filters.updatedFromMs) return false;
  if (filters.updatedToMs !== undefined && updatedMs > filters.updatedToMs) return false;

  return true;
}


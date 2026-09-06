/**
 * Pure helpers for the rich flashcard query (`searchCards`).
 *
 * Why a dedicated module: the rich query needs deterministic pagination that
 * survives data changes between pages (cursor = last card id + its sort key
 * + a fingerprint of the ACTIVE FILTERS), and cross-field validation rules
 * (mutually exclusive tag modes; token/filter pairing). All of that logic is
 * shared between the query validator (`validators.ts`), the query service
 * (`service.ts`), and their tests — so it lives here, dependency-free except
 * for `types.ts`.
 *
 * Firestore cannot express the full filter set natively (case-insensitive
 * substring search, ALL/NOT tag semantics, review-state predicates,
 * updated-at ranges, suspended defaults), so the service fetches the
 * candidate docs (optionally pruned server-side by createdAt bounds + the
 * createdAt desc ordering) and applies the remaining predicates in memory
 * with this module. That is the documented "safe in-memory filtering" path.
 */

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
export interface SearchableCard {
  id: string;
  front: string;
  back: string;
  deck?: string;
  deckId?: string;
  tags: string[];
  topic?: string;
  suspended?: boolean;
  createdAt: { toMillis(): number } | number;
  updatedAt: { toMillis(): number } | number;
  due: { toMillis(): number } | number;
  state?: number;
  reps?: number;
}

/**
 * Parses an accepted date bound.
 * - YYYY-MM-DD → UTC midnight of that day (`endOfDay` → the LAST millisecond
 *   of that UTC day, so an upper bound like `createdTo: 2026-08-31` includes
 *   the whole day).
 * - Full ISO 8601 date-times pass through Date.parse unchanged.
 */
export function parseSearchBound(value: string | undefined, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const day = Date.UTC(y, mo - 1, d);
    // Reject invalid calendar dates (e.g. 2026-02-31) that Date.UTC would
    // silently normalize.
    const check = new Date(day);
    if (Number.isNaN(day) || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return undefined;
    }
    return endOfDay ? day + 86_400_000 - 1 : day;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Normalizes a validated query into its canonical filter form. */
export function normalizeSearchFilters(query: SearchCardsQuery): SearchFilters {
  const uniqSorted = (xs: string[] | undefined): string[] => [...new Set(xs ?? [])].sort();
  return {
    ...(query.search !== undefined && query.search.trim() !== '' ? { search: query.search.trim().toLowerCase() } : {}),
    tagsAny: uniqSorted(query.tagsAny),
    tagsAll: uniqSorted(query.tagsAll),
    tagsNot: uniqSorted(query.tagsNot),
    ...(query.review !== undefined ? { review: query.review } : {}),
    decks: uniqSorted(query.decks),
    deckNames: uniqSorted(query.deckNames),
    ...(query.suspended !== undefined ? { suspended: query.suspended } : {}),
    ...(parseSearchBound(query.createdFrom) !== undefined ? { createdFromMs: parseSearchBound(query.createdFrom) } : {}),
    ...(parseSearchBound(query.createdTo, true) !== undefined ? { createdToMs: parseSearchBound(query.createdTo, true) } : {}),
    ...(parseSearchBound(query.updatedFrom) !== undefined ? { updatedFromMs: parseSearchBound(query.updatedFrom) } : {}),
    ...(parseSearchBound(query.updatedTo, true) !== undefined ? { updatedToMs: parseSearchBound(query.updatedTo, true) } : {}),
  };
}

/** Canonical JSON key of a filter set — two sets are "the same" iff keys match. */
export function searchFiltersKey(filters: SearchFilters): string {
  return JSON.stringify({
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
  /** Id of the last card of the previous page (resume-after point). */
  lastId: string;
  /** createdAt (ms, UTC) of the last card of the previous page (sort key). */
  lastCreatedAtMs: number;
}

/** Encodes a cursor token: base64url(JSON{ filtersKey, lastId, lastCreatedAtMs }). */
export function makeSearchPageToken(filters: SearchFilters, lastId: string, lastCreatedAtMs: number): string {
  const payload: SearchTokenPayload = {
    filtersKey: searchFiltersKey(filters),
    lastId,
    lastCreatedAtMs,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Decodes a cursor token; returns null when malformed. */
export function readSearchPageToken(token: string): SearchTokenPayload | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as Partial<SearchTokenPayload>;
    if (typeof parsed.filtersKey !== 'string' || typeof parsed.lastId !== 'string' || typeof parsed.lastCreatedAtMs !== 'number') {
      return null;
    }
    return parsed as SearchTokenPayload;
  } catch {
    return null;
  }
}

function msOf(value: { toMillis(): number } | number): number {
  return typeof value === 'number' ? value : value.toMillis();
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
  const createdMs = msOf(card.createdAt);
  const updatedMs = msOf(card.updatedAt);
  if (filters.createdFromMs !== undefined && createdMs < filters.createdFromMs) return false;
  if (filters.createdToMs !== undefined && createdMs > filters.createdToMs) return false;
  if (filters.updatedFromMs !== undefined && updatedMs < filters.updatedFromMs) return false;
  if (filters.updatedToMs !== undefined && updatedMs > filters.updatedToMs) return false;

  return true;
}

/**
 * Deterministic result order: createdAt DESCENDING, ties by card id
 * ASCENDING — the SAME total order Firestore applies natively when a query
 * is `orderBy('createdAt', 'desc')` (document id is Firestore's implicit
 * secondary sort key, ascending). The service adds an explicit
 * `orderBy(FieldPath.documentId())` so Firestore cursors (`startAfter`) skip
 * exactly the cards the in-memory matcher and the page token agree on — no
 * same-timestamp page can skip or duplicate a card.
 */
export function compareCardsDesc(a: SearchableCard, b: SearchableCard): number {
  const da = msOf(a.createdAt);
  const db = msOf(b.createdAt);
  if (da !== db) return db - da;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when the card sorts strictly AFTER the cursor (createdAt desc, id asc). */
export function cardAfterCursor(card: SearchableCard, lastId: string, lastCreatedAtMs: number): boolean {
  const createdMs = msOf(card.createdAt);
  if (createdMs !== lastCreatedAtMs) return createdMs < lastCreatedAtMs;
  return card.id > lastId;
}

/**
 * Unit tests for the pure rich-query helpers (search.ts): filter matching
 * across every requested family, tag semantics (ANY/ALL/NOT), review states,
 * deck combinations, suspended state, date ranges, deterministic ordering,
 * and cursor (de)serialization.
 */

import {
  SearchFilters, cardAfterCursor, cardMatchesFilters, compareCardsDesc,
  makeSearchPageToken, normalizeSearchFilters, parseSearchBound,
  readSearchPageToken, searchFiltersEqual, searchFiltersKey,
  SearchableCard,
} from './search';
import { SearchCardsQuery } from './types';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const D = (iso: string) => Date.parse(iso);

function card(overrides: Partial<SearchableCard> = {}): SearchableCard {
  return {
    id: 'c1',
    front: 'Capital of France?',
    back: 'Paris',
    tags: [],
    deck: 'Geography',
    deckId: 'deck-geo',
    topic: 'europe',
    createdAt: D('2026-08-01T00:00:00.000Z'),
    updatedAt: D('2026-08-01T00:00:00.000Z'),
    due: D('2026-08-01T00:00:00.000Z'),
    state: 0,
    reps: 0,
    ...overrides,
  };
}

function filters(q: SearchCardsQuery): SearchFilters {
  return normalizeSearchFilters(q);
}

describe('parseSearchBound', () => {
  it('parses YYYY-MM-DD as UTC midnight and passes through ISO date-times', () => {
    expect(parseSearchBound('2026-08-05')).toBe(Date.UTC(2026, 7, 5));
    expect(parseSearchBound('2026-08-05T10:30:00.000Z')).toBe(Date.parse('2026-08-05T10:30:00.000Z'));
    expect(parseSearchBound(undefined)).toBeUndefined();
    expect(parseSearchBound('not-a-date')).toBeUndefined();
  });

  it('upper bounds given as YYYY-MM-DD mean end of that UTC day', () => {
    expect(parseSearchBound('2026-08-31', true)).toBe(Date.UTC(2026, 7, 31) + 86_400_000 - 1);
  });

  it('rejects invalid calendar dates instead of normalizing them', () => {
    expect(parseSearchBound('2026-02-31')).toBeUndefined();
    expect(parseSearchBound('2026-13-01')).toBeUndefined();
    expect(parseSearchBound('2026-04-31')).toBeUndefined();
    expect(parseSearchBound('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
    expect(parseSearchBound('2026-02-29')).toBeUndefined(); // 2026 is not a leap year
  });
});

describe('text/topic search mapping', () => {
  it('matches front, back, OR topic case-insensitively', () => {
    const f = filters({ search: 'paris' });
    expect(cardMatchesFilters(card({ front: 'Capital of France?', back: 'Paris' }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ front: 'PARIS landmarks', back: 'x' }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ topic: 'euroPARIS' }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ front: 'Berlin', back: 'x', topic: 'x' }), f, NOW)).toBe(false);
  });

  it('topic is an optional card field — cards without a topic still match on front/back', () => {
    const f = filters({ search: 'capital' });
    expect(cardMatchesFilters(card({ topic: undefined, front: 'The capital city?', back: 'x' }), f, NOW)).toBe(true);
  });
});

describe('tag semantics', () => {
  const base = { tags: ['a', 'b'] };
  it('tagsAny: a card matching ANY listed tag qualifies', () => {
    const f = filters({ tagsAny: ['a', 'z'] });
    expect(cardMatchesFilters(card(base), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ tags: ['z'] }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ tags: ['q'] }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ tags: [] }), f, NOW)).toBe(false);
  });

  it('tagsAll: requires every listed tag (AND within the family)', () => {
    const f = filters({ tagsAll: ['a', 'b'] });
    expect(cardMatchesFilters(card(base), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ tags: ['a'] }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ tags: ['a', 'b', 'c'] }), f, NOW)).toBe(true);
  });

  it('tagsNot: excludes cards carrying any listed tag', () => {
    const f = filters({ tagsNot: ['a'] });
    expect(cardMatchesFilters(card({ tags: ['b'] }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ tags: [] }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card(base), f, NOW)).toBe(false);
  });
});

describe('review-state filters', () => {
  it('due: due <= now (new cards are due immediately)', () => {
    const f = filters({ review: 'due' });
    expect(cardMatchesFilters(card({ due: D('2026-08-01T00:00:00Z'), reps: 0 }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ due: D('2026-09-01T00:00:00Z'), reps: 1 }), f, NOW)).toBe(false);
  });

  it('notDue: scheduled strictly in the future', () => {
    const f = filters({ review: 'notDue' });
    expect(cardMatchesFilters(card({ due: D('2026-09-01T00:00:00Z'), reps: 1 }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ due: D('2026-01-01T00:00:00Z'), reps: 1 }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ due: D('2026-08-28T12:00:00Z'), reps: 1 }), f, NOW)).toBe(false); // exactly now = due
  });

  it('new: never reviewed (reps 0) regardless of due; reviewed: reps > 0', () => {
    expect(cardMatchesFilters(card({ reps: 0, due: D('2026-09-01T00:00:00Z') }), filters({ review: 'new' }), NOW)).toBe(true);
    expect(cardMatchesFilters(card({ reps: 1 }), filters({ review: 'new' }), NOW)).toBe(false);
    expect(cardMatchesFilters(card({ reps: 3 }), filters({ review: 'reviewed' }), NOW)).toBe(true);
    expect(cardMatchesFilters(card({ reps: 0 }), filters({ review: 'reviewed' }), NOW)).toBe(false);
  });

  it('suspended cards never match a review-state filter', () => {
    const f = filters({ review: 'due' });
    expect(cardMatchesFilters(card({ suspended: true, due: D('2026-01-01T00:00:00Z') }), f, NOW)).toBe(false);
    const fNew = filters({ review: 'new' });
    expect(cardMatchesFilters(card({ suspended: true, reps: 0 }), fNew, NOW)).toBe(false);
  });
});

describe('deck combinations', () => {
  it('matches by stable deck id OR legacy name (union within the family)', () => {
    const f = filters({ decks: ['deck-x'], deckNames: ['Geography'] });
    expect(cardMatchesFilters(card({ deckId: 'deck-x', deck: 'Other' }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ deckId: 'deck-other', deck: 'Geography' }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ deckId: 'deck-other', deck: 'Other' }), f, NOW)).toBe(false);
  });

  it('deck filter combines with other families by AND', () => {
    const f = filters({ decks: ['deck-geo'], tagsAll: ['a'] });
    expect(cardMatchesFilters(card({ deckId: 'deck-geo', tags: ['a'] }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ deckId: 'deck-geo', tags: [] }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ deckId: 'deck-other', tags: ['a'] }), f, NOW)).toBe(false);
  });
});

describe('suspended state', () => {
  it('suspended:true returns only suspended cards; suspended:false only active; absent both', () => {
    const active = card({ suspended: false });
    const suspended = card({ suspended: true });
    expect(cardMatchesFilters(active, filters({ suspended: false }), NOW)).toBe(true);
    expect(cardMatchesFilters(suspended, filters({ suspended: false }), NOW)).toBe(false);
    expect(cardMatchesFilters(suspended, filters({ suspended: true }), NOW)).toBe(true);
    expect(cardMatchesFilters(active, filters({ suspended: true }), NOW)).toBe(false);
    // Legacy documents have no suspended field → read as active.
    expect(cardMatchesFilters(card({ suspended: undefined }), filters({ suspended: false }), NOW)).toBe(true);
    // Absent filter → both.
    expect(cardMatchesFilters(active, filters({}), NOW)).toBe(true);
    expect(cardMatchesFilters(suspended, filters({}), NOW)).toBe(true);
  });
});

describe('date-range filters', () => {
  it('createdFrom/createdTo bound createdAt inclusively', () => {
    const f = filters({ createdFrom: '2026-08-01', createdTo: '2026-08-31' });
    expect(cardMatchesFilters(card({ createdAt: D('2026-08-15T00:00:00Z') }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ createdAt: D('2026-08-01T00:00:00Z') }), f, NOW)).toBe(true); // inclusive lower
    expect(cardMatchesFilters(card({ createdAt: D('2026-08-31T23:59:59Z') }), f, NOW)).toBe(true); // inclusive upper
    expect(cardMatchesFilters(card({ createdAt: D('2026-07-31T00:00:00Z') }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ createdAt: D('2026-09-01T00:00:00Z') }), f, NOW)).toBe(false);
  });

  it('updatedFrom/updatedTo bound updatedAt', () => {
    const f = filters({ updatedFrom: '2026-08-10T00:00:00.000Z', updatedTo: '2026-08-20T00:00:00.000Z' });
    expect(cardMatchesFilters(card({ updatedAt: D('2026-08-15T00:00:00Z') }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ updatedAt: D('2026-08-09T00:00:00Z') }), f, NOW)).toBe(false);
  });

  it('exact-bound inclusion at represented precision: createdAtTo == card createdAt (ms-truncated)', () => {
    // Regression for the nanosecond-inclusivity bug: a card whose raw
    // instant is X + sub-ms nanos displays/serializes (truncated to ms) as
    // exactly X. createdTo = X must therefore include it (its toMillis()
    // equals the bound), and a card 1ms later must be excluded.
    const x = D('2026-08-15T00:00:00.000Z');
    const f = filters({ createdTo: '2026-08-15T00:00:00.000Z' });
    // exact ms match (in-memory toMillis comparison is inclusive)
    expect(cardMatchesFilters(card({ createdAt: x }), f, NOW)).toBe(true);
    // 1ms after the bound is excluded (adjacent exclusion)
    expect(cardMatchesFilters(card({ createdAt: x + 1 }), f, NOW)).toBe(false);
    // 1ms before the bound is included
    expect(cardMatchesFilters(card({ createdAt: x - 1 }), f, NOW)).toBe(true);
  });

  it('exact-bound inclusion at represented precision: updatedTo == card updatedAt (ms-truncated)', () => {
    const x = D('2026-08-15T00:00:00.000Z');
    const f = filters({ updatedTo: '2026-08-15T00:00:00.000Z' });
    expect(cardMatchesFilters(card({ updatedAt: x }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ updatedAt: x + 1 }), f, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ updatedAt: x - 1 }), f, NOW)).toBe(true);
  });

  it('createdTo/updatedTo include a card whose raw nanos fall inside the bound ms (display truncation)', () => {
    // Regression for the nanosecond-inclusivity bug: a card stored at
    // 2026-08-15T00:00:00.000400Z displays/serializes as .000Z and its
    // toMillis() == the .000Z bound, so createdTo=.000Z MUST include it.
    const mk = (n: number) => ({ toMillis: () => D('2026-08-15T00:00:00.000Z'), nanoseconds: n });
    const f = filters({ createdTo: '2026-08-15T00:00:00.000Z' });
    expect(cardMatchesFilters(card({ createdAt: mk(400000) }), f, NOW)).toBe(true);
    const fu = filters({ updatedTo: '2026-08-15T00:00:00.000Z' });
    expect(cardMatchesFilters(card({ updatedAt: mk(999999) }), fu, NOW)).toBe(true);
  });

  it('date ranges combine with other families by AND', () => {
    const f = filters({ createdFrom: '2026-08-01', tagsAll: ['a'] });
    expect(cardMatchesFilters(card({ createdAt: D('2026-08-15T00:00:00Z'), tags: ['a'] }), f, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ createdAt: D('2026-07-15T00:00:00Z'), tags: ['a'] }), f, NOW)).toBe(false);
  });
});

describe('cross-family AND', () => {
  it('matches only when every family holds', () => {
    const f = filters({
      search: 'paris',
      tagsAll: ['a', 'b'],
      decks: ['deck-geo'],
      suspended: false,
      createdFrom: '2026-08-01',
    });
    const hit = card({ back: 'Paris', tags: ['a', 'b'], deckId: 'deck-geo', suspended: false, createdAt: D('2026-08-15T00:00:00Z') });
    expect(cardMatchesFilters(hit, f, NOW)).toBe(true);
    expect(cardMatchesFilters({ ...hit, tags: ['a'] }, f, NOW)).toBe(false);
    expect(cardMatchesFilters({ ...hit, back: 'Lyon' }, f, NOW)).toBe(false);
    expect(cardMatchesFilters({ ...hit, deckId: 'deck-other' }, f, NOW)).toBe(false);
    expect(cardMatchesFilters({ ...hit, suspended: true }, f, NOW)).toBe(false);
  });
});

describe('deterministic ordering', () => {
  it('orders createdAt desc, ties by id asc (Firestore native tie-break)', () => {
    const a = card({ id: 'a', createdAt: D('2026-08-01T00:00:00Z') });
    const b = card({ id: 'b', createdAt: D('2026-08-02T00:00:00Z') });
    const c1 = card({ id: 'c1', createdAt: D('2026-08-02T00:00:00Z') });
    const c2 = card({ id: 'c2', createdAt: D('2026-08-02T00:00:00Z') });
    const sorted = [a, b, c1, c2].sort(compareCardsDesc).map((x) => x.id);
    // Aug 2 group (b, c1, c2) sorts before Aug 1 (a); within the group id asc.
    expect(sorted).toEqual(['b', 'c1', 'c2', 'a']);
  });
});

describe('pagination cursors', () => {
  it('mints a token that resumes after the cursor card', () => {
    const f = filters({ search: 'paris' });
    const token = makeSearchPageToken(f, 'card-9', D('2026-08-10T00:00:00Z'));
    const payload = readSearchPageToken(token);
    expect(payload).toEqual({ filtersKey: searchFiltersKey(f), lastId: 'card-9', lastCreatedAtMs: D('2026-08-10T00:00:00Z') });
  });

  it('token filtersKey mismatches when the filter set changes', () => {
    const fParis = filters({ search: 'paris' });
    const token = makeSearchPageToken(fParis, 'c1', 1);
    expect(readSearchPageToken(token)!.filtersKey).toBe(searchFiltersKey(fParis));
    expect(readSearchPageToken(token)!.filtersKey).not.toBe(searchFiltersKey(filters({ search: 'lyon' })));
  });

  it('rejects malformed tokens', () => {
    expect(readSearchPageToken('not-base64!!')).toBeNull();
    expect(readSearchPageToken('')).toBeNull();
    expect(readSearchPageToken(Buffer.from('{"lastId":1}').toString('base64'))).toBeNull();
  });

  it('filters equality is canonical (order/dup-insensitive, case-normalized)', () => {
    const a = filters({ search: 'Paris', tagsAll: ['b', 'a'], tagsAny: ['x', 'x'] });
    const b = filters({ search: 'paris', tagsAll: ['a', 'b'], tagsAny: ['x'] });
    expect(searchFiltersEqual(a, b)).toBe(true);
    const c = filters({ search: 'paris', tagsAll: ['a', 'c'] });
    expect(searchFiltersEqual(a, c)).toBe(false);
  });

  it('cardAfterCursor: createdAt desc with id asc tiebreak', () => {
    const after = (created: number, id: string) => cardAfterCursor(card({ id, createdAt: created }), 'mid', D('2026-08-10T00:00:00Z'));
    // Strictly AFTER in createdAt-desc + id-asc order: older createdAt, or
    // equal createdAt with a LARGER id.
    expect(after(D('2026-08-09T00:00:00Z'), 'aaa')).toBe(true);
    expect(after(D('2026-08-10T00:00:00Z'), 'zzz')).toBe(true);
    expect(after(D('2026-08-10T00:00:00Z'), 'mid')).toBe(false); // the cursor card itself
    expect(after(D('2026-08-10T00:00:00Z'), 'aaa')).toBe(false); // sorts before cursor (same ts, smaller id)
    expect(after(D('2026-08-11T00:00:00Z'), 'zzz')).toBe(false); // newer → already shown
  });
});

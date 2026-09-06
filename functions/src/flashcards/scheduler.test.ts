import { Timestamp } from 'firebase-admin/firestore';
import { applyReview, initialScheduling, resolveReviewTime, parseTimestamp } from './scheduler';
import { Flashcard } from './types';

function ts(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

function makeCard(overrides: Partial<Flashcard> = {}): Flashcard {
  const created = ts('2026-08-01T00:00:00.000Z');
  return {
    id: 'card-1',
    front: 'Q',
    back: 'A',
    deck: 'deck',
    tags: [],
    createdAt: created,
    updatedAt: created,
    due: created,
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    reviewLog: [],
    images: [],
    ...overrides,
  };
}

describe('initialScheduling', () => {
  it('starts a new card as New and due immediately', () => {
    const now = ts('2026-08-28T00:00:00.000Z');
    const s = initialScheduling(now);
    expect(s).toEqual({
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, due: now,
    });
  });
});

describe('resolveReviewTime', () => {
  it('uses the client reviewAt when valid', () => {
    expect(resolveReviewTime('2026-08-28T12:30:00.000Z', new Date('2026-08-28T00:00:00Z')))
      .toEqual(new Date('2026-08-28T12:30:00.000Z'));
  });

  it('falls back to now for missing or invalid reviewAt', () => {
    const now = new Date('2026-08-28T00:00:00Z');
    expect(resolveReviewTime(undefined, now)).toEqual(now);
    expect(resolveReviewTime('garbage', now)).toEqual(now);
  });
});

describe('applyReview', () => {
  it('schedules a new card: Good advances to the 10-minute learning step', () => {
    const card = makeCard({ due: ts('2026-08-28T00:00:00.000Z') });
    const reviewAt = new Date('2026-08-28T00:00:00.000Z');
    const { scheduling, logEntry } = applyReview(card, 3, reviewAt);

    expect(scheduling.state).toBe(1); // Learning
    expect(scheduling.reps).toBe(1);
    expect(scheduling.lapses).toBe(0);
    expect(scheduling.stability).toBeGreaterThan(0);
    expect(scheduling.due.toDate().toISOString()).toBe('2026-08-28T00:10:00.000Z');
    expect(scheduling.lastReview!.toDate().toISOString()).toBe('2026-08-28T00:00:00.000Z');

    expect(logEntry.rating).toBe(3);
    expect(logEntry.state).toBe(0);
    expect(logEntry.review.toDate().toISOString()).toBe('2026-08-28T00:00:00.000Z');
    expect(logEntry.reps).toBe(1);
  });

  it('Again on a new card reschedules within the same minute (learning)', () => {
    const card = makeCard({ due: ts('2026-08-28T00:00:00.000Z') });
    const { scheduling } = applyReview(card, 1, new Date('2026-08-28T00:00:00.000Z'));
    expect(scheduling.state).toBe(1);
    expect(scheduling.due.toDate().toISOString()).toBe('2026-08-28T00:01:00.000Z');
  });

  it('graduates a learning card to Review after two Goods', () => {
    const card = makeCard({ due: ts('2026-08-28T00:00:00.000Z') });
    const first = applyReview(card, 3, new Date('2026-08-28T00:00:00.000Z'));
    const second = applyReview(
      { ...card, ...first.scheduling, reviewLog: [first.logEntry] },
      3,
      new Date('2026-08-28T00:10:00.000Z'),
    );
    expect(second.scheduling.state).toBe(2); // Review
    expect(second.scheduling.reps).toBe(2);
    expect(second.scheduling.due.toDate().toISOString()).toBe('2026-08-30T00:10:00.000Z');
  });

  it('is deterministic for the same inputs', () => {
    const card = makeCard({ due: ts('2026-08-28T00:00:00.000Z') });
    const reviewAt = new Date('2026-08-28T00:00:00.000Z');
    const a = applyReview(card, 4, reviewAt);
    const b = applyReview(card, 4, reviewAt);
    expect(a.scheduling).toEqual(b.scheduling);
    expect(a.logEntry).toEqual(b.logEntry);
  });

  it('uses the given reviewAt as the log review time', () => {
    const card = makeCard({ due: ts('2026-08-28T00:00:00.000Z') });
    const { logEntry } = applyReview(card, 3, new Date('2026-08-29T09:00:00.000Z'));
    expect(logEntry.review.toDate().toISOString()).toBe('2026-08-29T09:00:00.000Z');
  });
});

describe('parseTimestamp', () => {
  it('parses ISO strings and numbers', () => {
    expect(parseTimestamp('2026-08-28T00:00:00.000Z').toDate().toISOString()).toBe('2026-08-28T00:00:00.000Z');
    expect(parseTimestamp(0).toDate().getTime()).toBe(0);
  });

  it('falls back to the epoch for unparseable input', () => {
    expect(parseTimestamp('nope').toDate().getTime()).toBe(0);
    expect(parseTimestamp(null).toDate().getTime()).toBe(0);
  });
});

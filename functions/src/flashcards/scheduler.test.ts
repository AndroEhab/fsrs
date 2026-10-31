import { Timestamp } from 'firebase-admin/firestore';
import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs';
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
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, learningSteps: 0, due: now,
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
    expect(logEntry.due.toDate().toISOString()).toBe('2026-08-28T00:00:00.000Z');
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

  it('keeps Good on the next learning step after Again resets it', () => {
    const first = applyReview(makeCard(), 3, new Date('2026-08-28T00:00:00.000Z'));
    const again = applyReview({ ...makeCard(), ...first.scheduling, reviewLog: [first.logEntry] }, 1, new Date('2026-08-28T00:10:00.000Z'));
    const good = applyReview({ ...makeCard(), ...again.scheduling, reviewLog: [first.logEntry, again.logEntry] }, 3, new Date('2026-08-28T00:11:00.000Z'));
    expect([first.scheduling.learningSteps, again.scheduling.learningSteps, good.scheduling.learningSteps]).toEqual([1, 0, 1]);
    expect(good.scheduling.state).toBe(1);
    expect(good.scheduling.due.toDate().toISOString()).toBe('2026-08-28T00:21:00.000Z');
  });

  it('rejects ambiguous legacy learning progress without fabricating a step', () => {
    const card = makeCard({ state: 1, reps: 3, reviewLog: [] });
    expect(() => applyReview(card, 3, new Date('2026-08-28T00:00:00.000Z')))
      .toThrow('incomplete learning progress');
  });
  it('fails closed on malformed legacy event state/rating instead of inferring a progress step', () => {
    const badEvent = {
      rating: 1, state: 99, review: ts('2026-08-28T00:00:00.000Z'),
      due: ts('2026-08-28T00:00:00.000Z'), stability: 0, difficulty: 0, reps: 1, lapses: 0,
    } as unknown as Flashcard['reviewLog'][number];
    const card = makeCard({ state: 1, reps: 1, reviewLog: [badEvent] });
    expect(() => applyReview(card, 3, new Date('2026-08-28T00:00:00.000Z')))
      .toThrow('incomplete learning progress');
  });

  it('replays a truncated log starting at Again from a known reset boundary', () => {
    const reviewAt = new Date('2026-08-28T00:00:00.000Z');
    const native = fsrs();
    const nativeCard = {
      ...createEmptyCard(reviewAt),
      state: State.Learning,
      learning_steps: 1,
      reps: 4,
      lapses: 0,
      last_review: reviewAt,
    };
    const nativeAgain = native.next(nativeCard, reviewAt, Rating.Again);
    const nativeHard = native.next(nativeAgain.card, new Date('2026-08-28T00:01:00.000Z'), Rating.Hard);
    const nativeGood = native.next(nativeHard.card, new Date('2026-08-28T00:08:00.000Z'), Rating.Good);
    const log = [nativeAgain, nativeHard, nativeGood].map((item) => ({
      rating: item.log.rating as 1 | 2 | 3 | 4,
      state: item.log.state as 0 | 1 | 2 | 3,
      review: ts(item.log.review.toISOString()),
      due: ts(item.log.due.toISOString()),
      stability: item.log.stability,
      difficulty: item.log.difficulty,
      reps: item.card.reps,
      lapses: item.card.lapses,
    }));
    const card = makeCard({
      state: nativeHard.card.state,
      due: ts(nativeHard.card.due.toISOString()),
      stability: nativeHard.card.stability,
      difficulty: nativeHard.card.difficulty,
      reps: nativeHard.card.reps,
      lapses: nativeHard.card.lapses,
      lastReview: ts(nativeHard.card.last_review!.toISOString()),
      reviewLog: log.slice(0, 2),
    });

    const actual = applyReview(card, 3, new Date('2026-08-28T00:08:00.000Z'));
    expect(actual.scheduling.state).toBe(nativeGood.card.state);
    expect(actual.scheduling.learningSteps).toBe(nativeGood.card.learning_steps);
    expect(actual.scheduling.due.toDate()).toEqual(nativeGood.card.due);
  });
  it('recovers truncated Again then Hard then Good against native ts-fsrs', () => {
    const start = new Date('2026-08-28T00:00:00.000Z');
    const native = fsrs();
    const original = {
      ...createEmptyCard(start), state: State.Learning, learning_steps: 1,
      reps: 4, lapses: 0, last_review: start,
    };
    const again = native.next(original, start, Rating.Again);
    const hard = native.next(again.card, new Date('2026-08-28T00:01:00.000Z'), Rating.Hard);
    const good = native.next(hard.card, new Date('2026-08-28T00:08:00.000Z'), Rating.Good);
    const log = [again, hard].map((item) => ({
      rating: item.log.rating as 1 | 2 | 3 | 4,
      state: item.log.state as 0 | 1 | 2 | 3,
      review: ts(item.log.review.toISOString()),
      due: ts(item.log.due.toISOString()),
      stability: item.log.stability,
      difficulty: item.log.difficulty,
      reps: item.card.reps,
      lapses: item.card.lapses,
    }));
    const actual = applyReview(makeCard({
      state: hard.card.state,
      learningSteps: undefined,
      reps: hard.card.reps,
      lapses: hard.card.lapses,
      stability: hard.card.stability,
      difficulty: hard.card.difficulty,
      due: ts(hard.card.due.toISOString()),
      lastReview: ts(hard.card.last_review!.toISOString()),
      reviewLog: log,
    }), 3, new Date('2026-08-28T00:08:00.000Z'));
    expect(actual.scheduling.state).toBe(good.card.state);
    expect(actual.scheduling.learningSteps).toBe(good.card.learning_steps);
    expect(actual.scheduling.due.toDate()).toEqual(good.card.due);
  });

  it('reconstructs Relearning step from an Again boundary without using learning count', () => {
    const start = new Date('2026-08-28T00:00:00.000Z');
    const native = fsrs();
    const original = {
      ...createEmptyCard(start), state: State.Review, learning_steps: 0,
      reps: 12, lapses: 3, stability: 8, difficulty: 5, last_review: start,
    };
    const again = native.next(original, start, Rating.Again);
    const good = native.next(again.card, new Date('2026-08-28T00:10:00.000Z'), Rating.Good);
    const entry = {
      rating: again.log.rating as 1 | 2 | 3 | 4,
      state: again.log.state as 0 | 1 | 2 | 3,
      review: ts(again.log.review.toISOString()), due: ts(again.log.due.toISOString()),
      stability: again.log.stability, difficulty: again.log.difficulty,
      reps: again.card.reps, lapses: again.card.lapses,
    };
    const actual = applyReview(makeCard({
      state: again.card.state, reps: again.card.reps, lapses: again.card.lapses,
      stability: again.card.stability, difficulty: again.card.difficulty,
      due: ts(again.card.due.toISOString()), lastReview: ts(again.card.last_review!.toISOString()),
      reviewLog: [entry],
    }), 3, new Date('2026-08-28T00:10:00.000Z'));
    expect(actual.scheduling.state).toBe(good.card.state);
    expect(actual.scheduling.learningSteps).toBe(good.card.learning_steps);
    expect(actual.scheduling.due.toDate()).toEqual(good.card.due);
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

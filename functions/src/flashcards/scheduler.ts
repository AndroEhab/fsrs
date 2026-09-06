/**
 * FSRS scheduling adapter.
 *
 * Wraps ts-fsrs so the flashcard service persists the scheduler's full state
 * on the card document: the FSRS card fields (stability, difficulty, reps,
 * lapses, state, due) are stored directly, and every review is appended to
 * the card's `reviewLog` array (oldest first) so due-card retrieval and
 * future rescheduling can reconstruct history.
 *
 * Scheduling rules:
 *  - A new card (never reviewed) is due immediately and is in the New state.
 *  - Each review advances the card via ts-fsrs `next()` using the persisted
 *    state as the input card; the returned card's fields overwrite the stored
 *    scheduling state, and `due` becomes the next review time.
 *  - The `log` produced by `next()` is persisted as the reviewLog entry with
 *    the review timestamp fixed to the actual review time (server now, or a
 *    client-supplied `reviewAt`).
 */

import { fsrs, State, type Card, type RecordLogItem, type Grade } from 'ts-fsrs';
import { Timestamp } from 'firebase-admin/firestore';
import { Flashcard, ReviewLogEntry, ReviewRating } from './types';

/** One shared FSRS scheduler instance — parameters are process-wide defaults. */
const scheduler = fsrs();

function parseDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date(0) : d;
  }
  // Firestore Timestamp (or any { toDate(): Date } object).
  if (value && typeof value === 'object' && 'toDate' in value) {
    const toDate: unknown = value.toDate;
    if (typeof toDate === 'function') {
      const d = toDate.call(value);
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
  }
  return new Date(0);
}

function parseTimestamp(value: unknown): Timestamp {
  return Timestamp.fromMillis(parseDate(value).getTime());
}

function toReviewLogItem(log: RecordLogItem['log'], card: Card): ReviewLogEntry {
  return {
    rating: log.rating as ReviewLogEntry['rating'],
    state: log.state as ReviewLogEntry['state'],
    review: Timestamp.fromMillis(log.review.getTime()),
    due: Timestamp.fromMillis(log.due.getTime()),
    stability: log.stability,
    difficulty: log.difficulty,
    reps: card.reps,
    lapses: card.lapses,
  };
}

/** Builds the ts-fsrs input card from a stored flashcard. */
function toFsrsCard(card: Flashcard): Card {
  return {
    due: parseDate(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: card.state === 1 ? Math.max(card.reps, 1) : 0,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ? parseDate(card.lastReview) : undefined,
  };
}

/** Serializes a ts-fsrs Card into the fields stored on the flashcard document. */
function fromFsrsCard(card: Card): Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'due' | 'lastReview'> {
  return {
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    due: Timestamp.fromMillis(card.due.getTime()),
    lastReview: card.last_review ? Timestamp.fromMillis(card.last_review.getTime()) : undefined,
  };
}

/**
 * Applies one review to a stored flashcard using the FSRS scheduler.
 *
 * Returns the updated scheduling fields and the reviewLog entry to persist.
 * The input `card` is not mutated. When `reviewAt` is provided it becomes the
 * review's timestamp (defaults to the server's current time).
 */
export function applyReview(card: Flashcard, rating: ReviewRating, reviewAt: Date = new Date()): {
  scheduling: Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'due' | 'lastReview'>;
  logEntry: ReviewLogEntry;
} {
  const fsrsCard = toFsrsCard(card);
  // rating is validated 1..4 at the API boundary; it is structurally equal to Grade (Again..Easy).
  const grade: Grade = rating;
  const item: RecordLogItem = scheduler.next(fsrsCard, reviewAt, grade);
  return {
    scheduling: fromFsrsCard(item.card),
    logEntry: toReviewLogItem(item.log, item.card),
  };
}

/** Initial scheduling state for a brand-new card: New, due immediately. */
export function initialScheduling(now: Timestamp = Timestamp.now()): Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'due'> {
  return {
    state: State.New,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    due: now,
  };
}

/** Minimal scheduling state for legacy cards created before FSRS fields existed. */
export function legacyScheduling(): Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses'> {
  return {
    state: State.New,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
  };
}

/**
 * Computes a card's review timestamp: the client-supplied `reviewAt` when
 * valid, otherwise the server's current time.
 *
 * Malformed `reviewAt` values are rejected by the API validator
 * (`reviewFlashcardSchema` requires ISO-8601 datetime) before this is called;
 * the fallback-to-now here is defense in depth for non-ISO values that slip
 * through or for direct service callers.
 */
export function resolveReviewTime(reviewAt: string | undefined, now: Date = new Date()): Date {
  if (reviewAt !== undefined) {
    const d = new Date(reviewAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return now;
}

export { parseTimestamp };

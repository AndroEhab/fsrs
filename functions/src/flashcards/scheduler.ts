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

import { fsrs, generatorParameters, State, type Card, type RecordLogItem, type Grade } from 'ts-fsrs';
import { Timestamp } from 'firebase-admin/firestore';
import type { Flashcard, ReviewLogEntry, ReviewRating } from './types';
/** One shared FSRS scheduler instance — parameters are process-wide defaults. */
const schedulerParameters = generatorParameters();
const scheduler = fsrs(schedulerParameters);

/** Copy the real short-term step lists used by review scheduling. */
export function getFSRSStepConfiguration(): { learningSteps: string[]; relearningSteps: string[] } {
  return {
    learningSteps: [...schedulerParameters.learning_steps],
    relearningSteps: [...schedulerParameters.relearning_steps],
  };
}
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

function toReviewLogItem(log: RecordLogItem['log'], dueBefore: Timestamp, card: Card): ReviewLogEntry {
  return {
    rating: log.rating as ReviewLogEntry['rating'],
    state: log.state as ReviewLogEntry['state'],
    review: Timestamp.fromMillis(log.review.getTime()),
    due: dueBefore,
    stability: log.stability,
    difficulty: log.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    learningStepsAfter: card.learning_steps,
  };
}

/**
 * Reconstructs legacy learning progress only when a retained log provides a
 * boundary from New/Review or an explicit stored learningStepsAfter value.
 * A current Learning/Relearning card with no such evidence is ambiguous and
 * must not advance with guessed progress.
 */
type LearningProgressSnapshot = {
  state: number;
  learningSteps?: number;
  reviewLog: Array<{ state: number; rating: number; learningStepsAfter?: number }>;
};

export function reconstructLearningSteps(card: LearningProgressSnapshot): number {
  const isLearning = card.state === State.Learning || card.state === State.Relearning;
  if (!isLearning) return 0;
  if (typeof card.learningSteps === 'number' && Number.isInteger(card.learningSteps) && card.learningSteps >= 0) {
    return card.learningSteps;
  }

  let step: number | undefined;
  for (let index = 0; index < card.reviewLog.length; index += 1) {
    const entry = card.reviewLog[index];
    const nextState = card.reviewLog[index + 1]?.state ?? card.state;
    if (typeof entry.learningStepsAfter === 'number' && Number.isInteger(entry.learningStepsAfter) && entry.learningStepsAfter >= 0) {
      step = entry.learningStepsAfter;
      continue;
    }
    if (![State.New, State.Learning, State.Review, State.Relearning].includes(entry.state as State)
      || ![1, 2, 3, 4].includes(entry.rating)) {
      step = undefined;
      continue;
    }
    if (entry.state === State.New) {
      step = entry.rating === 1 || entry.rating === 2
        ? 0
        : entry.rating === 3 && (nextState === State.Learning || nextState === State.Relearning) ? 1 : undefined;
      continue;
    }
    if (entry.state === State.Review) {
      step = entry.rating === 1 && nextState === State.Relearning ? 0 : undefined;
      continue;
    }
    if (entry.rating === 1) {
      // Again is a complete reset boundary even when older progress is trimmed.
      step = 0;
    } else if (entry.rating === 2) {
      // Hard preserves a known step. Without an earlier boundary it does not
      // reveal which step was current, so step remains unknown.
    } else if (entry.rating === 3) {
      // Count one completed short-term step only when the following state
      // proves Good did not graduate. No configured step count is duplicated.
      step = (nextState === State.Learning || nextState === State.Relearning) && step !== undefined
        ? step + 1
        : undefined;
    } else {
      step = undefined;
    }
  }
  if (step === undefined) {
    throw new LearningProgressUnavailableError();
  }
  return step;
}

export class LearningProgressUnavailableError extends Error {
  constructor() {
    super('This legacy card has incomplete learning progress. Reset its scheduling state before reviewing again. No review was recorded.');
    this.name = 'LearningProgressUnavailableError';
  }
}

/** Builds the ts-fsrs input card from a stored flashcard. */
function toFsrsCard(card: Flashcard): Card {
  return {
    due: parseDate(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: reconstructLearningSteps(card),
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ? parseDate(card.lastReview) : undefined,
  };
}

/** Serializes a ts-fsrs Card into the fields stored on the flashcard document. */
function fromFsrsCard(card: Card): Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'learningSteps' | 'due' | 'lastReview'> {
  return {
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    learningSteps: card.learning_steps,
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
  scheduling: Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'learningSteps' | 'due' | 'lastReview'>;
  logEntry: ReviewLogEntry;
} {
  const fsrsCard = toFsrsCard(card);
  // rating is validated 1..4 at the API boundary; it is structurally equal to Grade (Again..Easy).
  const grade: Grade = rating;
  const item: RecordLogItem = scheduler.next(fsrsCard, reviewAt, grade);
  return {
    scheduling: fromFsrsCard(item.card),
    logEntry: toReviewLogItem(item.log, Timestamp.fromMillis(fsrsCard.due.getTime()), item.card),
  };
}

/** Initial scheduling state for a brand-new card: New, due immediately. */
export function initialScheduling(now: Timestamp = Timestamp.now()): Pick<Flashcard, 'state' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'learningSteps' | 'due'> {
  return {
    state: State.New,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    learningSteps: 0,
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

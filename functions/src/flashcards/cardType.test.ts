import {
  normalizeAnswer, resolveSessionCardType, extractClozeAnswer, expectedAnswerFor,
  renderReviewFront, evaluateTypedAnswer,
} from './cardType';
import { Flashcard, SelfTestAnswer } from './types';

const ts = { toDate: () => new Date('2026-08-28T00:00:00.000Z'), seconds: 1785283200, nanoseconds: 0 };

function card(overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    id: 'c1',
    front: 'Q',
    back: 'A',
    tags: [],
    createdAt: ts,
    updatedAt: ts,
    due: ts,
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    reviewLog: [],
    images: [],
    ...overrides,
  } as Flashcard;
}

describe('normalizeAnswer', () => {
  it('case-folds, collapses whitespace, and strips punctuation', () => {
    expect(normalizeAnswer('  Berlin,  GERMANY! ')).toBe('berlin germany');
    expect(normalizeAnswer('Hello, world.')).toBe('hello world');
    expect(normalizeAnswer('  spaced   out  ')).toBe('spaced out');
  });

  it('strips punctuation before collapsing whitespace (hello , world == hello world)', () => {
    expect(normalizeAnswer('hello , world')).toBe('hello world');
    expect(normalizeAnswer('a, b')).toBe('a b');
    expect(normalizeAnswer('a ; b')).toBe('a b');
  });

  it('preserves word boundaries for hyphens/dashes/apostrophes (replaces with a space, never concatenates)', () => {
    // Hyphen: 'well-known' → 'well known' (NOT 'wellknown').
    expect(normalizeAnswer('well-known')).toBe('well known');
    // Apostrophe: "don't" → 'don t' (NOT 'dont') — the apostrophe becomes a
    // boundary so words are not merged or altered.
    expect(normalizeAnswer("don't")).toBe('don t');
    // Em/en dash and interpunct behave the same.
    expect(normalizeAnswer('state-of-the-art')).toBe('state of the art');
    expect(normalizeAnswer('New York—city')).toBe('new york city');
  });

  it('lowercases deterministically (locale-independent toLowerCase)', () => {
    expect(normalizeAnswer('Hello')).toBe('hello');
    expect(normalizeAnswer('HELLO')).toBe('hello');
    expect(normalizeAnswer('Berlin')).toBe(normalizeAnswer('BERLIN'));
    expect(normalizeAnswer('Berlin')).toBe(normalizeAnswer('berlin'));
  });

  it('applies Unicode NFKC so visually-equivalent answers compare equal', () => {
    // Full-width Latin letters normalize to ASCII under NFKC.
    expect(normalizeAnswer('Ｂｅｒｌｉｎ')).toBe('berlin');
    // Ligature/compatibility forms normalize too.
    expect(normalizeAnswer('caf\u00e9')).toBe('caf\u00e9');
    // Diacritics are NOT stripped (NFKC composes but does not decompose to ASCII).
    expect(normalizeAnswer('caf\u00e9')).not.toBe('cafe');
  });
});

describe('resolveSessionCardType', () => {
  it('resolves cloze and defaults everything else to qa', () => {
    expect(resolveSessionCardType('cloze')).toBe('cloze');
    expect(resolveSessionCardType('qa')).toBe('qa');
    expect(resolveSessionCardType(undefined)).toBe('qa');
    expect(resolveSessionCardType('bogus')).toBe('qa');
    expect(resolveSessionCardType(null)).toBe('qa');
  });
});

describe('extractClozeAnswer', () => {
  it('extracts the first marker content', () => {
    expect(extractClozeAnswer('The capital of Germany is [Berlin].')).toBe('Berlin');
  });
  it('returns null without a marker', () => {
    expect(extractClozeAnswer('No cloze here')).toBeNull();
  });
});

describe('expectedAnswerFor', () => {
  it('uses back for qa', () => {
    expect(expectedAnswerFor(card({ back: 'Free Spaced Repetition Scheduler' }), 'qa')).toBe('Free Spaced Repetition Scheduler');
  });
  it('uses the front marker for cloze, falling back to back without a marker', () => {
    expect(expectedAnswerFor(card({ front: 'The capital is [Berlin]', back: 'A' }), 'cloze')).toBe('Berlin');
    expect(expectedAnswerFor(card({ front: 'No marker', back: 'fallback' }), 'cloze')).toBe('fallback');
  });
});

describe('renderReviewFront', () => {
  it('blanks the first marker for cloze and leaves qa front unchanged', () => {
    expect(renderReviewFront(card({ front: 'The capital is [Berlin].' }), 'cloze')).toBe('The capital is _____.');
    expect(renderReviewFront(card({ front: 'What is FSRS?' }), 'qa')).toBe('What is FSRS?');
    // Stored front is never modified.
    const c = card({ front: 'The capital is [Berlin].' });
    renderReviewFront(c, 'cloze');
    expect(c.front).toBe('The capital is [Berlin].');
  });
});

describe('evaluateTypedAnswer', () => {
  const ans = (text: string, revealed = false): SelfTestAnswer => ({ text, revealed });

  it('matches exact normalized answers (correct)', () => {
    const route = evaluateTypedAnswer(card({ back: 'Free Spaced Repetition Scheduler' }), 'qa', ans('free spaced repetition scheduler'));
    expect(route).toEqual({ kind: 'correct', expected: 'free spaced repetition scheduler' });
  });

  it('returns incorrect with the normalized expected answer for any non-exact answer', () => {
    const route = evaluateTypedAnswer(card({ back: 'Berlin' }), 'qa', ans('Paris'));
    expect(route).toEqual({ kind: 'incorrect', expected: 'berlin' });
    // Partial/paraphrased answers are deterministic incorrect (never a
    // semantic judgment).
    const partial = evaluateTypedAnswer(card({ back: 'Free Spaced Repetition Scheduler' }), 'qa', ans('free spaced'));
    expect(partial).toEqual({ kind: 'incorrect', expected: 'free spaced repetition scheduler' });
  });

  it('reports no-answer when the expected answer normalizes to empty (punctuation-only guard)', () => {
    // A raw nonempty expected like '...' normalizes to '' — an exact
    // comparison would be meaningless (an empty normalized value would equal
    // ANY empty typed answer), so it is an explicit no-answer outcome.
    const route = evaluateTypedAnswer(card({ back: '...' }), 'qa', ans('...'));
    expect(route).toEqual({ kind: 'no-answer' });
  });

  it('evaluates cloze cards against the marker content', () => {
    const c = card({ front: 'The capital of Germany is [Berlin]' });
    expect(evaluateTypedAnswer(c, 'cloze', ans('berlin'))).toEqual({ kind: 'correct', expected: 'berlin' });
  });

  it('returns revealed when the answer was revealed', () => {
    expect(evaluateTypedAnswer(card({ back: 'Berlin' }), 'qa', ans('', true))).toEqual({ kind: 'revealed' });
  });

  it('returns empty for an empty typed answer', () => {
    expect(evaluateTypedAnswer(card({ back: 'Berlin' }), 'qa', ans(''))).toEqual({ kind: 'empty' });
  });

  it('exactly matches short answers (no minimum length gate)', () => {
    expect(evaluateTypedAnswer(card({ back: 'A' }), 'qa', ans('A'))).toEqual({ kind: 'correct', expected: 'a' });
    expect(evaluateTypedAnswer(card({ back: 'A' }), 'qa', ans('B'))).toEqual({ kind: 'incorrect', expected: 'a' });
  });

  it('matches full-width (NFKC) answers exactly', () => {
    expect(evaluateTypedAnswer(card({ back: 'Berlin' }), 'qa', ans('Ｂｅｒｌｉｎ'))).toEqual({ kind: 'correct', expected: 'berlin' });
  });
});

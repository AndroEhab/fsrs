/**
 * Session-presentation card types and local answer evaluation.
 *
 * Card types (`qa` | `cloze`) are a PRESENTATION decision applied at review
 * time — the stored card document is never modified: `front`/`back` are
 * preserved byte-for-byte, and no `cardType`/`clozeAnswer`/`selfTest` fields
 * are written. A session or widget that wants typed/cloze rendering derives
 * the display form and expected answer from the stored text with the pure
 * helpers below.
 *
 *  - `qa`    — question/answer; the expected answer is the card's `back`.
 * 
 * The structured evaluation of a typed response is a LOCAL, deterministic
 * operation: responses are normalized (Unicode NFKC, case-folded, whitespace
 * collapsed, punctuation stripped) and compared exactly against the
 * normalized expected answer. Every submitted answer maps to an explicit
 * outcome: an exact normalized equality is `correct`; ANY non-exact
 * normalized answer is `incorrect` (never a semantic/AI judgment); reveal
 * without typing is `revealed`; an empty answer is `empty`; a card with no
 * comparable answer (including an expected answer that normalizes to EMPTY,
 * e.g. one that is only punctuation) is `no-answer`. No answer is ever
 * routed to an external semantic judge.
 */
import { Flashcard, Evaluation, SelfTestAnswer, CLOZE_MARKER_RE } from './types';

/** Card-type identifiers accepted by session configuration. */
export const SESSION_CARD_TYPES = ['qa', 'cloze'] as const;
export type SessionCardType = (typeof SESSION_CARD_TYPES)[number];

/**
 * Normalizes a string for exact comparison: trims, collapses all
 * whitespace runs to single spaces, folds to lower case, and strips
 * common punctuation. Deterministic and locale-independent.
 */
export function normalizeAnswer(value: string): string {
  // Unicode NFKC normalization: composes compatibility characters (full-width
  // forms, ligatures, accents) so visually-equivalent answers compare equal.
  // Deliberately does NOT strip diacritics or rewrite meaning.
  const nfkc = value.normalize('NFKC');
  return nfkc
    // Locale-independent lowercase (matches the deterministic contract).
    .toLowerCase()
    // Remove irrelevant punctuation/separators FIRST (so `hello , world` ==
    // `hello world`), then collapse whitespace runs — order matters.
    // Hyphens, dashes, and apostrophes are replaced with a SPACE (not
    // deleted) so intra-word boundaries are preserved instead of
    // concatenating or altering words: `well-known` normalizes to
    // `well known`, `don't` to `don t` — never `wellknown`/`dont`.
    .replace(/'|’|‘|"|“|”/g, ' ')
    .replace(/[.,;:!?¡¿()\[\]{}<>«»·—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves the effective card type for a session card (unknown → `qa`). */
export function resolveSessionCardType(cardType: string | null | undefined): SessionCardType {
  return cardType === 'cloze' ? 'cloze' : 'qa';
}

/**
 * Extracts the content of the first `[answer]` marker in a string, or null
 * when the string contains no marker.
 */
export function extractClozeAnswer(front: string): string | null {
  const match = CLOZE_MARKER_RE.exec(front);
  return match ? match[1].trim() : null;
}

/**
 * The expected answer for a card under a session card type: `cloze` uses the
 * first `[answer]` marker content of `front` (falling back to `back` when the
 * front has no marker); `qa` uses `back`. Returns null only when there is no
 * comparable answer at all.
 */
export function expectedAnswerFor(card: Flashcard, cardType: SessionCardType): string | null {
  if (cardType === 'cloze') {
    const fromFront = extractClozeAnswer(card.front);
    if (fromFront !== null && fromFront.length > 0) return fromFront;
    return card.back.length > 0 ? card.back : null;
  }
  return card.back.length > 0 ? card.back : null;
}

/**
 * Renders a card's `front` for review under a session card type: for `cloze`,
 * the first `[answer]` marker is replaced with a blank placeholder
 * (rendered client-side as an input); any other `[...]` groups stay literal.
 * For `qa`, the front is returned unchanged. The stored text is never
 * modified.
 */
export function renderReviewFront(card: Flashcard, cardType: SessionCardType): string {
  if (cardType !== 'cloze') return card.front;
  let replaced = false;
  return card.front.replace(CLOZE_MARKER_RE, (match) => {
    if (replaced) return match;
    replaced = true;
    return '_____';
  });
}

/**
 * Deterministic and pure — never performs semantic evaluation. Every
 * submitted answer maps to an explicit outcome:
 *   - `{ kind: 'correct', expected }` — normalized answer EXACTLY equals the
 *     normalized expected answer;
 *   - `{ kind: 'incorrect', expected }` — any non-exact normalized answer;
 *   - `{ kind: 'revealed' }` — the user revealed the answer without typing;
 *   - `{ kind: 'empty' }` — nothing was typed and nothing was revealed;
 *   - `{ kind: 'no-answer' }` — the card has no comparable answer (qa with an
 *     empty back, cloze with no marker and an empty back), or the expected
 *     answer normalizes to the EMPTY string (e.g. it is only punctuation)
 *     so an exact comparison would be meaningless.
 */
export function evaluateTypedAnswer(
  card: Flashcard,
  cardType: SessionCardType,
  answer: SelfTestAnswer,
): Evaluation {
  const expected = expectedAnswerFor(card, cardType);
  const typed = answer.text ?? '';
  const revealed = answer.revealed === true;

  if (revealed) {
    return { kind: 'revealed' };
  }
  if (expected === null) {
    return { kind: 'no-answer' };
  }
  if (typed.length === 0) {
    return { kind: 'empty' };
  }

  // Exact-after-normalization for ANY nonempty expected answer: no minimum
  // length gate. ONLY exact equality is `correct`; any non-exact normalized
  // answer (mismatch, partial, paraphrase) is deterministically `incorrect`.
  //
  // Deliberate empty-normalized guard: an expected answer that normalizes to
  // the EMPTY string (e.g. an answer that is only punctuation) cannot be
  // meaningfully compared — the empty normalized value would equal ANY empty
  // typed answer, so it is reported as `no-answer` instead of a fabricated
  // correct/incorrect verdict (see evaluateTypedAnswer tests).
  const normalizedExpected = normalizeAnswer(expected);
  const normalizedTyped = normalizeAnswer(typed);
  if (normalizedExpected.length > 0 && normalizedExpected === normalizedTyped) {
    return { kind: 'correct', expected: normalizedExpected };
  }
  if (normalizedExpected.length === 0) {
    return { kind: 'no-answer' };
  }
  return { kind: 'incorrect', expected: normalizedExpected };
}

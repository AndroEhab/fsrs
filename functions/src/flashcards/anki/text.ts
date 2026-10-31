/**
 * Pure conversions between Anki's HTML note fields and this product's
 * plain-text card fields, plus small shared string helpers.
 *
 * IMPORT (Anki HTML → plain text): a small whitelist converter — text is
 * escaped on the way IN so raw `<`/`>` can never inject markup into the
 * product; the whitelist then introduces real line/list structure only from
 * known block tags; every other tag's content is kept, tags are dropped,
 * and HTML entities are decoded. Output is deterministic.
 *
 * EXPORT (plain text → Anki HTML): text is HTML-escaped, line breaks become
 * `<br>`, and the product's cloze markers (`[answer]`) become Anki cloze
 * deletions (`{{cN::answer}}`) so cloze cards round-trip into Anki as cloze
 * notes (not plain text).
 */
import { ANKI_TEXT_MAX } from './types';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', deg: '°', times: '×',
  divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', micro: 'µ',
  para: '¶', sect: '§', middot: '·', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è',
  agrave: 'à', ugrave: 'ù', oacute: 'ó', ograve: 'ò', iacute: 'í', igrave: 'ì',
  aacute: 'á', uacute: 'ú', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', yacute: 'ý',
  uuml: 'ü', ouml: 'ö', auml: 'ä', euml: 'ë', iuml: 'ï', aring: 'å', aelig: 'æ',
  oslash: 'ø', eth: 'ð', thorn: 'þ', iexcl: '¡', iquest: '¿', shy: '',
};

/** Whitespace runs → single space; newline runs → single newline. */
function collapseSpaces(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
}


/**
 * Converts an Anki field (HTML) to this product's plain-text form.
 * - Block tags (`<br>`, `<div>`, `<p>`, `<li>`, headers) become newlines.
 * - All remaining tags are dropped (their text content is kept).
 * - Entities are decoded; stray angle brackets are escaped as text.
 * - Text is trimmed; interior whitespace collapses (lines keep ≤1 blank).
 */
export function ankiHtmlToPlainText(html: string): string {
  if (html === '') return '';
  const out: string[] = [];
  const normalized = html;
  let index = 0;
  let textStart = 0;
  while (index < normalized.length) {
    if (normalized[index] === '\r') {
      if (index > textStart) out.push(normalized.slice(textStart, index));
      out.push('\n');
      index += normalized[index + 1] === '\n' ? 2 : 1;
      textStart = index;
      continue;
    }
    if (normalized[index] !== '<') { index += 1; continue; }
    let cursor = index + 1;
    while (cursor < normalized.length && /\s/.test(normalized[cursor])) cursor += 1;
    if (cursor < normalized.length && normalized[cursor] === '/') cursor += 1;
    while (cursor < normalized.length && /\s/.test(normalized[cursor])) cursor += 1;
    if (cursor >= normalized.length || !/[a-z]/i.test(normalized[cursor])) { index += 1; continue; }
    const nameStart = cursor;
    cursor += 1;
    while (cursor < normalized.length && /[a-z0-9]/i.test(normalized[cursor])) cursor += 1;
    let end = cursor;
    let quote: '"' | "'" | null = null;
    while (end < normalized.length) {
      const character = normalized[end];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      end += 1;
    }
    if (end === normalized.length) {
      out.push(normalized.slice(textStart));
      textStart = end;
      break;
    }
    if (index > textStart) out.push(normalized.slice(textStart, index));
    const name = normalized.slice(nameStart, cursor).toLowerCase();
    if (name === 'br' || name === 'div' || name === 'p' || name === 'li' || name === 'tr'
      || name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') {
      out.push('\n');
    }
    index = end + 1;
    textStart = index;
  }
  if (textStart < normalized.length) out.push(normalized.slice(textStart));
  return collapseSpaces(decodeHtmlEntities(out.join(''))).trim();
}

/**
 * Decodes the named + numeric HTML entities that commonly appear in Anki
 * fields. Everything else (e.g. `&nbsp;` variants, `&quot;`) is handled by
 * the generic numeric/known-name table below; unknown entities stay literal.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hexadecimal = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    if (!Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return whole;
    return NAMED_ENTITIES[body];
  });
}

/**
 * Escapes text for inclusion as an Anki HTML field. Ampersands are escaped
 * first, then tag delimiters, then the literal U+001F `flds` separator.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replaceAll('\x1f', '&#31;');
}

/**
 * Converts this product's plain-text card field to an Anki HTML field:
 * HTML-escapes the text, then turns newlines into `<br>`. The product's
 * cloze marker form `[answer]` is converted to Anki cloze markup when
 * `clozeOrd` is provided (1-based deletion number), producing
 * `{{c1::answer}}` inside the escaped field.
 */
export function plainTextToAnkiHtml(value: string, clozeOrd?: number): string {
  const escaped = escapeHtmlText(value);
  if (clozeOrd !== undefined) {
    return escaped.replace(/\[([^[\]]+)\]/g, (m, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed === '') return m;
      return `{{c${clozeOrd}::${trimmed}}}`;
    }).replace(/\n/g, '<br>');
  }
  return escaped.replace(/\n/g, '<br>');
}

export function splitAnkiTags(tagsField: string, maxTags = Number.POSITIVE_INFINITY): string[] {
  const tags: string[] = [];
  let index = 0;
  while (index < tagsField.length && tags.length < maxTags) {
    while (index < tagsField.length && /\s/.test(tagsField[index])) index += 1;
    if (index >= tagsField.length) break;
    const start = index;
    while (index < tagsField.length && !/\s/.test(tagsField[index])) index += 1;
    tags.push(tagsField.slice(start, index));
  }
  return tags;
}
const CLOZE_MARKER_RE = /\[([^[\]]+)\]/;

/**
 * True when the card's `front` carries this product's cloze marker. When it
 * does, exporting the card as an Anki CLOZE note round-trips the blank; when
 * it does not, exporting as cloze would create a plain (broken) cloze, so
 * callers fall back to a Basic note.
 */
export function isClozeFront(front: string): boolean {
  return CLOZE_MARKER_RE.test(front);
}


/** Normalizes a tag (trim, collapse spaces) and length-validates it. */
export function normalizeTag(tag: string, maxLength: number): string | null {
  const t = tag.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  if (t.length > maxLength) return null;
  return t;
}


/** Normalizes a plain-text field for storage: trims and collapses lines. */
export function normalizePlainText(value: string): string {
  return collapseSpaces(value).trim();
}

/**
 * Validates a normalized plain-text field: non-empty, within bounds.
 * Returns an error message or null.
 */
export function validatePlainText(value: string, label: string): string | null {
  if (value === '') return `${label} cannot be empty`;
  if (value.length > ANKI_TEXT_MAX) return `${label} too long (max ${ANKI_TEXT_MAX} chars)`;
  return null;
}

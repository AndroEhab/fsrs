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

const BLOCK_TAG_RE = /<\s*\/?\s*(br|div|p|li|tr|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi;

/** Whitespace runs → single space; newline runs → single newline. Adjacent
 * block tags (`</div><div>`) collapse to one line break. */
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
  if (html === "") return "";
  // 1. Normalize block tags to a newline token. <br> may be <br>, <br/>,
  //    <br />; div/p boundaries always close. Lists: each <li> starts on
  //    its own line; nested content follows inline.
  let out = html.replace(/\r\n?/g, "\n").replace(BLOCK_TAG_RE, "\n");
  // 2. Drop every remaining well-formed tag; keep its inner content.
  //    Escaped markup (&lt;b&gt;) is NOT a tag and survives this pass.
  out = out.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*[^>]*>/g, "");
  // 3. Decode entities LAST so literal escaped text (&lt;, &amp;) becomes
  //    real characters (<, &) and cannot be mistaken for markup.
  out = decodeHtmlEntities(out);
  // 4. Collapse spaces/newlines deterministically.
  return collapseSpaces(out).trim();
}

/**
 * Decodes the named + numeric HTML entities that commonly appear in Anki
 * fields. Everything else (e.g. `&nbsp;` variants, `&quot;`) is handled by
 * the generic numeric/known-name table below; unknown entities stay literal.
 */
export function decodeHtmlEntities(value: string): string {
  const NAMED: Record<string, string> = {
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
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body];
    return named !== undefined ? named : whole;
  });
}

/**
 * Escapes text for inclusion as an Anki field (HTML). Entities first, then
 * angle brackets, so the result is safe inside Anki's HTML fields.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

/** The Anki cloze-deletion marker in a card's stored text. */
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

/**
 * A deterministic hash (FNV-1a over UTF-8) used to derive stable, safe
 * identifiers (deck ids, note guids) from names — never for security.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Normalizes a tag (trim, collapse spaces) and length-validates it. */
export function normalizeTag(tag: string, maxLength: number): string | null {
  const t = tag.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  if (t.length > maxLength) return null;
  return t;
}

/** Splits an Anki tag string (`" tag1 tag2 "`) into trimmed tags. */
export function splitAnkiTags(tagsField: string): string[] {
  return tagsField.split(/\s+/).map((t) => t.trim()).filter((t) => t !== '');
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

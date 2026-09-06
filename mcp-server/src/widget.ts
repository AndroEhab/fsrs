/**
 * Review-session UI widget (Apps SDK `ui://` resource) for the FSRS MCP
 * server.
 *
 * Registers a self-contained HTML resource at `ui://review-session-v5` that
 * renders an Anki-like review card: front visible, tap to flip, then
 * Again/Hard/Good/Easy rating buttons wired to the `submit_review` tool via
 * the host bridge. The widget reads a JSON bootstrap (session + card +
 * tool-name metadata) embedded by the server, so no unsafe string
 * interpolation ever reaches the HTML — all dynamic data is JSON-serialized
 * and HTML-escaped.
 *
 * The widget is a pure resource: registering it does not change any tool
 * schema or tool behavior. Hosts that cannot render `ui://` resources keep
 * the existing textual tool output (unchanged); the widget simply adds a
 * rich surface where the client supports it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FirebaseBridge } from './bridge.js';
import type { ReviewSessionWithCardSummary } from './tools.js';

/** Widget resource URI, namespaced under the Apps SDK `ui://` scheme.
 *
 * Versioned (v5): the ChatGPT connector caches the widget resource by URI, so
 * every release that changes the widget code bumps the URI (v4 → v5) with NO
 * alias on the previous version — clients are forced to fetch the new code.
 * v5 renders v2 (bounded-root) review sessions: the widget no longer needs
 * the full cardIds/reviewedCardIds root arrays (queueWindow + currentPosition
 * carry the bounded state). Only the current URI is served and only
 * start_review_session links it. */
export const REVIEW_WIDGET_URI = 'ui://review-session-v5';

/**
 * Apps SDK (MCP Apps) UI resource MIME type. The CURRENT connector contract
 * requires `text/html;profile=mcp-app` (the older `text/html+skybridge` and
 * plain `text/html` are legacy) — ChatGPT renders the resource in a sandboxed
 * iframe that exposes the postMessage JSON-RPC bridge; a plain `text/html`
 * MIME produces the "Runtime error / Error al cargar la aplicación" symptom.
 */
export const REVIEW_WIDGET_MIME = 'text/html;profile=mcp-app';

/**
 * Bootstrap payload embedded (JSON-serialized, never interpolated) into the
 * widget HTML. Carries the current session state, the current card, and the
 * tool names the widget should call on the host bridge.
 */
export interface ReviewWidgetBootstrap {
  session: ReviewSessionWithCardSummary['session'];
  card: ReviewSessionWithCardSummary['card'];
  /** Name of the MCP tool to call to submit a rating. */
  submitTool: string;
  /** Name of the MCP tool to call to start a new session. */
  startTool: string;
  /** Name of the MCP tool to call to end the session. */
  endTool: string;
  /** Name of the MCP tool to call to re-fetch the session. */
  getTool: string;
  /**
   * Name of the MCP tool to fetch a full flashcard by id (data-only, no UI
   * linkage). Used ONLY as a reconciliation fallback when a host strips the
   * hidden _meta and returns a minimal card (id only) with no cached copy.
   */
  flashcardTool: string;
  /**
   * Session presentation card type: 'qa' (default) or 'cloze'. Presentation
   * ONLY — the stored card is never modified. 'cloze' renders the first
   * [answer] marker in the card front as a blank input and evaluates typed
   * answers against the marker content.
   */
  cardType?: 'qa' | 'cloze';
}

export const reviewWidgetBootstrapSchema = z.object({
  session: z.record(z.unknown()),
  card: z.record(z.unknown()).nullable(),
  submitTool: z.string().min(1),
  startTool: z.string().min(1),
  endTool: z.string().min(1),
  getTool: z.string().min(1),
  flashcardTool: z.string().min(1).optional(),
  cardType: z.enum(['qa', 'cloze']).optional(),
});
export type ReviewWidgetBootstrapInput = z.infer<typeof reviewWidgetBootstrapSchema>;

/**
 * HTML-escapes a string for safe embedding in element content or attribute
 * values. Used for the static widget chrome and any display text; dynamic
 * session/card data is JSON-serialized into a <script> block instead.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serializes arbitrary data into a `<script type="application/json">` block
 * body, escaping `</script` so a crafted front/back can never break out of
 * the JSON bootstrap (XSS-safe by construction).
 */
export function jsonScriptBody(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Builds the static widget HTML with the JSON bootstrap embedded. */
export function buildReviewWidgetHtml(bootstrap: ReviewWidgetBootstrapInput): string {
  const body = jsonScriptBody(bootstrap);
  // All dynamic data lives in the JSON bootstrap; the HTML below is static.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FSRS Review</title>
<style>
  :root {
    --bg:#f8fafc; --card:#fff; --ink:#16213a; --muted:#5d6b82; --line:#e5eaf2;
    --accent:#2563eb; --accent-strong:#1d4ed8; --accent-ink:#fff;
    --danger:#dc2626; --warn:#d97706; --good:#16a34a; --easy:#1d4ed8;
    --shadow:0 12px 32px rgba(23,37,84,.09); --shadow-sm:0 2px 10px rgba(23,37,84,.06);
    --radius:18px; --radius-sm:12px;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); }
  .wrap { max-width:680px; margin:0 auto; padding:24px 18px 40px; min-width:0; }
  .top-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; min-width:0; }
  .tag-pill { display:inline-flex; align-items:center; gap:7px; background:#f5f8ff; color:var(--accent);
              border:1px solid #c7d6f5; border-radius:999px; padding:4px 12px 4px 9px; font-size:12px; font-weight:600; letter-spacing:.01em;
              min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tag-pill .dot { width:6px; height:6px; border-radius:50%; background:var(--accent); flex:none; }
  .counters { font-size:11.5px; font-weight:600; color:var(--muted); font-variant-numeric:tabular-nums;
              text-transform:uppercase; letter-spacing:.06em;
              min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .deck-row { text-align:center; margin-bottom:12px; }
  .deck-label { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font-size:12px; font-weight:600; color:var(--muted); background:var(--card);
                border:1px solid var(--line); border-radius:999px; padding:4px 14px; box-shadow:var(--shadow-sm); }
  .source-label { display:inline-block; margin-left:8px; max-width:60%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                  font-size:11px; font-weight:600; color:var(--accent); background:#f5f8ff;
                  border:1px solid #c7d6f5; border-radius:999px; padding:3px 10px; }
  .progress { font-size:11.5px; color:var(--muted); margin-bottom:6px; font-variant-numeric:tabular-nums; }
  .progress-bar { height:4px; border-radius:999px; background:#e8edf5; overflow:hidden; margin-bottom:18px; }
  .progress-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#60a5fa,#2563eb); transition:width .25s ease; }
  .card-shell { perspective:1200px; margin-bottom:12px; border-radius:var(--radius); }
  .card-shell:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .card-inner { position:relative; width:100%; min-height:208px; transform-style:preserve-3d;
                transition:transform .5s cubic-bezier(.4,.2,.2,1); }
  .card-shell.flipped .card-inner { transform:rotateY(180deg); }
  /* PERSISTENT card-change reset: while .resetting is present the card is
     FORCED front-facing and non-animating (transform:none + transition:none,
     both !important so no inline/user style can reintroduce the unwinding
     rotation). Installed BEFORE a different card's content is written and
     kept through first paint — removed only by the next intentional user
     flip/reveal (flipToBack), never by render/rAF/timer. */
  .card-shell.resetting .card-inner { transition:none !important; transform:none !important; }
  .card-face { position:absolute; inset:0; backface-visibility:hidden; -webkit-backface-visibility:hidden;
               display:flex; align-items:center; justify-content:center; text-align:center; padding:36px 30px;
               background:var(--card); border:1.5px solid var(--line); border-radius:var(--radius);
               box-shadow:var(--shadow); overflow-wrap:anywhere; min-width:0; }
  .card-face.back-face { transform:rotateY(180deg); background:#fbfdff; border-color:#dbe4f1; }
  #frontInner, #backInner { font-size:clamp(22px,4.5vw,30px); font-weight:650; line-height:1.3; }
  .cloze-blank { border-bottom:2px dotted var(--accent); letter-spacing:.12em; color:var(--accent); }
  .hint { display:flex; align-items:center; justify-content:center; gap:7px; font-size:12.5px; color:var(--muted); margin:0 0 18px; }
  .hint svg { flex:none; opacity:.75; }
  .ratings { display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-top:2px; }
  .ratings button { display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 4px 11px; }
  .ratings .num { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px;
                  border-radius:50%; border:1.5px solid currentColor; background:rgba(255,255,255,.65);
                  font-size:12px; font-weight:700; line-height:1; }
  .ratings .label { font-size:12.5px; font-weight:600; line-height:1; }
  button { font:inherit; font-weight:600; padding:12px 10px; border:1px solid var(--line); border-radius:var(--radius-sm);
           background:var(--card); cursor:pointer; color:var(--ink); transition:transform .08s ease, box-shadow .12s ease, border-color .12s ease, background .12s ease; }
  button:hover { border-color:var(--accent); box-shadow:0 3px 10px rgba(23,37,84,.10); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button:active { transform:translateY(1px); }
  button:disabled { opacity:.55; cursor:not-allowed; box-shadow:none; }
  .again { color:var(--danger); border-color:#fecaca; background:#fef2f2; }
  .again:hover { border-color:var(--danger); background:#fee2e2; }
  .hard { color:var(--warn); border-color:#fde68a; background:#fffbeb; }
  .hard:hover { border-color:var(--warn); background:#fef3c7; }
  .good { color:var(--good); border-color:#bbf7d0; background:#f0fdf4; }
  .good:hover { border-color:var(--good); background:#dcfce7; }
  .easy { color:var(--easy); border-color:#bfdbfe; background:#eff6ff; }
  .easy:hover { border-color:var(--easy); background:#dbeafe; }
  .done { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:28px 22px; text-align:center; box-shadow:var(--shadow); }
  .done .actions { display:flex; gap:10px; justify-content:center; margin-top:18px; }
  .primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
  .primary:hover { background:var(--accent-strong); border-color:var(--accent-strong); }
  .ghost { color:var(--muted); }
  .status { font-size:13px; color:var(--muted); margin-top:12px; min-height:20px; text-align:center; }
  .typed { margin-bottom:14px; }
  .typed .prompt { display:block; font-size:12.5px; font-weight:600; color:var(--muted); margin-bottom:7px; }
  .typed input { width:100%; font:inherit; padding:13px 14px; border:1.5px solid var(--line); border-radius:var(--radius-sm);
                 background:var(--card); color:var(--ink); box-sizing:border-box; font-size:15px; }
  .typed input::placeholder { color:#9aa7ba; }
  .typed input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
  .typed-actions { display:flex; gap:10px; margin-top:10px; }
  .typed-actions button { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:7px; }
  .end-row { text-align:center; margin-top:14px; }
  .end-row .end-session { font-size:12.5px; padding:7px 14px; color:var(--muted); background:transparent; }
  .end-row .end-session:hover { color:var(--danger); border-color:#fecaca; background:#fff5f5; box-shadow:none; }
  .hidden { display:none !important; }
  @media (max-width:380px) {
    .card-inner { min-height:180px; }
    .ratings .label { font-size:11.5px; }
    .ratings button { padding:10px 0 9px; }
    #frontInner, #backInner { font-size:20px; }
    .wrap { padding:16px 14px 32px; }
    /* On the narrowest iframes the long mode tag wraps instead of truncating */
    .tag-pill { white-space:normal; overflow:visible; text-overflow:clip; height:auto; }
    .counters { white-space:normal; overflow:visible; text-overflow:clip; height:auto; text-align:right; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card-inner { transition:none; }
    .progress-bar > i { transition:none; }
    button { transition:none; }
  }
</style>
</head>
<body>
<div class="wrap" id="app">
  <div class="top-row">
    <span class="tag-pill"><span class="dot"></span><span id="modeTag">Spaced repetition</span></span>
    <span class="counters" id="cardLabel"></span>
  </div>
  <div class="deck-row">
    <span class="deck-label" id="deckLabel">Review session</span>
    <span class="source-label" id="sourceLabel"></span>
  </div>
  <div class="progress" id="progress"></div>
  <div class="progress-bar"><i id="progressFill"></i></div>
  <div class="card-shell" id="cardShell" role="button" tabindex="0" aria-label="Flip card">
    <div class="card-inner" id="cardInner">
      <div class="card-face front-face" id="front"><div id="frontInner"></div></div>
      <div class="card-face back-face" id="back"><div id="backInner"></div></div>
    </div>
  </div>
  <div class="hint" id="hint">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    <span>Tap the card to flip it and reveal the answer.</span>
  </div>
  <div class="typed hidden" id="typed">
    <label class="prompt" id="typedPrompt" for="answerInput">Type your answer</label>
    <input id="answerInput" type="text" autocomplete="off" spellcheck="false" placeholder="Your answer…" />
    <div class="typed-actions">
      <button id="revealBtn" class="ghost">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Reveal
      </button>
      <button id="checkBtn" class="primary">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>
        Check
      </button>
    </div>
  </div>
  <div class="ratings hidden" id="ratings">
    <button class="again" data-rating="1"><span class="num">1</span><span class="label">Again</span></button>
    <button class="hard" data-rating="2"><span class="num">2</span><span class="label">Hard</span></button>
    <button class="good" data-rating="3"><span class="num">3</span><span class="label">Good</span></button>
    <button class="easy" data-rating="4"><span class="num">4</span><span class="label">Easy</span></button>
  </div>
  <div class="end-row" id="endRow">
    <button id="endSessionBtn" class="ghost end-session">End Session</button>
  </div>
  <div class="done hidden" id="done">
    <div><strong id="doneTitle"></strong></div>
    <div class="actions">
      <button id="finishBtn">Finish</button>
      <button id="continueBtn" class="hidden">Continue review</button>
    </div>
  </div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</div>
<script type="application/json" id="bootstrap">${body}</script>
<script>
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('bootstrap').textContent);
  var app = document.getElementById('app');
  var modeTag = document.getElementById('modeTag');
  var progress = document.getElementById('progress');
  var cardShell = document.getElementById('cardShell');
  var cardInner = document.getElementById('cardInner');
  var front = document.getElementById('front');
  var back = document.getElementById('back');
  var frontInner = document.getElementById('frontInner');
  var backInner = document.getElementById('backInner');
  var cardLabel = document.getElementById('cardLabel');
  var progressFill = document.getElementById('progressFill');
  var hint = document.getElementById('hint');
  var ratings = document.getElementById('ratings');
  var done = document.getElementById('done');
  var doneTitle = document.getElementById('doneTitle');
  var finishBtn = document.getElementById('finishBtn');
  var continueBtn = document.getElementById('continueBtn');
  var statusEl = document.getElementById('status');
  var typed = document.getElementById('typed');
  var typedPrompt = document.getElementById('typedPrompt');
  var answerInput = document.getElementById('answerInput');
  var checkBtn = document.getElementById('checkBtn');
  var revealBtn = document.getElementById('revealBtn');
  var deckLabel = document.getElementById('deckLabel');
  var sourceLabel = document.getElementById('sourceLabel');
  var endRow = document.getElementById('endRow');
  var endSessionBtn = document.getElementById('endSessionBtn');

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function text(v) { return String(v == null ? '' : v); }

  // ── Local deterministic answer evaluation ─────────────────────────────
  // Mirrors the backend's deterministic rules EXACTLY (functions/
  // src/flashcards/cardType.ts evaluateTypedAnswer + normalizeAnswer):
  // Unicode NFKC → lowercase → apostrophes/quotes become a space → the
  // punctuation set becomes a space → whitespace runs collapse to one space
  // → trim. EVERY answer gets an explicit outcome computed entirely in the
  // widget — no backend round-trip, no ChatGPT/semantic evaluation:
  //   { kind: 'correct', expected }   exact normalized equality
  //   { kind: 'incorrect', expected } any non-exact normalized answer
  //   { kind: 'revealed' }            the answer was revealed, not typed
  //   { kind: 'empty' }               nothing typed, nothing revealed
  //   { kind: 'no-answer' }           no comparable expected answer (incl.
  //                                   punctuation-only expected: normalizes
  //                                   to empty, so no exact comparison)
  var CLOZE_MARKER = /\\[([^\\[\\]]+)\\]/;
  function normalizeAnswer(value) {
    var nfkc = String(value == null ? '' : value).normalize('NFKC');
    return nfkc
      .toLowerCase()
      .replace(/'|\u2019|\u2018|"|\u201c|\u201d/g, ' ')
      .replace(/[.,;:!?¡¿()\\[\\]{}<>«»·—–-]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }
  // Expected answer for a card under the session card type (qa → back;
  // cloze → first [answer] marker in front, else back). Null when there is
  // no comparable answer.
  function expectedAnswerFor(card, cardType) {
    if (!card) return null;
    if (cardType === 'cloze') {
      var m = CLOZE_MARKER.exec(text(card.front));
      if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
      return text(card.back).length > 0 ? text(card.back) : null;
    }
    return text(card.back).length > 0 ? text(card.back) : null;
  }
  // Local deterministic evaluation against the DISPLAYED card (same outcomes
  // as the backend's evaluateTypedAnswer). Pure: never calls a tool.
  function evaluateLocalAnswer(card, cardType, answer) {
    var typed = text(answer && answer.text);
    var revealed = !!(answer && answer.revealed);
    var expected = expectedAnswerFor(card, cardType);
    if (revealed) return { kind: 'revealed' };
    if (expected === null) return { kind: 'no-answer' };
    if (typed.length === 0) return { kind: 'empty' };
    var normExpected = normalizeAnswer(expected);
    var normTyped = normalizeAnswer(typed);
    if (normExpected.length > 0 && normExpected === normTyped) {
      return { kind: 'correct', expected: normExpected };
    }
    if (normExpected.length === 0) return { kind: 'no-answer' };
    return { kind: 'incorrect', expected: normExpected };
  }

  // Session presentation card type (default qa). Presentation only: the
  // stored card is never modified; 'cloze' blanks the first [answer] marker.
  function sessionCardType() { return (data.session && data.session.cardType) === 'cloze' || data.cardType === 'cloze' ? 'cloze' : 'qa'; }
  function renderFront(front) {
    if (sessionCardType() !== 'cloze') return esc(text(front));
    var replaced = false;
    return esc(text(front)).replace(/\\[([^\\[\\]]+)\\]/, function () {
      if (replaced) return arguments[0];
      replaced = true;
      return '<span class="cloze-blank">_____</span>';
    });
  }

  // Full cards keyed by id: every full card that reaches the widget is
  // cached here (bootstrap, session preloads, authoritative responses, and
  // the flashcard fallback). An id-only server result is resolved from this
  // cache BEFORE render — never a white card, and never a wrong card (only
  // the SAME id matches). The displayed card is always full when the cache
  var cardCache = {};
  // MONOTONIC ordered queue of UNRATED upcoming cards (PreloadedCard[]).
  // Seeded from the authoritative session.cardIds in due order, hydrated
  // from every full preload array and every full response card. The queue
  // NEVER shrinks from an async response: responses only ADD/update cards
  // (merging by id, preserving due order) — a short or stale preload array
  // can never replace the local buffer. Sessions are UNCAPPed: the start/get
  // preload window is bounded (SESSION_PRELOAD), so when the buffer runs dry
  // mid-session the next authoritative response (each submit returns the
  // exact next card) refreshes it — the queue never fabricates completion.
  var queue = [];
  var ending = false;              // an end-session request is in flight: no new ratings
  var requestSeq = 0;              // stable per-rating request id
  var generation = 0;              // bumped when the session ends: stale submit callbacks no-op
  var renderedCardId = null;       // id of the card currently rendered; flip resets only on card change
  var ratedCardIds = {};           // card ids the user has rated (in-flight or committed), id -> true
  // PARALLEL rating bookkeeping: every rating captures the DISPLAYED card id
  // and submits immediately — there is no single-flight gate. In-flight
  // ratings are tracked per claimed card (a rapid double-click on the SAME
  // displayed card never double-submits) and per requestId (response
  // correlation + staleness).
  var inflightByCard = {};         // expectedCardId -> item { rating, requestId, expectedCardId }
  var inflightByRequest = {};      // requestId -> item

  // True when a card object is MINIMAL — only an id (no renderable content).
  // Some hosts strip the hidden _meta and return { session, card: { id } }.
  function isMinimalCard(c) {
    return !!(c && typeof c === 'object' && c.id && c.front == null && c.back == null);
  }

  // Cache a full card keyed by id (only FULL cards are cached — an id-only
  // result must never overwrite the full copy with a stripped shell).
  function cacheFullCard(c) {
    if (!c || isMinimalCard(c)) return;
    cardCache[c.id] = c;
  }

  // Resolve an authoritative card: full cards win and are cached; an id-only
  // card is resolved from the cache of the SAME id (never a wrong card). When
  // no cached copy exists the id-only marker is returned and the flashcard
  // fallback fills it.
  function resolveCard(authoritative) {
    if (!authoritative) return null;
    if (!isMinimalCard(authoritative)) {
      cacheFullCard(authoritative);
      return authoritative;
    }
    var cached = cardCache[authoritative.id];
    if (cached) return { ...authoritative, ...cached }; // merge id-only result over the cached full card
    return authoritative; // no cache yet: keep the marker; the fallback fills it
  }
  // Authoritative ordered queue ids for the CURRENT session layout:
  //  - v1/no-version roots carry the full root cardIds array;
  //  - v2 roots are BOUNDED (no cardIds) and carry queueWindow.cardIds
  //    (the current card plus the bounded preload window).

  // v2: stable queue position of the window id at index ii (from the session
  // queueWindow entries, which carry { cardId, position }).
  function windowPositionOf(s, ii) {
    var w = s && s.queueWindow;
    if (w && Array.isArray(w.cardIds)) {
      var we = w.cardIds[ii];
      if (we && typeof we === 'object' && typeof we.position === 'number') return we.position;
    }
    return null;
  }
  function sessionQueueIds(s) {
    if (!s) return [];
    if (Array.isArray(s.cardIds) && s.cardIds.length) return s.cardIds;
    var w = s.queueWindow;
    if (w && Array.isArray(w.cardIds) && w.cardIds.length) {
      // v2 window entries are { cardId, position } objects (never the full
      // queue) — map to ids for the local queue buffer.
      var out = [];
      for (var wi = 0; wi < w.cardIds.length; wi += 1) {
        var we = w.cardIds[wi];
        if (we && typeof we === 'object' && we.cardId) out.push(we.cardId);
        else if (typeof we === 'string') out.push(we);
      }
      return out;
    }
    return [];
  }
  // True when this is a v2 (bounded-root) session — the queue is chunked and
  // the widget must NOT assume a full cardIds/reviewedCardIds array exists.
  function isV2SessionState(s) {
    if (!s) return false;
    if (s.storageVersion === 2) return true;
    return Array.isArray(s.queueWindow) === false && s.queueWindow && Array.isArray(s.queueWindow.cardIds) && !Array.isArray(s.cardIds);
  }
  // True when EVERY card in the authoritative queue is locally accounted for:
  // rated (committed or in-flight), the currently displayed card, or
  // cached/buffered. Only then can an exhausted local queue mean the session
  // is genuinely complete.
  //  - v1: scan the full root cardIds (rated ids skip, displayed/cached count).
  //  - v2: the root carries NO full queue; an exhausted LOCAL buffer (the
  //    bounded window + preloads) is only "complete" when the authoritative
  //    counters say nothing remains (remainingQueueCount minus in-flight
  //    deltas <= 0) or the session is terminally completed/ended. Otherwise
  //    the next authoritative submit/get response delivers the next card.
  function allSessionCardsAccountedFor() {
    var s = data.session || {};
    // v2 sessions MUST be decided FIRST: their roots carry no full queue, so
    // an empty local window (bounded preload exhausted, no response yet) is
    // NOT completion. Completion is true ONLY when the session is terminally
    // completed/ended, or the authoritative remaining counters (minus
    // unacknowledged in-flight deltas) are <= 0. An empty local buffer with
    // remainingCount > 0 must return FALSE — the next authoritative response
    // delivers the next card; showing the done panel early is forbidden.
    if (isV2SessionState(s)) {
      if (s.status === 'completed' || s.status === 'ended') return true;
      var idsV2 = sessionQueueIds(s);
      var remainV2 = s.remainingQueueCount != null ? s.remainingQueueCount : (s.remainingCount != null ? s.remainingCount : (idsV2.length || 0));
      if (remainV2 - optimisticPending() <= 0) return true;
      return false;
    }
    var ids = sessionQueueIds(s);
    // Legacy v1/no-version: an empty root cardIds means no queue at all.
    if (!ids.length) return true;
    var reviewed = Array.isArray(s.reviewedCardIds) ? s.reviewedCardIds : [];
    var currentId = data.card ? data.card.id : null;
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (ratedCardIds[id] || reviewed.indexOf(id) !== -1) continue;
      if (currentId === id) continue;
      if (cardCache[id]) continue;
      return false; // an unrated session card we have never seen
    }
    return true;
  }
  // Optimistic completion: the last locally-known card of a hydrated session
  // was rated while submits are still in flight. Cleared by every
  // authoritative response (adoptServerState) — the backend decides the
  // terminal state.
  var optimisticDone = false;

  // True when the card id has been rated locally (in-flight or committed) or
  // per the authoritative session.reviewedCardIds (v1 legacy only — v2 roots
  // are BOUNDED and omit that array; the local in-flight/committed set plus
  // the authoritative counters are authoritative for v2).
  function isRated(id) {
    if (ratedCardIds[id]) return true;
    var s = data.session || {};
    if (isV2SessionState(s)) return false;
    var reviewed = Array.isArray(s.reviewedCardIds) ? s.reviewedCardIds : [];
    return reviewed.indexOf(id) !== -1;
  }

  // Ordered merge of upcoming cards into the MONOTONIC queue. The queue is
  // an ordered SET keyed by card id: an entry already present is refreshed
  // in place (a fuller copy wins; order preserved), a NEW id is appended in
  // response order. Rated ids are never inserted. An async response can
  // only ADD/update — it can never shrink or replace the queue.
  function mergeQueueCards(cards) {
    if (!Array.isArray(cards)) return;
    var index = {};
    for (var mi = 0; mi < queue.length; mi += 1) if (queue[mi] && queue[mi].id) index[queue[mi].id] = mi;
    for (var qi = 0; qi < cards.length; qi += 1) {
      var pc = cards[qi];
      if (!pc || !pc.id || isRated(pc.id)) continue;
      cacheFullCard(pc);
      // Preserve the stable queue position on the buffered copy (v2 preloads
      // carry it; used as the claim target when the card is displayed).
      if (pc && typeof pc.position !== 'number') pc.position = null;
      var existing = index[pc.id];
      if (existing !== undefined) {
        if (!isMinimalCard(pc)) {
          queue[existing] = pc; // fuller/newer copy wins in place
          if (pc.position == null && queue[existing] && typeof queue[existing].position === 'number') pc.position = queue[existing].position;
        }
      } else {
        index[pc.id] = queue.length;
        queue.push(pc);
      }
    }
  }

  // Rebuilds the queue in the authoritative ordered queue-id list (v1 root
  // cardIds; v2 queueWindow.cardIds), resolving each id to the best known card
  // copy (preloaded/cache), skipping rated ids and the currently DISPLAYED
  // card (the queue holds upcoming cards only). Ids with no known copy yet
  // are kept ONLY for v1 (a later full preload/response adds them via
  // mergeQueueCards); for v2 the bounded window IS the known universe — any
  // id in it that we have not seen full is fetched lazily by the preload
  // merge. The rebuild never regresses the queue to a shorter array.
  function seedQueueFromSession() {
    var s = data.session || {};
    var ids = sessionQueueIds(s);
    // No authoritative queue ids in this response: keep the existing queue
    // untouched — a response can never shrink it.
    if (!ids.length) return;
    var byId = {};
    for (var si = 0; si < queue.length; si += 1) {
      if (queue[si] && queue[si].id) byId[queue[si].id] = queue[si];
    }
    for (var cid in cardCache) {
      if (Object.prototype.hasOwnProperty.call(cardCache, cid) && !byId[cid]) byId[cid] = cardCache[cid];
    }
    var currentId = data.card && data.card.id;
    var v2 = isV2SessionState(s);
    var out = [];
    for (var ii = 0; ii < ids.length; ii += 1) {
      var id = ids[ii];
      if (isRated(id)) continue;
      if (currentId && id === currentId) continue;
      var known = byId[id];
      if (!known) {
        if (v2) {
          // v2: the bounded window IS the known universe — an id we have not
          // cached full yet is kept as an id-only placeholder so the queue
          // never stalls; the flashcard fallback fills it on display. The
          // queue position is carried from the authoritative window order.
          out.push({ id: id, position: windowPositionOf(s, ii) });
          continue;
        }
        continue; // v1: no known copy yet — a later response adds it
      }
      cacheFullCard(known);
      // Preserve the authoritative queue position on the buffered card.
      if (known && typeof known.id === 'string' && windowPositionOf(s, ii) != null) {
        known = { ...known, position: windowPositionOf(s, ii) };
      }
      out.push(known);
    }
    queue = out;
  }

  // Apply the authoritative next card + session + queue from a response.
  // Robust reconciliation for hosts that strip _meta:
  //  - session is always authoritative (id/status/counters);
  //  - a full result card is cached and adopted; an id-only result card is
  //    resolved from the card cache of the SAME id (never a wrong card);
  //  - the queue is MONOTONIC: preloads and full cards MERGE into the local
  //    queue (add/update only, ordered by the authoritative session.cardIds)
  //    — a short/stale preload array can never replace or shrink it;
  //  - when no cached card exists for an id-only result, a data-only
  //    get_flashcard fallback fetches the full card (completion semantics
  //    preserved: a completed/ended session with no card shows the done state,
  //    never a wrong card);
  //  - the optimistic next card shown during an in-flight submit is PRESERVED
  //    when the response confirms that same id (the authoritative counters are
  //    still applied, but the displayed full card is not blanked/regressed);
  //    an id-only response that matches the optimistic card id resolves from
  //    the cache and keeps the card full;
  //  - a response OLDER than the active rating (a different card id, or a
  //    null-card snapshot) cannot replace the optimistic card while it is
  //    displayed: only the authoritative session counters are applied;
  //  - an OPTIMISTIC completion (the last local card rated with submits in
  //    flight) is only cleared when the response carries a REAL terminal or
  //    next-card state — a stale response for an already-rated card keeps
  //    the done panel (no blank/disabled card).
  function adoptServerState(session, card, preloaded) {
    data.session = session;
    // v2: track the current card's stable queue position from the adopted
    // session (currentPosition) or its bounded queueWindow; the widget never
    // holds the full queue, so this position is the claim target for submits.
    if (isV2SessionState(session)) {
      if (typeof session.currentPosition === 'number') data.currentPosition = session.currentPosition;
      else if (session.queueWindow && typeof session.queueWindow.currentPosition === 'number') data.currentPosition = session.queueWindow.currentPosition;
      else data.currentPosition = null;
    } else {
      data.currentPosition = null;
    }
    // Out-of-order/parallel reconciliation: NEVER regress the display to a
    // card the user already rated. The local in-flight/rated set is
    // authoritative for "rated"; the backend reviewedCardIds array is folded
    // in for LEGACY v1 sessions only (v2 roots are BOUNDED and omit it — the
    // authoritative counts + chunk claims carry the state).
    var rated = ratedCardIds || {};
    var reviewed = session && !isV2SessionState(session) && Array.isArray(session.reviewedCardIds) ? session.reviewedCardIds : [];
    // The queue is MONOTONIC: a preload array MERGES into the local queue
    // (add/update only, preserving order) — it can never replace or shrink
    // it. Completion is decided later against the authoritative cardIds
    // (allSessionCardsAccountedFor), never by preload presence.
    if (Array.isArray(preloaded)) {
      mergeQueueCards(preloaded);
    }
    // Rebuild the queue in the authoritative session.cardIds order so the
    // buffer tracks the real session (rated/displayed cards are dropped,
    // order is exact). This is a merge, never a shrink-to-response.
    seedQueueFromSession();
    if (card && card.id && (rated[card.id] || reviewed.indexOf(card.id) !== -1)) {
      // A stale/older response for a card that was already rated (or whose
      // rating is in flight): keep the displayed card, apply only the
      // authoritative session counters. Never regress. When an optimistic
      // completion is showing, this stale response cannot resurrect the
      // last card — the done panel stays until a real terminal/next state.
      if (!optimisticDone) render();
      return;
    }
    // A REAL authoritative state: clear the optimistic completion — the
    // backend has decided the terminal/next card.
    optimisticDone = false;
    if (card) {
      var resolved = resolveCard(card);
      data.card = resolved;
      if (isMinimalCard(resolved) && data.flashcardTool) {
        fetchFlashcardFallback(resolved.id);
      }
    } else if (queue.length) {
      // No current card but preloaded remain: advance to the first unrated.
      var nextCard = queue.shift();
      // Never advance to a card the user has already rated (an out-of-order
      // response may confirm a rating for a preloaded card still in queue).
      while (nextCard && nextCard.id && (rated[nextCard.id] || reviewed.indexOf(nextCard.id) !== -1) && queue.length) {
        nextCard = queue.shift();
      }
      if (nextCard && !(nextCard.id && (rated[nextCard.id] || reviewed.indexOf(nextCard.id) !== -1))) {
        data.card = nextCard;
        cacheFullCard(nextCard);
      }
    } else if (data.session && (data.session.status === 'completed' || data.session.status === 'ended')) {
      // Authoritative completion: no card, queue empty → done state.
      data.card = null;
    }
    render();
  }

  // Data-only get_flashcard fallback (no UI linkage): fills an id-only card
  // from the server when the host stripped the full card. The result is only
  // applied if the displayed card is STILL the same id (never a wrong card).
  function fetchFlashcardFallback(cardId) {
    var gen = generation;
    callTool(data.flashcardTool || 'get_flashcard', { id: cardId })
      .then(function (res) {
        if (gen !== generation) return; // session ended while fetching
        if (!data.card || data.card.id !== cardId) return; // card advanced
        var full = res && (res.structuredContent || (res.content && res.content[0] && res.content[0].structuredContent));
        var cardObj = full && (full.card || (full.id ? full : null));
        if (!cardObj || isMinimalCard(cardObj)) return; // nothing useful
        data.card = { ...(isMinimalCard(data.card) ? {} : data.card), ...cardObj, id: cardId };
        render();
      })
      .catch(function () {
        // Keep the id-only card; the user can still rate (expectedCardId is
        // the id) or reveal — never fabricate content.
      });
  }

  // Apply an end_review_session result: the tool returns the PLAIN session
  // summary ({ id, status: 'ended', ... }) — NOT { session: ... } — so the
  // card/queue are cleared and the widget renders the hidden ended state.
  // Used by both the active End Session button and the completed-panel Finish.
  function adoptEndResult(res) {
    if (!res) return;
    var sc = res.structuredContent || (res.content && res.content[0] && res.content[0].structuredContent);
    if (sc && sc.id && (sc.status === 'ended' || sc.status === 'completed')) {
      data.session = sc;
      data.card = null;
      queue = [];
      optimisticDone = false;
      inflightByCard = {};
      inflightByRequest = {};
      ending = false;
      render();
    }
  }

  // Optimistic counter projection: authoritative session counts plus the
  // in-flight rating deltas the server has NOT already acknowledged. A
  // rating is acknowledged when its requestId appears in the authoritative
  // session.processedRequestIds (v1) / lastRequestId (v2) or its card id in
  // session.reviewedCardIds (v1) — those ratings are already inside the
  // authoritative counts. v2 roots are BOUNDED (no processedRequestIds /
  // reviewedCardIds arrays), so acknowledgement is the echo of lastRequestId
  // on the adopted session. Synchronous: called from render, so a rating
  // bumps the counters immediately, before any submit resolves. Never
  // mutates the authoritative session.
  function optimisticReviewDelta(sess) {
    if (!sess) return 0;
    var v2 = isV2SessionState(sess);
    var processed = v2 ? [] : (Array.isArray(sess.processedRequestIds) ? sess.processedRequestIds : []);
    var reviewedCards = v2 ? [] : (Array.isArray(sess.reviewedCardIds) ? sess.reviewedCardIds : []);
    var lastReq = sess.lastRequestId;
    var pending = 0;
    for (var key in inflightByCard) {
      var item = inflightByCard[key];
      if (!item) continue;
      if (processed.indexOf(item.requestId) !== -1) continue;
      if (reviewedCards.indexOf(item.expectedCardId) !== -1) continue;
      if (v2 && lastReq === item.requestId) continue;
      pending += 1;
    }
    return pending;
  }
  function optimisticPending() { return optimisticReviewDelta(data.session || {}); }

  function render() {
    var s = data.session || {};
    // Presentation-only pill label: the raw session modeTag ("[Spaced
    // repetition review · N cards due]") is reduced to its plain mode name —
    // the brackets and the due-count suffix are chrome and never shown; the
    // session state itself is untouched.
    var rawTag = String(s.modeTag || '');
    var pill = rawTag.replace(/^\\[/, '').replace(/\\]\\s*$/, '').replace(/\\s*·\\s*\\d+\\s+cards?\\s+due\\s*$/, '').replace(/\\s*·\\s*\\d+\\s+cards?\\s*·\\s*[^·\\]]*\\s*$/, '').trim();
    modeTag.textContent = pill || 'Spaced repetition review';
    // Projected counters: authoritative session counts plus the optimistic
    // delta for in-flight ratings the server has not yet acknowledged
    // (processedRequestIds/reviewedCardIds). A rating bumps the display
    // synchronously; an acknowledged response never double-counts.
    var optimistic = optimisticReviewDelta(s);
    var reviewed = (s.reviewedCount || 0) + optimistic;
    var remaining = s.remainingCount != null ? Math.max(0, s.remainingCount - optimistic) : s.remainingCount;
    progress.textContent = (optimistic === 0 && s.visibleStatus) || (s.status + ' \u00b7 ' + reviewed + ' reviewed, ' + (remaining != null ? remaining : '?') + ' remaining');
    // Progress denominator: v1 sessions carry the full root cardIds; v2 roots
    // are BOUNDED so the total queue size is the persisted limit (or the
    // bounded window length as a fallback - never a fabricated number).
    // Progress denominator precedence: v2 canonical totalCount first, then
    // the v1 full root cardIds length, then the persisted limit, then the
    // bounded window length as a last-resort fallback — never a fabricated
    // number and never a full-queue dependency.
    var total = (s.totalCount != null ? s.totalCount : ((s.cardIds && s.cardIds.length) ? s.cardIds.length : (s.limit || (s.queueWindow && s.queueWindow.cardIds ? s.queueWindow.cardIds.length : 100))));
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round((reviewed / total) * 100))) : 0;
    progressFill.style.width = pct + '%';
    // Counter presentation: "N reviewed | M left" — CSS uppercases it to the
    // reference's "N REVIEWED | M LEFT" with an understated pipe divider.
    cardLabel.textContent = remaining != null
      ? reviewed + ' reviewed | ' + remaining + ' left'
      : reviewed + ' reviewed';
    var card = data.card;
    // OPTIMISTIC completion: the last locally-known card of a hydrated
    // session was rated while submits are still in flight — show the clean
    // done panel (fully interactive) instead of a blank/disabled card. No
    // request wording is ever shown; the authoritative response reconciles
    // the terminal state (adoptServerState clears optimisticDone).
    var doneMode = s.status === 'completed' || optimisticDone;
    var activeSession = !doneMode && s.status !== 'ended' && !!card;
    cardShell.classList.toggle('hidden', !activeSession);
    hint.classList.toggle('hidden', !activeSession);
    ratings.classList.toggle('hidden', !activeSession);
    typed.classList.toggle('hidden', !activeSession);
    done.classList.toggle('hidden', !doneMode);
    // Active End Session control: shown only while a session is in progress
    // (hidden on the completed panel, where Finish/Continue apply).
    endRow.classList.toggle('hidden', !activeSession);
    // The deck label ALWAYS shows the CURRENT CARD's own deck name (falling
    // back to the session display name, then a neutral label) — a session
    // name or source can never hide which deck the card belongs to, even in
    // mixed-deck custom/tag sessions.
    deckLabel.textContent = (card && card.deck ? card.deck : '') || s.name || 'Review session';
    // The source label shows WHAT defined the session: "Due cards" (no
    // selectors), the deck name (deck-only selection), or "Custom" (any
    // tags/card-ids/mixed selection) — separate from the card's own deck.
    var src = s.source;
    var sourceText = src && src.type === 'deck'
      ? (src.deckName || s.name || 'Deck')
      : src && src.type === 'custom'
        ? 'Custom'
        : 'Due cards';
    sourceLabel.textContent = sourceText;
    if (card) {
      // PERSISTENT reset state, applied BEFORE any content write: a different
      // card's content must never be installed into a subtree that is
      // back-facing or transitioning. .resetting pins card-inner to
      // transform:none !important + transition:none !important, so from this
      // point on the card is front-facing and non-animating regardless of
      // when the browser samples/paints. The class is kept through first
      // paint and removed only by the next intentional user flip/reveal
      // (flipToBack) — never by render, rAF, or a timer.
      if (renderedCardId !== card.id) {
        renderedCardId = card.id;
        cardShell.classList.remove('flipped');
        cardShell.classList.add('resetting');
      }
      // Same-card re-renders preserve the user's flip state (async session
      // updates must not flip the card back on its own); content is written
      // for both branches only AFTER the reset state above is established.
      frontInner.innerHTML = renderFront(text(card.front));
      backInner.innerHTML = esc(text(card.back));
      // PARALLEL ratings: controls stay ENABLED for the displayed card unless
      // THAT card already has an in-flight submit (the per-card map makes a
      // rapid double-click on the same card a no-op). Other cards' in-flight
      // ratings never block the current card — a rating can be fired for the
      // displayed card at any time.
      var cardInFlight = card && card.id ? !!inflightByCard[card.id] : false;
      if (cardInFlight) {
        ratings.classList.add('disabled');
        Array.prototype.forEach.call(ratings.querySelectorAll('button'), function (b) { b.disabled = true; });
        checkBtn.disabled = true;
        revealBtn.disabled = true;
      } else {
        ratings.classList.remove('disabled');
        Array.prototype.forEach.call(ratings.querySelectorAll('button'), function (b) { b.disabled = false; });
        checkBtn.disabled = false;
        revealBtn.disabled = false;
        endSessionBtn.disabled = false;
      }
      answerInput.value = '';
      typedPrompt.textContent = text(card.selfTest) || (sessionCardType() === 'cloze' ? 'Type the answer for the blank' : 'Type your answer');
      answerInput.focus();
    }
    if (doneMode) {
      doneTitle.textContent = s.continuationAvailable
        ? 'Review session complete \u2014 choose Finish or Continue review'
        : 'Review session complete \u2014 choose Finish (all due cards were reviewed)';
      continueBtn.classList.toggle('hidden', !s.continuationAvailable);
    }
    statusEl.textContent = '';
  }

  function primeFromSession() {
    // Seed the queue and the card cache from the latest session response:
    // the preloaded array is authoritative; the current card is the next one
    // until a submit lands. The session's reviewedCardIds (persisted by the
    // backend, echoed in the full widget state for LEGACY v1 sessions) is
    // folded into the local rated set so a reload during parallel/out-of-order
    // submits never re-shows an already-rated FUTURE card (which would 409 on
    // a duplicate submit). v2 roots are BOUNDED (no reviewedCardIds) — the
    // local rated set + authoritative counters carry the state.
    var s = data.session || {};
    // v2 bootstrap/init: sync the tracked current position from the adopted
    // session (currentPosition) or its bounded queueWindow — the claim
    // target for submits. Runs at startup and on every session adopt.
    if (isV2SessionState(s)) {
      if (typeof s.currentPosition === 'number') data.currentPosition = s.currentPosition;
      else if (s.queueWindow && typeof s.queueWindow.currentPosition === 'number') data.currentPosition = s.queueWindow.currentPosition;
      else data.currentPosition = null;
    }
    var reviewed = !isV2SessionState(s) && Array.isArray(s.reviewedCardIds) ? s.reviewedCardIds : [];
    for (var ri = 0; ri < reviewed.length; ri += 1) ratedCardIds[reviewed[ri]] = true;
    var pre = Array.isArray(s.preloaded) ? s.preloaded.slice() : [];
    // MONOTONIC seeding: merge the response preloads into the queue (never
    // replace), then rebuild in the authoritative queue order (v1 root
    // cardIds; v2 queueWindow.cardIds). ratedCardIds filters rated cards;
    // an already-rated CURRENT card is replaced by the first unrated card.
    mergeQueueCards(pre);
    seedQueueFromSession();
    // The current card is authoritative; if it was already rated (stale
    // reload), drop it so the queue's first unrated card takes over.
    if (data.card && ratedCardIds[data.card.id]) {
      data.card = null;
      while (queue.length && ratedCardIds[queue[0].id]) queue.shift();
      if (queue.length) {
        data.card = queue.shift();
        cacheFullCard(data.card);
      }
    }
    cacheFullCard(data.card);
    // The filtered current card must be rendered — primeFromSession can
    // CHANGE data.card (a stale rated current card is replaced by the first
    // unrated queue card), so the DOM is refreshed here.
    render();
  }

  // Standard MCP Apps iframe bridge: JSON-RPC 2.0 messages posted to the
  // parent window. The sandboxed widget iframe has no window.openai — the
  // host listens for ui/notifications/* messages and replies on the request id.
  var rpcSeq = 0;
  var rpcWaiters = {};
  var rpcReady = false;

  function rpcSend(method, params) {
    var id = ++rpcSeq;
    return new Promise(function (resolve, reject) {
      rpcWaiters[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
      // The host may not respond (no bridge / non-OpenAI host): time out so
      // the caller can fall back gracefully instead of hanging forever.
      setTimeout(function () {
        if (rpcWaiters[id]) {
          delete rpcWaiters[id];
          reject(new Error('No response from host (bridge unavailable)'));
        }
      }, 15000);
    });
  }

  // Extracts the structuredContent from a tool result delivered in any of
  // the shapes the Apps SDK host uses: the result itself, params.output, or
  // params.output.content[0].structuredContent. Returns null when absent.
  function extractStructuredContent(payload) {
    if (!payload) return null;
    if (payload.structuredContent) return payload.structuredContent;
    if (payload.output != null) {
      var out = payload.output;
      if (out && out.structuredContent) return out.structuredContent;
      if (out && out.content && out.content[0] && out.content[0].structuredContent) return out.content[0].structuredContent;
    }
    if (payload.content && payload.content[0] && payload.content[0].structuredContent) return payload.content[0].structuredContent;
    return null;
  }

  // Applies a session-with-card tool result (start/get/submit) to the widget
  // state. Safe for unsolicited initial notifications and async results.
  // The FULL widget state rides in the hidden Apps SDK _meta['ui/widgetState']
  // (quiet mode); the minimal structuredContent (session id/status/card id)
  // is a fallback for hosts that strip _meta.
  function applyToolResult(payload) {
    var meta = payload && payload._meta;
    var hidden = meta && (meta['ui/widgetState'] || (meta.ui && meta.ui.widgetState));
    if (hidden && hidden.session) {
      if (typeof hidden.currentPosition === 'number') data.currentPosition = hidden.currentPosition;
      adoptServerState(hidden.session, hidden.card !== undefined ? hidden.card : null, hidden.preloaded);
      return;
    }
    var sc = extractStructuredContent(payload);
    if (sc && sc.session) {
      adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);
    }
  }

  function rpcHandle(event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.method === 'ui/notifications/tool-result') {
      // Tool result delivered as a notification. Two cases:
      //  (a) async response to a tools/call we sent: params.id matches our
      //      request id — resolve the waiter;
      //  (b) UNSOLICITED initial result (empty bootstrap): the host seeds the
      //      iframe with the session tool's structuredContent — apply it so
      //      the widget renders instead of staying blank.
      var p = msg.params || {};
      var w = rpcWaiters[p.id];
      if (w) {
        delete rpcWaiters[p.id];
        w.resolve(p.output);
        return;
      }
      applyToolResult(p);
      return;
    }
    if (msg.id == null) return; // other notifications without an id
    if (msg.method) {
      // Inbound request (e.g. ui/initialize): answer with a result echo.
      // The host expects the initialize response to echo the protocolVersion.
      if (msg.method === 'ui/initialize') {
        window.parent.postMessage({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params && msg.params.protocolVersion } }, '*');
      }
      return;
    }
    var waiter = rpcWaiters[msg.id];
    if (!waiter) return;
    delete rpcWaiters[msg.id];
    if (msg.error) waiter.reject(new Error(msg.error.message || 'RPC error'));
    else waiter.resolve(msg.result);
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', rpcHandle);
  }

  // MCP Apps lifecycle handshake: the View (this widget) INITIATES
  // ui/initialize once on load (per the ext-apps AppBridge spec), then sends
  // ui/notifications/initialized after the host's result. The request carries
  // appInfo (Implementation), appCapabilities, and the protocolVersion.
  var handshakeDone = false;
  var handshakeInited = false;
  var HANDSHAKE_PROTOCOL = '2026-01-26';
  function startHandshake() {
    if (handshakeInited) return;
    handshakeInited = true;
    rpcSend('ui/initialize', {
      appInfo: { name: 'fsrs-review-widget', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: HANDSHAKE_PROTOCOL,
    })
      .then(function () {
        if (handshakeDone) return;
        handshakeDone = true;
        // Notify the host the view is initialized and ready for tool input.
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      })
      .catch(function () {
        // No host bridge (standalone/preview): fall back silently.
        handshakeInited = false;
      });
  }
  // Start the handshake after the initial render so the DOM is ready.
  setTimeout(startHandshake, 0);

  // Extracts a human-readable message from a tool result (content array or
  // error text) for clear status display — never masks the underlying error.
  function toolErrorMessage(res) {
    if (!res) return 'Tool call failed';
    if (res.error) {
      var e = res.error;
      return (typeof e === 'string' ? e : (e.message || 'Tool call failed'));
    }
    if (Array.isArray(res.content) && res.content.length > 0) {
      var c0 = res.content[0];
      if (c0 && c0.text) return String(c0.text);
      if (c0 && c0.type === 'text' && c0.structuredContent) return 'Tool call failed';
    }
    return 'Tool call failed';
  }

  function callTool(name, args) {
    return new Promise(function (resolve, reject) {
      // Primary host bridge: the ChatGPT Apps SDK exposes window.openai
      // (legacy compatibility extension in the ChatGPT sandbox).
      var oai = window.openai;
      if (oai && typeof oai.callTool === 'function') {
        oai.callTool(name, args).then(function (res) {
          if (res && res.isError) { reject(new Error(toolErrorMessage(res))); return; }
          resolve(res);
        }, reject);
        return;
      }
      // Fallback host bridge (non-OpenAI Apps SDK hosts).
      var host = window.__MCP_HOST__;
      if (host && typeof host.callTool === 'function') {
        host.callTool(name, args).then(function (res) {
          if (res && res.isError) { reject(new Error(toolErrorMessage(res))); return; }
          resolve(res);
        }, reject);
        return;
      }
      // Standard MCP Apps bridge: postMessage JSON-RPC to the parent.
      // The host resolves the tool call asynchronously and delivers the
      // result back as ui/notifications/tool-result on the same request id.
      rpcSend('tools/call', { name: name, arguments: args })
        .then(function (result) { resolve(result); })
        .catch(function () {
          // No host bridge: show what the assistant should do next (textual
          // fallback) instead of failing silently.
          statusEl.textContent = 'Use the ' + name + ' tool with: ' + JSON.stringify(args);
          resolve(null);
        });
    });
  }

  // Hydrate the initial session/card from the host's published tool output
  // (Apps SDK: window.openai.toolOutput — an array of { toolName, output }).
  // The static resource cannot know the current session, so the last
  // session-tool result (start/get/submit) becomes the bootstrap state.
  // Recursively unwraps a tool result envelope down to the object that
  // carries the result payload (with hidden _meta['ui/widgetState']):
  // handles { toolName, output }, { result }, { call_tool_result },
  // { mcp_tool_result }, and nested { output: { result: ... } } shapes.
  function unwrapToolResult(entry) {
    if (!entry || typeof entry !== 'object') return null;
    for (var depth = 0; depth < 6; depth += 1) {
      var next = null;
      if (entry.call_tool_result != null) next = entry.call_tool_result;
      else if (entry.mcp_tool_result != null) next = entry.mcp_tool_result;
      else if (entry.output != null && typeof entry.output === 'object') next = entry.output;
      else if (entry.result != null && typeof entry.result === 'object') next = entry.result;
      if (next === null || next === entry) break;
      entry = next;
    }
    return entry;
  }

  // Collects candidate tool results from toolResponseMetadata (object or
  // array) and toolOutput (object or array), newest first, so hydration finds
  // the LAST session-tool result with hidden full state.
  function collectToolResults() {
    var oai = window.openai;
    if (!oai) return [];
    var out = [];
    var meta = oai.toolResponseMetadata;
    if (meta && typeof meta === 'object') {
      if (Array.isArray(meta)) {
        for (var i = meta.length - 1; i >= 0; i--) out.push({ name: meta[i] && (meta[i].toolName || meta[i].name), entry: meta[i] });
      } else {
        // Object shape: { status?, call_tool_result?, mcp_tool_result? } or a
        // single per-tool envelope { toolName?, output?, result?, _meta? }.
        var name = meta.toolName || meta.name;
        if (name) {
          out.push({ name: name, entry: meta });
        } else {
          // Bare envelope keys: mcp_tool_result / call_tool_result (no tool
          // name — they are the result of the last tool call). Also tolerate
          // a tool-name keyed map. Envelope keys are pushed WITHOUT a name so
          // the session filter never skips them.
          for (var k in meta) {
            if (Object.prototype.hasOwnProperty.call(meta, k) && k !== 'status') {
              var v = meta[k];
              if (v && typeof v === 'object') {
                if (k === 'call_tool_result' || k === 'mcp_tool_result' || k === 'result' || k === 'output') {
                  out.push({ name: '', entry: v });
                } else {
                  out.push({ name: k, entry: v });
                }
              }
            }
          }
        }
      }
    }
    var outputs = oai.toolOutput;
    if (outputs && typeof outputs === 'object') {
      if (Array.isArray(outputs)) {
        for (var j = outputs.length - 1; j >= 0; j--) {
          var e = outputs[j];
          if (!e) continue;
          out.push({ name: e.toolName || e.name, entry: e.output != null ? e.output : e });
        }
      } else if (outputs.toolName || outputs.name) {
        out.push({ name: outputs.toolName || outputs.name, entry: outputs.output != null ? outputs.output : outputs });
      }
    }
    return out;
  }

  function hydrateFromToolOutput() {
    var sessionTools = {};
    sessionTools[data.submitTool] = true;
    sessionTools[data.startTool] = true;
    sessionTools[data.getTool] = true;
    var candidates = collectToolResults();
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      // Only skip candidates named for a NON-session tool (e.g. a get_flashcard
      // entry). Any session tool (start/get/submit) and bare envelope keys
      // (mcp_tool_result / call_tool_result) are always tried — they may carry
      // the last session-tool result with the hidden full state.
      if (cand.name && sessionTools[cand.name] === undefined) {
        continue;
      }
      var wrapped = unwrapToolResult(cand.entry);
      if (wrapped && (wrapped._meta || extractStructuredContent(wrapped))) {
        applyToolResult(wrapped);
        return;
      }
    }
  }

  // The ONLY place the card may leave the persistent .resetting state. The
  // user's next intentional flip/reveal removes .resetting (re-enabling the
  // normal .5s transform transition on card-inner), then adds .flipped so
  // the front-to-back animation runs. The reflow between the two class
  // changes commits the transition-property change (none → .5s) FIRST, so
  // the transform change in the NEXT style recalc starts the animation; if
  // the browser coalesces the recalcs, the worst case is an instant snap —
  // never a flash, because no content changes during a user flip. Never
  // called from render/rAF/timer.
  function flipToBack() {
    cardShell.classList.remove('resetting');
    void cardInner.offsetHeight; // commit the transition re-arm before flipping
    cardShell.classList.add('flipped');
  }
  // Toggle-to-front (click/keyboard on an already-flipped card): removes
  // .flipped so the card animates back to the front. A card that is still
  // in the .resetting state cannot have been flipped by the user, so the
  // only transitions that can run here are genuine user flip animations.
  function toggleFlip() {
    if (cardShell.classList.contains('flipped')) {
      cardShell.classList.remove('flipped');
      return;
    }
    flipToBack();
  }

  cardShell.addEventListener('click', function () {
    if (cardShell.classList.contains('hidden')) return;
    toggleFlip();
  });
  cardShell.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!cardShell.classList.contains('hidden')) toggleFlip();
    }
  });

  function disableControls() {
    ratings.classList.add('disabled');
    Array.prototype.forEach.call(ratings.querySelectorAll('button'), function (b) { b.disabled = true; });
    checkBtn.disabled = true;
    revealBtn.disabled = true;
  }
  function enableControls() {
    ratings.classList.remove('disabled');
    Array.prototype.forEach.call(ratings.querySelectorAll('button'), function (b) { b.disabled = false; });
    checkBtn.disabled = false;
    revealBtn.disabled = false;
  }

  // PARALLEL rating pipeline: EVERY rating captures the DISPLAYED card id
  // and submits immediately — there is NO single-flight gate (the old
  // "if (inflight) return" is gone). Ratings are tracked per claimed card and per
  // requestId: a rapid double-click on the SAME displayed card never
  // double-submits (the per-card map), while ratings for DIFFERENT cards
  // (parallel preloaded-card reviews) all stay in flight at once. The
  // optimistic next card (shifted from the preloaded queue BEFORE the
  // submit starts) is displayed synchronously; the backend response is the
  // sole source of truth for the session counters, and an id-only response
  // resolving to the same card keeps the full displayed card (never a white
  // card, never a regression).
  function rate(rating) {
    if (!data.session || !data.session.id) return;
    if (ending) return; // an end request is in flight — no new ratings
    if (!data.card || !data.card.id) return; // nothing displayed to rate
    var expectedCardId = data.card.id;
    // v2 sessions claim BY POSITION (the widget never holds the full queue —
    // only the bounded window). The authoritative position comes from the
    // displayed card's own position (carried by preloads/queueWindow when
    // the backend sent it), falling back to the adopted session
    // currentPosition. Never a guessed increment: the backend is the source
    // of truth for positions after every response.
    var expectedPosition = null;
    if (isV2SessionState(data.session)) {
      var cardPos = data.card && typeof data.card.position === 'number' ? data.card.position : null;
      if (cardPos !== null) expectedPosition = cardPos;
      else if (typeof data.currentPosition === 'number') expectedPosition = data.currentPosition;
    }
    // A rapid double-click on the SAME displayed card must never double
    // submit (the per-card map is the guard — not a global inflight flag).
    if (inflightByCard[expectedCardId]) return;
    // Cache the RATED card before it leaves the display (a late id-only
    // response for it still resolves full from the cache).
    cacheFullCard(data.card);
    requestSeq += 1;
    var item = { rating: rating, requestId: 'req-' + Date.now().toString(36) + '-' + requestSeq, expectedCardId: expectedCardId, expectedPosition: expectedPosition };
    inflightByCard[expectedCardId] = item;
    inflightByRequest[item.requestId] = item;
    ratedCardIds[expectedCardId] = true;
    disableControls();
    // OPTIMISTIC next card: the monotonic preloaded queue is the next-card
    // source of truth, so shift the next full card into data.card and render
    // BEFORE the submit starts — the next card's front/back appear
    // immediately while the submit is unresolved. The captured
    // expectedCardId (above) still refers to the rated card, so parallel
    // correctness is untouched.
    if (queue.length) {
      var nextCard = queue.shift();
      cacheFullCard(nextCard);
      data.card = nextCard;
      // The buffered next card carries its own stable queue position when the
      // backend sent one (v2 preloads); otherwise fall back to incrementing
      // the adopted current position.
      if (typeof nextCard.position === 'number') data.currentPosition = nextCard.position;
      else if (typeof data.currentPosition === 'number') data.currentPosition += 1;
      render();
      submitItem(item);
      return;
    }
    // Queue exhausted. Optimistic completion is ONLY valid when every
    // authoritative session card is locally accounted for (rated/in-flight,
    // displayed, or cached) — i.e. the buffer emptied because the session is
    // genuinely at its last card, not because an UNCAPPed session outran its
    // bounded preload window (a never-seen unrated cardId means the submit
    // response will deliver the next card). Show the clean done panel fully
    // interactive (no request wording, no blank/disabled card); the
    // authoritative response reconciles (adoptServerState clears
    // optimisticDone).
    if (allSessionCardsAccountedFor()) {
      optimisticDone = true;
      render();
      submitItem(item);
      return;
    }
    // Cards beyond the local buffer are still unknown: keep the rated card
    // displayed (the response re-syncs the next card).
    render();
    submitItem(item);
  }

  // Submits ONE rating (parallel). The expectedCardId is the id of the card
  // the user was looking at when they rated — the session's authoritative
  // target. Failures NEVER resend a stale id: on any error the widget
  // re-syncs via get_review_session, adopts the authoritative current card,
  // and re-enables, so the user rates whatever the backend says is current.
  // Each in-flight item resolves INDEPENDENTLY: an out-of-order response
  // reconciles against the authoritative session state without regressing
  // the displayed card (see adoptServerState), and never touches another
  // item's bookkeeping.
  function submitItem(item) {
    var gen = generation;
    // Capture the session id at send time — the session is immutable for
    // the life of this submit.
    var sid = data.session.id;
    var submitArgs = { sessionId: sid, rating: item.rating, requestId: item.requestId, expectedCardId: item.expectedCardId };
    if (item.expectedPosition != null) submitArgs.expectedPosition = item.expectedPosition;
    callTool(data.submitTool, submitArgs)
      .then(function (res) {
        if (gen !== generation) return; // stale: session ended while in flight
        var sc = res && (res.structuredContent || (res.content && res.content[0] && res.content[0].structuredContent));
        if (sc && sc.session) {
          // Authoritative state wins: the session counters and the next card
          // are adopted. When the response card matches the optimistically
          // displayed next card, the full displayed card is PRESERVED (never
          // blanked/regressed); an id-only response resolves from the cache.
          // The committed rating leaves the in-flight maps BEFORE adopting:
          // the authoritative counts already include it, so the optimistic
          // projection must not transiently add its delta back when the
          // minimal submit response omits processedRequestIds/reviewedCardIds.
          clearInflightItem(item);
          adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);
        } else {
          // No usable state in the response (e.g. a host that strips _meta):
          // re-sync before re-enabling so the user rates the authoritative
          // current card. The item's bookkeeping is cleared FIRST (see the
          // catch path) so the sync can restore the still-current card.
          clearInflightItem(item, true);
          syncAfterSubmit(gen);
        }
        // Success: the rating COMMITTED — keep ratedCardIds[cardId] true so a
        // late/out-of-order duplicate or unsolicited response for this card
        // (MCP session summaries omit reviewedCardIds) can never regress the
        // display. Only the in-flight maps are cleared.
        clearInflightItem(item);
        render();
        statusEl.textContent = '';
      })
      .catch(function () {
        if (gen !== generation) return; // stale: session ended while in flight
        // NO visible error/request copy: the user never sees backend work.
        // Re-sync authoritative state, then re-enable. NEVER retry the stale
        // item: the backend rejected it because the session advanced; the
        // displayed card after the sync is the one to rate. CRITICAL: the
        // item's maps AND its ratedCardIds flag are cleared BEFORE the sync —
        // otherwise adoptServerState would suppress the failed card (it is
        // still marked rated) and the user could never retry it.
        clearInflightItem(item, true);
        syncAfterSubmit(gen);
      });
  }

  // Removes an item from the in-flight maps (by card id and requestId). The
  // ratedCardIds flag is unmarked ONLY on FAILED/empty responses (unmark ===
  // true) so that card can be retried; a SUCCESSFUL submit keeps the card
  // marked rated — MCP session summaries omit reviewedCardIds, so the local
  // flag is the only guard that stops a late/out-of-order duplicate response
  // for a committed card from regressing the display. Other in-flight items'
  // cards stay marked (never double-rated).
  function clearInflightItem(item, unmark) {
    if (!item) return;
    if (item.requestId && inflightByRequest[item.requestId] === item) {
      delete inflightByRequest[item.requestId];
    }
    if (item.expectedCardId && inflightByCard[item.expectedCardId] === item) {
      delete inflightByCard[item.expectedCardId];
    }
    if (unmark && item.expectedCardId && ratedCardIds[item.expectedCardId] === true) {
      delete ratedCardIds[item.expectedCardId];
    }
  }

  // Re-sync the authoritative session state after a failed/empty submit
  // result, then re-enable the rating controls for the displayed card.
  // Parallel-safe: clears ONLY this item's bookkeeping (other in-flight
  // items are untouched) and reconciles the displayed card against the
  // authoritative current card.
  function syncAfterSubmit(gen) {
    if (!data.getTool || !data.session || !data.session.id) {
      render();
      return;
    }
    callTool(data.getTool, { sessionId: data.session.id })
      .then(function (syncRes) {
        if (gen !== generation) return; // session ended while syncing
        var sc = syncRes && (syncRes.structuredContent || (syncRes.content && syncRes.content[0] && syncRes.content[0].structuredContent));
        if (sc && sc.session) {
          // Authoritative card restored: adopt the session's current card
          // (full from cache or preloaded; id-only resolved from cache).
          adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);
        } else {
          // No usable sync state: keep the displayed card (full or minimal)
          // so the user can still rate or reveal — never a blank card.
          render();
        }
        statusEl.textContent = '';
      })
      .catch(function () {
        if (gen !== generation) return;
        render();
      });
  }

  checkBtn.addEventListener('click', function () {
    if (!data.session || !data.session.id || !data.card) return;
    var answer = { text: answerInput.value || '', revealed: false };
    checkBtn.disabled = true;
    // Fully local deterministic evaluation against the DISPLAYED card:
    // ZERO tool calls, no ChatGPT/semantic fallback. The outcome mirrors
    // the backend's evaluateTypedAnswer exactly, so the widget never needs
    // a correction request.
    var route = evaluateLocalAnswer(data.card, sessionCardType(), answer);
    if (route.kind === 'correct') {
      checkBtn.disabled = false;
      statusEl.textContent = 'Correct \u2014 now rate how well you knew it.';
    } else if (route.kind === 'incorrect') {
      checkBtn.disabled = false;
      statusEl.textContent = 'Not quite \u2014 the expected answer was "' + route.expected + '". Now rate it.';
    } else if (route.kind === 'empty') {
      checkBtn.disabled = false;
      statusEl.textContent = 'Type an answer first (or reveal the card).';
      return;
    } else if (route.kind === 'no-answer') {
      checkBtn.disabled = false;
      statusEl.textContent = 'This card has no comparable answer \u2014 reveal it and rate it.';
      return;
    } else {
      // revealed
      checkBtn.disabled = false;
      statusEl.textContent = 'Answer revealed \u2014 rate it (Again if you got it wrong).';
    }
    flipToBack();
    ratings.classList.remove('hidden');
  });
  revealBtn.addEventListener('click', function () {
    flipToBack();
    ratings.classList.remove('hidden');
    statusEl.textContent = 'Answer revealed \u2014 rate it (Again if you got it wrong).';
  });

  ratings.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-rating]');
    if (!btn) return;
    if (ratings.classList.contains('disabled')) return;
    rate(Number(btn.getAttribute('data-rating')));
  });

  function requestEnd() {
    if (!data.session || !data.session.id) return;
    if (ending) return; // already ending — no double request
    ending = true;
    // Bump the generation: any in-flight submit callback becomes stale and
    // no-ops, so the end result stays authoritative and a late submit
    // response can never resurrect the card.
    generation += 1;
    // No new ratings while the end request is in flight; any in-flight rating
    // is abandoned (the session is being ended, not reviewed).
    inflightByCard = {};
    inflightByRequest = {};
    disableControls();
    // No request-state wording: the user never sees that a backend call is
    // in flight. The end result renders the ended state.
    callTool(data.endTool, { sessionId: data.session.id })
      .then(function (res) {
        adoptEndResult(res);
        statusEl.textContent = 'Session ended.';
      })
      .catch(function () {
        // End failed: re-sync the authoritative session state so a rating
        // that was already committed before the end request is reflected
        // (never silently lost), then restore the pipeline safely.
        ending = false;
        enableControls();
        endSessionBtn.disabled = false;
        if (data.getTool && data.session && data.session.id) {
          callTool(data.getTool, { sessionId: data.session.id })
            .then(function (syncRes) {
              var sc = syncRes && (syncRes.structuredContent || (syncRes.content && syncRes.content[0] && syncRes.content[0].structuredContent));
              if (sc && sc.session) {
                adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);
              }
            })
            .catch(function () { /* keep the error message; sync is best-effort */ });
        }
      });
  }

  endSessionBtn.addEventListener('click', requestEnd);

  finishBtn.addEventListener('click', requestEnd);
  continueBtn.addEventListener('click', function () {
    // Start a NEW spaced-repetition session covering the remaining due cards,
    // carrying the deck filter, presentation cardType, and name from the
    // finished session so the mode does not silently change, then render the
    // returned session + first card.
    var args = {};
    var s = data.session || {};
    var src = s.source;
    var v2 = isV2SessionState(s);
    // Continue a FINISHED session.
    //  - v2 sessions: pass repeatSessionId ONLY — the backend COPIES the
    //    finished session's chunked queue verbatim (exact snapshot replay,
    //    never a fresh query that could differ from what was reviewed).
    //  - legacy v1/no-version sessions (no chunked queue to copy): replay the
    //    selector provenance through the normal start path.
    if (v2 && s.id) {
      args.repeatSessionId = s.id;
    } else {
      if (src && src.type === 'deck') {
        if (src.deckId) args.deckId = src.deckId;
        else if (src.deckName) args.deck = src.deckName;
      } else if (src && src.type === 'custom') {
        if (src.deckId) args.deckId = src.deckId;
        else if (src.deckName) args.deck = src.deckName;
        if (src.tags && src.tags.length) args.tags = src.tags;
        if (src.cardIds && src.cardIds.length) args.cardIds = src.cardIds;
      } else if (s.deckId) {
        args.deckId = s.deckId;
      }
    }
    if (s.cardType) args.cardType = s.cardType;
    if (s.name) args.name = s.name;
    callTool(data.startTool, args).then(applyToolResult);
  });
  // Render the bootstrap state first, then let the host's published tool
  // output (Apps SDK toolOutput) replace it when present.
  render();
  primeFromSession();
  hydrateFromToolOutput();
})();
</script>
</body>
</html>`;
}

/**
 * Registers the review-session widget as a `ui://` resource. Returns the
 * registered resource name. Pure registration: no tool schemas are changed.
 */
export function registerReviewWidget(server: McpServer, _bridge: FirebaseBridge): string {
  server.registerResource(
    'review-session-widget',
    REVIEW_WIDGET_URI,
    {
      title: 'FSRS Review Session',
      description: 'Anki-style review widget for the current spaced-repetition session: flip the card, rate it, and continue or finish.',
      mimeType: REVIEW_WIDGET_MIME,
      _meta: { ui: { prefersBorder: true } },
      annotations: { audience: ['user'] as const, priority: 1 },
    },
    async () => ({
      contents: [{
        uri: REVIEW_WIDGET_URI,
        mimeType: REVIEW_WIDGET_MIME,
        // Official Apps SDK docs require the widget description on the
        // resources/read contents[0]._meta (not the resource registration).
        _meta: {
          ui: { prefersBorder: true },
          'openai/widgetDescription': 'FSRS review session widget: flip the card, type your answer, check it, and rate it (Again/Hard/Good/Easy).',
        },
        text: buildReviewWidgetHtml({
          session: {},
          card: null,
          submitTool: 'submit_review',
          startTool: 'start_review_session',
          endTool: 'end_review_session',
          getTool: 'get_review_session',
          flashcardTool: 'get_flashcard',
        }),
      }],
    }),
  );
  return 'review-session-widget';
}

export { buildReviewWidgetHtml as buildWidgetHtml };

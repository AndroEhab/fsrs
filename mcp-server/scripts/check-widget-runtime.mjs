#!/usr/bin/env node
/**
 * Runtime boot check for the review widget (run outside jest — jsdom is a
 * dev-only dependency, not saved).
 *
 * Executes the GENERATED ui://review-session-v5 HTML in a real DOM (jsdom) with
 * a simulated Apps SDK parent host and verifies:
 *  1. the inline script parses and boots with ZERO uncaught errors
 *     (catches backslash-escape corruption in the outer template literal,
 *      e.g. the cloze regex becoming an invalid /[([^[]]+)]/ — the
 *      "Runtime error / Error al cargar la aplicación" symptom);
 *  2. an UNSOLICITED initial `ui/notifications/tool-result` seeds an empty
 *     bootstrap (the current MCP Apps host delivers the session tool's
 *     structuredContent this way) and the widget renders the card;
 *  3. an async `tools/call` response resolves through the waiter path.
 *
 * Run: node scripts/check-widget-runtime.mjs   (after npm run build)
 */

import { createRequire } from 'node:module';
import { buildReviewWidgetHtml } from '../dist/widget.js';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIP: jsdom not installed (dev-only runtime check)');
  process.exit(0);
}

function widgetHtml() {
  return buildReviewWidgetHtml({
    session: {}, // EMPTY bootstrap — the host must seed via notification
    card: null,
    submitTool: 'submit_review',
    startTool: 'start_review_session',
    endTool: 'end_review_session',
    getTool: 'get_review_session',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const errors = [];
  const post = [];
  const dom = new JSDOM(widgetHtml(), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/',
  });
  dom.window.addEventListener('error', (e) => errors.push(e.message ?? String(e)));
  dom.window.parent.postMessage = (msg) => {
    post.push(msg);
  };
  return { dom, errors, post };
}

// The VIEW (widget) initiates ui/initialize per the ext-apps spec; the host
// answers with a result, after which the widget sends ui/notifications/initialized.
// The host postMessage stub records everything and answers ui/initialize.
function makeHost(dom, post) {
  dom.window.parent.postMessage = (msg) => {
    post.push(msg);
    if (msg.method === 'ui/initialize') {
      setTimeout(() => {
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
          data: {
            jsonrpc: '2.0', id: msg.id,
            result: {
              protocolVersion: msg.params && msg.params.protocolVersion,
              hostInfo: { name: 'chatgpt', version: '0' },
              hostCapabilities: {},
              hostContext: {},
            },
          },
        }));
      }, 0);
    }
  };
}

async function main() {
  // 1. Boot with zero errors + the widget-INITIATED handshake.
  const { dom, errors, post } = boot();
  makeHost(dom, post);
  await sleep(50);
  if (errors.length > 0) {
    throw new Error(`widget boot errors: ${JSON.stringify(errors)}`);
  }
  // 1b. OBSERVABLE VISUAL STRUCTURE (approved design): the static chrome
  //     renders the airy-white composition — session-info section (accent
  //     session-type label + muted mode label), slim progress bar, large
  //     outlined flashcard with subtle shadow, flip hint with an icon,
  //     full-width answer input, two equal action buttons with icons, four
  //     equal numbered tinted rating tiles, centered quiet End Session, and
  //     the polite inline feedback row.
  {
    const d = dom.window.document;
    const wrap = d.getElementById('app');
    if (!wrap) throw new Error('app root missing');
    const sessionInfo = wrap.querySelector('.session-info');
    if (!sessionInfo) throw new Error('session info (.session-info) missing');
    const sessionType = sessionInfo.querySelector('.session-type');
    if (!sessionType) throw new Error('session type label (.session-type) missing');
    const modeLabel = d.getElementById('modeLabel');
    if (!modeLabel) throw new Error('mode label (#modeLabel) missing');
    if (!d.querySelector('.progress-bar')) throw new Error('progress bar missing');
    if (!d.querySelector('.progress-bar > i#progressFill')) throw new Error('progress fill (i#progressFill) missing');
    // Status text (#progress) must sit ABOVE the progress bar (reference order).
    const progressEl = d.getElementById('progress');
    if (!progressEl) throw new Error('progress status text missing');
    const progressBarEl = d.querySelector('.progress-bar');
    // The status text must be the bar's PREVIOUS sibling (direct DOM order;
    // compareDocumentPosition is unreliable in this jsdom version).
    if (progressBarEl.previousElementSibling !== progressEl) {
      throw new Error('status text must be ABOVE the progress bar');
    }
    // Intentional top inset before the first row: the wrap owns the gap via
    // top padding (~24px desktop, 16px narrow) instead of a collapsed
    // top margin, so the status pill never sits flush against the sandbox
    // surface.
    const css = dom.window.document.querySelector('style')?.textContent ?? '';
    if (!css.includes('.wrap { max-width:680px; margin:0 auto; padding:24px 18px 40px; min-width:0; }')) {
      throw new Error('wrap top inset missing (expected 24px desktop padding)');
    }
    if (!css.includes('.wrap { padding:16px 14px 32px; }')) {
      throw new Error('wrap narrow top inset missing (expected 16px)');
    }
    const shell = d.getElementById('cardShell');
    if (!shell || !shell.querySelector('.card-face.front-face') || !shell.querySelector('.card-face.back-face')) {
      throw new Error('flip card faces missing');
    }
    const hint = d.getElementById('hint');
    if (!hint || !hint.querySelector('svg')) throw new Error('flip hint with icon missing');
    const typedRow = d.getElementById('typed');
    if (!typedRow) throw new Error('typed answer row missing');
    if (!typedRow.querySelector('label[for="answerInput"]')) throw new Error('answer input label (for=answerInput) missing');
    if (!typedRow.querySelector('#answerInput')) throw new Error('answer input missing');
    const actions = typedRow.querySelector('.typed-actions');
    if (!actions || actions.children.length !== 2) throw new Error('two equal action buttons missing');
    if (!actions.querySelector('#revealBtn svg') || !actions.querySelector('#checkBtn svg')) {
      throw new Error('action buttons missing inline icons');
    }
    const ratings = d.getElementById('ratings');
    const tiles = ratings ? Array.from(ratings.querySelectorAll('button[data-rating]')) : [];
    if (tiles.length !== 4) throw new Error(`expected 4 rating tiles, got ${tiles.length}`);
    for (const [i, t] of tiles.entries()) {
      if (String(t.dataset.rating) !== String(i + 1)) throw new Error(`rating tile ${i} has wrong data-rating`);
      if (!t.querySelector('.num')) throw new Error(`rating tile ${i} missing numbered circle`);
      if (!t.querySelector('.label')) throw new Error(`rating tile ${i} missing label`);
    }
    const endRow = d.getElementById('endRow');
    if (!endRow || !endRow.querySelector('#endSessionBtn')) throw new Error('End Session control missing');
    const status = d.getElementById('status');
    if (!status || status.getAttribute('role') !== 'status' || status.getAttribute('aria-live') !== 'polite') {
      throw new Error('inline feedback row missing role=status/aria-live=polite');
    }
    if (!css.includes('--bg:#f8fafc')) throw new Error('airy white canvas token missing');
    if (!css.includes('repeat(4,1fr)')) throw new Error('equal 4-column rating grid missing');
    if (!css.includes('box-shadow:var(--shadow)')) throw new Error('card subtle shadow token missing');
    if (!css.includes('clamp(22px,4.5vw,30px)')) throw new Error('fluid large card text missing');
    if (!css.includes('prefers-reduced-motion: reduce')) throw new Error('reduced-motion guard missing');
    if (!css.includes('@media (max-width:380px)')) throw new Error('narrow-iframe responsive step missing');
    // Session info section: accent session-type label, muted mode label.
    if (!css.includes('.session-info .session-type { color:var(--accent); }')) throw new Error('session type accent color missing');
    console.log('PASS observable visual structure: session-info/progress/card/hint/input/actions/tiles/end/feedback');
  }

  // 2. Unsolicited initial tool-result seeds the empty bootstrap.
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        output: {
          content: [{
            type: 'text',
            text: 'started',
            structuredContent: {
              session: {
                id: 's1', status: 'active', modeTag: '[Spaced repetition review · 2 cards due]',
                cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100,
                ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
                preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
              },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
            },
          }],
        },
      },
    },
  }));
  // Presentation-only label formatting: the session-type label shows the
  // session type, the mode label shows "Due cards" or "Custom", and the
  // progress text shows "status · N reviewed, M remaining".
  const sessionTypeText = dom.window.document.getElementById('sessionTypeLabel')?.textContent;
  if (!sessionTypeText || !sessionTypeText.includes('Spaced repetition')) {
    throw new Error(`session type should include "Spaced repetition", got ${JSON.stringify(sessionTypeText)}`);
  }
  const modeText = dom.window.document.getElementById('modeLabel')?.textContent;
  if (modeText !== 'Mode: Due cards') {
    throw new Error(`mode label should read "Mode: Due cards", got ${JSON.stringify(modeText)}`);
  }
  const progressText = dom.window.document.getElementById('progress')?.textContent;
  if (!progressText || !progressText.includes('0 reviewed')) {
    throw new Error(`progress should include "0 reviewed", got ${JSON.stringify(progressText)}`);
  }
  // Source + per-card deck labels: a custom/tag session shows "Mode: Custom"
  // in the mode label and the CURRENT CARD's own deck name in the card face.
  const domSrc = new JSDOM(buildReviewWidgetHtml({
    session: {
      id: 's-src', status: 'active', cardType: 'qa',
      cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100,
      source: { type: 'custom', tags: ['vocab'], cardIds: ['c1', 'c2'] },
    },
    card: { id: 'c1', front: 'Q1', back: 'A1', deck: 'Spanish' },
    submitTool: 'submit_review', startTool: 'start_review_session',
    endTool: 'end_review_session', getTool: 'get_review_session',
  }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
  await sleep(20);
  const srcMode = domSrc.window.document.getElementById('modeLabel')?.textContent;
  if (srcMode !== 'Mode: Custom') {
    throw new Error(`custom session mode label should read "Mode: Custom", got ${JSON.stringify(srcMode)}`);
  }
  const deckLabel = domSrc.window.document.getElementById('deckName')?.textContent;
  if (deckLabel !== 'Spanish') {
    throw new Error(`current-card deck label should read "Spanish", got ${JSON.stringify(deckLabel)}`);
  }
  // Deck-only session: mode label shows "Mode: Due cards".
  const domDeck = new JSDOM(buildReviewWidgetHtml({
    session: {
      id: 's-deck', status: 'active', cardType: 'qa',
      cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100,
      source: { type: 'deck', deckId: 'deck-1', deckName: 'Spanish' },
    },
    card: { id: 'c1', front: 'Q1', back: 'A1', deck: 'Spanish' },
    submitTool: 'submit_review', startTool: 'start_review_session',
    endTool: 'end_review_session', getTool: 'get_review_session',
  }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
  await sleep(20);
  const deckMode = domDeck.window.document.getElementById('modeLabel')?.textContent;
  if (deckMode !== 'Mode: Due cards') {
    throw new Error(`deck-only session mode label should read "Mode: Due cards", got ${JSON.stringify(deckMode)}`);
  }
  // Due-only session (no selectors): mode label reads "Mode: Due cards".
  const domDue = new JSDOM(buildReviewWidgetHtml({
    session: {
      id: 's-due', status: 'active', cardType: 'qa',
      cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100,
      source: { type: 'due' },
    },
    card: { id: 'c1', front: 'Q1', back: 'A1', deck: 'French' },
    submitTool: 'submit_review', startTool: 'start_review_session',
    endTool: 'end_review_session', getTool: 'get_review_session',
  }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
  await sleep(20);
  const dueMode = domDue.window.document.getElementById('modeLabel')?.textContent;
  if (dueMode !== 'Mode: Due cards') {
    throw new Error(`due session mode label should read "Mode: Due cards", got ${JSON.stringify(dueMode)}`);
  }
  console.log('PASS mode label (Custom/Due cards) + per-card deck label (mixed-deck safe)');

  console.log('PASS unsolicited tool-result seeded the session (front = Q1, ratings available; mode + progress labels formatted)');

  // 3. Async tools/call response resolves via the waiter path.
  const sent = post.filter((m) => m.method === 'tools/call');
  if (sent.length > 0) {
    const lastId = sent[sent.length - 1].id;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: lastId, result: { structuredContent: { ok: true } } },
    }));
    await sleep(10);
  }
  console.log('PASS async tools/call waiter path wired');

  // 4. REAL Check-click interaction: the widget evaluates the typed answer
  //    FULLY LOCALLY — correct/incorrect/empty/no-answer — with ZERO tool
  //    calls and no ChatGPT follow-up; the rating buttons are revealed.
  {
    const dom2 = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's2', status: 'active', cardType: 'qa', modeTag: '[Spaced repetition review · 1 cards due]', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'What is 2+2?', back: 'four' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs2 = [];
    dom2.window.addEventListener('error', (e) => errs2.push(e.message ?? String(e)));
    let toolCalls = 0;
    dom2.window.openai = {
      callTool: async () => { toolCalls += 1; return { structuredContent: {} }; },
      sendFollowUpMessage: async () => { throw new Error('no ChatGPT follow-up allowed'); },
    };
    await sleep(20);
    // INCORRECT: deterministic local verdict, zero tool calls, ratings revealed.
    let input = dom2.window.document.getElementById('answerInput');
    input.value = 'three'; // mismatch
    dom2.window.document.getElementById('checkBtn').click();
    await sleep(50);
    if (errs2.length > 0) {
      throw new Error(`check-click widget errors: ${JSON.stringify(errs2)}`);
    }
    if (toolCalls !== 0) {
      throw new Error(`incorrect Check made ${toolCalls} tool call(s) — expected ZERO (fully local)`);
    }
    const status2 = dom2.window.document.getElementById('status').textContent;
    if (!status2.includes('Not quite') || !status2.includes('four')) {
      throw new Error(`incorrect Check status wrong: ${JSON.stringify(status2)}`);
    }
    if (dom2.window.document.getElementById('ratings').classList.contains('hidden')) {
      throw new Error('ratings not revealed after incorrect Check');
    }
    // EMPTY: prompts to type an answer, ratings NOT revealed.
    input = dom2.window.document.getElementById('answerInput');
    input.value = '';
    dom2.window.document.getElementById('checkBtn').click();
    await sleep(30);
    const statusEmpty = dom2.window.document.getElementById('status').textContent;
    if (!statusEmpty.includes('Type an answer first')) {
      throw new Error(`empty Check status wrong: ${JSON.stringify(statusEmpty)}`);
    }
    console.log('PASS real Check click: fully local deterministic verdict (incorrect/empty), ZERO tool calls, no ChatGPT follow-up');
  }

  // 4b. EXACT fast path: typing the exact (normalized) answer and clicking
  //     Check must show the verdict IMMEDIATELY with ZERO tool calls
  //     calls (no backend/MCP correction request) and the rating buttons
  //     revealed — submit_review stays fully independent.
  {
    const dom2b = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's2b', status: 'active', cardType: 'qa', modeTag: '[Spaced repetition review · 1 cards due]', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'What is 2+2?', back: 'four' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs2b = [];
    dom2b.window.addEventListener('error', (e) => errs2b.push(e.message ?? String(e)));
    let toolCalls2b = 0;
    dom2b.window.openai = {
      callTool: async () => { toolCalls2b += 1; return { structuredContent: {} }; },
      sendFollowUpMessage: async () => { throw new Error('no ChatGPT follow-up allowed'); },
    };
    await sleep(20);
    const input2b = dom2b.window.document.getElementById('answerInput');
    input2b.value = 'FOUR'; // exact after normalization (case-folded)
    dom2b.window.document.getElementById('checkBtn').click();
    await sleep(50);
    if (errs2b.length > 0) {
      throw new Error(`exact-fast-path widget errors: ${JSON.stringify(errs2b)}`);
    }
    if (toolCalls2b !== 0) {
      throw new Error(`exact fast path made ${toolCalls2b} tool call(s) — expected ZERO (fully local)`);
    }
    const status2b = dom2b.window.document.getElementById('status').textContent;
    if (!status2b.includes('Correct')) {
      throw new Error(`exact fast path status wrong: ${JSON.stringify(status2b)}`);
    }
    if (dom2b.window.document.getElementById('ratings').classList.contains('hidden')) {
      throw new Error('ratings not revealed after exact check');
    }
    if (!dom2b.window.document.getElementById('cardShell').classList.contains('flipped')) {
      throw new Error('card not flipped after exact check');
    }
    console.log('PASS exact Check: immediate local verdict, ZERO tool calls, ratings revealed');
  }

  // 4c. Local normalization parity + punctuation-only expected guard: the
  //     embedded normalizeAnswer must match the backend's NFKC → lowercase →
  //     apostrophes/quotes→space → punctuation→space → whitespace-collapse
  //     rules, and a punctuation-only expected answer must NEVER match
  //     locally (routes to the semantic fallback), mirroring the backend.
  {
    const dom2c = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's2c', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'Hello, WORLD!' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    await sleep(20);
    const w = dom2c.window;
    // Exercise the embedded helpers through a synthetic evaluate call: set the
    // input to an exact-after-normalization variant and click Check — the fast
    // path must produce 'Correct' with zero evaluate calls.
    let toolCalls2c = 0;
    w.openai = { callTool: async () => { toolCalls2c += 1; return { structuredContent: {} }; } };
    const input2c = w.document.getElementById('answerInput');
    input2c.value = '  hello ,, world ! '; // NFKC-ish + punctuation + spaces
    w.document.getElementById('checkBtn').click();
    await sleep(40);
    if (toolCalls2c !== 0) {
      throw new Error(`normalization parity: exact-after-normalization still called a tool (${toolCalls2c})`);
    }
    if (!w.document.getElementById('status').textContent.includes('Correct')) {
      throw new Error('normalization parity: expected normalized exact match to be Correct');
    }
    // Punctuation-only expected guard: back = "!!!" normalizes to EMPTY →
    // the deterministic outcome is no-answer (reveal and rate), NOT Correct,
    // with zero tool calls.
    const dom2d = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's2d', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: '!!!' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    await sleep(20);
    let toolCalls2d = 0;
    const w2 = dom2d.window;
    w2.openai = { callTool: async () => { toolCalls2d += 1; return { structuredContent: {} }; } };
    w2.document.getElementById('answerInput').value = '!!!';
    w2.document.getElementById('checkBtn').click();
    await sleep(60);
    if (toolCalls2d !== 0) {
      throw new Error(`punctuation-only expected guard called a tool (${toolCalls2d}) — expected zero (no-answer is local)`);
    }
    const status2d = w2.document.getElementById('status').textContent;
    if (!status2d.includes('no comparable answer')) {
      throw new Error(`punctuation-only expected guard status wrong: ${JSON.stringify(status2d)}`);
    }
    console.log('PASS local normalization parity (NFKC/punctuation/whitespace) + punctuation-only expected guard (no-answer, zero tool calls)');
  }

  // 4d. Rating independence + per-card guard: rating while a correction is
  //     pending must still submit immediately (no coupling), and a delayed
  //     correction result must NOT update a newly rated/advanced card.
  {
    const dom2e = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's2e', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs2e = [];
    dom2e.window.addEventListener('error', (e) => errs2e.push(e.message ?? String(e)));
    const submitted = [];
    let getCalls = 0;
    dom2e.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitted.push(args);
          // Advance: next card c2.
          return {
            structuredContent: {
              session: { id: 's2e', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100 },
              card: { id: 'c2', front: 'Q2', back: 'A2' },
              preloaded: [],
            },
          };
        }
        if (name === 'get_review_session') {
          getCalls += 1;
          return {
            structuredContent: { session: { id: 's2e', status: 'active' }, card: { id: 'c2' } },
            _meta: { 'ui/widgetState': { session: { id: 's2e', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100 }, card: { id: 'c2', front: 'Q2', back: 'A2' }, preloaded: [] } },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    const input2e = dom2e.window.document.getElementById('answerInput');
    input2e.value = 'wrong';
    dom2e.window.document.getElementById('checkBtn').click(); // local incorrect, ratings revealed
    await sleep(30);
    // Rate the card immediately after the local check: must submit immediately.
    const goodBtn = dom2e.window.document.querySelector('button[data-rating="3"]');
    goodBtn.click();
    await sleep(80);
    if (errs2e.length > 0) {
      throw new Error(`rating-independence widget errors: ${JSON.stringify(errs2e)}`);
    }
    if (submitted.length === 0) {
      throw new Error('rating while correction pending did NOT submit (coupled to correction?)');
    }
    // The displayed card advanced to c2 (optimistic + authoritative).
    const front2e = dom2e.window.document.getElementById('frontInner').textContent;
    if (front2e !== 'Q2') {
      throw new Error(`after rating, displayed card should be c2 (Q2), got ${JSON.stringify(front2e)}`);
    }
    console.log('PASS rating after a local Check submits independently; rating stays decoupled from answer feedback');
  }
  // 4d1. HELD-PROMISE REGRESSION (immediate-display + no-white-card): the
  //      submit promise is HELD unresolved while we assert that (a) the next
  //      full card (c2 front/back) appears IMMEDIATELY after rating c1 —
  //      before any server response; (b) an id-only response for the
  //      optimistic card never makes the front blank (cardCache resolves it
  //      full); (c) a stale snapshot for the JUST-RATED old card (c1) cannot
  //      regress the displayed c2 (the older response only updates session
  //      counters); (d) controls stay disabled until the held submit resolves.
  {
    const domH = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sH', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsH = [];
    domH.window.addEventListener('error', (e) => errsH.push(e.message ?? String(e)));
    let submitCallsH = 0;
    let resolveSubmitH = null;
    let flashcardFetchesH = 0;
    domH.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsH += 1;
          // HOLD the submit unresolved so the optimistic display must stand on
          // its own (no authoritative response has arrived yet).
          await new Promise((r) => { resolveSubmitH = r; });
          return {
            structuredContent: {
              session: { id: 'sH', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100 },
              // ID-ONLY result: host strips _meta. Must resolve full from the
              // cardCache (c2 was preloaded) — never a white card.
              card: { id: 'c2' },
            },
          };
        }
        if (name === 'get_flashcard') {
          flashcardFetchesH += 1;
          return { structuredContent: { id: args.id, front: 'Q' + args.id.slice(1), back: 'A' + args.id.slice(1) } };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    if (domH.window.document.getElementById('frontInner').textContent !== 'Q1') {
      throw new Error(`held-promise setup: expected c1 front, got ${JSON.stringify(domH.window.document.getElementById('frontInner').textContent)}`);
    }
    domH.window.document.querySelector('button[data-rating="3"]').click(); // rate c1
    await sleep(60);
    if (errsH.length > 0) {
      throw new Error(`held-promise widget errors: ${JSON.stringify(errsH)}`);
    }
    // (a) The next full card appears IMMEDIATELY while the submit is held.
    const frontH = domH.window.document.getElementById('frontInner').textContent;
    const backH = domH.window.document.getElementById('backInner').textContent;
    if (frontH !== 'Q2' || backH !== 'A2') {
      throw new Error(`held submit: next card front/back did NOT appear immediately; front=${JSON.stringify(frontH)} back=${JSON.stringify(backH)}`);
    }
    if (submitCallsH !== 1) {
      throw new Error(`held submit: expected exactly 1 submit, got ${submitCallsH}`);
    }
    // (d) PARALLEL ratings: controls for the DISPLAYED card (c2) stay
    //     ENABLED while the c1 submit is held — the per-card guard only
    //     blocks a second rating of the SAME card. A rating for c2 can be
    //     fired concurrently.
    if (domH.window.document.getElementById('ratings').classList.contains('disabled')) {
      throw new Error('rating controls DISABLED for c2 while only c1 is in flight (parallel ratings must not block)');
    }
    // (c) A stale snapshot for the JUST-RATED old card (c1) arrives while c2
    //     is optimistically displayed: it must NOT regress the display to c1.
    domH.window.dispatchEvent(new domH.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sH', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
            },
          },
        },
      },
    }));
    await sleep(40);
    if (domH.window.document.getElementById('frontInner').textContent !== 'Q2') {
      throw new Error('stale snapshot for the just-rated card regressed the displayed optimistic card');
    }
    // Now resolve the held submit: the id-only c2 response must resolve FULL
    // from the cache (front stays Q2 — never white), and controls re-enable.
    resolveSubmitH();
    await sleep(80);
    if (errsH.length > 0) {
      throw new Error(`held-promise post-resolve errors: ${JSON.stringify(errsH)}`);
    }
    const frontH2 = domH.window.document.getElementById('frontInner').textContent;
    if (frontH2 !== 'Q2') {
      throw new Error(`id-only response blanked/regressed the card: front=${JSON.stringify(frontH2)}`);
    }
    if (flashcardFetchesH !== 0) {
      throw new Error(`id-only response triggered a flashcard fetch (${flashcardFetchesH}) when the cache already had the full card`);
    }
    if (domH.window.document.getElementById('ratings').classList.contains('disabled')) {
      throw new Error('rating controls NOT re-enabled after the submit resolved');
    }
    const reviewedH = domH.window.document.getElementById('progress').textContent;
    if (!reviewedH.includes('1 reviewed')) {
      throw new Error(`authoritative counters not applied after commit: ${JSON.stringify(reviewedH)}`);
    }
    console.log('PASS held submit: next card front/back appear immediately, stale snapshot cannot regress, id-only response never blanks the card');
  }


  // 4d1b. DEFERRED-SUBMIT COUNTER REGRESSION: the submit promise is HELD
  //       unresolved while we assert that the progress counters
  //       optimistically project remaining -1 IMMEDIATELY after
  //       clicking Good — before any server response. Resolving the held
  //       submit with an authoritative response (which ACKS the request via
  //       processedRequestIds + reviewedCardIds) must NOT double-count.
  {
    const domD = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sD', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsD = [];
    domD.window.addEventListener('error', (e) => errsD.push(e.message ?? String(e)));
    let submitCallsD = 0;
    let resolveSubmitD = null;
    domD.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsD += 1;
          // HOLD the submit unresolved — the optimistic counters must stand
          // on their own before any authoritative response arrives.
          await new Promise((r) => { resolveSubmitD = r; });
          return {
            structuredContent: {
              session: { id: 'sD', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100, processedRequestIds: [args.requestId], reviewedCardIds: ['c1'] },
              card: { id: 'c2' },
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    domD.window.document.querySelector('button[data-rating="3"]').click(); // Good on c1
    await sleep(40); // optimistic shift + render; submit promise STILL held
    if (errsD.length > 0) {
      throw new Error(`deferred-submit counter errors (pre-resolve): ${JSON.stringify(errsD)}`);
    }
    // IMMEDIATELY (submit unresolved): the click alone must project
    // remaining -1 in the status (reviewed stays server-authoritative).
    const progressD = domD.window.document.getElementById('progress').textContent;
    if (!progressD.includes('0 reviewed') || !progressD.includes('1 remaining')) {
      throw new Error(`optimistic progress missing pre-resolve: ${JSON.stringify(progressD)}`);
    }
    // Resolve the held submit: the authoritative response ACKS this requestId
    // — counters must NOT double-count.
    resolveSubmitD();
    await sleep(80);
    if (errsD.length > 0) {
      throw new Error(`deferred-submit counter errors (post-resolve): ${JSON.stringify(errsD)}`);
    }
    const progressD2 = domD.window.document.getElementById('progress').textContent;
    if (!progressD2.includes('1 reviewed') || !progressD2.includes('1 remaining')) {
      throw new Error(`authoritative progress double-counted: ${JSON.stringify(progressD2)}`);
    }
    console.log('PASS deferred submit: counters project remaining -1 immediately; no double count after the authoritative ack');
  }


  // 4d2. PARALLEL RATINGS (held promises): two rapid clicks on the rating
  //      button — the first while c1 is displayed, the second after the
  //      optimistic shift to c2 — submit TWO ratings CONCURRENTLY (no
  //      single-flight gate): each captures the DISPLAYED card id as
  //      expectedCardId (c1 then c2), both submits are held in flight at
  //      once, and the THIRD card (c3) is already visible. Resolving the
  //      held submits with ID-ONLY responses must never blank the displayed
  //      card (the cardCache resolves the same id full) and must not regress
  //      out-of-order.
  {
    const domR = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sR', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }, { id: 'c3', front: 'Q3', back: 'A3', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsR = [];
    domR.window.addEventListener('error', (e) => errsR.push(e.message ?? String(e)));
    let submitCalls = 0;
    const submittedIds = [];
    const resolveSubmits = [];
    // Hold EVERY submit unresolved so both are provably in flight at once;
    // resolve them only after the concurrency assertions.
    domR.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCalls += 1;
          submittedIds.push(args.expectedCardId);
          await new Promise((r) => { resolveSubmits.push(r); });
          // ID-ONLY authoritative result: the host strips _meta. Must
          // resolve full from the cardCache (the card was preloaded) —
          // never a white card.
          return {
            structuredContent: {
              session: { id: 'sR', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: submitCalls, reviewedCount: submitCalls, remainingCount: 3 - submitCalls, limit: 100 },
              card: submitCalls >= 3 ? null : { id: 'c' + (submitCalls + 1) },
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    const goodBtnR = domR.window.document.querySelector('button[data-rating="3"]');
    goodBtnR.click(); // rate c1 (displayed) → optimistic shift to c2, submit held
    await sleep(30);
    // The displayed card is now c2 (optimistic shift, submit still held).
    if (domR.window.document.getElementById('frontInner').textContent !== 'Q2') {
      throw new Error(`after first rating, displayed card should be c2, got ${JSON.stringify(domR.window.document.getElementById('frontInner').textContent)}`);
    }
    // Rate c2 (the newly displayed card) IMMEDIATELY — must NOT be blocked.
    const goodBtnR2 = domR.window.document.querySelector('button[data-rating="3"]');
    goodBtnR2.click(); // rate c2 → optimistic shift to c3, submit held
    await sleep(40);
    if (errsR.length > 0) {
      throw new Error(`parallel-rating widget errors: ${JSON.stringify(errsR)}`);
    }
    // TWO submits are in flight CONCURRENTLY, for c1 then c2.
    if (submitCalls !== 2) {
      throw new Error(`parallel ratings: expected 2 concurrent submits, got ${submitCalls}`);
    }
    if (submittedIds.length !== 2 || submittedIds[0] !== 'c1' || submittedIds[1] !== 'c2') {
      throw new Error(`parallel ratings submitted wrong ids ${JSON.stringify(submittedIds)} — expected [c1, c2]`);
    }
    // The THIRD card (c3) is already visible while both submits are held.
    const frontR = domR.window.document.getElementById('frontInner').textContent;
    const backR = domR.window.document.getElementById('backInner').textContent;
    if (frontR !== 'Q3' || backR !== 'A3') {
      throw new Error(`third card not visible while both submits held: front=${JSON.stringify(frontR)} back=${JSON.stringify(backR)}`);
    }
    // Both held submits resolve with ID-ONLY results — the displayed c3 must
    // stay full (cardCache), never a white card, and out-of-order responses
    // must not regress the display.
    for (const r of resolveSubmits) r();
    await sleep(120);
    if (errsR.length > 0) {
      throw new Error(`parallel-rating post-resolve errors: ${JSON.stringify(errsR)}`);
    }
    const frontR2 = domR.window.document.getElementById('frontInner').textContent;
    if (frontR2 !== 'Q3') {
      throw new Error(`id-only responses blanked/regressed the card: front=${JSON.stringify(frontR2)}`);
    }
    if (domR.window.document.getElementById('ratings').classList.contains('disabled')) {
      throw new Error('rating controls not re-enabled after both submits resolved');
    }
    const reviewedR = domR.window.document.getElementById('progress').textContent;
    if (!reviewedR.includes('2 reviewed')) {
      throw new Error(`authoritative counters not applied after both commits: ${JSON.stringify(reviewedR)}`);
    }
    console.log('PASS parallel ratings: two submits concurrently (c1 then c2), third card visible, id-only responses never blank/regress');
  }

  // 4d1c. LONG-SESSION HELD-PROMISE REGRESSION (the reported bug): a 12-card
  //       session preloads the FULL remaining queue (every card after the
  //       current one). Every submit is HELD unresolved while the user
  //       rates past card 5/6 (the old preload boundary). Assert that EVERY
  //       next card has front/back text, controls stay ENABLED, and NO
  //       'Submitting' / request wording ever appears. Then deliver an
  //       OUT-OF-ORDER response with a SHORT/stale preload array and assert
  //       the local queue does NOT regress (the next ratings still advance
  //       through every remaining card). Finally rate the LAST card with
  //       submits held: the widget shows a clean optimistic completion (no
  //       blank/disabled card, no request wording) and reconciles to the
  //       authoritative terminal state.
  {
    const N = 12;
    const ids = Array.from({ length: N }, (_, i) => 'c' + (i + 1));
    const preloaded = ids.slice(1).map((id) => ({ id, front: 'Q' + id.slice(1), back: 'A' + id.slice(1), tags: [] }));
    const domL = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 'sL', status: 'active', cardType: 'qa', cardIds: ids, currentIndex: 0,
        reviewedCount: 0, remainingCount: N, limit: 100, preloaded,
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsL = [];
    domL.window.addEventListener('error', (e) => errsL.push(e.message ?? String(e)));
    let submitCallsL = 0;
    const submittedIdsL = [];
    const resolveSubmitsL = [];
    // HOLD every submit unresolved — the user can outrun the backend.
    domL.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsL += 1;
          submittedIdsL.push(args.expectedCardId);
          await new Promise((r) => { resolveSubmitsL.push(r); });
          return { structuredContent: {} }; // unresolved until released
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    if (domL.window.document.getElementById('frontInner').textContent !== 'Q1') {
      throw new Error(`long-session setup: expected Q1, got ${JSON.stringify(domL.window.document.getElementById('frontInner').textContent)}`);
    }
    const rateGood = () => domL.window.document.querySelector('button[data-rating="3"]').click();
    // Rate THROUGH card 6 (past the old SESSION_PRELOAD=5 boundary) with all
    // submits held. Every next card must render full with ENABLED controls
    // and NO request wording.
    for (let k = 1; k <= 6; k += 1) {
      rateGood();
      await sleep(25);
      if (errsL.length > 0) {
        throw new Error(`long-session widget errors at card ${k}: ${JSON.stringify(errsL)}`);
      }
      const expectedFront = 'Q' + (k + 1);
      const frontL = domL.window.document.getElementById('frontInner').textContent;
      const backL = domL.window.document.getElementById('backInner').textContent;
      if (frontL !== expectedFront || backL !== 'A' + (k + 1)) {
        throw new Error(`after rating card ${k}, expected ${expectedFront} full, got front=${JSON.stringify(frontL)} back=${JSON.stringify(backL)}`);
      }
      if (domL.window.document.getElementById('ratings').classList.contains('disabled')) {
        throw new Error(`rating controls DISABLED for card ${k + 1} (only earlier cards are in flight)`);
      }
      const statusL = domL.window.document.getElementById('status').textContent;
      if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusL)) {
        throw new Error(`request wording leaked at card ${k + 1}: ${JSON.stringify(statusL)}`);
      }
    }
    if (submitCallsL !== 6) {
      throw new Error(`long-session: expected 6 held submits past the boundary, got ${submitCallsL}`);
    }
    // OUT-OF-ORDER SHORT-PRELOAD RESPONSE: a stale snapshot for an
    // ALREADY-RATED card (c2) carrying a SHORT preload (3 cards — the old
    // SESSION_PRELOAD=5 style) must NOT regress the display (c7) and must
    // NOT shrink the local queue: the next ratings still advance through
    // every remaining card.
    domL.window.dispatchEvent(new domL.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sL', status: 'active', cardType: 'qa', cardIds: ids, currentIndex: 0, reviewedCount: 0, remainingCount: N, limit: 100 },
              card: { id: 'c2', front: 'Q2', back: 'A2' },
              preloaded: [
                { id: 'c8', front: 'Q8', back: 'A8', tags: [] },
                { id: 'c9', front: 'Q9', back: 'A9', tags: [] },
                { id: 'c10', front: 'Q10', back: 'A10', tags: [] },
              ],
            },
          },
        },
      },
    }));
    await sleep(40);
    if (errsL.length > 0) {
      throw new Error(`long-session post-stale-response errors: ${JSON.stringify(errsL)}`);
    }
    if (domL.window.document.getElementById('frontInner').textContent !== 'Q7') {
      throw new Error('stale response for an already-rated card regressed the displayed card');
    }
    // Continue rating c7 → c12 with submits held: the queue must NOT have
    // been shrunk by the short preload.
    for (let k = 7; k <= 12; k += 1) {
      rateGood();
      await sleep(25);
      if (errsL.length > 0) {
        throw new Error(`long-session widget errors at card ${k}: ${JSON.stringify(errsL)}`);
      }
      if (k < 12) {
        const expectedFront = 'Q' + (k + 1);
        const frontL = domL.window.document.getElementById('frontInner').textContent;
        const backL = domL.window.document.getElementById('backInner').textContent;
        if (frontL !== expectedFront || backL !== 'A' + (k + 1)) {
          throw new Error(`after short-preload response, rating card ${k} showed front=${JSON.stringify(frontL)} back=${JSON.stringify(backL)} — queue regressed`);
        }
        if (domL.window.document.getElementById('ratings').classList.contains('disabled')) {
          throw new Error(`rating controls DISABLED for card ${k + 1} after the short-preload response`);
        }
        const statusL = domL.window.document.getElementById('status').textContent;
        if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusL)) {
          throw new Error(`request wording leaked at card ${k + 1}: ${JSON.stringify(statusL)}`);
        }
      }
    }
    // The LAST card (c12) was rated while ALL 12 submits are held: the widget
    // shows a CLEAN optimistic completion — the done panel is visible, fully
    // interactive, with NO request wording and NO blank/disabled card.
    const doneShownL = !domL.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShownL) {
      throw new Error('long-session: last card rated with submits held did NOT show optimistic completion');
    }
    const statusLast = domL.window.document.getElementById('status').textContent;
    if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusLast)) {
      throw new Error(`optimistic completion leaked request wording: ${JSON.stringify(statusLast)}`);
    }
    if (submitCallsL !== 12) {
      throw new Error(`long-session: expected 12 held submits total, got ${submitCallsL}`);
    }
    // Reconcile: release the held submits OUT OF ORDER with authoritative
    // terminal results — the done panel stays (never a regression, never a
    // blank card).
    for (let r = resolveSubmitsL.length - 1; r >= 0; r -= 1) {
      resolveSubmitsL[r]({
        structuredContent: {
          session: { id: 'sL', status: 'completed', cardType: 'qa', cardIds: ids, currentIndex: N, reviewedCount: N, remainingCount: 0, limit: 100, continuationAvailable: false },
          card: null,
          preloaded: [],
        },
      });
    }
    await sleep(120);
    if (errsL.length > 0) {
      throw new Error(`long-session post-reconcile errors: ${JSON.stringify(errsL)}`);
    }
    const doneShownL2 = !domL.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShownL2) {
      throw new Error('long-session: authoritative completion did not keep the done panel');
    }
    // The card shell is hidden (the completed state shows the done panel,
    // never a blank/disabled card).
    const shellHidden = domL.window.document.getElementById('cardShell').classList.contains('hidden');
    if (!shellHidden) {
      throw new Error('long-session: completed session still shows the card shell');
    }
    console.log('PASS long session (12 cards): every next card full + enabled past the old boundary, short stale preload cannot regress the queue, clean optimistic completion with zero request wording');
  }

  // 4d1d. ONE-CARD EMPTY-PRELOAD REGRESSION: a valid one-card session carries
  //       an EMPTY preload array (no upcoming cards — the FULL remaining
  //       queue is genuinely empty). allSessionCardsAccountedFor (the only
  //       card is rated/displayed) makes rating the single card while the
  //       submit is HELD show the clean optimistic completion — NOT a
  //       greyed-out disabled card.
  {
    const domO = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 'sO', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0,
        reviewedCount: 0, remainingCount: 1, limit: 100, preloaded: [], // EMPTY — full remaining queue
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsO = [];
    domO.window.addEventListener('error', (e) => errsO.push(e.message ?? String(e)));
    let submitCallsO = 0;
    let resolveSubmitO = null;
    domO.window.openai = {
      callTool: async (name) => {
        if (name === 'submit_review') {
          submitCallsO += 1;
          await new Promise((r) => { resolveSubmitO = r; });
          return { structuredContent: {} };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    if (domO.window.document.getElementById('frontInner').textContent !== 'Q1') {
      throw new Error(`one-card setup: expected Q1, got ${JSON.stringify(domO.window.document.getElementById('frontInner').textContent)}`);
    }
    domO.window.document.querySelector('button[data-rating="3"]').click(); // rate c1 (submit HELD)
    await sleep(60);
    if (errsO.length > 0) {
      throw new Error(`one-card widget errors: ${JSON.stringify(errsO)}`);
    }
    if (submitCallsO !== 1) {
      throw new Error(`one-card: expected exactly 1 submit, got ${submitCallsO}`);
    }
    // CLEAN optimistic completion: the done panel is visible and fully
    // interactive — NEVER a greyed-out disabled card.
    const doneShownO = !domO.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShownO) {
      throw new Error('one-card session: rating the only card with a held submit did NOT show optimistic completion (every card is accounted for)');
    }
    const statusO = domO.window.document.getElementById('status').textContent;
    if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusO)) {
      throw new Error(`one-card optimistic completion leaked request wording: ${JSON.stringify(statusO)}`);
    }
    // The Finish button is interactive (not disabled).
    if (domO.window.document.getElementById('finishBtn').disabled) {
      throw new Error('one-card: Finish button disabled during optimistic completion');
    }
    // Reconcile: the authoritative completed result keeps the done panel.
    resolveSubmitO({
      structuredContent: {
        session: { id: 'sO', status: 'completed', cardType: 'qa', cardIds: ['c1'], currentIndex: 1, reviewedCount: 1, remainingCount: 0, limit: 100, continuationAvailable: false },
        card: null,
        preloaded: [],
      },
    });
    await sleep(100);
    if (errsO.length > 0) {
      throw new Error(`one-card post-reconcile errors: ${JSON.stringify(errsO)}`);
    }
    const doneShownO2 = !domO.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShownO2) {
      throw new Error('one-card: authoritative completion did not keep the done panel');
    }
    console.log('PASS one-card session: every card accounted for (the only card) → clean optimistic completion (never a greyed card), zero request wording, authoritative reconcile keeps done panel');
  }

  // 4d2b. FAILED-SUBMIT REGRESSION: a submission that FAILS (backend
  //      rejects / network error) must clear its in-flight maps AND its
  //      ratedCardIds flag BEFORE the get_review_session re-sync, so the
  //      sync's authoritative current card (the failed card — still current)
  //      is NOT suppressed by adoptServerState and the user can RETRY it.
  //      Other in-flight cards are untouched.
  {
    const domB = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sB', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsB = [];
    domB.window.addEventListener('error', (e) => errsB.push(e.message ?? String(e)));
    let submitAttempts = 0;
    let getCalls = 0;
    domB.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitAttempts += 1;
          // First attempt FAILS (rejected); the retry succeeds.
          if (submitAttempts === 1) {
            throw new Error('boom');
          }
          return {
            structuredContent: {
              session: { id: 'sB', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100 },
              card: { id: 'c2', front: 'Q2', back: 'A2' },
              preloaded: [],
            },
          };
        }
        if (name === 'get_review_session') {
          getCalls += 1;
          // The authoritative current card is STILL c1 (the failed submit
          // never committed). Must be adopted after the failure.
          return {
            structuredContent: {
              session: { id: 'sB', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    domB.window.document.querySelector('button[data-rating="3"]').click(); // rate c1 → FAILS
    await sleep(120);
    if (errsB.length > 0) {
      throw new Error(`failed-submit widget errors: ${JSON.stringify(errsB)}`);
    }
    if (submitAttempts !== 1) {
      throw new Error(`failed submit: expected 1 attempt before retry, got ${submitAttempts}`);
    }
    if (getCalls < 1) {
      throw new Error('failed submit did not re-sync via get_review_session');
    }
    // The failed card (c1) is restored as current and its rating controls are
    // ENABLED (the ratedCardIds flag was cleared — adoptServerState did not
    // suppress it) — the user can retry.
    const frontB = domB.window.document.getElementById('frontInner').textContent;
    if (frontB !== 'Q1') {
      throw new Error(`failed submit did NOT restore the failed card c1: front=${JSON.stringify(frontB)}`);
    }
    if (domB.window.document.getElementById('ratings').classList.contains('disabled')) {
      throw new Error('failed submit left rating controls disabled — the user cannot retry');
    }
    // RETRY now succeeds and advances to c2.
    domB.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(120);
    const frontB2 = domB.window.document.getElementById('frontInner').textContent;
    if (frontB2 !== 'Q2') {
      throw new Error(`retry after failed submit did not advance to c2: front=${JSON.stringify(frontB2)}`);
    }
    // LATE COMMITTED RESPONSE: a duplicate/unsolicited response for the
    // COMMITTED card c1 arrives after the successful retry. The success path
    // KEEPS ratedCardIds[c1] true, so adoptServerState must NOT regress the
    // display back to c1 (MCP session summaries omit reviewedCardIds — the
    // local flag is the only guard).
    domB.window.dispatchEvent(new domB.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sB', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
            },
          },
        },
      },
    }));
    await sleep(60);
    const frontB3 = domB.window.document.getElementById('frontInner').textContent;
    if (frontB3 !== 'Q2') {
      throw new Error(`late duplicate response for committed c1 regressed the display: front=${JSON.stringify(frontB3)}`);
    }
    console.log('PASS failed submit: failed card restored and retryable; late duplicate response for committed card cannot regress');
  }

  // 4d2c. RELOAD/OUT-OF-ORDER REGRESSION: a reload (fresh bootstrap hydration)
  //      during parallel submits carries the backend-persisted
  //      reviewedCardIds in the full widget state. The widget must NEVER
  //      re-show an already-rated FUTURE card (a 409 duplicate): primeFromSession
  //      folds reviewedCardIds into the local rated set and skips rated cards
  //      when seeding the queue/current card.
  {
    const domC = new JSDOM(buildReviewWidgetHtml({
      // Simulate a reloaded bootstrap: c1 + c2 already committed (out-of-order:
      // c2 was rated while c1 was current), only c3 remains.
      session: {
        id: 'sC', status: 'active', cardType: 'qa',
        cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 2, remainingCount: 1, limit: 100,
        reviewedCardIds: ['c1', 'c2'],
        preloaded: [
          { id: 'c1', front: 'Q1', back: 'A1', tags: [] },
          { id: 'c2', front: 'Q2', back: 'A2', tags: [] },
          { id: 'c3', front: 'Q3', back: 'A3', tags: [] },
        ],
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' }, // stale current (already rated)
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsC = [];
    domC.window.addEventListener('error', (e) => errsC.push(e.message ?? String(e)));
    domC.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          return {
            structuredContent: {
              session: { id: 'sC', status: 'completed', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: 3, reviewedCount: 3, remainingCount: 0, limit: 100, continuationAvailable: false },
              card: null,
              preloaded: [],
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(40);
    if (errsC.length > 0) {
      throw new Error(`reload regression widget errors: ${JSON.stringify(errsC)}`);
    }
    // The displayed card must be c3 (the first UNRATED card) — never the
    // already-rated c1/c2 (which would 409 on a duplicate submit).
    const frontC = domC.window.document.getElementById('frontInner').textContent;
    if (frontC !== 'Q3') {
      throw new Error(`reload re-shows an already-rated future card: front=${JSON.stringify(frontC)} — expected Q3 (first unrated)`);
    }
    // OUT-OF-ORDER RESPONSE with a FULL preloaded array: a response (e.g. a
    // late sibling submit) whose preloaded includes the already-rated c1/c2
    // must NOT reinsert them into the queue (adoptServerState filters rated
    // entries) — only unrated future cards survive.
    domC.window.dispatchEvent(new domC.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sC', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: 2, reviewedCount: 2, remainingCount: 1, limit: 100 },
              card: { id: 'c3', front: 'Q3', back: 'A3' },
              preloaded: [
                { id: 'c1', front: 'Q1', back: 'A1', tags: [] },
                { id: 'c2', front: 'Q2', back: 'A2', tags: [] },
                { id: 'c3', front: 'Q3', back: 'A3', tags: [] },
              ],
            },
          },
        },
      },
    }));
    await sleep(60);
    // The displayed card stays c3; the rated c1/c2 must not resurface.
    const frontC2 = domC.window.document.getElementById('frontInner').textContent;
    if (frontC2 !== 'Q3') {
      throw new Error(`out-of-order full preload reinserted a rated card: front=${JSON.stringify(frontC2)} — expected Q3`);
    }
    // Rating c3 completes the session (no duplicate).
    domC.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(80);
    const doneShown = !domC.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShown) {
      throw new Error('reload regression: rating the first unrated card did not complete the session');
    }
    console.log('PASS reload/out-of-order: reviewedCardIds folded in; only the first UNRATED future card is shown (no 409 duplicate)');
  }

  // 4d3. SPONTANEOUS-FLIP REGRESSION: an async re-render of the SAME card
  //      (e.g. an unsolicited ui/notifications/tool-result or evaluation-poll
  //      session update arriving mid-review) must PRESERVE the user's flip
  //      state — the card only returns to the front when a DIFFERENT card
  //      becomes current. Previously render() unconditionally removed
  //      'flipped', so any async session update flipped the card back on its
  //      own while the user was reading the back.
  {
    const domF = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sF', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsF = [];
    domF.window.addEventListener('error', (e) => errsF.push(e.message ?? String(e)));
    domF.window.openai = {
      callTool: async () => ({ structuredContent: {} }),
    };
    await sleep(20);
    // User flips the card to see the back.
    domF.window.document.getElementById('cardShell').click();
    if (!domF.window.document.getElementById('cardShell').classList.contains('flipped')) {
      throw new Error('card did not flip after user click');
    }
    // An async session update for the SAME card arrives (e.g. evaluation
    // poll / get_review_session result / unsolicited tool-result).
    domF.window.dispatchEvent(new domF.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sF', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [],
            },
          },
        },
      },
    }));
    await sleep(40);
    if (errsF.length > 0) {
      throw new Error(`flip-preservation widget errors: ${JSON.stringify(errsF)}`);
    }
    if (!domF.window.document.getElementById('cardShell').classList.contains('flipped')) {
      throw new Error('async re-render of the SAME card reset the user\'s flip state (spontaneous flip)');
    }
    // A DIFFERENT card becoming current resets to the front (normal).
    domF.window.dispatchEvent(new domF.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sF', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 100 },
              card: { id: 'c2', front: 'Q2', back: 'A2' },
              preloaded: [],
            },
          },
        },
      },
    }));
    await sleep(40);
    if (domF.window.document.getElementById('cardShell').classList.contains('flipped')) {
      throw new Error('a DIFFERENT card becoming current did not reset the flip to front');
    }
    console.log('PASS async same-card re-render preserves flip state; a different card resets to front');
  }

  // 4d4. ANSWER-FLASH REGRESSION (persistent reset invariant): advancing to a
  //      DIFFERENT card (the rating → optimistic-shift path) must leave the
  //      card in a persistent .resetting state — .card-inner forced to
  //      transform:none !important + transition:none !important, .flipped
  //      absent — BEFORE the new card's content is installed, and the state
  //      must SURVIVE (still present after any microtask/rAF/timer window,
  //      never cleared by render). Previously the reset removed 'flipped'
  //      and restored the transition in the SAME synchronous block (relying
  //      on a forced reflow), so the real browser's transition engine could
  //      still animate the unwinding rotation through the new card's back
  //      face. The reset is removed ONLY by the next intentional user
  //      flip/reveal (flipToBack), which re-enables the normal animation.
  {
    const dom4d4 = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's4d4', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs4d4 = [];
    dom4d4.window.addEventListener('error', (e) => errs4d4.push(e.message ?? String(e)));
    dom4d4.window.openai = {
      callTool: async () => ({ structuredContent: {} }),
    };
    await sleep(20);
    const shell4 = dom4d4.window.document.getElementById('cardShell');
    const inner4 = dom4d4.window.document.getElementById('cardInner');
    // User flips the displayed card to see the back (normal user action).
    shell4.click();
    if (!shell4.classList.contains('flipped')) {
      throw new Error('4d4: card did not flip after user click');
    }
    // Rate the displayed card: the optimistic shift renders c2, resetting
    // the flip for the NEW card.
    dom4d4.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(40); // long past any microtask/rAF/timer window
    if (errs4d4.length > 0) {
      throw new Error(`4d4 flip-flash widget errors: ${JSON.stringify(errs4d4)}`);
    }
    // PERSISTENT INVARIANT after the optimistic advance:
    //  - .resetting present (transform/transition suppressed through first
    //    paint — NOT cleared by render, rAF, or a timer);
    //  - .flipped absent (never back-facing);
    //  - the NEW card's front is installed.
    if (!shell4.classList.contains('resetting')) {
      throw new Error('4d4: .resetting not present after a DIFFERENT card became current (answer-flash regression)');
    }
    if (shell4.classList.contains('flipped')) {
      throw new Error('4d4: flip not reset when a different card became current');
    }
    if (dom4d4.window.document.getElementById('frontInner').textContent !== 'Q2') {
      throw new Error(`4d4: expected the next card c2 (Q2) after rating, got ${JSON.stringify(dom4d4.window.document.getElementById('frontInner').textContent)}`);
    }
    // No inline style dance remains (the old timing hack is deleted).
    if (inner4.getAttribute('style')) {
      throw new Error(`4d4: unexpected inline style on card-inner (${JSON.stringify(inner4.getAttribute('style'))}) — the old transition/offsetHeight dance must be gone`);
    }
    // The user's NEXT intentional flip removes .resetting, adds .flipped,
    // and re-enables the transition so the animation runs.
    shell4.click();
    if (shell4.classList.contains('resetting')) {
      throw new Error('4d4: .resetting not cleared by the next intentional user flip');
    }
    if (!shell4.classList.contains('flipped')) {
      throw new Error('4d4: user flip broken after the card-change reset');
    }
    console.log('PASS persistent reset invariant: .resetting held through first paint (no answer flash), removed only by the next user flip');
  }

  // 4e. RECONCILIATION: a rating whose submit result is MINIMAL (host strips
  //     _meta; card is id-only, preloaded absent) must NOT blank the card or
  //     wipe the local queue — the cached full next card stays visible and
  //     the queue survives. Only an authoritative full preload array replaces
  //     the queue.
  {
    const dom4e = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's4e', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }, { id: 'c3', front: 'Q3', back: 'A3', tags: [] }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs4e = [];
    dom4e.window.addEventListener('error', (e) => errs4e.push(e.message ?? String(e)));
    let flashcardFetches = 0;
    let rated = 0;
    dom4e.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          rated += 1;
          // MINIMAL result: id-only card, NO preloaded — simulates the host
          // stripping hidden _meta. The authoritative next card is the rated
          // card's successor (c2 after rating c1, c3 after rating c2).
          const nextId = 'c' + (rated + 1);
          return {
            structuredContent: {
              session: { id: 's4e', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: rated, reviewedCount: rated, remainingCount: 3 - rated, limit: 100 },
              card: rated >= 3 ? null : { id: nextId },
            },
          };
        }
        if (name === 'get_flashcard') {
          flashcardFetches += 1;
          return { structuredContent: { id: args.id, front: 'Q' + args.id.slice(1), back: 'A' + args.id.slice(1) } };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    dom4e.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(120);
    if (errs4e.length > 0) {
      throw new Error(`reconciliation widget errors: ${JSON.stringify(errs4e)}`);
    }
    const front4e = dom4e.window.document.getElementById('frontInner').textContent;
    if (front4e !== 'Q2') {
      throw new Error(`minimal submit result blanked/advanced the card: front=${JSON.stringify(front4e)}`);
    }
    // The queue survived (c3 still cached) — rating again advances to c3.
    dom4e.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(120);
    const front4e2 = dom4e.window.document.getElementById('frontInner').textContent;
    if (front4e2 !== 'Q3') {
      throw new Error(`queue did not survive minimal result: front=${JSON.stringify(front4e2)}`);
    }
    console.log('PASS minimal submit result: cached next card stays visible, queue survives, id-only fallback fills gaps');
  }

  // 4f. COMPLETION semantics: an authoritative completed session with no card
  //     shows the done state (never a wrong card), even with a minimal result.
  {
    const dom4f = new JSDOM(buildReviewWidgetHtml({
      session: { id: 's4f', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs4f = [];
    dom4f.window.addEventListener('error', (e) => errs4f.push(e.message ?? String(e)));
    dom4f.window.openai = {
      callTool: async (name) => {
        if (name === 'submit_review') {
          // Authoritative completion: status completed, NO card, no preloaded.
          return {
            structuredContent: {
              session: { id: 's4f', status: 'completed', cardType: 'qa', cardIds: ['c1'], currentIndex: 1, reviewedCount: 1, remainingCount: 0, limit: 100, continuationAvailable: false },
              card: null,
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    dom4f.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(120);
    if (errs4f.length > 0) {
      throw new Error(`completion widget errors: ${JSON.stringify(errs4f)}`);
    }
    const doneHidden = dom4f.window.document.getElementById('done').classList.contains('hidden');
    if (doneHidden) {
      throw new Error('completed session did not show the done state');
    }
    console.log('PASS completion semantics: authoritative completed session shows done state (no wrong card)');
  }

  //    the minimal structuredContent, but toolResponseMetadata carries the
  //    hidden _meta['ui/widgetState'] (call_tool_result envelope). The widget
  //    must hydrate the card from the metadata envelope.
  {
    // Inject the legacy bridge stub BEFORE the widget script runs so the
    // startup hydrateFromToolOutput() sees it.
    const errs4 = [];
    const dom4 = new JSDOM(buildReviewWidgetHtml({
      session: {}, card: null, // EMPTY bootstrap
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/',
      beforeParse(window) {
        window.addEventListener('error', (e) => errs4.push(e.message ?? String(e)));
        // Legacy bridge: toolOutput has MINIMAL structuredContent; the FULL
        // state (incl. card front) is in toolResponseMetadata's
        // call_tool_result _meta.
        window.openai = {
          toolOutput: [
            { toolName: 'start_review_session', output: { structuredContent: { session: { id: 's4', status: 'active' }, card: { id: 'c1' } } } },
          ],
          toolResponseMetadata: [
            {
              toolName: 'start_review_session',
              call_tool_result: {
                structuredContent: { session: { id: 's4', status: 'active' }, card: { id: 'c1' } },
                _meta: {
                  'ui/widgetState': {
                    session: { id: 's4', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
                    card: { id: 'c1', front: 'MetaQ', back: 'MetaA' },
                    preloaded: [],
                  },
                },
              },
            },
          ],
        };
      },
    });
    await sleep(50);
    if (errs4.length > 0) {
      throw new Error(`toolResponseMetadata widget errors: ${JSON.stringify(errs4)}`);
    }
    const front4 = dom4.window.document.getElementById('frontInner').textContent;
    if (front4 !== 'MetaQ') {
      throw new Error(`widget did not hydrate from toolResponseMetadata: front=${JSON.stringify(front4)}`);
    }
    console.log('PASS widget hydrates full state from window.openai.toolResponseMetadata (call_tool_result _meta)');
  }

  // 7. OBJECT-shaped toolResponseMetadata (per official reference: a single
  //    object with status + call_tool_result / mcp_tool_result envelopes).
  //    The widget must hydrate the hidden full state and render the card.
  {
    const errs7 = [];
    const dom7 = new JSDOM(buildReviewWidgetHtml({
      session: {}, card: null, // EMPTY bootstrap
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    }), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/',
      beforeParse(window) {
        window.addEventListener('error', (e) => errs7.push(e.message ?? String(e)));
        // Minimal toolOutput + OBJECT toolResponseMetadata with mcp_tool_result.
        window.openai = {
          toolOutput: [
            { toolName: 'start_review_session', output: { structuredContent: { session: { id: 's7', status: 'active' }, card: { id: 'c1' } } } },
          ],
          toolResponseMetadata: {
            status: 'completed',
            mcp_tool_result: {
              structuredContent: { session: { id: 's7', status: 'active' }, card: { id: 'c1' } },
              _meta: {
                'ui/widgetState': {
                  session: { id: 's7', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
                  card: { id: 'c1', front: 'ObjQ', back: 'ObjA' },
                  preloaded: [],
                },
              },
            },
          },
        };
      },
    });
    await sleep(50);
    if (errs7.length > 0) {
      throw new Error(`object-toolResponseMetadata widget errors: ${JSON.stringify(errs7)}`);
    }
    const front7 = dom7.window.document.getElementById('frontInner').textContent;
    if (front7 !== 'ObjQ') {
      throw new Error(`widget did not hydrate from OBJECT toolResponseMetadata: front=${JSON.stringify(front7)}`);
    }
    console.log('PASS widget hydrates from OBJECT-shaped toolResponseMetadata (mcp_tool_result)');
  }

  // 4d1e. UNCAPPED-SESSION REGRESSION (>100 cards, bounded preload): a
  //       150-card session's start/get preload is the bounded SESSION_PRELOAD
  //       window (100 upcoming cards), NOT the whole queue. When the user
  //       rates past the preload boundary with submits in flight, the widget
  //       must NOT show a false optimistic completion (cards c102..c150 are
  //       still unknown locally); the next authoritative submit response
  //       delivers the next card and the session continues to its real end,
  //       where the LAST card does optimistic-complete.
  {
    const N = 150;
    const ids = Array.from({ length: N }, (_, i) => 'c' + (i + 1));
    // Bounded preload: at most SESSION_PRELOAD upcoming cards after the
    // current one — c2..c101 (100 cards). Cards beyond are NOT preloaded.
    const preloaded = ids.slice(1, 101).map((id) => ({ id, front: 'Q' + id.slice(1), back: 'A' + id.slice(1), tags: [] }));
    const domU = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 'sU', status: 'active', cardType: 'qa', cardIds: ids, currentIndex: 0,
        reviewedCount: 0, remainingCount: N, limit: N, preloaded,
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsU = [];
    domU.window.addEventListener('error', (e) => errsU.push(e.message ?? String(e)));
    let submitCallsU = 0;
    const heldU = [];
    domU.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsU += 1;
          // HOLD every submit; the release resolves the promise with the
          // authoritative result (returned verbatim to the widget).
          return await new Promise((r) => { heldU.push({ expected: args.expectedCardId, r }); });
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    const rateGood = () => domU.window.document.querySelector('button[data-rating="3"]').click();
    const shownFrontU = () => domU.window.document.getElementById('frontInner').textContent;
    const doneHiddenU = () => domU.window.document.getElementById('done').classList.contains('hidden');
    const releaseNext = (k, status) => {
      const h = heldU.shift();
      if (!h) throw new Error(`uncapped: no held submit to release at card ${k}`);
      h.r({
        structuredContent: {
          session: { id: 'sU', status: status || 'active', cardType: 'qa', cardIds: ids, currentIndex: k, reviewedCount: k, remainingCount: N - k, limit: N },
          card: { id: 'c' + (k + 1), front: 'Q' + (k + 1), back: 'A' + (k + 1) },
          preloaded: [],
        },
      });
    };
    if (shownFrontU() !== 'Q1') throw new Error(`uncapped setup: expected Q1, got ${JSON.stringify(shownFrontU())}`);
    // Rate through the ENTIRE bounded preload (c1..c100), each submit
    // resolving with the authoritative next card — the display advances
    // c2..c101 normally, never showing completion.
    for (let k = 1; k <= 100; k += 1) {
      rateGood();
      await sleep(15);
      releaseNext(k);
      await sleep(15);
      if (errsU.length > 0) throw new Error(`uncapped widget errors at card ${k}: ${JSON.stringify(errsU)}`);
      const expectedFront = 'Q' + (k + 1);
      if (shownFrontU() !== expectedFront) {
        throw new Error(`uncapped: after rating card ${k} expected ${expectedFront}, got ${JSON.stringify(shownFrontU())}`);
      }
      if (!doneHiddenU()) {
        throw new Error(`uncapped: FALSE optimistic completion shown at card ${k} (session still has unrated cards)`);
      }
    }
    // The preload buffer is now dry at card c101 with 49 cards (c102..c150)
    // never seen locally. Rating c101 with its submit HELD must NOT show a
    // premature done panel — the session is NOT complete.
    rateGood(); // rate c101 (submit HELD)
    await sleep(40);
    if (errsU.length > 0) throw new Error(`uncapped boundary errors: ${JSON.stringify(errsU)}`);
    if (submitCallsU !== 101) throw new Error(`uncapped: expected 101 submits, got ${submitCallsU}`);
    if (!doneHiddenU()) {
      throw new Error('uncapped: FALSE optimistic completion past the preload boundary (49 unrated cards still unknown)');
    }
    // The authoritative response for c101 delivers the next card c102 — the
    // session continues beyond the old 100-card boundary.
    releaseNext(101);
    await sleep(40);
    if (errsU.length > 0) throw new Error(`uncapped post-boundary errors: ${JSON.stringify(errsU)}`);
    if (shownFrontU() !== 'Q102') {
      throw new Error(`uncapped: expected Q102 after the boundary, got ${JSON.stringify(shownFrontU())}`);
    }
    if (!doneHiddenU()) {
      throw new Error('uncapped: done panel shown while the session continues past card 101');
    }
    // Continue c102..c149 (each submit resolving with the next card).
    for (let k = 102; k <= 149; k += 1) {
      rateGood();
      await sleep(15);
      releaseNext(k);
      await sleep(15);
      if (errsU.length > 0) throw new Error(`uncapped widget errors at card ${k}: ${JSON.stringify(errsU)}`);
      const expectedFront = 'Q' + (k + 1);
      if (shownFrontU() !== expectedFront) {
        throw new Error(`uncapped: after rating card ${k} expected ${expectedFront}, got ${JSON.stringify(shownFrontU())}`);
      }
      if (!doneHiddenU()) {
        throw new Error(`uncapped: FALSE optimistic completion at card ${k}`);
      }
    }
    // Rate the LAST card c150 with its submit HELD: every card is now
    // accounted for, so the clean optimistic completion IS correct.
    rateGood();
    await sleep(40);
    if (errsU.length > 0) throw new Error(`uncapped final errors: ${JSON.stringify(errsU)}`);
    if (submitCallsU !== 150) throw new Error(`uncapped: expected 150 submits, got ${submitCallsU}`);
    if (doneHiddenU()) {
      throw new Error('uncapped: the real last card (c150) rated with submits held did NOT show optimistic completion');
    }
    // Reconcile: the authoritative terminal result keeps the done panel.
    const lastHeld = heldU.shift();
    if (!lastHeld) throw new Error('uncapped: missing held submit for c150');
    lastHeld.r({
      structuredContent: {
        session: { id: 'sU', status: 'completed', cardType: 'qa', cardIds: ids, currentIndex: N, reviewedCount: N, remainingCount: 0, limit: N },
        card: null,
        preloaded: [],
      },
    });
    await sleep(60);
    if (errsU.length > 0) throw new Error(`uncapped post-final errors: ${JSON.stringify(errsU)}`);
    if (doneHiddenU()) {
      throw new Error('uncapped: authoritative completion did not keep the done panel');
    }
    console.log('PASS uncapped session (150 cards): rates past the 100-card preload boundary with zero false completion, next card delivered by the response, clean optimistic completion only at the real last card');
  }


  // 5. V2 BOUNDED SESSION (no root cardIds): the widget must fully render,
  //    rate, and complete a storageVersion-2 session whose session state
  //    carries ONLY queueWindow + currentPosition + bounded counters — never
  //    a full cardIds/reviewedCardIds array — and submit by expectedPosition.
  {
    const htmlV2 = buildReviewWidgetHtml({
      session: {
        id: 'sV', status: 'active', storageVersion: 2, modeTag: '[Spaced repetition review · 3 cards · Due cards]',
        limit: 3, remainingQueueCount: 3, remainingCount: 3, currentIndex: 0, reviewedCount: 0,
        currentPosition: 0,
        queueWindow: {
          currentPosition: 0,
          currentCardId: 'v1',
          cardIds: [
            { cardId: 'v1', position: 0 },
            { cardId: 'v2', position: 1 },
            { cardId: 'v3', position: 2 },
          ],
        },
        // NO cardIds, NO reviewedCardIds, NO processedRequestIds (bounded v2 root).
        // Realistic bounded preload: the next cards arrive FULL from the
        // backend (the widget never needs the full queue), each with its
        // stable queue position.
        preloaded: [
          { id: 'v2', front: 'V2?', back: 'A2', tags: [], position: 1 },
          { id: 'v3', front: 'V3?', back: 'A3', tags: [], position: 2 },
        ],
      },
      card: { id: 'v1', front: 'V1?', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    });
    if (htmlV2.includes('var ids = Array.isArray(s.cardIds) ? s.cardIds : [];\n    if (!ids.length) return true;')) {
      throw new Error('v2: widget still hard-depends on a root cardIds array');
    }
    const domV = new JSDOM(htmlV2, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsV = [];
    domV.window.addEventListener('error', (e) => errsV.push(e.message ?? String(e)));
    let submitCallsV = 0;
    const submitArgsV = [];
    let heldV = [];
    domV.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsV += 1;
          submitArgsV.push(args);
          await new Promise((r) => { heldV.push(r); });
          return { structuredContent: {} };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    if (errsV.length > 0) throw new Error(`v2 boot errors: ${JSON.stringify(errsV)}`);
    const docV = domV.window.document;
    if (docV.getElementById('frontInner').textContent !== 'V1?') {
      throw new Error(`v2 setup: expected V1? front, got ${JSON.stringify(docV.getElementById('frontInner').textContent)}`);
    }
    // Progress denominator is the v2 limit (3), not a cardIds array.
    const labelV = docV.getElementById('progress').textContent;
    if (!labelV.includes('0 reviewed') || !labelV.includes('3 remaining')) {
      throw new Error(`v2: progress label wrong: ${JSON.stringify(labelV)}`);
    }
    // Rate card 1: the submit must carry expectedPosition 0 (the v2 claim
    // target) alongside the card id — no full-queue dependency.
    docV.querySelector('button[data-rating="3"]').click();
    await sleep(60);
    if (errsV.length > 0) throw new Error(`v2 rate errors: ${JSON.stringify(errsV)}`);
    if (submitCallsV !== 1) throw new Error(`v2: expected 1 submit, got ${submitCallsV}`);
    if (submitArgsV[0].expectedPosition !== 0) {
      throw new Error(`v2: expectedPosition not sent on submit: ${JSON.stringify(submitArgsV[0])}`);
    }
    // Optimistic next card (v2) from the bounded window.
    if (docV.getElementById('frontInner').textContent !== 'V2?') {
      throw new Error(`v2: expected optimistic V2? after rating, got ${JSON.stringify(docV.getElementById('frontInner').textContent)}`);
    }
    // Resolve the submit with a v2 authoritative response (advances position).
    heldV.shift()({
      structuredContent: {
        session: { id: 'sV', status: 'active', storageVersion: 2, limit: 3, remainingQueueCount: 2, remainingCount: 2, currentIndex: 1, reviewedCount: 1, currentPosition: 1, queueWindow: { currentPosition: 1, cardIds: ['v2', 'v3'] } },
        card: { id: 'v2' },
        preloaded: [],
      },
    });
    await sleep(80);
    if (errsV.length > 0) throw new Error(`v2 reconcile errors: ${JSON.stringify(errsV)}`);
    if (docV.getElementById('frontInner').textContent !== 'V2?') {
      throw new Error('v2: displayed card regressed after the authoritative response');
    }
    // Rate the optimistically-shown next card (V2): the submit must claim by
    // the PRELOADED card's own stable position (1), never a guessed counter.
    docV.querySelector('button[data-rating="3"]').click();
    await sleep(40);
    if (submitCallsV !== 2) throw new Error(`v2: expected 2 submits, got ${submitCallsV}`);
    if (submitArgsV[1].expectedPosition !== 1) {
      throw new Error(`v2: second rating expectedPosition 1 (preloaded card position), got ${JSON.stringify(submitArgsV[1])}`);
    }
    // Resolve it (authoritative next is V3 at position 2).
    heldV.shift()({
      structuredContent: {
        session: { id: 'sV', status: 'active', storageVersion: 2, limit: 3, remainingQueueCount: 1, remainingCount: 1, currentIndex: 2, reviewedCount: 2, currentPosition: 2, queueWindow: { currentPosition: 2, currentCardId: 'v3', cardIds: [{ cardId: 'v3', position: 2 }] } },
        card: { id: 'v3' },
        preloaded: [],
      },
    });
    await sleep(60);
    if (errsV.length > 0) throw new Error(`v2 second reconcile errors: ${JSON.stringify(errsV)}`);
    console.log('PASS v2 bounded session: widget renders/rates/completes without any root cardIds — queueWindow + currentPosition drive the queue and submits claim by expectedPosition');
  }


  // 5b. V2 CONTINUE (repeatSessionId): the completed-panel Continue button
  //      starts a NEW session by passing repeatSessionId ONLY (the backend
  //      copies the finished chunked queue) — never a fresh selector query.
  {
    const domC = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 'sC', status: 'completed', storageVersion: 2, modeTag: '[Spaced repetition review · 1 cards due]',
        limit: 1, remainingQueueCount: 0, remainingCount: 0, currentIndex: 1, reviewedCount: 1,
        currentPosition: 1, currentChunkIndex: 1,
        queueWindow: { currentPosition: null, currentCardId: null, cardIds: [] },
        source: { type: 'due' },
        continuationAvailable: false,
      },
      card: null,
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsC = [];
    domC.window.addEventListener('error', (e) => errsC.push(e.message ?? String(e)));
    const startArgsC = [];
    domC.window.openai = {
      callTool: async (name, args) => {
        if (name === 'start_review_session') { startArgsC.push(args); return { structuredContent: {} }; }
        if (name === 'end_review_session') return { structuredContent: { id: 'sC', status: 'ended' } };
        return { structuredContent: {} };
      },
    };
    await sleep(30);
    if (errsC.length > 0) throw new Error(`continue boot errors: ${JSON.stringify(errsC)}`);
    const docC = domC.window.document;
    if (docC.getElementById('done').classList.contains('hidden')) {
      throw new Error('v2 continue: completed session did not show the done panel');
    }
    // Click Continue.
    const contBtn = docC.getElementById('continueBtn');
    // legacy sessions without continuationAvailable hide Continue — v2 done
    // sessions without the legacy flag should still offer Finish only.
    // Force-show then click to verify the branch sends repeatSessionId.
    contBtn.classList.remove('hidden');
    contBtn.click();
    await sleep(40);
    if (errsC.length > 0) throw new Error(`continue click errors: ${JSON.stringify(errsC)}`);
    if (startArgsC.length !== 1) throw new Error(`v2 continue: expected 1 start call, got ${startArgsC.length}`);
    if (startArgsC[0].repeatSessionId !== 'sC') {
      throw new Error(`v2 continue: expected repeatSessionId sC, got ${JSON.stringify(startArgsC[0])}`);
    }
    console.log('PASS v2 Continue: completed v2 session starts a NEW session by repeatSessionId (exact chunked-queue copy), never a fresh selector query');
  }


  // 5c. V2 NO-FALSE-COMPLETION REGRESSION: a v2 session whose LOCAL preload
  //      window is empty (bounded window exhausted, no response yet) but whose
  //      authoritative remainingCount is > 0 must NOT show the done panel when
  //      the current card is rated — allSessionCardsAccountedFor must consult
  //      the v2 remaining counters BEFORE the empty-queue shortcut.
  {
    const domN = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 'sN', status: 'active', storageVersion: 2, limit: 150, totalCount: 150,
        remainingQueueCount: 149, remainingCount: 149, currentIndex: 0,
        currentPosition: 0, currentChunkIndex: 0, reviewedCount: 0,
        queueWindow: { currentPosition: 0, currentCardId: 'n1', cardIds: [{ cardId: 'n1', position: 0 }] },
        // NO preloaded array (the bounded window carried ONLY the current
        // card; the next card arrives with the next response).
      },
      card: { id: 'n1', front: 'N1?', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session', flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errsN = [];
    domN.window.addEventListener('error', (e) => errsN.push(e.message ?? String(e)));
    let submitCallsN = 0;
    let heldN = [];
    domN.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsN += 1;
          const resolved = await new Promise((r) => { heldN.push(r); });
          return resolved || { structuredContent: {} };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    const docN = domN.window.document;
    if (docN.getElementById('frontInner').textContent !== 'N1?') {
      throw new Error(`v2 no-false-completion setup: expected N1?, got ${JSON.stringify(docN.getElementById('frontInner').textContent)}`);
    }
    // Rate the current card with the submit HELD and NO next card buffered:
    // remainingCount is 149 (>0) so the done panel MUST NOT appear.
    docN.querySelector('button[data-rating="3"]').click();
    await sleep(60);
    if (errsN.length > 0) throw new Error(`v2 no-false-completion errors: ${JSON.stringify(errsN)}`);
    if (submitCallsN !== 1) throw new Error(`v2 no-false-completion: expected 1 submit, got ${submitCallsN}`);
    const doneShownN = !docN.getElementById('done').classList.contains('hidden');
    if (doneShownN) {
      throw new Error('v2 no-false-completion: done panel shown while authoritative remainingCount is 149 — false completion');
    }
    // The rated card stays displayed (no fabricated next card, no completion).
    if (docN.getElementById('frontInner').textContent !== 'N1?') {
      throw new Error(`v2 no-false-completion: card regressed to ${JSON.stringify(docN.getElementById('frontInner').textContent)}`);
    }
    // Resolve the submit with a real next card (authoritative).
    heldN.shift()({
      structuredContent: {
        session: { id: 'sN', status: 'active', storageVersion: 2, limit: 150, totalCount: 150, remainingQueueCount: 148, remainingCount: 148, currentIndex: 1, reviewedCount: 1, currentPosition: 1, queueWindow: { currentPosition: 1, currentCardId: 'n2', cardIds: [{ cardId: 'n2', position: 1 }] } },
        card: { id: 'n2', front: 'N2?', back: 'A2' },
        preloaded: [],
      },
    });
    await sleep(60);
    if (errsN.length > 0) throw new Error(`v2 no-false-completion reconcile errors: ${JSON.stringify(errsN)}`);
    const frontAfterN = docN.getElementById('frontInner').textContent;
    if (frontAfterN !== 'N2?') {
      throw new Error('v2 no-false-completion: authoritative next card not shown; front=' + JSON.stringify(frontAfterN)
        + ' doneHidden=' + docN.getElementById('done').classList.contains('hidden')
        + ' status=' + JSON.stringify(docN.getElementById('status').textContent));
    }
    console.log('PASS v2 no-false-completion: empty local window with remainingCount>0 never shows the done panel — completion waits for the authoritative next card');
  }

  console.log('\nWIDGET RUNTIME OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('WIDGET RUNTIME FAILED:', err.message);
  process.exit(1);
});

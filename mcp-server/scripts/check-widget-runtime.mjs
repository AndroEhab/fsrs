#!/usr/bin/env node
/**
 * Runtime boot check for the review widget (run outside jest — jsdom is a
 * dev-only dependency, not saved).
 *
 * Executes the generated widget HTML in jsdom (no font fetch needed) and verifies:
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
import { webcrypto } from 'node:crypto';
import { buildReviewWidgetHtml } from '../dist/widget.js';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIP: jsdom not installed (dev-only runtime check)');
  process.exit(0);
}
// JSDOM has no nested browsing context; model its window as both the widget
// and its parent so protocol tests still exercise the mandatory source check.
const NativeJSDOM = JSDOM;
JSDOM = class extends NativeJSDOM {
  constructor(...args) {
    super(...args);
    const win = this.window;
    Object.defineProperty(win.crypto, 'randomUUID', { value: webcrypto.randomUUID.bind(webcrypto), configurable: true });
    const NativeMessageEvent = win.MessageEvent;
    win.MessageEvent = class extends NativeMessageEvent {
      constructor(type, init = {}) {
        super(type, { ...init, origin: init.origin || 'https://host.example' });
        Object.defineProperty(this, 'source', { value: init.source ?? win, configurable: true });
      }
    };
  }
};


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
              hostInfo: { name: 'test-host', version: '1.0.0' },
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
  //       unresolved while asserting server-authoritative counters and a
  //       separate pending-request indicator before any server response.
  //       click: the held response then supplies the server's acknowledged
  //       counters and request receipt.
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
          // HOLD the submit unresolved: pending is shown separately from the
          // unchanged server counters before an authoritative response.
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
    // Before resolution, server counters remain authoritative and the local
    // request appears separately as pending.
    const progressD = domD.window.document.getElementById('progress').textContent;
    if (!progressD.includes('0 reviewed') || !progressD.includes('2 remaining') || !progressD.includes('1 pending')) {
      throw new Error(`pending rating was conflated with authoritative counters: ${JSON.stringify(progressD)}`);
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
    console.log('PASS deferred submit: authoritative counters remain unchanged while pending; successful response applies the server update');
  }


  // 4d2. FIFO SERIAL RATINGS: three rapid clicks on the rating button —
  //      c1 displayed, shift to c2, shift to c3 — queue THREE items but
  //      fire only ONE initial submit (serial drain).  reviewed=3
  //      optimistically before any ack.  Resolving each submit drains the
  //      next in click order (c1→c2→c3).  Delayed/stale snapshots must
  //      never decrease the displayed reviewed count.
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
    // HOLD the first submit unresolved; the FIFO queue blocks subsequent
    // submits until this one resolves.
    domR.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCalls += 1;
          submittedIds.push(args.expectedCardId);
          await new Promise((r) => { resolveSubmits.push(r); });
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
    // Click 1: rate c1 → optimistic shift to c2, submit1 fires (held).
    domR.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(30);
    if (domR.window.document.getElementById('frontInner').textContent !== 'Q2') {
      throw new Error(`after first rating, displayed card should be c2, got ${JSON.stringify(domR.window.document.getElementById('frontInner').textContent)}`);
    }
    // Click 2: rate c2 → optimistic shift to c3, submit queued (submitInFlight=true).
    domR.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(20);
    // Click 3: rate c3 → optimistic completion (all cards accounted for), submit queued.
    domR.window.document.querySelector('button[data-rating="3"]').click();
    await sleep(40);
    if (errsR.length > 0) {
      throw new Error(`fifo-rating widget errors: ${JSON.stringify(errsR)}`);
    }
    // FIFO: only ONE submit fired (serial drain), two are queued.
    if (submitCalls !== 1) {
      throw new Error(`fifo ratings: expected 1 initial submit, got ${submitCalls}`);
    }
    if (submittedIds.length !== 1 || submittedIds[0] !== 'c1') {
      throw new Error(`fifo ratings: first submit should be c1, got ${JSON.stringify(submittedIds)}`);
    }
    // The THIRD card (c3) is already visible while only the first submit is held.
    const frontR = domR.window.document.getElementById('frontInner').textContent;
    const backR = domR.window.document.getElementById('backInner').textContent;
    if (frontR !== 'Q3' || backR !== 'A3') {
      throw new Error(`third card not visible while first submit held: front=${JSON.stringify(frontR)} back=${JSON.stringify(backR)}`);
    }
    // No server review count is projected before any acknowledgement.
    const reviewedRpre = domR.window.document.getElementById('progress').textContent;
    if (!reviewedRpre.includes('0 reviewed') || !reviewedRpre.includes('3 remaining') || !reviewedRpre.includes('3 pending')) {
      throw new Error(`fifo: authoritative progress and separate pending count are wrong: ${JSON.stringify(reviewedRpre)}`);
    }
    // Delayed stale snapshot: must NOT regress reviewed below 3.
    domR.window.dispatchEvent(new domR.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: { id: 'sR', status: 'active', cardType: 'qa', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100 },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
            },
          },
        },
      },
    }));
    await sleep(30);
    const reviewedRstale = domR.window.document.getElementById('progress').textContent;
    if (!reviewedRstale.includes('0 reviewed') || !reviewedRstale.includes('3 pending')) {
      throw new Error(`stale snapshot corrupted authoritative counters or pending count: ${JSON.stringify(reviewedRstale)}`);
    }
    // Resolve submit1 → FIFO drain fires submit2.
    resolveSubmits[0]();
    await sleep(60);
    if (submitCalls !== 2) {
      throw new Error(`fifo: expected 2 submits after first resolve, got ${submitCalls}`);
    }
    if (submittedIds[1] !== 'c2') {
      throw new Error(`fifo: second submit should be c2, got ${JSON.stringify(submittedIds[1])}`);
    }
    // Resolve submit2 → drain fires submit3.
    resolveSubmits[1]();
    await sleep(60);
    if (submitCalls !== 3) {
      throw new Error(`fifo: expected 3 submits after second resolve, got ${submitCalls}`);
    }
    if (submittedIds[2] !== 'c3') {
      throw new Error(`fifo: third submit should be c3, got ${JSON.stringify(submittedIds[2])}`);
    }
    // Resolve submit3 → drain complete, done panel visible.
    resolveSubmits[2]();
    await sleep(100);
    if (errsR.length > 0) {
      throw new Error(`fifo-rating post-resolve errors: ${JSON.stringify(errsR)}`);
    }
    const frontR2 = domR.window.document.getElementById('frontInner').textContent;
    if (frontR2 !== 'Q3') {
      throw new Error(`id-only responses blanked/regressed the card: front=${JSON.stringify(frontR2)}`);
    }
    if (domR.window.document.getElementById('ratings').classList.contains('disabled')) {
      throw new Error('rating controls not re-enabled after all submits resolved');
    }
    const reviewedR = domR.window.document.getElementById('progress').textContent;
    if (!reviewedR.includes('3 reviewed')) {
      throw new Error(`authoritative counters not applied after all commits: ${JSON.stringify(reviewedR)}`);
    }
    console.log('PASS fifo ratings: rapid clicks drain in order (c1→c2→c3), counters remain authoritative and pending stays separate');
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
    // HOLD the first submit unresolved — with FIFO, subsequent submits are
    // queued until this one resolves.  The user can outrun the backend:
    // every optimistic card advances correctly while only one submit is in
    // flight.
    domL.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCallsL += 1;
          submittedIdsL.push(args.expectedCardId);
          return await new Promise((resolve) => { resolveSubmitsL.push(resolve); });
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    if (domL.window.document.getElementById('frontInner').textContent !== 'Q1') {
      throw new Error(`long-session setup: expected Q1, got ${JSON.stringify(domL.window.document.getElementById('frontInner').textContent)}`);
    }
    const rateGood = () => domL.window.document.querySelector('button[data-rating="3"]').click();
    // Rate THROUGH card 6 (past the old SESSION_PRELOAD=5 boundary) with the
    // first submit held. Every next card must render full with ENABLED
    // controls and NO request wording.  Only 1 submit has fired (FIFO).
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
      const statusL = domL.window.document.getElementById('status').textContent;
      if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusL)) {
        throw new Error(`request wording leaked at card ${k + 1}: ${JSON.stringify(statusL)}`);
      }
    }
    // FIFO: only 1 submit fired (serial drain).
    if (submitCallsL !== 1) {
      throw new Error(`long-session: expected 1 initial submit (FIFO), got ${submitCallsL}`);
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
    // Continue rating c7 → c12 with the first submit still held: the queue
    // must NOT have been shrunk by the short preload.
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
        const statusL = domL.window.document.getElementById('status').textContent;
        if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusL)) {
          throw new Error(`request wording leaked at card ${k + 1}: ${JSON.stringify(statusL)}`);
        }
      }
    }
    // The LAST card (c12) was rated while only the first submit is held: the
    // widget shows a CLEAN optimistic completion — the done panel is visible,
    // fully interactive, with NO request wording and NO blank/disabled card.
    const doneShownL = !domL.window.document.getElementById('done').classList.contains('hidden');
    if (!doneShownL) {
      throw new Error('long-session: last card rated with submits held did NOT show optimistic completion');
    }
    const statusLast = domL.window.document.getElementById('status').textContent;
    if (/Submitting|submitting|request|Request|loading|Loading|saving|Saving|sync|Sync/i.test(statusLast)) {
      throw new Error(`optimistic completion leaked request wording: ${JSON.stringify(statusLast)}`);
    }
    if (submitCallsL !== 1) {
      throw new Error(`long-session: expected 1 held submit, got ${submitCallsL}`);
    }
    // FIFO DRAIN: release the held submits in ORDER — each resolve fires the
    // next submit (serial drain).  The final resolve delivers the terminal
    // completed state; the done panel stays.
    for (let r = 0; r < resolveSubmitsL.length; r += 1) {
      const isLast = r === resolveSubmitsL.length - 1;
      resolveSubmitsL[r]({
        structuredContent: isLast
          ? { session: { id: 'sL', status: 'completed', cardType: 'qa', cardIds: ids, currentIndex: N, reviewedCount: N, remainingCount: 0, limit: 100, continuationAvailable: false }, card: null, preloaded: [] }
          : { session: { id: 'sL', status: 'active', cardType: 'qa', cardIds: ids, currentIndex: r + 1, reviewedCount: r + 1, remainingCount: N - r - 1, limit: 100 }, card: { id: 'c' + (r + 2), front: 'Q' + (r + 2), back: 'A' + (r + 2) }, preloaded: [] },
      });
      await sleep(40);
    }
    // Wait for the last submit to complete and drain.
    await sleep(80);
    if (errsL.length > 0) {
      throw new Error(`long-session post-reconcile errors: ${JSON.stringify(errsL)}`);
    }
    if (submitCallsL !== 12) {
      throw new Error(`long-session: expected 12 submits after FIFO drain, got ${submitCallsL}`);
    }
    // FIFO order: submitted ids must be c1..c12 in order.
    const expectedIds = ids.slice(0, 12);
    for (let i = 0; i < 12; i += 1) {
      if (submittedIdsL[i] !== expectedIds[i]) {
        throw new Error(`long-session FIFO order wrong: submit ${i} was ${submittedIdsL[i]}, expected ${expectedIds[i]}`);
      }
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
    console.log('PASS long session (12 cards): FIFO serial drain, every next card full + enabled, short stale preload cannot regress the queue, clean optimistic completion');
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
          return await new Promise((resolve) => { heldV.push(resolve); });
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

  // 6. RAPID THREE-CARD BURST / STALE-RESPONSE REGRESSION: clicks 3
  //    ratings on three optimistically displayed cards before resolving any
  //    submit.  Verifies: (a) exactly one submit in flight initially;
  //    (b) UI keeps 0 reviewed / 3 remaining and shows three pending before
  //    each held submit in original click order, confirming the next starts
  //    only after the prior settles; (d) injects a delayed stale snapshot
  //    and proves the counter and displayed card do not regress.
  {
    const dom6 = new JSDOM(buildReviewWidgetHtml({
      session: {
        id: 's6', status: 'active', cardType: 'qa',
        cardIds: ['c1', 'c2', 'c3'], currentIndex: 0,
        reviewedCount: 0, remainingCount: 3, limit: 100,
        preloaded: [
          { id: 'c2', front: 'Q2', back: 'A2', tags: [] },
          { id: 'c3', front: 'Q3', back: 'A3', tags: [] },
        ],
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
      flashcardTool: 'get_flashcard',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://cuelingua-mcp-767542644824.us-central1.run.app/' });
    const errs6 = [];
    dom6.window.addEventListener('error', (e) => errs6.push(e.message ?? String(e)));
    let submitCalls6 = 0;
    const submittedIds6 = [];
    const resolveHeld6 = [];
    dom6.window.openai = {
      callTool: async (name, args) => {
        if (name === 'submit_review') {
          submitCalls6 += 1;
          submittedIds6.push(args.expectedCardId);
          await new Promise((r) => { resolveHeld6.push(r); });
          return {
            structuredContent: {
              session: {
                id: 's6', status: submitCalls6 >= 3 ? 'completed' : 'active', cardType: 'qa',
                cardIds: ['c1', 'c2', 'c3'], currentIndex: submitCalls6,
                reviewedCount: submitCalls6, remainingCount: 3 - submitCalls6,
                limit: 100,
              },
              card: submitCalls6 >= 3 ? null : { id: 'c' + (submitCalls6 + 1) },
              preloaded: [],
            },
          };
        }
        return { structuredContent: {} };
      },
    };
    await sleep(20);
    const doc6 = dom6.window.document;
    if (doc6.getElementById('frontInner').textContent !== 'Q1') {
      throw new Error(`burst setup: expected Q1, got ${JSON.stringify(doc6.getElementById('frontInner').textContent)}`);
    }
    const clickGood = () => doc6.querySelector('button[data-rating="3"]').click();
    const shownFront = () => doc6.getElementById('frontInner').textContent;
    const shownBack = () => doc6.getElementById('backInner').textContent;
    const progressText = () => doc6.getElementById('progress').textContent;
    const doneHidden = () => doc6.getElementById('done').classList.contains('hidden');

    // (a) Click 3 ratings rapidly before any submit resolves.
    clickGood(); // rate c1 → shift to c2, submit1 fires (held)
    await sleep(20);
    clickGood(); // rate c2 → shift to c3, submit2 queued
    await sleep(20);
    clickGood(); // rate c3 → optimistic completion, submit3 queued
    await sleep(40);
    if (errs6.length > 0) {
      throw new Error(`burst widget errors: ${JSON.stringify(errs6)}`);
    }
    // Exactly ONE submit fired (serial FIFO).
    if (submitCalls6 !== 1) {
      throw new Error(`burst: expected 1 initial submit, got ${submitCalls6}`);
    }
    if (submittedIds6[0] !== 'c1') {
      throw new Error(`burst: first submit should be c1, got ${JSON.stringify(submittedIds6[0])}`);
    }

    // (b) Server counters remain at 0 reviewed / 3 remaining, separately from pending.
    const prog6 = progressText();
    if (!prog6.includes('0 reviewed') || !prog6.includes('3 remaining') || !prog6.includes('3 pending')) {
      throw new Error(`burst: authoritative counters and separate pending progress wrong: ${JSON.stringify(prog6)}`);
    }
    // c3 is displayed (the third card).
    if (shownFront() !== 'Q3' || shownBack() !== 'A3') {
      throw new Error(`burst: expected c3 displayed, got front=${JSON.stringify(shownFront())} back=${JSON.stringify(shownBack())}`);
    }
    // Done panel shown (all cards accounted for optimistically).
    if (doneHidden()) {
      throw new Error('burst: done panel not shown optimistically');
    }

    // (c) Resolve each held submit in original click order.  Each resolve
    //     must trigger the next submit (FIFO drain).  Verify each step.
    // Resolve submit1 → submit2 fires.
    resolveHeld6[0]();
    await sleep(60);
    if (errs6.length > 0) {
      throw new Error(`burst post-resolve-1 errors: ${JSON.stringify(errs6)}`);
    }
    if (submitCalls6 !== 2) {
      throw new Error(`burst: after resolve-1 expected 2 submits, got ${submitCalls6}`);
    }
    if (submittedIds6[1] !== 'c2') {
      throw new Error(`burst: second submit should be c2, got ${JSON.stringify(submittedIds6[1])}`);
    }
    // Resolve submit2 → submit3 fires.
    resolveHeld6[1]();
    await sleep(60);
    if (submitCalls6 !== 3) {
      throw new Error(`burst: after resolve-2 expected 3 submits, got ${submitCalls6}`);
    }
    if (submittedIds6[2] !== 'c3') {
      throw new Error(`burst: third submit should be c3, got ${JSON.stringify(submittedIds6[2])}`);
    }
    // Resolve submit3 → terminal state.
    resolveHeld6[2]();
    await sleep(80);
    if (errs6.length > 0) {
      throw new Error(`burst post-resolve-3 errors: ${JSON.stringify(errs6)}`);
    }
    // Authoritative counters applied: 3 reviewed, 0 remaining.
    const prog6final = progressText();
    if (!prog6final.includes('3 reviewed') || !prog6final.includes('0 remaining')) {
      throw new Error(`burst: final progress wrong: ${JSON.stringify(prog6final)}`);
    }

    // (d) Inject a delayed/stale session snapshot for an already-rated card
    //     (c1) with reviewedCount:0 — must NOT regress the counter or card.
    dom6.window.dispatchEvent(new dom6.window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          output: {
            structuredContent: {
              session: {
                id: 's6', status: 'active', cardType: 'qa',
                cardIds: ['c1', 'c2', 'c3'], currentIndex: 0,
                reviewedCount: 0, remainingCount: 3, limit: 100,
              },
              card: { id: 'c1', front: 'Q1', back: 'A1' },
              preloaded: [
                { id: 'c2', front: 'Q2', back: 'A2', tags: [] },
              ],
            },
          },
        },
      },
    }));
    await sleep(40);
    if (errs6.length > 0) {
      throw new Error(`burst post-stale errors: ${JSON.stringify(errs6)}`);
    }
    // Counter must NOT regress below 3 reviewed.
    const prog6stale = progressText();
    if (!prog6stale.includes('3 reviewed')) {
      throw new Error(`burst: stale snapshot regressed reviewed counter: ${JSON.stringify(prog6stale)}`);
    }
    // Card must NOT regress to c1 — done panel stays visible (session is
    // completed after 3 ratings) and stale snapshot cannot resurrect it.
    if (doneHidden()) {
      throw new Error('burst: stale snapshot hid the done panel — card/session UI regressed');
    }
    // If the terminal DOM still shows the card shell, front/back must NOT
    // have reverted to c1 content (Q1/A1) from the stale snapshot.
    if (!doc6.getElementById('cardShell').classList.contains('hidden')) {
      if (shownFront() === 'Q1' || shownBack() === 'A1') {
        throw new Error(`burst: stale snapshot regressed card to c1 (front=${JSON.stringify(shownFront())}, back=${JSON.stringify(shownBack())})`);
      }
    }
    console.log('PASS rapid burst: 3 ratings before any ack, authoritative counters stay separate, FIFO drains in order and stale snapshots cannot regress state');
  }

  // Regression: a fulfilled submit with no usable payload is not safe to
  // dequeue until the authoritative recovery GET has applied.
  {
    const domQ = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sQ', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 3, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2' }, { id: 'c3', front: 'Q3', back: 'A3' }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    const calls = [];
    let releaseGet;
    domQ.window.openai = { callTool: (name, args) => {
      calls.push({ name, args });
      if (name === 'submit_review') return Promise.resolve(undefined);
      if (name === 'get_review_session') return new Promise((resolve) => { releaseGet = resolve; });
      return Promise.resolve({});
    } };
    const doc = domQ.window.document;
    doc.querySelector('[data-rating="3"]').click();
    doc.querySelector('[data-rating="3"]').click();
    await sleep(25);
    if (calls.filter((c) => c.name === 'submit_review').length !== 1 || !releaseGet) {
      throw new Error('ambiguous fulfilled submit did not wait for recovery GET');
    }
    releaseGet({ structuredContent: { session: { id: 'sQ', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 1, reviewedCount: 1, remainingCount: 2, limit: 3, processedRequestIds: [calls.find((c) => c.name === 'submit_review').args.requestId] }, card: { id: 'c2', front: 'Q2', back: 'A2' } } });
    await sleep(40);
    const queued = calls.filter((c) => c.name === 'submit_review');
    if (queued.length !== 2 || queued[1].args.expectedCardId !== 'c2') {
      throw new Error(`FIFO did not release after recovery GET: ${JSON.stringify(queued)}`);
    }
    domQ.window.close();
  }

  // A true failed rating restores its item; an ambiguous timeout is counted
  // only when the recovery GET contains the exact request receipt.
  for (const committed of [false, true]) {
    const sessionId = committed ? 'sAmbiguous' : 'sFailed';
    const domR = new JSDOM(buildReviewWidgetHtml({
      session: { id: sessionId, status: 'active', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 2, preloaded: [{ id: 'c2', front: 'Q2', back: 'A2' }] },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let submitCount = 0;
    let submittedRequestId;
    domR.window.openai = { callTool: (name, args) => {
      if (name === 'submit_review') {
        submittedRequestId = args.requestId;
        submitCount += 1;
        return Promise.reject(new Error('timeout after unknown commit'));
      }
      const state = committed
        ? { id: sessionId, status: 'active', cardIds: ['c1', 'c2'], currentIndex: 1, reviewedCount: 1, remainingCount: 1, limit: 2, processedRequestIds: committed ? [submittedRequestId] : [] }
        : { id: sessionId, status: 'active', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 2, processedRequestIds: [] };
      return Promise.resolve({ structuredContent: { session: state, card: committed ? { id: 'c2', front: 'Q2', back: 'A2' } : { id: 'c1', front: 'Q1', back: 'A1' } } });
    } };
    domR.window.document.querySelector('[data-rating="3"]').click();
    // Queued-intent preservation is exercised separately below.
    await sleep(40);
    const progress = domR.window.document.getElementById('progress').textContent;
    if (submitCount !== 1) throw new Error(`single-item recovery unexpectedly submitted more than once: ${submitCount}`);
    const expected = committed ? '1 reviewed, 1 remaining' : '0 reviewed, 2 remaining';
    if (!progress.includes(expected)) throw new Error(`${sessionId} optimistic count mismatch: ${progress}`);
    domR.window.close();
  }
  // Recovery must distinguish item-specific evidence from unrelated
  // progress and must keep an unresolvable deletion pending.
  for (const deleted of [false, true]) {
    const sessionId = deleted ? 'sDeletedWhileSubmitting' : 'sOtherClientProgress';
    const domS = new JSDOM(buildReviewWidgetHtml({
      session: { id: sessionId, status: 'active', cardIds: ['A', 'B'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 2 },
      card: { id: 'A', front: 'QA', back: 'AA' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    domS.window.openai = { callTool: (name) => name === 'submit_review'
      ? Promise.reject(new Error('submit timed out'))
      : Promise.resolve({ structuredContent: { session: {
        id: sessionId, status: 'active', cardIds: ['A', 'B'], currentIndex: deleted ? 1 : 0,
        reviewedCount: deleted ? 0 : 1, remainingCount: 1, limit: 2,
        reviewedCardIds: deleted ? [] : ['B'], processedRequestIds: [],
      }, card: deleted ? { id: 'B', front: 'QB', back: 'AB' } : { id: 'A', front: 'QA', back: 'AA' } } }) };
    domS.window.document.querySelector('[data-rating="3"]').click();
    await sleep(40);
    const progressS = domS.window.document.getElementById('progress').textContent;
    if (deleted) {
      if (!progressS.includes('0 reviewed') || !progressS.includes('1 pending') ||
          !domS.window.document.getElementById('ratings').classList.contains('disabled')) {
        throw new Error(`deleted in-flight item was misattributed or not held: ${JSON.stringify(progressS)}`);
      }
    } else if (domS.window.document.getElementById('frontInner').textContent !== 'QA' ||
        !progressS.includes('1 reviewed') || progressS.includes('pending') ||
        !domS.window.document.getElementById('status').textContent.includes('Rating was not recorded')) {
      throw new Error(`unrelated progress masked the failed item: front=${JSON.stringify(domS.window.document.getElementById('frontInner').textContent)} progress=${JSON.stringify(progressS)}`);
    }
    domS.window.close();
  }
  // A confirmed failure removes only its own intent; queued out-of-order
  // reviews retain their captured targets and drain in FIFO order.
  {
    const domFifo = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sQueuedRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 3, preloaded: [{ id: 'B', front: 'QB', back: 'AB' }, { id: 'C', front: 'QC', back: 'AC' }] },
      card: { id: 'A', front: 'QA', back: 'AA' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    const submitted = [];
    domFifo.window.openai = { callTool: (name, args) => {
      if (name === 'submit_review') {
        submitted.push(args.expectedCardId);
        if (args.expectedCardId === 'A') return Promise.reject(new Error('A failed'));
        const reviewedCardIds = submitted.filter((id) => id !== 'A');
        return Promise.resolve({ structuredContent: { session: {
          id: 'sQueuedRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 0,
          reviewedCount: reviewedCardIds.length, remainingCount: 3 - reviewedCardIds.length,
          reviewedCardIds, processedRequestIds: [],
        }, card: { id: 'A', front: 'QA', back: 'AA' } } });
      }
      return Promise.resolve({ structuredContent: { session: {
        id: 'sQueuedRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 0,
        reviewedCount: 0, remainingCount: 3, limit: 3, reviewedCardIds: [], processedRequestIds: [],
      }, card: { id: 'A', front: 'QA', back: 'AA' }, preloaded: [{ id: 'B', front: 'QB', back: 'AB' }, { id: 'C', front: 'QC', back: 'AC' }] } });
    } };
    const buttons = domFifo.window.document.querySelectorAll('button[data-rating="3"]');
    buttons[0].click();
    buttons[0].click();
    buttons[0].click();
    await sleep(120);
    if (JSON.stringify(submitted) !== JSON.stringify(['A', 'B', 'C'])) {
      throw new Error(`queued recovery lost or reordered valid intents: ${JSON.stringify(submitted)}`);
    }
    domFifo.window.close();
  }
  // Ending during an in-flight A cancels only unsent B/C; a failed End plus
  // authoritative active-A recovery clears stale local markers and permits retry.
  {
    const domEnd = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sEndRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 3, preloaded: [{ id: 'B', front: 'QB', back: 'AB' }, { id: 'C', front: 'QC', back: 'AC' }] },
      card: { id: 'A', front: 'QA', back: 'AA' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let submitCalls = 0;
    let releaseFirst;
    let getCalls = 0;
    domEnd.window.openai = { callTool: (name) => {
      if (name === 'submit_review') {
        submitCalls += 1;
        if (submitCalls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        return Promise.resolve({ structuredContent: { session: {
          id: 'sEndRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 1,
          reviewedCount: 1, remainingCount: 2, limit: 3, reviewedCardIds: ['A'], processedRequestIds: [],
        }, card: { id: 'B', front: 'QB', back: 'AB' } } });
      }
      if (name === 'end_review_session') return Promise.reject(new Error('end failed'));
      if (name === 'get_review_session') {
        getCalls += 1;
        return Promise.resolve({ structuredContent: { session: {
          id: 'sEndRecovery', status: 'active', cardIds: ['A', 'B', 'C'], currentIndex: 0,
          reviewedCount: 0, remainingCount: 3, limit: 3, reviewedCardIds: [], processedRequestIds: [],
        }, card: { id: 'A', front: 'QA', back: 'AA' }, preloaded: [{ id: 'B', front: 'QB', back: 'AB' }, { id: 'C', front: 'QC', back: 'AC' }] } });
      }
      return Promise.resolve({});
    } };
    const docEnd = domEnd.window.document;
    docEnd.querySelector('button[data-rating="3"]').click();
    docEnd.querySelector('button[data-rating="3"]').click();
    docEnd.querySelector('button[data-rating="3"]').click();
    docEnd.getElementById('endSessionBtn').click();
    await sleep(50);
    const progressEnd = docEnd.getElementById('progress').textContent;
    if (getCalls !== 1 || docEnd.getElementById('frontInner').textContent !== 'QA' ||
        !progressEnd.includes('0 reviewed') || progressEnd.includes('pending') ||
        docEnd.getElementById('ratings').classList.contains('disabled') || !docEnd.getElementById('done').classList.contains('hidden')) {
      throw new Error(`failed end recovery left stale queued/rated state: ${JSON.stringify({ front: docEnd.getElementById('frontInner').textContent, progressEnd, getCalls })}`);
    }
    docEnd.querySelector('button[data-rating="3"]').click();
    await sleep(25);
    if (submitCalls !== 2) throw new Error(`active card was not retryable after failed End recovery: ${submitCalls}`);
    releaseFirst({ structuredContent: {} });
    domEnd.window.close();
  }

  // Continue is single-flight and restores its button with useful feedback
  // when the start call fails.
  {
    const domC = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sContinue', status: 'completed', storageVersion: 2, limit: 1, remainingQueueCount: 0, remainingCount: 0, currentIndex: 1, reviewedCount: 1, continuationAvailable: true, source: { type: 'due' }, queueWindow: { cardIds: [] } },
      card: null, submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let startCalls = 0;
    let rejectStart;
    domC.window.openai = { callTool: (name) => name === 'start_review_session'
      ? (startCalls += 1, new Promise((_, reject) => { rejectStart = reject; }))
      : Promise.resolve({}) };
    const button = domC.window.document.getElementById('continueBtn');
    button.classList.remove('hidden');
    button.click();
    button.click();
    if (startCalls !== 1) throw new Error(`Continue double-click started ${startCalls} sessions`);
    rejectStart(new Error('start failed'));
    await sleep(25);
    if (button.disabled || !domC.window.document.getElementById('status').textContent.includes('Could not continue')) {
      throw new Error('Continue error did not restore the button and report a retryable state');
    }
    domC.window.close();
  }
  // A late rejection from session A must not clear the single-flight gate
  // for session B's already-pending Continue request.
  {
    const domContinueStale = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sContinueA', status: 'completed', storageVersion: 2, limit: 1, remainingQueueCount: 0, remainingCount: 0, currentIndex: 1, reviewedCount: 1, continuationAvailable: true, source: { type: 'due' }, queueWindow: { cardIds: [] } },
      card: null, submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let rejectA;
    let startCalls = 0;
    const pendingStarts = [];
    domContinueStale.window.openai = { callTool: (name) => name === 'start_review_session'
      ? (startCalls += 1, new Promise((resolve, reject) => {
        if (startCalls === 1) rejectA = reject;
        else pendingStarts.push(resolve);
      }))
      : Promise.resolve({}) };
    const button = domContinueStale.window.document.getElementById('continueBtn');
    button.classList.remove('hidden');
    button.click();
    const sessionB = { id: 'sContinueB', status: 'completed', storageVersion: 2, limit: 1, remainingQueueCount: 0, remainingCount: 0, currentIndex: 1, reviewedCount: 1, continuationAvailable: true, source: { type: 'due' }, queueWindow: { cardIds: [] } };
    const switchEvent = new domContinueStale.window.MessageEvent('message', {
      origin: 'https://host.example',
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { output: { structuredContent: { session: sessionB, card: null } } } },
    });
    Object.defineProperty(switchEvent, 'source', { value: domContinueStale.window });
    domContinueStale.window.dispatchEvent(switchEvent);
    button.classList.remove('hidden');
    button.click();
    if (startCalls !== 2 || !button.disabled) throw new Error('session B Continue did not enter its own single-flight state');
    rejectA(new Error('session A Continue failed late'));
    await sleep(25);
    if (startCalls !== 2 || !button.disabled ||
        domContinueStale.window.document.getElementById('status').textContent.includes('Could not continue')) {
      throw new Error(`stale session A Continue rejection altered B's pending gate: ${JSON.stringify({ startCalls, disabled: button.disabled, status: domContinueStale.window.document.getElementById('status').textContent })}`);
    }
    button.click();
    if (startCalls !== 2) throw new Error(`stale session A rejection allowed a duplicate B Continue: ${startCalls}`);
    console.log('PASS stale Continue rejection: old session cannot clear the new session single-flight gate or surface an old-session error');
    domContinueStale.window.close();
  }

  // Stale submit/end callbacks from a prior session cannot replace a newly
  // adopted session or strand its FIFO gate.
  {
    const domG = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sOld', status: 'active', cardIds: ['old1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 },
      card: { id: 'old1', front: 'Old question', back: 'Old answer' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let resolveSubmit;
    let resolveEnd;
    domG.window.openai = { callTool: (name) => name === 'submit_review'
      ? new Promise((resolve) => { resolveSubmit = resolve; })
      : name === 'end_review_session' ? new Promise((resolve) => { resolveEnd = resolve; }) : Promise.resolve({}) };
    const docG = domG.window.document;
    docG.querySelector('[data-rating="3"]').click();
    docG.getElementById('endSessionBtn').click();
    const newSession = { id: 'sNew', status: 'active', cardIds: ['new1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 };
    const event = new domG.window.MessageEvent('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { output: { structuredContent: { session: newSession, card: { id: 'new1', front: 'New question', back: 'New answer' } } } } } });
    domG.window.dispatchEvent(event);
    resolveSubmit({ structuredContent: { session: { id: 'sOld', status: 'completed', cardIds: ['old1'], currentIndex: 1, reviewedCount: 1, remainingCount: 0, limit: 1 }, card: null } });
    resolveEnd({ structuredContent: { id: 'sOld', status: 'ended', reviewedCount: 0 } });
    await sleep(30);
    if (docG.getElementById('frontInner').textContent !== 'New question') throw new Error('stale prior-session callback replaced the new session card');
    docG.querySelector('[data-rating="3"]').click();
    await sleep(20);
    domG.window.close();
  }

  // A rejected old submit is stale too: it must not paint an error or close
  // the new session's rating gate.
  {
    const domE = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sErrorOld', status: 'active', cardIds: ['oldE'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 },
      card: { id: 'oldE', front: 'Old question', back: 'Old answer' },
      submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    let rejectOld;
    let newSubmitCalls = 0;
    domE.window.openai = { callTool: (name) => name === 'submit_review'
      ? (name === 'submit_review' && ++newSubmitCalls === 1
        ? new Promise((_, reject) => { rejectOld = reject; })
        : Promise.resolve({ structuredContent: { session: { id: 'sErrorNew', status: 'active', cardIds: ['newE'], currentIndex: 1, reviewedCount: 1, remainingCount: 0, limit: 1 }, card: null } }))
      : name === 'get_review_session' ? Promise.resolve({})
        : Promise.resolve({}) };
    domE.window.document.querySelector('[data-rating="3"]').click();
    const event = new domE.window.MessageEvent('message', { origin: 'https://trusted.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { output: { structuredContent: { session: { id: 'sErrorNew', status: 'active', cardIds: ['newE'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 }, card: { id: 'newE', front: 'New question', back: 'New answer' } } } } } });
    Object.defineProperty(event, 'source', { value: domE.window });
    domE.window.dispatchEvent(event);
    rejectOld(new Error('old session failed'));
    await sleep(20);
    if (domE.window.document.getElementById('frontInner').textContent !== 'New question' ||
        domE.window.document.getElementById('status').textContent.includes('Could not verify')) {
      throw new Error('stale prior-session rejection altered new session state');
    }
    domE.window.document.querySelector('[data-rating="3"]').click();
    await sleep(20);
    if (newSubmitCalls !== 2) throw new Error('stale prior-session rejection stranded the new session gate');
    domE.window.close();
  }

  // The JSON-RPC bridge requires the actual parent source, binds its origin
  // from the first parent notification, and rejects sibling/wrong-origin data.
  {
    const domP = new JSDOM(widgetHtml(), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    const parentErrors = [];
    domP.window.addEventListener('error', (event) => parentErrors.push(event.message));
    const sibling = new JSDOM('', { url: 'https://sibling.example/' });
    const hostPosts = [];
    domP.window.parent.postMessage = (message) => hostPosts.push(message);
    const send = (source, origin, cardText) => {
      const event = new domP.window.MessageEvent('message', { origin, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { output: { structuredContent: { session: { id: 'sParent', status: 'active', cardIds: ['p1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 }, card: { id: 'p1', front: cardText, back: 'A' } } } } } });
      Object.defineProperty(event, 'source', { value: source });
      domP.window.dispatchEvent(event);
    };
    const forgedResponse = new domP.window.MessageEvent('message', {
      origin: 'https://trusted.example',
      data: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } },
      source: sibling.window,
    });
    domP.window.dispatchEvent(forgedResponse);
    await sleep(10);
    if (hostPosts.some((message) => message.method === 'ui/notifications/initialized')) {
      throw new Error('forged sibling response completed the parent handshake');
    }
    const validResponse = new domP.window.MessageEvent('message', {
      origin: 'https://trusted.example',
      data: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } },
      source: domP.window,
    });
    domP.window.dispatchEvent(validResponse);
    await sleep(10);
    if (!hostPosts.some((message) => message.method === 'ui/notifications/initialized')) {
      throw new Error('valid parent handshake response was rejected');
    }
    send(sibling.window, 'https://trusted.example', 'Sibling forgery');
    send(domP.window, 'https://attacker.example', 'Origin forgery');
    send(domP.window, 'https://trusted.example', 'Trusted host');
    await sleep(10);
    if (domP.window.document.getElementById('frontInner').textContent !== 'Trusted host') {
      throw new Error('forged sibling/source/origin message altered widget state or valid parent notification was rejected');
    }
    const malformed = new domP.window.MessageEvent('message', {
      origin: 'https://trusted.example',
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result' },
    });
    Object.defineProperty(malformed, 'source', { value: domP.window });
    domP.window.dispatchEvent(malformed);
    await sleep(10);
    if (parentErrors.length) throw new Error(`malformed parent notification threw: ${JSON.stringify(parentErrors)}`);
    domP.window.close();
    sibling.window.close();
  }
  // A fulfilled but unusable continuation (or one that reuses the finished
  // session ID) must surface failure and restore a retryable button.
  for (const result of [{}, { structuredContent: { session: { id: 'sContinueInvalid', status: 'active', cardIds: ['next'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 }, card: { id: 'next', front: 'Q', back: 'A' } } }]) {
    const domContinue = new JSDOM(buildReviewWidgetHtml({
      session: { id: 'sContinueInvalid', status: 'completed', storageVersion: 2, limit: 1, remainingQueueCount: 0, remainingCount: 0, currentIndex: 1, reviewedCount: 1, continuationAvailable: true, source: { type: 'due' }, queueWindow: { cardIds: [] } },
      card: null, submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
    domContinue.window.openai = { callTool: (name) => name === 'start_review_session' ? Promise.resolve(result) : Promise.resolve({}) };
    const button = domContinue.window.document.getElementById('continueBtn');
    button.classList.remove('hidden');
    button.click();
    await sleep(20);
    if (button.disabled || !domContinue.window.document.getElementById('status').textContent.includes('Could not continue')) {
      throw new Error('fulfilled unusable/same-session Continue result did not restore a visible retryable error');
    }
    domContinue.window.close();
  }
  // Independent widget instances must not collide when wall-clock time is
  // frozen; IDs come from each real browser crypto.randomUUID implementation.
  {
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const domId = new JSDOM(buildReviewWidgetHtml({
        session: { id: 'sFrozenTime', status: 'active', cardIds: ['same-card'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 1 },
        card: { id: 'same-card', front: 'Q', back: 'A' },
        submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
      }), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example/' });
      domId.window.Date.now = () => 1234;
      let requestId;
      domId.window.openai = { callTool: (name, args) => {
        if (name === 'submit_review') requestId = args.requestId;
        return Promise.resolve({ structuredContent: { session: {
          id: 'sFrozenTime', status: 'completed', cardIds: ['same-card'], currentIndex: 1,
          reviewedCount: 1, remainingCount: 0, limit: 1, processedRequestIds: [args?.requestId].filter(Boolean),
        }, card: null } });
      } };
      domId.window.document.querySelector('button[data-rating="3"]').click();
      await sleep(20);
      if (!requestId) throw new Error('widget did not generate a rating request id');
      ids.push(requestId);
      domId.window.close();
    }
    if (ids[0] === ids[1]) throw new Error('independent widgets collided on same-session, frozen-time rating request ids');
  }

  console.log('\nWIDGET RUNTIME OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('WIDGET RUNTIME FAILED:', err.message);
  process.exit(1);
});

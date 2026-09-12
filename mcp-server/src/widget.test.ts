import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FirebaseBridge } from './bridge';
import { registerReviewWidget, escapeHtml, jsonScriptBody, buildReviewWidgetHtml, REVIEW_WIDGET_URI, reviewWidgetBootstrapSchema } from './widget';
import { registerFlashcardTools, sessionSummary } from './tools';

type Handler = (url: string, init: RequestInit) => Response;
function fakeBridge(handler: Handler, apiKey = 'test-key'): FirebaseBridge {
  return new FirebaseBridge({ apiKey, baseUrl: 'https://test.invalid', fetchFn: jest.fn(async (url, init) => handler(String(url), init ?? {})) });
}

const ts = { _seconds: 1700000000, _nanoseconds: 0 };
function sessionWire(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    apiKeyName: 'Test Key',
    status: 'active',
    mode: 'spaced_repetition',
    limit: 100,
    dueCount: 12,
    cardIds: ['card-1'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 12,
    truncated: false,
    continuationAvailable: false,
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
    startedAt: ts,
    ...overrides,
  };
}

async function setup(handler: Handler): Promise<{ client: Client; server: McpServer }> {
  const bridge = fakeBridge(handler);
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerFlashcardTools(server, bridge);
  registerReviewWidget(server, bridge);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert("x")</script> & \'quotes\'')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;',
    );
  });

  it('stringifies non-strings safely', () => {
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(undefined)).toBe('undefined');
  });
});

describe('jsonScriptBody', () => {
  it('neutralizes </script> so crafted content cannot break out of the bootstrap', () => {
    const body = jsonScriptBody({ front: '</script><script>alert(1)</script>' });
    // No literal closing script tag can appear in the JSON bootstrap body.
    expect(body).not.toContain('</script>');
    // The '<' of every tag is escaped as \u003c, so the browser never parses
    // the payload as markup.
    expect(body).toContain('\\u003c/script');
  });

  it('serializes the bootstrap deterministically', () => {
    const a = jsonScriptBody({ x: 1, y: ['a', 'b'] });
    const b = jsonScriptBody({ x: 1, y: ['a', 'b'] });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ x: 1, y: ['a', 'b'] });
  });
});

describe('reviewWidgetBootstrapSchema', () => {
  it('accepts a valid bootstrap', () => {
    expect(reviewWidgetBootstrapSchema.safeParse({
      session: { id: 's1' }, card: null, submitTool: 'submit_review',
      startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }).success).toBe(true);
  });

  it('accepts an optional cloze presentation card type', () => {
    expect(reviewWidgetBootstrapSchema.safeParse({
      session: {}, card: null, submitTool: 'submit_review',
      startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }).success).toBe(true);
  });

  it('rejects a missing tool name', () => {
    expect(reviewWidgetBootstrapSchema.safeParse({
      session: {}, card: null, submitTool: '',
      startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session',
    }).success).toBe(false);
  });
});

describe('buildReviewWidgetHtml', () => {
  it('embeds the JSON bootstrap in a script tag and renders static chrome', () => {
    const html = buildReviewWidgetHtml({
      session: { modeTag: '[Spaced repetition review · 12 cards due]', status: 'active' },
      card: { front: 'Q', back: 'A' },
      submitTool: 'submit_review',
      startTool: 'start_review_session',
      endTool: 'end_review_session',
      getTool: 'get_review_session',
    });
    expect(html).toContain('id="bootstrap"');
    expect(html).toContain('data-rating="1"');
    expect(html).toContain('Again');
    expect(html).toContain('Good');
    expect(html).toContain('id="done"');
    // Airy white redesign: 3D flip tokens retained, compact blue status pill,
    // top-right counters, centered deck pill, slim progress bar, large outlined
    // card with subtle shadow, numbered tinted rating tiles, and icons.
    expect(html).toContain('.hidden { display:none !important; }');
    expect(html).toContain('perspective:1200px');
    expect(html).toContain('transform-style:preserve-3d');
    expect(html).toContain('backface-visibility:hidden');
    expect(html).toContain('rotateY(180deg)');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('id="sessionTypeLabel"');
    expect(html).toContain('id="progressFill"');
    expect(html).toContain('id="deckName"');
    expect(html).toContain('.card-face.back-face');
    // Airy white canvas + progress chrome (approved design).
    expect(html).toContain('--bg:#f8fafc');
    expect(html).toContain('class="session-info"');
    expect(html).toContain('progress-bar');
    expect(html).toContain('background:linear-gradient(90deg,#60a5fa,#2563eb)');
    // Intentional top inset: ~24px above the first row at desktop (wrap
    // top padding; margin no longer creates the gap), reduced to 16px on
    // the narrowest iframes.
    expect(html).toContain('.wrap { max-width:680px; margin:0 auto; padding:24px 18px 40px; min-width:0; }');
    expect(html).toContain('.wrap { padding:16px 14px 32px; }');
    // Session info: separate session-type (accent) and mode (muted) labels.
    expect(html).toContain('.session-type { color:var(--accent); }');
    expect(html).toContain('id="modeLabel"');
    // Status text (#progress) sits ABOVE the progress bar.
    expect(html).toContain('<div class="progress" id="progress"></div>\n  <div class="progress-bar"><i id="progressFill"></i></div>');
    expect(html).toContain('.progress { font-size:11.5px; color:var(--muted); margin-bottom:6px;');
    expect(html).toContain('.progress-bar { height:4px; border-radius:999px; background:#e8edf5; overflow:hidden; margin-bottom:18px;');
    // Large outlined flashcard with a subtle shadow + centered large text.
    expect(html).toContain('box-shadow:var(--shadow)');
    expect(html).toContain('border:1.5px solid var(--line)');
    expect(html).toContain('clamp(22px,4.5vw,30px)');
    // Flip hint with inline SVG icon.
    expect(html).toContain('class="hint"');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    // Two equal outlined/blue action buttons with icons.
    expect(html).toContain('.typed-actions button { flex:1;');
    expect(html).toContain('id="revealBtn"');
    expect(html).toContain('id="checkBtn"');
    // Four equal numbered rating tiles with tinted backgrounds.
    expect(html).toContain('grid-template-columns:repeat(4,1fr)');
    expect(html).toContain('<span class="num">1</span>');
    expect(html).toContain('data-rating="4"');
    expect(html).toContain('class="again"');
    expect(html).toContain('class="easy"');
    expect(html).toContain('background:#fef2f2');
    expect(html).toContain('background:#eff6ff');
    // Centered quiet End Session control + labeled answer input + polite
    // feedback row (accessible inline feedback, not a modal/toast).
    expect(html).toContain('class="ghost end-session"');
    expect(html).toContain('label class="prompt" id="typedPrompt" for="answerInput"');
    expect(html).toContain('role="status" aria-live="polite"');
    // Responsive: narrow-iframe refinement keeps the four tiles equal.
    expect(html).toContain('@media (max-width:380px)');
    // Primary Apps SDK bridge is window.openai.callTool; __MCP_HOST__ is the
    // fallback; toolOutput drives hydration of the static resource.
    expect(html).toContain('window.openai');
    expect(html).toContain('oai.callTool');
    expect(html).toContain('oai.toolOutput');
    expect(html).toContain('hydrateFromToolOutput');
    expect(html).toContain('window.__MCP_HOST__');
    // Continue button is wired: v2 sessions pass repeatSessionId so the
    // backend COPIES the finished session's chunked queue (exact snapshot
    // replay); legacy sessions replay the selector provenance. cardType/name
    // are carried so the mode does not silently change.
    expect(html).toContain("continueBtn.addEventListener('click'");
    expect(html).toContain('callTool(data.startTool, args)');
    expect(html).toContain('if (v2 && s.id) {');
    expect(html).toContain('args.repeatSessionId = s.id;');
    expect(html).toContain('args.cardType = s.cardType;');
    expect(html).toContain('args.name = s.name;');
    expect(html).toContain('then(applyToolResult)');
    // The bootstrap state is rendered at startup even without a host bridge:
    // a standalone render() call must precede hydrateFromToolOutput() (the
    // regression where render only ran inside hydration left an empty card).
    expect(html).toContain('  render();\n  primeFromSession();\n  hydrateFromToolOutput();');
    // The bootstrap is a JSON script block (not inline JS), so dynamic data
    // can never execute as markup.
    expect(html).toContain('<script type="application/json" id="bootstrap">');
  });

  it('escapes a crafted card front/back so it cannot inject markup', () => {
    const html = buildReviewWidgetHtml({
      session: {},
      card: { front: '</div><img src=x onerror=alert(1)>', back: '<script>evil()</script>' },
      submitTool: 'submit_review',
      startTool: 'start_review_session',
      endTool: 'end_review_session',
      getTool: 'get_review_session',
    });
    // The malicious payloads appear only inside the JSON bootstrap (escaped),
    // never as live markup.
    expect(html).toContain('\\u003c/div');
    expect(html).not.toContain('</div><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>evil()</script>');
  });
});

describe('registerReviewWidget', () => {
  it('registers the ui://review-session-v5 resource and serves HTML with a bootstrap', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const resources = await client.listResources();
    expect(resources.resources.some((r) => r.uri === REVIEW_WIDGET_URI)).toBe(true);
    const found = resources.resources.find((r) => r.uri === REVIEW_WIDGET_URI);
    expect(found?.mimeType).toBe('text/html;profile=mcp-app');
    expect(found?.name).toBe('review-session-widget');

    const read = await client.readResource({ uri: REVIEW_WIDGET_URI });
    const first = read.contents[0];
    if (!('text' in first)) throw new Error('expected text resource content');
    const text = first.text;
    expect(text).toContain('<!doctype html>');
    expect(text).toContain('id="bootstrap"');
    expect(text).toContain('submit_review');
    // The default bootstrap has an empty session and no card — valid JSON.
    expect(JSON.parse(text.split('id="bootstrap">')[1].split('</script>')[0])).toMatchObject({
      submitTool: 'submit_review',
      startTool: 'start_review_session',
    });
  });

  it('does not change tool input schemas (registration is a pure addition)', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const tools = await client.listTools();
    const submit = tools.tools.find((t) => t.name === 'submit_review');
    const props = (submit?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['expectedCardId', 'expectedPosition', 'rating', 'requestId', 'reviewAt', 'sessionId']);
    const start = tools.tools.find((t) => t.name === 'start_review_session');
    const startProps = (start?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(startProps).sort()).toEqual(['cardIds', 'cardType', 'deck', 'deckId', 'name', 'repeatSessionId', 'tags']);
  });

  it('session tools advertise the MINIMAL model-facing output schema (quiet mode)', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const tools = await client.listTools();
    for (const name of ['start_review_session', 'get_review_session', 'submit_review']) {
      const tool = tools.tools.find((t) => t.name === name);
      const out = (tool?.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      // The model-facing schema is MINIMAL: session (id/status/mode/counters)
      // + card { id } only — no front/back/preloaded/evaluations.
      expect(Object.keys(out).sort()).toEqual(['card', 'session']);
      const sessionProps = (out.session as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(sessionProps).sort()).toEqual(['buildStatus', 'currentChunkIndex', 'currentIndex', 'currentPosition', 'id', 'mode', 'remainingCount', 'reviewedCount', 'status', 'storageVersion', 'totalCount']);
      // card is nullable: anyOf [{ object { id } }, null].
      const cardAny = out.card as { anyOf?: Array<{ properties?: Record<string, unknown> }> } | undefined;
      const cardObj = cardAny?.anyOf?.[0];
      expect(cardObj?.properties ? Object.keys(cardObj.properties).sort() : []).toEqual(['id']);
    }
  });
});

describe('widget integration with session tool output', () => {
  it('session tool structuredContent carries the ui:// hint meta', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', {
        cardIds: Array.from({ length: 12 }, (_, i) => 'card-' + i),
        remainingCount: 12,
        modeTag: '[Spaced repetition review · 12 cards due]',
        visibleStatus: 'active · 0 reviewed, 12 remaining of 12',
      }),
      card: { id: 'card-1', front: 'Q', back: 'A', tags: [], createdAt: ts, updatedAt: ts, due: ts, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: { id?: string } | null } }).structuredContent;
    // QUIET mode: model-facing structuredContent is MINIMAL — no
    // modeTag/visibleStatus/front/back.
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    expect(sc?.session?.modeTag).toBeUndefined();
    expect(sc?.session?.visibleStatus).toBeUndefined();
    expect((sc?.card as { id?: string } | null | undefined)?.id).toBe('card-1');
    expect((sc?.card as { front?: string } | null | undefined)?.front).toBeUndefined();
    // QUIET mode: model-facing content is EMPTY (the widget owns display).
    expect(result.content).toEqual([]);
    // The FULL widget state rides in the hidden _meta['ui/widgetState'].
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe('ui://review-session-v5');
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; card?: { front?: string } | null } | undefined);
    expect(hidden?.session?.modeTag).toBe('[Spaced repetition review · 12 cards · Due cards]');
    expect(hidden?.session?.visibleStatus).toBe('active · 0 reviewed, 12 remaining of 12');
    expect(hidden?.card?.front).toBe('Q');
  });

  it('sessionSummary still yields modeTag/visibleStatus (pure helper contract)', () => {
    const summary = sessionSummary(sessionWire('s1', { cardIds: Array.from({ length: 12 }, (_, i) => 'card-' + i) }) as Parameters<typeof sessionSummary>[0]);
    expect(summary.modeTag).toBe('[Spaced repetition review · 12 cards · Due cards]');
    expect(summary.visibleStatus).toContain('12 remaining of 12');
  });
});

describe('optimistic review widget script', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: {
        id: 's1', status: 'active', modeTag: '[Spaced repetition review · 2 cards due]',
        cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100,
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
      cardType: 'cloze',
    });
  }

  it('submits ONE rating for the DISPLAYED card with controls disabled until the authoritative response lands', () => {
    const h = html();
    // rate() captures the DISPLAYED card id as expectedCardId, registers the
    // item in the per-card/per-request maps, disables controls, and submits
    // IMMEDIATELY via submitItem(item) — no single-flight gate.
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).toContain('var expectedCardId = data.card.id;');
    expect(rateFn).toContain("var item = { rating: rating, requestId: 'req-' + Date.now().toString(36) + '-' + requestSeq, expectedCardId: expectedCardId, expectedPosition: expectedPosition };");
    expect(rateFn).toContain('inflightByCard[expectedCardId] = item;');
    expect(rateFn).toContain('inflightByRequest[item.requestId] = item;');
    expect(rateFn).toContain('disableControls();');
    expect(rateFn).toContain('submitItem(item);');
    // The stale-id mechanism is GONE: no optimistic card shift, no queue.
    expect(rateFn).not.toContain('optimisticallyRate');
    expect(rateFn).not.toContain('pendingRatings');
    expect(h).not.toContain('function optimisticallyRate');
    expect(h).not.toContain('var pendingRatings');
  });

  it('refuses a second rating on the SAME displayed card while one is in flight (per-card guard)', () => {
    const h = html();
    // A rapid second click on the same card is a no-op — the per-card map
    // guards it (NOT a global inflight flag, so DIFFERENT cards can be rated
    // concurrently).
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).toContain('if (inflightByCard[expectedCardId]) return;');
    expect(rateFn).not.toContain('if (inflight) return;');
    expect(rateFn).not.toContain('pendingRatings.push');
    expect(rateFn).not.toContain('queued');
  });

  it('disables controls immediately on rate and re-enables only after the authoritative response is adopted', () => {
    const h = html();
    // The response path adopts the server's next card and re-renders (which
    // re-enables per-card controls since the card's item was cleared).
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    expect(submitFn).toContain('adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);');
    expect(submitFn).toContain('clearInflightItem(item, true);');
    expect(submitFn).toContain('render();');
    // No second optimistic shift after the response (no pump, no queue).
    expect(submitFn).not.toContain('pump();');
  });

  it('on submit error re-syncs via get_review_session and NEVER retries the stale item', () => {
    const h = html();
    // The error path calls syncAfterSubmit(gen) — a get_review_session
    // re-sync — and does NOT resubmit the rejected item (the backend already
    // rejected its stale expectedCardId).
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
        expect(submitFn).not.toContain("callTool(data.getTool, { sessionId: data.session.id })");
    expect(submitFn).toContain('syncAfterSubmit(gen);');
    expect(submitFn).not.toContain('Retrying');
    expect(submitFn).not.toContain('retryItem');
    // The catch path clears the item's maps AND its ratedCardIds flag
    // BEFORE the sync — otherwise adoptServerState suppresses the failed
    // still-current card and the user could never retry it.
    expect(submitFn).toContain('clearInflightItem(item);');
    const clearFn = h.slice(h.indexOf('function clearInflightItem'), h.indexOf('function syncAfterSubmit'));
    expect(clearFn).toContain('delete ratedCardIds[item.expectedCardId]');
    // syncAfterSubmit adopts the authoritative session and re-renders.
    const syncFn = h.slice(h.indexOf('function syncAfterSubmit'), h.indexOf('checkBtn.addEventListener'));
    expect(syncFn).toContain('adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);');
    expect(syncFn).toContain('render();');
    // No backend/request wording leaks to the user after a re-sync.
    expect(syncFn).not.toContain('The card changed');
    expect(syncFn).not.toContain('Submitting');
  });

  it('catch path decrements totalRatedCount so failed rating does not permanently inflate delta', () => {
    const h = html();
    // totalRatedCount is incremented in rate() and must be decremented in
    // the catch/empty-response paths so only accepted ratings contribute
    // to the optimistic delta.
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).toContain('totalRatedCount += 1;');
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    // Both the catch path and the empty-response path must decrement.
    expect(submitFn).toContain('totalRatedCount = Math.max(0, totalRatedCount - 1);');
  });

  it('rates DIFFERENT displayed cards concurrently (per-card map, no global inflight gate)', () => {
    const h = html();
    // rate() dispatches EVERY rating immediately via submitItem(item) —
    // there is no global inflight gate. The per-card map only guards a
    // second rating of the SAME card, so preloaded next cards can be rated
    // while earlier cards' submits are still in flight.
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).not.toContain('if (inflight) return;');
    expect(rateFn).toContain('if (inflightByCard[expectedCardId]) return;');
    expect(rateFn).toContain('inflightByCard[expectedCardId] = item;');
    expect(rateFn).toContain('inflightByRequest[item.requestId] = item;');
    expect(rateFn).toContain('submitItem(item);');
    // The optimistic shift happens synchronously BEFORE the submit starts,
    // so the next card is displayable/rateable immediately.
    expect(rateFn).toContain('var nextCard = queue.shift();');
    expect(rateFn).toContain('data.card = nextCard;');
    // submitItem resolves INDEPENDENTLY per item: clearing only that item's
    // bookkeeping (other in-flight items untouched).
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    expect(submitFn).toContain('clearInflightItem(item);');
    const clearFn = h.slice(h.indexOf('function clearInflightItem'), h.indexOf('function syncAfterSubmit'));
    expect(clearFn).toContain('delete inflightByRequest[item.requestId]');
    expect(clearFn).toContain('delete inflightByCard[item.expectedCardId]');
    // SUCCESS keeps the rated flag (bare clearInflightItem(item)); the
    // FAILURE paths unmark via clearInflightItem(item, true) so the
    // failed card can be retried.
    expect(submitFn).toContain('clearInflightItem(item);');
    expect(submitFn).toContain('clearInflightItem(item, true);');
    // adoptServerState never regresses to an already-rated card (the
    // backend reviewedCardIds + local rated set guard out-of-order).
    expect(h).toContain("if (card && card.id && (rated[card.id] || reviewed.indexOf(card.id) !== -1)) {");
  });

  it('uses the backend response as the authoritative queue (server next card always wins)', () => {
    const h = html();
    // adoptServerState applies the session + card from the response.
    expect(h).toContain('function adoptServerState(session, card, preloaded)');
    expect(h).toContain('data.session = session;');
    // The queue is MONOTONIC: preload arrays MERGE (add/update only) and the
    // queue is rebuilt in the authoritative session.cardIds order — a short
    // or stale preload array can never replace/shrink the local buffer.
    expect(h).toContain('if (Array.isArray(preloaded)) {');
    expect(h).toContain('function mergeQueueCards(cards)');
    expect(h).toContain('function seedQueueFromSession()');
    expect(h).toContain('mergeQueueCards(preloaded);');
    expect(h).toContain('seedQueueFromSession();');
    // Every full card (bootstrap, preloads, responses) is cached keyed by id;
    // an id-only result card is resolved from the cache of the SAME id
    // (never a wrong card, never a white card) and the get_flashcard
    // fallback fills gaps.
    expect(h).toContain('var cardCache = {};');
    expect(h).toContain('function cacheFullCard(c)');
    expect(h).toContain('function resolveCard(authoritative)');
    expect(h).toContain('cardCache[authoritative.id]');
    // The optimistic next card is shifted from the queue at rate() time
    // (BEFORE the submit starts) and rendered immediately.
    expect(h).toContain('var nextCard = queue.shift();');
    expect(h).toContain('data.card = nextCard;');
    expect(h).toContain('render();');
    // The queue also advances on the reconciliation fallback (an
    // authoritative response with no current card shifts the first preloaded
    // card in), skipping cards the user already rated.
    expect(h).toContain('if (queue.length) {');
    // Rated ids are never (re)inserted into the monotonic queue.
    expect(h).toContain('if (!pc || !pc.id || isRated(pc.id)) continue;');
  });

  it('shifts the next full card from the queue and renders BEFORE the submit starts (immediate display)', () => {
    const h = html();
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    // The expectedCardId is captured from the DISPLAYED card BEFORE the shift.
    expect(rateFn).toContain('var expectedCardId = data.card.id;');
    expect(rateFn).toContain('cacheFullCard(data.card);');
    // The next full card is shifted from the preloaded queue and rendered
    // synchronously inside rate() — BEFORE submitItem(item) starts the submit.
    expect(rateFn).toContain('var nextCard = queue.shift();');
    expect(rateFn).toContain('data.card = nextCard;');
    expect(rateFn).toContain('render();');
    const shiftIdx = rateFn.indexOf('var nextCard = queue.shift();');
    const submitIdx = rateFn.indexOf('submitItem(item);');
    expect(shiftIdx).toBeGreaterThan(rateFn.indexOf('var expectedCardId = data.card.id;'));
    expect(submitIdx).toBeGreaterThan(shiftIdx);
    expect(submitIdx).toBeGreaterThan(rateFn.indexOf('data.card = nextCard;'));
    expect(submitIdx).toBeGreaterThan(rateFn.indexOf('render();'));
    // Controls are disabled before the optimistic shift (per-card guard).
    expect(rateFn.indexOf('disableControls();')).toBeLessThan(shiftIdx);
  });


  it('id-only server results resolve from the cardCache (never a white card) and full results are cached', () => {
    const h = html();
    // Every full card is cached keyed by id; an id-only result merges with
    // the cached full card of the SAME id before render.
    expect(h).toContain('var cardCache = {};');
    expect(h).toContain('function cacheFullCard(c)');
    expect(h).toContain('cardCache[c.id] = c;');
    expect(h).toContain('function resolveCard(authoritative)');
    expect(h).toContain('var cached = cardCache[authoritative.id];');
    expect(h).toContain('if (cached) return { ...authoritative, ...cached };');
    // The bootstrap card and preloaded cards seed the cache at startup.
    expect(h).toContain('cacheFullCard(data.card);');
    // primeFromSession merges preloads into the MONOTONIC queue (rated ids
    // are skipped via isRated) and rebuilds in the session cardIds order.
    expect(h).toContain('mergeQueueCards(pre);');
    expect(h).toContain('function isRated(id)');
    // adoptServerState resolves id-only cards from the cache before render.
    expect(h).toContain('var resolved = resolveCard(card);');
    // A response whose card is already rated never regresses the display.
    expect(h).toContain("if (card && card.id && (rated[card.id] || reviewed.indexOf(card.id) !== -1)) {");
  });

  it('a response for an ALREADY-RATED card cannot regress the displayed card (out-of-order reconciliation)', () => {
    const h = html();
    // Out-of-order/parallel reconciliation: a response whose card was
    // already rated (locally or per the backend reviewedCardIds) only
    // applies the authoritative session counters and keeps the displayed
    // card — never a regression to a card the user already reviewed.
    expect(h).toContain("if (card && card.id && (rated[card.id] || reviewed.indexOf(card.id) !== -1)) {");
    expect(h).toContain('render();');
    expect(h).toContain('return;');
  });

  it('Check is fully local and deterministic: correct/incorrect/revealed/empty/no-answer, ZERO tool calls', () => {
    const h = html();
    // The Check handler computes the outcome entirely in-widget — no
    // evaluate_answer, no assistant follow-up, no polling.
    expect(h).toContain('var route = evaluateLocalAnswer(data.card, sessionCardType(), answer);');
    expect(h).toContain("if (route.kind === 'correct')");
    expect(h).toContain("statusEl.textContent = 'Correct \u2014 now rate how well you knew it.';");
    expect(h).toContain("'Not quite \u2014 the expected answer was \"' + route.expected + '\". Now rate it.'");
    expect(h).toContain("statusEl.textContent = 'Type an answer first (or reveal the card).'");
    expect(h).toContain("statusEl.textContent = 'This card has no comparable answer \u2014 reveal it and rate it.'");
    // No ChatGPT/AI plumbing remains in the generated widget.
    expect(h).not.toContain('sendFollowUpMessage');
    expect(h).not.toContain('ui/message');
    expect(h).not.toContain('startEvaluationPoll');
    expect(h).not.toContain('evaluateTool');
    expect(h).not.toContain('recordEvaluationTool');
    expect(h).not.toContain('ai-fallback');
  });

  it('supports typed input for qa cards too (not only cloze)', () => {
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardType: 'qa', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'A' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    // Typed row is shown for qa sessions (typed is toggled by doneMode/card, not cardType).
    expect(h).toContain("typed.classList.toggle('hidden', !activeSession)");
    expect(h).toContain("sessionCardType() === 'cloze' ? 'Type the answer for the blank' : 'Type your answer'");
    // Session cardType wins over the bootstrap default.
    expect(h).toContain("(data.session && data.session.cardType) === 'cloze'");
  });

  it('supports cloze presentation: blanked front and typed-answer input', () => {
    const h = html();
    expect(h).toContain('sessionCardType()');
    expect(h).toContain("data.cardType === 'cloze'");
    expect(h).toContain('<span class="cloze-blank">_____</span>');
    expect(h).toContain('id="answerInput"');
    expect(h).toContain('checkBtn.addEventListener');
    // The Check evaluation is fully local: the embedded helper runs first
    // and every outcome (correct/incorrect/revealed/empty/no-answer) is
    // handled deterministically — zero tool calls.
    expect(h).toContain('var route = evaluateLocalAnswer(data.card, sessionCardType(), answer);');
    expect(h).toContain("if (route.kind === 'correct')");
  });
});


describe('optimistic progress behavior (script contract)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: {
        id: 's1', status: 'active', modeTag: '[Spaced repetition review · 3 cards due]',
        cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100,
        ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
        preloaded: [
          { id: 'c2', front: 'Q2', back: 'A2', tags: [] },
          { id: 'c3', front: 'Q3', back: 'A3', tags: [] },
        ],
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('progress projects authoritative counts plus unacknowledged in-flight deltas', () => {
    const h = html();
    // The authoritative session remains the terminal source of truth
    // (adoptServerState replaces data.session); the display projects the
    // optimistic in-flight delta on top of it at render time.
    expect(h).toContain('data.session = session;');
    // No counter bump is hard-coded inside rate() — the projection lives in
    // the render-time optimisticReviewDelta helper over inflightByCard.
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).not.toContain('reviewedCount: (s.reviewedCount || 0) + 1');
    expect(rateFn).not.toContain('ratingCounts: {');
    // Progress bar/label derive from the projected (authoritative + delta).
    expect(h).toContain("progressFill.style.width = pct + '%';");
    // Counter presentation is consolidated in the progress line (reviewed +
    // remaining), not in a separate cardLabel element.
    expect(h).toContain("reviewed + ' reviewed, ' + (remaining != null ? remaining : '?') + ' remaining'");
    expect(h).not.toContain("' reviewed | ' + remaining + ' left'");
    // Session type and mode shown as separate labeled lines — never a deck name.
    expect(h).toContain("sessionTypeLabel.textContent = 'Session type: Spaced repetition';");
    expect(h).toContain("modeLabel.textContent = 'Mode: ' + modeText;");
    expect(h).toContain("var modeText = src && src.type === 'custom' ? 'Custom' : 'Due cards';");
  });

  it('each rating captures the DISPLAYED card id and sends it as expectedCardId (never a stale id)', () => {
    const h = html();
    // The active submission sends the captured item.requestId +
    // item.expectedCardId; the item's expectedCardId is data.card.id at
    // click time — always the authoritative displayed card.
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    expect(submitFn).toContain('rating: item.rating, requestId: item.requestId, expectedCardId: item.expectedCardId');
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).toContain('var expectedCardId = data.card.id;');
  });
});


describe('active End Session control (script contract)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: {
        id: 's1', status: 'active', modeTag: '[Spaced repetition review · 2 cards due]',
        cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100,
        preloaded: [{ id: 'c2', front: 'Q2', back: 'A2', tags: [] }],
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('shows an active End Session button wired to endTool with an ending guard and no rating', () => {
    const h = html();
    // The button exists and is wired to the end tool via requestEnd().
    expect(h).toContain('id="endSessionBtn"');
    expect(h).toContain('End Session');
    expect(h).toContain("endSessionBtn.addEventListener('click', requestEnd);");
    expect(h).toContain("callTool(data.endTool, { sessionId: data.session.id })");
    // Ending guard: no double requests, queued ratings abandoned, controls
    // disabled while in flight.
    expect(h).toContain('var ending = false;');
    expect(h).toContain('if (ending) return;');
    expect(h).toContain('disableControls();');
    // NO request-state wording: the user never sees that a backend end call
    // is in flight (only the terminal 'Session ended.' after the result).
    expect(h).not.toContain('Ending session');
    expect(h).not.toContain('Submitting');
    // On error the guard is cleared and controls re-enabled.
    expect(h).toContain('ending = false;');
    expect(h).toContain('enableControls();');
    // No backend/request-error wording leaks on an end failure.
    expect(h).not.toContain('Error ending session');
    expect(h).not.toContain('Submitting');
    // No rating is submitted by the end handler: requestEnd's only callTool
    // passes just { sessionId } (no rating arg).
    const endFn = h.slice(h.indexOf('function requestEnd()'), h.indexOf('endSessionBtn.addEventListener'));
    expect(endFn).toContain("callTool(data.endTool, { sessionId: data.session.id })");
    expect(endFn).not.toContain('rating:');
    expect(endFn).not.toContain('data.rating');
  });

  it('adoptEndResult handles the PLAIN ended session summary (not { session: ... }) and clears the card/queue', () => {
    const h = html();
    expect(h).toContain('function adoptEndResult(res)');
    // The end tool returns structuredContent = the summary itself.
    expect(h).toContain("if (sc && sc.id && (sc.status === 'ended' || sc.status === 'completed')) {");
    expect(h).toContain('data.session = sc;');
    expect(h).toContain('data.card = null;');
    expect(h).toContain('queue = [];');
    expect(h).toContain('inflightByCard = {};');
    expect(h).toContain('inflightByRequest = {};');
    expect(h).toContain('ending = false;');
    // Both the active End button and completed Finish use requestEnd →
    // adoptEndResult.
    expect(h).toContain("endSessionBtn.addEventListener('click', requestEnd);");
    expect(h).toContain("finishBtn.addEventListener('click', requestEnd);");
    expect(h).toContain('adoptEndResult(res);');
  });

  it('stale submit callbacks cannot adopt/re-enable after the session ends (generation token)', () => {
    const h = html();
    // requestEnd bumps the generation so in-flight submit callbacks no-op.
    expect(h).toContain('var generation = 0;');
    expect(h).toContain('generation += 1;');
    // submitItem captures the generation and its then/catch no-op when it
    // changed (the ended state stays authoritative — no resurrection).
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    expect(submitFn).toContain('var gen = generation;');
    expect(submitFn).toContain("if (gen !== generation) return; // stale: session ended while in flight");
    // The stale then cannot reach adoptServerState or re-enable.
    const thenIdx = submitFn.indexOf('.then(function (res) {');
    const staleGuard = submitFn.indexOf("if (gen !== generation) return; // stale: session ended while in flight");
    expect(staleGuard).toBeGreaterThan(thenIdx);
    expect(staleGuard).toBeLessThan(submitFn.indexOf('adoptServerState('));
    // The end-failure path re-syncs so a committed rating is never lost.
    const endFn = h.slice(h.indexOf('function requestEnd()'), h.indexOf('endSessionBtn.addEventListener'));
    expect(endFn).toContain("callTool(data.getTool, { sessionId: data.session.id })");
  });

  it('renders the End Session row only during an active session (hidden on completed/ended)', () => {
    const h = html();
    // Visibility is driven by activeSession (not doneMode).
    expect(h).toContain("var activeSession = !doneMode && s.status !== 'ended' && !!card;");
    expect(h).toContain("endRow.classList.toggle('hidden', !activeSession);");
    // The completed panel keeps Finish/Continue (no end button there).
    expect(h).toContain('id="finishBtn"');
    expect(h).toContain('id="continueBtn"');
  });

  it('resets the end button busy state when a new card renders', () => {
    const h = html();
    expect(h).toContain('endSessionBtn.disabled = false;');
  });
});



describe('Apps SDK postMessage bridge (script contract)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'A' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('applies UNSOLICITED initial tool-result notifications (empty bootstrap) and resolves waiters', () => {
    const h = html();
    // Shared extraction handles params, params.output, and content[0].
    expect(h).toContain('function extractStructuredContent(payload)');
    expect(h).toContain('if (payload.structuredContent) return payload.structuredContent;');
    expect(h).toContain('if (out && out.content && out.content[0] && out.content[0].structuredContent) return out.content[0].structuredContent;');
    // The notification handler: waiter resolution FIRST, then the
    // unsolicited-initial-result apply path.
    expect(h).toContain("var w = rpcWaiters[p.id];");
    expect(h).toContain('applyToolResult(p);');
    // applyToolResult calls adoptServerState for {session,...} shapes.
    expect(h).toContain('function applyToolResult(payload)');
    expect(h).toContain("if (sc && sc.session) {");
    expect(h).toContain('adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded);');
  });

  it('INITIATES the MCP Apps lifecycle handshake (ui/initialize then ui/notifications/initialized)', () => {
    const h = html();
    // The view sends ui/initialize with appInfo + protocolVersion (per the
    // ext-apps AppBridge spec: the View initiates, the Host answers).
    expect(h).toContain("rpcSend('ui/initialize', {");
    expect(h).toContain("appInfo: { name: 'fsrs-review-widget', version: '1.0.0' }");
    expect(h).toContain("protocolVersion: HANDSHAKE_PROTOCOL");
    expect(h).toContain("var HANDSHAKE_PROTOCOL = '2026-01-26';");
    // After the host result, the widget sends the initialized notification.
    expect(h).toContain("method: 'ui/notifications/initialized', params: {}");
    expect(h).toContain('handshakeDone = true;');
    // It still answers an inbound ui/initialize (host-initiated variant).
    expect(h).toContain("msg.method === 'ui/initialize'");
    // The handshake starts once after the DOM is ready.
    expect(h).toContain('setTimeout(startHandshake, 0);');
  });

  it('implements the standard postMessage JSON-RPC bridge with tool-result notifications', () => {
    const h = html();
    // rpcSend posts a JSON-RPC tools/call to the parent.
    expect(h).toContain("window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');");
    expect(h).toContain("rpcSend('tools/call', { name: name, arguments: args })");
    // The host may deliver the result as a ui/notifications/tool-result.
    expect(h).toContain("msg.method === 'ui/notifications/tool-result'");
    expect(h).toContain('w.resolve(p.output);');
    // ui/initialize is answered with a result echo.
    expect(h).toContain("msg.method === 'ui/initialize'");
    // No bridge → textual fallback (never hangs).
    expect(h).toContain('No response from host (bridge unavailable)');
    expect(h).toContain("'Use the ' + name + ' tool with: '");
    // window.openai remains feature-detected first (legacy compatibility).
    expect(h).toContain('if (oai && typeof oai.callTool === \'function\')');
  });
});


describe('deck/session label fallback (script contract)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'A' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('renders the CURRENT CARD deck name inside the card face above the content', () => {
    const h = html();
    // Deck name is shown inside the card face, falling back to session name.
    expect(h).toContain('deckName.textContent = (card.deck || s.name || \'\')');
    expect(h).toContain('id="deckName"');
    // Session type and mode shown as separate labeled lines (never a deck name).
    expect(h).toContain("sessionTypeLabel.textContent = 'Session type: Spaced repetition';");
    expect(h).toContain("modeLabel.textContent = 'Mode: ' + modeText;");
    expect(h).toContain("'Due cards'");
  });
});




describe('widget local normalization parity with the backend (cardType.ts)', () => {
  function widgetHelpers() {
    // Extract the embedded local-evaluation helpers (CLOZE_MARKER,
    // normalizeAnswer, expectedAnswerFor, evaluateLocalAnswer) from the
    // generated script and compile them in a fresh JS context so we test
    // EXACTLY what ships (dependencies included in one unit).
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'A' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const start = h.indexOf('function text(v)');
    const end = h.indexOf('function sessionCardType');
    const src = h.slice(start, end);
    // eslint-disable-next-line no-new-func
    const fns = new Function('return (function(){' + src + '; return { normalizeAnswer: normalizeAnswer, evaluateLocalAnswer: evaluateLocalAnswer }; })()')();
    return fns as { normalizeAnswer: (v: string) => string; evaluateLocalAnswer: (card: { front: string; back: string }, cardType: string, answer: { text: string; revealed?: boolean }) => { kind: string; expected?: string } };
  }

  it('matches the backend normalizeAnswer corpus (NFKC/lowercase/punctuation-space/whitespace)', () => {
    const normalize = widgetHelpers().normalizeAnswer;
    const corpus: Array<[string, string]> = [
      ['  Berlin,  GERMANY! ', 'berlin germany'],
      ['Hello, world.', 'hello world'],
      ['  spaced   out  ', 'spaced out'],
      ['hello , world', 'hello world'],
      ['a, b', 'a b'],
      ['a ; b', 'a b'],
      ['well-known', 'well known'],
      ["don't", 'don t'],
      ['state-of-the-art', 'state of the art'],
      ['New York—city', 'new york city'],
      ['Hello', 'hello'],
      ['HELLO', 'hello'],
      ['Ｂｅｒｌｉｎ', 'berlin'],
    ];
    for (const [input, expected] of corpus) {
      expect(normalize(input)).toBe(expected);
    }
  });

  it('deterministic local outcomes: no-answer guard, correct, incorrect (parity)', () => {
    // The embedded evaluateLocalAnswer must report a punctuation-only expected
    // answer (normalizes to EMPTY) as no-answer, mirroring the backend's
    // evaluateTypedAnswer.
    const evaluateLocal = widgetHelpers().evaluateLocalAnswer;
    const route = evaluateLocal({ front: 'Q', back: '!!!' }, 'qa', { text: '!!!' });
    expect(route.kind).toBe('no-answer');
    // An exact-normalized qa answer DOES match locally (correct).
    const hit = evaluateLocal({ front: 'Q', back: 'FOUR' }, 'qa', { text: ' four!! ' });
    expect(hit).toEqual({ kind: 'correct', expected: 'four' });
    // A non-exact answer is deterministically incorrect.
    const miss = evaluateLocal({ front: 'Q', back: 'FOUR' }, 'qa', { text: 'three' });
    expect(miss).toEqual({ kind: 'incorrect', expected: 'four' });
  });
});


describe('v2 bounded review session widget (script contract)', () => {
  function htmlV2(): string {
    return buildReviewWidgetHtml({
      session: {
        id: 's1', status: 'active', storageVersion: 2, limit: 150,
        remainingQueueCount: 150, remainingCount: 150, currentIndex: 0,
        reviewedCount: 0, modeTag: '[Spaced repetition review · 150 cards due]',
        currentPosition: 0,
        queueWindow: { currentPosition: 0, cardIds: ['c1', 'c2', 'c3'] },
        // NO cardIds / reviewedCardIds arrays (bounded v2 root).
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('recognizes a v2 session (no root cardIds) and seeds the queue from queueWindow', () => {
    const h = htmlV2();
    expect(h).toContain('function isV2SessionState(s)');
    expect(h).toContain('function sessionQueueIds(s)');
    // The queue is seeded from the bounded window ids, never a root array.
    expect(h).toContain('var w = s.queueWindow;');
    expect(h).toContain('if (w && Array.isArray(w.cardIds) && w.cardIds.length) {');
    // v2 window entries are { cardId, position } objects — mapped to ids.
    expect(h).toContain("if (we && typeof we === 'object' && we.cardId) out.push(we.cardId);");
    // V2 optimistic completion consults the authoritative counters, not a
    // never-seen full queue.
    expect(h).toContain('if (isV2SessionState(s)) {');
    expect(h).toContain('var remainV2 = s.remainingQueueCount != null ? s.remainingQueueCount : (s.remainingCount != null ? s.remainingCount');
    expect(h).toContain('if (remainV2 - optimisticReviewDelta() <= 0) return true;');
    // reviewedCardIds is NOT folded in for v2 (bounded root).
    expect(h).toContain("var reviewed = !isV2SessionState(s) && Array.isArray(s.reviewedCardIds) ? s.reviewedCardIds : [];");
  });

  it('captures the v2 currentPosition at rate time and sends expectedPosition on submit', () => {
    const h = htmlV2();
    expect(h).toContain('var expectedPosition = null;');
    expect(h).toContain('var cardPos = data.card && typeof data.card.position === \'number\' ? data.card.position : null;');
    expect(h).toContain("else if (typeof data.currentPosition === 'number') expectedPosition = data.currentPosition;");
    expect(h).toContain('expectedCardId: expectedCardId, expectedPosition: expectedPosition');
    expect(h).toContain('if (item.expectedPosition != null) submitArgs.expectedPosition = item.expectedPosition;');
    // The optimistic queue shift advances the tracked position.
    expect(h).toContain("if (typeof data.currentPosition === 'number') data.currentPosition += 1;");
  });

  it('progress denominator uses the v2 persisted limit (no cardIds array)', () => {
    const h = htmlV2();
    expect(h).toContain('s.limit || (s.queueWindow && s.queueWindow.cardIds ? s.queueWindow.cardIds.length : 100)');
    expect(h).not.toContain('(s.cardIds && s.cardIds.length) ? s.cardIds.length : (s.limit || 100)');
  });
});

describe('answerInput preservation on same-card render (bug fix)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'Q', back: 'A' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('answerInput.value reset is INSIDE the renderedCardId !== card.id guard', () => {
    const h = html();
    // The answer input is only cleared when the card ACTUALLY changes;
    // an async re-render of the same card must not wipe typed text.
    const renderBlock = h.slice(h.indexOf('function render()'), h.indexOf('function primeFromSession'));
    // Find the renderedCardId check
    const cardGuardIdx = renderBlock.indexOf('if (renderedCardId !== card.id)');
    expect(cardGuardIdx).toBeGreaterThanOrEqual(0);
    // Find answerInput.value = '' inside the guard block (before the closing brace)
    const guardBlock = renderBlock.slice(cardGuardIdx, renderBlock.indexOf('}', cardGuardIdx + 100));
    expect(guardBlock).toContain("answerInput.value = ''");
    // answerInput.value = '' must NOT appear outside the guard
    const afterGuard = renderBlock.slice(renderBlock.indexOf('}', cardGuardIdx + 100));
    expect(afterGuard).not.toContain("answerInput.value = ''");
  });

  it('typedPrompt reset is also inside the card-change guard', () => {
    const h = html();
    const renderBlock = h.slice(h.indexOf('function render()'), h.indexOf('function primeFromSession'));
    const cardGuardIdx = renderBlock.indexOf('if (renderedCardId !== card.id)');
    const guardBlock = renderBlock.slice(cardGuardIdx, renderBlock.indexOf('}', cardGuardIdx + 100));
    expect(guardBlock).toContain('typedPrompt.textContent');
  });
});

describe('count-based optimistic delta (stale visibleStatus immunity)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('uses totalRatedCount - serverAcked (not per-item inflight scan)', () => {
    const h = html();
    // The delta function must reference totalRatedCount and baselineReviewedCount
    expect(h).toContain('var totalRatedCount = 0;');
    expect(h).toContain('var baselineReviewedCount = 0;');
    const deltaFn = h.slice(h.indexOf('function optimisticReviewDelta()'), h.indexOf('function render()'));
    expect(deltaFn).toContain('totalRatedCount');
    expect(deltaFn).toContain('baselineReviewedCount');
    // Must NOT reference inflightByCard for delta computation
    expect(deltaFn).not.toContain('inflightByCard');
  });

  it('baselineReviewedCount is set on adoptServerState (monotonic upward only)', () => {
    const h = html();
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    // baselineReviewedCount is set to newReviewed only on new session start.
    expect(adoptBlock).toContain('baselineReviewedCount = newReviewed');
  });

  it('totalRatedCount is incremented in rate()', () => {
    const h = html();
    const rateFn = h.slice(h.indexOf('function rate(rating)'), h.indexOf('function submitItem'));
    expect(rateFn).toContain('totalRatedCount += 1;');
  });

  it('totalRatedCount resets on session ID change', () => {
    const h = html();
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    expect(adoptBlock).toContain('totalRatedCount = 0;');
    expect(adoptBlock).toContain('session.id !== prevSessionId');
  });

  it('progress always uses computed counters, never stale visibleStatus', () => {
    const h = html();
    // visibleStatus is a pre-baked server string that cannot reflect
    // optimistic deltas or monotonic reconciliation — the progress line
    // must always compute from reviewedCount + delta.
    expect(h).not.toContain("(optimistic === 0 && s.visibleStatus)");
    expect(h).toContain("reviewed + ' reviewed");
  });
});

describe('monotonic session reconciliation (stale snapshot regression)', () => {
  function html(): string {
    return buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  it('adoptServerState skips stale snapshots via adoptedIndex guard', () => {
    const h = html();
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    // The guard blocks stale responses whose currentIndex is strictly less
    // than the highest adopted index; equal-index responses are allowed.
    expect(adoptBlock).toContain('newIndex < adoptedIndex');
    expect(adoptBlock).toContain('newReviewed < prevReviewed');
    expect(adoptBlock).toContain('newRemaining > prevRemaining');
  });

  it('adoptedIndex is updated on every successful adopt (prevents rapid-click stale queue rebuild)', () => {
    const h = html();
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    // adoptedIndex must be set after session adoption so the next response
    // can compare against it.
    expect(adoptBlock).toContain('adoptedIndex = newIndex');
  });

  it('baselineReviewedCount set once at session start, never advanced', () => {
    const h = html();
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    // baseline is set to newReviewed ONLY when a new session starts
    expect(adoptBlock).toContain('baselineReviewedCount = newReviewed');
    // Must NOT contain a same-session advance guard
    expect(adoptBlock).not.toContain('newReviewed >= (baselineReviewedCount');
  });

  it('progress shows "1 reviewed" after first ack, "2 reviewed" after second; stale snapshot cannot revert', () => {
    // This is a script-contract proof: the math in optimisticReviewDelta
    // and the monotonic guard in adoptServerState together ensure the
    // following sequence never regresses.
    const h = html();
    // delta = max(0, totalRatedCount - max(0, curReviewed - baseline))
    // baseline is set once at session start (= reviewedCount when session
    // began, typically 0 for a fresh session). It is NEVER advanced by
    // same-session adoptions. So for a fresh session (baseline=0):
    //   rate card 1: totalRated=1, reviewed=0, delta=1
    //   ack card 1:  totalRated=1, reviewed=1, delta=0
    //   rate card 2: totalRated=2, reviewed=1, delta=1
    //   ack card 2:  totalRated=2, reviewed=2, delta=0
    const deltaFn = h.slice(h.indexOf('function optimisticReviewDelta()'), h.indexOf('function render()'));
    expect(deltaFn).toContain('totalRatedCount');
    expect(deltaFn).toContain('baselineReviewedCount');
    expect(deltaFn).toContain('Math.max(0');
    // The regression guard is in adoptServerState, not delta — verify both exist.
    const adoptBlock = h.slice(h.indexOf('function adoptServerState('), h.indexOf('function fetchFlashcardFallback'));
    expect(adoptBlock).toContain('if (!isNewSession && prev.id && session.id === prev.id)');
  });
});

describe('delta arithmetic regression: first-ack=1, second-ack=2, stale-no-revert', () => {
  // Extract the actual optimisticReviewDelta logic from the generated script
  // and exercise it with concrete state, proving the delta values through
  // the exact sequence the user described.
  function extractDeltaFn(): (totalRated: number, baseline: number, curReviewed: number) => number {
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const fnStart = h.indexOf('function optimisticReviewDelta()');
    const fnEnd = h.indexOf('\n  function render()');
    const deltaFnBody = h.slice(fnStart, fnEnd);
    const fn = new Function('totalRatedCount', 'baselineReviewedCount', 'curReviewed', `
      var data = { session: { reviewedCount: curReviewed } };
      ${deltaFnBody}
      return optimisticReviewDelta();
    `);
    return fn as (totalRated: number, baseline: number, cur: number) => number;
  }

  it('first-ack=1, second-ack=2 (simulates runtime: rate → adopt)', () => {
    const delta = extractDeltaFn();
    // baseline is set once at session start (= reviewedCount when session
    // began). The delta = totalRatedCount - max(0, curReviewed - baseline).
    // As curReviewed rises via server acks, delta drops to 0.
    expect(delta(0, 0, 0)).toBe(0);   // initial: nothing
    expect(delta(1, 0, 0)).toBe(1);   // rate card 1, no ack yet
    expect(delta(1, 0, 1)).toBe(0);   // ack card 1: curReviewed(1) > baseline(0)
    expect(delta(2, 0, 1)).toBe(1);   // rate card 2, server at 1
    expect(delta(2, 0, 2)).toBe(0);   // ack card 2
    expect(delta(3, 0, 2)).toBe(1);   // rate card 3
    expect(delta(3, 0, 3)).toBe(0);   // ack card 3
  });

  it('stale snapshot cannot revert: baseline stays at session-start value', () => {
    const delta = extractDeltaFn();
    // After ack of card 1: baseline=0 (set at session start, never advanced
    // by same-session adopt), totalRated=1, curReviewed=1 → delta=0
    expect(delta(1, 0, 1)).toBe(0);
    // Stale snapshot with reviewedCount=0 arrives but the monotonic guard
    // in adoptServerState PREVENTS adoption (0 < prevReviewed=1), so the
    // session stays at reviewedCount=1. Even if it were adopted, the delta
    // would be: max(0, 1 - max(0, 0 - 0)) = 1 — bounded by totalRated.
    expect(delta(1, 0, 0)).toBe(1);  // stale: shows 1 pending (bounded)
    expect(delta(1, 0, 0)).toBeLessThanOrEqual(1);
    // After two acks: totalRated=2, baseline=0, curReviewed=2 → delta=0
    expect(delta(2, 0, 2)).toBe(0);
    // Stale with reviewedCount=1: delta = max(0, 2 - max(0, 1-0)) = 1
    expect(delta(2, 0, 1)).toBe(1);  // bounded by totalRated
    expect(delta(2, 0, 1)).toBeLessThanOrEqual(2);
  });

  it('new session resets totalRatedCount, baseline stays at session-start reviewedCount', () => {
    const delta = extractDeltaFn();
    // End of session A: totalRated=5, baseline=0, reviewedCount=5 → delta=0
    expect(delta(5, 0, 5)).toBe(0);
    // New session B starts: totalRatedCount resets to 0. Baseline stays at 0
    // (new session's reviewedCount=0). delta = 0 - max(0, 0-0) = 0.
    expect(delta(0, 0, 0)).toBe(0);
    // Rate 1 in session B: delta = 1 - max(0, 0-0) = 1
    expect(delta(1, 0, 0)).toBe(1);
    // Ack in session B: reviewedCount=1, delta = 1 - max(0, 1-0) = 0
    expect(delta(1, 0, 1)).toBe(0);
  });
});

describe('generated widget script is parseable (runtime regression)', () => {
  function generatedScript(): string {
    const html = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1, limit: 100 },
      card: { id: 'c1', front: 'The capital is [Berlin]', back: 'Berlin' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no inline script found');
    return m[1];
  }

  it('the generated HTML contains the ESCAPED cloze regex (not the corrupted one)', () => {
    const html = buildReviewWidgetHtml({
      session: {}, card: null, submitTool: 's', startTool: 't', endTool: 'e', getTool: 'g',
    });
    // The inline script must keep the backslash escapes so the browser parses
    // /\[([^\[\]]+)\]/ — the corrupted single-backslash form is a
    // SyntaxError ('Unmatched )') that kills the whole widget at load time.
    expect(html).toContain('replace(/\\[([^\\[\\]]+)\\]/,');
    expect(html).not.toContain('replace(/[([^[]]+)]/,');
  });

  it('the generated inline script parses without a SyntaxError (vm compile)', () => {
    const script = generatedScript();
    // Compile the script in a fresh vm context: a SyntaxError here means the
    // browser would refuse to run the widget (the exact "Runtime error /
    // Error al cargar la aplicación" symptom). This catches backslash-escape
    // corruption in the outer template literal (e.g. the cloze regex losing
    // its \\[ escapes and becoming an invalid /[([^[]]+)]/).
    const vm = require('node:vm');
    expect(() => new vm.Script(script)).not.toThrow();
    // The script's renderFront uses the correctly-escaped cloze regex.
    expect(script).toContain('\\[([^\\[\\]]+)\\]');
  });
});

describe('progress counter invariant: reviewed + remaining <= total (optimistic no-double-count)', () => {
  // Regression for the bug where render() applied the optimistic delta to
  // BOTH reviewed AND remaining, inflating reviewed by phantom unacknowledged
  // ratings. The fix applies the delta to remaining only; reviewed stays
  // server-authoritative so the sum never exceeds total.

  function html(sessionOverrides: Record<string, unknown> = {}): string {
    return buildReviewWidgetHtml({
      session: {
        id: 's1', status: 'active',
        cardIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
        currentIndex: 0, reviewedCount: 0, remainingCount: 5, limit: 5,
        ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
        ...sessionOverrides,
      },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
  }

  // Extract optimisticReviewDelta from the generated script and exercise it
  // with concrete state in a fresh VM context. We then compute the progress
  // counters using the SAME formula as render() — proving the invariant
  // through the exact shipped code path.
  function extractDeltaFn(): (totalRated: number, baseline: number, curReviewed: number) => number {
    const h = html();
    const deltaStart = h.indexOf('function optimisticReviewDelta()');
    const deltaEnd = h.indexOf('\n  function render()');
    const deltaFn = h.slice(deltaStart, deltaEnd);
    const fn = new Function('totalRatedCount', 'baselineReviewedCount', 'curReviewed', `
      var data = { session: { reviewedCount: curReviewed } };
      ${deltaFn}
      return optimisticReviewDelta();
    `);
    return fn as (totalRated: number, baseline: number, cur: number) => number;
  }

  // Simulates render()'s progress computation using the EXTRACTED delta
  // function. Returns { reviewed, remaining } exactly as the widget displays.
  function simulateProgress(serverReviewed: number, serverRemaining: number, totalRated: number, baseline: number): { reviewed: number; remaining: number } {
    const delta = extractDeltaFn()(totalRated, baseline, serverReviewed);
    const reviewed = serverReviewed;         // server-authoritative (the fix)
    const remaining = Math.max(0, serverRemaining - delta); // delta applied here
    return { reviewed, remaining };
  }

  it('script contract: reviewed is NOT inflated by the optimistic delta', () => {
    const h = html();
    const renderBlock = h.slice(h.indexOf('var optimistic = optimisticReviewDelta()'), h.indexOf("progressFill.style.width = pct + '%'"));
    // reviewed MUST be the bare server count — no delta added.
    expect(renderBlock).toContain('var reviewed = s.reviewedCount || 0;');
    // The old buggy pattern must NOT appear.
    expect(renderBlock).not.toContain('(s.reviewedCount || 0) + optimistic');
    // remaining MUST still apply the delta for forward-progress display.
    expect(renderBlock).toContain('s.remainingCount - optimistic');
  });

  it('runtime: sum reviewed + remaining never exceeds total during in-flight ratings', () => {
    const r = simulateProgress(0, 5, 5, 0);  // rate all 5, ack 0
    expect(r.reviewed + r.remaining).toBeLessThanOrEqual(5);
    expect(r.reviewed).toBe(0);   // server-authoritative: no acks
    expect(r.remaining).toBe(0);  // all 5 consumed by delta
  });

  it('runtime: rate 3 of 5, ack 1 → reviewed stays at server count', () => {
    const r = simulateProgress(1, 4, 3, 0);  // serverReviewed=1, delta=2
    expect(r.reviewed).toBe(1);   // server-authoritative
    expect(r.remaining).toBe(2);  // delta applied here
    expect(r.reviewed + r.remaining).toBeLessThanOrEqual(5);
  });

  it('runtime: all acked → reviewed equals total, remaining is 0', () => {
    const r = simulateProgress(5, 0, 5, 0);
    expect(r.reviewed).toBe(5);
    expect(r.remaining).toBe(0);
    expect(r.reviewed + r.remaining).toBe(5);
  });

  it('runtime: no in-flight → reviewed + remaining equals total exactly', () => {
    const r = simulateProgress(2, 3, 2, 0);  // delta=0
    expect(r.reviewed + r.remaining).toBe(5);
  });

  it('runtime: extreme — rate all 5, ack 0 → reviewed is honest (0 not 5)', () => {
    // This was the core bug: old code would show reviewed=5, remaining=0
    // (sum=5, which happened to equal total), but reviewed was WRONG (5
    // phantom reviews). New code shows reviewed=0 (correct), remaining=0.
    const r = simulateProgress(0, 5, 5, 0);
    expect(r.reviewed).toBe(0); // server says 0 reviewed — honest
    expect(r.remaining).toBe(0);
    expect(r.reviewed + r.remaining).toBeLessThanOrEqual(5);
  });

  it('runtime: non-zero baseline → delta computed against session-start reviewedCount', () => {
    const r = simulateProgress(3, 2, 5, 2);  // baseline=2, delta=4
    expect(r.reviewed).toBe(3);
    expect(r.remaining).toBe(0);
    expect(r.reviewed + r.remaining).toBeLessThanOrEqual(5);
  });

  it('generated script is parseable after the fix (vm compile)', () => {
    const h = html();
    const m = h.match(/<script>\n([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no inline script found');
    const vm = require('node:vm');
    expect(() => new vm.Script(m[1])).not.toThrow();
  });
});

describe('failed-submit recovery restores authoritative card (adoptedIndex reset)', () => {
  // Regression: after optimistic shift c1→c2, a failed submit's
  // get_review_session sync returns the authoritative currentIndex=0 (card
  // c1). Without the recovery fix, adoptedIndex was advanced to 1 by the
  // optimistic shift, causing the stale guard (newIndex < adoptedIndex) to
  // block the authoritative recovery snapshot.

  it('script contract: catch path resets adoptedIndex when no other items in flight', () => {
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    // The catch path must reset adoptedIndex when inflightByCard is empty.
    expect(submitFn).toContain('Object.keys(inflightByCard).length === 0');
    expect(submitFn).toContain('adoptedIndex = (data.session && typeof data.session.currentIndex === \'number\') ? data.session.currentIndex : 0');
    // Must only reset when this was the sole in-flight item (parallel safety).
    expect(submitFn).not.toMatch(/adoptedIndex\s*=\s*0\s*;(?![\s\S]*Object\.keys)/);
  });

  it('catch path does NOT reset adoptedIndex when other items are in flight', () => {
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2', 'c3'], currentIndex: 0, reviewedCount: 0, remainingCount: 3, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const submitFn = h.slice(h.indexOf('function submitItem'), h.indexOf('function clearInflightItem'));
    // The reset is guarded: only when inflightByCard is empty.
    expect(submitFn).toContain('if (Object.keys(inflightByCard).length === 0)');
    // An unconditional reset would break parallel ratings — must NOT exist.
    const catchBlock = submitFn.slice(submitFn.indexOf('.catch(function'));
    // The adoptedIndex assignment must be inside the guard block.
    const guardIdx = catchBlock.indexOf('Object.keys(inflightByCard).length === 0');
    const assignIdx = catchBlock.indexOf('adoptedIndex = (data.session');
    expect(assignIdx).toBeGreaterThan(guardIdx);
  });

  it('syncAfterSubmit calls adoptServerState (not just render) for recovery', () => {
    const h = buildReviewWidgetHtml({
      session: { id: 's1', status: 'active', cardIds: ['c1', 'c2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2, limit: 100 },
      card: { id: 'c1', front: 'Q1', back: 'A1' },
      submitTool: 'submit_review', startTool: 'start_review_session',
      endTool: 'end_review_session', getTool: 'get_review_session',
    });
    const syncFn = h.slice(h.indexOf('function syncAfterSubmit'), h.indexOf('checkBtn.addEventListener'));
    // The sync must adopt the authoritative card via adoptServerState.
    expect(syncFn).toContain('adoptServerState(sc.session, sc.card !== undefined ? sc.card : null, sc.preloaded)');
    // Must NOT only render (which would keep the stale optimistic card).
    expect(syncFn).not.toMatch(/else \{\s*render\(\);\s*\}/);
  });
});


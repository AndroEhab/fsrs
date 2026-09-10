import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FirebaseBridge } from './bridge';
import { registerFlashcardTools, formatTimestamp, cardSummary, deckSummary, cardImageSummary, sessionSummary } from './tools';

/* ------------------------------------------------------------------ */
/* In-memory harness: register tools against a fake bridge, drive via  */
/* an MCP client over an in-memory transport. No live HTTP calls.      */
/* ------------------------------------------------------------------ */

type Handler = (url: string, init: RequestInit) => Response;

function fakeBridge(handler: Handler, apiKey = 'test-key'): FirebaseBridge {
  return new FirebaseBridge({ apiKey, baseUrl: 'https://test.invalid', fetchFn: jest.fn(async (url, init) => handler(String(url), init ?? {})) });
}

const ts = { _seconds: 1700000000, _nanoseconds: 0 };

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'card-1',
  front: 'What is FSRS?',
  back: 'Free Spaced Repetition Scheduler',
  deck: 'spaced-repetition',
  tags: ['algorithm'],
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
});

/** Builds a wire-format review session for response mocks. */
function sessionWire(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    apiKeyName: 'Test Key',
    status: 'active',
    mode: 'spaced_repetition',
    limit: 100,
    dueCount: 1,
    cardIds: ['card-1'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 1,
    truncated: false,
    continuationAvailable: false,
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
    startedAt: ts,
    ...overrides,
  };
}

/** v2 wire session: bounded root (no cardIds/reviewedCardIds arrays). */
function sessionWireV2(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = sessionWire(id, overrides);
  delete base.cardIds;
  delete base.reviewedCardIds;
  delete base.processedRequestIds;
  return { ...base, storageVersion: 2, ...overrides };
}

async function setup(handler: Handler): Promise<{ client: Client; bridge: FirebaseBridge; calls: Handler }> {
  const bridge = fakeBridge(handler);
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerFlashcardTools(server, bridge);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, bridge, calls: handler };
}

describe('registerFlashcardTools', () => {
  it('advertises the forty tools with correct names and descriptions', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'attach_image', 'bulk_create_flashcards', 'bulk_delete_flashcards', 'bulk_enroll_cards',
      'bulk_update_flashcards', 'count_flashcards', 'create_deck', 'create_flashcard', 'delete_deck',
      'delete_flashcard', 'delete_tag', 'end_review_session', 'export_apkg', 'get_deck',
      'get_due_flashcards', 'get_enrollment_status', 'get_flashcard', 'get_review_history',
      'get_review_session', 'get_study_stats', 'get_top_lapsed_cards',
      'health', 'import_apkg', 'list_card_images', 'list_decks', 'list_flashcards',
      'list_tags', 'merge_tags', 'migrate_review_events', 'remove_image', 'rename_tag', 'reset_flashcards',
      'review_flashcard', 'search_cards', 'set_due_date',
      'start_review_session', 'submit_review', 'suspend_flashcards', 'unsuspend_flashcards',
      'update_deck', 'update_flashcard', 'upload_image',
    ]);

    const create = tools.tools.find((t) => t.name === 'create_flashcard');
    expect(create?.description).toContain('Creates a flashcard');
    expect(create?.inputSchema).toBeDefined();
    const props = (create?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['back', 'deck', 'deckId', 'front', 'suspended', 'tags', 'topic']);
    expect(props.front).toMatchObject({ type: 'string', minLength: 1, maxLength: 10000 });
    expect(props.tags).toMatchObject({ type: 'array' });

    const due = tools.tools.find((t) => t.name === 'get_due_flashcards');
    expect(due?.description).toContain('due for review');
    const dueProps = (due?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(dueProps).sort()).toEqual(['deck', 'deckId', 'pageSize', 'pageToken']);
 
    const health = tools.tools.find((t) => t.name === 'health');
    expect(health?.description).toContain('flashcard service is reachable');
    expect(health?.description).not.toContain('persistent review session');

    const review = tools.tools.find((t) => t.name === 'review_flashcard');
    expect(review?.description).toContain('FSRS rating');
    const reviewProps = (review?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(reviewProps).sort()).toEqual(['id', 'rating', 'reviewAt']);

    // Deck tools exist with the right shapes.
    const createDeck = tools.tools.find((t) => t.name === 'create_deck');
    const createDeckProps = (createDeck?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(createDeckProps).sort()).toEqual(['description', 'name']);

    const deleteDeck = tools.tools.find((t) => t.name === 'delete_deck');
    expect(deleteDeck?.description).toContain('NOT to its cards');
    expect(deleteDeck?.description).toContain('reassigned to Uncategorized');

    // Tag tools exist with the right shapes and annotations.
    const listTags = tools.tools.find((t) => t.name === 'list_tags');
    const listTagsProps = (listTags?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(listTagsProps).sort()).toEqual(['pageSize', 'pageToken']);
    expect(listTags?.description).toContain('case-sensitive');
    expect(listTags?.description).toContain('Read-only');

    const renameTag = tools.tools.find((t) => t.name === 'rename_tag');
    const renameProps = (renameTag?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(renameProps).sort()).toEqual(['from', 'to']);
    expect(renameTag?.description).toContain('from');
    expect(renameTag?.description).toContain('to');
    expect(renameTag?.description).toContain('case-sensitive');

    const deleteTag = tools.tools.find((t) => t.name === 'delete_tag');
    const deleteTagProps = (deleteTag?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(deleteTagProps).sort()).toEqual(['name']);
    expect(deleteTag?.description).toContain('DESTRUCTIVE');
    expect(deleteTag?.description).toContain('explicitly asks');

    const mergeTags = tools.tools.find((t) => t.name === 'merge_tags');
    const mergeProps = (mergeTags?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(mergeProps).sort()).toEqual(['from', 'to']);
    expect(mergeTags?.description).toContain('UNION');
  });

  it('health calls GET /health and returns status content', async () => {
    const { client } = await setup(() => new Response(JSON.stringify({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Service status: ok') }]);
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('create_flashcard sends the input to the backend and returns structured content with ISO timestamps', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/createFlashcardHandler');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
      expect(JSON.parse(String(init.body))).toEqual({ front: 'Q', back: 'A', deck: 'D', tags: ['t'], topic: 'geo', suspended: true });
      return new Response(JSON.stringify(card({ id: 'new-1', front: 'Q', back: 'A', deck: 'D', tags: ['t'], topic: 'geo', suspended: true })), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'create_flashcard', arguments: { front: 'Q', back: 'A', deck: 'D', tags: ['t'], topic: 'geo', suspended: true } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Created flashcard new-1') }]);
    expect((result as { structuredContent?: Record<string, unknown> }).structuredContent).toEqual({
      id: 'new-1', front: 'Q', back: 'A', deck: 'D', tags: ['t'], topic: 'geo', suspended: true,
      createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z', due: '2023-11-14T22:13:20.000Z',
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [],
    });
  });

  it('create_flashcard fails with a clear message when the API key is missing', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'create_flashcard', arguments: { front: 'Q', back: 'A' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('list_flashcards passes filters and returns cards + nextPageToken', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/listFlashcardsHandler?deck=Math&pageSize=2');
      return new Response(JSON.stringify({ cards: [card(), card({ id: 'card-2', front: 'F2' })], nextPageToken: 'card-2' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'list_flashcards', arguments: { deck: 'Math', pageSize: 2 } });
    const sc = (result as { structuredContent?: { cards?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.cards).toHaveLength(2);
    expect(sc?.nextPageToken).toBe('card-2');
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('More results available') }]);
  });

  it('get_flashcard returns the card by id', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/getFlashcardHandler/card-1');
      return new Response(JSON.stringify(card()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_flashcard', arguments: { id: 'card-1' } });
    expect((result as { structuredContent?: { id?: string } }).structuredContent?.id).toBe('card-1');
  });

  it('get_due_flashcards passes deck/pageSize and returns due cards + token', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/dueFlashcardsHandler?deck=Math&pageSize=5');
      return new Response(JSON.stringify({
        cards: [card({ state: 1, stability: 2.3, difficulty: 6.4, reps: 1, lapses: 0, reviewLog: [{ rating: 3, state: 0, review: ts, due: ts, stability: 2.3, difficulty: 6.4, reps: 1, lapses: 0 }] })],
        nextPageToken: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_due_flashcards', arguments: { deck: 'Math', pageSize: 5 } });
    const sc = (result as { structuredContent?: { cards?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.cards).toHaveLength(1);
    expect(sc?.nextPageToken).toBeNull();
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('due') }]);
    const first = sc?.cards?.[0] as Record<string, unknown> | undefined;
    expect(first?.state).toBe(1);
    expect(first?.reviewLog).toHaveLength(1);
  });

  it('get_due_flashcards reports no due cards', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ cards: [], nextPageToken: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_due_flashcards', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('No flashcards are due') }]);
  });

  it('search_cards serializes every filter to the query string and returns cards + token', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/searchCardsHandler?search=paris&tagsAll=a%2Cb&review=due&decks=deck-1&deckNames=Spanish&suspended=false&createdFrom=2026-08-01&createdTo=2026-08-31&updatedFrom=2026-08-01T00%3A00%3A00.000Z&pageSize=2');
      return new Response(JSON.stringify({ cards: [card({ topic: 'europe', suspended: false })], nextPageToken: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({
      name: 'search_cards',
      arguments: {
        search: 'paris', tagsAll: ['a', 'b'], review: 'due', decks: ['deck-1'], deckNames: ['Spanish'],
        suspended: false, createdFrom: '2026-08-01', createdTo: '2026-08-31', updatedFrom: '2026-08-01T00:00:00.000Z',
        pageSize: 2,
      },
    });
    const sc = (result as { structuredContent?: { cards?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.cards).toHaveLength(1);
    expect(sc?.nextPageToken).toBe('tok');
    const first = sc?.cards?.[0] as Record<string, unknown> | undefined;
    expect(first?.topic).toBe('europe');
    expect(first?.suspended).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('More results available') }]);
  });

  it('search_cards reports no matches', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ cards: [], nextPageToken: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'search_cards', arguments: { search: 'zzz' } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('No flashcards match') }]);
  });

  it('search_cards surfaces a backend validation error (mutually exclusive tag modes) as isError', async () => {
    const { client } = await setup(() => new Response('{}', { status: 500 }));
    const result = await client.callTool({ name: 'search_cards', arguments: { tagsAny: ['a'], tagsNot: ['b'] } });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('count_flashcards sends filters to /countFlashcardsHandler and returns counts text + structured content', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/countFlashcardsHandler?deck=Spanish&groupBy=deck');
      return new Response(JSON.stringify({
        counts: { total: 12, new: 4, learning: 2, mature: 6, due: 5 },
        byDeck: [
          { deckId: 'deck-1', deck: 'Spanish', counts: { total: 10, new: 3, learning: 2, mature: 5, due: 4 } },
          { deckId: null, deck: null, counts: { total: 2, new: 1, learning: 0, mature: 1, due: 1 } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'count_flashcards', arguments: { deck: 'Spanish', groupBy: 'deck' } });
    expect((result as { structuredContent?: { counts?: Record<string, unknown>; byDeck?: unknown[] } }).structuredContent).toEqual({
      counts: { total: 12, new: 4, learning: 2, mature: 6, due: 5 },
      byDeck: [
        { deckId: 'deck-1', deck: 'Spanish', counts: { total: 10, new: 3, learning: 2, mature: 5, due: 4 } },
        { deckId: null, deck: null, counts: { total: 2, new: 1, learning: 0, mature: 1, due: 1 } },
      ],
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('12 total');
    expect(text).toContain('4 new');
    expect(text).toContain('5 due');
    expect(text).toContain('By deck:');
    expect(text).toContain('(no deck): 2 total');
  });

  it('count_flashcards reports plain counts for the whole library when no filters are given', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/countFlashcardsHandler');
      return new Response(JSON.stringify({ counts: { total: 0, new: 0, learning: 0, mature: 0, due: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'count_flashcards', arguments: {} });
    expect((result as { structuredContent?: { counts?: Record<string, unknown> } }).structuredContent?.counts).toEqual({ total: 0, new: 0, learning: 0, mature: 0, due: 0 });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toBe('0 total · 0 new · 0 learning · 0 mature · 0 due');
    expect(text).not.toContain('By deck:');
  });

  it('review_flashcard POSTs rating and returns updated card + log item', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/reviewFlashcardHandler/card-1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ rating: 3, reviewAt: '2026-08-28T10:00:00.000Z' });
      const updated = card({ state: 1, stability: 2.3065, difficulty: 2.11810397, reps: 1, lapses: 0, reviewLog: [{ rating: 3, state: 0, review: ts, due: ts, stability: 2.3065, difficulty: 2.11810397, reps: 1, lapses: 0 }] });
      return new Response(JSON.stringify({
        card: updated,
        reviewLogItem: updated.reviewLog[0],
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'review_flashcard', arguments: { id: 'card-1', rating: 3, reviewAt: '2026-08-28T10:00:00.000Z' } });
    const sc = (result as { structuredContent?: { card?: Record<string, unknown>; reviewLogItem?: Record<string, unknown> } }).structuredContent;
    expect(sc?.card?.state).toBe(1);
    expect(sc?.reviewLogItem?.rating).toBe(3);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Reviewed flashcard card-1') }]);
  });

  it('reset_flashcards POSTs { ids } to /resetFlashcardsHandler and returns reset summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/resetFlashcardsHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['card-1', 'card-2'] });
      const reset = card({ state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, due: ts, reviewLog: [] });
      return new Response(JSON.stringify({ ids: ['card-1', 'card-2'], count: 2, cards: [reset, { ...reset, id: 'card-2' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'reset_flashcards', arguments: { ids: ['card-1', 'card-2'] } });
    const sc = (result as { structuredContent?: { ids?: string[]; count?: number; cards?: unknown[] } }).structuredContent;
    expect(sc?.ids).toEqual(['card-1', 'card-2']);
    expect(sc?.count).toBe(2);
    expect(sc?.cards).toHaveLength(2);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Reset 2 flashcards to new') }]);
  });

  it('reset_flashcards mentions skipped missing ids in the text', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ ids: ['card-1'], count: 1, cards: [card({ state: 0, reps: 0 })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'reset_flashcards', arguments: { ids: ['card-1', 'missing'] } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('1 id(s) did not exist and were skipped') }]);
  });

  it('set_due_date POSTs { ids, due } and returns the updated card summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/setFlashcardDueDateHandler');
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['card-1'], due: '2026-09-15' });
      return new Response(JSON.stringify({ ids: ['card-1'], count: 1, cards: [card({ due: ts })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'set_due_date', arguments: { ids: ['card-1'], due: '2026-09-15' } });
    const sc = (result as { structuredContent?: { ids?: string[]; count?: number } }).structuredContent;
    expect(sc?.ids).toEqual(['card-1']);
    expect(sc?.count).toBe(1);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Set due date on 1 flashcard to 2026-09-15') }]);
  });

  it('set_due_date fails with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const result = await client.callTool({ name: 'set_due_date', arguments: { ids: ['card-1'], due: '2026-09-15' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('suspend_flashcards POSTs { ids } to /suspendFlashcardsHandler and returns suspended summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/suspendFlashcardsHandler');
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['card-1'] });
      return new Response(JSON.stringify({ ids: ['card-1'], count: 1, cards: [card({ suspended: true })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'suspend_flashcards', arguments: { ids: ['card-1'] } });
    const sc = (result as { structuredContent?: { ids?: string[]; count?: number; cards?: unknown[] } }).structuredContent;
    expect(sc?.count).toBe(1);
    expect((sc?.cards?.[0] as { suspended?: boolean }).suspended).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Suspended 1 flashcard') }]);
  });

  it('unsuspend_flashcards POSTs { ids } to /unsuspendFlashcardsHandler and returns active summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/unsuspendFlashcardsHandler');
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['card-1'] });
      return new Response(JSON.stringify({ ids: ['card-1'], count: 1, cards: [card({ suspended: false })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'unsuspend_flashcards', arguments: { ids: ['card-1'] } });
    const sc = (result as { structuredContent?: { ids?: string[]; count?: number; cards?: unknown[] } }).structuredContent;
    expect(sc?.count).toBe(1);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Unsuspended 1 flashcard') }]);
  });

  it('scheduling tools reject duplicate ids client-side (schema) before any backend call', async () => {
    const seen: string[] = [];
    const handler: Handler = (_url) => { seen.push(_url); return new Response('{}', { status: 200 }); };
    const { client } = await setup(handler);
    const calls = [
      { name: 'reset_flashcards', arguments: { ids: ['card-1', 'card-1'] } },
      { name: 'set_due_date', arguments: { ids: ['card-1', 'card-1'], due: '2026-09-15' } },
      { name: 'suspend_flashcards', arguments: { ids: ['card-1', 'card-1'] } },
      { name: 'unsuspend_flashcards', arguments: { ids: ['card-1', 'card-1'] } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Duplicate card ids are not allowed');
    }
    expect(seen).toEqual([]); // rejected locally — the backend is never called
  });

  it('update_flashcard sends only provided fields', async () => {
    const handler: Handler = (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ back: 'New answer', topic: null, suspended: true });
      return new Response(JSON.stringify(card({ back: 'New answer', suspended: true })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'update_flashcard', arguments: { id: 'card-1', back: 'New answer', topic: null, suspended: true } });
    expect((result as { structuredContent?: { back?: string } }).structuredContent?.back).toBe('New answer');
  });

  it('delete_flashcard calls DELETE and returns the deleted id', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/deleteFlashcardHandler/card-1');
      expect(init.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'delete_flashcard', arguments: { id: 'card-1' } });
    expect((result as { structuredContent?: { deleted?: boolean } }).structuredContent).toEqual({ id: 'card-1', deleted: true });
  });

  it('bulk_create_flashcards POSTs all cards to /bulkCreateFlashcardsHandler and returns created summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/bulkCreateFlashcardsHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        cards: [
          { front: 'Q1', back: 'A1', deck: 'D', tags: ['t'], topic: 'geo', suspended: true },
          { front: 'Q2', back: 'A2' },
        ],
      });
      return new Response(JSON.stringify({
        cards: [
          card({ id: 'new-1', front: 'Q1', back: 'A1', deck: 'D', tags: ['t'], topic: 'geo', suspended: true }),
          card({ id: 'new-2', front: 'Q2', back: 'A2', deck: undefined }),
        ],
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({
      name: 'bulk_create_flashcards',
      arguments: { cards: [{ front: 'Q1', back: 'A1', deck: 'D', tags: ['t'], topic: 'geo', suspended: true }, { front: 'Q2', back: 'A2' }] },
    });
    const sc = (result as { structuredContent?: { cards?: unknown[] } }).structuredContent;
    expect(sc?.cards).toHaveLength(2);
    expect((sc?.cards?.[0] as { id?: string }).id).toBe('new-1');
    expect((sc?.cards?.[1] as { id?: string }).id).toBe('new-2');
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Created 2 flashcards') }]);
  });

  it('bulk_create_flashcards fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({
      name: 'bulk_create_flashcards',
      arguments: { cards: [{ front: 'Q', back: 'A' }] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('bulk_update_flashcards POSTs items with ids and returns updated summaries', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/bulkUpdateFlashcardsHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ cards: [{ id: 'card-1', front: 'New', topic: 'geo', suspended: false }] });
      return new Response(JSON.stringify({ cards: [card({ front: 'New', topic: 'geo', suspended: false })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({
      name: 'bulk_update_flashcards',
      arguments: { cards: [{ id: 'card-1', front: 'New', topic: 'geo', suspended: false }] },
    });
    const sc = (result as { structuredContent?: { cards?: unknown[] } }).structuredContent;
    expect(sc?.cards).toHaveLength(1);
    expect((sc?.cards?.[0] as { front?: string }).front).toBe('New');
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Updated 1 flashcard') }]);
  });

  it('create_deck POSTs to /createDeckHandler and returns the deck summary', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/createDeckHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ name: 'Spanish', description: 'Vocab' });
      return new Response(JSON.stringify({ id: 'd1', name: 'Spanish', description: 'Vocab', createdAt: ts, updatedAt: ts }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'create_deck', arguments: { name: 'Spanish', description: 'Vocab' } });
    expect((result as { structuredContent?: { id?: string; name?: string } }).structuredContent).toEqual({
      id: 'd1', name: 'Spanish', description: 'Vocab',
      createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Created deck d1') }]);
  });

  it('create_deck fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'create_deck', arguments: { name: 'D' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('list_decks GETs /listDecksHandler and returns decks + token', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/listDecksHandler?pageSize=10');
      return new Response(JSON.stringify({ decks: [{ id: 'd1', name: 'Spanish', createdAt: ts, updatedAt: ts }], nextPageToken: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'list_decks', arguments: { pageSize: 10 } });
    const sc = (result as { structuredContent?: { decks?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.decks).toHaveLength(1);
    expect(sc?.nextPageToken).toBeNull();
  });

  it('get_deck GETs /getDeckHandler/{id}', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/getDeckHandler/d1');
      return new Response(JSON.stringify({ id: 'd1', name: 'Spanish', createdAt: ts, updatedAt: ts }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_deck', arguments: { id: 'd1' } });
    expect((result as { structuredContent?: { name?: string } }).structuredContent?.name).toBe('Spanish');
  });

  it('update_deck PATCHes to /updateDeckHandler/{id} and returns updated deck', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/updateDeckHandler/d1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ name: 'Spanish II' });
      return new Response(JSON.stringify({ id: 'd1', name: 'Spanish II', createdAt: ts, updatedAt: ts }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'update_deck', arguments: { id: 'd1', name: 'Spanish II' } });
    expect((result as { structuredContent?: { name?: string } }).structuredContent?.name).toBe('Spanish II');
  });

  it('list_tags GETs /listTagsHandler and returns tags + nextPageToken', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/listTagsHandler?pageSize=2');
      return new Response(JSON.stringify({
        tags: [{ name: 'algorithm', cardCount: 3 }, { name: 'spanish', cardCount: 1 }],
        nextPageToken: 'spanish',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'list_tags', arguments: { pageSize: 2 } });
    const sc = (result as { structuredContent?: { tags?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.tags).toEqual([{ name: 'algorithm', cardCount: 3 }, { name: 'spanish', cardCount: 1 }]);
    expect(sc?.nextPageToken).toBe('spanish');
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('algorithm (3 cards)') }]);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('More results available') }]);
  });

  it('list_tags reports no tags and omits the pagination hint', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ tags: [], nextPageToken: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'list_tags', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'No tags found.' }]);
    expect((result as { structuredContent?: { nextPageToken?: string | null } }).structuredContent?.nextPageToken).toBeNull();
  });

  it('list_tags fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'list_tags', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('rename_tag POSTs {from,to} to /renameTagHandler and returns affectedCards', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/renameTagHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ from: 'old', to: 'new' });
      return new Response(JSON.stringify({ affectedCards: 4 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'rename_tag', arguments: { from: 'old', to: 'new' } });
    expect((result as { structuredContent?: { affectedCards?: number } }).structuredContent).toEqual({ affectedCards: 4 });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Renamed tag "old" → "new" on 4 cards') }]);
  });

  it('rename_tag reports a successful no-op for a missing from tag', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ affectedCards: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'rename_tag', arguments: { from: 'ghost', to: 'new' } });
    expect((result as { structuredContent?: { affectedCards?: number } }).structuredContent?.affectedCards).toBe(0);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('No cards carried "ghost"') }]);
  });

  it('rename_tag rejects from === to client-side (no backend call)', async () => {
    const seen: string[] = [];
    const handler: Handler = (url) => { seen.push(String(url)); return new Response('{}', { status: 200 }); };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'rename_tag', arguments: { from: 'same', to: 'same' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('from and to must be different tag names');
    expect(seen).toEqual([]);
  });

  it('rename_tag fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'rename_tag', arguments: { from: 'a', to: 'b' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('delete_tag POSTs {name} to /deleteTagHandler and returns affectedCards', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/deleteTagHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ name: 'old' });
      return new Response(JSON.stringify({ affectedCards: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'delete_tag', arguments: { name: 'old' } });
    expect((result as { structuredContent?: { affectedCards?: number } }).structuredContent).toEqual({ affectedCards: 7 });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Deleted tag "old" from 7 cards') }]);
  });

  it('delete_tag reports a successful no-op for a missing name', async () => {
    const handler: Handler = () => new Response(JSON.stringify({ affectedCards: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'delete_tag', arguments: { name: 'ghost' } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('No cards carried "ghost"') }]);
  });

  it('delete_tag fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'delete_tag', arguments: { name: 'old' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('merge_tags POSTs {from,to} to /mergeTagsHandler and returns affectedCards', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/mergeTagsHandler');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ from: 'a', to: 'b' });
      return new Response(JSON.stringify({ affectedCards: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'merge_tags', arguments: { from: 'a', to: 'b' } });
    expect((result as { structuredContent?: { affectedCards?: number } }).structuredContent).toEqual({ affectedCards: 9 });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Merged tag "a" into "b" on 9 cards') }]);
  });

  it('merge_tags rejects from === to client-side (no backend call)', async () => {
    const seen: string[] = [];
    const handler: Handler = (url) => { seen.push(String(url)); return new Response('{}', { status: 200 }); };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'merge_tags', arguments: { from: 'x', to: 'x' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('from and to must be different tag names');
    expect(seen).toEqual([]);
  });

  it('attach_image POSTs to /attachImageHandler/{cardId} and returns card + image', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/attachImageHandler/card-1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg' });
      const withImage = card({ images: [{ id: 'img1', url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg', addedAt: ts }] });
      return new Response(JSON.stringify({ card: withImage, image: withImage.images[0] }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'attach_image', arguments: { id: 'card-1', url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg' } });
    const sc = (result as { structuredContent?: { card?: Record<string, unknown>; image?: Record<string, unknown> } }).structuredContent;
    expect((sc?.card?.images as unknown[])).toHaveLength(1);
    expect((sc?.image as { url?: string }).url).toBe('https://example.com/pic.jpg');
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Attached image to flashcard card-1') }]);
  });

  it('attach_image fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'attach_image', arguments: { id: 'card-1', url: 'https://example.com/pic.jpg' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('upload_image POSTs base64 to /uploadImageHandler/{cardId} and returns card + cloud metadata', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/uploadImageHandler/card-1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ data: 'aGVsbG8=', fileName: 'pic.jpg', contentType: 'image/jpeg', alt: 'A pic' });
      const withImage = card({ images: [{ id: 'img1', url: 'https://storage.example.com/card-images/card-1/img1-pic.jpg?signed=1', mimeType: 'image/jpeg', addedAt: ts, storagePath: 'card-images/card-1/img1-pic.jpg', downloadUrl: 'https://storage.example.com/card-images/card-1/img1-pic.jpg?signed=1', sizeBytes: 5 }] });
      return new Response(JSON.stringify({ card: withImage, image: withImage.images[0] }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'upload_image', arguments: { id: 'card-1', data: 'aGVsbG8=', fileName: 'pic.jpg', contentType: 'image/jpeg', alt: 'A pic' } });
    const sc = (result as { structuredContent?: { card?: Record<string, unknown>; image?: Record<string, unknown> } }).structuredContent;
    const img = sc?.image as { storagePath?: string; sizeBytes?: number; downloadUrl?: string };
    expect(img.storagePath).toBe('card-images/card-1/img1-pic.jpg');
    expect(img.sizeBytes).toBe(5);
    expect(img.downloadUrl).toContain('storage.example.com');
    expect((sc?.card?.images as unknown[])).toHaveLength(1);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Uploaded image to flashcard card-1') }]);
  });

  it('upload_image fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'upload_image', arguments: { id: 'card-1', data: 'aGk=', fileName: 'a.jpg', contentType: 'image/jpeg' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('upload_image rejects empty data client-side', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const result = await client.callTool({ name: 'upload_image', arguments: { id: 'card-1', data: '', fileName: 'a.jpg', contentType: 'image/jpeg' } });
    expect(result.isError).toBe(true);
  });

  it('list_card_images GETs /listImagesHandler/{cardId} and returns images', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/listImagesHandler/card-1');
      return new Response(JSON.stringify({ cardId: 'card-1', images: [{ id: 'img1', url: 'https://example.com/pic.jpg', alt: 'A pic', addedAt: ts }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'list_card_images', arguments: { id: 'card-1' } });
    const sc = (result as { structuredContent?: { images?: unknown[] } }).structuredContent;
    expect(sc?.images).toHaveLength(1);
    expect((sc?.images?.[0] as { url?: string }).url).toBe('https://example.com/pic.jpg');
  });

  it('start_review_session POSTs {deckId?} and returns session + first card with ISO timestamps', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/startReviewSessionHandler');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
      expect(JSON.parse(String(init.body))).toEqual({ deckId: 'deck-1' });
      return new Response(JSON.stringify({
        session: sessionWire('s1', { deckId: 'deck-1', dueCount: 3, cardIds: ['card-1', 'card-2'], remainingCount: 2 }),
        card: card(),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { deckId: 'deck-1' } });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: Record<string, unknown> | null } }).structuredContent;
    // QUIET mode: model-facing structuredContent is MINIMAL — no front/back,
    // no progress, no modeTag/visibleStatus, no ratings.
    expect(sc?.session).toMatchObject({
      id: 's1', status: 'active', mode: 'spaced_repetition',
      currentIndex: 0, reviewedCount: 0, remainingCount: 2,
    });
    expect((sc?.session as Record<string, unknown>).modeTag).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).visibleStatus).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).ratingCounts).toBeUndefined();
    expect((sc?.card as { id?: string }).id).toBe('card-1');
    expect((sc?.card as { front?: string }).front).toBeUndefined();
    // The FULL state (modeTag/visibleStatus/ratingCounts/card front) rides in
    // the hidden _meta['ui/widgetState'].
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; card?: { front?: string } } | undefined);
    expect(hidden?.session?.modeTag).toBe('[Spaced repetition review · 3 cards · Due cards]');
    expect(hidden?.session?.visibleStatus).toBe('active · 0 reviewed, 2 remaining of 2');
    expect(hidden?.card?.front).toBe('What is FSRS?');
    // QUIET mode: model-facing content is EMPTY (the widget owns display).
    expect(result.content).toEqual([]);
    // Minimal structuredContent carries the current card id.
    expect((sc?.card as { id?: string }).id).toBe('card-1');
  });

  it('start_review_session forwards all selectors and carries the source into the hidden widgetState', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/startReviewSessionHandler');
      expect(JSON.parse(String(init.body))).toEqual({ deck: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] });
      return new Response(JSON.stringify({
        session: sessionWire('s1', {
          source: { type: 'custom', deckName: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] },
        }),
        card: card(),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { deck: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] } });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown> } | undefined);
    // The source metadata rides in the hidden widget state for the widget.
    expect(hidden?.session?.source).toEqual({ type: 'custom', deckName: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] });
    // Deck-only sessions label the modeTag with the deck name.
  });

  it('sessionSummary labels a deck-only session modeTag with the deck name', () => {
    const summary = sessionSummary(sessionWire('s1', {
      dueCount: 5,
      source: { type: 'deck', deckId: 'deck-1', deckName: 'Spanish' },
    }) as Parameters<typeof sessionSummary>[0]);
    expect(summary.modeTag).toBe('[Spaced repetition review · 5 cards · Spanish]');
    expect(summary.source).toEqual({ type: 'deck', deckId: 'deck-1', deckName: 'Spanish' });
  });

  it('sessionSummary labels a custom session modeTag as Custom', () => {
    const summary = sessionSummary(sessionWire('s1', {
      dueCount: 3,
      source: { type: 'custom', tags: ['vocab'] },
    }) as Parameters<typeof sessionSummary>[0]);
    expect(summary.modeTag).toBe('[Spaced repetition review · 3 cards · Custom]');
  });

  it('start_review_session sends an empty body without filters and handles an empty queue (card null)', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/startReviewSessionHandler');
      expect(JSON.parse(String(init.body))).toEqual({});
      return new Response(JSON.stringify({ session: sessionWire('s-empty', { cardIds: [] }), card: null }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const sc = (result as { structuredContent?: { card?: unknown } }).structuredContent;
    expect(sc?.card).toBeNull();
    // Quiet: empty model-facing content.
    expect(result.content).toEqual([]);
  });

  it('start_review_session fails cleanly with no API key', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerFlashcardTools(server, fakeBridge(() => new Response('{}', { status: 200 }), ''));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CUELINGUA_API_KEY');
  });

  it('get_review_session GETs /getReviewSessionHandler/{sessionId} and returns current card', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/getReviewSessionHandler/s1');
      return new Response(JSON.stringify({ session: sessionWire('s1'), card: card({ front: 'Current?' }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_review_session', arguments: { sessionId: 's1' } });
    const sc = (result as { structuredContent?: { session?: { id?: string; status?: string }; card?: { id?: string } | null } }).structuredContent;
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    expect((sc?.session as Record<string, unknown>).modeTag).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).visibleStatus).toBeUndefined();
    // Minimal: card has only the id; the front rides in hidden widgetState.
    expect(sc?.card?.id).toBe('card-1');
    expect((sc?.card as { front?: string } | null | undefined)?.front).toBeUndefined();
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { card?: { front?: string } } | undefined);
    expect(hidden?.card?.front).toBe('Current?');
  });

  it('submit_review POSTs {rating,reviewAt?} and returns the NEXT card + advanced session', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/submitSessionReviewHandler/s1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' });
      return new Response(JSON.stringify({
        session: sessionWire('s1', {
          cardIds: ['card-1', 'card-2'], currentIndex: 1, reviewedCount: 1,
          ratingCounts: { again: 0, hard: 0, good: 1, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 } },
        }),
        card: card({ id: 'card-2', front: 'Next?' }),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'submit_review', arguments: { sessionId: 's1', rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' } });
    const sc = (result as { structuredContent?: { session?: { currentIndex?: number; reviewedCount?: number; status?: string }; card?: { id?: string; front?: string } | null } }).structuredContent;
    expect(sc?.session?.currentIndex).toBe(1);
    expect(sc?.session?.reviewedCount).toBe(1);
    expect(sc?.session?.status).toBe('active');
    expect((sc?.session as Record<string, unknown>).modeTag).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).visibleStatus).toBeUndefined();
    expect(sc?.card?.id).toBe('card-2');
    expect(result.content).toEqual([]);
  });

  it('submit_review rejects an out-of-range rating client-side (no write)', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const result = await client.callTool({ name: 'submit_review', arguments: { sessionId: 's1', rating: 9 } });
    expect(result.isError).toBe(true);
  });

  it('submit_review returns a null card and completed status when the queue is exhausted', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', { status: 'completed', currentIndex: 1, reviewedCount: 1 }),
      card: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'submit_review', arguments: { sessionId: 's1', rating: 4 } });
    const sc = (result as { structuredContent?: { session?: { status?: string }; card?: unknown } }).structuredContent;
    expect(sc?.session?.status).toBe('completed');
    expect(sc?.card).toBeNull();
    // All due cards were reviewed: quiet completion text (status conveys it).
    expect(result.content).toEqual([]);
  });

  it('submit_review completion on a LEGACY capped session still offers Continue (field kept for old docs)', async () => {
    // Sessions started after the cap removal never set continuationAvailable,
    // but legacy capped sessions stored it — the MCP must keep surfacing the
    // Finish/Continue choice for them (the widget shows it).
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', {
        status: 'completed', currentIndex: 100, reviewedCount: 100, dueCount: 150,
        cardIds: Array.from({ length: 100 }, (_, i) => 'card-' + i),
        truncated: true, continuationAvailable: true, remainingCount: 0,
      }),
      card: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'submit_review', arguments: { sessionId: 's1', rating: 4 } });
    // Quiet completion: empty model-facing content (the widget shows the
    // Finish/Continue choice).
    expect(result.content).toEqual([]);
  });

  it('end_review_session POSTs /endReviewSessionHandler/{sessionId} and returns the ended session', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/endReviewSessionHandler/s1');
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify(sessionWire('s1', { status: 'ended', endedAt: { _seconds: 1700000001, _nanoseconds: 0 } })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'end_review_session', arguments: { sessionId: 's1' } });
    const sc = (result as { structuredContent?: { status?: string; endedAt?: string } }).structuredContent;
    expect(sc?.status).toBe('ended');
    expect(sc?.endedAt).toBe('2023-11-14T22:13:21.000Z');
    expect(result.content).toEqual([]);
  });

  it('session tool inputs advertise the expected shapes', async () => {
    const { client } = await setup(() => new Response('{}', { status: 200 }));
    const tools = await client.listTools();
    const start = tools.tools.find((t) => t.name === 'start_review_session');
    const startProps = (start?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(startProps).sort()).toEqual(['cardIds', 'cardType', 'deck', 'deckId', 'name', 'repeatSessionId', 'tags']);
    expect(start?.description ?? '').not.toContain('ALWAYS repeat the session modeTag');
    expect(start?.description ?? '').toContain('MINIMAL model-facing state');
    const submit = tools.tools.find((t) => t.name === 'submit_review');
    const submitProps = (submit?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(submitProps).sort()).toEqual(['expectedCardId', 'expectedPosition', 'rating', 'requestId', 'reviewAt', 'sessionId']);
    expect(submit?.description).toContain('atomic');
    const get = tools.tools.find((t) => t.name === 'get_review_session');
    const getProps = (get?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(getProps).sort()).toEqual(['sessionId']);
    const end = tools.tools.find((t) => t.name === 'end_review_session');
    expect(end?.description).toContain('Idempotent');
  });
});

describe('formatTimestamp', () => {
  it('converts {_seconds,_nanoseconds} wire format to ISO 8601', () => {
    expect(formatTimestamp({ _seconds: 1700000000, _nanoseconds: 0 })).toBe('2023-11-14T22:13:20.000Z');
  });

  it('keeps the fractional-second part: a sub-second instant must NOT render as .000Z', () => {
    // Regression: formatTimestamp used to drop _nanoseconds entirely, so a
    // card stored at {_seconds:1788393231,_nanoseconds:373000000} displayed
    // as 2026-09-02T23:53:51.000Z — a value that createdTo/updatedTo then
    // rejected (the backend filters on the true instant). The displayed
    // timestamp must be round-trippable as a search bound.
    expect(formatTimestamp({ _seconds: 1788393231, _nanoseconds: 373000000 })).toBe('2026-09-02T23:53:51.373Z');
    expect(formatTimestamp({ _seconds: 1788393231, _nanoseconds: 373999999 })).toBe('2026-09-02T23:53:51.373Z');
    expect(formatTimestamp({ _seconds: 1788393231, _nanoseconds: 999999999 })).toBe('2026-09-02T23:53:51.999Z');
    // Whole-second instants still render with the .000Z suffix.
    expect(formatTimestamp({ _seconds: 1788393231, _nanoseconds: 0 })).toBe('2026-09-02T23:53:51.000Z');
    // Absent/malformed nanos fall back to whole seconds, not NaN.
    expect(formatTimestamp({ _seconds: 1788393231 })).toBe('2026-09-02T23:53:51.000Z');
  });

  it('passes through strings and unknown values', () => {
    expect(formatTimestamp('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp({ foo: 1 })).toBe('[object Object]');
  });
});

describe('cardSummary', () => {
  it('normalizes a backend card into ISO timestamps and omits absent deck', () => {
    const summary = cardSummary(card({ deck: undefined }));
    expect(summary).toEqual({
      id: 'card-1', front: 'What is FSRS?', back: 'Free Spaced Repetition Scheduler', tags: ['algorithm'],
      createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z', due: '2023-11-14T22:13:20.000Z',
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [],
    });
    expect('deck' in summary).toBe(false);
  });

  it('carries deckId and deck when present', () => {
    const summary = cardSummary(card({ deckId: 'd1', deck: 'Spanish' }));
    expect(summary.deckId).toBe('d1');
    expect(summary.deck).toBe('Spanish');
  });

  it('normalizes scheduling fields and reviewLog entries', () => {
    const summary = cardSummary(card({
      state: 2, stability: 8.5, difficulty: 4.2, reps: 5, lapses: 1,
      lastReview: { _seconds: 1700000000, _nanoseconds: 0 },
      reviewLog: [{ rating: 3, state: 2, review: ts, due: ts, stability: 8.5, difficulty: 4.2, reps: 5, lapses: 1 }],
    }));
    expect(summary.state).toBe(2);
    expect(summary.stability).toBe(8.5);
    expect(summary.lastReview).toBe('2023-11-14T22:13:20.000Z');
    expect(summary.reviewLog).toEqual([{ rating: 3, state: 2, review: '2023-11-14T22:13:20.000Z', due: '2023-11-14T22:13:20.000Z', stability: 8.5, difficulty: 4.2, reps: 5, lapses: 1 }]);
  });

  it('cardSummary preserves fractional milliseconds on createdAt/updatedAt/due (search-bound round-trip)', () => {
    // Regression: cardSummary inherited the nanosecond-dropping formatter, so
    // a card created at 2026-09-02T23:53:51.373Z was reported as
    // 2026-09-02T23:53:51.000Z and became unfindable via
    // search_cards(createdTo: <displayed value>). Every timestamp field must
    // carry the millisecond fraction.
    const frac = { _seconds: 1788393231, _nanoseconds: 373000000 };
    const summary = cardSummary(card({ createdAt: frac, updatedAt: frac, due: frac }));
    expect(summary.createdAt).toBe('2026-09-02T23:53:51.373Z');
    expect(summary.updatedAt).toBe('2026-09-02T23:53:51.373Z');
    expect(summary.due).toBe('2026-09-02T23:53:51.373Z');
    expect(summary.createdAt).not.toBe('2026-09-02T23:53:51.000Z');
  });
});

describe('sessionSummary', () => {
  it('normalizes a backend session into ISO timestamps and maps rating counts', () => {
    const summary = sessionSummary(sessionWire('s1', {
      deckId: 'deck-1',
      dueCount: 5,
      ratingCounts: { again: 1, hard: 0, good: 2, easy: 0, ratingCounts: { 1: 1, 2: 0, 3: 2, 4: 0 } },
      lastReviewedAt: { _seconds: 1700000001, _nanoseconds: 0 },
    }) as Parameters<typeof sessionSummary>[0]);
    expect(summary).toEqual({
      id: 's1', apiKeyName: 'Test Key', status: 'active', mode: 'spaced_repetition', deckId: 'deck-1', limit: 100,
      modeTag: '[Spaced repetition review · 5 cards · Due cards]',
      visibleStatus: 'active · 0 reviewed, 1 remaining of 1',
      dueCount: 5, cardIds: ['card-1'], currentIndex: 0, reviewedCount: 0, remainingCount: 1,
      reviewedCardIds: [],
      truncated: false, continuationAvailable: false,
      ratingCounts: { again: 1, hard: 0, good: 2, easy: 0, ratingCounts: { 1: 1, 2: 0, 3: 2, 4: 0 } },
      startedAt: '2023-11-14T22:13:20.000Z', lastReviewedAt: '2023-11-14T22:13:21.000Z',
    });
  });

  it('exposes a Finish/Continue visibleStatus for a LEGACY capped session (continuationAvailable kept on old docs)', () => {
    const summary = sessionSummary(sessionWire('s1', {
      status: 'completed', currentIndex: 100, reviewedCount: 100, dueCount: 150,
      cardIds: Array.from({ length: 100 }, (_, i) => 'card-' + i),
      remainingCount: 0, truncated: true, continuationAvailable: true,
    }) as Parameters<typeof sessionSummary>[0]);
    expect(summary.modeTag).toBe('[Spaced repetition review · 150 cards · Due cards]');
    expect(summary.visibleStatus).toContain('choose Finish or Continue review');
    expect(summary.visibleStatus).toContain('start a NEW spaced-repetition session');
  });
});


describe('deckSummary', () => {
  it('normalizes a backend deck into ISO timestamps and omits absent description', () => {
    const summary = deckSummary({ id: 'd1', name: 'Spanish', createdAt: ts, updatedAt: ts });
    expect(summary).toEqual({
      id: 'd1', name: 'Spanish',
      createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect('description' in summary).toBe(false);
  });

  it('includes description when present', () => {
    const summary = deckSummary({ id: 'd1', name: 'Spanish', description: 'Vocab', createdAt: ts, updatedAt: ts });
    expect(summary.description).toBe('Vocab');
  });
});

describe('cardImageSummary', () => {
  it('normalizes an image with all fields', () => {
    const summary = cardImageSummary({ id: 'img1', url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg', addedAt: ts });
    expect(summary).toEqual({
      id: 'img1', url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg',
      addedAt: '2023-11-14T22:13:20.000Z',
    });
  });

  it('omits absent alt/mimeType', () => {
    const summary = cardImageSummary({ id: 'img2', url: 'https://example.com/pic.png', addedAt: ts });
    expect('alt' in summary).toBe(false);
    expect('mimeType' in summary).toBe(false);
    expect(summary.addedAt).toBe('2023-11-14T22:13:20.000Z');
  });
});



describe('session preload + presentation config (MCP contract)', () => {
  it('start_review_session passes cardType/name and surfaces preloaded in structured output', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/startReviewSessionHandler');
      expect(JSON.parse(String(init.body))).toEqual({ cardType: 'cloze', name: 'Spanish Vocab' });
      return new Response(JSON.stringify({
        session: sessionWire('s1', { cardType: 'cloze', name: 'Spanish Vocab', cardIds: ['card-1', 'card-2'], remainingCount: 2 }),
        card: card(),
        preloaded: [{ id: 'card-2', front: 'Next?', back: 'Next!', deck: 'Spanish', tags: [] }],
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { cardType: 'cloze', name: 'Spanish Vocab' } });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; preloaded?: unknown[] } }).structuredContent;
    // Minimal model-facing shape: no cardType/name/preloaded.
    expect(sc?.session?.cardType).toBeUndefined();
    expect(sc?.session?.name).toBeUndefined();
    expect(sc?.preloaded).toBeUndefined();
    // Full state (cardType/name/preloaded) rides in hidden widgetState.
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; preloaded?: unknown[] } | undefined);
    expect(hidden?.session?.cardType).toBe('cloze');
    expect(hidden?.session?.name).toBe('Spanish Vocab');
    expect(hidden?.preloaded).toEqual([{ id: 'card-2', front: 'Next?', back: 'Next!', deck: 'Spanish', tags: [] }]);
  });

  it('submit_review passes requestId/expectedCardId and returns preloaded', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/submitSessionReviewHandler/s1');
      expect(JSON.parse(String(init.body))).toEqual({ rating: 3, requestId: 'req-12345678', expectedCardId: 'card-1' });
      return new Response(JSON.stringify({
        session: sessionWire('s1', { currentIndex: 1, reviewedCount: 1 }),
        card: { id: 'card-2', front: 'Next?', back: 'Next!', tags: [], createdAt: ts, updatedAt: ts, due: ts, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [] },
        preloaded: [],
        requestId: 'req-12345678',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'submit_review', arguments: { sessionId: 's1', rating: 3, requestId: 'req-12345678', expectedCardId: 'card-1' } });
    const sc = (result as { structuredContent?: { preloaded?: unknown[]; requestId?: string } }).structuredContent;
    // Minimal shape: no preloaded; requestId still echoed in the minimal session? No —
    // it rides in hidden widgetState.
    expect(sc?.preloaded).toBeUndefined();
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { preloaded?: unknown[]; requestId?: string } | undefined);
    expect(hidden?.preloaded).toEqual([]);
    expect(hidden?.requestId).toBe('req-12345678');
  });
});


describe('sessionWithCardText presentation info', () => {
  it('mentions preloaded/name/cardType in the text content', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', { cardType: 'cloze', name: 'Spanish Vocab', cardIds: ['card-1', 'card-2'], currentIndex: 0, remainingCount: 2 }),
      card: card(),
      preloaded: [{ id: 'card-2', front: 'Next?', back: 'Next!', deck: 'Spanish', tags: [] }],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { cardType: 'cloze', name: 'Spanish Vocab' } });
    // QUIET mode: empty model-facing content; minimal card id in structured.
    expect(result.content).toEqual([]);
    const sc = (result as { structuredContent?: { card?: { id?: string } | null } }).structuredContent;
    expect(sc?.card?.id).toBe('card-1');
    // The full state (mode/name/preloaded) rides in hidden _meta.
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; preloaded?: unknown[] } | undefined);
    expect(hidden?.session?.cardType).toBe('cloze');
    expect(hidden?.session?.name).toBe('Spanish Vocab');
    expect(hidden?.preloaded).toEqual([{ id: 'card-2', front: 'Next?', back: 'Next!', deck: 'Spanish', tags: [] }]);
  });
});





describe('v2 bounded review session wire (MCP contract)', () => {
  it('start_review_session surfaces storageVersion 2 + queueWindow (no root cardIds needed)', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWireV2('s-v2', {
        limit: 12,
        chunkCount: 1,
        position: 12,
        remainingQueueCount: 12,
        queueChunksPrefix: 'queueChunks',
        currentIndex: 0,
        reviewedCount: 0,
        remainingCount: 12,
      }),
      card: card(),
      preloaded: [{ id: 'card-2', front: 'Next?', back: 'Next!', tags: [] }],
      currentPosition: 0,
      queueWindow: { currentPosition: 0, cardIds: ['card-1', 'card-2'] },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; currentPosition?: unknown; queueWindow?: unknown } | undefined);
    expect(hidden?.session?.storageVersion).toBe(2);
    expect(hidden?.session?.cardIds).toBeUndefined();
    expect(hidden?.session?.remainingQueueCount).toBe(12);
    expect(hidden?.session?.limit).toBe(12);
    expect(hidden?.currentPosition).toBe(0);
    expect(hidden?.queueWindow).toEqual({ currentPosition: 0, cardIds: ['card-1', 'card-2'] });
    expect(hidden?.session?.visibleStatus).toBe('active · 0 reviewed, 12 remaining of 12');
  });

  it('submit_review forwards expectedPosition (v2 claim by position)', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/submitSessionReviewHandler/s1');
      const body = JSON.parse(String(init.body));
      expect(body.expectedPosition).toBe(3);
      expect(body.expectedCardId).toBeUndefined();
      return new Response(JSON.stringify({
        session: sessionWireV2('s1', { currentIndex: 4, reviewedCount: 1, limit: 12, remainingQueueCount: 11 }),
        card: { id: 'card-5', front: 'Next', back: '!', tags: [], createdAt: ts, updatedAt: ts, due: ts, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [] },
        preloaded: [],
        requestId: 'req-12345678',
        currentPosition: 4,
        queueWindow: { currentPosition: 4, cardIds: ['card-5'] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({
      name: 'submit_review',
      arguments: { sessionId: 's1', rating: 3, requestId: 'req-12345678', expectedPosition: 3 },
    });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; currentPosition?: unknown } | undefined);
    expect(hidden?.session?.storageVersion).toBe(2);
    expect(hidden?.currentPosition).toBe(4);
  });

  it('start_review_session passes repeatSessionId (Continue lineage) to the backend', async () => {
    const handler: Handler = (url, init) => {
      expect(url).toBe('https://test.invalid/startReviewSessionHandler');
      expect(JSON.parse(String(init.body))).toEqual({ repeatSessionId: 'session-old' });
      return new Response(JSON.stringify({
        session: sessionWireV2('s-new', { repeatSessionId: 'session-old', limit: 1, remainingQueueCount: 1 }),
        card: card(),
        preloaded: [],
        currentPosition: 0,
        queueWindow: { currentPosition: 0, cardIds: ['card-1'] },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { repeatSessionId: 'session-old' } });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown> } | undefined);
    expect(hidden?.session?.repeatSessionId).toBe('session-old');
  });
});
  it('v2 session summary OMITS source.cardIds and surfaces canonical root fields + buildStatus', async () => {
    // A v2 custom session that was started with an explicit (≤200) allowlist:
    // the strict invariant forbids exposing those card ids through provenance
    // — source.cardIds must be stripped from the summary — while the
    // canonical bounded root fields ride through.
    const wire = sessionWireV2('s-san', {
      source: { type: 'custom', deckName: 'Spanish', tags: ['v'], cardIds: ['c1', 'c2', 'c3'] },
      totalCount: 3,
      limit: 3,
      currentPosition: 1,
      currentChunkIndex: 0,
      buildStatus: 'ready',
      remainingQueueCount: 2,
      remainingCount: 2,
      currentIndex: 1,
    });
    const summary = sessionSummary(wire as Parameters<typeof sessionSummary>[0]);
    // NO card-id provenance leak.
    expect(summary.source).toEqual({ type: 'custom', deckName: 'Spanish', tags: ['v'] });
    expect((summary.source as { cardIds?: unknown } | undefined)?.cardIds).toBeUndefined();
    // Canonical bounded fields surfaced.
    expect(summary.storageVersion).toBe(2);
    expect(summary.totalCount).toBe(3);
    expect(summary.currentPosition).toBe(1);
    expect(summary.currentChunkIndex).toBe(0);
    expect(summary.buildStatus).toBe('ready');
    expect(summary.remainingCount).toBe(2);
    // No root arrays anywhere in the summary.
    expect((summary as { cardIds?: unknown }).cardIds).toBeUndefined();
    expect((summary as { reviewedCardIds?: unknown }).reviewedCardIds).toBeUndefined();
  });

  it('v1 (legacy) session summaries KEEP source.cardIds (selector replay for Continue)', async () => {
    const wire = sessionWire('s-legacy-source', {
      source: { type: 'custom', tags: ['v'], cardIds: ['c1', 'c2'] },
    });
    const summary = sessionSummary(wire as Parameters<typeof sessionSummary>[0]);
    expect(summary.source).toEqual({ type: 'custom', tags: ['v'], cardIds: ['c1', 'c2'] });
    // v1 legacy documents keep their in-root arrays on the wire.
    expect((summary as { cardIds?: unknown }).cardIds).toEqual(['card-1']);
  });
  it('v2 summary OMITS all legacy root arrays even when a malformed v2 object carries them', async () => {
    // Strict invariant regression: a v2 root that (wrongly) still has the
    // legacy in-root arrays must NOT leak any of them through the summary.
    const wire = sessionWireV2('s-malformed', {
      source: { type: 'custom', tags: ['v'] },
      cardIds: ['c1', 'c2', 'c3'],
      reviewedCardIds: ['c1'],
      processedRequestIds: ['req-1', 'req-2'],
      limit: 3,
      totalCount: 3,
      currentPosition: 1,
      currentChunkIndex: 0,
      buildStatus: 'ready',
      remainingQueueCount: 2,
      remainingCount: 2,
      currentIndex: 1,
    });
    const summary = sessionSummary(wire as Parameters<typeof sessionSummary>[0]);
    expect(summary.storageVersion).toBe(2);
    expect((summary as { cardIds?: unknown }).cardIds).toBeUndefined();
    expect((summary as { reviewedCardIds?: unknown }).reviewedCardIds).toBeUndefined();
    expect((summary as { processedRequestIds?: unknown }).processedRequestIds).toBeUndefined();
    expect(summary.totalCount).toBe(3);
    expect(summary.currentPosition).toBe(1);
    expect(summary.currentChunkIndex).toBe(0);
    expect(summary.buildStatus).toBe('ready');
    expect(summary.remainingCount).toBe(2);
  });

  it('end-to-end v2 start with an explicit allowlist NEVER leaks source.cardIds on the wire', async () => {
    // The backend sends a v2 session whose raw root source still carries the
    // explicit allowlist (older backend / defensive check): the MCP summary
    // must strip it — no card ids through the model-facing or hidden state.
    const handler: Handler = () => new Response(JSON.stringify({
      session: Object.assign(sessionWireV2('s-allow', {
        source: { type: 'custom', deckName: 'Spanish', cardIds: ['c1', 'c2'] },
        limit: 2, totalCount: 2, currentPosition: 0, currentChunkIndex: 0,
        buildStatus: 'ready', remainingQueueCount: 2, remainingCount: 2,
      }), { source: { type: 'custom', deckName: 'Spanish', cardIds: ['c1', 'c2'] } }),
      card: card(),
      preloaded: [],
      currentPosition: 0,
      queueWindow: { currentPosition: 0, currentCardId: 'card-1', cardIds: [{ cardId: 'card-1', position: 0 }] },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: { cardIds: ['c1', 'c2'] } });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown> } | undefined);
    const src = hidden?.session?.source as { cardIds?: unknown } | undefined;
    expect(src).toBeDefined();
    expect(src?.cardIds).toBeUndefined();
    expect(hidden?.session?.totalCount).toBe(2);
    expect(hidden?.session?.currentChunkIndex).toBe(0);
    expect(hidden?.session?.buildStatus).toBe('ready');
  });



describe('session tools Apps SDK ui linkage (single-widget decoupling)', () => {
  it('REVIEW_TEST_MODE=true marks session results with testMode (review/testMode) without UI linkage', async () => {
    const prev = process.env.REVIEW_TEST_MODE;
    process.env.REVIEW_TEST_MODE = 'true';
    try {
      const handler: Handler = () => new Response(JSON.stringify({
        session: sessionWire('s1', { cardIds: ['card-1'], remainingCount: 1, testMode: true }),
        card: card(),
        preloaded: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const { client } = await setup(handler);
      const result = await client.callTool({ name: 'get_review_session', arguments: { sessionId: 's1' } });
      const sc = (result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(sc.testMode).toBe(true);
      const meta = (result as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.['review/testMode']).toBe(true);
      // Still data-only: no UI linkage.
      expect(meta?.ui).toBeUndefined();
      expect(meta?.['openai/outputTemplate']).toBeUndefined();
      expect(meta?.['ui/widgetState']).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.REVIEW_TEST_MODE; else process.env.REVIEW_TEST_MODE = prev;
    }
  });

  it('start_review_session result carries UI linkage aliases and hidden widgetState', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', { cardIds: ['card-1'], remainingCount: 1 }),
      card: card(),
      preloaded: [],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    // start mounts the persistent widget once: UI linkage + hidden state.
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe('ui://review-session-v5');
    expect(meta?.['ui/resourceUri']).toBe('ui://review-session-v5');
    expect(meta?.['openai/outputTemplate']).toBe('ui://review-session-v5');
    expect(meta?.['ui/widgetState']).toBeDefined();
  });

  it('get_review_session and submit_review results carry ONLY hidden widgetState (no ui.resourceUri, no remount)', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      session: sessionWire('s1', { cardIds: ['card-1'], remainingCount: 1 }),
      card: card(),
      preloaded: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    for (const [name, args] of [
      ['get_review_session', { sessionId: 's1' }],
      ['submit_review', { sessionId: 's1', rating: 3 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const meta = (result as { _meta?: Record<string, unknown> })._meta;
      // Data-only: hidden widgetState present (the ALREADY-mounted widget
      // hydrates from it) but NO ui.resourceUri / outputTemplate linkage.
      expect(meta?.['ui/widgetState']).toBeDefined();
      expect(meta?.ui).toBeUndefined();
      expect(meta?.['openai/outputTemplate']).toBeUndefined();
    }
  });

  it('get_flashcard result is data-only (no widget metadata)', async () => {
    const handler: Handler = () => new Response(JSON.stringify(card()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_flashcard', arguments: { id: 'card-1' } });
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect(meta).toBeUndefined();
  });
});


describe('analytics tools (review history / stats / top-lapsed / migration)', () => {
  it('get_review_history GETs the handler and returns events + nextPageToken', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/getReviewHistoryHandler?ratings=1%2C3');
      return new Response(JSON.stringify({
        events: [{
          id: 'evt-1', cardId: 'c1', actorId: 'Key A', rating: 3, stateBefore: 0,
          reviewedAt: '2026-08-10T00:00:00.000Z', recordedAt: '2026-08-10T00:00:00.000Z',
          stabilityAfter: 1, difficultyAfter: 5, repsAfter: 1, lapsesAfter: 0,
          dueBefore: '2026-08-01T00:00:00.000Z', dueAfter: '2026-08-10T00:10:00.000Z',
          cardFrontSnapshot: 'Front', deckName: 'Spanish',
        }],
        nextPageToken: 'tok-1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_review_history', arguments: { ratings: [1, 3] } });
    const sc = (result as { structuredContent?: { events?: unknown[]; nextPageToken?: string | null } }).structuredContent;
    expect(sc?.events).toHaveLength(1);
    expect(sc?.nextPageToken).toBe('tok-1');
  });

  it('get_study_stats GETs the handler with required from/to and returns the FLAT stats object', async () => {
    const handler: Handler = (url) => {
      expect(url).toBe('https://test.invalid/getStudyStatsHandler?from=2026-08-01&to=2026-08-10&deckId=d1');
      return new Response(JSON.stringify({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
        totalReviews: 4,
        ratingCounts: { again: 1, hard: 1, good: 1, easy: 1 },
        ratingPercentages: { again: 0.25, hard: 0.25, good: 0.25, easy: 0.25 },
        observedRetention: 0.75,
        matureReviews: 2,
        matureRatingCounts: { again: 1, hard: 0, good: 1, easy: 0 },
        matureRetention: 0.5,
        topLapsedCards: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_study_stats', arguments: { from: '2026-08-01', to: '2026-08-10', deckId: 'd1' } });
    const sc = (result as { structuredContent?: { observedRetention?: number | null; totalReviews?: number } }).structuredContent;
    expect(sc?.observedRetention).toBe(0.75);
    expect(sc?.totalReviews).toBe(4);
  });

  it('get_top_lapsed_cards GETs the handler and returns the ranking', async () => {
    const handler: Handler = () => new Response(JSON.stringify({
      cards: [{ cardId: 'c1', lapses: 3, reps: 10, front: 'F', state: 2, deckName: 'Spanish' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'get_top_lapsed_cards', arguments: { limit: 5 } });
    const sc = (result as { structuredContent?: { cards?: unknown[] } }).structuredContent;
    expect(sc?.cards).toEqual([{ cardId: 'c1', lapses: 3, reps: 10, front: 'F', state: 2, deckName: 'Spanish' }]);
  });

  it('migrate_review_events POSTs the legacyActorId and reports counts', async () => {
    const handler: Handler = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.legacyActorId).toBe('operator-1');
      return new Response(JSON.stringify({ cardsMigrated: 1, eventsWritten: 2, hasMore: true, nextResumeAfterCardId: 'card-9' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: 'migrate_review_events', arguments: { legacyActorId: 'operator-1' } });
    const sc = (result as { structuredContent?: { eventsWritten?: number; hasMore?: boolean; nextResumeAfterCardId?: string | null } }).structuredContent;
    expect(sc?.eventsWritten).toBe(2);
    expect(sc?.hasMore).toBe(true);
    expect(sc?.nextResumeAfterCardId).toBe('card-9');
  });
});


describe("anki apkg tools (import_apkg / export_apkg)", () => {
  it("import_apkg POSTs the base64 package to /importApkgHandler and reports the imported cards", async () => {
    const handler: Handler = (_url, init) => {
      expect(_url).toBe("https://test.invalid/importApkgHandler");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(typeof body.package).toBe("string");
      expect(body.deckPath).toBe("Spanish::Verbs");
      return new Response(JSON.stringify({
        cards: [
          { front: "What is 2+2?", back: "4", deckPath: "Spanish::Verbs", tags: ["math"] },
          { front: "Capital?", back: "Paris", deckPath: "Spanish::Verbs", tags: [] },
        ],
        skippedNotes: 1,
        skippedEmpty: 0,
        skippedOverLimit: 0,
        atomic: true,
        batchCount: 1,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({
      name: "import_apkg",
      arguments: { package: "UEsDBA==", deckPath: "Spanish::Verbs" },
    });
    const sc = (result as { structuredContent?: { cards?: unknown[]; atomic?: boolean; skippedNotes?: number } }).structuredContent;
    expect(sc?.cards).toHaveLength(2);
    expect(sc?.atomic).toBe(true);
    expect(sc?.skippedNotes).toBe(1);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(String(content[0]?.text ?? "")).toContain("Imported 2 flashcards");
  });

  it("import_apkg input schema is strict and bounded", async () => {
    const { client } = await setup(() => new Response("{}", { status: 200 }));
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "import_apkg");
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["deckPath", "package"]);
    expect((props.package as { maxLength?: number }).maxLength).toBe(33554448);
    // Tool invocation with an oversized package is rejected by the schema
    // (MCP surfaces schema failures as isError results, not rejections).
    const big = "A".repeat(33554449);
    const res = await client.callTool({ name: "import_apkg", arguments: { package: big } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it("export_apkg POSTs the selection to /exportApkgHandler and returns the base64 package", async () => {
    const handler: Handler = (_url, init) => {
      expect(_url).toBe("https://test.invalid/exportApkgHandler");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body.deck).toBe("Spanish");
      expect(body.cardIds).toBeUndefined();
      return new Response(JSON.stringify({
        package: "UEsDBBQAAAA=",
        cardCount: 3,
        filteredCards: 0,
        decks: ["Spanish"],
        media: [{ fileName: "pic.png", sourceUrl: "https://storage/pic.png" }],
        mediaSkipped: [],
        schedulingExported: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { client } = await setup(handler);
    const result = await client.callTool({ name: "export_apkg", arguments: { deck: "Spanish" } });
    const sc = (result as { structuredContent?: { cardCount?: number; package?: string; decks?: unknown[] } }).structuredContent;
    expect(sc?.cardCount).toBe(3);
    expect(sc?.package).toBe("UEsDBBQAAAA=");
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(String(content[0]?.text ?? "")).toContain("Exported 3 cards");
  });

  it("export_apkg input schema forbids deck+cardIds together and caps cardIds at 1000", async () => {
    const { client } = await setup(() => new Response("{}", { status: 200 }));
    for (const badArgs of [{ deck: "D", cardIds: ["a"] }, { cardIds: [] }, { cardIds: Array(1001).fill("x") }, { cardIds: ["a", "a"] }]) {
      const res = await client.callTool({ name: "export_apkg", arguments: badArgs });
      expect((res as { isError?: boolean }).isError).toBe(true);
    }
  });
});

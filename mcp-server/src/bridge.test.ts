import { jest } from '@jest/globals';
import { FirebaseBridge, FirebaseBridgeError, searchCardsQuerySchema } from './bridge';

describe('FirebaseBridge request failures', () => {
  it('preserves backend error status and message', async () => {
    const bridge = new FirebaseBridge({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      fetchFn: jest.fn(async () => new Response(JSON.stringify({ error: 'Card not found' }), { status: 404 })),
    });
    await expect(bridge.getFlashcard('missing')).rejects.toMatchObject({
      name: 'FirebaseBridgeError',
      status: 404,
      message: 'Card not found',
    });
  });

  it('distinguishes an unreachable backend from an HTTP error', async () => {
    const bridge = new FirebaseBridge({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      fetchFn: jest.fn(async () => { throw new TypeError('fetch failed'); }),
    });
    await expect(bridge.health()).rejects.toMatchObject({
      name: 'FirebaseBridgeError',
      status: 0,
      body: { unreachable: true },
    });
  });

  it('normalizes timeouts from both fetch and response-body reads', async () => {
    const timeout = () => Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchTimeout = new FirebaseBridge({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      fetchFn: jest.fn(async () => { throw timeout(); }),
    });
    await expect(fetchTimeout.health()).rejects.toMatchObject({
      name: 'FirebaseBridgeError',
      status: 0,
      body: { timeout: true },
    });

    const bodyTimeout = new FirebaseBridge({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      fetchFn: jest.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(timeout()); } }), { status: 200 })),
    });
    await expect(bodyTimeout.health()).rejects.toMatchObject({
      name: 'FirebaseBridgeError',
      status: 0,
      body: { timeout: true },
    });
  });

  it('uses a safe fallback for unexpected non-JSON service responses', async () => {
    const bridge = new FirebaseBridge({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      fetchFn: jest.fn(async () => new Response('oops', { status: 503 })),
    });
    await expect(bridge.health()).rejects.toMatchObject({
      name: 'FirebaseBridgeError',
      status: 503,
      message: 'Request failed with status 503',
    });
  });
});

describe('search filter bounds', () => {
  const valid = { tagsAll: ['a', 'b,c', ' space '], decks: ['d'.repeat(100)], deckNames: ['n'.repeat(300)] };

  it('accepts literal repeated values at the backend limits', () => {
    expect(searchCardsQuerySchema.safeParse(valid).success).toBe(true);
    expect(searchCardsQuerySchema.safeParse({ tagsAny: Array(20).fill('x') }).success).toBe(true);
  });

  it('rejects excess values or values beyond tag, deck-id, and deck-name bounds', () => {
    expect(searchCardsQuerySchema.safeParse({ tagsAny: Array(21).fill('x') }).success).toBe(false);
    expect(searchCardsQuerySchema.safeParse({ tagsAll: ['t'.repeat(51)] }).success).toBe(false);
    expect(searchCardsQuerySchema.safeParse({ decks: ['d'.repeat(101)] }).success).toBe(false);
    expect(searchCardsQuerySchema.safeParse({ deckNames: ['n'.repeat(301)] }).success).toBe(false);
  });
});

import {
  FirebaseBridge, FirebaseBridgeError, createFlashcardInputSchema, updateFlashcardInputSchema, listFlashcardsQuerySchema,
  bulkCreateFlashcardsInputSchema, bulkUpdateFlashcardsInputSchema, bulkDeleteFlashcardsInputSchema,
  createDeckInputSchema, updateDeckInputSchema, listDecksQuerySchema, deleteDeckResultSchema,
  attachImageInputSchema, removeImageInputSchema, listImagesResponseSchema, removeImageResponseSchema,
  uploadImageInputSchema, uploadImageResponseSchema,
  startReviewSessionInputSchema, submitSessionReviewInputSchema, reviewSessionWithCardSchema,
  countFlashcardsQuerySchema, flashcardCountsSchema, countFlashcardsResponseSchema,
  schedulingActionInputSchema, setFlashcardDueDateInputSchema, schedulingActionResponseSchema,
  SCHEDULING_ACTION_LIMIT,
  listTagsQuerySchema, tagNameSchema, listTagsResponseSchema, renameTagInputSchema,
  deleteTagInputSchema, mergeTagsInputSchema, tagActionResultSchema,
  importApkgInputSchema, importApkgResponseSchema, exportApkgInputSchema, exportApkgResponseSchema,
  ANKI_IMPORT_PACKAGE_MAX,
} from './bridge';

const BASE = 'https://us-central1-cuelingua.cloudfunctions.net';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(handler: (url: string, init: RequestInit) => Response) {
  return jest.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
}

/** Builds a wire-format review session for response mocks. */
function sessionWire(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    apiKeyName: 'Test Key',
    status: 'active',
    mode: 'spaced_repetition',
    limit: 100,
    dueCount: 1,
    cardIds: ['c1'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 1,
    truncated: false,
    continuationAvailable: false,
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } },
    startedAt: { _seconds: 1700000000, _nanoseconds: 0 },
    ...overrides,
  };
}

describe('FirebaseBridge', () => {
  describe('URL and headers', () => {
    it('calls the named function URL and sends X-API-Key from the environment key', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/createFlashcardHandler`);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        return jsonResponse({ id: 'abc', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'secret-key', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.createFlashcard({ front: 'F', back: 'B' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('omits X-API-Key when no key is configured', async () => {
      const fetchMock = makeFetchMock((_url, init) => {
        expect((init.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
        return jsonResponse({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
      });
      const bridge = new FirebaseBridge({ apiKey: '', baseUrl: BASE, fetchFn: fetchMock });

      const health = await bridge.health();
      expect(health.status).toBe('ok');
    });

    it('strips trailing slashes from baseUrl and appends id to the function URL path', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/getFlashcardHandler/card-123`);
        return jsonResponse({ id: 'card-123', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: `${BASE}/`, fetchFn: fetchMock });

      await bridge.getFlashcard('card-123');
    });

    it('encodes ids in the URL path', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/getFlashcardHandler/card%20with%20spaces`);
        return jsonResponse({ id: 'x', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.getFlashcard('card with spaces');
    });

    it('builds list query parameters only for provided filters', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listFlashcardsHandler?deck=Math&tags=core%2Cbasic&pageSize=50`);
        return jsonResponse({ cards: [], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.listFlashcards({ deck: 'Math', tags: 'core,basic', pageSize: 50 });
    });

    it('sends an empty list query when no filters are provided', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listFlashcardsHandler`);
        return jsonResponse({ cards: [], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.listFlashcards();
    });

    it('forwards a request-scoped bearer token as the Authorization header', async () => {
      const fetchMock = makeFetchMock((_url, init) => {
        expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer auth0-verified-token-xyz');
        return jsonResponse({ id: 'abc', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} }, 201);
      });
      const bridge = new FirebaseBridge({
        apiKey: 'secret-key', baseUrl: BASE, fetchFn: fetchMock,
        bearerToken: 'auth0-verified-token-xyz',
      });

      await bridge.createFlashcard({ front: 'F', back: 'B' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('omits Authorization when no bearer token is set (stdio/local/health)', async () => {
      const fetchMock = makeFetchMock((_url, init) => {
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
        return jsonResponse({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const health = await bridge.health();
      expect(health.status).toBe('ok');
      expect(bridge.hasBearerToken).toBe(false);
    });

    it('scoped() returns an independent request-scoped bridge with the token', async () => {
      const fetchMock = makeFetchMock((_url, init) => {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer req-token-1');
        return jsonResponse({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
      });
      const base = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });
      expect(base.hasBearerToken).toBe(false);

      const scoped = base.scoped('req-token-1');
      expect(scoped.hasBearerToken).toBe(true);
      // The original bridge is untouched (never stores the request token).
      expect(base.hasBearerToken).toBe(false);

      await scoped.health();
    });
  });

  describe('request methods', () => {
    it('createFlashcard POSTs the body to /createFlashcardHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/createFlashcardHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ front: 'F', back: 'B', deck: 'D', tags: ['t'], topic: 'geo', suspended: true });
        return jsonResponse({ id: 'c1', front: 'F', back: 'B', deck: 'D', tags: ['t'], topic: 'geo', suspended: true, createdAt: {}, updatedAt: {}, due: {} }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const card = await bridge.createFlashcard({ front: 'F', back: 'B', deck: 'D', tags: ['t'], topic: 'geo', suspended: true });
      expect(card.id).toBe('c1');
    });

    it('updateFlashcard PATCHes partial body to /updateFlashcardHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/updateFlashcardHandler/c1`);
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ front: 'New', topic: null, suspended: false });
        return jsonResponse({ id: 'c1', front: 'New', back: 'B', tags: [], suspended: false, createdAt: {}, updatedAt: {}, due: {} });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

            const card = await bridge.updateFlashcard('c1', { front: 'New', topic: null, suspended: false });
      expect(card.front).toBe('New');
    });

    it('getDueFlashcards GETs /dueFlashcardsHandler with provided query params', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/dueFlashcardsHandler?deck=Math&pageSize=25`);
        return jsonResponse({ cards: [], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.getDueFlashcards({ deck: 'Math', pageSize: 25 });
      expect(result.cards).toEqual([]);
    });

    it('getDueFlashcards sends an empty query when no filters are provided', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/dueFlashcardsHandler`);
        return jsonResponse({ cards: [], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.getDueFlashcards();
    });

    it('countFlashcards GETs /countFlashcardsHandler with provided query params', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/countFlashcardsHandler?deck=Spanish&groupBy=deck`);
        return jsonResponse({ counts: { total: 1, new: 1, learning: 0, mature: 0, due: 1 } });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.countFlashcards({ deck: 'Spanish', groupBy: 'deck' });
      expect(result.counts.total).toBe(1);
    });

    it('countFlashcards sends an empty query when no filters are provided', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/countFlashcardsHandler`);
        return jsonResponse({ counts: { total: 0, new: 0, learning: 0, mature: 0, due: 0 } });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.countFlashcards();
    });

    it('bulkCreateFlashcards POSTs {cards:[...]} to /bulkCreateFlashcardsHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/bulkCreateFlashcardsHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({
          cards: [
            { front: 'F1', back: 'B1', deck: 'Math', tags: ['a'] },
            { front: 'F2', back: 'B2' },
          ],
        });
        return jsonResponse({
          cards: [
            { id: 'c1', front: 'F1', back: 'B1', deck: 'Math', tags: ['a'], createdAt: {}, updatedAt: {}, due: {} },
            { id: 'c2', front: 'F2', back: 'B2', tags: [], createdAt: {}, updatedAt: {}, due: {} },
          ],
        }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.bulkCreateFlashcards({
        cards: [
          { front: 'F1', back: 'B1', deck: 'Math', tags: ['a'] },
          { front: 'F2', back: 'B2' },
        ],
      });
      expect(result.cards).toHaveLength(2);
      expect(result.cards[0].id).toBe('c1');
      expect(result.cards[1].id).toBe('c2');
    });

    it('bulkUpdateFlashcards POSTs {cards:[{id,...}]} to /bulkUpdateFlashcardsHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/bulkUpdateFlashcardsHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({
          cards: [
            { id: 'c1', front: 'New' },
            { id: 'c2', back: 'B2' },
          ],
        });
        return jsonResponse({
          cards: [
            { id: 'c1', front: 'New', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} },
          ],
        });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.bulkUpdateFlashcards({
        cards: [{ id: 'c1', front: 'New' }, { id: 'c2', back: 'B2' }],
      });
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].id).toBe('c1');
    });

    it('createDeck POSTs {name,description?} to /createDeckHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/createDeckHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Spanish', description: 'Vocab' });
        return jsonResponse({ id: 'd1', name: 'Spanish', description: 'Vocab', createdAt: {}, updatedAt: {} }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const deck = await bridge.createDeck({ name: 'Spanish', description: 'Vocab' });
      expect(deck.id).toBe('d1');
      expect(deck.name).toBe('Spanish');
    });

    it('getDeck GETs /getDeckHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/getDeckHandler/d1`);
        return jsonResponse({ id: 'd1', name: 'Spanish', createdAt: {}, updatedAt: {} });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const deck = await bridge.getDeck('d1');
      expect(deck.name).toBe('Spanish');
    });

    it('listDecks GETs /listDecksHandler with pageSize', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listDecksHandler?pageSize=25`);
        return jsonResponse({ decks: [{ id: 'd1', name: 'A', createdAt: {}, updatedAt: {} }], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.listDecks({ pageSize: 25 });
      expect(result.decks).toHaveLength(1);
      expect(result.decks[0].name).toBe('A');
    });

    it('updateDeck PATCHes partial body to /updateDeckHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/updateDeckHandler/d1`);
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Spanish II' });
        return jsonResponse({ id: 'd1', name: 'Spanish II', createdAt: {}, updatedAt: {} });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const deck = await bridge.updateDeck('d1', { name: 'Spanish II' });
      expect(deck.name).toBe('Spanish II');
    });

    it('deleteDeck DELETEs /deleteDeckHandler/{id} and returns {deleted,detachedCards}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/deleteDeckHandler/d1`);
        expect(init.method).toBe('DELETE');
        return jsonResponse({ deleted: true, detachedCards: 3 });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.deleteDeck('d1');
      expect(result).toEqual({ deleted: true, detachedCards: 3 });
    });

    it('attachImage POSTs {url,alt?,mimeType?} to /attachImageHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/attachImageHandler/c1`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg' });
        return jsonResponse({
          card: { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, images: [{ url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg', addedAt: {} }] },
          image: { url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg', addedAt: {} },
        }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.attachImage('c1', { url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg' });
      expect(result.image.url).toBe('https://example.com/pic.jpg');
      expect(result.card.images).toHaveLength(1);
    });

    it('listImages GETs /listImagesHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listImagesHandler/c1`);
        return jsonResponse({ cardId: 'c1', images: [{ id: 'img1', url: 'https://example.com/pic.jpg', addedAt: {} }] });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.listImages('c1');
      expect(result.images).toHaveLength(1);
      expect(result.images[0].url).toBe('https://example.com/pic.jpg');
    });

    it('uploadImage POSTs {data,fileName,contentType,alt?} to /uploadImageHandler/{id}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/uploadImageHandler/c1`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ data: 'aGVsbG8=', fileName: 'pic.jpg', contentType: 'image/jpeg', alt: 'A pic' });
        return jsonResponse({
          card: { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, images: [{ id: 'img1', url: 'https://storage.example.com/card-images/c1/img1-pic.jpg?signed=1', mimeType: 'image/jpeg', addedAt: {}, storagePath: 'card-images/c1/img1-pic.jpg', downloadUrl: 'https://storage.example.com/card-images/c1/img1-pic.jpg?signed=1', sizeBytes: 5 }] },
          image: { id: 'img1', url: 'https://storage.example.com/card-images/c1/img1-pic.jpg?signed=1', mimeType: 'image/jpeg', addedAt: {}, storagePath: 'card-images/c1/img1-pic.jpg', downloadUrl: 'https://storage.example.com/card-images/c1/img1-pic.jpg?signed=1', sizeBytes: 5 },
        }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.uploadImage('c1', { data: 'aGVsbG8=', fileName: 'pic.jpg', contentType: 'image/jpeg', alt: 'A pic' });
      expect(result.image.storagePath).toBe('card-images/c1/img1-pic.jpg');
      expect(result.image.sizeBytes).toBe(5);
      expect(result.card.images).toHaveLength(1);
    });
    it('startReviewSession POSTs {deckId?} to /startReviewSessionHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/startReviewSessionHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ deckId: 'deck-1' });
        return jsonResponse({ session: sessionWire('s1'), card: null }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.startReviewSession({ deckId: 'deck-1' });
      expect(result.session.id).toBe('s1');
      expect(result.session.status).toBe('active');
      expect(result.session.mode).toBe('spaced_repetition');
      expect(result.session.dueCount).toBe(1);
      expect(result.session.continuationAvailable).toBe(false);
      expect(result.card).toBeNull();
    });

    it('startReviewSession forwards deck/tags/cardIds selectors and parses the source metadata', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/startReviewSessionHandler`);
        expect(JSON.parse(String(init.body))).toEqual({ deckId: 'deck-1', deck: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] });
        return jsonResponse({
          session: sessionWire('s1', { source: { type: 'custom', deckId: 'deck-1', deckName: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] } }),
          card: null,
        }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.startReviewSession({ deckId: 'deck-1', deck: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] });
      expect(result.session.source).toEqual({ type: 'custom', deckId: 'deck-1', deckName: 'Spanish', tags: ['vocab'], cardIds: ['c1', 'c2'] });
    });

    it('startReviewSession sends an empty body when no filters are provided', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/startReviewSessionHandler`);
        expect(JSON.parse(String(init.body))).toEqual({});
        return jsonResponse({ session: sessionWire('s1'), card: null }, 201);
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.startReviewSession({});
    });

    it('getReviewSession GETs /getReviewSessionHandler/{sessionId}', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/getReviewSessionHandler/s1`);
        return jsonResponse({ session: sessionWire('s1'), card: { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} } });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.getReviewSession('s1');
      expect(result.session.id).toBe('s1');
      expect(result.card?.id).toBe('c1');
    });

    it('submitSessionReview POSTs {rating,reviewAt?} to /submitSessionReviewHandler/{sessionId}', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/submitSessionReviewHandler/s1`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' });
        return jsonResponse({ session: sessionWire('s1', { status: 'completed', currentIndex: 1, reviewedCount: 1 }), card: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.submitSessionReview('s1', { rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' });
      expect(result.session.status).toBe('completed');
    });

    it('submitSessionReview sends rating only when reviewAt is omitted', async () => {
      const fetchMock = makeFetchMock((_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ rating: 4 });
        return jsonResponse({ session: sessionWire('s1'), card: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.submitSessionReview('s1', { rating: 4 });
    });

    it('endReviewSession POSTs /endReviewSessionHandler/{sessionId} and returns the session', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/endReviewSessionHandler/s1`);
        expect(init.method).toBe('POST');
        return jsonResponse(sessionWire('s1', { status: 'ended' }));
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.endReviewSession('s1');
      expect(result.id).toBe('s1');
      expect(result.status).toBe('ended');
    });

    it('listTags GETs /listTagsHandler with pageSize/pageToken', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listTagsHandler?pageSize=25&pageToken=spanish`);
        return jsonResponse({ tags: [{ name: 'algorithm', cardCount: 3 }, { name: 'spanish', cardCount: 1 }], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.listTags({ pageSize: 25, pageToken: 'spanish' });
      expect(result.tags).toHaveLength(2);
      expect(result.tags[0]).toEqual({ name: 'algorithm', cardCount: 3 });
      expect(result.nextPageToken).toBeNull();
    });

    it('listTags sends an empty query when no filters are provided', async () => {
      const fetchMock = makeFetchMock((url) => {
        expect(url).toBe(`${BASE}/listTagsHandler`);
        return jsonResponse({ tags: [], nextPageToken: null });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await bridge.listTags();
    });

    it('renameTag POSTs { from, to } to /renameTagHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/renameTagHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ from: 'old', to: 'new' });
        return jsonResponse({ affectedCards: 4 });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.renameTag({ from: 'old', to: 'new' });
      expect(result.affectedCards).toBe(4);
    });

    it('deleteTag POSTs { name } to /deleteTagHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/deleteTagHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'old' });
        return jsonResponse({ affectedCards: 7 });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.deleteTag({ name: 'old' });
      expect(result.affectedCards).toBe(7);
    });

    it('mergeTags POSTs { from, to } to /mergeTagsHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/mergeTagsHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ from: 'a', to: 'b' });
        return jsonResponse({ affectedCards: 9 });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.mergeTags({ from: 'a', to: 'b' });
      expect(result.affectedCards).toBe(9);
    });

    it('resetFlashcards POSTs { ids } to /resetFlashcardsHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/resetFlashcardsHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ ids: ['c1', 'c2'] });
        return jsonResponse({
          ids: ['c1', 'c2'],
          count: 2,
          cards: [
            { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] },
            { id: 'c2', front: 'F2', back: 'B2', tags: [], createdAt: {}, updatedAt: {}, due: {}, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [] },
          ],
        });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.resetFlashcards({ ids: ['c1', 'c2'] });
      expect(result.ids).toEqual(['c1', 'c2']);
      expect(result.count).toBe(2);
      expect(result.cards).toHaveLength(2);
    });

    it('setFlashcardDueDate POSTs { ids, due } to /setFlashcardDueDateHandler', async () => {
      const fetchMock = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/setFlashcardDueDateHandler`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ ids: ['c1'], due: '2026-09-15' });
        return jsonResponse({ ids: ['c1'], count: 1, cards: [{ id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, state: 2, stability: 5, difficulty: 3, reps: 4, lapses: 0, reviewLog: [] }] });
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const result = await bridge.setFlashcardDueDate({ ids: ['c1'], due: '2026-09-15' });
      expect(result.count).toBe(1);
    });

    it('suspendFlashcards and unsuspendFlashcards POST to their handlers', async () => {
      const suspendFetch = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/suspendFlashcardsHandler`);
        expect(JSON.parse(String(init.body))).toEqual({ ids: ['c1'] });
        return jsonResponse({ ids: ['c1'], count: 1, cards: [{ id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, suspended: true }] });
      });
      const suspendBridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: suspendFetch });
      const suspended = await suspendBridge.suspendFlashcards({ ids: ['c1'] });
      expect(suspended.cards[0].suspended).toBe(true);

      const unsuspendFetch = makeFetchMock((url, init) => {
        expect(url).toBe(`${BASE}/unsuspendFlashcardsHandler`);
        expect(JSON.parse(String(init.body))).toEqual({ ids: ['c1'] });
        return jsonResponse({ ids: ['c1'], count: 1, cards: [{ id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} }] });
      });
      const unsuspendBridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: unsuspendFetch });
      const unsuspended = await unsuspendBridge.unsuspendFlashcards({ ids: ['c1'] });
      expect(unsuspended.cards[0].suspended).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws FirebaseBridgeError with backend error message on 404', async () => {
      const fetchMock = makeFetchMock(() => jsonResponse({ error: 'Flashcard not found' }, 404));
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await expect(bridge.getFlashcard('nope')).rejects.toThrow(FirebaseBridgeError);
      await expect(bridge.getFlashcard('nope')).rejects.toMatchObject({ status: 404, message: 'Flashcard not found' });
    });

    it('carries validation issues from the backend on 400', async () => {
      const fetchMock = makeFetchMock(() => jsonResponse({ error: 'Validation failed', issues: [{ path: ['front'], message: 'Front cannot be empty' }] }, 400));
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      const err = await bridge.createFlashcard({ front: '', back: 'B' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FirebaseBridgeError);
      const bridgeErr = err as FirebaseBridgeError;
      expect(bridgeErr.status).toBe(400);
      expect(bridgeErr.body).toEqual(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('reports unreachable backend distinctly from auth errors', async () => {
      const fetchMock = makeFetchMock(() => {
        throw new TypeError('fetch failed');
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await expect(bridge.health()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('unreachable') });
    });

    it('reports timeout distinctly', async () => {
      const fetchMock = makeFetchMock(() => {
        const err = new Error('The operation was aborted due to timeout') as Error & { name: string };
        err.name = 'TimeoutError';
        throw err;
      });
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, timeoutMs: 50, fetchFn: fetchMock });

      await expect(bridge.health()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('timed out') });
    });

    it('uses a fallback message for unexpected statuses', async () => {
      const fetchMock = makeFetchMock(() => new Response('oops', { status: 503 }));
      const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });

      await expect(bridge.health()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('503') });
    });
  });

  describe('hasApiKey', () => {
    it('reflects whether a key is configured', () => {
      expect(new FirebaseBridge({ apiKey: 'k', fetchFn: jest.fn() }).hasApiKey).toBe(true);
      expect(new FirebaseBridge({ apiKey: '', fetchFn: jest.fn() }).hasApiKey).toBe(false);
    });
  });
});

describe('input schemas (mirror backend validators)', () => {
  it('create schema accepts valid input with all fields', () => {
    const result = createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deck: 'D', tags: ['a', 'b'] });
    expect(result.success).toBe(true);
  });

  it('create/update/bulk schemas carry topic (nullable) and suspended', () => {
    // topic: free-form label <= 200, nullable (null clears on update).
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', topic: 'geo', suspended: true }).success).toBe(true);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', topic: null }).success).toBe(true);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', topic: '' }).success).toBe(false);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', topic: 'x'.repeat(201) }).success).toBe(false);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', suspended: 'yes' }).success).toBe(false);

    expect(updateFlashcardInputSchema.safeParse({ topic: null, suspended: false }).success).toBe(true);
    expect(updateFlashcardInputSchema.safeParse({ topic: 'new topic', suspended: true }).success).toBe(true);
    expect(updateFlashcardInputSchema.safeParse({ topic: '' }).success).toBe(false);
    expect(updateFlashcardInputSchema.safeParse({ suspended: 1 }).success).toBe(false);

    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: [{ front: 'F', back: 'B', topic: 'geo', suspended: true }] }).success).toBe(true);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: 'a', topic: null, suspended: true }] }).success).toBe(true);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: 'a', topic: 'x'.repeat(201) }] }).success).toBe(false);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: 'a', suspended: 'nope' }] }).success).toBe(false);
  });

  it('create schema rejects empty front/back', () => {
    expect(createFlashcardInputSchema.safeParse({ front: '', back: 'B' }).success).toBe(false);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: '' }).success).toBe(false);
  });

  it('create schema rejects deck too long and too many tags', () => {
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deck: 'a'.repeat(101) }).success).toBe(false);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', tags: Array(21).fill('t') }).success).toBe(false);
  });

  it('update schema accepts an empty object (partial update)', () => {
    expect(updateFlashcardInputSchema.safeParse({}).success).toBe(true);
  });

  it('update schema rejects invalid fields when present', () => {
    expect(updateFlashcardInputSchema.safeParse({ front: '' }).success).toBe(false);
  });

  it('list query schema coerces pageSize and clamps to 1..100', () => {
    expect(listFlashcardsQuerySchema.safeParse({ pageSize: '50' }).success).toBe(true);
    expect(listFlashcardsQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(listFlashcardsQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('bulk create schema accepts valid cards and rejects empty/over-limit arrays', () => {
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: [{ front: 'F', back: 'B' }] }).success).toBe(true);
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: [{ front: 'F', back: 'B', deck: 'D', tags: ['t'] }] }).success).toBe(true);
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: [] }).success).toBe(false);
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: Array(101).fill({ front: 'F', back: 'B' }) }).success).toBe(false);
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: Array(100).fill({ front: 'F', back: 'B' }) }).success).toBe(true);
    expect(bulkCreateFlashcardsInputSchema.safeParse({ cards: [{ front: '', back: 'B' }] }).success).toBe(false);
  });

  it('bulk update schema accepts items with ids and rejects missing ids/over-limit', () => {
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: 'a', front: 'New' }] }).success).toBe(true);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: 'a' }] }).success).toBe(true);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ front: 'New' }] }).success).toBe(false);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: [{ id: '', front: 'New' }] }).success).toBe(false);
    expect(bulkUpdateFlashcardsInputSchema.safeParse({ cards: Array(101).fill({ id: 'a' }) }).success).toBe(false);
  });

  it('bulk delete schema accepts ids and rejects empty/missing/over-limit', () => {
    expect(bulkDeleteFlashcardsInputSchema.safeParse({ ids: ['a', 'b'] }).success).toBe(true);
    expect(bulkDeleteFlashcardsInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(bulkDeleteFlashcardsInputSchema.safeParse({ ids: [''] }).success).toBe(false);
    expect(bulkDeleteFlashcardsInputSchema.safeParse({ ids: Array(101).fill('a') }).success).toBe(false);
  });

  it('card create schema accepts deckId (nullable) alongside legacy deck name', () => {
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deckId: 'd1' }).success).toBe(true);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deckId: null }).success).toBe(true);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deckId: '' }).success).toBe(false);
    expect(createFlashcardInputSchema.safeParse({ front: 'F', back: 'B', deckId: 'd1', deck: 'Old' }).success).toBe(true);
  });

  it('card update schema accepts deckId null (detach)', () => {
    expect(updateFlashcardInputSchema.safeParse({ deckId: null }).success).toBe(true);
    expect(updateFlashcardInputSchema.safeParse({ deck: null }).success).toBe(true);
    expect(updateFlashcardInputSchema.safeParse({ deckId: '' }).success).toBe(false);
  });

  it('list query schema accepts deckId and legacy deck filters', () => {
    expect(listFlashcardsQuerySchema.safeParse({ deckId: 'd1' }).success).toBe(true);
    expect(listFlashcardsQuerySchema.safeParse({ deck: 'Math' }).success).toBe(true);
  });

  it('create deck schema accepts valid input and rejects empty/long names', () => {
    expect(createDeckInputSchema.safeParse({ name: 'Spanish' }).success).toBe(true);
    expect(createDeckInputSchema.safeParse({ name: 'Spanish', description: 'Vocab' }).success).toBe(true);
    expect(createDeckInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createDeckInputSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
    expect(createDeckInputSchema.safeParse({ description: 'a'.repeat(501) }).success).toBe(false);
  });

  it('update deck schema accepts partial updates and rejects empty name', () => {
    expect(updateDeckInputSchema.safeParse({ name: 'Spanish II' }).success).toBe(true);
    expect(updateDeckInputSchema.safeParse({ description: 'x' }).success).toBe(true);
    expect(updateDeckInputSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('list decks query schema coerces pageSize and clamps to 1..100', () => {
    expect(listDecksQuerySchema.safeParse({ pageSize: '30' }).success).toBe(true);
    expect(listDecksQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(listDecksQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('delete deck result schema validates {deleted,detachedCards}', () => {
    expect(deleteDeckResultSchema.safeParse({ deleted: true, detachedCards: 3 }).success).toBe(true);
    expect(deleteDeckResultSchema.safeParse({ deleted: true }).success).toBe(false);
  });

  it('tag name schema enforces the shared 1-50 char bound without trimming', () => {
    expect(tagNameSchema.safeParse('a').success).toBe(true);
    expect(tagNameSchema.safeParse('a'.repeat(50)).success).toBe(true);
    expect(tagNameSchema.safeParse('').success).toBe(false);
    expect(tagNameSchema.safeParse('a'.repeat(51)).success).toBe(false);
    // Names are NOT trimmed: whitespace-differing names are distinct valid tags.
    expect(tagNameSchema.safeParse(' vocab ').success).toBe(true);
  });

  it('list tags query schema coerces pageSize and clamps to 1..100', () => {
    expect(listTagsQuerySchema.safeParse({ pageSize: '30', pageToken: 'spanish' }).success).toBe(true);
    expect(listTagsQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(listTagsQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('list tags response schema validates {tags,nextPageToken}', () => {
    expect(listTagsResponseSchema.safeParse({ tags: [{ name: 'a', cardCount: 3 }], nextPageToken: 'a' }).success).toBe(true);
    expect(listTagsResponseSchema.safeParse({ tags: [{ name: 'a', cardCount: 3 }], nextPageToken: null }).success).toBe(true);
    expect(listTagsResponseSchema.safeParse({ tags: [{ name: 'a' }], nextPageToken: null }).success).toBe(false);
    expect(listTagsResponseSchema.safeParse({ tags: [], nextPageToken: null }).success).toBe(true);
  });

  it('rename/merge tag input schemas reject empty/overlong names and from === to', () => {
    expect(renameTagInputSchema.safeParse({ from: 'old', to: 'new' }).success).toBe(true);
    expect(renameTagInputSchema.safeParse({ from: 'same', to: 'same' }).success).toBe(false);
    expect(renameTagInputSchema.safeParse({ from: '', to: 'b' }).success).toBe(false);
    expect(renameTagInputSchema.safeParse({ from: 'a', to: 'b'.repeat(51) }).success).toBe(false);
    expect(mergeTagsInputSchema.safeParse({ from: 'a', to: 'b' }).success).toBe(true);
    expect(mergeTagsInputSchema.safeParse({ from: 'same', to: 'same' }).success).toBe(false);
    expect(mergeTagsInputSchema.safeParse({ from: 'a' }).success).toBe(false);
  });

  it('delete tag input schema accepts a name and rejects empty', () => {
    expect(deleteTagInputSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(deleteTagInputSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('tag action result schema validates {affectedCards}', () => {
    expect(tagActionResultSchema.safeParse({ affectedCards: 4 }).success).toBe(true);
    expect(tagActionResultSchema.safeParse({ affectedCards: 0 }).success).toBe(true);
    expect(tagActionResultSchema.safeParse({ affectedCards: '4' }).success).toBe(false);
    expect(tagActionResultSchema.safeParse({}).success).toBe(false);
  });

  it('attach image schema accepts url with optional alt/mimeType and rejects empty/overlong', () => {
    expect(attachImageInputSchema.safeParse({ url: 'https://example.com/pic.jpg' }).success).toBe(true);
    expect(attachImageInputSchema.safeParse({ url: 'https://example.com/pic.jpg', alt: 'A', mimeType: 'image/jpeg' }).success).toBe(true);
    expect(attachImageInputSchema.safeParse({ url: '' }).success).toBe(false);
    expect(attachImageInputSchema.safeParse({ url: `https://e.com/${'a'.repeat(2100)}` }).success).toBe(false);
    expect(attachImageInputSchema.safeParse({}).success).toBe(false);
  });

  it('remove image schema accepts url and rejects empty', () => {
    expect(removeImageInputSchema.safeParse({ url: 'https://example.com/pic.jpg' }).success).toBe(true);
    expect(removeImageInputSchema.safeParse({ url: '' }).success).toBe(false);
  });

  it('list images response schema validates {cardId, images}', () => {
    expect(listImagesResponseSchema.safeParse({ cardId: 'c1', images: [{ id: 'i1', url: 'https://e.com/p.jpg', addedAt: {} }] }).success).toBe(true);
    expect(listImagesResponseSchema.safeParse({ cardId: 'c1' }).success).toBe(false);
  });

  it('remove image response schema validates {cardId, removed}', () => {
    expect(removeImageResponseSchema.safeParse({ cardId: 'c1', removed: true }).success).toBe(true);
    expect(removeImageResponseSchema.safeParse({ removed: true }).success).toBe(false);
  });

  it('upload image schema accepts data/fileName/contentType and rejects empties/overlong', () => {
    expect(uploadImageInputSchema.safeParse({ data: 'aGk=', fileName: 'pic.jpg', contentType: 'image/jpeg' }).success).toBe(true);
    expect(uploadImageInputSchema.safeParse({ data: 'aGk=', fileName: 'pic.jpg', contentType: 'image/jpeg', alt: 'A' }).success).toBe(true);
    expect(uploadImageInputSchema.safeParse({ data: '', fileName: 'pic.jpg', contentType: 'image/jpeg' }).success).toBe(false);
    expect(uploadImageInputSchema.safeParse({ data: 'aGk=', contentType: 'image/jpeg' }).success).toBe(false);
    expect(uploadImageInputSchema.safeParse({ data: 'aGk=', fileName: 'pic.jpg' }).success).toBe(false);
    expect(uploadImageInputSchema.safeParse({ data: 'a'.repeat(14000001), fileName: 'pic.jpg', contentType: 'image/jpeg' }).success).toBe(false);
  });

  it('upload image response schema validates {card, image} with cloud metadata', () => {
    const img = { id: 'i1', url: 'u', mimeType: 'image/jpeg', addedAt: {}, storagePath: 'card-images/c1/i1.jpg', downloadUrl: 'u', sizeBytes: 5 };
    expect(uploadImageResponseSchema.safeParse({ card: { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {}, images: [img] }, image: img }).success).toBe(true);
  });

  it('start review session schema accepts selectors and a LARGE cardIds allowlist, but never a limit', () => {
    expect(startReviewSessionInputSchema.safeParse({}).success).toBe(true);
    expect(startReviewSessionInputSchema.safeParse({ deckId: 'deck-1' }).success).toBe(true);
    expect(startReviewSessionInputSchema.safeParse({ deckId: 'deck-1', cardType: 'cloze', name: 'Spanish' }).success).toBe(true);
    // No session card cap: a 150-id allowlist is accepted whole.
    const manyIds = Array.from({ length: 150 }, (_, i) => 'c' + i);
    expect(startReviewSessionInputSchema.safeParse({ cardIds: manyIds }).success).toBe(true);
    // A client-supplied limit is rejected (the queue is never client-set).
    expect(startReviewSessionInputSchema.safeParse({ limit: 25 }).success).toBe(false);
    expect(startReviewSessionInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(startReviewSessionInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(startReviewSessionInputSchema.safeParse({ deckId: '' }).success).toBe(false);
    expect(startReviewSessionInputSchema.safeParse({ deckId: 'a'.repeat(101) }).success).toBe(false);
  });

  it('submit session review schema accepts rating 1-4 and optional ISO reviewAt', () => {
    expect(submitSessionReviewInputSchema.safeParse({ rating: 1 }).success).toBe(true);
    expect(submitSessionReviewInputSchema.safeParse({ rating: 4, reviewAt: '2026-08-28T12:00:00.000Z' }).success).toBe(true);
    expect(submitSessionReviewInputSchema.safeParse({ rating: 3, requestId: 'req-123456', expectedCardId: 'c1' }).success).toBe(true);
    expect(submitSessionReviewInputSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(submitSessionReviewInputSchema.safeParse({ rating: 5 }).success).toBe(false);
    expect(submitSessionReviewInputSchema.safeParse({ rating: 3, reviewAt: 'not-a-date' }).success).toBe(false);
    expect(submitSessionReviewInputSchema.safeParse({}).success).toBe(false);
  });

  it('review session with card schema validates session + nullable card', () => {
    const session = sessionWire('s1');
    expect(reviewSessionWithCardSchema.safeParse({ session, card: null, preloaded: [] }).success).toBe(true);
    expect(reviewSessionWithCardSchema.safeParse({ session, card: { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} }, preloaded: [{ id: 'c2', front: 'F2', back: 'B2', tags: [] }] }).success).toBe(true);
    expect(reviewSessionWithCardSchema.safeParse({ session: { ...session, status: 'bogus' }, card: null, preloaded: [] }).success).toBe(false);
    expect(reviewSessionWithCardSchema.safeParse({ card: null, preloaded: [] }).success).toBe(false);
  });

  it('count schemas mirror the backend count contract', () => {
    expect(countFlashcardsQuerySchema.safeParse({ deckId: 'd1', tags: 'a,b', groupBy: 'deck' }).success).toBe(true);
    expect(countFlashcardsQuerySchema.safeParse({ deck: 'Spanish' }).success).toBe(true);
    expect(countFlashcardsQuerySchema.safeParse({ groupBy: 'tag' }).success).toBe(false);
    expect(countFlashcardsQuerySchema.safeParse({ deck: 'x'.repeat(101) }).success).toBe(false);

    const counts = { total: 12, new: 4, learning: 2, mature: 6, due: 5 };
    expect(flashcardCountsSchema.safeParse(counts).success).toBe(true);
    expect(flashcardCountsSchema.safeParse({ ...counts, total: '12' }).success).toBe(false);
    expect(flashcardCountsSchema.safeParse({ total: 1, new: 1, learning: 1, mature: 1 }).success).toBe(false); // due required

    expect(countFlashcardsResponseSchema.safeParse({ counts }).success).toBe(true);
    expect(countFlashcardsResponseSchema.safeParse({
      counts,
      byDeck: [{ deckId: 'deck-1', deck: 'Spanish', counts: { total: 10, new: 3, learning: 2, mature: 5, due: 4 } }],
    }).success).toBe(true);
    expect(countFlashcardsResponseSchema.safeParse({ counts, byDeck: [{ key: 'x', counts: { total: 1 } }] }).success).toBe(false);
  });
});


describe('scheduling-management wire schemas (mirror backend validators)', () => {
  it('schedulingActionInputSchema accepts unique ids and rejects duplicates/empties/over-limit', () => {
    expect(schedulingActionInputSchema.safeParse({ ids: ['a', 'b'] }).success).toBe(true);
    expect(schedulingActionInputSchema.safeParse({ ids: ['a', 'a'] }).success).toBe(false);
    expect(schedulingActionInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(schedulingActionInputSchema.safeParse({ ids: [''] }).success).toBe(false);
    expect(schedulingActionInputSchema.safeParse({ ids: Array.from({ length: SCHEDULING_ACTION_LIMIT + 1 }, (_, i) => `c${i}`) }).success).toBe(false);
    expect(schedulingActionInputSchema.safeParse({ ids: Array.from({ length: SCHEDULING_ACTION_LIMIT }, (_, i) => `c${i}`) }).success).toBe(true);
  });

  it('setFlashcardDueDateInputSchema extends ids with a due string', () => {
    expect(setFlashcardDueDateInputSchema.safeParse({ ids: ['a'], due: '2026-09-15' }).success).toBe(true);
    expect(setFlashcardDueDateInputSchema.safeParse({ ids: ['a'] }).success).toBe(false);
    expect(setFlashcardDueDateInputSchema.safeParse({ ids: ['a'], due: '' }).success).toBe(false);
  });

  it('schedulingActionResponseSchema validates { ids, count, cards }', () => {
    const card = { id: 'c1', front: 'F', back: 'B', tags: [], createdAt: {}, updatedAt: {}, due: {} };
    expect(schedulingActionResponseSchema.safeParse({ ids: ['c1'], count: 1, cards: [card] }).success).toBe(true);
    expect(schedulingActionResponseSchema.safeParse({ ids: ['c1'], count: 2, cards: [card] }).success).toBe(true);
    expect(schedulingActionResponseSchema.safeParse({ ids: ['c1'], cards: [card] }).success).toBe(false);
  });
});


describe('analytics bridge methods (review history / stats / top-lapsed / migration)', () => {
  const BASE = 'https://functions.test';

  it('getReviewHistory GETs /getReviewHistoryHandler with query params', async () => {
    const fetchMock = makeFetchMock((url, init) => {
      expect(url).toBe(`${BASE}/getReviewHistoryHandler?from=2026-08-01&to=2026-08-10&cardId=c1&ratings=1%2C3&pageSize=50`);
      expect(init.method).toBe('GET');
      return jsonResponse({ events: [{
        id: 'evt-1', cardId: 'c1', actorId: 'Key A', rating: 3, stateBefore: 0,
        reviewedAt: '2026-08-10T00:00:00.000Z', recordedAt: '2026-08-10T00:00:00.000Z',
        stabilityAfter: 1, difficultyAfter: 5, repsAfter: 1, lapsesAfter: 0,
        dueBefore: '2026-08-01T00:00:00.000Z', dueAfter: '2026-08-10T00:10:00.000Z',
        cardFrontSnapshot: 'Front', deckId: 'd1', deckName: 'Spanish',
      }], nextPageToken: 'tok' });
    });
    const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });
    const res = await bridge.getReviewHistory({ from: '2026-08-01', to: '2026-08-10', cardId: 'c1', ratings: [1, 3], pageSize: 50 });
    expect(res.events[0].cardFrontSnapshot).toBe('Front');
    expect(res.nextPageToken).toBe('tok');
  });

  it('getStudyStats GETs /getStudyStatsHandler with required from/to + deck + topLimit and returns FLAT stats', async () => {
    const fetchMock = makeFetchMock((url, init) => {
      expect(url).toBe(`${BASE}/getStudyStatsHandler?from=2026-08-01&to=2026-08-10&deckId=d1&topLimit=5`);
      expect(init.method).toBe('GET');
      return jsonResponse({
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
      });
    });
    const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });
    const res = await bridge.getStudyStats({ from: '2026-08-01', to: '2026-08-10', deckId: 'd1', topLimit: 5 });
    expect(res.observedRetention).toBe(0.75);
    expect(res.totalReviews).toBe(4);
  });

  it('getTopLapsedCards GETs /getTopLapsedCardsHandler with deck + limit', async () => {
    const fetchMock = makeFetchMock((url) => {
      expect(url).toBe(`${BASE}/getTopLapsedCardsHandler?deckId=d1&limit=5`);
      return jsonResponse({ cards: [{ cardId: 'c1', lapses: 3, reps: 10, front: 'F', state: 2, deckName: 'Spanish' }] });
    });
    const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });
    const res = await bridge.getTopLapsedCards({ deckId: 'd1', limit: 5 });
    expect(res.cards[0].lapses).toBe(3);
  });

  it('migrateReviewEvents POSTs /migrateReviewEventsHandler with legacyActorId', async () => {
    const fetchMock = makeFetchMock((url, init) => {
      expect(url).toBe(`${BASE}/migrateReviewEventsHandler`);
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body.legacyActorId).toBe('operator-1');
      return jsonResponse({ cardsMigrated: 1, eventsWritten: 2, hasMore: true });
    });
    const bridge = new FirebaseBridge({ apiKey: 'k', baseUrl: BASE, fetchFn: fetchMock });
    const res = await bridge.migrateReviewEvents({ legacyActorId: 'operator-1', pageSize: 10 });
    expect(res.eventsWritten).toBe(2);
    expect(res.hasMore).toBe(true);
  });
});


describe("anki apkg bridge methods + wire schemas", () => {
  const BASE = "https://functions.test";

  it("importApkg POSTs { package, deckPath? } to /importApkgHandler", async () => {
    const fetchMock = makeFetchMock((url, init) => {
      expect(url).toBe(`${BASE}/importApkgHandler`);
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body.package).toBe("UEsDBA==");
      expect(body.deckPath).toBe("Spanish");
      return jsonResponse({
        cards: [{ front: "Q", back: "A", deckPath: "Spanish", tags: ["t"] }],
        skippedNotes: 0, skippedEmpty: 0, skippedOverLimit: 0, atomic: true, batchCount: 1,
      }, 201);
    });
    const bridge = new FirebaseBridge({ apiKey: "k", baseUrl: BASE, fetchFn: fetchMock });
    const result = await bridge.importApkg({ package: "UEsDBA==", deckPath: "Spanish" });
    expect(result.cards).toHaveLength(1);
    expect(result.atomic).toBe(true);
  });

  it("exportApkg POSTs { deck } / { cardIds } to /exportApkgHandler", async () => {
    const byDeck = makeFetchMock((url, init) => {
      expect(url).toBe(`${BASE}/exportApkgHandler`);
      expect(JSON.parse(String(init.body))).toEqual({ deck: "Spanish" });
      return jsonResponse({
        package: "UEsDBBQ=", cardCount: 2, filteredCards: 0, decks: ["Spanish"],
        media: [], mediaSkipped: [], schedulingExported: true,
      });
    });
    const b1 = new FirebaseBridge({ apiKey: "k", baseUrl: BASE, fetchFn: byDeck });
    const r1 = await b1.exportApkg({ deck: "Spanish" });
    expect(r1.cardCount).toBe(2);

    const byIds = makeFetchMock((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ cardIds: ["c1", "c2"] });
      return jsonResponse({
        package: "UEsDBBQ=", cardCount: 2, filteredCards: 0, decks: [null],
        media: [], mediaSkipped: [], schedulingExported: false,
      });
    });
    const b2 = new FirebaseBridge({ apiKey: "k", baseUrl: BASE, fetchFn: byIds });
    const r2 = await b2.exportApkg({ cardIds: ["c1", "c2"] });
    expect(r2.decks).toEqual([null]);
  });

  it("importApkgInputSchema enforces the base64 cap and optional deckPath", () => {
    expect(importApkgInputSchema.safeParse({ package: "aGk=" }).success).toBe(true);
    expect(importApkgInputSchema.safeParse({ package: "aGk=", deckPath: "A::B" }).success).toBe(true);
    expect(importApkgInputSchema.safeParse({ package: "" }).success).toBe(false);
    expect(importApkgInputSchema.safeParse({ package: "x".repeat(ANKI_IMPORT_PACKAGE_MAX + 1) }).success).toBe(false);
    expect(importApkgInputSchema.safeParse({ package: "aGk=", deckPath: "x".repeat(301) }).success).toBe(false);
    expect(importApkgInputSchema.safeParse({ package: "aGk=", extra: 1 }).success).toBe(false);
  });

  it("exportApkgInputSchema enforces deck/cardIds exclusivity, dedupe, and the 1000 cap", () => {
    expect(exportApkgInputSchema.safeParse({}).success).toBe(true);
    expect(exportApkgInputSchema.safeParse({ deck: "D" }).success).toBe(true);
    expect(exportApkgInputSchema.safeParse({ cardIds: ["a", "b"] }).success).toBe(true);
    expect(exportApkgInputSchema.safeParse({ deck: "D", cardIds: ["a"] }).success).toBe(false);
    expect(exportApkgInputSchema.safeParse({ cardIds: [] }).success).toBe(false);
    expect(exportApkgInputSchema.safeParse({ cardIds: ["a", "a"] }).success).toBe(false);
    expect(exportApkgInputSchema.safeParse({ cardIds: Array.from({ length: 1001 }, (_, i) => `c${i}`) }).success).toBe(false);
    expect(exportApkgInputSchema.safeParse({ deck: "x".repeat(301) }).success).toBe(false);
  });

  it("response schemas validate the backend result shapes", () => {
    expect(importApkgResponseSchema.safeParse({
      cards: [{ front: "F", back: "B", deckPath: null, tags: [] }],
      skippedNotes: 0, skippedEmpty: 1, skippedOverLimit: 0, atomic: true, batchCount: 1,
    }).success).toBe(true);
    expect(importApkgResponseSchema.safeParse({ cards: [], atomic: true }).success).toBe(false);
    expect(exportApkgResponseSchema.safeParse({
      package: "UEs=", cardCount: 0, filteredCards: 0, decks: [], media: [], mediaSkipped: [], schedulingExported: false,
    }).success).toBe(true);
    expect(exportApkgResponseSchema.safeParse({ package: "UEs=" }).success).toBe(false);
  });
});

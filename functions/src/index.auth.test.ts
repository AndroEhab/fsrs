import express from 'express';
import { createServer, Server } from 'node:http';

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));
jest.mock('./identity', () => ({ verifyRequest: jest.fn() }));
jest.mock('./environment', () => ({
  assertLocalEmulatorDatastores: jest.fn(),
  isProductionRuntime: jest.fn(),
}));
jest.mock('./flashcards/service', () => ({
  verifyApiKey: jest.fn(),
}));

jest.mock('./flashcards/reviewHistory', () => ({
  migrateLegacyReviewEvents: jest.fn(),
}));

import { verifyRequest } from './identity';
import { isProductionRuntime } from './environment';
import { verifyApiKey } from './flashcards/service';
import { migrateLegacyReviewEvents } from './flashcards/reviewHistory';
import { migrateReviewEventsHandler, searchCardsHandler } from './index';

const mockVerifyRequest = verifyRequest as jest.MockedFunction<typeof verifyRequest>;
const mockIsProductionRuntime = isProductionRuntime as jest.MockedFunction<typeof isProductionRuntime>;
const mockVerifyApiKey = verifyApiKey as jest.MockedFunction<typeof verifyApiKey>;
const mockMigrateLegacyReviewEvents = migrateLegacyReviewEvents as jest.MockedFunction<typeof migrateLegacyReviewEvents>;

async function withHttpHandler(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(express.text({ type: 'text/plain' }));
  app.use(express.raw({ type: 'application/octet-stream' }));
  app.get('/searchCardsHandler', searchCardsHandler as unknown as express.RequestHandler);
  app.post('/migrateReviewEventsHandler', migrateReviewEventsHandler as unknown as express.RequestHandler);
  const server: Server = createServer(app);
  const listening = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}


describe('HTTP authentication boundary', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  const originalEmulator = process.env.FUNCTIONS_EMULATOR;
  beforeEach(() => {
    jest.clearAllMocks();
    if (originalEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = originalEmulator;
    mockIsProductionRuntime.mockReturnValue(true);
    mockVerifyApiKey.mockResolvedValue('Test key');
    mockVerifyRequest.mockResolvedValue({
      identity: { ownerId: 'auth0|owner', subject: 'auth0|owner', isOperator: false, via: 'auth0' },
      error: null,
    });
  });
  afterEach(() => {
    if (originalEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = originalEmulator;
  });

  afterAll(() => consoleError.mockRestore());


  it('returns a secret-safe generic 503 when API-key verification is unavailable', async () => {
    const secret = 'credential-value';
    mockVerifyApiKey.mockRejectedValue(new Error(`Firestore unavailable at apiKeys/${secret}`));
    await withHttpHandler(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/searchCardsHandler`, {
        headers: { 'X-API-Key': secret, Authorization: 'Bearer valid-token' },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Authentication service unavailable' });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(`apiKeys/${secret}`);
    });
  });

  it('rejects malformed migration body shapes and present invalid bounds before backfill', async () => {
    mockVerifyRequest.mockResolvedValue({
      identity: { ownerId: 'auth0|operator', subject: 'auth0|operator', isOperator: true, via: 'auth0' },
      error: null,
    });
    mockMigrateLegacyReviewEvents.mockResolvedValue({
      cardsMigrated: 0,
      eventsWritten: 0,
      hasMore: false,
      nextResumeAfterCardId: null,
    });
    const requests = [
      { contentType: 'application/json', body: 'null' },
      { contentType: 'application/json', body: '[]' },
      { contentType: 'application/json', body: '"text"' },
      { contentType: 'text/plain', body: 'not-json' },
      { contentType: 'application/octet-stream', body: 'binary' },
      { contentType: 'application/json', body: '{"pageSize":0}' },
      { contentType: 'application/json', body: '{"pageSize":101}' },
      { contentType: 'application/json', body: '{"pageSize":true}' },
      { contentType: 'application/json', body: '{"pageSize":"3items"}' },
      { contentType: 'application/json', body: '{"resumeAfterCardId":7}' },
      { contentType: 'application/json', body: '{"legacyActorId":"auth0|other"}' },
    ];

    await withHttpHandler(async (baseUrl) => {
      for (const request of requests) {
        const response = await fetch(`${baseUrl}/migrateReviewEventsHandler`, {
          method: 'POST',
          headers: {
            'X-API-Key': 'test-key',
            Authorization: 'Bearer operator-token',
            'Content-Type': request.contentType,
          },
          body: request.body,
        });
        expect(response.status).toBe(400);
      }
    });
  });
});
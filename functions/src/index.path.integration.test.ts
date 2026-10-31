import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { getFirestore, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;

describe('HTTP Firestore document ID path round-trips', () => {
  it('selects the exact flat document for encoded IDs and rejects malformed or slash IDs', async () => {
    const originalEnvironment = {
      FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      FIREBASE_STORAGE_EMULATOR_HOST: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
      STORAGE_EMULATOR_HOST: process.env.STORAGE_EMULATOR_HOST,
      FIREBASE_CONFIG: process.env.FIREBASE_CONFIG,
    };
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
      ?? (process.env.FIRESTORE_EMULATOR_PORT ? `127.0.0.1:${process.env.FIRESTORE_EMULATOR_PORT}` : '');
    const hostMatch = EMULATOR_HOST_PATTERN.exec(emulatorHost);
    if (!hostMatch || Number(hostMatch[2]) > 65535
        || process.env.FSRS_DATASTORE_PROJECT_ID !== DEMO_PROJECT_ID
        || process.env.GCLOUD_PROJECT !== DEMO_PROJECT_ID
        || process.env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT_ID) {
      throw new Error('HTTP ID tests require the explicit demo-fsrs-datastore-test project and localhost Firestore emulator');
    }

    const configuredStorageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    const storageHostMatch = configuredStorageHost && EMULATOR_HOST_PATTERN.exec(configuredStorageHost);
    if (!storageHostMatch || Number(storageHostMatch[2]) > 65535) {
      throw new Error('HTTP ID tests require a configured localhost Storage emulator');
    }
    const storageHost = configuredStorageHost;
    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = storageHost;
    process.env.STORAGE_EMULATOR_HOST = `http://${storageHost}`;
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: DEMO_PROJECT_ID,
      storageBucket: `${DEMO_PROJECT_ID}.appspot.com`,
    });
    let database: Firestore | undefined;
    let server: Server | undefined;
    const refs: DocumentReference[] = [];
    try {
      // index.ts checks loopback emulator settings during module evaluation.
      const { getFlashcardHandler } = await import('./index');
      database = getFirestore();
      const runId = randomUUID();
      const ownerId = 'emulator';
      const ids = [
        [`path-${runId}-漢字`, 'unicode-front'],
        [`path-${runId}-space id`, 'space-front'],
        [`path-${runId}-literal%2Ftarget`, 'literal-percent-front'],
      ] as const;
      const decoys = ids.map(([id, front]) => [encodeURIComponent(id), `decoy-${front}`] as const);
      const createdAt = Timestamp.now();
      for (const [id, front] of [...ids, ...decoys]) {
        const ref = database.collection('flashcards').doc(id);
        await ref.set({
          ownerId,
          front,
          back: 'HTTP ID test answer',
          tags: [],
          createdAt,
          updatedAt: createdAt,
          due: createdAt,
          state: 0,
          stability: 0,
          difficulty: 0,
          reps: 0,
          lapses: 0,
          reviewLog: [],
          images: [],
        });
        refs.push(ref);
      }

      const app = express();
      app.use(getFlashcardHandler as unknown as RequestHandler);
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP ID test server did not bind a TCP address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(15_000) });

      for (const [id, front] of ids) {
        const response = await get(`${baseUrl}/getFlashcardHandler/${encodeURIComponent(id)}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id, front });
      }

      const encodedSlash = await get(`${baseUrl}/getFlashcardHandler/path-${runId}-literal%2Ftarget`);
      expect(encodedSlash.status).toBe(400);
      const malformedPercent = await get(`${baseUrl}/getFlashcardHandler/path-${runId}-malformed-%ZZ`);
      expect(malformedPercent.status).toBe(400);
      const invalidUtf8 = await get(`${baseUrl}/getFlashcardHandler/path-${runId}-invalid-%FF`);
      expect(invalidUtf8.status).toBe(400);
      expect((await database.collection('flashcards').doc(ids[2][0]).get()).data()?.front).toBe('literal-percent-front');
    } finally {
      try {
        if (server?.listening) {
          await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        }
        if (database && refs.length > 0) {
          const batch = database.batch();
          for (const ref of refs) batch.delete(ref);
          await batch.commit();
        }
        await database?.terminate();
      } finally {
        for (const [key, value] of Object.entries(originalEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }, 30_000);
});

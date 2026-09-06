/**
 * Deterministic emulator tests for firestore.rules (repo root).
 *
 * Policy under test: DENY-BY-DEFAULT.  Every Firestore path in the repo
 * (apiKeys, flashcards, decks, reviewSessions + queueChunks subcollection,
 * reviewEvents) is read/write-locked; direct mobile/web client SDK access is
 * refused for unauthenticated AND authenticated callers, because all real
 * access goes through Cloud Functions using the Admin SDK (rules bypass).
 *
 * Run with:
 *   npm run test:rules            (fires up the Firestore emulator on an
 *                                  ephemeral port, runs this suite, tears down)
 *
 * Requires the Firestore emulator jar (firebase CLI downloads it on first
 * use). java must be on PATH. No Firebase project / credentials needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
// The compat side-effect imports register firebase.firestore() on the app
// namespace; required by the rules-unit-testing v3 client contexts.
import 'firebase/compat/app';
import 'firebase/compat/firestore';

const RULES_PATH = path.resolve(__dirname, '../../firestore.rules');
const PROJECT_ID = 'fsrs-rules-test';

let testEnv: RulesTestEnvironment;

// Firestore operations below create/delete documents and are expected to fail
// with PERMISSION_DENIED. The client SDK surfaces rules denials as rejected
// promises with code 'permission-denied'.
const READ_FAILS = (p: Promise<unknown>) => assertFails(p);
const WRITE_FAILS = (p: Promise<unknown>) => assertFails(p);

const CARD = { front: 'q', back: 'a', state: 'New', due: new Date() };
const API_KEY_DOC = { email: 'someone@example.com', key: 'k-1' };
const SESSION = { status: 'active', mode: 'due', currentIndex: 0, remainingQueueCount: 0, limit: 0, deletedCount: 0 };
const CHUNK = { start: 0, items: [] };
const EVENT = { actorId: 'Key A', cardId: 'c-1', rating: 3 };
const DECK = { name: 'Spanish', createdAt: new Date() };

beforeAll(async () => {
  if (!fs.existsSync(RULES_PATH)) {
    throw new Error(`firestore.rules not found at ${RULES_PATH} — run from the repo root or fix RULES_PATH`);
  }
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  // The default port (8080) collides with a running dev emulator; allow an
  // override so the rules suite can run on an ephemeral port
  // (e.g. FIRESTORE_EMULATOR_PORT=8090 npm run test:rules).
  const rulesPort = process.env.FIRESTORE_EMULATOR_PORT
    ? Number.parseInt(process.env.FIRESTORE_EMULATOR_PORT, 10)
    : 8080;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules, host: '127.0.0.1', port: rulesPort },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// -- helpers --------------------------------------------------------------

/** Firestore-compat client that presents NO Firebase Auth token. */
function unauth() {
  return testEnv.unauthenticatedContext().firestore();
}

/** Firestore-compat client that presents a real (mock) Firebase Auth token. */
function authed(uid: string, email?: string) {
  return testEnv
    .authenticatedContext(uid, email ? { email, email_verified: true } : undefined)
    .firestore();
}

// -- apiKeys --------------------------------------------------------------

describe('apiKeys (all access denied)', () => {
  it('unauthenticated read denied', async () => {
    await READ_FAILS(unauth().collection('apiKeys').doc('k-1').get());
  });
  it('authenticated read denied (any auth token)', async () => {
    await READ_FAILS(authed('user-1', 'someone@example.com').collection('apiKeys').doc('k-1').get());
  });
  it('write denied', async () => {
    await WRITE_FAILS(unauth().collection('apiKeys').doc('k-1').set(API_KEY_DOC));
    await WRITE_FAILS(authed('user-1').collection('apiKeys').doc('k-1').set(API_KEY_DOC));
  });
});

// -- flashcards -----------------------------------------------------------

describe('flashcards (all access denied)', () => {
  it('unauthenticated read denied', async () => {
    await READ_FAILS(unauth().collection('flashcards').doc('card-1').get());
    await READ_FAILS(unauth().collection('flashcards').limit(10).get());
  });
  it('authenticated read denied (any auth token)', async () => {
    await READ_FAILS(authed('user-1').collection('flashcards').doc('card-1').get());
    await READ_FAILS(authed('user-1').collection('flashcards').limit(10).get());
  });
  it('create/update/delete denied', async () => {
    const db = authed('user-1');
    await WRITE_FAILS(db.collection('flashcards').doc('card-1').set(CARD));
    await WRITE_FAILS(db.collection('flashcards').doc('card-1').update({ back: 'x' }));
    await WRITE_FAILS(db.collection('flashcards').doc('card-1').delete());
  });
});

// -- decks ----------------------------------------------------------------

describe('decks (all access denied)', () => {
  it('read denied', async () => {
    await READ_FAILS(unauth().collection('decks').doc('deck-1').get());
    await READ_FAILS(authed('user-1').collection('decks').doc('deck-1').get());
  });
  it('write denied', async () => {
    await WRITE_FAILS(unauth().collection('decks').doc('deck-1').set(DECK));
    await WRITE_FAILS(authed('user-1').collection('decks').doc('deck-1').delete());
  });
});

// -- reviewSessions (+ queueChunks subcollection) --------------------------

describe('reviewSessions and queueChunks (all access denied)', () => {
  it('session read denied', async () => {
    await READ_FAILS(unauth().collection('reviewSessions').doc('sess-1').get());
    await READ_FAILS(authed('user-1').collection('reviewSessions').doc('sess-1').get());
  });
  it('session write denied', async () => {
    await WRITE_FAILS(unauth().collection('reviewSessions').doc('sess-1').set(SESSION));
    await WRITE_FAILS(authed('user-1').collection('reviewSessions').doc('sess-1').update({ status: 'ended' }));
    await WRITE_FAILS(authed('user-1').collection('reviewSessions').doc('sess-1').delete());
  });
  it('queueChunks subcollection read denied', async () => {
    await READ_FAILS(
      authed('user-1').collection('reviewSessions').doc('sess-1').collection('queueChunks').doc('000000').get(),
    );
  });
  it('queueChunks subcollection write denied', async () => {
    await WRITE_FAILS(
      authed('user-1').collection('reviewSessions').doc('sess-1').collection('queueChunks').doc('000000').set(CHUNK),
    );
    await WRITE_FAILS(
      authed('user-1').collection('reviewSessions').doc('sess-1').collection('queueChunks').doc('000000').delete(),
    );
  });
});

// -- reviewEvents ---------------------------------------------------------

describe('reviewEvents (all access denied)', () => {
  it('read denied', async () => {
    await READ_FAILS(unauth().collection('reviewEvents').doc('ev-1').get());
    await READ_FAILS(authed('user-1').collection('reviewEvents').doc('ev-1').get());
  });
  it('create/update/delete denied', async () => {
    await WRITE_FAILS(authed('user-1').collection('reviewEvents').doc('ev-1').set(EVENT));
    await WRITE_FAILS(authed('user-1').collection('reviewEvents').doc('ev-1').update({ rating: 4 }));
    await WRITE_FAILS(authed('user-1').collection('reviewEvents').doc('ev-1').delete());
  });
});

// -- negative control: rules bypass is what functions rely on --------------

describe('Admin-SDK-equivalent access (bypasses rules)', () => {
  it('rules-disabled context can seed and read data', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await assertSucceeds(db.collection('flashcards').doc('card-1').set(CARD));
      await assertSucceeds(db.collection('apiKeys').doc('k-1').set(API_KEY_DOC));
      const snap = await db.collection('flashcards').doc('card-1').get();
      expect(snap.exists).toBe(true);
      expect(snap.data()?.front).toBe('q');
    });
  });
});

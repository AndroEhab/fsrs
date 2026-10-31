import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import {
  endReviewSession,
  getReviewSession,
  ReviewExpectedCardMismatchError,
  ReviewSessionRetryHistoryUnavailableError,
  ReviewSessionBuildFailedError,
  ReviewSessionForbiddenError,
  startReviewSession,
  submitSessionReview,
} from './service';
import { type ReviewRating, type ReviewSessionWithCard, SESSION_QUEUE_CHUNK_SIZE } from './types';
import { LearningProgressUnavailableError } from './scheduler';

const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const runId = randomUUID();
const sharedRequestId = `same-owner-request-id-${runId}`;
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;
const fixtureOwners = new Set<string>();
const db = (() => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
    ?? (process.env.FIRESTORE_EMULATOR_PORT ? `127.0.0.1:${process.env.FIRESTORE_EMULATOR_PORT}` : '');
  const match = EMULATOR_HOST_PATTERN.exec(emulatorHost);
  if (!match || Number(match[2]) > 65535) {
    throw new Error(`Datastore tests require a localhost Firestore emulator; got ${emulatorHost || '(unset)'}`);
  }
  if (process.env.FSRS_DATASTORE_PROJECT_ID !== DEMO_PROJECT_ID
      || process.env.GCLOUD_PROJECT !== DEMO_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT_ID) {
    throw new Error('Datastore tests require the explicit demo project demo-fsrs-datastore-test');
  }
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  initializeApp({ projectId: DEMO_PROJECT_ID });
  return getFirestore();
})();

function ownerFor(testName: string): string {
  const owner = `datastore-test-${runId}-${testName}`;
  fixtureOwners.add(owner);
  return owner;
}

function cardIdFor(testName: string, index: number): string {
  return `datastore-${runId}-${testName}-${String(index).padStart(4, '0')}`;
}

function chunkRef(sessionId: string, chunkIndex: number) {
  return db.collection('reviewSessions').doc(sessionId).collection('queueChunks')
    .where('chunkIndex', '==', chunkIndex).limit(1);
}

async function readChunk(sessionId: string, chunkIndex: number) {
  const snapshot = await chunkRef(sessionId, chunkIndex).get();
  expect(snapshot.size).toBe(1);
  return snapshot.docs[0];
}

function cardDocument(ownerId: string, front: string, back: string, dueMillis: number) {
  const due = Timestamp.fromMillis(dueMillis);
  const now = Timestamp.now();
  return {
    ownerId, front, back, tags: [], suspended: false, createdAt: now, updatedAt: now, due,
    state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, learningSteps: 0, reviewLog: [], images: [],
  };
}

async function seedCards(ownerId: string, count: number, prefix: string): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => cardIdFor(prefix, index));
  for (let start = 0; start < ids.length; start += 450) {
    const batch = db.batch();
    for (let index = start; index < Math.min(start + 450, ids.length); index += 1) {
      batch.create(db.collection('flashcards').doc(ids[index]),
        cardDocument(ownerId, `${prefix} front ${index}`, `${prefix} answer ${index}`, index));
    }
    await batch.commit();
  }
  return ids;
}

async function deleteDocs(refs: DocumentReference[]): Promise<void> {
  for (let start = 0; start < refs.length; start += 450) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + 450)) batch.delete(ref);
    await batch.commit();
  }
}

async function cleanupOwner(ownerId: string): Promise<void> {
  const sessions = await db.collection('reviewSessions').where('ownerId', '==', ownerId).get();
  const sessionChildren: DocumentReference[] = [];
  for (const session of sessions.docs) {
    const chunks = await session.ref.collection('queueChunks').get();
    const requestClaims = await session.ref.collection('requestClaims').get();
    sessionChildren.push(...chunks.docs.map((doc) => doc.ref), ...requestClaims.docs.map((doc) => doc.ref));
  }
  const events = await db.collection('reviewEvents').where('ownerId', '==', ownerId).get();
  const cards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
  await deleteDocs([...sessionChildren, ...sessions.docs.map((doc) => doc.ref),
    ...events.docs.map((doc) => doc.ref), ...cards.docs.map((doc) => doc.ref)]);
}

afterAll(async () => {
  for (const ownerId of fixtureOwners) await cleanupOwner(ownerId);
  await db.terminate();
});

describe('real Firestore review-session regressions', () => {
  it('keeps every v2 queue item intact through progression and same-request retries, including the final card', async () => {
    const ownerId = ownerFor('session-retries');
    const cardIds = await seedCards(ownerId, 3, 'retry-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    expect(started.card?.id).toBe(cardIds[0]);

    for (let position = 0; position < cardIds.length; position += 1) {
      const result = await submitSessionReview(started.session.id, {
        rating: 3, requestId: `retry-request-${position}`, expectedPosition: position, expectedCardId: cardIds[position],
      }, ownerId);
      expect(result?.session.reviewedCount).toBe(position + 1);
      const chunk = await readChunk(started.session.id, 0);
      const items = chunk.data()?.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.map((item: { cardId: string }) => item.cardId)).toEqual(cardIds);
      expect(items.map((item: { status: string }) => item.status)).toEqual(
        cardIds.map((_, index) => index <= position ? 'reviewed' : 'pending'),
      );
    }

    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const beforeRetry = (await sessionRef.get()).data();
    const eventsBeforeRetry = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', started.session.id).get();
    expect(beforeRetry).toMatchObject({ status: 'completed', reviewedCount: 3, ratingCounts: { good: 3 } });
    expect(eventsBeforeRetry.size).toBe(3);
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(3);

    for (const position of [0, 2]) {
      const retry = await submitSessionReview(started.session.id, {
        rating: 3, requestId: `retry-request-${position}`, expectedPosition: position, expectedCardId: cardIds[position],
      }, ownerId);
      expect(retry?.session.reviewedCount).toBe(3);
    }
    const afterRetry = (await sessionRef.get()).data();
    const eventsAfterRetry = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', started.session.id).get();
    expect(afterRetry).toMatchObject({ reviewedCount: 3, ratingCounts: { good: 3, ratingCounts: { 3: 3 } } });
    expect(eventsAfterRetry.size).toBe(3);
    for (const id of cardIds) expect((await db.collection('flashcards').doc(id).get()).data()?.reps).toBe(1);
  });
  it('rejects a missing next chunk before mutating the current chunk or any review state', async () => {
    const ownerId = ownerFor('session-missing-next-chunk');
    const cardIds = await seedCards(ownerId, SESSION_QUEUE_CHUNK_SIZE + 1, 'missing-next-chunk-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    expect(started.card?.id).toBe(cardIds[0]);
    for (let position = 0; position < SESSION_QUEUE_CHUNK_SIZE - 1; position += 1) {
      await submitSessionReview(started.session.id, {
        rating: 3, requestId: `missing-next-progress-${position}-${runId}`,
        expectedPosition: position, expectedCardId: cardIds[position],
      }, ownerId);
    }
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const currentChunkRef = (await readChunk(started.session.id, 0)).ref;
    const missingChunkRef = (await readChunk(started.session.id, 1)).ref;
    await missingChunkRef.delete();

    const rootBeforeClaim = (await sessionRef.get()).data();
    const currentChunkBeforeClaim = (await currentChunkRef.get()).data();
    const cardBeforeClaim = (await db.collection('flashcards').doc(cardIds[SESSION_QUEUE_CHUNK_SIZE - 1]).get()).data();
    const eventsBeforeClaim = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    const claimsBeforeClaim = await sessionRef.collection('requestClaims').get();
    expect(rootBeforeClaim).toMatchObject({ status: 'active', currentPosition: SESSION_QUEUE_CHUNK_SIZE - 1,
      reviewedCount: SESSION_QUEUE_CHUNK_SIZE - 1 });
    expect(eventsBeforeClaim.size).toBe(SESSION_QUEUE_CHUNK_SIZE - 1);
    expect(claimsBeforeClaim.size).toBe(SESSION_QUEUE_CHUNK_SIZE - 1);

    await expect(submitSessionReview(started.session.id, {
      rating: 3, requestId: `missing-next-${runId}`, expectedPosition: SESSION_QUEUE_CHUNK_SIZE - 1,
      expectedCardId: cardIds[SESSION_QUEUE_CHUNK_SIZE - 1],
    }, ownerId)).rejects.toBeInstanceOf(ReviewSessionBuildFailedError);

    expect((await sessionRef.get()).data()).toEqual(rootBeforeClaim);
    expect((await currentChunkRef.get()).data()).toEqual(currentChunkBeforeClaim);
    expect((await db.collection('flashcards').doc(cardIds[SESSION_QUEUE_CHUNK_SIZE - 1]).get()).data()).toEqual(cardBeforeClaim);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).size).toBe(eventsBeforeClaim.size);
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(claimsBeforeClaim.size);
    expect((await db.collection('flashcards').doc(cardIds[SESSION_QUEUE_CHUNK_SIZE]).get()).exists).toBe(true);
    expect((await missingChunkRef.get()).exists).toBe(false);
  }, 120_000);
  it('does not reapply delayed test-mode request IDs between cards or after completion', async () => {
    const ownerId = ownerFor('session-test-mode-retry');
    const cardIds = await seedCards(ownerId, 3, 'test-mode-retry-card');
    const due = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
    for (const id of cardIds) await db.collection('flashcards').doc(id).update({ due });
    const previousMode = process.env.REVIEW_TEST_MODE;
    process.env.REVIEW_TEST_MODE = 'true';
    let started: ReviewSessionWithCard | undefined;
    try {
      started = await startReviewSession({ cardIds }, ownerId);
    } finally {
      if (previousMode === undefined) delete process.env.REVIEW_TEST_MODE;
      else process.env.REVIEW_TEST_MODE = previousMode;
    }
    if (!started) throw new Error('Expected test-mode session to start');

    const cardBefore = await Promise.all(cardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    const requestA = `test-mode-request-a-${runId}`;
    const requestB = `test-mode-request-b-${runId}`;
    const requestC = `test-mode-request-c-${runId}`;
    const rate = (requestId: string, rating: ReviewRating = 3, position?: number) => submitSessionReview(started!.session.id, {
      rating, requestId, ...(position === undefined ? {} : { expectedPosition: position, expectedCardId: cardIds[position] }),
    }, ownerId);
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const chunkRef = (await readChunk(started.session.id, 0)).ref;

    expect((await rate(requestA, 3, 0))?.session.reviewedCount).toBe(1);
    expect((await rate(requestB, 3, 1))?.session.reviewedCount).toBe(2);
    const afterB = (await sessionRef.get()).data();
    expect(afterB).toMatchObject({ status: 'active', reviewedCount: 2, currentPosition: 2, remainingQueueCount: 1 });
    const replayA = await rate(requestA, 4);
    expect(replayA?.session.reviewedCount).toBe(2);
    expect(replayA?.currentPosition).toBe(2);
    expect((await sessionRef.get()).data()).toEqual(afterB);
    expect((await chunkRef.get()).data()?.items.map((item: { status: string }) => item.status))
      .toEqual(['reviewed', 'reviewed', 'pending']);

    expect((await rate(requestC, 3, 2))?.session.reviewedCount).toBe(3);
    const completedRoot = (await sessionRef.get()).data();
    const completedChunk = (await chunkRef.get()).data();
    expect(completedRoot).toMatchObject({ status: 'completed', reviewedCount: 3, remainingQueueCount: 0 });
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(3);
    const completedRetryA = await rate(requestA, 4);
    expect(completedRetryA?.session.reviewedCount).toBe(3);
    expect((await sessionRef.get()).data()).toEqual(completedRoot);
    expect((await chunkRef.get()).data()).toEqual(completedChunk);
    expect((await chunkRef.get()).data()?.items.map((item: { status: string }) => item.status))
      .toEqual(['reviewed', 'reviewed', 'reviewed']);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).empty).toBe(true);
    for (let index = 0; index < cardIds.length; index += 1) {
      expect((await db.collection('flashcards').doc(cardIds[index]).get()).data()).toEqual(cardBefore[index]);
    }
  });


  it('concurrent replays of the same request both return one committed claim', async () => {
    const ownerId = ownerFor('session-same-key-race');
    const cardIds = await seedCards(ownerId, 2, 'same-key-race-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    const requestId = `same-key-race-${runId}`;
    const input = { rating: 3 as const, requestId, expectedPosition: 0, expectedCardId: cardIds[0] };
    const results = await Promise.all([
      submitSessionReview(started.session.id, input, ownerId),
      submitSessionReview(started.session.id, input, ownerId),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result?.requestId === requestId)).toBe(true);
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    expect((await sessionRef.get()).data()).toMatchObject({ reviewedCount: 1, ratingCounts: { good: 1 } });
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(1);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).size).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);
  });
  it('persists valid out-of-order positions without skipping the earlier card', async () => {
    const ownerId = ownerFor('session-out-of-order');
    const cardIds = await seedCards(ownerId, 3, 'out-of-order-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    const later = await submitSessionReview(started.session.id, {
      rating: 4, requestId: `out-of-order-later-${runId}`, expectedPosition: 1, expectedCardId: cardIds[1],
    }, ownerId);
    expect(later?.session.reviewedCount).toBe(1);
    const afterLater = (await db.collection('reviewSessions').doc(started.session.id).get()).data();
    expect(afterLater).toMatchObject({ status: 'active', currentPosition: 0, reviewedCount: 1, remainingQueueCount: 2 });
    const earlier = await submitSessionReview(started.session.id, {
      rating: 3, requestId: `out-of-order-earlier-${runId}`, expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId);
    expect(earlier?.session.reviewedCount).toBe(2);
    expect(earlier?.currentPosition).toBe(2);
    expect((await readChunk(started.session.id, 0)).data()?.items.map((item: { cardId: string; status: string }) =>
      ({ cardId: item.cardId, status: item.status }))).toEqual([
      { cardId: cardIds[0], status: 'reviewed' },
      { cardId: cardIds[1], status: 'reviewed' },
      { cardId: cardIds[2], status: 'pending' },
    ]);
    const events = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    expect(events.size).toBe(2);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[1]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[2]).get()).data()?.reps).toBe(0);
  });

  it('scopes request IDs to the owner and session and retries historical event IDs without a new claim', async () => {
    const ownerId = ownerFor('session-request-scope');
    const cardIds = await seedCards(ownerId, 6, 'request-scope-card');
    const firstSession = await startReviewSession({ cardIds: cardIds.slice(0, 3) }, ownerId);
    const secondSession = await startReviewSession({ cardIds: cardIds.slice(3, 5) }, ownerId);
    const first = await submitSessionReview(firstSession.session.id, {
      rating: 3, requestId: sharedRequestId, expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId);
    const second = await submitSessionReview(secondSession.session.id, {
      rating: 4, requestId: sharedRequestId, expectedPosition: 0, expectedCardId: cardIds[3],
    }, ownerId);
    expect(first?.session.reviewedCount).toBe(1);
    expect(second?.session.reviewedCount).toBe(1);
    const bothSessionEvents = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('requestId', '==', sharedRequestId).get();
    expect(bothSessionEvents.size).toBe(2);
    expect(new Set(bothSessionEvents.docs.map((doc) => doc.data().sessionId)))
      .toEqual(new Set([firstSession.session.id, secondSession.session.id]));
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[3]).get()).data()?.reps).toBe(1);

    const firstChunk = (await readChunk(firstSession.session.id, 0)).data();
    const eventDocs = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', firstSession.session.id).where('requestId', '==', sharedRequestId).get();
    expect(eventDocs.size).toBe(1);
    const event = eventDocs.docs[0].data();
    const opaqueEventId = `historical-event-${runId}`;
    await db.collection('reviewEvents').doc(opaqueEventId).create(event);
    await eventDocs.docs[0].ref.delete();
    expect(firstChunk?.items[0]).toMatchObject({ cardId: cardIds[0], status: 'reviewed' });
    expect(event).toMatchObject({ cardId: cardIds[0], sessionId: firstSession.session.id, requestId: sharedRequestId });
    expect((await db.collection('flashcards').doc(cardIds[2]).get()).data()?.reps).toBe(0);
    const firstSessionRef = db.collection('reviewSessions').doc(firstSession.session.id);
    const claimsBeforeReplay = await firstSessionRef.collection('requestClaims').get();
    expect(claimsBeforeReplay.size).toBe(1);
    const retry = await submitSessionReview(firstSession.session.id, {
      rating: 3, requestId: sharedRequestId,
    }, ownerId);
    expect(retry?.session.reviewedCount).toBe(1);
    expect(retry?.card?.id).toBe(cardIds[1]);
    expect(retry?.currentPosition).toBe(1);
    expect((await db.collection('reviewSessions').doc(firstSession.session.id).get()).data())
      .toMatchObject({ reviewedCount: 1, deletedCount: 0, remainingQueueCount: 2 });
    expect((await firstSessionRef.collection('requestClaims').get()).size).toBe(claimsBeforeReplay.size);
    expect((await db.collection('reviewEvents').doc(opaqueEventId).get()).data()).toEqual(event);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', firstSession.session.id).get()).size).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);
  });
  it('replays opaque historical events on legacy roots after fresh progress and completion without stamping the claim version', async () => {
    const ownerId = ownerFor('session-legacy-event-replay');
    const cardIds = await seedCards(ownerId, 3, 'legacy-event-replay-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const firstRequestId = `legacy-event-first-${runId}`;

    await submitSessionReview(started.session.id, {
      rating: 3, requestId: firstRequestId, expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId);
    const firstEventQuery = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).where('requestId', '==', firstRequestId).get();
    expect(firstEventQuery.size).toBe(1);
    const firstEvent = firstEventQuery.docs[0].data();
    const opaqueEventId = `legacy-opaque-event-${runId}`;
    await db.collection('reviewEvents').doc(opaqueEventId).create(firstEvent);
    await firstEventQuery.docs[0].ref.delete();

    await sessionRef.update({ requestClaimsVersion: FieldValue.delete() });
    await deleteDocs((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.ref));
    expect((await sessionRef.get()).data()).not.toHaveProperty('requestClaimsVersion');
    expect((await sessionRef.collection('requestClaims').get()).empty).toBe(true);

    const secondRequestId = `legacy-event-second-${runId}`;
    await submitSessionReview(started.session.id, {
      rating: 4, requestId: secondRequestId, expectedPosition: 1, expectedCardId: cardIds[1],
    }, ownerId);
    const afterFreshProgress = (await sessionRef.get()).data();
    expect(afterFreshProgress).toMatchObject({ status: 'active', reviewedCount: 2, lastRequestId: secondRequestId });
    expect(afterFreshProgress).not.toHaveProperty('requestClaimsVersion');
    const claimsAfterProgress = await sessionRef.collection('requestClaims').get();
    expect(claimsAfterProgress.docs.map((doc) => doc.data().requestId)).toEqual([secondRequestId]);

    const eventsBeforeReplay = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    const replayAfterProgress = await submitSessionReview(started.session.id, {
      rating: 3, requestId: firstRequestId,
    }, ownerId);
    expect(replayAfterProgress?.session.reviewedCount).toBe(2);
    expect(replayAfterProgress?.card?.id).toBe(cardIds[2]);
    expect(replayAfterProgress?.currentPosition).toBe(2);
    expect((await sessionRef.get()).data()).toEqual(afterFreshProgress);
    expect((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.data().requestId))
      .toEqual([secondRequestId]);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).size).toBe(eventsBeforeReplay.size);
    expect((await db.collection('reviewEvents').doc(opaqueEventId).get()).data()).toEqual(firstEvent);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);

    const thirdRequestId = `legacy-event-third-${runId}`;
    await submitSessionReview(started.session.id, {
      rating: 3, requestId: thirdRequestId, expectedPosition: 2, expectedCardId: cardIds[2],
    }, ownerId);
    const afterCompletion = (await sessionRef.get()).data();
    expect(afterCompletion).toMatchObject({ status: 'completed', reviewedCount: 3, lastRequestId: thirdRequestId });
    expect(afterCompletion).not.toHaveProperty('requestClaimsVersion');
    const claimsAfterCompletion = await sessionRef.collection('requestClaims').get();
    expect(claimsAfterCompletion.docs.map((doc) => doc.data().requestId).sort())
      .toEqual([secondRequestId, thirdRequestId].sort());

    const eventsAtCompletion = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    const replayAfterCompletion = await submitSessionReview(started.session.id, {
      rating: 3, requestId: firstRequestId,
    }, ownerId);
    expect(replayAfterCompletion?.session.reviewedCount).toBe(3);
    expect(replayAfterCompletion?.card).toBeNull();
    expect(replayAfterCompletion?.currentPosition).toBeNull();
    expect((await sessionRef.get()).data()).toEqual(afterCompletion);
    expect((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.data().requestId).sort())
      .toEqual([secondRequestId, thirdRequestId].sort());
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).size).toBe(eventsAtCompletion.size);
    expect((await db.collection('reviewEvents').doc(opaqueEventId).get()).data()).toEqual(firstEvent);
    for (const id of cardIds) expect((await db.collection('flashcards').doc(id).get()).data()?.reps).toBe(1);
  });

  it('keeps foreign cards private and immutable when an owned legacy session references them', async () => {
    const ownerId = ownerFor('session-legacy-foreign-card-owner');
    const foreignOwnerId = ownerFor('session-legacy-foreign-card-target');
    const ownedCardIds = await seedCards(ownerId, 2, 'legacy-foreign-owned-card');
    const foreignCardId = cardIdFor('legacy-foreign-target', 0);
    await db.collection('flashcards').doc(foreignCardId).create(
      cardDocument(foreignOwnerId, 'private foreign front', 'private foreign back', 0),
    );
    const foreignRef = db.collection('flashcards').doc(foreignCardId);

    async function makeLegacySession(cardIds: string[], processedRequestIds: string[] = []) {
      const started = await startReviewSession({ cardIds: ownedCardIds }, ownerId);
      const ref = db.collection('reviewSessions').doc(started.session.id);
      await ref.update({
        storageVersion: FieldValue.delete(),
        requestClaimsVersion: FieldValue.delete(),
        cardIds,
        currentIndex: 0,
        reviewedCount: 0,
        reviewedCardIds: [],
        processedRequestIds,
      });
      return { id: started.session.id, ref };
    }

    const currentRoot = await makeLegacySession([foreignCardId, ...ownedCardIds]);
    const preloadRoot = await makeLegacySession([ownedCardIds[0], foreignCardId, ownedCardIds[1]]);
    const cachedRequestId = `legacy-foreign-cached-${runId}`;
    const cachedRoot = await makeLegacySession(
      [foreignCardId, ...ownedCardIds],
      [cachedRequestId],
    );
    await cachedRoot.ref.update({ lastRequestId: cachedRequestId });

    const currentHydrated = await getReviewSession(currentRoot.id, ownerId);
    const preloadHydrated = await getReviewSession(preloadRoot.id, ownerId);
    const cachedResult = await submitSessionReview(cachedRoot.id, {
      rating: 3, requestId: cachedRequestId,
    }, ownerId);
    const rootBeforeSubmit = (await currentRoot.ref.get()).data();
    const foreignBeforeSubmit = (await foreignRef.get()).data();
    const ownedBeforeSubmit = await Promise.all(ownedCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    const eventsBeforeSubmit = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', currentRoot.id).get();
    let submitResult: Awaited<ReturnType<typeof submitSessionReview>> = null;
    let submitError: unknown;
    try {
      submitResult = await submitSessionReview(currentRoot.id, {
        rating: 3,
        requestId: `legacy-foreign-submit-${runId}`,
        expectedCardId: foreignCardId,
      }, ownerId);
    } catch (error) {
      submitError = error;
    }
    const rootAfterSubmit = (await currentRoot.ref.get()).data();
    const foreignAfterSubmit = (await foreignRef.get()).data();
    const ownedAfterSubmit = await Promise.all(ownedCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    const eventsAfterSubmit = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', currentRoot.id).get();

    expect(currentHydrated?.card).toBeNull();
    expect(JSON.stringify(currentHydrated)).not.toContain('private foreign front');
    expect(JSON.stringify(currentHydrated)).not.toContain('private foreign back');
    expect(preloadHydrated?.preloaded.map((card) => card.id)).not.toContain(foreignCardId);
    expect(JSON.stringify(preloadHydrated?.preloaded)).not.toContain('private foreign front');
    expect(JSON.stringify(preloadHydrated?.preloaded)).not.toContain('private foreign back');
    expect(cachedResult?.card).toBeNull();
    expect(submitError).toBeInstanceOf(ReviewExpectedCardMismatchError);
    expect(submitResult).toBeNull();
    expect(rootAfterSubmit).toEqual(rootBeforeSubmit);
    expect(foreignAfterSubmit).toEqual(foreignBeforeSubmit);
    expect(ownedAfterSubmit).toEqual(ownedBeforeSubmit);
    expect(eventsAfterSubmit.docs.map((doc) => doc.data()))
      .toEqual(eventsBeforeSubmit.docs.map((doc) => doc.data()));
  });


  it('treats foreign v2 current, preloaded, and out-of-order cards as deleted without disclosure', async () => {
    const ownerId = ownerFor('session-v2-foreign-card-owner');
    const foreignOwnerId = ownerFor('session-v2-foreign-card-target');
    const ownedCardIds = await seedCards(ownerId, 4, 'v2-foreign-owned-card');
    const foreignCardIds = [cardIdFor('v2-foreign-target', 0), cardIdFor('v2-foreign-target', 1)];
    const foreignCards = foreignCardIds.map((id) => ({
      id,
      data: cardDocument(foreignOwnerId, `private ${id} front`, `private ${id} back`, 0),
    }));
    for (const card of foreignCards) {
      await db.collection('flashcards').doc(card.id).create(card.data);
    }
    const started = await startReviewSession({ cardIds: ownedCardIds }, ownerId);
    const chunk = await readChunk(started.session.id, 0);
    await chunk.ref.update({
      items: [
        { cardId: foreignCardIds[0], status: 'pending' },
        { cardId: ownedCardIds[0], status: 'pending' },
        { cardId: foreignCardIds[1], status: 'pending' },
        { cardId: ownedCardIds[1], status: 'pending' },
      ],
    });

    const foreignBefore = await Promise.all(foreignCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    const ownedBefore = await Promise.all(ownedCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const hydrated = await getReviewSession(started.session.id, ownerId);
    expect(hydrated?.card?.id).toBe(ownedCardIds[0]);
    expect(hydrated?.currentPosition).toBe(1);
    expect(hydrated?.preloaded.map((card) => card.id)).toEqual([ownedCardIds[1]]);
    expect(JSON.stringify(hydrated)).not.toContain('private ');
    expect((await sessionRef.get()).data()).toMatchObject({
      status: 'active', currentPosition: 1, deletedCount: 1, remainingQueueCount: 3,
    });
    const chunkAfterGet = await readChunk(started.session.id, 0);
    expect(chunkAfterGet.data()?.items.map((item: { status: string }) => item.status))
      .toEqual(['deleted', 'pending', 'pending', 'pending']);

    const eventsBefore = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    const requestId = `v2-foreign-out-of-order-${runId}`;
    const submitted = await submitSessionReview(started.session.id, {
      rating: 3, requestId, expectedPosition: 2, expectedCardId: foreignCardIds[1],
    }, ownerId);
    expect(submitted?.card?.id).toBe(ownedCardIds[0]);
    expect(JSON.stringify(submitted)).not.toContain('private ');
    const rootAfterSubmit = (await sessionRef.get()).data();
    const chunkAfterSubmit = (await readChunk(started.session.id, 0)).data();
    expect(rootAfterSubmit).toMatchObject({
      status: 'active', currentPosition: 1, deletedCount: 2, reviewedCount: 0, remainingQueueCount: 2,
    });
    expect(chunkAfterSubmit?.items.map((item: { status: string }) => item.status))
      .toEqual(['deleted', 'pending', 'deleted', 'pending']);
    const foreignAfterSubmit = await Promise.all(foreignCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()));
    expect(foreignAfterSubmit).toEqual(foreignBefore);
    expect(await Promise.all(ownedCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()))).toEqual(ownedBefore);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).docs.map((doc) => doc.data()))
      .toEqual(eventsBefore.docs.map((doc) => doc.data()));

    const duplicate = await submitSessionReview(started.session.id, {
      rating: 3, requestId, expectedPosition: 2, expectedCardId: foreignCardIds[1],
    }, ownerId);
    expect(duplicate?.card?.id).toBe(ownedCardIds[0]);
    expect(JSON.stringify(duplicate)).not.toContain('private ');
    expect((await sessionRef.get()).data()).toEqual(rootAfterSubmit);
    expect((await readChunk(started.session.id, 0)).data()).toEqual(chunkAfterSubmit);
    expect(await Promise.all(foreignCardIds.map(async (id) =>
      (await db.collection('flashcards').doc(id).get()).data()))).toEqual(foreignBefore);
  });

  it('fails unknown retries on a legacy deleted-progress root before any mutation', async () => {
    const ownerId = ownerFor('session-legacy-deleted-retry');
    const cardIds = await seedCards(ownerId, 2, 'legacy-deleted-retry-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    await db.collection('flashcards').doc(cardIds[0]).delete();
    await submitSessionReview(started.session.id, {
      rating: 3, requestId: `legacy-delete-first-${runId}`, expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId);

    await sessionRef.update({ requestClaimsVersion: FieldValue.delete() });
    await deleteDocs((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.ref));
    const rootBefore = (await sessionRef.get()).data();
    const chunkRefAtStart = (await readChunk(started.session.id, 0)).ref;
    const chunkBefore = (await chunkRefAtStart.get()).data();
    const cardBefore = (await db.collection('flashcards').doc(cardIds[1]).get()).data();
    const eventsBefore = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get();
    const claimsBefore = await sessionRef.collection('requestClaims').get();
    expect(rootBefore).toMatchObject({ deletedCount: 1, currentPosition: 1 });
    expect(rootBefore).not.toHaveProperty('requestClaimsVersion');
    expect(eventsBefore.empty).toBe(true);
    expect(claimsBefore.empty).toBe(true);

    await expect(submitSessionReview(started.session.id, {
      rating: 3, requestId: `legacy-delete-unknown-${runId}`, expectedPosition: 1, expectedCardId: cardIds[1],
    }, ownerId)).rejects.toBeInstanceOf(ReviewSessionRetryHistoryUnavailableError);

    expect((await sessionRef.get()).data()).toEqual(rootBefore);
    expect((await chunkRefAtStart.get()).data()).toEqual(chunkBefore);
    expect((await db.collection('flashcards').doc(cardIds[1]).get()).data()).toEqual(cardBefore);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).docs.map((doc) => doc.data()))
      .toEqual(eventsBefore.docs.map((doc) => doc.data()));
    expect((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.data()))
      .toEqual(claimsBefore.docs.map((doc) => doc.data()));
  });
  it('rejects unknown session storage and request-claim versions after ownership checks and before mutation', async () => {
    for (const [index, version] of [2, '1', null].entries()) {
      const ownerId = ownerFor(`session-unknown-claim-version-${index}`);
      const cardIds = await seedCards(ownerId, 2, `unknown-claim-version-${index}`);
      const started = await startReviewSession({ cardIds }, ownerId);
      const sessionRef = db.collection('reviewSessions').doc(started.session.id);
      await sessionRef.update({ requestClaimsVersion: version });

      const rootBefore = (await sessionRef.get()).data();
      const chunkRefAtStart = (await readChunk(started.session.id, 0)).ref;
      const chunkBefore = (await chunkRefAtStart.get()).data();
      const cardsBefore = await Promise.all(cardIds.map(async (id) =>
        (await db.collection('flashcards').doc(id).get()).data()));
      const eventsBefore = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
        .where('sessionId', '==', started.session.id).get();
      const claimsBefore = await sessionRef.collection('requestClaims').get();
      const requestId = `unknown-claim-version-${index}-${runId}`;
      const input = { rating: 3 as const, requestId, expectedPosition: 0, expectedCardId: cardIds[0] };

      await expect(submitSessionReview(started.session.id, input, `${ownerId}-wrong-owner`))
        .rejects.toBeInstanceOf(ReviewSessionForbiddenError);
      await expect(submitSessionReview(started.session.id, input, ownerId))
        .rejects.toBeInstanceOf(ReviewSessionBuildFailedError);

      expect((await sessionRef.get()).data()).toEqual(rootBefore);
      expect((await chunkRefAtStart.get()).data()).toEqual(chunkBefore);
      expect(await Promise.all(cardIds.map(async (id) =>
        (await db.collection('flashcards').doc(id).get()).data()))).toEqual(cardsBefore);
      expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
        .where('sessionId', '==', started.session.id).get()).docs.map((doc) => doc.data()))
        .toEqual(eventsBefore.docs.map((doc) => doc.data()));
      expect((await sessionRef.collection('requestClaims').get()).docs.map((doc) => doc.data()))
        .toEqual(claimsBefore.docs.map((doc) => doc.data()));
    }
    const observations: Array<Record<string, string | boolean>> = [];
    const actions = ['get', 'end', 'repeat', 'submit'] as const;
    const storageVersions: Array<number | string | null> = [3, '2', null, Number.NaN];
    for (const [versionIndex, storageVersion] of storageVersions.entries()) {
      for (const action of actions) {
        const ownerId = ownerFor(`session-unknown-storage-${versionIndex}-${action}`);
        const cardIds = await seedCards(ownerId, 2, `unknown-storage-${versionIndex}-${action}`);
        const started = await startReviewSession({ cardIds }, ownerId);
        const sessionId = started.session.id;
        const sessionRef = db.collection('reviewSessions').doc(sessionId);
        await sessionRef.update({
          storageVersion,
          requestClaimsVersion: FieldValue.delete(),
          cardIds,
          currentIndex: 0,
          reviewedCount: 0,
          reviewedCardIds: [],
          processedRequestIds: [],
        });

        let ownerOutcome = 'returned';
        try {
          await getReviewSession(sessionId, `${ownerId}-wrong-owner`);
        } catch (error) {
          ownerOutcome = error instanceof Error ? error.name : typeof error;
        }
        const rootBefore = (await sessionRef.get()).data();
        const chunkRefAtStart = (await readChunk(sessionId, 0)).ref;
        const chunkBefore = (await chunkRefAtStart.get()).data();
        const cardsBefore = await Promise.all(cardIds.map(async (id) =>
          (await db.collection('flashcards').doc(id).get()).data()));
        const eventsBefore = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
          .where('sessionId', '==', sessionId).get();
        const claimsBefore = await sessionRef.collection('requestClaims').get();
        const sessionsBefore = (await db.collection('reviewSessions').where('ownerId', '==', ownerId).get()).size;

        let outcome = 'returned';
        try {
          if (action === 'get') {
            await getReviewSession(sessionId, ownerId);
          } else if (action === 'end') {
            await endReviewSession(sessionId, ownerId);
          } else if (action === 'repeat') {
            await startReviewSession({ repeatSessionId: sessionId }, ownerId);
          } else {
            await submitSessionReview(sessionId, {
              rating: 3, requestId: `unknown-storage-${versionIndex}-${runId}`,
              expectedPosition: 0, expectedCardId: cardIds[0],
            }, ownerId);
          }
        } catch (error) {
          outcome = error instanceof Error ? error.name : typeof error;
        }

        const rootAfter = (await sessionRef.get()).data();
        const chunkAfter = (await chunkRefAtStart.get()).data();
        const cardsAfter = await Promise.all(cardIds.map(async (id) =>
          (await db.collection('flashcards').doc(id).get()).data()));
        const eventsAfter = await db.collection('reviewEvents').where('ownerId', '==', ownerId)
          .where('sessionId', '==', sessionId).get();
        const claimsAfter = await sessionRef.collection('requestClaims').get();
        const sessionsAfter = (await db.collection('reviewSessions').where('ownerId', '==', ownerId).get()).size;
        const versionLabel = typeof storageVersion === 'number' && Number.isNaN(storageVersion)
          ? 'NaN'
          : String(storageVersion);
        observations.push({
          version: versionLabel,
          action,
          ownerOutcome,
          outcome,
          rootUnchanged: isDeepStrictEqual(rootBefore, rootAfter),
          chunkUnchanged: isDeepStrictEqual(chunkBefore, chunkAfter),
          cardsUnchanged: isDeepStrictEqual(cardsBefore, cardsAfter),
          eventsUnchanged: isDeepStrictEqual(eventsBefore.docs.map((doc) => doc.data()), eventsAfter.docs.map((doc) => doc.data())),
          claimsUnchanged: isDeepStrictEqual(claimsBefore.docs.map((doc) => doc.data()), claimsAfter.docs.map((doc) => doc.data())),
          sessionCountUnchanged: sessionsBefore === sessionsAfter,
        });
      }
    }
    const expected = storageVersions.flatMap((storageVersion) => actions.map((action) => ({
      version: typeof storageVersion === 'number' && Number.isNaN(storageVersion) ? 'NaN' : String(storageVersion),
      action,
      ownerOutcome: 'ReviewSessionForbiddenError',
      outcome: 'ReviewSessionBuildFailedError',
      rootUnchanged: true,
      chunkUnchanged: true,
      cardsUnchanged: true,
      eventsUnchanged: true,
      claimsUnchanged: true,
      sessionCountUnchanged: true,
    })));
    if (!isDeepStrictEqual(observations, expected)) {
      console.log('unknown storageVersion before/after observations:', JSON.stringify(observations));
    }
    expect(observations).toEqual(expected);
  });
  it('rejects ambiguous legacy learning state without mutating the queued card claims', async () => {
    const ownerId = ownerFor('session-invalid-legacy-learning');
    const cardIds = await seedCards(ownerId, 3, 'invalid-learning-card');
    await db.collection('flashcards').doc(cardIds[0]).update({
      state: 1,
      reps: 4,
      learningSteps: FieldValue.delete(),
      reviewLog: [],
    });
    const started = await startReviewSession({ cardIds }, ownerId);
    await db.collection('flashcards').doc(cardIds[1]).delete();
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const chunkRef = (await readChunk(started.session.id, 0)).ref;
    const beforeRoot = (await sessionRef.get()).data();
    const beforeChunk = (await chunkRef.get()).data();
    const beforeInvalidCard = (await db.collection('flashcards').doc(cardIds[0]).get()).data();

    await expect(submitSessionReview(started.session.id, {
      rating: 3, requestId: 'ambiguous-learning-submit', expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId)).rejects.toBeInstanceOf(LearningProgressUnavailableError);
    expect((await sessionRef.get()).data()).toEqual(beforeRoot);
    expect((await chunkRef.get()).data()).toEqual(beforeChunk);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()).toEqual(beforeInvalidCard);
    expect((await db.collection('flashcards').doc(cardIds[2]).get()).data()?.reps).toBe(0);
    expect((await db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id).get()).empty).toBe(true);
  });


  it('claims the same position at most once and independently commits concurrent distinct positions', async () => {
    const ownerId = ownerFor('session-concurrency');
    const cardIds = await seedCards(ownerId, 6, 'concurrent-card');
    const samePosition = await startReviewSession({ cardIds: cardIds.slice(0, 3) }, ownerId);
    const sameResults = await Promise.allSettled([
      submitSessionReview(samePosition.session.id, {
        rating: 3, requestId: 'same-position-a', expectedPosition: 0, expectedCardId: cardIds[0],
      }, ownerId),
      submitSessionReview(samePosition.session.id, {
        rating: 4, requestId: 'same-position-b', expectedPosition: 0, expectedCardId: cardIds[0],
      }, ownerId),
    ]);
    expect(sameResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = sameResults.find((result) => result.status === 'rejected');
    expect(loser).toMatchObject({ status: 'rejected' });
    const loserError = (loser as PromiseRejectedResult).reason;
    if (!(loserError instanceof ReviewExpectedCardMismatchError)) {
      const code = loserError && typeof loserError === 'object' && 'code' in loserError
        ? ` code=${String(loserError.code)}`
        : '';
      const detail = loserError instanceof Error
        ? `${loserError.name}${code}: ${loserError.message}\n${loserError.stack ?? ''}`
        : String(loserError);
      throw new Error(`Expected a typed same-position mismatch; received ${detail}`);
    }
    const sameRoot = (await db.collection('reviewSessions').doc(samePosition.session.id).get()).data();
    const sameEvents = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', samePosition.session.id).get();
    expect(sameRoot?.reviewedCount).toBe(1);
    const onlyRating = sameEvents.docs[0].data().rating;
    expect(sameRoot?.ratingCounts).toMatchObject({ ratingCounts: { [onlyRating]: 1 } });
    expect(sameEvents.size).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[0]).get()).data()?.reps).toBe(1);

    const distinct = await startReviewSession({ cardIds: cardIds.slice(3, 6) }, ownerId);
    const distinctResults = await Promise.all([
      submitSessionReview(distinct.session.id, {
        rating: 3, requestId: 'distinct-position-a', expectedPosition: 0, expectedCardId: cardIds[3],
      }, ownerId),
      submitSessionReview(distinct.session.id, {
        rating: 4, requestId: 'distinct-position-b', expectedPosition: 1, expectedCardId: cardIds[4],
      }, ownerId),
    ]);
    expect(distinctResults.map((result) => result?.session.reviewedCount).sort()).toEqual([1, 2]);
    const distinctRoot = (await db.collection('reviewSessions').doc(distinct.session.id).get()).data();
    const distinctEvents = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', distinct.session.id).get();
    expect(distinctRoot).toMatchObject({ reviewedCount: 2, currentPosition: 2, remainingQueueCount: 1 });
    expect(distinctRoot?.ratingCounts).toMatchObject({ ratingCounts: { 3: 1, 4: 1 } });
    expect(distinctEvents.size).toBe(2);
    expect((await db.collection('flashcards').doc(cardIds[3]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[4]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[5]).get()).data()?.reps).toBe(0);
  }, 30_000);

  it('persists deleted-first-card progress and rejects a mismatched displayed-card claim', async () => {
    const ownerId = ownerFor('session-deleted-head');
    const cardIds = await seedCards(ownerId, 3, 'deleted-head-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    await db.collection('flashcards').doc(cardIds[0]).delete();

    const hydrated = await getReviewSession(started.session.id, ownerId);
    expect(hydrated?.card?.id).toBe(cardIds[1]);
    expect(hydrated).toMatchObject({ currentPosition: 1, session: { currentPosition: 1 },
      queueWindow: { currentPosition: 1, currentCardId: cardIds[1] } });
    expect(hydrated?.queueWindow?.cardIds[0]).toEqual({ cardId: cardIds[1], position: 1 });
    expect(hydrated?.preloaded.map((card) => card.id)).toContain(cardIds[2]);
    const queue = (await readChunk(started.session.id, 0)).data()?.items;
    expect(queue.map((item: { cardId: string }) => item.cardId)).toEqual(cardIds);
    expect(queue.map((item: { status: string }) => item.status)).toEqual(['deleted', 'pending', 'pending']);

    await expect(submitSessionReview(started.session.id, {
      rating: 3, requestId: 'wrong-displayed-card', expectedPosition: 1, expectedCardId: cardIds[2],
    }, ownerId)).rejects.toBeInstanceOf(ReviewExpectedCardMismatchError);
    const eventsAfterMismatch = await db.collection('reviewEvents')
      .where('ownerId', '==', ownerId).where('sessionId', '==', started.session.id).get();
    expect(eventsAfterMismatch.empty).toBe(true);
    expect((await db.collection('reviewSessions').doc(started.session.id).get()).data())
      .toMatchObject({ reviewedCount: 0, deletedCount: 1, remainingQueueCount: 2, currentPosition: 1 });

    const correct = await submitSessionReview(started.session.id, {
      rating: 3, requestId: 'right-displayed-card', expectedPosition: hydrated!.currentPosition!,
      expectedCardId: hydrated!.card!.id,
    }, ownerId);
    expect(correct?.session.reviewedCount).toBe(1);
    expect(correct?.card?.id).toBe(cardIds[2]);
    expect((await db.collection('flashcards').doc(cardIds[1]).get()).data()?.reps).toBe(1);
    expect((await db.collection('flashcards').doc(cardIds[2]).get()).data()?.reps).toBe(0);
  });
  it('round-trips a named session through get and submit', async () => {
    const ownerId = ownerFor('session-named-roundtrip');
    const cardIds = await seedCards(ownerId, 2, 'named-session-card');
    const name = `Named session ${runId}`;
    const started = await startReviewSession({ cardIds, name }, ownerId);
    expect(started.session.name).toBe(name);
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    expect((await sessionRef.get()).data()).toMatchObject({ ownerId, name });

    const loaded = await getReviewSession(started.session.id, ownerId);
    expect(loaded).toMatchObject({ session: { id: started.session.id }, card: { id: cardIds[0] } });
    expect(loaded?.session.name).toBe(name);

    const submitted = await submitSessionReview(started.session.id, {
      rating: 3, requestId: `named-session-submit-${runId}`, expectedPosition: 0, expectedCardId: cardIds[0],
    }, ownerId);
    expect(submitted).toMatchObject({ session: { reviewedCount: 1 }, card: { id: cardIds[1] } });
    expect(submitted?.session.name).toBe(name);
    expect((await sessionRef.get()).data()).toMatchObject({ ownerId, name, reviewedCount: 1 });
  });
  it('preserves exact padded Firestore card IDs through start, get, and submit', async () => {
    const ownerId = ownerFor('session-padded-card-id');
    const paddedId = ` ${cardIdFor('session-padded-card-id', 0)} `;
    const trimmedId = paddedId.trim();
    const paddedFront = `Padded ID front ${runId}`;
    const trimmedFront = `Trimmed decoy front ${runId}`;
    const paddedRef = db.collection('flashcards').doc(paddedId);
    const trimmedRef = db.collection('flashcards').doc(trimmedId);
    await paddedRef.create(cardDocument(ownerId, paddedFront, `Padded answer ${runId}`, 0));
    await trimmedRef.create(cardDocument(ownerId, trimmedFront, `Decoy answer ${runId}`, 1));

    const started = await startReviewSession({ cardIds: [paddedId, trimmedId, paddedId] }, ownerId);
    expect(started.card).toMatchObject({ id: paddedId, front: paddedFront });
    const chunk = await readChunk(started.session.id, 0);
    expect(chunk.data()?.items.map((item: { cardId: string }) => item.cardId)).toEqual([paddedId, trimmedId]);

    const loaded = await getReviewSession(started.session.id, ownerId);
    expect(loaded?.card).toMatchObject({ id: paddedId, front: paddedFront });
    const paddedBefore = (await paddedRef.get()).data();
    const trimmedBefore = (await trimmedRef.get()).data();
    const events = db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id);
    expect((await events.get()).empty).toBe(true);

    const requestId = `padded-card-id-submit-${runId}`;
    const submitted = await submitSessionReview(started.session.id, {
      rating: 3, requestId, expectedPosition: 0, expectedCardId: paddedId,
    }, ownerId);
    expect(submitted?.session.reviewedCount).toBe(1);
    expect(submitted?.card).toMatchObject({ id: trimmedId, front: trimmedFront });
    expect((await paddedRef.get()).data()?.reps).toBe((paddedBefore?.reps as number) + 1);
    expect((await trimmedRef.get()).data()).toEqual(trimmedBefore);
    const eventsAfter = await events.get();
    expect(eventsAfter.size).toBe(1);
    expect(eventsAfter.docs[0].data()).toMatchObject({ cardId: paddedId, requestId });
    expect(eventsAfter.docs.map((doc) => doc.data().cardId)).not.toContain(trimmedId);
  });

  it('does not double-count a normal-mode deleted-target retry', async () => {
    const ownerId = ownerFor('session-deleted-target-retry');
    const cardIds = await seedCards(ownerId, 3, 'deleted-target-retry-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    await db.collection('flashcards').doc(cardIds[0]).delete();
    const sessionRef = db.collection('reviewSessions').doc(started.session.id);
    const chunkRef = (await readChunk(started.session.id, 0)).ref;
    const nextLiveCardRef = db.collection('flashcards').doc(cardIds[1]);
    const nextLiveCardBefore = (await nextLiveCardRef.get()).data();
    const events = db.collection('reviewEvents').where('ownerId', '==', ownerId)
      .where('sessionId', '==', started.session.id);
    const eventsBefore = await events.get();
    const eventRecordsBefore = eventsBefore.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    expect(eventsBefore.empty).toBe(true);
    const requestId = `deleted-target-retry-${runId}`;
    const input = { rating: 3 as const, requestId, expectedPosition: 0, expectedCardId: cardIds[0] };

    const first = await submitSessionReview(started.session.id, input, ownerId);
    expect(first).toMatchObject({ session: { reviewedCount: 0, deletedCount: 1, remainingQueueCount: 2 },
      card: { id: cardIds[1] }, currentPosition: 1 });
    const rootAfterClaim = (await sessionRef.get()).data();
    const chunkAfterClaim = (await chunkRef.get()).data();
    expect((await readChunk(started.session.id, 0)).data()?.items.map((item: { status: string }) => item.status))
      .toEqual(['deleted', 'pending', 'pending']);
    const nextLiveCardAfterFirst = (await nextLiveCardRef.get()).data();
    expect(nextLiveCardAfterFirst).toEqual(nextLiveCardBefore);
    expect(nextLiveCardAfterFirst?.reps).toBe(nextLiveCardBefore?.reps);
    const eventsAfterFirst = await events.get();
    expect(eventsAfterFirst.docs.map((doc) => ({ id: doc.id, data: doc.data() }))).toEqual(eventRecordsBefore);
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(1);

    const retry = await submitSessionReview(started.session.id, input, ownerId);
    expect(retry).toMatchObject({ session: { reviewedCount: 0, deletedCount: 1, remainingQueueCount: 2 },
      card: { id: cardIds[1] }, currentPosition: 1 });
    expect((await sessionRef.get()).data()).toEqual(rootAfterClaim);
    expect((await chunkRef.get()).data()).toEqual(chunkAfterClaim);
    const nextLiveCardAfterRetry = (await nextLiveCardRef.get()).data();
    expect(nextLiveCardAfterRetry).toEqual(nextLiveCardBefore);
    expect(nextLiveCardAfterRetry?.reps).toBe(nextLiveCardBefore?.reps);
    const eventsAfterRetry = await events.get();
    expect(eventsAfterRetry.docs.map((doc) => ({ id: doc.id, data: doc.data() }))).toEqual(eventRecordsBefore);
    expect((await sessionRef.collection('requestClaims').get()).size).toBe(1);
  });

  it('advances through more than two deleted chunks to the live tail with exact counts', async () => {
    const ownerId = ownerFor('session-long-deleted-run');
    const deletedCount = SESSION_QUEUE_CHUNK_SIZE * 2 + 25;
    const cardIds = await seedCards(ownerId, deletedCount + 1, 'long-deleted-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    const expectedChunkCount = Math.ceil(cardIds.length / SESSION_QUEUE_CHUNK_SIZE);
    const rootAtStart = (await db.collection('reviewSessions').doc(started.session.id).get()).data();
    expect(rootAtStart?.chunkCount).toBe(expectedChunkCount);
    await deleteDocs(cardIds.slice(0, deletedCount).map((id) => db.collection('flashcards').doc(id)));

    const hydrated = await getReviewSession(started.session.id, ownerId);
    expect(hydrated).toMatchObject({ card: { id: cardIds[deletedCount] }, currentPosition: deletedCount,
      session: { status: 'active', deletedCount, remainingQueueCount: 1 },
      queueWindow: { cardIds: [{ cardId: cardIds[deletedCount], position: deletedCount }] } });
    const root = (await db.collection('reviewSessions').doc(started.session.id).get()).data();
    const targetChunkIndex = Math.floor(deletedCount / SESSION_QUEUE_CHUNK_SIZE);
    expect(root).toMatchObject({ currentPosition: deletedCount, currentChunkIndex: targetChunkIndex,
      deletedCount, remainingQueueCount: 1 });
    const firstChunk = (await readChunk(started.session.id, 0)).data();
    expect(Array.isArray(firstChunk?.items)).toBe(true);
    expect(firstChunk?.items).toHaveLength(SESSION_QUEUE_CHUNK_SIZE);
    expect(firstChunk?.items.every((item: { status: string }) => item.status === 'deleted')).toBe(true);
  }, 30_000);

  it('completes an all-deleted queue without a phantom current card', async () => {
    const ownerId = ownerFor('session-all-deleted');
    const cardIds = await seedCards(ownerId, 3, 'all-deleted-card');
    const started = await startReviewSession({ cardIds }, ownerId);
    await deleteDocs(cardIds.map((id) => db.collection('flashcards').doc(id)));

    const hydrated = await getReviewSession(started.session.id, ownerId);
    expect(hydrated).toMatchObject({ card: null, currentPosition: null,
      session: { status: 'completed', deletedCount: 3, remainingQueueCount: 0 } });
    expect((await db.collection('reviewSessions').doc(started.session.id).get()).data())
      .toMatchObject({ status: 'completed', deletedCount: 3, remainingQueueCount: 0, currentChunkIndex: -1 });
  });
});

import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  bulkEnrollCards,
  computeCardKey,
  EnrollmentValidationError,
  getEnrollmentStatus,
  onEnrollmentChunkWritten,
  type ChunkWrittenEvent,
} from './enrollment';
const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;
const runId = randomUUID();
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

async function deleteDocs(refs: DocumentReference[]): Promise<void> {
  for (let start = 0; start < refs.length; start += 450) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + 450)) batch.delete(ref);
    await batch.commit();
  }
}

async function cleanupOwner(ownerId: string): Promise<void> {
  const jobs = await db.collection('bulkEnrollmentJobs').where('ownerId', '==', ownerId).get();
  const jobChildren: DocumentReference[] = [];
  for (const job of jobs.docs) {
    const chunks = await job.ref.collection('chunks').get();
    jobChildren.push(...chunks.docs.map((doc) => doc.ref));
  }
  const cards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
  const decks = await db.collection('decks').where('ownerId', '==', ownerId).get();
  const reservations = await db.collection('deckNameReservations').where('ownerId', '==', ownerId).get();
  const claims = await db.collection('bulkEnrollmentCardKeys').where('ownerId', '==', ownerId).get();
  await deleteDocs([...jobChildren, ...jobs.docs.map((doc) => doc.ref),
    ...cards.docs.map((doc) => doc.ref), ...decks.docs.map((doc) => doc.ref),
    ...claims.docs.map((doc) => doc.ref), ...reservations.docs.map((doc) => doc.ref)]);
}

function chunkEvent(snapshot: QueryDocumentSnapshot): ChunkWrittenEvent {
  const jobId = snapshot.ref.parent.parent?.id;
  if (!jobId) throw new Error('Enrollment chunk fixture must belong to a job');
  return {
    data: {
      after: {
        data: () => snapshot.data(),
        ref: { id: snapshot.id, parent: { parent: { id: jobId } } },
      },
    },
  };
}

async function processEnrollmentJob(jobId: string): Promise<void> {
  const chunks = await db.collection('bulkEnrollmentJobs').doc(jobId).collection('chunks').get();
  for (const chunk of chunks.docs) await onEnrollmentChunkWritten(chunkEvent(chunk));
}

afterAll(async () => {
  for (const ownerId of fixtureOwners) await cleanupOwner(ownerId);
  await db.terminate();
});

describe('real Firestore enrollment regressions', () => {
  it('counts concurrent duplicate deliveries once and preserves incumbent FSRS state and user data', async () => {
    const ownerId = ownerFor('enrollment-concurrent-duplicates');
    const incumbent = { front: 'incumbent reviewed card', back: 'answer', tags: ['known'] };
    const incoming = { front: 'new card', back: 'new answer', tags: ['new'] };
    const originalJob = await bulkEnrollCards({ cards: [incumbent] }, ownerId);
    await processEnrollmentJob(originalJob.jobId);
    const incumbentSnap = (await db.collection('flashcards').where('ownerId', '==', ownerId)
      .where('front', '==', incumbent.front).get()).docs[0];
    expect(incumbentSnap).toBeDefined();
    const due = Timestamp.fromMillis(1_700_000_000_000);
    const reviewLog = [{ rating: 3, reviewedAt: due, state: 2, stability: 23, difficulty: 4 }];
    const images = [{ url: 'https://example.invalid/incumbent-image.png', fileName: 'review.png' }];
    await incumbentSnap.ref.update({
      state: 2, stability: 23, difficulty: 4, reps: 17, lapses: 3, learningSteps: 2,
      due, lastReview: due, reviewLog, images,
    });
    const incumbentBefore = (await incumbentSnap.ref.get()).data();

    const retryJob = await bulkEnrollCards({ cards: [incoming, incumbent] }, ownerId);
    const chunkSnap = (await db.collection('bulkEnrollmentJobs').doc(retryJob.jobId)
      .collection('chunks').get()).docs[0];
    await Promise.all([
      onEnrollmentChunkWritten(chunkEvent(chunkSnap)),
      onEnrollmentChunkWritten(chunkEvent(chunkSnap)),
    ]);

    const status = await getEnrollmentStatus(retryJob.jobId, ownerId);
    const root = (await db.collection('bulkEnrollmentJobs').doc(retryJob.jobId).get()).data();
    const chunk = (await chunkSnap.ref.get()).data();
    const incumbentAfter = (await incumbentSnap.ref.get()).data();
    const allCards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
    expect(status).toMatchObject({ status: 'completed', totalCards: 2, totalChunks: 1,
      completedChunks: 1, createdCount: 1, skippedCount: 1, failedCount: 0 });
    expect(root).toMatchObject({ status: 'completed', createdCount: 1, skippedCount: 1, failedCount: 0, completedChunks: 1 });
    expect(chunk).toMatchObject({ status: 'completed', createdCount: 1, skippedCount: 1, failedCount: 0 });
    expect(root!.createdCount + root!.skippedCount + root!.failedCount).toBe(root!.totalCards);
    expect(incumbentAfter).toEqual(incumbentBefore);
    expect(allCards.docs.filter((doc) => doc.data().front === incoming.front)).toHaveLength(1);
  }, 30_000);
  it('adopts an exact current legacy card when a valid claim points to an edited target', async () => {
    const ownerId = ownerFor('enrollment-stale-claim-legacy-adoption');
    const request = { front: 'exact legacy question', back: 'answer', tags: [] as string[] };
    const submission = await bulkEnrollCards({ cards: [request] }, ownerId);
    const chunk = (await db.collection('bulkEnrollmentJobs').doc(submission.jobId)
      .collection('chunks').doc('00000').get()).data();
    const canonicalCard = chunk!.cards[0] as { deckId: string };
    const deckName = (await db.collection('decks').doc(canonicalCard.deckId).get()).data()!.name;
    const key = computeCardKey(ownerId, request.front, request.back, [], canonicalCard.deckId);

    const editedTarget = db.collection('flashcards').doc(`card-${runId}-${ownerId}-stale-target`);
    const exactLegacy = db.collection('flashcards').doc(`card-${runId}-${ownerId}-exact-legacy`);
    await Promise.all([
      editedTarget.create({
        ownerId, deckId: 'moved-deck', deck: 'Moved', front: 'edited question', back: request.back,
        state: 2, reps: 8,
      }),
      exactLegacy.create({
        ownerId, deckId: canonicalCard.deckId, deck: deckName,
        front: request.front, back: request.back, state: 2, reps: 11,
      }),
      db.collection('bulkEnrollmentCardKeys').doc(key).create({
        ownerId, identity: key, cardId: editedTarget.id,
      }),
    ]);

    await processEnrollmentJob(submission.jobId);

    const status = await getEnrollmentStatus(submission.jobId, ownerId);
    expect(status).toMatchObject({ status: 'completed', createdCount: 0, skippedCount: 1, failedCount: 0 });
    expect((await db.collection('bulkEnrollmentCardKeys').doc(key).get()).data()?.cardId).toBe(exactLegacy.id);
    expect((await editedTarget.get()).data()).toMatchObject({ front: 'edited question', state: 2, reps: 8 });
    expect((await exactLegacy.get()).data()).toMatchObject({ front: request.front, state: 2, reps: 11 });
    expect((await db.collection('flashcards').where('ownerId', '==', ownerId).get()).size).toBe(2);
  }, 30_000);

  it('reconstructs a missing canonical chunk from a permuted resubmission', async () => {
    const ownerId = ownerFor('enrollment-permuted-resume');
    const cards = Array.from({ length: 101 }, (_, index) => ({
      front: `permutation-${String(index).padStart(3, '0')}`,
      back: `answer-${index}`,
      tags: ['permutation'],
    }));
    const first = await bulkEnrollCards({ cards }, ownerId);
    const chunkCollection = db.collection('bulkEnrollmentJobs').doc(first.jobId).collection('chunks');
    const before = await chunkCollection.get();
    expect(before.size).toBe(2);
    const originalChunks = new Map(before.docs.map((doc) => [doc.id, doc.data()]));
    const missingId = [...originalChunks.keys()].sort()[1];
    await chunkCollection.doc(missingId).delete();

    const resumed = await bulkEnrollCards({ cards: [...cards].reverse() }, ownerId);
    expect(resumed.jobId).toBe(first.jobId);
    const after = await chunkCollection.get();
    expect(after.size).toBe(2);
    for (const chunk of after.docs) expect(chunk.data().cards).toEqual(originalChunks.get(chunk.id)?.cards);
    await processEnrollmentJob(first.jobId);
    expect(await getEnrollmentStatus(first.jobId, ownerId)).toMatchObject({ status: 'completed',
      totalCards: 101, totalChunks: 2, completedChunks: 2, createdCount: 101, skippedCount: 0, failedCount: 0 });
    const persistedFronts = (await db.collection('flashcards').where('ownerId', '==', ownerId).get())
      .docs.map((doc) => doc.data().front).sort();
    expect(persistedFronts).toEqual(cards.map((card) => card.front).sort());
  });

  it('preserves long hierarchical deck names and uses the current owned deck name', async () => {
    const ownerId = ownerFor('enrollment-long-deck-name');
    const otherOwner = ownerFor('enrollment-long-deck-name-foreign');
    const deckId = `long-deck-${runId}`;
    const otherDeckId = `foreign-long-deck-${runId}`;
    const deckRef = db.collection('decks').doc(deckId);
    const otherDeckRef = db.collection('decks').doc(otherDeckId);
    const originalName = `Parent${'::Anki'.repeat(40)}`;
    const renamedName = `Renamed${'::Chapter'.repeat(25)}`;
    await deckRef.create({ ownerId, name: originalName });
    await otherDeckRef.create({ ownerId: otherOwner, name: originalName });

    const response = await bulkEnrollCards({
      cards: [{ front: 'long deck reference', back: 'answer', deckId }],
    }, ownerId);
    await deckRef.update({ name: renamedName });
    await processEnrollmentJob(response.jobId);

    const cards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
    expect(await getEnrollmentStatus(response.jobId, ownerId)).toMatchObject({
      status: 'completed', createdCount: 1, skippedCount: 0, failedCount: 0,
    });
    expect(cards.docs).toHaveLength(1);
    expect(cards.docs[0].data()).toMatchObject({ ownerId, deckId, deck: renamedName });
    await expect(bulkEnrollCards({
      cards: [{ front: 'foreign deck reference', back: 'answer', deckId: otherDeckId }],
    }, ownerId)).rejects.toBeInstanceOf(EnrollmentValidationError);
  });
  it.each(['missing', 'foreign-owner', 'empty-name'] as const)(
    'fails without card or claim writes when the current deck is %s',
    async (deckState) => {
      const ownerId = ownerFor(`enrollment-invalid-current-deck-${deckState}`);
      const front = `invalid-current-deck-${runId}-${deckState}`;
      const response = await bulkEnrollCards({
        cards: [{ front, back: 'answer', deck: 'Valid before processing' }],
      }, ownerId);
      const chunk = await db.collection('bulkEnrollmentJobs').doc(response.jobId)
        .collection('chunks').doc('00000').get();
      const deckId = (chunk.data()?.cards as Array<{ deckId: string }>)[0].deckId;
      const deckRef = db.collection('decks').doc(deckId);
      if (deckState === 'missing') await deckRef.delete();
      else if (deckState === 'foreign-owner') {
        await deckRef.update({ ownerId: ownerFor(`enrollment-invalid-deck-owner-${deckState}`) });
      } else await deckRef.update({ name: '' });

      await processEnrollmentJob(response.jobId);

      expect(await getEnrollmentStatus(response.jobId, ownerId)).toMatchObject({
        status: 'failed', completedChunks: 1, createdCount: 0, skippedCount: 0, failedCount: 1,
      });
      expect((await db.collection('flashcards').where('ownerId', '==', ownerId).get()).size).toBe(0);
      const identity = computeCardKey(ownerId, front, 'answer', [], deckId);
      expect((await db.collection('bulkEnrollmentCardKeys').doc(identity).get()).exists).toBe(false);
    },
  );


  it('partitions Unicode enrollment payloads below the Firestore document byte limit', async () => {
    const ownerId = ownerFor('enrollment-unicode-bytes');
    const cards = Array.from({ length: 100 }, (_, index) => ({
      front: `${String(index).padStart(3, '0')}-${'界'.repeat(5_000)}`,
      back: `respuesta-${index}`,
      tags: ['unicode'],
    }));
    const response = await bulkEnrollCards({ cards }, ownerId);
    const chunks = await db.collection('bulkEnrollmentJobs').doc(response.jobId).collection('chunks').get();
    expect(chunks.size).toBeGreaterThan(1);
    const persistedFronts: string[] = [];
    for (const chunk of chunks.docs) {
      const data = chunk.data();
      expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBeLessThan(1024 * 1024);
      expect(Array.isArray(data.cards)).toBe(true);
      persistedFronts.push(...data.cards.map((card: { front: string }) => card.front));
    }
    expect(persistedFronts.sort()).toEqual(cards.map((card) => card.front).sort());
  });
});

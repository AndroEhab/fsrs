import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore, type DocumentReference } from 'firebase-admin/firestore';
import { deleteTag, mergeTags, renameTag } from './service';

const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;
const runId = randomUUID();
const fixtureOwners = new Set<string>();
const db = (() => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
    ?? (process.env.FIRESTORE_EMULATOR_PORT ? `127.0.0.1:${process.env.FIRESTORE_EMULATOR_PORT}` : '');
  const match = EMULATOR_HOST_PATTERN.exec(emulatorHost);
  if (!match || Number(match[2]) > 65535) {
    throw new Error(`Tag integration tests require a localhost Firestore emulator; got ${emulatorHost || '(unset)'}`);
  }
  if (process.env.FSRS_DATASTORE_PROJECT_ID !== DEMO_PROJECT_ID
      || process.env.GCLOUD_PROJECT !== DEMO_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT_ID) {
    throw new Error('Tag integration tests require the explicit demo project demo-fsrs-datastore-test');
  }
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  initializeApp({ projectId: DEMO_PROJECT_ID });
  return getFirestore();
})();

function ownerFor(testName: string): string {
  const ownerId = `tag-test-${runId}-${testName}`;
  fixtureOwners.add(ownerId);
  return ownerId;
}

async function createCard(ownerId: string, tags: string[], suffix: string, extra: Record<string, unknown> = {}) {
  const ref = db.collection('flashcards').doc(`tag-${runId}-${suffix}`);
  await ref.set({
    ownerId,
    front: 'preserved front',
    back: 'preserved back',
    deckId: 'preserved-deck',
    tags,
    state: 2,
    stability: 8,
    difficulty: 4,
    reps: 12,
    due: Timestamp.fromDate(new Date('2026-10-01T00:00:00.000Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')),
    ...extra,
  });
  return ref;
}

async function cleanupOwner(ownerId: string): Promise<void> {
  const snapshot = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
  for (let start = 0; start < snapshot.docs.length; start += 450) {
    const batch = db.batch();
    for (const doc of snapshot.docs.slice(start, start + 450)) batch.delete(doc.ref);
    await batch.commit();
  }
}

afterAll(async () => {
  for (const ownerId of fixtureOwners) await cleanupOwner(ownerId);
  await db.terminate();
});

describe('real Firestore tag rewrite transactions', () => {
  it('composes concurrent renames and preserves other owners and card state', async () => {
    const ownerId = ownerFor('concurrent-renames');
    const otherOwner = ownerFor('other-owner');
    const target = await createCard(ownerId, ['A', 'B', 'C'], 'concurrent-target');
    const unrelated = await createCard(ownerId, ['C'], 'concurrent-unrelated');
    const other = await createCard(otherOwner, ['A', 'B', 'C'], 'concurrent-other-owner');

    const [renameA, renameB] = await Promise.all([
      renameTag({ from: 'A', to: 'X' }, ownerId),
      renameTag({ from: 'B', to: 'Y' }, ownerId),
    ]);

    expect(renameA.affectedCards).toBe(1);
    expect(renameB.affectedCards).toBe(1);
    const persisted = (await target.get()).data()!;
    expect(persisted.tags.slice().sort()).toEqual(['C', 'X', 'Y']);
    expect(persisted).toMatchObject({
      ownerId, front: 'preserved front', back: 'preserved back', deckId: 'preserved-deck',
      state: 2, stability: 8, difficulty: 4, reps: 12,
    });
    expect(persisted.due.toDate()).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect((await unrelated.get()).data()?.tags).toEqual(['C']);
    expect((await other.get()).data()?.tags).toEqual(['A', 'B', 'C']);
  }, 30_000);

  it('deletes and merges exact literal names while deduping only changed cards', async () => {
    const ownerId = ownerFor('literal-mutations');
    const deleteTarget = await createCard(ownerId, [' literal,tag ', 'keep', 'keep'], 'literal-delete');
    const deleteDecoy = await createCard(ownerId, ['literal', 'tag', 'keep'], 'split-delete-decoy');
    const mergeTarget = await createCard(ownerId, ['source, tag ', 'target', 'target', 'keep'], 'literal-merge');
    const mergeDecoy = await createCard(ownerId, ['source', 'tag', 'keep'], 'split-merge-decoy');

    expect(await deleteTag({ name: ' literal,tag ' }, ownerId)).toEqual({ affectedCards: 1 });
    expect((await deleteTarget.get()).data()?.tags).toEqual(['keep']);
    expect((await deleteDecoy.get()).data()?.tags).toEqual(['literal', 'tag', 'keep']);

    expect(await mergeTags({ from: 'source, tag ', to: 'target' }, ownerId)).toEqual({ affectedCards: 1 });
    expect((await mergeTarget.get()).data()?.tags).toEqual(['target', 'keep']);
    expect((await mergeDecoy.get()).data()?.tags).toEqual(['source', 'tag', 'keep']);
  }, 30_000);

  it('counts a rename onto an existing target because source removal changes the card', async () => {
    const ownerId = ownerFor('rename-existing-target');
    const target = await createCard(ownerId, ['from', 'to', 'keep'], 'rename-existing-target');

    expect(await renameTag({ from: 'from', to: 'to' }, ownerId)).toEqual({ affectedCards: 1 });
    expect((await target.get()).data()?.tags).toEqual(['to', 'keep']);
  }, 30_000);

  it('walks all matching cards in bounded pages', async () => {
    const ownerId = ownerFor('bounded-pages');
    const refs: DocumentReference[] = [];
    const batchSize = 401;
    let batch = db.batch();
    for (let index = 0; index < batchSize; index += 1) {
      const ref = db.collection('flashcards').doc(`tag-${runId}-page-${index}`);
      refs.push(ref);
      batch.create(ref, { ownerId, tags: ['page-source', 'keep'] });
      if ((index + 1) % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    await batch.commit();

    expect(await renameTag({ from: 'page-source', to: 'page-target' }, ownerId)).toEqual({ affectedCards: batchSize });
    const updated = await db.getAll(...refs);
    expect(updated).toHaveLength(batchSize);
    expect(updated.every((doc) => doc.data()?.tags?.includes('page-target') && !doc.data()?.tags?.includes('page-source'))).toBe(true);
  }, 60_000);
});

import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore, type DocumentReference } from 'firebase-admin/firestore';
import {
  AmbiguousDeckNameError,
  DeckNameConflictError,
  DeckNotFoundError,
  ProtectedDeckError,
  assignDecklessToDefault,
  createDeck,
  deleteDeck,
  findOwnedDeckByExactName,
  getDefaultOwnedDeck,
  getDeck,
  getOrCreateOwnedDeck,
  migrateLegacyDeckNames,
  updateDeck,
} from './decks';
import { createFlashcard, updateFlashcard } from './service';

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
  const ownerId = `datastore-test-${runId}-${testName}`;
  fixtureOwners.add(ownerId);
  return ownerId;
}

function fixtureCardId(ownerId: string, suffix: string): string {
  return `card-${runId}-${ownerId}-${suffix}`;
}

async function deleteDocs(refs: DocumentReference[]): Promise<void> {
  for (let start = 0; start < refs.length; start += 450) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + 450)) batch.delete(ref);
    await batch.commit();
  }
}

async function cleanupOwner(ownerId: string): Promise<void> {
  const [decks, cards, reservations] = await Promise.all([
    db.collection('decks').where('ownerId', '==', ownerId).get(),
    db.collection('flashcards').where('ownerId', '==', ownerId).get(),
    db.collection('deckNameReservations').where('ownerId', '==', ownerId).get(),
  ]);
  await deleteDocs([
    ...cards.docs.map((doc) => doc.ref),
    ...decks.docs.map((doc) => doc.ref),
    ...reservations.docs.map((doc) => doc.ref),
  ]);
}

afterAll(async () => {
  for (const ownerId of fixtureOwners) await cleanupOwner(ownerId);
  await db.terminate();
});

describe('real Firestore deck-name registry regressions', () => {
  it('migrates only owned name-only cards across pages with the current deck reference', async () => {
    const ownerId = ownerFor('legacy-deck-migration');
    const deckRef = db.collection('decks').doc();
    await deckRef.create({ ownerId, name: 'Migration current name' });
    const legacyCards = ['first', 'second'].map((suffix) =>
      db.collection('flashcards').doc(fixtureCardId(ownerId, suffix)));
    const assignedRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'already-assigned'));
    const decklessRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'fully-deckless'));
    const unownedRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'unowned'));
    await Promise.all([
      ...legacyCards.map((ref) => ref.create({
        ownerId, deck: 'Migration current name', front: ref.id, back: 'legacy',
      })),
      assignedRef.create({
        ownerId, deckId: deckRef.id, deck: 'Migration current name', front: 'assigned', back: 'same',
      }),
      decklessRef.create({ ownerId, front: 'deckless', back: 'unchanged' }),
      unownedRef.create({ deck: 'Unowned legacy name', front: 'unowned', back: 'unchanged' }),
    ]);
    const assignedBefore = (await assignedRef.get()).data();
    const decklessBefore = (await decklessRef.get()).data();
    const unownedBefore = (await unownedRef.get()).data();
    try {
      expect(await migrateLegacyDeckNames(1)).toEqual({ migrated: 2 });
      for (const cardRef of legacyCards) {
        expect((await cardRef.get()).data()).toMatchObject({
          ownerId, deckId: deckRef.id, deck: 'Migration current name',
        });
      }
      expect((await assignedRef.get()).data()).toEqual(assignedBefore);
      expect((await decklessRef.get()).data()).toEqual(decklessBefore);
      expect((await unownedRef.get()).data()).toEqual(unownedBefore);
    } finally {
      await unownedRef.delete();
    }
  }, 30_000);

  it('serializes concurrent get-or-create and create-only reservations', async () => {
    const ownerId = ownerFor('deck-create-races');
    const [first, second] = await Promise.all([
      getOrCreateOwnedDeck(ownerId, 'Concurrent name'),
      getOrCreateOwnedDeck(ownerId, 'Concurrent name'),
    ]);
    expect(first.id).toBe(second.id);
    expect((await db.collection('decks').where('ownerId', '==', ownerId).where('name', '==', 'Concurrent name').get()).size).toBe(1);

    const createOnly = await Promise.allSettled([
      createDeck({ name: 'Create only race' }, ownerId),
      createDeck({ name: 'Create only race' }, ownerId),
    ]);
    expect(createOnly.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = createOnly.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(DeckNameConflictError) });
    expect((await db.collection('decks').where('ownerId', '==', ownerId).where('name', '==', 'Create only race').get()).size).toBe(1);
  }, 30_000);
  it('rejects a rename onto an occupied name without moving either reservation', async () => {
    const ownerId = ownerFor('deck-rename-conflict');
    const source = await createDeck({ name: 'Original name' }, ownerId);
    const occupied = await createDeck({ name: 'Occupied name' }, ownerId);
    await expect(updateDeck(source.id, { name: 'Occupied name' }, ownerId))
      .rejects.toBeInstanceOf(DeckNameConflictError);

    expect((await db.collection('decks').doc(source.id).get()).data()?.name).toBe('Original name');
    expect((await db.collection('decks').doc(occupied.id).get()).data()?.name).toBe('Occupied name');
    const originalReservation = await db.collection('deckNameReservations')
      .where('ownerId', '==', ownerId).where('name', '==', 'Original name').get();
    const occupiedReservation = await db.collection('deckNameReservations')
      .where('ownerId', '==', ownerId).where('name', '==', 'Occupied name').get();
    expect(originalReservation.docs.map((doc) => doc.data().deckId)).toEqual([source.id]);
    expect(occupiedReservation.docs.map((doc) => doc.data().deckId)).toEqual([occupied.id]);
  }, 30_000);


  it('keeps exact-name uniqueness scoped to the owner and hides foreign deck IDs', async () => {
    const ownerId = ownerFor('deck-owner-scope-a');
    const otherOwner = ownerFor('deck-owner-scope-b');
    const deck = await createDeck({ name: 'Private exact name' }, ownerId);
    const otherDeck = await createDeck({ name: 'Private exact name' }, otherOwner);
    expect(otherDeck.id).not.toBe(deck.id);
    expect(await getDeck(deck.id, otherOwner)).toBeNull();
    await expect(createFlashcard({ front: 'foreign', back: 'answer', deckId: deck.id }, otherOwner))
      .rejects.toBeInstanceOf(DeckNotFoundError);
  }, 30_000);

  it('adopts one unambiguous legacy deck and refuses duplicate legacy names without merging', async () => {
    const ownerId = ownerFor('deck-legacy-adoption');
    const legacyRef = db.collection('decks').doc();
    await legacyRef.create({ ownerId, name: 'Legacy random ID' });
    const findOnlyRef = db.collection('decks').doc();
    await findOnlyRef.create({ ownerId, name: 'Legacy selector name' });
    expect(await findOwnedDeckByExactName(ownerId, 'Legacy selector name')).toMatchObject({ id: findOnlyRef.id });
    expect((await db.collection('deckNameReservations').where('ownerId', '==', ownerId)
      .where('name', '==', 'Legacy selector name').get()).size).toBe(0);
    const adopted = await getOrCreateOwnedDeck(ownerId, 'Legacy random ID');
    expect(adopted.id).toBe(legacyRef.id);
    expect(await findOwnedDeckByExactName(ownerId, 'Legacy random ID')).toMatchObject({ id: legacyRef.id });

    const duplicateA = db.collection('decks').doc();
    const duplicateB = db.collection('decks').doc();
    await Promise.all([
      duplicateA.create({ ownerId, name: 'Ambiguous legacy' }),
      duplicateB.create({ ownerId, name: 'Ambiguous legacy' }),
    ]);
    expect((await db.collection('deckNameReservations').where('ownerId', '==', ownerId).where('name', '==', 'Ambiguous legacy').get()).size).toBe(0);
    expect((await db.collection('decks').where('ownerId', '==', ownerId).where('name', '==', 'Ambiguous legacy').get()).size).toBe(2);
    await expect(findOwnedDeckByExactName(ownerId, 'Ambiguous legacy')).rejects.toBeInstanceOf(AmbiguousDeckNameError);
  }, 30_000);

  it('keeps long explicit deck names and current names across rename and concurrent card moves', async () => {
    const ownerId = ownerFor('deck-long-rename-move');
    const longName = Array.from({ length: 14 }, (_, index) => `Hierarchy${index}`).join('::');
    expect(longName.length).toBeGreaterThan(100);
    expect(longName.length).toBeLessThanOrEqual(300);
    const source = await createDeck({ name: longName }, ownerId);
    const destination = await createDeck({ name: 'Destination current' }, ownerId);
    const card = await createFlashcard({ front: 'before', back: 'answer', deckId: source.id }, ownerId);
    expect(card.deck).toBe(longName);

    const renamedName = `${longName}::renamed`;
    await Promise.all([
      updateDeck(source.id, { name: renamedName }, ownerId),
      updateFlashcard(card.id, { deckId: destination.id }, ownerId),
    ]);
    const currentCard = (await db.collection('flashcards').doc(card.id).get()).data();
    expect(currentCard).toMatchObject({ deckId: destination.id, deck: 'Destination current' });
    expect((await db.collection('decks').doc(source.id).get()).data()?.name).toBe(renamedName);
    expect((await db.collection('deckNameReservations').where('ownerId', '==', ownerId)
      .where('name', '==', longName).get()).size).toBe(0);
    const renamedReservation = await db.collection('deckNameReservations').where('ownerId', '==', ownerId)
      .where('name', '==', renamedName).get();
    expect(renamedReservation.docs.map((doc) => doc.data().deckId)).toEqual([source.id]);
  }, 30_000);
  it('leaves card state unchanged for description-only deck updates', async () => {
    const ownerId = ownerFor('deck-description-only-update');
    const deck = await createDeck({ name: 'Description only source' }, ownerId);
    const cardRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'unchanged'));
    await cardRef.create({
      ownerId, deckId: deck.id, deck: deck.name,
      front: 'unchanged front', back: 'unchanged back',
      updatedAt: Timestamp.fromMillis(946684800000),
    });
    const before = (await cardRef.get()).data();

    await updateDeck(deck.id, { description: 'new deck description' }, ownerId);
    expect((await cardRef.get()).data()).toEqual(before);
  }, 30_000);

  it('canonicalizes legacy cards before rename, resumes a failed label sync, and frees the old name', async () => {
    const ownerId = ownerFor('deck-legacy-rename-retry');
    const deckRef = db.collection('decks').doc();
    await deckRef.create({ ownerId, name: 'Legacy before rename' });
    const cardRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'name-only'));
    await cardRef.create({ ownerId, deck: 'Legacy before rename', front: 'legacy', back: 'answer' });
    const nextName = 'Legacy after rename';
    const originalRunTransaction = db.runTransaction.bind(db);
    let failureInjected = false;
    db.runTransaction = (async (...args: Parameters<typeof db.runTransaction>) => {
      if (!failureInjected && (await deckRef.get()).data()?.name === nextName) {
        failureInjected = true;
        throw new Error('injected post-rename label-sync failure');
      }
      return originalRunTransaction(...args);
    }) as typeof db.runTransaction;
    try {
      await expect(updateDeck(deckRef.id, { name: nextName }, ownerId))
        .rejects.toThrow('injected post-rename label-sync failure');
    } finally {
      db.runTransaction = originalRunTransaction;
    }
    expect(failureInjected).toBe(true);
    expect((await cardRef.get()).data()).toMatchObject({ deckId: deckRef.id, deck: 'Legacy before rename' });
    await updateDeck(deckRef.id, { name: nextName }, ownerId);
    expect((await cardRef.get()).data()).toMatchObject({ deckId: deckRef.id, deck: nextName });
    const unchangedCard = (await cardRef.get()).data();
    await updateDeck(deckRef.id, { name: nextName }, ownerId);
    expect((await cardRef.get()).data()).toEqual(unchangedCard);

    const oldNameDeck = await createDeck({ name: 'Legacy before rename' }, ownerId);
    expect(oldNameDeck.id).not.toBe(deckRef.id);
  }, 30_000);

  it('canonicalizes legacy cards before delete and finalizes without legacy full scans', async () => {
    const ownerId = ownerFor('deck-legacy-delete');
    const deckRef = db.collection('decks').doc();
    await deckRef.create({ ownerId, name: 'Legacy deletion source' });
    const cardRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'name-only'));
    await cardRef.create({ ownerId, deck: 'Legacy deletion source', front: 'legacy', back: 'answer' });

    const result = await deleteDeck(deckRef.id, ownerId);
    const defaultDeck = await getDefaultOwnedDeck(ownerId);
    expect(result).toMatchObject({ deleted: true, reassignedCards: 1 });
    expect((await cardRef.get()).data()).toMatchObject({
      ownerId, deckId: defaultDeck.id, deck: defaultDeck.name,
    });
    expect((await deckRef.get()).exists).toBe(false);
  }, 30_000);



  it('renames explicit-ID duplicates without assigning ambiguous deckless cards', async () => {
    const ownerId = ownerFor('deck-explicit-duplicate-rename');
    const decks = db.collection('decks');
    const chosenRef = decks.doc();
    const otherRef = decks.doc();
    await Promise.all([
      chosenRef.create({ ownerId, name: 'Duplicate legacy name' }),
      otherRef.create({ ownerId, name: 'Duplicate legacy name' }),
    ]);
    const stableCard = db.collection('flashcards').doc(fixtureCardId(ownerId, 'stable'));
    const ambiguousCard = db.collection('flashcards').doc(fixtureCardId(ownerId, 'deckless'));
    await Promise.all([
      stableCard.create({ ownerId, deckId: chosenRef.id, deck: 'Duplicate legacy name', front: 'stable', back: 'answer' }),
      ambiguousCard.create({ ownerId, deck: 'Duplicate legacy name', front: 'legacy', back: 'answer' }),
    ]);

    await updateDeck(chosenRef.id, { name: 'Chosen explicit name' }, ownerId);
    expect((await stableCard.get()).data()).toMatchObject({ deckId: chosenRef.id, deck: 'Chosen explicit name' });
    expect((await ambiguousCard.get()).data()).toMatchObject({ deck: 'Duplicate legacy name' });
    expect((await ambiguousCard.get()).data()?.deckId).toBeUndefined();
  }, 30_000);

  it('assigns only fully deckless owner cards to the current Uncategorized deck', async () => {
    const ownerId = ownerFor('deckless-default-migration');
    const foreignOwner = ownerFor('deckless-default-foreign');
    const decklessRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'deckless'));
    const namedRef = db.collection('flashcards').doc(fixtureCardId(ownerId, 'legacy-name'));
    const foreignRef = db.collection('flashcards').doc(fixtureCardId(foreignOwner, 'deckless'));
    await Promise.all([
      decklessRef.create({ ownerId, front: 'old', back: 'answer' }),
      namedRef.create({ ownerId, deck: 'Legacy label', front: 'named', back: 'answer' }),
      foreignRef.create({ ownerId: foreignOwner, front: 'foreign', back: 'answer' }),
    ]);

    const result = await assignDecklessToDefault(ownerId);
    const defaultDeck = await getDefaultOwnedDeck(ownerId);
    expect(result).toEqual({ assigned: 1 });
    expect((await decklessRef.get()).data()).toMatchObject({
      ownerId, deckId: defaultDeck.id, deck: defaultDeck.name,
    });
    expect((await namedRef.get()).data()).toMatchObject({ deck: 'Legacy label' });
    expect((await namedRef.get()).data()?.deckId).toBeUndefined();
    expect((await foreignRef.get()).data()?.deckId).toBeUndefined();
  }, 30_000);

  it('does not leave an orphan when assignment races bounded deck deletion and protects Uncategorized', async () => {
    const ownerId = ownerFor('deck-delete-assign-race');
    const source = await createDeck({ name: 'Delete race source' }, ownerId);
    const [creation, deletion] = await Promise.allSettled([
      createFlashcard({ front: 'race', back: 'answer', deckId: source.id }, ownerId),
      deleteDeck(source.id, ownerId),
    ]);
    const survivingDeck = await db.collection('decks').doc(source.id).get();
    if (creation.status === 'fulfilled') {
      const current = (await db.collection('flashcards').doc(creation.value.id).get()).data();
      expect(current).toBeDefined();
      if (!survivingDeck.exists) {
        const fallback = await getDefaultOwnedDeck(ownerId);
        expect(current).toMatchObject({ deckId: fallback.id, deck: fallback.name });
      } else {
        expect(current).toMatchObject({ deckId: source.id, deck: 'Delete race source' });
      }
    } else {
      expect(creation.reason).toBeInstanceOf(DeckNotFoundError);
    }
    expect(deletion.status).toBe('fulfilled');

    const defaultDeck = await getDefaultOwnedDeck(ownerId);
    await expect(deleteDeck(defaultDeck.id, ownerId)).rejects.toBeInstanceOf(ProtectedDeckError);
  }, 30_000);
});

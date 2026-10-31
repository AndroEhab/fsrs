import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { dueFlashcards, listFlashcards, searchCards } from './service';
import { listDecks } from './decks';
import { InvalidPageTokenError, makeDocumentPageToken } from './documentPageTokens';
import { makeSearchPageToken, normalizeSearchFilters } from './search';
import { validateSearchCardsQuery } from './validators';

const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;
const runId = randomUUID();
const fixtureOwners = new Set<string>();
const fixtureRefs: DocumentReference[] = [];

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

function cardId(testName: string, suffix: string): string {
  return `pagination-${runId}-${testName}-${suffix}`;
}

function cardData(ownerId: string, createdAt: Timestamp, due: Timestamp, values: {
  deck?: string;
  tags?: string[];
  suspended?: boolean;
  front?: string;
} = {}) {
  return {
    ownerId,
    front: values.front ?? 'pagination front',
    back: 'pagination answer',
    ...(values.deck ? { deck: values.deck } : {}),
    tags: values.tags ?? [],
    ...(values.suspended !== undefined ? { suspended: values.suspended } : {}),
    createdAt,
    updatedAt: createdAt,
    due,
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    reviewLog: [],
    images: [],
  };
}

async function seedCard(
  ownerId: string,
  id: string,
  createdAt: Timestamp,
  due: Timestamp,
  values: Parameters<typeof cardData>[3] = {},
): Promise<void> {
  const ref = db.collection('flashcards').doc(id);
  await ref.set(cardData(ownerId, createdAt, due, values));
  fixtureRefs.push(ref);
}

async function seedDeck(ownerId: string, id: string, createdAt: Timestamp): Promise<void> {
  const ref = db.collection('decks').doc(id);
  await ref.set({ ownerId, name: id, description: '', createdAt, updatedAt: createdAt });
  fixtureRefs.push(ref);
}

async function deleteDocs(refs: DocumentReference[]): Promise<void> {
  for (let start = 0; start < refs.length; start += 450) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + 450)) batch.delete(ref);
    await batch.commit();
  }
}

afterAll(async () => {
  await deleteDocs(fixtureRefs);
  for (const ownerId of fixtureOwners) {
    const cards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
    const decks = await db.collection('decks').where('ownerId', '==', ownerId).get();
    await deleteDocs([...cards.docs.map((doc) => doc.ref), ...decks.docs.map((doc) => doc.ref)]);
  }
  await db.terminate();
});

describe('native Firestore query pagination', () => {
  it('continues list cards after a deleted boundary in the owner’s createdAt DESC/id DESC order', async () => {
    const ownerId = ownerFor('list-deleted-boundary');
    const otherOwner = ownerFor('list-foreign-cursor');
    const createdAt = new Timestamp(1_800_000_000, 123_900_000);
    const due = new Timestamp(1_700_000_000, 0);
    const ids = ['a', 'b', 'c'].map((suffix) => cardId('list', suffix));
    for (const id of ids) await seedCard(ownerId, id, createdAt, due);
    await seedCard(otherOwner, cardId('foreign', 'a'), createdAt, due);
    await seedCard(otherOwner, cardId('foreign', 'b'), createdAt, due);

    const first = await listFlashcards({ pageSize: 1 }, ownerId);
    expect(first.cards.map((card) => card.id)).toEqual([ids[2]]);
    expect(first.nextPageToken).not.toBeNull();
    await db.collection('flashcards').doc(ids[2]).delete();
    const allOwnedCards = await listFlashcards({ pageSize: 10 }, ownerId);
    expect(allOwnedCards.cards.map((card) => card.id)).toEqual([ids[1], ids[0]]);

    const second = await listFlashcards({ pageSize: 1, pageToken: first.nextPageToken! }, ownerId);
    expect(second.cards.map((card) => card.id)).toEqual([ids[1]]);
    const third = await listFlashcards({ pageSize: 1, pageToken: second.nextPageToken! }, ownerId);
    expect(third.cards.map((card) => card.id)).toEqual([ids[0]]);
    expect(new Set([...second.cards, ...third.cards].map((card) => card.id)).size).toBe(2);

    const foreignPage = await listFlashcards({ pageSize: 1 }, otherOwner);
    await expect(listFlashcards({ pageSize: 1, pageToken: foreignPage.nextPageToken! }, ownerId))
      .rejects.toBeInstanceOf(InvalidPageTokenError);
    await expect(listFlashcards({ deck: 'different', pageToken: first.nextPageToken! }, ownerId))
      .rejects.toBeInstanceOf(InvalidPageTokenError);
    await expect(dueFlashcards({ pageSize: 1, pageToken: first.nextPageToken! }, ownerId))
      .rejects.toBeInstanceOf(InvalidPageTokenError);
  });

  it('rejects scope-valid cursors with invalid Firestore IDs and keeps Unicode IDs usable', async () => {
    const ownerId = ownerFor('flat-cursor-id');
    const cursorTime = new Timestamp(1_800_000_000, 123_456_000);
    const due = new Timestamp(1_700_000_000, 0);
    await seedCard(ownerId, cardId('flat-cursor', 'card'), cursorTime, due);
    await seedDeck(ownerId, cardId('flat-cursor', 'deck'), cursorTime);

    const searchFilters = normalizeSearchFilters({ pageSize: 1 });
    const invalidIds = ['nested/card', '.', '..', '__reserved__', 'x'.repeat(1501)];
    const operations: Promise<unknown>[] = [];
    for (const id of invalidIds) {
      const listToken = makeDocumentPageToken(
        'listFlashcards',
        ownerId,
        { deckId: null, deck: null, tags: [] },
        cursorTime,
        id,
      );
      const dueToken = makeDocumentPageToken(
        'dueFlashcards',
        ownerId,
        { deckId: null, deck: null },
        due,
        id,
      );
      const deckToken = makeDocumentPageToken('listDecks', ownerId, {}, cursorTime, id);
      const searchToken = makeSearchPageToken(
        searchFilters,
        ownerId,
        id,
        cursorTime.seconds,
        cursorTime.nanoseconds,
      );
      operations.push(
        listFlashcards({ pageSize: 1, pageToken: listToken }, ownerId),
        dueFlashcards({ pageSize: 1, pageToken: dueToken }, ownerId),
        listDecks({ pageSize: 1, pageToken: deckToken }, ownerId),
        searchCards({ pageSize: 1, pageToken: searchToken }, ownerId),
      );
    }
    const results = await Promise.allSettled(operations);
    const outcomeNames = results.map((result) => (
      result.status === 'rejected' ? (result.reason as Error).name : 'resolved'
    ));
    expect(outcomeNames).toEqual(Array(operations.length).fill('InvalidPageTokenError'));

    const validUnicodeId = 'café-東京';
    const unicodeListToken = makeDocumentPageToken(
      'listFlashcards',
      ownerId,
      { deckId: null, deck: null, tags: [] },
      cursorTime,
      validUnicodeId,
    );
    const unicodeSearchToken = makeSearchPageToken(
      searchFilters,
      ownerId,
      validUnicodeId,
      cursorTime.seconds,
      cursorTime.nanoseconds,
    );
    await expect(listFlashcards({ pageSize: 1, pageToken: unicodeListToken }, ownerId)).resolves.toBeDefined();
    await expect(searchCards({ pageSize: 1, pageToken: unicodeSearchToken }, ownerId)).resolves.toBeDefined();
  });

  it('continues due cards after a deleted boundary, preserving due ASC/id ASC and suspended filtering', async () => {
    const ownerId = ownerFor('due-deleted-boundary');
    const createdAt = new Timestamp(1_800_000_000, 0);
    const due = new Timestamp(1_700_000_000, 123_900_000);
    const suspendedId = cardId('due', 'a-suspended');
    const activeIds = ['b-active', 'c-active'].map((suffix) => cardId('due', suffix));
    await seedCard(ownerId, suspendedId, createdAt, due, { suspended: true });
    for (const id of activeIds) await seedCard(ownerId, id, createdAt, due, { suspended: false });

    const first = await dueFlashcards({ pageSize: 1 }, ownerId);
    expect(first.cards.map((card) => card.id)).toEqual([activeIds[0]]);
    expect(first.cards.some((card) => card.id === suspendedId)).toBe(false);
    expect(first.nextPageToken).not.toBeNull();
    await db.collection('flashcards').doc(activeIds[0]).delete();

    const second = await dueFlashcards({ pageSize: 1, pageToken: first.nextPageToken! }, ownerId);
    expect(second.cards.map((card) => card.id)).toEqual([activeIds[1]]);
    expect(second.nextPageToken).toBeNull();
  });

  it('continues rich search by exact timestamp tuple and accepts large filter sets on the next page', async () => {
    const ownerId = ownerFor('search-long-filters');
    const sharedMillisSeconds = 1_800_000_000;
    const createdAtLaterNanos = new Timestamp(sharedMillisSeconds, 123_900_000);
    const createdAtEarlierNanos = new Timestamp(sharedMillisSeconds, 123_100_000);
    const due = new Timestamp(1_700_000_000, 0);
    const longDeckNames = Array.from({ length: 20 }, (_, index) => `deck-${index}-${'x'.repeat(280)}`);
    const matchingDeck = longDeckNames[0];
    const laterId = cardId('search', 'z-later-nanos');
    const earlierId = cardId('search', 'a-earlier-nanos');
    await seedCard(ownerId, laterId, createdAtLaterNanos, due, { deck: matchingDeck });
    await seedCard(ownerId, earlierId, createdAtEarlierNanos, due, { deck: matchingDeck });

    const first = await searchCards({ deckNames: longDeckNames, pageSize: 1 }, ownerId);
    expect(first.cards.map((card) => card.id)).toEqual([laterId]);
    expect(first.nextPageToken).not.toBeNull();
    await db.collection('flashcards').doc(laterId).delete();

    const nextQuery = validateSearchCardsQuery({
      deckNames: longDeckNames,
      pageSize: 1,
      pageToken: first.nextPageToken,
    });
    const second = await searchCards(nextQuery, ownerId);
    expect(second.cards.map((card) => card.id)).toEqual([earlierId]);
    expect(second.nextPageToken).toBeNull();
    await expect(searchCards({ deckNames: ['different'], pageToken: first.nextPageToken! }, ownerId))
      .rejects.toBeInstanceOf(InvalidPageTokenError);
    await expect(searchCards(nextQuery, ownerFor('search-other-owner')))
      .rejects.toBeInstanceOf(InvalidPageTokenError);
  });

  it('continues deck pages after a deleted boundary without reading that document', async () => {
    const ownerId = ownerFor('deck-deleted-boundary');
    const createdAt = new Timestamp(1_800_000_000, 123_900_000);
    const ids = ['a', 'b', 'c'].map((suffix) => cardId('deck', suffix));
    for (const id of ids) await seedDeck(ownerId, id, createdAt);

    const first = await listDecks({ pageSize: 1 }, ownerId);
    expect(first.decks.map((deck) => deck.id)).toEqual([ids[2]]);
    expect(first.nextPageToken).not.toBeNull();
    await db.collection('decks').doc(ids[2]).delete();
    const second = await listDecks({ pageSize: 1, pageToken: first.nextPageToken! }, ownerId);
    expect(second.decks.map((deck) => deck.id)).toEqual([ids[1]]);
    expect(second.nextPageToken).not.toBeNull();
  });
  it('honors date-only inclusive bounds at Firestore nanosecond precision', async () => {
    const ownerId = ownerFor('date-nanos');
    const dayStartMillis = Date.UTC(2026, 7, 5);
    const due = new Timestamp(1_800_000_000, 0);
    const lastMillisecondId = cardId('date-nanos', 'last-millisecond');
    const followingDayId = cardId('date-nanos', 'following-day');
    await seedCard(
      ownerId,
      lastMillisecondId,
      new Timestamp(Math.floor((dayStartMillis + 86_399_999) / 1000), 999_999_000),
      due,
    );
    await seedCard(
      ownerId,
      followingDayId,
      new Timestamp(Math.floor((dayStartMillis + 86_400_000) / 1000), 0),
      due,
    );
    const result = await searchCards({ createdTo: '2026-08-05', pageSize: 10 }, ownerId);
    expect(result.cards.map((card) => card.id)).toEqual([lastMillisecondId]);
  });

  it('uses calendar-valid Firestore-range bounds for native queries', async () => {
    const ownerId = ownerFor('date-parser-fixed');
    const due = new Timestamp(1_800_000_000, 0);
    const yearOneId = cardId('date', 'year-one');
    const yearOneHundredId = cardId('date', 'year-one-hundred');
    await seedCard(ownerId, yearOneId, new Timestamp(-62_135_596_800, 0), due);
    await seedCard(ownerId, yearOneHundredId, Timestamp.fromMillis(Date.UTC(100, 0, 1)), due);

    const yearNinetyNine = await searchCards({ createdFrom: '0099-01-01', pageSize: 10 }, ownerId);
    expect(yearNinetyNine.cards.map((card) => card.id)).toEqual([yearOneHundredId]);
    const yearOneBound = await searchCards({ createdFrom: '0001-01-01', pageSize: 10 }, ownerId);
    expect(yearOneBound.cards.map((card) => card.id).sort()).toEqual([yearOneId, yearOneHundredId].sort());

    const beforeInvalidDateId = cardId('date', 'before-invalid-iso');
    const afterInvalidDateId = cardId('date', 'after-invalid-iso');
    await seedCard(ownerId, beforeInvalidDateId, Timestamp.fromMillis(Date.parse('2026-03-02T00:00:00.000Z')), due);
    await seedCard(ownerId, afterInvalidDateId, Timestamp.fromMillis(Date.parse('2026-03-04T00:00:00.000Z')), due);
    expect(() => validateSearchCardsQuery({ createdFrom: '2026-02-31T00:00:00.000Z' })).toThrow();
    expect(() => validateSearchCardsQuery({ createdFrom: 'August 1, 2026' })).toThrow();
  });
  it('includes a timestamp in the final millisecond of the 9999-12-31 upper bound', async () => {
    const ownerId = ownerFor('date-max-timestamp');
    const due = new Timestamp(1_700_000_000, 0);
    const id = cardId('date-max-timestamp', 'max-millisecond');
    await seedCard(ownerId, id, new Timestamp(253_402_300_799, 999_999_999), due);

    const result = await searchCards({ createdTo: '9999-12-31', pageSize: 10 }, ownerId);
    expect(result.cards.map((card) => card.id)).toEqual([id]);
  });
  it('returns every same-timestamp Unicode-id search result across pages', async () => {
    const ownerId = ownerFor('unicode-id-cursor');
    const createdAt = new Timestamp(1_800_000_000, 123_456_789);
    const due = new Timestamp(1_700_000_000, 0);
    const bmpId = cardId('unicode-id-cursor', '\uE000');
    const astralId = cardId('unicode-id-cursor', '🙂');
    await seedCard(ownerId, bmpId, createdAt, due);
    await seedCard(ownerId, astralId, createdAt, due);

    const first = await searchCards({ pageSize: 1 }, ownerId);
    expect(first.cards.map((card) => card.id)).toEqual([bmpId]);
    expect(first.nextPageToken).not.toBeNull();
    const second = await searchCards({ pageSize: 1, pageToken: first.nextPageToken! }, ownerId);
    expect(second.cards.map((card) => card.id)).toEqual([astralId]);
    expect(second.nextPageToken).toBeNull();
  });
});

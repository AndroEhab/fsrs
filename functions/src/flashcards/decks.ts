import { createHash } from 'node:crypto';
import {
  getFirestore, Timestamp, FieldPath,
  type DocumentData, type DocumentSnapshot, type Firestore,
  type QueryDocumentSnapshot, type QuerySnapshot,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  type CreateDeckInput, type Deck, type DeleteDeckResult, type ListDecksQuery, type ListDecksResponse,
  type UpdateDeckInput, DEFAULT_DECK_NAME, DECK_NAME_MAX_LENGTH, BULK_LIMIT,
} from './types';
import {
  makeDocumentPageToken, timestampFromDocumentPageCursor,
  validateDocumentPageToken,
} from './documentPageTokens';

const DECKS_COLLECTION = 'decks';
const FLASHCARDS_COLLECTION = 'flashcards';
const DECK_NAME_RESERVATIONS_COLLECTION = 'deckNameReservations';
const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 20;
const REASSIGN_PAGE_SIZE = 400;
const REASSIGN_TRANSACTION_BYTE_BUDGET = 6 * 1024 * 1024;
const DECK_CARD_METADATA_FIELDS = ['ownerId', 'deckId', 'deck'];

async function readDeckCardMetadata(
  transaction: Transaction,
  documents: QueryDocumentSnapshot<DocumentData>[],
): Promise<DocumentSnapshot<DocumentData>[]> {
  return transaction.getAll(...documents.map((document) => document.ref), {
    fieldMask: DECK_CARD_METADATA_FIELDS,
  });
}

let db: Firestore | undefined;

function getDb(): Firestore {
  if (!db) db = getFirestore();
  return db;
}

export class DeckNameConflictError extends Error {
  constructor(name: string) {
    super(`A deck named "${name}" already exists`);
    this.name = 'DeckNameConflictError';
  }
}

export class DeckNotFoundError extends Error {
  constructor(deckId: string) {
    super(`Deck not found: ${deckId}`);
    this.name = 'DeckNotFoundError';
  }
}

export class ProtectedDeckError extends Error {
  constructor(deckName: string) {
    super(`Cannot delete the "${deckName}" deck; it is a system-protected placeholder`);
    this.name = 'ProtectedDeckError';
  }
}

export class AmbiguousDeckNameError extends Error {
  constructor(name: string) {
    super(`Multiple owned decks are named "${name}"; explicit deckId assignment is required`);
    this.name = 'AmbiguousDeckNameError';
  }
}

export class DeckNameReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckNameReservationError';
  }
}

/** Projects the existing deck document shape into the public Deck model. */
export function deckFromSnapshot(doc: DocumentSnapshot<DocumentData>): Deck {
  const data = doc.data();
  if (!data) throw new DeckNameReservationError(`Deck document ${doc.id} has no data`);
  return {
    id: doc.id,
    ...(data.ownerId !== undefined ? { ownerId: data.ownerId as string } : {}),
    name: data.name as string,
    ...(data.description !== undefined ? { description: data.description as string } : {}),
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
  };
}

function validateOwner(ownerId: string): void {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new DeckNameReservationError('An ownerId is required for deck operations');
  }
}

function validateDeckName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > DECK_NAME_MAX_LENGTH) {
    throw new DeckNameReservationError(`Deck name must contain 1 to ${DECK_NAME_MAX_LENGTH} characters`);
  }
}

function reservationId(ownerId: string, name: string): string {
  return createHash('sha256').update(JSON.stringify([ownerId, name])).digest('hex');
}

function reservationRef(ownerId: string, name: string) {
  return getDb().collection(DECK_NAME_RESERVATIONS_COLLECTION).doc(reservationId(ownerId, name));
}

function matchingDecks(ownerId: string, name: string) {
  return getDb().collection(DECKS_COLLECTION)
    .where('ownerId', '==', ownerId).where('name', '==', name).limit(2);
}

function reservationData(snap: DocumentSnapshot<DocumentData>, ownerId: string, name: string): { deckId: string } | null {
  if (!snap.exists) return null;
  const value = snap.data();
  if (value?.ownerId !== ownerId || value.name !== name || typeof value.deckId !== 'string' || value.deckId.length === 0) {
    throw new DeckNameReservationError(`Deck name reservation for "${name}" is inconsistent`);
  }
  return { deckId: value.deckId };
}

function verifyReservedDeck(snap: DocumentSnapshot<DocumentData>, ownerId: string, name: string, deckId: string): Deck {
  const data = snap.data();
  if (!snap.exists || data?.ownerId !== ownerId || data.name !== name || snap.id !== deckId) {
    throw new DeckNameReservationError(`Deck name reservation for "${name}" does not reference its owned deck`);
  }
  return deckFromSnapshot(snap);
}

function reservationPayload(ownerId: string, name: string, deckId: string, now: Timestamp) {
  return { ownerId, name, deckId, createdAt: now, updatedAt: now };
}

async function uniqueNameQuery(ownerId: string, name: string): Promise<QuerySnapshot<DocumentData>> {
  return matchingDecks(ownerId, name).get();
}

/** Finds an exact owner/name match without creating a deck. */
export async function findOwnedDeckByExactName(ownerId: string, name: string): Promise<Deck | null> {
  validateOwner(ownerId);
  validateDeckName(name);
  const reserved = await reservationRef(ownerId, name).get();
  const entry = reservationData(reserved, ownerId, name);
  const matches = await uniqueNameQuery(ownerId, name);
  if (matches.size > 1) throw new AmbiguousDeckNameError(name);
  if (entry) {
    if (matches.empty || matches.docs[0].id !== entry.deckId) {
      throw new DeckNameReservationError(`Deck name reservation for "${name}" does not match its owned deck`);
    }
    return verifyReservedDeck(await getDb().collection(DECKS_COLLECTION).doc(entry.deckId).get(), ownerId, name, entry.deckId);
  }
  return matches.empty ? null : deckFromSnapshot(matches.docs[0]);
}

/** Finds or atomically creates one exact-name deck and its name reservation. */
export async function getOrCreateOwnedDeck(ownerId: string, name: string): Promise<Deck> {
  validateOwner(ownerId);
  validateDeckName(name);
  const reservation = reservationRef(ownerId, name);
  const decks = getDb().collection(DECKS_COLLECTION);
  return getDb().runTransaction(async (transaction) => {
    const reserved = await transaction.get(reservation);
    const matches = await transaction.get(matchingDecks(ownerId, name));
    const entry = reservationData(reserved, ownerId, name);
    if (matches.size > 1) throw new AmbiguousDeckNameError(name);
    if (entry) {
      if (matches.empty || matches.docs[0].id !== entry.deckId) {
        throw new DeckNameReservationError(`Deck name reservation for "${name}" does not match its owned deck`);
      }
      return verifyReservedDeck(await transaction.get(decks.doc(entry.deckId)), ownerId, name, entry.deckId);
    }
    if (!matches.empty) {
      const existing = matches.docs[0];
      const deck = verifyReservedDeck(existing, ownerId, name, existing.id);
      const now = Timestamp.now();
      transaction.create(reservation, reservationPayload(ownerId, name, deck.id, now));
      return deck;
    }

    const now = Timestamp.now();
    const deckRef = decks.doc();
    transaction.create(deckRef, { ownerId, name, createdAt: now, updatedAt: now });
    transaction.create(reservation, reservationPayload(ownerId, name, deckRef.id, now));
    return { id: deckRef.id, ownerId, name, createdAt: now, updatedAt: now };
  }, { maxAttempts: 20 });
}

/** Creates a deck only when its exact owner/name pair is unoccupied. */
export async function createDeck(input: CreateDeckInput, ownerId: string): Promise<Deck> {
  validateOwner(ownerId);
  validateDeckName(input.name);
  const reservation = reservationRef(ownerId, input.name);
  const decks = getDb().collection(DECKS_COLLECTION);
  return getDb().runTransaction(async (transaction) => {
    const reserved = await transaction.get(reservation);
    const matches = await transaction.get(matchingDecks(ownerId, input.name));
    const entry = reservationData(reserved, ownerId, input.name);
    if (matches.size > 1) throw new AmbiguousDeckNameError(input.name);
    if (entry) {
      if (matches.empty || matches.docs[0].id !== entry.deckId) {
        throw new DeckNameReservationError(`Deck name reservation for "${input.name}" does not match its owned deck`);
      }
      verifyReservedDeck(await transaction.get(decks.doc(entry.deckId)), ownerId, input.name, entry.deckId);
      throw new DeckNameConflictError(input.name);
    }
    if (!matches.empty) throw new DeckNameConflictError(input.name);

    const now = Timestamp.now();
    const deckRef = decks.doc();
    const payload: Omit<Deck, 'id'> = {
      ownerId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
    };
    transaction.create(deckRef, payload);
    transaction.create(reservation, reservationPayload(ownerId, input.name, deckRef.id, now));
    return { id: deckRef.id, ...payload };
  }, { maxAttempts: 20 });
}


export async function getDeck(id: string, ownerId: string): Promise<Deck | null> {
  validateOwner(ownerId);
  const snap = await getDb().collection(DECKS_COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
  validateDeckName(snap.data()!.name);
  return deckFromSnapshot(snap);
}

export interface DeckRef {
  deckId: string;
  deck: string;
}

export async function requireOwnedDeckById(id: string, ownerId: string): Promise<Deck> {
  const deck = await getDeck(id, ownerId);
  if (!deck) throw new DeckNotFoundError(id);
  return deck;
}

export async function readOwnedDeckInTransaction(
  transaction: Transaction,
  id: string,
  ownerId: string,
): Promise<Deck> {
  validateOwner(ownerId);
  const snap = await transaction.get(getDb().collection(DECKS_COLLECTION).doc(id));
  if (!snap.exists || snap.data()?.ownerId !== ownerId) throw new DeckNotFoundError(id);
  validateDeckName(snap.data()!.name);
  return deckFromSnapshot(snap);
}

export async function resolveOwnedDeckRef(
  input: { deckId?: string | null; deck?: string | null },
  ownerId: string,
): Promise<DeckRef | null> {
  if (input.deckId !== undefined && input.deckId !== null) {
    const deck = await requireOwnedDeckById(input.deckId, ownerId);
    validateDeckName(deck.name);
    return { deckId: deck.id, deck: deck.name };
  }
  if (input.deck !== undefined && input.deck !== null) {
    const deck = await getOrCreateOwnedDeck(ownerId, input.deck);
    return { deckId: deck.id, deck: deck.name };
  }
  return null;
}

export async function getDefaultOwnedDeck(ownerId: string): Promise<Deck> {
  return getOrCreateOwnedDeck(ownerId, DEFAULT_DECK_NAME);
}


export async function listDecks(query: ListDecksQuery, ownerId: string): Promise<ListDecksResponse> {
  validateOwner(ownerId);
  const pageSize = Math.min(query.pageSize || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  let q: FirebaseFirestore.Query<DocumentData> = getDb().collection(DECKS_COLLECTION)
    .where('ownerId', '==', ownerId)
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');
  if (query.pageToken) {
    const cursor = validateDocumentPageToken(query.pageToken, 'listDecks', ownerId, {});
    q = q.startAfter(timestampFromDocumentPageCursor(cursor), cursor.id);
  }
  const snapshot = await q.limit(pageSize + 1).get();
  const docs = snapshot.docs;
  const hasMore = docs.length > pageSize;
  const page = docs.slice(0, pageSize);
  const last = page[page.length - 1];
  const lastTimestamp = last?.get('createdAt');
  if (hasMore && !(lastTimestamp instanceof Timestamp)) {
    throw new DeckNameReservationError(`Deck ${last.id} has no valid createdAt cursor timestamp`);
  }
  return {
    decks: page.map(deckFromSnapshot),
    nextPageToken: hasMore && lastTimestamp instanceof Timestamp
      ? makeDocumentPageToken('listDecks', ownerId, {}, lastTimestamp, last.id)
      : null,
  };
}

interface DeckIdentity {
  deck: Deck;
  uniqueName: boolean;
}


async function readDeckIdentity(id: string, ownerId: string): Promise<DeckIdentity | null> {
  validateOwner(ownerId);
  return getDb().runTransaction(async (transaction) => {
    const snap = await transaction.get(getDb().collection(DECKS_COLLECTION).doc(id));
    if (!snap.exists || snap.data()?.ownerId !== ownerId) return null;
    const name = snap.data()!.name;
    validateDeckName(name);
    const matches = await transaction.get(matchingDecks(ownerId, name));
    return {
      deck: deckFromSnapshot(snap),
      uniqueName: matches.size === 1 && matches.docs[0].id === id,
    };
  }, { maxAttempts: 20 });
}

async function requireCurrentDeckIdentity(
  transaction: Transaction,
  id: string,
  ownerId: string,
  expected: DeckIdentity,
): Promise<DocumentSnapshot<DocumentData>> {
  const snap = await transaction.get(getDb().collection(DECKS_COLLECTION).doc(id));
  if (!snap.exists || snap.data()?.ownerId !== ownerId) throw new DeckNotFoundError(id);
  const currentName = snap.data()!.name;
  validateDeckName(currentName);
  const matches = await transaction.get(matchingDecks(ownerId, currentName));
  const uniqueName = matches.size === 1 && matches.docs[0].id === id;
  if (currentName !== expected.deck.name || uniqueName !== expected.uniqueName) {
    throw new DeckNameReservationError(`Deck "${id}" changed name ownership during the operation; retry`);
  }
  return snap;
}

/** Converts unambiguous legacy name-only references before a root name can change. */
async function canonicalizeLegacyDeckCards(ownerId: string, identity: DeckIdentity): Promise<void> {
  if (!identity.uniqueName) return;
  const db = getDb();
  const cards = db.collection(FLASHCARDS_COLLECTION);
  let lastId: string | undefined;
  let hasMore = true;
  while (hasMore) {
    let query = cards.where('ownerId', '==', ownerId).where('deck', '==', identity.deck.name)
      .select('ownerId', 'deckId', 'deck').orderBy(FieldPath.documentId()).limit(REASSIGN_PAGE_SIZE);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) return;
    const candidates = page.docs.filter((document) => document.get('ownerId') === ownerId
      && document.get('deckId') === undefined && document.get('deck') === identity.deck.name);
    if (candidates.length > 0) {
      await db.runTransaction(async (transaction) => {
        await requireCurrentDeckIdentity(transaction, identity.deck.id, ownerId, identity);
        const snapshots = await readDeckCardMetadata(transaction, candidates);
        const now = Timestamp.now();
        for (let index = 0; index < snapshots.length; index++) {
          const card = snapshots[index].data();
          if (!card || card.ownerId !== ownerId || card.deckId !== undefined || card.deck !== identity.deck.name) continue;
          transaction.update(candidates[index].ref, {
            deckId: identity.deck.id, deck: identity.deck.name, updatedAt: now,
          });
        }
      }, { maxAttempts: 20 });
    }
    hasMore = page.docs.length === REASSIGN_PAGE_SIZE;
    if (hasMore) lastId = page.docs[page.docs.length - 1].id;
  }
}

async function renameOrUpdateDeck(
  id: string,
  input: UpdateDeckInput,
  ownerId: string,
  identity: DeckIdentity,
): Promise<Deck | null> {
  validateOwner(ownerId);
  if (input.name !== undefined) validateDeckName(input.name);
  const decks = getDb().collection(DECKS_COLLECTION);
  const deckRef = decks.doc(id);
  return getDb().runTransaction(async (transaction) => {
    const currentSnap = await requireCurrentDeckIdentity(transaction, id, ownerId, identity);
    const oldName = currentSnap.data()!.name;
    const requestedName = input.name ?? oldName;
    const oldReservation = reservationRef(ownerId, oldName);
    const newReservation = reservationRef(ownerId, requestedName);
    const [oldReservationSnap, newReservationSnap, newNameMatches] = await Promise.all([
      transaction.get(oldReservation),
      transaction.get(newReservation),
      requestedName === oldName ? Promise.resolve(null) : transaction.get(matchingDecks(ownerId, requestedName)),
    ]);
    const oldEntry = reservationData(oldReservationSnap, ownerId, oldName);
    if (oldEntry && oldEntry.deckId !== id) {
      throw new DeckNameReservationError(`Deck name reservation for "${oldName}" points to another deck`);
    }
    const newEntry = reservationData(newReservationSnap, ownerId, requestedName);
    if (newEntry && newEntry.deckId !== id) {
      verifyReservedDeck(await transaction.get(decks.doc(newEntry.deckId)), ownerId, requestedName, newEntry.deckId);
      throw new DeckNameConflictError(requestedName);
    }
    if (newNameMatches && newNameMatches.docs.some((doc) => doc.id !== id)) {
      if (newNameMatches.size > 1) throw new AmbiguousDeckNameError(requestedName);
      throw new DeckNameConflictError(requestedName);
    }
    const now = Timestamp.now();
    const nextName = input.name ?? oldName;
    if (nextName === oldName && !oldEntry && identity.uniqueName) {
      transaction.create(oldReservation, reservationPayload(ownerId, oldName, id, now));
    }
    if (nextName !== oldName) {
      if (!newEntry) transaction.create(newReservation, reservationPayload(ownerId, nextName, id, now));
      if (oldEntry) transaction.delete(oldReservation);
    }
    const update: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) update.name = input.name;
    if (input.description !== undefined) update.description = input.description;
    transaction.update(deckRef, update);
    return { ...deckFromSnapshot(currentSnap), ...update } as Deck;
  }, { maxAttempts: 20 });
}

async function syncDeckCardNames(ownerId: string, deckId: string): Promise<void> {
  const db = getDb();
  const deckRef = db.collection(DECKS_COLLECTION).doc(deckId);
  const cards = db.collection(FLASHCARDS_COLLECTION);
  let lastId: string | undefined;
  let hasMore = true;
  while (hasMore) {
    let query = cards.where('ownerId', '==', ownerId).where('deckId', '==', deckId)
      .select(...DECK_CARD_METADATA_FIELDS).orderBy(FieldPath.documentId()).limit(REASSIGN_PAGE_SIZE);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) return;
    await db.runTransaction(async (transaction) => {
      const currentDeck = await transaction.get(deckRef);
      if (!currentDeck.exists || currentDeck.data()?.ownerId !== ownerId) return;
      const currentName = currentDeck.data()!.name;
      validateDeckName(currentName);
      const candidates = page.docs.filter((document) => document.get('ownerId') === ownerId
        && document.get('deckId') === deckId && document.get('deck') !== currentName);
      if (candidates.length === 0) return;
      const snapshots = await readDeckCardMetadata(transaction, candidates);
      const now = Timestamp.now();
      for (let index = 0; index < snapshots.length; index++) {
        const card = snapshots[index].data();
        if (card?.ownerId === ownerId && card.deckId === deckId && card.deck !== currentName) {
          transaction.update(candidates[index].ref, { deck: currentName, updatedAt: now });
        }
      }
    }, { maxAttempts: 20 });
    hasMore = page.docs.length === REASSIGN_PAGE_SIZE;
    if (hasMore) lastId = page.docs[page.docs.length - 1].id;
  }
}

export async function updateDeck(id: string, input: UpdateDeckInput, ownerId: string): Promise<Deck | null> {
  validateOwner(ownerId);
  if (input.name !== undefined) validateDeckName(input.name);
  const identity = await readDeckIdentity(id, ownerId);
  if (!identity) return null;
  if (input.name !== undefined) await canonicalizeLegacyDeckCards(ownerId, identity);
  const updated = await renameOrUpdateDeck(id, input, ownerId, identity);
  if (!updated) return null;
  if (input.name !== undefined) await syncDeckCardNames(ownerId, id);
  return updated;
}

async function reassignCardPage(
  ownerId: string,
  sourceDeckId: string,
  defaultDeckId: string,
  page: QueryDocumentSnapshot<DocumentData>[],
  identity: DeckIdentity,
): Promise<number> {
  if (page.length === 0) return 0;
  const defaultRef = getDb().collection(DECKS_COLLECTION).doc(defaultDeckId);
  return getDb().runTransaction(async (transaction) => {
    await requireCurrentDeckIdentity(transaction, sourceDeckId, ownerId, identity);
    const defaultSnap = await transaction.get(defaultRef);
    if (!defaultSnap.exists || defaultSnap.data()?.ownerId !== ownerId) return 0;
    validateDeckName(defaultSnap.data()!.name);
    const cardSnaps = await readDeckCardMetadata(transaction, page);
    const now = Timestamp.now();
    let reassigned = 0;
    for (let index = 0; index < cardSnaps.length; index++) {
      const card = cardSnaps[index].data();
      if (!card || card.ownerId !== ownerId || card.deckId !== sourceDeckId) continue;
      transaction.update(page[index].ref, {
        deckId: defaultDeckId, deck: defaultSnap.data()!.name, updatedAt: now,
      });
      reassigned++;
    }
    return reassigned;
  }, { maxAttempts: 20 });
}

async function reassignCardPages(
  ownerId: string,
  sourceDeckId: string,
  defaultDeckId: string,
  page: QuerySnapshot<DocumentData>,
  identity: DeckIdentity,
): Promise<number> {
  let total = 0;
  let pending: QueryDocumentSnapshot<DocumentData>[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    total += await reassignCardPage(ownerId, sourceDeckId, defaultDeckId, pending, identity);
    pending = [];
    pendingBytes = 0;
  };
  const candidates = page.docs.filter((doc) => doc.get('ownerId') === ownerId
    && doc.get('deckId') === sourceDeckId);
  for (const doc of candidates) {
    const serialized = JSON.stringify(doc.data());
    const estimatedBytes = Buffer.byteLength(serialized ?? '{}', 'utf8') + 512;
    if (pending.length > 0 && (pending.length >= REASSIGN_PAGE_SIZE
      || pendingBytes + estimatedBytes > REASSIGN_TRANSACTION_BYTE_BUDGET)) {
      await flush();
    }
    pending.push(doc);
    pendingBytes += estimatedBytes;
  }
  await flush();
  return total;
}

export async function deleteDeck(id: string, ownerId: string): Promise<DeleteDeckResult | null> {
  validateOwner(ownerId);
  const db = getDb();
  let reassignedCards = 0;
  let continueUntilEmpty = true;

  while (continueUntilEmpty) {
    continueUntilEmpty = false;
    const identity = await readDeckIdentity(id, ownerId);
    if (!identity) return reassignedCards > 0 ? { deleted: false, reassignedCards } : null;
    const source = identity.deck;
    if (source.name === DEFAULT_DECK_NAME) throw new ProtectedDeckError(DEFAULT_DECK_NAME);
    await canonicalizeLegacyDeckCards(ownerId, identity);
    const defaultDeck = await getDefaultOwnedDeck(ownerId);

    const stablePage = await db.collection(FLASHCARDS_COLLECTION).where('ownerId', '==', ownerId)
      .where('deckId', '==', id).select(...DECK_CARD_METADATA_FIELDS)
      .orderBy(FieldPath.documentId()).limit(REASSIGN_PAGE_SIZE).get();
    const stableCount = await reassignCardPages(ownerId, id, defaultDeck.id, stablePage, identity);
    reassignedCards += stableCount;

    const attempt = await db.runTransaction(async (transaction) => (
      deleteOwnedDeckIfEmptyInTransaction(transaction, ownerId, id, source.name, identity.uniqueName)
    ), { maxAttempts: 20 });
    if (attempt === 'deleted') return { deleted: true, reassignedCards };
    if (attempt === 'missing') return reassignedCards > 0 ? { deleted: false, reassignedCards } : null;
    const stableRemaining = await db.collection(FLASHCARDS_COLLECTION).where('ownerId', '==', ownerId)
      .where('deckId', '==', id).select('ownerId', 'deckId').limit(1).get();
    if (!stableRemaining.empty || stableCount > 0) continueUntilEmpty = true;
  }
  return { deleted: false, reassignedCards };
}



/** Assigns only the owner's oldest cards with no deck fields to Uncategorized. */
export async function assignDecklessToDefault(
  ownerId: string,
  pageSize = BULK_LIMIT,
): Promise<{ assigned: number }> {
  const limit = Math.min(Math.max(1, pageSize), REASSIGN_PAGE_SIZE);
  const cards = getDb().collection(FLASHCARDS_COLLECTION);
  const defaultDeck = await getDefaultOwnedDeck(ownerId);
  let lastDoc: QueryDocumentSnapshot<DocumentData> | undefined;
  let assigned = 0;
  let hasMore = true;

  while (hasMore) {
    let query = cards.where('ownerId', '==', ownerId).select(...DECK_CARD_METADATA_FIELDS)
      .orderBy(FieldPath.documentId()).limit(limit);
    if (lastDoc) query = query.startAfter(lastDoc);
    const page = await query.get();
    if (page.empty) break;
    const candidates = page.docs.filter((doc) => doc.get('ownerId') === ownerId
      && doc.get('deckId') === undefined && doc.get('deck') === undefined);

    if (candidates.length > 0) {
      const changed = await getDb().runTransaction(async (transaction) => {
        const deckSnap = await transaction.get(getDb().collection(DECKS_COLLECTION).doc(defaultDeck.id));
        const cardSnaps = await readDeckCardMetadata(transaction, candidates);
        if (!deckSnap.exists || deckSnap.data()?.ownerId !== ownerId) throw new DeckNotFoundError(defaultDeck.id);
        validateDeckName(deckSnap.data()!.name);
        const currentDeckName = deckSnap.data()!.name;
        const now = Timestamp.now();
        let count = 0;
        for (let index = 0; index < cardSnaps.length; index++) {
          const card = cardSnaps[index].data();
          if (!card || card.ownerId !== ownerId || card.deckId !== undefined || card.deck !== undefined) continue;
          transaction.update(candidates[index].ref, {
            deckId: defaultDeck.id, deck: currentDeckName, updatedAt: now,
          });
          count++;
        }
        return count;
      }, { maxAttempts: 20 });
      assigned += changed;
    }

    hasMore = page.docs.length === limit;
    if (hasMore) lastDoc = page.docs[page.docs.length - 1];
  }
  return { assigned };
}

/** Backfills owner-scoped legacy cards; unowned documents are left untouched. */
export async function migrateLegacyDeckNames(pageSize = BULK_LIMIT): Promise<{ migrated: number }> {
  const cards = getDb().collection(FLASHCARDS_COLLECTION);
  let lastDoc: QueryDocumentSnapshot<DocumentData> | undefined;
  let hasMore = true;
  let migrated = 0;
  while (hasMore) {
    let query = cards.where('deck', '!=', '').select(...DECK_CARD_METADATA_FIELDS)
      .orderBy('deck').orderBy(FieldPath.documentId()).limit(pageSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const page = await query.get();
    for (const doc of page.docs) {
      const card = doc.data();
      if (card.deckId !== undefined || typeof card.ownerId !== 'string' || typeof card.deck !== 'string') continue;
      const deck = await getOrCreateOwnedDeck(card.ownerId, card.deck);
      const count = await getDb().runTransaction(async (transaction) => {
        const [currentCards, currentDeck] = await Promise.all([
          readDeckCardMetadata(transaction, [doc]),
          transaction.get(getDb().collection(DECKS_COLLECTION).doc(deck.id)),
        ]);
        const currentCard = currentCards[0];
        const current = currentCard.data();
        const target = currentDeck.data();
        if (!currentCard.exists || !current || current.ownerId !== card.ownerId || current.deckId !== undefined
          || current.deck !== card.deck || !currentDeck.exists || !target || target.ownerId !== card.ownerId) return 0;
        validateDeckName(target.name);
        const now = Timestamp.now();
        transaction.update(doc.ref, { deckId: deck.id, deck: target.name, updatedAt: now });
        return 1;
      }, { maxAttempts: 20 });
      migrated += count;
    }
    hasMore = page.docs.length === pageSize;
    if (hasMore) lastDoc = page.docs[page.docs.length - 1];
  }
  return { migrated };
}

/** Transactional finalizer; unambiguous name-only references must be canonicalized first. */
export async function deleteOwnedDeckIfEmptyInTransaction(
  transaction: Transaction,
  ownerId: string,
  deckId: string,
  expectedName: string,
  expectedUniqueName: boolean,
): Promise<'deleted' | 'notEmpty' | 'missing'> {
  validateOwner(ownerId);
  const db = getDb();
  const deckRef = db.collection(DECKS_COLLECTION).doc(deckId);
  const deckSnap = await transaction.get(deckRef);
  if (!deckSnap.exists || deckSnap.data()?.ownerId !== ownerId) return 'missing';
  const name = deckSnap.data()!.name;
  validateDeckName(name);
  if (name !== expectedName) throw new DeckNameReservationError(`Deck "${deckId}" changed name during deletion; retry`);
  if (name === DEFAULT_DECK_NAME) throw new ProtectedDeckError(DEFAULT_DECK_NAME);
  const reservation = reservationRef(ownerId, name);
  const [reservationSnap, references, namedDecks] = await Promise.all([
    transaction.get(reservation),
    transaction.get(db.collection(FLASHCARDS_COLLECTION).where('ownerId', '==', ownerId)
      .where('deckId', '==', deckId).select('ownerId', 'deckId').limit(1)),
    transaction.get(matchingDecks(ownerId, name)),
  ]);
  const reservationEntry = reservationData(reservationSnap, ownerId, name);
  if (reservationEntry && reservationEntry.deckId !== deckId) {
    throw new DeckNameReservationError(`Deck name reservation for "${name}" points to another deck`);
  }
  const uniqueName = namedDecks.size === 1 && namedDecks.docs[0].id === deckId;
  if (uniqueName !== expectedUniqueName) throw new DeckNameReservationError(`Deck "${deckId}" changed name ownership during deletion; retry`);
  if (!references.empty) return 'notEmpty';
  transaction.delete(deckRef);
  if (reservationEntry) transaction.delete(reservation);
  return 'deleted';
}


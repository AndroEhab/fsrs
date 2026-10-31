/**
 * Anki .apkg import/export orchestration over Firestore.
 *
 * IMPORT (`importApkg`): parse + validate the package (pure — see
 * `parseApkgImport`), then write cards in owner-scoped Firestore transactions
 * of ≤500 writes each. All cards are validated before the first card write;
 * referenced decks are resolved through the owned-deck registry, and each
 * card transaction re-reads the current owned deck name. Each transaction is
 * atomic; more than 500 cards commit across transactions, so a mid-run
 * failure leaves explicit partial progress (the response reports `atomic`
 * and `batchCount`).
 *
 * EXPORT (`exportApkg`): scans cards in the canonical deterministic order
 * (createdAt DESC, document id ASC — the same total order searchCards and
 * the review-history pages use; needs the already-declared composite index
 * `(createdAt DESC, __name__ ASC)`), selects by deck or explicit ids, and
 * builds a valid stock-Anki .apkg in memory (collection.anki2 + media map).
 * Scheduling export is approximate rather than lossless: current card state
 * uses FSRS stability to approximate Anki intervals; revlog intervals use
 * the next retained pre-review due time, with short-term steps encoded in
 * seconds and review intervals in days. Unknown or truncated boundaries are
 * zero, not inferred from stability. Card/note IDs retain source creation
 * timestamps (same-ms ties use adjacent milliseconds); note GUIDs provide
 * stable identity. Reviewed cards use Anki's default 2500‰ ease because no
 * Anki-compatible FSRS memory state or SM-2 ease is stored. Truncated review
 * history and manual due-date changes cannot be reconstructed.
 * Media: stored images referenced by signed download URL are embedded when
 * fetchable and within the size caps; otherwise they are reported as skipped.
 *
 * Auth is enforced by the HTTP handler (fail-closed, existing gate); export
 * selection additionally requires the authenticated owner id to stay scoped.
 */
import {
  getFirestore, Firestore, Timestamp, FieldPath,
} from 'firebase-admin/firestore';
import {
  ANKI_DECK_PATH_MAX, ANKI_EXPORT_CARD_LIMIT, ANKI_MAX_APKG_RESPONSE_BYTES,
  ANKI_IMPORT_TRANSACTION_MAX_BYTES, ANKI_MAX_MEDIA_BYTES, ANKI_MAX_MEDIA_COUNT,
  ANKI_MAX_TOTAL_MEDIA_BYTES, ExportedMedia, ExportApkgInput, ExportApkgResponse,
  ImportApkgInput, ImportApkgResponse, ImportedCard,
} from './types';
import {
  buildCollectionBytes, decodeImportEnvelope, assembleApkgBytes,
  ExportCard, ExportSchedulerSteps, parseApkgImport,
} from './apkg';
import { ApkgFormatError } from './zip';
import { refreshOwnedCardImageUrls } from '../service';
import type { CardImage, Flashcard as FlashcardType } from '../types';
import { getFSRSStepConfiguration, reconstructLearningSteps, LearningProgressUnavailableError } from '../scheduler';
import { safeMediaFetch } from './ssrf';

import { getOrCreateOwnedDeck, readOwnedDeckInTransaction } from '../decks';

const COLLECTION = 'flashcards';
/** Firestore hard limit: one transaction supports at most 500 writes. */
const BATCH_WRITE_LIMIT = 500;
/** Firestore page size while scanning export candidates. */
const SCAN_PAGE = 500;

let db: Firestore | undefined;
function getDb(): Firestore {
  if (!db) db = getFirestore();
  return db;
}

/** Client-visible 400 for malformed/unacceptable package input. */
export class ApkgImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkgImportError';
  }
}

/** Client-visible 400 for export selection/limit problems. */
export class ApkgExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkgExportError';
  }
}

/**
 * Finds or creates the canonical owner-scoped deck entity for every distinct
 * Anki path. Anki's `A::B::C` hierarchy is stored as one deck name so export
 * preserves the original path.
 */
async function ensureDecksForPaths(paths: Array<string | null>, ownerId: string): Promise<Map<string, string>> {
  const leaves = new Set<string>();
  for (const path of paths) {
    if (path === null || path.trim() === '') continue;
    leaves.add(path.trim());
  }
  const out = new Map<string, string>();
  for (const leaf of [...leaves].sort()) {
    const deck = await getOrCreateOwnedDeck(ownerId, leaf);
    out.set(leaf, deck.id);
  }
  return out;
}

/** Builds the Firestore payload for one imported card using the current deck name. */
function cardToWrite(
  card: ImportedCard,
  deckRefs: Map<string, string>,
  deckNames: Map<string, string>,
  now: Timestamp,
  ownerId: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ownerId,
    front: card.front,
    back: card.back,
    tags: card.tags,
    suspended: false,
    createdAt: now,
    updatedAt: now,
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    due: now,
    reviewLog: [],
    images: [],
  };
  if (card.deckPath !== null && card.deckPath.trim() !== '') {
    const deckId = deckRefs.get(card.deckPath.trim());
    if (deckId !== undefined) {
      data.deckId = deckId;
      data.deck = deckNames.get(deckId)!;
    }
  }
  return data;
}

/**
 * Imports parsed cards in count- and byte-bounded transactions. JSON escaping
 * is conservatively budgeted at six bytes per UTF-16 code unit; fixed
 * per-document overhead reserves space for Firestore field/protobuf framing.
 */
function estimateImportWriteBytes(card: ImportedCard, ownerId: string): number {
  let codeUnits = ownerId.length + card.front.length + card.back.length;
  if (card.deckPath !== null && card.deckPath.trim() !== '') codeUnits += ANKI_DECK_PATH_MAX;
  for (const tag of card.tags) codeUnits += tag.length;
  return 2_048 + codeUnits * 6;
}

export async function writeImportedCards(cards: ImportedCard[], ownerId: string): Promise<{ atomic: boolean; batchCount: number }> {
  if (cards.length === 0) return { atomic: true, batchCount: 0 };
  const deckRefs = await ensureDecksForPaths(cards.map((c) => c.deckPath), ownerId);
  const now = Timestamp.now();
  let batchCount = 0;
  let requestBytes = 0;
  let writes: Array<{ card: ImportedCard; ref: FirebaseFirestore.DocumentReference }> = [];

  const commitChunk = async (): Promise<void> => {
    if (writes.length === 0) return;
    const chunk = writes;
    writes = [];
    requestBytes = 0;
    await getDb().runTransaction(async (transaction) => {
      const deckNames = new Map<string, string>();
      for (const { card } of chunk) {
        if (card.deckPath === null || card.deckPath.trim() === '') continue;
        const deckId = deckRefs.get(card.deckPath.trim());
        if (deckId !== undefined && !deckNames.has(deckId)) {
          const deck = await readOwnedDeckInTransaction(transaction, deckId, ownerId);
          deckNames.set(deckId, deck.name);
        }
      }
      for (const { card, ref } of chunk) {
        transaction.create(ref, cardToWrite(card, deckRefs, deckNames, now, ownerId));
      }
    });
    batchCount += 1;
  };

  for (const card of cards) {
    const estimatedBytes = estimateImportWriteBytes(card, ownerId);
    if (estimatedBytes > ANKI_IMPORT_TRANSACTION_MAX_BYTES) {
      throw new ApkgImportError('An imported card exceeds the safe Firestore write size');
    }
    if (writes.length >= BATCH_WRITE_LIMIT
      || requestBytes + estimatedBytes > ANKI_IMPORT_TRANSACTION_MAX_BYTES) {
      await commitChunk();
    }
    writes.push({ card, ref: getDb().collection(COLLECTION).doc() });
    requestBytes += estimatedBytes;
  }
  await commitChunk();
  return { atomic: batchCount <= 1, batchCount };
}


/**
 * Imports one base64 .apkg into the library. End-to-end: envelope decode →
 * ZIP/SQLite parse (bounded, validated) → optional deckPath override →
 * deck resolution → chunked owner-scoped card transactions. Each card
 * transaction re-reads the current owned deck name before writing cards.
 * Throws ApkgImportError for client-visible package input problems.
 */
export async function importApkg(input: ImportApkgInput, ownerId: string): Promise<ImportApkgResponse> {
  if (typeof input?.package !== 'string' || input.package === '') {
    throw new ApkgImportError('package is required (base64-encoded .apkg)');
  }
  const decoded = decodeImportEnvelope(input.package);
  if ('error' in decoded) throw new ApkgImportError(decoded.error);
  let parsed;
  try {
    parsed = await parseApkgImport(decoded.bytes);
  } catch (err) {
    if (err instanceof ApkgFormatError) throw new ApkgImportError(err.message);
    throw err;
  }
  // Optional override: import every card into one explicit deck path.
  if (input.deckPath !== undefined && input.deckPath !== null && input.deckPath.trim() !== '') {
    const normalized = normalizeDeckPathForImportPublic(input.deckPath);
    if (normalized === null) {
      throw new ApkgImportError('deckPath must be a non-empty deck path of at most 300 characters');
    }
    parsed = { ...parsed, cards: parsed.cards.map((c) => ({ ...c, deckPath: normalized })) };
  }
  const overLimit = parsed.skippedOverLimit;
  const bounded = parsed.cards;
  // Preflight the complete returned object before deck resolution or writes.
  // The actual write plan is computed by writeImportedCards; conservatively
  // budget its maximum possible transaction count and atomic flag here.
  const emptyResponse: ImportApkgResponse = {
    cards: [],
    skippedNotes: parsed.skippedNotes,
    skippedEmpty: parsed.skippedEmpty,
    skippedOverLimit: overLimit,
    atomic: bounded.length === 0,
    batchCount: bounded.length,
  };
  const responseBytes = Buffer.byteLength(JSON.stringify(emptyResponse), 'utf8')
    + jsonArrayByteLength(bounded) - 2;
  if (responseBytes > ANKI_MAX_APKG_RESPONSE_BYTES) {
    throw new ApkgImportError(
      'Import response exceeds the 32 MB response size limit; reduce the number or size of imported cards',
    );
  }
  const write = await writeImportedCards(bounded, ownerId);
  return {
    cards: bounded,
    skippedNotes: parsed.skippedNotes,
    skippedEmpty: parsed.skippedEmpty,
    skippedOverLimit: overLimit,
    atomic: write.atomic,
    batchCount: write.batchCount,
  };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Export encoding consumes its own view; media hydration needs only this
 * owner-scoped snapshot alongside it. */
type OwnedExportCard = ExportCard & Pick<FlashcardType, 'id' | 'images'> & { ownerId: string };

/** Maps a card snapshot to the export view (same read defaults as the
 * service's docToFlashcard, minus fields Anki cannot represent). */
function docToExportCard(doc: FirebaseFirestore.DocumentSnapshot): OwnedExportCard {
  const d = doc.data();
  if (!d) {
    return {
      id: doc.id, ownerId: '', images: [], front: '', back: '', deckPath: null, tags: [],
      createdAtMs: 0, updatedAtMs: 0, dueMs: 0, state: 0, stability: 0,
      difficulty: 0, reps: 0, lapses: 0, reviewLog: [],
    };
  }
  const ms = (v: unknown): number => {
    if (v && typeof v === 'object' && 'toMillis' in v && typeof (v as { toMillis: unknown }).toMillis === 'function') {
      return (v as { toMillis: () => number }).toMillis();
    }
    return 0;
  };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const optionalNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const numArray = Array.isArray(d.reviewLog)
    ? (d.reviewLog as Array<Record<string, unknown>>).map((e) => {
      const learningStepsAfter = optionalNum(e.learningStepsAfter);
      return {
        rating: num(e.rating), state: num(e.state), reviewMs: ms(e.review), dueMs: ms(e.due),
        stability: num(e.stability), difficulty: num(e.difficulty), reps: num(e.reps), lapses: num(e.lapses),
        ...(learningStepsAfter !== undefined ? { learningStepsAfter } : {}),
      };
    }).filter((e) => e.reviewMs > 0 || e.rating > 0)
    : [];
  const learningSteps = optionalNum(d.learningSteps);
  return {
    id: doc.id,
    ownerId: typeof d.ownerId === 'string' ? d.ownerId : '',
    images: Array.isArray(d.images) ? d.images as CardImage[] : [],
    front: typeof d.front === 'string' ? d.front : '',
    back: typeof d.back === 'string' ? d.back : '',
    deckPath: typeof d.deck === 'string' && d.deck !== '' ? d.deck : null,
    tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : [],
    suspended: d.suspended === true,
    createdAtMs: ms(d.createdAt),
    updatedAtMs: ms(d.updatedAt),
    dueMs: ms(d.due),
    state: num(d.state),
    stability: num(d.stability),
    difficulty: num(d.difficulty),
    reps: num(d.reps),
    lapses: num(d.lapses),
    ...(d.lastReview !== undefined ? { lastReviewMs: ms(d.lastReview) } : {}),
    ...(learningSteps !== undefined ? { learningSteps } : {}),
    reviewLog: numArray,
  };
}

/**
 * Scans cards in the canonical deterministic order (createdAt DESC, id ASC)
 * until `limit` are collected or the collection is exhausted. Used for
 * whole-library export (with optional in-memory deck filtering).
 */
async function scanExportCards(limit: number, ownerId: string): Promise<OwnedExportCard[]> {
  const out: OwnedExportCard[] = [];
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    if (out.length >= limit) break;
    let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
    q = q.where('ownerId', '==', ownerId);
    q = q.orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId());
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.limit(SCAN_PAGE).get();
    if (snap.docs.length === 0) break;
    lastDoc = snap.docs[snap.docs.length - 1];
    for (const doc of snap.docs) {
      out.push(docToExportCard(doc));
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Deck-filtered export scan: uses the Firestore composite index
 * (ownerId, deck, createdAt DESC) to read ONLY cards in the target deck,
 * avoiding a full-collection scan. Handles both exact deck-path and
 * leaf-name matching by collecting candidates from both the exact query
 * and the leaf-name query, deduplicating by document id.
 */
async function scanExportCardsByDeck(
  deck: string,
  limit: number,
  ownerId: string,
): Promise<OwnedExportCard[]> {
  const seen = new Set<string>();
  const out: OwnedExportCard[] = [];
  const collect = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    for (const doc of docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push(docToExportCard(doc));
      if (out.length >= limit) break;
    }
  };

  let q1: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
  q1 = q1.where('ownerId', '==', ownerId).where('deck', '==', deck)
    .orderBy('createdAt', 'desc');
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    if (out.length >= limit) break;
    const base: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = lastDoc ? q1.startAfter(lastDoc) : q1;
    const snap: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData> = await base.limit(SCAN_PAGE).get();
    if (snap.docs.length === 0) break;
    collect(snap.docs);
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  const leaf = deck.split('::').pop()?.trim();
  if (leaf !== undefined && leaf !== deck && out.length < limit) {
    let q2: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
    q2 = q2.where('ownerId', '==', ownerId).where('deck', '==', leaf)
      .orderBy('createdAt', 'desc');
    lastDoc = null;
    for (;;) {
      if (out.length >= limit) break;
      const base: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = lastDoc ? q2.startAfter(lastDoc) : q2;
      const snap: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData> = await base.limit(SCAN_PAGE).get();
      if (snap.docs.length === 0) break;
      collect(snap.docs);
      lastDoc = snap.docs[snap.docs.length - 1];
    }
  }

  return out;
}

/**
 * Selects export cards by deck / explicit ids. With no filters, exports the
 * newest ANKI_EXPORT_CARD_LIMIT cards. With `deck`, exports every card whose
 * stored deck path equals it (or whose leaf matches). With `cardIds`,
 * exports exactly those (deduped, input order; missing ids omitted).
 */
export async function selectExportCards(
  input: ExportApkgInput,
  ownerId: string,
): Promise<{ selected: OwnedExportCard[]; filtered: number; total: number }> {
  if (!ownerId) throw new ApkgExportError('An owner is required for export');
  const deck = typeof input?.deck === 'string' ? input.deck.trim() : undefined;
  const ids = Array.isArray(input.cardIds)
    ? [...new Set(input.cardIds.filter((x): x is string => typeof x === 'string' && x !== ''))]
    : undefined;
  if (deck !== undefined && deck.length > 300) {
    throw new ApkgExportError('deck must be at most 300 characters');
  }
  if (ids !== undefined) {
    if (ids.length > ANKI_EXPORT_CARD_LIMIT) {
      throw new ApkgExportError(`Too many card ids (${ids.length} > ${ANKI_EXPORT_CARD_LIMIT})`);
    }
    const selected: OwnedExportCard[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const doc = await getDb().collection(COLLECTION).doc(id).get();
      // Owner-scoped export never leaks another tenant's card: an id that is
      // missing OR not owned by the caller is omitted (never exported).
      if (!doc.exists || doc.data()?.ownerId !== ownerId) { missing.push(id); continue; }
      selected.push(docToExportCard(doc));
    }
    return { selected, filtered: missing.length, total: selected.length + missing.length };
  }

  // Deck-filtered export: use the composite index to read only the target
  // deck's cards, avoiding a full-collection scan (the previous path scanned
  // ANKI_EXPORT_CARD_LIMIT+1 docs and filtered in memory — expensive when
  // the collection has thousands of cards in other decks).
  if (deck !== undefined) {
    const selected = await scanExportCardsByDeck(deck, ANKI_EXPORT_CARD_LIMIT, ownerId);
    return { selected, filtered: 0, total: selected.length };
  }

  const scanned = await scanExportCards(ANKI_EXPORT_CARD_LIMIT + 1, ownerId);
  const over = scanned.length > ANKI_EXPORT_CARD_LIMIT;
  const within = scanned.slice(0, ANKI_EXPORT_CARD_LIMIT);
  return { selected: within, filtered: over ? 1 : 0, total: scanned.length };
}

/** Fetches image URLs of a card (best-effort; never throws). */
async function imageUrlsForCard(card: OwnedExportCard, ownerId: string): Promise<string[]> {
  try {
    const refreshed = await refreshOwnedCardImageUrls({
      id: card.id,
      ownerId: card.ownerId,
      images: card.images,
    }, ownerId);
    return refreshed.images.flatMap((image) => {
      const url = image.downloadUrl && image.downloadUrl !== '' ? image.downloadUrl : image.url;
      return url === '' ? [] : [url];
    });
  } catch {
    return card.images.flatMap((image) => {
      const url = image.downloadUrl && image.downloadUrl !== '' ? image.downloadUrl : image.url;
      return url === '' ? [] : [url];
    });
  }
}

function mediaUrlsSharePath(first: string, second: string): boolean {
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    return firstUrl.origin === secondUrl.origin && firstUrl.pathname === secondUrl.pathname;
  } catch {
    return false;
  }
}

const ANKI_MEDIA_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

function safeMediaFileName(url: string, successIndex: number, card: OwnedExportCard): string {
  let mimeType: string | undefined;
  for (const image of card.images) {
    if (image.downloadUrl === url || image.url === url
      || (image.downloadUrl !== undefined && mediaUrlsSharePath(image.downloadUrl, url))
      || mediaUrlsSharePath(image.url, url)) {
      mimeType = image.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
      break;
    }
  }
  let extension = mimeType && Object.hasOwn(ANKI_MEDIA_EXTENSION_BY_MIME, mimeType)
    ? ANKI_MEDIA_EXTENSION_BY_MIME[mimeType]
    : '';
  if (extension === '') {
    try {
      const pathname = new URL(url).pathname;
      const basename = pathname.slice(pathname.lastIndexOf('/') + 1);
      const dot = basename.lastIndexOf('.');
      const suffix = dot > 0 ? basename.slice(dot).toLowerCase() : '';
      if (/^\.(avif|bmp|gif|jpe?g|png|svg|webp)$/.test(suffix)) extension = suffix;
    } catch {
      // Invalid URLs remain subject to safeMediaFetch's typed refusal.
    }
  }
  return `image-${successIndex + 1}${extension}`;
}

function snapshotImageUrls(card: OwnedExportCard): string[] {
  return card.images.flatMap((image) => {
    const url = image.downloadUrl && image.downloadUrl !== '' ? image.downloadUrl : image.url;
    return url === '' ? [] : [url];
  });
}

/**
 * Fetches owner-projected media sequentially under aggregate byte/deadline
 * budgets. A failed request consumes its full bounded allowance, conservatively
 * limiting retries. Once a budget is exhausted, only snapshot URL associations
 * are used; no further URL signing or fetch is started.
 */
async function collectExportMedia(cards: OwnedExportCard[], ownerId: string): Promise<{
  media: ExportedMedia[];
  skipped: Array<{ url: string; reason: string }>;
  cardMediaRefs: Map<string, string[]>;
}> {
  const media: ExportedMedia[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const cardMediaRefs = new Map<string, string[]>();
  const fileNameByUrl = new Map<string, string>();
  const attempted = new Set<string>();
  let remainingBytes = ANKI_MAX_TOTAL_MEDIA_BYTES;
  const deadline = Date.now() + 8000;

  const attach = (cardId: string, fileName: string): void => {
    const refs = cardMediaRefs.get(cardId) ?? [];
    if (!refs.includes(fileName)) refs.push(fileName);
    cardMediaRefs.set(cardId, refs);
  };
  const budgetStopReason = (): string | null => {
    if (media.length >= ANKI_MAX_MEDIA_COUNT) return `media count cap reached (${ANKI_MAX_MEDIA_COUNT})`;
    if (remainingBytes <= 0) return 'total media byte budget exhausted';
    if (Date.now() >= deadline) return 'total media time budget exhausted';
    return null;
  };
  const useSnapshotUrls = (card: OwnedExportCard, reason: string): void => {
    for (const url of snapshotImageUrls(card)) {
      const existing = fileNameByUrl.get(url);
      if (existing !== undefined) {
        attach(card.id, existing);
      } else if (!attempted.has(url)) {
        attempted.add(url);
        skipped.push({ url, reason });
      }
    }
  };

  for (const card of cards) {
    const snapshotUrls = snapshotImageUrls(card);
    for (const url of snapshotUrls) {
      const existing = fileNameByUrl.get(url);
      if (existing !== undefined) attach(card.id, existing);
    }
    const stopReason = budgetStopReason();
    if (stopReason !== null) {
      useSnapshotUrls(card, stopReason);
      continue;
    }
    if (snapshotUrls.length === 0 || snapshotUrls.every((url) => fileNameByUrl.has(url))) continue;

    const urls = await imageUrlsForCard(card, ownerId);
    for (const url of urls) {
      const existing = fileNameByUrl.get(url);
      if (existing !== undefined) {
        attach(card.id, existing);
        continue;
      }
      if (attempted.has(url)) continue;
      attempted.add(url);
      const fetchStopReason = budgetStopReason();
      if (fetchStopReason !== null) {
        skipped.push({ url, reason: fetchStopReason });
        continue;
      }
      const remainingTimeMs = deadline - Date.now();
      const maxBytes = Math.min(ANKI_MAX_MEDIA_BYTES, remainingBytes);
      const fetched = await safeMediaFetch(url, {
        maxBytes,
        timeoutMs: Math.min(8000, remainingTimeMs),
        maxRedirects: 3,
      });
      if (!fetched.ok) {
        remainingBytes -= maxBytes;
        skipped.push({ url, reason: fetched.reason });
        continue;
      }
      const bytes = fetched.bytes;
      const size = bytes.byteLength;
      if (size === 0) {
        remainingBytes -= maxBytes;
        skipped.push({ url, reason: 'empty response' });
        continue;
      }
      if (size > ANKI_MAX_MEDIA_BYTES || size > maxBytes) {
        remainingBytes -= maxBytes;
        skipped.push({ url, reason: `too large (${size} bytes > ${maxBytes})` });
        continue;
      }
      remainingBytes -= size;
      const fileName = safeMediaFileName(url, media.length, card);
      fileNameByUrl.set(url, fileName);
      media.push({ fileName, data: bytes, sourceUrl: url });
      attach(card.id, fileName);
    }
  }
  return { media, skipped, cardMediaRefs };
}

function jsonArrayByteLength(values: readonly unknown[]): number {
  let bytes = 2;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) bytes += 1;
    const encoded = JSON.stringify(values[index]);
    if (encoded === undefined) throw new TypeError('APKG response contains a non-JSON value');
    bytes += Buffer.byteLength(encoded, 'utf8');
  }
  return bytes;
}

/**
 * Exports flashcards to a base64 .apkg.
 * - `deck` filter: exact stored deck path/name.
 * - `cardIds` filter: explicit bounded list.
 * - no filter: the newest ANKI_EXPORT_CARD_LIMIT cards (older cards are
 *   counted in `filteredCards` — exports never silently truncate).
 */
export async function exportApkg(input: ExportApkgInput, ownerId: string): Promise<ExportApkgResponse> {
  const { selected, filtered, total } = await selectExportCards(input, ownerId);
  if (selected.length === 0) {
    throw new ApkgExportError('No cards match the export selection');
  }
  const nowMs = Date.now();
  const stepConfig = getFSRSStepConfiguration();
  const progressByCardId = new Map<string, number>();
  try {
    for (const card of selected) {
      if (card.state === 1 || card.state === 3) {
        progressByCardId.set(card.id, reconstructLearningSteps({
          state: card.state,
          learningSteps: card.learningSteps,
          reviewLog: card.reviewLog,
        }));
      }
    }
  } catch (error) {
    if (error instanceof LearningProgressUnavailableError) throw new ApkgExportError(error.message);
    throw error;
  }
  const schedulerSteps: ExportSchedulerSteps = { ...stepConfig, progressByCardId };
  const { media, skipped, cardMediaRefs } = await collectExportMedia(selected, ownerId);
  let collection: Uint8Array;
  try {
    collection = await buildCollectionBytes(selected, nowMs, cardMediaRefs, schedulerSteps);
  } catch (error) {
    if (error instanceof ApkgFormatError) throw new ApkgExportError(error.message);
    throw error;
  }
  const pkg = await assembleApkgBytes(collection, media);
  const decks = [...new Set(selected.map((c) => c.deckPath ?? null))];
  const schedulingExported = selected.some((c) => c.reps > 0 || c.reviewLog.length > 0);
  const mediaSummary = media.map((m) => ({ fileName: m.fileName, sourceUrl: m.sourceUrl }));
  const responseBase64Length = 4 * Math.ceil(pkg.byteLength / 3);
  const emptyResponse = {
    package: '',
    cardCount: selected.length,
    filteredCards: filtered,
    decks: [],
    media: [],
    mediaSkipped: [],
    schedulingExported,
  };
  const responseBytes = Buffer.byteLength(JSON.stringify(emptyResponse), 'utf8')
    + responseBase64Length
    + jsonArrayByteLength(decks) - 2
    + jsonArrayByteLength(mediaSummary) - 2
    + jsonArrayByteLength(skipped) - 2;
  if (responseBytes > ANKI_MAX_APKG_RESPONSE_BYTES) {
    throw new ApkgExportError(
      'Export response exceeds the 32 MB response size limit; reduce selected cards or image references',
    );
  }
  void total;
  const packageBase64 = Buffer.from(pkg.buffer as ArrayBuffer, pkg.byteOffset, pkg.byteLength).toString('base64');
  return {
    package: packageBase64,
    cardCount: selected.length,
    filteredCards: filtered,
    decks,
    media: mediaSummary,
    mediaSkipped: skipped,
    schedulingExported,
  };
}

/** Validates a deck-path override for import. Exported for the validators. */
export function normalizeDeckPathForImportPublic(path: string): string | null {
  const parts = path.split('::').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return null;
  if (parts.some((p) => p.length > 100)) return null;
  const joined = parts.join('::');
  return joined.length > 300 ? null : joined;
}

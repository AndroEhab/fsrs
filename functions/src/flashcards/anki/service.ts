/**
 * Anki .apkg import/export orchestration over Firestore.
 *
 * IMPORT (`importApkg`): parse + validate the package (pure — see
 * `parseApkgImport`), then write every card in chunked Firestore write
 * batches (≤500 writes each — Firestore's batch limit). All cards are
 * validated before the first write; decks referenced by imported deck paths
 * are found-or-created (a deck entity per leaf name) before any card write.
 * Writes within one batch are ATOMIC (all or nothing); more than 500 cards
 * commit across batches, so a mid-run failure leaves explicit partial
 * progress (documented; the response reports `atomic` and `batchCount`).
 *
 * EXPORT (`exportApkg`): scans cards in the canonical deterministic order
 * (createdAt DESC, document id ASC — the same total order searchCards and
 * the review-history pages use; needs the already-declared composite index
 * `(createdAt DESC, __name__ ASC)`), selects by deck or explicit ids, and
 * builds a valid stock-Anki .apkg in memory (collection.anki2 + media map).
 * Scheduling metadata is carried where Anki-compatible: review cards map
 * FSRS state to Anki type/queue/due day-ordinals; reps/lapses and the FSRS
 * reviewLog become Anki revlog rows. Media: stored images referenced by
 * signed download URL are embedded when fetchable and within the size caps;
 * otherwise they are reported as skipped.
 *
 * Auth is enforced by the HTTP handler (fail-closed, existing gate); these
 * functions take no actor and are unit-testable against mocked Firestore.
 */
import {
  getFirestore, Firestore, Timestamp, FieldPath,
} from 'firebase-admin/firestore';
import {
  ANKI_EXPORT_CARD_LIMIT, ANKI_IMPORT_CARD_LIMIT,
  ANKI_MAX_MEDIA_BYTES, ANKI_MAX_MEDIA_COUNT, ANKI_MAX_TOTAL_MEDIA_BYTES,
  ExportedMedia, ExportApkgInput, ExportApkgResponse, ImportApkgInput,
  ImportApkgResponse, ImportedCard,
} from './types';
import {
  buildCollectionBytes, decodeImportEnvelope, assembleApkgBytes,
  ExportCard, parseApkgImport,
} from './apkg';
import { ApkgFormatError } from './zip';
import { safeMediaFetch } from './ssrf';

const COLLECTION = 'flashcards';
const DECKS_COLLECTION = 'decks';
/** Firestore hard limit: one WriteBatch supports 500 writes. */
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

/** Resolves a deck entity by exact leaf name (or null), scoped to the
 *  owner's decks when `ownerId` is given (deck names are unique per owner). */
async function findDeckIdByExactName(name: string, ownerId?: string): Promise<string | null> {
  let q = getDb().collection(DECKS_COLLECTION).where('name', '==', name);
  if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
  const existing = await q.limit(1).get();
  if (existing.empty) return null;
  return existing.docs[0].id;
}

/** Creates a deck entity (assumes the name is not taken). */
async function createDeckEntity(name: string, ownerId?: string): Promise<string> {
  const now = Timestamp.now();
  const docRef = getDb().collection(DECKS_COLLECTION).doc();
  const deck: Record<string, unknown> = { name, createdAt: now, updatedAt: now };
  if (ownerId !== undefined) deck.ownerId = ownerId;
  await docRef.set(deck);
  return docRef.id;
}

/**
 * Finds or creates the deck entity for every distinct leaf name referenced
 * by the imported cards. This product has ONE deck level; an Anki deck PATH
 * (`A::B::C`) is stored as a single deck whose name is the full path (so
 * re-export keeps the hierarchy), matching `createFlashcard`'s find-or-
 * create-by-name semantics. Returns leaf name → stable deck id.
 */
async function ensureDecksForPaths(paths: Array<string | null>, ownerId?: string): Promise<Map<string, string>> {
  const leaves = new Set<string>();
  for (const path of paths) {
    if (path === null || path.trim() === '') continue;
    leaves.add(path.trim());
  }
  const out = new Map<string, string>();
  for (const leaf of [...leaves].sort()) {
    const existing = await findDeckIdByExactName(leaf, ownerId);
    out.set(leaf, existing !== null ? existing : await createDeckEntity(leaf, ownerId));
  }
  return out;
}

/** Builds the Firestore payload for one imported card. */
function cardToWrite(card: ImportedCard, deckRefs: Map<string, string>, now: Timestamp, ownerId?: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...(ownerId !== undefined ? { ownerId } : {}),
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
      data.deck = card.deckPath.trim();
    }
  }
  return data;
}

/**
 * Imports parsed cards into Firestore with ≤500-write batches. Deck
 * entities are ensured first (standalone writes outside batches), then all
 * cards are written. Returns atomicity facts for the response.
 */
export async function writeImportedCards(cards: ImportedCard[], ownerId?: string): Promise<{ atomic: boolean; batchCount: number }> {
  if (cards.length === 0) return { atomic: true, batchCount: 0 };
  const deckRefs = await ensureDecksForPaths(cards.map((c) => c.deckPath), ownerId);
  const now = Timestamp.now();
  const atomic = cards.length <= BATCH_WRITE_LIMIT;
  let batchCount = 0;
  for (let i = 0; i < cards.length; i += BATCH_WRITE_LIMIT) {
    const chunk = cards.slice(i, i + BATCH_WRITE_LIMIT);
    const batch = getDb().batch();
    for (const card of chunk) {
      const docRef = getDb().collection(COLLECTION).doc();
      batch.set(docRef, cardToWrite(card, deckRefs, now, ownerId));
    }
    await batch.commit();
    batchCount += 1;
  }
  return { atomic, batchCount };
}

/**
 * Imports one base64 .apkg into the library. End-to-end: envelope decode →
 * ZIP/SQLite parse (bounded, validated) → optional deckPath override →
 * deck resolution → chunked atomic writes. Throws ApkgImportError for any
 * client-visible problem (malformed package, over-limit, invalid base64).
 */
export async function importApkg(input: ImportApkgInput, ownerId?: string): Promise<ImportApkgResponse> {
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
  const overLimit = Math.max(0, parsed.cards.length - ANKI_IMPORT_CARD_LIMIT);
  const bounded = parsed.cards.slice(0, ANKI_IMPORT_CARD_LIMIT);
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

/** Maps a card snapshot to the export view (same read defaults as the
 * service's docToFlashcard, minus fields Anki cannot represent). */
function docToExportCard(doc: FirebaseFirestore.DocumentSnapshot): ExportCard {
  const d = doc.data();
  if (!d) {
    return {
      id: doc.id, front: '', back: '', deckPath: null, tags: [],
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
  const numArray = Array.isArray(d.reviewLog)
    ? (d.reviewLog as Array<Record<string, unknown>>).map((e) => ({
      rating: num(e.rating), state: num(e.state), reviewMs: ms(e.review), dueMs: ms(e.due),
      stability: num(e.stability), difficulty: num(e.difficulty), reps: num(e.reps), lapses: num(e.lapses),
    })).filter((e) => e.reviewMs > 0 || e.rating > 0)
    : [];
  return {
    id: doc.id,
    ...(typeof d.ownerId === 'string' ? { ownerId: d.ownerId } : {}),
    front: typeof d.front === 'string' ? d.front : '',
    back: typeof d.back === 'string' ? d.back : '',
    // The stored `deck` is the deck path (leaf = full path in this product;
    // import writes full `A::B` paths as the deck name).
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
    reviewLog: numArray,
  };
}

/**
 * Scans cards in the canonical deterministic order (createdAt DESC, id ASC)
 * until `limit` are collected or the collection is exhausted. Used for
 * whole-library export (with optional in-memory deck filtering).
 */
async function scanExportCards(limit: number, ownerId?: string): Promise<ExportCard[]> {
  const out: ExportCard[] = [];
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    if (out.length >= limit) break;
    let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
    if (ownerId !== undefined) q = q.where('ownerId', '==', ownerId);
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
  ownerId?: string,
): Promise<ExportCard[]> {
  const seen = new Set<string>();
  const out: ExportCard[] = [];
  const collect = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    for (const doc of docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push(docToExportCard(doc));
      if (out.length >= limit) break;
    }
  };

  // Pass 1: exact deck-path match (uses the composite index
  // (ownerId, deck, createdAt DESC) directly — no __name__ tiebreaker
  // needed because startAfter on a document snapshot is sufficient for
  // stable pagination within the same deck).
  let q1: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
  if (ownerId !== undefined) q1 = q1.where('ownerId', '==', ownerId);
  q1 = q1.where('deck', '==', deck)
    .orderBy('createdAt', 'desc');
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    if (out.length >= limit) break;
    const base: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = lastDoc ? q1.startAfter(lastDoc) : q1;
    const snap = await base.limit(SCAN_PAGE).get();
    if (snap.docs.length === 0) break;
    collect(snap.docs);
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  // Pass 2: leaf-name match (e.g. user passes "Verbs" but stored path is
  // "Spanish::Verbs"). Only needed when the leaf differs from the full path.
  const leaf = deck.split('::').pop()?.trim();
  if (leaf !== undefined && leaf !== deck && out.length < limit) {
    let q2: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = getDb().collection(COLLECTION);
    if (ownerId !== undefined) q2 = q2.where('ownerId', '==', ownerId);
    q2 = q2.where('deck', '==', leaf)
      .orderBy('createdAt', 'desc');
    lastDoc = null;
    for (;;) {
      if (out.length >= limit) break;
      const base: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = lastDoc ? q2.startAfter(lastDoc) : q2;
      const snap = await base.limit(SCAN_PAGE).get();
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
  ownerId?: string,
): Promise<{ selected: ExportCard[]; filtered: number; total: number }> {
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
    const selected: ExportCard[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const doc = await getDb().collection(COLLECTION).doc(id).get();
      // Owner-scoped export never leaks another tenant's card: an id that is
      // missing OR not owned by the caller is omitted (never exported).
      if (!doc.exists || (ownerId !== undefined && doc.data()?.ownerId !== ownerId)) { missing.push(id); continue; }
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
async function imageUrlsForCard(cardId: string): Promise<string[]> {
  try {
    const doc = await getDb().collection(COLLECTION).doc(cardId).get();
    const data = doc.data();
    if (!data || !Array.isArray(data.images)) return [];
    const urls: string[] = [];
    for (const img of data.images as Array<Record<string, unknown>>) {
      const u = typeof img?.downloadUrl === 'string' && img.downloadUrl !== ''
        ? img.downloadUrl
        : (typeof img?.url === 'string' ? img.url : '');
      if (u !== '') urls.push(u);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Fetches and validates embeddable media bytes for the export card set.
 * Sequential (bounded concurrency); each image is fetched with a timeout,
 * size-checked, and capped in aggregate. Never throws — failures are
 * reported per-URL in `skipped`.
 */
async function collectExportMedia(cards: ExportCard[]): Promise<{
  media: ExportedMedia[];
  skipped: Array<{ url: string; reason: string }>;
}> {
  const media: ExportedMedia[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  const MAX_FETCH_MS = 8000;
  for (const card of cards) {
    const urls = await imageUrlsForCard(card.id);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      // SSRF guard: a card's image URL is user-controlled (attachImage
      // stores an arbitrary http(s) URL; uploadImage stores a Firebase
      // Storage signed URL). The fetch is PINNED and redirect-safe:
      // https-only, every DNS answer validated public before the socket
      // connects (the connect lookup hands Node only validated addresses —
      // no check/connect re-resolution race), and redirects are followed
      // manually with each Location re-validated (a 3xx to a private/
      // link-local/metadata/loopback target or to plaintext http is
      // refused). Failures are reported, never fetched.
      if (media.length >= ANKI_MAX_MEDIA_COUNT) {
        skipped.push({ url, reason: `media count cap reached (${ANKI_MAX_MEDIA_COUNT})` });
        continue;
      }
      const fileNameRaw = (() => {
        try {
          const p = new URL(url);
          return (p.pathname.split('/').pop() || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
        } catch {
          return '';
        }
      })();
      const fileName = fileNameRaw === '' ? `image-${media.length}` : fileNameRaw;
      const fetched = await safeMediaFetch(url, {
        maxBytes: ANKI_MAX_MEDIA_BYTES,
        timeoutMs: MAX_FETCH_MS,
        maxRedirects: 3,
      });
      if (!fetched.ok) {
        skipped.push({ url, reason: fetched.reason });
        continue;
      }
      const bytes = fetched.bytes;
      const size = bytes.byteLength;
      if (size === 0) {
        skipped.push({ url, reason: 'empty response' });
        continue;
      }
      if (size > ANKI_MAX_MEDIA_BYTES) {
        skipped.push({ url, reason: `too large (${size} bytes > ${ANKI_MAX_MEDIA_BYTES})` });
        continue;
      }
      if (totalBytes + size > ANKI_MAX_TOTAL_MEDIA_BYTES) {
        skipped.push({ url, reason: 'total media cap reached' });
        continue;
      }
      totalBytes += size;
      media.push({ fileName, data: bytes, sourceUrl: url });
    }
  }
  return { media, skipped };
}

/**
 * Exports flashcards to a base64 .apkg.
 * - `deck` filter: exact stored deck path/name.
 * - `cardIds` filter: explicit bounded list.
 * - no filter: the newest ANKI_EXPORT_CARD_LIMIT cards (older cards are
 *   counted in `filteredCards` — exports never silently truncate).
 */
export async function exportApkg(input: ExportApkgInput, ownerId?: string): Promise<ExportApkgResponse> {
  const { selected, filtered, total } = await selectExportCards(input, ownerId);
  if (selected.length === 0) {
    throw new ApkgExportError('No cards match the export selection');
  }
  const nowMs = Date.now();
  const collection = await buildCollectionBytes(selected, nowMs);
  const { media, skipped } = await collectExportMedia(selected);
  const pkg = await assembleApkgBytes(collection, media);
  const decks = [...new Set(selected.map((c) => c.deckPath ?? null))];
  const schedulingExported = selected.some((c) => c.reps > 0 || c.reviewLog.length > 0);
  void total;
  return {
    package: Buffer.from(pkg).toString('base64'),
    cardCount: selected.length,
    filteredCards: filtered,
    decks,
    media: media.map((m) => ({ fileName: m.fileName, sourceUrl: m.sourceUrl })),
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

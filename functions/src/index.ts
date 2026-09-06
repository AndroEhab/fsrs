import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import {
  verifyRequest, type RequestIdentity,
} from './identity';
import { isProductionRuntime } from './environment';
import {
  createFlashcard, getFlashcard, updateFlashcard, deleteFlashcard, listFlashcards,
  dueFlashcards, reviewFlashcard, verifyApiKey,
  resetFlashcards, setFlashcardDueDate, suspendFlashcards, unsuspendFlashcards,
  bulkCreateFlashcards, bulkUpdateFlashcards, bulkDeleteFlashcards,
  createDeck, getDeck, updateDeck, deleteDeck, listDecks, migrateLegacyDeckNames,
  listTags, renameTag, deleteTag, mergeTags,
  attachImage, listImages, removeImage, uploadImage,
  startReviewSession, getReviewSession, submitSessionReview, endReviewSession,
  searchCards, countFlashcards,
  DeckNotFoundError, DeckNameConflictError, ImageValidationError,
  ReviewSessionNotActiveError, ReviewSessionForbiddenError, ReviewExpectedCardMismatchError,
  ReviewSessionCardNotFoundError, ReviewSessionBuildFailedError, ReviewSessionSelectionTooLargeError,
} from './flashcards/service';
import {
  getReviewHistory, getStudyStats, getTopLapsedCards, migrateLegacyReviewEvents,
} from './flashcards/reviewHistory';
import {
  importApkg, exportApkg, ApkgImportError, ApkgExportError,
} from './flashcards/anki/service';
import {
  safeValidateImportApkg, safeValidateExportApkg,
} from './flashcards/anki/validators';
import {
  safeValidateCreateFlashcard, safeValidateUpdateFlashcard, safeValidateListFlashcardsQuery,
  safeValidateDueFlashcardsQuery, safeValidateReviewFlashcard,
  safeValidateSchedulingActionIds, safeValidateSetFlashcardDueDate,
  safeValidateBulkCreateFlashcards, safeValidateBulkUpdateFlashcards, safeValidateBulkDeleteFlashcards,
  safeValidateCreateDeck, safeValidateUpdateDeck, safeValidateListDecksQuery,
  safeValidateListTagsQuery, safeValidateRenameTag, safeValidateDeleteTag, safeValidateMergeTags,
  safeValidateAttachImage, safeValidateRemoveImage, safeValidateUploadImage,
  safeValidateStartReviewSession, safeValidateSubmitSessionReview,
  safeValidateSearchCardsQuery, safeValidateCountFlashcardsQuery,
  safeValidateReviewHistoryQuery, safeValidateStudyStatsQuery, safeValidateTopLapsedQuery,
} from './flashcards/validators';

initializeApp();

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '3600',
  };
}

function errorResponse(res: any, message: string, status = 400, issues?: unknown): void {
  res.set(corsHeaders());
  res.status(status).json({ error: message, issues });
}

/**
 * Maps service errors to client-visible statuses:
 *  - DeckNotFoundError  -> 404 (a referenced deckId does not exist)
 *  - DeckNameConflictError -> 400 (duplicate deck name)
 *  - ImageValidationError -> 400 (invalid image URL/MIME/count)
 *  - anything else      -> 500
 * Returns true when the response was written (i.e. the error was handled).
 */
function deckErrorResponse(res: any, err: unknown, logPrefix: string): boolean {
  if (err instanceof DeckNotFoundError) {
    errorResponse(res, err.message, 404);
    return true;
  }
  if (err instanceof DeckNameConflictError) {
    errorResponse(res, err.message, 400);
    return true;
  }
  if (err instanceof ImageValidationError) {
    errorResponse(res, err.message, 400);
    return true;
  }
  if (err instanceof ApkgImportError || err instanceof ApkgExportError) {
    errorResponse(res, err.message, 400);
    return true;
  }
  if (err instanceof ReviewSessionNotActiveError) {
    errorResponse(res, err.message, 409);
    return true;
  }
  if (err instanceof ReviewSessionForbiddenError) {
    errorResponse(res, err.message, 403);
    return true;
  }
  if (err instanceof ReviewExpectedCardMismatchError) {
    errorResponse(res, err.message, 409);
    return true;
  }
  if (err instanceof ReviewSessionCardNotFoundError) {
    errorResponse(res, err.message, 404);
    return true;
  }
  if (err instanceof ReviewSessionBuildFailedError) {
    errorResponse(res, err.message, 409);
    return true;
  }
  if (err instanceof ReviewSessionSelectionTooLargeError) {
    errorResponse(res, err.message, 400);
    return true;
  }
  console.error(logPrefix, err);
  errorResponse(res, 'Internal server error', 500);
  return true;
}

/**
 * Authenticates a request and resolves its identity.
 *
 * Multi-tenant gate (fail-closed):
 *  - The shared `X-API-Key` is verified FIRST (the existing transport
 *    credential the MCP bridge/clients present).
 *  - In production-like runtimes a verified Auth0 RS256 Bearer JWT is ALSO
 *    required: the identity (ownerId) comes exclusively from the verified
 *    JWT `sub` — identity headers are never trusted. An API-key-only
 *    production request is rejected (it would otherwise expose unowned data).
 *  - In the emulator, requests stay open but resolve to the fixed
 *    `'emulator'` owner (scoped dev data, never global).
 *
 * Returns `{ identity, apiKeyName, error }`. On error the caller writes a
 * 401 with the error's message. `identity` is null only in the error case;
 * production calls always carry a real ownerId before reaching services.
 */
async function authenticateRequest(req: any): Promise<{
  identity: RequestIdentity | null;
  apiKeyName: string | null;
  error: string | null;
}> {
  const apiKey = req.headers.get?.('X-API-Key') || req.headers['x-api-key'];
  const apiKeyName = apiKey ? await verifyApiKey(apiKey) : null;
  const production = isProductionRuntime();

  if (production && apiKeyName === null) {
    return { identity: null, apiKeyName: null, error: 'Invalid or missing API key' };
  }

  const bearer = req.headers.get?.('authorization') || req.headers['authorization'];
  const { identity, error } = await verifyRequest(bearer);
  if (error) {
    if (!production) {
      // Emulator: keep dev open (fixed emulator identity), never fail.
      return { identity, apiKeyName, error: null };
    }
    // Production: a valid API key alone is NOT enough — the request must
    // present a verified Auth0 JWT. Reject with a clear 401.
    return { identity: null, apiKeyName, error: error.message };
  }
  return { identity, apiKeyName, error: null };
}

/**
 * Auth gate used inside handlers that already handled OPTIONS/method checks:
 * returns the request identity, or writes the 401 and returns null.
 */
async function identityOr401(req: any, res: any): Promise<RequestIdentity | null> {
  const auth = await authenticateRequest(req);
  if (auth.error) {
    errorResponse(res, auth.error, 401);
    return null;
  }
  return auth.identity;
}

function parseBody(req: any): Promise<unknown> {
  return req.rawBody ? Promise.resolve(JSON.parse(req.rawBody.toString())) : Promise.resolve(req.body || {});
}

function getPathId(req: any): string | null {
  const url = new URL(req.url, `https://${req.headers.host}`);
  return url.pathname.split('/').pop() || null;
}

export const health = onRequest({ cors: true }, async (_req, res) => {
  res.set(corsHeaders());
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

export const createFlashcardHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateCreateFlashcard(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const card = await createFlashcard(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.status(201).json(card);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Create flashcard error:')) return;
  }
});

export const getFlashcardHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  try {
    const card = await getFlashcard(id, identity.ownerId);
    if (!card) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.json(card);
  } catch (err) {
    console.error('Get flashcard error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const updateFlashcardHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'PATCH') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateUpdateFlashcard(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const card = await updateFlashcard(id, validation.data, identity.ownerId);
    if (!card) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.json(card);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Update flashcard error:')) return;
  }
});

export const deleteFlashcardHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'DELETE') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  try {
    const deleted = await deleteFlashcard(id, identity.ownerId);
    if (!deleted) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.status(204).send('');
  } catch (err) {
    console.error('Delete flashcard error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const listFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    deck: url.searchParams.get('deck') || undefined,
    tags: url.searchParams.get('tags') || undefined,
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateListFlashcardsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await listFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('List flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const dueFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    deck: url.searchParams.get('deck') || undefined,
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateDueFlashcardsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await dueFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Due flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * GET /countFlashcardsHandler — deck statistics / counts.
 *
 * Returns counts for the flashcards matching the optional filters, WITHOUT
 * fetching any card records (Firestore count() aggregations). Buckets:
 *   total / new / learning / mature / due — see FlashcardCounts in
 *   functions/src/flashcards/types.ts for the exact semantics (new = FSRS
 *   state 0, learning = state 1, mature = states 2+3, due = due <= now).
 *
 * Query params (all optional, combined by AND):
 *   deckId    stable deck id
 *   deck      legacy deck name (deckId wins when both are given, matching
 *             listFlashcards/dueFlashcards)
 *   tags      comma-separated tags (ANY-of)
 *   groupBy   'deck' — additionally break the counts down per deck
 *             (whole-library; cannot be combined with deckId/deck/tags)
 *
 * Response: { counts: { total, new, learning, mature, due },
 *             byDeck?: [{ key, counts }] } — the top-level `counts` covers
 * the whole filtered set; with groupBy=deck each distinct deck present in
 * the set (stable deckId, else `name:<legacy name>`, else `none`) gets its
 * own identical-shape `counts`. Answers "how many cards are in Spanish?".
 */
export const countFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    deckId: url.searchParams.get('deckId') || undefined,
    deck: url.searchParams.get('deck') || undefined,
    tags: url.searchParams.get('tags') || undefined,
    groupBy: url.searchParams.get('groupBy') || undefined,
  };

  const validation = safeValidateCountFlashcardsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await countFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Count flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * GET /searchCardsHandler — the rich flashcard query.
 *
 * Query params (all optional, combined by INTERSECTION / AND across
 * families):
 *   search        free text; matches case-insensitively against topic OR front OR back
 *   tagsAny       comma-separated tags; a card must carry at least one
 *   tagsAll       comma-separated tags; a card must carry every one
 *   tagsNot       comma-separated tags; a card must carry none
 *                 (tagsAny / tagsAll / tagsNot are mutually exclusive)
 *   review        due | notDue | new | reviewed
 *   decks         comma-separated stable deck ids (ANY-of; unions with deckNames)
 *   deckNames     comma-separated legacy deck names (ANY-of)
 *   suspended     true | false (absent = both states)
 *   createdFrom / createdTo / updatedFrom / updatedTo
 *                 inclusive ISO 8601 date-time or YYYY-MM-DD bounds
 *   pageSize      1-100 (default 20)
 *   pageToken     opaque cursor from a previous response (must pair with the
 *                 exact same filters)
 *
 * Response: { cards: Flashcard[], nextPageToken: string | null } — cards
 * ordered createdAt desc (ties by document id ASC — Firestore's native
 * tie-break); nextPageToken resumes after the
 * last card with the SAME filters.
 */
export const searchCardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const parseCsv = (key: string): string[] | undefined => {
    const v = url.searchParams.get(key);
    if (v === null || v === '') return undefined;
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const query = {
    search: url.searchParams.get('search') || undefined,
    tagsAny: parseCsv('tagsAny'),
    tagsAll: parseCsv('tagsAll'),
    tagsNot: parseCsv('tagsNot'),
    review: url.searchParams.get('review') || undefined,
    decks: parseCsv('decks'),
    deckNames: parseCsv('deckNames'),
    // Pass the RAW string to validation: suspendedBoolSchema accepts only
    // boolean/true/false, so garbage like suspended=yes fails with a 400
    // (instead of being silently coerced to false).
    suspended: url.searchParams.get('suspended') || undefined,
    createdFrom: url.searchParams.get('createdFrom') || undefined,
    createdTo: url.searchParams.get('createdTo') || undefined,
    updatedFrom: url.searchParams.get('updatedFrom') || undefined,
    updatedTo: url.searchParams.get('updatedTo') || undefined,
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateSearchCardsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await searchCards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Search flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const reviewFlashcardHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateReviewFlashcard(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await reviewFlashcard(id, validation.data, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    console.error('Review flashcard error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Scheduling management (reset / set-due / suspend / unsuspend)       */
/* ------------------------------------------------------------------ */

/**
 * POST /resetFlashcardsHandler — body { ids: string[] } -> 200
 * { ids, count, cards }.
 * Resets the FSRS scheduling state of the given cards to a brand-new state
 * (New, due immediately, zeroed counters, empty reviewLog). Content, images
 * and suspension are untouched. Atomic: every existing id is reset in one
 * transaction (ids that do not exist are omitted — never an error). Ids must
 * be unique and ≤ SCHEDULING_ACTION_LIMIT (100).
 */
export const resetFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateSchedulingActionIds(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await resetFlashcards(validation.data.ids, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Reset flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /setFlashcardDueDateHandler — body { ids: string[], due: string }
 * -> 200 { ids, count, cards }.
 * Sets the exact next-review time (`due`) of the given cards. Only `due`
 * changes — the FSRS state (state/stability/difficulty/reps/lapses/
 * reviewLog) is preserved. `due` is a full ISO 8601 date-time or a
 * YYYY-MM-DD date (UTC midnight). Atomic: every existing id is updated in
 * one transaction (ids that do not exist are omitted — never an error). Ids
 * must be unique and ≤ SCHEDULING_ACTION_LIMIT (100).
 */
export const setFlashcardDueDateHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateSetFlashcardDueDate(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await setFlashcardDueDate(validation.data.ids, validation.data.due, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Set flashcard due date error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /suspendFlashcardsHandler — body { ids: string[] } -> 200
 * { ids, count, cards }.
 * Suspends the given cards: sets the persisted `suspended: true` flag
 * (content and scheduling state untouched). Suspended cards are selected via
 * search_cards `suspended: true` and never match its review facet; the
 * legacy due/review-session endpoints do not read the flag. Atomic: every
 * existing id is suspended in one transaction (ids that do not exist are
 * omitted — never an error). Ids must be unique and ≤
 * SCHEDULING_ACTION_LIMIT (100).
 */
export const suspendFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateSchedulingActionIds(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await suspendFlashcards(validation.data.ids, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Suspend flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /unsuspendFlashcardsHandler — body { ids: string[] } -> 200
 * { ids, count, cards }.
 * Unsuspends the given cards: removes the persisted `suspended` field (an
 * absent field reads as false everywhere). Content and scheduling state are
 * untouched. Atomic: every existing id is unsuspended in one transaction
 * (ids that do not exist are omitted — never an error). Ids must be unique
 * and ≤ SCHEDULING_ACTION_LIMIT (100).
 */
export const unsuspendFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateSchedulingActionIds(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await unsuspendFlashcards(validation.data.ids, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Unsuspend flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const bulkCreateFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateBulkCreateFlashcards(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await bulkCreateFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Bulk create flashcards error:')) return;
  }
});

export const bulkUpdateFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateBulkUpdateFlashcards(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await bulkUpdateFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Bulk update flashcards error:')) return;
  }
});

export const bulkDeleteFlashcardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateBulkDeleteFlashcards(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await bulkDeleteFlashcards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Bulk delete flashcards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Decks                                                               */
/* ------------------------------------------------------------------ */

export const createDeckHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateCreateDeck(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const deck = await createDeck(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.status(201).json(deck);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Create deck error:')) return;
  }
});

export const getDeckHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing deck ID', 400);
  }

  try {
    const deck = await getDeck(id, identity.ownerId);
    if (!deck) {
      return errorResponse(res, 'Deck not found', 404);
    }
    res.set(corsHeaders());
    res.json(deck);
  } catch (err) {
    console.error('Get deck error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const updateDeckHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'PATCH') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing deck ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateUpdateDeck(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const deck = await updateDeck(id, validation.data, identity.ownerId);
    if (!deck) {
      return errorResponse(res, 'Deck not found', 404);
    }
    res.set(corsHeaders());
    res.json(deck);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Update deck error:')) return;
  }
});

export const deleteDeckHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'DELETE') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing deck ID', 400);
  }

  try {
    const result = await deleteDeck(id, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Deck not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Delete deck error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

export const listDecksHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateListDecksQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await listDecks(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('List decks error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/** POST /migrateDecksHandler — explicit legacy `deck`-name → `deckId`
 * backfill. OPERATOR-ONLY: the verified Auth0 `sub` must be in the
 * documented `AUTH0_OPERATOR_SUBS` allowlist — ordinary users can never run
 * migrations, and there is no caller-supplied actor as authorization. */
export const migrateDecksHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;
  if (!identity.isOperator) {
    return errorResponse(res, 'Forbidden: operator role required', 403);
  }

  try {
    const result = await migrateLegacyDeckNames();
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Migrate decks error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Tag management (list / rename / delete / merge)                     */
/* ------------------------------------------------------------------ */

/**
 * GET /listTagsHandler — body-less; query `pageSize` (1–100, default 20)
 * and `pageToken`. -> 200 { tags: [{ name, cardCount }], nextPageToken }.
 * Lists the DISTINCT tags in the library (exact, case-sensitive names
 * derived from every flashcard's `tags` array — there is no tag
 * collection), each with the number of cards carrying it, sorted by name
 * ascending and paginated with the listDecks convention (`nextPageToken` =
 * the last tag name of the page).
 */
export const listTagsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateListTagsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await listTags(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('List tags error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /renameTagHandler — body { from, to } -> 200 { affectedCards }.
 * Replaces `from` with `to` on every card carrying `from` (exact,
 * case-sensitive), deduplicating when `to` already exists. A `from` that no
 * card carries is a successful no-op (`affectedCards: 0`). `from` and `to`
 * must differ; each is 1–50 characters. Tag names are read from the JSON
 * body (never the URL) so names containing spaces are supported.
 */
export const renameTagHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateRenameTag(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await renameTag(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Rename tag error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /deleteTagHandler — body { name } -> 200 { affectedCards }.
 * Removes `name` from every card carrying it (exact, case-sensitive); the
 * cards themselves are untouched. A name that no card carries is a
 * successful no-op (`affectedCards: 0`). Names are read from the JSON body
 * (never the URL) so names containing spaces are supported.
 */
export const deleteTagHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateDeleteTag(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await deleteTag(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Delete tag error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /mergeTagsHandler — body { from, to } -> 200 { affectedCards }.
 * Merges `from` into `to` with UNION semantics: `from` is removed from
 * every card carrying it and `to` is ensured on each (deduplicated — cards
 * already carrying `to` keep a single copy). A `from` that no card carries
 * is a successful no-op (`affectedCards: 0`). `from` and `to` must differ;
 * each is 1–50 characters. Names are read from the JSON body (never the
 * URL) so names containing spaces are supported.
 */
export const mergeTagsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateMergeTags(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await mergeTags(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Merge tags error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Card images                                                         */
/* ------------------------------------------------------------------ */

/** POST /attachImageHandler/{cardId} — body { url, alt?, mimeType? } -> 201 { card, image }. */
export const attachImageHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const cardId = getPathId(req);
  if (!cardId) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateAttachImage(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await attachImage(cardId, validation.data, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Attach image error:')) return;
  }
});

/** GET /listImagesHandler/{cardId} -> 200 { cardId, images }. */
export const listImagesHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const cardId = getPathId(req);
  if (!cardId) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  try {
    const result = await listImages(cardId, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('List images error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/** DELETE /removeImageHandler/{cardId} — body { url } -> 200 { cardId, removed }. */
export const removeImageHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'DELETE') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const cardId = getPathId(req);
  if (!cardId) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateRemoveImage(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await removeImage(cardId, validation.data.url, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Remove image error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/** POST /uploadImageHandler/{cardId} — body { data, fileName, contentType, alt? } -> 201 { card, image }.
 * Stores the decoded bytes in Firebase Storage (card-scoped path) and persists
 * image metadata (id, storagePath, downloadUrl, contentType, sizeBytes, alt,
 * addedAt) on the card. Limits: <=5 images/card, <=10 MiB decoded, allowed
 * raster MIME types (SVG excluded), sanitized file name, strict base64. */
export const uploadImageHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const cardId = getPathId(req);
  if (!cardId) {
    return errorResponse(res, 'Missing flashcard ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateUploadImage(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await uploadImage(cardId, validation.data, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Flashcard not found', 404);
    }
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Upload image error:')) return;
  }
});

/* ------------------------------------------------------------------ */
/* Review sessions                                                     */
/* ------------------------------------------------------------------ */

/** POST /startReviewSessionHandler — body { deckId? } -> 201 { session, card }.
 * Starts a persistent review session: snapshots every matching card (the
 * standard due queue, or the optional deck/tags/cardIds selectors — never
 * capped, no pagination, ordered by due time ascending) and returns the
 * session plus its first card. NEW sessions use the bounded v2 storage
 * layout (metadata-only root + queueChunks children, 200 positions/chunk);
 * a queue-build failure after the root write returns 409 with the root
 * marked failed (not reviewable — start a fresh session). */
export const startReviewSessionHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateStartReviewSession(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await startReviewSession(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Start review session error:')) return;
  }
});

/** GET /getReviewSessionHandler/{sessionId} -> 200 { session, card }.
 * Retrieves a session (any status) plus the card currently awaiting review
 * (null when the queue is exhausted). */
export const getReviewSessionHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing session ID', 400);
  }

  try {
    const result = await getReviewSession(id, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Review session not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Get review session error:')) return;
  }
});

/** POST /submitSessionReviewHandler/{sessionId} — body { rating, reviewAt? } -> 200 { session, card }.
 * Atomically applies the FSRS scheduling for the session's expected current
 * card and advances the session (counters, currentIndex, status, and for v2
 * the queueChunks claim marker) in one transaction, so retries and concurrent
 * submissions never double-apply a review or lose progress. v2 submissions
 * may claim by `expectedPosition`; a card deleted since the snapshot is
 * skipped (never rated, never an event). A v2 session whose queue build
 * failed returns 409 (not reviewable). */
export const submitSessionReviewHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing session ID', 400);
  }

  const body = await parseBody(req);
  const validation = safeValidateSubmitSessionReview(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await submitSessionReview(id, validation.data, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Review session not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Submit session review error:')) return;
  }
});

/** POST /endReviewSessionHandler/{sessionId} -> 200 { session }.
 * Ends an active session without rating the remaining cards (idempotent). */
export const endReviewSessionHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const id = getPathId(req);
  if (!id) {
    return errorResponse(res, 'Missing session ID', 400);
  }

  try {
    const result = await endReviewSession(id, identity.ownerId);
    if (!result) {
      return errorResponse(res, 'Review session not found', 404);
    }
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'End review session error:')) return;
  }
});

/* ------------------------------------------------------------------ */
/* Review history / study statistics                                   */
/* ------------------------------------------------------------------ */

/**
 * GET /getReviewHistoryHandler — the actor's review-event history.
 *
 * Query params (all optional, combined by AND):
 *   from        inclusive lower bound on reviewedAt (ISO 8601 or YYYY-MM-DD
 *               → UTC midnight of that day)
 *   to          EXCLUSIVE upper bound ([from, to) — a date-only `to`
 *               excludes the whole day it names; pass an ISO instant)
 *   cardId      events of one card
 *   deckId      events recorded while the card was in one deck
 *   ratings     repeated and/or comma-separated 1|2|3|4 — events of ANY of
 *               these ratings (e.g. ?ratings=1,2 or ?ratings=1&ratings=2)
 *   pageSize    1-100 (default 50)
 *   pageToken   opaque cursor from a previous response (must pair with the
 *               exact same filters)
 *
 * Response: { events: ReviewHistoryItem[], nextPageToken: string | null } —
 * events ordered reviewedAt DESC (ties by document id ASC), each event
 * normalized (ISO 8601, whole-millisecond; dueBefore/dueAfter absent when
 * the source event did not record them). SCOPED TO THE CALLER'S API KEY:
 * a key can only read its own reviews. Auth required in production.
 */
export const getReviewHistoryHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  // ratings accepts repeated ?ratings=N params AND/OR a comma-separated
  // ?ratings=1,2 (the bridge convention). Each value must parse as 1..4.
  const rawRatings: number[] = [];
  for (const part of url.searchParams.getAll('ratings')) {
    for (const token of part.split(',')) {
      const trimmed = token.trim();
      if (trimmed === '') continue;
      const n = Number(trimmed);
      if (Number.isInteger(n)) rawRatings.push(n);
    }
  }
  const query = {
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    cardId: url.searchParams.get('cardId') || undefined,
    deckId: url.searchParams.get('deckId') || undefined,
    ratings: rawRatings.length > 0 ? rawRatings : undefined,
    pageSize: url.searchParams.get('pageSize') ? parseInt(url.searchParams.get('pageSize')!, 10) : undefined,
    pageToken: url.searchParams.get('pageToken') || undefined,
  };

  const validation = safeValidateReviewHistoryQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await getReviewHistory(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Get review history error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * GET /getStudyStatsHandler — read-time study statistics (FLAT response).
 *
 * Query params (from/to REQUIRED — the reviewedAt window [from, to), from
 * inclusive, to exclusive): from, to (ISO 8601 or YYYY-MM-DD), deckId
 * (optional; events of one deck), topLimit (optional 1-25, default 10).
 *
 * Response: the FLAT StudyStats object — from / to / totalReviews /
 * ratingCounts{again,hard,good,easy} / ratingPercentages /
 * observedRetention (successful 2/3/4 / total) / matureReviews /
 * matureRatingCounts / matureRetention / topLapsedCards (current all-time
 * by persisted lapses, <= topLimit) — the event aggregates are computed by
 * Firestore count() aggregation over the actor's `reviewEvents` (SCOPED TO
 * THE CALLER'S API KEY; no per-review card fetches, no N+1). The attached
 * topLapsedCards share the getTopLapsedCardsHandler semantics: a CURRENT
 * library/card-state ranking, not actor-attributed.
 */
export const getStudyStatsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    deckId: url.searchParams.get('deckId') || undefined,
    topLimit: url.searchParams.get('topLimit') ? parseInt(url.searchParams.get('topLimit')!, 10) : undefined,
  };

  const validation = safeValidateStudyStatsQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await getStudyStats(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Get study stats error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * GET /getTopLapsedCardsHandler — current all-time top-lapsed ranking.
 *
 * Query params: deckId (restrict to cards currently in one deck), limit
 * (1-25, default 10).
 *
 * Response: { cards: TopLapsedCard[] } — cards ranked by their CURRENT
 * all-time lapse count (the persisted `lapses` field, read at request time;
 * zero-lapse excluded; indexed query, no event scan, NO event-actor field).
 * Each entry: cardId, lapses, reps, front, deckId/deckName, lastReview.
 * Bounded reads (one indexed query + ≤ limit card documents). This is a
 * CURRENT LIBRARY/CARD-STATE ranking — it is NOT attributed by event actor
 * (unlike the history/stats event aggregates); the optional deckId still
 * filters it.
 */
export const getTopLapsedCardsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const query = {
    deckId: url.searchParams.get('deckId') || undefined,
    limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined,
  };

  const validation = safeValidateTopLapsedQuery(query);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await getTopLapsedCards(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Get top-lapsed cards error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/**
 * POST /migrateReviewEventsHandler — explicit legacy reviewLog backfill.
 * Body: { pageSize? (1-100, default 100), resumeAfterCardId? }.
 * OPERATOR-ONLY: the verified Auth0 `sub` must be in the documented
 * `AUTH0_OPERATOR_SUBS` allowlist — ordinary users can never run it and
 * there is NO caller-supplied `legacyActorId`; the operator's verified
 * identity is recorded on migrated events (both `ownerId` and `actorId`).
 * -> 200 { cardsMigrated, eventsWritten, hasMore, nextResumeAfterCardId }.
 * Backfills `reviewEvents` from card-embedded reviewLog entries written
 * before the event model shipped (idempotent: deterministic ids + per-entry
 * existence checks; each migrated event's dueAfter comes from the next log
 * entry, or the card's current due for its newest entry, when available).
 * nextResumeAfterCardId is the id of the last card doc scanned — pass it as
 * resumeAfterCardId on the next call to continue exactly. Maintenance
 * route: repeated calls page through the cards. NEVER call this
 * automatically — it is an explicit, operator-invoked migration.
 */
export const migrateReviewEventsHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;
  if (!identity.isOperator) {
    return errorResponse(res, 'Forbidden: operator role required', 403);
  }

  const body = await parseBody(req) as { pageSize?: unknown; resumeAfterCardId?: unknown };
  let parsedPageSize: number | undefined;
  if (body.pageSize !== undefined) {
    parsedPageSize = typeof body.pageSize === 'number' ? body.pageSize : parseInt(String(body.pageSize), 10);
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      return errorResponse(res, 'Validation failed', 400, [{ path: ['pageSize'], message: 'pageSize must be an integer between 1 and 100' }]);
    }
  }
  const resumeAfterCardId = typeof body?.resumeAfterCardId === 'string' && body.resumeAfterCardId !== '' ? body.resumeAfterCardId : undefined;

  try {
    const result = await migrateLegacyReviewEvents({
      ...(parsedPageSize !== undefined ? { pageSize: parsedPageSize } : {}),
      operatorOwnerId: identity.subject,
      ...(resumeAfterCardId !== undefined ? { resumeAfterCardId } : {}),
    });
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    console.error('Migrate review events error:', err);
    errorResponse(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Anki .apkg import / export                                          */
/* ------------------------------------------------------------------ */

/** POST /importApkgHandler — body { package, deckPath? } -> 201 { cards, skipped*, atomic, batchCount }.
 * Imports a standard Anki .apkg (base64-encoded ZIP containing a SQLite
 * collection.anki2) into the library: note models/cards become flashcards
 * (front/back as plain text, tags, deck found-or-created). Limits: package
 * ≤ 20 MiB decoded, ≤ 1000 cards imported (extra notes reported in
 * skippedOverLimit), every note validated (malformed → 400, never partial
 * writes below the 500-card single-batch ceiling). */
export const importApkgHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateImportApkg(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await importApkg(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.status(201).json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Import .apkg error:')) return;
  }
});

/** POST /exportApkgHandler — body { deck?, cardIds? } -> 200 { package, cardCount, ... }.
 * Exports flashcards into a valid .apkg (base64-encoded ZIP): collection.anki2
 * plus media (embedded from stored image download URLs where fetchable and
 * within caps; skipped otherwise with reasons). Selection: all (newest
 * ANKI_EXPORT_CARD_LIMIT=1000), one deck (exact name/path), or explicit
 * cardIds (≤1000). Scheduling metadata (review state, reps/lapses, revlog
 * from the FSRS reviewLog) is carried where Anki-compatible. */
export const exportApkgHandler = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.set(corsHeaders());
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const identity = await identityOr401(req, res);
  if (!identity) return;

  const body = await parseBody(req);
  const validation = safeValidateExportApkg(body);
  if (!validation.success) {
    return errorResponse(res, 'Validation failed', 400, validation.error.issues);
  }

  try {
    const result = await exportApkg(validation.data, identity.ownerId);
    res.set(corsHeaders());
    res.json(result);
  } catch (err) {
    if (deckErrorResponse(res, err, 'Export .apkg error:')) return;
  }
});

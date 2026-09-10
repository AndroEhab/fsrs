/**
 * Bridge from the MCP server to the deployed Firebase HTTP API.
 *
 * Mirrors the backend contract in functions/src/index.ts and
 * chatgpt/openapi.yaml: each handler is a SEPARATE named Cloud Function
 * (no /api router prefix), card ids are appended to the function URL path,
 * and the `X-API-Key` header carries the production API key. The bridge is
 * transport-agnostic so the same logic serves both HTTP and STDIO transports.
 */

import { z } from 'zod';

/**
 * Base URL the deployed backend runs at.
 * Default: https://us-central1-cuelingua.cloudfunctions.net
 * (set FSRS_API_BASE_URL to the emulator or mock server for local dev).
 */
export const DEFAULT_API_BASE_URL = 'https://us-central1-cuelingua.cloudfunctions.net';

export interface BridgeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Fetch timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /**
   * Request-scoped verified Auth0 Bearer token, forwarded verbatim to the
   * backend as the `Authorization` header on every call this bridge makes.
   * Set per request (see `scoped()`) — NEVER stored globally or shared
   * across requests. When absent (stdio/local emulator or the public
   * /health route) no Authorization header is sent.
   */
  bearerToken?: string;
}

export class FirebaseBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'FirebaseBridgeError';
  }
}

export interface ApiKeyErrorInfo {
  /** True when the backend returned 401 (missing/invalid key). */
  authRequired: boolean;
  /** True when the backend is unreachable (network/DNS/timeout). */
  unreachable: boolean;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  404: 'Not found',
  405: 'Method not allowed',
  500: 'Internal server error',
};

export class FirebaseBridge {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly bearerToken: string;

  constructor(options: BridgeOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.bearerToken = options.bearerToken ?? '';
  }

  /** The API key header value. The key is never printed or logged anywhere. */
  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** True when this (request-scoped) bridge carries a verified Bearer token. */
  get hasBearerToken(): boolean {
    return this.bearerToken.length > 0;
  }

  /**
   * Returns a NEW bridge instance bound to the same API key / base URL /
   * fetch but carrying the given request-scoped Bearer token. Used by the
   * HTTP transport to scope one bridge per incoming /mcp request to the
   * caller's verified token — the token is never stored on the shared
   * config or leaked across requests. Passing an empty token clears it.
   */
  scoped(bearerToken: string): FirebaseBridge {
    return new FirebaseBridge({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      fetchFn: this.fetchFn,
      bearerToken,
    });
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    // The verified incoming Auth0 token is forwarded verbatim as the Bearer
    // credential the backend validates (its `sub` becomes the request
    // owner). Only ever set on a request-scoped bridge instance.
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    return headers;
  }

  private async request<T>(method: string, path: string, opts: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    /** Override the default fetch timeout for this request (ms). */
    timeoutMs?: number;
  } = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const init: RequestInit = {
      method,
      headers: this.headers(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new FirebaseBridgeError('The flashcard service timed out. Try again.', 0, { timeout: true });
      }
      throw new FirebaseBridgeError(
        'The flashcard service is unreachable. Check that the backend is deployed and FSRS_API_BASE_URL is correct.',
        0,
        { unreachable: true },
      );
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const message = typeof data === 'object' && data !== null && 'error' in data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : STATUS_TEXT[res.status] ?? `Request failed with status ${res.status}`;
      throw new FirebaseBridgeError(message, res.status, data);
    }

    return data as T;
  }

  /** GET /health — public, no API key needed. */
  async health(): Promise<{ status: string; timestamp: string }> {
    return this.request<{ status: string; timestamp: string }>('GET', '/health');
  }

  /** POST /createFlashcardHandler */
  async createFlashcard(input: CreateFlashcardInput): Promise<Flashcard> {
    return this.request<Flashcard>('POST', '/createFlashcardHandler', { body: input });
  }

  /** GET /getFlashcardHandler/{id} */
  async getFlashcard(id: string): Promise<Flashcard> {
    return this.request<Flashcard>('GET', `/getFlashcardHandler/${encodeURIComponent(id)}`);
  }

  /** GET /listFlashcardsHandler */
  async listFlashcards(query: ListFlashcardsQuery = {}): Promise<ListFlashcardsResponse> {
    return this.request<ListFlashcardsResponse>('GET', '/listFlashcardsHandler', {
      query: {
        deckId: query.deckId,
        deck: query.deck,
        tags: query.tags,
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

    /** PATCH /updateFlashcardHandler/{id} */
  async updateFlashcard(id: string, input: UpdateFlashcardInput): Promise<Flashcard> {
    return this.request<Flashcard>('PATCH', `/updateFlashcardHandler/${encodeURIComponent(id)}`, { body: input });
  }

  /** DELETE /deleteFlashcardHandler/{id} */
  async deleteFlashcard(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/deleteFlashcardHandler/${encodeURIComponent(id)}`);
  }

  /** GET /dueFlashcardsHandler */
  async getDueFlashcards(query: DueFlashcardsQuery = {}): Promise<DueFlashcardsResponse> {
    return this.request<DueFlashcardsResponse>('GET', '/dueFlashcardsHandler', {
      query: {
        deckId: query.deckId,
        deck: query.deck,
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

  /** GET /searchCardsHandler — rich query. Arrays are comma-joined. */
  async searchCards(query: SearchCardsQuery = {}): Promise<SearchCardsResponse> {
    const join = (xs: string[] | undefined): string | undefined => (xs && xs.length > 0 ? xs.join(',') : undefined);
    return this.request<SearchCardsResponse>('GET', '/searchCardsHandler', {
      query: {
        search: query.search,
        tagsAny: join(query.tagsAny),
        tagsAll: join(query.tagsAll),
        tagsNot: join(query.tagsNot),
        review: query.review,
        decks: join(query.decks),
        deckNames: join(query.deckNames),
        suspended: query.suspended === undefined ? undefined : String(query.suspended),
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        updatedFrom: query.updatedFrom,
        updatedTo: query.updatedTo,
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

  /** GET /countFlashcardsHandler — aggregate counts (no card records fetched). */
  async countFlashcards(query: CountFlashcardsQuery = {}): Promise<CountFlashcardsResponse> {
    return this.request<CountFlashcardsResponse>('GET', '/countFlashcardsHandler', {
      query: {
        deckId: query.deckId,
        deck: query.deck,
        tags: query.tags,
        groupBy: query.groupBy,
      },
    });
  }

  /** POST /reviewFlashcardHandler/{id} */
  async reviewFlashcard(id: string, input: ReviewFlashcardInput): Promise<ReviewFlashcardResponse> {
    return this.request<ReviewFlashcardResponse>('POST', `/reviewFlashcardHandler/${encodeURIComponent(id)}`, { body: input });
  }

  /** POST /resetFlashcardsHandler — body { ids } -> { ids, count, cards }. */
  async resetFlashcards(input: SchedulingActionInput): Promise<SchedulingActionResponse> {
    return this.request<SchedulingActionResponse>('POST', '/resetFlashcardsHandler', { body: input });
  }

  /** POST /setFlashcardDueDateHandler — body { ids, due } -> { ids, count, cards }. */
  async setFlashcardDueDate(input: SetFlashcardDueDateInput): Promise<SchedulingActionResponse> {
    return this.request<SchedulingActionResponse>('POST', '/setFlashcardDueDateHandler', { body: input });
  }

  /** POST /suspendFlashcardsHandler — body { ids } -> { ids, count, cards }. */
  async suspendFlashcards(input: SchedulingActionInput): Promise<SchedulingActionResponse> {
    return this.request<SchedulingActionResponse>('POST', '/suspendFlashcardsHandler', { body: input });
  }

  /** POST /unsuspendFlashcardsHandler — body { ids } -> { ids, count, cards }. */
  async unsuspendFlashcards(input: SchedulingActionInput): Promise<SchedulingActionResponse> {
    return this.request<SchedulingActionResponse>('POST', '/unsuspendFlashcardsHandler', { body: input });
  }

  /** POST /bulkCreateFlashcardsHandler */
  async bulkCreateFlashcards(input: BulkCreateFlashcardsInput): Promise<BulkCreateFlashcardsResponse> {
    return this.request<BulkCreateFlashcardsResponse>('POST', '/bulkCreateFlashcardsHandler', { body: input });
  }

  /** POST /bulkUpdateFlashcardsHandler */
  async bulkUpdateFlashcards(input: BulkUpdateFlashcardsInput): Promise<BulkUpdateFlashcardsResponse> {
    return this.request<BulkUpdateFlashcardsResponse>('POST', '/bulkUpdateFlashcardsHandler', { body: input });
  }

  /** POST /bulkDeleteFlashcardsHandler */
  async bulkDeleteFlashcards(input: BulkDeleteFlashcardsInput): Promise<BulkDeleteFlashcardsResponse> {
    return this.request<BulkDeleteFlashcardsResponse>('POST', '/bulkDeleteFlashcardsHandler', { body: input });
  }

  /* -- Bulk enrollment (resumable, idempotent, server-side chunked) -- */

  /** POST /bulkEnrollCardsHandler — starts or resumes a bulk enrollment. */
  async bulkEnrollCards(input: BulkEnrollCardsInput): Promise<BulkEnrollCardsResponse> {
    return this.request<BulkEnrollCardsResponse>('POST', '/bulkEnrollCardsHandler', { body: input });
  }

  /** GET /enrollmentStatusHandler/{jobId} — enrollment progress poll. */
  async getEnrollmentStatus(jobId: string): Promise<BulkEnrollStatusResponse> {
    return this.request<BulkEnrollStatusResponse>('GET', `/enrollmentStatusHandler/${encodeURIComponent(jobId)}`);
  }

  /** POST /createDeckHandler */
  async createDeck(input: CreateDeckInput): Promise<Deck> {
    return this.request<Deck>('POST', '/createDeckHandler', { body: input });
  }

  /** GET /getDeckHandler/{id} */
  async getDeck(id: string): Promise<Deck> {
    return this.request<Deck>('GET', `/getDeckHandler/${encodeURIComponent(id)}`);
  }

  /** GET /listDecksHandler */
  async listDecks(query: ListDecksQuery = {}): Promise<ListDecksResponse> {
    return this.request<ListDecksResponse>('GET', '/listDecksHandler', {
      query: {
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

  /** PATCH /updateDeckHandler/{id} */
  async updateDeck(id: string, input: UpdateDeckInput): Promise<Deck> {
    return this.request<Deck>('PATCH', `/updateDeckHandler/${encodeURIComponent(id)}`, { body: input });
  }

  /** DELETE /deleteDeckHandler/{id} — returns { deleted, reassignedCards } */
  async deleteDeck(id: string): Promise<DeleteDeckResult> {
    return this.request<DeleteDeckResult>('DELETE', `/deleteDeckHandler/${encodeURIComponent(id)}`);
  }

  /** POST /attachImageHandler/{cardId} */
  async attachImage(cardId: string, input: AttachImageInput): Promise<AttachImageResponse> {
    return this.request<AttachImageResponse>('POST', `/attachImageHandler/${encodeURIComponent(cardId)}`, { body: input });
  }

  /** POST /uploadImageHandler/{cardId} — base64 image upload to Firebase Storage. */
  async uploadImage(cardId: string, input: UploadImageInput): Promise<UploadImageResponse> {
    return this.request<UploadImageResponse>('POST', `/uploadImageHandler/${encodeURIComponent(cardId)}`, { body: input });
  }

  /** GET /listImagesHandler/{cardId} */
  async listImages(cardId: string): Promise<ListImagesResponse> {
    return this.request<ListImagesResponse>('GET', `/listImagesHandler/${encodeURIComponent(cardId)}`);
  }

  /** DELETE /removeImageHandler/{cardId} */
  async removeImage(cardId: string, input: RemoveImageInput): Promise<RemoveImageResponse> {
    return this.request<RemoveImageResponse>('DELETE', `/removeImageHandler/${encodeURIComponent(cardId)}`, { body: input });
  }

  /** POST /startReviewSessionHandler */
  async startReviewSession(input: StartReviewSessionInput): Promise<ReviewSessionWithCard> {
    return this.request<ReviewSessionWithCard>('POST', '/startReviewSessionHandler', { body: input });
  }

  /** GET /getReviewSessionHandler/{sessionId} */
  async getReviewSession(sessionId: string): Promise<ReviewSessionWithCard> {
    return this.request<ReviewSessionWithCard>('GET', `/getReviewSessionHandler/${encodeURIComponent(sessionId)}`);
  }

  /** POST /submitSessionReviewHandler/{sessionId} */
  async submitSessionReview(sessionId: string, input: SubmitSessionReviewInput): Promise<ReviewSessionWithCard> {
    return this.request<ReviewSessionWithCard>('POST', `/submitSessionReviewHandler/${encodeURIComponent(sessionId)}`, { body: input });
  }

  /** POST /endReviewSessionHandler/{sessionId} — returns the session only. */
  async endReviewSession(sessionId: string): Promise<ReviewSession> {
    return this.request<ReviewSession>('POST', `/endReviewSessionHandler/${encodeURIComponent(sessionId)}`);
  }



  /** GET /getReviewHistoryHandler — actor-scoped review history page. */
  async getReviewHistory(query: ReviewHistoryQuery = {}): Promise<ReviewHistoryResponse> {
    return this.request<ReviewHistoryResponse>('GET', '/getReviewHistoryHandler', {
      query: {
        from: query.from,
        to: query.to,
        cardId: query.cardId,
        deckId: query.deckId,
        ...(query.ratings !== undefined && query.ratings.length > 0
          ? { ratings: [...new Set(query.ratings)].sort((a, b) => a - b).join(',') }
          : {}),
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

  /** GET /getStudyStatsHandler — read-time study statistics (flat stats). */
  async getStudyStats(query: StudyStatsQuery): Promise<StudyStatsResponse> {
    return this.request<StudyStatsResponse>('GET', '/getStudyStatsHandler', {
      query: {
        from: query.from,
        to: query.to,
        deckId: query.deckId,
        topLimit: query.topLimit === undefined ? undefined : String(query.topLimit),
      },
    });
  }

  /** GET /getTopLapsedCardsHandler — current all-time top-lapsed ranking. */
  async getTopLapsedCards(query: TopLapsedQuery = {}): Promise<TopLapsedResponse> {
    return this.request<TopLapsedResponse>('GET', '/getTopLapsedCardsHandler', {
      query: {
        deckId: query.deckId,
        limit: query.limit === undefined ? undefined : String(query.limit),
      },
    });
  }

  /** POST /migrateReviewEventsHandler — explicit legacy reviewLog backfill. */
  async migrateReviewEvents(input: MigrateReviewEventsInput): Promise<MigrateReviewEventsResponse> {
    return this.request<MigrateReviewEventsResponse>('POST', '/migrateReviewEventsHandler', { body: input });
  }

  /** GET /listTagsHandler */
  async listTags(query: ListTagsQuery = {}): Promise<ListTagsResponse> {
    return this.request<ListTagsResponse>('GET', '/listTagsHandler', {
      query: {
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize),
        pageToken: query.pageToken,
      },
    });
  }

  /** POST /renameTagHandler — body { from, to } -> { affectedCards }. */
  async renameTag(input: RenameTagInput): Promise<TagActionResult> {
    return this.request<TagActionResult>('POST', '/renameTagHandler', { body: input });
  }

  /** POST /deleteTagHandler — body { name } -> { affectedCards }. */
  async deleteTag(input: DeleteTagInput): Promise<TagActionResult> {
    return this.request<TagActionResult>('POST', '/deleteTagHandler', { body: input });
  }

  /** POST /mergeTagsHandler — body { from, to } -> { affectedCards }. */
  async mergeTags(input: MergeTagsInput): Promise<TagActionResult> {
    return this.request<TagActionResult>('POST', '/mergeTagsHandler', { body: input });
  }

  /** POST /importApkgHandler — body { package, deckPath? } -> 201 summary.
   *  Import involves base64 decode + ZIP inflate + SQLite parse + Firestore
   *  batch writes which can exceed the default 15 s bridge timeout. */
  async importApkg(input: ImportApkgInput): Promise<ImportApkgResponse> {
    return this.request<ImportApkgResponse>('POST', '/importApkgHandler', {
      body: input,
      timeoutMs: 55_000,
    });
  }

  /** POST /exportApkgHandler — body { deck?, cardIds? } -> 200 base64 .apkg.
   *  Export involves Firestore card scan + SQLite collection build + media
   *  fetch + ZIP assembly. 115 s stays under the Cloud Function's 120 s
   *  timeout with headroom. */
  async exportApkg(input: ExportApkgInput): Promise<ExportApkgResponse> {
    return this.request<ExportApkgResponse>('POST', '/exportApkgHandler', {
      body: input,
      timeoutMs: 115_000,
    });
  }

}

/* ------------------------------------------------------------------ */
/* Wire types — mirror the deployed functions contract (chatgpt/openapi.yaml is the historical GPT-Action-era spec; the MCP server has since extended the contract) */
/* ------------------------------------------------------------------ */

export const createFlashcardInputSchema = z.object({
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long'),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long'),
  /** Stable deck reference (decks collection). */
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  /** Legacy deck name (find-or-create). Kept for backward compatibility. */
  deck: z.string().max(100, 'Deck name too long').optional(),
  /** Optional free-form topic label (subject-area grouping). null clears it. */
  topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
  /** Persisted suspended attribute (boolean, default false); filterable via search_cards. */
  suspended: z.boolean().optional(),
  tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
});
export type CreateFlashcardInput = z.infer<typeof createFlashcardInputSchema>;

export const updateFlashcardInputSchema = z.object({
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
  /** Stable deck reference. */
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  /** Legacy deck name. */
  deck: z.string().max(100, 'Deck name too long').optional(),
  /** Optional free-form topic label. null clears it (field removed). */
  topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
  /** Sets/clears the persisted suspended attribute; filterable via search_cards. */
  suspended: z.boolean().optional(),
  tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
});
export type UpdateFlashcardInput = z.infer<typeof updateFlashcardInputSchema>;

/* ------------------------------------------------------------------ */
/* Scheduling-management wire types — mirror functions/src/flashcards/types.ts */
/* ------------------------------------------------------------------ */

/** Mirrors SCHEDULING_ACTION_LIMIT in functions/src/flashcards/types.ts. */
export const SCHEDULING_ACTION_LIMIT = 100;

export const schedulingActionInputSchema = z.object({
  /** Target card ids (unique, 1..SCHEDULING_ACTION_LIMIT). */
  ids: z.array(z.string().min(1, 'Card id is required'))
    .min(1, 'At least one id is required')
    .max(SCHEDULING_ACTION_LIMIT, `No more than ${SCHEDULING_ACTION_LIMIT} ids per request`)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
});
export type SchedulingActionInput = z.infer<typeof schedulingActionInputSchema>;

export const setFlashcardDueDateInputSchema = schedulingActionInputSchema.extend({
  /** The new due time: a full ISO 8601 date-time or a plain YYYY-MM-DD date (UTC midnight). */
  due: z.string().min(1, 'due is required').max(64, 'due too long'),
});
export type SetFlashcardDueDateInput = z.infer<typeof setFlashcardDueDateInputSchema>;

export const listFlashcardsQuerySchema = z.object({
  /** Filter by stable deck id. */
  deckId: z.string().max(100).optional(),
  /** Legacy filter by deck name. */
  deck: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});
export type ListFlashcardsQuery = z.infer<typeof listFlashcardsQuerySchema>;

export const dueFlashcardsQuerySchema = z.object({
  /** Filter by stable deck id. */
  deckId: z.string().max(100).optional(),
  /** Legacy filter by deck name. */
  deck: z.string().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});
export type DueFlashcardsQuery = z.infer<typeof dueFlashcardsQuerySchema>;

export const searchCardsQuerySchema = z.object({
  /** Free-text search: matches case-insensitively against topic OR front OR back. */
  search: z.string().max(500).optional(),
  /** Cards carrying ANY of these tags. Mutually exclusive with tagsAll/tagsNot. */
  tagsAny: z.array(z.string().min(1).max(50)).max(20).optional(),
  /** Cards carrying ALL of these tags. Mutually exclusive with tagsAny/tagsNot. */
  tagsAll: z.array(z.string().min(1).max(50)).max(20).optional(),
  /** Cards carrying NONE of these tags. Mutually exclusive with tagsAny/tagsAll. */
  tagsNot: z.array(z.string().min(1).max(50)).max(20).optional(),
  /** Review-state filter. */
  review: z.enum(['due', 'notDue', 'new', 'reviewed']).optional(),
  /** Stable deck ids, ANY-of (unions with deckNames within the deck family). */
  decks: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** Legacy deck names, ANY-of. */
  deckNames: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** true = suspended only, false = active only; absent = both. */
  suspended: z.boolean().optional(),
  /** Inclusive lower bound on createdAt (ISO 8601 or YYYY-MM-DD). */
  createdFrom: z.string().optional(),
  /** Inclusive upper bound on createdAt. */
  createdTo: z.string().optional(),
  /** Inclusive lower bound on updatedAt. */
  updatedFrom: z.string().optional(),
  /** Inclusive upper bound on updatedAt. */
  updatedTo: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});
export type SearchCardsQuery = z.infer<typeof searchCardsQuerySchema>;

export const searchCardsResponseSchema = z.object({
  cards: z.array(z.unknown()),
  nextPageToken: z.string().nullable(),
});
export type SearchCardsResponse = z.infer<typeof searchCardsResponseSchema>;

/* ------------------------------------------------------------------ */
/* Count wire types — mirror functions/src/flashcards/types.ts         */
/* ------------------------------------------------------------------ */

export const countFlashcardsQuerySchema = z.object({
  /** Restrict to cards of this deck (stable deck id). */
  deckId: z.string().max(100).optional(),
  /** Restrict to cards whose stored deck name equals this (legacy name filter). */
  deck: z.string().max(100).optional(),
  /** Restrict to cards carrying ANY of these comma-separated tags. */
  tags: z.string().max(500).optional(),
  /** When set, break the counts down per deck. */
  groupBy: z.enum(['deck']).optional(),
});
export type CountFlashcardsQuery = z.infer<typeof countFlashcardsQuerySchema>;

export const flashcardCountsSchema = z.object({
  /** Every card matching the filters. */
  total: z.number(),
  /** Never reviewed — FSRS state New (0); derived as total - learning - mature (legacy no-state cards included). */
  new: z.number(),
  /** Short-term learning — FSRS state Learning (1). */
  learning: z.number(),
  /** Past learning — FSRS state Review (2) or Relearning (3). */
  mature: z.number(),
  /** Due for review right now (`due <= now`; new cards are due immediately). */
  due: z.number(),
});
export type FlashcardCounts = z.infer<typeof flashcardCountsSchema>;

export const countByDeckSchema = z.object({
  /** Stable deck id of the deck entity; null = the deck-less remainder. */
  deckId: z.string().nullable(),
  /** Current deck name; null for the deck-less remainder. */
  deck: z.string().nullable(),
  counts: flashcardCountsSchema,
});
export type CountByDeck = z.infer<typeof countByDeckSchema>;

export const countFlashcardsResponseSchema = z.object({
  counts: flashcardCountsSchema,
  byDeck: z.array(countByDeckSchema).optional(),
});
export type CountFlashcardsResponse = z.infer<typeof countFlashcardsResponseSchema>;

export const reviewFlashcardInputSchema = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewAt: z.string().datetime({ offset: true }).optional(),
});
export type ReviewFlashcardInput = z.infer<typeof reviewFlashcardInputSchema>;

export const listFlashcardsResponseSchema = z.object({
  cards: z.array(z.unknown()),
  nextPageToken: z.string().nullable(),
});
export type ListFlashcardsResponse = z.infer<typeof listFlashcardsResponseSchema>;

export const dueFlashcardsResponseSchema = z.object({
  cards: z.array(z.unknown()),
  nextPageToken: z.string().nullable(),
});
export type DueFlashcardsResponse = z.infer<typeof dueFlashcardsResponseSchema>;

export const reviewLogItemSchema = z.object({
  rating: z.number(),
  state: z.number(),
  review: z.unknown(),
  due: z.unknown(),
  stability: z.number(),
  difficulty: z.number(),
  reps: z.number(),
  lapses: z.number(),
});
export type ReviewLogItem = z.infer<typeof reviewLogItemSchema>;

export const cardImageSchema = z.object({
  /** Stable image id (server-assigned). */
  id: z.string(),
  /** The image URL: the external http(s) URL for URL attachments, or the download URL for cloud images. */
  url: z.string(),
  /** Optional short description / alt text. */
  alt: z.string().optional(),
  /** Image MIME type (e.g. image/jpeg). */
  mimeType: z.string().optional(),
  addedAt: z.unknown(),
  /** Firebase Storage object path (cloud images only). */
  storagePath: z.string().optional(),
  /** Signed download URL (cloud images only). */
  downloadUrl: z.string().optional(),
  /** Decoded byte size (cloud images only). */
  sizeBytes: z.number().optional(),
});
export type CardImage = z.infer<typeof cardImageSchema>;

export const flashcardSchema = z.object({
  id: z.string(),
  front: z.string(),
  back: z.string(),
  /** Stable deck reference; absent when the card has no deck. */
  deckId: z.string().optional(),
  /** Denormalized deck name; kept for readable/legacy filtering. */
  deck: z.string().optional(),
  /** Optional topic label (subject-area grouping). */
  topic: z.string().optional(),
  /** Whether the card is suspended (persisted; filterable via search_cards). */
  suspended: z.boolean().optional(),
  tags: z.array(z.string()),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
  due: z.unknown(),
  state: z.number().optional(),
  stability: z.number().optional(),
  difficulty: z.number().optional(),
  reps: z.number().optional(),
  lapses: z.number().optional(),
  lastReview: z.unknown().optional(),
  reviewLog: z.array(reviewLogItemSchema).optional(),
  /** Image attachments (external URL refs and cloud upload metadata; bounded by MAX_CARD_IMAGES=5). */
  images: z.array(cardImageSchema).optional(),
});
export type Flashcard = z.infer<typeof flashcardSchema>;

/** Shared response: the updated cards (existing ids only) in input order. */
export const schedulingActionResponseSchema = z.object({
  ids: z.array(z.string()),
  count: z.number(),
  cards: z.array(flashcardSchema),
});
export type SchedulingActionResponse = z.infer<typeof schedulingActionResponseSchema>;

export const reviewFlashcardResponseSchema = z.object({
  card: flashcardSchema,
  reviewLogItem: reviewLogItemSchema,
});
export type ReviewFlashcardResponse = z.infer<typeof reviewFlashcardResponseSchema>;

/** Maximum items per bulk operation — mirrors BULK_LIMIT in functions/src/flashcards/types.ts. */
export const BULK_LIMIT = 100;

export const bulkCreateFlashcardsInputSchema = z.object({
  cards: z.array(createFlashcardInputSchema)
    .min(1, 'At least one card is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} cards per request`),
});
export type BulkCreateFlashcardsInput = z.infer<typeof bulkCreateFlashcardsInputSchema>;

export const bulkUpdateFlashcardsInputSchema = z.object({
  cards: z.array(z.object({
    id: z.string().min(1, 'Card id is required'),
    front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
    back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
    deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
    deck: z.string().max(100, 'Deck name too long').optional(),
    /** Optional free-form topic label. null clears it (field removed). */
    topic: z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long').nullable().optional(),
    /** Sets/clears the persisted suspended attribute; filterable via search_cards. */
    suspended: z.boolean().optional(),
    tags: z.array(z.string().min(1, 'Tags cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
  })).min(1, 'At least one card is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} cards per request`),
});
export type BulkUpdateFlashcardsInput = z.infer<typeof bulkUpdateFlashcardsInputSchema>;

export const bulkDeleteFlashcardsInputSchema = z.object({
  ids: z.array(z.string().min(1, 'Card id is required'))
    .min(1, 'At least one id is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} ids per request`),
});
export type BulkDeleteFlashcardsInput = z.infer<typeof bulkDeleteFlashcardsInputSchema>;

export const bulkCreateFlashcardsResponseSchema = z.object({
  cards: z.array(flashcardSchema),
});
export type BulkCreateFlashcardsResponse = z.infer<typeof bulkCreateFlashcardsResponseSchema>;

export const bulkUpdateFlashcardsResponseSchema = z.object({
  cards: z.array(flashcardSchema),
});
export type BulkUpdateFlashcardsResponse = z.infer<typeof bulkUpdateFlashcardsResponseSchema>;

export const bulkDeleteFlashcardsResponseSchema = z.object({
  deletedIds: z.array(z.string()),
});
export type BulkDeleteFlashcardsResponse = z.infer<typeof bulkDeleteFlashcardsResponseSchema>;

/* ------------------------------------------------------------------ */
/* Bulk enrollment wire types — resumable, idempotent, chunked         */
/* ------------------------------------------------------------------ */

/** Mirrors ENROLLMENT_MAX_CARDS in functions/src/flashcards/types.ts. */
export const ENROLLMENT_MAX_CARDS = 10_000;

export const enrollmentStatusEnum = z.enum(['pending', 'processing', 'completed', 'failed']);
export type EnrollmentStatus = z.infer<typeof enrollmentStatusEnum>;

export const bulkEnrollCardsInputSchema = z.object({
  cards: z.array(createFlashcardInputSchema)
    .min(1, 'At least one card is required')
    .max(ENROLLMENT_MAX_CARDS, `No more than ${ENROLLMENT_MAX_CARDS} cards per enrollment request`),
});
export type BulkEnrollCardsInput = z.infer<typeof bulkEnrollCardsInputSchema>;

export const bulkEnrollCardsResponseSchema = z.object({
  jobId: z.string(),
  status: enrollmentStatusEnum,
  totalCards: z.number(),
  totalChunks: z.number(),
  completedChunks: z.number(),
  createdCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  retriedChunkCount: z.number(),
});
export type BulkEnrollCardsResponse = z.infer<typeof bulkEnrollCardsResponseSchema>;

export const bulkEnrollStatusResponseSchema = z.object({
  jobId: z.string(),
  status: enrollmentStatusEnum,
  totalCards: z.number(),
  totalChunks: z.number(),
  completedChunks: z.number(),
  createdCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  chunkErrors: z.array(z.object({
    chunkIndex: z.number(),
    error: z.string(),
  })).optional(),
});
export type BulkEnrollStatusResponse = z.infer<typeof bulkEnrollStatusResponseSchema>;

/* ------------------------------------------------------------------ */
/* Deck wire types — mirror functions/src/flashcards/types.ts          */
/* ------------------------------------------------------------------ */

export const createDeckInputSchema = z.object({
  name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long'),
  description: z.string().max(500, 'Description too long').optional(),
});
export type CreateDeckInput = z.infer<typeof createDeckInputSchema>;

export const updateDeckInputSchema = z.object({
  name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
  description: z.string().max(500, 'Description too long').optional(),
});
export type UpdateDeckInput = z.infer<typeof updateDeckInputSchema>;

export const listDecksQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});
export type ListDecksQuery = z.infer<typeof listDecksQuerySchema>;

export const deckSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});
export type Deck = z.infer<typeof deckSchema>;

export const listDecksResponseSchema = z.object({
  decks: z.array(deckSchema),
  nextPageToken: z.string().nullable(),
});
export type ListDecksResponse = z.infer<typeof listDecksResponseSchema>;

export const deleteDeckResultSchema = z.object({
  deleted: z.boolean(),
  reassignedCards: z.number(),
});
export type DeleteDeckResult = z.infer<typeof deleteDeckResultSchema>;

/* ------------------------------------------------------------------ */
/* Tag wire types — mirror functions/src/flashcards/types.ts           */
/* ------------------------------------------------------------------ */

/**
 * A single tag name: the SAME 1–50 character bound the create/update/bulk
 * validators enforce on every entry of a card's `tags` array. Matching is
 * exact and case-sensitive everywhere (the backend never normalizes,
 * lowercases, or trims tag names), so the MCP does NOT trim either — a name
 * that differs from the stored one by whitespace is a different (valid) tag
 * name, never a silent rewrite.
 */
export const tagNameSchema = z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long');

export const listTagsQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;

export const tagSummarySchema = z.object({
  /** The exact, case-sensitive tag name as stored on cards. */
  name: z.string(),
  /** Number of cards carrying this tag. */
  cardCount: z.number(),
});
export type TagSummary = z.infer<typeof tagSummarySchema>;

export const listTagsResponseSchema = z.object({
  tags: z.array(tagSummarySchema),
  nextPageToken: z.string().nullable(),
});
export type ListTagsResponse = z.infer<typeof listTagsResponseSchema>;

/** Rename input: replace `from` with `to` on every card carrying `from` (they must differ). */
export const renameTagInputSchema = z.object({
  from: tagNameSchema,
  to: tagNameSchema,
}).refine((data) => data.from !== data.to, {
  message: 'from and to must be different tag names',
  path: ['to'],
});
export type RenameTagInput = z.infer<typeof renameTagInputSchema>;

/** Merge input: union `from` into `to` — remove `from`, ensure `to` (they must differ). */
export const mergeTagsInputSchema = z.object({
  from: tagNameSchema,
  to: tagNameSchema,
}).refine((data) => data.from !== data.to, {
  message: 'from and to must be different tag names',
  path: ['to'],
});
export type MergeTagsInput = z.infer<typeof mergeTagsInputSchema>;

export const deleteTagInputSchema = z.object({
  name: tagNameSchema,
});
export type DeleteTagInput = z.infer<typeof deleteTagInputSchema>;

/** Result of a tag-management mutation (rename/delete/merge): the number of CARD documents whose `tags` array was rewritten. */
export const tagActionResultSchema = z.object({
  affectedCards: z.number(),
});
export type TagActionResult = z.infer<typeof tagActionResultSchema>;

/* ------------------------------------------------------------------ */
/* Image wire types — mirror functions/src/flashcards/types.ts          */
/* ------------------------------------------------------------------ */

/** Mirrors the backend's MAX_CARD_IMAGES bound. */
export const MAX_CARD_IMAGES = 5;

export const attachImageInputSchema = z.object({
  url: z.string().min(1, 'Image URL is required').max(2048, 'Image URL too long'),
  alt: z.string().max(500, 'Alt text too long').optional(),
  mimeType: z.string().max(100, 'MIME type too long').optional(),
});
export type AttachImageInput = z.infer<typeof attachImageInputSchema>;

export const removeImageInputSchema = z.object({
  url: z.string().min(1, 'Image URL is required').max(2048, 'Image URL too long'),
});
export type RemoveImageInput = z.infer<typeof removeImageInputSchema>;

export const attachImageResponseSchema = z.object({
  card: flashcardSchema,
  image: cardImageSchema,
});
export type AttachImageResponse = z.infer<typeof attachImageResponseSchema>;

export const listImagesResponseSchema = z.object({
  cardId: z.string(),
  images: z.array(cardImageSchema),
});
export type ListImagesResponse = z.infer<typeof listImagesResponseSchema>;

export const removeImageResponseSchema = z.object({
  cardId: z.string(),
  removed: z.boolean(),
});
export type RemoveImageResponse = z.infer<typeof removeImageResponseSchema>;

/** Mirrors the backend upload limits. */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DATA_LENGTH = Math.ceil(MAX_IMAGE_UPLOAD_BYTES * 4 / 3) + 8;
export const MAX_IMAGE_FILE_NAME_LENGTH = 255;

export const uploadImageInputSchema = z.object({
  /** Base64-encoded image data (decoded size <= 10 MiB). */
  data: z.string().min(1, 'Image data is required').max(MAX_IMAGE_DATA_LENGTH, 'Image data too large'),
  /** Original file name (extension drives nothing; the backend appends a canonical one from contentType). */
  fileName: z.string().min(1, 'fileName is required').max(MAX_IMAGE_FILE_NAME_LENGTH, 'fileName too long'),
  /** Image MIME type (allowed raster types: jpeg/png/gif/webp/avif/bmp; SVG is not accepted for upload). */
  contentType: z.string().min(1, 'contentType is required').max(100, 'contentType too long'),
  alt: z.string().max(500, 'Alt text too long').optional(),
});
export type UploadImageInput = z.infer<typeof uploadImageInputSchema>;

export const uploadImageResponseSchema = z.object({
  card: flashcardSchema,
  image: cardImageSchema,
});
export type UploadImageResponse = z.infer<typeof uploadImageResponseSchema>;

/* ------------------------------------------------------------------ */
/* Review session wire types — mirror functions/src/flashcards/types.ts */
/* ------------------------------------------------------------------ */

export const startReviewSessionInputSchema = z.object({
  /** Restrict the snapshot to cards of this deck (stable deck id). */
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  /** Legacy deck filter by name (resolved to a stable deck id at start; deckId wins when both are present). */
  deck: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
  /** Restrict the snapshot to cards carrying ANY of these tags (ANY-of). Combined with a deck selector by intersection. */
  tags: z.array(z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long')).min(1).max(20).optional(),
  /** Explicit card-id allowlist (deduped; every id must exist). Combined with deck/tags by intersection. May include non-due cards. */
  cardIds: z.array(z.string().min(1, 'Card id cannot be empty').max(200, 'Card id too long')).min(1).optional(),
  /** Session presentation card type: 'qa' (default) or 'cloze'. Never stored on cards. */
  cardType: z.enum(['qa', 'cloze']).nullable().optional(),
  /** Optional session display name (e.g. the deck name). */
  name: z.string().min(1).max(200).nullable().optional(),
  /** Continue lineage: the previous session id this session continues (bounded). */
  repeatSessionId: z.string().min(1).max(200).nullable().optional(),
}).strict();
export type StartReviewSessionInput = z.infer<typeof startReviewSessionInputSchema>;

export const submitSessionReviewInputSchema = z.object({
  /** FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy. */
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Optional review time (ISO 8601). Defaults to the server's current time. */
  reviewAt: z.string().datetime({ offset: true }).optional(),
  /** Stable idempotency key — a retry with the same key is a no-op (never double-applies). */
  requestId: z.string().min(8).max(128).optional(),
  /** The card id the client believes is current; a mismatch is rejected (409). */
  expectedCardId: z.string().min(1).max(200).optional(),
  /** v2 bounded claim target: the queue POSITION rated (alternative to
   *  expectedCardId for clients that do not hold full card ids). */
  expectedPosition: z.number().int().min(0).optional(),
});
export type SubmitSessionReviewInput = z.infer<typeof submitSessionReviewInputSchema>;

export const sessionRatingCountsSchema = z.object({
  again: z.number(),
  hard: z.number(),
  good: z.number(),
  easy: z.number(),
  /** The same counters keyed by FSRS rating number (1..4). */
  ratingCounts: z.record(z.number()),
});
export type SessionRatingCounts = z.infer<typeof sessionRatingCountsSchema>;

export const reviewSessionSchema = z.object({
  id: z.string(),
  /** The API key name that started the session. */
  apiKeyName: z.string(),
  /** Lifecycle status: active | completed | ended | failed (build failed / not reviewable). */
  status: z.union([z.literal('active'), z.literal('completed'), z.literal('ended'), z.literal('failed')]),
  /** Session mode; currently always 'spaced_repetition'. */
  mode: z.literal('spaced_repetition'),
  /** Optional deck restriction captured at start. */
  deckId: z.string().optional(),
  /** Optional session display name (e.g. the deck name). */
  name: z.string().optional(),
  /** Persisted provenance of the session's card set ('due' | 'deck' | 'custom') + selector details. */
  source: z.object({
    type: z.union([z.literal('due'), z.literal('deck'), z.literal('custom')]),
    deckId: z.string().optional(),
    deckName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    cardIds: z.array(z.string()).optional(),
  }).optional(),
  /** Session presentation card type ('qa' default | 'cloze'). Never stored on cards. */
  cardType: z.enum(['qa', 'cloze']).optional(),
  /** Idempotency bookkeeping (echo of the last applied requestId). */
  lastRequestId: z.string().optional(),
  lastRatedCardId: z.string().optional(),
  /** Id of the session this session REPEATS (Continue lineage, root-only). */
  repeatSessionId: z.string().optional(),
  /** Storage layout version: 2 = bounded root + queueChunks children; absent/1 = legacy in-root arrays. */
  storageVersion: z.number().optional(),
  /** v2 bounded metadata: total chunk documents. */
  chunkCount: z.number().optional(),
  /** v2: number of fully-consumed leading chunks. */
  completedChunks: z.number().optional(),
  /** v2: fixed child collection name ('queueChunks'). */
  queueChunksPrefix: z.string().optional(),
  /** v2: total queue positions (equals limit; canonical root name totalCount). */
  position: z.number().optional(),
  /** v2 canonical total queue positions (== limit == position). */
  totalCount: z.number().optional(),
  /** v2 canonical chunk ordinal owning currentPosition (the ACTIVE chunk; -1 when empty). */
  currentChunkIndex: z.number().optional(),
  /** v2 canonical queue position of the current (next live) card (== currentIndex). */
  currentPosition: z.number().optional(),
  /** v2 build lifecycle: 'building' (not reviewable), 'ready' (reviewable), 'failed'. */
  buildStatus: z.union([z.literal('building'), z.literal('ready'), z.literal('failed')]).optional(),
  /** v2: exact count of deleted-card skips. */
  deletedCount: z.number().optional(),
  /** v2: exact count of unrated live positions (persisted on the root). */
  remainingQueueCount: z.number().optional(),
  /** v2 build-failure markers (NOT reviewable when set). */
  buildFailed: z.boolean().optional(),
  buildError: z.string().optional(),
  /** Number of cards snapshotted into the session (v1: cardIds.length; v2: total queue positions). */
  limit: z.number(),
  /** Exact number of cards that were due when the session started. */
  dueCount: z.number(),
  /** Snapshot of the session card ids (LEGACY v1/no-version ONLY — v2 roots omit it; the bounded window replaces it). */
  cardIds: z.array(z.string()).optional(),
  /** Index into cardIds (v1) of the card awaiting the next rating (v2: the current queue position). */
  currentIndex: z.number(),
  /** Number of cards successfully rated in this session. */
  reviewedCount: z.number(),
  /** Number of cards still awaiting review (v1 computed; v2 persisted remainingQueueCount). */
  remainingCount: z.number().optional(),
  /**
   * The cards rated in this session (LEGACY v1/no-version ONLY — v2 roots
   * omit it; the queueChunks claims are authoritative).
   */
  reviewedCardIds: z.array(z.string()).optional(),
  /** Every requestId that has already been applied (LEGACY v1/no-version ONLY). */
  processedRequestIds: z.array(z.string()).optional(),
  /** True when the snapshot was capped at start (legacy sessions only — new sessions never cap). */
  truncated: z.boolean(),
  /** True when the snapshot was capped at start (a new session can be started after this one completes). Legacy sessions only. */
  continuationAvailable: z.boolean(),
  /** Ratings applied so far, keyed by name and by rating number. */
  ratingCounts: sessionRatingCountsSchema,
  startedAt: z.unknown(),
  lastReviewedAt: z.unknown().optional(),
  endedAt: z.unknown().optional(),
  /** Persisted REVIEW_TEST_MODE flag captured at start (test sessions never mutate cards). */
  testMode: z.boolean().optional(),
});
export type ReviewSession = z.infer<typeof reviewSessionSchema>;

/** A session plus the card awaiting review (null when the queue is exhausted). */
export const preloadedCardSchema = z.object({
  id: z.string(),
  front: z.string(),
  back: z.string(),
  deck: z.string().optional(),
  tags: z.array(z.string()),
});
export type PreloadedCard = z.infer<typeof preloadedCardSchema>;

export const reviewSessionWithCardSchema = z.object({
  session: reviewSessionSchema,
  card: flashcardSchema.nullable(),
  /** Upcoming cards (after `card`), bounded, from the backend response. */
  preloaded: z.array(preloadedCardSchema),
  /** v2: stable queue position of the current card (null when exhausted). */
  currentPosition: z.number().nullable().optional(),
  /** v2 bounded queue window (current position + preload ids). NEVER the full queue. */
  queueWindow: z.object({
    currentPosition: z.number().nullable(),
    currentCardId: z.string().nullable().optional(),
    cardIds: z.array(z.object({
      cardId: z.string(),
      position: z.number(),
    })),
  }).optional(),
});
export type ReviewSessionWithCard = z.infer<typeof reviewSessionWithCardSchema>;



/* ------------------------------------------------------------------ */
/* Review history / study stats / top-lapsed (analytics surface)       */
/* ------------------------------------------------------------------ */

export const reviewHistoryItemSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  actorId: z.string(),
  rating: z.number(),
  stateBefore: z.number(),
  reviewedAt: z.string(),
  recordedAt: z.string(),
  stabilityAfter: z.number(),
  difficultyAfter: z.number(),
  repsAfter: z.number(),
  lapsesAfter: z.number(),
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  deckId: z.string().optional(),
  deckName: z.string().optional(),
  cardFrontSnapshot: z.string(),
  sessionId: z.string().optional(),
});
export type ReviewHistoryItem = z.infer<typeof reviewHistoryItemSchema>;

export const reviewHistoryResponseSchema = z.object({
  events: z.array(reviewHistoryItemSchema),
  nextPageToken: z.string().nullable(),
});
export type ReviewHistoryResponse = z.infer<typeof reviewHistoryResponseSchema>;

export interface ReviewHistoryQuery {
  from?: string;
  to?: string;
  cardId?: string;
  deckId?: string;
  /** Restrict to events of ANY of these ratings (1=Again..4=Easy). */
  ratings?: number[];
  pageSize?: number;
  pageToken?: string;
}

export const ratingHistogramSchema = z.object({
  again: z.number(),
  hard: z.number(),
  good: z.number(),
  easy: z.number(),
});

export const topLapsedCardSchema = z.object({
  cardId: z.string(),
  lapses: z.number(),
  reps: z.number(),
  front: z.string(),
  deckId: z.string().optional(),
  deckName: z.string().optional(),
  lastReview: z.string().optional(),
});
export type TopLapsedCard = z.infer<typeof topLapsedCardSchema>;

export const studyStatsSchema = z.object({
  from: z.string(),
  to: z.string(),
  totalReviews: z.number(),
  ratingCounts: ratingHistogramSchema,
  ratingPercentages: ratingHistogramSchema,
  observedRetention: z.number().nullable(),
  matureReviews: z.number(),
  matureRatingCounts: ratingHistogramSchema,
  matureRetention: z.number().nullable(),
  topLapsedCards: z.array(topLapsedCardSchema),
});
export type StudyStats = z.infer<typeof studyStatsSchema>;

/** The study stats response IS the flat stats object. */
export const studyStatsResponseSchema = studyStatsSchema;
export type StudyStatsResponse = StudyStats;

export interface StudyStatsQuery {
  from: string;
  to: string;
  deckId?: string;
  topLimit?: number;
}

export const topLapsedResponseSchema = z.object({ cards: z.array(topLapsedCardSchema) });
export type TopLapsedResponse = z.infer<typeof topLapsedResponseSchema>;

export interface TopLapsedQuery {
  deckId?: string;
  limit?: number;
}

export const migrateReviewEventsResponseSchema = z.object({
  cardsMigrated: z.number(),
  eventsWritten: z.number(),
  hasMore: z.boolean(),
  /** Resume cursor: pass as resumeAfterCardId on the next call. Null when nothing was scanned. */
  nextResumeAfterCardId: z.string().nullable(),
});
export type MigrateReviewEventsResponse = z.infer<typeof migrateReviewEventsResponseSchema>;

export interface MigrateReviewEventsInput {
  pageSize?: number;
  legacyActorId: string;
  resumeAfterCardId?: string;
}

/* ------------------------------------------------------------------ */
/* Anki .apkg import/export wire types — mirror the deployed contract  */
/* (functions/src/flashcards/anki/*).                                  */
/* ------------------------------------------------------------------ */

/** Decoded .apkg byte cap (import). Mirrors ANKI_MAX_APKG_BYTES. */
export const ANKI_MAX_APKG_BYTES = 20 * 1024 * 1024;
/** Import package base64 string cap (≈ decoded cap × 4/3 + slack). */
export const ANKI_IMPORT_PACKAGE_MAX = Math.ceil((ANKI_MAX_APKG_BYTES * 4) / 3) + 8;
/** Card cap per import/export (mirrors ANKI_IMPORT_CARD_LIMIT). */
export const ANKI_CARD_LIMIT = 1000;

export const importApkgInputSchema = z.object({
  /** Base64 encoding of the WHOLE .apkg (a ZIP containing collection.anki2). */
  package: z.string().min(1, 'package is required').max(ANKI_IMPORT_PACKAGE_MAX, `package too large (max ${ANKI_MAX_APKG_BYTES} bytes decoded)`),
  /** Optional override deck path (e.g. "Spanish::Verbs") applied to every imported card. */
  deckPath: z.string().min(1, 'deckPath cannot be empty').max(300, 'deckPath too long (max 300 chars)')
    .refine((p) => p.split('::').every((part) => part.trim().length > 0 && part.trim().length <= 100), {
      message: 'deckPath levels must be 1-100 characters (separated by ::)',
    }).optional(),
}).strict();
export type ImportApkgInput = z.infer<typeof importApkgInputSchema>;

export const importApkgCardSchema = z.object({
  front: z.string(),
  back: z.string(),
  deckPath: z.string().nullable(),
  tags: z.array(z.string()),
});
export type ImportApkgCard = z.infer<typeof importApkgCardSchema>;

export const importApkgResponseSchema = z.object({
  cards: z.array(importApkgCardSchema),
  /** Notes skipped because they had other than exactly one card. */
  skippedNotes: z.number(),
  /** Notes skipped because a required field was empty. */
  skippedEmpty: z.number(),
  /** Notes beyond the 1000-card import cap. */
  skippedOverLimit: z.number(),
  /** True when all cards committed in ONE batch (≤500 cards). */
  atomic: z.boolean(),
  /** Firestore write batches used (1 when atomic). */
  batchCount: z.number(),
});
export type ImportApkgResponse = z.infer<typeof importApkgResponseSchema>;

export const exportApkgInputSchema = z.object({
  /** Exact deck name/path to export (e.g. "Spanish" or "Spanish::Verbs"). */
  deck: z.string().min(1, 'deck cannot be empty').max(300, 'deck too long (max 300 chars)').optional(),
  /** Explicit card ids (deduped; missing ids omitted, counted in filteredCards). */
  cardIds: z.array(z.string().min(1, 'card id cannot be empty').max(200, 'card id too long'))
    .min(1, 'At least one card id is required')
    .max(ANKI_CARD_LIMIT, `No more than ${ANKI_CARD_LIMIT} card ids per request`)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' })
    .optional(),
}).strict().refine((data) => data.deck === undefined || data.cardIds === undefined, {
  message: 'deck and cardIds cannot be combined — pick one selection',
  path: ['cardIds'],
});
export type ExportApkgInput = z.infer<typeof exportApkgInputSchema>;

export const exportApkgResponseSchema = z.object({
  /** Base64 encoding of the whole .apkg ZIP (decode and save as *.apkg). */
  package: z.string(),
  /** Cards actually exported. */
  cardCount: z.number(),
  /** Cards excluded by the selection. */
  filteredCards: z.number(),
  /** Decks represented in the package (null = the deck-less "Imported" deck). */
  decks: z.array(z.string().nullable()),
  /** Embedded media (file name in the package + source download URL). */
  media: z.array(z.object({ fileName: z.string(), sourceUrl: z.string() })),
  /** Image URLs that could not be embedded, with reasons. */
  mediaSkipped: z.array(z.object({ url: z.string(), reason: z.string() })),
  /** True when scheduling metadata was carried where Anki-compatible. */
  schedulingExported: z.boolean(),
});
export type ExportApkgResponse = z.infer<typeof exportApkgResponseSchema>;

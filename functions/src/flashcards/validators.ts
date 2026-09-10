import { z } from 'zod';
import { CreateFlashcardInput, UpdateFlashcardInput, ListFlashcardsQuery, DueFlashcardsQuery, SearchCardsQuery, ReviewFlashcardInput, BulkCreateFlashcardsInput, BulkUpdateFlashcardsInput, BulkDeleteFlashcardsInput, BULK_LIMIT, CreateDeckInput, UpdateDeckInput, ListDecksQuery, AttachImageInput, RemoveImageInput, UploadImageInput, MAX_IMAGE_URL_LENGTH, MAX_IMAGE_DATA_LENGTH, MAX_IMAGE_FILE_NAME_LENGTH, StartReviewSessionInput, SubmitSessionReviewInput, CountFlashcardsQuery, SchedulingActionInput, SetFlashcardDueDateInput, SCHEDULING_ACTION_LIMIT, ListTagsQuery, RenameTagInput, DeleteTagInput, MergeTagsInput, MIN_TAG_NAME_LENGTH, MAX_TAG_NAME_LENGTH, ReviewHistoryQuery, StudyStatsQuery, TopLapsedQuery, BulkEnrollCardsInput, ENROLLMENT_MAX_CARDS } from './types';
import { normalizeSearchFilters, searchFiltersKey, readSearchPageToken } from './search';
import { normalizeHistoryFilters, historyFiltersKey, readHistoryPageToken } from './analytics';


const topicSchema = z.string().min(1, 'Topic cannot be empty').max(200, 'Topic too long');
const suspendedSchema = z.boolean();

export const createFlashcardSchema = z.object({
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long'),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long'),
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  deck: z.string().max(100, 'Deck name too long').optional(),
  topic: topicSchema.nullable().optional(),
  suspended: suspendedSchema.optional(),
  tags: z.array(z.string().min(1).max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
}) satisfies z.ZodType<CreateFlashcardInput>;

export const updateFlashcardSchema = z.object({
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  deck: z.string().max(100, 'Deck name too long').optional(),
  topic: topicSchema.nullable().optional(),
  suspended: suspendedSchema.optional(),
  tags: z.array(z.string().min(1).max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
}) satisfies z.ZodType<UpdateFlashcardInput>;


export const listFlashcardsQuerySchema = z.object({
  deckId: z.string().max(100).optional(),
  deck: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  pageToken: z.string().optional(),
}).transform((data) => ({
  ...data,
  pageSize: data.pageSize ?? 20,
})) satisfies z.ZodType<ListFlashcardsQuery>;

export const dueFlashcardsQuerySchema = z.object({
  deckId: z.string().max(100).optional(),
  deck: z.string().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  pageToken: z.string().optional(),
}).transform((data) => ({
  ...data,
  pageSize: data.pageSize ?? 20,
})) satisfies z.ZodType<DueFlashcardsQuery>;

/* ------------------------------------------------------------------ */
/* Card counts (countFlashcards)                                       */
/* ------------------------------------------------------------------ */

export const countFlashcardsQuerySchema = z.object({
  deckId: z.string().max(100).optional(),
  deck: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
  groupBy: z.enum(['deck']).optional(),
}).superRefine((data, ctx) => {
  // groupBy is a whole-library breakdown: combining it with any deck/tag
  // filter would require per-deck aggregates over a filtered set, which is
  // not expressible with count() queries (and would need card reads).
  if (data.groupBy !== undefined && (data.deckId !== undefined || data.deck !== undefined || data.tags !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groupBy'],
      message: 'groupBy is a whole-library breakdown and cannot be combined with deckId/deck/tags filters (counts are aggregate-only: a filtered per-deck breakdown is not expressible without reading cards)',
    });
  }
}) satisfies z.ZodType<CountFlashcardsQuery>;

export function validateCountFlashcardsQuery(data: unknown): CountFlashcardsQuery {
  const result = countFlashcardsQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateCountFlashcardsQuery(data: unknown): { success: true; data: CountFlashcardsQuery } | { success: false; error: ValidationError } {
  const result = countFlashcardsQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Rich card query (searchCards)                                       */
/* ------------------------------------------------------------------ */

/**
 * Accepts a full ISO 8601 date-time or a plain YYYY-MM-DD date.
 * YYYY-MM-DD is validated against the REAL calendar (Date.UTC would silently
 * normalize 2026-02-31 to 2026-03-03, so the components are round-tripped
 * through Date.UTC and compared). Date-only lower bounds mean the UTC
 * midnight of that day; date-only UPPER bounds (createdTo/updatedTo) mean
 * the END of that UTC day (23:59:59.999) — see parseSearchBound.
 */
const searchBoundSchema = z.string()
  .refine((s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      const utc = Date.UTC(y, mo - 1, d);
      const check = new Date(utc);
      return !Number.isNaN(utc)
        && check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
    }
    return !Number.isNaN(Date.parse(s));
  }, 'Expected an ISO 8601 date-time or a valid YYYY-MM-DD date');

const tagListSchema = z.array(z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long')).max(20, 'Too many tags');

/** Accepts a real boolean or the string forms 'true'/'false' (query strings). */
const suspendedBoolSchema = z.union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((v) => v === true || v === 'true');

export const searchCardsQuerySchema = z.object({
  search: z.string().max(500, 'Search too long').optional(),
  tagsAny: tagListSchema.optional(),
  tagsAll: tagListSchema.optional(),
  tagsNot: tagListSchema.optional(),
  review: z.enum(['due', 'notDue', 'new', 'reviewed']).optional(),
  decks: tagListSchema.optional(),
  deckNames: tagListSchema.optional(),
  suspended: suspendedBoolSchema.optional(),
  createdFrom: searchBoundSchema.optional(),
  createdTo: searchBoundSchema.optional(),
  updatedFrom: searchBoundSchema.optional(),
  updatedTo: searchBoundSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  pageToken: z.string().max(2000).optional(),
}).transform((data) => ({
  ...data,
  suspended: data.suspended,
  pageSize: data.pageSize ?? 20,
})) as unknown as z.ZodType<SearchCardsQuery>;


export const reviewFlashcardSchema = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewAt: z.string().datetime({ offset: true }).optional(),
}) satisfies z.ZodType<ReviewFlashcardInput>;

/* ------------------------------------------------------------------ */
/* Scheduling management (reset / set-due / suspend / unsuspend)       */
/* ------------------------------------------------------------------ */

/**
 * Ids of the card documents an explicit scheduling-management call targets.
 * At least one id, at most SCHEDULING_ACTION_LIMIT, and no duplicates — a
 * duplicate id would make the "ids in input order" result ambiguous and is
 * rejected instead of silently deduped.
 */
export const schedulingActionIdsSchema = z.object({
  ids: z.array(z.string().min(1, 'Card id is required'))
    .min(1, 'At least one id is required')
    .max(SCHEDULING_ACTION_LIMIT, `No more than ${SCHEDULING_ACTION_LIMIT} ids per request`)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' }),
}) satisfies z.ZodType<SchedulingActionInput>;

/**
 * Accepts a full ISO 8601 date-time or a plain YYYY-MM-DD date.
 * YYYY-MM-DD is validated against the REAL calendar (Date.UTC would silently
 * normalize 2026-02-31 to 2026-03-03, so the components are round-tripped
 * through Date.UTC and compared). A date-only value means UTC midnight of
 * that day — the same bound semantics as the search_cards date filters.
 */
const dueDateSchema = z.string()
  .refine((s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      const utc = Date.UTC(y, mo - 1, d);
      const check = new Date(utc);
      return !Number.isNaN(utc)
        && check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
    }
    return !Number.isNaN(Date.parse(s));
  }, 'Expected an ISO 8601 date-time or a valid YYYY-MM-DD date');

export const setFlashcardDueDateSchema = schedulingActionIdsSchema.extend({
  due: dueDateSchema,
}) satisfies z.ZodType<SetFlashcardDueDateInput>;

export function validateSchedulingActionIds(data: unknown): SchedulingActionInput {
  const result = schedulingActionIdsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateSetFlashcardDueDate(data: unknown): SetFlashcardDueDateInput {
  const result = setFlashcardDueDateSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateSchedulingActionIds(data: unknown): { success: true; data: SchedulingActionInput } | { success: false; error: ValidationError } {
  const result = schedulingActionIdsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateSetFlashcardDueDate(data: unknown): { success: true; data: SetFlashcardDueDateInput } | { success: false; error: ValidationError } {
  const result = setFlashcardDueDateSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

const createCardSchema = z.object({
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long'),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long'),
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  deck: z.string().max(100, 'Deck name too long').optional(),
  topic: topicSchema.nullable().optional(),
  suspended: suspendedSchema.optional(),
  tags: z.array(z.string().min(1).max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
});

export const bulkCreateFlashcardsSchema = z.object({
  cards: createCardSchema.array()
    .min(1, 'At least one card is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} cards per request`),
}) satisfies z.ZodType<BulkCreateFlashcardsInput>;

const bulkUpdateItemSchema = z.object({
  id: z.string().min(1, 'Card id is required'),
  front: z.string().min(1, 'Front cannot be empty').max(10000, 'Front too long').optional(),
  back: z.string().min(1, 'Back cannot be empty').max(10000, 'Back too long').optional(),
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  deck: z.string().max(100, 'Deck name too long').optional(),
  topic: topicSchema.nullable().optional(),
  suspended: suspendedSchema.optional(),
  tags: z.array(z.string().min(1).max(50, 'Tag too long')).max(20, 'Too many tags').optional(),
});

export const bulkUpdateFlashcardsSchema = z.object({
  cards: bulkUpdateItemSchema.array()
    .min(1, 'At least one card is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} cards per request`),
}) satisfies z.ZodType<BulkUpdateFlashcardsInput>;

export const bulkDeleteFlashcardsSchema = z.object({
  ids: z.array(z.string().min(1, 'Card id is required'))
    .min(1, 'At least one id is required')
    .max(BULK_LIMIT, `No more than ${BULK_LIMIT} ids per request`),
}) satisfies z.ZodType<BulkDeleteFlashcardsInput>;

export function validateCreateFlashcard(data: unknown): CreateFlashcardInput {
  const result = createFlashcardSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateUpdateFlashcard(data: unknown): UpdateFlashcardInput {
  const result = updateFlashcardSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateListFlashcardsQuery(data: unknown): ListFlashcardsQuery {
  const result = listFlashcardsQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateDueFlashcardsQuery(data: unknown): DueFlashcardsQuery {
  const result = dueFlashcardsQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateReviewFlashcard(data: unknown): ReviewFlashcardInput {
  const result = reviewFlashcardSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export class ValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(issues: z.ZodIssue[]) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function safeValidateCreateFlashcard(data: unknown): { success: true; data: CreateFlashcardInput } | { success: false; error: ValidationError } {
  const result = createFlashcardSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateUpdateFlashcard(data: unknown): { success: true; data: UpdateFlashcardInput } | { success: false; error: ValidationError } {
  const result = updateFlashcardSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateListFlashcardsQuery(data: unknown): { success: true; data: ListFlashcardsQuery } | { success: false; error: ValidationError } {
  const result = listFlashcardsQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateDueFlashcardsQuery(data: unknown): { success: true; data: DueFlashcardsQuery } | { success: false; error: ValidationError } {
  const result = dueFlashcardsQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/**
 * Enforces the cross-field rules of the rich card query that zod cannot
 * express declaratively: tag modes are mutually exclusive, and a pageToken
 * must pair with an IDENTICAL filter set (the token's filtersKey must match
 * the normalized filters of this request — mixing filters would silently
 * paginate a different result set).
 */
function validateSearchRules(data: SearchCardsQuery): void {
  const tagModes = (['tagsAny', 'tagsAll', 'tagsNot'] as const).filter((k) => data[k] !== undefined);
  if (tagModes.length > 1) {
    throw new ValidationError([{
      code: 'custom',
      path: ['tagsAny', 'tagsAll', 'tagsNot'],
      message: 'Only one of tagsAny, tagsAll, tagsNot may be given (they are mutually exclusive)',
    }]);
  }
  if (data.pageToken) {
    const payload = readSearchPageToken(data.pageToken);
    if (!payload || payload.lastId.length === 0) {
      throw new ValidationError([{ code: 'custom', path: ['pageToken'], message: 'Invalid pageToken' }]);
    }
    const key = searchFiltersKey(normalizeSearchFilters(data));
    if (payload.filtersKey !== key) {
      throw new ValidationError([{ code: 'custom', path: ['pageToken'], message: 'pageToken does not match the given filters (pass the exact filters of the previous page)' }]);
    }
  }
}
export function validateSearchCardsQuery(data: unknown): SearchCardsQuery {
  const result = searchCardsQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  validateSearchRules(result.data);
  return result.data;
}

export function safeValidateSearchCardsQuery(data: unknown): { success: true; data: SearchCardsQuery } | { success: false; error: ValidationError } {
  const result = searchCardsQuerySchema.safeParse(data);
  if (!result.success) {
    return { success: false, error: new ValidationError(result.error.issues) };
  }
  try {
    validateSearchRules(result.data);
    return { success: true, data: result.data };
  } catch (err) {
    if (err instanceof ValidationError) return { success: false, error: err };
    throw err;
  }
}

export function safeValidateReviewFlashcard(data: unknown): { success: true; data: ReviewFlashcardInput } | { success: false; error: ValidationError } {
  const result = reviewFlashcardSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function validateBulkCreateFlashcards(data: unknown): BulkCreateFlashcardsInput {
  const result = bulkCreateFlashcardsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateBulkUpdateFlashcards(data: unknown): BulkUpdateFlashcardsInput {
  const result = bulkUpdateFlashcardsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateBulkDeleteFlashcards(data: unknown): BulkDeleteFlashcardsInput {
  const result = bulkDeleteFlashcardsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateBulkCreateFlashcards(data: unknown): { success: true; data: BulkCreateFlashcardsInput } | { success: false; error: ValidationError } {
  const result = bulkCreateFlashcardsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateBulkUpdateFlashcards(data: unknown): { success: true; data: BulkUpdateFlashcardsInput } | { success: false; error: ValidationError } {
  const result = bulkUpdateFlashcardsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateBulkDeleteFlashcards(data: unknown): { success: true; data: BulkDeleteFlashcardsInput } | { success: false; error: ValidationError } {
  const result = bulkDeleteFlashcardsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Deck validators                                                     */
/* ------------------------------------------------------------------ */

export const createDeckSchema = z.object({
  name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long'),
  description: z.string().max(500, 'Description too long').optional(),
}) satisfies z.ZodType<CreateDeckInput>;

export const updateDeckSchema = z.object({
  name: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
  description: z.string().max(500, 'Description too long').optional(),
}) satisfies z.ZodType<UpdateDeckInput>;

export const listDecksQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  pageToken: z.string().optional(),
}).transform((data) => ({
  ...data,
  pageSize: data.pageSize ?? 20,
})) satisfies z.ZodType<ListDecksQuery>;

export function validateCreateDeck(data: unknown): CreateDeckInput {
  const result = createDeckSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateUpdateDeck(data: unknown): UpdateDeckInput {
  const result = updateDeckSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateListDecksQuery(data: unknown): ListDecksQuery {
  const result = listDecksQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateCreateDeck(data: unknown): { success: true; data: CreateDeckInput } | { success: false; error: ValidationError } {
  const result = createDeckSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateUpdateDeck(data: unknown): { success: true; data: UpdateDeckInput } | { success: false; error: ValidationError } {
  const result = updateDeckSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateListDecksQuery(data: unknown): { success: true; data: ListDecksQuery } | { success: false; error: ValidationError } {
  const result = listDecksQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Tag-management validators (list / rename / delete / merge)          */
/* ------------------------------------------------------------------ */

/**
 * A single tag name: the SAME 1–50 character bound the create/update/bulk
 * validators enforce on every entry of a card's `tags` array. Matching is
 * exact and case-sensitive everywhere (tags are never normalized,
 * lowercased, or trimmed by the backend), so validation does NOT trim —
 * a name that differs from the stored one by whitespace is a different
 * (valid) tag name, never a silent rewrite.
 */
export const tagNameSchema = z.string()
  .min(MIN_TAG_NAME_LENGTH, 'Tag cannot be empty')
  .max(MAX_TAG_NAME_LENGTH, 'Tag too long');

export const listTagsQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  pageToken: z.string().optional(),
}).transform((data) => ({
  ...data,
  pageSize: data.pageSize ?? 20,
})) satisfies z.ZodType<ListTagsQuery>;

export const renameTagSchema = z.object({
  from: tagNameSchema,
  to: tagNameSchema,
}).refine((data) => data.from !== data.to, {
  message: 'from and to must be different tag names',
  path: ['to'],
}) satisfies z.ZodType<RenameTagInput>;

export const deleteTagSchema = z.object({
  name: tagNameSchema,
}) satisfies z.ZodType<DeleteTagInput>;

export const mergeTagsSchema = z.object({
  from: tagNameSchema,
  to: tagNameSchema,
}).refine((data) => data.from !== data.to, {
  message: 'from and to must be different tag names',
  path: ['to'],
}) satisfies z.ZodType<MergeTagsInput>;

export function validateListTagsQuery(data: unknown): ListTagsQuery {
  const result = listTagsQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateRenameTag(data: unknown): RenameTagInput {
  const result = renameTagSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateDeleteTag(data: unknown): DeleteTagInput {
  const result = deleteTagSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateMergeTags(data: unknown): MergeTagsInput {
  const result = mergeTagsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateListTagsQuery(data: unknown): { success: true; data: ListTagsQuery } | { success: false; error: ValidationError } {
  const result = listTagsQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateRenameTag(data: unknown): { success: true; data: RenameTagInput } | { success: false; error: ValidationError } {
  const result = renameTagSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateDeleteTag(data: unknown): { success: true; data: DeleteTagInput } | { success: false; error: ValidationError } {
  const result = deleteTagSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateMergeTags(data: unknown): { success: true; data: MergeTagsInput } | { success: false; error: ValidationError } {
  const result = mergeTagsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Image validators                                                    */
/* ------------------------------------------------------------------ */

export const attachImageSchema = z.object({
  url: z.string().min(1, 'Image URL is required').max(MAX_IMAGE_URL_LENGTH, 'Image URL too long'),
  alt: z.string().max(500, 'Alt text too long').optional(),
  mimeType: z.string().max(100, 'MIME type too long').optional(),
}) satisfies z.ZodType<AttachImageInput>;

export const removeImageSchema = z.object({
  url: z.string().min(1, 'Image URL is required').max(MAX_IMAGE_URL_LENGTH, 'Image URL too long'),
}) satisfies z.ZodType<RemoveImageInput>;

export function validateAttachImage(data: unknown): AttachImageInput {
  const result = attachImageSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateRemoveImage(data: unknown): RemoveImageInput {
  const result = removeImageSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateAttachImage(data: unknown): { success: true; data: AttachImageInput } | { success: false; error: ValidationError } {
  const result = attachImageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateRemoveImage(data: unknown): { success: true; data: RemoveImageInput } | { success: false; error: ValidationError } {
  const result = removeImageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export const uploadImageSchema = z.object({
  data: z.string().min(1, 'Image data is required').max(MAX_IMAGE_DATA_LENGTH, 'Image data too large'),
  fileName: z.string().min(1, 'fileName is required').max(MAX_IMAGE_FILE_NAME_LENGTH, 'fileName too long'),
  contentType: z.string().min(1, 'contentType is required').max(100, 'contentType too long'),
  alt: z.string().max(500, 'Alt text too long').optional(),
}) satisfies z.ZodType<UploadImageInput>;

export function validateUploadImage(data: unknown): UploadImageInput {
  const result = uploadImageSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateUploadImage(data: unknown): { success: true; data: UploadImageInput } | { success: false; error: ValidationError } {
  const result = uploadImageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
export const startReviewSessionSchema = z.object({
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  deck: z.string().min(1, 'Deck name cannot be empty').max(100, 'Deck name too long').optional(),
  tags: z.array(z.string().min(1, 'Tag cannot be empty').max(50, 'Tag too long')).min(1, 'At least one tag is required').max(20, 'Too many tags').optional(),
  cardIds: z.array(z.string().min(1, 'Card id cannot be empty').max(200, 'Card id too long')).min(1, 'At least one card id is required').optional(),
  cardType: z.enum(['qa', 'cloze']).nullable().optional(),
  name: z.string().min(1, 'Session name cannot be empty').max(200, 'Session name too long').nullable().optional(),
  repeatSessionId: z.string().min(1, 'repeatSessionId cannot be empty').max(200, 'repeatSessionId too long').nullable().optional(),
}).strict() satisfies z.ZodType<StartReviewSessionInput>;

export const submitSessionReviewSchema = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewAt: z.string().datetime({ offset: true }).optional(),
  requestId: z.string().min(8, 'requestId too short').max(128, 'requestId too long').optional(),
  expectedCardId: z.string().min(1, 'expectedCardId cannot be empty').max(200, 'expectedCardId too long').optional(),
  expectedPosition: z.number().int().min(0, 'expectedPosition cannot be negative').optional(),
}) satisfies z.ZodType<SubmitSessionReviewInput>;

export function validateStartReviewSession(data: unknown): StartReviewSessionInput {
  const result = startReviewSessionSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateSubmitSessionReview(data: unknown): SubmitSessionReviewInput {
  const result = submitSessionReviewSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateStartReviewSession(data: unknown): { success: true; data: StartReviewSessionInput } | { success: false; error: ValidationError } {
  const result = startReviewSessionSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateSubmitSessionReview(data: unknown): { success: true; data: SubmitSessionReviewInput } | { success: false; error: ValidationError } {
  const result = submitSessionReviewSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}
/* ------------------------------------------------------------------ */
/* Review history / study stats validators                             */
/* ------------------------------------------------------------------ */

/**
 * Accepts a full ISO 8601 date-time or a plain YYYY-MM-DD date. YYYY-MM-DD
 * is validated against the REAL calendar (see the search bound validator).
 * History semantics: `from` is INCLUSIVE (a date-only from = UTC midnight
 * of that day); `to` is EXCLUSIVE — a date-only `to` EXCLUDES the whole day
 * it names, so clients pass an ISO instant for a precise cut ([from, to)).
 */
const historyBoundSchema = z.string()
  .refine((s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      const utc = Date.UTC(y, mo - 1, d);
      const check = new Date(utc);
      return !Number.isNaN(utc)
        && check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
    }
    return !Number.isNaN(Date.parse(s));
  }, 'Expected an ISO 8601 date-time or a valid YYYY-MM-DD date');

const historyRatingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const reviewHistoryQuerySchema = z.object({
  from: historyBoundSchema.optional(),
  to: historyBoundSchema.optional(),
  cardId: z.string().min(1, 'Card id cannot be empty').max(200, 'Card id too long').optional(),
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  ratings: z.array(historyRatingSchema).min(1, 'At least one rating is required').max(4, 'No more than 4 ratings').optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50).optional(),
  pageToken: z.string().max(2000).optional(),
}).superRefine((data, ctx) => {
  if (data.from !== undefined && data.to !== undefined) {
    const fromMs = Date.parse(data.from);
    const toMs = Date.parse(data.to);
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && fromMs >= toMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to must be strictly after from ([from, to) — the upper bound is exclusive)',
      });
    }
  }
  if (data.pageToken) {
    const payload = readHistoryPageToken(data.pageToken);
    if (!payload || payload.lastId.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pageToken'], message: 'Invalid pageToken' });
    } else {
      const filters = normalizeHistoryFilters(data);
      if (payload.filtersKey !== historyFiltersKey(filters)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pageToken'],
          message: 'pageToken does not match the given filters (pass the exact filters of the previous page)',
        });
      }
    }
  }
}).transform((data) => ({
  ...data,
  pageSize: data.pageSize ?? 50,
})) satisfies z.ZodType<ReviewHistoryQuery>;

export const studyStatsQuerySchema = z.object({
  from: historyBoundSchema,
  to: historyBoundSchema,
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  topLimit: z.coerce.number().int().min(1).max(25).optional(),
}).superRefine((data, ctx) => {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && fromMs >= toMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must be strictly after from ([from, to) — the upper bound is exclusive)',
    });
  }
}) satisfies z.ZodType<StudyStatsQuery>;

export const topLapsedQuerySchema = z.object({
  deckId: z.string().min(1, 'Deck id cannot be empty').max(100, 'Deck id too long').optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10).optional(),
}).transform((data) => ({
  ...data,
  limit: data.limit ?? 10,
})) satisfies z.ZodType<TopLapsedQuery>;

export function safeValidateReviewHistoryQuery(data: unknown): { success: true; data: ReviewHistoryQuery } | { success: false; error: ValidationError } {
  const result = reviewHistoryQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateStudyStatsQuery(data: unknown): { success: true; data: StudyStatsQuery } | { success: false; error: ValidationError } {
  const result = studyStatsQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateTopLapsedQuery(data: unknown): { success: true; data: TopLapsedQuery } | { success: false; error: ValidationError } {
  const result = topLapsedQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Bulk enrollment validators (resumable, idempotent, chunked)         */
/* ------------------------------------------------------------------ */

export const bulkEnrollCardsSchema = z.object({
  cards: createCardSchema.array()
    .min(1, 'At least one card is required')
    .max(ENROLLMENT_MAX_CARDS, `No more than ${ENROLLMENT_MAX_CARDS} cards per request`),
}) satisfies z.ZodType<BulkEnrollCardsInput>;

export const bulkEnrollStatusQuerySchema = z.object({
  jobId: z.string().min(1, 'Job id is required').max(100, 'Job id too long'),
}) satisfies z.ZodType<{ jobId: string }>;

export function validateBulkEnrollCards(data: unknown): BulkEnrollCardsInput {
  const result = bulkEnrollCardsSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function validateBulkEnrollStatusQuery(data: unknown): { jobId: string } {
  const result = bulkEnrollStatusQuerySchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}

export function safeValidateBulkEnrollCards(data: unknown): { success: true; data: BulkEnrollCardsInput } | { success: false; error: ValidationError } {
  const result = bulkEnrollCardsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateBulkEnrollStatusQuery(data: unknown): { success: true; data: { jobId: string } } | { success: false; error: ValidationError } {
  const result = bulkEnrollStatusQuerySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new ValidationError(result.error.issues) };
}

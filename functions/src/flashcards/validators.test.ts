import {
  validateSchedulingActionIds,
  validateSetFlashcardDueDate,
  safeValidateSchedulingActionIds,
  safeValidateSetFlashcardDueDate,
  validateCreateFlashcard,
  validateUpdateFlashcard,
  validateListFlashcardsQuery,
  validateDueFlashcardsQuery,
  validateReviewFlashcard,
  validateBulkCreateFlashcards,
  validateBulkUpdateFlashcards,
  validateBulkDeleteFlashcards,
  validateCreateDeck,
  validateUpdateDeck,
  validateListDecksQuery,
  safeValidateCreateFlashcard,
  safeValidateUpdateFlashcard,
  safeValidateListFlashcardsQuery,
  safeValidateDueFlashcardsQuery,
  safeValidateReviewFlashcard,
  safeValidateBulkCreateFlashcards,
  safeValidateBulkUpdateFlashcards,
  safeValidateBulkDeleteFlashcards,
  safeValidateCreateDeck,
  safeValidateUpdateDeck,
  safeValidateListDecksQuery,
  validateAttachImage,
  validateRemoveImage,
  validateUploadImage,
  safeValidateAttachImage,
  safeValidateRemoveImage,
  safeValidateUploadImage,
  validateStartReviewSession,
  validateSubmitSessionReview,
  safeValidateStartReviewSession,
  safeValidateSubmitSessionReview,
  validateSearchCardsQuery,
  validateCountFlashcardsQuery,
  safeValidateSearchCardsQuery,
  safeValidateCountFlashcardsQuery,
  validateListTagsQuery,
  validateRenameTag,
  validateDeleteTag,
  validateMergeTags,
  safeValidateListTagsQuery,
  safeValidateRenameTag,
  safeValidateDeleteTag,
  safeValidateMergeTags,
  createFlashcardSchema,
  ValidationError
} from './validators';

describe('Validators', () => {
  describe('validateCreateFlashcard', () => {
    it('accepts valid input with all fields', () => {
      const input = {
        front: 'What is 2+2?',
        back: '4',
        deck: 'Math',
        tags: ['arithmetic', 'basic'],
      };
      const result = validateCreateFlashcard(input);
      expect(result).toEqual(input);
    });

    it('accepts valid input with only required fields', () => {
      const input = { front: 'Front', back: 'Back' };
      const result = validateCreateFlashcard(input);
      expect(result).toEqual({ front: 'Front', back: 'Back', deck: undefined, tags: undefined });
    });

    it('rejects empty front', () => {
      expect(() => validateCreateFlashcard({ front: '', back: 'Back' })).toThrow(ValidationError);
    });

    it('rejects empty back', () => {
      expect(() => validateCreateFlashcard({ front: 'Front', back: '' })).toThrow(ValidationError);
    });

    it('rejects front too long', () => {
      expect(() => validateCreateFlashcard({ front: 'a'.repeat(10001), back: 'Back' })).toThrow(ValidationError);
    });

    it('rejects back too long', () => {
      expect(() => validateCreateFlashcard({ front: 'Front', back: 'a'.repeat(10001) })).toThrow(ValidationError);
    });

    it('rejects deck too long', () => {
      expect(() => validateCreateFlashcard({ front: 'F', back: 'B', deck: 'a'.repeat(101) })).toThrow(ValidationError);
    });

    it('rejects too many tags', () => {
      const tags = Array(21).fill('tag');
      expect(() => validateCreateFlashcard({ front: 'F', back: 'B', tags })).toThrow(ValidationError);
    });

    it('rejects tag too long', () => {
      expect(() => validateCreateFlashcard({ front: 'F', back: 'B', tags: ['a'.repeat(51)] })).toThrow(ValidationError);
    });

    it('accepts deckId and nullable deck fields', () => {
      const result = validateCreateFlashcard({ front: 'F', back: 'B', deckId: 'deck-1', deck: null });
      expect(result.deckId).toBe('deck-1');
      expect(result.deck).toBeNull();
    });

    it('accepts deckId null to explicitly mean no deck', () => {
      const result = validateCreateFlashcard({ front: 'F', back: 'B', deckId: null });
      expect(result.deckId).toBeNull();
    });

    it('rejects empty deckId', () => {
      expect(() => validateCreateFlashcard({ front: 'F', back: 'B', deckId: '' })).toThrow(ValidationError);
    });
  });

  describe('validateUpdateFlashcard', () => {
    it('accepts valid partial update', () => {
      const input = { front: 'New front' };
      const result = validateUpdateFlashcard(input);
      expect(result).toEqual(input);
    });

    it('accepts all fields', () => {
      const input = { front: 'F', back: 'B', deck: 'D', tags: ['t1'] };
      const result = validateUpdateFlashcard(input);
      expect(result).toEqual(input);
    });

    it('rejects empty front', () => {
      expect(() => validateUpdateFlashcard({ front: '' })).toThrow(ValidationError);
    });

    it('rejects empty back', () => {
      expect(() => validateUpdateFlashcard({ back: '' })).toThrow(ValidationError);
    });

    it('accepts empty object', () => {
      const result = validateUpdateFlashcard({});
      expect(result).toEqual({});
    });
  });

  describe('validateListFlashcardsQuery', () => {
    it('accepts empty query with defaults', () => {
      const result = validateListFlashcardsQuery({});
      expect(result.pageSize).toBe(20);
    });

    it('accepts valid query', () => {
      const result = validateListFlashcardsQuery({ deck: 'Math', tags: 'tag1,tag2', pageSize: 50, pageToken: 'abc' });
      expect(result).toEqual({ deck: 'Math', tags: 'tag1,tag2', pageSize: 50, pageToken: 'abc' });
    });

    it('rejects pageSize too large', () => {
      expect(() => validateListFlashcardsQuery({ pageSize: 101 })).toThrow(ValidationError);
    });

    it('rejects pageSize zero', () => {
      expect(() => validateListFlashcardsQuery({ pageSize: 0 })).toThrow(ValidationError);
    });

    it('coerces pageSize string to number', () => {
      const result = validateListFlashcardsQuery({ pageSize: '50' });
      expect(result.pageSize).toBe(50);
    });
  });

  describe('validateDueFlashcardsQuery', () => {
    it('accepts empty query with defaults', () => {
      const result = validateDueFlashcardsQuery({});
      expect(result.pageSize).toBe(20);
    });

    it('accepts deck and page params', () => {
      const result = validateDueFlashcardsQuery({ deck: 'spanish-vocab', pageSize: 50, pageToken: 'abc' });
      expect(result).toEqual({ deck: 'spanish-vocab', pageSize: 50, pageToken: 'abc' });
    });

    it('rejects pageSize out of range', () => {
      expect(() => validateDueFlashcardsQuery({ pageSize: 0 })).toThrow(ValidationError);
      expect(() => validateDueFlashcardsQuery({ pageSize: 101 })).toThrow(ValidationError);
    });

    it('coerces pageSize string to number', () => {
      const result = validateDueFlashcardsQuery({ pageSize: '30' });
      expect(result.pageSize).toBe(30);
    });
  });

  describe('validateReviewFlashcard', () => {
    it('accepts rating 1-4', () => {
      for (const rating of [1, 2, 3, 4]) {
        expect(validateReviewFlashcard({ rating }).rating).toBe(rating);
      }
    });

    it('accepts optional reviewAt as ISO datetime', () => {
      const result = validateReviewFlashcard({ rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' });
      expect(result.reviewAt).toBe('2026-08-28T12:00:00.000Z');
    });

    it('rejects rating outside 1-4', () => {
      expect(() => validateReviewFlashcard({ rating: 0 })).toThrow(ValidationError);
      expect(() => validateReviewFlashcard({ rating: 5 })).toThrow(ValidationError);
      expect(() => validateReviewFlashcard({ rating: 'x' })).toThrow(ValidationError);
    });

    it('rejects a malformed reviewAt', () => {
      expect(() => validateReviewFlashcard({ rating: 3, reviewAt: 'not-a-date' })).toThrow(ValidationError);
    });
  });

  describe('safeValidateCreateFlashcard', () => {
    it('returns success for valid input', () => {
      const result = safeValidateCreateFlashcard({ front: 'F', back: 'B' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.front).toBe('F');
      }
    });

    it('returns error for invalid input', () => {
      const result = safeValidateCreateFlashcard({ front: '', back: 'B' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('safeValidateUpdateFlashcard', () => {
    it('returns success for valid input', () => {
      const result = safeValidateUpdateFlashcard({ front: 'F' });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateUpdateFlashcard({ front: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateListFlashcardsQuery', () => {
    it('returns success for valid input', () => {
      const result = safeValidateListFlashcardsQuery({ pageSize: '30' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageSize).toBe(30);
      }
    });

    it('returns error for invalid input', () => {
      const result = safeValidateListFlashcardsQuery({ pageSize: 200 });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateDueFlashcardsQuery', () => {
    it('returns success for valid input', () => {
      const result = safeValidateDueFlashcardsQuery({ pageSize: '30' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageSize).toBe(30);
      }
    });

    it('returns error for invalid input', () => {
      const result = safeValidateDueFlashcardsQuery({ pageSize: 200 });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateReviewFlashcard', () => {
    it('returns success for valid input', () => {
      const result = safeValidateReviewFlashcard({ rating: 4 });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateReviewFlashcard({ rating: 9 });
      expect(result.success).toBe(false);
    });
  });
});

describe('Bulk Validators', () => {
  const BULK_LIMIT = 100;

  describe('validateBulkCreateFlashcards', () => {
    it('accepts valid cards', () => {
      const input = {
        cards: [
          { front: 'F1', back: 'B1', deck: 'Math', tags: ['a'] },
          { front: 'F2', back: 'B2' },
        ],
      };
      const result = validateBulkCreateFlashcards(input);
      expect(result.cards).toHaveLength(2);
      expect(result.cards[0].deck).toBe('Math');
      expect(result.cards[1].tags).toBeUndefined();
    });

    it('rejects empty cards array', () => {
      expect(() => validateBulkCreateFlashcards({ cards: [] })).toThrow(ValidationError);
    });

    it('rejects more than the bulk limit', () => {
      const cards = Array(BULK_LIMIT + 1).fill({ front: 'F', back: 'B' });
      expect(() => validateBulkCreateFlashcards({ cards })).toThrow(ValidationError);
    });

    it('accepts exactly the bulk limit', () => {
      const cards = Array(BULK_LIMIT).fill({ front: 'F', back: 'B' });
      expect(() => validateBulkCreateFlashcards({ cards })).not.toThrow();
    });

    it('rejects a card with invalid fields', () => {
      expect(() => validateBulkCreateFlashcards({ cards: [{ front: '', back: 'B' }] })).toThrow(ValidationError);
      expect(() => validateBulkCreateFlashcards({ cards: [{ front: 'F', back: 'B', tags: [''] }] })).toThrow(ValidationError);
    });
  });

  describe('validateBulkUpdateFlashcards', () => {
    it('accepts valid items with ids and partial patches', () => {
      const input = {
        cards: [
          { id: 'a', front: 'New' },
          { id: 'b', back: 'B2', deck: 'D', tags: ['t'] },
        ],
      };
      const result = validateBulkUpdateFlashcards(input);
      expect(result.cards).toHaveLength(2);
      expect(result.cards[0].id).toBe('a');
      expect(result.cards[1].tags).toEqual(['t']);
    });

    it('rejects missing id', () => {
      expect(() => validateBulkUpdateFlashcards({ cards: [{ front: 'F' }] })).toThrow(ValidationError);
    });

    it('rejects empty cards array and over-limit arrays', () => {
      expect(() => validateBulkUpdateFlashcards({ cards: [] })).toThrow(ValidationError);
      const cards = Array(BULK_LIMIT + 1).fill({ id: 'a' });
      expect(() => validateBulkUpdateFlashcards({ cards })).toThrow(ValidationError);
    });
  });

  describe('validateBulkDeleteFlashcards', () => {
    it('accepts valid ids', () => {
      const result = validateBulkDeleteFlashcards({ ids: ['a', 'b'] });
      expect(result.ids).toEqual(['a', 'b']);
    });

    it('rejects empty ids array', () => {
      expect(() => validateBulkDeleteFlashcards({ ids: [] })).toThrow(ValidationError);
    });

    it('rejects empty id string', () => {
      expect(() => validateBulkDeleteFlashcards({ ids: [''] })).toThrow(ValidationError);
    });

    it('rejects more than the bulk limit', () => {
      const ids = Array(BULK_LIMIT + 1).fill('a');
      expect(() => validateBulkDeleteFlashcards({ ids })).toThrow(ValidationError);
    });
  });

  describe('safeValidateBulkCreateFlashcards', () => {
    it('returns success for valid input', () => {
      const result = safeValidateBulkCreateFlashcards({ cards: [{ front: 'F', back: 'B' }] });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateBulkCreateFlashcards({ cards: [{ front: '', back: 'B' }] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
    });
  });

  describe('safeValidateBulkUpdateFlashcards', () => {
    it('returns success for valid input', () => {
      const result = safeValidateBulkUpdateFlashcards({ cards: [{ id: 'a', front: 'F' }] });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateBulkUpdateFlashcards({ cards: [{ front: 'F' }] });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateBulkDeleteFlashcards', () => {
    it('returns success for valid input', () => {
      const result = safeValidateBulkDeleteFlashcards({ ids: ['a'] });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateBulkDeleteFlashcards({ ids: [] });
      expect(result.success).toBe(false);
    });
  });
});

describe('Deck Validators', () => {
  describe('validateCreateDeck', () => {
    it('accepts valid input with all fields', () => {
      const result = validateCreateDeck({ name: 'Spanish', description: 'Vocab' });
      expect(result).toEqual({ name: 'Spanish', description: 'Vocab' });
    });

    it('accepts name-only input', () => {
      const result = validateCreateDeck({ name: 'Math' });
      expect(result).toEqual({ name: 'Math', description: undefined });
    });

    it('rejects empty name', () => {
      expect(() => validateCreateDeck({ name: '' })).toThrow(ValidationError);
    });

    it('rejects name too long', () => {
      expect(() => validateCreateDeck({ name: 'a'.repeat(101) })).toThrow(ValidationError);
    });

    it('rejects description too long', () => {
      expect(() => validateCreateDeck({ name: 'D', description: 'a'.repeat(501) })).toThrow(ValidationError);
    });
  });

  describe('validateUpdateDeck', () => {
    it('accepts partial update', () => {
      const result = validateUpdateDeck({ name: 'Spanish II' });
      expect(result).toEqual({ name: 'Spanish II' });
    });

    it('accepts empty object', () => {
      expect(() => validateUpdateDeck({})).not.toThrow();
    });

    it('rejects invalid fields when present', () => {
      expect(() => validateUpdateDeck({ name: '' })).toThrow(ValidationError);
    });
  });

  describe('validateListDecksQuery', () => {
    it('accepts empty query with defaults', () => {
      const result = validateListDecksQuery({});
      expect(result.pageSize).toBe(20);
    });

    it('rejects pageSize out of range', () => {
      expect(() => validateListDecksQuery({ pageSize: 0 })).toThrow(ValidationError);
      expect(() => validateListDecksQuery({ pageSize: 101 })).toThrow(ValidationError);
    });
  });

  describe('safeValidateCreateDeck', () => {
    it('returns success for valid input', () => {
      const result = safeValidateCreateDeck({ name: 'D' });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateCreateDeck({ name: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateUpdateDeck', () => {
    it('returns success for valid input', () => {
      const result = safeValidateUpdateDeck({ description: 'x' });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateUpdateDeck({ name: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('safeValidateListDecksQuery', () => {
    it('returns success for valid input', () => {
      const result = safeValidateListDecksQuery({ pageSize: '30' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageSize).toBe(30);
      }
    });

    it('returns error for invalid input', () => {
      const result = safeValidateListDecksQuery({ pageSize: 200 });
      expect(result.success).toBe(false);
    });
  });
});

describe('Image Validators', () => {
  describe('validateAttachImage', () => {
    it('accepts valid input with all fields', () => {
      const result = validateAttachImage({ url: 'https://example.com/pic.jpg', alt: 'A pic', mimeType: 'image/jpeg' });
      expect(result.url).toBe('https://example.com/pic.jpg');
      expect(result.alt).toBe('A pic');
    });

    it('accepts url-only input', () => {
      const result = validateAttachImage({ url: 'https://example.com/pic.png' });
      expect(result).toEqual({ url: 'https://example.com/pic.png', alt: undefined, mimeType: undefined });
    });

    it('rejects empty or missing url', () => {
      expect(() => validateAttachImage({ url: '' })).toThrow(ValidationError);
      expect(() => validateAttachImage({})).toThrow(ValidationError);
    });

    it('rejects url too long', () => {
      expect(() => validateAttachImage({ url: `https://example.com/${'a'.repeat(2100)}` })).toThrow(ValidationError);
    });
  });

  describe('validateRemoveImage', () => {
    it('accepts a valid url', () => {
      const result = validateRemoveImage({ url: 'https://example.com/pic.jpg' });
      expect(result.url).toBe('https://example.com/pic.jpg');
    });

    it('rejects empty url', () => {
      expect(() => validateRemoveImage({ url: '' })).toThrow(ValidationError);
    });
  });

  describe('safeValidateAttachImage', () => {
    it('returns success for valid input', () => {
      const result = safeValidateAttachImage({ url: 'https://example.com/pic.jpg' });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateAttachImage({ url: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
    });
  });

  describe('safeValidateRemoveImage', () => {
    it('returns success for valid input', () => {
      const result = safeValidateRemoveImage({ url: 'https://example.com/pic.jpg' });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateRemoveImage({ url: '' });
      expect(result.success).toBe(false);
    });
  });
});

describe('Upload Image Validators', () => {
  const VALID = { data: Buffer.from('x').toString('base64'), fileName: 'pic.jpg', contentType: 'image/jpeg' };

  describe('validateUploadImage', () => {
    it('accepts valid input', () => {
      const result = validateUploadImage({ ...VALID, alt: 'A pic' });
      expect(result.fileName).toBe('pic.jpg');
      expect(result.alt).toBe('A pic');
    });

    it('rejects missing/empty data', () => {
      expect(() => validateUploadImage({ ...VALID, data: '' })).toThrow(ValidationError);
      expect(() => validateUploadImage({ fileName: 'a.jpg', contentType: 'image/jpeg' })).toThrow(ValidationError);
    });

    it('rejects missing fileName and contentType', () => {
      expect(() => validateUploadImage({ data: 'aGk=', contentType: 'image/jpeg' })).toThrow(ValidationError);
      expect(() => validateUploadImage({ data: 'aGk=', fileName: 'a.jpg' })).toThrow(ValidationError);
    });

    it('rejects data too large', () => {
      expect(() => validateUploadImage({ ...VALID, data: 'a'.repeat(14000001) })).toThrow(ValidationError);
    });
  });

  describe('safeValidateUploadImage', () => {
    it('returns success for valid input', () => {
      const result = safeValidateUploadImage(VALID);
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateUploadImage({ ...VALID, fileName: '' });
      expect(result.success).toBe(false);
    });
  });
});

describe('Review Session Validators', () => {
  describe('validateStartReviewSession', () => {
    it('accepts an empty body with defaults', () => {
      const result = validateStartReviewSession({});
      expect(result).toEqual({});
    });

    it('accepts a deck name filter', () => {
      const result = validateStartReviewSession({ deck: 'Spanish' });
      expect(result).toEqual({ deck: 'Spanish' });
    });

    it('accepts tag selectors (ANY-of semantics preserved)', () => {
      const result = validateStartReviewSession({ tags: ['vocab', 'verbs'] });
      expect(result).toEqual({ tags: ['vocab', 'verbs'] });
    });

    it('accepts an explicit card id allowlist (deduped server-side)', () => {
      const result = validateStartReviewSession({ cardIds: ['c1', 'c2'] });
      expect(result).toEqual({ cardIds: ['c1', 'c2'] });
    });

    it('accepts a mixed deck + tags selection', () => {
      const result = validateStartReviewSession({ deckId: 'deck-1', tags: ['vocab'] });
      expect(result).toEqual({ deckId: 'deck-1', tags: ['vocab'] });
    });

    it('rejects an empty tag array and empty card id allowlist', () => {
      expect(() => validateStartReviewSession({ tags: [] })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ cardIds: [] })).toThrow(ValidationError);
    });

    it('accepts a LARGE card id allowlist (101+ ids — no session cap)', () => {
      // Regression for the removed 100-card session cap: an explicit
      // allowlist of 150 ids is accepted and passed through whole.
      const many = Array.from({ length: 150 }, (_, i) => 'c' + i);
      const result = validateStartReviewSession({ cardIds: many });
      expect(result.cardIds).toEqual(many);
    });

    it('rejects empty/oversized tags and card ids', () => {
      expect(() => validateStartReviewSession({ tags: [''], deck: undefined, deckId: undefined, cardIds: undefined })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ cardIds: [''], tags: undefined, deck: undefined, deckId: undefined })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ tags: ['x'.repeat(51)] })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ cardIds: ['x'.repeat(201)] })).toThrow(ValidationError);
    });

    it('rejects a client-supplied limit (never user-configurable)', () => {
      // The schema never accepts `limit` — the queue size is the snapshot
      // itself (never capped, never client-set).
      expect(() => validateStartReviewSession({ limit: 25 })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ limit: 0 })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ limit: 101 })).toThrow(ValidationError);
    });

    it('rejects empty or oversized deckId', () => {
      expect(() => validateStartReviewSession({ deckId: '' })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ deckId: 'a'.repeat(101) })).toThrow(ValidationError);
    });

    it('accepts a Continue repeatSessionId lineage (bounded string, nullable)', () => {
      const result = validateStartReviewSession({ repeatSessionId: 'session-abc' });
      expect(result).toEqual({ repeatSessionId: 'session-abc' });
      // Null is accepted (the service treats it as absent — no lineage);
      // empty/oversized is rejected.
      expect(validateStartReviewSession({ repeatSessionId: null })).toEqual({ repeatSessionId: null });
      expect(() => validateStartReviewSession({ repeatSessionId: '' })).toThrow(ValidationError);
      expect(() => validateStartReviewSession({ repeatSessionId: 'x'.repeat(201) })).toThrow(ValidationError);
    });
  });

  describe('validateSubmitSessionReview', () => {
    it('accepts rating 1-4', () => {
      for (const rating of [1, 2, 3, 4]) {
        expect(validateSubmitSessionReview({ rating }).rating).toBe(rating);
      }
    });

    it('accepts optional reviewAt as ISO datetime', () => {
      const result = validateSubmitSessionReview({ rating: 3, reviewAt: '2026-08-28T12:00:00.000Z' });
      expect(result.reviewAt).toBe('2026-08-28T12:00:00.000Z');
    });

    it('rejects rating outside 1-4', () => {
      expect(() => validateSubmitSessionReview({ rating: 0 })).toThrow(ValidationError);
      expect(() => validateSubmitSessionReview({ rating: 5 })).toThrow(ValidationError);
      expect(() => validateSubmitSessionReview({ rating: 'x' })).toThrow(ValidationError);
    });

    it('rejects a malformed reviewAt', () => {
      expect(() => validateSubmitSessionReview({ rating: 3, reviewAt: 'not-a-date' })).toThrow(ValidationError);
    });

    it('rejects a missing rating', () => {
      expect(() => validateSubmitSessionReview({})).toThrow(ValidationError);
    });

    it('accepts an expectedPosition (v2 bounded claim target)', () => {
      const result = validateSubmitSessionReview({ rating: 3, expectedPosition: 0 });
      expect(result.expectedPosition).toBe(0);
      const r2 = validateSubmitSessionReview({ rating: 3, expectedPosition: 150, expectedCardId: 'c1' });
      expect(r2.expectedPosition).toBe(150);
      expect(r2.expectedCardId).toBe('c1');
    });

    it('rejects a negative or fractional expectedPosition', () => {
      expect(() => validateSubmitSessionReview({ rating: 3, expectedPosition: -1 })).toThrow(ValidationError);
      expect(() => validateSubmitSessionReview({ rating: 3, expectedPosition: 1.5 })).toThrow(ValidationError);
    });
  });

  describe('safeValidateStartReviewSession', () => {
    it('returns success for valid input', () => {
      const result = safeValidateStartReviewSession({ deckId: 'deck-1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deckId).toBe('deck-1');
      }
    });

    it('returns error for an unknown limit field', () => {
      const result = safeValidateStartReviewSession({ limit: 200 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
    });
  });

  describe('safeValidateSubmitSessionReview', () => {
    it('returns success for valid input', () => {
      const result = safeValidateSubmitSessionReview({ rating: 4 });
      expect(result.success).toBe(true);
    });

    it('returns error for invalid input', () => {
      const result = safeValidateSubmitSessionReview({ rating: 9 });
      expect(result.success).toBe(false);
    });
  });
});

describe('Rich query (searchCards) validators', () => {
  describe('create/update card topic + suspended', () => {
    it('accepts topic and suspended on create and update', () => {
      expect(createFlashcardSchema.safeParse({ front: 'F', back: 'B', topic: 'geo', suspended: true }).success).toBe(true);
      expect(createFlashcardSchema.safeParse({ front: 'F', back: 'B', topic: null, suspended: false }).success).toBe(true);
      expect(createFlashcardSchema.safeParse({ front: 'F', back: 'B', topic: '' }).success).toBe(false);
      expect(createFlashcardSchema.safeParse({ front: 'F', back: 'B', topic: 'x'.repeat(201) }).success).toBe(false);
      expect(createFlashcardSchema.safeParse({ front: 'F', back: 'B', suspended: 'yes' }).success).toBe(false);
    });
  });

  describe('validateSearchCardsQuery', () => {
    it('accepts an empty query', () => {
      const data = validateSearchCardsQuery({});
      expect(data.pageSize).toBe(20);
      expect(data.search).toBeUndefined();
    });

    it('accepts every filter family combined', () => {
      const data = validateSearchCardsQuery({
        search: 'paris',
        tagsAny: ['a'],
        review: 'due',
        decks: ['deck-1'],
        deckNames: ['Geography'],
        suspended: false,
        createdFrom: '2026-08-01',
        createdTo: '2026-08-31',
        updatedFrom: '2026-08-01T00:00:00.000Z',
        updatedTo: '2026-08-31T00:00:00.000Z',
        pageSize: 5,
      });
      expect(data.pageSize).toBe(5);
      expect(data.tagsAny).toEqual(['a']);
    });

    it('coerces the comma-separated arrays and boolean', () => {
      const data = validateSearchCardsQuery({ tagsAll: ['a', 'b'], suspended: 'false' });
      expect(data.tagsAll).toEqual(['a', 'b']);
      expect(data.suspended).toBe(false);
    });

    it('rejects multiple tag modes at once', () => {
      expect(() => validateSearchCardsQuery({ tagsAny: ['a'], tagsAll: ['b'] })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ tagsAny: ['a'], tagsNot: ['b'] })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ tagsAll: ['a'], tagsNot: ['b'] })).toThrow(ValidationError);
    });

    it('rejects an unknown review value and a malformed date bound', () => {
      expect(() => validateSearchCardsQuery({ review: 'someday' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ createdFrom: 'not-a-date' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ pageSize: 0 })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ pageSize: 101 })).toThrow(ValidationError);
    });

    it('rejects invalid calendar dates that Date.UTC would silently normalize', () => {
      expect(() => validateSearchCardsQuery({ createdFrom: '2026-02-31' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ createdTo: '2026-13-01' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ updatedFrom: '2026-04-31' })).toThrow(ValidationError);
      // Valid leap day and month-end pass.
      expect(() => validateSearchCardsQuery({ createdFrom: '2024-02-29' })).not.toThrow();
      expect(() => validateSearchCardsQuery({ createdTo: '2026-08-31' })).not.toThrow();
    });

    it('rejects a suspended value other than true/false', () => {
      expect(() => validateSearchCardsQuery({ suspended: 'garbage' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ suspended: 'yes' })).toThrow(ValidationError);
      expect(() => validateSearchCardsQuery({ suspended: 'true' })).not.toThrow();
      expect(() => validateSearchCardsQuery({ suspended: 'false' })).not.toThrow();
      expect(() => validateSearchCardsQuery({ suspended: true })).not.toThrow();
    });

    it('pageSize defaults to 20', () => {
      expect(validateSearchCardsQuery({}).pageSize).toBe(20);
    });

    it('rejects a pageToken that does not pair with identical filters', () => {
      // Mint a real token for a specific filter set, then change the filters.
      const token = validateSearchCardsQuery({ search: 'paris', pageSize: 1 });
      // Build a token from the search module the same way the service does.
      const { normalizeSearchFilters, makeSearchPageToken } = require('./search');
      const t = makeSearchPageToken(normalizeSearchFilters({ search: 'paris' }), 'card-x', 1234);
      // Same filters + token → valid.
      expect(() => validateSearchCardsQuery({ search: 'paris', pageToken: t })).not.toThrow();
      // Different filters + token → rejected.
      expect(() => validateSearchCardsQuery({ search: 'lyon', pageToken: t })).toThrow(ValidationError);
      // Malformed token → rejected.
      expect(() => validateSearchCardsQuery({ pageToken: 'garbage' })).toThrow(ValidationError);
      // `token` var is unused; keep lint quiet.
      void token;
    });
  });

  describe('safeValidateSearchCardsQuery', () => {
    it('returns success for valid input', () => {
      const result = safeValidateSearchCardsQuery({ search: 'x', tagsNot: ['z'] });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.search).toBe('x');
    });

    it('returns error for mutually exclusive tag modes', () => {
      const result = safeValidateSearchCardsQuery({ tagsAny: ['a'], tagsAll: ['b'] });
      expect(result.success).toBe(false);
    });
  });
});

  describe('validateCountFlashcardsQuery', () => {
    it('accepts an empty query (count everything)', () => {
      const result = validateCountFlashcardsQuery({});
      expect(result).toEqual({});
    });

    it('accepts filters without groupBy', () => {
      const result = validateCountFlashcardsQuery({ deckId: 'deck-1', tags: 'verb,core' });
      expect(result).toEqual({ deckId: 'deck-1', tags: 'verb,core' });
    });

    it('accepts groupBy=deck alone (whole-library breakdown)', () => {
      const result = validateCountFlashcardsQuery({ groupBy: 'deck' });
      expect(result).toEqual({ groupBy: 'deck' });
    });

    it('accepts the legacy deck name filter', () => {
      const result = validateCountFlashcardsQuery({ deck: 'Spanish' });
      expect(result).toEqual({ deck: 'Spanish' });
    });

    it('accepts deckId and deck together (deckId wins — list/due convention)', () => {
      const result = validateCountFlashcardsQuery({ deckId: 'deck-1', deck: 'Spanish' });
      expect(result).toEqual({ deckId: 'deck-1', deck: 'Spanish' });
    });

    it('rejects groupBy combined with any deck/tag filter', () => {
      // groupBy is a whole-library breakdown; a filtered per-deck breakdown
      // is not expressible as count() aggregates without reading cards.
      expect(() => validateCountFlashcardsQuery({ groupBy: 'deck', deckId: 'deck-1' })).toThrow(ValidationError);
      expect(() => validateCountFlashcardsQuery({ groupBy: 'deck', deck: 'Spanish' })).toThrow(ValidationError);
      expect(() => validateCountFlashcardsQuery({ groupBy: 'deck', tags: 'verb' })).toThrow(ValidationError);
    });

    it('rejects an unknown groupBy value', () => {
      expect(() => validateCountFlashcardsQuery({ groupBy: 'tag' })).toThrow(ValidationError);
    });

    it('rejects oversized filters', () => {
      expect(() => validateCountFlashcardsQuery({ deck: 'a'.repeat(101) })).toThrow(ValidationError);
      expect(() => validateCountFlashcardsQuery({ tags: 'a'.repeat(501) })).toThrow(ValidationError);
    });
  });

  describe('safeValidateCountFlashcardsQuery', () => {
    it('returns success for valid input', () => {
      const result = safeValidateCountFlashcardsQuery({ deck: 'Math' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.deck).toBe('Math');
    });

    it('accepts deckId and deck together (deckId wins)', () => {
      const result = safeValidateCountFlashcardsQuery({ deckId: 'd1', deck: 'Math' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual({ deckId: 'd1', deck: 'Math' });
    });

    it('returns error when groupBy is combined with filters', () => {
      const result = safeValidateCountFlashcardsQuery({ groupBy: 'deck', tags: 'verb' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    });
  });


describe('validateSchedulingActionIds', () => {
  it('accepts a list of unique card ids', () => {
    const result = validateSchedulingActionIds({ ids: ['card-1', 'card-2'] });
    expect(result.ids).toEqual(['card-1', 'card-2']);
  });

  it('rejects an empty ids array', () => {
    expect(() => validateSchedulingActionIds({ ids: [] })).toThrow(ValidationError);
  });

  it('rejects duplicate card ids (never silently dedupes)', () => {
    expect(() => validateSchedulingActionIds({ ids: ['card-1', 'card-1'] })).toThrow(ValidationError);
  });

  it('rejects more than SCHEDULING_ACTION_LIMIT (100) ids', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `card-${i}`);
    expect(() => validateSchedulingActionIds({ ids })).toThrow(ValidationError);
  });

  it('accepts exactly SCHEDULING_ACTION_LIMIT (100) ids', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `card-${i}`);
    const result = validateSchedulingActionIds({ ids });
    expect(result.ids).toHaveLength(100);
  });

  it('rejects an empty card id string', () => {
    expect(() => validateSchedulingActionIds({ ids: ['card-1', ''] })).toThrow(ValidationError);
  });

  it('rejects a missing ids field', () => {
    expect(() => validateSchedulingActionIds({})).toThrow(ValidationError);
  });

  it('safeValidateSchedulingActionIds returns success/error discriminately', () => {
    expect(safeValidateSchedulingActionIds({ ids: ['a'] }).success).toBe(true);
    const bad = safeValidateSchedulingActionIds({ ids: [] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toBeInstanceOf(ValidationError);
  });
});

describe('validateSetFlashcardDueDate', () => {
  it('accepts a full ISO 8601 date-time with ids', () => {
    const result = validateSetFlashcardDueDate({ ids: ['card-1'], due: '2026-09-15T08:30:00.000Z' });
    expect(result.ids).toEqual(['card-1']);
    expect(result.due).toBe('2026-09-15T08:30:00.000Z');
  });

  it('accepts a plain YYYY-MM-DD date (UTC midnight)', () => {
    const result = validateSetFlashcardDueDate({ ids: ['card-1'], due: '2026-09-15' });
    expect(result.due).toBe('2026-09-15');
  });

  it('rejects an invalid calendar date', () => {
    expect(() => validateSetFlashcardDueDate({ ids: ['card-1'], due: '2026-02-31' })).toThrow(ValidationError);
  });

  it('rejects a garbage due string', () => {
    expect(() => validateSetFlashcardDueDate({ ids: ['card-1'], due: 'tomorrow' })).toThrow(ValidationError);
  });

  it('rejects duplicate ids alongside a valid due', () => {
    expect(() => validateSetFlashcardDueDate({ ids: ['card-1', 'card-1'], due: '2026-09-15' })).toThrow(ValidationError);
  });

  it('rejects a missing due', () => {
    expect(() => validateSetFlashcardDueDate({ ids: ['card-1'] })).toThrow(ValidationError);
  });

  it('safeValidateSetFlashcardDueDate returns success/error discriminately', () => {
    expect(safeValidateSetFlashcardDueDate({ ids: ['a'], due: '2026-09-15' }).success).toBe(true);
    const bad = safeValidateSetFlashcardDueDate({ ids: ['a'], due: 'nope' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toBeInstanceOf(ValidationError);
  });
});

/* ------------------------------------------------------------------ */
/* Tag-management validators (list / rename / delete / merge)          */
/* ------------------------------------------------------------------ */

describe('Tag Management Validators', () => {
  describe('validateListTagsQuery', () => {
    it('accepts an empty query with the default page size', () => {
      const result = validateListTagsQuery({});
      expect(result.pageSize).toBe(20);
      expect(result.pageToken).toBeUndefined();
    });

    it('accepts pageSize and pageToken', () => {
      const result = validateListTagsQuery({ pageSize: 50, pageToken: 'spanish' });
      expect(result).toEqual({ pageSize: 50, pageToken: 'spanish' });
    });

    it('coerces a string pageSize', () => {
      expect(validateListTagsQuery({ pageSize: '7' }).pageSize).toBe(7);
    });

    it('rejects pageSize out of range', () => {
      expect(() => validateListTagsQuery({ pageSize: 0 })).toThrow(ValidationError);
      expect(() => validateListTagsQuery({ pageSize: 101 })).toThrow(ValidationError);
      expect(() => validateListTagsQuery({ pageSize: 1.5 })).toThrow(ValidationError);
    });
  });

  describe('validateRenameTag', () => {
    it('accepts distinct from/to tags', () => {
      const result = validateRenameTag({ from: 'spanish', to: 'espanol' });
      expect(result).toEqual({ from: 'spanish', to: 'espanol' });
    });

    it('accepts names containing spaces (body-borne names)', () => {
      const result = validateRenameTag({ from: 'spanish verbs', to: 'verbos' });
      expect(result).toEqual({ from: 'spanish verbs', to: 'verbos' });
    });

    it('rejects an empty tag', () => {
      expect(() => validateRenameTag({ from: '', to: 'x' })).toThrow(ValidationError);
      expect(() => validateRenameTag({ from: 'x', to: '' })).toThrow(ValidationError);
    });

    it('rejects a tag longer than 50 characters', () => {
      expect(() => validateRenameTag({ from: 'a'.repeat(51), to: 'x' })).toThrow(ValidationError);
      expect(() => validateRenameTag({ from: 'x', to: 'a'.repeat(51) })).toThrow(ValidationError);
    });

    it('accepts a tag of exactly 50 characters', () => {
      const result = validateRenameTag({ from: 'a'.repeat(50), to: 'b'.repeat(50) });
      expect(result.from).toHaveLength(50);
    });

    it('rejects from === to', () => {
      expect(() => validateRenameTag({ from: 'same', to: 'same' })).toThrow(ValidationError);
    });

    it('is exact and case-sensitive (never trims or normalizes)', () => {
      const result = validateRenameTag({ from: ' Spanish ', to: 'spanish' });
      expect(result).toEqual({ from: ' Spanish ', to: 'spanish' });
    });
  });

  describe('validateDeleteTag', () => {
    it('accepts a valid tag name', () => {
      expect(validateDeleteTag({ name: 'spanish' })).toEqual({ name: 'spanish' });
    });

    it('accepts names containing spaces', () => {
      expect(validateDeleteTag({ name: 'to delete' })).toEqual({ name: 'to delete' });
    });

    it('rejects an empty name', () => {
      expect(() => validateDeleteTag({ name: '' })).toThrow(ValidationError);
    });

    it('rejects a name longer than 50 characters', () => {
      expect(() => validateDeleteTag({ name: 'a'.repeat(51) })).toThrow(ValidationError);
    });
  });

  describe('validateMergeTags', () => {
    it('accepts distinct from/to tags', () => {
      expect(validateMergeTags({ from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' });
    });

    it('rejects from === to', () => {
      expect(() => validateMergeTags({ from: 'same', to: 'same' })).toThrow(ValidationError);
    });

    it('rejects empty or overlong tags', () => {
      expect(() => validateMergeTags({ from: '', to: 'b' })).toThrow(ValidationError);
      expect(() => validateMergeTags({ from: 'a', to: 'b'.repeat(51) })).toThrow(ValidationError);
    });
  });

  describe('safe validators', () => {
    it('safeValidateListTagsQuery returns success/error discriminately', () => {
      expect(safeValidateListTagsQuery({ pageSize: '5' }).success).toBe(true);
      const bad = safeValidateListTagsQuery({ pageSize: 0 });
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error).toBeInstanceOf(ValidationError);
    });

    it('safeValidateRenameTag returns success/error discriminately', () => {
      expect(safeValidateRenameTag({ from: 'a', to: 'b' }).success).toBe(true);
      expect(safeValidateRenameTag({ from: 'same', to: 'same' }).success).toBe(false);
      expect(safeValidateRenameTag({ from: '', to: 'b' }).success).toBe(false);
    });

    it('safeValidateDeleteTag returns success/error discriminately', () => {
      expect(safeValidateDeleteTag({ name: 'x' }).success).toBe(true);
      const bad = safeValidateDeleteTag({ name: '' });
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error).toBeInstanceOf(ValidationError);
    });

    it('safeValidateMergeTags returns success/error discriminately', () => {
      expect(safeValidateMergeTags({ from: 'a', to: 'b' }).success).toBe(true);
      expect(safeValidateMergeTags({ from: 'same', to: 'same' }).success).toBe(false);
    });
  });
});

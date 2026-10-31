import { cardSummary, sessionSummary } from './tools';

describe('consumer summaries', () => {
  it('preserves card metadata and serializes backend timestamps', () => {
    const timestamp = { _seconds: 1_700_000_000, _nanoseconds: 500_000_000 };
    const result = cardSummary({
      id: 'card-1', front: 'Q', back: 'A', deckId: 'deck-1', deck: 'Spanish',
      topic: 'geography', suspended: false, tags: [' literal,tag ', 'vocab'],
      createdAt: timestamp, updatedAt: timestamp, due: timestamp,
      state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0,
      reviewLog: [], images: [],
    } as never);
    expect(result).toMatchObject({
      id: 'card-1', deckId: 'deck-1', topic: 'geography', suspended: false,
      tags: [' literal,tag ', 'vocab'], createdAt: '2023-11-14T22:13:20.500Z',
    });
  });

  it('keeps v2 summaries bounded and exposes current position/counts', () => {
    const result = sessionSummary({
      id: 'session-1', ownerId: 'owner-1', status: 'active', mode: 'spaced_repetition',
      storageVersion: 2, limit: 150, totalCount: 150, chunkCount: 1,
      currentIndex: 2, currentPosition: 2, reviewedCount: 2, remainingCount: 148,
      remainingQueueCount: 148, dueCount: 150, cardIds: ['must-not-escape'],
      reviewedCardIds: ['must-not-escape'], processedRequestIds: ['must-not-escape'],
      continuationAvailable: false, truncated: false,
      source: { type: 'custom', cardIds: ['must-not-escape'] },
      ratingCounts: { again: 0, hard: 0, good: 2, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 2, 4: 0 } },
      startedAt: { _seconds: 1_700_000_000, _nanoseconds: 0 },
    } as never);
    expect(result).toMatchObject({ id: 'session-1', currentPosition: 2, remainingQueueCount: 148, limit: 150 });
    expect(result).not.toHaveProperty('cardIds');
    expect(result).not.toHaveProperty('reviewedCardIds');
    expect(result).not.toHaveProperty('processedRequestIds');
    expect(result.source).not.toHaveProperty('cardIds');
  });
});

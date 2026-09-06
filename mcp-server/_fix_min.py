import io

p = 'src/tools.test.ts'
s = io.open(p, encoding='utf-8').read()

# 1. start_review_session test: minimal structuredContent + hidden widgetState
old = """    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: Record<string, unknown> | null } }).structuredContent;
    expect(sc?.session).toMatchObject({
      id: 's1', status: 'active', mode: 'spaced_repetition', limit: 100, dueCount: 3, deckId: 'deck-1',
      modeTag: '[Spaced repetition review · 3 cards due]',
      visibleStatus: 'active · 0 reviewed, 2 remaining of 2',
      cardIds: ['card-1', 'card-2'], currentIndex: 0, reviewedCount: 0, remainingCount: 2,
      truncated: false, continuationAvailable: false,
      startedAt: '2023-11-14T22:13:20.000Z',
    });
    // ChatGPT renders structuredContent, so the mode tag MUST be in structured output,
    // not only in the text content.
    expect((sc?.session as Record<string, unknown>).modeTag).toBe('[Spaced repetition review · 3 cards due]');
    expect((sc?.session as Record<string, unknown>).visibleStatus).toBe('active · 0 reviewed, 2 remaining of 2');
    expect(sc?.session?.ratingCounts).toEqual({ again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } });
    expect((sc?.card as { id?: string }).id).toBe('card-1');"""
new = """    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: Record<string, unknown> | null } }).structuredContent;
    // QUIET mode: model-facing structuredContent is MINIMAL — no front/back,
    // no progress, no modeTag/visibleStatus, no ratings.
    expect(sc?.session).toMatchObject({
      id: 's1', status: 'active', mode: 'spaced_repetition',
      currentIndex: 0, reviewedCount: 0, remainingCount: 2,
    });
    expect((sc?.session as Record<string, unknown>).modeTag).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).visibleStatus).toBeUndefined();
    expect((sc?.session as Record<string, unknown>).ratingCounts).toBeUndefined();
    expect((sc?.card as { id?: string }).id).toBe('card-1');
    expect((sc?.card as { front?: string }).front).toBeUndefined();
    // The FULL state (modeTag/visibleStatus/ratingCounts/card front) rides in
    // the hidden _meta['ui/widgetState'].
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; card?: { front?: string } } | undefined);
    expect(hidden?.session?.modeTag).toBe('[Spaced repetition review · 3 cards due]');
    expect(hidden?.session?.visibleStatus).toBe('active · 0 reviewed, 2 remaining of 2');
    expect(hidden?.card?.front).toBe('What is FSRS?');"""
assert s.count(old) == 1, f'start {s.count(old)}'
s = s.replace(old, new)

# 2. get_review_session test: minimal shape
old = """    const result = await client.callTool({ name: 'get_review_session', arguments: { sessionId: 's1' } });
    const sc = (result as { structuredContent?: { session?: { id?: string; status?: string }; card?: { front?: string } | null } }).structuredContent;
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    expect((sc?.card as { front?: string } | null | undefined)?.front).toBe('Current?');"""
new = """    const result = await client.callTool({ name: 'get_review_session', arguments: { sessionId: 's1' } });
    const sc = (result as { structuredContent?: { session?: { id?: string; status?: string }; card?: { id?: string } | null } }).structuredContent;
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    // Minimal: card has only the id; the front rides in hidden widgetState.
    expect((sc?.card as { id?: string } | null | undefined)?.id).toBe('card-1');
    expect((sc?.card as { front?: string } | null | undefined)?.front).toBeUndefined();
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const hidden = (meta?.['ui/widgetState'] as { card?: { front?: string } } | undefined);
    expect(hidden?.card?.front).toBe('Current?');"""
assert s.count(old) == 1, f'get {s.count(old)}'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('session-tool tests updated for minimal shape')

import io

p = 'src/widget.test.ts'
s = io.open(p, encoding='utf-8').read()

old = """    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: unknown } }).structuredContent;
    // QUIET mode: model-facing structuredContent is minimal — no card
    // front/back/progress prose, no modeTag/visibleStatus.
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    expect(sc?.session?.modeTag).toBeUndefined();
    expect(sc?.session?.visibleStatus).toBeUndefined();
    expect((sc?.card as { id?: string } | null | undefined)?.id).toBe('card-1');
    expect((sc?.card as { front?: string } | null | undefined)?.front).toBeUndefined();
    // The FULL widget state rides in the hidden _meta['ui/widgetState'].
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe('ui://review-session');
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; card?: { front?: string } | null } | undefined);
    expect(hidden?.session?.modeTag).toBe('[Spaced repetition review · 12 cards due]');
    expect(hidden?.session?.visibleStatus).toBe('active · 0 reviewed, 12 remaining of 12');
    expect(hidden?.card?.front).toBe('Q');
  });"""
new = """    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown>; card?: { front?: string } | null } }).structuredContent;
    // structuredContent stays outputSchema-complete (modeTag/visibleStatus
    // present) so MCP validation passes...
    expect(sc?.session?.id).toBe('s1');
    expect(sc?.session?.status).toBe('active');
    expect(sc?.session?.modeTag).toBe('[Spaced repetition review · 12 cards due]');
    expect(sc?.session?.visibleStatus).toBe('active · 0 reviewed, 12 remaining of 12');
    // ...but the model-facing TEXT is quiet: no front/back or progress prose.
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('the review widget is updated.');
    expect(text).toContain('Current card id: card-1.');
    expect(text).not.toContain('"Q" → "A"');
    expect(text).not.toContain('Progress:');
    // The FULL widget state also rides in the hidden _meta['ui/widgetState'].
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe('ui://review-session');
    const hidden = (meta?.['ui/widgetState'] as { session?: Record<string, unknown>; card?: { front?: string } | null } | undefined);
    expect(hidden?.session?.modeTag).toBe('[Spaced repetition review · 12 cards due]');
    expect(hidden?.card?.front).toBe('Q');
  });"""
assert s.count(old) == 1, f'meta {s.count(old)}'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('meta test updated')

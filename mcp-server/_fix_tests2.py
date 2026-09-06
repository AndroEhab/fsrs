import io

p = 'src/widget.test.ts'
s = io.open(p, encoding='utf-8').read()

# 1. Session-tool quiet-mode test: the model-facing structuredContent is now
# minimal (id/status/card id); the FULL state (modeTag/visibleStatus/card) is
# in the hidden _meta['ui/widgetState'].
old = """    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
    const sc = (result as { structuredContent?: { session?: Record<string, unknown> } }).structuredContent;
    expect(sc?.session?.modeTag).toBe('[Spaced repetition review · 12 cards due]');
    expect(sc?.session?.visibleStatus).toBe('active · 0 reviewed, 12 remaining of 12');
    // The meta hint points hosts at the widget resource via the current
    // Apps SDK ui.resourceUri linkage (legacy alias retained separately).
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    // The result meta uses the current Apps SDK ui.resourceUri linkage.
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe('ui://review-session');
  });"""
new = """    const result = await client.callTool({ name: 'start_review_session', arguments: {} });
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
assert s.count(old) == 1, f'meta test {s.count(old)}'
s = s.replace(old, new)

# 2. AI-fallback test: the prompt now instructs the assistant to CALL
# record_answer_evaluation (not reply with JSON), and the widget polls.
old = """  it('routes AI-fallback through sendFollowUpMessage with the CORRECT object signature and a clear evaluation prompt', () => {
    const h = html();
    expect(h).toContain("typeof window.openai.sendFollowUpMessage === 'function'");
    expect(h).toContain('window.__MCP_HOST__');
    // The legacy bridge requires an OBJECT { prompt, scrollToBottom } — a
    // string is silently ignored (the 'Sent...' with no feedback symptom).
    expect(h).toContain('followUp.sendFollowUpMessage({ prompt: promptText, scrollToBottom: true })');
    expect(h).not.toContain('sendFollowUpMessage(JSON.stringify');
    // The prompt carries expected + submitted + card/session context and the
    // constrained verdict instruction.
    expect(h).toContain("'Expected answer: ' + (route.expected || '')");
    expect(h).toContain("'User\\'s typed answer: ' + (answer.text || '(revealed)')");
    expect(h).toContain('verdict: "correct"|"partial"|"incorrect"');
    expect(h).toContain('Do not add anything outside the JSON object.');
    // Standard MCP Apps host uses the documented ui/message shape.
    expect(h).toContain("rpcSend('ui/message', { role: 'user', content: [{ type: 'text', text: promptText }] })");
    // Never fabricates a verdict: the fallback copy says "inconclusive".
    expect(h).toContain('Local check inconclusive');
  });"""
new = """  it('routes AI-fallback to record_answer_evaluation and polls for the stored verdict', () => {
    const h = html();
    expect(h).toContain("typeof window.openai.sendFollowUpMessage === 'function'");
    expect(h).toContain('window.__MCP_HOST__');
    // The legacy bridge requires an OBJECT { prompt, scrollToBottom } — a
    // string is silently ignored.
    expect(h).toContain('followUp.sendFollowUpMessage({ prompt: promptText, scrollToBottom: true })');
    expect(h).not.toContain('sendFollowUpMessage(JSON.stringify');
    // The prompt instructs the assistant to CALL record_answer_evaluation
    // with sessionId + cardId + verdict + feedback (not reply with JSON).
    expect(h).toContain('call the record_answer_evaluation tool with:');
    expect(h).toContain('  sessionId: ' + data.session.id');
    expect(h).toContain("'  cardId: ' + (data.card && data.card.id || '')");
    expect(h).toContain('verdict: "correct" | "partial" | "incorrect"');
    expect(h).toContain('Do NOT write a chat reply about the card or the verdict');
    // The widget starts polling get_review_session for the stored eval.
    expect(h).toContain('startEvaluationPoll();');
    expect(h).toContain('function startEvaluationPoll()');
    expect(h).toContain('function evalPollTick()');
    expect(h).toContain("callTool(data.getTool, { sessionId: data.session.id })");
    // Standard MCP Apps host uses the documented ui/message shape.
    expect(h).toContain("rpcSend('ui/message', { role: 'user', content: [{ type: 'text', text: promptText }] })");
    // Never fabricates a verdict: the fallback copy says "inconclusive".
    expect(h).toContain('Local check inconclusive');
  });"""
assert s.count(old) == 1, f'fb test {s.count(old)}'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tests updated')

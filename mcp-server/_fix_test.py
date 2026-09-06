import io

p = 'src/widget.test.ts'
s = io.open(p, encoding='utf-8').read()

old = """  it('routes AI-fallback through sendFollowUpMessage with a structured needs_ai route', () => {
    const h = html();
    expect(h).toContain("typeof window.openai.sendFollowUpMessage === 'function'");
    expect(h).toContain('window.__MCP_HOST__');
    expect(h).toContain("kind: 'needs_ai'");
    expect(h).toContain('reason: route.reason');
    expect(h).toContain('sessionId: data.session.id');
    expect(h).toContain('submitted: answer.text');
    expect(h).toContain("ask: 'Return JSON { verdict: \"correct\"|\"partial\"|\"incorrect\", feedback: \"<brief explanation>\" } only.'");
    expect(h).toContain('followUp.sendFollowUpMessage(JSON.stringify({ needs_ai: needsAi }))');
    // Never fabricates a verdict: the fallback copy says "inconclusive".
    expect(h).toContain('Local check inconclusive');
  });"""

new = """  it('routes AI-fallback through sendFollowUpMessage with the CORRECT object signature and a clear evaluation prompt', () => {
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

assert s.count(old) == 1, f'replace count {s.count(old)}'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('test replaced')

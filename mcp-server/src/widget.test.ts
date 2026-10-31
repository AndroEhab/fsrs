import { escapeHtml, jsonScriptBody, reviewWidgetBootstrapSchema } from './widget';

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert("x")</script> & \'quotes\'')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;',
    );
  });

  it('stringifies non-strings safely', () => {
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(undefined)).toBe('undefined');
  });
});

describe('jsonScriptBody', () => {
  it('neutralizes closing script tags in serialized bootstrap data', () => {
    const body = jsonScriptBody({ front: '</script><script>alert(1)</script>' });
    expect(body).not.toContain('</script>');
    expect(body).toContain('\\u003c/script');
    expect(JSON.parse(body)).toEqual({ front: '</script><script>alert(1)</script>' });
  });
});

describe('reviewWidgetBootstrapSchema', () => {
  it('accepts valid bootstrap input and rejects missing tool names', () => {
    const base = { session: { id: 's1' }, card: null, submitTool: 'submit_review', startTool: 'start_review_session', endTool: 'end_review_session', getTool: 'get_review_session' };
    expect(reviewWidgetBootstrapSchema.safeParse(base).success).toBe(true);
    expect(reviewWidgetBootstrapSchema.safeParse({ ...base, submitTool: '' }).success).toBe(false);
  });
});

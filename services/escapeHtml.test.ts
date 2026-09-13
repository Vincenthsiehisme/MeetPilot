import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('跳脫五個 HTML 特殊字元', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;'
    );
  });
  it('一般中文與數字原樣輸出', () => {
    expect(escapeHtml('會議記錄 2026-09-14')).toBe('會議記錄 2026-09-14');
  });
  it('非字串輸入先轉成字串', () => {
    expect(escapeHtml(undefined as unknown as string)).toBe('undefined');
  });
});

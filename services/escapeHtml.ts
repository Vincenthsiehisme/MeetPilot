/**
 * 把字串放進 HTML 文字節點或屬性值前的跳脫。T0 實作，T3 的列印文件用它組字串。
 * 只處理五個字元；不做 URL 或 JS 上下文的跳脫，那些不該用字串拼。
 */
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** RegExp 的特殊字元。搜尋框的值是字面文字，組 pattern 前要全部跳脫 */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * 把 text 依搜尋字切成片段，match 標出命中的片段，不分大小寫。
 * 搜尋字只有空白時不切，整段回一個不命中的片段。
 * 用跳脫後的 RegExp 而不是 toLowerCase + indexOf：少數字元（例如 'İ'）轉小寫後長度會變，索引就對不回原文。
 */
export function splitForHighlight(text: string, term: string): HighlightPart[] {
  if (!term.trim()) return [{ text, match: false }];
  const pattern = new RegExp(`(${term.replace(REGEX_SPECIAL, '\\$&')})`, 'gi');
  // split 帶捕獲群組時，奇數位置是命中的字，偶數位置是命中之間的原文
  return text
    .split(pattern)
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter(part => part.text !== '');
}

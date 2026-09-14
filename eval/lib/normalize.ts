/**
 * S1（標籤字串比對）用的正規化。
 *
 * 中文沒有空白分詞，所以比對單位用字元 bigram，不用詞。這是刻意的取捨：
 * 引入斷詞器會多一個相依套件和一組它自己的錯誤，而 S1 的定位是「最便宜的 baseline」，
 * 要贏過它的策略才值得引入複雜度。bigram 已經足以代表這個定位。
 */

/** 全形轉半形，只處理 ASCII 可對應的區段。 */
function toHalfWidth(input: string): string {
  return input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 這些字出現在題目標籤裡幾乎不帶區別力，留著會讓任何兩個標籤都有共同 bigram。 */
const STOPWORDS = [
  '的',
  '與',
  '和',
  '及',
  '跟',
  '這個',
  '那個',
  '我們',
  '他們',
  '一個',
  '相關',
  '部分',
  '方式',
  '進行',
  '討論',
  '問題',
];

export function normalize(input: string): string {
  let text = toHalfWidth(input).toLowerCase();
  text = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  for (const word of STOPWORDS) {
    text = text.split(word).join('');
  }
  return text;
}

/** 字元 bigram 集合。長度小於 2 的字串回傳它自己，不回傳空集合。 */
export function bigrams(input: string): Set<string> {
  const text = normalize(input);
  if (text.length === 0) return new Set();
  if (text.length === 1) return new Set([text]);
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

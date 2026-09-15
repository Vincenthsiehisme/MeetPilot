import { TranscriptSegment } from '../types';

/**
 * 接縫對齊（W2-2）。
 *
 * 為什麼不用時間戳：模型回的時間戳在片內會被壓縮。實測一場 65 分鐘的會，第 0 片把 615 秒
 * 音檔的時間戳壓進 262 秒，其中一段 200 多字標成 7.5 秒。時間戳一旦不可信，以它為基礎的
 * 去重就會失效，而失效的樣子是「同一段話在逐字稿裡出現兩次」，沒有任何錯誤。
 *
 * 換成文字對齊之後，overlap 區同時變成**覆蓋度的量測工具**：第 N 片與第 N+1 片共享
 * `[start_{N+1}, start_{N+1} + O]` 這段音檔，所以
 *
 * - 前一片的尾巴對得上後一片的開頭 → 前一片蓋到了，後面那份是重複，丟掉
 * - 對不上 → 有一片沒蓋到，中間是破洞。**這個模組只負責讓它現形，不負責補**
 *
 * 實測的破洞長這樣：1770–1830 秒那一窗，獨立轉錄出來的 14 段有 10 段在整份合併結果裡
 * 找不到——第 2 片從來沒把自己的尾巴轉出來，而舊的時間戳去重完全看不見這件事。
 *
 * **中段永遠不進入比對**，所以會議中途真的重複說的話不會被誤砍。這是結構上的保證，
 * 不是靠門檻調出來的。
 */

/** 只留中日韓文字、英數。標點、空白、全形半形差異都不影響比對 */
const normalize = (text: string): string =>
  (text || '').replace(/[^一-鿿぀-ヿA-Za-z0-9]/g, '').toLowerCase();

/**
 * 字元 bigram 的 Dice 係數。中文沒有詞邊界，bigram 比 token 比對穩。
 *
 * 不用 difflib 那種最長共同子序列：模型兩次轉同一段音檔，用字會有出入
 * （「營運」對「贏運」、「很猛」對「很高」），要的是「大致是同一段話」不是逐字相同。
 */
export function bigramSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const left = counts.get(g) ?? 0;
    if (left > 0) {
      counts.set(g, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * needle 的 bigram 有多少比例出現在 haystack 裡。**不對稱**，這是重點。
 *
 * 接縫兩側的長度可以差很多：實測有一個接縫的 incoming 第一段是「相處。」兩個字，
 * 它確實是前一片尾巴的一部分，但對稱的 Dice 只給 0.026（被長度差稀釋），
 * 拿它下判斷會把真的重複判成破洞。包含度對同一段給 1.000。
 */
export function bigramContainment(needle: string, haystack: string): number {
  if (needle.length < 2 || haystack.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < haystack.length - 1; i += 1) {
    const g = haystack.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let hits = 0;
  const total = needle.length - 1;
  for (let i = 0; i < total; i += 1) {
    const g = needle.slice(i, i + 2);
    const left = counts.get(g) ?? 0;
    if (left > 0) {
      counts.set(g, left - 1);
      hits += 1;
    }
  }
  return hits / total;
}

export type SeamVerdict =
  /** 對得上：incoming 開頭 duplicateSegments 段是重複的 */
  | 'duplicate'
  /** 對不上：兩片之間有內容沒有人轉到 */
  | 'gap'
  /** 比不動：接縫兩側其中一邊的文字太少，做不出有意義的判斷 */
  | 'inconclusive';

export interface SeamAlignment {
  verdict: SeamVerdict;
  /** 最佳比對的相似度，0 到 1 */
  similarity: number;
  /** incoming 開頭有幾段判定為重複。verdict 不是 duplicate 時一律 0 */
  duplicateSegments: number;
}

export interface SeamOptions {
  /** 判定為重複的相似度門檻 */
  threshold?: number;
  /** 接縫兩側各自最多看幾段 */
  windowSegments?: number;
  /** 兩側正規化後至少要有幾個字才做判斷，低於此回 inconclusive */
  minChars?: number;
  /** 錨點段落對尾巴的包含度門檻 */
  anchorContainment?: number;
  /** 短於這個字數的開頭段落視為碎片，跳過再下錨 */
  fragmentChars?: number;
}

/**
 * 門檻取 0.30。實測（65 分鐘、7 片、真實模型、六個接縫）四個重複接縫的 bigram 相似度是
 * 0.635／0.711／0.716／0.519，兩個破洞接縫是 0.053／0.125，中間空了 0.39。
 * 取在中央而不是貼著重複那側的下緣：**寧可漏掉一個重複，不可把不重複的砍掉**——
 * 重複看得出來，掉字看不出來。只有一場會的樣本，門檻要隨新樣本重新檢查。
 */
export const SEAM_SIMILARITY_THRESHOLD = 0.30;
const DEFAULT_WINDOW_SEGMENTS = 8;
const DEFAULT_MIN_CHARS = 12;

/**
 * 錨點：incoming 的第一個**夠長的**段落，必須自己就對得上前一片的尾巴。
 *
 * 沒有這道閘的話，滑動窗會出事：incoming 第一段是全新內容、第二段才是真的重複時，
 * 兩段合起來比對的相似度照樣過門檻，結果**連第一段全新內容一起被當成重複丟掉**。
 * 那是這個模組最不能犯的錯——重複看得出來，掉字看不出來。
 *
 * 實測門檻：三個重複接縫的錨點包含度是 0.879／1.000／0.967，兩個破洞接縫是 0.167／0.077。
 */
const DEFAULT_ANCHOR_CONTAINMENT = 0.5;

/**
 * 短於這個字數的開頭段落可以跳過再下錨。
 *
 * 實測有個接縫的 incoming 第一段是「或者是」三個字，對應前一片的「或是說」，
 * 用字不同所以包含度是 0，但它後面那段是明確的重複。碎片本來就對不準，
 * 跳過它從下一段下錨。**只跳短碎片**：誤砍那個案例的第一段是 17 個字的完整句子，跳不過去。
 */
const DEFAULT_FRAGMENT_CHARS = 6;

/**
 * 找 incoming 開頭有幾段跟 existing 尾巴是同一段話。
 *
 * 兩邊都用滑動窗：前一片的尾端可能被切成 2 段也可能 6 段，後一片同理，
 * 固定段數比對會因為切分方式不同而錯過。取所有 (m, k) 組合裡相似度最高的那一對。
 */
export function alignSeam(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  options: SeamOptions = {}
): SeamAlignment {
  const {
    threshold = SEAM_SIMILARITY_THRESHOLD,
    windowSegments = DEFAULT_WINDOW_SEGMENTS,
    minChars = DEFAULT_MIN_CHARS,
    anchorContainment = DEFAULT_ANCHOR_CONTAINMENT,
    fragmentChars = DEFAULT_FRAGMENT_CHARS,
  } = options;

  if (existing.length === 0 || incoming.length === 0) {
    return { verdict: 'inconclusive', similarity: 0, duplicateSegments: 0 };
  }

  const maxTail = Math.min(windowSegments, existing.length);
  const maxHead = Math.min(windowSegments, incoming.length);

  const tails: string[] = [];
  for (let m = 1; m <= maxTail; m += 1) {
    tails.push(normalize(existing.slice(existing.length - m).map(s => s.text).join('')));
  }
  const heads: string[] = [];
  for (let k = 1; k <= maxHead; k += 1) {
    heads.push(normalize(incoming.slice(0, k).map(s => s.text).join('')));
  }

  // 兩側的最大窗都湊不出足夠的字，就不要假裝判斷得出來。
  // 硬判的話，短句碰巧相似會砍掉真內容，而那正是這個模組要防的失敗
  if (tails[maxTail - 1].length < minChars || heads[maxHead - 1].length < minChars) {
    return { verdict: 'inconclusive', similarity: 0, duplicateSegments: 0 };
  }

  let best = { similarity: 0, k: 0 };
  for (let ti = 0; ti < tails.length; ti += 1) {
    for (let hi = 0; hi < heads.length; hi += 1) {
      const similarity = bigramSimilarity(tails[ti], heads[hi]);
      if (similarity > best.similarity) best = { similarity, k: hi + 1 };
    }
  }

  // 錨點閘：找 incoming 第一個夠長的段落，它必須自己就對得上尾巴。
  // 在它之前的短碎片一併算進重複區（碎片跟誰都對不準，單獨判會判錯）
  let anchorIndex = 0;
  while (
    anchorIndex < incoming.length - 1 &&
    normalize(incoming[anchorIndex].text).length < fragmentChars
  ) {
    anchorIndex += 1;
  }
  const anchorText = normalize(incoming[anchorIndex].text);
  let anchorScore = 0;
  for (const tail of tails) {
    anchorScore = Math.max(anchorScore, bigramContainment(anchorText, tail));
  }

  const anchored = anchorScore >= anchorContainment;
  if (!(best.similarity >= threshold && anchored && best.k > anchorIndex)) {
    return { verdict: 'gap', similarity: best.similarity, duplicateSegments: 0 };
  }

  // 重複區有幾段，用逐段包含度往後延伸，不用「對稱相似度最大的 k」。
  //
  // 對稱 Dice 會被長度差稀釋：重複區的最後一段常常是「找方法去。」這種短句，
  // 把它加進來反而讓整體分數下降，於是 k 停在它前面，那一段重複就留在逐字稿裡。
  // 實測（真實樣本）用最大 k 的做法，兩個接縫清完仍有 0.505 與 0.489 的殘餘相似度。
  //
  // 逐段判就沒有這個問題：每一段各自問「你在不在前一片的尾巴裡」，短句照樣答得出來。
  const bestTail = tails[tails.length - 1];
  let k = 0;
  while (k < incoming.length) {
    const text = normalize(incoming[k].text);
    // 短碎片跟誰都對不準，夾在重複區中間時跟著走，但不能靠它自己把重複區往外拉長
    const isFragment = text.length < fragmentChars;
    const contained = bigramContainment(text, bestTail) >= anchorContainment;
    if (!contained && !(isFragment && k < incoming.length - 1)) break;
    k += 1;
  }
  // 往回收掉尾端的碎片：重複區不該以「跟著走」的碎片結尾，那一段可能已經是新內容
  while (k > 0 && normalize(incoming[k - 1].text).length < fragmentChars) k -= 1;

  if (k === 0) {
    return { verdict: 'gap', similarity: best.similarity, duplicateSegments: 0 };
  }
  return { verdict: 'duplicate', similarity: best.similarity, duplicateSegments: k };
}

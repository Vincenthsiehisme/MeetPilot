import { TranscriptSegment } from '../types';
import { SeamAlignment, SeamOptions, alignSeam } from './seamAlignment';

// 切片 overlap 秒數的唯一來源：server 端 planSlices（services/audioSlicer.ts）切出來的重疊區、
// transcriptionPipeline 傳給它的值都從這裡拿。任何地方都不要寫回字面值。
//
// W2-2 之後去重不再看這個值：模型回的時間戳在片內會被壓縮，以時間為準的去重會失效
// （理由見 services/seamAlignment.ts 檔頭）。它現在只管「切片時要重疊幾秒」，
// 而那段重疊本身變成接縫對齊的原料。
export const SLICE_OVERLAP_SECONDS = 15;

export interface MergeResult {
  segments: TranscriptSegment[];
  /** 這一片接上去時接縫長什麼樣。第一片沒有接縫，是 null */
  seam: SeamAlignment | null;
}

/**
 * 把一個切片的轉錄結果接到既有逐字稿後面，去掉 overlap 重複。
 *
 * 背景：planSlices() 排出的第 N 片涵蓋 [start_N, start_N + D + O]，第 N+1 片從 start_N + D 開始，
 * 所以 [start_{N+1}, start_{N+1} + O] 這段同時出現在第 N 片的尾巴與第 N+1 片的開頭。
 *
 * **W2-2 改成文字對齊，不再用時間戳判重複。** 舊做法是
 * `coveredUntil = min(existing 最後一段的 end, sliceStartTime + overlapSeconds)`，丟掉 end 在它之內的段落。
 * 那個 `min` 是為了防時間戳**高估**設的上限，對**低估**沒有任何保護；而實測模型會低估——
 * 一場 65 分鐘的會，第 0 片把 615 秒音檔的時間戳壓進 262 秒，於是它宣稱「只覆蓋到 262 秒」，
 * 第 1 片從 600 秒開始的內容就整段被當成新的，同一段話進了逐字稿兩次，而且沒有任何錯誤。
 *
 * 換成對齊之後多拿到一個東西：**接縫對不上就是破洞**，代表有一片沒把自己該轉的轉完
 * （實測至少兩個接縫是這種）。這個函式只回報，不修補（修補是 W2-2b）。
 * **呼叫端有責任把 gap 講出去，不要吞掉。**
 *
 * 純函式：同輸入同輸出，不 mutate 任何輸入陣列。測試要寫死期望值。
 */
export function mergeSliceTranscript(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  sliceStartTime: number,
  isFirstSlice: boolean,
  options: SeamOptions = {},
  overlapSeconds: number = SLICE_OVERLAP_SECONDS,
  tolerance: number = 0.5,
): MergeResult {
  if (isFirstSlice) {
    return { segments: [...existing, ...incoming], seam: null };
  }

  const seam = alignSeam(existing, incoming, options);
  // 判不出來（接縫兩側字太少）時全部接上：寧可留一小段重複，不可掉字
  const wanted = seam.verdict === 'duplicate' ? seam.duplicateSegments : 0;

  // **文字決定有沒有重複，幾何決定最多能刪多少。**
  //
  // 只刪「按 incoming 自己的時間戳完全落在 overlap 區內」的段落。超過那條線的音檔，
  // 前一片根本沒有，不可能是重複。這道上限用的是 incoming 的時間戳而不是 existing 的：
  // 壓縮是沿著片內累積的，一片的開頭附近相對可信，而前一片的尾端正是被壓得最兇的地方。
  //
  // 沒有這道上限時，文字高度自相似的內容會被多砍。實測的形狀是合成測試資料
  // （「600s 開始的內容」「610s 開始的內容」這種公式化字串，相鄰段落 bigram 天生就像），
  // 但真實會議裡的套語重複也有同樣的風險，而多砍就是掉字——這個模組最不能犯的錯。
  //
  // 代價是接縫可能留下幾段沒刪乾淨的重複（incoming 自己也被壓縮時）。那是刻意的取捨：
  // 重複看得出來，掉字看不出來。留下來的重複會記在 seam 裡，不是安靜通過
  const limit = sliceStartTime + overlapSeconds + tolerance;
  let dropCount = 0;
  while (dropCount < wanted && incoming[dropCount].end <= limit) dropCount += 1;

  return {
    segments: [...existing, ...incoming.slice(dropCount)],
    seam: { ...seam, duplicateSegments: dropCount },
  };
}

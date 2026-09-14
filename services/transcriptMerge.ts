import { TranscriptSegment } from '../types';

// 切片 overlap 秒數的唯一來源：generateAudioSlices 切出來的重疊區、mergeSliceTranscript 去重的上限、
// App.tsx 傳給兩者的值都從這裡拿，三處對不上就會掉字或重複
export const SLICE_OVERLAP_SECONDS = 15;

/**
 * 契約（T0 定，T2 實作）：把一個切片的轉錄結果接到既有逐字稿後面，去掉 overlap 重複。
 *
 * 背景：generateAudioSlices() 切出的第 N 片涵蓋 [start_N, start_N + D + O]，第 N+1 片從 start_N + D 開始，
 * 所以 [start_{N+1}, start_{N+1} + O] 這段同時出現在第 N 片的尾巴與第 N+1 片的開頭。
 * server 端已把 offsetSeconds 加進每段的 start/end，incoming 的時間是絕對時間。
 *
 * 規則（以「既有逐字稿已涵蓋到哪」為準，不以切片邊界為準）：
 * - isFirstSlice 為 true：全部接上，不過濾。
 * - 否則 coveredUntil = min(existing 最後一段的 end, sliceStartTime + overlapSeconds)
 *   （existing 空則為 sliceStartTime）。上限是因為 server 沒把 LLM 回的 end clamp 到切片實際長度，
 *   時間戳高估時前一片的 end 可能遠超過 overlap 區，不設上限會把第 N+1 片開頭真的內容當重複丟掉。
 *   incoming 裡 end <= coveredUntil + tolerance 的段落視為重複，丟掉；其餘依序接上，
 *   即使它的 start 略早於 coveredUntil 也保留（寧可幾秒重疊，不可掉字）。
 * - 不改 existing 的內容與順序；不 mutate 任何輸入陣列。
 * - tolerance 預設 0.5 秒；overlapSeconds 預設 15 秒，要跟 generateAudioSlices 用的 overlap 一致。
 *
 * 純函式：同輸入同輸出，不碰 DOM、不碰 IndexedDB。測試要寫死期望值。
 */
export function mergeSliceTranscript(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  sliceStartTime: number,
  isFirstSlice: boolean,
  tolerance: number = 0.5,
  overlapSeconds: number = SLICE_OVERLAP_SECONDS
): TranscriptSegment[] {
  if (isFirstSlice) {
    return [...existing, ...incoming];
  }
  const coveredUntil = existing.length > 0
    ? Math.min(existing[existing.length - 1].end, sliceStartTime + overlapSeconds)
    : sliceStartTime;
  const kept = incoming.filter(s => s.end > coveredUntil + tolerance);
  return [...existing, ...kept];
}

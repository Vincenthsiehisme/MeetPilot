import { TranscriptSegment } from '../types';

/**
 * 契約（T0 定，T2 實作）：把一個切片的轉錄結果接到既有逐字稿後面，去掉 overlap 重複。
 *
 * 背景：generateAudioSlices() 切出的第 N 片涵蓋 [start_N, start_N + D + O]，第 N+1 片從 start_N + D 開始，
 * 所以 [start_{N+1}, start_{N+1} + O] 這段同時出現在第 N 片的尾巴與第 N+1 片的開頭。
 * server 端已把 offsetSeconds 加進每段的 start/end，incoming 的時間是絕對時間。
 *
 * 規則（以「既有逐字稿已涵蓋到哪」為準，不以切片邊界為準）：
 * - isFirstSlice 為 true：全部接上，不過濾。
 * - 否則 coveredUntil = existing 最後一段的 end（existing 空則為 sliceStartTime）；
 *   incoming 裡 end <= coveredUntil + tolerance 的段落視為重複，丟掉；其餘依序接上，
 *   即使它的 start 略早於 coveredUntil 也保留（寧可幾秒重疊，不可掉字）。
 * - 不改 existing 的內容與順序；不 mutate 任何輸入陣列。
 * - tolerance 預設 0.5 秒。
 *
 * 純函式：同輸入同輸出，不碰 DOM、不碰 IndexedDB。測試要寫死期望值。
 */
export function mergeSliceTranscript(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  sliceStartTime: number,
  isFirstSlice: boolean,
  tolerance: number = 0.5
): TranscriptSegment[] {
  void existing; void incoming; void sliceStartTime; void isFirstSlice; void tolerance;
  throw new Error('mergeSliceTranscript 尚未實作（工作包 T2）');
}

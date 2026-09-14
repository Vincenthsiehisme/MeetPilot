import { TranscriptSegment } from '../types';

// 把 LLM 回的 raw segments 正規化成 TranscriptSegment：補預設值、把時間夾回這片音訊的範圍、再加上切片起點偏移。
// 抽成純函式是為了能單獨測：LLM 常回超出切片長度的 end（例如整檔的絕對秒數），
// 不夾回去的話合併時 coveredUntil 會被推爆，後面的切片整段被當成重複丟掉。

// sliceDurationSeconds 不是有限正數時（0、負數、NaN、字串、null…）不能拿來夾，
// 視同沒給並警告一次，讓設定錯誤看得見，而不是安靜地不夾。
function resolveSliceDuration(sliceDurationSeconds: number | undefined): number | undefined {
  if (sliceDurationSeconds === undefined) return undefined;
  if (typeof sliceDurationSeconds === 'number' && Number.isFinite(sliceDurationSeconds) && sliceDurationSeconds > 0) {
    return sliceDurationSeconds;
  }
  console.warn(
    `[normalizeTranscribedSegments] sliceDurationSeconds 不是有限正數（收到 ${JSON.stringify(sliceDurationSeconds)}），這次不夾切片範圍`
  );
  return undefined;
}

export function normalizeTranscribedSegments(
  rawSegments: unknown[],
  offsetSeconds: number,
  sliceDurationSeconds?: number
): TranscriptSegment[] {
  const duration = resolveSliceDuration(sliceDurationSeconds);

  return rawSegments.map((raw) => {
    const s = (raw ?? {}) as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };

    // 非數字時沿用既有預設：start 當 0、end 當 5（加上 offset 後就是 offset 與 offset+5）
    const rawStart = typeof s.start === 'number' ? s.start : 0;
    const rawEnd = typeof s.end === 'number' ? s.end : 5;

    let start: number;
    let end: number;
    if (duration === undefined) {
      // 解不出切片長度是合法的空（raw-file fallback 路徑沒有長度可用），這種情況不夾，原樣採用
      start = rawStart;
      end = rawEnd;
    } else {
      end = Math.min(Math.max(rawEnd, 0), duration);
      start = Math.min(Math.max(rawStart, 0), end);
    }

    return {
      start: start + offsetSeconds,
      end: end + offsetSeconds,
      text: typeof s.text === 'string' ? s.text : '',
      speaker: typeof s.speaker === 'string' && s.speaker ? s.speaker : 'Speaker 1',
    };
  });
}

/**
 * 決定切片用的音訊總長度。
 * <audio>/<video> 的 metadata duration 在串流或某些容器會給 Infinity 或 NaN，
 * 拿去當 while 迴圈上限就不會停；規則：metadata 是有限正數才用它，否則改用解碼後 AudioBuffer 的 duration。
 * 兩者都不是有限正數就拋錯，不回 0、不回 Infinity。
 */
const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

export function resolveDuration(metadataDuration: number, decodedDuration: number): number {
  if (isPositiveFinite(metadataDuration)) return metadataDuration;
  if (isPositiveFinite(decodedDuration)) return decodedDuration;
  throw new Error(
    `resolveDuration: 無法判定音訊總長度（metadataDuration=${metadataDuration}, decodedDuration=${decodedDuration}），無法切片。`
  );
}

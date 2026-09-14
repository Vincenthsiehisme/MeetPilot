import { HttpError } from "./httpError";

// 重試延遲的純函式：從 withRetry 抽出來，才能寫死 random 驗證退避時間。
// 分類條件沿用原本 withRetry 的訊息字串判斷（server 與 SDK 的錯誤大多只剩訊息可看），
// 另外認 HttpError 的 status，這樣 429 不必靠訊息裡有沒有出現 "429" 這幾個字。

const RATE_LIMIT_BASE_MS = 8000;
const TRANSIENT_BASE_MS = 2500;
const JITTER_MS = 1500;
// Retry-After 上限 60 秒：server 若給出離譜的值，不讓單次重試把整個工作卡住
const RETRY_AFTER_CAP_SECONDS = 60;

/**
 * 回傳這次錯誤該等多久再重試（毫秒）；回 null 代表不該重試，呼叫端直接把錯誤丟出去。
 * attempt 從 0 起算（第一次失敗是 0）。random 可注入，測試才能寫死期望值。
 */
export function retryDelayMs(err: unknown, attempt: number, random: () => number = Math.random): number | null {
  const msg = String((err as { message?: unknown } | null | undefined)?.message ?? "").toLowerCase();

  // 僅對短暫性伺服器過載、高需求 (503)、HTML 代理錯誤或網路錯誤重試；
  // 額度用罄 (prepayment / depleted) 重試再多次也不會過，直接放棄
  const isRateLimit =
    (msg.includes('429') || (err instanceof HttpError && err.status === 429)) &&
    !msg.includes('prepayment') &&
    !msg.includes('depleted');
  const isServerError =
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('high demand') ||
    msg.includes('unavailable') ||
    msg.includes('html') ||
    msg.includes('網頁內容') ||
    msg.includes('短暫無回應');
  const isNetworkError = msg.includes('fetch') || msg.includes('networkerror') || msg.includes('failed to fetch');

  const jitter = random() * JITTER_MS;

  if (isRateLimit) {
    // server 有給 Retry-After 就照它的時間退避，別再自己猜比它短或長的值
    const retryAfterSeconds = err instanceof HttpError ? err.retryAfterSeconds : undefined;
    if (retryAfterSeconds !== undefined) {
      return Math.min(retryAfterSeconds, RETRY_AFTER_CAP_SECONDS) * 1000 + jitter;
    }
    return RATE_LIMIT_BASE_MS * (attempt + 1) + jitter;
  }

  if (isServerError || isNetworkError) {
    return TRANSIENT_BASE_MS * (attempt + 1) + jitter;
  }

  return null;
}

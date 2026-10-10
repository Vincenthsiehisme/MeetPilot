/**
 * 非 2xx 回應翻成 `HttpError` 的唯一一份規則。
 *
 * 原本前端有兩個檔各留一份，內容一模一樣。兩份的問題不是多打字，
 * 是只改一邊時不會有任何錯誤：兩條路徑撞到同一個 429、同一個重啟中的 HTML 回應，
 * 使用者會看到兩種說法，限流退避也會吃到不同的 Retry-After。
 *
 * message 的內容維持原樣不要動：`App.tsx` 的 `translateError` 與 `components/TranscriptView.tsx`
 * 都只看 message 字串做分類。
 */
import { HttpError } from './httpError';

// Retry-After 只認非負整數秒數字串。server.ts 的 429 一律送 String(retryAfterSeconds)，
// 不會出現 RFC 的 HTTP-date 格式，所以這裡不做日期解析；解不出來就當 server 沒給，
// 呼叫端照沒有 Retry-After 處理，不自己編一個時間出來。
export function parseRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

export function errorFromResponse(response: Response, text: string): HttpError {
  let errorMsg = `HTTP ${response.status} ${response.statusText}`;
  try {
    const errJson = JSON.parse(text);
    // 契約規定錯誤回應一律是 ApiErrorResponse（`{ error: string }`）
    if (errJson.error) {
      errorMsg = errJson.error;
    } else if (errJson.message) {
      errorMsg = errJson.message;
    }
  } catch {
    if (text.includes('503') || text.includes('high demand') || text.includes('UNAVAILABLE')) {
      errorMsg = 'AI 服務目前需求量極大 (503 High Demand)，系統正在自動重試...';
    } else if (text.trim().startsWith('<')) {
      errorMsg = `伺服器短暫無回應 (HTTP ${response.status})，請稍候重試。`;
    } else if (text) {
      errorMsg = text.slice(0, 200);
    }
  }
  return new HttpError(response.status, errorMsg, parseRetryAfterSeconds(response));
}

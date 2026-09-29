/**
 * Gemini 撞到限流時要等多久（vault plan「MeetPilot · Gemini 限流退避」）。
 *
 * 每位記錄人的 app 各自打同一把 key，額度是整個專案共用的。原本 `generateContentWithFallback`
 * 撞到 429 只等 1、2 秒就換模型，三個模型大約十秒內試完，一分鐘的限流視窗撐不過去，
 * 會議就在大家同時轉錄的時候變成 FAILED。
 *
 * SDK（`@google/genai`）把非 2xx 回應包成 `ApiError`：`status` 是 HTTP 狀態碼，`message` 是整個
 * 錯誤 body 的 `JSON.stringify`。429 的 body 照 Gemini API 公開格式，`error.details` 裡有
 * `google.rpc.RetryInfo.retryDelay`（例如 `"37s"`）與 `google.rpc.QuotaFailure.violations[].quotaId`。
 * **這台機器的紀錄從沒撞過 429，沒有實際樣本**，所以解析一律容錯：解析不到就當沒給，走指數退避。
 */

/** 等待時間從哪來，記進 llm.jsonl：`retry-info` 照回應、`backoff` 自己算、`daily-quota` 是每日額度用完直接換模型 */
export type BackoffSource = 'retry-info' | 'backoff' | 'daily-quota';

export interface RateLimitInfo {
  /** 回應的 `RetryInfo.retryDelay` 換成毫秒；沒給或解析不到是 null */
  retryDelayMs: number | null;
  /** `quotaId` 含 `PerDay`：今天這個模型的額度用完了，等幾十秒也不會好 */
  dailyQuotaExhausted: boolean;
}

export const RETRY_DELAY_FLOOR_MS = 1_000;
export const RETRY_DELAY_CAP_MS = 60_000;
export const BACKOFF_BASE_MS = 5_000;
/** 幾台電腦同時撞到同一個限流時，錯開一點再一起回來，不要同一秒再撞一次 */
export const JITTER_MS = 1_000;

/** 是不是限流。503、overloaded 是服務端過載，不算，維持原本 1、2 秒的等法 */
export function isRateLimitError(err: unknown): boolean {
  if ((err as { status?: unknown } | null | undefined)?.status === 429) return true;
  const msg = String((err as { message?: unknown } | null | undefined)?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('resource_exhausted');
}

const parseDurationMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]) * 1000;
  return Number.isFinite(ms) ? ms : null;
};

export function readRateLimitInfo(err: unknown): RateLimitInfo {
  const none: RateLimitInfo = { retryDelayMs: null, dailyQuotaExhausted: false };
  const raw = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return none;
  let details: unknown;
  try {
    details = JSON.parse(raw)?.error?.details;
  } catch {
    // 看起來像 JSON 但不是：當沒給，呼叫端照樣走退避
    return none;
  }
  if (!Array.isArray(details)) return none;

  let retryDelayMs: number | null = null;
  let dailyQuotaExhausted = false;
  for (const detail of details) {
    const type = String((detail as { '@type'?: unknown } | null)?.['@type'] ?? '');
    if (type.endsWith('RetryInfo')) {
      retryDelayMs = parseDurationMs((detail as { retryDelay?: unknown }).retryDelay) ?? retryDelayMs;
    }
    if (type.endsWith('QuotaFailure')) {
      const violations = (detail as { violations?: unknown }).violations;
      if (Array.isArray(violations) && violations.some(v => String((v as { quotaId?: unknown } | null)?.quotaId ?? '').includes('PerDay'))) {
        dailyQuotaExhausted = true;
      }
    }
  }
  return { retryDelayMs, dailyQuotaExhausted };
}

/**
 * 這次限流要等多久。`attempt` 從 0 起算（第一次失敗是 0）；`random` 可注入，測試才能寫死期望值。
 * 回應有給 `retryDelay` 就照它加 jitter，再夾在 1 到 60 秒；沒給就 5 秒起跳、每次加倍，加 0～1 秒 jitter。
 */
export function rateLimitWait(
  info: RateLimitInfo,
  attempt: number,
  random: () => number = Math.random,
): { ms: number; source: 'retry-info' | 'backoff' } {
  const jitter = Math.floor(random() * JITTER_MS);
  if (info.retryDelayMs !== null) {
    // jitter 加完再夾，等待時間一定落在 1 到 60 秒
    const ms = Math.min(Math.max(info.retryDelayMs + jitter, RETRY_DELAY_FLOOR_MS), RETRY_DELAY_CAP_MS);
    return { ms, source: 'retry-info' };
  }
  return { ms: BACKOFF_BASE_MS * 2 ** attempt + jitter, source: 'backoff' };
}

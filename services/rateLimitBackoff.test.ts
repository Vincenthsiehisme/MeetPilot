import { describe, it, expect } from 'vitest';
import { isRateLimitError, rateLimitWait, readRateLimitInfo } from './rateLimitBackoff';

/** SDK 的 ApiError：status 是 HTTP 狀態碼，message 是整個錯誤 body 的 JSON.stringify */
const apiError = (status: number, details?: unknown[]) => Object.assign(
  new Error(JSON.stringify({ error: { code: status, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details } })),
  { status },
);
const retryInfo = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
const quotaFailure = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaId }],
});

describe('isRateLimitError', () => {
  it('HTTP 429、訊息帶 429 或 RESOURCE_EXHAUSTED 都算限流', () => {
    expect(isRateLimitError(apiError(429))).toBe(true);
    expect(isRateLimitError({ status: 429, message: '' })).toBe(true);
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
  });

  it('503、過載、一般錯誤不算：那些維持原本 1、2 秒的等法', () => {
    expect(isRateLimitError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isRateLimitError(new Error('model overloaded'))).toBe(false);
    expect(isRateLimitError(new Error('400 Invalid argument'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe('readRateLimitInfo', () => {
  it('讀出 RetryInfo 的 retryDelay，每分鐘額度不算每日用完', () => {
    expect(readRateLimitInfo(apiError(429, [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), retryInfo('37s')])))
      .toEqual({ retryDelayMs: 37_000, dailyQuotaExhausted: false });
  });

  it('小數秒也讀得出來', () => {
    expect(readRateLimitInfo(apiError(429, [retryInfo('1.5s')])).retryDelayMs).toBe(1_500);
  });

  it('quotaId 含 PerDay 就是今天的額度用完', () => {
    expect(readRateLimitInfo(apiError(429, [quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo('3600s')])))
      .toEqual({ retryDelayMs: 3_600_000, dailyQuotaExhausted: true });
  });

  it('解析不到的形狀一律當沒給，不拋錯', () => {
    const none = { retryDelayMs: null, dailyQuotaExhausted: false };
    expect(readRateLimitInfo(new Error('429 Too Many Requests'))).toEqual(none);
    expect(readRateLimitInfo(new Error('{ 不是 JSON'))).toEqual(none);
    expect(readRateLimitInfo(apiError(429))).toEqual(none);
    expect(readRateLimitInfo(apiError(429, [retryInfo('很快')]))).toEqual(none);
    expect(readRateLimitInfo(apiError(429, [null, 3, 'x']))).toEqual(none);
    expect(readRateLimitInfo(undefined)).toEqual(none);
  });
});

describe('rateLimitWait', () => {
  const at = (value: number) => () => value;

  it('有 retryDelay 就照它加 jitter', () => {
    expect(rateLimitWait({ retryDelayMs: 37_000, dailyQuotaExhausted: false }, 0, at(0))).toEqual({ ms: 37_000, source: 'retry-info' });
    expect(rateLimitWait({ retryDelayMs: 37_000, dailyQuotaExhausted: false }, 0, at(0.5))).toEqual({ ms: 37_500, source: 'retry-info' });
  });

  it('retryDelay 夾在 1 到 60 秒，jitter 加完再夾', () => {
    expect(rateLimitWait({ retryDelayMs: 3_600_000, dailyQuotaExhausted: false }, 0, at(0.9)).ms).toBe(60_000);
    expect(rateLimitWait({ retryDelayMs: 59_800, dailyQuotaExhausted: false }, 0, at(0.9)).ms).toBe(60_000);
    expect(rateLimitWait({ retryDelayMs: 0, dailyQuotaExhausted: false }, 0, at(0)).ms).toBe(1_000);
  });

  it('沒給 retryDelay 就 5 秒起跳、每次加倍', () => {
    const none = { retryDelayMs: null, dailyQuotaExhausted: false };
    expect(rateLimitWait(none, 0, at(0))).toEqual({ ms: 5_000, source: 'backoff' });
    expect(rateLimitWait(none, 1, at(0))).toEqual({ ms: 10_000, source: 'backoff' });
    expect(rateLimitWait(none, 1, at(0.999))).toEqual({ ms: 10_999, source: 'backoff' });
    // 第三次才分得出是加倍還是線性（5、10、20 對 5、10、15）
    expect(rateLimitWait(none, 2, at(0))).toEqual({ ms: 20_000, source: 'backoff' });
  });
});

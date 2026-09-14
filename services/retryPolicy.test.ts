import { describe, it, expect } from 'vitest';
import { retryDelayMs } from './retryPolicy';
import { HttpError } from './httpError';

// random 寫死成 0，抽掉 jitter 才能驗證退避時間本身
const noJitter = () => 0;

describe('retryDelayMs', () => {
  it('429 帶 Retry-After 就照 server 給的秒數退避', () => {
    // 訊息裡刻意不含 "429"，驗證是靠 HttpError.status 判出 rate limit
    const err = new HttpError(429, '請求太頻繁，請 7 秒後再試', 7);
    expect(retryDelayMs(err, 0, noJitter)).toBe(7000);
  });

  it('Retry-After 過大時夾到 60 秒上限', () => {
    const err = new HttpError(429, '請求太頻繁', 600);
    expect(retryDelayMs(err, 0, noJitter)).toBe(60000);
  });

  it('Retry-After 為 0 時夾到 1 秒下限', () => {
    // 反向代理可能把 Retry-After 改寫成 0；照做等於只等 jitter 就再撞一次限流
    const err = new HttpError(429, '請求太頻繁', 0);
    expect(retryDelayMs(err, 0, noJitter)).toBe(1000);
  });

  it('Retry-After 剛好 1 秒時不被下限動到', () => {
    const err = new HttpError(429, '請求太頻繁', 1);
    expect(retryDelayMs(err, 0, noJitter)).toBe(1000);
  });

  it('429 沒有 Retry-After 時退回既有的遞增退避', () => {
    const err = new HttpError(429, '請求太頻繁 (HTTP 429)');
    expect(retryDelayMs(err, 0, noJitter)).toBe(8000);
    expect(retryDelayMs(err, 1, noJitter)).toBe(16000);
  });

  it('503 用短暫性錯誤的退避', () => {
    expect(retryDelayMs(new Error('HTTP 503 Service Unavailable'), 0, noJitter)).toBe(2500);
  });

  it('額度用罄的 429 不重試', () => {
    const err = new HttpError(429, 'Prepayment credits are depleted', 7);
    expect(retryDelayMs(err, 0, noJitter)).toBeNull();
  });

  it('無法分類的錯誤不重試', () => {
    expect(retryDelayMs(new Error('boom'), 0, noJitter)).toBeNull();
  });

  it('400 這種用戶端錯誤不重試', () => {
    expect(retryDelayMs(new HttpError(400, '缺少必要欄位'), 0, noJitter)).toBeNull();
  });
});

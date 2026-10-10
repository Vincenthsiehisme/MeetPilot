import { describe, it, expect } from 'vitest';
import { HttpError } from './httpError';

describe('HttpError', () => {
  it('帶 HTTP 狀態碼與訊息，是 Error 的子類', () => {
    const err = new HttpError(429, '請求太頻繁 (HTTP 429)');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.name).toBe('HttpError');
    expect(err.status).toBe(429);
    expect(err.message).toBe('請求太頻繁 (HTTP 429)');
  });

  it('Retry-After 秒數照傳入值保留，0 不會被當成沒給', () => {
    expect(new HttpError(429, '請求太頻繁', 7).retryAfterSeconds).toBe(7);
    expect(new HttpError(429, '請求太頻繁', 0).retryAfterSeconds).toBe(0);
  });

  it('沒給 Retry-After 時 retryAfterSeconds 是 undefined', () => {
    expect(new HttpError(400, '缺少必要欄位').retryAfterSeconds).toBeUndefined();
  });
});

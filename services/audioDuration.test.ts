import { describe, it, expect } from 'vitest';
import { resolveDuration } from './audioDuration';

describe('resolveDuration', () => {
  it('metadata 是有限正數就原樣回傳', () => {
    expect(resolveDuration(3600, 3599.5)).toBe(3600);
    expect(resolveDuration(0.5, 100)).toBe(0.5);
  });

  it('metadata 為 Infinity 時改用 decoded', () => {
    expect(resolveDuration(Infinity, 1234.5)).toBe(1234.5);
  });

  it('metadata 為 NaN 時改用 decoded', () => {
    expect(resolveDuration(NaN, 1234.5)).toBe(1234.5);
  });

  it('metadata 為 0 時改用 decoded', () => {
    expect(resolveDuration(0, 1234.5)).toBe(1234.5);
  });

  it('metadata 為負數時改用 decoded', () => {
    expect(resolveDuration(-1, 1234.5)).toBe(1234.5);
  });

  it('兩者都不是有限正數就拋出帶定位訊息的 Error', () => {
    expect(() => resolveDuration(Infinity, NaN)).toThrow(
      'resolveDuration: 無法判定音訊總長度（metadataDuration=Infinity, decodedDuration=NaN），無法切片。'
    );
    expect(() => resolveDuration(NaN, 0)).toThrow(
      'resolveDuration: 無法判定音訊總長度（metadataDuration=NaN, decodedDuration=0），無法切片。'
    );
    expect(() => resolveDuration(0, Infinity)).toThrow(
      'resolveDuration: 無法判定音訊總長度（metadataDuration=0, decodedDuration=Infinity），無法切片。'
    );
    expect(() => resolveDuration(-5, -1)).toThrow(
      'resolveDuration: 無法判定音訊總長度（metadataDuration=-5, decodedDuration=-1），無法切片。'
    );
  });
});

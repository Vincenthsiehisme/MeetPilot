import { describe, expect, it } from 'vitest';

import { bigrams, jaccard, normalize } from './normalize';

describe('normalize', () => {
  it('全形轉半形並轉小寫', () => {
    expect(normalize('ＡＩ客服')).toBe('ai客服');
  });

  it('去掉空白與標點', () => {
    expect(normalize('主管介入、轉派 (插隊)')).toBe('主管介入轉派插隊');
  });

  it('去掉沒有區別力的停用詞', () => {
    expect(normalize('知識庫的維護方式')).toBe('知識庫維護');
  });

  it('停用詞被拿掉之後可能變空字串，不拋錯', () => {
    expect(normalize('相關討論')).toBe('');
  });
});

describe('bigrams', () => {
  it('切成連續兩字的集合', () => {
    expect([...bigrams('主管介入')]).toEqual(['主管', '管介', '介入']);
  });

  it('單字回傳它自己而不是空集合', () => {
    expect([...bigrams('票')]).toEqual(['票']);
  });

  it('正規化後為空時回傳空集合', () => {
    expect(bigrams('的').size).toBe(0);
  });
});

describe('jaccard', () => {
  it('完全相同為 1', () => {
    expect(jaccard(bigrams('主管介入'), bigrams('主管介入'))).toBe(1);
  });

  it('毫無交集為 0', () => {
    expect(jaccard(bigrams('高鐵班次'), bigrams('主管介入'))).toBe(0);
  });

  it('空集合為 0 而不是拋錯', () => {
    expect(jaccard(new Set(), bigrams('主管介入'))).toBe(0);
  });

  it('部分重疊落在 0 與 1 之間', () => {
    const sim = jaccard(bigrams('上下文記憶'), bigrams('上下文記憶與查詢歷程'));
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

import { describe, it, expect } from 'vitest';

import { MATCH_KEY_VERSION, isTopicExtractionStatus, toMatchKey } from './topicTag';

// 期望值一律寫死。比對鍵的規則一改，這幾條就要紅——那正是 MATCH_KEY_VERSION 要加一的時候，
// 「跑兩次比一比」驗不出這種改動
describe('toMatchKey', () => {
  it('全形轉半形並轉小寫', () => {
    expect(toMatchKey('ＡＩ客服')).toBe('ai客服');
  });

  it('去掉空白與標點', () => {
    expect(toMatchKey('主管介入、轉派 (插隊)')).toBe('主管介入轉派插隊');
  });

  it('去掉沒有區別力的停用詞', () => {
    expect(toMatchKey('知識庫的維護方式')).toBe('知識庫維護');
  });

  it('大小寫不影響英文詞', () => {
    expect(toMatchKey('POC 時程')).toBe('poc時程');
  });

  it('整條都是停用詞與標點時回空字串，不拋錯——呼叫端要自己把它當成不可比對', () => {
    expect(toMatchKey('相關討論')).toBe('');
    expect(toMatchKey('？？？')).toBe('');
  });

  it('規則版本是 1。改了上面任何一條規則就要加一', () => {
    expect(MATCH_KEY_VERSION).toBe(1);
  });
});

describe('isTopicExtractionStatus', () => {
  it('只認三個值，null 與其他字串都不是', () => {
    expect(isTopicExtractionStatus('ok')).toBe(true);
    expect(isTopicExtractionStatus('empty')).toBe(true);
    expect(isTopicExtractionStatus('failed')).toBe(true);
    expect(isTopicExtractionStatus(null)).toBe(false);
    expect(isTopicExtractionStatus('OK')).toBe(false);
  });
});

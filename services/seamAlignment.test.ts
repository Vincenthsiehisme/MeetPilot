import { describe, it, expect } from 'vitest';
import { alignSeam, bigramSimilarity, SEAM_SIMILARITY_THRESHOLD } from './seamAlignment';
import { TranscriptSegment } from '../types';

const seg = (start: number, end: number, text: string): TranscriptSegment =>
  ({ start, end, text, speaker: 'Speaker 1' });

// fixture 是照真實模型輸出的**形狀**編的，不是真的逐字稿：同一段話被轉兩次、用字有出入
// （「排程」對「排成」這種同音錯字、贅字增減），這正是不能用逐字比對的理由。
// 不放真實會議內容進 repo。也不要換成「600s 開始的內容」那種公式化字串——
// 那種文字相鄰段落天生就像，測不到真正的行為（實測相似度 0.93）
const TAIL = [
  seg(249.5, 257.0, '所以那個時候我就跟主管提,說我想做一個共用的排程模組,讓每一組自己排自己的批次,不要每次都回來找我們手動跑一遍。'),
  seg(257.0, 260.0, '而不是用工單的數量當指標,而是看他們的批次有沒有準時跑完。'),
  seg(260.0, 262.0, '這樣我才知道說,某一組看起來自動化很高,'),
];
const HEAD = [
  seg(600.0, 609.9, '然後我就跟主管提說,我想做一個共用的排成模組,讓每一組自己排自己的批次,不要每次都回來找我們手動跑。'),
  seg(610.5, 618.6, '而不是用工單數量當指標,是看他們的批次有沒有準時跑完,這樣我才知道某一組看起來自動化很高,但其他組完全沒有。'),
  seg(620.3, 622.8, '那當初這件事你覺得最挑戰的會是什麼?'),
];

describe('bigramSimilarity', () => {
  it('同一段話用字略有出入仍算高相似', () => {
    expect(bigramSimilarity('我想做一個共用的排程模組讓每一組自己排批次', '我想做一個共用的排成模組讓每一組自己排自己的批次'))
      .toBeGreaterThan(SEAM_SIMILARITY_THRESHOLD);
  });

  it('不同主題的兩段話低相似', () => {
    expect(bigramSimilarity('那你的管理風格大概會是什麼樣子', '棧板的數量從上個月開始就一直不夠用'))
      .toBeLessThan(SEAM_SIMILARITY_THRESHOLD);
  });

  it('空字串回 0，不拋錯', () => {
    expect(bigramSimilarity('', 'abc')).toBe(0);
    expect(bigramSimilarity('abc', '')).toBe(0);
  });
});

describe('alignSeam', () => {
  it('重複的接縫判成 duplicate，並指出開頭兩段是重複的', () => {
    const result = alignSeam(TAIL, HEAD);
    expect(result.verdict).toBe('duplicate');
    expect(result.similarity).toBeGreaterThan(0.5);
    // 第三段是新內容，不能被算進去
    expect(result.duplicateSegments).toBe(2);
  });

  it('破洞的接縫判成 gap：前一片根本沒轉到那段，沒有東西可以對上', () => {
    const tail = [
      seg(1677.9, 1679.8, '所以之後每一組的標準就統一了。'),
      seg(1680.6, 1683.9, '這件事情就變成排得進年度計畫的東西。'),
    ];
    const head = [
      seg(1800.0, 1801.7, '那倉儲那邊呢。'),
      seg(1801.7, 1805.4, '棧板的數量從上個月開始就一直不夠用。'),
      seg(1805.4, 1810.3, '採購說最快也要月底才補得到貨,中間這段只能先調度。'),
    ];
    const result = alignSeam(tail, head);
    expect(result.verdict).toBe('gap');
    expect(result.duplicateSegments).toBe(0);
  });

  it('時間戳壓縮不影響判斷：同一組文字，時間戳差 340 秒也照樣判成 duplicate', () => {
    // 這一條是整個 W2-2 的重點。舊的去重看時間，看到「前一片只到 262 秒」就整片放行
    const shifted = TAIL.map(s => ({ ...s, start: s.start + 340, end: s.end + 340 }));
    expect(alignSeam(TAIL, HEAD).verdict).toBe('duplicate');
    expect(alignSeam(shifted, HEAD).verdict).toBe('duplicate');
    expect(alignSeam(TAIL, HEAD).duplicateSegments)
      .toBe(alignSeam(shifted, HEAD).duplicateSegments);
  });

  it('會議中途真的說了兩次的話不會被判成重複：它不在接縫上', () => {
    const tail = [seg(100, 104, '那我們就照這個方向走，下週再對一次進度。')];
    const head = [
      seg(104, 108, '好，那先講第二件事情，關於報價的部分。'),
      seg(108, 112, '那我們就照這個方向走，下週再對一次進度。'), // 同一句話，但在第二段
    ];
    const result = alignSeam(tail, head);
    expect(result.verdict).toBe('gap');
    expect(result.duplicateSegments).toBe(0);
  });

  it('兩側文字太少時回 inconclusive，不硬判', () => {
    expect(alignSeam([seg(0, 1, '對。')], [seg(1, 2, '嗯。')]).verdict).toBe('inconclusive');
  });

  it('任一側是空陣列回 inconclusive', () => {
    expect(alignSeam([], HEAD).verdict).toBe('inconclusive');
    expect(alignSeam(TAIL, []).verdict).toBe('inconclusive');
  });

  it('不 mutate 輸入', () => {
    const tail = TAIL.map(s => ({ ...s }));
    const head = HEAD.map(s => ({ ...s }));
    alignSeam(tail, head);
    expect(tail).toEqual(TAIL);
    expect(head).toEqual(HEAD);
  });
});

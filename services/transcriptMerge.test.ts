import { describe, it, expect } from 'vitest';
import { mergeSliceTranscript, SLICE_OVERLAP_SECONDS } from './transcriptMerge';
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
const HEAD_DUP = seg(600.0, 609.9, '然後我就跟主管提說,我想做一個共用的排成模組,讓每一組自己排自己的批次,不要每次都回來找我們手動跑。');
const HEAD_DUP2 = seg(610.5, 618.6, '而不是用工單數量當指標,是看他們的批次有沒有準時跑完,這樣我才知道某一組看起來自動化很高,但其他組完全沒有,對,這是我在意的地方。');
const HEAD_NEW = seg(620.3, 622.8, '那當初這件事你覺得最挑戰的會是什麼?');
const HEAD_NEW2 = seg(624.4, 626.2, '是在溝通這一段嗎?');

describe('mergeSliceTranscript', () => {
  it('第一片全收、不比對，seam 是 null', () => {
    const incoming = [HEAD_DUP, HEAD_NEW];
    const result = mergeSliceTranscript([], incoming, 0, true);
    expect(result.segments).toEqual(incoming);
    expect(result.seam).toBeNull();
  });

  it('第一片即使 existing 非空也全部接上', () => {
    const result = mergeSliceTranscript(TAIL, [HEAD_DUP], 600, true);
    expect(result.segments).toEqual([...TAIL, HEAD_DUP]);
    expect(result.seam).toBeNull();
  });

  it('接縫對得上時丟掉重複的那一段，新內容一段都不丟', () => {
    const incoming = [HEAD_DUP, HEAD_DUP2, HEAD_NEW, HEAD_NEW2];
    const result = mergeSliceTranscript(TAIL, incoming, 600, false);
    expect(result.seam?.verdict).toBe('duplicate');
    // HEAD_DUP 整段落在 overlap 區（end 609.9 <= 600 + 15 + 0.5）→ 刪。
    // HEAD_DUP2 的 end 是 618.6，超出 overlap 區，**即使文字上是重複也留著**：
    // 那條線之外的音檔前一片根本沒有，刪它就有掉字的風險（見實作的幾何上限）
    expect(result.segments).toEqual([...TAIL, HEAD_DUP2, HEAD_NEW, HEAD_NEW2]);
    expect(result.seam?.duplicateSegments).toBe(1);
  });

  it('幾何上限擋得住過度刪除：文字判定要刪 4 段，超出 overlap 區的一段都不刪', () => {
    // 這條擋的是文字自相似造成的多砍。合成資料最明顯（「600s 開始的內容」那種），
    // 真實會議的套語重複也一樣，而多砍就是掉字
    const incoming = [HEAD_DUP, HEAD_DUP2, HEAD_NEW, HEAD_NEW2];
    const generous = mergeSliceTranscript(TAIL, incoming, 600, false, { threshold: 0.01 });
    expect(generous.seam?.duplicateSegments).toBeLessThanOrEqual(1);
    expect(generous.segments).toContain(HEAD_NEW);
    expect(generous.segments).toContain(HEAD_NEW2);
  });

  it('時間戳被壓縮也照樣去重：這是換掉時間比對的全部理由', () => {
    // 舊做法看 coveredUntil = min(existing 最後的 end, sliceStart + 15)。
    // 這裡 existing 最後一段的 end 是 262，而 incoming 從 600 開始，
    // 舊規則算出 coveredUntil = 262，incoming 全部放行，同一段話進去兩次
    const incoming = [HEAD_DUP, HEAD_DUP2, HEAD_NEW];
    const result = mergeSliceTranscript(TAIL, incoming, 600, false);
    expect(TAIL[TAIL.length - 1].end).toBeLessThan(incoming[0].start - 300);
    expect(result.seam?.verdict).toBe('duplicate');
    expect(result.segments).toEqual([...TAIL, HEAD_DUP2, HEAD_NEW]);
  });

  it('接縫對不上時全部接上，判定是 gap：那代表有一片沒轉完，呼叫端要講出去', () => {
    const incoming = [
      seg(1800.0, 1801.7, '那倉儲那邊呢。'),
      seg(1801.7, 1805.4, '棧板的數量從上個月開始就一直不夠用。'),
      seg(1805.4, 1810.3, '採購說最快也要月底才補得到貨,中間這段只能先調度。'),
    ];
    const result = mergeSliceTranscript(TAIL, incoming, 1800, false);
    expect(result.seam?.verdict).toBe('gap');
    expect(result.segments).toEqual([...TAIL, ...incoming]);
  });

  it('判不出來時全部接上：寧可留一小段重複，不可掉字', () => {
    const result = mergeSliceTranscript([seg(0, 1, '對。')], [seg(1, 2, '嗯。')], 0, false);
    expect(result.seam?.verdict).toBe('inconclusive');
    expect(result.segments).toHaveLength(2);
  });

  it('接縫之外真的重複說的話不會被砍掉', () => {
    const existing = [seg(100, 104, '那我們就照這個方向走，下週再對一次進度好嗎。')];
    const incoming = [
      seg(104, 108, '好，那先講第二件事情，關於報價的部分。'),
      seg(108, 112, '那我們就照這個方向走，下週再對一次進度好嗎。'),
    ];
    const result = mergeSliceTranscript(existing, incoming, 104, false);
    expect(result.segments).toEqual([...existing, ...incoming]);
  });

  it('SLICE_OVERLAP_SECONDS 仍是 15：planSlices 靠它切出重疊區，沒有重疊就沒有可對齊的內容', () => {
    expect(SLICE_OVERLAP_SECONDS).toBe(15);
  });

  it('不 mutate 輸入陣列', () => {
    const existing = TAIL.map(s => ({ ...s }));
    const incoming = [HEAD_DUP, HEAD_NEW].map(s => ({ ...s }));
    const existingSnapshot = JSON.stringify(existing);
    const incomingSnapshot = JSON.stringify(incoming);
    const result = mergeSliceTranscript(existing, incoming, 600, false);
    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
    expect(result.segments).not.toBe(existing);
  });
});

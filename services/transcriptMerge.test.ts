import { describe, it, expect } from 'vitest';
import { mergeSliceTranscript, SLICE_OVERLAP_SECONDS } from './transcriptMerge';
import { TranscriptSegment } from '../types';

const seg = (start: number, end: number, text: string): TranscriptSegment => ({ start, end, text, speaker: 'A' });

describe('mergeSliceTranscript', () => {
  it('第一片全收，不過濾', () => {
    const incoming = [seg(0, 4, 'a'), seg(4, 9, 'b'), seg(9, 14, 'c')];
    expect(mergeSliceTranscript([], incoming, 0, true)).toEqual([
      seg(0, 4, 'a'), seg(4, 9, 'b'), seg(9, 14, 'c')
    ]);
  });

  it('第一片即使 existing 非空也全部接上', () => {
    const existing = [seg(0, 3, 'x')];
    const incoming = [seg(1, 2, 'y')];
    expect(mergeSliceTranscript(existing, incoming, 0, true)).toEqual([
      seg(0, 3, 'x'), seg(1, 2, 'y')
    ]);
  });

  it('第二片裡 end 落在 coveredUntil + tolerance 之內的段落被丟', () => {
    // 第一片涵蓋到 615 秒（600 + 15 秒 overlap），第二片從 600 開始
    const existing = [seg(590, 600, 'p'), seg(600, 608, 'q'), seg(608, 615, 'r')];
    const incoming = [
      seg(600, 608, 'q-dup'),   // end 608 <= 615.5，丟
      seg(608, 615, 'r-dup'),   // end 615 <= 615.5，丟
      seg(615, 615.5, 'edge'),  // end 615.5 <= 615.5，丟（邊界含等號）
      seg(615.5, 620, 's'),     // end 620 > 615.5，留
      seg(620, 630, 't')
    ];
    expect(mergeSliceTranscript(existing, incoming, 600, false)).toEqual([
      seg(590, 600, 'p'), seg(600, 608, 'q'), seg(608, 615, 'r'),
      seg(615.5, 620, 's'), seg(620, 630, 't')
    ]);
  });

  it('start 早於 coveredUntil 但 end 超過 tolerance 的段落保留', () => {
    const existing = [seg(600, 612, 'q')];
    const incoming = [seg(610, 618, 'straddle'), seg(618, 625, 'next')];
    expect(mergeSliceTranscript(existing, incoming, 600, false)).toEqual([
      seg(600, 612, 'q'), seg(610, 618, 'straddle'), seg(618, 625, 'next')
    ]);
  });

  it('existing 為空的非第一片以 sliceStartTime 當 coveredUntil', () => {
    const incoming = [seg(598, 600.4, 'before'), seg(600, 600.5, 'edge'), seg(600.2, 603, 'after')];
    expect(mergeSliceTranscript([], incoming, 600, false)).toEqual([
      seg(600.2, 603, 'after')
    ]);
  });

  it('tolerance 可自訂', () => {
    const existing = [seg(0, 10, 'a')];
    const incoming = [seg(9, 11, 'b'), seg(11, 13, 'c')];
    expect(mergeSliceTranscript(existing, incoming, 0, false, 2)).toEqual([
      seg(0, 10, 'a'), seg(11, 13, 'c')
    ]);
  });

  it('existing 最後一段 end 超過 overlap 區時，coveredUntil 以 sliceStartTime + overlapSeconds 為上限', () => {
    // 前一片 LLM 時間戳高估到 640（sliceStart 600 + 40，超過 overlap 15），不能拿 640 當 coveredUntil
    const existing = [seg(600, 640, 'overshoot')];
    const incoming = [
      seg(600, 612, 'in-overlap'),  // end 612 <= 615.5，丟
      seg(612, 620, 'must-keep'),   // end 620 > 615.5，留（舊規則會因 620 <= 640.5 掉字）
      seg(620, 630, 'next')
    ];
    expect(mergeSliceTranscript(existing, incoming, 600, false)).toEqual([
      seg(600, 640, 'overshoot'), seg(612, 620, 'must-keep'), seg(620, 630, 'next')
    ]);
  });

  it('existing 最後一段 end 在 overlap 區內時，行為跟原本一樣', () => {
    const existing = [seg(600, 610, 'short')];
    const incoming = [
      seg(600, 605, 'dup'),        // end 605 <= 610.5，丟
      seg(605, 610.5, 'edge'),     // end 610.5 <= 610.5，丟
      seg(610, 614, 'keep'),       // end 614 > 610.5，留
      seg(614, 620, 'next')
    ];
    expect(mergeSliceTranscript(existing, incoming, 600, false)).toEqual([
      seg(600, 610, 'short'), seg(610, 614, 'keep'), seg(614, 620, 'next')
    ]);
  });

  it('overlapSeconds 可自訂', () => {
    const existing = [seg(600, 640, 'overshoot')];
    const incoming = [seg(600, 630, 'a'), seg(630, 636, 'b')];
    expect(mergeSliceTranscript(existing, incoming, 600, false, 0.5, 30)).toEqual([
      seg(600, 640, 'overshoot'), seg(630, 636, 'b')
    ]);
  });

  it('overlapSeconds 預設值就是 SLICE_OVERLAP_SECONDS（15），省略第 6 參數跟明傳 15 一樣', () => {
    // 常數被改值或 default 沒接上常數時，這條會壞；planSlices 與 transcriptionPipeline 都靠這個值對齊
    expect(SLICE_OVERLAP_SECONDS).toBe(15);

    const existing = [seg(600, 640, 'overshoot')];
    const incoming = [
      seg(600, 612, 'in-overlap'),  // end 612 <= 600 + 15 + 0.5，丟
      seg(612, 620, 'must-keep'),
      seg(620, 630, 'next')
    ];
    const expected = [
      seg(600, 640, 'overshoot'), seg(612, 620, 'must-keep'), seg(620, 630, 'next')
    ];
    expect(mergeSliceTranscript(existing, incoming, 600, false)).toEqual(expected);
    expect(mergeSliceTranscript(existing, incoming, 600, false, 0.5, 15)).toEqual(expected);
  });

  it('不 mutate 輸入陣列', () => {
    const existing = [seg(0, 10, 'a')];
    const incoming = [seg(5, 10, 'dup'), seg(10, 15, 'b')];
    const existingSnapshot = JSON.stringify(existing);
    const incomingSnapshot = JSON.stringify(incoming);
    const result = mergeSliceTranscript(existing, incoming, 0, false);
    expect(result).toEqual([seg(0, 10, 'a'), seg(10, 15, 'b')]);
    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(2);
    expect(result).not.toBe(existing);
  });
});

import { describe, it, expect } from 'vitest';
import { mergeSliceTranscript } from './transcriptMerge';
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

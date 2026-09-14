import { describe, it, expect, vi } from 'vitest';
import { normalizeTranscribedSegments } from './transcribeSegments';

describe('normalizeTranscribedSegments', () => {
  it('沒給 sliceDurationSeconds 時不夾，只加 offset', () => {
    expect(
      normalizeTranscribedSegments(
        [{ start: 2, end: 900, text: 'a', speaker: 'Speaker 2' }],
        600
      )
    ).toEqual([{ start: 602, end: 1500, text: 'a', speaker: 'Speaker 2' }]);
  });

  it('end 超過切片長度被夾到切片長度', () => {
    expect(
      normalizeTranscribedSegments([{ start: 1, end: 900, text: 'a', speaker: 'Speaker 1' }], 0, 615)
    ).toEqual([{ start: 1, end: 615, text: 'a', speaker: 'Speaker 1' }]);
  });

  it('start 超過 end 被夾到 end', () => {
    expect(
      normalizeTranscribedSegments([{ start: 700, end: 900, text: 'a', speaker: 'Speaker 1' }], 0, 615)
    ).toEqual([{ start: 615, end: 615, text: 'a', speaker: 'Speaker 1' }]);
  });

  it('負值被夾到 0', () => {
    expect(
      normalizeTranscribedSegments([{ start: -5, end: -1, text: 'a', speaker: 'Speaker 1' }], 0, 615)
    ).toEqual([{ start: 0, end: 0, text: 'a', speaker: 'Speaker 1' }]);
  });

  it('start 負值、end 正常時只夾 start', () => {
    expect(
      normalizeTranscribedSegments([{ start: -3, end: 10, text: 'a', speaker: 'Speaker 1' }], 0, 615)
    ).toEqual([{ start: 0, end: 10, text: 'a', speaker: 'Speaker 1' }]);
  });

  it('start/end 不是數字時沿用既有預設：start→offset、end→offset+5', () => {
    expect(
      normalizeTranscribedSegments([{ text: 'a' }, { start: '3', end: null, text: 'b' }], 600)
    ).toEqual([
      { start: 600, end: 605, text: 'a', speaker: 'Speaker 1' },
      { start: 600, end: 605, text: 'b', speaker: 'Speaker 1' },
    ]);
  });

  it('start/end 不是數字且有切片長度時，預設值一樣是 offset 與 offset+5', () => {
    expect(normalizeTranscribedSegments([{ text: 'a' }], 600, 615)).toEqual([
      { start: 600, end: 605, text: 'a', speaker: 'Speaker 1' },
    ]);
  });

  it('offset 在 clamp 之後才加，不會把 offset 也夾掉', () => {
    expect(
      normalizeTranscribedSegments(
        [{ start: 10, end: 20, text: 'a', speaker: 'Speaker 1' }, { start: 610, end: 900, text: 'b', speaker: 'Speaker 1' }],
        600,
        615
      )
    ).toEqual([
      { start: 610, end: 620, text: 'a', speaker: 'Speaker 1' },
      { start: 1210, end: 1215, text: 'b', speaker: 'Speaker 1' },
    ]);
  });

  it('text/speaker 缺漏時補預設值', () => {
    expect(normalizeTranscribedSegments([{ start: 0, end: 1 }, { start: 0, end: 1, text: '', speaker: '' }], 0)).toEqual([
      { start: 0, end: 1, text: '', speaker: 'Speaker 1' },
      { start: 0, end: 1, text: '', speaker: 'Speaker 1' },
    ]);
  });

  it('sliceDurationSeconds 不是有限正數時視同沒給並警告一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of [0, -1, NaN, Infinity, '615' as unknown as number, null as unknown as number]) {
        warn.mockClear();
        expect(
          normalizeTranscribedSegments([{ start: 1, end: 900, text: 'a', speaker: 'Speaker 1' }], 0, bad)
        ).toEqual([{ start: 1, end: 900, text: 'a', speaker: 'Speaker 1' }]);
        expect(warn).toHaveBeenCalledTimes(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('空陣列回空陣列', () => {
    expect(normalizeTranscribedSegments([], 600, 615)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { classify, score } from './metrics';
import type { GoldPair, PairVerdict } from './types';

const verdict = (a: string, b: string, same: boolean): PairVerdict => ({
  a,
  b,
  same,
  score: same ? 1 : 0,
  evidence: 'test',
});

const gold = (a: string, b: string, label: GoldPair['label']): GoldPair => ({ a, b, label, note: 'test' });

describe('score', () => {
  it('把四個象限各算一次', () => {
    const result = score(
      [verdict('A', 'B', true), verdict('A', 'C', true), verdict('B', 'C', false), verdict('C', 'D', false)],
      [gold('A', 'B', 'same'), gold('A', 'C', 'different'), gold('B', 'C', 'different'), gold('C', 'D', 'same')],
    );
    expect(result).toMatchObject({ truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1 });
    expect(result.precision).toBeCloseTo(0.5);
    expect(result.recall).toBeCloseTo(0.5);
    expect(result.f1).toBeCloseTo(0.5);
    expect(result.evaluated).toBe(4);
  });

  it('unknown 的 pair 不列入指標，只計數', () => {
    const result = score(
      [verdict('A', 'B', true), verdict('A', 'C', true)],
      [gold('A', 'B', 'same'), gold('A', 'C', 'unknown')],
    );
    expect(result.evaluated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.truePositive).toBe(1);
    expect(result.falsePositive).toBe(0);
  });

  it('沒有任何正判定時 precision 是 null 不是 0', () => {
    const result = score([verdict('A', 'B', false)], [gold('A', 'B', 'same')]);
    expect(result.precision).toBeNull();
    expect(result.recall).toBe(0);
    expect(result.f1).toBeNull();
  });

  it('評測集沒有正例時 recall 是 null 不是 0', () => {
    const result = score([verdict('A', 'B', false)], [gold('A', 'B', 'different')]);
    expect(result.recall).toBeNull();
  });

  it('pair 的順序顛倒仍然對得上黃金答案', () => {
    const result = score([verdict('B', 'A', true)], [gold('A', 'B', 'same')]);
    expect(result.truePositive).toBe(1);
  });

  it('黃金答案缺該 pair 時直接爆，不默默跳過', () => {
    expect(() => score([verdict('A', 'Z', true)], [gold('A', 'B', 'same')])).toThrow(/黃金答案缺少 pair/);
  });
});

describe('classify', () => {
  it('逐筆標上 TP / FP / TN / FN / SKIP', () => {
    const rows = classify(
      [verdict('A', 'B', true), verdict('A', 'C', true), verdict('B', 'C', false), verdict('C', 'D', false), verdict('D', 'E', true)],
      [
        gold('A', 'B', 'same'),
        gold('A', 'C', 'different'),
        gold('B', 'C', 'different'),
        gold('C', 'D', 'same'),
        gold('D', 'E', 'unknown'),
      ],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['TP', 'FP', 'TN', 'FN', 'SKIP']);
  });
});

import type { GoldPair, Metrics, PairVerdict } from './types';

const pairKey = (a: string, b: string) => [a, b].sort().join('|');

/**
 * 對照黃金答案算指標。label 為 unknown 的 pair 不列入計算，只計數。
 *
 * 分母為 0 時回傳 null 而不是 0：沒有正例可找時 recall 不是「零召回」，是「算不出來」。
 * 兩者混在一起會讓「策略很爛」和「評測集沒有正例」在報表上長得一樣。
 */
export function score(verdicts: PairVerdict[], gold: GoldPair[]): Metrics {
  const goldByPair = new Map(gold.map((g) => [pairKey(g.a, g.b), g]));

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let skipped = 0;

  for (const v of verdicts) {
    const g = goldByPair.get(pairKey(v.a, v.b));
    if (!g) throw new Error(`黃金答案缺少 pair：${v.a} / ${v.b}`);
    if (g.label === 'unknown') {
      skipped += 1;
      continue;
    }
    const expected = g.label === 'same';
    if (v.same && expected) tp += 1;
    else if (v.same && !expected) fp += 1;
    else if (!v.same && !expected) tn += 1;
    else fn += 1;
  }

  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    precision,
    recall,
    f1,
    evaluated: tp + fp + tn + fn,
    skipped,
  };
}

/** 把指標裡的每個 pair 標成 TP / FP / TN / FN，給逐筆檢視用。 */
export function classify(
  verdicts: PairVerdict[],
  gold: GoldPair[],
): { verdict: PairVerdict; gold: GoldPair; outcome: 'TP' | 'FP' | 'TN' | 'FN' | 'SKIP' }[] {
  const goldByPair = new Map(gold.map((g) => [pairKey(g.a, g.b), g]));
  return verdicts.map((verdict) => {
    const g = goldByPair.get(pairKey(verdict.a, verdict.b));
    if (!g) throw new Error(`黃金答案缺少 pair：${verdict.a} / ${verdict.b}`);
    let outcome: 'TP' | 'FP' | 'TN' | 'FN' | 'SKIP';
    if (g.label === 'unknown') outcome = 'SKIP';
    else if (verdict.same && g.label === 'same') outcome = 'TP';
    else if (verdict.same) outcome = 'FP';
    else if (g.label === 'different') outcome = 'TN';
    else outcome = 'FN';
    return { verdict, gold: g, outcome };
  });
}

export function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

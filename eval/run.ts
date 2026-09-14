/**
 * U-001 離線評測的進入點。
 *
 *   npx tsx eval/run.ts                            # manual：人工標註的 Topic Tag，只跑 S1
 *   npx tsx eval/run.ts auto --with-api            # auto：analyze.ts 產出的（先跑 analyze.ts）
 *   npx tsx eval/run.ts tagged --with-api          # tagged：extract-tags.ts 產出的（先跑 extract-tags.ts）
 *
 * 刻意不預設及格門檻：這支程式只產出數字與逐筆判定依據，門檻由人看完數字再定。
 * 理由在 vault 的 plan：U-001 的關閉條件需要門檻，門檻（U-009）又需要 baseline，
 * 兩者互為前置，只能靠「先量、後裁決」切開。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { classify, formatMetric, score } from './lib/metrics';
import type { EvalMeeting, GoldPair, MeetingTopics, Strategy } from './lib/types';
import { ExactMatchStrategy, StringMatchStrategy } from './strategies/s1-string';
import { EmbeddingStrategy } from './strategies/s2-embedding';
import { LlmJudgeStrategy } from './strategies/s3-llm';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 三種 Topic Tag 來源，對應三個要分開看的問題：
 * - manual：人工判讀。它是上界參考，而且因為標籤與黃金答案出自同一次判讀，字面比對類的策略會被送分
 * - auto：沿用 server.ts `analyze` 的 prompt，代表「現況」
 * - tagged：專為跨會議比對設計的 prompt（extract-tags.ts），代表「改了段 A 之後」
 */
const TAG_SOURCES = {
  manual: { path: 'eval-data/topics.manual.json', label: 'manual（人工判讀）' },
  auto: { path: 'eval-data/topics.auto.json', label: 'auto（沿用 analyze 的 prompt）' },
  tagged: { path: 'eval-data/topics.tagged.json', label: 'tagged（為比對設計的 prompt）' },
} as const;
type TagSource = keyof typeof TAG_SOURCES;

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function allPairs(meetings: EvalMeeting[]): { a: string; b: string }[] {
  const out: { a: string; b: string }[] = [];
  for (let i = 0; i < meetings.length; i += 1) {
    for (let j = i + 1; j < meetings.length; j += 1) {
      out.push({ a: meetings[i].id, b: meetings[j].id });
    }
  }
  return out;
}

async function main() {
  const requested = process.argv.slice(2).find((arg) => arg in TAG_SOURCES) as TagSource | undefined;
  const source = TAG_SOURCES[requested ?? 'manual'];

  const meetings = readJson<EvalMeeting[]>(resolve(ROOT, 'eval/meetings.json'));
  const gold = readJson<GoldPair[]>(resolve(ROOT, 'eval/gold.json'));
  const topics = readJson<MeetingTopics[]>(resolve(ROOT, source.path));

  const pairs = allPairs(meetings);
  if (gold.length !== pairs.length) {
    throw new Error(`黃金答案有 ${gold.length} 筆，但 ${meetings.length} 場會應該有 ${pairs.length} 個 pair`);
  }

  const positives = gold.filter((g) => g.label === 'same').length;
  const negatives = gold.filter((g) => g.label === 'different').length;
  const unknowns = gold.filter((g) => g.label === 'unknown').length;

  console.log('=== U-001 關聯可行性評測 ===');
  console.log(`Topic Tag 來源：${source.label}`);
  console.log(`會議 ${meetings.length} 場、pair ${pairs.length} 個：正例 ${positives}、負例 ${negatives}、unknown ${unknowns}`);
  console.log(`每場會的標籤數：${topics.map((t) => `${t.meetingId}=${t.tags.length}`).join('、')}`);
  console.log('');

  const withApi = process.argv.includes('--with-api');

  const strategies: Strategy[] = [new ExactMatchStrategy()];
  for (const tagThreshold of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    for (const minHits of [1, 2, 3]) {
      strategies.push(new StringMatchStrategy(tagThreshold, minHits));
    }
  }

  if (withApi) {
    await EmbeddingStrategy.warm(topics);
    for (const tagThreshold of [0.6, 0.7, 0.75, 0.8, 0.85]) {
      for (const minHits of [1, 2, 3]) {
        strategies.push(new EmbeddingStrategy(tagThreshold, minHits));
      }
    }
    for (const confidence of [0.5, 0.7, 0.9]) {
      strategies.push(new LlmJudgeStrategy(confidence));
    }
  } else {
    console.log('（只跑 S1。S2 與 S3 需要 GEMINI_API_KEY，加 --with-api 才會執行）');
    console.log('');
  }

  const rows: string[] = [];
  const detailed: { id: string; lines: string[] }[] = [];

  for (const strategy of strategies) {
    const verdicts = await strategy.run(topics, pairs);
    const metrics = score(verdicts, gold);
    rows.push(
      [
        strategy.id.padEnd(24),
        `P=${formatMetric(metrics.precision)}`,
        `R=${formatMetric(metrics.recall)}`,
        `F1=${formatMetric(metrics.f1)}`,
        `TP=${metrics.truePositive} FP=${metrics.falsePositive} TN=${metrics.trueNegative} FN=${metrics.falseNegative}`,
      ].join('  '),
    );

    const lines = classify(verdicts, gold)
      .filter((row) => row.outcome === 'FP' || row.outcome === 'FN' || row.outcome === 'TP')
      .map(
        (row) =>
          `  [${row.outcome}] ${row.verdict.a}×${row.verdict.b}  ${row.verdict.evidence}` +
          (row.outcome === 'FN' ? `\n         黃金答案：${row.gold.note}` : ''),
      );
    detailed.push({ id: strategy.id, lines });
  }

  console.log('--- 指標總表（門檻掃描）---');
  for (const row of rows) console.log(row);

  console.log('');
  console.log('--- 逐筆判定依據（只列 TP / FP / FN）---');
  for (const entry of detailed) {
    console.log(`${entry.id}`);
    if (entry.lines.length === 0) {
      console.log('  （全部判為不相關，沒有命中任何正例）');
    } else {
      for (const line of entry.lines) console.log(line);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

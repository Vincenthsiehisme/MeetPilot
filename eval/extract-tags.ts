/**
 * 段 A 的第二版：專為「可跨會議比對」設計的 Topic Tag 抽取。
 *
 *   npx tsx --env-file-if-exists=.env eval/extract-tags.ts
 *
 * 為什麼要另寫一支：`analyze.ts` 沿用 server.ts 的 systemInstruction，那個 prompt 的
 * 用途是產出給人看的會議記錄，一場會概括成 3 到 5 個大議題就夠。2026-09-14 實測
 * 證明那個粒度下三個策略全都認不出跨會議的同一題目——不是策略不行，是抽象標題裡
 * 根本沒有可比對的東西（M1 與 M4 實際有十條逐條對應，各自卻被壓成三個抽象標題）。
 *
 * 這支的 prompt 只描述「什麼樣的標籤可以拿來比對」，不描述任何一場會的內容，
 * 也不照抄人工判讀的清單，避免把評測集的答案洩進抽取端。
 */
import { Type } from '@google/genai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ANALYZE_MODELS, cleanJsonString, requireClient } from './lib/client';
import type { EvalMeeting, MeetingTopics } from './lib/types';

const ROOT = resolve(import.meta.dirname, '..');
const TRANSCRIPT_DIR = resolve(ROOT, 'eval-data/transcripts');
const CACHE_DIR = resolve(ROOT, 'eval-data/tags');
const OUT = resolve(ROOT, 'eval-data/topics.tagged.json');

const SYSTEM_INSTRUCTION = `你要從會議逐字稿抽出「題目標籤」。這些標籤的唯一用途是拿去跨會議比對，找出不同場會議在討論同一件事。

這跟整理會議記錄不同。會議記錄要概括，一場會三到五個大項就夠；題目標籤要具體，因為兩場會的重疊往往只落在其中一兩個細項上，概括掉就比不出來了。

規則：

1. 一個標籤代表一件具體的事：一個待決事項、一個系統或流程、一個規則、一個對象。
2. 不要把兩件事綁進同一個標籤。「A 與 B」這種標題會讓比對失效，該拆成兩個。
3. 標籤要能離開這場會被讀懂。不要用只有在場的人才知道指什麼的代稱。
4. 涵蓋整場會，包含只討論幾分鐘但有具體內容的事。
5. 數量通常落在 15 到 25 之間。很短的會議可以少，但不要為了湊數把一件事拆成兩件。
6. 逐字稿可能有同音錯字與語意破碎的段落。看得出是什麼就用正確的寫法，看不出來就跳過那一段，不要猜。

每個標籤附一句 content，寫這件事在這場會裡的具體內容：有哪些選項、決定了什麼、卡在哪。

回傳純 JSON，不要 Markdown 標記。`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tags: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          content: { type: Type.STRING },
        },
        required: ['title', 'content'],
      },
    },
  },
  required: ['tags'],
} as const;

interface ExtractResult {
  tags: { title: string; content: string }[];
}

function loadTranscript(meeting: EvalMeeting): string {
  return meeting.sources
    .map((name) => {
      const path = resolve(TRANSCRIPT_DIR, name);
      if (!existsSync(path)) throw new Error(`找不到逐字稿：${path}`);
      return readFileSync(path, 'utf-8').trim();
    })
    .join('\n\n');
}

async function extractOne(meeting: EvalMeeting, transcript: string): Promise<ExtractResult> {
  const ai = requireClient();
  let lastError: unknown;
  for (const model of ANALYZE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `會議逐字稿：\n${transcript}`,
        config: {
          maxOutputTokens: 8192,
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      const parsed = JSON.parse(cleanJsonString(response.text)) as ExtractResult;
      if (!Array.isArray(parsed.tags) || parsed.tags.length === 0) {
        throw new Error(`${meeting.id} 抽取回傳的 tags 是空的`);
      }
      console.log(`  ${meeting.id}：${model} 抽出 ${parsed.tags.length} 個標籤`);
      return parsed;
    } catch (err) {
      lastError = err;
      console.warn(`  ${meeting.id}：${model} 失敗，換下一個 — ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`${meeting.id} 的抽取在所有 model 上都失敗：${lastError instanceof Error ? lastError.message : lastError}`);
}

async function main() {
  const meetings: EvalMeeting[] = JSON.parse(readFileSync(resolve(ROOT, 'eval/meetings.json'), 'utf-8'));
  mkdirSync(CACHE_DIR, { recursive: true });

  const out: MeetingTopics[] = [];
  for (const meeting of meetings) {
    const cachePath = resolve(CACHE_DIR, `${meeting.id}.json`);
    let result: ExtractResult;
    if (existsSync(cachePath)) {
      console.log(`  ${meeting.id}：用快取 ${cachePath}`);
      result = JSON.parse(readFileSync(cachePath, 'utf-8')) as ExtractResult;
    } else {
      const transcript = loadTranscript(meeting);
      console.log(`  ${meeting.id}：${meeting.sources.length} 個檔、${transcript.length} 字元`);
      result = await extractOne(meeting, transcript);
      writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf-8');
    }
    out.push({
      meetingId: meeting.id,
      tags: result.tags.map((t) => ({ title: t.title, content: t.content, source: 'auto' as const })),
    });
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n寫入 ${OUT}`);
  console.log(`每場會的標籤數：${out.map((o) => `${o.meetingId}=${o.tags.length}`).join('、')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

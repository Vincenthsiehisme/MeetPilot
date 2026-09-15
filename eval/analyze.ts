/**
 * 段 A：Transcript → Topic Tag。
 *
 *   npx tsx --env-file-if-exists=.env eval/analyze.ts
 *
 * 沿用正式分析路徑的 systemInstruction 與 responseSchema，所以它測的是「現在這套分析出來的
 * 標籤能不能拿來關聯」，不是另一套為評測調過的 prompt。
 *
 * **正本在 `services/geminiServerClient.ts` 的 `analyzeTranscript`**（W2 之後；在那之前是
 * `server.ts` 的 `/api/gemini/analyze`，那條路由已經隨前端搬到 server 而刪除）。
 * 下面這份是複本，兩邊會各自漂移，而這支評測的意義正是「測現在這套 prompt」——
 * 改動正本時要同一次改這裡，或把它換成 import 同一份常數。
 *
 * 同一場會的多個音檔（錄音被切斷）在這裡依序串接成一份逐字稿再送出。這是 SDD D-001
 * 「最小工作單元是 Meeting 不是 Job」在評測端的落實：不合併的話，同一場會會變成兩個
 * 互相極度相關的「會議」，把每個策略的 precision 一起灌高。
 */
import { Type } from '@google/genai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ANALYZE_MODELS, cleanJsonString, requireClient } from './lib/client';
import type { EvalMeeting, MeetingTopics } from './lib/types';

const ROOT = resolve(import.meta.dirname, '..');
const TRANSCRIPT_DIR = resolve(ROOT, 'eval-data/transcripts');
const CACHE_DIR = resolve(ROOT, 'eval-data/analysis');
const OUT = resolve(ROOT, 'eval-data/topics.auto.json');

const SYSTEM_INSTRUCTION = `
你是一位專業的會議記錄師。請忽略流水帳式的摘要，改為「以議題為導向」的結構化整理。

你需要產出以下 JSON 格式：
1. **overview**: 用一句話概括整場會議的核心主旨。
2. **topics**: 識別會議中討論的數個具體議題。針對每個議題，請撰寫詳細的內容整理，包含討論過程中的關鍵觀點。
3. **decisions**: 會議中明確達成的所有決議。
4. **action_items**: 後續需要執行的行動項目與負責人。

請直接回傳純 JSON，不要包含 Markdown 標記。`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING },
    topics: {
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
    decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
    action_items: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['overview', 'topics', 'decisions', 'action_items'],
} as const;

interface AnalysisResult {
  overview: string;
  topics: { title: string; content: string }[];
  decisions: string[];
  action_items: string[];
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

async function analyzeOne(meeting: EvalMeeting, transcript: string): Promise<AnalysisResult> {
  const ai = requireClient();
  let lastError: unknown;
  for (const model of ANALYZE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `請將這份會議記錄整理成結構化的「議題討論紀錄」。
這是一份逐字稿，可能包含口語贅字。請在分析時自動進行潤飾與歸納。
請根據對話內容，產出「繁體中文」的分析報告。

會議記錄內容：
${transcript}`,
        config: {
          maxOutputTokens: 8192,
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      const parsed = JSON.parse(cleanJsonString(response.text)) as AnalysisResult;
      if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
        throw new Error(`${meeting.id} 分析回傳的 topics 是空的`);
      }
      console.log(`  ${meeting.id}：${model} 產出 ${parsed.topics.length} 個議題`);
      return parsed;
    } catch (err) {
      lastError = err;
      console.warn(`  ${meeting.id}：${model} 失敗，換下一個 — ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`${meeting.id} 的分析在所有 model 上都失敗：${lastError instanceof Error ? lastError.message : lastError}`);
}

async function main() {
  const meetings: EvalMeeting[] = JSON.parse(readFileSync(resolve(ROOT, 'eval/meetings.json'), 'utf-8'));
  mkdirSync(CACHE_DIR, { recursive: true });

  const out: MeetingTopics[] = [];
  for (const meeting of meetings) {
    const cachePath = resolve(CACHE_DIR, `${meeting.id}.json`);
    let analysis: AnalysisResult;
    if (existsSync(cachePath)) {
      console.log(`  ${meeting.id}：用快取 ${cachePath}`);
      analysis = JSON.parse(readFileSync(cachePath, 'utf-8')) as AnalysisResult;
    } else {
      const transcript = loadTranscript(meeting);
      console.log(`  ${meeting.id}：${meeting.sources.length} 個檔、${transcript.length} 字元`);
      analysis = await analyzeOne(meeting, transcript);
      writeFileSync(cachePath, JSON.stringify(analysis, null, 2), 'utf-8');
    }
    out.push({
      meetingId: meeting.id,
      tags: analysis.topics.map((t) => ({ title: t.title, content: t.content, source: 'auto' as const })),
    });
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n寫入 ${OUT}`);
  console.log(`每場會的議題數：${out.map((o) => `${o.meetingId}=${o.tags.length}`).join('、')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

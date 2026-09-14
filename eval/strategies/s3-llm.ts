import { Type } from '@google/genai';

import { ANALYZE_MODELS, cleanJsonString, requireClient } from '../lib/client';
import type { MeetingTopics, PairVerdict, Strategy } from '../lib/types';

/**
 * S3：把兩場會的題目清單交給 Gemini，直接問它們有沒有在討論同一個題目。
 *
 * 成本最高的一個：每新增一場會就要對全部歷史各跑一次，總量隨會議數平方成長
 * （SDD 6.4 已經標過這條）。所以它要贏 S1、S2 夠多，才值得為它付這個成本。
 *
 * 回傳帶理由與信心值。理由那一欄是三個策略裡唯一能讓人直接看懂它為什麼判錯的東西。
 */
interface JudgeResult {
  sameTopic: boolean;
  confidence: number;
  reason: string;
  sharedTopics: string[];
}

export class LlmJudgeStrategy implements Strategy {
  readonly id: string;
  /**
   * 判定結果按 pair 快取。掃信心門檻時同一個 pair 的判定不該重打 API：
   * 門檻是在結果上過濾，不是換一個問題。沒有這層快取，掃 N 個門檻就是 N 倍成本，
   * 而 S3 本來就是三個策略裡最貴的一個。
   */
  private static cache = new Map<string, JudgeResult>();

  constructor(private readonly confidenceThreshold: number) {
    this.id = `S3(conf>=${confidenceThreshold})`;
  }

  describe(): string {
    return `Gemini 兩兩判定，信心值 >= ${this.confidenceThreshold} 才算同題目`;
  }

  async run(topics: MeetingTopics[], pairs: { a: string; b: string }[]): Promise<PairVerdict[]> {
    const ai = requireClient();
    const byId = new Map(topics.map((t) => [t.meetingId, t]));
    const listOf = (meetingId: string) => {
      const entry = byId.get(meetingId);
      if (!entry) throw new Error(`找不到 ${meetingId} 的 Topic Tag`);
      return entry.tags.map((tag, i) => `${i + 1}. ${tag.title}${tag.content ? `：${tag.content}` : ''}`).join('\n');
    };

    const out: PairVerdict[] = [];
    for (const { a, b } of pairs) {
      const cacheKey = [a, b].sort().join('|');
      let result = LlmJudgeStrategy.cache.get(cacheKey);
      if (!result) {
        result = await this.judge(ai, a, listOf(a), b, listOf(b));
        LlmJudgeStrategy.cache.set(cacheKey, result);
      }
      out.push({
        a,
        b,
        same: result.sameTopic && result.confidence >= this.confidenceThreshold,
        score: result.confidence,
        evidence: `信心 ${result.confidence.toFixed(2)}｜${result.reason}${
          result.sharedTopics.length > 0 ? `｜共同題目：${result.sharedTopics.join('、')}` : ''
        }`,
      });
    }
    return out;
  }

  private async judge(
    ai: ReturnType<typeof requireClient>,
    idA: string,
    listA: string,
    idB: string,
    listB: string,
  ): Promise<JudgeResult> {
    let lastError: unknown;
    for (const model of ANALYZE_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: `會議 ${idA} 討論的題目：
${listA}

會議 ${idB} 討論的題目：
${listB}`,
          config: {
            maxOutputTokens: 2048,
            systemInstruction: `你要判斷兩場會議有沒有在討論「同一個題目」。

判準：
- 同一個題目指的是同一件待決事項、同一個系統或流程、同一個對象。用詞不同不影響判定。
- 只是同屬一個大領域（例如都跟 AI 有關、都跟業務有關）不算同一個題目。
- 一方只順口提過一句、沒有實質討論的，不算。

請回傳 JSON：sameTopic（布林）、confidence（0 到 1）、reason（一句話，繁體中文）、sharedTopics（共同題目的名稱陣列，沒有就空陣列）。`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                sameTopic: { type: Type.BOOLEAN },
                confidence: { type: Type.NUMBER },
                reason: { type: Type.STRING },
                sharedTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['sameTopic', 'confidence', 'reason', 'sharedTopics'],
            },
          },
        });
        return JSON.parse(cleanJsonString(response.text));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `${idA} × ${idB} 的判定在所有 model 上都失敗：${lastError instanceof Error ? lastError.message : lastError}`,
    );
  }
}

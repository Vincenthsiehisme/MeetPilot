/**
 * Gemini 呼叫的共用出口（W2 T1）。
 *
 * 為什麼要從 server.ts 抽出來：轉錄鏈搬到 server 之後，切片轉錄與整份分析有兩個呼叫端
 * ——前端仍在用的 `/api/gemini/*` 路由，以及 server 內部的 transcriptionPipeline。
 * 兩邊各自寫一份 prompt 與 fallback 鏈的話，改了一邊沒改另一邊不會有任何錯誤，
 * 只會變成「從畫面跑的結果」跟「從 server 跑的結果」不一樣，而那種差異沒有人會發現。
 *
 * 這個檔是搬家不是改寫：prompt、responseSchema、fallback 鏈、錯誤訊息與紀錄欄位
 * 全部照 server.ts 原樣搬過來，路由那邊只剩參數檢查與 res 的形狀。
 */
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { GeminiOutput, TranscriptSegment } from '../types';
import { normalizeTranscribedSegments } from './transcribeSegments';
import { LlmCallKind, LlmLogger } from './llmTelemetry';
import { PairJudgement } from './topicLink';

// Lazy GoogleGenAI client
let aiClient: GoogleGenAI | null = null;
export function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not configured');
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Clean markdown JSON wrapper
export function cleanJsonString(str: string | undefined): string {
  if (!str) return '{}';
  let cleaned = str.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIndex = -1;
  let endIndex = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIndex = firstBrace;
    endIndex = cleaned.lastIndexOf('}');
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
    endIndex = cleaned.lastIndexOf(']');
  }

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    cleaned = cleaned.substring(startIndex, endIndex + 1);
  }

  return cleaned;
}

/**
 * 這個錯誤值不值得退到 fallback 鏈的下一個。
 *
 * W4 把它從 `generateContentWithFallback` 的 body 抽出來（判斷字串逐字相同，行為未變），
 * 因為 embedding 沒有 fallback 鏈卻一樣要在紀錄裡分得出 transient 與 fatal。
 * 留兩份的話，之後加一個新的限流訊息只會改到其中一份，而紀錄上看不出哪一份沒改。
 */
export function isTransientLlmError(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('overloaded')
  );
}

class RetryableLlmResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableLlmResponseError';
  }
}

export function formatTranscriptForAI(transcript: TranscriptSegment[]): string {
  return transcript.reduce((acc, curr, idx, arr) => {
    const prev = arr[idx - 1];
    const speaker = curr.speaker || 'Unknown';
    if (prev && (prev.speaker || 'Unknown') === speaker) {
      return acc + ` ${curr.text}`;
    }
    return acc + (acc ? '\n\n' : '') + `${speaker}: ${curr.text}`;
  }, '');
}

export function formatTranscriptWithTimeForAI(transcript: TranscriptSegment[]): string {
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return transcript.map(t =>
    `[${formatTime(t.start)}-${formatTime(t.end)}] ${t.speaker || 'Unknown'}: ${t.text}`
  ).join('\n');
}

export interface TranscribeSliceInput {
  base64Data: string;
  offsetSeconds?: number;
  previousContext?: string;
  mimeType?: string;
  /** 這片音訊的實際長度（秒，含 overlap）。undefined 代表解不出長度，那就不把時間夾回切片範圍 */
  sliceDurationSeconds?: number;
  /** 這片屬於哪一場會議，記進 llm.jsonl 才查得出單場會議的 token 花費 */
  meetingId?: string;
}

export interface AnalyzeTranscriptInput {
  transcript: TranscriptSegment[];
  meetingTags?: string[];
  meetingContext?: string;
  meetingId?: string;
}

/** 模型回的一條題目標籤。落地前還要算比對鍵，見 services/topicExtractor.ts */
export interface ExtractedTopicTag {
  title: string;
  content: string;
}

/**
 * 題目標籤抽取的 systemInstruction（`FN-03`）。
 *
 * **整段照搬 `eval/extract-tags.ts`，包含那六條規則，一個字都不要改。** 它是 U-001 第二版的
 * 產物：同一組關聯策略、同一份評測集，只換這段字，S3 的 recall 就從 0.333 升到 0.667。
 * 改它等於讓已經落地的標籤與新抽的標籤來自兩種粒度，而那不會有任何錯誤訊息，
 * 只會讓兩場本來對得上的會安靜地對不上。要改就要重跑評測。
 *
 * 也不要改成沿用 analyze 的 systemInstruction：那個 prompt 是為「給人看的會議記錄」寫的，
 * 會把一場會壓成 3 到 5 個抽象標題，任何關聯策略都認不出具體的同一題目（2026-09-14 實測）。
 */
const EXTRACT_TAGS_SYSTEM_INSTRUCTION = `你要從會議逐字稿抽出「題目標籤」。這些標籤的唯一用途是拿去跨會議比對，找出不同場會議在討論同一件事。

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

/**
 * Embedding model（W4）。
 *
 * 2026-09-14 實測：這把 key 能用的只有 `gemini-embedding-001`、`gemini-embedding-2` 與其 preview 版，
 * `text-embedding-004` 回 404。取穩定版不取 preview。**沒有 fallback 鏈**，這裡跟轉錄不一樣：
 * 退到另一個 embedding model 會產出另一個向量空間的向量，跟既有的算 cosine 得到的數字沒有意義。
 * 所以它失敗就是失敗，寧可這場會算不出候選。
 *
 * 換 model 一定要連 `LINK_ALGO_VERSION` 一起換，而且既有向量全部要重算。
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/** 一次 embedding 的結果。model 與維度跟著回來，呼叫端要把它們跟向量一起落地 */
export interface EmbeddingBatch {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export interface JudgeMeetingPairInput {
  idA: string;
  tagsA: readonly { title: string; content: string }[];
  idB: string;
  tagsB: readonly { title: string; content: string }[];
}

/**
 * S3 的 systemInstruction（`FN-04`）。**整段照搬 `eval/strategies/s3-llm.ts`，一個字都不要改。**
 *
 * 理由同 W3 的抽取 prompt：U-001 第三輪量到的 P 1.000 / R 0.667 是這段字跑出來的，
 * 改它等於讓已經落地的判定與新判定來自兩把尺，而那不會有任何錯誤訊息。要改就要重跑評測，
 * 而且依 SDD 4.1 那是 L3 變更。
 */
const JUDGE_PAIR_SYSTEM_INSTRUCTION = `你要判斷兩場會議有沒有在討論「同一個題目」。

判準：
- 同一個題目指的是同一件待決事項、同一個系統或流程、同一個對象。用詞不同不影響判定。
- 只是同屬一個大領域（例如都跟 AI 有關、都跟業務有關）不算同一個題目。
- 一方只順口提過一句、沒有實質討論的，不算。

請回傳 JSON：sameTopic（布林）、confidence（0 到 1）、reason（一句話，繁體中文）、sharedTopics（共同題目的名稱陣列，沒有就空陣列）。`;

/** 把一場會的題目標籤排成 S3 看的清單。格式與 eval/strategies/s3-llm.ts 的 listOf 相同 */
const formatTagsForJudge = (tags: readonly { title: string; content: string }[]): string =>
  tags.map((tag, i) => `${i + 1}. ${tag.title}${tag.content ? `：${tag.content}` : ''}`).join('\n');

export interface GeminiServerClient {
  /**
   * 這個 client 現在用的 embedding model（W4）。
   *
   * 掛在介面上而不是讓呼叫端直接讀 `EMBEDDING_MODEL` 常數：`TopicLinker` 要靠它判斷
   * 「表裡那些向量是不是舊 model 算的」，而測試注入的假 client 用的是另一個名字。
   * 讀常數的話，測試裡每一次關聯都會把全部向量重算一遍，而那條路線在正式環境從來不會走到。
   */
  readonly embeddingModel: string;
  transcribeSlice(input: TranscribeSliceInput): Promise<TranscriptSegment[]>;
  polishTranscript(transcript: TranscriptSegment[]): Promise<string>;
  analyzeTranscript(input: AnalyzeTranscriptInput): Promise<GeminiOutput>;
  /** 題目標籤抽取（W3）。回空陣列是合法結果（模型說這份逐字稿沒有可抽的題目），不是錯誤 */
  extractTopicTags(input: { transcript: TranscriptSegment[]; meetingId?: string }): Promise<ExtractedTopicTag[]>;
  /** 題目標籤的 embedding（W4，S2 召回的原料）。回傳順序與送進去的順序一致 */
  embedTopicTags(texts: readonly string[], meetingId?: string): Promise<EmbeddingBatch>;
  /** 兩場會是不是在討論同一題目（W4，S3）。判不出來就拋，不回一個猜的 false */
  judgeMeetingPair(input: JudgeMeetingPairInput): Promise<PairJudgement>;
}

export function createGeminiServerClient(llmLogger: LlmLogger): GeminiServerClient {
  // Generate content with automatic retry and model fallback for high availability
  async function generateContentWithFallback(
    ai: GoogleGenAI,
    request: {
      kind: LlmCallKind;
      meetingId?: string;
      contents: any;
      config?: any;
      preferredModel?: string;
      validateResponse?: (response: any) => void;
    }
  ): Promise<any> {
    const models = request.preferredModel
      ? [request.preferredModel, 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'].filter(
          (m, idx, arr) => arr.indexOf(m) === idx
        )
      : ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

    let lastError: any;

    // 用索引跑，modelIndex 要進紀錄：>0 代表當時首選模型不能用，退到了 fallback 鏈後面
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const model = models[modelIndex];
      for (let attempt = 0; attempt < 2; attempt++) {
        const startedAt = Date.now();
        let response: any;
        try {
          response = await ai.models.generateContent({
            model,
            contents: request.contents,
            config: request.config,
          });
          // HTTP 成功不等於有可用輸出。Gemini 實測會只消耗 thinking token、response.text 卻為空；
          // 若在 fallback 外才檢查，整場會直接 FAILED，而且 retry 永遠只打同一個 model。
          request.validateResponse?.(response);
          llmLogger.log({
            kind: request.kind,
            meetingId: request.meetingId ?? null,
            model,
            modelIndex,
            attempt: attempt + 1,
            streamed: false,
            latencyMs: Date.now() - startedAt,
            outcome: 'ok',
            response,
            configuredMaxOutputTokens: request.config?.maxOutputTokens ?? null,
          });
          return response;
        } catch (err: any) {
          lastError = err;
          // 兩種 transient 成因在這裡本來就是分開判斷的，記進紀錄時不要再壓平成同一個值：
          // 空輸出（thinking 吃光預算或被安全過濾）跟限流過載要採取的對策完全不同
          const isEmptyOutput = err instanceof RetryableLlmResponseError;
          const isTransient = isEmptyOutput || isTransientLlmError(err);

          llmLogger.log({
            kind: request.kind,
            meetingId: request.meetingId ?? null,
            model,
            modelIndex,
            attempt: attempt + 1,
            streamed: false,
            latencyMs: Date.now() - startedAt,
            outcome: isTransient ? 'transient' : 'fatal',
            transientReason: isTransient ? (isEmptyOutput ? 'empty_output' : 'rate_limited') : null,
            response,
            error: err,
            configuredMaxOutputTokens: request.config?.maxOutputTokens ?? null,
          });

          console.warn(`[Gemini Request] Model ${model} (attempt ${attempt + 1}) failed:`, err?.message || err);

          if (!isTransient) {
            throw err;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError;
  }

  return {
    embeddingModel: EMBEDDING_MODEL,

    async transcribeSlice(input: TranscribeSliceInput): Promise<TranscriptSegment[]> {
      const {
        base64Data,
        offsetSeconds = 0,
        previousContext = '',
        mimeType = 'audio/wav',
        sliceDurationSeconds,
        meetingId,
      } = input;

      const ai = getAI();
      const parts: any[] = [];
      if (previousContext) {
        parts.push({
          text: `Context (Preceding Transcript):\n${previousContext}\n\nTask: Continue transcribing the following audio strictly verbatim.`
        });
      }
      parts.push({ inlineData: { data: base64Data, mimeType } });

      const promptConfig = {
        systemInstruction: `You are a professional speech-to-text transcriber. 
Your goal is to generate a precise, word-for-word transcription of the audio file in Traditional Chinese (繁體中文).

RULES:
1. **FULL SENTENCES**: Transcribe complete sentences. DO NOT just list keywords. DO NOT summarize.
2. **VERBATIM**: Write exactly what is said. Include all content.
3. **SPEAKER ID**: Identify speakers (Speaker 1, Speaker 2) based on voice. Use context to maintain consistency.
4. **TIMESTAMPS**: Provide start/end times in seconds.
5. **LANGUAGE**: Output mainly in Traditional Chinese. If English technical terms are used, keep them in English.

Output JSON format:
{ "segments": [{ "start": 0.0, "end": 5.5, "text": "完整的句子內容...", "speaker": "Speaker 1" }] }`,
        // 逐字稿是機械式的照抄任務，不需要推理，調低 thinking level 降低「thinking 吃光
        // maxOutputTokens、response.text 變空」的機率（2026-09-16 查證：Gemini 3 系列的
        // thinking token 算進 maxOutputTokens，這支呼叫又沒設上限）。不是保證消除，是降低機率：
        // llm.jsonl 的 finishReason 欄位之後能直接看出還有沒有撞到 MAX_TOKENS
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                  speaker: { type: Type.STRING }
                },
                required: ['start', 'end', 'text', 'speaker']
              }
            }
          }
        }
      };

      const response = await generateContentWithFallback(ai, {
        kind: 'transcribe',
        meetingId,
        preferredModel: 'gemini-3.8-flash',
        contents: { parts },
        config: promptConfig,
        validateResponse: (candidate) => {
          if (
            typeof candidate?.text !== 'string'
            || candidate.text.trim() === ''
            || cleanJsonString(candidate.text) === '{}'
          ) {
            throw new RetryableLlmResponseError('Gemini 轉錄回應沒有文字內容');
          }
        },
      });

      const rawText = typeof response.text === 'string' ? response.text : '';
      // 先剝 markdown 圍欄與前後雜訊再 parse。順序不能反過來拿原文判「像不像 JSON」：
      // ```json {...}``` 與「Here is the transcription: {...}」都不是以 { 開頭，
      // 先判的話會被當成純文字整段收下，變成一段內容是 JSON 原始碼的假逐字稿——
      // 那正是 V1 要擋的那種安靜消失，只是換個入口
      const jsonStr = cleanJsonString(rawText);

      let parsed: any;
      let parseError: Error | null = null;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        parseError = err as Error;
      }

      let rawSegments: any[] | null = null;
      if (parseError === null) {
        if (Array.isArray(parsed)) {
          rawSegments = parsed;
        } else if (Array.isArray(parsed?.segments)) {
          rawSegments = parsed.segments;
        }
      }

      if (rawSegments === null) {
        const trimmed = rawText.trim();
        // 模型沒照格式、直接吐純文字：內容是有的，當成一整段收下。這條 fallback 是刻意留的。
        //
        // 涵蓋面比搬家前的舊碼窄一格：**以 `[` 開頭的純文字**（例如 `[00:00] 大家好…`）
        // 會被 cleanJsonString 取成 `[…]`、parse 失敗，然後落到下面拋錯；舊碼只判 `{`，
        // 那種輸入會走這條 fallback。這是刻意的取捨——responseMimeType 是 application/json
        // 又帶 responseSchema，這個形狀很難出現，而「像 JSON 卻解不開」安靜地變成假逐字稿
        // 才是這一整段要擋的東西。不要把它當 bug 修回去。
        if (trimmed !== '' && !/^[{[]/.test(trimmed)) {
          rawSegments = [{ start: 0, end: 10, text: trimmed, speaker: 'Speaker 1' }];
        } else if (parseError !== null) {
          // 看起來像 JSON 但解不開（輸出被截斷時就是這樣）。以前這裡只 console.warn 然後回空陣列，
          // 而空陣列在上層跟「這片真的沒人說話」分不開：pipeline 會照樣推進 processed_slices，
          // 整整 10 分鐘安靜消失、狀態顯示完美，音檔還在分析成功後被刪掉，重跑也救不回來
          throw new Error(
            `這一片的轉錄結果不是合法 JSON（模型輸出可能被截斷）：${parseError.message}。`
            + `收到的開頭：${jsonStr.slice(0, 200)}`,
          );
        } else {
          // 解得開但形狀不對（沒有 segments 陣列），理由同上，不能退成空陣列
          throw new Error(
            `這一片的轉錄結果沒有 segments 陣列，模型回的形狀不對：${jsonStr.slice(0, 200)}`,
          );
        }
      }

      return normalizeTranscribedSegments(rawSegments, offsetSeconds, sliceDurationSeconds);
    },

    async polishTranscript(transcript: TranscriptSegment[]): Promise<string> {
      const ai = getAI();
      const fullText = formatTranscriptForAI(transcript);

      const response = await generateContentWithFallback(ai, {
        kind: 'polish',
        preferredModel: 'gemini-3.8-flash',
        contents: `請將以下會議逐字稿進行「全文修潤」。
      
原始逐字稿可能包含破碎的句子、文法錯誤或贅字。
請將其重寫為一篇流暢、通順的「對話劇本」或「文章」。

要求：
1. **修正語病**：將口語轉化為通順的書面語，但保留原意。
2. **標示講者**：保留對話形式 (Speaker: Content)。
3. **分段清晰**：適當分段，增加可讀性。
4. **Markdown 格式**：使用 Markdown 格式輸出。

原始內容：
${fullText}`,
        config: {
          systemInstruction: '你是一位專業的文字編輯，擅長將口語逐字稿潤飾為高品質的訪談文章或劇本。',
        },
      });

      return response.text || '無法生成修潤內容';
    },

    async analyzeTranscript(input: AnalyzeTranscriptInput): Promise<GeminiOutput> {
      const { transcript, meetingTags = [], meetingContext = '', meetingId } = input;

      const ai = getAI();
      const formattedTranscript = formatTranscriptForAI(transcript);
      const contextStr = `
會議標籤：${meetingTags.join(', ')}
背景補充：${meetingContext}
`.trim();

      const response = await generateContentWithFallback(ai, {
        kind: 'analyze',
        meetingId,
        preferredModel: 'gemini-3.8-flash',
        contents: `請將這份會議記錄整理成結構化的「議題討論紀錄」。
這是一份逐字稿，可能包含口語贅字。請在分析時自動進行潤飾與歸納。
請根據對話內容，產出「繁體中文」的分析報告。
${contextStr ? `\n本次會議背景與標籤：\n${contextStr}\n` : ''}
會議記錄內容：
${formattedTranscript}`,
        config: {
          maxOutputTokens: 8192,
          systemInstruction: `
你是一位專業的會議記錄師。請忽略流水帳式的摘要，改為「以議題為導向」的結構化整理。

你需要產出以下 JSON 格式：
1. **overview**: 用一句話概括整場會議的核心主旨。
2. **topics**: 識別會議中討論的數個具體議題。針對每個議題，請撰寫詳細的內容整理，包含討論過程中的關鍵觀點。
3. **decisions**: 會議中明確達成的所有決議。
4. **action_items**: 後續需要執行的行動項目與負責人。

請直接回傳純 JSON，不要包含 Markdown 標記。`,
          responseMimeType: 'application/json',
          responseSchema: {
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
          },
        },
      });

      const jsonStr = cleanJsonString(response.text);
      return JSON.parse(jsonStr) as GeminiOutput;
    },

    async extractTopicTags(input: { transcript: TranscriptSegment[]; meetingId?: string }): Promise<ExtractedTopicTag[]> {
      const ai = getAI();

      const response = await generateContentWithFallback(ai, {
        kind: 'extract-tags',
        meetingId: input.meetingId,
        // 不指定 preferredModel：fallback 鏈就是評測跑出 15 到 25 那個結果時用的那條
        // （eval/lib/client.ts 的 ANALYZE_MODELS），加一個首選等於換掉受測對象
        contents: `會議逐字稿：\n${formatTranscriptWithTimeForAI(input.transcript)}`,
        config: {
          maxOutputTokens: 8192,
          systemInstruction: EXTRACT_TAGS_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: {
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
          },
        },
      });

      const jsonStr = cleanJsonString(response.text);
      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        // 解不開就拋，不要退成空陣列：空陣列在上層跟「這場會真的沒有題目可抽」分不開，
        // 而那種會永遠不會參與任何關聯（SDD 4.x）。拋上去之後 TopicExtractor 會把它
        // 記成 failed 並附上原因，這場會照樣進 READY
        throw new Error(
          `題目標籤的回應不是合法 JSON（模型輸出可能被截斷）：${(err as Error).message}。`
          + `收到的開頭：${jsonStr.slice(0, 200)}`,
        );
      }
      if (!Array.isArray(parsed?.tags)) {
        throw new Error(`題目標籤的回應沒有 tags 陣列，模型回的形狀不對：${jsonStr.slice(0, 200)}`);
      }

      return parsed.tags.map((tag: any, index: number) => {
        // 形狀不對就整份拋掉，不要偷偷跳過壞掉的那幾條：跳過之後「模型少抽了五條」
        // 與「模型回的形狀壞了」在標籤數上長得一模一樣
        if (typeof tag?.title !== 'string' || tag.title.trim() === '') {
          throw new Error(`題目標籤第 ${index} 條沒有 title：${JSON.stringify(tag).slice(0, 200)}`);
        }
        if (typeof tag?.content !== 'string') {
          throw new Error(`題目標籤「${tag.title}」的 content 不是字串：${JSON.stringify(tag).slice(0, 200)}`);
        }
        return { title: tag.title.trim(), content: tag.content.trim() };
      });
    },

    async embedTopicTags(texts: readonly string[], meetingId?: string): Promise<EmbeddingBatch> {
      // 沒有標籤時不打 API，也不回一個假的維度：0 維在下游會讓 canCompare 判成「可以比」
      if (texts.length === 0) return { model: EMBEDDING_MODEL, dimensions: 0, vectors: [] };

      const ai = getAI();
      const vectors: number[][] = [];
      const BATCH = 50;

      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const startedAt = Date.now();
        let response: any;
        try {
          response = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: batch as string[] });
        } catch (err) {
          llmLogger.log({
            kind: 'embed',
            meetingId: meetingId ?? null,
            model: EMBEDDING_MODEL,
            modelIndex: 0,
            attempt: 1,
            streamed: false,
            latencyMs: Date.now() - startedAt,
            outcome: isTransientLlmError(err) ? 'transient' : 'fatal',
            error: err,
          });
          // 不退到別的 embedding model：那是另一個向量空間，跟既有向量算出來的 cosine 沒有意義
          throw err;
        }
        llmLogger.log({
          kind: 'embed',
          meetingId: meetingId ?? null,
          model: EMBEDDING_MODEL,
          modelIndex: 0,
          attempt: 1,
          streamed: false,
          latencyMs: Date.now() - startedAt,
          outcome: 'ok',
          response,
        });

        const embeddings = response?.embeddings;
        // 回來的筆數對不上就整批拋掉，不要按順序硬對：少一筆的話後面每一條標籤都會配到別人的向量，
        // 而那不會有任何錯誤，只會讓關聯安靜地變成亂的
        if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
          throw new Error(`embedding 回傳 ${embeddings?.length ?? 0} 筆，送出 ${batch.length} 筆`);
        }
        embeddings.forEach((item: any, index: number) => {
          const values = item?.values;
          if (!Array.isArray(values) || values.length === 0) {
            throw new Error(`第 ${i + index} 條標籤的 embedding 是空的`);
          }
          // 逐值檢查。不檢查的話 `null` 會在轉 Float32Array 時被 coercion 成 0、字串變成 NaN，
          // 而 NaN 進 cosine 之後每個比較都是 false ——結果是 0 個候選、狀態 LINKED、空集合，
          // 跟「這場會真的沒有同題目的會」長得一模一樣。這正是這個 repo 一直在擋的那種壞法
          for (let k = 0; k < values.length; k += 1) {
            if (typeof values[k] !== 'number' || !Number.isFinite(values[k])) {
              throw new Error(
                `第 ${i + index} 條標籤的 embedding 第 ${k} 個值不是有限數字：${JSON.stringify(values[k])}`,
              );
            }
          }
          vectors.push(values);
        });
      }

      const dimensions = vectors[0].length;
      for (let i = 1; i < vectors.length; i += 1) {
        // 同一批出現兩種維度代表 API 換了行為。讓它往下走的話，canCompare 會把整批標籤判成
        // 不可比，而症狀是「這場會突然關聯不到任何東西」，看不出來源
        if (vectors[i].length !== dimensions) {
          throw new Error(`同一批 embedding 的維度不一致：第 0 條是 ${dimensions}、第 ${i} 條是 ${vectors[i].length}`);
        }
      }
      return { model: EMBEDDING_MODEL, dimensions, vectors };
    },

    async judgeMeetingPair(input: JudgeMeetingPairInput): Promise<PairJudgement> {
      const ai = getAI();

      const response = await generateContentWithFallback(ai, {
        kind: 'link-judge',
        // 記 idA：呼叫端（TopicLinker.link）一律傳「正在跑關聯的那場會」當 idA，
        // 這通呼叫的額度算在它頭上，跟 idB（被比對的歷史會議）無關
        meetingId: input.idA,
        // 不指定 preferredModel：理由同 extractTopicTags，評測跑出那組數字時走的就是這條預設鏈
        contents: `會議 ${input.idA} 討論的題目：
${formatTagsForJudge(input.tagsA)}

會議 ${input.idB} 討論的題目：
${formatTagsForJudge(input.tagsB)}`,
        config: {
          maxOutputTokens: 2048,
          systemInstruction: JUDGE_PAIR_SYSTEM_INSTRUCTION,
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

      const jsonStr = cleanJsonString(response.text);
      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        // 解不開就拋，不要退成「判為不相關」：那會讓「模型說沒關係」與「我們沒問成功」
        // 長得一模一樣，而前者是結論、後者是這一對還沒被判過
        throw new Error(
          `${input.idA} × ${input.idB} 的判定回應不是合法 JSON（模型輸出可能被截斷）：${(err as Error).message}。`
          + `收到的開頭：${jsonStr.slice(0, 200)}`,
        );
      }

      const where = `${input.idA} × ${input.idB} 的判定`;
      if (typeof parsed?.sameTopic !== 'boolean') {
        throw new Error(`${where}沒有布林的 sameTopic：${jsonStr.slice(0, 200)}`);
      }
      if (typeof parsed?.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
        throw new Error(`${where}的 confidence 不是數字：${jsonStr.slice(0, 200)}`);
      }
      if (parsed.confidence < 0 || parsed.confidence > 1) {
        // 夾回 0 到 1 會讓一個壞掉的回應看起來正常，而信心值正是門檻在比的東西
        throw new Error(`${where}的 confidence 是 ${parsed.confidence}，不在 0 到 1 之間`);
      }
      if (typeof parsed?.reason !== 'string' || parsed.reason.trim() === '') {
        // 沒有理由的判定不能落地：`FN-04` 的驗收條件是「每筆判定必須帶可被人否決的理由」，
        // 而 SDD 1.3.1 的 vault markdown 直接列它。只有信心值的話人無從否決
        throw new Error(`${where}沒有判定理由：${jsonStr.slice(0, 200)}`);
      }
      if (!Array.isArray(parsed?.sharedTopics) || !parsed.sharedTopics.every((t: unknown) => typeof t === 'string')) {
        throw new Error(`${where}的 sharedTopics 不是字串陣列：${jsonStr.slice(0, 200)}`);
      }

      return {
        sameTopic: parsed.sameTopic,
        confidence: parsed.confidence,
        reason: parsed.reason.trim(),
        sharedTopics: parsed.sharedTopics.map((t: string) => t.trim()).filter((t: string) => t !== ''),
      };
    },
  };
}

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
import { GoogleGenAI, Type } from '@google/genai';
import { GeminiOutput, TranscriptSegment } from '../types';
import { normalizeTranscribedSegments } from './transcribeSegments';
import { LlmCallKind, LlmLogger } from './llmTelemetry';

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
}

export interface AnalyzeTranscriptInput {
  transcript: TranscriptSegment[];
  meetingTags?: string[];
  meetingContext?: string;
}

export interface GeminiServerClient {
  transcribeSlice(input: TranscribeSliceInput): Promise<TranscriptSegment[]>;
  polishTranscript(transcript: TranscriptSegment[]): Promise<string>;
  analyzeTranscript(input: AnalyzeTranscriptInput): Promise<GeminiOutput>;
}

export function createGeminiServerClient(llmLogger: LlmLogger): GeminiServerClient {
  // Generate content with automatic retry and model fallback for high availability
  async function generateContentWithFallback(
    ai: GoogleGenAI,
    request: { kind: LlmCallKind; contents: any; config?: any; preferredModel?: string }
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
        try {
          const response = await ai.models.generateContent({
            model,
            contents: request.contents,
            config: request.config,
          });
          llmLogger.log({
            kind: request.kind,
            model,
            modelIndex,
            attempt: attempt + 1,
            streamed: false,
            latencyMs: Date.now() - startedAt,
            outcome: 'ok',
            response,
          });
          return response;
        } catch (err: any) {
          lastError = err;
          const msg = (err?.message || '').toLowerCase();
          const isTransient =
            msg.includes('503') ||
            msg.includes('unavailable') ||
            msg.includes('high demand') ||
            msg.includes('429') ||
            msg.includes('resource_exhausted') ||
            msg.includes('overloaded');

          llmLogger.log({
            kind: request.kind,
            model,
            modelIndex,
            attempt: attempt + 1,
            streamed: false,
            latencyMs: Date.now() - startedAt,
            outcome: isTransient ? 'transient' : 'fatal',
            error: err,
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
    async transcribeSlice(input: TranscribeSliceInput): Promise<TranscriptSegment[]> {
      const {
        base64Data,
        offsetSeconds = 0,
        previousContext = '',
        mimeType = 'audio/wav',
        sliceDurationSeconds,
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
        preferredModel: 'gemini-3.8-flash',
        contents: { parts },
        config: promptConfig,
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
      const { transcript, meetingTags = [], meetingContext = '' } = input;

      const ai = getAI();
      const formattedTranscript = formatTranscriptForAI(transcript);
      const contextStr = `
會議標籤：${meetingTags.join(', ')}
背景補充：${meetingContext}
`.trim();

      const response = await generateContentWithFallback(ai, {
        kind: 'analyze',
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
  };
}

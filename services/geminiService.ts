import { GeminiOutput, TranscriptSegment, ChatMessage, SubAgentType } from "../types";
import { HttpError } from "./httpError";
import { retryDelayMs } from "./retryPolicy";

// Retry-After 只認非負整數秒數字串。server.ts 的 429 一律送 String(retryAfterSeconds)，
// 不會出現 RFC 的 HTTP-date 格式，所以這裡不做日期解析；解不出來就當 server 沒給，
// 退回 retryPolicy 既有的固定退避，不自己編一個時間出來。
function parseRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

async function postJson(endpoint: string, body: any): Promise<any> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errJson = JSON.parse(text);
      if (errJson.error) {
        errorMsg = errJson.error;
      } else if (errJson.message) {
        errorMsg = errJson.message;
      }
    } catch {
      if (text.includes('503') || text.includes('high demand') || text.includes('UNAVAILABLE')) {
        errorMsg = 'AI 服務目前需求量極大 (503 High Demand)，系統正在自動重試...';
      } else if (text.trim().startsWith('<')) {
        errorMsg = `伺服器短暫無回應 (HTTP ${response.status})，請稍候重試。`;
      } else if (text) {
        errorMsg = text.slice(0, 200);
      }
    }
    // message 內容維持原樣：App.tsx 的 translateError 只看 message 字串做分類
    throw new HttpError(response.status, errorMsg, parseRetryAfterSeconds(response));
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
    throw new Error('伺服器回傳了網頁內容 (HTML)，可能是連線短暫中斷或服務正在重啟，請稍候重試。');
  }

  try {
    return JSON.parse(text);
  } catch (parseErr: any) {
    throw new Error(`回應格式解析錯誤: ${parseErr.message}`);
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // 最後一次不重試，直接把錯誤丟給呼叫者
      const delay = i < maxRetries - 1 ? retryDelayMs(err, i) : null;
      if (delay === null) throw err;
      console.warn(`[AI 重試] 發生短暫錯誤 (${err.message})，正在進行第 ${i + 1} 次重試...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// sliceDurationSeconds：這片音訊的實際長度（秒，含 overlap，相對切片起點）。server 用它把 LLM 回的
// start/end 夾回切片範圍；undefined 代表前端解不出長度（raw-file fallback），server 那邊就不 clamp。
export const transcribeSlice = async (
  base64Data: string, 
  offsetSeconds: number,
  previousContext: string = "",
  mimeType: string = "audio/wav",
  sliceDurationSeconds?: number
): Promise<TranscriptSegment[]> => {
  return withRetry(async () => {
    const data = await postJson('/api/gemini/transcribe', {
      base64Data,
      offsetSeconds,
      previousContext,
      mimeType,
      sliceDurationSeconds,
    });
    return data.segments || [];
  });
};

/**
 * 全文修潤功能 (Post-Process Cleaning)
 * 將破碎的逐字稿轉換為通順的劇本/文章格式
 */
export const polishTranscript = async (transcript: TranscriptSegment[]): Promise<string> => {
  if (!transcript || transcript.length === 0) return "";

  return withRetry(async () => {
    const data = await postJson('/api/gemini/polish', { transcript });
    return data.content || "無法生成修潤內容";
  });
};

export const analyzeTranscript = async (
  transcript: TranscriptSegment[], 
  meetingTags: string[] = [], 
  meetingContext: string = ""
): Promise<GeminiOutput> => {
  if (!transcript || transcript.length === 0) throw new Error("無內容可分析");

  return withRetry(async () => {
    const data = await postJson('/api/gemini/analyze', {
      transcript,
      meetingTags,
      meetingContext,
    });
    return data.analysis;
  });
};

/**
 * 分段節錄摘要 (Segmented Summary)
 * 針對目前的對話片段進行簡短總結
 */
export const getSegmentedSummary = async (
  transcript: TranscriptSegment[], 
  meetingTags: string[] = [], 
  meetingContext: string = ""
): Promise<string> => {
  if (!transcript || transcript.length === 0) return "";

  return withRetry(async () => {
    const data = await postJson('/api/gemini/segmented-summary', {
      transcript,
      meetingTags,
      meetingContext,
    });
    return data.summary || "";
  });
};

/**
 * 即時策略建議 (Live Strategy)
 * 根據目前的對話內容，即時產出對應策略或行動建議
 */
export const getLiveStrategy = async (
  transcript: TranscriptSegment[], 
  agentType: SubAgentType = SubAgentType.PROJECT_MANAGER,
  meetingTags: string[] = [],
  meetingContext: string = "",
  previousStrategies: string[] = [],
  consensus: string[] = []
): Promise<string[]> => {
  if (!transcript || transcript.length === 0) return [];

  return withRetry(async () => {
    const data = await postJson('/api/gemini/live-strategy', {
      transcript,
      agentType,
      meetingTags,
      meetingContext,
      previousStrategies,
      consensus,
    });
    return data.strategies || [];
  });
};

/**
 * 提取共識 (Consensus Extraction)
 * 識別會議中已達成的共識，作為長期記憶
 */
export const getConsensus = async (
  transcript: TranscriptSegment[],
  currentConsensus: string[] = []
): Promise<string[]> => {
  if (!transcript || transcript.length < 10) return currentConsensus;

  return withRetry(async () => {
    const data = await postJson('/api/gemini/consensus', {
      transcript,
      currentConsensus,
    });
    return data.consensus || currentConsensus;
  });
};

export const askDocument = async (
  transcript: TranscriptSegment[], 
  history: ChatMessage[], 
  question: string
): Promise<string> => {
  return withRetry(async () => {
    const data = await postJson('/api/gemini/chat', {
      transcript,
      history,
      question,
    });
    return data.answer || "無法生成回應";
  });
};

export const askDocumentStream = async function* (
  transcript: TranscriptSegment[], 
  history: ChatMessage[], 
  question: string
) {
  const response = await fetch('/api/gemini/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, history, question }),
  });

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      if (err.error) errorMsg = err.error;
    } catch {}
    throw new Error(errorMsg);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("瀏覽器不支援串流讀取");

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.text) {
            yield parsed.text;
          } else if (parsed.error) {
            throw new Error(parsed.error);
          }
        } catch (e: any) {
          if (e.message && !e.message.includes('JSON')) {
            throw e;
          }
        }
      }
    }
  }
};

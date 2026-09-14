import { GeminiOutput, TranscriptSegment, ChatMessage } from "../types";
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

// 把非 2xx 回應翻成 HttpError。抽成同步純函式是為了讓 JSON 與串流兩條路徑共用同一套訊息規則：
// 兩邊撞到同一個 429 時使用者看到的字要一樣，限流退避也才吃得到同一個 Retry-After。
// message 內容維持原樣：App.tsx 的 translateError 與 TranscriptView 只看 message 字串做分類。
function errorFromResponse(response: Response, text: string): HttpError {
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
  return new HttpError(response.status, errorMsg, parseRetryAfterSeconds(response));
}

async function postJson(endpoint: string, body: any): Promise<any> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw errorFromResponse(response, text);
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

// 串流端點的建立連線階段。錯誤走跟 postJson 同一套 errorFromResponse，串流問答才吃得到
// 限流退避（限流掛在整個 /api，這條路徑一樣會被擋）。成功時原樣回傳 Response，
// body 留給呼叫端當 stream 讀 —— 這裡絕對不能先讀掉 body。
async function postStream(endpoint: string, body: any): Promise<Response> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw errorFromResponse(response, await response.text());
  }

  return response;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  // 迴圈只會靠 return 或 throw 離開：最後一圈 delay 必為 null 一定 throw，所以迴圈後面不需要再丟一次
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      // 最後一次不重試，直接把錯誤丟給呼叫者
      const delay = i < maxRetries - 1 ? retryDelayMs(err, i) : null;
      if (delay === null) throw err;
      console.warn(`[AI 重試] 發生短暫錯誤 (${err.message})，正在進行第 ${i + 1} 次重試...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
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

export const askDocumentStream = async function* (
  transcript: TranscriptSegment[], 
  history: ChatMessage[], 
  question: string
) {
  // 只有建立連線這一段重試：一旦開始 yield，重試就會把同一則回覆的開頭再送一次，
  // 使用者會在同一段文字裡看到重複的字。所以下面讀 stream 的迴圈出錯一律往外丟，不重試。
  const response = await withRetry(() => postStream('/api/gemini/chat-stream', { transcript, history, question }));

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

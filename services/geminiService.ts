import { TranscriptSegment, ChatMessage } from "../types";
import { errorFromResponse } from "./httpResponse";
import { retryDelayMs } from "./retryPolicy";

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

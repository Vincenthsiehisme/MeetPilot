import { TranscriptSegment } from "../types";
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

import { GoogleGenAI } from '@google/genai';

/**
 * 評測用的 Gemini client。
 *
 * 缺 key 就直接拋錯，不降級、不跳過、不回傳空結果。理由：這支程式的輸出是要拿來
 * 裁決門檻的數字，一個「因為沒有 key 所以靜默跳過」的策略，在報表上會跟
 * 「這個策略什麼都判不出來」長得一模一樣。
 */
export function requireClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      '缺少 GEMINI_API_KEY。這支評測需要真實呼叫 Gemini。\n' +
        '設法：在 repo 根目錄建 .env 寫 GEMINI_API_KEY=<你的 key>，' +
        '然後用 `node --env-file-if-exists=.env` 或 `npx tsx --env-file-if-exists=.env` 執行。',
    );
  }
  return new GoogleGenAI({ apiKey: apiKey.trim() });
}

/** 與 server.ts 相同的 model 順序，讓評測測的是現況而不是另一套設定。 */
export const ANALYZE_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

/**
 * Embedding model。與 server.ts 無關，它目前沒有用到 embedding。
 *
 * 2026-09-14 實測：這個 key 能用的只有 `gemini-embedding-001`、`gemini-embedding-2`
 * 與其 preview 版；`text-embedding-004` 回 404。選穩定版不選 preview。
 * 換 key 或換區域時先跑 `ai.models.list()` 確認，不要照抄舊的 model 名。
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

export function cleanJsonString(text: string | undefined): string {
  if (!text) throw new Error('Gemini 回應為空');
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();
}

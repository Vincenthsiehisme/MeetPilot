import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Gemini 呼叫的結構化紀錄：每次嘗試一行 JSONL。只記 metadata，不記逐字稿、提問或模型回覆內容。
// 在這之前唯一的痕跡是 console.warn 的散字，回答不了「fallback 多常觸發」「限流有多嚴重」
// 「一場會議燒掉多少 token」。埋在這裡的欄位就是為了回答這三個問題。
// 不上 observability 平台的門檻見 vault 的 AGENT-EVAL-METHODS〈不要上 observability 平台〉。

export type LlmCallKind =
  | 'transcribe' | 'polish' | 'analyze' | 'chat-stream' | 'extract-tags'
  // W4：'embed' 是題目標籤的 embedding（S2 召回的原料），'link-judge' 是兩場會的 S3 判定。
  // 分成兩個 kind 而不是一個 'link'：兩者的額度池、成本與失敗意義都不同——embedding 失敗是
  // 「這場會算不出候選」，判定失敗是「候選判不完」，混成一個之後那份紀錄回答不了「首選模型多常不可用」
  | 'embed' | 'link-judge';

// ok：模型回了東西。transient：可重試的錯（503／429／overloaded），會退到 fallback 鏈的下一個。
// fatal：不可重試，直接往上拋。三者分開才看得出「退了幾次才成功」與「第一次就死」的差別，
// 合成一個 success boolean 就分不出來了。
export type LlmOutcome = 'ok' | 'transient' | 'fatal';

// transient 底下還分兩種成因，混在同一個 outcome 值裡查不出「這場會因為空輸出重試幾次」
// 跟「因為限流重試幾次」——兩者要採取的對策完全不同（前者是 thinking 預算或 prompt 問題，
// 後者是額度或退避）。empty_output：HTTP 成功但回應沒有可用文字（RetryableLlmResponseError）。
// rate_limited：HTTP 層的 503／429／overloaded。只在 outcome 是 transient 時有值
export type LlmTransientReason = 'empty_output' | 'rate_limited';

export interface LlmUsage {
  // 每一項都可能缺。SDK 沒回就是 null，不補 0：
  // 0 是「真的沒用 token」，null 是「不知道」。混成同一個值之後，
  // SDK 改欄位名（整欄變 0）跟請求真的很小，在 log 裡長得一模一樣。
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
}

export interface LlmCallInput {
  kind: LlmCallKind;
  // 這場呼叫算在哪一場會議頭上，事後才查得出「這場會燒了多少 token」。
  // null／缺省代表這次呼叫真的沒有單一會議可歸——目前只有前端兩條舊路由
  // （polish、chat-stream）還沒把 meetingId 帶進請求，其餘 kind 一律會傳
  meetingId?: string | null;
  // 這次實際打的 model id
  model: string;
  // 它在 fallback 鏈的第幾個，0 是首選。>0 就代表首選模型當時不能用
  modelIndex: number;
  // 同一個 model 的第幾次嘗試，1-based
  attempt: number;
  streamed: boolean;
  // 從發出請求到拿到結果（串流是到最後一個 chunk）的毫秒數
  latencyMs: number;
  // 串流專用：到第一個 chunk 的毫秒數。非串流是 null
  ttfbMs?: number | null;
  outcome: LlmOutcome;
  // outcome 是 transient 時這次重試是哪一種成因。ok／fatal 不填
  transientReason?: LlmTransientReason | null;
  // 成功時傳 SDK 的 response（或串流裡最後一個帶 usageMetadata 的 chunk）
  response?: unknown;
  // 失敗時傳 caught 的 error
  error?: unknown;
  // 這通呼叫實際帶的 maxOutputTokens。沒設就是 null——「沒設」跟「設了但拿不到」
  // 要分得開，不然之後改了設定也對不回舊紀錄裡哪些呼叫當時有沒有上限
  configuredMaxOutputTokens?: number | null;
  // 測試注入用；正式呼叫不要傳
  now?: Date;
}

export interface LlmCallRecord {
  ts: string;
  kind: LlmCallKind;
  meetingId: string | null;
  model: string;
  modelIndex: number;
  attempt: number;
  streamed: boolean;
  latencyMs: number;
  ttfbMs: number | null;
  outcome: LlmOutcome;
  transientReason: LlmTransientReason | null;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
  // SDK 的 candidates[0].finishReason：STOP／MAX_TOKENS／SAFETY／…。純 metadata 不含內容，
  // 空輸出是不是真的撞到輸出上限、還是被安全過濾擋下，一行紀錄直接看得出來，不用回頭猜
  finishReason: string | null;
  configuredMaxOutputTokens: number | null;
  // prompt 在產生候選之前就被擋下的原因（promptFeedback.blockReason）。finishReason 是
  // null 又想知道是不是這種情況時看這個欄位
  blockReason: string | null;
  // candidates 陣列的長度，0 是「模型回了、零個候選」，null 是「根本沒收到 response」
  candidatesCount: number | null;
  errorStatus: number | null;
  errorMessage: string | null;
}

// 錯誤訊息截斷長度。Gemini 的錯誤是 API 層的訊息，不含 prompt，但上限是為了萬一：
// 這份 log 的前提是「不含會議內容」，不能靠第三方訊息格式不變來維持這個前提。
const MAX_ERROR_MESSAGE = 200;

const DEFAULT_LLM_LOG_PATH = 'logs/llm.jsonl';

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 從 SDK 的 response 抽 token 數。拿不到就整組 null，不猜、不補 0。
export function extractUsage(response: unknown): LlmUsage {
  const meta = (response as { usageMetadata?: Record<string, unknown> } | null | undefined)?.usageMetadata;
  return {
    promptTokens: readTokenCount(meta?.promptTokenCount),
    outputTokens: readTokenCount(meta?.candidatesTokenCount),
    thoughtsTokens: readTokenCount(meta?.thoughtsTokenCount),
    totalTokens: readTokenCount(meta?.totalTokenCount),
  };
}

// 從 SDK 的 response 抽 candidates[0].finishReason。拿不到就 null，跟 extractUsage 同一套原則
export function extractFinishReason(response: unknown): string | null {
  const candidates = (response as { candidates?: Array<{ finishReason?: unknown }> } | null | undefined)
    ?.candidates;
  const reason = candidates?.[0]?.finishReason;
  return typeof reason === 'string' ? reason : null;
}

// finishReason 掛在 candidates[0] 上，如果 Gemini 在產生候選「之前」就把整個 prompt 擋下
// （安全過濾），candidates 會是空的，finishReason 自然拿不到。promptFeedback.blockReason
// 是另一個獨立欄位，專門回答「是不是這種情況」——2026-09-16 的空輸出調查發現 finishReason
// 全部是 null，需要這個欄位才知道是不是撞到這裡，不是繼續猜
export function extractBlockReason(response: unknown): string | null {
  const reason = (response as { promptFeedback?: { blockReason?: unknown } } | null | undefined)
    ?.promptFeedback?.blockReason;
  return typeof reason === 'string' ? reason : null;
}

// candidates 陣列的長度。response 存在但拿不到陣列就是 0——這是真的資訊（模型回了、
// 但零個候選），不是「不知道」。只有整個 response 都沒拿到（呼叫端還沒收到 HTTP 回應
// 就先拋錯，例如網路層的錯誤）才是 null，跟 extractUsage 的 null／0 原則一致
export function extractCandidatesCount(response: unknown): number | null {
  if (response === null || response === undefined) return null;
  const candidates = (response as { candidates?: unknown }).candidates;
  return Array.isArray(candidates) ? candidates.length : 0;
}

// 抽 HTTP 狀態碼與訊息。與 server.ts 的 handleApiError 看的是同兩個地方
// （err.status、JSON 字串 message 裡的 error.code），但那支綁著 express response，不能共用。
export function describeLlmError(err: unknown): { status: number | null; message: string } {
  const raw = (err as { message?: unknown } | null | undefined)?.message;
  const message = typeof raw === 'string' ? raw : String(err ?? '');

  let status: number | null = null;
  // Gemini 的錯誤把整包 JSON 塞進 message。直接截斷會砍在 details 中間，
  // 留下一段讀不出重點的字串，所以 code 與人看的 message 都從裡面取出來
  let readable = message;
  if (message.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      const code = parsed?.error?.code;
      if (typeof code === 'number') status = code;
      const inner = parsed?.error?.message;
      if (typeof inner === 'string' && inner !== '') readable = inner;
    } catch {
      // 訊息看起來像 JSON 但不是，狀態碼維持 null、訊息用原字串。兩者都還是會被記下來
    }
  }

  const direct = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof direct === 'number') status = direct;

  return { status, message: readable.slice(0, MAX_ERROR_MESSAGE) };
}

export function buildLlmRecord(input: LlmCallInput): LlmCallRecord {
  const usage = extractUsage(input.response);
  const error = input.outcome === 'ok' ? null : describeLlmError(input.error);

  return {
    ts: (input.now ?? new Date()).toISOString(),
    kind: input.kind,
    meetingId: input.meetingId ?? null,
    model: input.model,
    modelIndex: input.modelIndex,
    attempt: input.attempt,
    streamed: input.streamed,
    latencyMs: input.latencyMs,
    ttfbMs: input.ttfbMs ?? null,
    outcome: input.outcome,
    transientReason: input.outcome === 'transient' ? input.transientReason ?? null : null,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    thoughtsTokens: usage.thoughtsTokens,
    totalTokens: usage.totalTokens,
    finishReason: extractFinishReason(input.response),
    configuredMaxOutputTokens: input.configuredMaxOutputTokens ?? null,
    blockReason: extractBlockReason(input.response),
    candidatesCount: extractCandidatesCount(input.response),
    errorStatus: error?.status ?? null,
    errorMessage: error?.message ?? null,
  };
}

// MEETPILOT_LLM_LOG：未設用預設路徑，設 "off" 關閉，其他值當檔案路徑。
// 預設開啟是刻意的：這份紀錄的用處在事後回頭查，沒有人會在出事之前想到要先打開它。
export function resolveLlmLogPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env.MEETPILOT_LLM_LOG;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LLM_LOG_PATH;
  const value = raw.trim();
  if (value.toLowerCase() === 'off') return null;
  return value;
}

export interface LlmLogger {
  log(input: LlmCallInput): void;
}

export function createLlmLogger(logPath: string | null): LlmLogger {
  // 關掉時給 no-op，呼叫端不用到處判斷要不要記
  if (logPath === null) return { log: () => {} };

  // 啟動時就建目錄並碰一次檔案。路徑不可寫要在這裡爆，
  // 不要等到第一次呼叫 Gemini 才發現整場會議一行都沒留下。
  // 包一層是為了訊息：原生的 EACCES 只印一段 node 內部堆疊，看不出是哪個設定造成的
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, '');
  } catch (err) {
    const reason = (err as { message?: unknown } | null)?.message ?? err;
    throw new Error(
      `MEETPILOT_LLM_LOG="${logPath}" 無法寫入：${reason}。請改成可寫的路徑，或設成 off 關閉呼叫紀錄`
    );
  }

  let writeFailureReported = false;
  let missingUsageReported = false;

  return {
    log(input: LlmCallInput) {
      const record = buildLlmRecord(input);

      // 呼叫成功卻一個 token 數都拿不到，多半是 SDK 的 usageMetadata 換了形狀。
      // 那會讓整份紀錄的 token 欄位安靜地全是 null，跟「這台機器沒人用過」長得一樣，
      // 等到有人想查用量才發現查不到，那些呼叫已經過去了。第一次就叫出來
      if (
        !missingUsageReported &&
        record.outcome === 'ok' &&
        record.promptTokens === null &&
        record.totalTokens === null
      ) {
        missingUsageReported = true;
        console.warn(
          `[LLM Log] ${record.kind} 呼叫成功但取不到 token 數，usageMetadata 可能換了形狀；紀錄的 token 欄位會是 null`
        );
      }

      const line = JSON.stringify(record);
      try {
        // 同步寫：單人自用，一場會議數十筆，每筆約 300 bytes，阻塞 event loop 的代價可忽略。
        // 換來的是錯誤就地可見，不用處理 write stream 的生命週期與背壓
        appendFileSync(logPath, `${line}\n`);
      } catch (err) {
        // 記錄失敗不該讓使用者的請求跟著失敗，但也不安靜吞掉。
        // 第一次印完整原因，之後每次印一行短的，免得洗版蓋掉真正的錯誤
        if (!writeFailureReported) {
          writeFailureReported = true;
          console.error(`[LLM Log] 寫入 ${logPath} 失敗，之後的呼叫紀錄會不完整：`, err);
        } else {
          console.error(`[LLM Log] 寫入 ${logPath} 再次失敗`);
        }
      }
    },
  };
}

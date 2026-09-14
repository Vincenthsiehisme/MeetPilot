import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import {
  checkBasicAuth,
  createRateLimiter,
  describeBodyParserError,
  resolveListenConfig,
} from './services/httpGuards';
import { normalizeTranscribedSegments } from './services/transcribeSegments';
import { createLlmLogger, resolveLlmLogPath, LlmCallKind } from './services/llmTelemetry';
import { openMeetingDb, resolveDbPath } from './services/meetingDb';
import { createMeetingStore } from './services/meetingStore';
import { MigrationRecord, isRejected, toMigrationRecord } from './services/jobMigration';
import { TranscriptSegment } from './types';

// 監聽設定在啟動時就解析：HOST 不是本機位址又沒設 Basic Auth 會在這裡直接拋錯，不進 listen
const listenConfig = resolveListenConfig(process.env);

// Gemini 呼叫紀錄也在啟動時開檔：log 路徑不可寫要在這裡爆，不要等到第一次轉錄才發現沒留下任何紀錄
const llmLogger = createLlmLogger(resolveLlmLogPath(process.env));

// 一期的結構化儲存。同樣在啟動時開：資料庫開不起來（路徑不可寫、schema 版本比程式碼新）
// 要在這裡爆，不要等到使用者送出第一場會才發現存不進去
const meetingDb = openMeetingDb(resolveDbPath(process.env));
const meetingStore = createMeetingStore(meetingDb);

const app = express();

// 順序重要：限流與 Basic Auth 先掛，body parser 後掛。
// 否則未認證的請求會先把整個 50MB body 讀完、解析完，才在後面被拒絕。

// /api/* 限流：每個 IP 每分鐘最多 MEETPILOT_API_RATE_LIMIT 次（預設 60）。放在 Basic Auth 前面，猜密碼也一起被限
const apiRateLimiter = createRateLimiter({ limit: listenConfig.apiRateLimitPerMinute, windowMs: 60_000 });
app.use('/api', (req, res, next) => {
  const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const result = apiRateLimiter.check(clientIp);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    // 前端 services/retryPolicy.ts 靠 HttpError.status === 429 加 Retry-After 決定退避；訊息帶 "429" 是給人看的，也讓 translateError 分類得到
    return res.status(429).json({ error: `請求太頻繁 (HTTP 429)，請 ${result.retryAfterSeconds} 秒後再試` });
  }
  next();
});

// /api/* Basic Auth：只有設定了帳密才掛，本機位址不設帳密就不要求認證
if (listenConfig.basicAuth) {
  const credentials = listenConfig.basicAuth;
  app.use('/api', (req, res, next) => {
    if (!checkBasicAuth(req.headers.authorization, credentials)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="MeetPilot", charset="UTF-8"');
      return res.status(401).json({ error: '需要 Basic Auth 認證' });
    }
    next();
  });
}

// Allow large payloads for audio slices (up to 50MB)
// 只掛在 /api 底下，通過限流與認證後才解析 body；/api 以外沒有路由讀 req.body
app.use('/api', express.json({ limit: '50mb' }));
app.use('/api', express.urlencoded({ limit: '50mb', extended: true }));

// body parser 的錯要自己接：Express 預設回 HTML 錯誤頁，前端 postJson 看到 `<` 開頭會當成連線異常，
// 使用者只看到「無法連線」，不知道是送出的 JSON 壞掉還是超過 50MB。其他錯誤原樣往下丟。
app.use('/api', (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const described = describeBodyParserError(err);
  if (!described) return next(err);
  res.status(described.status).json({ error: described.error });
});

// Lazy GoogleGenAI client
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
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
function cleanJsonString(str: string | undefined): string {
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

function formatTranscriptForAI(transcript: TranscriptSegment[]): string {
  return transcript.reduce((acc, curr, idx, arr) => {
    const prev = arr[idx - 1];
    const speaker = curr.speaker || 'Unknown';
    if (prev && (prev.speaker || 'Unknown') === speaker) {
      return acc + ` ${curr.text}`;
    }
    return acc + (acc ? '\n\n' : '') + `${speaker}: ${curr.text}`;
  }, '');
}

function formatTranscriptWithTimeForAI(transcript: TranscriptSegment[]): string {
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return transcript.map(t =>
    `[${formatTime(t.start)}-${formatTime(t.end)}] ${t.speaker || 'Unknown'}: ${t.text}`
  ).join('\n');
}

function handleApiError(err: any, res: express.Response) {
  console.error('[Gemini API Server Error]:', err?.message || err);
  let statusCode = 500;
  let message = err?.message || 'Gemini API 處理發生錯誤';

  try {
    if (typeof err?.message === 'string' && err.message.trim().startsWith('{')) {
      const parsed = JSON.parse(err.message);
      if (parsed?.error) {
        statusCode = parsed.error.code || 500;
        message = parsed.error.message || message;
      }
    }
  } catch {}

  if (err?.status && typeof err.status === 'number') {
    statusCode = err.status;
  }

  // Prevent reverse proxies (e.g. nginx in container) from intercepting 502/503/504
  // and returning an HTML page (<!doctype html>) instead of our JSON response.
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    statusCode = 500;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
    error: message,
    rawError: err?.message,
  });
}

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

// API Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!process.env.GEMINI_API_KEY,
  });
});

// Meeting 相關的錯誤自己接：handleApiError 是為 Gemini 的錯誤形狀寫的（會去解析 err.message 裡的 JSON），
// 用在這裡會把 store 的錯誤印成 Gemini 錯誤，出事時找錯地方
function handleStoreError(err: unknown, res: express.Response) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[MeetPilot Store Error]:', message);
  res.status(500).json({ error: message });
}

// Migration：瀏覽器 IndexedDB 的 Job 搬進 server 端 SQLite（SDD 1.5 第一段）。
// server 讀不到 IndexedDB，所以資料一定是前端撈出來送上來的。
app.post('/api/meetings/import', (req, res) => {
  try {
    const { jobs, blobIds = [] } = req.body ?? {};
    if (!Array.isArray(jobs)) {
      return res.status(400).json({ error: 'jobs 必須是陣列' });
    }
    // blobIds 壞掉不能當成空陣列：那會回報「沒有音檔留在瀏覽器」，是最危險的一種假回報
    if (!Array.isArray(blobIds) || !blobIds.every((id: unknown) => typeof id === 'string')) {
      return res.status(400).json({ error: 'blobIds 必須是字串陣列' });
    }

    const records: MigrationRecord[] = [];
    const rejected: { jobId: string | null; reason: string }[] = [];
    const notes: { jobId: string; note: string }[] = [];

    for (const raw of jobs) {
      const outcome = toMigrationRecord(raw);
      if (isRejected(outcome)) {
        rejected.push({ jobId: outcome.jobId, reason: outcome.reason });
        continue;
      }
      records.push(outcome.record);
      for (const note of outcome.notes) notes.push({ jobId: outcome.record.meeting.meeting_id, note });
    }

    const report = meetingStore.importMigrated(records);

    // 音檔這一期不搬：它只在「轉錄或分析失敗」的 Meeting 上還留著，而重跑需要的是 server 端的新流程。
    // 但不能安靜地不搬，否則使用者清掉 IndexedDB 之後才發現那幾場會再也重跑不了。
    //
    // 全部列出來、逐筆標出它屬於哪一群，不做交集過濾：被拒收的那幾筆正是之後要重跑的，
    // 把它們濾掉等於在最需要提醒的地方不提醒
    const importedSet = new Set(report.imported);
    const skippedSet = new Set(report.skippedExisting);
    const rejectedSet = new Set(rejected.map(r => r.jobId).filter((id): id is string => id !== null));
    const audioStillInBrowser = blobIds.map((meetingId: string) => ({
      meetingId,
      // orphan：這個音檔在 IndexedDB 裡，但沒有對應的 job 被送上來
      group: importedSet.has(meetingId) ? 'imported'
        : skippedSet.has(meetingId) ? 'skippedExisting'
        : rejectedSet.has(meetingId) ? 'rejected'
        : 'orphan',
    }));

    res.json({ ...report, rejected, notes, audioStillInBrowser });
  } catch (err) {
    handleStoreError(err, res);
  }
});

app.get('/api/meetings', (req, res) => {
  try {
    res.json({ meetings: meetingStore.listMeetings() });
  } catch (err) {
    handleStoreError(err, res);
  }
});

app.get('/api/meetings/:id', (req, res) => {
  try {
    const meeting = meetingStore.getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${req.params.id}` });
    res.json({
      meeting,
      transcript: meetingStore.getTranscript(req.params.id),
      analysis: meetingStore.getAnalysis(req.params.id),
      tags: meetingStore.getTags(req.params.id),
    });
  } catch (err) {
    handleStoreError(err, res);
  }
});

// 1. Transcribe Audio Slice
app.post('/api/gemini/transcribe', async (req, res) => {
  try {
    const { base64Data, offsetSeconds = 0, previousContext = '', mimeType = 'audio/wav', sliceDurationSeconds } = req.body;
    if (!base64Data) {
      return res.status(400).json({ error: 'Missing base64Data' });
    }

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

    const jsonStr = cleanJsonString(response.text);
    let parsed: any = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn('Failed to parse transcribe JSON response:', jsonStr);
    }

    let rawSegments: any[] = [];
    if (Array.isArray(parsed)) {
      rawSegments = parsed;
    } else if (Array.isArray(parsed?.segments)) {
      rawSegments = parsed.segments;
    } else if (response.text && !response.text.trim().startsWith('{')) {
      rawSegments = [{
        start: 0,
        end: 10,
        text: response.text.trim(),
        speaker: 'Speaker 1'
      }];
    }

    const segments = normalizeTranscribedSegments(rawSegments, offsetSeconds, sliceDurationSeconds);

    res.json({ segments });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 2. Polish Transcript
app.post('/api/gemini/polish', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return res.json({ content: '' });
    }

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

    res.json({ content: response.text || '無法生成修潤內容' });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 3. Analyze Transcript
app.post('/api/gemini/analyze', async (req, res) => {
  try {
    const { transcript, meetingTags = [], meetingContext = '' } = req.body;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: '無內容可分析' });
    }

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
    const result = JSON.parse(jsonStr);
    res.json({ analysis: result });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 4. Chat Q&A Streaming (SSE)
app.post('/api/gemini/chat-stream', async (req, res) => {
  try {
    const { transcript = [], history = [], question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const ai = getAI();
    const docContext = formatTranscriptWithTimeForAI(transcript);
    const recentHistory = history.slice(-6).map((h: any) => ({
      role: h.role,
      parts: [{ text: h.text }],
    }));

    const chatHistory = [
      {
        role: 'user',
        parts: [{ text: `這是本次會議的完整逐字稿內容 (含時間戳記)：\n\n${docContext}\n\n請閱讀並記住上述內容，準備回答問題。` }],
      },
      {
        role: 'model',
        parts: [{ text: '好的，我已經閱讀並理解了會議逐字稿。請問有什麼關於這次會議的問題需要我協助解答？我將會基於上述文件內容進行精準回覆並附上時間引用。' }],
      },
      ...recentHistory,
    ];

    const chatConfig = {
      systemInstruction: '你是一位專業的會議助理。任務是回答用戶關於「會議逐字稿」的具體問題。準則：嚴格基於事實，引用時間戳記 [MM:SS]，繁體中文回答。',
    };

    const models = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
    let responseStream: any = null;
    let lastErr: any;
    // 這條路徑不走 generateContentWithFallback，紀錄要自己埋，而且跨「建立」與「消費」兩段：
    // 成功建立的那個 model 與起算時間要傳到下面
    let streamModel = '';
    let streamModelIndex = -1;
    let streamStartedAt = 0;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const model = models[modelIndex];
      const startedAt = Date.now();
      try {
        const chat = ai.chats.create({
          model,
          history: chatHistory,
          config: chatConfig,
        });
        responseStream = await chat.sendMessageStream({ message: question });
        streamModel = model;
        streamModelIndex = modelIndex;
        streamStartedAt = startedAt;
        break;
      } catch (err: any) {
        lastErr = err;
        const msg = (err?.message || '').toLowerCase();
        const isTransient = msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') || msg.includes('429');
        llmLogger.log({
          kind: 'chat-stream',
          model,
          modelIndex,
          attempt: 1,
          streamed: true,
          latencyMs: Date.now() - startedAt,
          outcome: isTransient ? 'transient' : 'fatal',
          error: err,
        });
        if (!isTransient) throw err;
      }
    }

    if (!responseStream) throw (lastErr || new Error('無法建立對話串流'));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let firstChunkAt: number | null = null;
    // Gemini 在串流尾端才給完整的 usageMetadata，留住最後一個帶它的 chunk
    let usageChunk: unknown = null;

    // 消費串流的錯誤在這裡就記，不留給外層 catch：外層也接得到上面建立階段的錯，
    // 在那裡記會把已經記過的那一筆再記第二次
    try {
      for await (const chunk of responseStream) {
        if (firstChunkAt === null) firstChunkAt = Date.now();
        if (chunk.usageMetadata) usageChunk = chunk;
        if (chunk.text) {
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
      }
    } catch (err) {
      llmLogger.log({
        kind: 'chat-stream',
        model: streamModel,
        modelIndex: streamModelIndex,
        attempt: 1,
        streamed: true,
        latencyMs: Date.now() - streamStartedAt,
        ttfbMs: firstChunkAt === null ? null : firstChunkAt - streamStartedAt,
        // 斷在中途不算可重試：部分內容已經送出去了
        outcome: 'fatal',
        error: err,
      });
      throw err;
    }

    llmLogger.log({
      kind: 'chat-stream',
      model: streamModel,
      modelIndex: streamModelIndex,
      attempt: 1,
      streamed: true,
      latencyMs: Date.now() - streamStartedAt,
      ttfbMs: firstChunkAt === null ? null : firstChunkAt - streamStartedAt,
      outcome: 'ok',
      response: usageChunk,
    });

    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err: any) {
    if (!res.headersSent) {
      handleApiError(err, res);
    } else {
      res.write(`data: ${JSON.stringify({ error: err?.message || '串流錯誤' })}\n\n`);
      res.end();
    }
  }
});

// Vite middleware & Production static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const { host, port, basicAuth } = listenConfig;
  app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}${basicAuth ? ' (Basic Auth on /api/*)' : ''}`);
  });
}

startServer();

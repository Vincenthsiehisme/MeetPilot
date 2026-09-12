import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import { getAgentById } from './services/agents';
import { TranscriptSegment, GeminiOutput, ChatMessage, SubAgentType } from './types';

const app = express();
const PORT = 3000;

// Allow large payloads for audio slices (up to 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  request: { contents: any; config?: any; preferredModel?: string }
): Promise<any> {
  const models = request.preferredModel
    ? [request.preferredModel, 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'].filter(
        (m, idx, arr) => arr.indexOf(m) === idx
      )
    : ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

  let lastError: any;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: request.contents,
          config: request.config,
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

// 1. Transcribe Audio Slice
app.post('/api/gemini/transcribe', async (req, res) => {
  try {
    const { base64Data, offsetSeconds = 0, previousContext = '', mimeType = 'audio/wav' } = req.body;
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

    const segments = rawSegments.map((s: any) => ({
      start: typeof s.start === 'number' ? s.start + offsetSeconds : offsetSeconds,
      end: typeof s.end === 'number' ? s.end + offsetSeconds : offsetSeconds + 5,
      text: s.text || '',
      speaker: s.speaker || 'Speaker 1',
    }));

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

// 4. Segmented Summary
app.post('/api/gemini/segmented-summary', async (req, res) => {
  try {
    const { transcript, meetingTags = [], meetingContext = '' } = req.body;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return res.json({ summary: '' });
    }

    const ai = getAI();
    const text = formatTranscriptForAI(transcript);
    const contextStr = `
會議標籤：${meetingTags.join(', ')}
背景補充：${meetingContext}
`.trim();

    const response = await generateContentWithFallback(ai, {
      preferredModel: 'gemini-3.8-flash',
      contents: `你現在是會議記錄助手。請針對以下「最近的對話片段」進行簡短的「分段節錄摘要」。

${contextStr ? `本次會議背景與標籤：\n${contextStr}\n` : ''}
要求：
1. 用 1-2 句話精煉地總結這段對話的核心內容。
2. 繁體中文回答。

對話內容：
${text}`,
      config: {
        systemInstruction: '你是一位專業的會議記錄師，擅長精煉地總結對話重點。',
      },
    });

    res.json({ summary: response.text || '' });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 5. Live Strategy
app.post('/api/gemini/live-strategy', async (req, res) => {
  try {
    const {
      transcript,
      agentType = SubAgentType.PROJECT_MANAGER,
      meetingTags = [],
      meetingContext = '',
      previousStrategies = [],
      consensus = [],
    } = req.body;

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return res.json({ strategies: [] });
    }

    const ai = getAI();
    const recentTranscript = transcript.slice(-20);
    const text = formatTranscriptForAI(recentTranscript);
    const agent = getAgentById(agentType);

    const contextStr = `
會議標籤：${meetingTags.join(', ')}
背景補充：${meetingContext}
已達成共識 (長期記憶)：${consensus.length > 0 ? consensus.join('; ') : '尚無'}
先前建議 (反饋閉環)：${previousStrategies.slice(-5).join('; ')}
`.trim();

    const response = await generateContentWithFallback(ai, {
      preferredModel: 'gemini-3.8-flash',
      contents: `你現在是即時會議助手：【${agent.name}】。

請根據目前的對話片段，發揮你的專業角色（${agent.description}），即時產出「對應策略」或「行動建議」。
${contextStr ? `\n本次會議背景與脈絡：\n${contextStr}\n` : ''}

任務指引：
1. **第一性原理**：優先挑戰假設，回歸本質。
2. **高信心**：判斷信心不足時，請回傳空陣列。
3. **前瞻性**：預判未來 10 秒的對話走向。
4. **去重**：不要給出與「已達成共識」或「先前建議」重複的內容。

目前對話內容：
${text}`,
      config: {
        systemInstruction: agent.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            strategies: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['strategies'],
        },
      },
    });

    const jsonStr = cleanJsonString(response.text);
    const parsed = JSON.parse(jsonStr);
    res.json({ strategies: parsed.strategies || [] });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 6. Consensus
app.post('/api/gemini/consensus', async (req, res) => {
  try {
    const { transcript, currentConsensus = [] } = req.body;
    if (!transcript || !Array.isArray(transcript) || transcript.length < 10) {
      return res.json({ consensus: currentConsensus });
    }

    const ai = getAI();
    const text = formatTranscriptForAI(transcript.slice(-50));

    const response = await generateContentWithFallback(ai, {
      preferredModel: 'gemini-3.8-flash',
      contents: `你是一位會議審計員。請從以下對話中識別「已達成的共識」或「已確定的決策」。

目前已有的共識：${currentConsensus.join('; ')}

請更新並回傳完整的共識列表。
要求：
1. 僅包含雙方明確同意的事項。
2. 繁體中文。
3. 排除瑣碎細節。

對話內容：
${text}`,
      config: {
        systemInstruction: '你擅長從混亂的對話中提取明確的共識與決策。',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            consensus: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['consensus'],
        },
      },
    });

    const jsonStr = cleanJsonString(response.text);
    const parsed = JSON.parse(jsonStr);
    res.json({ consensus: parsed.consensus || currentConsensus });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 7. Chat Q&A
app.post('/api/gemini/chat', async (req, res) => {
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
      systemInstruction: '你是一位專業的會議助理。你的任務是回答用戶關於「會議逐字稿」的具體問題。請嚴格基於事實，並引用發言者與時間。',
    };

    const models = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
    let lastErr: any;
    let answer = '';

    for (const model of models) {
      try {
        const chat = ai.chats.create({
          model,
          history: chatHistory,
          config: chatConfig,
        });
        const result = await chat.sendMessage({ message: question });
        answer = result.text || '無法生成回應';
        break;
      } catch (err: any) {
        lastErr = err;
        const msg = (err?.message || '').toLowerCase();
        const isTransient = msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') || msg.includes('429');
        if (!isTransient) throw err;
      }
    }

    if (!answer && lastErr) throw lastErr;
    res.json({ answer });
  } catch (err: any) {
    handleApiError(err, res);
  }
});

// 8. Chat Q&A Streaming (SSE)
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

    for (const model of models) {
      try {
        const chat = ai.chats.create({
          model,
          history: chatHistory,
          config: chatConfig,
        });
        responseStream = await chat.sendMessageStream({ message: question });
        break;
      } catch (err: any) {
        lastErr = err;
        const msg = (err?.message || '').toLowerCase();
        const isTransient = msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') || msg.includes('429');
        if (!isTransient) throw err;
      }
    }

    if (!responseStream) throw (lastErr || new Error('無法建立對話串流'));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of responseStream) {
      if (chunk.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

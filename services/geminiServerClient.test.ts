import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LlmCallInput, extractFinishReason, extractBlockReason, extractCandidatesCount } from './llmTelemetry';

// @google/genai 整包換掉：這些測試要驗的是 prompt 組裝、fallback 鏈與回應解析，
// 不是真的去打 Gemini。vi.hoisted 是因為 vi.mock 的 factory 會被提到 import 之前執行
const { generateContent, embedContent } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  embedContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: (request: unknown) => generateContent(request),
      embedContent: (request: unknown) => embedContent(request),
    };
  },
  Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN', INTEGER: 'INTEGER' },
  ThinkingLevel: { UNSPECIFIED: 'THINKING_LEVEL_UNSPECIFIED', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
}));

// node:fs 的 ESM 匯出不可重新定義，vi.spyOn 直接對它下手會拋
// 「Cannot redefine property」，只能整個模組換掉，其餘函式原樣代理給真實實作。
// 預設代理到真的 readFileSync，讓 analyzeTranscript 讀到真的規範檔；
// 只有測「規範檔讀不到／是空的」那兩條才覆寫這個 mock 的回傳
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => readFileSyncMock(...args) };
});

const {
  EMBEDDING_MODEL,
  cleanJsonString,
  createGeminiServerClient,
  formatTranscriptForAI,
  formatTranscriptForAnalysis,
  formatTranscriptWithTimeForAI,
  isTransientLlmError,
} = await import('./geminiServerClient');
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

let logged: LlmCallInput[];

/** SDK 的 ApiError 形狀：status 是 HTTP 狀態碼，message 是整個錯誤 body 的 JSON.stringify */
const rateLimited = (details?: unknown[]) => Object.assign(
  new Error(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details } })),
  { status: 429 },
);
const retryInfo = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
const quotaFailure = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaId }],
});
const client = () => createGeminiServerClient({ log: (input) => logged.push(input) });

beforeEach(() => {
  logged = [];
  generateContent.mockReset();
  embedContent.mockReset();
  readFileSyncMock.mockImplementation((...args: Parameters<typeof realFs.readFileSync>) => realFs.readFileSync(...args));
  process.env.GEMINI_API_KEY = 'test-key';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('cleanJsonString', () => {
  it('剝掉 markdown 圍欄與前後雜訊', () => {
    expect(cleanJsonString('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(cleanJsonString('這是結果：{"a":1} 以上')).toBe('{"a":1}');
    expect(cleanJsonString('[1,2]')).toBe('[1,2]');
  });

  it('空的回應給 {}，不回 undefined 讓 JSON.parse 爆在別的地方', () => {
    expect(cleanJsonString(undefined)).toBe('{}');
    expect(cleanJsonString('')).toBe('{}');
  });
});

describe('formatTranscriptForAI', () => {
  it('同一個講者連續發言併成一段，換人才換行', () => {
    expect(formatTranscriptForAI([
      { start: 0, end: 1, text: '你好', speaker: 'A' },
      { start: 1, end: 2, text: '再問一句', speaker: 'A' },
      { start: 2, end: 3, text: '收到', speaker: 'B' },
    ])).toBe('A: 你好 再問一句\n\nB: 收到');
  });

  it('沒有 speaker 的段落算 Unknown', () => {
    expect(formatTranscriptForAI([{ start: 0, end: 1, text: 'x' }])).toBe('Unknown: x');
  });
});

describe('formatTranscriptWithTimeForAI', () => {
  it('每段帶 [MM:SS-MM:SS] 時間戳，extractTopicTags 的 prompt 靠它', () => {
    expect(formatTranscriptWithTimeForAI([{ start: 65, end: 130.9, text: '重點', speaker: 'A' }]))
      .toBe('[01:05-02:10] A: 重點');
  });
});

describe('transcribeSlice', () => {
  it('解析 segments 並套用 offset 與切片長度上限', async () => {
    generateContent.mockResolvedValue({
      text: '{"segments":[{"start":5,"end":9999,"text":"很長的一段","speaker":"Speaker 2"}]}',
    });

    const segments = await client().transcribeSlice({
      base64Data: 'AAAA', offsetSeconds: 600, sliceDurationSeconds: 615,
    });

    // end 被夾回切片長度再加 offset：不夾的話合併時 coveredUntil 會被推爆
    expect(segments).toEqual([{ start: 605, end: 1215, text: '很長的一段', speaker: 'Speaker 2' }]);
  });

  it('有前文時把它放進 prompt 的第一個 part，音訊在後面', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });

    await client().transcribeSlice({ base64Data: 'AAAA', previousContext: 'A: 前一句', mimeType: 'audio/wav' });

    const request = generateContent.mock.calls[0][0] as any;
    expect(request.contents.parts[0].text).toContain('A: 前一句');
    expect(request.contents.parts[1].inlineData).toEqual({ data: 'AAAA', mimeType: 'audio/wav' });
    expect(request.model).toBe('gemini-3.8-flash');
  });

  it('帶 participantNames 時把已知人名塞進 systemInstruction 第 6 條規則（人名校正 N3）', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });
    await client().transcribeSlice({ base64Data: 'AAAA', participantNames: ['陳國煌', 'Philchen'] });

    const request = generateContent.mock.calls[0][0] as any;
    expect(request.config.systemInstruction).toContain('6. **KNOWN NAMES**');
    expect(request.config.systemInstruction).toContain('陳國煌, Philchen');
  });

  it('沒有 participantNames 或空陣列時不加人名規則，既有 prompt 不變', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });
    await client().transcribeSlice({ base64Data: 'AAAA' });
    await client().transcribeSlice({ base64Data: 'AAAA', participantNames: [] });

    for (const call of generateContent.mock.calls) {
      expect((call[0] as any).config.systemInstruction).not.toContain('KNOWN NAMES');
    }
  });

  it('thinking level 調低，降低 thinking 吃光 maxOutputTokens 讓 response.text 變空的機率', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });
    await client().transcribeSlice({ base64Data: 'AAAA' });

    const request = generateContent.mock.calls[0][0] as any;
    expect(request.config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    // 沒設 maxOutputTokens：這支呼叫本來就是三支裡唯一沒設上限的一支，配上調低的 thinking
    // level 是同一個問題的兩面，log 裡的 configuredMaxOutputTokens 要老實記成 null
    expect(request.config.maxOutputTokens).toBeUndefined();
  });

  it('圍欄包住的合法 segments 要正確解析，不能變成一段 JSON 原始碼的假逐字稿', async () => {
    // cleanJsonString 整支函式存在的理由就是剝圍欄，代表這個 repo 認為圍欄會發生
    generateContent.mockResolvedValue({
      text: '```json\n{"segments":[{"start":0,"end":5,"text":"開場白","speaker":"Speaker 1"}]}\n```',
    });

    expect(await client().transcribeSlice({ base64Data: 'AAAA' })).toEqual([
      { start: 0, end: 5, text: '開場白', speaker: 'Speaker 1' },
    ]);
  });

  it('前言加 JSON 也要正確解析', async () => {
    generateContent.mockResolvedValue({
      text: 'Here is the transcription: {"segments":[{"start":1,"end":4,"text":"第二句","speaker":"Speaker 2"}]}',
    });

    expect(await client().transcribeSlice({ base64Data: 'AAAA' })).toEqual([
      { start: 1, end: 4, text: '第二句', speaker: 'Speaker 2' },
    ]);
  });

  it('輸出被截斷（看起來像 JSON 但解不開）時拋錯，不回空陣列', async () => {
    // 模型被 maxOutputTokens 截斷時就是長這樣：開頭是 {，結尾斷在半路
    generateContent.mockResolvedValue({
      text: '{"segments":[{"start":0,"end":5,"text":"前五秒","speaker":"Speaker 1"},{"start":5,"end":1',
    });

    await expect(client().transcribeSlice({ base64Data: 'AAAA' })).rejects.toThrow(/不是合法 JSON/);
  });

  it('解得開但沒有 segments 陣列時也拋錯：空陣列在上層跟「這片沒人說話」分不開', async () => {
    generateContent.mockResolvedValue({ text: '{"error":"I cannot transcribe this audio"}' });

    await expect(client().transcribeSlice({ base64Data: 'AAAA' })).rejects.toThrow(/沒有 segments 陣列/);
  });

  it('segments 是空陣列時照樣回空：這一片真的沒人說話是合法結果', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });

    expect(await client().transcribeSlice({ base64Data: 'AAAA' })).toEqual([]);
  });

  it('模型回的不是 JSON 時當成一整段文字收下，不是丟掉', async () => {
    generateContent.mockResolvedValue({ text: '就是一段純文字' });

    expect(await client().transcribeSlice({ base64Data: 'AAAA' })).toEqual([
      { start: 0, end: 10, text: '就是一段純文字', speaker: 'Speaker 1' },
    ]);
  });
});

describe('fallback 鏈', () => {
  it('轉錄回應沒有文字或只回空物件時重試同一個 model，再退到下一個', async () => {
    vi.useFakeTimers();
    generateContent
      .mockResolvedValueOnce({ text: '', usageMetadata: { thoughtsTokenCount: 21, totalTokenCount: 21 } })
      .mockResolvedValueOnce({ text: '{}', usageMetadata: { thoughtsTokenCount: 13, totalTokenCount: 13 } })
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual([]);
    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual([
      'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite',
    ]);
    expect(logged.map(l => l.outcome)).toEqual(['transient', 'transient', 'ok']);
    expect(logged.slice(0, 2).map(l => l.response)).toEqual([
      { text: '', usageMetadata: { thoughtsTokenCount: 21, totalTokenCount: 21 } },
      { text: '{}', usageMetadata: { thoughtsTokenCount: 13, totalTokenCount: 13 } },
    ]);
    // 這兩筆是空輸出，不是限流：跟下面 503 那個案例要分得開，才查得出「這場會因為
    // thinking 吃光預算重試幾次」跟「因為限流重試幾次」
    expect(logged.slice(0, 2).map(l => l.transientReason)).toEqual(['empty_output', 'empty_output']);
  });

  it('transient 錯誤重試同一個 model 兩次後才退到下一個，紀錄留下 modelIndex', async () => {
    vi.useFakeTimers();
    generateContent
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual([
      'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite',
    ]);
    expect(logged.map(l => l.outcome)).toEqual(['transient', 'transient', 'ok']);
    expect(logged.map(l => l.modelIndex)).toEqual([0, 0, 1]);
    expect(logged.every(l => l.kind === 'transcribe' && l.streamed === false)).toBe(true);
    // 503 是限流過載，不是空輸出：跟上面那個案例是兩種不同成因
    expect(logged.slice(0, 2).map(l => l.transientReason)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('不可重試的錯誤第一次就往上拋，不退到 fallback 鏈後面', async () => {
    generateContent.mockRejectedValue(new Error('400 Invalid argument'));

    await expect(client().transcribeSlice({ base64Data: 'AAAA' })).rejects.toThrow('400 Invalid argument');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(logged.map(l => l.outcome)).toEqual(['fatal']);
    // fatal 不是 transient，transientReason 不該有值
    expect(logged.map(l => l.transientReason)).toEqual([null]);
  });

  it('finishReason 跟著 response 記下來，MAX_TOKENS 直接證實是撞到輸出上限', async () => {
    generateContent.mockResolvedValueOnce({
      text: '',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });
    generateContent.mockResolvedValueOnce({ text: '{"segments":[]}' });

    await client().transcribeSlice({ base64Data: 'AAAA' });

    expect(logged.map(l => extractFinishReason(l.response))).toEqual(['MAX_TOKENS', null]);
  });

  it('finishReason 是 null 又沒有候選時，blockReason／candidatesCount 補得出是不是被安全過濾擋下', async () => {
    generateContent.mockResolvedValueOnce({
      text: '',
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
    });
    generateContent.mockResolvedValueOnce({
      text: '{"segments":[]}',
      candidates: [{ finishReason: 'STOP' }],
    });

    await client().transcribeSlice({ base64Data: 'AAAA' });

    expect(logged.map(l => extractBlockReason(l.response))).toEqual(['SAFETY', null]);
    expect(logged.map(l => extractCandidatesCount(l.response))).toEqual([0, 1]);
  });
});

describe('formatTranscriptForAnalysis', () => {
  it('每段標成 [#n MM:SS-MM:SS] 講者: 內容，n 是 1-based 陣列索引', () => {
    const out = formatTranscriptForAnalysis([
      { start: 0, end: 5, text: '大家好', speaker: 'A' },
      { start: 65, end: 72, text: '開始討論預算', speaker: 'B' },
    ]);
    expect(out).toBe('[#1 00:00-00:05] A: 大家好\n[#2 01:05-01:12] B: 開始討論預算');
  });

  it('沒有 speaker 的段落算 Unknown', () => {
    expect(formatTranscriptForAnalysis([{ start: 0, end: 1, text: 'x' }])).toBe('[#1 00:00-00:01] Unknown: x');
  });
});

describe('analyzeTranscript', () => {
  const okOutput = {
    title: '預算與報價',
    overview: '討論預算',
    topics: [{ title: '預算', content: '內容', points: [{ text: '預算上限 50 萬', segment_from: 1, segment_to: 1 }] }],
    decisions: [{ text: '採用方案 A', segment_from: 1, segment_to: 1, decided_by: null }],
    action_items: [{ text: '追蹤報價', segment_from: 1, segment_to: 1, assignee: null, due: null }],
    open_questions: [],
  };
  const transcript = [{ start: 0, end: 5, text: '大家好', speaker: 'A' }];

  it('讀不到規範檔時，建 client 當下就拋錯，不等第一次呼叫才發現', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT: no such file or directory'); });
    expect(() => client()).toThrow(/規範檔.*讀取失敗/);
  });

  it('規範檔是空檔時拋錯', () => {
    readFileSyncMock.mockReturnValue('   \n  ');
    expect(() => client()).toThrow(/規範檔.*是空的/);
  });

  it('systemInstruction 是規範檔全文，逐字稿標段落編號送進 contents', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });

    await client().analyzeTranscript({ transcript });

    const request = generateContent.mock.calls[0][0] as any;
    expect(request.config.systemInstruction).toContain('會議記錄規範');
    expect(request.contents).toContain('[#1 00:00-00:05] A: 大家好');
    expect(request.model).toBe('gemini-3.8-flash');
  });

  it('會議標籤與背景補充帶進 prompt，沒給的話不留空段落', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });

    await client().analyzeTranscript({ transcript, meetingTags: ['採購'], meetingContext: '第三次會' });
    const withContext = (generateContent.mock.calls[0][0] as any).contents as string;
    expect(withContext).toContain('會議標籤：採購');
    expect(withContext).toContain('背景補充：第三次會');

    generateContent.mockClear();
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });
    await client().analyzeTranscript({ transcript });
    const withoutContext = (generateContent.mock.calls[0][0] as any).contents as string;
    expect(withoutContext).not.toContain('會議標籤：');
    expect(withoutContext).not.toContain('背景補充：');
  });

  it('responseSchema 對可為 null 的欄位用 nullable，不是 optional', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });
    await client().analyzeTranscript({ transcript });

    const schema = (generateContent.mock.calls[0][0] as any).config.responseSchema;
    expect(schema.properties.decisions.items.properties.decided_by.nullable).toBe(true);
    // 討論要點必填且每點要有出處，不帶提出者（SDD v0.9、D-021）
    const topicItem = schema.properties.topics.items;
    expect(topicItem.required).toEqual(['title', 'content', 'points']);
    expect(topicItem.properties.points.items.required).toEqual(['text', 'segment_from', 'segment_to']);
    expect(Object.keys(topicItem.properties.points.items.properties).sort()).toEqual(['segment_from', 'segment_to', 'text']);
    expect(schema.properties.action_items.items.properties.assignee.nullable).toBe(true);
    expect(schema.properties.action_items.items.properties.due.nullable).toBe(true);
  });

  it('正常回應解析成 AnalysisModelOutput', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });
    expect(await client().analyzeTranscript({ transcript })).toEqual(okOutput);
  });

  it('帶 participantNames 時把已知人名塞進 systemInstruction（人名校正 N3）', async () => {
    generateContent.mockResolvedValue({
      text: '{"title":"t","overview":"x","topics":[],"decisions":[],"action_items":[],"open_questions":[]}',
    });
    await client().analyzeTranscript({
      transcript: [{ start: 0, end: 1, text: 'x' }],
      participantNames: ['陳國煌', 'Philchen'],
    });

    const request = generateContent.mock.calls[0][0] as any;
    expect(request.config.systemInstruction).toContain('已知人名');
    expect(request.config.systemInstruction).toContain('陳國煌、Philchen');
  });

  it('沒有 participantNames 或空陣列時不加人名規則，既有 prompt 不變', async () => {
    generateContent.mockResolvedValue({
      text: '{"title":"t","overview":"x","topics":[],"decisions":[],"action_items":[],"open_questions":[]}',
    });
    await client().analyzeTranscript({ transcript: [{ start: 0, end: 1, text: 'x' }] });
    await client().analyzeTranscript({ transcript: [{ start: 0, end: 1, text: 'x' }], participantNames: [] });

    for (const call of generateContent.mock.calls) {
      expect((call[0] as any).config.systemInstruction).not.toContain('已知人名');
    }
  });

  it('回的內容不是合法 JSON 時拋錯，不回一份空的分析', async () => {
    generateContent.mockResolvedValue({ text: '抱歉，我無法處理' });
    await expect(client().analyzeTranscript({ transcript })).rejects.toThrow();
  });

  it('解析出來的形狀不對時拋錯（responseSchema 不保證型別完全符合預期）', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ ...okOutput, overview: 123 }) });
    await expect(client().analyzeTranscript({ transcript })).rejects.toThrow(/overview/);
  });

  it('responseSchema 把 title 列為必填，回應缺 title 時拋錯，不回一份沒名字的分析', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });
    await client().analyzeTranscript({ transcript });
    const schema = (generateContent.mock.calls[0][0] as any).config.responseSchema;
    expect(schema.required).toContain('title');

    generateContent.mockResolvedValue({ text: JSON.stringify({ ...okOutput, title: undefined }) });
    await expect(client().analyzeTranscript({ transcript })).rejects.toThrow(/title/);
  });

  it('紀錄的 configuredMaxOutputTokens 是這支呼叫實際設的上限，跟 transcribe 沒設的 null 不一樣', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(okOutput) });
    await client().analyzeTranscript({ transcript });
    expect(logged.map(l => l.configuredMaxOutputTokens)).toEqual([8192]);
  });

});

describe('全文修潤已拿掉', () => {
  it('client 上沒有 polishTranscript', () => {
    expect('polishTranscript' in client()).toBe(false);
  });
});

describe('extractTopicTags', () => {
  const transcript = [{ start: 0, end: 65, text: 'POC 時程還沒定', speaker: 'A' }];

  it('用的是題目標籤專屬的 prompt，不是 analyze 那一份', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[]}' });

    await client().extractTopicTags({ transcript });

    const request = generateContent.mock.calls[0][0] as any;
    // 這三段字是 U-001 第二版 prompt 的骨架（跨會議比對、具體不概括、15 到 25）。
    // 換成 analyze 的 systemInstruction 會把一場會壓成 3 到 5 個抽象標題，
    // 那個粒度下任何關聯策略都認不出同一題目
    expect(request.config.systemInstruction).toContain('跨會議比對');
    expect(request.config.systemInstruction).toContain('15 到 25');
    expect(request.config.systemInstruction).not.toContain('會議記錄師');
    // 逐字稿帶時間戳送進去，與評測那一跑吃到的形狀一致
    expect(request.contents).toContain('[00:00-01:05] A: POC 時程還沒定');
  });

  it('解析 tags 並去掉前後空白', async () => {
    generateContent.mockResolvedValue({
      text: '```json\n{"tags":[{"title":" POC 時程 ","content":" 卡在報價 "}]}\n```',
    });

    expect(await client().extractTopicTags({ transcript }))
      .toEqual([{ title: 'POC 時程', content: '卡在報價' }]);
  });

  it('空陣列是合法結果：那是「這份逐字稿沒有可抽的題目」，由上層記成 empty', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[]}' });
    expect(await client().extractTopicTags({ transcript })).toEqual([]);
  });

  it('回的不是合法 JSON 時拋錯，不退成空陣列：空陣列跟「真的沒有題目」分不開', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[{"title":"被截斷' });
    await expect(client().extractTopicTags({ transcript })).rejects.toThrow(/不是合法 JSON/);
  });

  it('沒有 tags 陣列時拋錯，不當成沒抽到', async () => {
    generateContent.mockResolvedValue({ text: '{"topics":[]}' });
    await expect(client().extractTopicTags({ transcript })).rejects.toThrow(/沒有 tags 陣列/);
  });

  it('某一條缺 title 時整份拋掉，不偷偷跳過壞掉的那幾條', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[{"title":"好的","content":"x"},{"content":"沒有標題"}]}' });
    await expect(client().extractTopicTags({ transcript })).rejects.toThrow(/第 1 條沒有 title/);
  });

  it('紀錄的 kind 是 extract-tags：算得出這件事燒掉多少額度', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[]}' });
    await client().extractTopicTags({ transcript });
    expect(logged.map(l => l.kind)).toEqual(['extract-tags']);
  });
});

describe('isTransientLlmError', () => {
  it('限流與過載算 transient，其餘算 fatal', () => {
    // 這一支是 W4 從 generateContentWithFallback 的 body 抽出來的（判斷字串逐字相同），
    // 抽出來是為了 embedding 那條沒有 fallback 鏈的路徑也用同一把尺
    expect(isTransientLlmError(new Error('429 RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isTransientLlmError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientLlmError(new Error('model is overloaded'))).toBe(true);
    expect(isTransientLlmError(new Error('invalid api key'))).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
  });
});

describe('限流退避（vault plan「MeetPilot · Gemini 限流退避」）', () => {
  it('照回應的 retryDelay 等完才重試同一個模型，紀錄留下等了多久與來源（AC-1、AC-4）', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateContent
      .mockRejectedValueOnce(rateLimited([quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), retryInfo('20s')]))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([]);
    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
    expect(logged.map(l => [l.outcome, l.transientReason ?? null, l.backoffMs ?? null, l.backoffSource ?? null])).toEqual([
      ['transient', 'rate_limited', 20_000, 'retry-info'],
      ['ok', null, null, null],
    ]);
  });

  it('回應沒給 retryDelay 就等 5 秒；同一個模型第二次也撞到就直接換模型，不再等', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateContent
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([]);
    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual([
      'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite',
    ]);
    expect(logged.map(l => [l.backoffMs ?? null, l.backoffSource ?? null])).toEqual([[5_000, 'backoff'], [null, null], [null, null]]);
  });

  it('沒給 retryDelay 時等待時間整條鏈累計加倍，換了模型不歸零：5 秒、10 秒', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateContent
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(5_000);
    // 第 1 個模型等 5 秒後再試、又撞到就換第 2 個模型；第 2 個模型第一次撞到要等 10 秒，不是 5 秒
    expect(generateContent).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(generateContent).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([]);
    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual([
      'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite',
    ]);
    expect(logged.map(l => l.backoffMs ?? null)).toEqual([5_000, null, 10_000, null]);
  });

  it('每日額度用完不在這個模型上等，直接換下一個模型（AC-2）', async () => {
    vi.useFakeTimers();
    generateContent
      .mockRejectedValueOnce(rateLimited([quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo('50000s')]))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual([]);
    expect(generateContent.mock.calls.map(c => (c[0] as any).model)).toEqual(['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
    expect(logged.map(l => [l.modelIndex, l.backoffMs ?? null, l.backoffSource ?? null])).toEqual([[0, 0, 'daily-quota'], [1, null, null]]);
  });

  it('503 不算限流，維持原本 1 秒的等法，紀錄不填等待欄位', async () => {
    vi.useFakeTimers();
    generateContent
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
    expect(logged.map(l => [l.backoffMs ?? null, l.backoffSource ?? null])).toEqual([[null, null], [null, null]]);
  });

  it('解析不到的 429（不是 JSON，訊息也沒有 429 字樣）照樣走退避，不拋解析錯誤（AC-5）', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    generateContent
      .mockRejectedValueOnce(Object.assign(new Error('<html>Too Many Requests</html>'), { status: 429 }))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const pending = client().transcribeSlice({ base64Data: 'AAAA' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual([]);
    expect(logged[0]).toMatchObject({ transientReason: 'rate_limited', backoffMs: 5_000, backoffSource: 'backoff' });
  });
});

describe('embedTopicTags（W4）', () => {
  it('分批送出，回來的順序就是送出去的順序', async () => {
    embedContent.mockImplementation((request: any) => ({
      embeddings: request.contents.map((text: string) => ({ values: [text.length, 0, 0] })),
    }));

    const batch = await client().embedTopicTags(['一', '兩個字', '三個字啦']);

    expect(batch.model).toBe(EMBEDDING_MODEL);
    expect(batch.dimensions).toBe(3);
    expect(batch.vectors).toEqual([[1, 0, 0], [3, 0, 0], [4, 0, 0]]);
    expect(logged.map(l => [l.kind, l.outcome])).toEqual([['embed', 'ok']]);
  });

  it('沒有標籤時不打 API', async () => {
    const batch = await client().embedTopicTags([]);
    expect(embedContent).not.toHaveBeenCalled();
    expect(batch.vectors).toEqual([]);
  });

  it('回來的筆數對不上就整批拋掉，不按順序硬對', async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [1, 2, 3] }] });
    await expect(client().embedTopicTags(['甲', '乙'])).rejects.toThrow(/回傳 1 筆，送出 2 筆/);
  });

  it('同一批出現兩種維度就拋錯', async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [1, 2, 3] }, { values: [1, 2] }] });
    await expect(client().embedTopicTags(['甲', '乙'])).rejects.toThrow(/維度不一致/);
  });

  it('向量裡有非數字或非有限值就拋錯（Codex 2026-09-15 findings 4）', async () => {
    // 不擋的話：null 轉 Float32Array 被 coercion 成 0、字串變 NaN，而 NaN 進 cosine 之後
    // 每個比較都是 false，結果是 0 個候選、狀態 LINKED、空集合——跟「這場會真的沒有同題目的會」
    // 在資料上完全一樣
    embedContent.mockResolvedValue({ embeddings: [{ values: [1, null, 3] }] });
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/第 1 個值不是有限數字/);

    embedContent.mockResolvedValue({ embeddings: [{ values: [1, 'bad', 3] }] });
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/不是有限數字/);

    embedContent.mockResolvedValue({ embeddings: [{ values: [1, NaN, 3] }] });
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/不是有限數字/);
  });

  it('空的向量就拋錯，不當成一條合法的標籤向量', async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [] }] });
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/embedding 是空的/);
  });

  it('失敗時紀錄分得出 transient 與 fatal，而且不退到別的 embedding model', async () => {
    embedContent.mockRejectedValue(new Error('503 Service Unavailable'));
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/503/);

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(logged.map(l => [l.kind, l.model, l.outcome])).toEqual([['embed', EMBEDDING_MODEL, 'transient']]);
  });

  it('撞到限流照等法重試，最多 3 次，一直是同一個 embedding model（AC-3）', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    embedContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    const pending = client().embedTopicTags(['甲']);
    const settled = pending.then(() => new Error('應該要失敗'), (err: Error) => err);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(embedContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 10_000);

    expect((await settled).message).toMatch(/429/);
    expect(embedContent).toHaveBeenCalledTimes(3);
    expect(embedContent.mock.calls.every(c => (c[0] as any).model === EMBEDDING_MODEL)).toBe(true);
    expect(logged.map(l => [l.attempt, l.outcome, l.backoffMs ?? null, l.backoffSource ?? null])).toEqual([
      [1, 'transient', 5_000, 'backoff'],
      [2, 'transient', 10_000, 'backoff'],
      [3, 'transient', null, null],
    ]);
  });

  it('限流之後重試成功，ok 那一行記的是第幾次', async () => {
    vi.useFakeTimers();
    embedContent
      .mockRejectedValueOnce(rateLimited([retryInfo('2s')]))
      .mockResolvedValueOnce({ embeddings: [{ values: [1, 2, 3] }] });

    const pending = client().embedTopicTags(['甲']);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toMatchObject({ dimensions: 3 });
    expect(logged.map(l => [l.attempt, l.outcome, l.backoffSource ?? null])).toEqual([[1, 'transient', 'retry-info'], [2, 'ok', null]]);
  });

  it('embedding 每日額度用完就不等，直接拋', async () => {
    embedContent.mockRejectedValue(rateLimited([quotaFailure('EmbedContentRequestsPerDayPerProject')]));

    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/RESOURCE_EXHAUSTED/);
    expect(embedContent).toHaveBeenCalledTimes(1);
  });
});

describe('judgeMeetingPair（W4 的 S3）', () => {
  const tags = (titles: string[]) => titles.map(title => ({ title, content: `${title} 的內容` }));

  const judgeReply = (body: unknown) => {
    generateContent.mockResolvedValue({ text: JSON.stringify(body) });
  };

  const judge = () => client().judgeMeetingPair({
    idA: 'm-1', tagsA: tags(['自動貼標']), idB: 'm-2', tagsB: tags(['標籤管理']),
  });

  it('把兩場會的標籤排成編號清單送出去，紀錄記成 link-judge', async () => {
    judgeReply({ sameTopic: true, confidence: 0.85, reason: '同一件事', sharedTopics: ['貼標'] });

    const result = await judge();
    expect(result).toEqual({ sameTopic: true, confidence: 0.85, reason: '同一件事', sharedTopics: ['貼標'] });

    const request = generateContent.mock.calls[0][0];
    expect(request.contents).toContain('1. 自動貼標：自動貼標 的內容');
    expect(request.contents).toContain('1. 標籤管理：標籤管理 的內容');
    expect(logged.map(l => l.kind)).toEqual(['link-judge']);
  });

  it('解不開的回應拋錯，不退成「判為不相關」', async () => {
    generateContent.mockResolvedValue({ text: '{"sameTopic": tr' });
    // 退成 false 的話，「模型說沒關係」與「我們沒問成功」會長得一模一樣，
    // 而後者應該讓這一對留在「還沒判過」
    await expect(judge()).rejects.toThrow(/不是合法 JSON/);
  });

  it('沒有判定理由就拒收', async () => {
    judgeReply({ sameTopic: true, confidence: 0.9, reason: '   ', sharedTopics: [] });
    // FN-04 的驗收條件是「每筆判定必須帶可被人否決的理由」。只有信心值的話人無從否決
    await expect(judge()).rejects.toThrow(/沒有判定理由/);
  });

  it('信心值超出 0 到 1 就拒收，不夾回範圍內', async () => {
    judgeReply({ sameTopic: true, confidence: 1.4, reason: '理由', sharedTopics: [] });
    await expect(judge()).rejects.toThrow(/不在 0 到 1 之間/);
  });

  it('sameTopic 不是布林就拒收', async () => {
    judgeReply({ sameTopic: 'yes', confidence: 0.9, reason: '理由', sharedTopics: [] });
    await expect(judge()).rejects.toThrow(/沒有布林的 sameTopic/);
  });

  it('sharedTopics 不是字串陣列就拒收', async () => {
    judgeReply({ sameTopic: true, confidence: 0.9, reason: '理由', sharedTopics: [{ x: 1 }] });
    await expect(judge()).rejects.toThrow(/sharedTopics 不是字串陣列/);
  });

  it('紀錄的 meetingId 是 idA（發起關聯的那場會），不是 idB', async () => {
    judgeReply({ sameTopic: true, confidence: 0.9, reason: '理由', sharedTopics: [] });
    await judge();
    expect(logged.map(l => l.meetingId)).toEqual(['m-1']);
  });
});

describe('meetingId 記進 telemetry，事後才查得出單場會議花了多少 token', () => {
  it('transcribeSlice 有傳 meetingId 就記得下來', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });
    await client().transcribeSlice({ base64Data: 'AAAA', meetingId: 'meeting-1' });
    expect(logged.map(l => l.meetingId)).toEqual(['meeting-1']);
  });

  it('transcribeSlice 沒傳 meetingId 就記 null，不是猜一個值', async () => {
    generateContent.mockResolvedValue({ text: '{"segments":[]}' });
    await client().transcribeSlice({ base64Data: 'AAAA' });
    expect(logged.map(l => l.meetingId)).toEqual([null]);
  });

  it('analyzeTranscript 有傳 meetingId 就記得下來', async () => {
    generateContent.mockResolvedValue({
      text: '{"title":"t","overview":"x","topics":[],"decisions":[],"action_items":[],"open_questions":[]}',
    });
    await client().analyzeTranscript({
      transcript: [{ start: 0, end: 1, text: 'x', speaker: 'A' }],
      meetingId: 'meeting-2',
    });
    expect(logged.map(l => l.meetingId)).toEqual(['meeting-2']);
  });

  it('extractTopicTags 有傳 meetingId 就記得下來', async () => {
    generateContent.mockResolvedValue({ text: '{"tags":[]}' });
    await client().extractTopicTags({
      transcript: [{ start: 0, end: 1, text: 'x', speaker: 'A' }],
      meetingId: 'meeting-3',
    });
    expect(logged.map(l => l.meetingId)).toEqual(['meeting-3']);
  });

  it('embedTopicTags 有傳 meetingId 就記得下來', async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [1, 0, 0] }] });
    await client().embedTopicTags(['一段字'], 'meeting-4');
    expect(logged.map(l => l.meetingId)).toEqual(['meeting-4']);
  });
});

describe('MEETPILOT_GEMINI_MAX_CONCURRENCY（AC-6，兩條 queue 共用的全域併發上限）', () => {
  afterEach(() => {
    delete process.env.MEETPILOT_GEMINI_MAX_CONCURRENCY;
  });

  it('不是正整數時建 client 就拋錯，不靜默退成無限制', () => {
    process.env.MEETPILOT_GEMINI_MAX_CONCURRENCY = '0';
    expect(() => client()).toThrow(/MEETPILOT_GEMINI_MAX_CONCURRENCY/);

    process.env.MEETPILOT_GEMINI_MAX_CONCURRENCY = '不是數字';
    expect(() => client()).toThrow(/MEETPILOT_GEMINI_MAX_CONCURRENCY/);
  });

  it('沒設時預設 2：兩個呼叫可以同時在飛，不用等對方結束', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let resolveSecond: (value: unknown) => void = () => {};
    generateContent
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const c = client();
    const first = c.transcribeSlice({ base64Data: 'AAAA' });
    const second = c.transcribeSlice({ base64Data: 'BBBB' });
    await Promise.resolve();
    await Promise.resolve();

    // 兩個都已經真的打進 generateContent，不是第二個卡在等第一個
    expect(generateContent).toHaveBeenCalledTimes(2);

    resolveFirst({ text: '{"segments":[]}' });
    resolveSecond({ text: '{"segments":[]}' });
    await Promise.all([first, second]);
  });

  it('設成 1 時，第二個呼叫要等第一個結束才真的打進 generateContent', async () => {
    process.env.MEETPILOT_GEMINI_MAX_CONCURRENCY = '1';
    let resolveFirst: (value: unknown) => void = () => {};
    generateContent
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ text: '{"segments":[]}' });

    const c = client();
    const first = c.transcribeSlice({ base64Data: 'AAAA' });
    const second = c.transcribeSlice({ base64Data: 'BBBB' });
    await Promise.resolve();
    await Promise.resolve();

    // 第二個還卡在信號量外面，generateContent 只被叫過一次
    expect(generateContent).toHaveBeenCalledTimes(1);

    resolveFirst({ text: '{"segments":[]}' });
    await first;
    await second;

    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});

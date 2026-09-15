import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LlmCallInput } from './llmTelemetry';

// @google/genai 整包換掉：這些測試要驗的是 prompt 組裝、fallback 鏈與回應解析，
// 不是真的去打 Gemini。vi.hoisted 是因為 vi.mock 的 factory 會被提到 import 之前執行
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (request: unknown) => generateContent(request) };
  },
  Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', NUMBER: 'NUMBER' },
}));

const {
  cleanJsonString,
  createGeminiServerClient,
  formatTranscriptForAI,
  formatTranscriptWithTimeForAI,
} = await import('./geminiServerClient');

let logged: LlmCallInput[];
const client = () => createGeminiServerClient({ log: (input) => logged.push(input) });

beforeEach(() => {
  logged = [];
  generateContent.mockReset();
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
  it('每段帶 [MM:SS-MM:SS] 時間戳，Chat 的引用靠它', () => {
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
  });

  it('不可重試的錯誤第一次就往上拋，不退到 fallback 鏈後面', async () => {
    generateContent.mockRejectedValue(new Error('400 Invalid argument'));

    await expect(client().transcribeSlice({ base64Data: 'AAAA' })).rejects.toThrow('400 Invalid argument');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(logged.map(l => l.outcome)).toEqual(['fatal']);
  });
});

describe('analyzeTranscript', () => {
  it('回傳解析後的 GeminiOutput，並把標籤與背景帶進 prompt', async () => {
    generateContent.mockResolvedValue({
      text: '```json\n{"overview":"主旨","topics":[],"decisions":["d"],"action_items":["a"]}\n```',
    });

    const result = await client().analyzeTranscript({
      transcript: [{ start: 0, end: 1, text: '討論採購', speaker: 'A' }],
      meetingTags: ['採購'],
      meetingContext: '第三次會',
    });

    expect(result).toEqual({ overview: '主旨', topics: [], decisions: ['d'], action_items: ['a'] });
    const request = generateContent.mock.calls[0][0] as any;
    expect(request.contents).toContain('會議標籤：採購');
    expect(request.contents).toContain('背景補充：第三次會');
    expect(request.contents).toContain('A: 討論採購');
  });

  it('回的內容不是合法 JSON 時拋錯，不回一份空的分析', async () => {
    generateContent.mockResolvedValue({ text: '抱歉，我無法處理' });
    await expect(client().analyzeTranscript({ transcript: [{ start: 0, end: 1, text: 'x' }] }))
      .rejects.toThrow();
  });
});

describe('polishTranscript', () => {
  it('模型沒回內容時給固定字串，維持既有路由的回應形狀', async () => {
    generateContent.mockResolvedValue({ text: '' });
    expect(await client().polishTranscript([{ start: 0, end: 1, text: 'x' }])).toBe('無法生成修潤內容');
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

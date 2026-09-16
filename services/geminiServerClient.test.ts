import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LlmCallInput } from './llmTelemetry';

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
  Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' },
}));

const {
  EMBEDDING_MODEL,
  cleanJsonString,
  createGeminiServerClient,
  formatTranscriptForAI,
  formatTranscriptWithTimeForAI,
  isTransientLlmError,
} = await import('./geminiServerClient');

let logged: LlmCallInput[];
const client = () => createGeminiServerClient({ log: (input) => logged.push(input) });

beforeEach(() => {
  logged = [];
  generateContent.mockReset();
  embedContent.mockReset();
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
    embedContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));
    await expect(client().embedTopicTags(['甲'])).rejects.toThrow(/429/);

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(logged.map(l => [l.kind, l.model, l.outcome])).toEqual([['embed', EMBEDDING_MODEL, 'transient']]);
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
      text: '{"overview":"x","topics":[],"decisions":[],"action_items":[]}',
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

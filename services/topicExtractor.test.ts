import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { TranscriptSegment } from '../types';
import { ExtractedTopicTag, GeminiServerClient } from './geminiServerClient';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { MATCH_KEY_VERSION } from './topicTag';
import { createTopicExtractor } from './topicExtractor';

const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let store: MeetingStore;

const fakeGemini = (extract: () => Promise<ExtractedTopicTag[]>): GeminiServerClient => ({
  transcribeSlice: async () => [],
  polishTranscript: async () => '',
  analyzeTranscript: async () => ({ overview: 'x', topics: [], decisions: [], action_items: [], open_questions: [] }),
  extractTopicTags: extract,
  embeddingModel: 'fake-embedding',
  // W4 的兩支。這一層不算關聯，形狀要在，缺了型別就對不上
  embedTopicTags: async (texts) => ({ model: 'fake-embedding', dimensions: 1, vectors: texts.map(() => [1]) }),
  judgeMeetingPair: async () => ({ sameTopic: false, confidence: 0, reason: '假的判定', sharedTopics: [] }),
});

const extractorWith = (extract: () => Promise<ExtractedTopicTag[]>) =>
  createTopicExtractor({ store, gemini: fakeGemini(extract), now: () => T0 + 1 });

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  store.createMeeting({ meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10 });
  store.saveTranscript('m-1', { segments: [{ start: 0, end: 5, text: '今天談 POC 時程' }], polished_content: null }, T0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('extract：正常路徑', () => {
  it('抽到的標籤帶著算好的比對鍵落地，狀態是 ok', async () => {
    const summary = await extractorWith(async () => [
      { title: 'ＰＯＣ 的時程', content: '卡在廠商報價' },
      { title: '知識庫維護', content: '誰維護還沒定' },
    ]).extract('m-1');

    expect(summary).toEqual({ status: 'ok', inserted: 2, error: null });
    // 順序是 store 的排序鍵（created_at、title、tag_id）決定的，不是插入順序
    expect(store.getTopicTags('m-1').map(t => [t.title, t.match_key, t.match_key_version])).toEqual([
      ['知識庫維護', '知識庫維護', MATCH_KEY_VERSION],
      ['ＰＯＣ 的時程', 'poc時程', MATCH_KEY_VERSION],
    ]);
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('ok');
  });

  it('送出去的是整份逐字稿，不是其中一片', async () => {
    store.saveTranscript('m-1', {
      segments: [
        { start: 0, end: 5, text: '第一段' },
        { start: 5, end: 9, text: '第二段' },
      ],
      polished_content: null,
    }, T0);
    const seen: TranscriptSegment[][] = [];
    const gemini = fakeGemini(async () => []);
    gemini.extractTopicTags = async (input) => { seen.push(input.transcript); return []; };

    await createTopicExtractor({ store, gemini, now: () => T0 + 1 }).extract('m-1');

    expect(seen).toHaveLength(1);
    expect(seen[0].map(s => s.text)).toEqual(['第一段', '第二段']);
  });
});

describe('extract：抽不到東西時不讓這場會失敗（AC-4、Q2 裁決）', () => {
  it('模型丟錯時記成 failed 並留下原因，**不往上拋**', async () => {
    const summary = await extractorWith(async () => {
      throw new Error('題目標籤的回應不是合法 JSON（模型輸出可能被截斷）');
    }).extract('m-1');

    expect(summary.status).toBe('failed');
    expect(summary.error).toMatch(/不是合法 JSON/);
    const meeting = store.getMeeting('m-1');
    expect(meeting?.topic_extraction_status).toBe('failed');
    expect(meeting?.topic_extraction_error).toMatch(/不是合法 JSON/);
  });

  it('模型回空陣列時記成 empty：那種會永遠不會參與關聯，要查得出來', async () => {
    const summary = await extractorWith(async () => []).extract('m-1');

    expect(summary).toEqual({ status: 'empty', inserted: 0, error: null });
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('empty');
    expect(store.getMeeting('m-1')?.topic_extraction_error).toBeNull();
  });

  it('標記是資料不是 log：抽不到的會可以用一句 SQL 撈出來', async () => {
    store.createMeeting({ meeting_id: 'm-2', created_at: T0, source_file_name: 'b.m4a', source_file_size: 10 });
    store.saveTranscript('m-2', { segments: [{ start: 0, end: 1, text: 'x' }], polished_content: null }, T0);
    await extractorWith(async () => []).extract('m-1');
    await extractorWith(async () => [{ title: 'POC 時程', content: '內容' }]).extract('m-2');

    const stuck = db.prepare(
      "SELECT meeting_id FROM meetings WHERE topic_extraction_status IS NULL OR topic_extraction_status <> 'ok'",
    ).all() as { meeting_id: string }[];

    expect(stuck.map(r => r.meeting_id)).toEqual(['m-1']);
  });
});

describe('extract：算不出比對鍵的標籤', () => {
  it('丟掉那一條，其餘照樣落地', async () => {
    const summary = await extractorWith(async () => [
      { title: '相關討論', content: '整條都是停用詞' },
      { title: 'POC 時程', content: '內容' },
    ]).extract('m-1');

    expect(summary.inserted).toBe(1);
    expect(store.getTopicTags('m-1').map(t => t.title)).toEqual(['POC 時程']);
  });

  it('全部都算不出來時記成 empty，不寫一批比不了的標籤進表', async () => {
    const summary = await extractorWith(async () => [{ title: '相關討論', content: 'x' }]).extract('m-1');

    expect(summary.status).toBe('empty');
    expect(store.getTopicTags('m-1')).toEqual([]);
  });
});

describe('extract：前置條件', () => {
  it('沒有逐字稿時拋錯，不記成 failed 混在模型錯誤裡', async () => {
    store.createMeeting({ meeting_id: 'm-3', created_at: T0, source_file_name: 'c.m4a', source_file_size: 1 });

    await expect(extractorWith(async () => []).extract('m-3')).rejects.toThrow(/沒有逐字稿/);
    expect(store.getMeeting('m-3')?.topic_extraction_status).toBeNull();
  });
});

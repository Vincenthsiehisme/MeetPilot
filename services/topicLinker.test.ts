/**
 * TopicLinker 的整條鏈（W4，`FN-04`）：狀態推進、候選、判定、覆蓋率、排除黏著、重算。
 *
 * 用真的 SQLite（`:memory:`）配假的 Gemini。假的是模型那一層，不是儲存那一層——
 * 排除紀錄黏不黏得住、重算 idempotent 不 idempotent，都是儲存層的行為，用假 store 測等於沒測。
 *
 * **這裡驗的是機制（AC-1a），不是關聯品質（AC-1b）。** 品質要對評測集跑真實的 embedding 與
 * S3 判定，2026-09-15 使用者裁決不花額度，所以那一條在這一包是未達成，不要把這支測試全綠
 * 讀成「關聯做得準」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { EmbeddingBatch, GeminiServerClient, JudgeMeetingPairInput } from './geminiServerClient';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { MATCH_KEY_VERSION, toMatchKey } from './topicTag';
import { LINK_ALGO_VERSION } from './topicLink';
import { TopicLinkerDeps, createTopicLinker, isLinkingEnabled } from './topicLinker';

const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let store: MeetingStore;

/** 每條標籤的向量由標題前綴決定，測試才控制得住誰跟誰像 */
const VECTORS: Record<string, number[]> = {
  甲: [1, 0, 0],
  乙: [0, 1, 0],
};

const vectorFor = (text: string): number[] => VECTORS[text.slice(0, 1)] ?? [0, 0, 1];

interface FakeOptions {
  judge?: (input: JudgeMeetingPairInput) => Promise<{
    sameTopic: boolean; confidence: number; reason: string; sharedTopics: string[];
  }>;
  embed?: (texts: readonly string[]) => Promise<EmbeddingBatch>;
  /** 換 model 的情境用。預設 test-embedding，跟 embed 假回的 model 一致 */
  embeddingModel?: string;
}

const judged: string[] = [];
const embedded: string[][] = [];

const fakeGemini = (options: FakeOptions = {}): GeminiServerClient => ({
  embeddingModel: options.embeddingModel ?? 'test-embedding',
  transcribeSlice: async () => [],
  polishTranscript: async () => '',
  analyzeTranscript: async () => ({ overview: 'x', topics: [], decisions: [], action_items: [], open_questions: [] }),
  extractTopicTags: async () => [],
  embedTopicTags: options.embed ?? (async (texts) => {
    embedded.push([...texts]);
    return { model: 'test-embedding', dimensions: 3, vectors: texts.map(vectorFor) };
  }),
  judgeMeetingPair: options.judge ?? (async (input) => {
    judged.push(`${input.idA}×${input.idB}`);
    return { sameTopic: true, confidence: 0.9, reason: '兩場都在談同一件事', sharedTopics: ['共同題目'] };
  }),
});

/** 把一場會推到 READY 並給它幾條題目標籤 */
const readyMeeting = (id: string, tagTitles: readonly string[]): void => {
  store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: `${id}.m4a`, source_file_size: 1 });
  store.setStatus(id, 'TRANSCRIBING', T0);
  store.setStatus(id, 'ANALYZING', T0);
  store.setStatus(id, 'READY', T0);
  if (tagTitles.length === 0) return;
  store.saveTopicExtraction(id, {
    status: 'ok',
    tags: tagTitles.map(title => ({
      title,
      content: `${title} 的內容`,
      match_key: toMatchKey(title),
      match_key_version: MATCH_KEY_VERSION,
    })),
  }, T0);
};

const linkerWith = (options: FakeOptions = {}, config?: TopicLinkerDeps['config']) =>
  createTopicLinker({ store, gemini: fakeGemini(options), now: () => T0 + 1, config });

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  judged.length = 0;
  embedded.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('正常路徑', () => {
  beforeEach(() => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-same', ['甲四', '甲五', '甲六']);
    readyMeeting('m-other', ['乙一', '乙二', '乙三']);
  });

  it('S2 選出同題目的那場、S3 判完之後關聯落地，狀態走到 LINKED', async () => {
    const summary = await linkerWith().link('m-new');

    expect(summary.status).toBe('LINKED');
    expect(summary.links).toBe(1);
    expect(store.getMeeting('m-new')?.status).toBe('LINKED');

    // 只有向量對得上的那場被送去判，方向不同的那場連判都沒判
    expect(judged).toEqual(['m-new×m-same']);

    const links = store.getLinks('m-new');
    expect(links).toHaveLength(1);
    expect([links[0].meeting_a, links[0].meeting_b].sort()).toEqual(['m-new', 'm-same']);
    expect(links[0].confidence).toBe(0.9);
    expect(links[0].algo_version).toBe(LINK_ALGO_VERSION);
    expect(links[0].shared_topics).toEqual(['共同題目']);
    // 判定理由要留得下來，不能只有信心值（FN-04 的驗收條件）
    expect(links[0].evidence).toContain('兩場都在談同一件事');
    expect(links[0].evidence).toContain('S2');
  });

  it('關聯從對方那一側也查得到：A×B 只存一列', async () => {
    await linkerWith().link('m-new');
    expect(store.getLinks('m-same')).toHaveLength(1);
  });

  it('覆蓋率落地，看得出候選幾對、判了幾對', async () => {
    await linkerWith().link('m-new');
    const run = store.getLinkRun('m-new');
    expect(run).toMatchObject({
      meeting_id: 'm-new',
      algo_version: LINK_ALGO_VERSION,
      candidates: 1,
      judged: 1,
      skipped_cap: 0,
      skipped_excluded: 0,
      skipped_error: 0,
      error: null,
    });
  });

  it('向量只算一次，第二次重算不再打 embedding（Q2 的快取那一半）', async () => {
    await linkerWith().link('m-new');
    const firstRound = embedded.length;
    expect(firstRound).toBeGreaterThan(0);

    await linkerWith().link('m-new');
    expect(embedded.length).toBe(firstRound);
  });

  it('S3 說不是同題目時不寫關聯，但狀態照樣是 LINKED', async () => {
    const summary = await linkerWith({
      judge: async () => ({ sameTopic: false, confidence: 0.1, reason: '只是都提到客服', sharedTopics: [] }),
    }).link('m-new');

    expect(summary.status).toBe('LINKED');
    expect(store.getLinks('m-new')).toEqual([]);
    // 「算過了，沒有同題目的會」跟「還沒算」「算壞了」要分得開（AC-4）
    expect(store.getMeeting('m-new')?.status).toBe('LINKED');
    expect(store.getMeeting('m-new')?.error).toBeNull();
    expect(store.getLinkRun('m-new')?.judged).toBe(1);
  });

  it('信心值沒到門檻的不寫，即使模型說是同題目', async () => {
    const summary = await linkerWith({
      judge: async () => ({ sameTopic: true, confidence: 0.49, reason: '有點像', sharedTopics: [] }),
    }).link('m-new');

    expect(summary.links).toBe(0);
    expect(store.getLinks('m-new')).toEqual([]);
    // 判過了，所以不是沒判到
    expect(store.getLinkRun('m-new')?.judged).toBe(1);
  });
});

describe('AC-4：三種狀態分得開', () => {
  it('一個候選都沒有時是 LINKED＋空集合＋candidates 0', async () => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-other', ['乙一', '乙二', '乙三']);

    const summary = await linkerWith().link('m-new');
    expect(summary.status).toBe('LINKED');
    expect(store.getLinks('m-new')).toEqual([]);
    expect(store.getLinkRun('m-new')?.candidates).toBe(0);
    expect(judged).toEqual([]);
  });

  it('一場標籤都沒有的會照樣走到 LINKED，不會卡在 READY', async () => {
    readyMeeting('m-empty', []);
    readyMeeting('m-other', ['甲一', '甲二', '甲三']);

    const summary = await linkerWith().link('m-empty');
    expect(summary.status).toBe('LINKED');
    expect(store.getLinkRun('m-empty')?.candidates).toBe(0);
  });

  it('embedding 掛掉是 LINK_FAILED 並留下原因，不是空集合', async () => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);

    const summary = await linkerWith({
      embed: async () => { throw new Error('embedding 的額度用完了'); },
    }).link('m-new');

    expect(summary.status).toBe('LINK_FAILED');
    const meeting = store.getMeeting('m-new');
    expect(meeting?.status).toBe('LINK_FAILED');
    // 關聯失敗的原因不落地的話，之後查「為什麼這場沒關聯到」沒有證據
    expect(meeting?.error).toContain('embedding 的額度用完了');
    expect(store.getLinkRun('m-new')?.error).toContain('embedding 的額度用完了');
  });
});

describe('Q3：判不完的時候', () => {
  beforeEach(() => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-a', ['甲四', '甲五', '甲六']);
    readyMeeting('m-b', ['甲七', '甲八', '甲九']);
  });

  it('判了一半撞牆：LINKED＋已判出的關聯留著＋skipped_error 記下來', async () => {
    let calls = 0;
    const summary = await linkerWith({
      judge: async (input) => {
        calls += 1;
        if (calls > 1) throw new Error('429 每日額度用完');
        judged.push(`${input.idA}×${input.idB}`);
        return { sameTopic: true, confidence: 0.8, reason: '同一題', sharedTopics: [] };
      },
    }).link('m-new');

    expect(summary.status).toBe('LINKED');
    expect(store.getLinks('m-new')).toHaveLength(1);

    const run = store.getLinkRun('m-new')!;
    expect(run.candidates).toBe(2);
    expect(run.judged).toBe(1);
    expect(run.skipped_error).toBe(1);
    expect(run.error).toContain('429');
    // 第一次失敗就停，不把剩下的每一對都拿去重打整條 fallback 鏈
    expect(calls).toBe(2);
  });

  it('一對都沒判成功是 LINK_FAILED，而且不動既有的關聯', async () => {
    await linkerWith().link('m-new');
    expect(store.getLinks('m-new')).toHaveLength(2);

    const summary = await linkerWith({
      judge: async () => { throw new Error('429 每日額度用完'); },
    }).link('m-new');

    expect(summary.status).toBe('LINK_FAILED');
    // 這一輪沒算到不代表上一輪算到的是錯的（理由同 W3 的 empty／failed 不刪既有標籤）
    expect(store.getLinks('m-new')).toHaveLength(2);
    expect(store.getMeeting('m-new')?.error).toContain('429');
    expect(store.getLinkRun('m-new')?.judged).toBe(0);
  });

  it('候選上限：分數低的那幾對進 skipped_cap，不是安靜消失', async () => {
    const summary = await linkerWith({}, { candidateLimit: 1 }).link('m-new');

    expect(summary.status).toBe('LINKED');
    const run = store.getLinkRun('m-new')!;
    expect(run.candidates).toBe(2);
    expect(run.judged).toBe(1);
    expect(run.skipped_cap).toBe(1);
  });
});

describe('換 embedding model（Codex 2026-09-15 findings 6）', () => {
  beforeEach(() => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-same', ['甲四', '甲五', '甲六']);
  });

  it('舊 model 算的向量會被重算，不會留下一組比不了的向量', async () => {
    await linkerWith().link('m-new');
    expect(store.getTagVectors('m-new').every(v => v.model === 'test-embedding')).toBe(true);
    embedded.length = 0;

    // 換一個 model 的 client 再跑一次
    const nextModel = async (texts: readonly string[]) => {
      embedded.push([...texts]);
      return { model: 'next-embedding', dimensions: 3, vectors: texts.map(vectorFor) };
    };
    const summary = await linkerWith({ embeddingModel: 'next-embedding', embed: nextModel }).link('m-new');

    // 兩場會的標籤都被重算成新 model，關聯照樣成立
    expect(embedded.length).toBeGreaterThan(0);
    expect(store.getTagVectors('m-new').every(v => v.model === 'next-embedding')).toBe(true);
    expect(store.getTagVectors('m-same').every(v => v.model === 'next-embedding')).toBe(true);
    expect(summary.status).toBe('LINKED');
    expect(summary.links).toBe(1);
    expect(store.getLinkRun('m-new')?.incomparable_pairs).toBe(0);
  });

  it('真的出現比不了的向量時，incomparable_pairs 講得出來', async () => {
    // 手動塞一組維度對不上的向量，模擬重算沒補到的殘留
    const tags = store.getTopicTags('m-same');
    store.saveTagVectors(
      tags.map(t => ({ tag_id: t.tag_id, model: 'test-embedding', dimensions: 2, vector: [1, 0] })),
      T0,
    );

    const summary = await linkerWith().link('m-new');

    // 一個候選都沒有，狀態是 LINKED ＋ 空集合——跟「真的沒有同題目的會」長得一樣，
    // 唯一分得開的是這個數字
    expect(summary.status).toBe('LINKED');
    expect(store.getLinks('m-new')).toEqual([]);
    expect(store.getLinkRun('m-new')?.candidates).toBe(0);
    expect(store.getLinkRun('m-new')!.incomparable_pairs).toBeGreaterThan(0);
  });
});

describe('AC-3：排除紀錄黏著', () => {
  beforeEach(() => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-same', ['甲四', '甲五', '甲六']);
  });

  it('被標為不相關的那一對，重算之後不復活，而且連判都不判', async () => {
    await linkerWith().link('m-new');
    expect(store.getLinks('m-new')).toHaveLength(1);

    store.addLinkExclusion('m-new', 'm-same', 'different_topic', T0 + 2);
    expect(store.getLinks('m-new')).toEqual([]);

    judged.length = 0;
    const summary = await linkerWith().link('m-new');

    expect(summary.links).toBe(0);
    expect(store.getLinks('m-new')).toEqual([]);
    // 連 S3 都不該打：人已經判過了，再問一次模型只是多花一次呼叫去得到一個會被丟掉的答案
    expect(judged).toEqual([]);
    expect(store.getLinkRun('m-new')?.skipped_excluded).toBe(1);
  });

  it('從對方那一側重算也一樣不復活', async () => {
    store.addLinkExclusion('m-new', 'm-same', 'outdated', T0 + 2);
    await linkerWith().link('m-same');
    expect(store.getLinks('m-same')).toEqual([]);
  });
});

describe('AC-5：帶版本、可重算、idempotent', () => {
  it('同一組輸入重算兩次，關聯內容相同', async () => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-same', ['甲四', '甲五', '甲六']);

    await linkerWith().link('m-new');
    const first = store.getLinks('m-new').map(l => [l.meeting_a, l.meeting_b, l.confidence, l.evidence]);

    await linkerWith().link('m-new');
    const second = store.getLinks('m-new').map(l => [l.meeting_a, l.meeting_b, l.confidence, l.evidence]);

    expect(second).toEqual(first);
    // 累加而不是換掉的話，重算一次就會變兩筆
    expect(store.getLinks('m-new')).toHaveLength(1);
  });

  it('重算會把上一輪算出來、這一輪不再成立的關聯拿掉', async () => {
    readyMeeting('m-new', ['甲一', '甲二', '甲三']);
    readyMeeting('m-same', ['甲四', '甲五', '甲六']);

    await linkerWith().link('m-new');
    expect(store.getLinks('m-new')).toHaveLength(1);

    await linkerWith({
      judge: async () => ({ sameTopic: false, confidence: 0, reason: '重看一次不是同一題', sharedTopics: [] }),
    }).link('m-new');
    expect(store.getLinks('m-new')).toEqual([]);
  });

  it('不是可以算關聯的狀態就拋錯，不默默算一遍', async () => {
    store.createMeeting({ meeting_id: 'm-raw', created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
    await expect(linkerWith().link('m-raw')).rejects.toThrow(/目前是 CREATED/);
  });

  it('找不到的會拋錯', async () => {
    await expect(linkerWith().link('m-nope')).rejects.toThrow(/找不到 Meeting/);
  });
});

describe('isLinkingEnabled', () => {
  it('只有 off 是關，其餘（含沒設）都是開', () => {
    expect(isLinkingEnabled({})).toBe(true);
    expect(isLinkingEnabled({ MEETPILOT_LINKING: 'on' })).toBe(true);
    expect(isLinkingEnabled({ MEETPILOT_LINKING: ' OFF ' })).toBe(false);
  });
});

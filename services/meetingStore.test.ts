import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, openMeetingDb, resolveDbPath } from './meetingDb';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { MigrationRecord } from './jobMigration';

let db: DatabaseSync;
let store: MeetingStore;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
});

afterEach(() => {
  db.close();
});

const newMeeting = (id = 'm-1') =>
  store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 10 });

const migrated = (id: string, overrides: Partial<MigrationRecord['meeting']> = {}): MigrationRecord => ({
  meeting: {
    meeting_id: id,
    title: '標題',
    status: 'READY',
    created_at: T0,
    updated_at: T0,
    source_file_name: 'a.m4a',
    source_file_size: 10,
    origin: 'migrated',
    error: null,
    processed_slices: null,
    total_slices: null,
    meeting_context: null,
    ...overrides,
  },
  transcript: { segments: [{ start: 0, end: 1, text: 'hi' }], polished_content: null },
  analysis: {
    contract_version: 2,
    overview: '標題',
    topics: [],
    decisions: ['決定 A'],
    action_items: [{ text: 't', source_meeting_id: id, created_at: T0, status: 'unknown' }],
  },
  tags: ['採購'],
});

describe('openMeetingDb', () => {
  it('建好表並把 user_version 帶到最新', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(SCHEMA_VERSION);
  });

  it('同一個檔案重開不會重跑 migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meetpilot-db-'));
    const path = join(dir, 'x.db');
    try {
      const first = openMeetingDb(path);
      first.close();
      const second = openMeetingDb(path);
      expect((second.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('資料庫版本比程式碼新時拒絕開啟，不用舊程式碼寫下去', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meetpilot-db-'));
    const path = join(dir, 'future.db');
    try {
      const ahead = new DatabaseSync(path);
      ahead.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
      ahead.close();
      expect(() => openMeetingDb(path)).toThrow(/schema 版本是/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('外鍵有打開：transcripts 指向不存在的 meeting 會被擋', () => {
    expect(() => db.prepare('INSERT INTO transcripts (meeting_id, segments, created_at) VALUES (?, ?, ?)')
      .run('nope', '[]', T0)).toThrow();
  });
});

describe('resolveDbPath', () => {
  it('沒設就用 data/meetpilot.db', () => {
    expect(resolveDbPath({})).toMatch(/data\/meetpilot\.db$/);
  });

  it(':memory: 原樣回傳，不解析成路徑', () => {
    expect(resolveDbPath({ MEETPILOT_DB: ':memory:' })).toBe(':memory:');
  });

  it('前後空白不影響', () => {
    expect(resolveDbPath({ MEETPILOT_DB: '  :memory:  ' })).toBe(':memory:');
  });
});

describe('createMeeting', () => {
  it('新建的是 CREATED 且 origin 為 native', () => {
    const m = newMeeting();
    expect(m.status).toBe('CREATED');
    expect(m.origin).toBe('native');
    expect(m.created_at).toBe(T0);
  });

  it('同一個 id 再建一次拋錯，不靜默覆蓋', () => {
    newMeeting();
    expect(() => newMeeting()).toThrow(/已經存在/);
  });
});

describe('setStatus', () => {
  it('合法轉移寫得進去', () => {
    newMeeting();
    expect(store.setStatus('m-1', 'TRANSCRIBING', T0 + 1).status).toBe('TRANSCRIBING');
  });

  it('非法轉移拋錯且不改資料', () => {
    newMeeting();
    expect(() => store.setStatus('m-1', 'READY', T0 + 1)).toThrow(/不能從 CREATED 轉到 READY/);
    expect(store.getMeeting('m-1')?.status).toBe('CREATED');
  });

  it('找不到 Meeting 時拋錯，不回 null 往下傳', () => {
    expect(() => store.setStatus('nope', 'TRANSCRIBING', T0)).toThrow(/找不到 Meeting nope/);
  });

  it('進 FAILED 記錯誤訊息，離開 FAILED 時清掉', () => {
    newMeeting();
    expect(store.setStatus('m-1', 'FAILED', T0 + 1, '轉錄失敗').error).toBe('轉錄失敗');
    expect(store.setStatus('m-1', 'CREATED', T0 + 2).error).toBeNull();
  });

  it('LINK_FAILED 也要留原因：關聯失敗的原因不落地就查不出為什麼沒關聯到', () => {
    store.importMigrated([migrated('m-ready')]);
    store.setStatus('m-ready', 'LINKING', T0 + 1);
    expect(store.setStatus('m-ready', 'LINK_FAILED', T0 + 2, 'embedding 服務逾時').error).toBe('embedding 服務逾時');
  });

  it('傳了 error 卻轉到不保留它的狀態時拋錯，不安靜丟掉呼叫端給的資訊', () => {
    newMeeting();
    expect(() => store.setStatus('m-1', 'TRANSCRIBING', T0 + 1, '某個原因'))
      .toThrow(/不會保留錯誤訊息/);
  });
});

describe('transcript 與 analysis', () => {
  it('存進去再讀出來是同一份', () => {
    newMeeting();
    const segments = [{ start: 0, end: 3, text: '開場', speaker: 'Speaker 1' }];
    store.saveTranscript('m-1', { segments, polished_content: '潤過的' }, T0);
    expect(store.getTranscript('m-1')).toEqual({ segments, polished_content: '潤過的' });
  });

  it('空的逐字稿不給存：型別對但語意空的資料不能標記成成功', () => {
    newMeeting();
    expect(() => store.saveTranscript('m-1', { segments: [], polished_content: null }, T0))
      .toThrow(/逐字稿是空的/);
  });

  it('analysis 的巢狀欄位還原成物件，不是字串', () => {
    newMeeting();
    const analysis = {
      contract_version: 2 as const,
      overview: 'x',
      topics: [{ title: 'a', content: 'b' }],
      decisions: ['d'],
      action_items: [{ text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'unknown' as const }],
    };
    store.saveAnalysis('m-1', analysis, T0);
    expect(store.getAnalysis('m-1')).toEqual(analysis);
  });

  it('四個欄位全空的分析不給存，標準與空逐字稿一致', () => {
    newMeeting();
    expect(() => store.saveAnalysis('m-1', {
      contract_version: 2, overview: '  ', topics: [], decisions: [], action_items: [],
    }, T0)).toThrow(/四個欄位都是空的/);
  });

  it('沒有資料時回 null', () => {
    newMeeting();
    expect(store.getTranscript('m-1')).toBeNull();
    expect(store.getAnalysis('m-1')).toBeNull();
  });

  it('Meeting 不存在時寫入拋錯', () => {
    expect(() => store.saveAnalysis('nope', {
      contract_version: 2, overview: 'x', topics: [], decisions: [], action_items: [],
    }, T0)).toThrow(/找不到 Meeting/);
  });

  it('讀到不是 v2 的分析時拋錯，不硬當成 v2 解讀', () => {
    newMeeting();
    db.prepare(`INSERT INTO analyses (meeting_id, contract_version, overview, topics, decisions, action_items, created_at)
                VALUES (?, 1, '', '[]', '[]', '[]', ?)`).run('m-1', T0);
    expect(() => store.getAnalysis('m-1')).toThrow(/C-ANALYSIS v1/);
  });
});

describe('接縫報告（seam_report）', () => {
  const report = [
    { sliceIndex: 1, verdict: 'duplicate' as const, similarity: 0.635, droppedSegments: 1 },
    { sliceIndex: 2, verdict: 'gap' as const, similarity: 0.053, droppedSegments: 0 },
  ];

  const withTranscript = () => {
    newMeeting();
    store.saveTranscriptProgress('m-1', { segments: [{ start: 0, end: 1, text: '嗨' }], polished_content: null }, 1, 3, T0);
  };

  it('寫進去讀得回來，形狀不變', () => {
    withTranscript();
    store.saveSeamReport('m-1', report);
    expect(store.getSeamReport('m-1')).toEqual(report);
  });

  it('沒寫過是 null，不是空陣列：「沒量過」跟「量過沒問題」不是同一件事', () => {
    withTranscript();
    expect(store.getSeamReport('m-1')).toBeNull();
  });

  it('**後續的逐字稿寫入不會把接縫報告清掉**', () => {
    // 這條擋的是 INSERT OR REPLACE：它是砍掉整列再插一列，statement 沒列到的欄位一起變 null。
    // 逐字稿每轉完一片就寫一次，用 REPLACE 的話接縫報告每片都被沖掉一次，而且沒有任何症狀
    withTranscript();
    store.saveSeamReport('m-1', report);

    store.saveTranscriptProgress(
      'm-1',
      { segments: [{ start: 0, end: 1, text: '嗨' }, { start: 1, end: 2, text: '再來' }], polished_content: '潤過的' },
      2, 3, T0 + 1,
    );

    expect(store.getSeamReport('m-1')).toEqual(report);
    expect(store.getTranscript('m-1')!.segments).toHaveLength(2);
    expect(store.getTranscript('m-1')!.polished_content).toBe('潤過的');
  });

  it('還沒有逐字稿時拒絕寫入，不默默生一列出來', () => {
    newMeeting();
    expect(() => store.saveSeamReport('m-1', report)).toThrow(/還沒有逐字稿/);
  });

  it('meeting 不存在時拋錯', () => {
    expect(() => store.saveSeamReport('nope', report)).toThrow();
  });
});

describe('切片進度與續傳游標', () => {
  it('setSliceProgress 只動進度，不動狀態', () => {
    newMeeting();
    store.setSliceProgress('m-1', 0, 7, T0 + 1);
    const m = store.getMeeting('m-1');
    expect(m?.total_slices).toBe(7);
    expect(m?.processed_slices).toBe(0);
    expect(m?.status).toBe('CREATED');
  });

  it('逐字稿與游標同一步寫入：不會出現「存了逐字稿但游標沒動」', () => {
    newMeeting();
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 3, text: '第一片' }], polished_content: null }, 1, 3, T0 + 1,
    );
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(1);
    expect(store.getMeeting('m-1')?.total_slices).toBe(3);
  });

  it('這一片沒轉出內容時只推進游標，不用空逐字稿蓋掉前面幾片', () => {
    newMeeting();
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 3, text: '第一片' }], polished_content: null }, 1, 3, T0 + 1,
    );
    store.saveTranscriptProgress('m-1', { segments: [], polished_content: null }, 2, 3, T0 + 2);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(2);
  });

  it('Meeting 不存在時拋錯，不靜默建一筆進度', () => {
    expect(() => store.setSliceProgress('nope', 0, 1, T0)).toThrow(/找不到 Meeting nope/);
    expect(() => store.saveTranscriptProgress('nope', { segments: [], polished_content: null }, 1, 1, T0))
      .toThrow(/找不到 Meeting nope/);
  });
});

describe('resetTranscriptionProgress', () => {
  it('清掉逐字稿並把續傳游標歸零：重新上傳的音檔不能接在舊音檔的逐字稿後面', () => {
    newMeeting();
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 3, text: '舊音檔的內容' }], polished_content: '舊潤稿' }, 2, 3, T0 + 1,
    );

    store.resetTranscriptionProgress('m-1', T0 + 2);

    expect(store.getTranscript('m-1')).toBeNull();
    expect(store.getMeeting('m-1')?.processed_slices).toBeNull();
    expect(store.getMeeting('m-1')?.total_slices).toBeNull();
    expect(store.getMeeting('m-1')?.updated_at).toBe(T0 + 2);
  });

  it('分析也一起刪掉：不能讓新音檔配著舊音檔的結論', () => {
    newMeeting();
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 3, text: '舊音檔的內容' }], polished_content: null }, 1, 1, T0 + 1,
    );
    store.saveAnalysis('m-1', {
      contract_version: 2 as const,
      overview: '舊音檔的結論',
      topics: [{ title: 'a', content: 'b' }],
      decisions: ['d'],
      action_items: [{ text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'unknown' as const }],
    }, T0 + 1);

    store.resetTranscriptionProgress('m-1', T0 + 2);

    expect(store.getAnalysis('m-1')).toBeNull();
  });

  it('本來就沒有逐字稿時照樣跑得完，不拋錯', () => {
    newMeeting();
    expect(() => store.resetTranscriptionProgress('m-1', T0 + 1)).not.toThrow();
  });

  it('Meeting 不存在時拋錯', () => {
    expect(() => store.resetTranscriptionProgress('nope', T0)).toThrow(/找不到 Meeting nope/);
  });
});

describe('setTags', () => {
  it('寫進去再讀出來是排序過的同一組', () => {
    newMeeting();
    store.setTags('m-1', ['採購', '雙週會']);
    expect(store.getTags('m-1')).toEqual(['採購', '雙週會']);
  });

  it('重設整組而不是累加：留著舊標籤會讓 prompt 帶到已經不成立的背景', () => {
    newMeeting();
    store.setTags('m-1', ['採購']);
    store.setTags('m-1', ['人事']);
    expect(store.getTags('m-1')).toEqual(['人事']);
  });
});

describe('importMigrated', () => {
  it('匯入後 meeting、逐字稿、分析、標籤都在', () => {
    const report = store.importMigrated([migrated('job-1')]);
    expect(report).toEqual({ imported: ['job-1'], skippedExisting: [] });
    expect(store.getMeeting('job-1')?.origin).toBe('migrated');
    expect(store.getTranscript('job-1')?.segments).toHaveLength(1);
    expect(store.getAnalysis('job-1')?.decisions).toEqual(['決定 A']);
    expect(store.getTags('job-1')).toEqual(['採購']);
  });

  it('重跑匯入時已存在的跳過，不覆寫 server 上已經往前跑的狀態', () => {
    store.importMigrated([migrated('job-1')]);
    store.setStatus('job-1', 'LINKING', T0 + 1);
    const report = store.importMigrated([migrated('job-1'), migrated('job-2')]);
    expect(report).toEqual({ imported: ['job-2'], skippedExisting: ['job-1'] });
    expect(store.getMeeting('job-1')?.status).toBe('LINKING');
  });

  it('中途失敗整批回退，不留半套', () => {
    const broken = migrated('job-bad');
    (broken.meeting as { origin: string }).origin = 'somewhere-else';
    expect(() => store.importMigrated([migrated('job-1'), broken, migrated('job-2')])).toThrow();
    expect(store.listMeetings()).toEqual([]);
  });

  it('列表依建立時間新的在前', () => {
    store.importMigrated([
      migrated('old', { created_at: T0 }),
      migrated('new', { created_at: T0 + 1000 }),
    ]);
    expect(store.listMeetings().map(m => m.meeting_id)).toEqual(['new', 'old']);
  });

  it('建立時間相同時用 meeting_id 決定順序，不留未定義的排序', () => {
    store.importMigrated([
      migrated('b', { created_at: T0 }),
      migrated('a', { created_at: T0 }),
      migrated('c', { created_at: T0 }),
    ]);
    expect(store.listMeetings().map(m => m.meeting_id)).toEqual(['c', 'b', 'a']);
  });
});

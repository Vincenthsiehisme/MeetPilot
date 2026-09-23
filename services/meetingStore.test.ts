import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCHEMA_VERSION, openMeetingDb, resolveDbPath } from './meetingDb';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { MigrationRecord } from './jobMigration';
import { MATCH_KEY_VERSION } from './topicTag';

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
    topic_extraction_status: null,
    topic_extraction_error: null,
    ...overrides,
  },
  transcript: { segments: [{ start: 0, end: 1, text: 'hi' }], polished_content: null },
  analysis: {
    contract_version: 3,
    overview: '標題',
    topics: [],
    decisions: [{ text: '決定 A', evidence: null, decided_by: null }],
    action_items: [{
      text: 't', source_meeting_id: id, created_at: T0, status: 'unknown',
      assignee: null, due: null, evidence: null,
    }],
    open_questions: [],
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
    expect(resolveDbPath({})).toBe(resolve('data/meetpilot.db'));
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

describe('createMeeting 的 participant_ids（人名校正 N2，D-016）', () => {
  const seedPerson = (employeeId: string) => {
    db.prepare(
      'INSERT INTO people (employee_id, display_name, email, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(employeeId, `測試-${employeeId}`, `${employeeId}@liontravel.com`, T0, T0);
  };

  it('不帶 participant_ids 時行為不變（既有呼叫端不受影響）', () => {
    const m = store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    expect(m.status).toBe('CREATED');
    expect(store.getParticipants('m-1')).toEqual([]);
  });

  it('帶 participant_ids 時一併寫入 meeting_participants', () => {
    seedPerson('p-1');
    seedPerson('p-2');
    store.createMeeting({ meeting_id: 'm-1', created_at: T0, participant_ids: ['p-1', 'p-2'] });
    expect(store.getParticipants('m-1').sort()).toEqual(['p-1', 'p-2']);
  });

  it('participant_ids 指到不存在的員編時整筆連 Meeting 都不建立（同一個交易，FK 擋下）', () => {
    expect(() => store.createMeeting({ meeting_id: 'm-1', created_at: T0, participant_ids: ['no-such-id'] }))
      .toThrow();
    expect(store.getMeeting('m-1')).toBeNull();
  });

  it('刪除 Meeting 時 meeting_participants 隨外鍵 cascade 一起清掉', () => {
    seedPerson('p-1');
    store.createMeeting({ meeting_id: 'm-1', created_at: T0, participant_ids: ['p-1'] });
    store.deleteMeeting('m-1');
    expect(db.prepare('SELECT COUNT(*) c FROM meeting_participants WHERE meeting_id = ?').get('m-1'))
      .toMatchObject({ c: 0 });
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
      contract_version: 3 as const,
      overview: 'x',
      topics: [{ title: 'a', content: 'b' }],
      decisions: [{ text: 'd', evidence: { start: 0, end: 1 }, decided_by: null }],
      action_items: [{
        text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'unknown' as const,
        assignee: null, due: null, evidence: null,
      }],
      open_questions: [{ text: 'q', evidence: null }],
    };
    store.saveAnalysis('m-1', analysis, T0);
    expect(store.getAnalysis('m-1')).toEqual(analysis);
  });

  it('五個欄位全空的分析不給存，標準與空逐字稿一致', () => {
    newMeeting();
    expect(() => store.saveAnalysis('m-1', {
      contract_version: 3, overview: '  ', topics: [], decisions: [], action_items: [], open_questions: [],
    }, T0)).toThrow(/五個欄位都是空的/);
  });

  it('沒有資料時回 null', () => {
    newMeeting();
    expect(store.getTranscript('m-1')).toBeNull();
    expect(store.getAnalysis('m-1')).toBeNull();
  });

  it('Meeting 不存在時寫入拋錯', () => {
    expect(() => store.saveAnalysis('nope', {
      contract_version: 3, overview: 'x', topics: [], decisions: [], action_items: [], open_questions: [],
    }, T0)).toThrow(/找不到 Meeting/);
  });

  it('讀到 v1（既不是 v2 也不是 v3）時拋錯，不硬當成已知版本解讀', () => {
    newMeeting();
    db.prepare(`INSERT INTO analyses (meeting_id, contract_version, overview, topics, decisions, action_items, created_at)
                VALUES (?, 1, '', '[]', '[]', '[]', ?)`).run('m-1', T0);
    expect(() => store.getAnalysis('m-1')).toThrow(/這一版只讀 v2 與 v3/);
  });

  it('讀到 v2 資料時 lazy 升成 v3：出處與人名補 null，資料列本身不改寫', () => {
    newMeeting();
    // 直接插入舊格式（沒有 open_questions 之外，decisions／action_items 也是 v2 的扁平形狀），
    // 模擬「還沒被下一次寫入覆蓋過」的既有資料
    db.prepare(`INSERT INTO analyses (meeting_id, contract_version, overview, topics, decisions, action_items, created_at)
                VALUES (?, 2, 'x', '[]', '["舊決議"]',
                        '[{"text":"舊待辦","source_meeting_id":"m-1","created_at":${T0},"status":"unknown"}]', ?)`)
      .run('m-1', T0);

    expect(store.getAnalysis('m-1')).toEqual({
      contract_version: 3,
      overview: 'x',
      topics: [],
      decisions: [{ text: '舊決議', evidence: null, decided_by: null }],
      action_items: [{
        text: '舊待辦', source_meeting_id: 'm-1', created_at: T0, status: 'unknown',
        assignee: null, due: null, evidence: null,
      }],
      open_questions: [],
    });

    // 資料列本身沒被重寫：contract_version 直接查資料庫仍是 2
    const row = db.prepare('SELECT contract_version FROM analyses WHERE meeting_id = ?').get('m-1') as
      { contract_version: number };
    expect(row.contract_version).toBe(2);
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
      contract_version: 3 as const,
      overview: '舊音檔的結論',
      topics: [{ title: 'a', content: 'b' }],
      decisions: [{ text: 'd', evidence: null, decided_by: null }],
      action_items: [{
        text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'unknown' as const,
        assignee: null, due: null, evidence: null,
      }],
      open_questions: [],
    }, T0 + 1);

    store.resetTranscriptionProgress('m-1', T0 + 2);

    expect(store.getAnalysis('m-1')).toBeNull();
  });

  it('重新上傳音檔時清掉舊逐字稿的人名提及', () => {
    newMeeting();
    db.prepare(
      'INSERT INTO name_mentions '
      + '(mention_id, meeting_id, segment_index, original_text, employee_id, method, confidence, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('mention-1', 'm-1', 0, 'Tina', null, 'conflict_review', 0, T0);

    store.resetTranscriptionProgress('m-1', T0 + 1);

    expect((db.prepare('SELECT COUNT(*) AS count FROM name_mentions WHERE meeting_id = ?')
      .get('m-1') as { count: number }).count).toBe(0);
  });

  it('本來就沒有逐字稿時照樣跑得完，不拋錯', () => {
    newMeeting();
    expect(() => store.resetTranscriptionProgress('m-1', T0 + 1)).not.toThrow();
  });

  it('Meeting 不存在時拋錯', () => {
    expect(() => store.resetTranscriptionProgress('nope', T0)).toThrow(/找不到 Meeting nope/);
  });
});

describe('updateTranscript', () => {
  it('人工修改逐字稿時清掉已失效的人名提及', () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 1, text: 'Tina 發言' }], polished_content: null }, T0);
    db.prepare(
      'INSERT INTO name_mentions '
      + '(mention_id, meeting_id, segment_index, original_text, employee_id, method, confidence, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('mention-1', 'm-1', 0, 'Tina', null, 'conflict_review', 0, T0);

    store.updateTranscript(
      'm-1',
      { segments: [{ start: 0, end: 1, text: '已移除舊人名' }] },
      T0 + 1,
    );

    expect((db.prepare('SELECT COUNT(*) AS count FROM name_mentions WHERE meeting_id = ?')
      .get('m-1') as { count: number }).count).toBe(0);
  });
});

describe('getCurrentTranscript：legacy_unconfirmed_raw（Codex adversarial review 抓到）', () => {
  it('這次升級之後才寫入的 raw，source_kind 是 raw', () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 1, text: '內容' }], polished_content: null }, T0);

    expect(store.getCurrentTranscript('m-1')).toMatchObject({ source_kind: 'raw', source_edit_version: null });
  });

  it('升級前就存在的舊資料（legacy_unconfirmed_raw=1）標成 unknown，不假裝是 raw', () => {
    // 這次升級前 PATCH 直接覆寫 segments，raw／edited 沒有分開，沒辦法回頭判斷這筆
    // 究竟是模型原始輸出還是人改過的——標成 raw 是騙自己，unknown 才是「判不出來」的老實紀錄
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 1, text: '可能被人改過的舊內容' }], polished_content: null }, T0);
    // 模擬 migration 對「這次升級前就存在」的列做的標記
    db.prepare('UPDATE transcripts SET legacy_unconfirmed_raw = 1 WHERE meeting_id = ?').run('m-1');

    expect(store.getCurrentTranscript('m-1')).toMatchObject({ source_kind: 'unknown', source_edit_version: null });
  });

  it('就算是 legacy 資料，只要有人工編輯過，編輯版本優先於 unknown 標記', () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 1, text: '舊內容' }], polished_content: null }, T0);
    db.prepare('UPDATE transcripts SET legacy_unconfirmed_raw = 1 WHERE meeting_id = ?').run('m-1');
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 1, text: '這次升級後才編輯過' }] }, T0 + 1);

    expect(store.getCurrentTranscript('m-1')).toMatchObject({ source_kind: 'edited', source_edit_version: 1 });
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
    expect(store.getAnalysis('job-1')?.decisions).toEqual([{ text: '決定 A', evidence: null, decided_by: null }]);
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

describe('題目標籤（topic_tags，W3）', () => {
  const autoTag = (title: string, matchKey: string, content = '內容') => ({
    title,
    content,
    match_key: matchKey,
    match_key_version: MATCH_KEY_VERSION,
  });

  // manual 的標籤這一期還沒有入口（W5／W6 才有），直接寫進表裡建局面：
  // 保護要現在就成立，等入口做好再補測試等於讓這條路在中間裸奔
  const insertManual = (meetingId: string, title: string, matchKey: string) => {
    db.prepare(`
      INSERT INTO topic_tags (tag_id, meeting_id, title, content, source, corrected_at,
                              match_key, match_key_version, created_at)
      VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)
    `).run(`manual-${title}`, meetingId, title, '人改過的內容', T0 + 5, matchKey, MATCH_KEY_VERSION, T0);
  };

  beforeEach(() => {
    newMeeting();
  });

  it('寫進去讀得回來，欄位一個不掉', () => {
    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程', '卡在廠商報價')] }, T0 + 1);

    const tags = store.getTopicTags('m-1');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      meeting_id: 'm-1',
      title: 'POC 時程',
      content: '卡在廠商報價',
      source: 'auto',
      corrected_at: null,
      match_key: 'poc時程',
      match_key_version: MATCH_KEY_VERSION,
      created_at: T0 + 1,
    });
    expect(tags[0].tag_id).toBeTruthy();
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('ok');
    expect(store.getMeeting('m-1')?.topic_extraction_error).toBeNull();
  });

  it('重抽只換掉 auto 的那些，**人工修正一條都不動**', () => {
    insertManual('m-1', '知識庫維護', '知識庫維護');
    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程')] }, T0 + 1);

    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('派單規則', '派單規則')] }, T0 + 2);

    const tags = store.getTopicTags('m-1');
    // 舊的 auto 被換掉、新的 auto 進來、manual 還在原地
    expect(tags.map(t => `${t.source}:${t.title}`).sort())
      .toEqual(['auto:派單規則', 'manual:知識庫維護']);
    expect(tags.find(t => t.source === 'manual')?.corrected_at).toBe(T0 + 5);
  });

  it('新抽的標籤撞到人工修正過的同一題目時整條跳過，不讓兩個版本並存', () => {
    insertManual('m-1', '知識庫的維護方式', '知識庫維護');

    const report = store.saveTopicExtraction('m-1', {
      status: 'ok',
      tags: [autoTag('知識庫維護', '知識庫維護'), autoTag('POC 時程', 'poc時程')],
    }, T0 + 1);

    expect(report.inserted).toBe(1);
    expect(report.skippedByManual).toEqual(['知識庫維護']);
    expect(store.getTopicTags('m-1').filter(t => t.match_key === '知識庫維護').map(t => t.source))
      .toEqual(['manual']);
  });

  it('同一批裡比對鍵重複的只留第一條，並回報被丟掉的那些', () => {
    const report = store.saveTopicExtraction('m-1', {
      status: 'ok',
      tags: [autoTag('POC 時程', 'poc時程'), autoTag('POC 的時程', 'poc時程')],
    }, T0 + 1);

    expect(report).toEqual({ inserted: 1, skippedByManual: [], skippedDuplicate: ['POC 的時程'] });
    expect(store.getTopicTags('m-1')).toHaveLength(1);
  });

  it('比對鍵是空字串時拋錯：空鍵之間會互相相等，會把兩件不相干的事判成同一題', () => {
    expect(() => store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('相關討論', '')] }, T0 + 1))
      .toThrow(/算不出比對鍵/);
    expect(store.getTopicTags('m-1')).toEqual([]);
    // 整個交易回退，狀態也不能留下來
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBeNull();
  });

  it('比對鍵版本跟這一版不同時拋錯，不讓兩種規則的鍵混在同一張表', () => {
    expect(() => store.saveTopicExtraction('m-1', {
      status: 'ok',
      tags: [{ ...autoTag('POC 時程', 'poc時程'), match_key_version: MATCH_KEY_VERSION + 1 }],
    }, T0 + 1)).toThrow(/比對鍵版本/);
  });

  it('ok 卻一條標籤都沒有時拋錯：那是 empty，不能寫成抽得好好的', () => {
    expect(() => store.saveTopicExtraction('m-1', { status: 'ok', tags: [] }, T0 + 1)).toThrow(/應該用 empty/);
  });

  it('empty 落地成狀態，既有標籤不刪：這一輪沒抽到不代表上一輪抽到的是錯的', () => {
    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程')] }, T0 + 1);

    store.saveTopicExtraction('m-1', { status: 'empty' }, T0 + 2);

    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('empty');
    expect(store.getTopicTags('m-1')).toHaveLength(1);
  });

  it('failed 把原因留下來，既有標籤同樣不刪', () => {
    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程')] }, T0 + 1);

    store.saveTopicExtraction('m-1', { status: 'failed', error: '模型輸出被截斷' }, T0 + 2);

    const meeting = store.getMeeting('m-1');
    expect(meeting?.topic_extraction_status).toBe('failed');
    expect(meeting?.topic_extraction_error).toBe('模型輸出被截斷');
    expect(store.getTopicTags('m-1')).toHaveLength(1);
  });

  it('從 failed 抽成功之後原因要清掉，不留一個已經不成立的失敗訊息', () => {
    store.saveTopicExtraction('m-1', { status: 'failed', error: '模型輸出被截斷' }, T0 + 1);

    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程')] }, T0 + 2);

    expect(store.getMeeting('m-1')?.topic_extraction_error).toBeNull();
  });

  it('沒抽過的會是 null，不是 empty：「還沒輪到它」與「抽不出東西」不是同一件事', () => {
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBeNull();
    expect(store.getTopicTags('m-1')).toEqual([]);
  });

  it('刪掉整場會時標籤跟著走，不留孤兒列', () => {
    store.saveTopicExtraction('m-1', { status: 'ok', tags: [autoTag('POC 時程', 'poc時程')] }, T0 + 1);
    store.deleteMeeting('m-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_tags').get()).toMatchObject({ n: 0 });
  });

  it('Meeting 不存在時拋錯，不靜默生出一批沒有主人的標籤', () => {
    expect(() => store.saveTopicExtraction('nope', { status: 'empty' }, T0)).toThrow(/找不到 Meeting/);
  });

  it('同一批標籤的順序固定，不依賴插入時的巧合', () => {
    store.saveTopicExtraction('m-1', {
      status: 'ok',
      tags: [autoTag('派單規則', '派單規則'), autoTag('POC 時程', 'poc時程'), autoTag('客服座席', '客服座席')],
    }, T0 + 1);

    expect(store.getTopicTags('m-1').map(t => t.title)).toEqual(['POC 時程', '客服座席', '派單規則']);
  });
});

describe('W4：向量、關聯與排除紀錄', () => {
  const tagsFor = (id: string, titles: readonly string[]) => {
    store.saveTopicExtraction(id, {
      status: 'ok',
      tags: titles.map(title => ({
        title,
        content: `${title} 的內容`,
        match_key: title,
        match_key_version: MATCH_KEY_VERSION,
      })),
    }, T0);
    return store.getTopicTags(id);
  };

  beforeEach(() => {
    newMeeting('m-1');
    newMeeting('m-2');
  });

  it('向量存進去再讀出來是同一組（float32 的精度）', () => {
    const [tag] = tagsFor('m-1', ['題目甲']);
    store.saveTagVectors([{ tag_id: tag.tag_id, model: 'e-1', dimensions: 3, vector: [0.5, -0.25, 0.125] }], T0);

    const [read] = store.getTagVectors('m-1');
    expect(read.tag_id).toBe(tag.tag_id);
    expect(read.model).toBe('e-1');
    expect(read.dimensions).toBe(3);
    // float32 存得下的值原樣回來；存不下的差在 1e-7 量級，cosine 不受影響
    expect(read.vector).toEqual([0.5, -0.25, 0.125]);
  });

  it('dimensions 欄跟實際長度對不上就拒收', () => {
    const [tag] = tagsFor('m-1', ['題目甲']);
    expect(() =>
      store.saveTagVectors([{ tag_id: tag.tag_id, model: 'e-1', dimensions: 4, vector: [1, 2, 3] }], T0),
    ).toThrow(/dimensions 欄寫 4/);
  });

  it('listTagsMissingVectors 只回還沒算過的那幾條', () => {
    const tags = tagsFor('m-1', ['題目甲', '題目乙']);
    expect(store.listTagsNeedingVectors('m-1', 'e-1')).toHaveLength(2);

    store.saveTagVectors([{ tag_id: tags[0].tag_id, model: 'e-1', dimensions: 1, vector: [1] }], T0);
    expect(store.listTagsNeedingVectors('m-1', 'e-1').map(t => t.tag_id)).toEqual([tags[1].tag_id]);
  });

  it('向量是別的 model 算的就算要重算（Codex 2026-09-15 findings 6）', () => {
    const [tag] = tagsFor('m-1', ['題目甲']);
    store.saveTagVectors([{ tag_id: tag.tag_id, model: '舊 model', dimensions: 1, vector: [1] }], T0);

    // 同一個 model 問：不用重算
    expect(store.listTagsNeedingVectors('m-1', '舊 model')).toEqual([]);
    // 換了 model 問：那條要重算。不重算的話 canCompare 會把舊向量全部判成不可比，
    // 而那些會就安靜地關聯不到任何東西，狀態卻是正常的 LINKED ＋ 空集合
    expect(store.listTagsNeedingVectors('m-1', '新 model').map(t => t.tag_id)).toEqual([tag.tag_id]);
  });

  it('重新抽取會把舊向量一起帶走，不留對不到標籤的孤兒', () => {
    const [tag] = tagsFor('m-1', ['題目甲']);
    store.saveTagVectors([{ tag_id: tag.tag_id, model: 'e-1', dimensions: 1, vector: [1] }], T0);
    expect(store.getTagVectors('m-1')).toHaveLength(1);

    tagsFor('m-1', ['題目甲']);
    // 新一輪的 tag_id 是新的，舊向量靠外鍵 cascade 走掉
    expect(store.getTagVectors('m-1')).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_tag_embeddings').get()).toEqual({ n: 0 });
  });

  it('listTopicTagOwners 只列真的有標籤的會，不看抽取狀態', () => {
    tagsFor('m-1', ['題目甲']);
    // m-2 抽過但一條都沒有
    store.saveTopicExtraction('m-2', { status: 'empty' }, T0);
    expect(store.listTopicTagOwners()).toEqual(['m-1']);

    // 上一輪抽到過的標籤仍是合法的關聯原料，就算這一輪失敗了
    store.saveTopicExtraction('m-1', { status: 'failed', error: '壞了' }, T0);
    expect(store.listTopicTagOwners()).toEqual(['m-1']);
  });

  const linkResult = (other: string) => ({
    algo_version: 'test-v1',
    links: [{ other_meeting_id: other, confidence: 0.8, evidence: '理由', shared_topics: ['共同題目'] }],
    coverage: { candidates: 1, judged: 1, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
      incomparable_pairs: 0, error: null },
  });

  it('關聯兩端正規化排序，兩邊都查得到', () => {
    const report = store.saveLinkResult('m-2', linkResult('m-1'), T0);
    expect(report.inserted).toBe(1);

    const [link] = store.getLinks('m-1');
    expect([link.meeting_a, link.meeting_b]).toEqual(['m-1', 'm-2']);
    expect(link.shared_topics).toEqual(['共同題目']);
    expect(store.getLinks('m-2')).toHaveLength(1);
  });

  it('重算是換掉不是累加', () => {
    store.saveLinkResult('m-1', linkResult('m-2'), T0);
    store.saveLinkResult('m-1', linkResult('m-2'), T0 + 1);
    expect(store.getLinks('m-1')).toHaveLength(1);
  });

  it('儲存層擋住排除過的那一對（AC-3 的最後一道）', () => {
    store.addLinkExclusion('m-1', 'm-2', 'different_topic', T0);

    const report = store.saveLinkResult('m-1', linkResult('m-2'), T0 + 1);
    expect(report.inserted).toBe(0);
    expect(report.blockedByExclusion).toEqual(['m-2']);
    expect(store.getLinks('m-1')).toEqual([]);
  });

  it('標記不相關會當場把既有那一筆撤掉，不等下一次重算', () => {
    store.saveLinkResult('m-1', linkResult('m-2'), T0);
    expect(store.getLinks('m-1')).toHaveLength(1);

    store.addLinkExclusion('m-2', 'm-1', 'outdated', T0 + 1);
    expect(store.getLinks('m-1')).toEqual([]);
    expect(store.listLinkExclusions('m-1')).toEqual([
      { meeting_a: 'm-1', meeting_b: 'm-2', reason_code: 'outdated', created_at: T0 + 1 },
    ]);
  });

  it('同一對重標只更新原因，不長出第二列', () => {
    store.addLinkExclusion('m-1', 'm-2', 'different_topic', T0);
    store.addLinkExclusion('m-1', 'm-2', 'not_needed', T0 + 1);
    expect(store.listLinkExclusions('m-1')).toHaveLength(1);
    expect(store.listLinkExclusions('m-1')[0].reason_code).toBe('not_needed');
  });

  it('排除原因不是那四個之一就拒收', () => {
    expect(() => store.addLinkExclusion('m-1', 'm-2', '看不順眼' as never, T0)).toThrow(/不是合法值/);
  });

  it('saveLinkRun 只寫覆蓋率，不碰既有關聯', () => {
    store.saveLinkResult('m-1', linkResult('m-2'), T0);
    store.saveLinkRun('m-1', {
      algo_version: 'test-v1',
      links: [],
      coverage: { candidates: 1, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 1,
        incomparable_pairs: 0, error: '429' },
    }, T0 + 1);

    expect(store.getLinks('m-1')).toHaveLength(1);
    expect(store.getLinkRun('m-1')).toMatchObject({ judged: 0, skipped_error: 1, error: '429' });
  });

  it('沒算過的會 getLinkRun 是 null——那跟「算過但沒找到」不是同一件事', () => {
    expect(store.getLinkRun('m-1')).toBeNull();
  });

  it('刪掉會議時關聯、排除紀錄與覆蓋率一起走', () => {
    tagsFor('m-1', ['題目甲']);
    store.saveLinkResult('m-1', linkResult('m-2'), T0);
    store.addLinkExclusion('m-1', 'm-2', 'not_needed', T0);
    store.deleteMeeting('m-1');

    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_links').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM link_exclusions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM link_runs').get()).toEqual({ n: 0 });
  });
});

describe('setTitle', () => {
  it('寫入標題與 updated_at，其餘欄位不動', () => {
    newMeeting();
    const updated = store.setTitle('m-1', '週會', T0 + 5);
    expect(updated.title).toBe('週會');
    expect(updated.updated_at).toBe(T0 + 5);
    expect(updated.status).toBe('CREATED');
    expect(store.getMeeting('m-1')?.title).toBe('週會');
  });

  it('找不到 Meeting 時拋錯，不靜默建一筆', () => {
    expect(() => store.setTitle('nope', '週會', T0)).toThrow('找不到 Meeting nope');
  });
});

describe('語音備忘錄錄音的起訖紀錄（vault plan「MeetPilot · 網頁錄音」）', () => {
  it('開始錄音：狀態進 RECORDING、開始時間落地，兩件事一起發生', () => {
    newMeeting();
    const meeting = store.startRecording('m-1', T0 + 1000);
    expect(meeting.status).toBe('RECORDING');
    expect(store.getRecording('m-1')).toEqual({ meeting_id: 'm-1', started_at: T0 + 1000, stopped_at: null });
    expect(store.listRecordingMeetings().map(m => m.meeting_id)).toEqual(['m-1']);
  });

  it('不是 CREATED 不能開始錄，而且不會留下半筆起訖紀錄', () => {
    newMeeting();
    store.setStatus('m-1', 'TRANSCRIBING', T0);
    expect(() => store.startRecording('m-1', T0)).toThrow(/不能從 TRANSCRIBING 轉到 RECORDING/);
    expect(store.getRecording('m-1')).toBeNull();
  });

  it('開始失敗退回 CREATED：起訖紀錄一起刪掉，不留一筆看起來還在錄的列', () => {
    newMeeting();
    store.startRecording('m-1', T0);
    const meeting = store.abortRecording('m-1', T0 + 5);
    expect(meeting.status).toBe('CREATED');
    expect(store.getRecording('m-1')).toBeNull();
    expect(store.listRecordingMeetings()).toEqual([]);
  });

  it('退回 CREATED 之後重新開始：開始時間換成這一次的，不留上一次的', () => {
    newMeeting();
    store.startRecording('m-1', T0);
    store.markRecordingStopped('m-1', T0 + 10_000);
    store.setStatus('m-1', 'CREATED', T0 + 11_000);
    store.startRecording('m-1', T0 + 60_000);
    expect(store.getRecording('m-1')).toEqual({ meeting_id: 'm-1', started_at: T0 + 60_000, stopped_at: null });
  });

  it('停止時間只能記一次：第二次寫會蓋掉第一次的終點，一律拋錯', () => {
    newMeeting();
    store.startRecording('m-1', T0);
    store.markRecordingStopped('m-1', T0 + 10_000);
    expect(store.getRecording('m-1')?.stopped_at).toBe(T0 + 10_000);
    expect(() => store.markRecordingStopped('m-1', T0 + 20_000)).toThrow(/沒有進行中的錄音紀錄/);
    expect(store.getRecording('m-1')?.stopped_at).toBe(T0 + 10_000);
  });

  it('沒有錄音紀錄的會記不了停止時間', () => {
    newMeeting();
    expect(() => store.markRecordingStopped('m-1', T0)).toThrow(/沒有進行中的錄音紀錄/);
  });

  it('刪除會議時起訖紀錄跟著刪（外鍵 cascade）', () => {
    newMeeting();
    store.startRecording('m-1', T0);
    store.deleteMeeting('m-1');
    expect(store.getRecording('m-1')).toBeNull();
  });

  it('補寫實際音檔大小', () => {
    newMeeting();
    store.setSourceFileSize('m-1', 91_557, T0 + 1);
    expect(store.getMeeting('m-1')?.source_file_size).toBe(91_557);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AnalysisV3 } from './analysisContract';
import { AudioFileStore } from './audioFileStore';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { deleteMeetingRequest, patchAnalysisRequest, patchTranscriptRequest } from './meetingEdits';

const T0 = 1_700_000_000_000;
const T1 = T0 + 5_000;

let db: DatabaseSync;
let store: MeetingStore;
let present: Set<string>;

const audioStore = (removeFails = false): AudioFileStore => ({
  dir: '/fake/audio',
  pathFor: (id: string) => `/fake/audio/${id}.audio`,
  exists: (id: string) => present.has(id),
  sizeOf: () => 1024,
  saveFrom: async (id: string) => { present.add(id); return { path: `/fake/audio/${id}.audio`, bytes: 1024 }; },
  removePartialUploads: () => [],
  remove: (id: string) => {
    if (removeFails) throw new Error('EACCES: permission denied');
    present.delete(id);
  },
});

const fakeQueue = (cancelled: string[] = []) => ({
  cancelled,
  cancel: (id: string) => { cancelled.push(id); return true; },
});

const analysis: AnalysisV3 = {
  contract_version: 3,
  overview: '主旨',
  topics: [{ title: '議題 A', content: '內容' }],
  decisions: [{ text: '決定 A', evidence: { start: 0, end: 5 }, decided_by: null }],
  action_items: [{
    text: '待辦 A', source_meeting_id: 'm-1', created_at: T0, status: 'unknown',
    assignee: null, due: null, evidence: null,
  }],
  open_questions: [],
};

// 已經跑完的一場會：逐字稿、分析、標籤、音檔都在
const readyMeeting = (id = 'm-1') => {
  store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 10 });
  store.setTags(id, ['採購']);
  store.saveTranscript(id, { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: '潤過的' }, T0);
  store.saveAnalysis(id, { ...analysis, action_items: analysis.action_items.map(a => ({ ...a, source_meeting_id: id })) }, T0);
  store.setStatus(id, 'TRANSCRIBING', T0);
  store.setStatus(id, 'ANALYZING', T0);
  store.setStatus(id, 'READY', T0);
  present.add(id);
};

// READY 的會推到指定的處理中狀態。READY 只能往 LINKING 走，要回轉錄得先繞 FAILED → CREATED
const moveTo = (status: 'TRANSCRIBING' | 'ANALYZING' | 'LINKING', id = 'm-1') => {
  if (status === 'LINKING') {
    store.setStatus(id, 'LINKING', T0 + 1);
    return;
  }
  store.setStatus(id, 'FAILED', T0 + 1, '先退回去');
  store.setStatus(id, 'CREATED', T0 + 2);
  store.setStatus(id, 'TRANSCRIBING', T0 + 3);
  if (status === 'ANALYZING') store.setStatus(id, 'ANALYZING', T0 + 4);
};

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  present = new Set<string>();
});

afterEach(() => {
  db.close();
});

describe('DELETE /api/meetings/:id', () => {
  it('刪掉 Meeting、逐字稿、分析、標籤與音檔', () => {
    readyMeeting();

    const outcome = deleteMeetingRequest({ store, audioStore: audioStore() }, 'm-1');

    expect(outcome).toEqual({ status: 200, body: { deleted: true, meetingId: 'm-1' } });
    expect(store.getMeeting('m-1')).toBeNull();
    // transcripts / analyses / meeting_tags 靠外鍵 cascade 一起走
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM analyses').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_tags').get()).toEqual({ n: 0 });
    expect(present.has('m-1')).toBe(false);
  });

  it('找不到 Meeting 時回 404', () => {
    expect(deleteMeetingRequest({ store, audioStore: audioStore() }, 'nope'))
      .toEqual({ status: 404, body: { error: '找不到 Meeting nope' } });
  });

  it('刪掉還在排隊的那場會時順手把它移出佇列，不留一行像故障的 log', () => {
    readyMeeting();
    store.setStatus('m-1', 'FAILED', T0 + 1, '上次失敗');
    store.setStatus('m-1', 'CREATED', T0 + 2);
    const queue = fakeQueue();

    expect(deleteMeetingRequest({ store, audioStore: audioStore(), queue }, 'm-1').status).toBe(200);
    expect(queue.cancelled).toEqual(['m-1']);
  });

  it.each(['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const)(
    '正在跑（%s）的會回 409，而且 DB 紀錄與音檔都還在',
    (status) => {
      readyMeeting();
      moveTo(status);

      const outcome = deleteMeetingRequest({ store, audioStore: audioStore() }, 'm-1');

      expect(outcome.status).toBe(409);
      expect((outcome.body as { error: string }).error).toContain('等它結束或失敗之後再刪');
      expect(store.getMeeting('m-1')?.status).toBe(status);
      expect(store.getTranscript('m-1')).not.toBeNull();
      expect(present.has('m-1')).toBe(true);
    },
  );

  it('音檔已經不在不算錯：分析成功之後音檔本來就會被刪掉', () => {
    readyMeeting();
    present.delete('m-1');

    expect(deleteMeetingRequest({ store, audioStore: audioStore() }, 'm-1').status).toBe(200);
    expect(store.getMeeting('m-1')).toBeNull();
  });

  it('刪檔本身失敗時往上拋，不吞掉，而且 Meeting 還在可以再刪一次', () => {
    readyMeeting();

    expect(() => deleteMeetingRequest({ store, audioStore: audioStore(true) }, 'm-1'))
      .toThrow(/permission denied/);
    expect(store.getMeeting('m-1')).not.toBeNull();
  });
});

describe('PATCH /api/meetings/:id/transcript', () => {
  const segments = [{ start: 0, end: 4, text: '改過的開場', speaker: 'Speaker 1' }];

  it('只給 segments 時潤稿保持原值', () => {
    readyMeeting();

    const outcome = patchTranscriptRequest({ store }, 'm-1', { segments }, T1);

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ transcript: { segments, polished_content: '潤過的' } });
    expect(store.getTranscript('m-1')).toEqual({ segments, polished_content: '潤過的' });
  });

  it('只給 polished_content 時逐字稿保持原值', () => {
    readyMeeting();

    const outcome = patchTranscriptRequest({ store }, 'm-1', { polished_content: '新的潤稿' }, T1);

    expect(outcome.status).toBe(200);
    expect(store.getTranscript('m-1')?.segments).toEqual([{ start: 0, end: 3, text: '開場', speaker: 'S' }]);
    expect(store.getTranscript('m-1')?.polished_content).toBe('新的潤稿');
  });

  it('polished_content 給 null 是清掉潤稿，沒給這個欄位是保留（兩者不能併成同一件事）', () => {
    readyMeeting('m-clear');
    readyMeeting('m-keep');

    patchTranscriptRequest({ store }, 'm-clear', { polished_content: null }, T1);
    patchTranscriptRequest({ store }, 'm-keep', { segments }, T1);

    expect(store.getTranscript('m-clear')?.polished_content).toBeNull();
    expect(store.getTranscript('m-keep')?.polished_content).toBe('潤過的');
  });

  it('更新 updated_at，但不動 status', () => {
    readyMeeting();

    patchTranscriptRequest({ store }, 'm-1', { segments }, T1);

    expect(store.getMeeting('m-1')?.updated_at).toBe(T1);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });

  it('兩個欄位都沒給時回 400', () => {
    readyMeeting();
    expect(patchTranscriptRequest({ store }, 'm-1', {}, T1))
      .toEqual({ status: 400, body: { error: 'segments 與 polished_content 至少要給一個' } });
    expect(patchTranscriptRequest({ store }, 'm-1', undefined, T1).status).toBe(400);
  });

  it.each([
    ['不是陣列', { segments: '一段文字' }],
    ['是空陣列', { segments: [] }],
  ])('segments %s 時回 400，不用空的蓋掉既有逐字稿', (_label, body) => {
    readyMeeting();

    const outcome = patchTranscriptRequest({ store }, 'm-1', body, T1);

    expect(outcome).toEqual({ status: 400, body: { error: 'segments 必須是非空陣列' } });
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('segments 的元素形狀不對時回 400，不把任何 JSON 都存進去', () => {
    readyMeeting();
    const outcome = patchTranscriptRequest({ store }, 'm-1', { segments: [{ start: '0', end: 1, text: 'x' }] }, T1);
    expect(outcome.status).toBe(400);
    expect((outcome.body as { error: string }).error).toContain('start');
  });

  it('polished_content 不是字串也不是 null 時回 400', () => {
    readyMeeting();
    expect(patchTranscriptRequest({ store }, 'm-1', { polished_content: 42 }, T1).status).toBe(400);
  });

  it.each(['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const)(
    '轉錄／分析進行中（%s）回 409：這時存進去的東西會被下一片寫回蓋掉',
    (status) => {
      readyMeeting();
      moveTo(status);

      const outcome = patchTranscriptRequest({ store }, 'm-1', { segments, polished_content: '新潤稿' }, T1);

      expect(outcome.status).toBe(409);
      expect((outcome.body as { error: string }).error).toContain('等它跑完再編輯');
      expect(store.getTranscript('m-1')).toEqual({
        segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: '潤過的',
      });
      expect(store.getMeeting('m-1')?.updated_at).not.toBe(T1);
    },
  );

  it('Meeting 不存在時回 404', () => {
    expect(patchTranscriptRequest({ store }, 'nope', { segments }, T1))
      .toEqual({ status: 404, body: { error: '找不到 Meeting nope' } });
  });

  it('還沒有逐字稿時回 404：轉錄完成後才能編', () => {
    store.createMeeting({ meeting_id: 'm-new', created_at: T0 });

    const outcome = patchTranscriptRequest({ store }, 'm-new', { segments }, T1);

    expect(outcome.status).toBe(404);
    expect((outcome.body as { error: string }).error).toContain('還沒有逐字稿');
  });
});

describe('PATCH /api/meetings/:id/analysis', () => {
  const edited: AnalysisV3 = {
    ...analysis,
    overview: '改過的主旨',
    decisions: [{ text: '改過的決定', evidence: { start: 1, end: 9 }, decided_by: '小美' }],
  };

  it('整份覆寫並回傳寫進去的那一份', () => {
    readyMeeting();

    const outcome = patchAnalysisRequest({ store }, 'm-1', { analysis: edited }, T1);

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ analysis: edited });
    expect(store.getAnalysis('m-1')).toEqual(edited);
  });

  it('更新 updated_at，但不動 status', () => {
    readyMeeting();

    patchAnalysisRequest({ store }, 'm-1', { analysis: edited }, T1);

    expect(store.getMeeting('m-1')?.updated_at).toBe(T1);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });

  it.each([
    ['analysis 不是物件', { analysis: '一段文字' }, 'analysis 必須是物件'],
    ['整個 body 沒有 analysis', {}, 'analysis 必須是物件'],
    ['contract_version 不是 3', { analysis: { ...edited, contract_version: 2 } }, 'contract_version 必須是 3'],
    ['欄位形狀不對', { analysis: { ...edited, topics: '不是陣列' } }, '形狀不是 C-ANALYSIS v3'],
    [
      'decisions 的 evidence 形狀不對',
      { analysis: { ...edited, decisions: [{ text: 'x', evidence: { start: '0', end: 5 }, decided_by: null }] } },
      '形狀不是 C-ANALYSIS v3',
    ],
    [
      'decisions 的 evidence start 大於 end',
      { analysis: { ...edited, decisions: [{ text: 'x', evidence: { start: 9, end: 1 }, decided_by: null }] } },
      '形狀不是 C-ANALYSIS v3',
    ],
    [
      'open_questions 不是陣列',
      { analysis: { ...edited, open_questions: '不是陣列' } },
      '形狀不是 C-ANALYSIS v3',
    ],
  ])('%s 時回 400，既有分析不動', (_label, body, expected) => {
    readyMeeting();

    const outcome = patchAnalysisRequest({ store }, 'm-1', body, T1);

    expect(outcome.status).toBe(400);
    expect((outcome.body as { error: string }).error).toContain(expected);
    expect(store.getAnalysis('m-1')?.overview).toBe('主旨');
  });

  it('五個欄位都空的分析回 400，標準與 saveAnalysis 一致', () => {
    readyMeeting();

    const outcome = patchAnalysisRequest({ store }, 'm-1', {
      analysis: {
        contract_version: 3, overview: '  ', topics: [], decisions: [], action_items: [], open_questions: [],
      },
    }, T1);

    expect(outcome.status).toBe(400);
    expect((outcome.body as { error: string }).error).toContain('五個欄位都是空的');
    expect(store.getAnalysis('m-1')?.overview).toBe('主旨');
  });

  it.each(['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const)(
    '轉錄／分析進行中（%s）回 409，既有分析不動',
    (status) => {
      readyMeeting();
      moveTo(status);

      const outcome = patchAnalysisRequest({ store }, 'm-1', { analysis: edited }, T1);

      expect(outcome.status).toBe(409);
      expect((outcome.body as { error: string }).error).toContain('等它跑完再編輯');
      expect(store.getAnalysis('m-1')?.overview).toBe('主旨');
    },
  );

  it.each([
    ['status 不是三值列舉', { text: 't', source_meeting_id: 'm-1', created_at: T0, status: '完成了嗎', assignee: null, due: null, evidence: null }],
    ['created_at 不是數字', { text: 't', source_meeting_id: 'm-1', created_at: '不是數字', status: 'open', assignee: null, due: null, evidence: null }],
    ['source_meeting_id 不是字串', { text: 't', source_meeting_id: 42, created_at: T0, status: 'open', assignee: null, due: null, evidence: null }],
    ['缺 status', { text: 't', source_meeting_id: 'm-1', created_at: T0, assignee: null, due: null, evidence: null }],
    ['assignee 不是字串或 null', { text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'open', assignee: 42, due: null, evidence: null }],
    ['due 不是字串或 null', { text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'open', assignee: null, due: 42, evidence: null }],
    ['evidence 不是 null 或 {start,end}', { text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'open', assignee: null, due: null, evidence: '不對' }],
  ])('action_items 的 %s 時回 400，不讓壞形狀原樣落地', (_label, item) => {
    readyMeeting();

    const outcome = patchAnalysisRequest({ store }, 'm-1', {
      analysis: { ...edited, action_items: [item] },
    }, T1);

    expect(outcome.status).toBe(400);
    expect((outcome.body as { error: string }).error).toContain('action_items');
    expect(store.getAnalysis('m-1')?.overview).toBe('主旨');
  });

  it('action_items 形狀正確時收下，assignee／due／evidence 可以是 null', () => {
    readyMeeting();

    const outcome = patchAnalysisRequest({ store }, 'm-1', {
      analysis: {
        ...edited,
        action_items: [{
          text: 't', source_meeting_id: 'm-1', created_at: T0, status: 'done',
          assignee: null, due: null, evidence: null,
        }],
      },
    }, T1);

    expect(outcome.status).toBe(200);
    expect(store.getAnalysis('m-1')?.action_items[0].status).toBe('done');
  });

  it('Meeting 不存在時回 404', () => {
    expect(patchAnalysisRequest({ store }, 'nope', { analysis: edited }, T1))
      .toEqual({ status: 404, body: { error: '找不到 Meeting nope' } });
  });

  it('還沒有分析結果時回 404：分析完成後才能編', () => {
    store.createMeeting({ meeting_id: 'm-new', created_at: T0 });

    const outcome = patchAnalysisRequest({ store }, 'm-new', { analysis: edited }, T1);

    expect(outcome.status).toBe(404);
    expect((outcome.body as { error: string }).error).toContain('還沒有分析結果');
  });
});

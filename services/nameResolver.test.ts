import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { createPeopleStore, PeopleStore } from './peopleStore';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { createNameResolver, NameResolver } from './nameResolver';
import { AnalysisV3 } from './analysisContract';
import { TranscriptSegment } from '../types';

let db: DatabaseSync;
let peopleStore: PeopleStore;
let store: MeetingStore;
let resolver: NameResolver;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  peopleStore = createPeopleStore(db);
  store = createMeetingStore(db);
  resolver = createNameResolver(db, peopleStore, store);
});

afterEach(() => {
  db.close();
});

const seg = (text: string, start = 0, end = 5): TranscriptSegment => ({ start, end, text, speaker: 'S1' });

const newMeeting = (participantIds: string[]) => {
  store.createMeeting({
    meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10,
    participant_ids: participantIds,
  });
};

describe('resolveTranscript：沒有與會者', () => {
  it('沒有與會者時回空 mentions，segments 原樣不動', () => {
    newMeeting([]);
    const segments = [seg('今天陳國煌說要往前推進')];
    const result = resolver.resolveTranscript('m-1', segments, T0);
    expect(result.mentions).toEqual([]);
    expect(result.resolvedSegments).toEqual(segments);
  });
});

describe('resolveTranscript：精確比對', () => {
  beforeEach(() => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen'] }],
      T0,
    );
    newMeeting(['p-1']);
  });

  it('別名命中時已解析視圖替換成正名，記一筆 exact mention', () => {
    const result = resolver.resolveTranscript('m-1', [seg('Philchen 說要往前推進')], T0);
    expect(result.resolvedSegments[0].text).toBe('陳國煌 說要往前推進');
    expect(result.mentions).toEqual([
      { meeting_id: 'm-1', segment_index: 0, original_text: 'Philchen', employee_id: 'p-1', method: 'exact', confidence: 1 },
    ]);
  });

  it('正名本身命中時不做無意義的替換，但仍記一筆 mention', () => {
    const result = resolver.resolveTranscript('m-1', [seg('陳國煌說要往前推進')], T0);
    expect(result.resolvedSegments[0].text).toBe('陳國煌說要往前推進');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].method).toBe('exact');
  });

  it('沒有命中的段落不產生 mention，segment 物件保持原樣（不是新物件）', () => {
    const original = seg('這段沒有提到任何與會者');
    const result = resolver.resolveTranscript('m-1', [original], T0);
    expect(result.mentions).toEqual([]);
    expect(result.resolvedSegments[0]).toBe(original);
  });

  it('段落索引跟原始逐字稿一致，不因為前面段落沒命中而偏移', () => {
    const result = resolver.resolveTranscript('m-1', [
      seg('開場白，沒有人名'),
      seg('Philchen 報告進度'),
    ], T0);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].segment_index).toBe(1);
  });
});

describe('resolveTranscript：短別名一律 needs_review', () => {
  it('兩字以下的別名命中一律 short_alias_review，不直接替換已解析視圖', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳小明', title: null, email: 'p1@liontravel.com', department: null, aliases: ['小明'] }],
      T0,
    );
    newMeeting(['p-1']);

    const result = resolver.resolveTranscript('m-1', [seg('小明白板上寫了重點')], T0);
    // 短別名不猜，已解析視圖原樣保留，不會把「小明白」誤植成「陳小明白」
    expect(result.resolvedSegments[0].text).toBe('小明白板上寫了重點');
    expect(result.mentions).toEqual([
      { meeting_id: 'm-1', segment_index: 0, original_text: '小明', employee_id: 'p-1', method: 'short_alias_review', confidence: 0 },
    ]);
  });
});

describe('resolveTranscript：同一字串撞兩個員編不猜', () => {
  it('對到多個員編時 conflict_review，employee_id 是 null，已解析視圖不替換', () => {
    peopleStore.importRoster(
      [
        { employeeId: 'p-1', displayName: '陳雅婷', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Tina'] },
        { employeeId: 'p-2', displayName: '林雅婷', title: null, email: 'p2@liontravel.com', department: null, aliases: ['Tina'] },
      ],
      T0,
    );
    newMeeting(['p-1', 'p-2']);

    const result = resolver.resolveTranscript('m-1', [seg('Tina 說明採購狀況')], T0);
    expect(result.resolvedSegments[0].text).toBe('Tina 說明採購狀況');
    expect(result.mentions).toEqual([
      { meeting_id: 'm-1', segment_index: 0, original_text: 'Tina', employee_id: null, method: 'conflict_review', confidence: 0 },
    ]);
  });
});

describe('resolveTranscript：組合別名不重複計一次提及', () => {
  it('「陳國煌 Philchen」與「陳國煌」同時命中同一段話，只記一筆、只替換一次', () => {
    peopleStore.importRoster(
      [{
        employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null,
        aliases: ['Philchen', '陳國煌 Philchen'],
      }],
      T0,
    );
    newMeeting(['p-1']);

    const result = resolver.resolveTranscript('m-1', [seg('陳國煌 Philchen 說要往前推進')], T0);
    const exactMentions = result.mentions.filter((m) => m.employee_id === 'p-1');
    expect(exactMentions).toHaveLength(1);
  });
});

describe('resolveTranscript：重疊別名不誤判（Codex review 2026-09-21 抓到）', () => {
  it('員工 A 的別名包含員工 B 的別名時，B 不該因為落在 A 的命中範圍內而被記一筆', () => {
    peopleStore.importRoster(
      [
        { employeeId: 'p-1', displayName: '陳愛麗', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Alice Chen'] },
        { employeeId: 'p-2', displayName: '陳先生', title: null, email: 'p2@liontravel.com', department: null, aliases: ['Chen'] },
      ],
      T0,
    );
    newMeeting(['p-1', 'p-2']);

    const result = resolver.resolveTranscript('m-1', [seg('Alice Chen 提案')], T0);
    // 只有 p-1（Alice Chen）被記一筆，p-2（Chen）不該因為是 Alice Chen 的子字串而誤中
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].employee_id).toBe('p-1');
    expect(result.resolvedSegments[0].text).toBe('陳愛麗 提案');
  });

  it('同一個人在同一段話裡用兩個不重疊的別名，各自記一筆並各自替換', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen', 'Phil'] }],
      T0,
    );
    newMeeting(['p-1']);

    const result = resolver.resolveTranscript('m-1', [seg('Philchen 先開場，後面 Phil 又補充')], T0);
    expect(result.mentions).toHaveLength(2);
    expect(result.mentions.every((m) => m.employee_id === 'p-1')).toBe(true);
    // 兩個不重疊的別名都要被換成正名，不能因為同一個員編先出現過就跳過後面那個
    expect(result.resolvedSegments[0].text).toBe('陳國煌 先開場，後面 陳國煌 又補充');
  });

  it('正名與它自己的短別名重疊時，短別名不該在同一個位置再記一筆', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳小明', title: null, email: 'p1@liontravel.com', department: null, aliases: ['小明'] }],
      T0,
    );
    newMeeting(['p-1']);

    const result = resolver.resolveTranscript('m-1', [seg('陳小明報告')], T0);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toMatchObject({ original_text: '陳小明', method: 'exact' });
  });

  it('短別名在正名命中範圍外另外出現時，仍各自記一筆（needs_review 那筆不影響已解析視圖）', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳小明', title: null, email: 'p1@liontravel.com', department: null, aliases: ['小明'] }],
      T0,
    );
    newMeeting(['p-1']);

    const result = resolver.resolveTranscript('m-1', [seg('陳小明說完，小明再補充一句')], T0);
    expect(result.mentions).toHaveLength(2);
    expect(result.mentions[0]).toMatchObject({ original_text: '陳小明', method: 'exact' });
    expect(result.mentions[1]).toMatchObject({ original_text: '小明', method: 'short_alias_review' });
    expect(result.resolvedSegments[0].text).toBe('陳小明說完，小明再補充一句');
  });
});

describe('resolveTranscript：只在該場會與會者的別名集合裡比對', () => {
  it('沒被宣告為與會者的人，就算名字出現在逐字稿裡也不比對', () => {
    peopleStore.importRoster(
      [
        { employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: [] },
        { employeeId: 'p-2', displayName: '林小華', title: null, email: 'p2@liontravel.com', department: null, aliases: [] },
      ],
      T0,
    );
    newMeeting(['p-1']); // 只有陳國煌是這場會的與會者

    const result = resolver.resolveTranscript('m-1', [seg('陳國煌跟林小華都同意這個方向')], T0);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].employee_id).toBe('p-1');
  });
});

describe('resolveTranscript：name_mentions 落地與可重建', () => {
  beforeEach(() => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: [] }],
      T0,
    );
    newMeeting(['p-1']);
  });

  it('重跑同一場會的比對會整批清掉舊列重寫，不留舊版本', () => {
    resolver.resolveTranscript('m-1', [seg('陳國煌開場'), seg('陳國煌總結')], T0);
    const countAfterFirst = (db.prepare('SELECT COUNT(*) AS c FROM name_mentions WHERE meeting_id = ?').get('m-1') as { c: number }).c;
    expect(countAfterFirst).toBe(2);

    // 第二次只有一段提到人名：重算後應該只剩一筆，不是累加成三筆
    resolver.resolveTranscript('m-1', [seg('這次只有陳國煌開場')], T0 + 1);
    const rows = db.prepare('SELECT segment_index, original_text, employee_id, method, confidence FROM name_mentions WHERE meeting_id = ?').all('m-1');
    expect(rows).toHaveLength(1);
  });

  it('Meeting 被刪除時 name_mentions 跟著 cascade 清掉', () => {
    resolver.resolveTranscript('m-1', [seg('陳國煌開場')], T0);
    store.deleteMeeting('m-1');
    const rows = db.prepare('SELECT * FROM name_mentions WHERE meeting_id = ?').all('m-1');
    expect(rows).toEqual([]);
  });
});

describe('resolveAnalysisEmployeeIds（FN-14）', () => {
  const baseAnalysis: AnalysisV3 = {
    contract_version: 3,
    overview: '摘要',
    topics: [],
    decisions: [{ text: '採用方案 A', evidence: null, decided_by: '陳國煌' }],
    action_items: [{
      text: '整理報價', source_meeting_id: 'm-1', created_at: T0, status: 'unknown', due: null,
      assignee: 'Philchen', evidence: null,
    }],
    open_questions: [],
  };

  beforeEach(() => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen'] }],
      T0,
    );
    newMeeting(['p-1']);
  });

  it('decided_by／assignee 逐字對得上正名或別名時反查出員編', () => {
    const result = resolver.resolveAnalysisEmployeeIds(baseAnalysis, 'm-1');
    expect(result.decisions[0].decided_by_employee_id).toBe('p-1');
    expect(result.action_items[0].assignee_employee_id).toBe('p-1');
  });

  it('decided_by／assignee 是 null 時不查，員編也是 null', () => {
    const analysis: AnalysisV3 = {
      ...baseAnalysis,
      decisions: [{ text: '採用方案 A', evidence: null, decided_by: null }],
      action_items: [{ ...baseAnalysis.action_items[0], assignee: null }],
    };
    const result = resolver.resolveAnalysisEmployeeIds(analysis, 'm-1');
    expect(result.decisions[0].decided_by_employee_id).toBeNull();
    expect(result.action_items[0].assignee_employee_id).toBeNull();
  });

  it('字串對不上任何正名或別名（模型意譯或簡稱）時不猜，留 null', () => {
    const analysis: AnalysisV3 = {
      ...baseAnalysis,
      decisions: [{ text: '採用方案 A', evidence: null, decided_by: '小陳' }], // 簡稱，不在別名集合裡
    };
    const result = resolver.resolveAnalysisEmployeeIds(analysis, 'm-1');
    expect(result.decisions[0].decided_by_employee_id).toBeNull();
  });

  it('字串撞到兩個員編時不猜，留 null', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '林雅婷', title: null, email: 'p2@liontravel.com', department: null, aliases: ['陳國煌'] }],
      T0,
    );
    store.createMeeting({ meeting_id: 'm-2', created_at: T0, source_file_name: 'b.m4a', source_file_size: 10, participant_ids: ['p-1', 'p-2'] });

    const result = resolver.resolveAnalysisEmployeeIds(baseAnalysis, 'm-2');
    expect(result.decisions[0].decided_by_employee_id).toBeNull();
  });

  it('短別名（兩字以下）在這裡不受限制：整段逐字相等就查，不套 needs_review', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-3', displayName: '陳小明', title: null, email: 'p3@liontravel.com', department: null, aliases: ['小明'] }],
      T0,
    );
    store.createMeeting({ meeting_id: 'm-3', created_at: T0, source_file_name: 'c.m4a', source_file_size: 10, participant_ids: ['p-3'] });

    const analysis: AnalysisV3 = { ...baseAnalysis, decisions: [{ text: '採用方案 A', evidence: null, decided_by: '小明' }] };
    const result = resolver.resolveAnalysisEmployeeIds(analysis, 'm-3');
    expect(result.decisions[0].decided_by_employee_id).toBe('p-3');
  });

  it('模型輸出多帶前後空白時仍查得到（trim 不是放寬比對，只防意外空白）', () => {
    const analysis: AnalysisV3 = { ...baseAnalysis, decisions: [{ text: '採用方案 A', evidence: null, decided_by: '  陳國煌 ' }] };
    const result = resolver.resolveAnalysisEmployeeIds(analysis, 'm-1');
    expect(result.decisions[0].decided_by_employee_id).toBe('p-1');
  });

  it('沒有與會者時全部留 null，不查全公司名單', () => {
    store.createMeeting({ meeting_id: 'm-4', created_at: T0, source_file_name: 'd.m4a', source_file_size: 10 });
    const result = resolver.resolveAnalysisEmployeeIds(baseAnalysis, 'm-4');
    expect(result.decisions[0].decided_by_employee_id).toBeNull();
    expect(result.action_items[0].assignee_employee_id).toBeNull();
  });
});

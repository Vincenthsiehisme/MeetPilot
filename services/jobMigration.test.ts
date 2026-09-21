import { describe, it, expect } from 'vitest';
import { JobStatus } from '../types';
import { isRejected, toMigrationRecord } from './jobMigration';

const completedJob = {
  id: 'job-1',
  fileName: '週會.m4a',
  fileSize: 1024,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  status: JobStatus.COMPLETED,
  currentStep: 3,
  transcript: [{ start: 0, end: 5, text: '開始', speaker: 'Speaker 1' }],
  analysis: {
    overview: '討論供應商報價',
    topics: [{ title: '付款條件', content: '30 改 60 天' }],
    decisions: ['採用 B 方案'],
    action_items: ['整理比較表'],
  },
  meetingTags: ['採購', '報價'],
  meetingContext: '第三次談',
  steps: [],
};

const expectOk = (outcome: ReturnType<typeof toMigrationRecord>) => {
  if (isRejected(outcome)) throw new Error(`預期成功，實際被拒：${outcome.reason}`);
  return outcome;
};

describe('toMigrationRecord 的成功路徑', () => {
  it('COMPLETED 且資料齊全轉成 READY', () => {
    const { record } = expectOk(toMigrationRecord(completedJob));
    expect(record.meeting.status).toBe('READY');
    expect(record.meeting.meeting_id).toBe('job-1');
    expect(record.meeting.origin).toBe('migrated');
  });

  it('標題取 analysis 的 overview，不是檔名', () => {
    const { record } = expectOk(toMigrationRecord(completedJob));
    expect(record.meeting.title).toBe('討論供應商報價');
  });

  it('沒有 analysis 時退回檔名當標題，兩者都沒有就是 null，不塞「未命名」', () => {
    const pending = { ...completedJob, status: JobStatus.PENDING, analysis: undefined, transcript: undefined };
    expect(expectOk(toMigrationRecord(pending)).record.meeting.title).toBe('週會.m4a');
    expect(expectOk(toMigrationRecord({ ...pending, fileName: undefined })).record.meeting.title).toBeNull();
  });

  it('action_items 升成 v3 並標 unknown，出處與人名一律 null', () => {
    const { record } = expectOk(toMigrationRecord(completedJob));
    expect(record.analysis?.action_items).toEqual([
      {
        text: '整理比較表', source_meeting_id: 'job-1', created_at: 1_700_000_000_000, status: 'unknown',
        assignee: null, due: null, evidence: null,
      },
    ]);
  });

  it('meetingTags 帶過去，非字串的元素丟掉但要講出來', () => {
    const outcome = expectOk(toMigrationRecord({ ...completedJob, meetingTags: ['採購', 7, null] }));
    expect(outcome.record.tags).toEqual(['採購']);
    expect(outcome.notes.join()).toMatch(/2 個元素不是字串/);
  });

  it('PENDING 轉成 CREATED', () => {
    const { record } = expectOk(toMigrationRecord({ ...completedJob, status: JobStatus.PENDING }));
    expect(record.meeting.status).toBe('CREATED');
  });

  it('FAILED 轉成 FAILED 並帶著錯誤訊息', () => {
    const { record } = expectOk(toMigrationRecord({ ...completedJob, status: JobStatus.FAILED, error: '轉錄失敗' }));
    expect(record.meeting.status).toBe('FAILED');
    expect(record.meeting.error).toBe('轉錄失敗');
  });

  it('RUNNING 轉成 CREATED 但一定帶 note，不安靜地轉', () => {
    const outcome = expectOk(toMigrationRecord({ ...completedJob, status: JobStatus.RUNNING }));
    expect(outcome.record.meeting.status).toBe('CREATED');
    expect(outcome.notes.join()).toMatch(/重新送出處理/);
  });

  it('沒有要講的事情時 notes 是空陣列', () => {
    expect(expectOk(toMigrationRecord(completedJob)).notes).toEqual([]);
  });

  it('同一份輸入轉兩次完全相同', () => {
    expect(toMigrationRecord(completedJob)).toEqual(toMigrationRecord(completedJob));
  });
});

describe('toMigrationRecord 的拒收路徑', () => {
  it('不是物件', () => {
    expect(toMigrationRecord('x')).toEqual({ ok: false, jobId: null, reason: '不是物件' });
  });

  it('缺 id', () => {
    const outcome = toMigrationRecord({ ...completedJob, id: '  ' });
    expect(outcome).toMatchObject({ ok: false, jobId: null });
  });

  it('缺 createdAt 時拒收，不補現在時間', () => {
    const outcome = toMigrationRecord({ ...completedJob, createdAt: undefined });
    expect(outcome).toMatchObject({ ok: false, jobId: 'job-1', reason: '缺 createdAt 或不是數字' });
  });

  it('缺 updatedAt 時拒收，不沿用 createdAt 頂替', () => {
    const outcome = toMigrationRecord({ ...completedJob, updatedAt: undefined });
    expect(outcome).toMatchObject({ ok: false, jobId: 'job-1', reason: '缺 updatedAt 或不是數字' });
  });

  it('transcript 有值但不是陣列時整筆拒收，不當成「沒有逐字稿」', () => {
    const outcome = toMigrationRecord({ ...completedJob, transcript: { segments: [] } });
    expect(outcome).toMatchObject({ ok: false, jobId: 'job-1', reason: 'transcript 不是陣列' });
  });

  it('status 不是合法的 JobStatus', () => {
    const outcome = toMigrationRecord({ ...completedJob, status: 'DONE' });
    expect(outcome).toMatchObject({ ok: false, jobId: 'job-1' });
    if (isRejected(outcome)) expect(outcome.reason).toMatch(/DONE/);
  });

  it('COMPLETED 但沒有逐字稿', () => {
    const outcome = toMigrationRecord({ ...completedJob, transcript: [] });
    expect(outcome).toMatchObject({ ok: false, reason: 'status 是 COMPLETED 但沒有逐字稿' });
  });

  it('COMPLETED 但沒有分析結果', () => {
    const outcome = toMigrationRecord({ ...completedJob, analysis: undefined });
    expect(outcome).toMatchObject({ ok: false, reason: 'status 是 COMPLETED 但沒有分析結果' });
  });

  it('COMPLETED 但分析四個欄位全空，不當成成功匯入', () => {
    const empty = { overview: '', topics: [], decisions: [], action_items: [] };
    const outcome = toMigrationRecord({ ...completedJob, analysis: empty });
    expect(outcome).toMatchObject({ ok: false, reason: 'status 是 COMPLETED 但分析結果四個欄位都是空的' });
  });

  it('逐字稿裡有段落缺欄位就整筆拒收，不丟掉那一段', () => {
    const outcome = toMigrationRecord({ ...completedJob, transcript: [{ start: 0, end: 1, text: 'a' }, { start: 2 }] });
    expect(outcome).toMatchObject({ ok: false, reason: 'transcript 裡有段落缺 start / end / text' });
  });

  it('analysis 形狀不符合 v1 契約', () => {
    const outcome = toMigrationRecord({ ...completedJob, analysis: { overview: 'x', topics: [], decisions: [], action_items: [{ text: 'x' }] } });
    expect(outcome).toMatchObject({ ok: false, reason: 'analysis 的形狀不符合 C-ANALYSIS v1' });
  });
});

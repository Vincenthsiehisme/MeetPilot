import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { createJobStore, JobStore } from './jobStore';

const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let meetingStore: MeetingStore;
let jobs: JobStore;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  meetingStore = createMeetingStore(db);
  jobs = createJobStore(db);
  meetingStore.createMeeting({ meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
});

afterEach(() => {
  db.close();
});

describe('enqueue', () => {
  it('回傳新 job 的 id，狀態是 queued', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0);
    expect(jobId).not.toBeNull();
    expect(jobs.get(jobId!)).toMatchObject({ meeting_id: 'm-1', kind: 'transcription', status: 'queued', attempt: 0 });
  });

  it('同一場會同一種 kind 已經在排隊就不重複入列，回傳 null', () => {
    const first = jobs.enqueue('m-1', 'transcription', null, T0);
    const second = jobs.enqueue('m-1', 'transcription', null, T0 + 1);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('不同 kind 各自可以入列，互不影響', () => {
    const t = jobs.enqueue('m-1', 'transcription', null, T0);
    const a = jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0);
    expect(t).not.toBeNull();
    expect(a).not.toBeNull();
  });

  it('analysis job 的 payload 原樣存回，enqueue 當下釘死', () => {
    const jobId = jobs.enqueue('m-1', 'analysis', { source_kind: 'edited', source_edit_version: 3 }, T0);
    expect(jobs.get(jobId!)?.payload).toEqual({ source_kind: 'edited', source_edit_version: 3 });
  });

  it('已經跑完（succeeded）的 job 不算 active，可以重新入列', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60_000, T0 + 1);
    jobs.markSucceeded(jobId, T0 + 2);

    const again = jobs.enqueue('m-1', 'transcription', null, T0 + 3);
    expect(again).not.toBeNull();
    expect(jobs.hasActive('m-1', 'transcription')).toBe(true);
  });
});

describe('claim', () => {
  it('依建立時間搶最舊的一筆，claim 後狀態變 claimed 並記下 worker 與到期時間', () => {
    const first = jobs.enqueue('m-1', 'transcription', null, T0)!;
    meetingStore.createMeeting({ meeting_id: 'm-2', created_at: T0, source_file_name: 'b.m4a', source_file_size: 1 });
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);

    const claimed = jobs.claim('transcription', 'worker-1', 60_000, T0 + 2);

    expect(claimed?.job_id).toBe(first);
    expect(claimed).toMatchObject({ status: 'claimed', claimed_by: 'worker-1', claimed_at: T0 + 2, lease_expires_at: T0 + 2 + 60_000 });
  });

  it('已經被搶走的 job 不會被第二個 worker 搶到', () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    const won = jobs.claim('transcription', 'worker-1', 60_000, T0 + 1);
    const lost = jobs.claim('transcription', 'worker-2', 60_000, T0 + 2);

    expect(won).not.toBeNull();
    expect(lost).toBeNull();
  });

  it('沒有排隊中的 job 時回 null', () => {
    expect(jobs.claim('analysis', 'worker-1', 60_000, T0)).toBeNull();
  });

  it('只搶指定 kind，不會搶到另一種 kind 的 job', () => {
    jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0);
    expect(jobs.claim('transcription', 'worker-1', 60_000, T0 + 1)).toBeNull();
  });
});

describe('markRunning／markSucceeded', () => {
  it('claim 之後轉 running，成功後轉 succeeded 並清掉 error', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60_000, T0 + 1);

    jobs.markRunning(jobId, T0 + 2);
    expect(jobs.get(jobId)?.status).toBe('running');

    jobs.markSucceeded(jobId, T0 + 3);
    expect(jobs.get(jobId)).toMatchObject({ status: 'succeeded', error: null });
  });
});

describe('markFailed', () => {
  it('重試次數還沒用盡時退回 queued，attempt +1，清掉 claim 資訊', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60_000, T0 + 1);
    jobs.markRunning(jobId, T0 + 2);

    const outcome = jobs.markFailed(jobId, 'Gemini 逾時', T0 + 3);

    expect(outcome).toBe('queued');
    expect(jobs.get(jobId)).toMatchObject({
      status: 'queued', attempt: 1, error: 'Gemini 逾時', claimed_by: null, claimed_at: null, lease_expires_at: null,
    });
  });

  it('用盡 max_attempts 之後轉 failed，不再退回 queued', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0, 2)!; // max_attempts = 2

    jobs.claim('transcription', 'w1', 60_000, T0 + 1);
    expect(jobs.markFailed(jobId, '第一次失敗', T0 + 2)).toBe('queued');

    jobs.claim('transcription', 'w1', 60_000, T0 + 3);
    const outcome = jobs.markFailed(jobId, '第二次失敗', T0 + 4);

    expect(outcome).toBe('failed');
    expect(jobs.get(jobId)?.status).toBe('failed');
    expect(jobs.get(jobId)?.attempt).toBe(2);
  });

  it('找不到 job 時拋錯，不靜默忽略', () => {
    expect(() => jobs.markFailed('不存在的 id', '原因', T0)).toThrow(/找不到 job/);
  });
});

describe('reclaimExpired', () => {
  it('lease 過期的 claimed job 退回 queued，attempt +1', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 1_000, T0 + 1); // lease 到 T0+1001 過期

    const report = jobs.reclaimExpired(T0 + 2_000);

    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ outcome: 'queued' });
    expect(jobs.get(jobId)).toMatchObject({ status: 'queued', attempt: 1 });
  });

  it('lease 過期的 running job 一樣會被回收', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 1_000, T0 + 1);
    jobs.markRunning(jobId, T0 + 1);

    const report = jobs.reclaimExpired(T0 + 5_000);

    expect(report[0].outcome).toBe('queued');
  });

  it('lease 還沒過期的不動', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60_000, T0 + 1);

    expect(jobs.reclaimExpired(T0 + 2_000)).toEqual([]);
    expect(jobs.get(jobId)?.status).toBe('claimed');
  });

  it('回收也吃 max_attempts：用盡了就轉 failed 不再退回 queued', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0, 1)!; // max_attempts = 1
    jobs.claim('transcription', 'worker-1', 1_000, T0 + 1);

    const report = jobs.reclaimExpired(T0 + 5_000);

    expect(report[0].outcome).toBe('failed');
    expect(jobs.get(jobId)?.status).toBe('failed');
  });

  it('queued（還沒被搶）的 job 不受影響，只回收 claimed／running', () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    expect(jobs.reclaimExpired(T0 + 999_999)).toEqual([]);
  });
});

describe('reclaimAllActive（server 啟動時呼叫一次）', () => {
  it('不管 lease 過期沒過期，claimed／running 全部回收', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60 * 60_000, T0 + 1); // lease 還有一小時才到期

    const report = jobs.reclaimAllActive(T0 + 2_000); // 遠早於 lease 到期時間

    expect(report).toHaveLength(1);
    expect(report[0].outcome).toBe('queued');
    expect(jobs.get(jobId)).toMatchObject({ status: 'queued', attempt: 1 });
  });

  it('running 的也一起回收', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'worker-1', 60 * 60_000, T0 + 1);
    jobs.markRunning(jobId, T0 + 1);

    const report = jobs.reclaimAllActive(T0 + 2_000);

    expect(report[0].outcome).toBe('queued');
  });

  it('queued 與 succeeded／failed 不受影響', () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    expect(jobs.reclaimAllActive(T0 + 1)).toEqual([]);
  });

  it('也吃 max_attempts：用盡了轉 failed，不是無限重開', () => {
    const jobId = jobs.enqueue('m-1', 'transcription', null, T0, 1)!; // max_attempts=1
    jobs.claim('transcription', 'worker-1', 60 * 60_000, T0 + 1);

    const report = jobs.reclaimAllActive(T0 + 2_000);

    expect(report[0].outcome).toBe('failed');
    expect(jobs.get(jobId)?.status).toBe('failed');
  });
});

describe('activeMeetingIds', () => {
  it('queued、claimed、running 都算，每場只列一次；succeeded、failed 不算', () => {
    meetingStore.createMeeting({ meeting_id: 'm-2', created_at: T0, source_file_name: 'b.m4a', source_file_size: 1 });
    meetingStore.createMeeting({ meeting_id: 'm-3', created_at: T0, source_file_name: 'c.m4a', source_file_size: 1 });
    jobs.enqueue('m-1', 'transcription', null, T0);
    jobs.claim('transcription', 'w', 60_000, T0 + 1);
    jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0 + 2);
    const m2 = jobs.enqueue('m-2', 'transcription', null, T0 + 3)!;
    jobs.markSucceeded(m2, T0 + 4);
    expect(jobs.activeMeetingIds()).toEqual(['m-1']);
    const m3 = jobs.enqueue('m-3', 'transcription', null, T0 + 5)!;
    expect(jobs.activeMeetingIds().sort()).toEqual(['m-1', 'm-3']);
    jobs.markFailed(m3, 'x', T0 + 6);
    jobs.markFailed(m3, 'x', T0 + 7);
    jobs.markFailed(m3, 'x', T0 + 8);
    expect(jobs.activeMeetingIds()).toEqual(['m-1']);
  });
});

describe('listLatestJobs', () => {
  it('每場會每種 kind 只回最新一筆，失敗用盡的那筆帶 error', () => {
    const first = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.markFailed(first, '壞了', T0 + 1);
    jobs.markFailed(first, '壞了', T0 + 2);
    jobs.markFailed(first, '壞了', T0 + 3);
    expect(jobs.listLatestJobs()).toEqual([
      { job_id: first, meeting_id: 'm-1', kind: 'transcription', status: 'failed', error: '壞了' },
    ]);

    const second = jobs.enqueue('m-1', 'transcription', null, T0 + 10)!;
    const analysis = jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0 + 11)!;
    const latest = jobs.listLatestJobs();
    expect(latest).toHaveLength(2);
    expect(latest.find(j => j.kind === 'transcription')).toMatchObject({ job_id: second, status: 'queued', error: null });
    expect(latest.find(j => j.kind === 'analysis')).toMatchObject({ job_id: analysis, status: 'queued' });
  });

  it('同一毫秒建立的兩筆（前一筆已 succeeded）取後插入的', () => {
    const first = jobs.enqueue('m-1', 'transcription', null, T0)!;
    jobs.claim('transcription', 'w', 60_000, T0);
    jobs.markSucceeded(first, T0);
    const second = jobs.enqueue('m-1', 'transcription', null, T0)!;
    expect(jobs.listLatestJobs().map(j => j.job_id)).toEqual([second]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { createJobStore, JobStore } from './jobStore';
import { JOB_RETRY_COOLDOWN_STEP_MS, createJobWorker } from './jobWorker';

const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let meetingStore: MeetingStore;
let jobs: JobStore;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  meetingStore = createMeetingStore(db);
  jobs = createJobStore(db);
  for (const id of ['m-1', 'm-2', 'm-3']) {
    meetingStore.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
  }
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('createJobWorker', () => {
  it('poke 之後搶到 job 並跑完，成功呼叫 onSuccess', async () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    const ran: string[] = [];
    const succeeded: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async (meetingId) => { ran.push(meetingId); },
      onSuccess: (meetingId) => succeeded.push(meetingId),
    });

    worker.poke();
    await worker.whenIdle();

    expect(ran).toEqual(['m-1']);
    expect(succeeded).toEqual(['m-1']);
    expect(jobs.hasActive('m-1', 'transcription')).toBe(false);
  });

  it('concurrency=1 時一次只跑一個，第二個要等第一個結束才開始', async () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);
    let resolveFirst: () => void = () => {};
    const started: string[] = [];
    const finished: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async (meetingId) => {
        started.push(meetingId);
        if (meetingId === 'm-1') await new Promise<void>((resolve) => { resolveFirst = resolve; });
        finished.push(meetingId);
      },
    });

    worker.poke();
    await Promise.resolve();
    await Promise.resolve();

    // 第二個還沒開始跑：concurrency=1 卡住了
    expect(started).toEqual(['m-1']);
    expect(worker.active).toBe(1);

    resolveFirst();
    await worker.whenIdle();

    expect(started).toEqual(['m-1', 'm-2']);
    expect(finished).toEqual(['m-1', 'm-2']);
  });

  it('concurrency=2 時兩個可以同時跑', async () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);
    let resolveBoth: (() => void)[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 2, workerId: 'w1', leaseMs: 60_000,
      run: () => new Promise<void>((resolve) => { resolveBoth.push(resolve); }),
    });

    worker.poke();
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.active).toBe(2);
    resolveBoth.forEach((r) => r());
    await worker.whenIdle();
  });

  it('只搶指定 kind 的 job，不會跑到別種 kind', async () => {
    jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0);
    const ran: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async (meetingId) => { ran.push(meetingId); },
    });

    worker.poke();
    await worker.whenIdle();

    expect(ran).toEqual([]);
    expect(jobs.hasActive('m-1', 'analysis')).toBe(true); // 沒被動到
  });

  it('run() 持續失敗：退回 queued 後冷卻 30 秒乘第幾次失敗才再搶，用盡 max_attempts 才轉 failed（AC-5）', async () => {
    vi.useFakeTimers();
    jobs.enqueue('m-1', 'transcription', null, T0, 3); // max_attempts=3
    const failures: { meetingId: string; outcome: string }[] = [];
    let runs = 0;
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async () => { runs += 1; throw new Error('fetch failed'); },
      onFailure: (meetingId, outcome) => failures.push({ meetingId, outcome }),
    });

    worker.poke();
    await worker.whenIdle();
    expect(runs).toBe(1);
    expect(failures).toEqual([{ meetingId: 'm-1', outcome: 'queued' }]);

    // 第 1 次失敗冷卻 30 秒：差 1 毫秒不搶，poke 也不搶
    await vi.advanceTimersByTimeAsync(JOB_RETRY_COOLDOWN_STEP_MS - 1);
    worker.poke();
    await worker.whenIdle();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await worker.whenIdle();
    expect(runs).toBe(2);

    // 第 2 次失敗冷卻變 60 秒：30 秒到了還不搶
    await vi.advanceTimersByTimeAsync(JOB_RETRY_COOLDOWN_STEP_MS);
    await worker.whenIdle();
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(JOB_RETRY_COOLDOWN_STEP_MS);
    await worker.whenIdle();
    expect(runs).toBe(3);

    expect(failures).toEqual([
      { meetingId: 'm-1', outcome: 'queued' },
      { meetingId: 'm-1', outcome: 'queued' },
      { meetingId: 'm-1', outcome: 'failed' },
    ]);
    expect(jobs.hasActive('m-1', 'transcription')).toBe(false);
  });

  it('job 用盡重試轉 failed 時不冷卻，同一輪接著搶下一筆', async () => {
    vi.useFakeTimers();
    jobs.enqueue('m-1', 'transcription', null, T0, 1); // max_attempts=1：第一次失敗就 failed
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);
    const ran: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async (meetingId) => { ran.push(meetingId); if (meetingId === 'm-1') throw new Error('掛了'); },
    });

    worker.poke();
    await worker.whenIdle();

    expect(ran).toEqual(['m-1', 'm-2']);
  });

  it('冷卻中整個 worker 不搶，別場會的 job 也要等冷卻到期', async () => {
    vi.useFakeTimers();
    jobs.enqueue('m-1', 'transcription', null, T0);
    const ran: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      cooldownMs: (n) => 1_000 * n,
      run: async (meetingId) => { ran.push(meetingId); if (meetingId === 'm-1' && ran.length === 1) throw new Error('掛了'); },
    });

    worker.poke();
    await worker.whenIdle();
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);
    worker.poke();
    await worker.whenIdle();
    expect(ran).toEqual(['m-1']);

    await vi.advanceTimersByTimeAsync(1_000);
    await worker.whenIdle();
    // 冷卻到期後照 claim 的順序把排隊的都跑完
    expect(ran).toEqual(['m-1', 'm-1', 'm-2']);
  });

  it('前一個 job 做完自動接著搶下一個，不用等外部再呼叫一次 poke', async () => {
    jobs.enqueue('m-1', 'transcription', null, T0);
    jobs.enqueue('m-2', 'transcription', null, T0 + 1);
    const ran: string[] = [];
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async (meetingId) => { ran.push(meetingId); },
    });

    worker.poke(); // 只 poke 一次
    await worker.whenIdle();

    expect(ran).toEqual(['m-1', 'm-2']);
  });

  it('沒有排隊中的 job 時 poke 什麼都不做', async () => {
    const worker = createJobWorker({
      jobs, kind: 'transcription', concurrency: 1, workerId: 'w1', leaseMs: 60_000,
      run: async () => {},
    });
    worker.poke();
    await worker.whenIdle();
    expect(worker.active).toBe(0);
  });
});

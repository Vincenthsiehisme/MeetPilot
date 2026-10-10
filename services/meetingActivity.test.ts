import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMeetingDb } from './meetingDb';
import { createMeetingStore } from './meetingStore';
import { createJobStore, type LatestJob } from './jobStore';
import type { MeetingStatus } from './meetingState';
import {
  buildStatusFile, createActivityMonitor, createActivityTracker, resolveActivitySender, takeSnapshot,
  type ActivityMeeting, type ActivityMessage,
} from './meetingActivity';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;

const meeting = (id: string, status: MeetingStatus, extra: Partial<ActivityMeeting> = {}): ActivityMeeting => ({
  meeting_id: id, title: `會議 ${id}`, status, updated_at: NOW, error: null, ...extra,
});
const job = (id: string, kind: LatestJob['kind'], status: LatestJob['status'], error: string | null = null, jobId = `${id}-${kind}`): LatestJob =>
  ({ job_id: jobId, meeting_id: id, kind, status, error });

/** 一個時間點的世界：會議、每種 kind 最新的 job。進行中的 job 集合照 jobStore 的定義（queued／claimed／running）算 */
const snap = (meetings: ActivityMeeting[], jobs: LatestJob[] = []) =>
  takeSnapshot(
    meetings, jobs,
    [...new Set(jobs.filter(j => ['queued', 'claimed', 'running'].includes(j.status)).map(j => j.meeting_id))],
  );

describe('takeSnapshot：active', () => {
  it('claimed 的 job 也算進行中；同一場有兩種 job 只算一次', () => {
    const s = snap(
      [meeting('a', 'TRANSCRIBING'), meeting('b', 'TRANSCRIBED'), meeting('c', 'READY')],
      [job('a', 'transcription', 'claimed'), job('a', 'analysis', 'queued'), job('b', 'analysis', 'running'),
        job('c', 'analysis', 'succeeded')],
    );
    expect(s.active).toBe(2);
  });

  it('LINKING 的會議也算，而且已經有進行中 job 的 LINKING 只算一次', () => {
    const s = snap(
      [meeting('a', 'LINKING'), meeting('b', 'LINKING'), meeting('c', 'LINKED')],
      [job('b', 'analysis', 'running')],
    );
    expect(s.active).toBe(2);
  });

  it('CREATED、RECORDING、FAILED 沒有 job 就不算', () => {
    expect(snap([meeting('a', 'CREATED'), meeting('b', 'RECORDING'), meeting('c', 'FAILED')]).active).toBe(0);
  });
});

describe('createActivityTracker：done', () => {
  it('啟動基準不發事件，基準時已經在處理中的會議之後跑完照發', () => {
    const t = createActivityTracker();
    expect(t.observe(snap([meeting('a', 'ANALYZING'), meeting('b', 'LINKED')]))).toEqual([]);
    expect(t.observe(snap([meeting('a', 'LINKED'), meeting('b', 'LINKED')]))).toEqual([
      { meetingId: 'a', title: '會議 a', kind: 'done', reason: null },
    ]);
  });

  it('基準時就是 READY、LINKED 的會議不補發', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'READY'), meeting('b', 'LINKED'), meeting('c', 'LINK_FAILED')]));
    expect(t.observe(snap([meeting('a', 'READY'), meeting('b', 'LINKED'), meeting('c', 'LINK_FAILED')]))).toEqual([]);
  });

  it('READY 一閃而過：快照看到 ANALYZING 然後直接是 LINKED，照發 done 且只發一次', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'TRANSCRIBED')], [job('a', 'analysis', 'queued')]));
    expect(t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running')]))).toEqual([]);
    const events = t.observe(snap([meeting('a', 'LINKED')], [job('a', 'analysis', 'succeeded')]));
    expect(events).toEqual([{ meetingId: 'a', title: '會議 a', kind: 'done', reason: null }]);
    expect(t.observe(snap([meeting('a', 'LINKED')], [job('a', 'analysis', 'succeeded')]))).toEqual([]);
  });

  it('LINKING 還沒結束不發；結束在 READY（關聯關閉）也發', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'ANALYZING'), meeting('b', 'ANALYZING')]));
    expect(t.observe(snap([meeting('a', 'LINKING'), meeting('b', 'READY')])).map(e => e.meetingId)).toEqual(['b']);
    expect(t.observe(snap([meeting('a', 'LINKED'), meeting('b', 'READY')])).map(e => e.meetingId)).toEqual(['a']);
  });

  it('LINK_FAILED 算 done，reason 寫關聯失敗與 meeting.error', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'ANALYZING')]));
    expect(t.observe(snap([meeting('a', 'LINK_FAILED', { error: 'embedding 逾時' })]))).toEqual([
      { meetingId: 'a', title: '會議 a', kind: 'done', reason: '關聯失敗：embedding 逾時' },
    ]);
  });

  it('終點狀態但還有進行中的 job（例如又排了分析）不發 done', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running')]));
    expect(t.observe(snap([meeting('a', 'READY')], [job('a', 'analysis', 'running')]))).toEqual([]);
  });

  it('跑完後再被重跑，第二次跑完會再發一次', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'LINKED')]));
    t.observe(snap([meeting('a', 'LINKING')], [job('a', 'analysis', 'running')]));
    expect(t.observe(snap([meeting('a', 'LINKED')], [job('a', 'analysis', 'succeeded')])).map(e => e.kind)).toEqual(['done']);
  });
});

describe('createActivityTracker：failed', () => {
  it('分析退回 TRANSCRIBED 但 job 退回 queued 重試時不發 failed', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running')]));
    expect(t.observe(snap([meeting('a', 'TRANSCRIBED')], [job('a', 'analysis', 'queued', '暫時性錯誤')]))).toEqual([]);
    expect(t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running', '暫時性錯誤')]))).toEqual([]);
  });

  it('分析 job 用盡重試轉 failed、會議停在 TRANSCRIBED：發一次 failed，reason 是 job 的錯誤', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running')]));
    const failedState = snap([meeting('a', 'TRANSCRIBED')], [job('a', 'analysis', 'failed', 'MAX_TOKENS')]);
    expect(t.observe(failedState)).toEqual([{ meetingId: 'a', title: '會議 a', kind: 'failed', reason: 'MAX_TOKENS' }]);
    expect(t.observe(failedState)).toEqual([]);
  });

  it('轉錄 job 用盡與會議進 FAILED 在同一輪：只發一則，reason 用 meeting.error', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'TRANSCRIBING')], [job('a', 'transcription', 'running')]));
    const events = t.observe(snap(
      [meeting('a', 'FAILED', { error: '轉錄失敗：fetch failed' })],
      [job('a', 'transcription', 'failed', 'fetch failed')],
    ));
    expect(events).toEqual([{ meetingId: 'a', title: '會議 a', kind: 'failed', reason: '轉錄失敗：fetch failed' }]);
  });

  it('job 先失敗、會議下一輪才進 FAILED：不重複發', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'TRANSCRIBING')], [job('a', 'transcription', 'running')]));
    expect(t.observe(snap([meeting('a', 'TRANSCRIBING')], [job('a', 'transcription', 'failed', 'x')]))).toHaveLength(1);
    expect(t.observe(snap([meeting('a', 'FAILED', { error: 'x' })], [job('a', 'transcription', 'failed', 'x')]))).toEqual([]);
  });

  it('會議新進 FAILED（沒有新失敗的 job，例如 job 已經不在）也發，reason 沒有就 null', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'CREATED')]));
    expect(t.observe(snap([meeting('a', 'FAILED')]))).toEqual([
      { meetingId: 'a', title: '會議 a', kind: 'failed', reason: null },
    ]);
  });

  it('基準時就已經 FAILED 或 job 已經 failed 的不發', () => {
    const t = createActivityTracker();
    const world = snap([meeting('a', 'FAILED', { error: 'x' }), meeting('b', 'TRANSCRIBED')], [job('b', 'analysis', 'failed', 'y')]);
    t.observe(world);
    expect(t.observe(world)).toEqual([]);
  });

  it('失敗後使用者重跑又失敗（新 job）會再發一次', () => {
    const t = createActivityTracker();
    t.observe(snap([meeting('a', 'TRANSCRIBED')], [job('a', 'analysis', 'failed', 'x', 'j1')]));
    t.observe(snap([meeting('a', 'ANALYZING')], [job('a', 'analysis', 'running', null, 'j2')]));
    const events = t.observe(snap([meeting('a', 'TRANSCRIBED')], [job('a', 'analysis', 'failed', 'z', 'j2')]));
    expect(events).toEqual([{ meetingId: 'a', title: '會議 a', kind: 'failed', reason: 'z' }]);
  });
});

describe('resolveActivitySender', () => {
  it('沒有 parentPort（dev、正式 server）回 null', () => {
    expect(resolveActivitySender({} as NodeJS.Process)).toBeNull();
  });

  it('有 parentPort 就把訊息交給 postMessage', () => {
    const sent: unknown[] = [];
    const send = resolveActivitySender({ parentPort: { postMessage: (m: unknown) => sent.push(m) } } as unknown as NodeJS.Process);
    const message: ActivityMessage = { type: 'meetpilot-activity', schema: 1, active: 1, events: [] };
    send!(message);
    expect(sent).toEqual([message]);
  });
});

describe('buildStatusFile', () => {
  it('只收不是 READY／LINKED、14 天內有動過的會議，並帶 inProgress', () => {
    const jobs = [job('t', 'transcription', 'claimed'), job('x', 'analysis', 'failed', 'boom')];
    const file = buildStatusFile(snap(
      [
        meeting('r', 'READY'), meeting('l', 'LINKED'),
        meeting('t', 'TRANSCRIBING'),
        meeting('k', 'LINKING'),
        meeting('rec', 'RECORDING'),
        meeting('x', 'TRANSCRIBED'),
        meeting('lf', 'LINK_FAILED', { error: '關聯壞了' }),
        meeting('old', 'FAILED', { updated_at: NOW - 15 * DAY }),
        meeting('edge', 'CREATED', { updated_at: NOW - 14 * DAY, title: null }),
      ],
      jobs,
    ), NOW);
    expect(file.schema).toBe(1);
    expect(file.writtenAt).toBe(new Date(NOW).toISOString());
    expect(file.meetings.map(m => [m.meetingId, m.status, m.inProgress])).toEqual([
      ['t', 'TRANSCRIBING', true],
      ['k', 'LINKING', true],
      ['rec', 'RECORDING', false],
      ['x', 'TRANSCRIBED', false],
      ['lf', 'LINK_FAILED', false],
      ['edge', 'CREATED', false],
    ]);
    expect(file.meetings.find(m => m.meetingId === 'lf')).toEqual({
      meetingId: 'lf', title: '會議 lf', status: 'LINK_FAILED', inProgress: false,
      updatedAt: new Date(NOW).toISOString(), error: '關聯壞了',
    });
    expect(file.meetings.find(m => m.meetingId === 'edge')?.title).toBeNull();
  });
});

describe('createActivityMonitor', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'meetpilot-activity-'));
    const db = openMeetingDb(':memory:');
    const store = createMeetingStore(db);
    const jobs = createJobStore(db);
    const sent: ActivityMessage[] = [];
    const clock = { now: NOW };
    const monitor = createActivityMonitor({
      listMeetings: () => store.listMeetings(),
      jobs,
      vaultDir: dir,
      send: m => sent.push(m),
      now: () => clock.now,
    });
    return { db, store, jobs, sent, clock, monitor, dir };
  };

  it('第一次送基準；active 沒變又沒事件就不送；變了或有事件才送', () => {
    const { db, store, jobs, sent, clock, monitor } = setup();
    store.createMeeting({ meeting_id: 'm1', created_at: NOW, source_file_name: 'a.m4a', source_file_size: 1 });
    monitor.tick();
    expect(sent).toEqual([{ type: 'meetpilot-activity', schema: 1, active: 0, events: [] }]);

    clock.now += 5_000;
    monitor.tick();
    expect(sent).toHaveLength(1);

    store.setStatus('m1', 'TRANSCRIBING', clock.now);
    jobs.enqueue('m1', 'transcription', null, clock.now);
    clock.now += 5_000;
    monitor.tick();
    expect(sent.at(-1)).toEqual({ type: 'meetpilot-activity', schema: 1, active: 1, events: [] });

    store.setStatus('m1', 'FAILED', clock.now, '壞了');
    const claimed = jobs.claim('transcription', 'w', 1000, clock.now)!;
    jobs.markFailed(claimed.job_id, '壞了', clock.now);
    jobs.markFailed(claimed.job_id, '壞了', clock.now);
    jobs.markFailed(claimed.job_id, '壞了', clock.now);
    clock.now += 5_000;
    monitor.tick();
    expect(sent.at(-1)).toEqual({
      type: 'meetpilot-activity', schema: 1, active: 0,
      events: [{ meetingId: 'm1', title: null, kind: 'failed', reason: '壞了' }],
    });
    db.close();
  });

  it('send 是 null（不在 utilityProcess）時不送也不報錯，狀態檔照寫', () => {
    const dirPath = mkdtempSync(join(tmpdir(), 'meetpilot-activity-'));
    dir = dirPath;
    const db = openMeetingDb(':memory:');
    const store = createMeetingStore(db);
    store.createMeeting({ meeting_id: 'm1', created_at: NOW, source_file_name: 'a.m4a', source_file_size: 1 });
    const monitor = createActivityMonitor({
      listMeetings: () => store.listMeetings(), jobs: createJobStore(db), vaultDir: dirPath, send: null, now: () => NOW,
    });
    expect(() => monitor.tick()).not.toThrow();
    expect(readdirSync(dirPath)).toEqual(['_狀態.json']);
    db.close();
  });

  it('狀態檔：內容是 schema 1 的 JSON、原子寫入不留 .part；沒變時不重寫，變了或滿 60 秒才寫', () => {
    const { db, store, clock, dir: vault } = setup();
    const writes: string[] = [];
    const monitor = createActivityMonitor({
      listMeetings: () => store.listMeetings(),
      jobs: createJobStore(db),
      vaultDir: vault,
      send: null,
      now: () => clock.now,
      writeFile: path => { writes.push(path); },
    });
    store.createMeeting({ meeting_id: 'm1', created_at: NOW, source_file_name: 'a.m4a', source_file_size: 1 });
    monitor.tick();
    clock.now += 5_000;
    monitor.tick();
    expect(writes).toEqual([join(vault, '_狀態.json')]);
    clock.now += 5_000;
    store.setStatus('m1', 'TRANSCRIBING', clock.now);
    monitor.tick();
    expect(writes).toHaveLength(2);
    clock.now += 60_000;
    monitor.tick();
    expect(writes).toHaveLength(3);
    db.close();
  });

  it('狀態檔真的寫到磁碟：meetings 與 inProgress，資料夾裡沒有 .part 殘留', () => {
    const { db, store, jobs, clock, monitor, dir: vault } = setup();
    store.createMeeting({ meeting_id: 'm1', created_at: NOW, source_file_name: 'a.m4a', source_file_size: 1 });
    store.setStatus('m1', 'TRANSCRIBING', NOW);
    jobs.enqueue('m1', 'transcription', null, NOW);
    store.createMeeting({ meeting_id: 'm2', created_at: NOW, source_file_name: 'b.m4a', source_file_size: 1 });
    monitor.tick();
    clock.now += 1;
    expect(readdirSync(vault)).toEqual(['_狀態.json']);
    const file = JSON.parse(readFileSync(join(vault, '_狀態.json'), 'utf8'));
    expect(file.schema).toBe(1);
    expect(file.writtenAt).toBe(new Date(NOW).toISOString());
    expect(file.meetings).toHaveLength(2);
    expect(file.meetings.find((m: { meetingId: string }) => m.meetingId === 'm1')).toMatchObject({
      status: 'TRANSCRIBING', inProgress: true, error: null,
    });
    expect(file.meetings.find((m: { meetingId: string }) => m.meetingId === 'm2')).toMatchObject({
      status: 'CREATED', inProgress: false,
    });
    db.close();
  });

  it('start()：第一次寫狀態檔失敗不拋、大聲記錯（帶路徑），基準訊息照送，下一輪 tick 會再寫', () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { db, store, sent, dir: vault } = setup();
      store.createMeeting({ meeting_id: 'm1', created_at: NOW, source_file_name: 'a.m4a', source_file_size: 1 });
      const writes: string[] = [];
      let failNext = true;
      const monitor = createActivityMonitor({
        listMeetings: () => store.listMeetings(),
        jobs: createJobStore(db),
        vaultDir: vault,
        send: m => sent.push(m),
        now: () => NOW,
        writeFile: path => {
          writes.push(path);
          if (failNext) {
            failNext = false;
            throw new Error('EPERM: rename 被 OneDrive 鎖住');
          }
        },
      });
      expect(() => monitor.start()).not.toThrow();
      expect(sent).toEqual([{ type: 'meetpilot-activity', schema: 1, active: 0, events: [] }]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(String(errorLog.mock.calls[0]?.[0])).toContain(join(vault, '_狀態.json'));
      vi.advanceTimersByTime(5_000);
      expect(writes).toEqual([join(vault, '_狀態.json'), join(vault, '_狀態.json')]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      monitor.stop();
      db.close();
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });
});

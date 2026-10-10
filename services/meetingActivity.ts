/**
 * server 端的活動快照（vault plan「MeetPilot · 記錄完整度、成本與背景運作」AC-3）。
 *
 * 每 5 秒算一次「哪些會議在處理、哪些剛跑完或剛失敗」，兩個出口：
 * - 在 Electron utilityProcess 裡（`process.parentPort` 存在）時，經 parentPort 送 `meetpilot-activity` 訊息
 *   給桌面主程序，它拿去擋休眠、問結束確認、發系統通知（`electron/desktopActivity.ts`，T2）；
 * - 每 60 秒與內容有變時，原子寫 `<vault>/_狀態.json`，同事看得到每位記錄人現在卡在哪（`scripts/` 的總覽，T4）。
 *
 * 判斷邏輯是純函式加一個小的狀態物件（`createActivityTracker`），不碰 DB 與 timer，測試用假資料就跑得動；
 * `createActivityMonitor` 才把它接上 store、timer 與輸出。
 */
import { join } from 'node:path';
import type { JobKind, LatestJob } from './jobStore';
import type { MeetingStatus } from './meetingState';
import { writeAtomic } from './vaultProjector';

export const ACTIVITY_SCHEMA = 1;
export const ACTIVITY_MESSAGE_TYPE = 'meetpilot-activity';
export const STATUS_FILE_NAME = '_狀態.json';
export const SNAPSHOT_INTERVAL_MS = 5_000;
export const STATUS_HEARTBEAT_MS = 60_000;
/** 狀態檔只收這個時間內有動過的會議 */
export const STATUS_FILE_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface ActivityEvent {
  meetingId: string;
  title: string | null;
  kind: 'done' | 'failed';
  reason: string | null;
}

export interface ActivityMessage {
  type: typeof ACTIVITY_MESSAGE_TYPE;
  schema: typeof ACTIVITY_SCHEMA;
  active: number;
  events: ActivityEvent[];
}

export interface StatusFileMeeting {
  meetingId: string;
  title: string | null;
  status: MeetingStatus;
  inProgress: boolean;
  updatedAt: string;
  error: string | null;
}

export interface StatusFile {
  schema: typeof ACTIVITY_SCHEMA;
  writtenAt: string;
  meetings: StatusFileMeeting[];
}

/** `Meeting` 結構相容的最小形狀，測試不必開 DB */
export interface ActivityMeeting {
  meeting_id: string;
  title: string | null;
  status: MeetingStatus;
  updated_at: number;
  error: string | null;
}

interface JobObservation {
  jobId: string;
  status: LatestJob['status'];
  error: string | null;
}

export interface MeetingSnapshot {
  meetingId: string;
  title: string | null;
  status: MeetingStatus;
  updatedAt: number;
  error: string | null;
  /** 有 queued、claimed 或 running 的 job */
  hasActiveJob: boolean;
  jobs: Partial<Record<JobKind, JobObservation>>;
  /** `done` 判斷用的「處理中」：TRANSCRIBING、TRANSCRIBED 且有進行中的 job、ANALYZING，或有進行中的 job */
  processing: boolean;
  /** 算進 `active` 的會議：有進行中的 job，或 LINKING */
  counted: boolean;
}

export interface ActivitySnapshot {
  meetings: MeetingSnapshot[];
  active: number;
}

const isProcessing = (status: MeetingStatus, hasActiveJob: boolean): boolean =>
  hasActiveJob || status === 'TRANSCRIBING' || status === 'ANALYZING';

export const takeSnapshot = (
  meetings: readonly ActivityMeeting[],
  latestJobs: readonly LatestJob[],
  activeMeetingIds: readonly string[],
): ActivitySnapshot => {
  const activeIds = new Set(activeMeetingIds);
  const jobsByMeeting = new Map<string, Partial<Record<JobKind, JobObservation>>>();
  for (const job of latestJobs) {
    const entry = jobsByMeeting.get(job.meeting_id) ?? {};
    entry[job.kind] = { jobId: job.job_id, status: job.status, error: job.error };
    jobsByMeeting.set(job.meeting_id, entry);
  }
  const snapshots = meetings.map((meeting): MeetingSnapshot => {
    const hasActiveJob = activeIds.has(meeting.meeting_id);
    return {
      meetingId: meeting.meeting_id,
      title: meeting.title,
      status: meeting.status,
      updatedAt: meeting.updated_at,
      error: meeting.error,
      hasActiveJob,
      jobs: jobsByMeeting.get(meeting.meeting_id) ?? {},
      processing: isProcessing(meeting.status, hasActiveJob),
      counted: hasActiveJob || meeting.status === 'LINKING',
    };
  });
  return { meetings: snapshots, active: snapshots.filter(m => m.counted).length };
};

const TERMINAL_STATUSES: readonly MeetingStatus[] = ['READY', 'LINKED', 'LINK_FAILED'];

/**
 * 記住上一次快照，只對「server 啟動後觀察到的變化」發事件。第一次 `observe` 是啟動基準，不發事件。
 *
 * - `done`：先在某次快照處於處理中，之後落在 READY／LINKED／LINK_FAILED、沒有進行中的 job（LINKING 不算終點）。
 *   不能只看進 READY：關聯開著時 READY 只停留幾毫秒，快照多半直接看到 LINKING 或 LINKED。
 * - `failed`：轉錄或分析 job 新變成 failed（重試用盡），或會議新進 FAILED。分析失敗退回 TRANSCRIBED、
 *   job 退回 queued 重試的那幾次，最新 job 是 queued 不是 failed，不發。
 * - 同一場同一次處理最多一則：job 失敗與會議進 FAILED 常在同一輪發生，後者靠 `failedFired` 擋掉；
 *   會議再被看到處理中時才重置。
 */
export const createActivityTracker = () => {
  let previous: Map<string, MeetingSnapshot> | null = null;
  const wasProcessing = new Set<string>();
  const failedFired = new Set<string>();

  const failureOf = (current: MeetingSnapshot, before: MeetingSnapshot | undefined): ActivityEvent | null => {
    let jobError: string | null = null;
    let jobFailed = false;
    for (const kind of ['transcription', 'analysis'] as const) {
      const job = current.jobs[kind];
      if (job?.status !== 'failed') continue;
      const old = before?.jobs[kind];
      if (old?.jobId === job.jobId && old.status === 'failed') continue;
      jobFailed = true;
      jobError = jobError ?? job.error;
    }
    const enteredFailed = current.status === 'FAILED' && before?.status !== 'FAILED';
    if (!jobFailed && !(enteredFailed && !failedFired.has(current.meetingId))) return null;
    failedFired.add(current.meetingId);
    const reason = current.status === 'FAILED' ? (current.error ?? jobError) : (jobError ?? current.error);
    return { meetingId: current.meetingId, title: current.title, kind: 'failed', reason };
  };

  const doneOf = (current: MeetingSnapshot): ActivityEvent | null => {
    if (!wasProcessing.has(current.meetingId)) return null;
    if (current.hasActiveJob || !TERMINAL_STATUSES.includes(current.status)) return null;
    let reason: string | null = null;
    if (current.status === 'LINK_FAILED') {
      reason = current.error ? `關聯失敗：${current.error}` : '關聯失敗';
    }
    return { meetingId: current.meetingId, title: current.title, kind: 'done', reason };
  };

  return {
    observe: (snapshot: ActivitySnapshot): ActivityEvent[] => {
      const current = new Map(snapshot.meetings.map(m => [m.meetingId, m]));
      const events: ActivityEvent[] = [];
      for (const meeting of snapshot.meetings) {
        if (previous !== null) {
          const failed = failureOf(meeting, previous.get(meeting.meetingId));
          const done = failed ? null : doneOf(meeting);
          if (failed) {
            events.push(failed);
            wasProcessing.delete(meeting.meetingId);
            continue;
          }
          if (done) {
            events.push(done);
            wasProcessing.delete(meeting.meetingId);
          }
        }
        if (meeting.processing) {
          wasProcessing.add(meeting.meetingId);
          failedFired.delete(meeting.meetingId);
        }
      }
      for (const id of [...wasProcessing, ...failedFired]) {
        if (!current.has(id)) {
          wasProcessing.delete(id);
          failedFired.delete(id);
        }
      }
      previous = current;
      return events;
    },
  };
};

export const buildStatusFile = (snapshot: ActivitySnapshot, now: number): StatusFile => ({
  schema: ACTIVITY_SCHEMA,
  writtenAt: new Date(now).toISOString(),
  meetings: snapshot.meetings
    .filter(m => m.status !== 'READY' && m.status !== 'LINKED' && m.updatedAt >= now - STATUS_FILE_WINDOW_MS)
    .map(m => ({
      meetingId: m.meetingId,
      title: m.title,
      status: m.status,
      // 錄音中不算：那是人在錄，不是系統在處理
      inProgress: m.status !== 'RECORDING' && m.counted,
      updatedAt: new Date(m.updatedAt).toISOString(),
      error: m.error,
    })),
});

export interface ActivityPort {
  postMessage: (message: unknown) => void;
}

/** Electron utilityProcess 才有 `process.parentPort`；`npm run dev` 與正式 server 沒有，回 null */
export const resolveActivitySender = (proc: NodeJS.Process): ((message: ActivityMessage) => void) | null => {
  const port = (proc as unknown as { parentPort?: ActivityPort }).parentPort;
  if (!port) return null;
  return message => port.postMessage(message);
};

export interface ActivityMonitorDeps {
  listMeetings: () => readonly ActivityMeeting[];
  jobs: { activeMeetingIds: () => string[]; listLatestJobs: () => LatestJob[] };
  vaultDir: string;
  /** null：不在 utilityProcess，只寫狀態檔 */
  send: ((message: ActivityMessage) => void) | null;
  now?: () => number;
  writeFile?: (path: string, content: string) => void;
}

export const createActivityMonitor = (deps: ActivityMonitorDeps) => {
  const now = deps.now ?? Date.now;
  const writeFile = deps.writeFile ?? writeAtomic;
  const statusPath = join(deps.vaultDir, STATUS_FILE_NAME);
  const tracker = createActivityTracker();
  let sentActive: number | null = null;
  let lastWrittenBody: string | null = null;
  let lastWrittenAt = 0;
  let timer: NodeJS.Timeout | null = null;

  /** 算一次快照：送訊息、需要時寫狀態檔。丟出的錯誤由呼叫端記錄 */
  const tick = (): void => {
    const at = now();
    const snapshot = takeSnapshot(deps.listMeetings(), deps.jobs.listLatestJobs(), deps.jobs.activeMeetingIds());
    const events = tracker.observe(snapshot);
    if (deps.send && (sentActive === null || sentActive !== snapshot.active || events.length > 0)) {
      deps.send({ type: ACTIVITY_MESSAGE_TYPE, schema: ACTIVITY_SCHEMA, active: snapshot.active, events });
      sentActive = snapshot.active;
    }
    const file = buildStatusFile(snapshot, at);
    const body = JSON.stringify(file.meetings);
    if (lastWrittenBody === null || body !== lastWrittenBody || at - lastWrittenAt >= STATUS_HEARTBEAT_MS) {
      writeFile(statusPath, `${JSON.stringify(file, null, 2)}\n`);
      lastWrittenBody = body;
      lastWrittenAt = at;
    }
  };

  return {
    tick,
    /** 立刻算一次當基準，之後每 5 秒一次。timer 裡的例外只記 log，不讓 server 因此掛掉 */
    start: (): void => {
      if (timer) throw new Error('活動快照已經在跑');
      tick();
      timer = setInterval(() => {
        try {
          tick();
        } catch (err) {
          console.error('[MeetPilot] 活動快照失敗：', err);
        }
      }, SNAPSHOT_INTERVAL_MS);
      timer.unref();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};

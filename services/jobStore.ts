/**
 * `jobs` 表的存取層（vault plan「MeetPilot · 轉錄分析佇列架構升級」）。
 *
 * 取代升級前純記憶體、單一佇列、一次只跑一場、`server` 一重啟就空了的舊做法。
 * 這裡是持久化的 job table，轉錄與分析各自一條（`kind` 分流），各自可以有自己的並行量、
 * 各自失敗各自重試，不再綁死成同一條鏈。
 *
 * claim 用 compare-and-swap（`UPDATE ... WHERE status='queued'` 檢查 `changes === 1`），
 * 不是因為這個 process 真的有多執行緒——`node:sqlite` 的 `DatabaseSync` 是同步 API，
 * 同一個 process 裡不會有兩個呼叫交錯執行。這裡先把介面設計成「假設會有多個 worker」，
 * 是為了未來要拆多 worker／多 process 時不用改介面，現在單 process 下它退化成單純的
 * 樂觀鎖檢查，成本很低。
 *
 * 「同一場會同一種 job 不重複入列」靠 `idx_jobs_meeting_kind_active`（partial unique index）
 * 保底，但 `enqueue()` 自己先查一次再寫，不靠抓 UNIQUE constraint 錯誤字串——那需要
 * 猜 node:sqlite 拋出的錯誤形狀，這裡沒有實測過。`DatabaseSync` 同步執行，
 * 查完到寫入之間不會有別的呼叫插進來，check-then-insert 在這裡是安全的。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type JobKind = 'transcription' | 'analysis';
export type JobRunStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed';

/** 分析 job 的 payload：讀哪個 transcript 版本，enqueue 當下釘死，worker 執行時不重查 */
export interface AnalysisJobPayload {
  source_kind: 'raw' | 'edited' | 'unknown';
  source_edit_version: number | null;
}

export interface Job {
  job_id: string;
  meeting_id: string;
  kind: JobKind;
  status: JobRunStatus;
  payload: AnalysisJobPayload | null;
  attempt: number;
  max_attempts: number;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_expires_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface JobRow {
  job_id: string; meeting_id: string; kind: JobKind; status: JobRunStatus; payload: string | null;
  attempt: number; max_attempts: number; claimed_by: string | null; claimed_at: number | null;
  lease_expires_at: number | null; error: string | null; created_at: number; updated_at: number;
}

const toJob = (row: JobRow): Job => ({
  ...row,
  payload: row.payload === null ? null : JSON.parse(row.payload) as AnalysisJobPayload,
});

export const createJobStore = (db: DatabaseSync) => {
  const selectByMeetingKindActive = db.prepare(
    "SELECT job_id FROM jobs WHERE meeting_id = ? AND kind = ? AND status IN ('queued','claimed','running')",
  );
  const selectByMeetingKindAny = db.prepare(
    'SELECT job_id FROM jobs WHERE meeting_id = ? AND kind = ? LIMIT 1',
  );
  const insertJob = db.prepare(`
    INSERT INTO jobs (job_id, meeting_id, kind, status, payload, attempt, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)
  `);
  const selectOne = db.prepare('SELECT * FROM jobs WHERE job_id = ?');
  const selectQueuedByKind = db.prepare(
    "SELECT job_id FROM jobs WHERE kind = ? AND status = 'queued' ORDER BY created_at LIMIT 10",
  );
  const claimUpdate = db.prepare(
    "UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ? "
    + "WHERE job_id = ? AND status = 'queued'",
  );
  const runningUpdate = db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE job_id = ?");
  const succeededUpdate = db.prepare(
    "UPDATE jobs SET status = 'succeeded', error = NULL, updated_at = ? WHERE job_id = ?",
  );
  const selectExpired = db.prepare(
    "SELECT * FROM jobs WHERE status IN ('claimed','running') AND lease_expires_at < ?",
  );

  const get = (jobId: string): Job | null => {
    const row = selectOne.get(jobId) as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  };

  /**
   * 重試用盡就轉 failed，否則退回 queued（attempt +1、清掉 claim 資訊）。
   * 回傳退到哪個狀態，呼叫端（worker、reclaim 掃描）拿這個決定要不要動 meeting 狀態。
   */
  const requeueOrFail = (job: Job, errorMessage: string, now: number): 'queued' | 'failed' => {
    const nextAttempt = job.attempt + 1;
    if (nextAttempt >= job.max_attempts) {
      db.prepare("UPDATE jobs SET status = 'failed', attempt = ?, error = ?, updated_at = ? WHERE job_id = ?")
        .run(nextAttempt, errorMessage, now, job.job_id);
      return 'failed';
    }
    db.prepare(
      "UPDATE jobs SET status = 'queued', attempt = ?, error = ?, claimed_by = NULL, claimed_at = NULL, "
      + 'lease_expires_at = NULL, updated_at = ? WHERE job_id = ?',
    ).run(nextAttempt, errorMessage, now, job.job_id);
    return 'queued';
  };

  return {
    /**
     * 這場會這種 kind 已經在排隊或在跑就不重複入列，回傳 null（呼叫端不用特別處理，
     * 語意跟 TranscriptionQueue.enqueue 的「已經在列不重複加」一致）。
     */
    enqueue: (
      meetingId: string,
      kind: JobKind,
      payload: AnalysisJobPayload | null,
      now: number,
      maxAttempts = 3,
    ): string | null => {
      if (selectByMeetingKindActive.get(meetingId, kind)) return null;
      const jobId = randomUUID();
      insertJob.run(jobId, meetingId, kind, payload === null ? null : JSON.stringify(payload), maxAttempts, now, now);
      return jobId;
    },

    get,

    /** 這場會這種 kind 目前是不是還在排隊或在跑 */
    hasActive: (meetingId: string, kind: JobKind): boolean =>
      selectByMeetingKindActive.get(meetingId, kind) !== undefined,

    /**
     * 這場會這種 kind 有沒有**任何**一筆 job，不管現在是什麼狀態（含 succeeded／failed）。
     * 給 `backfillInterruptedMeetings` 用：只在完全沒有 job 歷史時才補，已經有過 job
     * （包含用盡重試轉 failed 的）就不介入，交給既有機制（reclaimAllActive、使用者手動
     * retry）處理，不然每次重啟都會繞過 max_attempts 把已經放棄的 job 復活。
     */
    hasAny: (meetingId: string, kind: JobKind): boolean =>
      selectByMeetingKindAny.get(meetingId, kind) !== undefined,

    /**
     * 依建立時間搶最舊的一筆 queued job。CAS 失敗（被搶走）就换下一筆候選，
     * 10 筆都搶不到才回 null——單 worker 情境幾乎不會發生，多 worker 才用得到這個重試。
     */
    claim: (kind: JobKind, workerId: string, leaseMs: number, now: number): Job | null => {
      const candidates = selectQueuedByKind.all(kind) as { job_id: string }[];
      for (const { job_id: jobId } of candidates) {
        const result = claimUpdate.run(workerId, now, now + leaseMs, now, jobId);
        if (result.changes === 1) return get(jobId);
      }
      return null;
    },

    markRunning: (jobId: string, now: number): void => {
      runningUpdate.run(now, jobId);
    },

    markSucceeded: (jobId: string, now: number): void => {
      succeededUpdate.run(now, jobId);
    },

    /** 執行失敗（不是 lease 過期）：worker 自己呼叫，帶著真正的錯誤訊息 */
    markFailed: (jobId: string, errorMessage: string, now: number): 'queued' | 'failed' => {
      const job = get(jobId);
      if (!job) throw new Error(`找不到 job ${jobId}`);
      return requeueOrFail(job, errorMessage, now);
    },

    /**
     * lease 到期回收：取代 `requeueInterruptedMeetings` 的猜測式重建。server 重啟時掃一次，
     * 把停在 claimed／running 但 lease 已過期的 job 退回 queued（或用盡重試轉 failed）。
     * 回傳被動到的 job，呼叫端（worker 管理層）決定要不要同步 meeting 狀態。
     */
    reclaimExpired: (now: number): { job: Job; outcome: 'queued' | 'failed' }[] => {
      const expired = (selectExpired.all(now) as unknown as JobRow[]).map(toJob);
      return expired.map(job => ({
        job,
        outcome: requeueOrFail(job, 'lease 過期（worker 沒有正常結束，可能是 server 重啟或當掉）', now),
      }));
    },

    /**
     * server 啟動時呼叫一次：把所有還停在 `claimed`／`running` 的 job 全部回收，
     * **不看 lease 有沒有過期**。
     *
     * 這比 `reclaimExpired` 更激進，只有在單一 process 的前提下才安全——這個假設在這個 repo
     * 成立（見 `jobStore.ts` 檔頭）：一個新啟動的 process 看到 `claimed`／`running` 的 job，
     * 那一定是**上一個** process 留下的，不可能有另一個活著的 worker 還在真的跑它，所以
     * 不用等 lease 到期，啟動當下就能確定它已經死了。跟舊版 `requeueInterruptedMeetings`
     * 讀 `meetings.status` 猜的效果一樣，但這裡直接讀 job table 本身的狀態，不用猜。
     */
    reclaimAllActive: (now: number): { job: Job; outcome: 'queued' | 'failed' }[] => {
      const active = (
        db.prepare("SELECT * FROM jobs WHERE status IN ('claimed','running')").all() as unknown as JobRow[]
      ).map(toJob);
      return active.map(job => ({
        job,
        outcome: requeueOrFail(job, 'server 重啟前這個 job 還沒跑完（process 已經不在了）', now),
      }));
    },
  };
};

export type JobStore = ReturnType<typeof createJobStore>;

/**
 * job table 的事件驅動 worker（vault plan「MeetPilot · 轉錄分析佇列架構升級」）。
 *
 * 事件驅動，不是輪詢：這裡沒有第三方會偷偷往 `jobs` 表塞新列，所有寫入都是這個 process
 * 自己的 HTTP 路由或另一個 worker 的 `onSuccess` 呼叫的 `enqueue()`，所以事件驅動
 * （`poke()` 通知「可能有新工作」）比定時輪詢更直接，也不用在沒有工作時空轉。
 *
 * 跟升級前的做法差異只在「同時可以跑幾場」：舊的是寫死 1，這裡由 `concurrency` 決定，
 * 一路搶到搶不到 queued job 或滿了併行量為止。
 */
import { AnalysisJobPayload, JobKind, JobStore } from './jobStore';

export interface JobWorker {
  /** 通知這個 worker「可能有新工作」，實際搶不搶得到由 job table 的 claim 決定 */
  poke(): void;
  /** 目前真的在跑幾個 job */
  readonly active: number;
  /** 測試用：等所有正在跑的 job 都跑完（成功或失敗）。不等冷卻中的重試。正式流程不需要等 */
  whenIdle(): Promise<void>;
}

export interface JobWorkerDeps {
  jobs: JobStore;
  kind: JobKind;
  /** 同時最多跑幾場會 */
  concurrency: number;
  /** 這個 worker 的識別，寫進 `jobs.claimed_by`，方便查是哪個 worker 在跑 */
  workerId: string;
  /** claim 的 lease 時長。跑到一半 process 掛了，超過這個時間會被 reclaim 重新排隊 */
  leaseMs: number;
  /** 真正執行一個 job：`transcriptionPipeline` 的 `runTranscriptionPhase`／`runAnalysisPhase` */
  run: (meetingId: string, payload: AnalysisJobPayload | null) => Promise<void>;
  /** job 成功時呼叫，例如轉錄 worker 用它 enqueue 下一階段的分析 job */
  onSuccess?: (meetingId: string) => void;
  /**
   * job 失敗時呼叫（不管是退回 queued 重試還是重試次數用盡轉 failed 都會呼叫，
   * `outcome` 分得出兩者）。轉錄 worker 用它在 `outcome === 'failed'` 時呼叫
   * `transcriptionPipeline.markTranscriptionFailed` 把 meeting 轉成真正的終態。
   *
   * 退回 queued 時這個 worker 會先冷卻（見 `cooldownMs`），冷卻完才再搶。
   */
  onFailure?: (meetingId: string, outcome: 'queued' | 'failed', err: unknown) => void;
  now?: () => number;
  /**
   * job 第 n 次失敗、退回 queued 之後，這個 worker 停手多久才再搶（毫秒）。預設 30 秒乘 n
   * （`JOB_RETRY_COOLDOWN_STEP_MS`）。測試注入別的值；正式流程用預設。
   */
  cooldownMs?: (failureCount: number) => number;
}

/** job 退回 queued 後的冷卻：第 n 次失敗等這個值乘 n */
export const JOB_RETRY_COOLDOWN_STEP_MS = 30_000;

export function createJobWorker(deps: JobWorkerDeps): JobWorker {
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? ((failureCount: number) => JOB_RETRY_COOLDOWN_STEP_MS * failureCount);
  let active = 0;
  const running = new Set<Promise<void>>();

  /**
   * 冷卻（vault plan「MeetPilot · 記錄完整度、成本與背景運作」AC-5）：以前退回 queued 的 job
   * 會在同一輪 `finally` 的 `tick()` 被立刻搶回來重跑，造成失敗的原因（網路斷線、限流持續）
   * 多半還沒過去，`max_attempts` 很快用完、會議直接 FAILED。冷卻期間整個 worker 不搶（`poke()` 也不搶），
   * 等到時才 `tick()`；不改 `jobs` schema，冷卻只活在這個 process 的記憶體裡，
   * server 重啟後 `reclaimAllActive` 退回的 job 照常立刻搶，那是另一件事。
   *
   * 已經在冷卻時又有 job 失敗（`concurrency` > 1），取比較晚到期的那個，不重設成比較短的。
   */
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let cooldownUntil = 0;
  const startCooldown = (ms: number): void => {
    const until = now() + ms;
    if (cooldownTimer !== null && until <= cooldownUntil) return;
    if (cooldownTimer !== null) clearTimeout(cooldownTimer);
    cooldownUntil = until;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      void tick();
    }, ms);
    // 只為了等冷卻不該把 process 吊著不讓它結束
    cooldownTimer.unref?.();
  };

  const runOne = async (): Promise<void> => {
    const job = deps.jobs.claim(deps.kind, deps.workerId, deps.leaseMs, now());
    if (!job) return;
    active += 1;
    const task = (async () => {
      deps.jobs.markRunning(job.job_id, now());
      try {
        await deps.run(job.meeting_id, job.payload);
        deps.jobs.markSucceeded(job.job_id, now());
        deps.onSuccess?.(job.meeting_id);
      } catch (err) {
        const outcome = deps.jobs.markFailed(
          job.job_id,
          err instanceof Error ? err.message : String(err),
          now(),
        );
        // job.attempt 是這次搶到時的值（從 0 起算），這次失敗是第 attempt + 1 次
        if (outcome === 'queued') startCooldown(cooldownMs(job.attempt + 1));
        deps.onFailure?.(job.meeting_id, outcome, err);
      } finally {
        active -= 1;
        // 空出一個名額，可能還有排隊的下一筆，同一個 tick 裡繼續搶，不用等下一次 poke。
        // 冷卻中的話 tick 直接回，等冷卻到期再搶
        void tick();
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    // 遞迴而不是迴圈：每次搶到一個就立刻讓它開始跑（不 await），再看還有沒有名額繼續搶，
    // 讓多個 job 真的併發起步，不是搶到第一個才輪到第二個
    await tick();
  };

  const tick = async (): Promise<void> => {
    if (cooldownTimer !== null) return;
    if (active >= deps.concurrency) return;
    await runOne();
  };

  return {
    poke: () => { void tick(); },
    get active() { return active; },
    whenIdle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

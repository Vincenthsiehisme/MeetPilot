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
  /** 測試用：等所有正在跑的 job 都跑完（成功或失敗）。正式流程不需要等 */
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
   * **退回 queued 的 job 沒有 backoff，可能立刻在同一輪被同一個 worker 重新搶到重跑**
   * （見 `runOne` 的 `finally`）。這是刻意的簡化：`generateContentWithFallback` 自己會等：
   * 空輸出與 503 等 1、2 秒，限流照回應的 `retryDelay` 等、最多 60 秒（vault plan「MeetPilot ·
   * Gemini 限流退避」），會走到 job 級失敗的通常是限流持續好幾分鐘、或更嚴重的問題，
   * `max_attempts` 設得小，立即重試的代價可接受。限流持續到三次立刻重試都用完時會議會 FAILED，
   * 這包刻意不處理（要改 `jobs` schema）。
   * 之後如果真的需要 backoff，加在這裡（`onFailure` 裡 delay 後再 `poke()`）不用動這支本身。
   */
  onFailure?: (meetingId: string, outcome: 'queued' | 'failed', err: unknown) => void;
  now?: () => number;
}

export function createJobWorker(deps: JobWorkerDeps): JobWorker {
  const now = deps.now ?? (() => Date.now());
  let active = 0;
  const running = new Set<Promise<void>>();

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
        deps.onFailure?.(job.meeting_id, outcome, err);
      } finally {
        active -= 1;
        // 空出一個名額，可能還有排隊的下一筆，同一個 tick 裡繼續搶，不用等下一次 poke
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

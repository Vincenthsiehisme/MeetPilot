/**
 * 通用計數信號量（AC-6，vault plan「MeetPilot · 轉錄分析佇列架構升級」）。
 *
 * 不裝 `p-limit`／`bottleneck` 這類依賴：這個規模自己寫，維護成本比多一個依賴低。
 *
 * 為什麼需要：轉錄與分析拆成兩條各自可設定並行量的 queue 之後，兩條 queue 可能同時各跑
 * 一場會，各自打 Gemini——這是今天完全序列的架構裡不會發生的新併發。兩條 queue 共用同一個
 * Gemini API project，用同一個全域上限包住所有出去的呼叫，不管是哪條 queue 發出的。
 */
export interface ConcurrencyLimiter {
  /** 排到自己可以跑為止才 resolve */
  acquire(): Promise<void>;
  /** 用完一定要呼叫，通常搭 try/finally */
  release(): void;
}

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (max < 1) throw new Error(`concurrency limiter 的上限必須至少是 1，收到 ${max}`);
  let active = 0;
  const waiting: (() => void)[] = [];

  return {
    acquire(): Promise<void> {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiting.push(() => {
          active += 1;
          resolve();
        });
      });
    },
    release(): void {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    },
  };
}

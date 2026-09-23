import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter } from './concurrencyLimiter';

describe('createConcurrencyLimiter', () => {
  it('上限內的 acquire 立刻 resolve', async () => {
    const limiter = createConcurrencyLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    // 沒有拋錯、沒有卡住就是通過；上限內不排隊
  });

  it('超過上限時排隊，release 之後才輪到下一個', async () => {
    const limiter = createConcurrencyLimiter(1);
    const order: string[] = [];

    await limiter.acquire();
    order.push('A 拿到');

    const bWaiting = limiter.acquire().then(() => order.push('B 拿到'));
    // B 這時應該還卡著，還沒 resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['A 拿到']);

    limiter.release();
    await bWaiting;
    expect(order).toEqual(['A 拿到', 'B 拿到']);
  });

  it('多個排隊者依序放行，不會有兩個同時拿到超過上限', async () => {
    const limiter = createConcurrencyLimiter(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await limiter.acquire();
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      limiter.release();
    };

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('上限小於 1 時拋錯，不靜默退成無限制', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/至少是 1/);
  });
});

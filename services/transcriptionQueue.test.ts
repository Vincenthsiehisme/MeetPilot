import { describe, it, expect, vi } from 'vitest';
import { createTranscriptionQueue } from './transcriptionQueue';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createTranscriptionQueue', () => {
  it('一次只跑一場：第二場要等第一場跑完才開始', async () => {
    const started: string[] = [];
    const first = deferred();
    const queue = createTranscriptionQueue(async (id) => {
      started.push(id);
      if (id === 'm-1') await first.promise;
    });

    queue.enqueue('m-1');
    queue.enqueue('m-2');
    await Promise.resolve();

    expect(started).toEqual(['m-1']);
    expect(queue.running).toBe('m-1');
    expect(queue.pending).toBe(1);

    first.resolve();
    await queue.whenIdle();
    expect(started).toEqual(['m-1', 'm-2']);
    expect(queue.running).toBeNull();
    expect(queue.pending).toBe(0);
  });

  it('同一場會重複入列不會跑兩次：重複的 PUT 或 retry 不該讓同一場會並行', async () => {
    const started: string[] = [];
    const first = deferred();
    const queue = createTranscriptionQueue(async (id) => {
      started.push(id);
      if (started.length === 1) await first.promise;
    });

    queue.enqueue('m-1');
    queue.enqueue('m-1');
    await Promise.resolve();
    queue.enqueue('m-1');
    first.resolve();
    await queue.whenIdle();

    expect(started).toEqual(['m-1']);
  });

  it('一場失敗不影響後面那場，錯誤交給 onError 不往上丟', async () => {
    const onError = vi.fn();
    const done: string[] = [];
    const queue = createTranscriptionQueue(
      async (id) => {
        if (id === 'm-1') throw new Error('轉錄失敗');
        done.push(id);
      },
      onError,
    );

    queue.enqueue('m-1');
    queue.enqueue('m-2');
    await queue.whenIdle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('m-1');
    expect((onError.mock.calls[0][1] as Error).message).toBe('轉錄失敗');
    expect(done).toEqual(['m-2']);
  });

  it('has 回報排隊中與正在跑的那場，跑完之後就不算在裡面', async () => {
    const first = deferred();
    const queue = createTranscriptionQueue(async (id) => { if (id === 'm-1') await first.promise; });

    queue.enqueue('m-1');
    queue.enqueue('m-2');
    await Promise.resolve();

    expect(queue.has('m-1')).toBe(true);  // 正在跑
    expect(queue.has('m-2')).toBe(true);  // 排隊中
    expect(queue.has('m-3')).toBe(false);

    first.resolve();
    await queue.whenIdle();

    expect(queue.has('m-1')).toBe(false);
    expect(queue.has('m-2')).toBe(false);
  });

  it('cancel 把還在排隊的那場抽掉，佇列輪不到它', async () => {
    const started: string[] = [];
    const first = deferred();
    const queue = createTranscriptionQueue(async (id) => {
      started.push(id);
      if (id === 'm-1') await first.promise;
    });

    queue.enqueue('m-1');
    queue.enqueue('m-2');
    queue.enqueue('m-3');
    await Promise.resolve();

    expect(queue.cancel('m-2')).toBe(true);
    expect(queue.pending).toBe(1);
    first.resolve();
    await queue.whenIdle();

    expect(started).toEqual(['m-1', 'm-3']);
  });

  it('cancel 沒排隊的那場回 false，正在跑的那場也停不下來', async () => {
    const first = deferred();
    const queue = createTranscriptionQueue(async () => { await first.promise; });

    queue.enqueue('m-1');
    await Promise.resolve();

    expect(queue.cancel('m-1')).toBe(false);
    expect(queue.cancel('沒看過的 id')).toBe(false);
    first.resolve();
    await queue.whenIdle();
  });

  it('跑完之後再入列會重新開始跑，不會卡在已經結束的那一輪', async () => {
    const done: string[] = [];
    const queue = createTranscriptionQueue(async (id) => { done.push(id); });

    queue.enqueue('m-1');
    await queue.whenIdle();
    queue.enqueue('m-2');
    await queue.whenIdle();

    expect(done).toEqual(['m-1', 'm-2']);
  });
});

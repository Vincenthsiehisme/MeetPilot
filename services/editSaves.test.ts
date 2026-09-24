import { describe, it, expect } from 'vitest';
import { createDraftSync, createSaveQueue } from './editSaves';

/** 手動控制結束時機的 promise，用來排出「前一個還在路上」的情境 */
const deferred = <T = void>() => {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createSaveQueue：寫回一次一個、照送出的順序', () => {
  it('前一個還在路上時，後一個不會先送出', async () => {
    const queue = createSaveQueue();
    const log: string[] = [];
    const first = deferred();

    const a = queue.run(async () => { log.push('A 開始'); await first.promise; log.push('A 結束'); });
    const b = queue.run(async () => { log.push('B 開始'); });

    // 讓排程跑一輪：B 若沒排隊，這時已經開始了
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['A 開始']);

    first.resolve();
    await a;
    await b;
    expect(log).toEqual(['A 開始', 'A 結束', 'B 開始']);
  });

  it('最後寫進去的是最後送出的那份快照，不管前面的請求多慢', async () => {
    const queue = createSaveQueue();
    let stored = '';
    const slow = deferred();
    const write = (snapshot: string, wait?: Promise<void>) => queue.run(async () => {
      if (wait) await wait;
      stored = snapshot;
    });

    const older = write('舊快照', slow.promise);
    const newer = write('新快照');
    slow.resolve();
    await Promise.all([older, newer]);

    expect(stored).toBe('新快照');
  });

  it('前一個失敗不擋後一個，錯誤照樣交給前一個的呼叫端', async () => {
    const queue = createSaveQueue();
    const log: string[] = [];

    const failing = queue.run(async () => { throw new Error('PATCH 失敗'); });
    const next = queue.run(async () => { log.push('B 跑了'); return 'ok'; });

    await expect(failing).rejects.toThrow('PATCH 失敗');
    await expect(next).resolves.toBe('ok');
    expect(log).toEqual(['B 跑了']);
  });
});

describe('createDraftSync：草稿什麼時候可以被 server 的版本蓋掉', () => {
  it('沒有編輯也沒有存檔在路上：可以', () => {
    const sync = createDraftSync();
    expect(sync.canAdoptServer()).toBe(true);
    expect(sync.hasUnsent()).toBe(false);
  });

  it('打了字還沒送出：不行，蓋下去使用者正在打的字就不見了', () => {
    const sync = createDraftSync();
    sync.edited();
    expect(sync.hasUnsent()).toBe(true);
    expect(sync.canAdoptServer()).toBe(false);
  });

  it('送出之後、存檔結束之前：不行，這段期間回來的詳情可能是存檔之前的那份', () => {
    const sync = createDraftSync();
    sync.edited();
    sync.saveStarted();
    expect(sync.hasUnsent()).toBe(false);
    expect(sync.canAdoptServer()).toBe(false);
    sync.saveSettled(true);
    expect(sync.canAdoptServer()).toBe(true);
  });

  it('存檔在路上時又打了字：存檔結束後仍然不行，要等這段新修改送出去', () => {
    const sync = createDraftSync();
    sync.edited();
    sync.saveStarted();
    sync.edited();
    sync.saveSettled(true);
    expect(sync.hasUnsent()).toBe(true);
    expect(sync.canAdoptServer()).toBe(false);
  });

  it('沒存進去：草稿留著，算回還沒送出，下一次會再送', () => {
    const sync = createDraftSync();
    sync.edited();
    sync.saveStarted();
    sync.saveSettled(false);
    expect(sync.hasUnsent()).toBe(true);
    expect(sync.canAdoptServer()).toBe(false);
  });

  it('兩次存檔重疊：要兩次都結束才可以', () => {
    const sync = createDraftSync();
    sync.edited();
    sync.saveStarted();
    sync.edited();
    sync.saveStarted();
    sync.saveSettled(true);
    expect(sync.canAdoptServer()).toBe(false);
    sync.saveSettled(true);
    expect(sync.canAdoptServer()).toBe(true);
  });

  it('結束的次數比開始多是呼叫端寫錯，直接拋錯不要安靜地算成負數', () => {
    const sync = createDraftSync();
    expect(() => sync.saveSettled(true)).toThrow();
  });
});

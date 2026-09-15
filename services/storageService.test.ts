import { describe, it, expect, beforeEach, vi } from 'vitest';

// 最小的 IndexedDB 替身：只做 open / transaction / objectStore.delete，
// 交易何時 complete 或 error 由測試手動觸發，才能驗證「第二筆在第一筆 oncomplete 之後才開始」。
// open 的次數、close 與 versionchange 也記下來，才能驗證連線是共用的。
// 佇列現在只剩刪除在用（前端不再寫新的 Job，轉錄整條在 server），所以這個檔一律用 deleteJobFromDB 驗佇列。
type FakeTx = {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: Error | null;
  objectStore: (name: string) => { delete: (k: unknown) => void };
};

type FakeDB = {
  closed: boolean;
  onversionchange: (() => void) | null;
  onclose: (() => void) | null;
  close: () => void;
  objectStoreNames: { contains: () => boolean };
  transaction: () => FakeTx;
};

type FakeRequest = {
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onblocked: (() => void) | null;
  onerror: (() => void) | null;
  result: FakeDB | null;
  error: Error | null;
};

type FakeIDB = {
  deletes: unknown[];
  txs: FakeTx[];
  dbs: FakeDB[];
  opens: number;
  // 測試把它設 true，下一次 open 就以 onerror 收場
  failNextOpen: boolean;
  // 測試把它設 true，下一次 open 直接同步拋錯（IndexedDB 被停用時的 SecurityError）
  throwNextOpen: boolean;
  // 測試把它設 true，下一次 open 先 onblocked，之後才補一個遲到的 onsuccess
  // （其他分頁關掉後真的開成功了），用來驗證那條沒人要的連線有被關掉
  blockNextOpen: boolean;
  // 每呼叫一次 db.transaction() 就 shift 一個：非 null 就丟出去，
  // 用來模擬連線被 versionchange 關掉後開交易會拿到的 InvalidStateError
  txErrors: (Error | null)[];
  open: (name: string, version: number) => FakeRequest;
};

const makeFakeIDB = (): FakeIDB => {
  const fake: FakeIDB = {
    deletes: [],
    txs: [],
    dbs: [],
    opens: 0,
    failNextOpen: false,
    throwNextOpen: false,
    blockNextOpen: false,
    txErrors: [],
    open: () => {
      fake.opens += 1;
      if (fake.throwNextOpen) {
        fake.throwNextOpen = false;
        throw new Error('SecurityError');
      }
      const db: FakeDB = {
        closed: false,
        onversionchange: null,
        onclose: null,
        close: () => { db.closed = true; },
        objectStoreNames: { contains: () => true },
        transaction: (): FakeTx => {
          const txError = fake.txErrors.shift();
          if (txError) throw txError;
          const tx: FakeTx = {
            oncomplete: null,
            onerror: null,
            error: null,
            objectStore: () => ({
              delete: (k: unknown) => { fake.deletes.push(k); }
            })
          };
          fake.txs.push(tx);
          return tx;
        }
      };
      const request: FakeRequest = { onupgradeneeded: null, onsuccess: null, onblocked: null, onerror: null, result: db, error: null };
      const shouldFail = fake.failNextOpen;
      fake.failNextOpen = false;
      const shouldBlock = fake.blockNextOpen;
      fake.blockNextOpen = false;
      queueMicrotask(() => {
        if (shouldFail) {
          request.result = null;
          request.error = new Error('OpenFailed');
          if (request.onerror) request.onerror();
          return;
        }
        if (shouldBlock) {
          if (request.onblocked) request.onblocked();
          // 其他分頁關掉後這個 request 還是會成功，用下一個 microtask 模擬那個遲到的 onsuccess
          queueMicrotask(() => {
            fake.dbs.push(db);
            if (request.onsuccess) request.onsuccess();
          });
          return;
        }
        fake.dbs.push(db);
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    }
  };
  return fake;
};

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('storageService jobs 寫入佇列', () => {
  let fake: FakeIDB;
  // storageService 把連線快取在模組層，靜態 import 會讓快取跨測試殘留，
  // 所以每條測試都 resetModules 後重新載入，從乾淨的快取開始。
  let storage: typeof import('./storageService');

  beforeEach(async () => {
    fake = makeFakeIDB();
    vi.stubGlobal('indexedDB', fake);
    vi.resetModules();
    storage = await import('./storageService');
  });

  it('連續三次刪除照呼叫順序執行，且下一筆在前一筆 oncomplete 之後才開始', async () => {
    const states: string[] = [];

    const p1 = storage.deleteJobFromDB('job_1').then(() => { states.push('p1'); });
    const p2 = storage.deleteJobFromDB('job_2').then(() => { states.push('p2'); });
    const p3 = storage.deleteJobFromDB('job_3').then(() => { states.push('p3'); });

    await tick();
    expect(fake.deletes).toEqual(['job_1']);
    expect(fake.txs).toHaveLength(1);
    expect(states).toEqual([]);

    fake.txs[0].oncomplete!();
    await tick();
    expect(states).toEqual(['p1']);
    expect(fake.deletes).toEqual(['job_1', 'job_2']);
    expect(fake.txs).toHaveLength(2);

    fake.txs[1].oncomplete!();
    await tick();
    expect(states).toEqual(['p1', 'p2']);
    expect(fake.deletes).toEqual(['job_1', 'job_2', 'job_3']);
    expect(fake.txs).toHaveLength(3);

    fake.txs[2].oncomplete!();
    await Promise.all([p1, p2, p3]);
    expect(states).toEqual(['p1', 'p2', 'p3']);
  });

  it('某一筆失敗 reject 給呼叫者，後面那筆照常開始並完成', async () => {
    const p1 = storage.deleteJobFromDB('job_1');
    const p2 = storage.deleteJobFromDB('job_2');
    const p3 = storage.deleteJobFromDB('job_3');
    const p2Rejection = p2.then(() => 'resolved', (e: Error) => e.message);

    await tick();
    fake.txs[0].oncomplete!();
    await tick();
    expect(fake.deletes).toEqual(['job_1', 'job_2']);

    fake.txs[1].error = new Error('QuotaExceededError');
    fake.txs[1].onerror!();
    await tick();
    expect(await p2Rejection).toBe('QuotaExceededError');
    expect(fake.deletes).toEqual(['job_1', 'job_2', 'job_3']);
    expect(fake.txs).toHaveLength(3);

    fake.txs[2].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    await expect(p3).resolves.toBeUndefined();
  });

  it('連續三次刪除共用同一條連線，只 open 一次', async () => {
    const p1 = storage.deleteJobFromDB('job_1');
    const p2 = storage.deleteJobFromDB('job_2');
    const p3 = storage.deleteJobFromDB('job_3');

    await tick();
    fake.txs[0].oncomplete!();
    await tick();
    fake.txs[1].oncomplete!();
    await tick();
    fake.txs[2].oncomplete!();
    await Promise.all([p1, p2, p3]);

    expect(fake.opens).toBe(1);
  });

  it('收到 versionchange 就關掉連線，下一次刪除重新 open', async () => {
    const p1 = storage.deleteJobFromDB('job_1');
    await tick();
    fake.txs[0].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    expect(fake.opens).toBe(1);

    const db = fake.dbs[0];
    db.onversionchange!();
    expect(db.closed).toBe(true);

    const p2 = storage.deleteJobFromDB('job_2');
    await tick();
    expect(fake.opens).toBe(2);

    fake.txs[1].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('open 同步拋錯時呼叫者拿到 reject，下一次呼叫會重新 open', async () => {
    fake.throwNextOpen = true;
    const p1 = storage.deleteJobFromDB('job_1');
    await expect(p1).rejects.toThrow('SecurityError');
    expect(fake.opens).toBe(1);
    expect(fake.deletes).toEqual([]);

    const p2 = storage.deleteJobFromDB('job_2');
    await tick();
    expect(fake.opens).toBe(2);
    expect(fake.deletes).toEqual(['job_2']);

    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('open 失敗時呼叫者拿到 reject，下一次呼叫會重新 open', async () => {
    fake.failNextOpen = true;
    const p1 = storage.deleteJobFromDB('job_1');
    await expect(p1).rejects.toThrow('OpenFailed');
    expect(fake.opens).toBe(1);
    expect(fake.deletes).toEqual([]);

    const p2 = storage.deleteJobFromDB('job_2');
    await tick();
    expect(fake.opens).toBe(2);
    expect(fake.deletes).toEqual(['job_2']);

    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('open 被其他分頁擋住時呼叫者拿到 reject，下一次呼叫會重新 open', async () => {
    fake.blockNextOpen = true;
    const p1 = storage.deleteJobFromDB('job_1');
    await expect(p1).rejects.toThrow('其他分頁');
    expect(fake.opens).toBe(1);
    expect(fake.deletes).toEqual([]);

    const p2 = storage.deleteJobFromDB('job_2');
    await tick();
    expect(fake.opens).toBe(2);
    expect(fake.deletes).toEqual(['job_2']);

    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('blocked 之後才來的 onsuccess 不留下沒人關的連線', async () => {
    fake.blockNextOpen = true;
    const p1 = storage.deleteJobFromDB('job_1');
    await expect(p1).rejects.toThrow('其他分頁');

    // 遲到的 onsuccess 在下一個 microtask 才跑
    await tick();
    expect(fake.dbs).toHaveLength(1);
    expect(fake.dbs[0].closed).toBe(true);
  });

  it('交易開到一半連線被關掉（InvalidStateError）時重開連線再試一次，刪除照樣完成', async () => {
    fake.txErrors = [new DOMException('closed', 'InvalidStateError')];
    const p1 = storage.deleteJobFromDB('job_1');

    await tick();
    // 第一次 db.transaction() 就丟錯，重開一條連線後才真的開出交易
    expect(fake.opens).toBe(2);
    expect(fake.txs).toHaveLength(1);
    expect(fake.deletes).toEqual(['job_1']);

    fake.txs[0].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
  });

  it('重開後仍然 InvalidStateError 就往上拋，不會無限重試', async () => {
    fake.txErrors = [
      new DOMException('closed', 'InvalidStateError'),
      new DOMException('closed', 'InvalidStateError')
    ];
    const p1 = storage.deleteJobFromDB('job_1');

    await expect(p1).rejects.toThrow('closed');
    expect(fake.opens).toBe(2);
    expect(fake.txs).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it('重開後第二次也失敗時，那條作廢的連線不留在快取，下一次呼叫直接重開', async () => {
    // 第二次失敗若把新連線留在快取，下一個呼叫者要再走完一輪「失敗→清快取→重開」才會自癒
    fake.txErrors = [
      new DOMException('closed', 'InvalidStateError'),
      new DOMException('closed', 'InvalidStateError')
    ];
    await expect(storage.deleteJobFromDB('job_1')).rejects.toThrow('closed');
    expect(fake.opens).toBe(2);

    // 第二次呼叫：快取已空，第一次 transaction 就該成功，不必再賠一輪
    const p2 = storage.deleteJobFromDB('job_2');
    await tick();
    expect(fake.opens).toBe(3);
    expect(fake.txs).toHaveLength(1);
    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('非 InvalidStateError 的錯誤直接上拋，不重開連線', async () => {
    fake.txErrors = [new DOMException('quota', 'QuotaExceededError')];
    const p1 = storage.deleteJobFromDB('job_1');

    await expect(p1).rejects.toThrow('quota');
    expect(fake.opens).toBe(1);
    expect(fake.deletes).toEqual([]);
  });

  it('重試發生在佇列的那一格裡，不會插隊也不會卡住後面', async () => {
    fake.txErrors = [new DOMException('closed', 'InvalidStateError')];
    const p1 = storage.deleteJobFromDB('job_1');
    const p2 = storage.deleteJobFromDB('job_2');

    await tick();
    // 第一筆在重試，第二筆還沒開始
    expect(fake.deletes).toEqual(['job_1']);
    expect(fake.txs).toHaveLength(1);

    fake.txs[0].oncomplete!();
    await tick();
    expect(fake.deletes).toEqual(['job_1', 'job_2']);

    fake.txs[1].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });
});

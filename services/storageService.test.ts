import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job, JobStatus } from '../types';

// 最小的 IndexedDB 替身：只做 open / transaction / objectStore.put|delete，
// 交易何時 complete 或 error 由測試手動觸發，才能驗證「第二筆在第一筆 oncomplete 之後才開始」。
// open 的次數、close 與 versionchange 也記下來，才能驗證連線是共用的。
type FakeTx = {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: Error | null;
  objectStore: (name: string) => { put: (v: unknown) => void; delete: (k: unknown) => void };
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
  onerror: (() => void) | null;
  result: FakeDB | null;
  error: Error | null;
};

type FakeIDB = {
  puts: unknown[];
  deletes: unknown[];
  txs: FakeTx[];
  dbs: FakeDB[];
  opens: number;
  // 測試把它設 true，下一次 open 就以 onerror 收場
  failNextOpen: boolean;
  // 測試把它設 true，下一次 open 直接同步拋錯（IndexedDB 被停用時的 SecurityError）
  throwNextOpen: boolean;
  open: (name: string, version: number) => FakeRequest;
};

const makeFakeIDB = (): FakeIDB => {
  const fake: FakeIDB = {
    puts: [],
    deletes: [],
    txs: [],
    dbs: [],
    opens: 0,
    failNextOpen: false,
    throwNextOpen: false,
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
          const tx: FakeTx = {
            oncomplete: null,
            onerror: null,
            error: null,
            objectStore: () => ({
              put: (v: unknown) => { fake.puts.push(v); },
              delete: (k: unknown) => { fake.deletes.push(k); }
            })
          };
          fake.txs.push(tx);
          return tx;
        }
      };
      const request: FakeRequest = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db, error: null };
      const shouldFail = fake.failNextOpen;
      fake.failNextOpen = false;
      queueMicrotask(() => {
        if (shouldFail) {
          request.result = null;
          request.error = new Error('OpenFailed');
          if (request.onerror) request.onerror();
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

const makeJob = (id: string): Job => ({
  id,
  fileName: `${id}.wav`,
  fileSize: 1,
  createdAt: 1,
  updatedAt: 1,
  status: JobStatus.PENDING,
  currentStep: 0,
  steps: []
});

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

  it('連續三次寫入照呼叫順序執行，且下一筆在前一筆 oncomplete 之後才開始', async () => {
    const job1 = makeJob('job_1');
    const job2 = makeJob('job_2');
    const job3 = makeJob('job_3');
    const states: string[] = [];

    const p1 = storage.saveJobToDB(job1).then(() => { states.push('p1'); });
    const p2 = storage.saveJobToDB(job2).then(() => { states.push('p2'); });
    const p3 = storage.saveJobToDB(job3).then(() => { states.push('p3'); });

    await tick();
    expect(fake.puts).toEqual([job1]);
    expect(fake.txs).toHaveLength(1);
    expect(states).toEqual([]);

    fake.txs[0].oncomplete!();
    await tick();
    expect(states).toEqual(['p1']);
    expect(fake.puts).toEqual([job1, job2]);
    expect(fake.txs).toHaveLength(2);

    fake.txs[1].oncomplete!();
    await tick();
    expect(states).toEqual(['p1', 'p2']);
    expect(fake.puts).toEqual([job1, job2, job3]);
    expect(fake.txs).toHaveLength(3);

    fake.txs[2].oncomplete!();
    await Promise.all([p1, p2, p3]);
    expect(states).toEqual(['p1', 'p2', 'p3']);
  });

  it('某一筆失敗 reject 給呼叫者，後面那筆照常開始並完成', async () => {
    const job1 = makeJob('job_1');
    const job2 = makeJob('job_2');
    const job3 = makeJob('job_3');

    const p1 = storage.saveJobToDB(job1);
    const p2 = storage.saveJobToDB(job2);
    const p3 = storage.saveJobToDB(job3);
    const p2Rejection = p2.then(() => 'resolved', (e: Error) => e.message);

    await tick();
    fake.txs[0].oncomplete!();
    await tick();
    expect(fake.puts).toEqual([job1, job2]);

    fake.txs[1].error = new Error('QuotaExceededError');
    fake.txs[1].onerror!();
    await tick();
    expect(await p2Rejection).toBe('QuotaExceededError');
    expect(fake.puts).toEqual([job1, job2, job3]);
    expect(fake.txs).toHaveLength(3);

    fake.txs[2].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    await expect(p3).resolves.toBeUndefined();
  });

  it('deleteJobFromDB 與 saveJobToDB 共用同一條佇列，順序等於呼叫順序', async () => {
    const job1 = makeJob('job_1');
    const p1 = storage.saveJobToDB(job1);
    const p2 = storage.deleteJobFromDB('job_1');

    await tick();
    expect(fake.puts).toEqual([job1]);
    expect(fake.deletes).toEqual([]);

    fake.txs[0].oncomplete!();
    await tick();
    expect(fake.deletes).toEqual(['job_1']);

    fake.txs[1].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it('連續三次寫入共用同一條連線，只 open 一次', async () => {
    const p1 = storage.saveJobToDB(makeJob('job_1'));
    const p2 = storage.saveJobToDB(makeJob('job_2'));
    const p3 = storage.saveJobToDB(makeJob('job_3'));

    await tick();
    fake.txs[0].oncomplete!();
    await tick();
    fake.txs[1].oncomplete!();
    await tick();
    fake.txs[2].oncomplete!();
    await Promise.all([p1, p2, p3]);

    expect(fake.opens).toBe(1);
  });

  it('收到 versionchange 就關掉連線，下一次寫入重新 open', async () => {
    const p1 = storage.saveJobToDB(makeJob('job_1'));
    await tick();
    fake.txs[0].oncomplete!();
    await expect(p1).resolves.toBeUndefined();
    expect(fake.opens).toBe(1);

    const db = fake.dbs[0];
    db.onversionchange!();
    expect(db.closed).toBe(true);

    const p2 = storage.saveJobToDB(makeJob('job_2'));
    await tick();
    expect(fake.opens).toBe(2);

    fake.txs[1].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('open 同步拋錯時呼叫者拿到 reject，下一次呼叫會重新 open', async () => {
    fake.throwNextOpen = true;
    const p1 = storage.saveJobToDB(makeJob('job_1'));
    await expect(p1).rejects.toThrow('SecurityError');
    expect(fake.opens).toBe(1);
    expect(fake.puts).toEqual([]);

    const job2 = makeJob('job_2');
    const p2 = storage.saveJobToDB(job2);
    await tick();
    expect(fake.opens).toBe(2);
    expect(fake.puts).toEqual([job2]);

    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });

  it('open 失敗時呼叫者拿到 reject，下一次呼叫會重新 open', async () => {
    fake.failNextOpen = true;
    const p1 = storage.saveJobToDB(makeJob('job_1'));
    await expect(p1).rejects.toThrow('OpenFailed');
    expect(fake.opens).toBe(1);
    expect(fake.puts).toEqual([]);

    const job2 = makeJob('job_2');
    const p2 = storage.saveJobToDB(job2);
    await tick();
    expect(fake.opens).toBe(2);
    expect(fake.puts).toEqual([job2]);

    fake.txs[0].oncomplete!();
    await expect(p2).resolves.toBeUndefined();
  });
});

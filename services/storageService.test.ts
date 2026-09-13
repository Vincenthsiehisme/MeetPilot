import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveJobToDB, deleteJobFromDB } from './storageService';
import { Job, JobStatus } from '../types';

// 最小的 IndexedDB 替身：只做 open / transaction / objectStore.put|delete，
// 交易何時 complete 或 error 由測試手動觸發，才能驗證「第二筆在第一筆 oncomplete 之後才開始」。
type FakeTx = {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: Error | null;
  objectStore: (name: string) => { put: (v: unknown) => void; delete: (k: unknown) => void };
};

type FakeIDB = {
  puts: unknown[];
  deletes: unknown[];
  txs: FakeTx[];
  open: (name: string, version: number) => {
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    result: unknown;
    error: Error | null;
  };
};

const makeFakeIDB = (): FakeIDB => {
  const fake: FakeIDB = {
    puts: [],
    deletes: [],
    txs: [],
    open: () => {
      const db = {
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
      const request = { onupgradeneeded: null, onsuccess: null as (() => void) | null, onerror: null, result: db, error: null };
      queueMicrotask(() => { if (request.onsuccess) request.onsuccess(); });
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

  beforeEach(() => {
    fake = makeFakeIDB();
    vi.stubGlobal('indexedDB', fake);
  });

  it('連續三次寫入照呼叫順序執行，且下一筆在前一筆 oncomplete 之後才開始', async () => {
    const job1 = makeJob('job_1');
    const job2 = makeJob('job_2');
    const job3 = makeJob('job_3');
    const states: string[] = [];

    const p1 = saveJobToDB(job1).then(() => { states.push('p1'); });
    const p2 = saveJobToDB(job2).then(() => { states.push('p2'); });
    const p3 = saveJobToDB(job3).then(() => { states.push('p3'); });

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

    const p1 = saveJobToDB(job1);
    const p2 = saveJobToDB(job2);
    const p3 = saveJobToDB(job3);
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
    const p1 = saveJobToDB(job1);
    const p2 = deleteJobFromDB('job_1');

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
});


import { Job } from "../types";

const DB_NAME = "WhisperXHub";
const DB_VERSION = 1;
const STORE_JOBS = "jobs";
const STORE_FILES = "files";

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// jobs store 的序列化寫入佇列：同一時間只有一筆交易在飛，後來的照呼叫順序排隊。
// 任一筆失敗只 reject 給它自己的呼叫者，鏈本身吞掉結果繼續往下，後面的不會永遠卡住。
let jobWriteChain: Promise<void> = Promise.resolve();

const enqueueJobWrite = <T>(task: () => Promise<T>): Promise<T> => {
  const run = jobWriteChain.then(task);
  jobWriteChain = run.then(() => undefined, () => undefined);
  return run;
};

const putJob = async (job: Job): Promise<void> => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    tx.objectStore(STORE_JOBS).put(job);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const deleteJob = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    tx.objectStore(STORE_JOBS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const saveJobToDB = (job: Job): Promise<void> => enqueueJobWrite(() => putJob(job));

export const deleteJobFromDB = (id: string): Promise<void> => enqueueJobWrite(() => deleteJob(id));

export const getAllJobsFromDB = async (): Promise<Job[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readonly");
    const request = tx.objectStore(STORE_JOBS).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveFileBlob = async (id: string, blob: Blob) => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getFileBlob = async (id: string): Promise<Blob | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const request = tx.objectStore(STORE_FILES).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

export const deleteFileBlob = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getAllFileIds = async (): Promise<string[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const request = tx.objectStore(STORE_FILES).getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
};


import { Job } from "../types";

const DB_NAME = "WhisperXHub";
const DB_VERSION = 1;
const STORE_JOBS = "jobs";
const STORE_FILES = "files";

// 共用一條連線：原本每個操作各開一條且從不關，一個長時間跑的分頁會一路累積連線。
// 這裡快取整個 promise，連線還在開的時候進來的呼叫也共用同一條，不會開出第二條。
let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    // 只清掉自己這條：連線已經被換成新的時，不能把新的那條一起清掉
    const dropCache = () => { if (dbPromise === opening) dbPromise = null; };

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 其他分頁要升級 schema 時會發 versionchange，這條連線不關就會把對方擋在 blocked，
      // 所以收到就主動關掉並清快取，下一次操作重開一條。
      db.onversionchange = () => {
        db.close();
        dropCache();
      };
      // 連線被瀏覽器強制關閉（例如儲存空間被清掉）時，快取裡那條已經不能用了
      db.onclose = () => { dropCache(); };
      resolve(db);
    };
    request.onerror = () => {
      // 失敗的 promise 留在快取會讓之後每次操作都拿到同一個錯誤，這裡清掉讓下一次重開
      dropCache();
      reject(request.error);
    };
  });

  dbPromise = opening;
  return opening;
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

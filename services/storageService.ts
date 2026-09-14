
import { Job } from "../types";

const DB_NAME = "WhisperXHub";
const DB_VERSION = 1;
const STORE_JOBS = "jobs";
const STORE_FILES = "files";

// 共用一條連線：原本每個操作各開一條且從不關，一個長時間跑的分頁會一路累積連線。
// 這裡快取整個 promise，連線還在開的時候進來的呼叫也共用同一條，不會開出第二條。
let dbPromise: Promise<IDBDatabase> | null = null;

// 只清掉自己這條：連線已經被換成新的時，不能把新的那條一起清掉
const dropCache = (opening: Promise<IDBDatabase>) => {
  if (dbPromise === opening) dbPromise = null;
};

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // onblocked 之後這個 request 仍然可能 onsuccess（其他分頁關掉時），那時 promise 已經 settled，
    // resolve 是 no-op，開出來的連線就沒人關。三個 handler 都先看這面旗標：先到的那個負責 settle，
    // 晚到的 onsuccess 負責把多出來的連線關掉。
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // 其他分頁要升級 schema 時會發 versionchange，這條連線不關就會把對方擋在 blocked，
      // 所以收到就主動關掉並清快取，下一次操作重開一條。
      db.onversionchange = () => {
        db.close();
        dropCache(opening);
      };
      // 連線被瀏覽器強制關閉（例如儲存空間被清掉）時，快取裡那條已經不能用了
      db.onclose = () => { dropCache(opening); };
      resolve(db);
    };
    // 其他分頁還壓著舊版本的連線時 open 會停在 blocked，不給任何回呼就是無限期 pending：
    // 快取住的這條 promise 會讓之後每個 storage 呼叫都 await 在上面，畫面一點錯誤都看不到。
    // 寧可明確失敗，讓呼叫端有東西可以顯示。
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      dropCache(opening);
      reject(new Error("IndexedDB 被其他分頁擋住（blocked）：其他分頁還開著舊版本的資料庫，請關掉其他 MeetPilot 分頁後重新整理"));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error);
    };
  });

  dbPromise = opening;
  // 失敗就清快取統一在 promise 這層做，不放在 request.onerror：indexedDB.open() 本身也可能同步拋錯
  // （IndexedDB 被停用時的 SecurityError、indexedDB 是 undefined 的 TypeError），那種情況 executor
  // 直接 reject，根本走不到 onerror。失敗的 promise 留在快取會讓之後每次操作都拿到同一個錯誤，
  // 重新整理前都不會再試。
  opening.catch(() => dropCache(opening));
  return opening;
};

// versionchange 把連線關掉後，已經拿到舊連線但還沒開交易的操作會在 db.transaction() 丟
// InvalidStateError。那筆資料沒寫進去也沒人重試就這樣掉了。
const isClosedConnectionError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "InvalidStateError";

// 所有 store 操作都走這裡：連線作廢就重開一條再跑一次。
// 只重試一次：連線作廢是一次性事件（versionchange 關掉舊連線，重開就拿到新的），
// 無限重試只會把真正的錯誤變成迴圈。第二次還是同樣的錯就往上拋。
const withConnection = async <T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> => {
  const opening = openDB();
  const db = await opening;
  try {
    return await run(db);
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    dropCache(opening);
    // 重開一條再跑一次。第二次若還是連線作廢，那條也不能留在快取裡，
    // 否則下一個呼叫者要再走完一輪「失敗→清快取→重開」才會自癒。
    const retryOpening = openDB();
    try {
      return await run(await retryOpening);
    } catch (retryErr) {
      if (isClosedConnectionError(retryErr)) dropCache(retryOpening);
      throw retryErr;
    }
  }
};

// jobs store 的序列化寫入佇列：同一時間只有一筆交易在飛，後來的照呼叫順序排隊。
// 任一筆失敗只 reject 給它自己的呼叫者，鏈本身吞掉結果繼續往下，後面的不會永遠卡住。
let jobWriteChain: Promise<void> = Promise.resolve();

const enqueueJobWrite = <T>(task: () => Promise<T>): Promise<T> => {
  const run = jobWriteChain.then(task);
  jobWriteChain = run.then(() => undefined, () => undefined);
  return run;
};

const putJob = (job: Job): Promise<void> =>
  withConnection(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    tx.objectStore(STORE_JOBS).put(job);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));

const deleteJob = (id: string): Promise<void> =>
  withConnection(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readwrite");
    tx.objectStore(STORE_JOBS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));

export const saveJobToDB = (job: Job): Promise<void> => enqueueJobWrite(() => putJob(job));

export const deleteJobFromDB = (id: string): Promise<void> => enqueueJobWrite(() => deleteJob(id));

export const getAllJobsFromDB = (): Promise<Job[]> =>
  withConnection(db => new Promise<Job[]>((resolve, reject) => {
    const tx = db.transaction(STORE_JOBS, "readonly");
    const request = tx.objectStore(STORE_JOBS).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));

export const saveFileBlob = (id: string, blob: Blob): Promise<void> =>
  withConnection(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));

export const getFileBlob = (id: string): Promise<Blob | null> =>
  withConnection(db => new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const request = tx.objectStore(STORE_FILES).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));

export const deleteFileBlob = (id: string): Promise<void> =>
  withConnection(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    tx.objectStore(STORE_FILES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));

export const getAllFileIds = (): Promise<string[]> =>
  withConnection(db => new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const request = tx.objectStore(STORE_FILES).getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  }));

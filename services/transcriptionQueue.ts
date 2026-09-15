/**
 * server 端的轉錄佇列（W2 T1）。
 *
 * 為什麼獨立一個檔而不是併進 transcriptionPipeline：pipeline 是「一場會怎麼跑完」，
 * 佇列是「同時間只准跑一場」。兩者的測試要問的問題不一樣——pipeline 要驗狀態與續傳，
 * 佇列要驗併發與順序——混在一起之後，想測併發就得準備一整套假的 store 與 Gemini。
 *
 * 一次只跑一場是刻意的：一片 10 分鐘的 16kHz WAV 約 19MB，同時跑兩場會同時佔住兩份，
 * 而且會同時打 Gemini，撞到限流時兩場一起退。單人自用，序列就夠。
 */

export interface TranscriptionQueue {
  /** 已經在排隊或正在跑的同一場會不重複入列 */
  enqueue(meetingId: string): void;
  /**
   * 這場會在不在佇列裡（排隊中或正在跑）。
   *
   * 給上傳用：狀態停在 CREATED 不代表沒人要處理它——retry 之後佇列正忙、或重啟掃描一次入列
   * 好幾場時，那些會都是 CREATED 而音檔已經在 server 上。這時收新音檔會在
   * pipeline 讀第 N 片與第 N+1 片之間把檔案換掉，前幾片來自舊音檔、後幾片來自新音檔，
   * 合併成一份逐字稿而且沒有任何錯誤。
   */
  has(meetingId: string): boolean;

  /**
   * 把還在排隊的那場會移出佇列，回傳有沒有真的移掉。
   *
   * 給刪除用：刪掉一場排隊中的會之後，佇列輪到它只會印「找不到 Meeting」，
   * 資料沒壞，但那行 log 看起來像系統出錯，之後查真的故障時會被它干擾。
   * 正在跑的那場取消不了（回 false）——那個狀態外面已經擋在 409，不用在這裡重複防。
   */
  cancel(meetingId: string): boolean;
  /** 還在排隊的場次（不含正在跑的那一場） */
  readonly pending: number;
  readonly running: string | null;
  /** 測試用：等到佇列清空。正式流程不需要等 */
  whenIdle(): Promise<void>;
}

export function createTranscriptionQueue(
  run: (meetingId: string) => Promise<void>,
  onError: (meetingId: string, err: unknown) => void = (meetingId, err) => {
    // 失敗的狀態已經由 pipeline 寫進資料庫了，這裡只負責讓它在 server log 上看得見。
    // 不往上拋：入列端是 HTTP 路由，那時請求早就回完了，拋出去只會變成 unhandled rejection
    console.error(`[Transcription Queue] Meeting ${meetingId} 處理失敗：`, err);
  },
): TranscriptionQueue {
  const queued: string[] = [];
  let running: string | null = null;
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queued.length > 0) {
      const meetingId = queued.shift() as string;
      running = meetingId;
      try {
        await run(meetingId);
      } catch (err) {
        onError(meetingId, err);
      } finally {
        running = null;
      }
    }
    draining = null;
  };

  return {
    enqueue(meetingId: string): void {
      if (running === meetingId || queued.includes(meetingId)) return;
      queued.push(meetingId);
      if (!draining) draining = drain();
    },
    has(meetingId: string): boolean {
      return running === meetingId || queued.includes(meetingId);
    },
    cancel(meetingId: string): boolean {
      const index = queued.indexOf(meetingId);
      if (index === -1) return false;
      queued.splice(index, 1);
      return true;
    },
    get pending() {
      return queued.length;
    },
    get running() {
      return running;
    },
    whenIdle(): Promise<void> {
      return draining ?? Promise.resolve();
    },
  };
}

/**
 * 人工編輯寫回 server 的兩道順序保證（App.tsx 與 SummaryView 用）。
 *
 * 會議記錄與逐字稿的 PATCH 都是送整份快照。原本 SummaryView 每打一個字就送一次，而且快照是用
 * 還沒刷新的 prop 組的：受控的 textarea 在刷新回來前被 React 還原成舊值，下一個字就接在舊值後面。
 * 2026-09-24 在隔離 server 上逐鍵打 26 個字母，26 支 PATCH 同時在路上，最後 server 只多了最後一個字，
 * 第 49 個請求開始吃 429（web 版限流每分鐘 60 次，每個字是 PATCH 加兩支 GET）。
 *
 * 修法分兩半，這裡是可以脫離 React 測的那兩半：
 * - createSaveQueue：同一個 App 的寫回一次一個、照送出的順序寫。
 * - createDraftSync：SummaryView 的本地草稿什麼時候可以拿 server 的版本蓋掉。
 * 詳情回應的新舊判斷在 meetingAdapter.ts 的 createLatestRequestGate。
 */

export interface SaveQueue {
  /** 等前面排的都結束才跑 task。回傳的 promise 跟 task 自己的結果一樣，失敗照樣拒絕給呼叫端 */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * 兩次存檔同時在路上時，server 收到的順序不保證等於送出的順序。較舊的快照晚到，就會蓋掉較新的
 * 文字，或把剛刪掉的項目寫回來，而兩次都回 200。排成一次一個，後送的一定後寫。
 *
 * 前一個失敗不擋後一個：後一個是較新的整份快照，本來就包含前一個想存的內容。
 * 鏈尾接住拒絕只是為了讓下一個照樣排得上，錯誤仍由 run 回傳的那個 promise 交給呼叫端。
 */
export const createSaveQueue = (): SaveQueue => {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
};

export interface DraftSync {
  /** 草稿有了還沒送出的修改 */
  edited(): void;
  /** 把目前的草稿送出去存 */
  saveStarted(): void;
  /** 一次存檔結束。saved 為 false 代表沒存進去（錯誤已經由呼叫端講給使用者），草稿要留著等下一次送 */
  saveSettled(saved: boolean): void;
  /** 草稿有沒有還沒送出（或送了沒存進去）的修改 */
  hasUnsent(): boolean;
  /** 現在拿 server 的版本蓋掉草稿安不安全 */
  canAdoptServer(): boolean;
}

/**
 * 草稿什麼時候可以被 server 的版本蓋掉。
 *
 * 有還沒送出的修改時不行：蓋下去使用者正在打的字就不見了。
 * 有存檔還在路上時也不行：這段期間回來的詳情可能是存檔之前的那份，套上去畫面會退回舊文字，
 * 使用者接著編輯的話，舊文字會連同新修改一起被存回 server。
 * 存檔結束之後不主動重套：那一刻手上的 prop 不保證比草稿新（重拉的回應可能因為有更新的請求而被丟掉），
 * 等下一份詳情真的套上來再換。
 */
export const createDraftSync = (): DraftSync => {
  let unsent = false;
  let inFlight = 0;
  return {
    edited: () => {
      unsent = true;
    },
    saveStarted: () => {
      unsent = false;
      inFlight += 1;
    },
    saveSettled: (saved: boolean) => {
      if (inFlight === 0) throw new Error('saveSettled 比 saveStarted 多呼叫了一次');
      inFlight -= 1;
      if (!saved) unsent = true;
    },
    hasUnsent: () => unsent,
    canAdoptServer: () => !unsent && inFlight === 0,
  };
};

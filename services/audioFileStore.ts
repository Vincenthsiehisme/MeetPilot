/**
 * 上傳音檔在 server 上的落腳處（W2 T1）。
 *
 * 檔案跟 Meeting 一對一，檔名只由 meeting_id 決定：server 重啟後的續傳掃描要能只憑
 * meeting_id 判斷「音檔還在不在」，檔名若帶上傳時的原始檔名，就得先查資料庫才找得到檔案，
 * 而那份對應關係一旦對不上，音檔會變成誰也找不到的孤兒。
 *
 * 音檔只在「分析成功」之後才刪（SDD 1.4）。轉錄或分析失敗時留著，重跑才有東西可跑。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_AUDIO_DIR = 'data/audio';

export const resolveAudioDir = (env: NodeJS.ProcessEnv): string =>
  resolve((env.MEETPILOT_AUDIO_DIR ?? '').trim() || DEFAULT_AUDIO_DIR);

// meeting_id 會直接變成檔名的一部分。原生建立的是 UUID、搬過來的是 `job_<timestamp>`，
// 都落在這個字集裡；不合的一律拋錯，不做消毒後照用——消毒過的名字會讓兩個不同的
// meeting_id 對到同一個檔案，那是最難查的一種資料互蓋
const SAFE_MEETING_ID = /^[A-Za-z0-9_-]+$/;

export interface SavedAudio {
  path: string;
  bytes: number;
}

export function createAudioFileStore(dir: string) {
  mkdirSync(dir, { recursive: true });

  const pathFor = (meetingId: string): string => {
    if (!SAFE_MEETING_ID.test(meetingId)) {
      throw new Error(`meeting_id ${JSON.stringify(meetingId)} 不能當成檔名（只允許英數、底線與連字號）`);
    }
    return join(dir, `${meetingId}.audio`);
  };

  return {
    dir,
    pathFor,

    exists: (meetingId: string): boolean => existsSync(pathFor(meetingId)),

    sizeOf: (meetingId: string): number => statSync(pathFor(meetingId)).size,

    /**
     * 把上傳的位元組流寫進檔案。
     *
     * 先寫 `.part` 再改名：中途斷線或 server 掛掉時，半個檔案若直接叫最終檔名，
     * 重啟後的續傳掃描會判定「音檔還在」而把截斷的檔案送去轉錄，
     * 轉出來的東西看起來像一場提早結束的會，不像一次失敗的上傳。
     *
     * `.part` 的名字每次唯一，不是固定的 `<id>.audio.part`：固定名會讓同一場會的兩個並行上傳
     * 寫進同一個檔案。實測過的壞法是後到的先 rename，先到的 fd 繼續把資料寫進已經改名的最終音檔，
     * 最後那個檔是兩次上傳混出來的，而且成功的那一邊沒有任何錯誤。
     * 路由那層還有一道 in-flight 的鎖，這裡是第二道：鎖只在單一 process 內有效。
     */
    saveFrom: async (meetingId: string, source: Readable): Promise<SavedAudio> => {
      const finalPath = pathFor(meetingId);
      const partPath = `${finalPath}.${randomUUID()}.part`;
      let bytes: number;
      try {
        await pipeline(source, createWriteStream(partPath));
        // statSync 也要在 try 裡面：它自己可能拋（檔案被別人搬走），在外面的話 .part 不會被清掉
        bytes = statSync(partPath).size;
        renameSync(partPath, finalPath);
      } catch (err) {
        rmSync(partPath, { force: true });
        throw err;
      }
      return { path: finalPath, bytes };
    },

    /**
     * 清掉沒寫完的上傳（`.audio.part`）。server 啟動時跑一次。
     *
     * 上傳中斷或 server 掛掉時 saveFrom 的 catch 來不及跑，`.part` 就會留在目錄裡，
     * 而它不會被任何一條路徑刪掉——`remove()` 刪的是最終檔名，續傳掃描也只看最終檔名。
     * 不清的話那些半個音檔會一直佔著空間，而且沒有人看得出來它們屬於哪一次失敗的上傳。
     * 有對應 Meeting 的也照清：那次上傳沒完成，檔案本來就不完整。
     */
    removePartialUploads: (): string[] => {
      const removed: string[] = [];
      for (const name of readdirSync(dir)) {
        // 比對只看 .part 結尾：中間那段是每次上傳的唯一碼，寫死 `.audio.part` 會一個都對不到
        if (!name.endsWith('.part')) continue;
        const target = join(dir, name);
        rmSync(target, { force: true });
        removed.push(target);
      }
      return removed;
    },

    /** 刪掉音檔。已經不在就當作已完成，不拋錯：呼叫端要的是「之後不會再佔著空間」 */
    remove: (meetingId: string): void => {
      rmSync(pathFor(meetingId), { force: true });
    },
  };
}

export type AudioFileStore = ReturnType<typeof createAudioFileStore>;

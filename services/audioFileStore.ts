/**
 * 上傳音檔在 server 上的落腳處（W2 T1）。
 *
 * 檔案跟 Meeting 一對一，檔名只由 meeting_id 決定：server 重啟後的續傳掃描要能只憑
 * meeting_id 判斷「音檔還在不在」，檔名若帶上傳時的原始檔名，就得先查資料庫才找得到檔案，
 * 而那份對應關係一旦對不上，音檔會變成誰也找不到的孤兒。
 *
 * 音檔只在「分析成功」之後才刪（SDD 1.4）。轉錄或分析失敗時留著，重跑才有東西可跑。
 */
import {
  closeSync, createWriteStream, existsSync, fsyncSync, ftruncateSync, fstatSync, mkdirSync, openSync, readdirSync,
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
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

/** tempPathFor 的結尾。不帶點，理由見 tempPathFor */
const EXTERNAL_TEMP_SUFFIX = '_part';

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

  const recordingPathFor = (meetingId: string): string => {
    pathFor(meetingId); // 同一條檔名規則：不合法的 meeting_id 在這裡就拋錯
    return join(dir, `${meetingId}.recording`);
  };

  return {
    dir,
    pathFor,

    exists: (meetingId: string): boolean => existsSync(pathFor(meetingId)),

    /**
     * 給外部程式先寫進來的暫存路徑（語音備忘錄的取檔捷徑用它當 `--output-path`）。
     *
     * **整個檔名不能有點**，所以不沿用 saveFrom 的 `.part`：`shortcuts run --output-path` 會照副檔名
     * 轉換輸出，遇到不認得的副檔名（`.part`、`.voicememo-xxx`）就結束碼 0、什麼都不寫；沒有副檔名或
     * `.m4a` 才寫得出來（2026-09-23 實測）。寫死 `.m4a` 的話，語音備忘錄哪天改存別的格式又會安靜失敗，
     * 所以用沒有副檔名的 `_part` 結尾，removePartialUploads 一起認得它，server 掛掉留下的也會被清。
     * 呼叫端用完要自己刪。
     */
    tempPathFor: (meetingId: string): string => {
      pathFor(meetingId); // 同一條檔名規則：不合法的 meeting_id 在這裡就拋錯
      return join(dir, `${meetingId}_${randomUUID()}${EXTERNAL_TEMP_SUFFIX}`);
    },

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
        // 比對只看結尾：中間那段是每次上傳的唯一碼，寫死 `.audio.part` 會一個都對不到。
        // `_part` 是 tempPathFor 給外部程式（語音備忘錄取檔捷徑）用的暫存名，理由見那支的說明
        if (!name.endsWith('.part') && !name.endsWith(EXTERNAL_TEMP_SUFFIX)) continue;
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

    // ---- 桌面 app 自己錄音的分段（vault plan「MeetPilot · 跨平台打包部署」E4） ----
    //
    // 錄音中的檔叫 `<id>.recording`，不是 `.part`：removePartialUploads 會在 server 啟動時清掉 `.part`，
    // 而錄到一半 server 重啟時，已經送到的段落正是要留下來的東西（停止或「送出已錄的部分」時才轉成音檔）。

    recordingPathFor,

    /**
     * 把一段錄音接在 `<id>.recording` 後面，寫到磁碟才回傳新的總長度。
     *
     * `committedBytes` 是資料庫記的「已經確定收到」的長度。檔案比它長代表上一次寫完檔、還沒記進資料庫就斷了
     * （server 掛掉、請求中斷），那一段前端會重送，所以先截回 committedBytes 再寫，不然同一段會出現兩次。
     * 檔案比它短代表已經收到的段落不見了（被刪掉、磁碟出錯），接下去寫只會得到一個缺了中間的檔，直接拋錯。
     * 第 0 段（committedBytes 是 0）才准建新檔。
     */
    appendRecordingChunk: (meetingId: string, committedBytes: number, data: Buffer): number => {
      const target = recordingPathFor(meetingId);
      if (committedBytes > 0 && !existsSync(target)) {
        throw new Error(`Meeting ${meetingId} 的錄音檔不見了（已經收到 ${committedBytes} bytes），接不下去`);
      }
      const fd = openSync(target, committedBytes === 0 ? 'w' : 'r+');
      try {
        const size = fstatSync(fd).size;
        if (size < committedBytes) {
          throw new Error(`Meeting ${meetingId} 的錄音檔只有 ${size} bytes，比已經收到的 ${committedBytes} bytes 短，接不下去`);
        }
        if (size > committedBytes) ftruncateSync(fd, committedBytes);
        let written = 0;
        while (written < data.length) {
          written += writeSync(fd, data, written, data.length - written, committedBytes + written);
        }
        // 回應送出去之前要真的在磁碟上：前端收到 200 就會丟掉這段，斷電時留在快取裡的就沒了
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return committedBytes + data.length;
    },

    /**
     * 錄音結束：`<id>.recording` 截到 committedBytes 後改名成這場會的音檔。
     *
     * 截的理由同 appendRecordingChunk：比資料庫記的長，多出來的是沒有確認收到的半段。
     * 比它短就拋錯，不把缺了一截的檔當成完整錄音送去轉錄。
     *
     * 可以重跑：上一次改名成功、之後更新資料庫之前就斷了的話，`<id>.recording` 已經不在、音檔在而且長度對，
     * 這次就直接用它，不然這場會會永遠停在錄音中、每次收尾都說錄音檔不見了（Codex review）
     */
    promoteRecording: (meetingId: string, committedBytes: number): SavedAudio => {
      const finalPath = pathFor(meetingId);
      const source = recordingPathFor(meetingId);
      if (!existsSync(source)) {
        if (existsSync(finalPath) && statSync(finalPath).size === committedBytes) return { path: finalPath, bytes: committedBytes };
        throw new Error(`Meeting ${meetingId} 的錄音檔不見了（應該有 ${committedBytes} bytes）`);
      }
      const size = statSync(source).size;
      if (size < committedBytes) {
        throw new Error(`Meeting ${meetingId} 的錄音檔只有 ${size} bytes，比已經收到的 ${committedBytes} bytes 短`);
      }
      if (size > committedBytes) {
        const fd = openSync(source, 'r+');
        try {
          ftruncateSync(fd, committedBytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      renameSync(source, finalPath);
      return { path: finalPath, bytes: committedBytes };
    },

    /** 刪掉錄音中的檔（刪除會議時）。不在就當作已完成，理由同 remove */
    removeRecording: (meetingId: string): void => {
      rmSync(recordingPathFor(meetingId), { force: true });
    },
  };
}

export type AudioFileStore = ReturnType<typeof createAudioFileStore>;

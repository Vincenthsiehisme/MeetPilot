/**
 * 叫本機的語音備忘錄錄音（vault plan「MeetPilot · 網頁錄音」路線 D）。
 *
 * 為什麼不在瀏覽器用 MediaRecorder 自己錄：錄音交給原生 App，分頁關掉、重整或 server 重啟都不會
 * 中斷，而瀏覽器自己錄的話這三種情況都要另外寫分段上傳與中斷復原。使用者本來就用語音備忘錄錄會
 * （本機 DB 的檔名都是「新錄音 N.m4a」），m4a 也本來就走得完現行的切片流程。
 *
 * 語音備忘錄沒有 AppleScript、沒有 URL scheme，只有給「捷徑」App 用的動作（開始錄、停止錄），
 * 而且沒有任何動作會交出錄音檔。所以三件事都經使用者自己建的三個捷徑，用 `shortcuts run` 呼叫：
 * - 開始／停止：捷徑裡各放一個語音備忘錄的動作
 * - 取檔：捷徑去讀語音備忘錄的錄音資料夾，挑最新的一支交出來，`--output-path` 寫到我們指定的路徑
 *
 * 取檔一定要經捷徑：那個資料夾受 macOS 權限保護，server 行程直接讀會回 `Operation not permitted`；
 * 資料夾授權是捷徑 App 拿的，server 不需要「完全取用磁碟」權限（2026-09-23 實測，見 vault plan〈決策〉）。
 *
 * 這條路只在 server 跟語音備忘錄在同一台 Mac 上才成立，而且捷徑動作與資料夾位置都不是 Apple
 * 承諾的介面，macOS 升級可能讓它壞掉。所以每一步失敗都要講出是哪一個捷徑、怎麼修，不能壞得安靜。
 *
 * 執行檔一律經注入的 `CommandRunner`（跟 audioSlicer.ts 同一個型別）：測試不用真的錄音。
 */
import { existsSync, statSync } from 'node:fs';
import { CommandResult, CommandRunner, spawnCommandRunner } from './audioSlicer';

/** 三個捷徑的名稱。使用者在「捷徑」App 照這三個名字建，做法在 README〈用語音備忘錄錄音〉 */
export const VOICE_MEMO_SHORTCUTS = {
  start: 'MeetPilot 開始錄音',
  stop: 'MeetPilot 停止錄音',
  fetch: 'MeetPilot 取檔',
} as const;

/**
 * 每一種呼叫的逾時上限（毫秒）。
 *
 * 2026-09-23 實測 `shortcuts run` 會間歇性卡住不回來：19:07～19:15 連三次（一次 26 秒後才被派出去
 * 又被取消、兩次連 log 都沒有），19:17 又正常；正常時停止 0.3 秒、取檔 0.2 秒（2.5 MB 的 5 分鐘錄音）。
 * 不設上限的話，停止請求會永遠掛著，而 createApp 的 recorderBusy 會把整台 server 的錄音操作鎖到重啟。
 *
 * 數字是我判的，比正常耗時寬兩個數量級：取檔會被 createApp 重試最多 4 次，所以它的上限最短，
 * 最壞情況約一分鐘就放棄並退回「等待音檔」。
 */
export const RECORDER_TIMEOUTS_MS = {
  list: 10_000,
  start: 20_000,
  stop: 20_000,
  fetch: 15_000,
  probe: 30_000,
} as const;

export type RecorderTimeouts = { [K in keyof typeof RECORDER_TIMEOUTS_MS]: number };

/** 逾時的錯誤。呼叫端（例如開始錄音）要靠它判斷「結果不明」，跟「確定失敗」分開講 */
export class RecorderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderTimeoutError';
  }
}

export type RecorderAvailability =
  | { available: true }
  | { available: false; reason: string };

/** 取回的那支檔案自己說它多長、什麼時候建立的 */
export interface RecordingInfo {
  durationSeconds: number;
  /** m4a 的 `creation_time` 標籤（epoch ms）。檔案沒帶就是 null，由 checkFetchedRecording 擋下 */
  creationTimeMs: number | null;
}

/**
 * 判斷「取回的是不是這場會的錄音」的容許範圍（AC-3）。
 *
 * 2026-09-23 實測一支 10 秒的錄音：15:16:08 下開始、15:16:19 下停止（相差約 11 秒），
 * 檔案長度 10.28 秒，creation_time 是 15:16:09，比開始晚 1 秒。所以：
 * - 檔案一定比「開始到停止」短一點（捷徑啟動要時間），短多少由 maxStartDelaySeconds 管。
 *   10 秒是我判的，100 分鐘的會延遲會不會變大沒量過，AC-8 那場真實錄音時校正
 * - 檔案不可能比經過時間長，maxOverrunSeconds 只吸收秒級時間戳的捨去誤差
 * - creation_time 只到秒，前後各給 creationSlackMs 吸收捨去誤差
 *
 * 這三條要擋的主要是「最新一支不是這場會的」：iPhone 在會議期間錄的東西經 iCloud 同步進同一個
 * 資料夾，或捷徑的過濾條件設錯，都會讓「最新一支」變成別的檔。
 */
export const RECORDING_CHECK = {
  maxStartDelaySeconds: 10,
  maxOverrunSeconds: 3,
  creationSlackMs: 2000,
} as const;

export type RecordingCheck = { ok: true } | { ok: false; reason: string };

const formatClock = (ms: number): string => new Date(ms).toLocaleString('zh-TW', { hour12: false });

/**
 * 取回的檔案對不對得上這場會的開始與停止時間。純函式，測試直接釘住三條規則。
 *
 * 對不上一律拒收，不猜「應該就是它吧」：收錯的後果是把另一支錄音轉成這場會的記錄，
 * 而且整條轉錄與分析跑完之前沒有任何地方看得出來。
 */
export const checkFetchedRecording = (
  info: RecordingInfo,
  recording: { startedAt: number; stoppedAt: number },
): RecordingCheck => {
  const elapsedSeconds = (recording.stoppedAt - recording.startedAt) / 1000;

  if (info.creationTimeMs === null) {
    return {
      ok: false,
      reason: '取回的檔案沒有建立時間（creation_time），無法確認它是這場會的錄音。'
        + `請檢查「${VOICE_MEMO_SHORTCUTS.fetch}」捷徑交出的是不是語音備忘錄的錄音檔`,
    };
  }
  if (info.creationTimeMs < recording.startedAt - RECORDING_CHECK.creationSlackMs
    || info.creationTimeMs > recording.stoppedAt + RECORDING_CHECK.creationSlackMs) {
    return {
      ok: false,
      reason: `取回的檔案建立於 ${formatClock(info.creationTimeMs)}，不在這場會的錄音期間`
        + `（${formatClock(recording.startedAt)} 到 ${formatClock(recording.stoppedAt)}）。`
        + '最新的一支可能是別的錄音（例如 iPhone 經 iCloud 同步進來的），這次沒有送出',
    };
  }
  if (info.durationSeconds > elapsedSeconds + RECORDING_CHECK.maxOverrunSeconds) {
    return {
      ok: false,
      reason: `取回的檔案長 ${info.durationSeconds.toFixed(1)} 秒，比這場會實際錄的 `
        + `${elapsedSeconds.toFixed(1)} 秒還長，不是這場會的錄音，這次沒有送出`,
    };
  }
  if (elapsedSeconds - info.durationSeconds > RECORDING_CHECK.maxStartDelaySeconds) {
    return {
      ok: false,
      reason: `取回的檔案只有 ${info.durationSeconds.toFixed(1)} 秒，這場會錄了 ${elapsedSeconds.toFixed(1)} 秒，`
        + `差了 ${(elapsedSeconds - info.durationSeconds).toFixed(1)} 秒（容許 ${RECORDING_CHECK.maxStartDelaySeconds} 秒）。`
        + '可能中途停過、錄到的不是這一支，或語音備忘錄還沒把檔案寫完，這次沒有送出',
    };
  }
  return { ok: true };
};

export interface VoiceMemoRecorderOptions {
  /** 預設 `shortcuts`（macOS 內建的 /usr/bin/shortcuts） */
  shortcutsPath: string;
  ffprobePath: string;
  /** 注入 process.platform，測試才驗得到「不是 macOS」那條 */
  platform: NodeJS.Platform;
  runner?: CommandRunner;
  /** 預設 RECORDER_TIMEOUTS_MS；測試縮短它才不用真的等 */
  timeouts?: Partial<RecorderTimeouts>;
}

// 明寫的型別守衛，不靠自動 narrowing：這個 repo 的 tsconfig 沒開 strict（同 audioSlicer.ts）
const isSpawnNotFound = (err: unknown): boolean =>
  (err as { code?: unknown } | null | undefined)?.code === 'ENOENT';

const ERROR_STDERR_TAIL = 600;
const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= ERROR_STDERR_TAIL ? trimmed : `…${trimmed.slice(-ERROR_STDERR_TAIL)}`;
};

const SETUP_HINT = '三個捷徑的建法見 README〈用語音備忘錄錄音〉';

export function createVoiceMemoRecorder(options: VoiceMemoRecorderOptions) {
  const runner = options.runner ?? spawnCommandRunner;
  const timeouts: RecorderTimeouts = { ...RECORDER_TIMEOUTS_MS, ...options.timeouts };

  const run = async (
    executable: string,
    args: readonly string[],
    what: string,
    timeoutMs: number,
    timeoutHint = '',
  ): Promise<CommandResult> => {
    let result: CommandResult;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 順序要先 reject 再 abort：反過來的話 runner 會在 abort 的同步流程裡先以 AbortError 結束，
        // race 拿到的就是那個看不出是哪個捷徑的錯誤（測試抓到）
        reject(new RecorderTimeoutError(`${what}超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應，已經中止${timeoutHint}`));
        controller.abort();
      }, timeoutMs);
    });
    // 逾時之後 runner 會以 AbortError 結束。不用另外 .catch：Promise.race 對每個輸入都掛了處理函式，
    // 晚到的 rejection 已經有人接，不會變成 unhandled rejection（變異測試驗過拿掉 .catch 照樣綠）
    const running = runner(executable, args, controller.signal);
    try {
      result = await Promise.race([running, timedOut]);
    } catch (err) {
      if (err instanceof RecorderTimeoutError) throw err;
      if (isSpawnNotFound(err)) {
        throw new Error(`找不到 ${executable}，${what}做不了。語音備忘錄錄音只支援 macOS（需要內建的 shortcuts 指令）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (result.code !== 0) {
      throw new Error(`${what}失敗（${executable} 結束碼 ${result.code}）：${tail(result.stderr) || '沒有錯誤輸出'}`);
    }
    return result;
  };

  const runShortcut = async (
    name: string,
    timeoutMs: number,
    extraArgs: readonly string[] = [],
    timeoutHint = '',
  ): Promise<void> => {
    await run(options.shortcutsPath, ['run', name, ...extraArgs], `執行捷徑「${name}」`, timeoutMs, timeoutHint);
  };

  return {
    /**
     * 這台機器能不能錄。每次都重查，不在啟動時查一次就記住：使用者可能在 server 開著的時候
     * 才去「捷徑」App 建那三個捷徑，記住的話要重啟 server 才看得到錄音按鍵
     */
    checkAvailability: async (): Promise<RecorderAvailability> => {
      if (options.platform !== 'darwin') {
        return { available: false, reason: `語音備忘錄錄音只支援 macOS，這台 server 跑在 ${options.platform}` };
      }
      let listed: CommandResult;
      try {
        listed = await run(options.shortcutsPath, ['list'], '列出捷徑', timeouts.list);
      } catch (err) {
        return { available: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const names = new Set(listed.stdout.toString('utf8').split('\n').map((line) => line.trim()));
      const missing = Object.values(VOICE_MEMO_SHORTCUTS).filter((name) => !names.has(name));
      if (missing.length > 0) {
        return {
          available: false,
          reason: `「捷徑」App 裡找不到 ${missing.map((n) => `「${n}」`).join('、')}，${SETUP_HINT}`,
        };
      }
      return { available: true };
    },

    // 開始逾時是「結果不明」：卡住的那次有可能晚一點才被派出去（實測看過等 26 秒才派），
    // 所以提示使用者自己看一眼語音備忘錄，不能說成「確定沒開始」
    start: (): Promise<void> => runShortcut(
      VOICE_MEMO_SHORTCUTS.start, timeouts.start, [],
      '。語音備忘錄有可能晚一點才開始錄，請看一下它有沒有在錄，有的話直接在語音備忘錄按停止',
    ),

    // 停止逾時的提示由 createApp 的停止路由補（它對所有停止失敗都講同一句），這裡不重複
    stop: (): Promise<void> => runShortcut(VOICE_MEMO_SHORTCUTS.stop, timeouts.stop),

    /**
     * 叫取檔捷徑把最新的一支錄音寫到 destPath。destPath 的檔名不能帶不認得的副檔名：
     * `shortcuts` 遇到 `.part` 這種副檔名會結束碼 0、什麼都不寫（用 audioStore.tempPathFor 給的路徑）。
     *
     * 捷徑成功結束不代表有交出東西：過濾條件什麼都沒挑到時 `shortcuts run` 照樣回 0、
     * 但不會寫檔。所以結束碼之外還要看檔案真的在、而且不是空的，不然下一步 ffprobe 的錯誤
     * 會把人指去查音檔格式，而問題其實在捷徑沒挑到檔。
     */
    fetchLatestTo: async (destPath: string): Promise<void> => {
      await runShortcut(VOICE_MEMO_SHORTCUTS.fetch, timeouts.fetch, ['--output-path', destPath]);
      if (!existsSync(destPath) || statSync(destPath).size === 0) {
        throw new Error(
          `捷徑「${VOICE_MEMO_SHORTCUTS.fetch}」執行完了，但沒有交出任何檔案。`
          + `請確認它讀的是語音備忘錄的錄音資料夾、過濾條件挑得到檔案（${SETUP_HINT}）`,
        );
      }
    },

    /**
     * 讀取回檔案的長度與建立時間。
     *
     * 讀不出長度通常是捷徑交出了音檔以外的東西：語音備忘錄每支錄音旁邊都有一個 `.waveform`
     * 附屬檔（波形資料），過濾條件沒排除它的話「最新一支」會拿到它（2026-09-23 實測踩過）
     */
    probe: async (filePath: string): Promise<RecordingInfo> => {
      const result = await run(
        options.ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration:format_tags=creation_time', '-of', 'json', filePath],
        'ffprobe 讀取錄音檔資訊',
        timeouts.probe,
      );
      let parsed: { format?: { duration?: unknown; tags?: { creation_time?: unknown } } };
      try {
        parsed = JSON.parse(result.stdout.toString('utf8'));
      } catch (err) {
        throw new Error(`ffprobe 的輸出不是 JSON，讀不到錄音檔資訊：${(err as Error).message}`);
      }
      const duration = Number(parsed.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(
          `取回的檔案讀不出長度（ffprobe 回 ${JSON.stringify(parsed.format?.duration ?? null)}），可能不是音檔。`
          + `請確認「${VOICE_MEMO_SHORTCUTS.fetch}」的過濾條件有排除 .waveform 附屬檔（${SETUP_HINT}）`,
        );
      }
      const rawCreation = parsed.format?.tags?.creation_time;
      const creationTimeMs = typeof rawCreation === 'string' ? Date.parse(rawCreation) : NaN;
      return { durationSeconds: duration, creationTimeMs: Number.isFinite(creationTimeMs) ? creationTimeMs : null };
    },
  };
}

export type VoiceMemoRecorder = ReturnType<typeof createVoiceMemoRecorder>;

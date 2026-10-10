/**
 * server 端音訊切片（W2 T1，SDD 1.1）。
 *
 * 為什麼不沿用搬家前那套瀏覽器切片（W2 之前的 `generateAudioSlices`，已隨前端流程一起刪掉）：
 * 那條路徑是整檔 `arrayBuffer()` → 整檔 `decodeAudioData()` → `OfflineAudioContext` 整檔重取樣，
 * 記憶體佔用跟會議長度成正比，106 分鐘的會上傳後分頁直接崩潰。ffmpeg 一次只讀它要的那一段，
 * 記憶體跟檔案長度無關。
 *
 * 兩支執行檔一律經注入的 `CommandRunner` 呼叫，不在這個檔裡直接 spawn：
 * 測試機器上不一定裝得到 ffmpeg，而「切片規則對不對」與「spawn 出來的東西會不會動」
 * 是兩件事，後者不該擋住前者的測試。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';

/** 一片的計畫。時間是相對整個音檔的絕對秒數，durationSeconds 含 overlap */
export interface SlicePlanEntry {
  index: number;
  startSeconds: number;
  durationSeconds: number;
}

const isPositiveFinite = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * 排出整份切片計畫。純函式，不碰任何 I/O。
 *
 * 規則跟 `generateAudioSlices` 一致：第 N 片涵蓋 [start_N, start_N + D + O]，
 * 第 N+1 片從 start_N + D 開始，所以相鄰兩片有 O 秒重疊，`mergeSliceTranscript` 靠這段去重。
 * 最後一片會被總長度夾短，`durationSeconds` 要回報實際長度——傳錯的話
 * `normalizeTranscribedSegments` 會把時間夾到不存在的範圍。
 *
 * 總長度不是有限正數（0、負數、NaN、Infinity）一律拋錯，不回空陣列：
 * 回空陣列會讓整場會「轉錄成功但一個字都沒有」，而那跟真的沒人說話長得一樣。
 */
export function planSlices(
  totalDurationSeconds: number,
  sliceDurationSeconds: number,
  overlapSeconds: number,
): SlicePlanEntry[] {
  if (!isPositiveFinite(totalDurationSeconds)) {
    throw new Error(`planSlices: 音訊總長度必須是有限正數，收到 ${JSON.stringify(totalDurationSeconds)}`);
  }
  if (!isPositiveFinite(sliceDurationSeconds)) {
    throw new Error(`planSlices: 切片長度必須是有限正數，收到 ${JSON.stringify(sliceDurationSeconds)}`);
  }
  if (typeof overlapSeconds !== 'number' || !Number.isFinite(overlapSeconds) || overlapSeconds < 0) {
    throw new Error(`planSlices: overlap 必須是有限非負數，收到 ${JSON.stringify(overlapSeconds)}`);
  }

  const plan: SlicePlanEntry[] = [];
  let start = 0;
  while (start < totalDurationSeconds) {
    const end = Math.min(start + sliceDurationSeconds + overlapSeconds, totalDurationSeconds);
    plan.push({ index: plan.length, startSeconds: start, durationSeconds: end - start });
    start += sliceDurationSeconds;
  }
  return plan;
}

export interface CommandResult {
  /** 被訊號殺掉時是 null，那不是成功，跟非 0 一起處理 */
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * `signal` 是選填的中止訊號：給了而且被 abort，子程序會被 SIGKILL 砍掉、Promise 以錯誤結束。
 * ffmpeg 這邊不給（切片的長度跟會議長度成正比，沒有合理的上限）；語音備忘錄的捷徑呼叫會給，
 * 因為 `shortcuts run` 實測會間歇性卡住不回來（voiceMemoRecorder.ts 的 RECORDER_TIMEOUTS_MS）
 */
export type CommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

// stderr 只留尾端：ffmpeg 正常跑也會印一大段 banner 與 stream 資訊，真正的錯誤在最後幾行。
// 全部留著會把錯誤訊息灌成幾十 KB，反而看不到重點
const MAX_STDERR_KEPT = 4000;
const ERROR_STDERR_TAIL = 600;

const tail = (text: string, length: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= length ? trimmed : `…${trimmed.slice(-length)}`;
};

/** 真的去 spawn 的 runner。正式啟動用這支，測試注入假的 */
export const spawnCommandRunner: CommandRunner = (executable, args, signal) =>
  new Promise<CommandResult>((resolve, reject) => {
    // 被 abort 時 Node 會砍掉子程序並觸發 error 事件（AbortError），走下面同一條 reject
    const child = spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    const chunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_STDERR_KEPT) stderr = stderr.slice(-MAX_STDERR_KEPT);
    });
    // spawn 本身失敗（找不到執行檔、沒有執行權限）走 error，不會有 close
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/** 沒設就走 PATH 上的 ffmpeg / ffprobe。設了空字串等同沒設，不要拿空字串去 spawn */
export const resolveFfmpegPaths = (env: NodeJS.ProcessEnv): FfmpegPaths => ({
  ffmpeg: (env.MEETPILOT_FFMPEG ?? '').trim() || 'ffmpeg',
  ffprobe: (env.MEETPILOT_FFPROBE ?? '').trim() || 'ffprobe',
});

/** 切片輸出格式：`flac` 送 Gemini，`wav` 給音量檢查（見 `readSlice`） */
export type SliceFormat = 'flac' | 'wav';

/** 送 Gemini 的切片格式對應的 mimeType，pipeline 與接縫修補共用 */
export const SLICE_MIME_TYPE = 'audio/flac';

// ffmpeg 結束碼 0 卻沒寫出檔案時當成沒有輸出，交給呼叫端那條「沒有輸出任何資料」的錯誤，
// 不讓 ENOENT 蓋掉真正的原因
const readOutputFile = (path: string): Buffer => {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as { code?: unknown } | null | undefined)?.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
};

export interface AudioSlicerOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** 預設 spawnCommandRunner；測試注入假的 */
  runner?: CommandRunner;
}

// 明寫的型別守衛，不靠自動 narrowing：這個 repo 的 tsconfig 沒開 strict（同 jobMigration.ts 的 isRejected）
const isSpawnNotFound = (err: unknown): boolean =>
  (err as { code?: unknown } | null | undefined)?.code === 'ENOENT';

export function createAudioSlicer(options: AudioSlicerOptions) {
  const runner = options.runner ?? spawnCommandRunner;

  const run = async (executable: string, args: readonly string[], what: string): Promise<CommandResult> => {
    let result: CommandResult;
    try {
      result = await runner(executable, args);
    } catch (err) {
      if (isSpawnNotFound(err)) {
        // 原始的 spawn ENOENT 只說「no such file or directory」，看不出缺的是 ffmpeg。
        // 這是最常見的一種安裝問題，訊息要直接講怎麼解決
        throw new Error(
          `找不到 ${executable}：server 端切片需要 ffmpeg 與 ffprobe。請先安裝（macOS：brew install ffmpeg），`
          + '或用 MEETPILOT_FFMPEG / MEETPILOT_FFPROBE 指定完整路徑',
        );
      }
      throw err;
    }

    if (result.code !== 0) {
      throw new Error(`${what}失敗（${executable} 結束碼 ${result.code}）：${tail(result.stderr, ERROR_STDERR_TAIL)}`);
    }
    return result;
  };

  const readRawDuration = async (filePath: string): Promise<string> => {
    const result = await run(
      options.ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      'ffprobe 讀取音訊長度',
    );
    return result.stdout.toString('utf8').trim();
  };

  // 讀不出有限正數（0、NaN、Infinity）就拋錯，不回 0 也不回 Infinity：
  // 那兩個值拿去當切片迴圈的上限，一個切不出東西、一個永遠不停
  const parseDuration = (raw: string, filePath: string): number => {
    const duration = Number(raw);
    if (!isPositiveFinite(duration)) {
      throw new Error(
        `ffprobe 沒有回出有限正數的長度（拿到 ${JSON.stringify(raw)}），無法切片：${filePath}`,
      );
    }
    return duration;
  };

  return {
    /**
     * 用 ffprobe 讀總長度；容器裡沒寫長度（ffprobe 回 `N/A`）時，先原地 remux 一次再讀。
     *
     * 瀏覽器 `MediaRecorder` 錄的 webm 沒有 Duration 也沒有 Cues，ffprobe 讀不到長度，
     * 拖曳上傳這種檔原本會在轉錄一開始就 FAILED。2026-09-23 實測：同一支檔 `ffmpeg -c copy`
     * 之後長度讀得到（vault plan「MeetPilot · 網頁錄音」AC-7）。
     *
     * 只救 `N/A` 這一種。0、負數、ffprobe 自己失敗代表檔案本身有問題，remux 救不回來，
     * 照原本的錯誤爆，不要把一個壞檔包裝成「補寫過長度」的樣子繼續往下送。
     *
     * `-c copy` 不重新編碼，只重寫容器；輸出 matroska（webm 是它的子集，opus、vorbis、aac 都裝得下）。
     * 先寫 `.part` 再 rename 蓋回原檔：中途失敗不留半個檔，server 掛掉留下的 `.part`
     * 由啟動時的 `removePartialUploads` 清掉。
     */
    probeDurationRemuxingIfMissing: async (filePath: string): Promise<number> => {
      const raw = await readRawDuration(filePath);
      if (raw !== 'N/A') return parseDuration(raw, filePath);

      const partPath = `${filePath}.remux-${randomUUID()}.part`;
      try {
        await run(
          options.ffmpegPath,
          ['-v', 'error', '-y', '-i', filePath, '-c', 'copy', '-f', 'matroska', partPath],
          'ffmpeg 補寫音訊長度（remux）',
        );
        renameSync(partPath, filePath);
      } catch (err) {
        rmSync(partPath, { force: true });
        throw err;
      }
      return parseDuration(await readRawDuration(filePath), filePath);
    },

    /**
     * 切出一片 16kHz 單聲道音訊。`format` 決定輸出：
     *
     * - `flac`：送 Gemini 用。無損壓縮，同樣的 16kHz 單聲道 16-bit 取樣，上傳量比 WAV 小（vault plan
     *   「MeetPilot · 記錄完整度、成本與背景運作」AC-5：10 分鐘 WAV 約 19MB、base64 後約 25MB）。
     *   寫到音檔旁邊的 `.part` 暫存檔再讀回來，不寫 pipe：FLAC 的 STREAMINFO（總取樣數）要寫完回頭補，
     *   pipe 不能回頭，輸出的檔沒有長度（2026-10-10 實測 ffprobe 讀成 `N/A`），送一個沒有長度的檔給
     *   Gemini 不知道它怎麼算時間，不賭。暫存檔用完就刪，server 掛掉留下的由啟動時的 `removePartialUploads` 清。
     *   `-sample_fmt s16` 寫明：輸入是浮點（aac、opus 解出來都是）時 flac 編碼器會自動挑 32-bit
     *   （2026-10-10 實測語音備忘錄 aac 那支測試音檔：不寫是 s32、72KB，寫了 s16、29KB）。
     * - `wav`：只給 `audioLevel.wavLevel` 量音量用，它只讀得懂 WAV。
     *
     * `-ss` 放在 `-i` 前面是 input seeking：ffmpeg 直接跳到那個位置，不用把前面整段解碼過去。
     * 放在 `-i` 後面會變成逐格解碼到指定時間，長會議的後段切片會慢到不能用。
     */
    readSlice: async (
      filePath: string,
      startSeconds: number,
      durationSeconds: number,
      format: SliceFormat,
    ): Promise<Buffer> => {
      if (!Number.isFinite(startSeconds) || startSeconds < 0) {
        throw new Error(`readSlice: 起點必須是非負有限數，收到 ${JSON.stringify(startSeconds)}`);
      }
      if (!isPositiveFinite(durationSeconds)) {
        throw new Error(`readSlice: 片長必須是有限正數，收到 ${JSON.stringify(durationSeconds)}`);
      }

      const input = ['-ss', String(startSeconds), '-t', String(durationSeconds), '-i', filePath, '-ar', '16000', '-ac', '1'];
      const what = `ffmpeg 切出 ${startSeconds}s 起算 ${durationSeconds}s 的片段`;
      let output: Buffer;
      if (format === 'wav') {
        output = (await run(options.ffmpegPath, [...input, '-f', 'wav', 'pipe:1'], what)).stdout;
      } else {
        const partPath = `${filePath}.slice-${randomUUID()}.part`;
        try {
          await run(
            options.ffmpegPath,
            ['-y', ...input, '-sample_fmt', 's16', '-c:a', 'flac', '-f', 'flac', partPath],
            what,
          );
          output = readOutputFile(partPath);
        } finally {
          rmSync(partPath, { force: true });
        }
      }

      if (output.length === 0) {
        // 結束碼 0 但沒有輸出：這一片會變成「送了空音檔給 Gemini」，回來的空逐字稿
        // 跟「這段真的沒人說話」分不開，所以在這裡就爆
        throw new Error(
          `ffmpeg 在 ${startSeconds}s 起算 ${durationSeconds}s 的片段沒有輸出任何資料：${filePath}`,
        );
      }
      return output;
    },
  };
}

export type AudioSlicer = ReturnType<typeof createAudioSlicer>;

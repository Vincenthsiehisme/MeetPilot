/**
 * 桌面 app 自己錄音的判斷與分段上傳（vault plan「MeetPilot · 跨平台打包部署」E4）。
 *
 * 這裡只放不碰瀏覽器 API 的部分，跟 recordingView.ts 同一個理由：App.tsx 沒有元件測試、tsc 對它幾乎沒有
 * 型別覆蓋（AGENTS.md〈gate 守不到哪裡〉），能測的判斷一律抽出來。碰 getUserMedia／MediaRecorder 的在 micRecorder.ts。
 *
 * 錄音品質的兩條前提來自 plan〈決策〉2026-09-23「錄音品質評斷」：
 * - 瀏覽器預設開著的回音消除、噪音抑制、自動增益對會議室遠場多人講話有害，三項都要關，而且要確認真的關了
 * - Windows 上 Chromium 可能挑到「通訊裝置」而不是預設的錄音裝置，所以要讓人選麥克風
 */
import { HttpError } from './httpError';

/** 三項前處理。名字就是 MediaTrackConstraints／MediaTrackSettings 的欄位名 */
export const PROCESSING_FLAGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

const PROCESSING_LABELS: Record<(typeof PROCESSING_FLAGS)[number], string> = {
  echoCancellation: '回音消除',
  noiseSuppression: '噪音抑制',
  autoGainControl: '自動增益',
};

/**
 * getUserMedia 的參數。deviceId 是 null 就用系統預設的麥克風。
 *
 * 用 `exact` 不用 `ideal`：選了某支麥克風卻被瀏覽器換成另一支，錄到的聲音跟使用者以為的不同，而畫面上看不出來。
 * 那支麥克風不在了就讓 getUserMedia 失敗、講出原因。三項前處理同理，要求 `exact: false`
 */
export const buildMicConstraints = (deviceId: string | null): MediaStreamConstraints => ({
  audio: {
    ...(deviceId === null ? {} : { deviceId: { exact: deviceId } }),
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl: { exact: false },
    channelCount: 1,
  },
  video: false,
});

export type TrackCheck = { ok: true } | { ok: false; reason: string };

/**
 * 拿到的麥克風真的把三項前處理都關了嗎（track.getSettings() 的結果）。
 *
 * 沒回報也算不通過：`undefined` 可能是瀏覽器照樣開著只是不說，錄完才發現聲音被壓過一輪就來不及了。
 * 這條錯了的代價是某些驅動回報不全的電腦錄不了，那時改成警告（plan E4 裁定）
 */
export const checkProcessingOff = (settings: Partial<Record<(typeof PROCESSING_FLAGS)[number], unknown>>): TrackCheck => {
  const notOff = PROCESSING_FLAGS.filter((flag) => settings[flag] !== false);
  if (notOff.length === 0) return { ok: true };
  const described = notOff.map((flag) => `${PROCESSING_LABELS[flag]}（${settings[flag] === undefined ? '瀏覽器沒有回報' : '開著'}）`);
  return {
    ok: false,
    reason: `這支麥克風沒辦法確認關掉${described.join('、')}。這幾項會把會議室裡遠一點的人聲壓掉，`
      + '所以沒有開始錄音。換一支麥克風再試，或改用手機錄好之後把檔案拖進來',
  };
};

/**
 * 錄音格式。只收 webm／opus：server 端的 ffmpeg（隨附的最小版）確定認得它，沒有長度的 webm 也有 remux 那條路。
 * 瀏覽器不支援就不錄，不退回瀏覽器預設的格式：那可能是隨附的 ffmpeg 解不開的東西，錄完一小時才在轉錄時 FAILED
 */
export const RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm'] as const;

export const pickRecordingMimeType = (isTypeSupported: (type: string) => boolean): string | null =>
  RECORDING_MIME_TYPES.find((type) => isTypeSupported(type)) ?? null;

/** 64 kbps 單聲道 opus：語音 32 kbps 就夠，多給一倍是為了遠場小聲的人。100 分鐘約 48 MB */
export const RECORDING_BITS_PER_SECOND = 64_000;

/**
 * getUserMedia／MediaRecorder 的錯誤翻成使用者看得懂、知道下一步的話。
 * 認不得的錯誤原樣帶出名字與訊息，不改寫成籠統的「麥克風有問題」
 */
export const describeMicError = (err: unknown, platform: 'mac' | 'windows' | 'other'): string => {
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const where = platform === 'mac'
      ? '到「系統設定 › 隱私權與安全性 › 麥克風」打開 MeetPilot，再重新打開 MeetPilot'
      : platform === 'windows'
        ? '到「設定 › 隱私權與安全性 › 麥克風」打開「讓桌面應用程式存取您的麥克風」'
        : '到系統的隱私權設定允許這個程式使用麥克風';
    return `沒有麥克風權限，${where}`;
  }
  if (name === 'NotFoundError') return '找不到麥克風。接上麥克風，或確認系統的音效設定裡看得到它';
  if (name === 'OverconstrainedError') {
    return '選的那支麥克風現在不在了（拔掉或換了插孔），或它關不掉回音消除等前處理。重新選一支再試';
  }
  if (name === 'NotReadableError') return '麥克風被別的程式佔著或驅動出錯。關掉其他在用麥克風的程式（視訊會議之類）再試';
  return `麥克風打不開（${typeof name === 'string' ? name : '未知錯誤'}：${message}）`;
};

/**
 * 預設選哪支麥克風。上次選的還在就用它，不在就用系統預設（Chromium 的 `default`），都沒有就第一支。
 * 上次選的那支不在時不安靜換掉：回傳 `forgotten`，畫面講一句「上次那支不在了」
 */
export const pickInitialDevice = (
  devices: readonly { deviceId: string }[],
  remembered: string | null,
): { deviceId: string | null; forgotten: boolean } => {
  if (remembered !== null && devices.some((d) => d.deviceId === remembered)) return { deviceId: remembered, forgotten: false };
  const fallback = devices.find((d) => d.deviceId === 'default')?.deviceId ?? devices[0]?.deviceId ?? null;
  return { deviceId: fallback, forgotten: remembered !== null };
};

// ---------------------------------------------------------------------------
// 靜音偵測：錄到空白是這條路最安靜的壞法（選錯麥克風、麥克風靜音、系統權限被拒但沒報錯）
// ---------------------------------------------------------------------------

/** 音量（0～1 的 RMS）低於這個值算「沒聲音」。約 -50 dBFS，比安靜會議室的底噪還低（我判，AC-8 真實錄音時校正） */
export const SILENCE_LEVEL = 0.003;
/** 連續多久沒聲音就警告 */
export const SILENCE_WARN_MS = 60_000;

/**
 * 更新「從什麼時候開始沒聲音」。有聲音就歸零（null），沒聲音就保留第一次沒聲音的時間
 */
export const nextSilentSince = (silentSince: number | null, level: number, now: number): number | null =>
  level >= SILENCE_LEVEL ? null : (silentSince ?? now);

export const isSilentTooLong = (silentSince: number | null, now: number): boolean =>
  silentSince !== null && now - silentSince >= SILENCE_WARN_MS;

/** 一段取樣（-1～1）的 RMS */
export const rmsLevel = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
};

/** 音量條的長度（0～100）。用 dB 刻度：RMS 直接畫的話，一般講話只佔音量條最左邊一小截，看不出有沒有在收音 */
export const levelToPercent = (level: number): number => {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.round(Math.min(1, Math.max(0, (db + 60) / 60)) * 100);
};

// ---------------------------------------------------------------------------
// 分段上傳
// ---------------------------------------------------------------------------

/** 一段送不到時等多久再送。最後一個數字一直重複：錄音中網路斷了，回來之後要自己接上，不能放棄 */
export const CHUNK_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** flush 等到一半被 abandon（使用者選了放棄沒送到的段落）。呼叫端看到它就不要再當成一般的停止失敗處理 */
export class UploaderAbandonedError extends Error {
  constructor() {
    super('沒送到的段落已經放棄');
    this.name = 'UploaderAbandonedError';
  }
}

export interface UploaderStatus {
  /** 已經送到 server 的段數 */
  sent: number;
  /** 錄好了、還沒送到的段數 */
  waiting: number;
  /** 最近一次送不到的原因；送到之後清掉 */
  lastError: string | null;
  /** 送不下去了（server 明確拒收，重送也不會好），之後的段落都不送 */
  fatal: string | null;
}

export interface SendFailure {
  /** 重送有沒有機會好：連線失敗、5xx、429 會；404、409 這種 server 明確拒收的不會 */
  retry: boolean;
  /** server 給的 Retry-After（毫秒），有就照它等 */
  retryAfterMs?: number;
  message: string;
}

/**
 * 一段送不到時要不要重送。連線失敗（fetch 拋 TypeError）、5xx、429 會好；其他 4xx 是 server 明確拒收
 * （這場會被刪了、已經停止、段號對不上），重送一百次也一樣，停下來講原因
 */
export const classifyChunkFailure = (err: unknown): SendFailure => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError) {
    if (err.status === 429 || err.status >= 500) {
      return {
        retry: true,
        retryAfterMs: err.retryAfterSeconds === undefined ? undefined : err.retryAfterSeconds * 1000,
        message,
      };
    }
    return { retry: false, message };
  }
  return { retry: true, message };
};

/**
 * 依序把錄好的段落送上去，一次只送一段。送不到就照 CHUNK_RETRY_DELAYS_MS 等一下再送同一段，
 * 不跳過、不並行：server 只接「下一段」，跳過一段後面全部都會被當成跳號。
 *
 * 狀態每變一次就呼叫 onStatus，畫面照它顯示「還有幾段沒送到、為什麼」，不讓重送在背景安靜地一直失敗
 */
export function createChunkUploader<T>(options: {
  send: (seq: number, chunk: T) => Promise<void>;
  classify: (err: unknown) => SendFailure;
  onStatus?: (status: UploaderStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? CHUNK_RETRY_DELAYS_MS;
  const queue: { seq: number; chunk: T }[] = [];
  let nextSeq = 0;
  let sent = 0;
  let lastError: string | null = null;
  let fatal: string | null = null;
  let abandoned = false;
  let running = false;
  // 正在送的那一次請求。abandon 要等它結束：請求已經送出去的話，server 還是會把那一段寫進去
  let sending: Promise<unknown> | null = null;
  let idle: (() => void)[] = [];

  const status = (): UploaderStatus => ({ sent, waiting: queue.length, lastError, fatal });
  const report = () => options.onStatus?.(status());

  const settleIdle = () => {
    const waiters = idle;
    idle = [];
    waiters.forEach((resolve) => resolve());
  };

  const run = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && fatal === null && !abandoned) {
        const { seq, chunk } = queue[0];
        let attempt = 0;
        for (;;) {
          try {
            const request = options.send(seq, chunk);
            sending = request;
            try {
              await request;
            } finally {
              sending = null;
            }
            queue.shift();
            sent += 1;
            lastError = null;
            report();
            break;
          } catch (err) {
            const failure = options.classify(err);
            lastError = failure.message;
            if (!failure.retry) fatal = `第 ${seq} 段被 server 拒收：${failure.message}`;
            report();
            if (fatal !== null || abandoned) return;
            await sleep(failure.retryAfterMs ?? delays[Math.min(attempt, delays.length - 1)]);
            attempt += 1;
            if (abandoned) return;
          }
        }
      }
    } finally {
      running = false;
      settleIdle();
    }
  };

  return {
    /** 排一段進去，回傳它的段號（從 0 起算） */
    push: (chunk: T): number => {
      const seq = nextSeq;
      nextSeq += 1;
      if (fatal === null && !abandoned) {
        queue.push({ seq, chunk });
        report();
        void run();
      }
      return seq;
    },
    /** 一共錄了幾段（含還沒送到的）。停止時就是要告訴 server 的段數 */
    total: (): number => nextSeq,
    status,
    /**
     * 等到全部送完。送不下去（fatal）就拋錯；只是暫時送不到會一直等，呼叫端看 onStatus 決定要不要讓人放棄
     */
    flush: async (): Promise<void> => {
      for (;;) {
        if (fatal !== null) throw new Error(fatal);
        // 放棄了就不是「送完了」：呼叫端不能接著跟 server 說一共錄了幾段
        if (abandoned) throw new UploaderAbandonedError();
        if (queue.length === 0 && !running) return;
        await new Promise<void>((resolve) => { idle.push(resolve); void run(); });
      }
    },
    /**
     * 不送了（刪掉這場會、送出已錄的部分之前）。之後不再送任何一段、不再重送；
     * 回傳的 Promise 等到正在送的那一次請求結束（成功失敗都算）才完成，呼叫端要等它再叫 server 刪除或收尾
     */
    abandon: (): Promise<void> => {
      abandoned = true;
      queue.length = 0;
      settleIdle();
      const inFlight = sending;
      return inFlight === null ? Promise.resolve() : inFlight.then(() => undefined, () => undefined);
    },
  };
}

export type ChunkUploader<T> = ReturnType<typeof createChunkUploader<T>>;

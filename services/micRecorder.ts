/**
 * 桌面 app 自己錄音時碰瀏覽器 API 的那一層（vault plan「MeetPilot · 跨平台打包部署」E4）：getUserMedia、
 * MediaRecorder、音量取樣。判斷都在 inAppRecording.ts（有測試），這裡只接線，盡量薄。
 *
 * 錄音跑在主視窗的頁面裡。關視窗只是藏起來（外殼的 close 處理），頁面還活著，所以錄音不中斷；
 * 外殼另外關掉了背景節流（backgroundThrottling: false），藏起來的頁面計時器照常跑，分段照常送。
 */
import {
  RECORDING_BITS_PER_SECOND,
  buildMicConstraints,
  checkProcessingOff,
  describeMicError,
  pickRecordingMimeType,
  rmsLevel,
} from './inAppRecording';
import { RECORDING_CHUNK_MS } from './meetingApi';

const LEVEL_INTERVAL_MS = 250;

/**
 * 是不是跑在桌面 app 的視窗裡（外殼的 preload 掛了 meetpilotDesktop）。只有桌面 app 關視窗是藏到系統匣、錄音不斷；
 * 一般瀏覽器關分頁就是結束，畫面上的說法要跟著分開（Codex review）
 */
export const isDesktopApp = (): boolean => typeof (window as any).meetpilotDesktop === 'object';

const currentPlatform = (): 'mac' | 'windows' | 'other' => {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
};

/** 列出麥克風。先要一次權限：沒給過權限的話 enumerateDevices 回的名稱全是空字串，選不了 */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('這個視窗不支援錄音（沒有 mediaDevices）');
  let probe: MediaStream;
  try {
    probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    throw new Error(describeMicError(err, currentPlatform()));
  }
  probe.getTracks().forEach((t) => t.stop());
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  if (devices.length === 0) throw new Error(describeMicError({ name: 'NotFoundError' }, currentPlatform()));
  return devices;
}

export interface OpenedMicrophone {
  stream: MediaStream;
  label: string;
  mimeType: string;
}

/**
 * 打開麥克風並確認三項前處理真的關了、瀏覽器錄得出 webm。任何一項不成立就拋錯（訊息給人看），麥克風一併放掉。
 * 這一步在建立會議之前做：麥克風打不開的話，不留一場沒有錄音的空會議
 */
export async function openMicrophone(deviceId: string | null): Promise<OpenedMicrophone> {
  if (typeof MediaRecorder === 'undefined') throw new Error('這個視窗不支援錄音（沒有 MediaRecorder）');
  const mimeType = pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
  if (mimeType === null) throw new Error('這個視窗錄不出 webm（opus），沒有開始錄音');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
  } catch (err) {
    throw new Error(describeMicError(err, currentPlatform()));
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('麥克風打開了，但沒有聲音軌');
  }
  const check = checkProcessingOff(track.getSettings() as Record<string, unknown>);
  if (check.ok === false) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(check.reason);
  }
  return { stream, label: track.label || '（沒有名稱的麥克風）', mimeType };
}

export interface MicRecordingCallbacks {
  /** 錄好一段（約 10 秒）。空的段落不會送進來 */
  onChunk: (chunk: Blob) => void;
  /** 目前音量（0～1 的 RMS），每 250 毫秒一次 */
  onLevel: (level: number) => void;
  /** 錄音自己停了（麥克風被拔掉、系統收回、MediaRecorder 出錯）。已經錄好的段落照常會送進 onChunk */
  onInterrupted: (reason: string) => void;
}

export interface MicRecording {
  /** 停止錄音，等最後一段交出去才回來 */
  stop: () => Promise<void>;
  /** 放掉麥克風與音量取樣。stop 之後、或不要這場錄音時呼叫 */
  release: () => void;
}

/**
 * 開始錄。任何一步起不來（MediaRecorder、AudioContext）就把這裡建的東西收掉再拋錯，麥克風由呼叫端放：
 * 半套起來的計時器或 AudioContext 留著的話，會在背景一直跑（Codex review）
 */
export function startMicRecording(mic: OpenedMicrophone, callbacks: MicRecordingCallbacks): MicRecording {
  let context: AudioContext | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  try {
    return startMicRecordingUnsafe(mic, callbacks, (c, t) => { context = c; levelTimer = t; });
  } catch (err) {
    if (levelTimer !== null) clearInterval(levelTimer);
    if (context !== null) void (context as AudioContext).close();
    throw err;
  }
}

function startMicRecordingUnsafe(
  mic: OpenedMicrophone,
  callbacks: MicRecordingCallbacks,
  track: (context: AudioContext | null, levelTimer: ReturnType<typeof setInterval> | null) => void,
): MicRecording {
  const recorder = new MediaRecorder(mic.stream, { mimeType: mic.mimeType, audioBitsPerSecond: RECORDING_BITS_PER_SECOND });
  const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
  let interrupted = false;
  const interrupt = (reason: string) => {
    if (interrupted) return;
    interrupted = true;
    callbacks.onInterrupted(reason);
    if (recorder.state !== 'inactive') recorder.stop();
  };

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) callbacks.onChunk(event.data);
  });
  recorder.addEventListener('error', (event) => {
    const detail = (event as Event & { error?: { message?: string } }).error?.message ?? '未知錯誤';
    interrupt(`錄音程式出錯停下來了（${detail}）`);
  });
  const audioTrack = mic.stream.getAudioTracks()[0];
  audioTrack.addEventListener('ended', () => interrupt(`麥克風「${mic.label}」中斷了（拔掉、被系統收回或裝置出錯）`));

  // 音量取樣。AudioContext 沒有使用者手勢時可能是 suspended，那樣取到的永遠是 0，靜音警告會誤報；
  // 外殼已經關掉自動播放限制，這裡再 resume 一次
  const context = new AudioContext();
  track(context, null);
  void context.resume();
  const source = context.createMediaStreamSource(mic.stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const levelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    callbacks.onLevel(rmsLevel(samples));
  }, LEVEL_INTERVAL_MS);
  track(context, levelTimer);

  recorder.start(RECORDING_CHUNK_MS);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(levelTimer);
    source.disconnect();
    void context.close();
    mic.stream.getTracks().forEach((t) => t.stop());
  };

  return {
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
    },
    release,
  };
}

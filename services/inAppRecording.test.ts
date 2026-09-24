import { describe, it, expect } from 'vitest';
import { HttpError } from './httpError';
import {
  SILENCE_LEVEL,
  SILENCE_WARN_MS,
  UploaderAbandonedError,
  UploaderStatus,
  buildMicConstraints,
  checkProcessingOff,
  classifyChunkFailure,
  createChunkUploader,
  describeMicError,
  isSilentTooLong,
  levelToPercent,
  nextSilentSince,
  pickInitialDevice,
  pickRecordingMimeType,
  rmsLevel,
} from './inAppRecording';

describe('buildMicConstraints', () => {
  it('三項前處理一律要求 exact false、單聲道；選了麥克風就 exact 那一支', () => {
    expect(buildMicConstraints('mic-2')).toEqual({
      audio: {
        deviceId: { exact: 'mic-2' },
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: 1,
      },
      video: false,
    });
  });

  it('沒選就不帶 deviceId（系統預設）', () => {
    expect((buildMicConstraints(null).audio as MediaTrackConstraints).deviceId).toBeUndefined();
  });
});

describe('checkProcessingOff', () => {
  it('三項都回報 false 才通過', () => {
    expect(checkProcessingOff({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })).toEqual({ ok: true });
  });

  it('有一項開著就不通過，講出是哪一項', () => {
    const check = checkProcessingOff({ echoCancellation: false, noiseSuppression: true, autoGainControl: false });
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toContain('噪音抑制（開著）');
      expect(check.reason).not.toContain('回音消除');
    }
  });

  it('沒回報也不通過：undefined 可能是照樣開著只是不說', () => {
    const check = checkProcessingOff({ echoCancellation: false, noiseSuppression: false });
    expect(check.ok).toBe(false);
    if (check.ok === false) expect(check.reason).toContain('自動增益（瀏覽器沒有回報）');
  });
});

describe('pickRecordingMimeType', () => {
  it('優先 webm/opus；都不支援回 null，不退回瀏覽器預設的格式', () => {
    expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecordingMimeType((t) => t === 'audio/webm')).toBe('audio/webm');
    expect(pickRecordingMimeType((t) => t === 'audio/mp4')).toBeNull();
  });
});

describe('describeMicError', () => {
  it('沒權限時依平台指到對的設定位置', () => {
    expect(describeMicError({ name: 'NotAllowedError' }, 'mac')).toContain('系統設定 › 隱私權與安全性 › 麥克風');
    expect(describeMicError({ name: 'NotAllowedError' }, 'windows')).toContain('讓桌面應用程式存取您的麥克風');
  });

  it('認不得的錯誤帶出名字與原始訊息', () => {
    const err = Object.assign(new Error('boom'), { name: 'AbortError' });
    expect(describeMicError(err, 'mac')).toBe('麥克風打不開（AbortError：boom）');
  });
});

describe('pickInitialDevice', () => {
  const devices = [{ deviceId: 'default' }, { deviceId: 'communications' }, { deviceId: 'usb-1' }];

  it('上次選的還在就用它', () => {
    expect(pickInitialDevice(devices, 'usb-1')).toEqual({ deviceId: 'usb-1', forgotten: false });
  });

  it('上次選的不在了：用系統預設，並標出來讓畫面講', () => {
    expect(pickInitialDevice(devices, 'gone')).toEqual({ deviceId: 'default', forgotten: true });
  });

  it('沒記過就用系統預設；沒有 default 就第一支；一支都沒有是 null', () => {
    expect(pickInitialDevice(devices, null)).toEqual({ deviceId: 'default', forgotten: false });
    expect(pickInitialDevice([{ deviceId: 'a' }], null)).toEqual({ deviceId: 'a', forgotten: false });
    expect(pickInitialDevice([], null)).toEqual({ deviceId: null, forgotten: false });
  });
});

describe('靜音偵測', () => {
  it('沒聲音時記下第一次沒聲音的時間，有聲音就歸零', () => {
    expect(nextSilentSince(null, 0, 1000)).toBe(1000);
    expect(nextSilentSince(1000, 0, 5000)).toBe(1000);
    expect(nextSilentSince(1000, SILENCE_LEVEL, 6000)).toBeNull();
  });

  it('連續超過門檻才算太久', () => {
    expect(isSilentTooLong(null, 10_000_000)).toBe(false);
    expect(isSilentTooLong(0, SILENCE_WARN_MS - 1)).toBe(false);
    expect(isSilentTooLong(0, SILENCE_WARN_MS)).toBe(true);
  });

  it('rmsLevel 與 levelToPercent', () => {
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel([0.5, -0.5, 0.5, -0.5])).toBe(0.5);
    expect(levelToPercent(0)).toBe(0);
    expect(levelToPercent(1)).toBe(100);
    expect(levelToPercent(0.001)).toBe(0); // -60 dBFS
    expect(levelToPercent(0.0316)).toBe(50); // 約 -30 dBFS
  });
});

describe('classifyChunkFailure', () => {
  it('連線失敗、5xx、429 會重送，429 照 Retry-After 等', () => {
    expect(classifyChunkFailure(new TypeError('Failed to fetch'))).toEqual({ retry: true, message: 'Failed to fetch' });
    expect(classifyChunkFailure(new HttpError(500, '寫不進去')).retry).toBe(true);
    expect(classifyChunkFailure(new HttpError(503, '上一段還在寫', 1))).toEqual({ retry: true, retryAfterMs: 1000, message: '上一段還在寫' });
    expect(classifyChunkFailure(new HttpError(429, '太頻繁', 7)).retryAfterMs).toBe(7000);
  });

  it('其他 4xx 是 server 明確拒收，不重送', () => {
    expect(classifyChunkFailure(new HttpError(409, '跳號'))).toEqual({ retry: false, message: '跳號' });
    expect(classifyChunkFailure(new HttpError(404, '找不到')).retry).toBe(false);
  });
});

describe('createChunkUploader', () => {
  const setup = (sendImpl: (seq: number, chunk: string) => Promise<void>) => {
    const statuses: UploaderStatus[] = [];
    const sleeps: number[] = [];
    const uploader = createChunkUploader<string>({
      send: sendImpl,
      classify: classifyChunkFailure,
      onStatus: (s) => statuses.push(s),
      sleep: async (ms) => { sleeps.push(ms); },
      retryDelaysMs: [10, 20],
    });
    return { uploader, statuses, sleeps };
  };

  it('依序送、一次一段，段號從 0 起算', async () => {
    const sent: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { uploader } = setup(async (seq, chunk) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      sent.push(`${seq}:${chunk}`);
      inFlight -= 1;
    });
    expect(uploader.push('a')).toBe(0);
    expect(uploader.push('b')).toBe(1);
    expect(uploader.push('c')).toBe(2);
    await uploader.flush();
    expect(sent).toEqual(['0:a', '1:b', '2:c']);
    expect(maxInFlight).toBe(1);
    expect(uploader.total()).toBe(3);
    expect(uploader.status()).toEqual({ sent: 3, waiting: 0, lastError: null, fatal: null });
  });

  it('送不到就等一下再送同一段，不跳過；等待照退避表、最後一個一直重複；送到後清掉錯誤', async () => {
    let failures = 3;
    const sent: number[] = [];
    const { uploader, statuses, sleeps } = setup(async (seq) => {
      if (seq === 0 && failures > 0) {
        failures -= 1;
        throw new TypeError('Failed to fetch');
      }
      sent.push(seq);
    });
    uploader.push('a');
    uploader.push('b');
    await uploader.flush();
    expect(sent).toEqual([0, 1]);
    expect(sleeps).toEqual([10, 20, 20]);
    // 畫面看得到「送不到、為什麼」，不是在背景安靜地重試
    expect(statuses.some((s) => s.lastError === 'Failed to fetch' && s.waiting === 2)).toBe(true);
    expect(uploader.status().lastError).toBeNull();
  });

  it('server 拒收（4xx）：停下來、之後的段落都不送，flush 拋出原因', async () => {
    const sent: number[] = [];
    const { uploader } = setup(async (seq) => {
      if (seq === 1) throw new HttpError(409, '段號跳了');
      sent.push(seq);
    });
    uploader.push('a');
    uploader.push('b');
    uploader.push('c');
    await expect(uploader.flush()).rejects.toThrow('第 1 段被 server 拒收：段號跳了');
    expect(sent).toEqual([0]);
    uploader.push('d');
    expect(uploader.status()).toMatchObject({ sent: 1, fatal: '第 1 段被 server 拒收：段號跳了' });
    // 拒收之後排進來的也算進總段數：停止時告訴 server 的段數要是真的錄了幾段
    expect(uploader.total()).toBe(4);
  });

  it('flush 在送的途中呼叫也會等到全部送完', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const sent: number[] = [];
    const { uploader } = setup(async (seq) => {
      if (seq === 0) await gate;
      sent.push(seq);
    });
    uploader.push('a');
    const flushed = uploader.flush();
    uploader.push('b');
    release();
    await flushed;
    expect(sent).toEqual([0, 1]);
  });

  it('abandon 等正在送的那一次請求結束才完成：呼叫端之後才叫 server 刪除或收尾', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let finished = false;
    const { uploader } = setup(async () => { await gate; finished = true; });
    uploader.push('a');
    let abandoned = false;
    const done = uploader.abandon().then(() => { abandoned = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(abandoned).toBe(false);
    release();
    await done;
    expect(finished).toBe(true);
  });

  it('flush 等到一半被 abandon：拋 UploaderAbandonedError，不當成送完了', async () => {
    const { uploader } = setup(async () => { throw new TypeError('offline'); });
    uploader.push('a');
    const flushed = uploader.flush();
    await uploader.abandon();
    await expect(flushed).rejects.toThrow(UploaderAbandonedError);
  });

  it('abandon 之後不再送、flush 馬上以「已放棄」結束', async () => {
    const sent: number[] = [];
    let fail = true;
    const { uploader } = setup(async (seq) => {
      if (fail) throw new TypeError('offline');
      sent.push(seq);
    });
    uploader.push('a');
    uploader.abandon();
    fail = false;
    uploader.push('b');
    await expect(uploader.flush()).rejects.toThrow(UploaderAbandonedError);
    expect(sent).toEqual([]);
  });
});

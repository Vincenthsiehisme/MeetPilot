import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandResult, CommandRunner, spawnCommandRunner } from './audioSlicer';
import {
  RECORDER_TIMEOUTS_MS,
  RECORDING_CHECK,
  RecorderTimeoutError,
  VOICE_MEMO_SHORTCUTS,
  checkFetchedRecording,
  createVoiceMemoRecorder,
} from './voiceMemoRecorder';

const T0 = Date.parse('2026-09-23T07:16:08.000Z');

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout: Buffer.from(stdout, 'utf8'), stderr: '' });

describe('checkFetchedRecording（AC-3：取回的是不是這場會的錄音）', () => {
  // 2026-09-23 實測那一支：開始 07:16:08、停止 07:16:19，檔案 10.28 秒、建立於 07:16:09
  const real = { durationSeconds: 10.282667, creationTimeMs: Date.parse('2026-09-23T07:16:09.000Z') };
  const window = { startedAt: T0, stoppedAt: T0 + 11_000 };

  it('實測那一支對得上', () => {
    expect(checkFetchedRecording(real, window)).toEqual({ ok: true });
  });

  it('沒有建立時間就不收：確認不了是不是這場會的', () => {
    const check = checkFetchedRecording({ ...real, creationTimeMs: null }, window);
    expect(check.ok).toBe(false);
    if (check.ok === false) expect(check.reason).toContain('沒有建立時間');
  });

  it('建立時間早於開始（前一支錄音）或晚於停止（之後同步進來的）都不收', () => {
    const before = checkFetchedRecording({ ...real, creationTimeMs: T0 - RECORDING_CHECK.creationSlackMs - 1 }, window);
    const after = checkFetchedRecording({ ...real, creationTimeMs: window.stoppedAt + RECORDING_CHECK.creationSlackMs + 1 }, window);
    expect(before.ok).toBe(false);
    expect(after.ok).toBe(false);
    if (before.ok === false) expect(before.reason).toContain('不在這場會的錄音期間');
  });

  it('建立時間只到秒：開始前一秒內（捨去誤差）照樣收', () => {
    expect(checkFetchedRecording({ ...real, creationTimeMs: T0 - 999 }, window)).toEqual({ ok: true });
  });

  it('檔案比實際錄的時間還長就不是這一支', () => {
    const check = checkFetchedRecording({ ...real, durationSeconds: 11 + RECORDING_CHECK.maxOverrunSeconds + 0.1 }, window);
    expect(check.ok).toBe(false);
    if (check.ok === false) expect(check.reason).toContain('還長');
  });

  it('檔案比實際錄的時間短太多就不收（中途停過、拿錯檔、還沒寫完）', () => {
    const tooShort = checkFetchedRecording({ ...real, durationSeconds: 11 - RECORDING_CHECK.maxStartDelaySeconds - 0.1 }, window);
    expect(tooShort.ok).toBe(false);
    if (tooShort.ok === false) expect(tooShort.reason).toContain(`容許 ${RECORDING_CHECK.maxStartDelaySeconds} 秒`);
    // 剛好落在容許範圍內的收
    expect(checkFetchedRecording({ ...real, durationSeconds: 11 - RECORDING_CHECK.maxStartDelaySeconds + 0.1 }, window))
      .toEqual({ ok: true });
  });

  it('容許範圍是寫死的決策：值改了要有人知道', () => {
    expect(RECORDING_CHECK).toEqual({ maxStartDelaySeconds: 10, maxOverrunSeconds: 3, creationSlackMs: 2000 });
  });
});

describe('createVoiceMemoRecorder', () => {
  let calls: { executable: string; args: readonly string[] }[];
  let dir: string;

  beforeEach(() => {
    calls = [];
    dir = mkdtempSync(join(tmpdir(), 'meetpilot-voicememo-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const recorderWith = (runner: CommandRunner, platform: NodeJS.Platform = 'darwin') =>
    createVoiceMemoRecorder({
      shortcutsPath: 'shortcuts',
      ffprobePath: 'ffprobe',
      platform,
      runner: async (executable, args) => {
        calls.push({ executable, args });
        return runner(executable, args);
      },
    });

  describe('checkAvailability（AC-5）', () => {
    it('三個捷徑都在就可以錄', async () => {
      const recorder = recorderWith(async () => ok(`別的捷徑\n${Object.values(VOICE_MEMO_SHORTCUTS).join('\n')}\n`));
      expect(await recorder.checkAvailability()).toEqual({ available: true });
      expect(calls).toEqual([{ executable: 'shortcuts', args: ['list'] }]);
    });

    it('少了哪一個就講哪一個，並指到建法', async () => {
      // 2026-09-23 實測踩過：第三個捷徑存成預設名稱「取得檔案夾的內容」
      const recorder = recorderWith(async () => ok(`取得檔案夾的內容\n${VOICE_MEMO_SHORTCUTS.start}\n${VOICE_MEMO_SHORTCUTS.stop}\n`));
      const result = await recorder.checkAvailability();
      expect(result.available).toBe(false);
      if (result.available === false) {
        expect(result.reason).toContain(`「${VOICE_MEMO_SHORTCUTS.fetch}」`);
        expect(result.reason).not.toContain(`「${VOICE_MEMO_SHORTCUTS.start}」`);
        expect(result.reason).toContain('README');
      }
    });

    it('不是 macOS 就不去跑 shortcuts，直接講原因', async () => {
      const recorder = recorderWith(async () => ok(), 'linux');
      const result = await recorder.checkAvailability();
      expect(result.available).toBe(false);
      if (result.available === false) expect(result.reason).toContain('只支援 macOS');
      expect(calls).toEqual([]);
    });

    it('找不到 shortcuts 指令時回「不可用」並講原因，不讓整條路由變 500', async () => {
      const recorder = recorderWith(async () => { throw Object.assign(new Error('spawn shortcuts ENOENT'), { code: 'ENOENT' }); });
      const result = await recorder.checkAvailability();
      expect(result.available).toBe(false);
      if (result.available === false) expect(result.reason).toContain('找不到 shortcuts');
    });
  });

  describe('開始、停止', () => {
    it('照名稱跑對應的捷徑', async () => {
      const recorder = recorderWith(async () => ok());
      await recorder.start();
      await recorder.stop();
      expect(calls).toEqual([
        { executable: 'shortcuts', args: ['run', VOICE_MEMO_SHORTCUTS.start] },
        { executable: 'shortcuts', args: ['run', VOICE_MEMO_SHORTCUTS.stop] },
      ]);
    });

    it('捷徑失敗時錯誤指出是哪一個捷徑', async () => {
      const recorder = recorderWith(async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'The operation couldn’t be completed.' }));
      await expect(recorder.start()).rejects.toThrow(`執行捷徑「${VOICE_MEMO_SHORTCUTS.start}」失敗`);
    });
  });

  describe('fetchLatestTo', () => {
    it('把 --output-path 交給取檔捷徑，檔案有寫出來就算成功', async () => {
      const dest = join(dir, 'out.part');
      const recorder = recorderWith(async (executable, args) => {
        writeFileSync(args[args.length - 1] as string, 'audio-bytes');
        return ok();
      });
      await recorder.fetchLatestTo(dest);
      expect(calls).toEqual([{ executable: 'shortcuts', args: ['run', VOICE_MEMO_SHORTCUTS.fetch, '--output-path', dest] }]);
    });

    it('捷徑回 0 但沒寫檔（過濾條件什麼都沒挑到）要講出來，不留給 ffprobe 去報一個看不懂的錯', async () => {
      const recorder = recorderWith(async () => ok());
      await expect(recorder.fetchLatestTo(join(dir, 'missing.part'))).rejects.toThrow(/沒有交出任何檔案/);
    });

    it('寫出空檔一樣算沒交出', async () => {
      const dest = join(dir, 'empty.part');
      const recorder = recorderWith(async () => { writeFileSync(dest, ''); return ok(); });
      await expect(recorder.fetchLatestTo(dest)).rejects.toThrow(/沒有交出任何檔案/);
    });
  });

  describe('probe', () => {
    it('讀出長度與建立時間', async () => {
      const recorder = recorderWith(async () => ok(JSON.stringify({
        format: { duration: '10.282667', tags: { creation_time: '2026-09-23T07:16:09.000000Z' } },
      })));
      expect(await recorder.probe('/tmp/a.part')).toEqual({
        durationSeconds: 10.282667,
        creationTimeMs: Date.parse('2026-09-23T07:16:09.000Z'),
      });
    });

    it('讀不出長度（例如拿到 .waveform 附屬檔）要指到捷徑的過濾條件', async () => {
      const recorder = recorderWith(async () => ok(JSON.stringify({ format: { duration: 'N/A' } })));
      await expect(recorder.probe('/tmp/a.part')).rejects.toThrow(/\.waveform/);
    });

    it('沒有建立時間回 null，交給 checkFetchedRecording 擋，不補一個假的時間', async () => {
      const recorder = recorderWith(async () => ok(JSON.stringify({ format: { duration: '5' } })));
      expect(await recorder.probe('/tmp/a.part')).toEqual({ durationSeconds: 5, creationTimeMs: null });
    });
  });
});

describe('捷徑呼叫的逾時（2026-09-23 實測 shortcuts run 會間歇性卡住）', () => {
  // 永遠不回來的 runner，記下自己有沒有被中止
  const hanging = (aborted: string[]): CommandRunner => (executable, args, signal) =>
    new Promise<CommandResult>((_, reject) => {
      signal?.addEventListener('abort', () => {
        aborted.push(String(args[1] ?? args[0]));
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });

  const recorderWith = (runner: CommandRunner) => createVoiceMemoRecorder({
    shortcutsPath: 'shortcuts',
    ffprobePath: 'ffprobe',
    platform: 'darwin',
    runner,
    timeouts: { list: 20, start: 20, stop: 20, fetch: 20, probe: 20 },
  });

  it('開始卡住：逾時錯誤講出是哪個捷徑、提示可能晚一點才開始，而且真的中止了子程序', async () => {
    const aborted: string[] = [];
    const error = await recorderWith(hanging(aborted)).start().catch(e => e);
    expect(error).toBeInstanceOf(RecorderTimeoutError);
    expect(error.message).toContain(`執行捷徑「${VOICE_MEMO_SHORTCUTS.start}」超過`);
    expect(error.message).toContain('晚一點才開始錄');
    expect(aborted).toEqual([VOICE_MEMO_SHORTCUTS.start]);
  });

  it('停止、取檔、讀長度卡住一樣會逾時，不會永遠掛著', async () => {
    const recorder = recorderWith(hanging([]));
    await expect(recorder.stop()).rejects.toBeInstanceOf(RecorderTimeoutError);
    await expect(recorder.fetchLatestTo('/tmp/never')).rejects.toBeInstanceOf(RecorderTimeoutError);
    await expect(recorder.probe('/tmp/never')).rejects.toBeInstanceOf(RecorderTimeoutError);
  });

  it('列捷徑卡住時回「不可用」並講原因，不讓錄音按鍵的判斷掛著', async () => {
    const result = await recorderWith(hanging([])).checkAvailability();
    expect(result.available).toBe(false);
    if (result.available === false) expect(result.reason).toContain('列出捷徑超過');
  });

  it('逾時上限是寫死的決策：值改了要有人知道', () => {
    expect(RECORDER_TIMEOUTS_MS).toEqual({ list: 10_000, start: 20_000, stop: 20_000, fetch: 15_000, probe: 30_000 });
  });
});

describe('spawnCommandRunner 的中止（真的 spawn）', () => {
  it('abort 之後子程序被砍掉、Promise 以錯誤結束，不等它自己跑完', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = spawnCommandRunner('sleep', ['5'], controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('沒給 signal 時照舊跑完（ffmpeg 那邊不受影響）', async () => {
    const result = await spawnCommandRunner('sh', ['-c', 'printf ok']);
    expect(result).toEqual({ code: 0, stdout: Buffer.from('ok'), stderr: '' });
  });
});

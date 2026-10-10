import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandResult,
  CommandRunner,
  createAudioSlicer,
  planSlices,
  resolveFfmpegPaths,
} from './audioSlicer';

// 假的 runner：測試機器上不一定有 ffmpeg（寫這份測試的機器就沒有），
// 而切片規則與錯誤處理跟「spawn 出來的東西會不會動」是兩件事
const fakeRunner = (
  result: Partial<CommandResult> | ((executable: string, args: readonly string[]) => Partial<CommandResult>),
  calls: { executable: string; args: readonly string[] }[] = [],
): CommandRunner => async (executable, args) => {
  calls.push({ executable, args });
  const r = typeof result === 'function' ? result(executable, args) : result;
  // 'code' in r 而不是 r.code ?? 0：被訊號殺掉時 code 就是 null，?? 會把它當沒給而變成 0
  return { code: 'code' in r ? r.code : 0, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? '' };
};

const throwingRunner = (err: unknown): CommandRunner => async () => { throw err; };

// node:fs 的 ESM 匯出不能 vi.spyOn，只能整個模組換掉，其餘原樣代理給真實實作（同 geminiServerClient.test.ts）。
// 預設 rmSync 照真的刪；只有測「暫存檔刪不掉」那一條才覆寫
const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => rmSyncMock(...args) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
beforeEach(() => {
  rmSyncMock.mockImplementation((...args: Parameters<typeof realFs.rmSync>) => realFs.rmSync(...args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('planSlices', () => {
  it('總長剛好等於一片長度時只有一片，不多排一片空的', () => {
    expect(planSlices(600, 600, 15)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 600 },
    ]);
  });

  it('最後一片短於一片長度時回報實際長度，不回報名目長度', () => {
    expect(planSlices(1500, 600, 15)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 615 },
      { index: 1, startSeconds: 600, durationSeconds: 615 },
      { index: 2, startSeconds: 1200, durationSeconds: 300 },
    ]);
  });

  it('總長小於一片長度時是一片，長度等於總長', () => {
    expect(planSlices(42.5, 600, 15)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 42.5 },
    ]);
  });

  it('相鄰兩片重疊 overlap 秒，mergeSliceTranscript 靠這段去重', () => {
    const plan = planSlices(1500, 600, 15);
    const firstEnd = plan[0].startSeconds + plan[0].durationSeconds;
    expect(firstEnd - plan[1].startSeconds).toBe(15);
  });

  it.each([0, -1, NaN, Infinity, '600' as unknown as number, null as unknown as number])(
    '總長不是有限正數（%s）時拋錯，不回空陣列',
    (bad) => {
      expect(() => planSlices(bad, 600, 15)).toThrow(/音訊總長度必須是有限正數/);
    },
  );

  it('切片長度或 overlap 不合法時也拋錯', () => {
    expect(() => planSlices(600, 0, 15)).toThrow(/切片長度必須是有限正數/);
    expect(() => planSlices(600, 600, -1)).toThrow(/overlap 必須是有限非負數/);
  });

  it('是純函式：同輸入同輸出，不碰任何 I/O', () => {
    expect(planSlices(1500, 600, 15)).toEqual(planSlices(1500, 600, 15));
  });
});

describe('resolveFfmpegPaths', () => {
  it('沒設就走 PATH 上的 ffmpeg / ffprobe', () => {
    expect(resolveFfmpegPaths({})).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  });

  it('設了就用設的，前後空白不算', () => {
    expect(resolveFfmpegPaths({ MEETPILOT_FFMPEG: ' /opt/bin/ffmpeg ', MEETPILOT_FFPROBE: '/opt/bin/ffprobe' }))
      .toEqual({ ffmpeg: '/opt/bin/ffmpeg', ffprobe: '/opt/bin/ffprobe' });
  });

  it('設成空字串等同沒設，不拿空字串去 spawn', () => {
    expect(resolveFfmpegPaths({ MEETPILOT_FFMPEG: '   ' }).ffmpeg).toBe('ffmpeg');
  });
});

describe('probeDurationRemuxingIfMissing：讀長度', () => {
  it('照契約的參數呼叫 ffprobe 並解析長度', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: '/opt/ffprobe',
      runner: fakeRunner({ stdout: Buffer.from('6382.351000\n') }, calls),
    });

    expect(await slicer.probeDurationRemuxingIfMissing('/tmp/a.audio')).toBe(6382.351);
    expect(calls[0].executable).toBe('/opt/ffprobe');
    expect(calls[0].args).toEqual([
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '/tmp/a.audio',
    ]);
  });

  it('結束碼非 0 時拋錯，訊息帶 stderr 尾段', async () => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      runner: fakeRunner({ code: 1, stderr: 'x'.repeat(50) + '\n/tmp/a.audio: Invalid data found when processing input' }),
    });
    await expect(slicer.probeDurationRemuxingIfMissing('/tmp/a.audio'))
      .rejects.toThrow(/Invalid data found when processing input/);
  });
});

describe('probeDurationRemuxingIfMissing（AC-7：瀏覽器錄的 webm 沒寫長度）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'meetpilot-remux-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** ffprobe 依序回 durations 裡的值；ffmpeg 把 remuxOutput 寫到它的輸出路徑（最後一個參數） */
  const scripted = (durations: string[], calls: { executable: string; args: readonly string[] }[], remux: { code?: number; output?: string } = {}): CommandRunner =>
    async (executable, args) => {
      calls.push({ executable, args });
      if (executable === 'ffprobe') return { code: 0, stdout: Buffer.from(durations.shift() ?? ''), stderr: '' };
      if ((remux.code ?? 0) === 0) writeFileSync(args[args.length - 1] as string, remux.output ?? 'remuxed');
      return { code: remux.code ?? 0, stdout: Buffer.alloc(0), stderr: remux.code ? 'Invalid data found' : '' };
    };

  it('讀得到長度就直接回，不去 remux', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: scripted(['61.5'], calls) });
    expect(await slicer.probeDurationRemuxingIfMissing(join(dir, 'a.audio'))).toBe(61.5);
    expect(calls.map(c => c.executable)).toEqual(['ffprobe']);
  });

  it('N/A 時 -c copy remux 成 matroska 蓋回原檔，再讀一次長度', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const file = join(dir, 'a.audio');
    writeFileSync(file, 'webm-without-duration');
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: scripted(['N/A', '2.459000'], calls) });

    expect(await slicer.probeDurationRemuxingIfMissing(file)).toBe(2.459);
    expect(calls.map(c => c.executable)).toEqual(['ffprobe', 'ffmpeg', 'ffprobe']);
    const remuxArgs = calls[1].args;
    expect(remuxArgs.slice(0, -1)).toEqual(['-v', 'error', '-y', '-i', file, '-c', 'copy', '-f', 'matroska']);
    expect(remuxArgs[remuxArgs.length - 1]).toMatch(/\.part$/);
    expect(readFileSync(file, 'utf8')).toBe('remuxed');
    expect(readdirSync(dir)).toEqual(['a.audio']);
  });

  it('remux 失敗：原檔不動、暫存檔清掉、錯誤往上拋', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const file = join(dir, 'a.audio');
    writeFileSync(file, 'original');
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: scripted(['N/A'], calls, { code: 1 }) });

    await expect(slicer.probeDurationRemuxingIfMissing(file)).rejects.toThrow(/remux/);
    expect(readFileSync(file, 'utf8')).toBe('original');
    expect(readdirSync(dir)).toEqual(['a.audio']);
  });

  it('remux 失敗又刪不掉暫存檔（EBUSY）：拋的是 remux 的錯誤，不被刪檔錯誤蓋掉，只 warn 路徑與錯誤碼', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSyncMock.mockImplementation((path: string, ...rest: unknown[]) => {
      if (String(path).endsWith('.part')) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY' });
      }
      return (realFs.rmSync as (...args: unknown[]) => void)(path, ...rest);
    });
    const file = join(dir, 'a.audio');
    writeFileSync(file, 'original');
    let partPath = '';
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      runner: async (executable, args) => {
        if (executable === 'ffprobe') return { code: 0, stdout: Buffer.from('N/A'), stderr: '' };
        // 真的 ffmpeg 失敗時可能已經寫了半個檔
        partPath = args[args.length - 1] as string;
        writeFileSync(partPath, 'half');
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'Invalid data found' };
      },
    });

    await expect(slicer.probeDurationRemuxingIfMissing(file)).rejects.toThrow(/remux.*Invalid data found/);
    expect(readFileSync(file, 'utf8')).toBe('original');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain(partPath);
    expect(String(warn.mock.calls[0].join(' '))).toContain('EBUSY');
  });

  it('remux 之後還是讀不到長度就照原本的錯誤爆，不塞一個假長度', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const file = join(dir, 'a.audio');
    writeFileSync(file, 'x');
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: scripted(['N/A', 'N/A'], calls) });
    await expect(slicer.probeDurationRemuxingIfMissing(file)).rejects.toThrow(/沒有回出有限正數的長度/);
  });

  it.each([['0'], ['']])('N/A 以外讀不出長度（%s）代表檔案本身有問題，不 remux', async (raw) => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: scripted([raw], calls) });
    await expect(slicer.probeDurationRemuxingIfMissing(join(dir, 'a.audio'))).rejects.toThrow(/沒有回出有限正數的長度/);
    expect(calls.map(c => c.executable)).toEqual(['ffprobe']);
  });
});

describe('readSlice', () => {
  let dir: string;
  let audio: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetpilot-slice-'));
    audio = join(dir, 'a.audio');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** ffmpeg 把 content 寫到輸出路徑（最後一個參數），跟真的 ffmpeg 寫 FLAC 一樣 */
  const writingRunner = (content: string, calls: { executable: string; args: readonly string[] }[] = []): CommandRunner =>
    async (executable, args) => {
      calls.push({ executable, args });
      writeFileSync(args[args.length - 1] as string, content);
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    };

  it('flac：-ss 與 -t 在 -i 前面，16kHz 單聲道 16-bit FLAC 寫到音檔旁的 .part 再讀回來，暫存檔不留', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({ ffmpegPath: '/opt/ffmpeg', ffprobePath: 'ffprobe', runner: writingRunner('fLaC....', calls) });

    const flac = await slicer.readSlice(audio, 600, 615, 'flac');
    expect(flac.toString('utf8')).toBe('fLaC....');
    expect(calls[0].executable).toBe('/opt/ffmpeg');
    const outPath = calls[0].args[calls[0].args.length - 1] as string;
    expect(calls[0].args).toEqual([
      '-y', '-ss', '600', '-t', '615', '-i', audio, '-ar', '16000', '-ac', '1',
      '-sample_fmt', 's16', '-c:a', 'flac', '-f', 'flac', outPath,
    ]);
    // 不寫 pipe：FLAC 的長度要寫完回頭補，pipe 不能回頭
    expect(outPath.startsWith(`${audio}.slice-`)).toBe(true);
    expect(outPath.endsWith('.part')).toBe(true);
    expect(calls[0].args.indexOf('-ss')).toBeLessThan(calls[0].args.indexOf('-i'));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('暫存檔刪不掉（Windows 防毒或 OneDrive 鎖住，EBUSY）時照樣回傳切片，只 warn 路徑與錯誤碼', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSyncMock.mockImplementation((path: string, ...rest: unknown[]) => {
      if (String(path).endsWith('.part')) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY' });
      }
      return (realFs.rmSync as (...args: unknown[]) => void)(path, ...rest);
    });
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: writingRunner('fLaC....', calls) });

    const flac = await slicer.readSlice(audio, 0, 10, 'flac');

    expect(flac.toString('utf8')).toBe('fLaC....');
    const outPath = calls[0].args[calls[0].args.length - 1] as string;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain(outPath);
    expect(String(warn.mock.calls[0].join(' '))).toContain('EBUSY');
  });

  it('ffmpeg 失敗又刪不掉暫存檔時，拋的是 ffmpeg 的錯誤，不被刪檔錯誤蓋掉', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSyncMock.mockImplementation((path: string, ...rest: unknown[]) => {
      if (String(path).endsWith('.part')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return (realFs.rmSync as (...args: unknown[]) => void)(path, ...rest);
    });
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ code: 1, stderr: 'Invalid data found' }),
    });

    await expect(slicer.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/結束碼 1.*Invalid data found/);
  });

  it('wav：給音量檢查用，維持 16kHz 單聲道 WAV 寫到 stdout', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: '/opt/ffmpeg',
      ffprobePath: 'ffprobe',
      runner: fakeRunner({ stdout: Buffer.from('RIFF....WAVE') }, calls),
    });

    const wav = await slicer.readSlice(audio, 600, 615, 'wav');
    expect(wav.toString('utf8')).toBe('RIFF....WAVE');
    expect(calls[0].args).toEqual([
      '-ss', '600', '-t', '615', '-i', audio, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
    ]);
  });

  it('結束碼非 0 時拋錯且訊息含 stderr 尾段，暫存檔不留', async () => {
    const stderr = 'ffmpeg version 7.1 banner…\n'.repeat(200) + 'Output file #0 does not contain any stream';
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      runner: async (_executable, args) => {
        // 真的 ffmpeg 失敗時可能已經寫了半個檔
        writeFileSync(args[args.length - 1] as string, 'half');
        return { code: 2, stdout: Buffer.alloc(0), stderr };
      },
    });

    await expect(slicer.readSlice(audio, 0, 615, 'flac')).rejects.toThrow(/結束碼 2/);
    await expect(slicer.readSlice(audio, 0, 615, 'flac'))
      .rejects.toThrow(/Output file #0 does not contain any stream/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('被訊號殺掉（code 為 null）也算失敗，不當成成功', async () => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ code: null, stderr: 'killed' }),
    });
    await expect(slicer.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/結束碼 null/);
    await expect(slicer.readSlice(audio, 0, 10, 'wav')).rejects.toThrow(/結束碼 null/);
  });

  it('結束碼 0 但沒有輸出時拋錯，不把空音檔送給 Gemini', async () => {
    const empty = createAudioSlicer({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: writingRunner('') });
    await expect(empty.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/沒有輸出任何資料/);
    // 連檔案都沒寫出來：一樣是沒有輸出，不讓 ENOENT 蓋掉原因
    const missing = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ stdout: Buffer.alloc(0) }),
    });
    await expect(missing.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/沒有輸出任何資料/);
    await expect(missing.readSlice(audio, 0, 10, 'wav')).rejects.toThrow(/沒有輸出任何資料/);
  });

  it('spawn 是 ENOENT 時訊息要指出缺 ffmpeg，不丟原始 spawn 錯誤', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: throwingRunner(enoent),
    });

    await expect(slicer.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/請先安裝/);
    await expect(slicer.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/MEETPILOT_FFMPEG/);
  });

  it('ENOENT 以外的 spawn 錯誤原樣往上拋，不包成安裝問題', async () => {
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: throwingRunner(denied),
    });
    await expect(slicer.readSlice(audio, 0, 10, 'flac')).rejects.toThrow(/EACCES/);
  });

  it('起點或片長不合法時在呼叫 ffmpeg 之前就拋錯', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ stdout: Buffer.from('x') }, calls),
    });

    await expect(slicer.readSlice(audio, -1, 10, 'flac')).rejects.toThrow(/起點必須是非負有限數/);
    await expect(slicer.readSlice(audio, 0, 0, 'flac')).rejects.toThrow(/片長必須是有限正數/);
    expect(calls).toHaveLength(0);
  });
});

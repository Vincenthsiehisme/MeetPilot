import { describe, it, expect } from 'vitest';
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

describe('probeDurationSeconds', () => {
  it('照契約的參數呼叫 ffprobe 並解析長度', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: '/opt/ffprobe',
      runner: fakeRunner({ stdout: Buffer.from('6382.351000\n') }, calls),
    });

    expect(await slicer.probeDurationSeconds('/tmp/a.audio')).toBe(6382.351);
    expect(calls[0].executable).toBe('/opt/ffprobe');
    expect(calls[0].args).toEqual([
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '/tmp/a.audio',
    ]);
  });

  it.each([['N/A'], [''], ['0']])('長度解不出有限正數（%s）時拋錯，不回 0 也不回 Infinity', async (raw) => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ stdout: Buffer.from(raw) }),
    });
    await expect(slicer.probeDurationSeconds('/tmp/a.audio')).rejects.toThrow(/沒有回出有限正數的長度/);
  });

  it('結束碼非 0 時拋錯，訊息帶 stderr 尾段', async () => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      runner: fakeRunner({ code: 1, stderr: 'x'.repeat(50) + '\n/tmp/a.audio: Invalid data found when processing input' }),
    });
    await expect(slicer.probeDurationSeconds('/tmp/a.audio'))
      .rejects.toThrow(/Invalid data found when processing input/);
  });
});

describe('readSlice', () => {
  it('照契約的參數呼叫 ffmpeg：-ss 與 -t 在 -i 前面，輸出 16kHz 單聲道 WAV 到 stdout', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: '/opt/ffmpeg',
      ffprobePath: 'ffprobe',
      runner: fakeRunner({ stdout: Buffer.from('RIFF....WAVE') }, calls),
    });

    const wav = await slicer.readSlice('/tmp/a.audio', 600, 615);
    expect(wav.toString('utf8')).toBe('RIFF....WAVE');
    expect(calls[0].executable).toBe('/opt/ffmpeg');
    expect(calls[0].args).toEqual([
      '-ss', '600', '-t', '615', '-i', '/tmp/a.audio', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
    ]);
    expect(calls[0].args.indexOf('-ss')).toBeLessThan(calls[0].args.indexOf('-i'));
  });

  it('結束碼非 0 時拋錯且訊息含 stderr 尾段', async () => {
    const stderr = 'ffmpeg version 7.1 banner…\n'.repeat(200) + 'Output file #0 does not contain any stream';
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ code: 2, stderr }),
    });

    await expect(slicer.readSlice('/tmp/a.audio', 0, 615)).rejects.toThrow(/結束碼 2/);
    await expect(slicer.readSlice('/tmp/a.audio', 0, 615))
      .rejects.toThrow(/Output file #0 does not contain any stream/);
  });

  it('被訊號殺掉（code 為 null）也算失敗，不當成成功', async () => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ code: null, stderr: 'killed' }),
    });
    await expect(slicer.readSlice('/tmp/a.audio', 0, 10)).rejects.toThrow(/結束碼 null/);
  });

  it('結束碼 0 但沒有輸出時拋錯，不把空音檔送給 Gemini', async () => {
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ stdout: Buffer.alloc(0) }),
    });
    await expect(slicer.readSlice('/tmp/a.audio', 0, 10)).rejects.toThrow(/沒有輸出任何資料/);
  });

  it('spawn 是 ENOENT 時訊息要指出缺 ffmpeg，不丟原始 spawn 錯誤', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: throwingRunner(enoent),
    });

    await expect(slicer.readSlice('/tmp/a.audio', 0, 10)).rejects.toThrow(/請先安裝/);
    await expect(slicer.readSlice('/tmp/a.audio', 0, 10)).rejects.toThrow(/MEETPILOT_FFMPEG/);
  });

  it('ENOENT 以外的 spawn 錯誤原樣往上拋，不包成安裝問題', async () => {
    const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: throwingRunner(denied),
    });
    await expect(slicer.readSlice('/tmp/a.audio', 0, 10)).rejects.toThrow(/EACCES/);
  });

  it('起點或片長不合法時在呼叫 ffmpeg 之前就拋錯', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const slicer = createAudioSlicer({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runner: fakeRunner({ stdout: Buffer.from('x') }, calls),
    });

    await expect(slicer.readSlice('/tmp/a.audio', -1, 10)).rejects.toThrow(/起點必須是非負有限數/);
    await expect(slicer.readSlice('/tmp/a.audio', 0, 0)).rejects.toThrow(/片長必須是有限正數/);
    expect(calls).toHaveLength(0);
  });
});

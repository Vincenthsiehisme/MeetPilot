import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SILENT_PEAK_DBFS, WavFormatError, isSilent, wavLevel } from './audioLevel';
import { pipeStyleWav, silentWav, toneWav } from './wavFixture';

describe('wavLevel', () => {
  it('ffmpeg 寫到 pipe 的形狀（長度是 0xFFFFFFFF、中間夾 LIST）也讀得到 data', () => {
    const level = wavLevel(toneWav(16384));
    expect(level.seconds).toBe(1);
    // 振幅 16384 是滿格的一半，約 -6 dBFS
    expect(level.peakDbfs).toBeCloseTo(-6.02, 1);
  });

  it('全是 0 → -Infinity，算沒聲音', () => {
    const level = wavLevel(silentWav());
    expect(level.peakDbfs).toBe(-Infinity);
    expect(isSilent(level)).toBe(true);
  });

  it('門檻是 -45 dBFS：低於它算沒聲音，高於它算有', () => {
    expect(SILENT_PEAK_DBFS).toBe(-45);
    // -45 dBFS 約是振幅 184
    expect(isSilent(wavLevel(pipeStyleWav([0, 150, -150, 0])))).toBe(true);
    expect(isSilent(wavLevel(pipeStyleWav([0, 250, -250, 0])))).toBe(false);
  });

  it('只看最大值：一整秒底噪裡有一個大聲的取樣就算有聲音', () => {
    const samples = new Array(16000).fill(3);
    samples[8000] = -20000;
    expect(isSilent(wavLevel(pipeStyleWav(samples)))).toBe(false);
  });

  it('data 長度是真的值時照它讀，不讀到後面多出來的 chunk', () => {
    const wav = pipeStyleWav([100, -100]);
    // 把 data 長度改成 2（只含第一個取樣），後面接一段會讓最大值變大的垃圾
    const dataAt = wav.indexOf('data');
    wav.writeUInt32LE(2, dataAt + 4);
    const withTrailer = Buffer.concat([wav, Buffer.from([0xff, 0x7f])]);
    expect(wavLevel(withTrailer).peakDbfs).toBeCloseTo(20 * Math.log10(100 / 32768), 5);
  });

  it.each([
    ['不是 RIFF', Buffer.from('wav@0')],
    ['只有表頭', Buffer.from('RIFF\xff\xff\xff\xffWAVE', 'latin1')],
  ])('%s → 拋，不當成有聲音放行', (_label, buf) => {
    expect(() => wavLevel(buf)).toThrow(WavFormatError);
  });

  it('LIST chunk 長度是奇數時跳過補位的那個 byte（ffmpeg 版本字串一換長度就可能是奇數）', () => {
    const wav = pipeStyleWav([0, 5000, 0]);
    const listAt = wav.indexOf('LIST');
    const listSize = wav.readUInt32LE(listAt + 4);
    // 把 LIST 內容縮短一個 byte 變成奇數長度，後面補一個 0 當補位，data 往後挪不動
    const odd = Buffer.concat([
      wav.subarray(0, listAt + 4),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(listSize - 1, 0); return b; })(),
      wav.subarray(listAt + 8, listAt + 8 + listSize - 1),
      Buffer.from([0]),
      wav.subarray(listAt + 8 + listSize),
    ]);
    expect(wavLevel(odd).peakDbfs).toBeCloseTo(20 * Math.log10(5000 / 32768), 5);
  });

  it('不是 16-bit PCM → 拋', () => {
    const wav = pipeStyleWav([0, 1]);
    wav.writeUInt16LE(3, wav.indexOf('fmt ') + 8); // IEEE float
    expect(() => wavLevel(wav)).toThrow('16-bit PCM');
  });

  // 真的 ffmpeg 切出來的 WAV（跟 server 同一組參數）讀得懂：本機有編好的隨附 ffmpeg 才跑
  const ffmpeg = join(process.cwd(), 'vendor', 'ffmpeg', `${process.platform === 'win32' ? 'win' : 'mac'}-${process.arch}`,
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  it.skipIf(!existsSync(ffmpeg))('隨附 ffmpeg 切出來的語音備忘錄 WAV 有聲音', () => {
    const wav = execFileSync(ffmpeg, [
      '-v', 'error', '-ss', '0', '-t', '2', '-i', join('scripts', 'ffmpeg-fixtures', 'alac.m4a'),
      '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
    ]);
    const level = wavLevel(wav);
    expect(level.seconds).toBeGreaterThan(1.9);
    expect(isSilent(level)).toBe(false);
  });
});

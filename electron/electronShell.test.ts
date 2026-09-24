import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServerEnv } from './serverEnv';
import { createLogTail } from './logTail';
import { resolveBundledFfmpeg } from './bundledFfmpeg';

describe('buildServerEnv', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/u', SystemRoot: 'C:\\Windows' };

  it('資料路徑全部在 userData 底下，只綁 127.0.0.1，正式模式', () => {
    const env = buildServerEnv({ baseEnv: base, userDataDir: '/data/MeetPilot', port: 51234 });
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '51234',
      MEETPILOT_DB: join('/data/MeetPilot', 'meetpilot.db'),
      MEETPILOT_AUDIO_DIR: join('/data/MeetPilot', 'audio'),
      MEETPILOT_LLM_LOG: join('/data/MeetPilot', 'logs', 'llm.jsonl'),
      MEETPILOT_VAULT: join('/data/MeetPilot', 'vault'),
    });
  });

  it('投影資料夾沒指定時不落到 server 預設的 ~/MeetPilot Vault（那是網頁版在用的），指定了就用指定的', () => {
    expect(buildServerEnv({ baseEnv: { MEETPILOT_VAULT: '/Users/u/MeetPilot Vault' }, userDataDir: '/d', port: 1 }).MEETPILOT_VAULT)
      .toBe(join('/d', 'vault'));
    expect(buildServerEnv({ baseEnv: {}, userDataDir: '/d', port: 1, vaultDir: '/shared/records' }).MEETPILOT_VAULT)
      .toBe('/shared/records');
  });

  it('隨附的 ffmpeg 路徑傳給 server；沒給就不設，使用者 shell 裡的 MEETPILOT_FFMPEG 也不會漏進去', () => {
    const bundled = buildServerEnv({ baseEnv: {}, userDataDir: '/d', port: 1, ffmpeg: { ffmpeg: '/r/ffmpeg/ffmpeg', ffprobe: '/r/ffmpeg/ffprobe' } });
    expect(bundled.MEETPILOT_FFMPEG).toBe('/r/ffmpeg/ffmpeg');
    expect(bundled.MEETPILOT_FFPROBE).toBe('/r/ffmpeg/ffprobe');
    const dev = buildServerEnv({ baseEnv: { MEETPILOT_FFMPEG: '/opt/x/ffmpeg' }, userDataDir: '/d', port: 1 });
    expect(dev).not.toHaveProperty('MEETPILOT_FFMPEG');
    expect(dev).not.toHaveProperty('MEETPILOT_FFPROBE');
  });

  it('系統變數照傳：子程序要靠 PATH 找 ffmpeg、Windows 要 SystemRoot', () => {
    const env = buildServerEnv({ baseEnv: base, userDataDir: '/d', port: 1 });
    expect(env).toMatchObject(base);
  });

  it('使用者 shell 裡剛好設了 server 設定同名的變數，一律不往下傳，也蓋不過外殼給的值', () => {
    const env = buildServerEnv({
      baseEnv: {
        ...base,
        HOST: '0.0.0.0',
        PORT: '3000',
        MEETPILOT_DB: '/tmp/other.db',
        MEETPILOT_BASIC_AUTH_USER: 'u',
        MEETPILOT_LINKING: 'off',
        GEMINI_API_KEY: 'from-shell',
      },
      userDataDir: '/d',
      port: 5000,
    });
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe('5000');
    expect(env.MEETPILOT_DB).toBe(join('/d', 'meetpilot.db'));
    expect(env).not.toHaveProperty('MEETPILOT_BASIC_AUTH_USER');
    expect(env).not.toHaveProperty('MEETPILOT_LINKING');
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
  });

  it('大小寫不同的同名變數也擋：Windows 的環境變數名稱不分大小寫', () => {
    const env = buildServerEnv({
      baseEnv: { meetpilot_basic_auth_user: 'u', MeetPilot_Linking: 'off', Port: '3000', gemini_api_key: 'k', Path: 'C:\\bin' },
      userDataDir: '/d',
      port: 5000,
    });
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('MEETPILOT_BASIC_AUTH_USER');
    expect(env).not.toHaveProperty('MeetPilot_Linking');
    expect(env).not.toHaveProperty('Port');
    expect(env).not.toHaveProperty('gemini_api_key');
    expect(env.Path).toBe('C:\\bin');
  });

  it('有給 Gemini key 才帶；空白的 key 不帶，不拿空字串頂替', () => {
    expect(buildServerEnv({ baseEnv: {}, userDataDir: '/d', port: 1, geminiApiKey: ' k ' }).GEMINI_API_KEY).toBe('k');
    expect(buildServerEnv({ baseEnv: {}, userDataDir: '/d', port: 1, geminiApiKey: '  ' })).not.toHaveProperty('GEMINI_API_KEY');
  });
});

describe('createLogTail', () => {
  it('只留最後 N 行，斷在行中間的那段等下一段接上', () => {
    const tail = createLogTail(3);
    tail.push('a\nb\nc');
    tail.push('c-end\nd\n');
    expect(tail.lines()).toEqual(['b', 'cc-end', 'd']);
  });

  it('Windows 的 \\r\\n 也當換行，還沒換行的最後一段也看得到', () => {
    const tail = createLogTail(5);
    tail.push('x\r\ny\r\nlast');
    expect(tail.lines()).toEqual(['x', 'y', 'last']);
  });
});

describe('resolveBundledFfmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meetpilot-ffmpeg-'));
  const withBinaries = (sub: string, exe = '') => {
    const d = join(dir, sub);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `ffmpeg${exe}`), '');
    writeFileSync(join(d, `ffprobe${exe}`), '');
    return d;
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('打包後用 resources/ffmpeg；Windows 帶 .exe', () => {
    const res = join(dir, 'res-win');
    withBinaries(join('res-win', 'ffmpeg'), '.exe');
    expect(resolveBundledFfmpeg({ isPackaged: true, resourcesPath: res, appPath: '/x', platform: 'win32', arch: 'x64' }))
      .toEqual({ ffmpeg: join(res, 'ffmpeg', 'ffmpeg.exe'), ffprobe: join(res, 'ffmpeg', 'ffprobe.exe') });
  });

  it('打包後缺檔直接拋，不退回 PATH：記錄人的電腦上本來就沒有 ffmpeg', () => {
    expect(() => resolveBundledFfmpeg({ isPackaged: true, resourcesPath: join(dir, 'nothing'), appPath: '/x', platform: 'darwin', arch: 'arm64' }))
      .toThrow(/安裝檔裡少了 ffmpeg/);
  });

  it('開發時用 vendor/ffmpeg/<平台>-<架構>，沒編過就回 undefined 讓 server 走 PATH', () => {
    const app = join(dir, 'app');
    withBinaries(join('app', 'vendor', 'ffmpeg', 'mac-arm64'));
    expect(resolveBundledFfmpeg({ isPackaged: false, resourcesPath: '/r', appPath: app, platform: 'darwin', arch: 'arm64' })?.ffmpeg)
      .toBe(join(app, 'vendor', 'ffmpeg', 'mac-arm64', 'ffmpeg'));
    expect(resolveBundledFfmpeg({ isPackaged: false, resourcesPath: '/r', appPath: app, platform: 'darwin', arch: 'x64' })).toBeUndefined();
  });
});

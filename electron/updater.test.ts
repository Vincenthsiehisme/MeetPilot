import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PENDING_UPDATE_FILE, UPDATE_FOLDER_NAME, UPDATE_MANIFEST_NAME, UpdateManifestError, UpdateVerifyError, WINDOWS_INSTALL_ARGS,
  checkForUpdate, compareVersions, describeUpdateCheck, parsePendingUpdate, parseUpdateManifest, pendingUpdateDone,
  stageInstaller, updateFolderFor,
} from './updater';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tempRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'meetpilot-updater-'));
  roots.push(r);
  return r;
};
const sha512 = (data: Buffer | string) => createHash('sha512').update(data).digest('hex');

const INSTALLER = Buffer.from('fake installer bytes for win x64');
const artifact = (over: Record<string, unknown> = {}) => ({
  platform: 'win32', arch: 'x64', file: 'MeetPilot-0.2.0-win-x64.exe', size: INSTALLER.length, sha512: sha512(INSTALLER), ...over,
});
const manifestText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, version: '0.2.0', artifacts: [artifact()], ...over });

/** 建一個 `_更新/` 資料夾，放清單與（可選的）安裝檔 */
function updateFolder(opts: { manifest?: string; installer?: Buffer | null } = {}): string {
  const folder = join(tempRoot(), UPDATE_FOLDER_NAME);
  mkdirSync(folder);
  if (opts.manifest !== undefined) writeFileSync(join(folder, UPDATE_MANIFEST_NAME), opts.manifest);
  if (opts.installer !== null) writeFileSync(join(folder, 'MeetPilot-0.2.0-win-x64.exe'), opts.installer ?? INSTALLER);
  return folder;
}
const win = { currentVersion: '0.1.0', platform: 'win32' as NodeJS.Platform, arch: 'x64' };

describe('compareVersions', () => {
  it('逐段比數字，不是比字串', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.1', '0.2.10')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
  });

  it('不是「數字.數字.數字」就拋，不當成比較小', () => {
    for (const bad of ['0.2', '0.2.0-beta', 'v0.2.0', '01.2.0', '']) {
      expect(() => compareVersions(bad, '0.1.0')).toThrow(UpdateManifestError);
    }
  });
});

describe('parseUpdateManifest', () => {
  it('讀得懂合法的清單', () => {
    expect(parseUpdateManifest(manifestText(), 'm.json')).toEqual({ schema: 1, version: '0.2.0', artifacts: [artifact()] });
  });

  it.each([
    ['不是 JSON', '{', '不是合法的 JSON'],
    ['是陣列', '[]', 'JSON 物件'],
    ['schema 不是 1', manifestText({ schema: 2 }), 'schema'],
    ['少了 schema', JSON.stringify({ version: '0.2.0', artifacts: [artifact()] }), 'schema'],
    ['版本號不合法', manifestText({ version: '0.2' }), '版本號'],
    ['沒有 artifacts', manifestText({ artifacts: [] }), 'artifacts'],
    ['平台不認得', manifestText({ artifacts: [artifact({ platform: 'linux' })] }), 'platform'],
    ['架構不認得', manifestText({ artifacts: [artifact({ arch: 'ia32' })] }), 'arch'],
    ['file 帶路徑', manifestText({ artifacts: [artifact({ file: '../evil.exe' })] }), 'file'],
    ['file 帶反斜線', manifestText({ artifacts: [artifact({ file: 'sub\\x.exe' })] }), 'file'],
    ['file 是 ..', manifestText({ artifacts: [artifact({ file: '..' })] }), 'file'],
    ['size 是 0', manifestText({ artifacts: [artifact({ size: 0 })] }), 'size'],
    ['size 不是整數', manifestText({ artifacts: [artifact({ size: 1.5 })] }), 'size'],
    ['sha512 太短', manifestText({ artifacts: [artifact({ sha512: 'abc' })] }), 'sha512'],
    ['sha512 大寫', manifestText({ artifacts: [artifact({ sha512: sha512(INSTALLER).toUpperCase() })] }), 'sha512'],
    ['同平台架構兩份', manifestText({ artifacts: [artifact(), artifact({ file: 'other.exe' })] }), '兩份'],
  ])('%s → 拋錯並講出哪裡不對', (_label, text, hint) => {
    expect(() => parseUpdateManifest(text, 'm.json')).toThrow(hint);
    expect(() => parseUpdateManifest(text, 'm.json')).toThrow(UpdateManifestError);
  });
});

describe('updateFolderFor', () => {
  it('是投影資料夾的兄弟 _更新', () => {
    const records = join(tempRoot(), 'MeetPilot 記錄');
    expect(updateFolderFor(join(records, '記錄人甲'))).toBe(join(records, UPDATE_FOLDER_NAME));
  });
});

describe('checkForUpdate', () => {
  it('資料夾不存在 → no-folder', async () => {
    const folder = join(tempRoot(), UPDATE_FOLDER_NAME);
    expect(await checkForUpdate({ folder, ...win })).toEqual({ state: 'no-folder', folder });
  });

  it('資料夾在、清單不在 → no-manifest', async () => {
    const folder = updateFolder({ installer: null });
    expect(await checkForUpdate({ folder, ...win })).toEqual({ state: 'no-manifest', folder });
  });

  it('清單壞了 → 拋，不當成沒有新版', async () => {
    const folder = updateFolder({ manifest: '{"schema":1' });
    await expect(checkForUpdate({ folder, ...win })).rejects.toThrow(UpdateManifestError);
  });

  it('清單版本一樣或比較舊 → up-to-date', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    expect(await checkForUpdate({ folder, ...win, currentVersion: '0.2.0' })).toEqual({ state: 'up-to-date', version: '0.2.0' });
    expect(await checkForUpdate({ folder, ...win, currentVersion: '0.10.0' })).toEqual({ state: 'up-to-date', version: '0.2.0' });
  });

  it('有新版但沒有這台電腦的平台 → no-artifact', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    expect(await checkForUpdate({ folder, ...win, platform: 'darwin', arch: 'arm64' })).toEqual({ state: 'no-artifact', version: '0.2.0' });
  });

  it('安裝檔還沒到 → syncing', async () => {
    const folder = updateFolder({ manifest: manifestText(), installer: null });
    expect(await checkForUpdate({ folder, ...win })).toMatchObject({ state: 'syncing', version: '0.2.0', reason: '安裝檔還沒同步到' });
  });

  it('安裝檔大小不對（同步到一半）→ syncing', async () => {
    const folder = updateFolder({ manifest: manifestText(), installer: INSTALLER.subarray(0, 5) });
    const check = await checkForUpdate({ folder, ...win });
    expect(check).toMatchObject({ state: 'syncing', version: '0.2.0' });
    expect(describeUpdateCheck(check)).toContain('還在同步');
  });

  it('大小對、內容被換過 → corrupt，不是 ready', async () => {
    const tampered = Buffer.from(INSTALLER);
    tampered[0] ^= 0xff;
    const folder = updateFolder({ manifest: manifestText(), installer: tampered });
    const check = await checkForUpdate({ folder, ...win });
    expect(check).toEqual({ state: 'corrupt', version: '0.2.0', file: 'MeetPilot-0.2.0-win-x64.exe' });
    expect(describeUpdateCheck(check)).toContain('不會安裝');
  });

  it('清單在但讀不了（這裡用同名資料夾造 EISDIR）→ unreadable 帶路徑與原因，不當成清單壞了', async () => {
    const folder = updateFolder({ installer: null });
    mkdirSync(join(folder, UPDATE_MANIFEST_NAME));
    const check = await checkForUpdate({ folder, ...win });
    expect(check).toMatchObject({ state: 'unreadable', path: join(folder, UPDATE_MANIFEST_NAME), reason: 'EISDIR' });
    expect(describeUpdateCheck(check)).toContain('讀不了');
  });

  // Windows 上資料夾的 size 是 0，清單寫不出「大小對得上」的資料夾，這條只在 macOS／Linux 造得出來
  it.skipIf(process.platform === 'win32')('安裝檔大小對得上但讀不了 → unreadable，不是 corrupt', async () => {
    const folder = updateFolder({ installer: null });
    const installer = join(folder, 'MeetPilot-0.2.0-win-x64.exe');
    mkdirSync(installer);
    writeFileSync(join(folder, UPDATE_MANIFEST_NAME), manifestText({ artifacts: [artifact({ size: statSync(installer).size })] }));
    expect(await checkForUpdate({ folder, ...win })).toMatchObject({ state: 'unreadable', path: installer, reason: 'EISDIR' });
  });

  it('都對 → ready，帶資料夾裡安裝檔的路徑', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    expect(await checkForUpdate({ folder, ...win })).toEqual({
      state: 'ready', version: '0.2.0', artifact: artifact(), installerPath: join(folder, 'MeetPilot-0.2.0-win-x64.exe'),
    });
  });
});

describe('stageInstaller', () => {
  it('複製到暫存的版本資料夾，複本驗過才回傳', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    const check = await checkForUpdate({ folder, ...win });
    if (check.state !== 'ready') throw new Error(`前提不成立：${check.state}`);
    const staging = tempRoot();
    const staged = await stageInstaller(check, staging);
    expect(staged).toBe(join(staging, '0.2.0', 'MeetPilot-0.2.0-win-x64.exe'));
    expect(readFileSync(staged).equals(INSTALLER)).toBe(true);
  });

  it('上一版留在暫存的複本先清掉（一版一百多 MB，Windows 的 %TEMP% 不會自己清）', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    const check = await checkForUpdate({ folder, ...win });
    if (check.state !== 'ready') throw new Error(`前提不成立：${check.state}`);
    const staging = tempRoot();
    mkdirSync(join(staging, '0.1.0'));
    writeFileSync(join(staging, '0.1.0', 'MeetPilot-0.1.0-win-x64.exe'), 'old');
    await stageInstaller(check, staging);
    expect(readdirSync(staging)).toEqual(['0.2.0']);
  });

  it('檢查之後資料夾裡的檔被換過 → 拋，複本刪掉，不回傳任何路徑', async () => {
    const folder = updateFolder({ manifest: manifestText() });
    const check = await checkForUpdate({ folder, ...win });
    if (check.state !== 'ready') throw new Error(`前提不成立：${check.state}`);
    // 同樣長度、不同內容：只比大小的話會放過
    const swapped = Buffer.from(INSTALLER);
    swapped[swapped.length - 1] ^= 0xff;
    writeFileSync(check.installerPath, swapped);
    const staging = tempRoot();
    await expect(stageInstaller(check, staging)).rejects.toThrow(UpdateVerifyError);
    expect(existsSync(join(staging, '0.2.0', 'MeetPilot-0.2.0-win-x64.exe'))).toBe(false);
  });
});

describe('上次的更新有沒有完成', () => {
  const marker = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ from: '0.1.0', to: '0.2.0', startedAt: '2026-09-24T08:00:00.000Z', ...over });

  it('讀得懂標記', () => {
    expect(parsePendingUpdate(marker(), 'p.json')).toEqual({ from: '0.1.0', to: '0.2.0', startedAt: '2026-09-24T08:00:00.000Z' });
  });

  it.each([
    ['不是 JSON', '{'],
    ['少了 to', JSON.stringify({ from: '0.1.0', startedAt: 'x' })],
    ['版本號不合法', marker({ to: 'v0.2.0' })],
  ])('%s → 拋', (_label, text) => {
    expect(() => parsePendingUpdate(text, 'p.json')).toThrow(UpdateManifestError);
  });

  it('現在的版本到了（或超過）要裝的那版才算完成', () => {
    const pending = parsePendingUpdate(marker(), 'p.json');
    expect(pendingUpdateDone(pending, '0.2.0')).toBe(true);
    expect(pendingUpdateDone(pending, '0.3.0')).toBe(true);
    expect(pendingUpdateDone(pending, '0.1.0')).toBe(false);
  });

  it('標記檔名固定（外殼靠它在 userData 找）', () => {
    expect(PENDING_UPDATE_FILE).toBe('update-pending.json');
  });
});

describe('WINDOWS_INSTALL_ARGS', () => {
  it('跟 electron-updater 的 NsisUpdater 同一組：靜默安裝、裝完重開', () => {
    expect([...WINDOWS_INSTALL_ARGS]).toEqual(['--updated', '/S', '--force-run']);
  });
});

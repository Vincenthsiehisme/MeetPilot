import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REQUIRED_TARGETS, UpdateBundleError, planUpdateBundle, writeUpdateBundle } from './updateBundle';
import { UPDATE_MANIFEST_NAME, checkForUpdate } from './updater';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tempRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'meetpilot-update-bundle-'));
  roots.push(r);
  return r;
};

const names = (version: string) => [
  `MeetPilot-${version}-mac-arm64.dmg`, `MeetPilot-${version}-mac-x64.dmg`, `MeetPilot-${version}-win-x64.exe`,
];
const at = (dir: string, list: string[]) => list.map((name) => ({ dir, name }));

describe('planUpdateBundle', () => {
  it('三個目標齊了就依固定順序排好；blockmap 之類的檔不理', () => {
    const plan = planUpdateBundle(
      at('/ci/win', [`MeetPilot-0.2.0-win-x64.exe`, `MeetPilot-0.2.0-win-x64.exe.blockmap`])
        .concat(at('/ci/mac', [`MeetPilot-0.2.0-mac-x64.dmg`, `MeetPilot-0.2.0-mac-arm64.dmg`, 'latest-mac.yml'])),
      '0.2.0',
    );
    expect(plan.map((p) => `${p.platform}-${p.arch}`)).toEqual([...REQUIRED_TARGETS]);
    expect(plan.map((p) => p.dir)).toEqual(['/ci/mac', '/ci/mac', '/ci/win']);
  });

  it('少一個平台 → 拋，講出少了哪個', () => {
    expect(() => planUpdateBundle(at('/ci', names('0.2.0').slice(0, 2)), '0.2.0')).toThrow('少了 win32-x64');
  });

  it('安裝檔版本跟 package.json 不一樣 → 拋', () => {
    expect(() => planUpdateBundle(at('/ci', [...names('0.2.0').slice(0, 2), 'MeetPilot-0.1.9-win-x64.exe']), '0.2.0'))
      .toThrow(UpdateBundleError);
  });

  it('同一個目標兩份 → 拋', () => {
    expect(() => planUpdateBundle(at('/a', names('0.2.0')).concat(at('/b', ['MeetPilot-0.2.0-win-x64.exe'])), '0.2.0'))
      .toThrow('兩份');
  });

  it('平台跟副檔名對不上 → 拋', () => {
    expect(() => planUpdateBundle(at('/ci', [...names('0.2.0'), 'MeetPilot-0.2.0-mac-arm64.exe']), '0.2.0'))
      .toThrow('對不上');
  });
});

describe('writeUpdateBundle', () => {
  it('寫出的清單 app 端讀得懂，放進 _更新 就是 ready', async () => {
    const root = tempRoot();
    const mac = join(root, 'installer-macos');
    const winDir = join(root, 'installer-windows');
    mkdirSync(mac);
    mkdirSync(winDir);
    const [arm, x64, exe] = names('0.2.0');
    writeFileSync(join(mac, arm), 'mac arm64 installer');
    writeFileSync(join(mac, x64), 'mac x64 installer');
    writeFileSync(join(winDir, exe), 'windows installer');
    const out = join(root, 'MeetPilot 記錄', '_更新');

    const manifest = await writeUpdateBundle([mac, winDir], out, '0.2.0');

    expect(manifest.artifacts.map((a) => a.file)).toEqual([arm, x64, exe]);
    expect(JSON.parse(readFileSync(join(out, UPDATE_MANIFEST_NAME), 'utf8'))).toEqual(manifest);
    expect(readFileSync(join(out, exe), 'utf8')).toBe('windows installer');
    const check = await checkForUpdate({ folder: out, currentVersion: '0.1.0', platform: 'win32', arch: 'x64' });
    expect(check).toMatchObject({ state: 'ready', version: '0.2.0' });
    const macCheck = await checkForUpdate({ folder: out, currentVersion: '0.1.0', platform: 'darwin', arch: 'x64' });
    expect(macCheck).toMatchObject({ state: 'ready', installerPath: join(out, x64) });
  });
});

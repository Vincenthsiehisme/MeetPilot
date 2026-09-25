/**
 * 重新產生 app icon 與托盤圖示：
 *
 *   npm run icons:build
 *
 * 輸出 `build/icon.icns`（macOS）、`build/icon.ico`（Windows），並覆寫 `electron/assets/` 的三張托盤圖。
 * 圖案定義在 `scripts/icon/iconArtwork.ts`，要改樣子改那裡再重跑，不要手改產出的圖。
 * 只能在 macOS 跑：.icns 要用系統的 `iconutil`。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ICO_SIZES, ICONSET, icoSourceSvg, macIconSvg, packIco, smallIconSvg, traySvg,
} from './icon/iconArtwork';

interface Job { name: string; svg: string; size: number }

function main(): void {
  if (process.platform !== 'darwin') {
    console.error('[icons] 只能在 macOS 跑：.icns 要用系統的 iconutil');
    process.exitCode = 1;
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'meetpilot-icons-'));
  try {
    const jobs: Job[] = [
      ...[...new Set(Object.values(ICONSET))].map((size) => ({ name: `mac-${size}`, svg: macIconSvg(), size })),
      ...ICO_SIZES.map((size) => ({ name: `win-${size}`, svg: icoSourceSvg(size), size })),
      { name: 'tray-16', svg: traySvg(16), size: 16 },
      { name: 'tray-32', svg: traySvg(32), size: 32 },
      { name: 'tray-win', svg: smallIconSvg(32), size: 32 },
    ];
    const png = (name: string) => join(work, `${name}.png`);
    const renderJobs = jobs.map(({ name, svg, size }) => {
      const svgPath = join(work, `${name}.svg`);
      writeFileSync(svgPath, svg);
      return { svg: svgPath, size, out: png(name) };
    });
    const jobsFile = join(work, 'jobs.json');
    writeFileSync(jobsFile, JSON.stringify(renderJobs));

    const electron = createRequire(import.meta.url)('electron') as string;
    const rendered = spawnSync(electron, [resolve('scripts/icon/renderIcons.cjs'), jobsFile], { stdio: 'inherit' });
    if (rendered.status !== 0) throw new Error(`Electron 渲染結束碼 ${rendered.status ?? rendered.signal}`);

    mkdirSync('build', { recursive: true });
    writeFileSync('build/icon.ico', packIco(ICO_SIZES.map((size) => ({ size, png: readFileSync(png(`win-${size}`)) }))));

    const iconset = join(work, 'MeetPilot.iconset');
    mkdirSync(iconset);
    for (const [file, size] of Object.entries(ICONSET)) copyFileSync(png(`mac-${size}`), join(iconset, file));
    const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns'], { stdio: 'inherit' });
    if (icns.status !== 0) throw new Error(`iconutil 結束碼 ${icns.status ?? icns.signal}`);

    copyFileSync(png('tray-16'), 'electron/assets/trayTemplate.png');
    copyFileSync(png('tray-32'), 'electron/assets/trayTemplate@2x.png');
    copyFileSync(png('tray-win'), 'electron/assets/tray.png');
    console.log('[icons] 寫出 build/icon.icns、build/icon.ico、electron/assets/ 三張托盤圖');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();

/**
 * 把兩個平台的安裝檔整理成一包更新檔（vault plan「MeetPilot · 跨平台打包部署」E5）。
 *
 *   npx tsx scripts/writeUpdateBundle.ts --out <輸出資料夾> <安裝檔資料夾> [<安裝檔資料夾> ...]
 *
 * CI 的 update-bundle job 從 draft Release 下載兩個平台的安裝檔跑它，產出的 `meetpilot-update.json` 傳回同一個 Release
 * （安裝檔已經在上面）。admin 從 Release 下載安裝檔與清單，全部放進 `MeetPilot 記錄/_更新/`，舊版的檔案刪掉。
 * 版本號讀 package.json；安裝檔的版本跟它不一樣、或少了任何一個平台，就不產。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UpdateBundleError, writeUpdateBundle } from '../electron/updateBundle';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = outIndex === -1 ? undefined : args[outIndex + 1];
  const inputs = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (!outDir || inputs.length === 0) {
    console.error('用法：npx tsx scripts/writeUpdateBundle.ts --out <輸出資料夾> <安裝檔資料夾> [<安裝檔資料夾> ...]');
    process.exitCode = 1;
    return;
  }
  const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
  try {
    const manifest = await writeUpdateBundle(inputs.map((d) => resolve(d)), resolve(outDir), version);
    console.log(`[update-bundle] ${version}：${manifest.artifacts.map((a) => `${a.file}（${a.size} bytes）`).join('、')}`);
    console.log(`[update-bundle] 輸出在 ${resolve(outDir)}（CI 只把裡面的清單傳回 Release，admin 從 Release 下載）`);
  } catch (err) {
    if (!(err instanceof UpdateBundleError)) throw err;
    console.error(`[update-bundle] 失敗：${err.message}`);
    process.exitCode = 1;
  }
}

main();

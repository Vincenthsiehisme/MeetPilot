/**
 * 把兩個平台的安裝檔整理成一包更新檔（vault plan「MeetPilot · 跨平台打包部署」E5）。
 *
 *   npx tsx scripts/writeUpdateBundle.ts --out <輸出資料夾> <安裝檔資料夾> [<安裝檔資料夾> ...]
 *
 * CI 的 update-bundle job 在兩個平台都打包完之後跑它，產出的資料夾上傳成一個 artifact。
 * admin 下載後把裡面的檔案全部放進 `MeetPilot 記錄/_更新/`，舊版的檔案刪掉。
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
    console.log(`[update-bundle] 輸出在 ${resolve(outDir)}，整包放進 MeetPilot 記錄/_更新/`);
  } catch (err) {
    if (!(err instanceof UpdateBundleError)) throw err;
    console.error(`[update-bundle] 失敗：${err.message}`);
    process.exitCode = 1;
  }
}

main();

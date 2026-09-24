/**
 * 桌面 app 隨附的 ffmpeg／ffprobe 在哪（vault plan「MeetPilot · 跨平台打包部署」E2）。
 *
 * 打包後在 `<resources>/ffmpeg/`（electron-builder 的 extraResources，依平台與架構從 vendor/ffmpeg/ 帶進去）。
 * 開發時在 repo 的 `vendor/ffmpeg/<mac|win>-<arm64|x64>/`（scripts/ffmpeg/build.sh 產的），沒編就走 PATH。
 *
 * 打包後找不到是安裝檔壞了，不能退回 PATH：記錄人的電腦上本來就沒有 ffmpeg，退回去只會讓每場會在轉錄一開始
 * FAILED，而且錯誤訊息叫人去 brew install。所以打包後缺檔直接拋，讓外殼跳錯誤視窗。
 * 這個檔不 import electron，才測得到。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BundledFfmpegInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  arch: string;
}

export function resolveBundledFfmpeg(input: BundledFfmpegInput): { ffmpeg: string; ffprobe: string } | undefined {
  const exe = input.platform === 'win32' ? '.exe' : '';
  const dir = input.isPackaged
    ? join(input.resourcesPath, 'ffmpeg')
    : join(input.appPath, 'vendor', 'ffmpeg', `${input.platform === 'win32' ? 'win' : 'mac'}-${input.arch}`);
  const paths = { ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) };
  const missing = Object.values(paths).filter((p) => !existsSync(p));
  if (missing.length === 0) return paths;
  if (input.isPackaged) {
    throw new Error(`安裝檔裡少了 ffmpeg（找不到 ${missing.join('、')}），請重新安裝 MeetPilot`);
  }
  return undefined;
}

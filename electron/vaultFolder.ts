/**
 * 設定頁選的投影資料夾在交給 server 之前先驗一次（vault plan「MeetPilot · 跨平台打包部署」E3）。
 *
 * server 自己在啟動時也會驗（寫不進去就起不來），但那時已經離開設定頁，記錄人看到的是「背景程式停止了」
 * 加一段 log，不知道是資料夾選錯。在這裡擋，錯誤訊息直接出現在選資料夾的那一格下面。
 * 家目錄本身不能當投影資料夾的規則只有一份，在 server 的 `resolveVaultDir`，這裡借用它。
 * 這個檔不 import electron，才測得到。
 */
import { accessSync, constants, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveVaultDir } from '../services/vaultProjector';

export class VaultFolderError extends Error {}

export function checkVaultFolder(raw: string): string {
  const input = raw.trim();
  if (input === '') throw new VaultFolderError('還沒選投影資料夾');
  if (!isAbsolute(input)) throw new VaultFolderError(`投影資料夾要是完整路徑：${input}`);
  let dir: string;
  try {
    dir = resolveVaultDir({ MEETPILOT_VAULT: input });
  } catch (err) {
    throw new VaultFolderError((err as Error).message.replace(/^MEETPILOT_VAULT ?/, '投影資料夾'));
  }
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new VaultFolderError(`找不到這個資料夾：${dir}`);
  }
  if (!isDir) throw new VaultFolderError(`這不是資料夾：${dir}`);
  // 真的寫一個檔再刪掉：Windows 上唯讀的同步資料夾、macOS 沒給權限的資料夾，accessSync 不一定看得出來
  const probe = join(dir, `.meetpilot-write-test-${process.pid}`);
  try {
    accessSync(dir, constants.W_OK);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (err) {
    throw new VaultFolderError(`這個資料夾寫不進去（${(err as Error).message}）：${dir}`);
  }
  return dir;
}

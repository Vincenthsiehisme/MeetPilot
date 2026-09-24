/**
 * 把 CI 產出的安裝檔整理成一包可以直接放進 `MeetPilot 記錄/_更新/` 的更新檔（vault plan「MeetPilot · 跨平台打包部署」E5）。
 * CLI 在 scripts/writeUpdateBundle.ts；這裡是邏輯，才測得到。
 *
 * 安裝檔的檔名由 package.json 的 build.dmg／build.nsis.artifactName 定成 `MeetPilot-<版本>-<mac|win>-<架構>.<dmg|exe>`，
 * 平台與架構從檔名讀。三個目標（mac arm64、mac x64、win x64）缺一個就不產：少一個平台的清單放出去，
 * 那個平台的記錄人永遠停在舊版，而且沒有任何地方會紅。
 * 這裡寫的清單 app 端讀不讀得懂，由 updateBundle.test.ts 拿 app 端的 checkForUpdate 讀它來守。
 */
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_MANIFEST_NAME, UPDATE_MANIFEST_SCHEMA, UpdateArch, UpdateManifest, UpdatePlatform, sha512OfFile,
} from './updater';

export const ARTIFACT_NAME_PATTERN = /^MeetPilot-(\d+\.\d+\.\d+)-(mac|win)-(arm64|x64)\.(dmg|exe)$/;
export const REQUIRED_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const;

export class UpdateBundleError extends Error {}

export interface PlannedArtifact {
  platform: UpdatePlatform;
  arch: UpdateArch;
  file: string;
  /** 找到它的資料夾 */
  dir: string;
}

/** 從各個資料夾的檔名挑出要進這一版的安裝檔。不是安裝檔的檔（blockmap 之類）不理，其他不對的一律拋 */
export function planUpdateBundle(found: { dir: string; name: string }[], version: string): PlannedArtifact[] {
  const planned = new Map<string, PlannedArtifact>();
  for (const { dir, name } of found) {
    const match = ARTIFACT_NAME_PATTERN.exec(name);
    if (match === null) continue;
    const [, fileVersion, os, arch, ext] = match;
    if (fileVersion !== version) {
      throw new UpdateBundleError(`${join(dir, name)} 是 ${fileVersion} 版，package.json 是 ${version}：不要把兩個版本混成一包`);
    }
    if ((os === 'mac') !== (ext === 'dmg')) throw new UpdateBundleError(`${name} 的平台跟副檔名對不上`);
    const platform: UpdatePlatform = os === 'mac' ? 'darwin' : 'win32';
    const key = `${platform}-${arch}`;
    const existing = planned.get(key);
    if (existing !== undefined) {
      throw new UpdateBundleError(`${key} 有兩份安裝檔：${join(existing.dir, existing.file)}、${join(dir, name)}`);
    }
    planned.set(key, { platform, arch: arch as UpdateArch, file: name, dir });
  }
  const missing = REQUIRED_TARGETS.filter((t) => !planned.has(t));
  if (missing.length > 0) {
    throw new UpdateBundleError(`少了 ${missing.join('、')} 的安裝檔（找到 ${[...planned.keys()].join('、') || '沒有'}）`);
  }
  // 清單裡的順序固定，同一批安裝檔產出同一份清單
  return REQUIRED_TARGETS.map((t) => planned.get(t) as PlannedArtifact);
}

/** 讀 inputDirs 裡的安裝檔，複製到 outDir 並寫清單，回傳寫出的清單 */
export async function writeUpdateBundle(inputDirs: string[], outDir: string, version: string): Promise<UpdateManifest> {
  const found: { dir: string; name: string }[] = [];
  for (const dir of inputDirs) {
    for (const name of await readdir(dir)) found.push({ dir, name });
  }
  const planned = planUpdateBundle(found, version);
  await mkdir(outDir, { recursive: true });
  const artifacts = [];
  for (const p of planned) {
    const source = join(p.dir, p.file);
    const { size } = await stat(source);
    const sha512 = await sha512OfFile(source);
    await copyFile(source, join(outDir, p.file));
    artifacts.push({ platform: p.platform, arch: p.arch, file: p.file, size, sha512 });
  }
  const manifest: UpdateManifest = { schema: UPDATE_MANIFEST_SCHEMA, version, artifacts };
  await writeFile(join(outDir, UPDATE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

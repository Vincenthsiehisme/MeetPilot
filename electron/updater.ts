/**
 * 桌面 app 從共享資料夾更新（vault plan「MeetPilot · 跨平台打包部署」E5）。
 *
 * 新版的安裝檔與清單（meetpilot-update.json）由 admin 放進 `MeetPilot 記錄/_更新/`，OneDrive 同步到每位記錄人的電腦。
 * 這個資料夾在投影資料夾的上一層：投影資料夾是 `MeetPilot 記錄/<自己的名字>/`，所以不用多一格設定。
 * 群組對 `_更新/` 只有檢視權限，只有 admin 寫得進去：安裝檔沒有簽章，app 會直接執行它。
 *
 * 不用 electron-updater（2026-09-24 查證）：它經 net.request 抓檔，Electron 44 的 net.request 不收 file://；
 * macOS 的自動安裝要 app 有簽章（Squirrel.Mac）。安裝檔已經由 OneDrive 下載好，剩下的只有讀清單、比版本、
 * 驗雜湊、執行安裝檔，這裡自己做。
 *
 * 一個安裝檔要過兩次驗證才會被執行：檢查時驗資料夾裡那份，複製到暫存之後再驗一次複本。
 * 驗完到執行之間 OneDrive 可能又改了資料夾裡的檔，所以執行的一定是驗過的那份複本。
 * 這個檔不 import electron，才測得到。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const UPDATE_FOLDER_NAME = '_更新';
export const UPDATE_MANIFEST_NAME = 'meetpilot-update.json';
export const UPDATE_MANIFEST_SCHEMA = 1;

/** electron-builder 的 NSIS 安裝檔自己更新時用的參數，跟 electron-updater 的 NsisUpdater 同一組：靜默安裝、裝完重開 */
export const WINDOWS_INSTALL_ARGS = ['--updated', '/S', '--force-run'] as const;

export type UpdatePlatform = 'darwin' | 'win32';
export type UpdateArch = 'arm64' | 'x64';

export interface UpdateArtifact {
  platform: UpdatePlatform;
  arch: UpdateArch;
  /** 只有檔名，跟清單放在同一個資料夾 */
  file: string;
  size: number;
  /** 小寫 hex */
  sha512: string;
}

export interface UpdateManifest {
  schema: typeof UPDATE_MANIFEST_SCHEMA;
  version: string;
  artifacts: UpdateArtifact[];
}

export class UpdateManifestError extends Error {}
export class UpdateVerifyError extends Error {}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA512_PATTERN = /^[0-9a-f]{128}$/;
// 檔名只准英數、點、底線、連字號：不能帶路徑，也不能是 `..`
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLATFORMS: readonly UpdatePlatform[] = ['darwin', 'win32'];
const ARCHES: readonly UpdateArch[] = ['arm64', 'x64'];

function parseVersion(version: string, where: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) throw new UpdateManifestError(`版本號要是「數字.數字.數字」（${where}）：${JSON.stringify(version)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a 比 b 新回正數、一樣回 0、舊回負數。逐段比數字，所以 0.10.0 比 0.9.0 新 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a, '比較版本');
  const pb = parseVersion(b, '比較版本');
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 清單壞了一律拋、講出哪一格：壞掉的清單當成「沒有新版」的話，admin 放了新版也沒有人會發現沒生效 */
export function parseUpdateManifest(text: string, source: string): UpdateManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new UpdateManifestError(`${source} 不是合法的 JSON：${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UpdateManifestError(`${source} 要是一個 JSON 物件`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== UPDATE_MANIFEST_SCHEMA) {
    throw new UpdateManifestError(`${source} 的 schema 是 ${JSON.stringify(obj.schema)}，這版 MeetPilot 只看得懂 ${UPDATE_MANIFEST_SCHEMA}`);
  }
  if (typeof obj.version !== 'string') throw new UpdateManifestError(`${source} 少了 version`);
  parseVersion(obj.version, `${source} 的 version`);
  if (!Array.isArray(obj.artifacts) || obj.artifacts.length === 0) {
    throw new UpdateManifestError(`${source} 的 artifacts 要是非空的陣列`);
  }
  const seen = new Set<string>();
  const artifacts = obj.artifacts.map((item, index): UpdateArtifact => {
    const where = `${source} 的 artifacts[${index}]`;
    if (typeof item !== 'object' || item === null) throw new UpdateManifestError(`${where} 要是物件`);
    const a = item as Record<string, unknown>;
    if (!PLATFORMS.includes(a.platform as UpdatePlatform)) {
      throw new UpdateManifestError(`${where} 的 platform 要是 ${PLATFORMS.join(' 或 ')}：${JSON.stringify(a.platform)}`);
    }
    if (!ARCHES.includes(a.arch as UpdateArch)) {
      throw new UpdateManifestError(`${where} 的 arch 要是 ${ARCHES.join(' 或 ')}：${JSON.stringify(a.arch)}`);
    }
    if (typeof a.file !== 'string' || !FILE_PATTERN.test(a.file)) {
      throw new UpdateManifestError(`${where} 的 file 只能是檔名（英數、點、底線、連字號）：${JSON.stringify(a.file)}`);
    }
    if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size <= 0) {
      throw new UpdateManifestError(`${where} 的 size 要是正整數：${JSON.stringify(a.size)}`);
    }
    if (typeof a.sha512 !== 'string' || !SHA512_PATTERN.test(a.sha512)) {
      throw new UpdateManifestError(`${where} 的 sha512 要是 128 個小寫 hex 字元`);
    }
    const key = `${a.platform}-${a.arch}`;
    if (seen.has(key)) throw new UpdateManifestError(`${source} 有兩份 ${key} 的安裝檔，不知道要用哪一份`);
    seen.add(key);
    return { platform: a.platform as UpdatePlatform, arch: a.arch as UpdateArch, file: a.file, size: a.size, sha512: a.sha512 };
  });
  return { schema: UPDATE_MANIFEST_SCHEMA, version: obj.version, artifacts };
}

/** 投影資料夾是 `MeetPilot 記錄/<名字>/`，更新資料夾是它的兄弟 `MeetPilot 記錄/_更新/` */
export function updateFolderFor(vaultDir: string): string {
  return join(dirname(vaultDir), UPDATE_FOLDER_NAME);
}

export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export type UpdateCheck =
  /** 資料夾不存在：投影資料夾不在 `MeetPilot 記錄/<名字>/` 這種結構底下，或 OneDrive 還沒同步到 */
  | { state: 'no-folder'; folder: string }
  /** 資料夾在、清單不在：admin 還沒放過任何一版 */
  | { state: 'no-manifest'; folder: string }
  | { state: 'up-to-date'; version: string }
  /** 有新版，但清單裡沒有這台電腦的平台與架構 */
  | { state: 'no-artifact'; version: string }
  /** 安裝檔還沒到或大小不對：OneDrive 還在同步，下次再檢查 */
  | { state: 'syncing'; version: string; file: string; reason: string }
  /** 大小對、雜湊不對：不是同步中，是檔案被換過或壞了。不安裝，而且要講出來 */
  | { state: 'corrupt'; version: string; file: string }
  /** 資料夾、清單或安裝檔在但讀不了（OneDrive 正在寫、佔位檔離線下載不到、權限）：不是清單壞了，講實際原因 */
  | { state: 'unreadable'; path: string; reason: string }
  | { state: 'ready'; version: string; artifact: UpdateArtifact; installerPath: string };

export interface CheckInput {
  folder: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';
const unreadable = (path: string, err: unknown): UpdateCheck => ({
  state: 'unreadable', path, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message,
});

/**
 * 清單讀不懂時拋 UpdateManifestError；其他狀態（包括「還在同步」「讀不了」）都是回傳值。
 * 這台 app 自己的版本號不合法也拋（那是打包出錯，不是資料夾的狀態）。
 */
export async function checkForUpdate(input: CheckInput): Promise<UpdateCheck> {
  const { folder } = input;
  try {
    if (!(await stat(folder)).isDirectory()) return { state: 'no-folder', folder };
  } catch (err) {
    if (isMissing(err)) return { state: 'no-folder', folder };
    return unreadable(folder, err);
  }
  const manifestPath = join(folder, UPDATE_MANIFEST_NAME);
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if (isMissing(err)) return { state: 'no-manifest', folder };
    return unreadable(manifestPath, err);
  }
  const manifest = parseUpdateManifest(text, manifestPath);
  if (compareVersions(manifest.version, input.currentVersion) <= 0) return { state: 'up-to-date', version: manifest.version };
  const artifact = manifest.artifacts.find((a) => a.platform === input.platform && a.arch === input.arch);
  if (artifact === undefined) return { state: 'no-artifact', version: manifest.version };
  const installerPath = join(folder, artifact.file);
  let size: number;
  try {
    size = (await stat(installerPath)).size;
  } catch (err) {
    if (isMissing(err)) return { state: 'syncing', version: manifest.version, file: artifact.file, reason: '安裝檔還沒同步到' };
    return unreadable(installerPath, err);
  }
  if (size !== artifact.size) {
    return { state: 'syncing', version: manifest.version, file: artifact.file, reason: `安裝檔 ${size} bytes，清單寫 ${artifact.size} bytes` };
  }
  let hash: string;
  try {
    hash = await sha512OfFile(installerPath);
  } catch (err) {
    return unreadable(installerPath, err);
  }
  if (hash !== artifact.sha512) return { state: 'corrupt', version: manifest.version, file: artifact.file };
  return { state: 'ready', version: manifest.version, artifact, installerPath };
}

/**
 * 把驗過的安裝檔複製到暫存資料夾，複本再驗一次才回傳它的路徑。複本對不上就刪掉並拋：
 * 檢查之後資料夾裡的檔又被換過（OneDrive 同步到一半、有人改了），這時不能執行任何一份。
 * 暫存資料夾只放這個用途，每次先整個清掉：一版一百多 MB，Windows 的 %TEMP% 不會自己清。
 */
export async function stageInstaller(ready: Extract<UpdateCheck, { state: 'ready' }>, stagingDir: string): Promise<string> {
  await rm(stagingDir, { recursive: true, force: true });
  const dir = join(stagingDir, ready.version);
  await mkdir(dir, { recursive: true });
  const staged = join(dir, ready.artifact.file);
  await copyFile(ready.installerPath, staged);
  const { size } = await stat(staged);
  const hash = await sha512OfFile(staged);
  if (size !== ready.artifact.size || hash !== ready.artifact.sha512) {
    await rm(staged, { force: true });
    throw new UpdateVerifyError(`複製出來的安裝檔跟清單對不上（${ready.artifact.file}），檢查之後資料夾裡的檔被換過了，這次不安裝`);
  }
  return staged;
}

/** 托盤與橫幅上給人看的一句話 */
export function describeUpdateCheck(check: UpdateCheck): string {
  switch (check.state) {
    case 'no-folder':
      return `沒有更新資料夾（${check.folder}）`;
    case 'no-manifest':
      return '更新資料夾裡還沒有新版';
    case 'up-to-date':
      return '已經是最新版';
    case 'no-artifact':
      return `新版 ${check.version} 沒有這台電腦能用的安裝檔`;
    case 'syncing':
      return `新版 ${check.version} 還在同步（${check.reason}）`;
    case 'corrupt':
      return `新版 ${check.version} 的安裝檔跟清單對不上，不會安裝，請通知 admin`;
    case 'unreadable':
      return `更新資料夾讀不了（${check.reason}：${check.path}），稍後再檢查`;
    case 'ready':
      return `新版 ${check.version} 可以安裝`;
  }
}

// ---- 上次的更新有沒有完成 ----
// 安裝程式是 detached 起來的，app 接著就結束了；它失敗（Windows 按掉提權詢問、檔案被鎖、磁碟滿，
// macOS 開了 dmg 沒拖）的話沒有任何畫面。所以起安裝程式之前在 userData 留一張標記，下次啟動比對版本。

export const PENDING_UPDATE_FILE = 'update-pending.json';

export interface PendingUpdate {
  from: string;
  to: string;
  startedAt: string;
}

export function parsePendingUpdate(text: string, source: string): PendingUpdate {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new UpdateManifestError(`${source} 不是合法的 JSON：${(err as Error).message}`);
  }
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.from !== 'string' || typeof p.to !== 'string' || typeof p.startedAt !== 'string') {
    throw new UpdateManifestError(`${source} 少了 from、to 或 startedAt`);
  }
  parseVersion(p.from, `${source} 的 from`);
  parseVersion(p.to, `${source} 的 to`);
  return { from: p.from, to: p.to, startedAt: p.startedAt };
}

/** 現在的版本已經到（或超過）要裝的那版，就是裝好了 */
export function pendingUpdateDone(pending: PendingUpdate, currentVersion: string): boolean {
  return compareVersions(currentVersion, pending.to) >= 0;
}

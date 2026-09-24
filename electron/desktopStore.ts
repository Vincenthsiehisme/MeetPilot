/**
 * 桌面 app 自己要記住的東西，全部在 userData（vault plan「MeetPilot · 跨平台打包部署」E3）。
 *
 * - `desktop-settings.json`：投影資料夾。不是密，明文。
 * - `credentials.json`：gateway 的 token 與 Gemini key，**加密後**才落地（Electron `safeStorage`：
 *   macOS Keychain、Windows DPAPI）。加解密由呼叫端傳進來，這個檔不 import electron，才測得到。
 * - `roster.json`：上次從 gateway 拿到的名單，server 以 `MEETPILOT_ROSTER_DOCUMENT` 每次啟動匯入。
 *   不加密：server 要讀它，而且匯入後同一份名單就以明文存在 SQLite，加密一份副本擋不到任何東西（plan E3 裁定）。
 *
 * 檔案不存在是合法的空（第一次啟動），回 null。檔案在但讀不懂、解不開是另一回事，拋 `DesktopStoreError`，
 * 不當成「沒設定過」：那樣記錄人會看到一個像是第一次安裝的畫面，卻不知道原本的設定為什麼不見了。
 * 寫入一律先寫暫存檔再改名，寫到一半斷電不會留下半個 JSON。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RosterDocument } from '../services/rosterDocument';

export interface SecretBox {
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export interface DesktopSettings {
  vaultDir: string;
}

export interface DesktopCredentials {
  inviteId: string;
  token: string;
  geminiApiKey: string;
}

export class DesktopStoreError extends Error {}

const FILE_VERSION = 1;

export function createDesktopStore(dir: string, box: SecretBox) {
  const settingsPath = join(dir, 'desktop-settings.json');
  const credentialsPath = join(dir, 'credentials.json');
  const rosterPath = join(dir, 'roster.json');

  const writeAtomic = (path: string, content: string) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  };

  const readJson = (path: string): Record<string, unknown> | null => {
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new DesktopStoreError(`${path} 讀不懂：${(err as Error).message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DesktopStoreError(`${path} 不是物件`);
    }
    const obj = raw as Record<string, unknown>;
    if (obj.version !== FILE_VERSION) {
      throw new DesktopStoreError(`${path} 的 version 是 ${JSON.stringify(obj.version)}，這版只認 ${FILE_VERSION}`);
    }
    return obj;
  };

  const requireString = (obj: Record<string, unknown>, field: string, path: string): string => {
    const value = obj[field];
    if (typeof value !== 'string' || value === '') throw new DesktopStoreError(`${path} 缺 ${field}`);
    return value;
  };

  const open = (obj: Record<string, unknown>, field: string): string => {
    const sealed = requireString(obj, field, credentialsPath);
    let plain: string;
    try {
      plain = box.decrypt(Buffer.from(sealed, 'base64'));
    } catch (err) {
      // 換了電腦帳號、重灌系統、Keychain 項目被刪，都會解不開
      throw new DesktopStoreError(`${credentialsPath} 的 ${field} 解不開：${(err as Error).message}`);
    }
    if (plain === '') throw new DesktopStoreError(`${credentialsPath} 的 ${field} 解出來是空的`);
    return plain;
  };

  return {
    rosterPath,

    readSettings(): DesktopSettings | null {
      const obj = readJson(settingsPath);
      return obj === null ? null : { vaultDir: requireString(obj, 'vaultDir', settingsPath) };
    },

    writeSettings(settings: DesktopSettings): void {
      writeAtomic(settingsPath, JSON.stringify({ version: FILE_VERSION, vaultDir: settings.vaultDir }, null, 2));
    },

    readCredentials(): DesktopCredentials | null {
      const obj = readJson(credentialsPath);
      if (obj === null) return null;
      return {
        inviteId: requireString(obj, 'inviteId', credentialsPath),
        token: open(obj, 'token'),
        geminiApiKey: open(obj, 'geminiApiKey'),
      };
    },

    writeCredentials(credentials: DesktopCredentials): void {
      const seal = (plain: string) => box.encrypt(plain).toString('base64');
      writeAtomic(credentialsPath, JSON.stringify({
        version: FILE_VERSION,
        inviteId: credentials.inviteId,
        token: seal(credentials.token),
        geminiApiKey: seal(credentials.geminiApiKey),
      }, null, 2));
    },

    hasRoster(): boolean {
      return existsSync(rosterPath);
    },

    writeRoster(doc: RosterDocument): void {
      writeAtomic(rosterPath, JSON.stringify(doc));
    },

    /** 撤銷或登入資料壞掉時用：token、key、名單一起刪，投影資料夾留著（重新輸入邀請碼時不用再選一次） */
    clearCredentials(): void {
      rmSync(credentialsPath, { force: true });
      rmSync(rosterPath, { force: true });
    },
  };
}

export type DesktopStore = ReturnType<typeof createDesktopStore>;

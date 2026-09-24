/**
 * 桌面 app 啟動 server 子程序時給它的環境變數（vault plan「MeetPilot · 跨平台打包部署」E1）。
 *
 * 這個檔不 import electron，才能在 vitest 裡測。server 本身不知道自己跑在桌面 app 裡：
 * 它吃的還是網頁版同一組 MEETPILOT_* 變數，差別只在值由外殼決定。
 *
 * - 資料一律放 userData（macOS `~/Library/Application Support/MeetPilot`、Windows `%APPDATA%\MeetPilot`），
 *   不放安裝目錄：安裝目錄在更新時會被整個換掉，而且 Windows 的 Program Files 一般使用者寫不進去。
 * - 只綁 127.0.0.1：桌面 app 只給本機的視窗用，不對區網開。
 * - 投影資料夾由 E3 的設定頁讓記錄人自己選（通常是共享資料夾）。沒指定時放 userData，不用 server 的預設
 *   `~/MeetPilot Vault`：同一台機器上跑著網頁版的話，兩個各有資料庫的 server 會寫進同一個資料夾，
 *   投影器處理檔名衝突時會改名既有檔案。
 * - 錄音走 app 內錄音（`MEETPILOT_RECORDER=in-app`，E4），限流放寬到每分鐘 600 次（理由見下方）。
 * - 名單由外殼從 gateway 拿、寫成 userData 的 roster.json，以 `MEETPILOT_ROSTER_DOCUMENT` 交給 server 每次啟動匯入。
 * - 呼叫端環境裡跟 server 設定同名的變數（使用者機器上剛好設了 PORT、HOST、MEETPILOT_DB 之類）
 *   一律不往下傳：桌面 app 的行為不能因為使用者的 shell 設定而改變，而且那種錯很難從畫面上看出來。
 */
import { join } from 'node:path';

export interface ServerEnvInput {
  /** 呼叫端的 process.env；只挑系統需要的那幾個往下傳 */
  baseEnv: Record<string, string | undefined>;
  userDataDir: string;
  port: number;
  /** 外殼向 gateway 拿的那一把（E3）；呼叫端環境裡的 GEMINI_API_KEY 不用 */
  geminiApiKey?: string;
  /** 會議 markdown 投影到哪；沒給就是 userData/vault */
  vaultDir?: string;
  /** gateway 名單的本機副本（E3）；沒給就不設，server 不自動匯入 */
  rosterDocument?: string;
  /** 隨附的 ffmpeg／ffprobe（E2）。沒給就不設，server 走 PATH 上的（開發時） */
  ffmpeg?: { ffmpeg: string; ffprobe: string };
}

// server 會看的設定變數前綴與名稱。不在這張表裡的系統變數（PATH、HOME、SystemRoot、TEMP…）照傳，
// 子程序要靠它們找 ffmpeg、建暫存檔。
// 比對前轉大寫：Windows 的環境變數名稱不分大小寫，父程序帶 `meetpilot_basic_auth_user` 的話，
// 子程序照樣讀得到 MEETPILOT_BASIC_AUTH_USER（Codex review 2026-09-24）
const SERVER_CONFIG_KEYS = new Set(['HOST', 'PORT', 'NODE_ENV', 'GEMINI_API_KEY']);
const isServerConfigKey = (key: string): boolean => {
  const upper = key.toUpperCase();
  return SERVER_CONFIG_KEYS.has(upper) || upper.startsWith('MEETPILOT_');
};

export function buildServerEnv(input: ServerEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value !== undefined && !isServerConfigKey(key)) env[key] = value;
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(input.port),
    MEETPILOT_DB: join(input.userDataDir, 'meetpilot.db'),
    MEETPILOT_AUDIO_DIR: join(input.userDataDir, 'audio'),
    MEETPILOT_LLM_LOG: join(input.userDataDir, 'logs', 'llm.jsonl'),
    MEETPILOT_VAULT: input.vaultDir ?? join(input.userDataDir, 'vault'),
    // 錄音由 app 自己的視窗用麥克風錄（E4），不叫語音備忘錄：Windows 沒有，Mac 上也要每人手建三個捷徑
    MEETPILOT_RECORDER: 'in-app',
    // 限流是給對外開放的網頁版擋濫用的。桌面版只綁 127.0.0.1、只有自己的視窗，錄音中 polling（每分鐘 40 次）
    // 加分段上傳（每分鐘 6 次）已經逼近預設的 60，撞到 429 的話段落會一直重送
    MEETPILOT_API_RATE_LIMIT: '600',
  });
  if (input.rosterDocument !== undefined) env.MEETPILOT_ROSTER_DOCUMENT = input.rosterDocument;
  if (input.ffmpeg !== undefined) {
    env.MEETPILOT_FFMPEG = input.ffmpeg.ffmpeg;
    env.MEETPILOT_FFPROBE = input.ffmpeg.ffprobe;
  }
  if (input.geminiApiKey !== undefined && input.geminiApiKey.trim() !== '') {
    env.GEMINI_API_KEY = input.geminiApiKey.trim();
  }
  return env;
}

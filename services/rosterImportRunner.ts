/**
 * 讀 CSV 檔案並匯入 people／person_aliases 的膠合層。橋接 `rosterImport.ts`（純解析，
 * 不碰檔案系統）與 `peopleStore.ts`（真的寫入），供 `scripts/importRoster.ts`（手動 CLI）
 * 與 `server.ts`（啟動時自動補一次）共用，兩邊不重複寫「讀檔→解析→寫入」這段邏輯。
 *
 * 匯入決策仍是「CLI 而非 HTTP 路由」（2026-09-21）：這裡沒有新增 API 端點或 UI，
 * 只是把既有 CLI 的邏輯抽出來讓 server 啟動時也能呼叫同一套（2026-09-22 決策，見 plan）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRosterCsv } from './rosterImport';
import { PeopleStore, RosterImportOutcome } from './peopleStore';

export const DEFAULT_ROSTER_EMAIL_DOMAIN = 'liontravel.com';

/** CSV 內容格式錯誤時拋這個，跟「檔案讀不到」（Node 原生 ENOENT 等）分開，呼叫端各自決定怎麼處理 */
export class RosterImportFileError extends Error {}

/**
 * 讀 `csvPath`、解析、整批寫入 `peopleStore`。格式錯誤時整批拒絕（不部分寫入，
 * 沿用 `parseRosterCsv` 的既有規則），拋 `RosterImportFileError`，訊息含全部錯誤列。
 */
export function importRosterFromFile(
  csvPath: string,
  peopleStore: PeopleStore,
  now: number,
  defaultEmailDomain: string = DEFAULT_ROSTER_EMAIL_DOMAIN,
): RosterImportOutcome {
  const text = readFileSync(resolve(csvPath), 'utf-8');
  const result = parseRosterCsv(text, defaultEmailDomain);
  if (result.errors.length > 0) {
    const detail = result.errors.map((err) => `  - ${err}`).join('\n');
    throw new RosterImportFileError(`匯入中止，${result.errors.length} 個問題：\n${detail}`);
  }
  return peopleStore.importRoster(result.rows, now);
}

/**
 * `MEETPILOT_ROSTER_CSV` 未設或空白時回 `null`（維持原本「不自動做任何事」的行為，
 * 跟其他 `resolve*`（`resolveAudioDir`／`resolveVaultDir`）同一套慣例：空字串視同未設）。
 */
export function resolveRosterCsvPath(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.MEETPILOT_ROSTER_CSV ?? '').trim();
  return raw === '' ? null : raw;
}

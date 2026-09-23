/**
 * 名單發到 gateway（vault plan「MeetPilot · 跨平台打包部署」）的文件形狀。
 *
 * 名單放在 gateway 那個 Vercel 專案的私有 Blob store，pathname 固定 `roster/people.json`，
 * 內容 `{ version: 1, rows: RosterPersonImport[] }`。解析只有一份：`scripts/publishRoster.ts`
 * 用這裡的 `buildRosterDocument`（背後是 `parseRosterCsv`）驗過才上傳，gateway 只驗外殼、原樣轉交，
 * 各台 app 拿回來直接 `peopleStore.importRoster(rows)`，不在別處重寫一次 CSV 規則。
 * pathname 與 version 是跨 repo 的契約，gateway 端的同一組常數在 meetpilot-gateway 的 `lib/roster.ts`，
 * 改一邊要改另一邊。
 */
import { RosterPersonImport, parseRosterCsv } from './rosterImport';
import { RosterImportFileError } from './rosterImportRunner';

export const ROSTER_BLOB_PATHNAME = 'roster/people.json';
export const ROSTER_DOCUMENT_VERSION = 1;

export interface RosterDocument {
  version: typeof ROSTER_DOCUMENT_VERSION;
  rows: RosterPersonImport[];
}

/** 格式錯誤整批拒絕，規則跟 CLI 匯入同一套（`importRosterFromFile`），不上傳半份名單 */
export function buildRosterDocument(csvText: string, defaultEmailDomain: string): RosterDocument {
  const result = parseRosterCsv(csvText, defaultEmailDomain);
  if (result.errors.length > 0) {
    const detail = result.errors.map((err) => `  - ${err}`).join('\n');
    throw new RosterImportFileError(`發布中止，${result.errors.length} 個問題：\n${detail}`);
  }
  // 解析成功但一個人都沒有（只有表頭），發出去等於把每台 app 的名單清空
  if (result.rows.length === 0) throw new RosterImportFileError('發布中止：CSV 只有表頭，一個人都沒有');
  return { version: ROSTER_DOCUMENT_VERSION, rows: result.rows };
}

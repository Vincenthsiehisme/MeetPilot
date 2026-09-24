/**
 * 名單發到 gateway（vault plan「MeetPilot · 跨平台打包部署」）的文件形狀。
 *
 * 名單放在 gateway 那個 Vercel 專案的私有 Blob store，pathname 固定 `roster/people.json`，
 * 內容 `{ version: 1, rows: RosterPersonImport[] }`。解析只有一份：`scripts/publishRoster.ts`
 * 用這裡的 `buildRosterDocument`（背後是 `parseRosterCsv`）驗過才上傳，gateway 只驗外殼、原樣轉交，
 * 各台 app 拿回來直接 `peopleStore.importRoster(rows)`，不在別處重寫一次 CSV 規則。
 * pathname 與 version 是跨 repo 的契約，gateway 端的同一組常數在 meetpilot-gateway 的 `lib/roster.ts`，
 * 改一邊要改另一邊。
 *
 * 讀回來的那一端（E3）：桌面 app 的外殼從 gateway 拿到文件，用 `parseRosterDocument` 驗過才寫進
 * userData 的 `roster.json`，server 以 `MEETPILOT_ROSTER_DOCUMENT` 指到它、每次啟動匯入一次（upsert）。
 * gateway 只驗外殼，所以每一筆的欄位在這裡驗：型別對但內容空的員編、姓名寫進 people 表，
 * 選人畫面會出現一個沒有名字的人，而且沒有任何錯誤訊息。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PeopleStore, RosterImportOutcome } from './peopleStore';
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

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

/**
 * 驗 `buildRosterDocument` 產出、經 gateway 轉交的文件。欄位規則對齊 `parseRosterCsv` 的輸出：
 * 員編、姓名、email 非空，title／department 是字串或 null，aliases 是字串陣列，員編不重複。
 * 任何一筆不對就整份拒絕，跟 CSV 匯入同一條規則，不匯半份。`source` 只用在錯誤訊息裡（檔案路徑或網址）。
 */
export function parseRosterDocument(text: string, source: string): RosterDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RosterImportFileError(`名單文件 ${source} 不是 JSON：${(err as Error).message}`);
  }
  const doc = raw as { version?: unknown; rows?: unknown } | null;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new RosterImportFileError(`名單文件 ${source} 不是物件`);
  }
  if (doc.version !== ROSTER_DOCUMENT_VERSION) {
    throw new RosterImportFileError(
      `名單文件 ${source} 的 version 是 ${JSON.stringify(doc.version)}，這版 MeetPilot 只認 ${ROSTER_DOCUMENT_VERSION}`,
    );
  }
  if (!Array.isArray(doc.rows) || doc.rows.length === 0) {
    throw new RosterImportFileError(`名單文件 ${source} 的 rows 不是非空陣列`);
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  doc.rows.forEach((row: unknown, index) => {
    const r = row as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`rows[${index}] 不是物件`);
      return;
    }
    const problems: string[] = [];
    if (!isNonEmptyString(r.employeeId)) problems.push('employeeId 不是非空字串');
    if (!isNonEmptyString(r.displayName)) problems.push('displayName 不是非空字串');
    if (!isNonEmptyString(r.email)) problems.push('email 不是非空字串');
    if (!isStringOrNull(r.title)) problems.push('title 不是字串或 null');
    if (!isStringOrNull(r.department)) problems.push('department 不是字串或 null');
    if (!Array.isArray(r.aliases) || !r.aliases.every((a) => typeof a === 'string')) {
      problems.push('aliases 不是字串陣列');
    }
    if (isNonEmptyString(r.employeeId)) {
      if (seen.has(r.employeeId)) problems.push(`employeeId「${r.employeeId}」重複`);
      seen.add(r.employeeId);
    }
    if (problems.length > 0) errors.push(`rows[${index}]：${problems.join('、')}`);
  });
  if (errors.length > 0) {
    const detail = errors.map((err) => `  - ${err}`).join('\n');
    throw new RosterImportFileError(`名單文件 ${source} 有 ${errors.length} 筆不對，整份不匯入：\n${detail}`);
  }
  return { version: ROSTER_DOCUMENT_VERSION, rows: doc.rows as RosterPersonImport[] };
}

/** 讀檔、驗過、整批寫入。檔案讀不到原樣拋 Node 的錯（ENOENT 等），內容不對拋 `RosterImportFileError` */
export function importRosterDocumentFromFile(
  documentPath: string,
  peopleStore: PeopleStore,
  now: number,
): RosterImportOutcome {
  const fullPath = resolve(documentPath);
  const doc = parseRosterDocument(readFileSync(fullPath, 'utf-8'), fullPath);
  return peopleStore.importRoster(doc.rows, now);
}

/** `MEETPILOT_ROSTER_DOCUMENT` 未設或空白時回 `null`，跟 `resolveRosterCsvPath` 同一套慣例 */
export function resolveRosterDocumentPath(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.MEETPILOT_ROSTER_DOCUMENT ?? '').trim();
  return raw === '' ? null : raw;
}

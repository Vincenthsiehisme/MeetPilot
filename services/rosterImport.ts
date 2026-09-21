/**
 * 人員名單匯入的純函式（SDD 1.3.2〈名單來源〉）。不碰 DB，方便單獨測；
 * 寫入交給 `services/peopleStore.ts`，兩者的邊界是「算出要寫什麼」與「真的寫進去」。
 *
 * CSV 解析刻意不處理帶逗號或跨行的欄位（不支援 RFC4180 的引號跳脫）：真實樣本
 * （`eval-data/meeting_attendee_static_master_utf8.csv`，388 人）已查證所有欄位都不含
 * 逗號或換行，完整的引號跳脫是預防性複雜度。改用逐列切欄＋欄位數量檢查，數量兜不起來
 * 就整批拒絕，不猜、不部分寫入（2026-09-21 決策）。
 */

/** 匯入來源檔的必要欄位。順序不拘，靠欄位名找，不靠位置——來源檔換一次匯出順序不該讓匯入失敗 */
const REQUIRED_COLUMNS = [
  'employee_id',
  'name_zh',
  'alias',
  'title',
  'email',
  'organization',
  'display_names',
  'match_keys',
] as const;

export interface RosterPersonImport {
  employeeId: string;
  displayName: string;
  title: string | null;
  email: string;
  department: string | null;
  /** 這個人的別名候選，已去重、已排除等於 employeeId 的項目（見 buildAliasCandidates） */
  aliases: string[];
}

/**
 * 不用 discriminated union（`{ok:true;rows}|{ok:false;errors}`）：這個 repo 的 tsconfig
 * 沒開 strict，`if (!result.ok)` 之後屬性收斂不到對應分支（同 `meetingEdits.ts` 的既有註解），
 * 呼叫端得靠明寫轉型才能用，比這個扁平形狀更難讀。判斷方式改成看 `errors.length`：
 * 非空代表整批被拒絕，此時 `rows` 保證是空陣列，不是「猜」出來的半批資料。
 */
export interface RosterParseResult {
  rows: RosterPersonImport[];
  errors: string[];
}

/**
 * 逐列切欄。不支援欄位內帶逗號或換行（見檔頭說明），欄位數與表頭不符的列視為格式錯誤，
 * 由呼叫端決定要不要整批拒絕。空白列（純換行）略過，不算錯誤，不算資料。
 */
const splitLines = (text: string): string[] =>
  text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');

const splitFields = (line: string): string[] => line.split(',').map((f) => f.trim());

/**
 * 別名候選來源是 `display_names` ∪ `match_keys`（扣掉等於 employeeId 的項）∪ `alias` 單欄，
 * 不是只用其中一欄（2026-09-21 決策）：三者合起來才有中文正名、英文暱稱、email 帳號三種寫法。
 * `match_keys` 裡的 employeeId 本身不收——逐字稿裡不會有人講出員編當名字。
 * 用 `Set` 去重，比對用原字串（大小寫敏感），排序用 `Array.from` 保留插入順序方便測試斷言。
 */
export const buildAliasCandidates = (
  employeeId: string,
  displayNames: string,
  matchKeys: string,
  alias: string,
): string[] => {
  const candidates = new Set<string>();
  const addAll = (raw: string, excludeEmployeeId: boolean) => {
    for (const part of raw.split('|').map((s) => s.trim())) {
      if (part === '') continue;
      if (excludeEmployeeId && part.toLowerCase() === employeeId.toLowerCase()) continue;
      candidates.add(part);
    }
  };
  addAll(displayNames, false);
  addAll(matchKeys, true);
  if (alias.trim() !== '') candidates.add(alias.trim());
  return Array.from(candidates);
};

/**
 * email 缺網域時補上預設網域（2026-09-21 使用者確認：`@liontravel.com`）。已經帶 `@` 的原樣保留——
 * 真實樣本裡 12 筆已帶完整 email 的人分屬集團其他子公司網域，不是這個預設網域，不能覆寫。
 */
export const completeEmail = (raw: string, defaultDomain: string): string =>
  raw.includes('@') ? raw : `${raw}@${defaultDomain}`;

/**
 * 解析整份 CSV 文字。**整批驗證、整批拒絕**（SDD 2.3〈名單匯入格式錯誤〉）：
 * 任何一列有問題，回傳的 `errors` 就列出所有問題列，`rows` 一筆都不給，呼叫端不該以為
 * 「至少匯進去一部分」是安全的部分成功。
 */
export const parseRosterCsv = (text: string, defaultEmailDomain: string): RosterParseResult => {
  const lines = splitLines(text);
  if (lines.length === 0) return { rows: [], errors: ['檔案是空的'] };

  const header = splitFields(lines[0]);
  const missingColumns = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  if (missingColumns.length > 0) {
    return { rows: [], errors: [`表頭缺少必要欄位：${missingColumns.join('、')}`] };
  }
  const colIndex = (name: string): number => header.indexOf(name);

  const errors: string[] = [];
  const rows: RosterPersonImport[] = [];
  const seenEmployeeIds = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1; // 1-based，含表頭那一行
    const fields = splitFields(lines[i]);
    if (fields.length !== header.length) {
      errors.push(`第 ${lineNumber} 行：欄位數 ${fields.length} 與表頭 ${header.length} 不符（可能含逗號或換行，本解析器不支援）`);
      continue;
    }

    const employeeId = fields[colIndex('employee_id')];
    const displayName = fields[colIndex('name_zh')];
    const email = fields[colIndex('email')];

    if (employeeId === '') { errors.push(`第 ${lineNumber} 行：employee_id 是空的`); continue; }
    if (displayName === '') { errors.push(`第 ${lineNumber} 行：name_zh 是空的`); continue; }
    if (email === '') { errors.push(`第 ${lineNumber} 行：email 是空的`); continue; }
    if (seenEmployeeIds.has(employeeId)) {
      errors.push(`第 ${lineNumber} 行：employee_id「${employeeId}」在檔案裡重複出現`);
      continue;
    }
    seenEmployeeIds.add(employeeId);

    const title = fields[colIndex('title')];
    const department = fields[colIndex('organization')];
    const alias = fields[colIndex('alias')];
    const displayNames = fields[colIndex('display_names')];
    const matchKeys = fields[colIndex('match_keys')];

    rows.push({
      employeeId,
      displayName,
      title: title === '' ? null : title,
      email: completeEmail(email, defaultEmailDomain),
      department: department === '' ? null : department,
      aliases: buildAliasCandidates(employeeId, displayNames, matchKeys, alias),
    });
  }

  if (errors.length > 0) return { rows: [], errors };
  return { rows, errors: [] };
};

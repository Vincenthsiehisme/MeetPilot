import { describe, expect, it } from 'vitest';
import { ROSTER_BLOB_PATHNAME, ROSTER_DOCUMENT_VERSION, buildRosterDocument } from './rosterDocument';
import { RosterImportFileError } from './rosterImportRunner';

const HEADER = 'employee_id,name_zh,alias,title,email,organization,display_names,match_keys';

describe('buildRosterDocument', () => {
  it('合法 CSV 包成 { version: 1, rows }，rows 就是 parseRosterCsv 的輸出', () => {
    const csv = [HEADER, '1001,王小明,Ming,工程師,ming,研發部,王小明 | Ming,1001 | 王小明 | ming'].join('\n');
    const doc = buildRosterDocument(csv, 'example.com');
    expect(doc.version).toBe(1);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]).toMatchObject({ employeeId: '1001', displayName: '王小明', email: 'ming@example.com' });
  });

  it('格式錯誤整批拒絕，不發半份名單', () => {
    const csv = [HEADER, '1001,王小明,Ming,工程師,ming,研發部,王小明 | Ming,1001 | 王小明 | ming', '1002,少一欄'].join('\n');
    expect(() => buildRosterDocument(csv, 'example.com')).toThrow(RosterImportFileError);
    expect(() => buildRosterDocument(csv, 'example.com')).toThrow(/發布中止/);
  });

  it('只有表頭拒絕：發出去等於把每台 app 的名單清空', () => {
    expect(() => buildRosterDocument(HEADER, 'example.com')).toThrow(/一個人都沒有/);
  });

  it('pathname 與 version 釘死：跟 meetpilot-gateway 的 lib/roster.ts 是同一組契約，改了要兩邊一起改', () => {
    expect(ROSTER_BLOB_PATHNAME).toBe('roster/people.json');
    expect(ROSTER_DOCUMENT_VERSION).toBe(1);
  });
});

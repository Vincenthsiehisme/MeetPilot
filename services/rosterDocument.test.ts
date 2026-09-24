import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { PeopleStore, createPeopleStore } from './peopleStore';
import {
  ROSTER_BLOB_PATHNAME,
  ROSTER_DOCUMENT_VERSION,
  buildRosterDocument,
  importRosterDocumentFromFile,
  parseRosterDocument,
  resolveRosterDocumentPath,
} from './rosterDocument';
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

const person = (overrides: Record<string, unknown> = {}) => ({
  employeeId: '1001',
  displayName: '王小明',
  title: '工程師',
  email: 'ming@example.com',
  department: null,
  aliases: ['Ming', 'ming'],
  ...overrides,
});
const docText = (rows: unknown[], version: unknown = 1) => JSON.stringify({ version, rows });

describe('parseRosterDocument', () => {
  it('buildRosterDocument 的輸出原樣讀得回來', () => {
    const csv = [HEADER, '1001,王小明,Ming,工程師,ming,研發部,王小明 | Ming,1001 | 王小明 | ming'].join('\n');
    const built = buildRosterDocument(csv, 'example.com');
    expect(parseRosterDocument(JSON.stringify(built), 'x')).toEqual(built);
  });

  it('不是 JSON、不是物件、版本不對、rows 空或不是陣列，都整份拒絕並講出來源', () => {
    expect(() => parseRosterDocument('{', '/d/roster.json')).toThrow(/\/d\/roster\.json 不是 JSON/);
    expect(() => parseRosterDocument('[]', 'x')).toThrow(/不是物件/);
    expect(() => parseRosterDocument(docText([person()], 2), 'x')).toThrow(/version 是 2/);
    expect(() => parseRosterDocument(docText([]), 'x')).toThrow(/rows 不是非空陣列/);
    expect(() => parseRosterDocument(JSON.stringify({ version: 1, rows: {} }), 'x')).toThrow(/rows 不是非空陣列/);
  });

  it('型別對但內容空的員編、姓名、email 擋下：寫進去的話選人畫面會出現沒有名字的人', () => {
    for (const bad of [{ employeeId: ' ' }, { displayName: '' }, { email: '' }, { employeeId: 1001 }]) {
      expect(() => parseRosterDocument(docText([person(bad)]), 'x')).toThrow(RosterImportFileError);
    }
  });

  it('title／department 只收字串或 null，aliases 只收字串陣列，員編不能重複；一筆不對整份不收並列出每一筆', () => {
    expect(() => parseRosterDocument(docText([person({ title: 3 })]), 'x')).toThrow(/title 不是字串或 null/);
    expect(() => parseRosterDocument(docText([person({ department: {} })]), 'x')).toThrow(/department/);
    expect(() => parseRosterDocument(docText([person({ aliases: 'Ming' })]), 'x')).toThrow(/aliases 不是字串陣列/);
    expect(() => parseRosterDocument(docText([person({ aliases: ['a', 2] })]), 'x')).toThrow(/aliases/);
    expect(() => parseRosterDocument(docText([person(), person()]), 'x')).toThrow(/rows\[1\]：employeeId「1001」重複/);
    expect(() => parseRosterDocument(docText([person({ email: '' }), null]), 'x')).toThrow(/2 筆不對/);
  });
});

describe('importRosterDocumentFromFile', () => {
  let db: DatabaseSync;
  let store: PeopleStore;
  let dir: string;
  beforeEach(() => {
    db = openMeetingDb(':memory:');
    store = createPeopleStore(db);
    dir = mkdtempSync(join(tmpdir(), 'meetpilot-roster-doc-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('每次都 upsert：同一份再匯一次不重複，名單更新後改到既有的人', () => {
    const path = join(dir, 'roster.json');
    writeFileSync(path, docText([person()]));
    expect(importRosterDocumentFromFile(path, store, 1)).toEqual({ peopleWritten: 1, aliasesAdded: 2 });
    expect(importRosterDocumentFromFile(path, store, 2)).toEqual({ peopleWritten: 1, aliasesAdded: 0 });
    writeFileSync(path, docText([person({ title: '資深工程師' }), person({ employeeId: '1002', displayName: '李四', aliases: [] })]));
    importRosterDocumentFromFile(path, store, 3);
    expect(store.getPerson('1001')?.title).toBe('資深工程師');
    expect(store.listPeople()).toHaveLength(2);
  });

  it('內容不對整份不寫，檔案不在原樣拋 ENOENT', () => {
    const path = join(dir, 'roster.json');
    writeFileSync(path, docText([person(), person({ employeeId: '' })]));
    expect(() => importRosterDocumentFromFile(path, store, 1)).toThrow(RosterImportFileError);
    expect(store.listPeople()).toHaveLength(0);
    expect(() => importRosterDocumentFromFile(join(dir, 'nope.json'), store, 1)).toThrow(/ENOENT/);
  });
});

describe('resolveRosterDocumentPath', () => {
  it('沒設或空白回 null，有設原樣回', () => {
    expect(resolveRosterDocumentPath({})).toBeNull();
    expect(resolveRosterDocumentPath({ MEETPILOT_ROSTER_DOCUMENT: '  ' })).toBeNull();
    expect(resolveRosterDocumentPath({ MEETPILOT_ROSTER_DOCUMENT: ' /d/roster.json ' })).toBe('/d/roster.json');
  });
});

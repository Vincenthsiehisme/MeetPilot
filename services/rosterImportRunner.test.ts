import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { createPeopleStore, PeopleStore } from './peopleStore';
import { importRosterFromFile, resolveRosterCsvPath, RosterImportFileError } from './rosterImportRunner';

const HEADER = 'employee_id,name_zh,alias,title,email,organization,display_names,match_keys';
const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let store: PeopleStore;
let dir: string;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createPeopleStore(db);
  dir = mkdtempSync(join(tmpdir(), 'meetpilot-roster-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('importRosterFromFile', () => {
  it('讀檔、解析、寫入 peopleStore，回報跟 CLI 一樣的 outcome', () => {
    const csv = [
      HEADER,
      '4323,陳國煌,Philchen,資深協理,philchen,經營企劃部/通路企劃組,陳國煌 | Philchen,4323 | 陳國煌 | philchen',
    ].join('\n');
    const csvPath = join(dir, 'roster.csv');
    writeFileSync(csvPath, csv, 'utf-8');

    const outcome = importRosterFromFile(csvPath, store, T0);

    expect(outcome.peopleWritten).toBe(1);
    expect(store.getPerson('4323')?.display_name).toBe('陳國煌');
  });

  it('CSV 格式錯誤時整批拒絕，拋 RosterImportFileError，不寫入任何一筆', () => {
    const csv = [HEADER, '4323,陳國煌'].join('\n'); // 欄位數量不對
    const csvPath = join(dir, 'roster.csv');
    writeFileSync(csvPath, csv, 'utf-8');

    expect(() => importRosterFromFile(csvPath, store, T0)).toThrow(RosterImportFileError);
    expect(store.listPeople()).toHaveLength(0);
  });

  it('檔案不存在時原樣拋出 Node 的 ENOENT，不吞掉、不當成格式錯誤處理', () => {
    const missingPath = join(dir, 'not-there.csv');
    expect(() => importRosterFromFile(missingPath, store, T0)).toThrow(/ENOENT/);
  });
});

describe('resolveRosterCsvPath', () => {
  it('未設定時回 null（維持原本不自動做任何事的行為）', () => {
    expect(resolveRosterCsvPath({})).toBeNull();
  });

  it('空字串視同未設定', () => {
    expect(resolveRosterCsvPath({ MEETPILOT_ROSTER_CSV: '   ' })).toBeNull();
  });

  it('回傳去除頭尾空白後的路徑', () => {
    expect(resolveRosterCsvPath({ MEETPILOT_ROSTER_CSV: '  eval-data/roster.csv  ' })).toBe('eval-data/roster.csv');
  });
});

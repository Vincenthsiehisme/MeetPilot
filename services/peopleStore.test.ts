import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openMeetingDb } from './meetingDb';
import { createPeopleStore, PeopleStore } from './peopleStore';
import { RosterPersonImport } from './rosterImport';

let db: DatabaseSync;
let store: PeopleStore;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createPeopleStore(db);
});

afterEach(() => {
  db.close();
});

const person = (overrides: Partial<RosterPersonImport> = {}): RosterPersonImport => ({
  employeeId: '4323',
  displayName: '陳國煌',
  title: '資深協理',
  email: 'philchen@liontravel.com',
  department: '經營企劃部/通路企劃組',
  aliases: ['Philchen', 'philchen', '陳國煌 Philchen'],
  ...overrides,
});

describe('importRoster', () => {
  it('寫入 people 與 person_aliases，回報寫入筆數', () => {
    const outcome = store.importRoster([person()], T0);
    expect(outcome).toEqual({ peopleWritten: 1, aliasesAdded: 3 });

    const p = store.getPerson('4323');
    expect(p).toMatchObject({
      employee_id: '4323',
      display_name: '陳國煌',
      title: '資深協理',
      email: 'philchen@liontravel.com',
      department: '經營企劃部/通路企劃組',
      active: true, // 匯入預設在職（2026-09-21 使用者裁決）
    });

    const aliases = store.listAliasesForEmployees(['4323']).map((a) => a.alias).sort();
    expect(aliases).toEqual(['philchen', 'Philchen', '陳國煌 Philchen'].sort());
    expect(store.listAliasesForEmployees(['4323']).every((a) => a.source === 'import')).toBe(true);
  });

  it('重新匯入同一個人不會產生重複別名', () => {
    store.importRoster([person()], T0);
    const second = store.importRoster([person()], T0 + 1000);
    expect(second.aliasesAdded).toBe(0); // 三個別名都已存在，OR IGNORE 全部跳過
    expect(store.listAliasesForEmployees(['4323'])).toHaveLength(3);
  });

  it('重新匯入會更新 display_name／title／email／department，但不動 active', () => {
    store.importRoster([person()], T0);
    // 模擬「之後要改」的離職維護機制（雖然這一版還沒有介面，直接操作 DB 驗證約束成立）
    db.prepare('UPDATE people SET active = 0 WHERE employee_id = ?').run('4323');

    store.importRoster([person({ displayName: '陳國煌（改名）', title: '協理' })], T0 + 1000);

    const p = store.getPerson('4323');
    expect(p?.display_name).toBe('陳國煌（改名）');
    expect(p?.title).toBe('協理');
    expect(p?.active).toBe(false); // 重新匯入沒有把它改回在職
  });

  it('新別名可以在既有別名之外累加（例如來源檔更新後多了一個別名）', () => {
    store.importRoster([person({ aliases: ['Philchen'] })], T0);
    const second = store.importRoster([person({ aliases: ['Philchen', 'PC'] })], T0 + 1000);
    expect(second.aliasesAdded).toBe(1); // 只有 'PC' 是新的
    expect(store.listAliasesForEmployees(['4323'])).toHaveLength(2);
  });

  it('一次匯入多人，各自的別名互不影響', () => {
    const outcome = store.importRoster(
      [
        person(),
        person({ employeeId: '6036', displayName: '陳雅婷', aliases: ['Tina', 'tina'] }),
      ],
      T0,
    );
    expect(outcome).toEqual({ peopleWritten: 2, aliasesAdded: 5 });
    expect(store.listPeople()).toHaveLength(2);
  });

  it('匯入中途出錯時整批回滾（模擬：同一個 employee_id 出現兩次時，第二筆的 alias 寫入撞到約束不該發生於此，改測交易邊界本身用一支會拋錯的資料）', () => {
    // people.email 是 NOT NULL，用一筆會違反約束的資料觸發交易失敗，驗證前面已寫的列不會殘留
    const rows: RosterPersonImport[] = [
      person(),
      person({ employeeId: '9999', email: null as unknown as string }),
    ];
    expect(() => store.importRoster(rows, T0)).toThrow();
    expect(store.getPerson('4323')).toBeNull(); // 第一筆也被回滾，不是部分寫入
  });
});

describe('addManualAlias', () => {
  it('人工確認的別名 source 是 manual', () => {
    store.importRoster([person({ aliases: [] })], T0);
    store.addManualAlias('4323', '阿煌', T0 + 1000);

    const aliases = store.listAliasesForEmployees(['4323']);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ alias: '阿煌', source: 'manual', corrected_at: T0 + 1000 });
  });

  it('重新匯入不會覆寫人工新增的別名', () => {
    store.importRoster([person({ aliases: ['Philchen'] })], T0);
    store.addManualAlias('4323', '阿煌', T0 + 1000);
    store.importRoster([person({ aliases: ['Philchen'] })], T0 + 2000);

    const aliases = store.listAliasesForEmployees(['4323']);
    const manual = aliases.find((a) => a.alias === '阿煌');
    expect(manual?.source).toBe('manual'); // 沒有被匯入的 source='import' 蓋掉
  });

  it('對不存在的員編加別名要明確報錯，不靜默略過', () => {
    expect(() => store.addManualAlias('no-such-id', '某某', T0)).toThrow(/找不到員編/);
  });

  // 人名校正 N5：needs_review 常見的情境是「這個別名匯入時就已經存在」（例如自動比對出的
  // 兩字短別名），人只是確認它對。之前用 INSERT OR IGNORE 的話這裡完全沒有效果，
  // source 永遠停在 import，NameResolver 判斷「有沒有被人工確認過」就永遠是 false
  it('人工確認一個匯入時已存在的別名，source 從 import 升級成 manual', () => {
    store.importRoster([person({ aliases: ['小煌'] })], T0);
    expect(store.listAliasesForEmployees(['4323']).find((a) => a.alias === '小煌')?.source).toBe('import');

    store.addManualAlias('4323', '小煌', T0 + 1000);

    const upgraded = store.listAliasesForEmployees(['4323']).find((a) => a.alias === '小煌');
    expect(upgraded).toMatchObject({ alias: '小煌', source: 'manual', corrected_at: T0 + 1000 });
    // 只有這一筆，不是額外多一筆重複的別名列
    expect(store.listAliasesForEmployees(['4323']).filter((a) => a.alias === '小煌')).toHaveLength(1);
  });

  it('重複確認同一個別名是冪等的，corrected_at 更新成最新一次', () => {
    store.importRoster([person({ aliases: [] })], T0);
    store.addManualAlias('4323', '阿煌', T0 + 1000);
    store.addManualAlias('4323', '阿煌', T0 + 2000);

    const aliases = store.listAliasesForEmployees(['4323']).filter((a) => a.alias === '阿煌');
    expect(aliases).toHaveLength(1);
    expect(aliases[0].corrected_at).toBe(T0 + 2000);
  });
});

describe('listAliasesForEmployees', () => {
  it('空清單回空陣列，不查全表', () => {
    store.importRoster([person()], T0);
    expect(store.listAliasesForEmployees([])).toEqual([]);
  });

  it('只回傳指定員編的別名，不含其他人的', () => {
    store.importRoster(
      [person(), person({ employeeId: '6036', displayName: '陳雅婷', aliases: ['Tina'] })],
      T0,
    );
    const aliases = store.listAliasesForEmployees(['6036']);
    expect(aliases.every((a) => a.employee_id === '6036')).toBe(true);
  });
});

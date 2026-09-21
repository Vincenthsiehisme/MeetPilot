/**
 * PeopleStore（SDD 1.3.2、第 3 節 Module 表〈v0.7 新增〉）。
 *
 * 不變量：`source = manual` 的別名不可被匯入覆寫（1.2）；離職不刪除只標 `active = false`
 * （這一版尚未實作標記介面，`active` 全部維持匯入時的預設值 `true`，維護方式待定，見 plan
 * 的 Next actions，不是遺漏）。
 * 錯誤模式：匯入格式錯誤整批拒絕，不部分寫入——格式驗證在 `rosterImport.ts`，這裡假設
 * 收到的 `RosterPersonImport[]` 已經通過驗證。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RosterPersonImport } from './rosterImport';

export interface Person {
  employee_id: string;
  display_name: string;
  title: string | null;
  email: string;
  department: string | null;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface PersonAlias {
  alias_id: string;
  employee_id: string;
  alias: string;
  source: 'import' | 'manual';
  corrected_at: number | null;
}

export interface RosterImportOutcome {
  peopleWritten: number;
  aliasesAdded: number;
}

interface PersonRow {
  employee_id: string;
  display_name: string;
  title: string | null;
  email: string;
  department: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

const toPerson = (row: PersonRow): Person => ({
  ...row,
  active: row.active === 1,
});

export const createPeopleStore = (db: DatabaseSync) => {
  const selectPerson = db.prepare('SELECT * FROM people WHERE employee_id = ?');
  const selectAllPeople = db.prepare('SELECT * FROM people ORDER BY employee_id');
  const selectAliasesForEmployees = (placeholders: string) =>
    db.prepare(`SELECT * FROM person_aliases WHERE employee_id IN (${placeholders})`);

  // upsert 不寫 active：重新匯入是常態操作（名單更新、跑第二次），
  // 不能因為這個動作把人工（或未來機制）標成離職的人悄悄改回在職，反之亦然。
  // 首次寫入的 INSERT 分支才決定初始值，這裡固定給 1（在職）——
  // 使用者 2026-09-21 裁決：靜態名單是單一時間點快照，看不出離職，全部先當在職。
  const upsertPerson = db.prepare(`
    INSERT INTO people (employee_id, display_name, title, email, department, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET
      display_name = excluded.display_name,
      title = excluded.title,
      email = excluded.email,
      department = excluded.department,
      updated_at = excluded.updated_at
  `);

  // OR IGNORE 靠 UNIQUE(employee_id, alias) 擋重複：不分來源，已存在的列一律不覆寫。
  // 這一條規則同時滿足「重新匯入不重複」與「不覆寫 source = manual」（1.2），
  // 不需要先查再決定要不要寫的兩段式邏輯
  const insertAliasIfAbsent = db.prepare(`
    INSERT OR IGNORE INTO person_aliases (alias_id, employee_id, alias, source, corrected_at, created_at)
    VALUES (?, ?, ?, 'import', NULL, ?)
  `);

  // 跟 insertAliasIfAbsent 不是同一條規則：人工確認（N5）很常見的情境是「這個別名匯入時
  // 就已經存在，人只是確認它對」（例如自動比對出的兩字短別名，人一鍵確認）。如果也用
  // INSERT OR IGNORE，既有的 import 列會擋掉這次寫入、source 永遠停在 import，
  // 人工確認等於沒發生——`NameResolver` 判斷「這個別名是不是已經人工確認過」時只看
  // source 是不是 manual，短別名規則因此永遠解不掉。這裡改用 UPSERT，把既有列的
  // source 升級成 manual；反過來（import 蓋掉 manual）永遠不會發生，因為只有這個函式
  // 寫 source = 'manual'，insertAliasIfAbsent 從來不覆寫任何既有列
  const insertManualAlias = db.prepare(`
    INSERT INTO person_aliases (alias_id, employee_id, alias, source, corrected_at, created_at)
    VALUES (?, ?, ?, 'manual', ?, ?)
    ON CONFLICT(employee_id, alias) DO UPDATE SET source = 'manual', corrected_at = excluded.corrected_at
  `);

  return {
    getPerson: (employeeId: string): Person | null => {
      const row = selectPerson.get(employeeId) as unknown as PersonRow | undefined;
      return row ? toPerson(row) : null;
    },

    listPeople: (): Person[] =>
      (selectAllPeople.all() as unknown as PersonRow[]).map(toPerson),

    /** 查一批員編各自的別名，NameResolver（N4）比對時用。employeeIds 為空回空陣列，不查全表 */
    listAliasesForEmployees: (employeeIds: readonly string[]): PersonAlias[] => {
      if (employeeIds.length === 0) return [];
      const placeholders = employeeIds.map(() => '?').join(', ');
      return selectAliasesForEmployees(placeholders).all(...employeeIds) as unknown as PersonAlias[];
    },

    /**
     * 人工確認 `needs_review` 的人名時呼叫（N5）。跟匯入別名共用同一張表與同一條
     * 「不覆寫既有列」規則，差別只在 `source` 與 `corrected_at`。
     */
    addManualAlias: (employeeId: string, alias: string, now: number): void => {
      if (!selectPerson.get(employeeId)) {
        throw new Error(`加別名失敗：找不到員編 ${employeeId}`);
      }
      insertManualAlias.run(randomUUID(), employeeId, alias, now, now);
    },

    /**
     * 整批匯入。呼叫端（CLI）保證傳進來的資料已經過 `rosterImport.parseRosterCsv` 驗證，
     * 這裡不重新驗證格式，只負責寫入；一支交易內完成，中途失敗全部回滾，不留半批資料。
     */
    importRoster: (rows: readonly RosterPersonImport[], now: number): RosterImportOutcome => {
      db.exec('BEGIN');
      try {
        let aliasesAdded = 0;
        for (const row of rows) {
          upsertPerson.run(
            row.employeeId, row.displayName, row.title, row.email, row.department, now, now,
          );
          for (const alias of row.aliases) {
            const result = insertAliasIfAbsent.run(randomUUID(), row.employeeId, alias, now);
            if (result.changes > 0) aliasesAdded += 1;
          }
        }
        db.exec('COMMIT');
        return { peopleWritten: rows.length, aliasesAdded };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
};

export type PeopleStore = ReturnType<typeof createPeopleStore>;

/**
 * 人員名單匯入的進入點（SDD 1.3.2、D-015：一期人工匯入）。
 *
 *   npx tsx scripts/importRoster.ts <CSV 路徑>
 *
 * 獨立可執行、不被其他模組 import，比照 `eval/run.ts` 的既有慣例。一期只需要一個人
 * 偶爾手動跑一次，不建 API 端點或 UI（2026-09-21 決策，見 plan〈決策〉）。
 *
 * 讀檔＋解析＋寫入的邏輯在 `services/rosterImportRunner.ts`，跟 `server.ts` 啟動時的
 * 自動匯入共用（2026-09-22 決策），這支腳本只負責 CLI 的輸入輸出。
 *
 * 寫入哪個資料庫由 `MEETPILOT_DB` 決定（跟 server.ts 同一個環境變數，同一份 resolveDbPath），
 * 不另外發明一個參數：本地跑 server 用的就是這份名單，兩者本來就該是同一個資料庫。
 */
import { openMeetingDb, resolveDbPath } from '../services/meetingDb';
import { createPeopleStore } from '../services/peopleStore';
import { importRosterFromFile, RosterImportFileError } from '../services/rosterImportRunner';

function main(): void {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('用法：npx tsx scripts/importRoster.ts <CSV 路徑>');
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveDbPath(process.env);
  const db = openMeetingDb(dbPath);
  try {
    const store = createPeopleStore(db);
    const outcome = importRosterFromFile(csvPath, store, Date.now());
    console.log(`寫入 ${dbPath}：`);
    console.log(`  people：${outcome.peopleWritten} 筆（新增或更新）`);
    console.log(`  person_aliases：新增 ${outcome.aliasesAdded} 筆（重複的別名已跳過，不重複寫入）`);
  } catch (err) {
    if (err instanceof RosterImportFileError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    db.close();
  }
}

main();

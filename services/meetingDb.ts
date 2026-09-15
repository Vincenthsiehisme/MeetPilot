/**
 * 一期的結構化儲存：server 端 SQLite（SDD 0.2.1）。
 *
 * 為什麼是 server 端而不是沿用 IndexedDB：D-010 把轉錄狀態機搬到 server，而 IndexedDB
 * 在瀏覽器裡、server 讀不到；加上 S2 的關聯要做向量相似度查詢，IndexedDB 也做不到。
 * 兩個理由各自獨立成立。
 *
 * 用 node 內建的 `node:sqlite`，不加原生依賴。
 *
 * 這一版只建 migration 真的要落地的四張表。TopicTag、TopicLink、排除紀錄、RecallFeedback
 * 等到 W3 到 W6 各自實作時再加一條 migration：現在建空表等於憑空猜欄位，而那些欄位的形狀
 * （例如 TopicLink 的判定理由）要等策略實作完才確定。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * 一條 migration 一個元素，索引加一就是它帶到的版本。只能往後追加，不能改既有的：
 * 已經跑過的資料庫不會重跑前面的條目。
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meetings (
    meeting_id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_file_name TEXT,
    source_file_size INTEGER,
    origin TEXT NOT NULL CHECK (origin IN ('native', 'migrated')),
    error TEXT,
    processed_slices INTEGER,
    total_slices INTEGER,
    meeting_context TEXT
  );

  CREATE TABLE transcripts (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    segments TEXT NOT NULL,
    polished_content TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE analyses (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL,
    overview TEXT NOT NULL,
    topics TEXT NOT NULL,
    decisions TEXT NOT NULL,
    action_items TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE meeting_tags (
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (meeting_id, tag)
  );

  CREATE INDEX idx_meetings_status ON meetings(status);
  CREATE INDEX idx_meetings_created_at ON meetings(created_at);
  `,
  // W2-2：每個切片接縫的對齊結果。對不上代表有一片沒轉完，中間是破洞（實測會發生）。
  // 落地而不是只印 log：破洞要留得下來，W2-2b 的修補要拿它當輸入，
  // 而且「這份逐字稿哪裡可能缺內容」是使用者看得到的事實，不是除錯訊息
  `ALTER TABLE transcripts ADD COLUMN seam_report TEXT;`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** 預設放 data/meetpilot.db；`:memory:` 直接用，不當成路徑去建目錄（測試靠它） */
export const resolveDbPath = (env: NodeJS.ProcessEnv): string => {
  const raw = (env.MEETPILOT_DB ?? '').trim();
  if (raw === ':memory:') return raw;
  return resolve(raw || 'data/meetpilot.db');
};

/**
 * 開庫並把 schema 帶到最新版。
 *
 * `user_version` 是 SQLite 內建的整數欄位，不需要自己開一張版本表。
 * 版本比 MIGRATIONS 還新時直接拋錯：那代表這個檔案被更新版的程式碼開過，
 * 用舊程式碼寫下去會寫出它不認得的形狀，而那種壞法在當下沒有任何症狀。
 */
export const openMeetingDb = (path: string): DatabaseSync => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `${path} 的 schema 版本是 ${current}，這份程式碼只認得到 ${MIGRATIONS.length}：`
      + '這個資料庫被更新版的 MeetPilot 開過，用這一版寫入會寫壞它',
    );
  }

  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error(`schema migration 第 ${v + 1} 步失敗（${path}）：${(err as Error).message}`);
    }
  }

  return db;
};

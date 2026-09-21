/**
 * 一期的結構化儲存：server 端 SQLite（SDD 0.2.1）。
 *
 * 為什麼是 server 端而不是沿用 IndexedDB：D-010 把轉錄狀態機搬到 server，而 IndexedDB
 * 在瀏覽器裡、server 讀不到；加上 S2 的關聯要做向量相似度查詢，IndexedDB 也做不到。
 * 兩個理由各自獨立成立。
 *
 * 用 node 內建的 `node:sqlite`，不加原生依賴。
 *
 * 表只在真的要落地的那一包才建。W1 建了四張（meetings、transcripts、analyses、meeting_tags），
 * W3 加了 topic_tags，W4 加了 topic_links、link_exclusions、topic_tag_embeddings、link_runs，
 * 人名校正 N1（SDD 1.3.2）加了 people、person_aliases，N2 加了 meeting_participants；
 * RecallFeedback 等到 W6 再加一條 migration：現在建空表等於憑空猜欄位，而那些欄位的形狀
 * 要等策略實作完才確定。
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
  // W3：題目標籤（`C-TOPICTAG` v1，SDD 1.1／1.2／FN-03）。
  //
  // 另開一張表而不是併進 meeting_tags：那張是使用者自己打的會議標籤，全部是人打的；
  // 這張分得出 auto 與 manual，而人工優先規則只該套在這張上面。併進去之後兩種來源
  // 長得一模一樣，重算會把人工修正一起洗掉而且沒有任何錯誤訊息。
  //
  // meetings 那兩欄是抽取的結果本身：標籤數 0 的會永遠不會參與任何關聯（SDD 4.x），
  // 這件事要查得出來，不能只寫 log。NULL 是「還沒抽過」（W3 之前的會與搬遷進來的會），
  // 跟 'empty'（抽過、一條都沒有）不是同一件事
  `
  CREATE TABLE topic_tags (
    tag_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
    corrected_at INTEGER,
    match_key TEXT NOT NULL,
    match_key_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX idx_topic_tags_meeting ON topic_tags(meeting_id);
  -- 跨會議比對是照 match_key 找的（W4），沒有這個索引就是全表掃
  CREATE INDEX idx_topic_tags_match_key ON topic_tags(match_key);

  ALTER TABLE meetings ADD COLUMN topic_extraction_status TEXT
    CHECK (topic_extraction_status IN ('ok', 'empty', 'failed'));
  ALTER TABLE meetings ADD COLUMN topic_extraction_error TEXT;
  `,
  // W4：跨會議關聯（`C-TOPICLINK` v1，SDD 1.1／1.2／1.3／2.4／FN-04）。
  //
  // 四張表各自有存在的理由，不要合併：
  //
  // `topic_links` 是可全量重建的計算結果；`link_exclusions` 是人的判斷，**不可重建**（SDD 1.5）。
  // 放同一張表的話，「清掉重算」這個正常操作會順手刪掉人標過的不相關，而且刪的當下沒有任何訊息。
  //
  // `topic_tag_embeddings` 另開而不是掛在 topic_tags 上：那張表是 API 詳情的熱路徑
  // （`getTopicTags` 每次整列讀出來），一條 3072 維的向量是 12KB，一場會 20 條就是 240KB
  // 跟著每一次詳情請求走。而且換 embedding model 時整欄語意作廢，掛在原表上沒地方寫版本。
  // 靠 tag_id 的外鍵 cascade：重新抽取會刪掉 auto 標籤並換新的 tag_id，舊向量跟著走，
  // 不會留下對不到標籤的孤兒向量。
  //
  // `link_runs` 記一次計算的覆蓋率，一場會一列（重算時整列換掉）。不塞進 meetings，跟 W3 把
  // topic_extraction_status 放進 meetings 的判斷相反，而且是刻意的：那一欄是單一結果碼，
  // 這裡是五個數字加一個錯誤原因，塞進去要加六欄，而它們描述的是「那一次計算」不是「這場會」。
  // 查得出來不受影響：`SELECT * FROM link_runs WHERE skipped_error > 0` 就是一句 SQL。
  `
  CREATE TABLE topic_links (
    link_id TEXT PRIMARY KEY,
    meeting_a TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    meeting_b TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    confidence REAL NOT NULL,
    evidence TEXT NOT NULL,
    shared_topics TEXT NOT NULL,
    algo_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- 兩端一律正規化排序（services/topicLink.ts 的 orderPair）。沒有這條約束的話，
    -- 繞過那個函式寫進來的 A×B 與 B×A 會變成兩筆不同的關聯，而查詢只會找到其中一筆
    CHECK (meeting_a < meeting_b)
  );

  -- 一對會議只能有一筆關聯，版本不進唯一鍵。重算時整組刪掉重寫（見 meetingStore.saveLinkResult），
  -- 所以同一對不會有兩個版本的結果並排；algo_version 留在列上是為了看得出「這一筆是哪一版算的」，
  -- 那在「有些會重算過、有些還沒」的混合狀態下是唯一的線索
  CREATE UNIQUE INDEX idx_topic_links_pair ON topic_links(meeting_a, meeting_b);
  CREATE INDEX idx_topic_links_b ON topic_links(meeting_b);

  CREATE TABLE link_exclusions (
    meeting_a TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    meeting_b TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    reason_code TEXT NOT NULL
      CHECK (reason_code IN ('different_topic', 'outdated', 'not_needed', 'unspecified')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (meeting_a, meeting_b),
    CHECK (meeting_a < meeting_b)
  );

  -- vector 存 BLOB（Float32Array 的位元組），不存 JSON 文字：3072 個 float 寫成 JSON 約 60KB，
  -- 二進位是 12KB，而一年約 18,700 條標籤。float32 也正是 embedding API 本來的精度
  CREATE TABLE topic_tag_embeddings (
    tag_id TEXT PRIMARY KEY REFERENCES topic_tags(tag_id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE link_runs (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    algo_version TEXT NOT NULL,
    candidates INTEGER NOT NULL,
    judged INTEGER NOT NULL,
    skipped_cap INTEGER NOT NULL,
    skipped_excluded INTEGER NOT NULL,
    skipped_error INTEGER NOT NULL,
    -- 因為 embedding 的 model 或維度對不上而沒有被比到的「標籤對」數。
    -- 正常情況永遠是 0（舊 model 的向量會被自動重算）。不是 0 就代表這一次的分數不完整，
    -- 而那種情況下最可能的結果是「LINKED ＋ 空集合」——跟真的沒有相關會議長得一樣
    incomparable_pairs INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // `C-ANALYSIS` v2 → v3：決議、待辦、未決事項每條要能回查逐字稿出處（analysisContract.ts）。
  // 新增一段「未決事項」，既有三欄（overview／topics／decisions／action_items）的形狀不變，
  // 只是欄位內容從 v3 起帶 evidence／decided_by／assignee／due。舊資料讀出來時
  // 由 meetingStore 的 getAnalysis 做 lazy 升級（v2 → v3），不改寫既有資料列。
  `ALTER TABLE analyses ADD COLUMN open_questions TEXT NOT NULL DEFAULT '[]';`,
  // 人名校正 N1（SDD 1.3.2，`C-PEOPLE`／`person_aliases`）。
  //
  // `active` 預設 1（在職）：一期的名單來源是單一時間點的快照，看不出誰離職，重新匯入
  // 也不會把它改回去（見 PeopleStore.importRoster 的 upsert 語句，UPDATE 子句刻意不寫這一欄）。
  // 使用者 2026-09-21 裁決現階段全部當在職，維護方式待定，記在 plan 的 Next actions。
  //
  // `person_aliases` 是整個設計的核心資產（1.3.2）：同一個人可以有好幾個別名，`UNIQUE(employee_id, alias)`
  // 讓重新匯入不會疊出重複列；`source` 分 import／manual，配合 1.2 的人工優先且黏著規則——
  // 這裡不覆寫既有列（見 PeopleStore 用 INSERT OR IGNORE），不分來源都不覆寫，
  // 因為「不覆寫」本身就同時滿足「不重複」與「manual 不被 import 洗掉」兩條規則。
  `
  CREATE TABLE people (
    employee_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    title TEXT,
    email TEXT NOT NULL,
    department TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE person_aliases (
    alias_id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES people(employee_id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('import', 'manual')),
    corrected_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (employee_id, alias)
  );

  CREATE INDEX idx_person_aliases_alias ON person_aliases(alias);
  `,
  // 人名校正 N2（SDD 1.3.2、D-016：`F-CREATE` 必填至少一位與會者）。
  //
  // `meeting_id` 掛 CASCADE：刪會議時這張表要跟著清，跟 meeting_tags 同一個理由。
  // `employee_id` 不掛 CASCADE：people 目前沒有刪除操作（離職是標 active=false，見 N1），
  // 這裡不需要處理「引用的人被刪掉」這個目前不會發生的情境。
  //
  // 「至少一位」這條規則刻意不在這裡用 CHECK 或 trigger 強制：SQLite 沒有簡單的方法對
  // 「關聯表至少有一列」做宣告式約束，而這條規則的正確位置是 `F-CREATE`（Recorder 互動的
  // 邊界），不是 Meeting 這個實體本身的資料完整性——沒有與會者的 Meeting 在資料層不是
  // 非法狀態，只是不該被 `F-CREATE` 這條路允許送出來（見 meetingStore.ts 的 CreateMeetingInput 註解）
  `
  CREATE TABLE meeting_participants (
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL REFERENCES people(employee_id),
    PRIMARY KEY (meeting_id, employee_id)
  );

  CREATE INDEX idx_meeting_participants_employee ON meeting_participants(employee_id);
  `,
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

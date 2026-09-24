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
  // 人名校正 N4（SDD 1.3.2 第 2 層，`NameResolver`）。
  //
  // 可重建：從逐字稿與當時的 `person_aliases` 重算（SDD 1.5），所以 `NameResolver` 每次
  // 重跑一場會的比對時整批刪掉舊列重寫，這張表不需要保留歷史版本。
  //
  // `employee_id` 允許 NULL：`needs_review`（衝突）時查不出是哪一個人；`employee_id` 不掛
  // CASCADE 理由同 `meeting_participants`——people 目前沒有刪除操作。
  //
  // `C-ANALYSIS` v3 → v4（`decided_by_employee_id`／`assignee_employee_id`）不需要對應的
  // migration：那兩個新欄位加在既有的 `decisions`／`action_items` JSON blob 裡，`analyses`
  // 表本身沒有新增欄位，`contract_version` 不動（見 analysisContract.ts 檔頭與 SDD 1.3.2）。
  `
  CREATE TABLE name_mentions (
    mention_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    original_text TEXT NOT NULL,
    employee_id TEXT REFERENCES people(employee_id),
    method TEXT NOT NULL CHECK (method IN ('exact', 'short_alias_review', 'conflict_review')),
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX idx_name_mentions_meeting ON name_mentions(meeting_id);
  `,
  // 逐字稿三層（raw／resolved／edited）與轉錄分析佇列拆解的共用地基
  // （vault plan「MeetPilot · 逐字稿版本分層與來源標記」「MeetPilot · 轉錄分析佇列架構升級」）。
  //
  // `transcript_edits`：edited layer，append-only。取代直接覆寫 `transcripts.segments`——
  // 那一欄從這次起是真正的 raw（模型原始轉譯輸出），`PATCH /transcript` 改成對這張表 insert
  // 新列，`edit_version` 該會議內單調遞增。「目前顯示的逐字稿」＝這張表裡最大 edit_version
  // 那列，沒有任何列就退回 raw。
  //
  // `transcripts.slice_models`：轉錄逐片可能各自 fallback 到不同模型
  // （`generateContentWithFallback` 逐次呼叫各自判斷，不是整場會鎖一個），單一 model 欄位會
  // 遺失這個真實會發生的事（2026-09-22 查 `logs/llm.jsonl`：11 場有轉錄紀錄的會議 6 場混用
  // 兩個模型）。JSON 陣列，跟既有 `seam_report` 同一個「per-slice blob、
  // `saveTranscriptProgress` 每片寫入時一併更新」慣例。
  //
  // `analyses` 新增來源欄位：`source_kind`／`source_edit_version` 記這次分析讀的是 raw 還是
  // 哪一版 edited；`resolved_segments_snapshot` 存實際送進分析模型的已解析文字快照，不對
  // `name_mentions` 做版本化——那張表會被人工 `confirmMention` 事後覆寫，沒辦法從「現在的
  // 狀態」回推「當時模型讀到的內容」，只有快照可靠；`model`／`prompt_version` 記這次分析實際
  // 打中哪個模型（fallback 後的值，不是設定的首選）與 `prompts/meeting-record-spec.md` 當下的
  // 內容雜湊。全部允許 NULL：既有分析資料回填不出這些值，NULL 是「這筆早於這次升級」，不是
  // 猜一個值出來（跟 `topic_extraction_status` 的 NULL＝「還沒抽過」同一個判準）。
  //
  // `jobs`：轉錄與分析拆成兩條持久化 queue 的 job table，取代純記憶體的 `TranscriptionQueue`。
  // `payload` 給 analysis job 用，帶 `{source_kind, source_edit_version}`，enqueue 當下釘死，
  // worker 執行時直接讀 job row 的值，不重新查「這場會目前最新版本是哪一版」。
  // `idx_jobs_meeting_kind_active` 擋同一場會同一種 job 重複入列；claim 靠
  // `UPDATE ... WHERE status='queued'` 的 compare-and-swap 判 `changes === 1`，不用另外加鎖。
  `
  CREATE TABLE transcript_edits (
    edit_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    edit_version INTEGER NOT NULL,
    segments TEXT NOT NULL,
    polished_content TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (meeting_id, edit_version)
  );

  CREATE INDEX idx_transcript_edits_meeting ON transcript_edits(meeting_id);

  ALTER TABLE transcripts ADD COLUMN slice_models TEXT;

  ALTER TABLE analyses ADD COLUMN source_kind TEXT CHECK (source_kind IN ('raw', 'edited'));
  ALTER TABLE analyses ADD COLUMN source_edit_version INTEGER;
  ALTER TABLE analyses ADD COLUMN resolved_segments_snapshot TEXT;
  ALTER TABLE analyses ADD COLUMN model TEXT;
  ALTER TABLE analyses ADD COLUMN prompt_version TEXT;

  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('transcription', 'analysis')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'succeeded', 'failed')),
    payload TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    claimed_by TEXT,
    claimed_at INTEGER,
    lease_expires_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX idx_jobs_kind_status ON jobs(kind, status);
  CREATE INDEX idx_jobs_meeting ON jobs(meeting_id);
  CREATE UNIQUE INDEX idx_jobs_meeting_kind_active ON jobs(meeting_id, kind)
    WHERE status IN ('queued', 'claimed', 'running');
  `,
  // 補標記升級前（上一步 migration 之前）就存在的 transcripts 列（Codex adversarial review
  // 抓到）。那時 PATCH 直接覆寫 `segments`，raw／edited 沒有分開，沒辦法回頭判斷哪些其實是
  // 人改過的——provenance 因此不能宣稱這些是 raw，只能標 unknown，這是資料真實情況「判不出來」，
  // 不是猜一個值出來。這一步之後才寫入的列，`legacy_unconfirmed_raw` 預設 0（真的是 raw），
  // 因為那之後 PATCH 已經改走 `transcript_edits`，不會再覆寫這欄。
  //
  // analyses.source_kind 的 CHECK 只放行 raw／edited，要收 unknown 得整張表重建
  // （SQLite 不能直接改既有 CHECK 約束）。目前 analyses 只有 meeting_id 當 PK、沒有其他索引、
  // 沒有別的表用外鍵指向它，重建只是搬資料，不用管索引或級聯。
  `
  ALTER TABLE transcripts ADD COLUMN legacy_unconfirmed_raw INTEGER NOT NULL DEFAULT 0;
  UPDATE transcripts SET legacy_unconfirmed_raw = 1;

  CREATE TABLE analyses_v2 (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL,
    overview TEXT NOT NULL,
    topics TEXT NOT NULL,
    decisions TEXT NOT NULL,
    action_items TEXT NOT NULL,
    open_questions TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    source_kind TEXT CHECK (source_kind IN ('raw', 'edited', 'unknown')),
    source_edit_version INTEGER,
    resolved_segments_snapshot TEXT,
    model TEXT,
    prompt_version TEXT
  );
  INSERT INTO analyses_v2
    SELECT meeting_id, contract_version, overview, topics, decisions, action_items, open_questions,
           created_at, source_kind, source_edit_version, resolved_segments_snapshot, model, prompt_version
    FROM analyses;
  DROP TABLE analyses;
  ALTER TABLE analyses_v2 RENAME TO analyses;
  `,
  // 網頁錄音（vault plan「MeetPilot · 網頁錄音」）：webapp 叫本機語音備忘錄錄音的起訖時間。
  //
  // 不加在 meetings 表上：只有從錄音按鍵開始的會才有這兩個值，其餘（上傳、搬遷）一律沒有，
  // 放進 meetings 等於讓 Meeting 型別的每一個建構點都要多填兩個跟它無關的 null。
  //
  // started_at 落地是 AC-4 的前提：錄音由語音備忘錄負責，分頁關掉或 server 重啟都不會中斷，
  // 重開頁面時畫面上的計時與停止按鍵要靠這一欄才接得回來，不能只存在前端。
  // 停止後這一列留著不刪：取回的檔案要拿開始／停止時間比對長度（AC-3），事後也查得到這場會的
  // 音檔是從語音備忘錄來的。stopped_at 是 NULL 代表還在錄。
  `
  CREATE TABLE voice_memo_recordings (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER
  );
  `,
  // 桌面 app 自己錄音（vault plan「MeetPilot · 跨平台打包部署」E4）：同一場會的起訖紀錄多了一種來源。
  //
  // 沿用同一張表、不另開：一場 RECORDING 的會只會有一列起訖紀錄，分兩張表的話「現在在錄的是誰、
  // 從什麼時候開始」要兩邊一起查，只查一邊的地方就會漏。所以改名成 recordings，加上 method。
  // 既有的列都是語音備忘錄錄的，DEFAULT 'voice_memo' 就是它們的正確值。
  //
  // received_chunks／received_bytes 只有 in_app 用：前端每 10 秒送一段，server 附加到 `<id>.recording`。
  // 兩個數字是「已經確定寫進檔案」的進度：寫檔之前先把檔案截到 received_bytes，寫完才更新這兩欄，
  // 斷在中間（server 掛掉、請求中斷）時前端重送同一段不會變成重複的資料。
  `
  ALTER TABLE voice_memo_recordings RENAME TO recordings;
  ALTER TABLE recordings ADD COLUMN method TEXT NOT NULL DEFAULT 'voice_memo' CHECK (method IN ('voice_memo', 'in_app'));
  ALTER TABLE recordings ADD COLUMN received_chunks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recordings ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
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

/**
 * MeetingStore（SDD 第 3 節 Module 表、2.2 的 `I-MEETING`）。
 *
 * 不變量：狀態只能依 meetingState 的合法轉移改變，caller 不得直接設值。
 * 錯誤模式：非法轉移與找不到 Meeting 一律拋出明確錯誤，不靜默忽略、不回預設值。
 *
 * JSON 欄位（segments、topics、decisions、action_items）在這一層序列化與還原，
 * 呼叫端拿到的一律是解好的物件；讓每個 caller 自己 JSON.parse 的話，
 * 「解析失敗」會散成好幾種處理方式。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Meeting, TranscriptSegment } from '../types';
import { AnalysisV2, isAnalysisV2SemanticallyEmpty } from './analysisContract';
import { MigrationRecord } from './jobMigration';
import { SeamReportEntry } from './meetingApi';
import { MeetingStatus, assertTransition, isMeetingStatus } from './meetingState';
import {
  MATCH_KEY_VERSION,
  TopicExtractionStatus,
  TopicTag,
  isTopicExtractionStatus,
} from './topicTag';

export interface TranscriptRecord {
  segments: TranscriptSegment[];
  polished_content: string | null;
}

/**
 * PATCH 逐字稿用的部分更新。
 *
 * 「沒給這個欄位」與「明確給 null」是兩件事：前者保持原值，後者是清掉潤稿。
 * 兩者在 JSON 裡長得不一樣，判斷一律用 `in`，不要用 `?? 原值` 把它們併掉——
 * 併掉之後使用者永遠清不掉潤稿，而且不會有任何錯誤。
 */
export interface TranscriptPatch {
  segments?: TranscriptSegment[];
  polished_content?: string | null;
}

/**
 * 要寫進去的一條 auto 題目標籤。`tag_id` 由 store 生，呼叫端不用管。
 *
 * `match_key` 由 `TopicExtractor` 算好傳進來（規則見 topicTag.ts），不是在這裡算：
 * 正規化是那個 module 存在的理由之一，散進儲存層之後兩邊會各自演化。
 */
export interface NewAutoTopicTag {
  title: string;
  content: string;
  match_key: string;
  match_key_version: number;
}

/**
 * 一次抽取的結果（W3）。三種情形分開寫，是因為它們要做的事不一樣：
 * 只有 `ok` 會動 topic_tags，`empty` 與 `failed` 只留標記。
 */
export type TopicExtractionResult =
  | { status: 'ok'; tags: readonly NewAutoTopicTag[] }
  | { status: 'empty' }
  | { status: 'failed'; error: string };

export interface TopicTagWriteReport {
  inserted: number;
  /** 因為同一場會已經有人工標籤佔著同一個 match_key 而沒有寫進去的標題 */
  skippedByManual: string[];
  /** 這一批自己有兩條以上 match_key 相同，只留第一條，其餘的標題在這裡 */
  skippedDuplicate: string[];
}

export interface CreateMeetingInput {
  meeting_id: string;
  title?: string | null;
  created_at: number;
  source_file_name?: string | null;
  source_file_size?: number | null;
  meeting_context?: string | null;
}

export interface ImportReport {
  imported: string[];
  skippedExisting: string[];
}

type MeetingRow = {
  meeting_id: string;
  title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  source_file_name: string | null;
  source_file_size: number | null;
  origin: string;
  error: string | null;
  processed_slices: number | null;
  total_slices: number | null;
  meeting_context: string | null;
  topic_extraction_status: string | null;
  topic_extraction_error: string | null;
};

/** null 是「還沒抽過」，其餘只認三個值。認不得的值往下傳會讓畫面顯示一個不存在的抽取狀態，而那不會有任何錯誤 */
const readExtractionStatus = (row: MeetingRow): TopicExtractionStatus | null => {
  const raw = row.topic_extraction_status;
  if (raw === null) return null;
  if (isTopicExtractionStatus(raw)) return raw;
  throw new Error(`Meeting ${row.meeting_id} 的 topic_extraction_status 不是合法值：${raw}`);
};

const toMeeting = (row: MeetingRow): Meeting => {
  if (!isMeetingStatus(row.status)) {
    // 資料庫裡出現這一版不認得的狀態，通常是被更新版的程式碼寫過。往下傳會讓狀態機在別的地方爆，
    // 那時已經看不出來源是哪一筆
    throw new Error(`Meeting ${row.meeting_id} 的 status 不是合法值：${row.status}`);
  }
  if (row.origin !== 'native' && row.origin !== 'migrated') {
    throw new Error(`Meeting ${row.meeting_id} 的 origin 不是合法值：${row.origin}`);
  }
  return {
    ...row,
    status: row.status,
    origin: row.origin,
    topic_extraction_status: readExtractionStatus(row),
  };
};

type TopicTagRow = Omit<TopicTag, 'source'> & { source: string };

const toTopicTag = (row: TopicTagRow): TopicTag => {
  if (row.source !== 'auto' && row.source !== 'manual') {
    // 分不出來源就沒有人工優先可言：往下傳的話，重算會不會蓋掉它變成看運氣
    throw new Error(`TopicTag ${row.tag_id} 的 source 不是合法值：${row.source}`);
  }
  return { ...row, source: row.source };
};

export const createMeetingStore = (db: DatabaseSync) => {
  const selectOne = db.prepare('SELECT * FROM meetings WHERE meeting_id = ?');
  // 排序鍵明寫到唯一為止：只用 created_at 的話，同一毫秒建立的兩場會順序未定義，
  // 而「它看起來是穩定的」正是 DEV-STANDARDS〈確定性〉點名的那種假設
  const selectAll = db.prepare('SELECT * FROM meetings ORDER BY created_at DESC, meeting_id DESC');

  const insertMeeting = db.prepare(`
    INSERT INTO meetings (meeting_id, title, status, created_at, updated_at, source_file_name,
                          source_file_size, origin, error, processed_slices, total_slices, meeting_context,
                          topic_extraction_status, topic_extraction_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // upsert 而不是 INSERT OR REPLACE：後者是砍掉整列再插一列，會把這個 statement 沒列出來的欄位
  // （seam_report）一起清成 null。逐字稿每轉完一片就寫一次，用 REPLACE 的話接縫紀錄每片都被沖掉一次
  const insertTranscript = db.prepare(`
    INSERT INTO transcripts (meeting_id, segments, polished_content, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(meeting_id) DO UPDATE SET
      segments = excluded.segments,
      polished_content = excluded.polished_content,
      created_at = excluded.created_at
  `);
  const insertAnalysis = db.prepare(`
    INSERT OR REPLACE INTO analyses (meeting_id, contract_version, overview, topics, decisions, action_items, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare('INSERT OR IGNORE INTO meeting_tags (meeting_id, tag) VALUES (?, ?)');
  const insertTopicTag = db.prepare(`
    INSERT INTO topic_tags (tag_id, meeting_id, title, content, source, corrected_at,
                            match_key, match_key_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 排序鍵明寫到唯一為止（理由同 selectAll）：同一批標籤的 created_at 全都一樣，
  // 只用它排的話順序未定義，而 vault markdown 每次投影出來的行序會跟著跳
  const selectTopicTags = db.prepare(
    'SELECT * FROM topic_tags WHERE meeting_id = ? ORDER BY created_at, title, tag_id',
  );

  const getMeeting = (id: string): Meeting | null => {
    const row = selectOne.get(id) as MeetingRow | undefined;
    return row ? toMeeting(row) : null;
  };

  const requireMeeting = (id: string): Meeting => {
    const meeting = getMeeting(id);
    if (!meeting) throw new Error(`找不到 Meeting ${id}`);
    return meeting;
  };

  const readTranscript = (id: string): TranscriptRecord | null => {
    const row = db.prepare('SELECT segments, polished_content FROM transcripts WHERE meeting_id = ?').get(id) as
      { segments: string; polished_content: string | null } | undefined;
    if (!row) return null;
    return { segments: JSON.parse(row.segments) as TranscriptSegment[], polished_content: row.polished_content };
  };

  const readSeamReport = (id: string): SeamReportEntry[] | null => {
    const row = db.prepare('SELECT seam_report FROM transcripts WHERE meeting_id = ?').get(id) as
      { seam_report: string | null } | undefined;
    if (!row?.seam_report) return null;
    return JSON.parse(row.seam_report) as SeamReportEntry[];
  };

  const readAnalysisRow = (id: string) =>
    db.prepare(
      'SELECT contract_version, overview, topics, decisions, action_items FROM analyses WHERE meeting_id = ?',
    ).get(id) as {
      contract_version: number; overview: string; topics: string; decisions: string; action_items: string;
    } | undefined;

  const writeTranscript = (id: string, transcript: TranscriptRecord, createdAt: number) => {
    insertTranscript.run(id, JSON.stringify(transcript.segments), transcript.polished_content, createdAt);
  };

  const writeAnalysis = (id: string, analysis: AnalysisV2, createdAt: number) => {
    insertAnalysis.run(
      id,
      analysis.contract_version,
      analysis.overview,
      JSON.stringify(analysis.topics),
      JSON.stringify(analysis.decisions),
      JSON.stringify(analysis.action_items),
      createdAt,
    );
  };

  return {
    getMeeting,

    listMeetings: (): Meeting[] => (selectAll.all() as MeetingRow[]).map(toMeeting),

    createMeeting: (input: CreateMeetingInput): Meeting => {
      if (getMeeting(input.meeting_id)) throw new Error(`Meeting ${input.meeting_id} 已經存在`);
      insertMeeting.run(
        input.meeting_id,
        input.title ?? null,
        'CREATED',
        input.created_at,
        input.created_at,
        input.source_file_name ?? null,
        input.source_file_size ?? null,
        'native',
        null,
        null,
        null,
        input.meeting_context ?? null,
        // 新建的會還沒抽過標籤。這裡寫死 null 而不是省略欄位：省略的話新增欄位時
        // 會安靜地吃到資料庫預設值，而那不一定是這裡想要的
        null,
        null,
      );
      return requireMeeting(input.meeting_id);
    },

    /**
     * 改狀態。`error` 只在兩個失敗狀態上有意義，其餘狀態一律清成 null：
     * 留著上一次的錯誤訊息會讓畫面顯示一個已經不成立的失敗原因。
     *
     * LINK_FAILED 跟 FAILED 一樣要留原因。關聯失敗的原因不落地的話，
     * 之後查「為什麼這場沒關聯到」就沒有證據，而那正是最大不可接受失敗的偵測路徑。
     * 傳了 error 卻要轉到不保留它的狀態一律拋錯，不要安靜丟掉呼叫端給的資訊。
     */
    setStatus: (id: string, to: MeetingStatus, updatedAt: number, error?: string | null): Meeting => {
      const current = requireMeeting(id);
      assertTransition(id, current.status, to);
      const keepsError = to === 'FAILED' || to === 'LINK_FAILED';
      if (!keepsError && error != null) {
        throw new Error(`Meeting ${id} 轉到 ${to} 不會保留錯誤訊息，但呼叫端傳了 error：${error}`);
      }
      db.prepare('UPDATE meetings SET status = ?, updated_at = ?, error = ? WHERE meeting_id = ?')
        .run(to, updatedAt, keepsError ? (error ?? null) : null, id);
      return requireMeeting(id);
    },

    /**
     * 只更新切片進度。轉錄開始前用來把 total_slices 寫下去：
     * 進度分母缺著的話，畫面只能顯示「已處理 3 片」而看不出還有多久。
     */
    setSliceProgress: (id: string, processedSlices: number, totalSlices: number, updatedAt: number): void => {
      requireMeeting(id);
      db.prepare('UPDATE meetings SET processed_slices = ?, total_slices = ?, updated_at = ? WHERE meeting_id = ?')
        .run(processedSlices, totalSlices, updatedAt, id);
    },

    /**
     * 逐字稿與續傳游標寫在同一個交易裡（SDD 1.4）。
     *
     * 分成兩次寫的話，中間掛掉會留下「逐字稿存了但 processed_slices 沒動」——續傳時那一片
     * 會再送一次 Gemini，合併後同一段話出現兩次，而且沒有任何錯誤。
     *
     * segments 為空時只推進游標、不寫 transcripts：一片真的沒人說話是合法的結果，
     * 但空的逐字稿不能蓋掉前面幾片已經存好的內容。整場會一段都沒有的情況由
     * transcriptionPipeline 在進分析前擋下來，不在這裡當成成功。
     */
    saveTranscriptProgress: (
      id: string,
      transcript: TranscriptRecord,
      processedSlices: number,
      totalSlices: number,
      updatedAt: number,
    ): void => {
      requireMeeting(id);
      db.exec('BEGIN');
      try {
        if (transcript.segments.length > 0) writeTranscript(id, transcript, updatedAt);
        db.prepare('UPDATE meetings SET processed_slices = ?, total_slices = ?, updated_at = ? WHERE meeting_id = ?')
          .run(processedSlices, totalSlices, updatedAt, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** 建立 Meeting 時帶上來的人工標籤（只當 prompt 背景，不是 TopicTag）。重設整組，不累加 */
    setTags: (id: string, tags: readonly string[]): void => {
      requireMeeting(id);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM meeting_tags WHERE meeting_id = ?').run(id);
        for (const tag of tags) insertTag.run(id, tag);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * 刪掉整場會。transcripts、analyses、meeting_tags 靠外鍵 cascade 一起走
     * （meetingDb 開了 `PRAGMA foreign_keys = ON`）；手動逐張刪的話，之後新增的表
     * 只要忘了補一行就會留下對不到 Meeting 的孤兒列。
     *
     * 找不到 Meeting 時拋錯，不靜默當作已經刪掉：呼叫端要分得開「本來就沒有」與「剛剛刪掉」。
     */
    deleteMeeting: (id: string): void => {
      requireMeeting(id);
      db.prepare('DELETE FROM meetings WHERE meeting_id = ?').run(id);
    },

    /**
     * 重新上傳音檔時把上一輪的轉錄成果清掉：刪掉逐字稿、把續傳游標歸零。
     *
     * 不清的後果是**無聲的資料混合**：retry 把狀態退回 CREATED 但刻意保留 processed_slices，
     * 這時若上傳的是另一個音檔，server 會沿用舊游標，把新音檔的後半接到舊音檔的逐字稿後面，
     * 全程沒有任何錯誤。續傳不受影響——續傳走的是 server 重啟掃描，不經過上傳這條路。
     */
    resetTranscriptionProgress: (id: string, updatedAt: number): void => {
      requireMeeting(id);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM transcripts WHERE meeting_id = ?').run(id);
        // 分析也要一起刪，不能只刪逐字稿。留著的話，上傳新音檔到新一輪分析跑完之間，
        // `GET /api/meetings/:id` 會回一份屬於**舊音檔**的結論，而畫面上沒有任何東西說得出
        // 「這份分析跟你剛上傳的檔沒有關係」。中途失敗更糟：留下「新的部分逐字稿 ＋ 上一輪的
        // 會議記錄」這種對不起來的組合。
        db.prepare('DELETE FROM analyses WHERE meeting_id = ?').run(id);
        db.prepare(
          'UPDATE meetings SET processed_slices = NULL, total_slices = NULL, updated_at = ? WHERE meeting_id = ?',
        ).run(updatedAt, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * 人工編輯逐字稿。只寫有給的欄位，沒給的沿用原值（語意見 TranscriptPatch）。
     *
     * 還沒有逐字稿的會拋錯：那代表這場還沒轉錄完，編輯一份不存在的東西會把
     * 「轉錄結果」與「人工輸入」混成同一筆，之後分不出哪些字是模型產的。
     *
     * transcripts 與 meetings.updated_at 同一個交易：畫面靠 updated_at 排序與判斷新舊，
     * 內容改了而 updated_at 沒動的話，那次編輯在列表上看起來沒發生過。
     */
    updateTranscript: (id: string, patch: TranscriptPatch, updatedAt: number): TranscriptRecord => {
      requireMeeting(id);
      const existing = readTranscript(id);
      if (!existing) throw new Error(`Meeting ${id} 還沒有逐字稿，沒有東西可以編輯`);

      const segments = 'segments' in patch ? patch.segments : existing.segments;
      if (!segments || segments.length === 0) {
        // 與 saveTranscript 同一條語意空守衛：空的逐字稿不能覆蓋掉已經有的內容
        throw new Error(`Meeting ${id} 的逐字稿是空的，不寫入`);
      }
      const polishedContent = 'polished_content' in patch ? patch.polished_content ?? null : existing.polished_content;
      const next: TranscriptRecord = { segments, polished_content: polishedContent };

      db.exec('BEGIN');
      try {
        writeTranscript(id, next, updatedAt);
        db.prepare('UPDATE meetings SET updated_at = ? WHERE meeting_id = ?').run(updatedAt, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return next;
    },

    /**
     * 人工編輯會議記錄：整份覆寫（前端送的是編輯後的完整 v2）。
     * 還沒有分析的會拋錯，理由同 updateTranscript。
     */
    replaceAnalysis: (id: string, analysis: AnalysisV2, updatedAt: number): void => {
      requireMeeting(id);
      if (!readAnalysisRow(id)) throw new Error(`Meeting ${id} 還沒有分析結果，沒有東西可以編輯`);
      if (isAnalysisV2SemanticallyEmpty(analysis)) {
        throw new Error(`Meeting ${id} 的分析四個欄位都是空的，不寫入`);
      }

      db.exec('BEGIN');
      try {
        writeAnalysis(id, analysis, updatedAt);
        db.prepare('UPDATE meetings SET updated_at = ? WHERE meeting_id = ?').run(updatedAt, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    saveTranscript: (id: string, transcript: TranscriptRecord, createdAt: number): void => {
      requireMeeting(id);
      if (transcript.segments.length === 0) {
        // SDD 1.5 的資料品質檢查：型別對但語意為空的逐字稿不能存成「成功」，
        // 它會一路走到分析，產出一份空的結論而且沒有任何錯誤
        throw new Error(`Meeting ${id} 的逐字稿是空的，不寫入`);
      }
      writeTranscript(id, transcript, createdAt);
    },

    saveAnalysis: (id: string, analysis: AnalysisV2, createdAt: number): void => {
      requireMeeting(id);
      if (isAnalysisV2SemanticallyEmpty(analysis)) {
        // 與 saveTranscript 同一條標準（SDD 1.5）：四個欄位全空卻寫成成功，
        // 在畫面上跟「這場會沒什麼結論」長得一樣，而且不會有任何錯誤
        throw new Error(`Meeting ${id} 的分析四個欄位都是空的，不寫入`);
      }
      writeAnalysis(id, analysis, createdAt);
    },

    getTranscript: readTranscript,

    getSeamReport: readSeamReport,

    /**
     * 寫入接縫報告。逐字稿那一列必須先存在（接縫是合併的產物，合併寫完才輪到它）。
     * 分開一支而不是併進 saveTranscriptProgress：`PATCH transcript` 走的是同一條寫入路徑，
     * 使用者手動編輯逐字稿不該連帶改寫「模型當時漏了什麼」這個事實
     */
    saveSeamReport: (id: string, report: SeamReportEntry[]): void => {
      requireMeeting(id);
      const changed = db.prepare('UPDATE transcripts SET seam_report = ? WHERE meeting_id = ?')
        .run(JSON.stringify(report), id);
      if (changed.changes === 0) {
        throw new Error(`Meeting ${id} 還沒有逐字稿，寫不了接縫報告`);
      }
    },

    getAnalysis: (id: string): AnalysisV2 | null => {
      const row = readAnalysisRow(id);
      if (!row) return null;
      if (row.contract_version !== 2) {
        throw new Error(`Meeting ${id} 的分析是 C-ANALYSIS v${row.contract_version}，這一版只讀 v2`);
      }
      return {
        contract_version: 2,
        overview: row.overview,
        topics: JSON.parse(row.topics),
        decisions: JSON.parse(row.decisions),
        action_items: JSON.parse(row.action_items),
      };
    },

    getTags: (id: string): string[] =>
      (db.prepare('SELECT tag FROM meeting_tags WHERE meeting_id = ? ORDER BY tag').all(id) as { tag: string }[])
        .map(r => r.tag),

    /** 一場會的題目標籤，auto 與 manual 都在裡面（W3）。跟 getTags 是兩件事，見 topicTag.ts 檔頭 */
    getTopicTags: (id: string): TopicTag[] =>
      (selectTopicTags.all(id) as TopicTagRow[]).map(toTopicTag),

    /**
     * 落地一次抽取的結果：標籤與狀態同一個交易（W3，SDD 1.2）。
     *
     * 分兩次寫的話，中間掛掉會留下「標籤寫進去了但狀態還是 null」——那看起來是
     * 「這場會還沒抽過」，下一輪重算會再抽一次、再寫一批，而舊的那批已經在表裡。
     *
     * **人工優先（SDD 1.2）：只刪 `source = 'auto'` 的列。** manual 的一列都不碰，
     * 而且新抽出來的標籤只要 match_key 跟既有的 manual 撞上就整條跳過——不跳過的話，
     * 同一場會的同一題目會同時存在「人改過的」與「模型又抽一次的」兩條，
     * 人工修正等於白做，而且沒有任何錯誤訊息。
     *
     * `empty` 與 `failed` **不刪既有標籤**：這一輪沒抽到不代表上一輪抽到的是錯的，
     * 刪掉只會讓這場會連舊的關聯原料都沒有。狀態欄已經把「最新一輪沒抽到」講清楚了。
     */
    saveTopicExtraction: (id: string, result: TopicExtractionResult, at: number): TopicTagWriteReport => {
      requireMeeting(id);
      const report: TopicTagWriteReport = { inserted: 0, skippedByManual: [], skippedDuplicate: [] };

      if (result.status === 'ok' && result.tags.length === 0) {
        // 空集合要走 'empty'，那是它自己的狀態。當成 ok 寫下去的話，
        // 「抽到 0 條」在資料上跟「抽得好好的」長得一樣
        throw new Error(`Meeting ${id} 的抽取結果是 ok 卻沒有任何標籤，應該用 empty`);
      }

      db.exec('BEGIN');
      try {
        if (result.status === 'ok') {
          const manualKeys = new Set(
            (db.prepare("SELECT match_key FROM topic_tags WHERE meeting_id = ? AND source = 'manual'")
              .all(id) as { match_key: string }[]).map(r => r.match_key),
          );
          db.prepare("DELETE FROM topic_tags WHERE meeting_id = ? AND source = 'auto'").run(id);

          const seen = new Set<string>();
          for (const tag of result.tags) {
            if (tag.match_key === '') {
              // 空鍵跟空鍵會互相「相等」，會把兩件不相干的事判成同一題。
              // TopicExtractor 應該已經擋掉了，這裡是最後一道
              throw new Error(`Meeting ${id} 的標籤「${tag.title}」算不出比對鍵，不寫入`);
            }
            if (tag.match_key_version !== MATCH_KEY_VERSION) {
              throw new Error(
                `Meeting ${id} 的標籤「${tag.title}」帶的比對鍵版本是 ${tag.match_key_version}，`
                + `這一版只寫 ${MATCH_KEY_VERSION}`,
              );
            }
            if (manualKeys.has(tag.match_key)) {
              report.skippedByManual.push(tag.title);
              continue;
            }
            if (seen.has(tag.match_key)) {
              report.skippedDuplicate.push(tag.title);
              continue;
            }
            seen.add(tag.match_key);
            insertTopicTag.run(
              randomUUID(), id, tag.title, tag.content, 'auto', null,
              tag.match_key, tag.match_key_version, at,
            );
            report.inserted += 1;
          }
        }

        const status: TopicExtractionStatus = result.status;
        db.prepare(
          'UPDATE meetings SET topic_extraction_status = ?, topic_extraction_error = ?, updated_at = ? '
          + 'WHERE meeting_id = ?',
        ).run(status, result.status === 'failed' ? result.error : null, at, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return report;
    },

    /**
     * Migration 匯入。整批一個交易：中途失敗就整批回退，不留半套。
     * 已存在的 meeting_id 跳過而不是覆寫，重跑匯入才安全；覆寫會把 server 上已經往前跑過的
     * 狀態倒回舊資料的樣子。
     */
    importMigrated: (records: readonly MigrationRecord[]): ImportReport => {
      const report: ImportReport = { imported: [], skippedExisting: [] };
      db.exec('BEGIN');
      try {
        for (const record of records) {
          const { meeting } = record;
          if (getMeeting(meeting.meeting_id)) {
            report.skippedExisting.push(meeting.meeting_id);
            continue;
          }
          insertMeeting.run(
            meeting.meeting_id, meeting.title, meeting.status, meeting.created_at, meeting.updated_at,
            meeting.source_file_name, meeting.source_file_size, meeting.origin, meeting.error,
            meeting.processed_slices, meeting.total_slices, meeting.meeting_context,
            meeting.topic_extraction_status, meeting.topic_extraction_error,
          );
          if (record.transcript) writeTranscript(meeting.meeting_id, record.transcript, meeting.created_at);
          if (record.analysis) writeAnalysis(meeting.meeting_id, record.analysis, meeting.created_at);
          for (const tag of record.tags) insertTag.run(meeting.meeting_id, tag);
          report.imported.push(meeting.meeting_id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return report;
    },
  };
};

export type MeetingStore = ReturnType<typeof createMeetingStore>;

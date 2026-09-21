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
import { AnalysisV3, isAnalysisV3SemanticallyEmpty, upgradeAnalysisV2ToV3 } from './analysisContract';
import { MigrationRecord } from './jobMigration';
import { SeamReportEntry } from './meetingApi';
import { MeetingStatus, assertTransition, isMeetingStatus } from './meetingState';
import {
  MATCH_KEY_VERSION,
  TopicExtractionStatus,
  TopicTag,
  isTopicExtractionStatus,
} from './topicTag';
import {
  LinkExclusion,
  LinkExclusionReason,
  LinkRun,
  TagVector,
  TopicLink,
  isLinkExclusionReason,
  orderPair,
  pairKey,
} from './topicLink';

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

/** 要寫進去的一條向量。model 與維度由 embedding 呼叫端給，store 不猜 */
export interface NewTagVector {
  tag_id: string;
  model: string;
  dimensions: number;
  vector: number[];
}

/** 一次關聯計算要落地的東西：關聯本體與這次的覆蓋率，同一個交易寫 */
export interface LinkResult {
  algo_version: string;
  links: readonly NewTopicLink[];
  coverage: {
    candidates: number;
    judged: number;
    skipped_cap: number;
    skipped_excluded: number;
    skipped_error: number;
    incomparable_pairs: number;
    error: string | null;
  };
}

export interface NewTopicLink {
  /** 對方那一場。兩端的排序由 store 做，呼叫端不用管 */
  other_meeting_id: string;
  confidence: number;
  evidence: string;
  shared_topics: string[];
}

export interface LinkWriteReport {
  inserted: number;
  /** 因為排除紀錄而沒有寫進去的對方 meeting_id。正常路徑上應該是空的（候選階段就扣掉了） */
  blockedByExclusion: string[];
}

export interface CreateMeetingInput {
  meeting_id: string;
  title?: string | null;
  created_at: number;
  source_file_name?: string | null;
  source_file_size?: number | null;
  meeting_context?: string | null;
  /**
   * 這場會的與會者員編（人名校正 N2，SDD D-016）。**選填在 store 這一層**：
   * 「至少一位」是 `F-CREATE` 的前置條件（`services/createApp.ts` 的路由驗證），不是
   * `Meeting` 這個實體本身的資料完整性規則——沒有這條區分，這個既有函式簽章一改成必填，
   * 全 repo 九個呼叫端（多半是不關心與會者的既有測試）都要跟著補假資料，
   * 那些測試測的是別的事，不該被這個新規則波及
   */
  participant_ids?: readonly string[];
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

// node:sqlite 回的是帶 index signature 的 Record，而 interface 沒有隱式 index signature，
// 直接轉會被 tsc 擋下來。照 MeetingRow 的既有做法宣告本地 row type
type LinkRunRow = {
  meeting_id: string;
  algo_version: string;
  candidates: number;
  judged: number;
  skipped_cap: number;
  skipped_excluded: number;
  skipped_error: number;
  incomparable_pairs: number;
  error: string | null;
  created_at: number;
};

type LinkExclusionRow = {
  meeting_a: string;
  meeting_b: string;
  reason_code: string;
  created_at: number;
};

const toLinkExclusion = (row: LinkExclusionRow): LinkExclusion => {
  if (!isLinkExclusionReason(row.reason_code)) {
    // 認不得的原因往下傳，6.3 的三分類統計就會混進一個不存在的類別，
    // 而那份統計是判斷關聯品質的唯一線上訊號
    throw new Error(`排除紀錄 ${row.meeting_a} × ${row.meeting_b} 的 reason_code 不是合法值：${row.reason_code}`);
  }
  return { ...row, reason_code: row.reason_code };
};

const toTopicTag = (row: TopicTagRow): TopicTag => {
  if (row.source !== 'auto' && row.source !== 'manual') {
    // 分不出來源就沒有人工優先可言：往下傳的話，重算會不會蓋掉它變成看運氣
    throw new Error(`TopicTag ${row.tag_id} 的 source 不是合法值：${row.source}`);
  }
  return { ...row, source: row.source };
};

/**
 * 向量在資料庫裡是 float32 的位元組（W4）。
 *
 * 不存 JSON 文字：3072 個 float 寫成 JSON 約 60KB、二進位是 12KB，而一年約 18,700 條標籤。
 * float32 也正是 embedding API 本來的精度，轉成它不損失原本就有的資訊。
 */
const toVectorBlob = (vector: readonly number[]): Uint8Array =>
  new Uint8Array(new Float32Array(vector).buffer.slice(0));

const fromVectorBlob = (blob: Uint8Array): number[] => {
  if (blob.byteLength % 4 !== 0) {
    // 長度不是 4 的倍數代表這個 BLOB 不是 float32 陣列。硬解會回一組看起來正常的數字
    throw new Error(`向量的長度 ${blob.byteLength} bytes 不是 4 的倍數，不是 float32 陣列`);
  }
  const view = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(view);
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
    INSERT OR REPLACE INTO analyses
      (meeting_id, contract_version, overview, topics, decisions, action_items, open_questions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare('INSERT OR IGNORE INTO meeting_tags (meeting_id, tag) VALUES (?, ?)');
  const insertParticipant = db.prepare(
    'INSERT OR IGNORE INTO meeting_participants (meeting_id, employee_id) VALUES (?, ?)',
  );
  const selectParticipants = db.prepare(
    'SELECT employee_id FROM meeting_participants WHERE meeting_id = ? ORDER BY employee_id',
  );
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
      'SELECT contract_version, overview, topics, decisions, action_items, open_questions '
      + 'FROM analyses WHERE meeting_id = ?',
    ).get(id) as {
      contract_version: number; overview: string; topics: string; decisions: string; action_items: string;
      // v2 資料列沒有走過第 5 條 migration 前的資料一律有預設值 '[]'（ALTER TABLE 的
      // DEFAULT），所以這裡不會是 null，但型別仍寫 nullable 以防手動插入的舊測試資料漏帶
      open_questions: string | null;
    } | undefined;

  const writeTranscript = (id: string, transcript: TranscriptRecord, createdAt: number) => {
    insertTranscript.run(id, JSON.stringify(transcript.segments), transcript.polished_content, createdAt);
  };

  const writeLinkRun = (id: string, result: LinkResult, at: number) => {
    db.prepare(
      'INSERT INTO link_runs (meeting_id, algo_version, candidates, judged, skipped_cap, skipped_excluded, '
      + 'skipped_error, incomparable_pairs, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(meeting_id) DO UPDATE SET algo_version = excluded.algo_version, '
      + 'candidates = excluded.candidates, judged = excluded.judged, skipped_cap = excluded.skipped_cap, '
      + 'skipped_excluded = excluded.skipped_excluded, skipped_error = excluded.skipped_error, '
      + 'incomparable_pairs = excluded.incomparable_pairs, error = excluded.error, '
      + 'created_at = excluded.created_at',
    ).run(
      id, result.algo_version, result.coverage.candidates, result.coverage.judged,
      result.coverage.skipped_cap, result.coverage.skipped_excluded, result.coverage.skipped_error,
      result.coverage.incomparable_pairs, result.coverage.error, at,
    );
  };

  const writeAnalysis = (id: string, analysis: AnalysisV3, createdAt: number) => {
    insertAnalysis.run(
      id,
      analysis.contract_version,
      analysis.overview,
      JSON.stringify(analysis.topics),
      JSON.stringify(analysis.decisions),
      JSON.stringify(analysis.action_items),
      JSON.stringify(analysis.open_questions),
      createdAt,
    );
  };

  return {
    getMeeting,

    listMeetings: (): Meeting[] => (selectAll.all() as MeetingRow[]).map(toMeeting),

    createMeeting: (input: CreateMeetingInput): Meeting => {
      if (getMeeting(input.meeting_id)) throw new Error(`Meeting ${input.meeting_id} 已經存在`);
      const participantIds = input.participant_ids ?? [];
      // 有帶與會者才開交易：多數既有呼叫端不帶這個欄位，維持原本的單一 INSERT，
      // 不為了一個大家通常用不到的欄位讓每次建立都多一層交易開銷
      if (participantIds.length === 0) {
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
      } else {
        db.exec('BEGIN');
        try {
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
            null,
            null,
          );
          for (const employeeId of participantIds) insertParticipant.run(input.meeting_id, employeeId);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
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
     * 改標題。分析完成時 pipeline 用它填模型的建議（只在還是 null 時），之後使用者從畫面改。
     * 值的規則（非空、長度、控制字元）在 meetingTitle.ts 由呼叫端先驗，這裡只寫。
     */
    setTitle: (id: string, title: string, updatedAt: number): Meeting => {
      requireMeeting(id);
      db.prepare('UPDATE meetings SET title = ?, updated_at = ? WHERE meeting_id = ?').run(title, updatedAt, id);
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
     * 刪掉整場會。transcripts、analyses、meeting_tags、meeting_participants 靠外鍵 cascade
     * 一起走（meetingDb 開了 `PRAGMA foreign_keys = ON`）；手動逐張刪的話，之後新增的表
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
        db.prepare('DELETE FROM name_mentions WHERE meeting_id = ?').run(id);
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
        db.prepare('DELETE FROM name_mentions WHERE meeting_id = ?').run(id);
        db.prepare('UPDATE meetings SET updated_at = ? WHERE meeting_id = ?').run(updatedAt, id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return next;
    },

    /**
     * 人工編輯會議記錄：整份覆寫（前端送的是編輯後的完整 v3）。
     * 還沒有分析的會拋錯，理由同 updateTranscript。
     */
    replaceAnalysis: (id: string, analysis: AnalysisV3, updatedAt: number): void => {
      requireMeeting(id);
      if (!readAnalysisRow(id)) throw new Error(`Meeting ${id} 還沒有分析結果，沒有東西可以編輯`);
      if (isAnalysisV3SemanticallyEmpty(analysis)) {
        throw new Error(`Meeting ${id} 的分析五個欄位都是空的，不寫入`);
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

    saveAnalysis: (id: string, analysis: AnalysisV3, createdAt: number): void => {
      requireMeeting(id);
      if (isAnalysisV3SemanticallyEmpty(analysis)) {
        // 與 saveTranscript 同一條標準（SDD 1.5）：五個欄位全空卻寫成成功，
        // 在畫面上跟「這場會沒什麼結論」長得一樣，而且不會有任何錯誤
        throw new Error(`Meeting ${id} 的分析五個欄位都是空的，不寫入`);
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

    /**
     * 讀出來的一律是 v3。v2 的舊資料在這裡 lazy 升級（`upgradeAnalysisV2ToV3`），
     * 不改寫資料列本身——升級只是讀取時呈現的形狀，資料列維持 `contract_version = 2`
     * 直到下一次真的被覆寫（`saveAnalysis`／`replaceAnalysis` 只寫 v3）。
     */
    getAnalysis: (id: string): AnalysisV3 | null => {
      const row = readAnalysisRow(id);
      if (!row) return null;
      if (row.contract_version === 2) {
        return upgradeAnalysisV2ToV3({
          contract_version: 2,
          overview: row.overview,
          topics: JSON.parse(row.topics),
          decisions: JSON.parse(row.decisions),
          action_items: JSON.parse(row.action_items),
        });
      }
      if (row.contract_version !== 3) {
        throw new Error(`Meeting ${id} 的分析是 C-ANALYSIS v${row.contract_version}，這一版只讀 v2 與 v3`);
      }
      return {
        contract_version: 3,
        overview: row.overview,
        topics: JSON.parse(row.topics),
        decisions: JSON.parse(row.decisions),
        action_items: JSON.parse(row.action_items),
        open_questions: JSON.parse(row.open_questions ?? '[]'),
      };
    },

    getTags: (id: string): string[] =>
      (db.prepare('SELECT tag FROM meeting_tags WHERE meeting_id = ? ORDER BY tag').all(id) as { tag: string }[])
        .map(r => r.tag),

    /** 這場會的與會者員編（N3 轉錄／分析提示、N4 NameResolver 比對都靠這份清單縮小範圍） */
    getParticipants: (id: string): string[] =>
      (selectParticipants.all(id) as { employee_id: string }[]).map((r) => r.employee_id),

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
     * 有題目標籤的會議 id（W4）。關聯的比對對象就是這一組。
     *
     * 只看 topic_tags 有沒有列，不看 `topic_extraction_status`：`empty` 與 `failed` 的會如果
     * 上一輪抽到過標籤，那些標籤仍然留著（saveTopicExtraction 不刪），它們照樣是合法的關聯原料。
     * 反過來用狀態欄判的話，一次失敗的重抽會讓這場會從所有人的關聯對象裡安靜消失。
     */
    listTopicTagOwners: (): string[] =>
      (db.prepare('SELECT DISTINCT meeting_id FROM topic_tags ORDER BY meeting_id').all() as
        { meeting_id: string }[]).map(r => r.meeting_id),

    /** 這場會有向量的標籤（W4）。沒有向量的標籤不會出現在這裡，要補算的用 listTagsMissingVectors 查 */
    getTagVectors: (id: string): TagVector[] =>
      (db.prepare(
        'SELECT t.tag_id, t.title, e.model, e.dimensions, e.vector FROM topic_tags t '
        + 'JOIN topic_tag_embeddings e ON e.tag_id = t.tag_id '
        + 'WHERE t.meeting_id = ? ORDER BY t.created_at, t.title, t.tag_id',
      ).all(id) as { tag_id: string; title: string; model: string; dimensions: number; vector: Uint8Array }[])
        .map(row => ({
          tag_id: row.tag_id,
          title: row.title,
          model: row.model,
          dimensions: row.dimensions,
          vector: fromVectorBlob(row.vector),
        })),

    /**
     * 這場會需要（重）算向量的標籤（W4）。lazy 補算的輸入。
     *
     * 兩種都算：**沒有向量的**，以及**向量是別的 model 算的**。
     * 只補前者的話，換過 embedding model 之後舊向量會一直留著，而 `canCompare` 會把它們全部
     * 判成不可比——結果是那些會安靜地關聯不到任何東西，狀態卻是正常的 `LINKED` ＋ 空集合。
     */
    listTagsNeedingVectors: (id: string, model: string): TopicTag[] =>
      (db.prepare(
        'SELECT t.* FROM topic_tags t LEFT JOIN topic_tag_embeddings e ON e.tag_id = t.tag_id '
        + 'WHERE t.meeting_id = ? AND (e.tag_id IS NULL OR e.model <> ?) '
        + 'ORDER BY t.created_at, t.title, t.tag_id',
      ).all(id, model) as TopicTagRow[]).map(toTopicTag),

    /**
     * 落地一批向量（W4）。整批一個交易。
     *
     * 同一個 tag_id 重送就覆蓋：重算向量的唯一正當理由是換了 model，那時舊的一定要走。
     */
    saveTagVectors: (rows: readonly NewTagVector[], at: number): void => {
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          if (row.vector.length !== row.dimensions) {
            // 維度欄跟實際長度對不上的話，canCompare 會拿一個假的維度去比，
            // 而兩條長度不同的向量算 cosine 會在 cosine 裡拋錯，錯誤指到的是比對不是寫入
            throw new Error(
              `標籤 ${row.tag_id} 的向量長度是 ${row.vector.length}，但 dimensions 欄寫 ${row.dimensions}`,
            );
          }
          db.prepare(
            'INSERT INTO topic_tag_embeddings (tag_id, model, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?) '
            + 'ON CONFLICT(tag_id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions, '
            + 'vector = excluded.vector, created_at = excluded.created_at',
          ).run(row.tag_id, row.model, row.dimensions, toVectorBlob(row.vector), at);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** 這場會的關聯（W4）。兩端都查，因為 A×B 只存一列 */
    getLinks: (id: string): TopicLink[] =>
      (db.prepare(
        'SELECT * FROM topic_links WHERE meeting_a = ? OR meeting_b = ? '
        + 'ORDER BY confidence DESC, meeting_a, meeting_b',
      ).all(id, id) as (Omit<TopicLink, 'shared_topics'> & { shared_topics: string })[])
        .map(row => ({ ...row, shared_topics: JSON.parse(row.shared_topics) as string[] })),

    /** 這場會最近一次關聯計算的覆蓋率（W4）。沒算過是 null——那跟「算過但沒找到」不是同一件事 */
    getLinkRun: (id: string): LinkRun | null =>
      (db.prepare('SELECT * FROM link_runs WHERE meeting_id = ?').get(id) as LinkRunRow | undefined) ?? null,

    /** 人標記某一對不相關（W4）。同一對重標就更新原因，不新增一列 */
    addLinkExclusion: (x: string, y: string, reason: LinkExclusionReason, at: number): void => {
      const [a, b] = orderPair(x, y);
      requireMeeting(a);
      requireMeeting(b);
      if (!isLinkExclusionReason(reason)) throw new Error(`排除原因不是合法值：${reason}`);
      db.exec('BEGIN');
      try {
        db.prepare(
          'INSERT INTO link_exclusions (meeting_a, meeting_b, reason_code, created_at) VALUES (?, ?, ?, ?) '
          + 'ON CONFLICT(meeting_a, meeting_b) DO UPDATE SET reason_code = excluded.reason_code',
        ).run(a, b, reason, at);
        // 已經在畫面上的那一筆同時撤掉。只記排除不刪 Link 的話，人標了不相關之後那筆關聯
        // 還會留在那裡直到下一次重算，而重算可能永遠不會發生
        db.prepare('DELETE FROM topic_links WHERE meeting_a = ? AND meeting_b = ?').run(a, b);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** 跟這場會有關的排除紀錄（W4） */
    listLinkExclusions: (id: string): LinkExclusion[] =>
      (db.prepare(
        'SELECT * FROM link_exclusions WHERE meeting_a = ? OR meeting_b = ? ORDER BY meeting_a, meeting_b',
      ).all(id, id) as LinkExclusionRow[]).map(toLinkExclusion),

    /**
     * 落地一次關聯計算（W4）：關聯本體與覆蓋率同一個交易。
     *
     * **整組換掉，不是累加**：先刪掉這場會兩端的全部既有關聯，再寫新的。累加的話，上一輪算出來
     * 而這一輪不再成立的關聯會永遠留著，而重算本來就是為了讓結果跟著新的標籤與新的演算法版本走。
     *
     * **排除紀錄在這裡再擋一次**（SDD 1.2「人工優先且黏著」）。候選階段已經扣過了，這裡是最後一道：
     * 少了它，任何一條繞過候選選擇直接寫入的路徑都會讓人標過不相關的關聯復活，而復活的當下
     * 沒有任何錯誤訊息。
     */
    saveLinkResult: (id: string, result: LinkResult, at: number): LinkWriteReport => {
      requireMeeting(id);
      const report: LinkWriteReport = { inserted: 0, blockedByExclusion: [] };

      const excluded = new Set(
        (db.prepare('SELECT meeting_a, meeting_b FROM link_exclusions WHERE meeting_a = ? OR meeting_b = ?')
          .all(id, id) as { meeting_a: string; meeting_b: string }[])
          .map(r => pairKey(r.meeting_a, r.meeting_b)),
      );

      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM topic_links WHERE meeting_a = ? OR meeting_b = ?').run(id, id);

        for (const link of result.links) {
          const [a, b] = orderPair(id, link.other_meeting_id);
          if (excluded.has(pairKey(a, b))) {
            report.blockedByExclusion.push(link.other_meeting_id);
            continue;
          }
          db.prepare(
            'INSERT INTO topic_links (link_id, meeting_a, meeting_b, confidence, evidence, shared_topics, '
            + 'algo_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            randomUUID(), a, b, link.confidence, link.evidence,
            JSON.stringify(link.shared_topics), result.algo_version, at,
          );
          report.inserted += 1;
        }

        writeLinkRun(id, result, at);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return report;
    },

    /**
     * 只寫覆蓋率，不動既有的關聯（W4）。
     *
     * 關聯算失敗時走這條：這一輪沒算到不代表上一輪算到的是錯的，把既有那組刪掉只會讓
     * 使用者在一次額度用完之後失去本來看得到的關聯——理由與 W3 的 `empty`／`failed`
     * 不刪既有標籤同一條。狀態欄已經把「這一輪沒算成」講清楚了。
     */
    saveLinkRun: (id: string, result: LinkResult, at: number): void => {
      requireMeeting(id);
      writeLinkRun(id, result, at);
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

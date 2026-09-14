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
import { Meeting, TranscriptSegment } from '../types';
import { AnalysisV2, isAnalysisV2SemanticallyEmpty } from './analysisContract';
import { MigrationRecord } from './jobMigration';
import { MeetingStatus, assertTransition, isMeetingStatus } from './meetingState';

export interface TranscriptRecord {
  segments: TranscriptSegment[];
  polished_content: string | null;
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
  return { ...row, status: row.status, origin: row.origin };
};

export const createMeetingStore = (db: DatabaseSync) => {
  const selectOne = db.prepare('SELECT * FROM meetings WHERE meeting_id = ?');
  // 排序鍵明寫到唯一為止：只用 created_at 的話，同一毫秒建立的兩場會順序未定義，
  // 而「它看起來是穩定的」正是 DEV-STANDARDS〈確定性〉點名的那種假設
  const selectAll = db.prepare('SELECT * FROM meetings ORDER BY created_at DESC, meeting_id DESC');

  const insertMeeting = db.prepare(`
    INSERT INTO meetings (meeting_id, title, status, created_at, updated_at, source_file_name,
                          source_file_size, origin, error, processed_slices, total_slices, meeting_context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTranscript = db.prepare(
    'INSERT OR REPLACE INTO transcripts (meeting_id, segments, polished_content, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertAnalysis = db.prepare(`
    INSERT OR REPLACE INTO analyses (meeting_id, contract_version, overview, topics, decisions, action_items, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare('INSERT OR IGNORE INTO meeting_tags (meeting_id, tag) VALUES (?, ?)');

  const getMeeting = (id: string): Meeting | null => {
    const row = selectOne.get(id) as MeetingRow | undefined;
    return row ? toMeeting(row) : null;
  };

  const requireMeeting = (id: string): Meeting => {
    const meeting = getMeeting(id);
    if (!meeting) throw new Error(`找不到 Meeting ${id}`);
    return meeting;
  };

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

    getTranscript: (id: string): TranscriptRecord | null => {
      const row = db.prepare('SELECT segments, polished_content FROM transcripts WHERE meeting_id = ?').get(id) as
        { segments: string; polished_content: string | null } | undefined;
      if (!row) return null;
      return { segments: JSON.parse(row.segments) as TranscriptSegment[], polished_content: row.polished_content };
    },

    getAnalysis: (id: string): AnalysisV2 | null => {
      const row = db.prepare(
        'SELECT contract_version, overview, topics, decisions, action_items FROM analyses WHERE meeting_id = ?',
      ).get(id) as {
        contract_version: number; overview: string; topics: string; decisions: string; action_items: string;
      } | undefined;
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

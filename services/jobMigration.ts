/**
 * IndexedDB 的 Job 轉成 server 端的 Meeting（SDD 1.5 的 migration 第一段）。
 *
 * 這裡只做轉換與判定，不碰資料庫：轉換是純函式才測得動，而 migration 的驗收條件
 * 是「對真實資料副本逐筆比對無遺漏」，逐筆比對比的就是這個函式的輸出。
 *
 * 輸入來自瀏覽器經 HTTP 送上來的 JSON，所以型別不保證。每一筆都在執行期驗，
 * 驗不過的**整筆拒收並回報原因**，不補預設值、不猜、也不靜默跳過：
 * 靜默跳過的那幾筆在報告裡跟「本來就沒有」長得一模一樣。
 */
import { GeminiOutput, Job, JobStatus, Meeting, TranscriptSegment } from '../types';
import { AnalysisV3, isAnalysisSemanticallyEmpty, upgradeAnalysisToV2, upgradeAnalysisV2ToV3 } from './analysisContract';
import { MeetingStatus } from './meetingState';

export interface MigrationRecord {
  meeting: Meeting;
  transcript: { segments: TranscriptSegment[]; polished_content: string | null } | null;
  /** IndexedDB 只有 v1（`GeminiOutput`），這裡一路升到 v3 才落地：v1 → v2 → v3 兩段都是
   * 純函式、都不編造資料，逐筆比對比的就是升到底之後的值 */
  analysis: AnalysisV3 | null;
  /** 既有的 meetingTags（人工輸入、只當 prompt 背景），不是 TopicTag */
  tags: string[];
}

export interface MigrationAccepted { ok: true; record: MigrationRecord; notes: string[] }
export interface MigrationRejected { ok: false; jobId: string | null; reason: string }
export type MigrationOutcome = MigrationAccepted | MigrationRejected;

/**
 * 明寫的型別守衛，不靠 `if (!outcome.ok)` 自己收斂：這個 repo 的 tsconfig 沒開 strict，
 * discriminated union 的自動 narrowing 在這裡不成立，`outcome.reason` 會直接是型別錯誤。
 */
export const isRejected = (outcome: MigrationOutcome): outcome is MigrationRejected => !outcome.ok;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const isTranscriptSegment = (v: unknown): v is TranscriptSegment =>
  isObject(v)
  && typeof v.start === 'number'
  && typeof v.end === 'number'
  && typeof v.text === 'string';

const isGeminiOutput = (v: unknown): v is GeminiOutput =>
  isObject(v)
  && typeof v.overview === 'string'
  && Array.isArray(v.topics)
  && v.topics.every(t => isObject(t) && typeof t.title === 'string' && typeof t.content === 'string')
  && Array.isArray(v.decisions)
  && v.decisions.every(d => typeof d === 'string')
  && Array.isArray(v.action_items)
  && v.action_items.every(a => typeof a === 'string');

/**
 * Job.status 對到 Meeting.status。
 *
 * RUNNING 沒有對應的中間態可以還原：處理上下文（音檔、已完成的切片）留在瀏覽器，
 * server 接手時什麼都沒有。映射成 CREATED 代表「待處理」，語意是對的，但呼叫端要拿到
 * note 才知道這筆得重跑一次，所以回傳帶 note 而不是安靜地轉。
 *
 * COMPLETED 卻缺 transcript 或 analysis 是資料本身不一致，不是可以轉換的狀態，整筆拒收。
 */
const mapStatus = (
  job: Job,
  hasTranscript: boolean,
  analysis: GeminiOutput | null,
): { status: MeetingStatus; note?: string } | { reject: string } => {
  switch (job.status) {
    case JobStatus.PENDING:
      return { status: 'CREATED' };
    case JobStatus.RUNNING:
      return { status: 'CREATED', note: '原本是處理中，音檔與進度留在瀏覽器無法接手，匯入後需要重新送出處理' };
    case JobStatus.FAILED:
      return { status: 'FAILED' };
    case JobStatus.COMPLETED:
      if (!hasTranscript) return { reject: 'status 是 COMPLETED 但沒有逐字稿' };
      if (!analysis) return { reject: 'status 是 COMPLETED 但沒有分析結果' };
      if (isAnalysisSemanticallyEmpty(analysis)) return { reject: 'status 是 COMPLETED 但分析結果四個欄位都是空的' };
      return { status: 'READY' };
    default:
      return { reject: `不認得的 job status：${String(job.status)}` };
  }
};

/**
 * 轉一筆。函式裡不拿 Date.now()、不產生 id：同一份輸入必須轉出同一份輸出，
 * 否則 rehearsal 的逐筆比對比不了（DEV-STANDARDS〈確定性〉）。
 * 缺 createdAt 的一律拒收而不是補 now()，補了就分不出「舊資料本來就有時間」與「我們編的」。
 */
export const toMigrationRecord = (raw: unknown): MigrationOutcome => {
  if (!isObject(raw)) return { ok: false, jobId: null, reason: '不是物件' };

  const id = asString(raw.id);
  if (!id || !id.trim()) return { ok: false, jobId: null, reason: '缺 id 或 id 不是非空字串' };

  const status = asString(raw.status);
  if (!status || !(Object.values(JobStatus) as string[]).includes(status)) {
    return { ok: false, jobId: id, reason: `status 不是合法的 JobStatus：${String(raw.status)}` };
  }

  const createdAt = asNumber(raw.createdAt);
  if (createdAt === null) return { ok: false, jobId: id, reason: '缺 createdAt 或不是數字' };

  // updatedAt 在 Job 型別裡是必填，缺了代表這筆資料本身壞掉。跟 createdAt 同一個標準拒收，
  // 不要沿用 createdAt 頂替：頂替之後「本來就沒動過」與「我們補的」在資料庫裡分不出來
  const updatedAt = asNumber(raw.updatedAt);
  if (updatedAt === null) return { ok: false, jobId: id, reason: '缺 updatedAt 或不是數字' };

  // transcript 沒有這個欄位是合法的（還沒轉錄）；有但不是陣列就是資料壞了，不能當成「沒有逐字稿」。
  // 兩者若都變成 null，COMPLETED 那條的拒收原因會寫成「沒有逐字稿」，跟真的沒有分不開
  if (raw.transcript !== undefined && raw.transcript !== null && !Array.isArray(raw.transcript)) {
    return { ok: false, jobId: id, reason: 'transcript 不是陣列' };
  }
  const rawSegments = Array.isArray(raw.transcript) ? raw.transcript : null;
  if (rawSegments && !rawSegments.every(isTranscriptSegment)) {
    return { ok: false, jobId: id, reason: 'transcript 裡有段落缺 start / end / text' };
  }
  const segments = rawSegments as TranscriptSegment[] | null;

  const analysisRaw = raw.analysis;
  if (analysisRaw !== undefined && analysisRaw !== null && !isGeminiOutput(analysisRaw)) {
    return { ok: false, jobId: id, reason: 'analysis 的形狀不符合 C-ANALYSIS v1' };
  }
  const analysis = (analysisRaw ?? null) as GeminiOutput | null;

  const job = { ...raw, id, status: status as JobStatus, createdAt } as unknown as Job;
  const mapped = mapStatus(job, !!segments && segments.length > 0, analysis);
  if ('reject' in mapped) return { ok: false, jobId: id, reason: mapped.reject };

  const notes: string[] = [];
  if (mapped.note) notes.push(mapped.note);

  // 標籤是人工輸入的，掉了很難察覺，所以丟掉幾個要講出來
  const rawTags = Array.isArray(raw.meetingTags) ? raw.meetingTags : [];
  const tags = rawTags.filter((t): t is string => typeof t === 'string');
  if (tags.length !== rawTags.length) {
    notes.push(`meetingTags 有 ${rawTags.length - tags.length} 個元素不是字串，已丟棄`);
  }
  const upgraded = analysis ? upgradeAnalysisV2ToV3(upgradeAnalysisToV2(analysis, id, createdAt)) : null;

  const meeting: Meeting = {
    meeting_id: id,
    // READY 的用 overview 當標題，其餘只有檔名可用。兩者都沒有就留 null，不塞「未命名」這種假標題
    title: upgraded?.overview.trim() || asString(raw.fileName) || null,
    status: mapped.status,
    created_at: createdAt,
    updated_at: updatedAt,
    source_file_name: asString(raw.fileName),
    source_file_size: asNumber(raw.fileSize),
    origin: 'migrated',
    error: asString(raw.error),
    processed_slices: asNumber(raw.processedSlices),
    total_slices: asNumber(raw.totalSlices),
    meeting_context: asString(raw.meetingContext),
    // 搬遷進來的會沒有題目標籤，也不該假裝抽過。null 是「還沒抽過」，
    // 之後真的抽了才會有值（W3）
    topic_extraction_status: null,
    topic_extraction_error: null,
  };

  return {
    ok: true,
    record: {
      meeting,
      transcript: segments && segments.length > 0
        ? { segments, polished_content: asString(raw.polishedContent) }
        : null,
      analysis: upgraded,
      tags,
    },
    notes,
  };
};

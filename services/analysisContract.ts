/**
 * `C-ANALYSIS` v1 → v2（SDD 1.3）。本設計唯一的破壞性資料契約變更。
 *
 * v1 的 action_items 是 string[]（types.ts 的 GeminiOutput），v2 每筆帶
 * text、source_meeting_id、created_at、status，`assignee` 的來源未定（U-007），
 * 欄位存在但可為空。
 *
 * 歷史待辦的 status 一律補 'unknown'（SDD D-004）：舊資料沒有狀態資訊，
 * 補 'open' 會讓從未被追蹤過的舊待辦看起來像待處理，補 'done' 會讓真正未完成的消失。
 * 兩種都是編造，'unknown' 是誠實的第三種。
 */
import { GeminiOutput, TranscriptSegment } from '../types';

export type ActionItemStatus = 'unknown' | 'open' | 'done';

export interface ActionItemV2 {
  text: string;
  source_meeting_id: string;
  created_at: number;
  status: ActionItemStatus;
  /** U-007 未關閉：來源未定，欄位存在但可為空 */
  assignee?: string;
}

export interface AnalysisV2 {
  contract_version: 2;
  overview: string;
  topics: { title: string; content: string }[];
  decisions: string[];
  action_items: ActionItemV2[];
}

/**
 * 把一份 v1 的 GeminiOutput 升成 v2。
 *
 * meetingId 與 createdAt 由呼叫端給：這兩個值不在 v1 的資料裡，函式自己拿 Date.now()
 * 會讓同一份輸入每次轉出不同結果，migration 的逐筆比對就失去意義（DEV-STANDARDS〈確定性〉）。
 */
export const upgradeAnalysisToV2 = (v1: GeminiOutput, meetingId: string, createdAt: number): AnalysisV2 => ({
  contract_version: 2,
  overview: v1.overview,
  topics: v1.topics,
  decisions: v1.decisions,
  action_items: v1.action_items.map(text => ({
    text,
    source_meeting_id: meetingId,
    created_at: createdAt,
    status: 'unknown' as const,
  })),
});

/**
 * analysis 是不是「型別對但語意空」。
 *
 * 四個欄位全空卻標記成功，是 DEV-STANDARDS〈不要用 fallback 掩蓋錯誤〉點名的形狀，
 * SDD 1.5 把它列為資料品質檢查。這裡只判定，不決定怎麼處置：
 * migration 拿它擋下該筆並回報，`MeetingStore.saveAnalysis` 拿它擋寫入。
 */
export const isAnalysisSemanticallyEmpty = (v1: GeminiOutput): boolean =>
  !v1.overview.trim()
  && v1.topics.length === 0
  && v1.decisions.length === 0
  && v1.action_items.length === 0;

export const isAnalysisV2SemanticallyEmpty = (v2: AnalysisV2): boolean =>
  !v2.overview.trim()
  && v2.topics.length === 0
  && v2.decisions.length === 0
  && v2.action_items.length === 0;

/**
 * `C-ANALYSIS` v2 → v3。第二個破壞性契約變更：規範重寫成「段落固定、內容不臆測」之後，
 * 決議、待辦、未決事項每條都要能回查逐字稿，不然規範「出處必附」在資料層沒有地方落地。
 *
 * `evidence` 存秒數（`TranscriptSegment.start`／`end`），不是段落編號：模型只知道編號，
 * 但編號會因為逐字稿被 `PATCH` 改過而位移，秒數不會。編號 → 秒數的換算在
 * `buildAnalysisV3FromModelOutput`，離模型輸出最近的地方做，離存進 SQLite的形狀最遠。
 *
 * `open_questions` 是新增的一段，不是修改既有欄位：`types.ts` 的 `GeminiOutput` 早期有過
 * 一個同名概念但已被移除（初版 commit，不是 SDD 決策），這裡是重新設計，跟舊的無關。
 */

/** 一條結論／待辦／未決事項回查得到的逐字稿位置，秒數對應 `TranscriptSegment.start`／`end` */
export interface Evidence {
  start: number;
  end: number;
}

export interface DecisionV3 {
  text: string;
  /** 找不到出處就是 null——只有 v2 升上來的舊資料會是 null，模型端新產生的一律要有值 */
  evidence: Evidence | null;
  /** 只用逐字稿裡講過的人名；沒明講就是 null，不從語氣或職稱推測 */
  decided_by: string | null;
  /**
   * `C-ANALYSIS` v3 → v4（SDD 1.3.2，`NameResolver` 反查，關閉 U-007）。選填（`?`）而不是
   * 必填 `| null`：這個欄位加在既有的 v3 型別上，`contract_version` 不動，舊資料的 JSON blob
   * 裡沒有這個 key，`upgradeAnalysisV2ToV3`／`buildAnalysisV3FromModelOutput` 也不用跟著改
   * ——查不到員編或反查邏輯本身失敗時就是「這個 key 不存在」，跟寫成 `null` 是同一件事，
   * 不需要特殊的 lazy 升級分支（SDD 1.3.2〈第 3 層〉）。由 `nameResolver.ts` 的
   * `resolveAnalysisEmployeeIds` 在分析完成後另外補上
   */
  decided_by_employee_id?: string | null;
}

export interface ActionItemV3 {
  text: string;
  source_meeting_id: string;
  created_at: number;
  status: ActionItemStatus;
  /** v2 是 `assignee?: string`（U-007 未關閉、來源未定）。v3 明寫成 `string | null`：
   * 「沒有」跟「這個欄位選擇性存在」不是同一件事，nullable 比 optional 誠實 */
  assignee: string | null;
  /** 逐字稿講的原話（例如「下週三」），不換算成日期；沒講就是 null */
  due: string | null;
  evidence: Evidence | null;
  /** 同 `DecisionV3.decided_by_employee_id`，由 `nameResolver.ts` 反查 `assignee` 補上 */
  assignee_employee_id?: string | null;
}

export interface OpenQuestionV3 {
  text: string;
  evidence: Evidence | null;
}

/**
 * 討論段的一個要點（SDD v0.9，vault plan「MeetPilot · 會議記錄結構化與逐點出處」）。加在 v3 上的選填欄位，
 * `contract_version` 不動：舊資料的 topic 沒有 `points` 這個 key，呈現端退回只印 `content`。
 * 不帶提出者（SDD D-021）：轉錄的講者只是人聲編號，對不上真人。
 */
export interface TopicPointV3 {
  text: string;
  evidence: Evidence | null;
}

export interface TopicV3 {
  title: string;
  /** v0.9 起是「本節走到哪」一兩句；舊資料是整段內容 */
  content: string;
  points?: TopicPointV3[];
}

export interface AnalysisV3 {
  contract_version: 3;
  overview: string;
  topics: TopicV3[];
  decisions: DecisionV3[];
  action_items: ActionItemV3[];
  open_questions: OpenQuestionV3[];
}

/**
 * 把一份 v2 升成 v3。跟 `upgradeAnalysisToV2` 同一套原則：純函式、呼叫端給
 * meetingId／createdAt、不編造資料。舊的 decisions／action_items 沒有出處與人名，
 * 一律補 null，不是空字串——空字串會被之後的判斷誤認成「模型回了空白」。
 */
export const upgradeAnalysisV2ToV3 = (v2: AnalysisV2): AnalysisV3 => ({
  contract_version: 3,
  overview: v2.overview,
  topics: v2.topics,
  decisions: v2.decisions.map(text => ({ text, evidence: null, decided_by: null })),
  action_items: v2.action_items.map(item => ({
    ...item,
    assignee: item.assignee ?? null,
    due: null,
    evidence: null,
  })),
  open_questions: [],
});

/** 同 `isAnalysisV2SemanticallyEmpty`，五欄都空才算空——`open_questions` 有內容、
 * 其餘四欄都空是合法結果（一場會只吵出問題、什麼都沒定案），不能被判定成空分析擋下來 */
export const isAnalysisV3SemanticallyEmpty = (v3: AnalysisV3): boolean =>
  !v3.overview.trim()
  && v3.topics.length === 0
  && v3.decisions.length === 0
  && v3.action_items.length === 0
  && v3.open_questions.length === 0;

/**
 * 分析模型（`geminiServerClient.ts` 的 `analyzeTranscript`）回的形狀，不是存進 SQLite 的形狀。
 * 出處用逐字稿的段落編號（1-based，對應餵給模型時標的 `[#n ...]`），不是秒數——模型算秒數
 * 容易算錯，回段落編號只要查表，換算成秒數是 `buildAnalysisV3FromModelOutput` 的工作。
 */
export interface AnalysisModelSegmentRef {
  segment_from: number;
  segment_to: number;
}

export interface AnalysisModelOutput {
  /** 建議標題（規範〈標題〉節）。存進 `meetings.title`、不在 C-ANALYSIS 裡；只在那場會還沒有標題時採用 */
  title: string;
  overview: string;
  topics: { title: string; content: string; points: (AnalysisModelSegmentRef & { text: string })[] }[];
  decisions: (AnalysisModelSegmentRef & { text: string; decided_by: string | null })[];
  action_items: (AnalysisModelSegmentRef & { text: string; assignee: string | null; due: string | null })[];
  open_questions: (AnalysisModelSegmentRef & { text: string })[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSegmentRef = (v: unknown): v is AnalysisModelSegmentRef =>
  isPlainObject(v) && typeof v.segment_from === 'number' && typeof v.segment_to === 'number';

/**
 * 結構化輸出的 responseSchema 保證「解得開的 JSON」，不保證每個欄位的型別完全符合我們的預期
 * ——這裡再驗一次，形狀不對就明確拋錯，不要讓錯的型別一路帶進 `buildAnalysisV3FromModelOutput`
 * 才在算秒數時炸出一個看不出原因的 TypeError。
 */
export function assertAnalysisModelOutput(value: unknown): asserts value is AnalysisModelOutput {
  if (!isPlainObject(value)) throw new Error('分析模型回應的結構化輸出不是物件');
  if (typeof value.title !== 'string') throw new Error('結構化輸出的 title 不是字串');
  if (typeof value.overview !== 'string') throw new Error('結構化輸出的 overview 不是字串');
  if (
    !Array.isArray(value.topics)
    || !value.topics.every((t) => isPlainObject(t) && typeof t.title === 'string' && typeof t.content === 'string'
      && Array.isArray(t.points)
      && t.points.every((pt) => isSegmentRef(pt) && isPlainObject(pt) && typeof pt.text === 'string'))
  ) {
    throw new Error('結構化輸出的 topics 形狀不對：每筆要有字串 title、content 與 points（每點字串 text、整數 segment_from／segment_to）');
  }
  if (
    !Array.isArray(value.decisions)
    || !value.decisions.every((d) =>
      isSegmentRef(d) && isPlainObject(d) && typeof d.text === 'string'
      && (d.decided_by === null || typeof d.decided_by === 'string'))
  ) {
    throw new Error('結構化輸出的 decisions 形狀不對：每筆要有字串 text、整數 segment_from／segment_to、decided_by 是字串或 null');
  }
  if (
    !Array.isArray(value.action_items)
    || !value.action_items.every((a) =>
      isSegmentRef(a) && isPlainObject(a) && typeof a.text === 'string'
      && (a.assignee === null || typeof a.assignee === 'string')
      && (a.due === null || typeof a.due === 'string'))
  ) {
    throw new Error('結構化輸出的 action_items 形狀不對：每筆要有字串 text、整數 segment_from／segment_to、assignee／due 是字串或 null');
  }
  if (
    !Array.isArray(value.open_questions)
    || !value.open_questions.every((q) => isSegmentRef(q) && isPlainObject(q) && typeof q.text === 'string')
  ) {
    throw new Error('結構化輸出的 open_questions 形狀不對：每筆要有字串 text、整數 segment_from／segment_to');
  }
}

/**
 * 段落編號（1-based）換算成 Evidence（秒）。編號超出逐字稿範圍、不是整數、或
 * from > to 就拋錯——不裁切、不丟掉那一條，讓呼叫端整場會 FAILED 可重跑。
 * 靜默丟掉一條決議或裁掉一個編號，會讓「這條結論查不到出處」在畫面上跟
 * 「模型沒回」長得一樣，兩者原因完全不同（DEV-STANDARDS〈不要用 fallback 掩蓋錯誤〉）。
 */
const resolveEvidence = (
  ref: AnalysisModelSegmentRef,
  transcript: readonly TranscriptSegment[],
  context: string,
): Evidence => {
  const { segment_from, segment_to } = ref;
  if (!Number.isInteger(segment_from) || !Number.isInteger(segment_to)) {
    throw new Error(`${context}的段落編號不是整數：segment_from=${segment_from}, segment_to=${segment_to}`);
  }
  if (segment_from < 1 || segment_from > transcript.length || segment_to < 1 || segment_to > transcript.length) {
    throw new Error(
      `${context}的段落編號超出逐字稿範圍（共 ${transcript.length} 段）：`
      + `segment_from=${segment_from}, segment_to=${segment_to}`,
    );
  }
  if (segment_from > segment_to) {
    throw new Error(`${context}的 segment_from（${segment_from}）大於 segment_to（${segment_to}）`);
  }
  return { start: transcript[segment_from - 1].start, end: transcript[segment_to - 1].end };
};

/**
 * 模型輸出轉成要存的 AnalysisV3。meetingId／createdAt 由呼叫端給，理由同
 * `upgradeAnalysisToV2`：同一份輸入要能轉出同一份輸出。action_items 的 status
 * 一律 'unknown'（SDD D-004 同一條標準：模型不判斷待辦有沒有完成，那是事後追蹤的事）。
 */
export const buildAnalysisV3FromModelOutput = (
  output: AnalysisModelOutput,
  transcript: readonly TranscriptSegment[],
  meetingId: string,
  createdAt: number,
): AnalysisV3 => ({
  contract_version: 3,
  overview: output.overview,
  topics: output.topics.map((t, i) => ({
    title: t.title,
    content: t.content,
    points: t.points.map((pt, j) => ({
      text: pt.text,
      evidence: resolveEvidence(pt, transcript, `第 ${i + 1} 個議題的第 ${j + 1} 點`),
    })),
  })),
  decisions: output.decisions.map((d, i) => ({
    text: d.text,
    decided_by: d.decided_by,
    evidence: resolveEvidence(d, transcript, `第 ${i + 1} 條決議`),
  })),
  action_items: output.action_items.map((a, i) => ({
    text: a.text,
    source_meeting_id: meetingId,
    created_at: createdAt,
    status: 'unknown' as const,
    assignee: a.assignee,
    due: a.due,
    evidence: resolveEvidence(a, transcript, `第 ${i + 1} 條待辦`),
  })),
  open_questions: output.open_questions.map((q, i) => ({
    text: q.text,
    evidence: resolveEvidence(q, transcript, `第 ${i + 1} 條未決事項`),
  })),
});

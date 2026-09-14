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
import { GeminiOutput } from '../types';

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

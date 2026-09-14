/**
 * Meeting 的狀態集合與合法轉移（SDD 1.4）。
 *
 * 這裡只有規則，沒有 I/O：`MeetingStore` 每一次改狀態都要先過 `assertTransition`，
 * 呼叫端不得直接設值。規則寫成純函式是為了讓「非法轉移被拒絕」有一支跑得快的測試。
 *
 * READY 與 LINKED 刻意分開（SDD D-002）：Meeting 在 READY 時結論已經完整可用，
 * 關聯尚未完成。兩者若共用一個狀態，「關聯整組壞掉」與「真的沒有相關會議」
 * 在資料層就分不開，而那種壞法不會有人發現。
 */

export type MeetingStatus =
  | 'CREATED'
  | 'TRANSCRIBING'
  | 'ANALYZING'
  | 'READY'
  | 'LINKING'
  | 'LINKED'
  | 'LINK_FAILED'
  | 'FAILED';

export const MEETING_STATUSES: readonly MeetingStatus[] = [
  'CREATED', 'TRANSCRIBING', 'ANALYZING', 'READY', 'LINKING', 'LINKED', 'LINK_FAILED', 'FAILED',
];

export const isMeetingStatus = (value: unknown): value is MeetingStatus =>
  typeof value === 'string' && (MEETING_STATUSES as readonly string[]).includes(value);

// SDD 1.4 的轉移表。任一段不可重試的錯誤都可以進 FAILED，所以 FAILED 不列在每一列裡，
// 由 canTransition 統一處理；FAILED 自己則可以退回 CREATED 重跑整條（音檔還在的情況）。
const ALLOWED: Record<MeetingStatus, readonly MeetingStatus[]> = {
  CREATED: ['TRANSCRIBING'],
  TRANSCRIBING: ['ANALYZING'],
  ANALYZING: ['READY'],
  READY: ['LINKING'],
  LINKING: ['LINKED', 'LINK_FAILED'],
  // 關聯可以全量重算，所以 LINKED 與 LINK_FAILED 都能再回到 LINKING
  LINKED: ['LINKING'],
  LINK_FAILED: ['LINKING'],
  FAILED: ['CREATED'],
};

/** 從某個狀態出發的全部合法下一步，含統一放行的 FAILED。錯誤訊息要列完整，少列一個會讓人以為那條路不存在 */
export const legalNextStates = (from: MeetingStatus): MeetingStatus[] =>
  from === 'FAILED' ? [...ALLOWED.FAILED] : [...ALLOWED[from], 'FAILED'];

export const canTransition = (from: MeetingStatus, to: MeetingStatus): boolean => {
  if (from === to) return false;
  // 轉錄、分析、關聯任一段的不可重試錯誤都落到 FAILED
  if (to === 'FAILED') return from !== 'FAILED';
  return ALLOWED[from].includes(to);
};

/**
 * 非法轉移一律拋錯，不靜默忽略、不回預設值（SDD 2.2 的 `I-MEETING` 錯誤模式）。
 * 訊息帶 meetingId 與前後狀態：只寫「invalid transition」跟沒擋差不多，出事時定位不到是哪一場會。
 */
export const assertTransition = (meetingId: string, from: MeetingStatus, to: MeetingStatus): void => {
  if (canTransition(from, to)) return;
  throw new Error(`Meeting ${meetingId} 不能從 ${from} 轉到 ${to}（合法的下一步：${legalNextStates(from).join(', ')}）`);
};

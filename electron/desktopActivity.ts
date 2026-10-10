/**
 * 桌面外殼對「會議在背景處理」的判斷（vault plan「MeetPilot · 記錄完整度、成本與背景運作」AC-3）。
 *
 * server 在 utilityProcess 裡，每當處理中的會議數變了、或有會議完成／失敗，就送一則活動訊息給主程序
 * （形狀見 `parseActivityMessage`，契約在 services/meetingActivity.ts）。這個檔只放可以不開 Electron 就測的判斷：
 * 訊息形狀驗證、要不要擋睡眠、結束要不要先問、事件轉通知文字、開機自動啟動與縮托盤的條件。
 * 不 import electron，也不 import server 端模組：形狀自己驗，server 那頭改壞了會在這裡被擋下並寫 log。
 */

export const ACTIVITY_MESSAGE_TYPE = 'meetpilot-activity';
export const ACTIVITY_SCHEMA = 1;

export type ActivityEventKind = 'done' | 'failed';

export interface ActivityEvent {
  meetingId: string;
  title: string | null;
  kind: ActivityEventKind;
  reason: string | null;
}

export interface ActivityMessage {
  /** 有 queued、claimed、running job 或在 LINKING 的會議數，同一場只算一次 */
  active: number;
  events: ActivityEvent[];
}

export type ActivityParse = { kind: 'ok'; message: ActivityMessage } | { kind: 'invalid'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 驗 server 送來的訊息。形狀不對整則不收並回原因，呼叫端寫 log、維持上一次的狀態：
 * 不把壞訊息當成「沒有活動」，否則 server 改壞格式時，防睡眠與結束確認會安靜失效。
 * 多出來的欄位放行（schema 1 往後只加欄位不算破壞）。
 */
export function parseActivityMessage(raw: unknown): ActivityParse {
  if (!isRecord(raw)) return { kind: 'invalid', reason: '不是物件' };
  if (raw.type !== ACTIVITY_MESSAGE_TYPE) return { kind: 'invalid', reason: `type 不是 ${ACTIVITY_MESSAGE_TYPE}` };
  if (raw.schema !== ACTIVITY_SCHEMA) return { kind: 'invalid', reason: `schema 是 ${JSON.stringify(raw.schema)}，這版只認 ${ACTIVITY_SCHEMA}` };
  const { active } = raw;
  if (typeof active !== 'number' || !Number.isInteger(active) || active < 0) {
    return { kind: 'invalid', reason: `active 要是 0 以上的整數，收到 ${JSON.stringify(active)}` };
  }
  if (!Array.isArray(raw.events)) return { kind: 'invalid', reason: 'events 不是陣列' };
  const events: ActivityEvent[] = [];
  for (const [index, item] of raw.events.entries()) {
    if (!isRecord(item)) return { kind: 'invalid', reason: `events[${index}] 不是物件` };
    if (typeof item.meetingId !== 'string' || item.meetingId === '') return { kind: 'invalid', reason: `events[${index}].meetingId 不是非空字串` };
    if (item.title !== null && typeof item.title !== 'string') return { kind: 'invalid', reason: `events[${index}].title 不是字串或 null` };
    if (item.kind !== 'done' && item.kind !== 'failed') return { kind: 'invalid', reason: `events[${index}].kind 不是 done 或 failed` };
    if (item.reason !== null && typeof item.reason !== 'string') return { kind: 'invalid', reason: `events[${index}].reason 不是字串或 null` };
    events.push({ meetingId: item.meetingId, title: item.title as string | null, kind: item.kind, reason: item.reason as string | null });
  }
  return { kind: 'ok', message: { active, events } };
}

export interface ShellActivity {
  /** 頁面回報正在錄音 */
  recording: boolean;
  /** server 回報有幾場會議在轉錄、分析或關聯 */
  active: number;
}

export interface QuitState extends ShellActivity {
  /** 裝更新要結束 app：使用者已經在更新的確認框同意結束，處理中那項不再問；錄音中照舊問 */
  ignoreProcessing?: boolean;
}

/** 錄音中或有會議在處理，任一成立就擋閒置睡眠；兩者都不成立才放 */
export function shouldBlockSleep(state: ShellActivity): boolean {
  return state.recording || state.active > 0;
}

export interface QuitPrompt {
  message: string;
  detail: string;
  /** 第一顆是取消（不結束），第二顆是結束 */
  buttons: [string, string];
  /** 使用者確認結束時寫進 log 的前綴 */
  logNote: string;
}

const RECORDING_DETAIL = '結束會中斷錄音。已經送出的部分會留著，下次打開 MeetPilot 可以把它送去轉錄；最後幾秒可能沒送到。';

/** 結束前要不要先問。錄音與處理同時成立只問一次，文案兩件事都講；都不成立回 null，直接結束 */
export function quitPrompt(state: QuitState): QuitPrompt | null {
  const processing = state.active > 0 && !state.ignoreProcessing;
  if (state.recording && processing) {
    return {
      message: `正在錄音，另外還有 ${state.active} 場會議在處理，要結束 MeetPilot 嗎？`,
      detail: `${RECORDING_DETAIL}\n\n處理中的會議也會停下來，下次打開 MeetPilot 會接著跑。`,
      buttons: ['不結束', '結束 MeetPilot'],
      logNote: `錄音中且 ${state.active} 場處理中`,
    };
  }
  if (state.recording) {
    return {
      message: '正在錄音，要結束 MeetPilot 嗎？',
      detail: RECORDING_DETAIL,
      buttons: ['繼續錄音', '結束 MeetPilot'],
      logNote: '錄音中',
    };
  }
  if (processing) {
    return {
      message: `還有 ${state.active} 場會議在處理，要結束 MeetPilot 嗎？`,
      detail: '結束會停下轉錄與分析，下次打開 MeetPilot 會接著跑沒做完的部分。要讓它在背景跑完，請關掉視窗就好，不要按結束。',
      buttons: ['繼續處理', '結束 MeetPilot'],
      logNote: `${state.active} 場處理中`,
    };
  }
  return null;
}

/** 裝更新前的確認框補的一句：處理中的會議不會丟，沒有處理中就不補 */
export function updateInstallNote(active: number): string {
  return active > 0 ? `\n\n現在有 ${active} 場會議還在處理，結束會讓它們停下來，下次打開 MeetPilot 會接著跑。` : '';
}

/** 通知內文最長的原因長度；系統通知會自己截，但超長的 API 錯誤訊息塞進去也看不到重點 */
const REASON_MAX_CHARS = 200;
const UNTITLED = '未命名會議';
const NO_REASON = '沒有記錄失敗原因';

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > REASON_MAX_CHARS ? `${flat.slice(0, REASON_MAX_CHARS)}…` : flat;
}

export interface NotificationText {
  title: string;
  body: string;
}

/** 完成與失敗各一則：失敗一定帶原因（沒有就明說沒有記錄）；完成帶 reason 的是關聯失敗，一併講 */
export function notificationFor(event: ActivityEvent): NotificationText {
  const name = event.title === null || event.title.trim() === '' ? UNTITLED : event.title.trim();
  if (event.kind === 'failed') {
    return { title: '會議處理失敗', body: `${name}\n${event.reason === null || event.reason.trim() === '' ? NO_REASON : clip(event.reason)}` };
  }
  return {
    title: '會議記錄完成',
    body: event.reason === null || event.reason.trim() === '' ? name : `${name}\n${clip(event.reason)}`,
  };
}

/** 開機自動啟動時帶的參數。Windows 靠它判斷；macOS 看系統給的 wasOpenedAtLogin */
export const HIDDEN_LAUNCH_ARG = '--hidden';

/** 要不要登記成開機自動啟動：打包版、已選過資料夾（首次設定前不開）、不是冒煙測試。開發模式不登記，不然會把 electron 本體寫進登入項目 */
export function shouldOpenAtLogin(opts: { vaultDir: string | null; isPackaged: boolean; smoke: boolean }): boolean {
  return opts.isPackaged && !opts.smoke && opts.vaultDir !== null && opts.vaultDir !== '';
}

/** 這次啟動是不是開機自動啟動：是的話不跳主視窗，只留托盤 */
export function startedHidden(opts: { argv: readonly string[]; wasOpenedAtLogin: boolean }): boolean {
  return opts.wasOpenedAtLogin || opts.argv.includes(HIDDEN_LAUNCH_ARG);
}

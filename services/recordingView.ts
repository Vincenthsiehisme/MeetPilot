/**
 * 錄音按鍵與錄音中畫面用的判斷（vault plan「MeetPilot · 網頁錄音」）。
 *
 * 純函式抽出來的理由跟 meetingAdapter.ts、droppedFiles.ts 一樣：App.tsx 沒有元件測試基礎設施，
 * `tsc` 對它也幾乎沒有型別覆蓋（見 AGENTS.md〈gate 守不到哪裡〉），能測的判斷一律放這裡。
 */
import { MeetingView } from './meetingApi';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 錄了多久。一小時以內 `mm:ss`，超過一小時 `h:mm:ss`。
 *
 * now 比 startedAt 早（這台電腦的時鐘比 server 慢）時顯示 00:00，不顯示負數：
 * 開始時間是 server 的 Date.now()，畫面用的是瀏覽器的，同一台機器上兩者一樣，
 * 差出負數只可能是時鐘剛被調過，負的計時沒有任何可以讀的意思
 */
export const formatRecordingElapsed = (startedAt: number, now: number): string => {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
};

/**
 * 錄音按鍵建立的會議要填的「原始檔名」。這時還沒有檔案，但 `POST /api/meetings` 要一個非空的
 * fileName，而清單上在分析出標題之前顯示的就是它，所以寫成人看得懂的「哪一天幾點錄的」
 */
export const recordingMeetingFileName = (at: Date, method: 'voice_memo' | 'in_app'): string =>
  `${method === 'in_app' ? 'MeetPilot 錄音' : '語音備忘錄錄音'} ${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;

/**
 * 現在正在錄的那一場。語音備忘錄一次只錄一支，server 擋掉了第二場，所以最多一場。
 *
 * 真的出現兩場（資料庫被別的東西改過）時拋錯，不挑第一場：停止按鍵停的是語音備忘錄那一支，
 * 挑錯場的話取回的錄音會被收進另一場會議，而畫面上看起來一切正常
 */
export const findRecordingMeeting = (meetings: MeetingView[] | null): MeetingView | null => {
  if (meetings === null) return null;
  const recording = meetings.filter(m => m.status === 'RECORDING');
  if (recording.length > 1) {
    throw new Error(`同時有 ${recording.length} 場會在錄音（${recording.map(m => m.meeting_id).join('、')}），一次只能錄一場`);
  }
  return recording[0] ?? null;
};

export type StartFailureAction =
  | { kind: 'delete' }
  | { kind: 'keep-recording' }
  | { kind: 'keep-unknown'; reason: string };

/**
 * 「開始錄音」請求失敗之後，剛建立的那場會要不要刪（2026-09-23 Codex review 抓到）。
 *
 * 不能看到失敗就刪：失敗不代表語音備忘錄沒開始錄。捷徑成功了但回應在路上丟了、或 server 叫完
 * 語音備忘錄之後組回應時拋錯（回 500），這場會其實已經是 RECORDING，而刪除錄音中的會會先叫
 * 語音備忘錄停止——一次暫時性的回應失敗就把一支正在錄的錄音切掉，畫面上還說「沒有開始錄音」。
 *
 * 所以呼叫端要先重讀這場會，照 server 當下的狀態決定：
 * - CREATED 而且沒有音檔：確定沒在錄（server 開始失敗時會退回這裡），刪掉不留空會議
 * - RECORDING：其實在錄，留著，讓使用者照常按停止
 * - 讀不到或其他狀態：不知道發生什麼事，不刪，照實講
 */
export const decideAfterStartFailure = (meeting: MeetingView | null, readError: string | null): StartFailureAction => {
  if (meeting === null) {
    return { kind: 'keep-unknown', reason: `讀不到這場會現在的狀態（${readError ?? '沒有回應'}），為了不切掉可能已經開始的錄音，沒有刪除它` };
  }
  if (meeting.status === 'RECORDING') return { kind: 'keep-recording' };
  if (meeting.status === 'CREATED' && !meeting.has_audio) return { kind: 'delete' };
  return { kind: 'keep-unknown', reason: `這場會現在是 ${meeting.status}，不是預期的狀態，沒有刪除它` };
};

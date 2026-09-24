/**
 * 刪除會議與人工編輯（W2 T1 返工）。
 *
 * 為什麼不直接寫在 server.ts 的路由裡：這三條的規則幾乎都在錯誤路徑上——哪些狀態不准刪、
 * 哪些輸入算空、「沒給欄位」與「給了 null」差在哪。路由函式綁著 express 的 req/res 測不動，
 * 而這些規則正是最需要有一條會紅的測試盯著的部分。所以這裡回傳 { status, body }，
 * 路由只負責 `res.status(r.status).json(r.body)`。
 *
 * 這些操作都不改 Meeting 的 status，只動內容與 updated_at。
 */
import { TranscriptSegment } from '../types';
import { AnalysisV3, isAnalysisV3SemanticallyEmpty } from './analysisContract';
import { AudioFileStore } from './audioFileStore';
import { BUSY_STATUSES } from './meetingApi';
import { MeetingStatus } from './meetingState';
import { MeetingStore, TranscriptPatch } from './meetingStore';
import { checkMeetingTitle } from './meetingTitle';

export interface EditOutcome {
  status: number;
  body: unknown;
}

const fail = (status: number, error: string): EditOutcome => ({ status, body: { error } });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 正在跑的會一律不准從外面寫（刪除與兩條 PATCH 共用同一條規則，常數來自契約檔 meetingApi.ts）。
 *
 * 刪除：pipeline 手上還握著這場會的狀態與音檔路徑，刪到一半它下一次寫入會撞上
 * 「找不到 Meeting」，那個錯誤會被記成轉錄失敗，看起來像模型出問題。
 *
 * 編輯：pipeline 在迴圈外讀一份逐字稿快照，每轉完一片就把快照加新片寫回去，所以轉錄途中
 * 存進來的潤稿或人工修正會在下一片被蓋掉，而當下回的是 200——使用者看到「已儲存」然後內容消失。
 * 不改成「每片寫回前重讀再合併」是因為那會讓人以為轉錄中編輯是受支援的，
 * 但講者分段仍然可能被後續片段影響。
 *
 * 明寫轉型是因為 tsconfig 沒開 strict，唯讀字面值元組跟 MeetingStatus 收斂不到一起。
 */
export const isBusy = (status: MeetingStatus): boolean =>
  (BUSY_STATUSES as readonly string[]).includes(status);

const busyError = (meetingId: string, status: MeetingStatus, advice: string): EditOutcome =>
  fail(409, `Meeting ${meetingId} 目前是 ${status}，這場正在處理，${advice}`);

export function deleteMeetingRequest(
  deps: {
    store: MeetingStore;
    audioStore: AudioFileStore;
    queue?: { cancel(meetingId: string): boolean };
    /** 正在上傳中的會（createApp 的 in-flight 集合）。Set 就符合這個形狀 */
    uploading?: { has(meetingId: string): boolean };
  },
  meetingId: string,
): EditOutcome {
  const meeting = deps.store.getMeeting(meetingId);
  if (!meeting) return fail(404, `找不到 Meeting ${meetingId}`);
  if (isBusy(meeting.status)) return busyError(meetingId, meeting.status, '等它結束或失敗之後再刪');
  // 上傳期間狀態還是 CREATED，BUSY 那條擋不到。這時刪掉的後果是孤兒檔：
  // remove() 刪的是最終檔名，而檔案當下還叫 .part 刪不到；上傳完成後 rename 把它變成最終檔名，
  // 那個檔就再也沒有任何路徑會清它（removePartialUploads 只看 .part，續傳掃描只走 Meeting 列表），
  // 一場 100 分鐘的會就是幾百 MB，事後還看不出它屬於誰
  if (deps.uploading?.has(meetingId)) {
    return fail(
      409,
      `Meeting ${meetingId} 的音檔正在上傳，這場正在處理，等它結束或失敗之後再刪`,
    );
  }

  // 先刪音檔再刪紀錄：刪檔失敗時 Meeting 還在，使用者可以再刪一次。
  // 反過來的話紀錄已經沒了，留下的音檔再也沒有人找得到它屬於哪一場會。
  // 檔案本來就不在不算錯（分析成功後就會刪掉），但刪不掉要往上拋，不吞。
  // 先把還在排隊的那筆抽掉。狀態是 CREATED 但已經排在佇列裡的會走得到這裡
  // （retry 之後佇列正忙就是這個狀態），不取消的話等一下會印一行看起來像故障的 log
  deps.queue?.cancel(meetingId);
  deps.audioStore.remove(meetingId);
  // app 內錄音錄到一半的段落（E4）。它不叫 `.part`，啟動清理不會碰它，這裡不刪就一直佔著空間
  deps.audioStore.removeRecording(meetingId);
  deps.store.deleteMeeting(meetingId);
  return { status: 200, body: { deleted: true, meetingId } };
}

// 逐字稿的形狀在寫入前驗，規則與 jobMigration 的 isTranscriptSegment 一致。
// 不驗的話任何 JSON 都存得進去，壞掉的地方會落在之後的匯出或合併，那時已經看不出是誰寫進來的
const isTranscriptSegment = (v: unknown): v is TranscriptSegment =>
  isObject(v)
  && typeof v.start === 'number'
  && typeof v.end === 'number'
  && typeof v.text === 'string';

export function patchTranscriptRequest(
  deps: { store: MeetingStore },
  meetingId: string,
  body: unknown,
  updatedAt: number,
): EditOutcome {
  const payload = isObject(body) ? body : {};
  const hasSegments = 'segments' in payload;
  const hasPolished = 'polished_content' in payload;
  if (!hasSegments && !hasPolished) {
    return fail(400, 'segments 與 polished_content 至少要給一個');
  }

  const patch: TranscriptPatch = {};
  if (hasSegments) {
    const segments = payload.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return fail(400, 'segments 必須是非空陣列');
    }
    if (!segments.every(isTranscriptSegment)) {
      return fail(400, 'segments 的每一段都要有數字的 start、end 與字串的 text');
    }
    patch.segments = segments;
  }
  if (hasPolished) {
    const polished = payload.polished_content;
    if (polished !== null && typeof polished !== 'string') {
      return fail(400, 'polished_content 必須是字串，或用 null 清掉');
    }
    // 明確給 null 要保留成 null 傳下去，這是「清掉潤稿」，不是「沒給」。
    // 明寫轉型是因為 tsconfig 沒開 strict，上面那個 typeof 守衛收斂不到 string | null
    patch.polished_content = polished as string | null;
  }

  const meeting = deps.store.getMeeting(meetingId);
  if (!meeting) return fail(404, `找不到 Meeting ${meetingId}`);
  if (isBusy(meeting.status)) return busyError(meetingId, meeting.status, '等它跑完再編輯');
  // FAILED 目前只會是轉錄本身沒有完成（見 transcriptionPipeline.ts 的 runTranscriptionPhase／
  // markFailed；分析失敗會退回 TRANSCRIBED，不會到這裡）。這種情況下 raw 可能只是部分逐字稿，
  // 編輯它會落地一筆 transcript_edits；retry 續傳完成後新轉出來的內容接在 raw 後面，但
  // getCurrentTranscript 永遠整份拿最新那筆編輯蓋過 raw，續傳補上的尾巴就會悄悄消失
  // （Codex adversarial review 抓到）。擋在這裡：轉錄真的完成、到 TRANSCRIBED 之後才能編輯。
  if (meeting.status === 'FAILED') {
    return fail(
      409,
      `Meeting ${meetingId} 轉錄失敗尚未完成（可能只有部分逐字稿），重跑轉錄到 TRANSCRIBED 之後才能編輯`,
    );
  }
  if (!deps.store.getTranscript(meetingId)) {
    return fail(404, `Meeting ${meetingId} 還沒有逐字稿，轉錄完成後才能編輯`);
  }

  return { status: 200, body: { transcript: deps.store.updateTranscript(meetingId, patch, updatedAt) } };
}

/**
 * `evidence` 是 null（v2 升上來的舊資料）或 `{ start, end }` 兩個有限數字且 `start <= end`。
 * 只驗「是不是物件」不夠：`{ start: '0' }` 這種型別錯的值會原樣落地，之後拿它算秒數會
 * 直接是 NaN，而那時已經看不出來是哪一次編輯寫進去的。
 */
const isEvidence = (v: unknown): boolean =>
  v === null
  || (
    isObject(v)
    && typeof v.start === 'number' && Number.isFinite(v.start)
    && typeof v.end === 'number' && Number.isFinite(v.end)
    && v.start <= v.end
  );

// decided_by_employee_id／assignee_employee_id（人名校正 N4，C-ANALYSIS v3→v4）是選填欄位，
// 不驗的話任意型別（數字、物件）都能原樣存進 JSON blob，下游把它當員編用時才會炸
// （Codex review 2026-09-21 抓到）。這裡只驗型別，不驗員編存不存在或跟 decided_by／assignee
// 是否一致——那需要 peopleStore 才能查，是 N5 人工確認流程的責任，不在這支路由的範圍
const isEmployeeIdField = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string';

const isDecisionV3 = (v: unknown): boolean =>
  isObject(v)
  && typeof v.text === 'string'
  && isEvidence(v.evidence)
  && (v.decided_by === null || typeof v.decided_by === 'string')
  && isEmployeeIdField(v.decided_by_employee_id);

/**
 * action_items 的每一筆都要完整驗。
 *
 * 只驗 text 的話，`created_at: "不是數字"`、`status: "完成了嗎"` 會原樣落地而且回 200，
 * 之後任何把 created_at 當數字排序、把 status 當三值列舉的程式（W3 的跨會議待辦）
 * 會在讀取端拿到字串，而那時已經看不出是哪一次編輯寫進去的。
 * assignee、due 在 v3 明寫成 `string | null`（不是 optional），U-007 仍未關閉。
 */
const isActionItemV3 = (v: unknown): boolean =>
  isObject(v)
  && typeof v.text === 'string'
  && typeof v.source_meeting_id === 'string'
  && typeof v.created_at === 'number'
  && Number.isFinite(v.created_at)
  && (v.status === 'unknown' || v.status === 'open' || v.status === 'done')
  && (v.assignee === null || typeof v.assignee === 'string')
  && (v.due === null || typeof v.due === 'string')
  && isEvidence(v.evidence)
  && isEmployeeIdField(v.assignee_employee_id);

const isOpenQuestionV3 = (v: unknown): boolean =>
  isObject(v)
  && typeof v.text === 'string'
  && isEvidence(v.evidence);

// contract_version 之外的欄位也要驗：少驗一個，isAnalysisV3SemanticallyEmpty 會在
// 非字串的 overview 上炸成 500，使用者看到的是「伺服器錯誤」而不是「你送的東西不對」
const isAnalysisV3Shape = (v: unknown): v is AnalysisV3 =>
  isObject(v)
  && v.contract_version === 3
  && typeof v.overview === 'string'
  && Array.isArray(v.topics)
  && v.topics.every(t => isObject(t) && typeof t.title === 'string' && typeof t.content === 'string'
    // points 選填（SDD v0.9 加的欄位，舊資料沒有）；有的話每點要字串 text 與合法的 evidence
    && (t.points === undefined
      || (Array.isArray(t.points) && t.points.every(pt => isObject(pt) && typeof pt.text === 'string' && isEvidence(pt.evidence)))))
  && Array.isArray(v.decisions)
  && v.decisions.every(isDecisionV3)
  && Array.isArray(v.action_items)
  && v.action_items.every(isActionItemV3)
  && Array.isArray(v.open_questions)
  && v.open_questions.every(isOpenQuestionV3);

export function patchAnalysisRequest(
  deps: { store: MeetingStore },
  meetingId: string,
  body: unknown,
  updatedAt: number,
): EditOutcome {
  const analysis = isObject(body) ? body.analysis : undefined;
  if (!isObject(analysis)) return fail(400, 'analysis 必須是物件');
  if (analysis.contract_version !== 3) {
    return fail(400, `analysis 的 contract_version 必須是 3，收到 ${JSON.stringify(analysis.contract_version)}`);
  }
  if (!isAnalysisV3Shape(analysis)) {
    return fail(
      400,
      'analysis 的欄位形狀不是 C-ANALYSIS v3：overview 要字串，topics/decisions/action_items/'
      + 'open_questions 要陣列，topics 的 points（有的話）與 decisions、action_items、open_questions 每筆的 evidence 要是 '
      + 'null 或 { start, end }（start <= end），action_items 的 status 是 unknown / open / done 其中之一',
    );
  }
  if (isAnalysisV3SemanticallyEmpty(analysis)) {
    // 與 saveAnalysis 同一條標準：五個欄位全空卻存成成功，畫面上跟「這場會沒什麼結論」長得一樣
    return fail(400, 'analysis 五個欄位都是空的，不寫入');
  }

  const meeting = deps.store.getMeeting(meetingId);
  if (!meeting) return fail(404, `找不到 Meeting ${meetingId}`);
  if (isBusy(meeting.status)) return busyError(meetingId, meeting.status, '等它跑完再編輯');
  if (!deps.store.getAnalysis(meetingId)) {
    return fail(404, `Meeting ${meetingId} 還沒有分析結果，分析完成後才能編輯`);
  }

  deps.store.replaceAnalysis(meetingId, analysis, updatedAt);
  return { status: 200, body: { analysis } };
}

/**
 * 改標題。規則在 meetingTitle.ts，跟 pipeline 填建議標題用同一支檢查。
 * 分析中回 409 的理由跟另外兩條 PATCH 不同：pipeline 在分析結尾才判「標題還是 null 就填建議」，
 * 這時放行寫入，剛存的標題會被那個過期的判斷蓋掉，而回應是 200。
 */
export function patchTitleRequest(
  deps: { store: MeetingStore },
  meetingId: string,
  body: unknown,
  updatedAt: number,
): EditOutcome {
  const check = checkMeetingTitle(isObject(body) ? body.title : undefined);
  if (check.ok === false) return fail(400, check.reason);

  const meeting = deps.store.getMeeting(meetingId);
  if (!meeting) return fail(404, `找不到 Meeting ${meetingId}`);
  if (isBusy(meeting.status)) return busyError(meetingId, meeting.status, '等它跑完再改標題');

  deps.store.setTitle(meetingId, check.title, updatedAt);
  return { status: 200, body: { title: check.title } };
}

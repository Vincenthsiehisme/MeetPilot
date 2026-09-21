/**
 * 前端打 Meeting API 的唯一出口（W2 T2）。
 *
 * 型別一律吃 `meetingApi.ts`，這裡不自己再寫一份：兩邊各寫一份的話，對不上的那一刻
 * 不會有任何錯誤，只會在執行時變成「欄位是 undefined」。
 *
 * 這裡沒有 `withRetry`：音檔上傳失敗要讓使用者自己決定重送，自動重試一個 100 分鐘的檔
 * 等於把剛解掉的記憶體與頻寬問題再做一次；進度查詢本來就在 polling，下一拍自然會再試。
 */
import { AnalysisV3 } from './analysisContract';
import { errorFromResponse } from './httpResponse';
import {
  AUDIO_CONTENT_TYPE,
  CreateMeetingRequest,
  DeleteMeetingResponse,
  ImportRequest,
  ImportResponse,
  MeetingDetailResponse,
  MeetingListResponse,
  MeetingResponse,
  MeetingView,
  PatchAnalysisResponse,
  PatchTranscriptRequest,
  PatchTranscriptResponse,
} from './meetingApi';

async function requestJson<T>(endpoint: string, init: RequestInit): Promise<T> {
  const response = await fetch(endpoint, init);
  const text = await response.text();

  if (!response.ok) {
    throw errorFromResponse(response, text);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
    throw new Error('伺服器回傳了網頁內容 (HTML)，可能是連線短暫中斷或服務正在重啟，請稍候重試。');
  }

  try {
    return JSON.parse(text) as T;
  } catch (parseErr: any) {
    throw new Error(`回應格式解析錯誤: ${parseErr.message}`);
  }
}

const meetingPath = (meetingId: string, suffix = ''): string =>
  `/api/meetings/${encodeURIComponent(meetingId)}${suffix}`;

export const createMeeting = async (request: CreateMeetingRequest): Promise<MeetingView> => {
  const data = await requestJson<MeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return data.meeting;
};

/**
 * 音檔本體直接當 body 送上去。
 *
 * 不包成 JSON、不做 base64：base64 會把整個檔案先變成一條字串留在分頁記憶體裡，還膨脹 33%，
 * 106 分鐘的會就是這樣把分頁弄崩的。這條路徑在 server 那頭不經 body parser，body 直接 pipe 進檔案。
 */
export const uploadAudio = async (meetingId: string, file: File): Promise<MeetingView> => {
  const data = await requestJson<MeetingResponse>(meetingPath(meetingId, '/audio'), {
    method: 'PUT',
    headers: { 'Content-Type': AUDIO_CONTENT_TYPE },
    body: file,
  });
  return data.meeting;
};

export const listMeetings = async (): Promise<MeetingView[]> => {
  const data = await requestJson<MeetingListResponse>('/api/meetings', { method: 'GET' });
  return data.meetings;
};

export const getMeetingDetail = (meetingId: string): Promise<MeetingDetailResponse> =>
  requestJson<MeetingDetailResponse>(meetingPath(meetingId), { method: 'GET' });

export const retryMeeting = async (meetingId: string): Promise<MeetingView> => {
  const data = await requestJson<MeetingResponse>(meetingPath(meetingId, '/retry'), { method: 'POST' });
  return data.meeting;
};

/** 把 IndexedDB 裡的舊紀錄送上去（W1 既有的搬遷端點）。音檔不搬，回應會說哪幾場的音檔還留在瀏覽器 */
export const importLegacyJobs = (request: ImportRequest): Promise<ImportResponse> =>
  requestJson<ImportResponse>('/api/meetings/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

/**
 * 刪除一場會議。
 *
 * 正在跑的會議（TRANSCRIBING / ANALYZING / LINKING）server 會回 409，訊息會說要等它結束或失敗。
 * 呼叫端要把那句話原樣顯示：翻成「刪除失敗」會把「為什麼不能刪、什麼時候可以刪」整個蓋掉。
 */
export const deleteMeeting = (meetingId: string): Promise<DeleteMeetingResponse> =>
  requestJson<DeleteMeetingResponse>(meetingPath(meetingId), { method: 'DELETE' });

/** 只送要改的欄位。兩個欄位都不給 server 會回 400，所以呼叫端不要送空物件充數 */
export const patchTranscript = async (
  meetingId: string,
  request: PatchTranscriptRequest
): Promise<PatchTranscriptResponse['transcript']> => {
  const data = await requestJson<PatchTranscriptResponse>(meetingPath(meetingId, '/transcript'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return data.transcript;
};

/** 整份覆寫。contract_version 不是 2 或四欄全空時 server 回 400 */
export const patchAnalysis = async (meetingId: string, analysis: AnalysisV3): Promise<AnalysisV3> => {
  const data = await requestJson<PatchAnalysisResponse>(meetingPath(meetingId, '/analysis'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis }),
  });
  return data.analysis;
};

/**
 * 送出音檔。
 *
 * `target` 是 null 就是新的一場會（建立再上傳）；給了 meetingId 就只補送音檔給那一場。
 *
 * 分開這兩條是因為上傳失敗的復原：`POST` 成功、`PUT` 失敗時 server 已經留下一筆 CREATED 的會，
 * 這時再選一次檔如果又走 `POST`，列表就會每失敗一次多一筆殭屍會議，而舊的那筆永遠沒人補音檔。
 * 對 CREATED 重送 `PUT` 多半是合法的，server 會把片段計數歸零、清掉舊逐字稿**與舊分析**，從頭跑。
 * 例外是那場會已經在佇列裡排隊（retry 之後還沒輪到它），那時回 409 —— 它的音檔還在 server 上，
 * 換掉會讓 pipeline 前半讀舊檔、後半讀新檔。
 *
 * onCreated 在「建立成功、還沒開始上傳」時呼叫：上傳是整條裡最久的一段，呼叫端要在這個時間點
 * 就把那場會放進畫面，失敗時使用者才找得到它去補音檔。
 */
export const submitAudio = async (
  file: File,
  target: { meetingId: string } | null,
  onCreated?: (meeting: MeetingView) => void
): Promise<MeetingView> => {
  if (target !== null) return uploadAudio(target.meetingId, file);

  const created = await createMeeting({ fileName: file.name, fileSize: file.size });
  if (onCreated) onCreated(created);
  return uploadAudio(created.meeting_id, file);
};

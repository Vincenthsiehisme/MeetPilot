/**
 * 前端與 server 之間的 HTTP 契約（W2）。
 *
 * 這個檔由 coordinator 擁有，T1 與 T2 只讀不改：兩邊各自寫一份型別的話，
 * 對不上的那一刻不會有任何錯誤，只會在執行時變成「欄位是 undefined」。
 *
 * 只放型別與常數，不放任何實作，也不 import 任何帶 node 依賴的模組
 * （`meetingStore.ts` 會把 `node:sqlite` 帶進前端 bundle，所以逐字稿的形狀在這裡自己寫一份）。
 */
import { Job, Meeting, TranscriptSegment } from '../types';
import { AnalysisV3 } from './analysisContract';
import { TopicTag } from './topicTag';
import { LinkRun, TopicLink } from './topicLink';

/** 音檔上傳的 Content-Type。刻意不是 JSON：這條路徑不經 body parser，body 直接 pipe 進檔案 */
export const AUDIO_CONTENT_TYPE = 'application/octet-stream';

/**
 * 前端 polling 的間隔。
 *
 * **每一拍會打兩支 API**（清單一次、開著的那場詳情一次），3 秒一拍就是 40 次/分鐘，
 * 而 `/api` 的限流預設是每分鐘 60 次、同一個 IP 共用一個桶。所以開第二個分頁看同一台 server
 * 就會撞 429。這個數字不是「還很寬鬆」，是「只剩一個分頁的餘裕」，要加 polling 對象之前先算。
 */
export const MEETING_POLL_INTERVAL_MS = 3000;

/** `POST /api/meetings` */
export interface CreateMeetingRequest {
  fileName: string;
  fileSize: number;
  title?: string;
  meetingContext?: string;
  tags?: string[];
  /** 這場會的與會者員編，至少一個（人名校正 N2，SDD D-016）。server 沒收到會拒絕建立 */
  participantIds: string[];
}

/** `GET /api/people` 的一列，只給前端選取用，不含 email／active（人名校正 N2） */
export interface PersonSummary {
  employeeId: string;
  displayName: string;
  title: string | null;
  department: string | null;
  /** 匯入或人工確認的別名（含英文名），只給搜尋比對用，不在畫面上顯示 */
  aliases: string[];
}

export interface PeopleListResponse {
  people: PersonSummary[];
}

/**
 * API 回出去的 Meeting。
 *
 * `Meeting` 是資料庫那一列的形狀，`has_audio` 不在裡面——它是 server 當下去看檔案系統的結果
 * （`audioStore.exists`），不是欄位。分開兩個型別是刻意的：把它塞進 `Meeting` 會讓從資料庫
 * 讀出來的物件型別上宣稱有這個欄位、實際上沒有。
 *
 * **為什麼前端非要它不可**：`CREATED` 現在是兩種完全不同的處境合用一個狀態——
 * 「建立了還沒上傳，等使用者給音檔」與「retry 之後在佇列裡排隊，音檔好好地在 server 上」。
 * 光看狀態分不出來，而兩者要做的事相反：前者要顯示上傳入口、不該 polling、該能被批次清除；
 * 後者正在跑，顯示上傳入口是假話（照做會把 retry 刻意保留的逐字稿與游標刪掉）。
 */
export interface MeetingView extends Meeting {
  /** server 端這場會的音檔現在在不在。`CREATED` 的兩種處境靠它分開 */
  has_audio: boolean;
  /**
   * 語音備忘錄開始錄的時間（epoch ms）。只有 `RECORDING` 時有值，其餘一律 null。
   * 畫面上的錄音計時靠它：錄音不因分頁關掉而中斷，重開頁面時計時要從 server 接回來，
   * 不能從「這個分頁按下開始的那一刻」算（vault plan「MeetPilot · 網頁錄音」AC-4）
   */
  recording_started_at: number | null;
  /** 這場錄音是誰在錄。只有 `RECORDING` 時有值：畫面要靠它決定停止按鍵做什麼、中斷了能不能救 */
  recording_method: RecordingMethod | null;
  /**
   * app 內錄音已經確定收到的段數（E4）。只有 `RECORDING` 且 `in_app` 時有值。
   * app 關掉或當掉之後重開，畫面靠它講「已經收到多少」，讓使用者決定要不要送出已錄的部分
   */
  recording_received_chunks: number | null;
}

/**
 * 錄音是誰在錄。`voice_memo` 是網頁版叫本機語音備忘錄（vault plan「MeetPilot · 網頁錄音」），
 * `in_app` 是桌面 app 自己用麥克風錄、分段送上來（vault plan「MeetPilot · 跨平台打包部署」E4）。
 * 一台 server 只提供一種（`MEETPILOT_RECORDER`），已經在錄的那一場照它開始時的方式收尾
 */
export type RecordingMethod = 'voice_memo' | 'in_app';

/**
 * `GET /api/recording/availability`。這台 server 能不能錄音、用哪一種方式。
 *
 * 不能的時候一定帶原因：錄音按鍵要嘛不出現、要嘛講清楚為什麼不能按（AC-5），
 * 不讓使用者按下去才失敗。原因只有 server 知道（平台、三個捷徑在不在、請求是不是從本機來）。
 * `in_app` 的「麥克風能不能用」server 不知道，由前端開始錄之前自己問瀏覽器。
 */
export type RecordingAvailabilityResponse =
  | { available: true; method: RecordingMethod }
  | { available: false; reason: string };

/**
 * app 內錄音每一段多長（毫秒），也是 app 當掉時最多丟掉的長度（還沒送出去的那一段）。
 * 10 秒是我判的（E4 裁定）：再短，每分鐘的請求數會吃掉更多限流額度；再長，當掉時丟得更多
 */
export const RECORDING_CHUNK_MS = 10_000;

/** `PUT /api/meetings/:id/recording/chunks/:seq` 的一段最多幾 bytes。10 秒 64 kbps 約 80 KB，給兩個數量級的餘裕 */
export const RECORDING_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

/** `PUT /api/meetings/:id/recording/chunks/:seq` 200：server 目前確定收到的進度 */
export interface RecordingChunkResponse {
  received_chunks: number;
  received_bytes: number;
}

/**
 * `POST /api/meetings/:id/recording/stop` 的 body，只有 app 內錄音要帶（語音備忘錄不帶）。
 * - `{ chunks: N }`：正常停止，前端一共錄了 N 段、都送到了。server 收到的不是 N 段就拒絕，不把缺段的檔送去轉錄
 * - `{ partial: true }`：app 關掉或當掉後救回來，錄音已經中斷，收到幾段就送幾段
 * 兩個都沒帶一律拒絕：分不出是哪一種的話，前端漏帶段數就會安靜地變成「收到幾段算幾段」
 */
export type StopInAppRecordingRequest = { chunks: number } | { partial: true };

/**
 * `POST /api/meetings` 201、`PUT /api/meetings/:id/audio` 202、`POST /api/meetings/:id/retry` 202、
 * `POST /api/meetings/:id/recording/start` 200、`POST /api/meetings/:id/recording/stop` 202
 */
export interface MeetingResponse {
  meeting: MeetingView;
}

/** `GET /api/meetings` */
export interface MeetingListResponse {
  meetings: MeetingView[];
}

/**
 * 一場會裡待確認的人名比對結果（人名校正 N4／N5，SDD 1.3.2 第 2、3 層）。
 *
 * 這是 `services/nameResolver.ts` 的 `NameMention` 的前端安全版本，故意不 import 那個檔案：
 * 它有 `node:sqlite` 依賴，跟 `meetingStore.ts` 同一個理由不能進前端 bundle（見檔頭）。
 * 只回 `needs_review` 的兩種（`short_alias_review`／`conflict_review`），確認粒度是段落＋字串。
 */
export interface NameMentionView {
  segment_index: number;
  /** 該筆提及所在的完整逐字稿段落，讓使用者能分辨同名者 */
  segment_text: string;
  original_text: string;
  /** `short_alias_review` 時是那個唯一候選；`conflict_review` 時是 null，不猜 */
  employee_id: string | null;
  method: 'short_alias_review' | 'conflict_review';
}

/** `POST /api/meetings/:id/name-mentions/confirm`。人一鍵確認 needs_review 的人名（N5） */
export interface ConfirmNameMentionRequest {
  segment_index: number;
  original_text: string;
  employee_id: string;
}

export interface ConfirmNameMentionResponse {
  /** 確認後這場會剩下的 needs_review 名單（已排除剛確認的那一筆） */
  nameMentions: NameMentionView[];
}

/** `GET /api/meetings/:id`。transcript 與 analysis 還沒產出時是 null，不是空物件 */
export interface MeetingDetailResponse {
  meeting: MeetingView;
  transcript: { segments: TranscriptSegment[]; polished_content: string | null } | null;
  analysis: AnalysisV3 | null;
  /** 這場會的與會者員編（人名校正 N2 必填，N5 的人名確認只能從這裡面選人） */
  participantIds: string[];
  /** 還沒確認的人名比對結果（人名校正 N4／N5）。沒有 nameResolver 或還沒轉錄完成時是空陣列 */
  nameMentions: NameMentionView[];
  /** 使用者建立會議時自己打的會議標籤（`meeting_tags`），只當 prompt 背景 */
  tags: string[];
  /**
   * 模型抽出來、要拿去跨會議比對的題目標籤（W3 的 `topic_tags`）。
   *
   * **跟上面的 `tags` 是兩件事，不要合併顯示**：那是人打的會議標籤，這是模型抽的題目，
   * 而人工優先規則只套用在這一組。沒有標籤時是空陣列；「還沒抽過」與「抽過但一條都沒有」
   * 要看 `meeting.topic_extraction_status`（null 是還沒抽過）
   */
  topicTags: TopicTag[];
  /**
   * 每個切片接縫的對齊結果（W2-2）。單片的會、還沒開始轉的會是 null。
   * 裡面有 `verdict: 'gap'` 的項目代表這份逐字稿在那個接縫確實缺了一段內容
   */
  seamReport: SeamReportEntry[] | null;
  /**
   * 跟這場會判定為同題目的歷史會議（W4 的 `topic_links`）。
   *
   * **空陣列不等於「沒有相關會議」**，要配 `meeting.status` 一起讀（SDD 1.3.1 三種狀態必須分得開）：
   * `LINKED` ＋ 空陣列是「算過了，沒有同題目的會」；`READY` 或 `LINKING` 是「還沒算完」；
   * `LINK_FAILED` 是「算壞了」，原因在 `meeting.error`。三者寫成同一句話正是 2.3 列的
   * 「不會有人發現的壞法」
   */
  links: TopicLink[];
  /**
   * 最近一次關聯計算的覆蓋率（W4）。沒算過是 null。
   *
   * `judged` 小於 `candidates` 是常態（候選有上限），所以要看得出剩下的是被上限丟的、
   * 被人排除的、還是撞到額度沒判的——三個數字分開記就是為了這個
   */
  linkRun: LinkRun | null;
}

/** `POST /api/meetings/:id/link` 200。重算這場會的關聯 */
export interface LinkRecomputeResponse {
  meeting: MeetingView;
  links: TopicLink[];
  linkRun: LinkRun | null;
}

/**
 * 處理中的狀態。這幾個狀態下 server 自己正在寫這場會的資料，所以外面的寫入一律擋掉。
 *
 * 不擋的後果不是衝突而是**安靜消失**：pipeline 在迴圈外讀一份逐字稿快照，每轉完一片就把
 * 那份快照加上新片寫回去，所以轉錄途中存進來的潤稿或人工修正會在下一片寫回時被蓋掉，
 * 而 server 那一刻回的是 200。使用者看到「已儲存」，然後內容自己不見。
 */
export const BUSY_STATUSES = ['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const;

/**
 * `PATCH /api/meetings/:id/transcript`
 *
 * 兩個欄位都是選填，只更新有給的那些。`polished_content: null` 是「把潤稿清掉」，
 * 跟「沒給這個欄位」是兩件事：JSON 裡它們長得不一樣，用 `?? 原值` 把兩者併掉
 * 會讓「清除潤稿」這個動作安靜失效。
 *
 * 狀態在 `BUSY_STATUSES` 裡時回 **409**，理由見那個常數。`PATCH .../analysis` 同。
 */
export interface PatchTranscriptRequest {
  segments?: TranscriptSegment[];
  polished_content?: string | null;
}

export interface PatchTranscriptResponse {
  transcript: { segments: TranscriptSegment[]; polished_content: string | null };
}

/** `PATCH /api/meetings/:id/analysis`。整份覆寫，前端送的是編輯後的完整 v2 */
export interface PatchAnalysisRequest {
  analysis: AnalysisV3;
}

export interface PatchAnalysisResponse {
  analysis: AnalysisV3;
}

/**
 * `PATCH /api/meetings/:id/title`
 *
 * 標題的規則在 `services/meetingTitle.ts`（trim 後非空、最多 100 字、不含控制字元），server 與前端共用
 * 同一支檢查。分析中（`BUSY_STATUSES`）回 **409**：pipeline 在分析結尾才判「標題還是 null 就填建議」，
 * 分析中放行寫入會讓剛存的標題被那個判斷蓋掉。下載檔名與畫面上的名字都用這個欄位。
 */
export interface PatchTitleRequest {
  title: string;
}

export interface PatchTitleResponse {
  title: string;
}

/**
 * `DELETE /api/meetings/:id`
 *
 * 正在跑的（`TRANSCRIBING` / `ANALYZING` / `LINKING`）回 409 而不是排隊刪除：
 * 序列佇列一次只跑一場，等它結束是有限的等待，而「刪到一半被 pipeline 寫回去」
 * 沒有任何症狀，事後也看不出來發生過。
 */
export interface DeleteMeetingResponse {
  deleted: true;
  meetingId: string;
}

/**
 * 一個切片接縫的對齊結果（W2-2）。`GET /api/meetings/:id` 會帶整份。
 *
 * `verdict` 是 `gap` 代表**第 sliceIndex 片與前一片之間有內容沒有人轉到**——
 * 不是警告，是這份逐字稿確實缺了一段。實測一場 65 分鐘的會六個接縫中有兩個是這種。
 */
export interface SeamReportEntry {
  /** 這一片接在前一片後面。第 0 片沒有接縫，不會出現在報告裡 */
  sliceIndex: number;
  verdict: 'duplicate' | 'gap' | 'inconclusive';
  similarity: number;
  /** 判定為重複而丟掉的段數 */
  droppedSegments: number;
  /**
   * 破洞修復的結果（W2-2b）。只有 `verdict` 是 `gap` 的接縫才有。
   *
   * `repaired` 代表補回來了，`failed` 代表**試過但補不回來，那一段內容確實不在逐字稿裡**，
   * `skipped` 代表沒試（關掉了、或這場會的修復額度用完了）。
   * 三者不可混為一談：`failed` 是已知的缺口，`skipped` 是還不知道有沒有缺口
   */
  repair?: {
    outcome: 'repaired' | 'failed' | 'skipped';
    /** 實際送出去的轉錄次數 */
    attempts: number;
    /** 成功時用的橋接窗長度（秒） */
    bridgeSeconds?: number;
  };
}

/** `POST /api/meetings/import`（W1 既有） */
export interface ImportRequest {
  jobs: Job[];
  blobIds: string[];
}

/** 音檔留在瀏覽器的那幾筆屬於哪一群。rejected 那群最要緊，那正是之後要重跑的 */
export type AudioResidencyGroup = 'imported' | 'skippedExisting' | 'rejected' | 'orphan';

export interface ImportResponse {
  imported: string[];
  skippedExisting: string[];
  rejected: { jobId: string | null; reason: string }[];
  notes: { jobId: string; note: string }[];
  audioStillInBrowser: { meetingId: string; group: AudioResidencyGroup }[];
}

/**
 * `PUT /api/meetings/:id/audio` 兩種 409 的訊息正本。
 *
 * server 與前端共用同一份字面值。server 發、前端認：這兩種 409 的共同點是**音檔已經在
 * server 上或正在進去的路上**，所以失敗訊息後面不能再接「這場會還沒有音檔，去補上音檔」
 * 那段建議——那是假話，而且叫使用者再做一次剛被拒絕的動作。
 * 各留一份字面值的話，改了 server 這邊前端會安靜地認不出來，回頭接上那段假話。
 */
export const audioUploadInFlightError = (meetingId: string): string =>
  `Meeting ${meetingId} 已經有一個上傳正在進行，等它結束再送`;

export const audioUploadQueuedError = (meetingId: string): string =>
  `Meeting ${meetingId} 已經在佇列裡，等它跑完或失敗再重送音檔`;

/** 前端用來認出上面那兩種 409 的線索。比對 meeting_id 以外的部分，前綴（例如「【處理失敗】」）不影響 */
export const AUDIO_ALREADY_ON_SERVER_HINTS = [
  '已經有一個上傳正在進行',
  '已經在佇列裡',
] as const;

/**
 * 所有錯誤回應的形狀。server 的 `handleStoreError` 送這個。
 */
export interface ApiErrorResponse {
  error: string;
}

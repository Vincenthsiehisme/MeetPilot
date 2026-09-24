/**
 * Meeting（server 的真相）→ Job（畫面元件現在吃的形狀）的轉接層。
 *
 * `components/` 底下的元件全部吃 `Job`，改它們是另一包的量，所以這一期由這裡把 Meeting
 * 翻成 Job 形狀餵進去。代價是 `Job` 這個型別在前端多活一陣子，這是 coordinator 決定並記錄的。
 *
 * 這個檔全是純函式：App.tsx 沒有元件測試基礎設施，能測的邏輯一律放這裡。
 */
import { GeminiOutput, Job, JobStatus, Meeting, StepStatus } from '../types';
import { upgradeAnalysisToV2, upgradeAnalysisV2ToV3 } from './analysisContract';
import {
  AUDIO_ALREADY_ON_SERVER_HINTS,
  AudioResidencyGroup,
  BUSY_STATUSES,
  ImportResponse,
  MeetingDetailResponse,
  MeetingView,
} from './meetingApi';
import { MeetingStatus } from './meetingState';

/** server 這條線的三個階段，順序即 Job.steps 的順序 */
const STAGE_NAMES = ['音檔上傳與轉錄', 'AI 分析與會議記錄', '跨會議關聯'] as const;

interface StatusView {
  jobStatus: JobStatus;
  /** 三個階段各自的顯示狀態。空陣列代表「不知道斷在哪一階段」，由 buildSteps 另外處理 */
  stageStatuses: StepStatus[];
  currentStep: number;
  /** 這個狀態要對使用者講清楚的話；沒有特別要講的就是 null */
  note: string | null;
}

/**
 * 每個 MeetingStatus 逐一列出，沒有 default 分支。
 *
 * 寫成 Record<MeetingStatus, ...> 是為了讓「server 多出一個狀態、前端漏了」在 `tsc` 就壞掉；
 * default 分支會把不認得的狀態吞成某個看起來正常的值，那種壞法不會有人發現。
 *
 * READY 與 LINKED 分開（SDD D-002）：READY 時結論已經完整可用，只是還沒關聯。
 * LINK_FAILED 對到 JobStatus.FAILED 而不是 COMPLETED —— 關聯真的壞了，標成完成就是把錯誤藏起來；
 * 「壞的只有關聯、結論本身可讀」由 note 併進 error 文字講明白，不靠狀態去暗示。
 */
const STATUS_VIEW: Record<MeetingStatus, StatusView> = {
  CREATED: {
    jobStatus: JobStatus.PENDING,
    stageStatuses: [StepStatus.IDLE, StepStatus.IDLE, StepStatus.IDLE],
    currentStep: 0,
    note: '會議已建立，等待音檔上傳',
  },
  // 語音備忘錄正在錄（vault plan「MeetPilot · 網頁錄音」）。算在「音檔」那一階段：還沒有音檔可轉，
  // 但這場會確實在進行中，標成 PENDING 會跟「建立了等上傳」長得一樣
  RECORDING: {
    jobStatus: JobStatus.RUNNING,
    stageStatuses: [StepStatus.PROCESSING, StepStatus.IDLE, StepStatus.IDLE],
    currentStep: 0,
    note: '錄音中，按「停止錄音」後會自動送進轉錄',
  },
  TRANSCRIBING: {
    jobStatus: JobStatus.RUNNING,
    stageStatuses: [StepStatus.PROCESSING, StepStatus.IDLE, StepStatus.IDLE],
    currentStep: 0,
    note: null,
  },
  // 轉錄與分析拆成兩條獨立 queue 之後才有的停留點：轉錄完成、分析 job 還沒被排進去或還沒跑。
  // 這段期間逐字稿可以編輯（不在 BUSY_STATUSES 裡），note 順便提示這件事
  TRANSCRIBED: {
    jobStatus: JobStatus.RUNNING,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.IDLE, StepStatus.IDLE],
    currentStep: 1,
    note: '逐字稿已完成，分析尚未開始，可以先修正逐字稿內容',
  },
  ANALYZING: {
    jobStatus: JobStatus.RUNNING,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.PROCESSING, StepStatus.IDLE],
    currentStep: 1,
    note: null,
  },
  READY: {
    jobStatus: JobStatus.COMPLETED,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.IDLE],
    currentStep: 2,
    note: '結論已完成可用，跨會議關聯尚未開始',
  },
  LINKING: {
    jobStatus: JobStatus.RUNNING,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.PROCESSING],
    currentStep: 2,
    note: '結論已可閱讀，正在關聯其他會議',
  },
  LINKED: {
    jobStatus: JobStatus.COMPLETED,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.SUCCESS],
    currentStep: 2,
    note: null,
  },
  LINK_FAILED: {
    jobStatus: JobStatus.FAILED,
    stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.ERROR],
    currentStep: 2,
    note: '會議結論已完成可用，失敗的是跨會議關聯',
  },
  FAILED: {
    jobStatus: JobStatus.FAILED,
    stageStatuses: [],
    currentStep: 0,
    note: null,
  },
};

/** FAILED 時唯一那個節點的名稱。Meeting 沒有記錄斷在哪一階段，硬填三個階段的成敗都是編造 */
export const UNKNOWN_STAGE_STEP_NAME = 'server 處理中斷（未記錄中斷在哪一階段）';

/** server 沒附錯誤訊息時填這句。留空會讓失敗的會議看起來像沒事 */
export const MISSING_ERROR_MESSAGE = 'server 沒有附上錯誤訊息';

/**
 * 片段進度轉成文字。total 是 null 時不推算、不補 0：
 * 補一個數字會讓進度條顯示一個 server 從沒說過的百分比。
 */
export const formatSliceProgress = (
  processed: number | null,
  total: number | null
): string | null => {
  if (processed === null) return null;
  if (total === null) return `已完成 ${processed} 個片段（總片段數 server 尚未回報）`;
  return `已完成 ${processed}/${total} 片段`;
};

const buildSteps = (meeting: Meeting, view: StatusView): Job['steps'] => {
  if (view.stageStatuses.length === 0) {
    return [{ name: UNKNOWN_STAGE_STEP_NAME, status: StepStatus.ERROR }];
  }
  const progress = formatSliceProgress(meeting.processed_slices, meeting.total_slices);
  return view.stageStatuses.map((status, idx) => ({
    // 進度只掛在轉錄那一步：切片數是轉錄才有的東西
    name: idx === 0 && progress !== null ? `${STAGE_NAMES[0]}（${progress}）` : STAGE_NAMES[idx],
    status,
  }));
};

const buildErrorText = (meeting: Meeting, view: StatusView): string | undefined => {
  if (view.jobStatus === JobStatus.FAILED) {
    const detail = meeting.error === null ? MISSING_ERROR_MESSAGE : meeting.error;
    return view.note === null ? detail : `${view.note}：${detail}`;
  }
  return meeting.error === null ? undefined : meeting.error;
};

export const meetingToJob = (meeting: MeetingView): Job => {
  const view = STATUS_VIEW[meeting.status];
  // server 送來前端不認得的狀態時直接壞掉。猜一個最接近的值會讓畫面一直顯示錯的進度，
  // 而沒有人會發現那是猜的。
  if (!view) {
    throw new Error(`未知的 Meeting 狀態「${meeting.status}」（meeting_id: ${meeting.meeting_id}）`);
  }

  return {
    id: meeting.meeting_id,
    // 三個都可能是 null，最後退回 meeting_id：畫面上至少要有一個認得出是哪一場的字串
    fileName: meeting.source_file_name ?? meeting.title ?? meeting.meeting_id,
    title: meeting.title ?? undefined,
    fileSize: meeting.source_file_size ?? 0,
    createdAt: meeting.created_at,
    updatedAt: meeting.updated_at,
    status: view.jobStatus,
    currentStep: view.currentStep,
    error: buildErrorText(meeting, view),
    processedSlices: meeting.processed_slices ?? undefined,
    totalSlices: meeting.total_slices ?? undefined,
    meetingContext: meeting.meeting_context ?? undefined,
    recordingStartedAt: meeting.recording_started_at ?? undefined,
    recordingMethod: meeting.recording_method ?? undefined,
    steps: buildSteps(meeting, view),
  };
};

export const meetingsToJobs = (meetings: MeetingView[]): Job[] => meetings.map(meetingToJob);

/**
 * 本機 IndexedDB 裡的舊 Job：`analysis` 是寫入當時的 v1（`GeminiOutput`）形狀——前端搬到
 * server 端分析之前就是直接存 Gemini 的回應。載入畫面前先升到 v3（v1 → v2 → v3 兩段都是
 * 純函式），跟 server 那邊的資料同一個形狀，`SummaryView` 不用為本機任務另外分渲染邏輯。
 *
 * 沒有 analysis（還沒分析完）原樣通過。前端已經不再寫新的本機任務，所以不會出現已經是
 * v3 形狀的本機資料，這裡不特別判斷、一律當 v1 升級——真的遇到形狀對不上，
 * `upgradeAnalysisToV2` 會在存取不存在的欄位時直接壞得明顯，不會靜默吞掉。
 */
export const upgradeLocalJobAnalysis = (job: Job): Job => {
  if (job.analysis === undefined) return job;
  const v1 = job.analysis as unknown as GeminiOutput;
  return { ...job, analysis: upgradeAnalysisV2ToV3(upgradeAnalysisToV2(v1, job.id, job.createdAt)) };
};

export const meetingDetailToJob = (detail: MeetingDetailResponse): Job => ({
  ...meetingToJob(detail.meeting),
  // transcript 與 analysis 還沒產出時是 null，不是空物件；轉成 undefined 讓 JobDetail 的分頁停用
  transcript: detail.transcript === null ? undefined : detail.transcript.segments,
  polishedContent: detail.transcript?.polished_content ?? undefined,
  // v3 直接進畫面，不再降成 v1 字串。舊的 analysisV2ToGeminiOutput／geminiOutputToAnalysisV2
  // 那套「用文字比對認領 metadata」的兩輪演算法已刪除：它存在的唯一理由是前端過去只拿得到
  // 字串，改字時要自己猜哪一筆是哪一筆；v3 的每一筆決議／待辦／未決事項自帶 evidence 與
  // metadata，SummaryView 直接編輯物件即可，不會有「猜錯認領」這種資料污染
  analysis: detail.analysis === null ? undefined : detail.analysis,
  meetingTags: detail.tags,
});

/** 畫面上選中的是哪一邊的哪一筆。App.tsx 的 Selection 就是這個型別，不要各寫一份 */
export type SelectionRef = { source: 'server' | 'local'; id: string } | null;

/**
 * 這一份詳情回應還該不該套用到畫面上。
 *
 * 不比對就會這樣壞：從會議 A 快速切到 B，A 的請求比較慢回來，回來時仍然被寫進
 * `activeServerJob` 與 `activeDetail`。畫面在選中 B 時顯示 A 的內容還算看得出來，
 * **真正致命的是存檔**：寫回用的是 B 的 meeting_id，接 metadata 用的卻是 A 的 analysis，
 * 於是 A 的待辦來源與時間戳被寫進 B。polling 那一拍走同一條路，所以一起走這支。
 */
export const shouldApplyDetail = (requestedMeetingId: string, current: SelectionRef): boolean =>
  current !== null && current.source === 'server' && current.id === requestedMeetingId;

/**
 * 拉一場會的詳情，只在使用者還停在同一場時才套用。App.tsx 一律用這支，不要自己再寫一次比對。
 *
 * readSelection 是函式不是值：要在 await 之後才讀「現在」選中誰，讀 render 當下那份閉包
 * 等於沒有比對。錯誤也要比對，舊請求的失敗蓋掉新畫面一樣是錯的畫面。
 */
export const loadDetailForSelection = async (
  meetingId: string,
  fetchDetail: (id: string) => Promise<MeetingDetailResponse>,
  readSelection: () => SelectionRef,
  handlers: {
    onDetail: (detail: MeetingDetailResponse) => void;
    onError: (err: unknown) => void;
  }
): Promise<void> => {
  let detail: MeetingDetailResponse;
  try {
    detail = await fetchDetail(meetingId);
  } catch (err) {
    if (!shouldApplyDetail(meetingId, readSelection())) return;
    handlers.onError(err);
    return;
  }
  if (!shouldApplyDetail(meetingId, readSelection())) return;
  handlers.onDetail(detail);
};

export const isMeetingBusy = (status: MeetingStatus): boolean =>
  (BUSY_STATUSES as readonly string[]).includes(status);

/**
 * 這場會現在能不能編輯，不能的話理由是什麼（null = 可以編）。
 *
 * 不要等 server 回 409 才講：那時候使用者已經把字打完了，而他打的那些字沒有任何地方存得住。
 * 擋的理由不是「衝突」是「安靜消失」—— pipeline 在迴圈外抓一份逐字稿快照，每轉完一片就把
 * 快照加新片寫回去，轉錄途中存進來的修改會在下一片寫回時被蓋掉，而那一刻 server 回的是 200。
 */
export const editBlockedReason = (status: MeetingStatus): string | null =>
  isMeetingBusy(status)
    ? `這場會議正在處理中（${status}），伺服器同時在寫它的逐字稿與分析。`
      + '現在存下去會被下一次寫回蓋掉，而且畫面上不會有任何錯誤，所以先擋下來。等它跑完再編輯。'
    : null;

/**
 * 這場會現在還在跑嗎。polling 只在有這種會議時才排下一拍，批次清除則只清不在跑的。
 *
 * `CREATED` 一定要看 `has_audio`，不能只看狀態。搬遷進來的舊 Job 一律是 `CREATED`
 * 而且刻意不搬音檔，所以「搬完 20 筆」之後只要 CREATED 一律算處理中，這個分頁就會
 * **永久**每 3 秒打兩支 API（40 次/分鐘，限流是 60），而它們同時被批次清除濾掉，
 * 使用者按完「清除已結束的會議」還以為清乾淨了。出口只剩逐筆 DELETE。
 *   CREATED + has_audio: false = 等使用者上傳。不算在跑
 *   CREATED + has_audio: true  = retry 之後在佇列裡排隊。算在跑
 *
 * `TRANSCRIBED` 另外特判：它刻意不在 `BUSY_STATUSES` 裡（那段期間 server 沒在寫這場會，
 * 逐字稿可以編輯），但這場會離結束還很遠——分析 job 可能還在佇列裡排隊。用 `isMeetingBusy`
 * 判「還在跑」的話這裡會誤判成已經結束，polling 停掉，使用者不會看到分析什麼時候真的開始。
 *
 * 其餘狀態剛好等於 `BUSY_STATUSES`：server 正在寫這場會的資料，跟「還在跑」是同一件事的兩面。
 * 共用一份清單，不要各留一份會漂移的字面值。
 */
export const isMeetingInProgress = (meeting: MeetingView): boolean => {
  if (meeting.status === 'CREATED') return meeting.has_audio;
  if (meeting.status === 'TRANSCRIBED') return true;
  // RECORDING 跟 TRANSCRIBED 一樣不在 BUSY_STATUSES 裡（server 沒在寫這場會的逐字稿），
  // 但它還沒結束：polling 要繼續，另一個分頁按了停止之後這裡才看得到；批次清除也不能清掉
  // 一場還在錄的會（刪掉的話語音備忘錄會一直錄下去，沒有任何畫面停得了它）
  if (meeting.status === 'RECORDING') return true;
  return isMeetingBusy(meeting.status);
};

export const hasMeetingsInProgress = (meetings: MeetingView[]): boolean =>
  meetings.some(isMeetingInProgress);

/**
 * 這場會要不要給「補上音檔」的入口。
 *
 * 只看 `status === 'CREATED'` 會出事：retry 把 FAILED 退回 CREATED 再排進佇列，
 * 佇列在跑別場時這場就停在 CREATED，而**音檔明明在 server 上**。那段期間顯示上傳入口
 * 等於對使用者說一句假話，而他照做按下去，server 的 PUT 會把 retry 刻意保留的
 * 逐字稿與游標全刪掉 —— 不用重跑兩小時轉錄的整個用意就沒了，過程中沒有任何提示。
 */
export const needsAudioUpload = (meeting: MeetingView): boolean =>
  meeting.status === 'CREATED' && !meeting.has_audio;

/**
 * 送出音檔失敗時要說的話。
 *
 * 一定要分三種：
 * - `createMeeting` 自己就失敗時（server 沒起來、429、400）伺服器上根本沒有那場會，
 *   還叫使用者「去清單裡選中它」是叫他去找一筆不存在的紀錄。
 * - 被 `PUT audio` 的兩種 409 擋下來時（另一個上傳正在進行、已經在佇列裡排隊），
 *   **音檔已經在 server 上或正在進去的路上**。接「只是還沒有音檔，去補上音檔」是假話，
 *   而且叫使用者再做一次剛剛被拒絕的動作。這種只要說等它跑完。
 * - 其餘的失敗，那場會確實在 server 上而且確實缺音檔，補送就對了。
 */
export const audioSubmitFailureMessage = (reason: string, meetingExists: boolean): string => {
  if (!meetingExists) {
    return `${reason}\n\n伺服器上沒有建立這場會議，清單裡不會出現這一筆。`
      + '排除問題之後重新選一次檔案即可，不會留下半筆紀錄。';
  }
  if (AUDIO_ALREADY_ON_SERVER_HINTS.some(hint => reason.includes(hint))) {
    return `${reason}\n\n音檔已經在伺服器上，不用重送。`
      + '等這一輪跑完或失敗之後再處理它就好，剛才選的檔案沒有被寫進去。';
  }
  return `${reason}\n\n這場會議已經在伺服器上，只是還沒有音檔。不用重新建立，`
    + '在清單裡選中它，用上方的「補上音檔」重送一次就會繼續跑。';
};

// ---------------------------------------------------------------------------
// 雙讀：server 的 Meeting 與瀏覽器 IndexedDB 裡的舊 Job 同時上畫面
// ---------------------------------------------------------------------------

export const SERVER_SECTION_TITLE = '伺服器上的會議';
export const LOCAL_SECTION_TITLE = '尚未搬到伺服器的本機紀錄';

const SERVER_SECTION_HINT = '換一台機器也看得到，處理由伺服器跑。';
const LOCAL_SECTION_HINT = '只存在這台瀏覽器，換一台機器就看不到。搬到伺服器之前都只能看，不能重跑。';

/** 舊紀錄停在處理中時要講的話。瀏覽器端的轉錄已經移除，它不會自己前進 */
export const LOCAL_STALLED_ERROR =
  '這筆是舊版在瀏覽器裡處理到一半的紀錄。瀏覽器端的轉錄已經移除，它不會再前進；搬到伺服器後才能重跑。';

export interface DashboardSection {
  key: 'server' | 'local';
  title: string;
  hint: string;
  jobs: Job[];
}

export interface DashboardView {
  sections: DashboardSection[];
  /** server 讀不到時要顯示的那句話。null 代表沒事 */
  serverNotice: string | null;
}

/**
 * 舊紀錄停在 PENDING / RUNNING 的，在畫面上標成失敗並說明原因。
 *
 * 不寫回 IndexedDB：前端已經不寫新的 Job 了，改的是顯示不是資料。
 * 維持顯示「處理中」才是說謊 —— 那個任務永遠不會有人去跑它。
 */
export const localJobForDisplay = (job: Job): Job =>
  job.status === JobStatus.PENDING || job.status === JobStatus.RUNNING
    ? { ...job, status: JobStatus.FAILED, error: job.error ?? LOCAL_STALLED_ERROR }
    : job;

/**
 * 組出側邊欄要顯示的兩區。
 *
 * server 讀不到時**不清空清單**：本機紀錄還在，清空等於告訴使用者資料不見了。
 * meetings 傳 null 代表「這一次沒讀到」，上一次讀到的內容由呼叫端自己留著再傳進來。
 */
export const buildDashboardView = (
  meetings: MeetingView[] | null,
  serverError: string | null,
  localJobs: Job[]
): DashboardView => {
  const sections: DashboardSection[] = [{
    key: 'server',
    title: SERVER_SECTION_TITLE,
    hint: SERVER_SECTION_HINT,
    jobs: meetings === null ? [] : meetingsToJobs(meetings),
  }];

  // 沒有本機紀錄就不放這一區：沒東西可搬的時候不要一直提醒有東西沒搬
  if (localJobs.length > 0) {
    sections.push({
      key: 'local',
      title: LOCAL_SECTION_TITLE,
      hint: LOCAL_SECTION_HINT,
      jobs: localJobs.map(localJobForDisplay),
    });
  }

  return {
    sections,
    serverNotice: serverError === null
      ? null
      : `伺服器清單讀取失敗（${serverError}）。畫面上的伺服器會議可能不是最新的，本機紀錄不受影響。`,
  };
};

// ---------------------------------------------------------------------------
// 搬遷結果
// ---------------------------------------------------------------------------

export interface ImportSummary {
  imported: string[];
  skippedExisting: string[];
  rejected: { jobId: string | null; reason: string }[];
  notes: { jobId: string; note: string }[];
  audioStillInBrowser: { meetingId: string; group: AudioResidencyGroup }[];
  /**
   * 被退件、而且音檔還留在瀏覽器的那幾場。
   * 這是清掉 IndexedDB 之後真的重跑不了的一群，要單獨列出來，不能混在 audioStillInBrowser 裡帶過。
   */
  unrecoverableMeetingIds: string[];
  /** 給 ConfirmModal 顯示的純文字報告，五個欄位各自一段 */
  message: string;
}

/**
 * 搬遷報告裡指路用的那一句。
 *
 * 舊版寫「請先自行備份音檔」，但前端當時連讀 blob 的路徑都沒有，使用者只能去開 DevTools。
 * 報告只能指向畫面上真的做得到的動作，做不到的提示比不提還糟。
 */
export const AUDIO_BACKUP_HINT =
  '這幾場的紀錄沒進伺服器、音檔只剩瀏覽器這一份。關掉這個視窗後，'
  + '側邊欄「尚未搬到伺服器的本機紀錄」那一區會列出它們，逐筆按「下載音檔」存下來再清 IndexedDB。';

export interface AudioBackupTarget {
  meetingId: string;
  /** 下載時的檔名。對得上本機紀錄就用原本的檔名，對不上才退回 meetingId */
  fileName: string;
}

/**
 * 把「被退件、音檔還在瀏覽器」的 meetingId 配回本機紀錄，湊出可以下載的清單。
 *
 * 配得回來是因為 `jobMigration` 的 `meeting_id` 直接沿用 Job 的 id，而 IndexedDB 的 blob
 * 也是用同一個 id 當 key。這個等式哪天不成立，這裡就只會退回用 meetingId 當檔名，
 * 不會憑空配到別人的檔名。
 */
export const buildAudioBackupTargets = (
  unrecoverableMeetingIds: string[],
  localJobs: Job[]
): AudioBackupTarget[] =>
  unrecoverableMeetingIds.map(meetingId => {
    const job = localJobs.find(j => j.id === meetingId);
    return { meetingId, fileName: job === undefined ? meetingId : job.fileName };
  });

const listOrNone = (lines: string[]): string =>
  lines.length === 0 ? '（無）' : lines.map(line => `・${line}`).join('\n');

export const summarizeImportResponse = (response: ImportResponse): ImportSummary => {
  const unrecoverableMeetingIds = response.audioStillInBrowser
    .filter(entry => entry.group === 'rejected')
    .map(entry => entry.meetingId);

  const message = [
    `已搬進伺服器（${response.imported.length}）：\n${listOrNone(response.imported)}`,
    `伺服器上已經有、略過（${response.skippedExisting.length}）：\n${listOrNone(response.skippedExisting)}`,
    `退件、沒有搬進去（${response.rejected.length}）：\n${listOrNone(
      response.rejected.map(r => `${r.jobId ?? '(沒有 jobId)'}：${r.reason}`)
    )}`,
    `搬進去但有附註（${response.notes.length}）：\n${listOrNone(
      response.notes.map(n => `${n.jobId}：${n.note}`)
    )}`,
    `音檔仍留在這台瀏覽器（${response.audioStillInBrowser.length}）：\n${listOrNone(
      response.audioStillInBrowser.map(a => `${a.meetingId}（${a.group}）`)
    )}`,
    `其中被退件、清掉瀏覽器資料後就重跑不了的（${unrecoverableMeetingIds.length}）：\n${listOrNone(
      unrecoverableMeetingIds
    )}\n${AUDIO_BACKUP_HINT}`,
  ].join('\n\n');

  return {
    imported: response.imported,
    skippedExisting: response.skippedExisting,
    rejected: response.rejected,
    notes: response.notes,
    audioStillInBrowser: response.audioStillInBrowser,
    unrecoverableMeetingIds,
    message,
  };
};

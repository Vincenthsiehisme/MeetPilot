import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Job, JobStatus } from './types';
import JobDashboard from './components/JobDashboard';
import JobDetail from './components/JobDetail';
import FileUpload from './components/FileUpload';
import ConfirmModal from './components/ConfirmModal';
import ParticipantPicker from './components/ParticipantPicker';
import { HttpError } from './services/httpError';
import { MEETING_POLL_INTERVAL_MS, MeetingDetailResponse, MeetingView, PersonSummary, RecordingAvailabilityResponse } from './services/meetingApi';
import {
  confirmNameMention,
  createMeeting,
  deleteMeeting,
  getMeetingDetail,
  getRecordingAvailability,
  importLegacyJobs,
  listMeetings,
  listPeopleWithSingleRetry,
  patchAnalysis,
  patchTitle,
  patchTranscript,
  retryMeeting,
  startRecording,
  stopRecording,
  submitAudio
} from './services/meetingClient';
import { decideAfterStartFailure, findRecordingMeeting, formatRecordingElapsed, recordingMeetingFileName } from './services/recordingView';
import {
  AudioBackupTarget,
  SelectionRef,
  audioSubmitFailureMessage,
  buildAudioBackupTargets,
  buildDashboardView,
  editBlockedReason,
  hasMeetingsInProgress,
  isMeetingInProgress,
  loadDetailForSelection,
  meetingDetailToJob,
  needsAudioUpload,
  summarizeImportResponse,
  upgradeLocalJobAnalysis
} from './services/meetingAdapter';
import { downloadBlob } from './services/exportUtils';
import { pickDroppedAudioFile } from './services/droppedFiles';
import {
  getAllJobsFromDB,
  deleteJobFromDB,
  deleteFileBlob,
  exportAllForMigration,
  getFileBlob
} from './services/storageService';

/** 選中的是哪一邊的紀錄。server 的 meeting_id 與本機的 job id 可能長得一樣，來源要自己記 */
type Selection = NonNullable<SelectionRef>;

// err 不一定是 Error（IndexedDB 的事件物件、被 reject 的字串都可能），直接內插會印出 [object Object]，
// 而這些字串全都是要給使用者看的
const errorText = (err: any): string => (err instanceof Error ? err.message : String(err));

const translateError = (error: string) => {
  const e = (error || '').toLowerCase();
  if (e.includes('api_key') || e.includes('gemini_api_key')) {
    return '【系統提示】尚未偵測到 Gemini API 金鑰，請確認環境設定。';
  }
  if (e.includes('403') || e.includes('permission_denied') || e.includes('permission') || e.includes('unregistered callers')) {
    return '【金鑰權限錯誤】Gemini API 金鑰權限不足 (PERMISSION_DENIED)。請前往 Google AI Studio 確認專案權限或重新綁定 API 金鑰。';
  }
  if (e.includes('prepayment') || e.includes('credits are depleted')) {
    return '【額度用罄】Gemini API 預付額度已耗盡 (Prepayment credits depleted)。請至 Google AI Studio (ai.studio/projects) 儲值或調整專案計費設定。';
  }
  if (e.includes('429') || e.includes('resource_exhausted')) {
    return '【AI 額度上限】目前的處理量已達 AI 限制或用量配額上限，請稍候再重試。';
  }
  if (e.includes('503') || e.includes('unavailable') || e.includes('high demand') || e.includes('overloaded')) {
    return '【AI 服務繁忙】模型目前需求量極大 (503 High Demand)。系統已嘗試自動切換模型，請稍候重試。';
  }
  if (e.includes('developer instruction is not enabled')) {
    return '【模型指令錯誤】使用的模型不支援開發者指令，已修正為通用多模態模型。請點擊重試。';
  }
  if (e.includes('unexpected token') || e.includes('<!doctype') || e.includes('is not valid json') || e.includes('網頁內容') || e.includes('html')) {
    return '【連線異常】伺服器回應了非預期的網頁格式，可能連線短暫中斷或正在重啟，請點擊重試。';
  }
  // server 整個連不上跟 server 回錯是兩件事，講一樣的話會讓人往 API 金鑰的方向查
  if (e.includes('failed to fetch') || e.includes('networkerror') || e.includes('load failed')) {
    return '【連不上伺服器】無法連到處理服務，請確認 server 有在跑、網路正常後重試。';
  }
  return `【處理失敗】${error}`;
};

const App: React.FC = () => {
  // meetings 是 server 清單的快取。null 代表「還沒成功讀到過」，空陣列代表「讀到了，一場都沒有」，
  // 兩者在畫面上要講的話不一樣，不能合併成同一個值。
  const [meetings, setMeetings] = useState<MeetingView[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [localJobs, setLocalJobs] = useState<Job[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  // 非同步回應要比對「現在」選中誰，不是送出請求那一刻的閉包值，所以額外記一份 ref。
  // 兩邊一定要一起改，所以一律走 selectRecord，不要直接呼叫 setSelection。
  const selectionRef = useRef<Selection | null>(null);
  const [activeServerJob, setActiveServerJob] = useState<Job | null>(null);
  // 原始的 detail 也留著：判斷「現在存的是不是還在看的那一場」與「這場會現在能不能編輯」
  // 都要看 meeting 的原始狀態，activeServerJob 是轉成 Job 形狀給元件用的顯示版本，缺這些欄位
  const [activeDetail, setActiveDetail] = useState<MeetingDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // 正在跑的長動作（上傳、搬遷）。有值時 header 會顯示，免得使用者以為按鈕沒反應又按一次
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  // 搬遷之後「被退件、音檔只剩瀏覽器這一份」的那幾場。列在本機那一區給使用者逐筆下載
  const [audioBackupTargets, setAudioBackupTargets] = useState<AudioBackupTarget[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  // 整頁拖曳上傳（AC-6）。用計數器不用布林：拖過子元素時瀏覽器會先觸發子元素的
  // dragleave 再觸發它自己的 dragenter，布林版本會在兩者之間閃一下 false
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragCounter = useRef(0);
  // 建立新會議前的與會者名單（人名校正 N2）。null 是「還沒讀回來」，picker 用它跟 people 分開判斷
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [peopleLoadError, setPeopleLoadError] = useState<string | null>(null);
  // 選好檔案或按了開始錄音，等使用者在 picker 裡選完與會者才真的送出（D-016：至少一位是前置條件）。
  // 錄音也要先選人：與會者在會議開始時選（vault plan「MeetPilot · 網頁錄音」，使用者裁決）
  const [pendingNew, setPendingNew] = useState<{ kind: 'file'; file: File } | { kind: 'recording' } | null>(null);
  // 這台 server 能不能叫語音備忘錄錄音。null 是還沒問到；不能的時候帶原因，錄音按鍵照它決定顯不顯示（AC-5）
  const [recordingAvailability, setRecordingAvailability] = useState<RecordingAvailabilityResponse | null>(null);
  // 正在叫語音備忘錄開始或停止時的訊息。跟 busyMessage 分開：上傳一支大檔可能跑好幾分鐘，
  // 共用同一個狀態的話那段期間停止按鍵會被停用，webapp 停不了還在進行的錄音（Codex review 抓到）
  const [recordingOp, setRecordingOp] = useState<string | null>(null);
  // 錄音計時用的「現在」。只在有會正在錄的時候每秒更新，其餘時間不跑計時器
  const [now, setNow] = useState<number>(() => Date.now());
  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive?: boolean;
    hideCancel?: boolean;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    isDestructive: true,
    hideCancel: false
  });

  const selectRecord = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const closeConfirm = useCallback(() => setConfirmConfig(prev => ({ ...prev, isOpen: false })), []);

  const showAlert = useCallback((title: string, message: string) => {
    setConfirmConfig({
      isOpen: true,
      title,
      message,
      onConfirm: closeConfirm,
      hideCancel: true,
      isDestructive: false
    });
  }, [closeConfirm]);

  const refreshMeetings = useCallback(async (): Promise<void> => {
    try {
      const list = await listMeetings();
      setMeetings(list);
      setServerError(null);
    } catch (err: any) {
      // 讀不到就把上一次的清單留著，另外把失敗講出來。清空清單等於告訴使用者「你的會議不見了」，
      // 那是這一包最該擋掉的壞法。
      console.error('讀取伺服器會議清單失敗', err);
      setServerError(errorText(err));
    }
  }, []);

  const refreshActiveDetail = useCallback((meetingId: string): Promise<void> =>
    loadDetailForSelection(
      meetingId,
      getMeetingDetail,
      () => selectionRef.current,
      {
        onDetail: detail => {
          try {
            // 先轉再寫入 state：meetingDetailToJob 撞到不認得的狀態會拋錯，
            // 讓它在這裡被接住，不要留下半套的畫面
            const job = meetingDetailToJob(detail);
            setActiveServerJob(job);
            setActiveDetail(detail);
            setDetailError(null);
          } catch (err: any) {
            console.error('會議內容轉換失敗', err);
            setDetailError(errorText(err));
          }
        },
        onError: err => {
          console.error('讀取會議內容失敗', err);
          setDetailError(errorText(err));
        }
      }
    ), []);

  // 開場：server 清單與本機舊紀錄各讀各的，一邊失敗不影響另一邊
  useEffect(() => {
    refreshMeetings();
    getAllJobsFromDB()
      .then(jobs => setLocalJobs(
        [...jobs].sort((a, b) => b.createdAt - a.createdAt).map(job => {
          try {
            return upgradeLocalJobAnalysis(job);
          } catch (err: any) {
            // 單筆舊資料形狀壞掉不該拖垮其他筆：這筆原樣顯示（analysis 可能渲染不出來），
            // 但至少不會讓整份本機任務清單從畫面消失
            console.error(`本機任務 ${job.id} 的 analysis 升級失敗`, err);
            return job;
          }
        })
      ))
      .catch((err: any) => {
        console.error('讀取本機任務紀錄失敗', err);
        showAlert(
          '讀取本機紀錄失敗',
          `無法讀取這台瀏覽器裡的舊紀錄（${errorText(err)}）。伺服器上的會議不受影響；資料沒有被刪除，排除問題後重新整理即可。`
        );
      });
  }, [refreshMeetings, showAlert]);

  const loadPeople = useCallback(async (): Promise<void> => {
    setPeople(null);
    setPeopleLoadError(null);
    try {
      setPeople(await listPeopleWithSingleRetry());
    } catch (err: any) {
      console.error('讀取人員名單失敗', err);
      setPeopleLoadError(errorText(err));
    }
  }, []);

  // 與會者名單只在真的要建立新會議時才需要，但先在開場讀好：picker 打開時使用者不該乾等一次 API 呼叫。
  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  const loadRecordingAvailability = useCallback(async (): Promise<void> => {
    try {
      setRecordingAvailability(await getRecordingAvailability());
    } catch (err: any) {
      // 問不到也要講原因，不讓錄音按鍵安靜地消失：使用者會以為這台機器本來就沒有這個功能
      console.error('讀取錄音功能狀態失敗', err);
      setRecordingAvailability({ available: false, reason: `問不到 server 能不能錄音（${errorText(err)}）` });
    }
  }, []);

  useEffect(() => {
    loadRecordingAvailability();
  }, [loadRecordingAvailability]);

  // 選到 server 的會議才去拉內容。本機紀錄的內容本來就在手上，不用再讀一次
  useEffect(() => {
    if (selection === null || selection.source !== 'server') {
      setActiveServerJob(null);
      setActiveDetail(null);
      setDetailError(null);
      return;
    }
    setActiveServerJob(null);
    setActiveDetail(null);
    setDetailError(null);
    refreshActiveDetail(selection.id);
  }, [selection, refreshActiveDetail]);

  // 進度用 polling，不做 SSE。只有「還有會議沒跑完」時才排下一拍，全部結束就不再排。
  // 用 setTimeout 不用 setInterval：每次拿到新的 meetings 這個 effect 就重跑一次，
  // setInterval 會在重跑時被清掉再重建，實際行為本來就是一次一拍，寫成 setTimeout 才符實。
  useEffect(() => {
    if (meetings === null || !hasMeetingsInProgress(meetings)) return;
    const timer = setTimeout(() => {
      refreshMeetings();
      if (selection !== null && selection.source === 'server') {
        refreshActiveDetail(selection.id);
      }
    }, MEETING_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [meetings, selection, refreshMeetings, refreshActiveDetail]);

  // 錄音計時：有會正在錄才每秒更新一次，沒有就不跑計時器
  const hasRecordingMeeting = meetings !== null && meetings.some(m => m.status === 'RECORDING');
  useEffect(() => {
    if (!hasRecordingMeeting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRecordingMeeting]);

  /**
   * 送出音檔。targetMeetingId 給了就是對既有的那場補送，沒給才建立新的一場。
   *
   * 補送這條路絕對不能再 POST 一次：上傳失敗留下的 CREATED 會議要能被救回來，
   * 每失敗一次多一筆殭屍會議的話，那幾筆永遠不會有人去補音檔。
   *
   * `participantIds` 只在新建時用得到（D-016），補送既有會議時忽略——那場會的與會者
   * 已經在建立當下定了，不能事後改。
   */
  const submitAudioFile = async (file: File, targetMeetingId: string | null, participantIds: string[] | null = null) => {
    setBusyMessage(`正在上傳「${file.name}」…`);
    // server 上到底有沒有那場會。補送本來就有；新建這條要等 onCreated 才算數 ——
    // createMeeting 自己失敗時那場會根本不存在，這個旗標決定失敗訊息該講哪一句
    let meetingExists = targetMeetingId !== null;
    try {
      await submitAudio(
        file,
        targetMeetingId === null ? null : { meetingId: targetMeetingId },
        participantIds,
        created => {
          meetingExists = true;
          // 上傳是整條裡最久的一段。建立完就先把那場會放進畫面，
          // 上傳失敗時使用者才找得到它去補音檔
          selectRecord({ source: 'server', id: created.meeting_id });
          if (!isSidebarOpen) setIsSidebarOpen(true);
          refreshMeetings();
        }
      );
      await refreshMeetings();
    } catch (err: any) {
      console.error('建立會議或上傳音檔失敗', err);
      showAlert(
        '音檔沒有上傳成功',
        audioSubmitFailureMessage(translateError(errorText(err)), meetingExists)
      );
      await refreshMeetings();
    } finally {
      setBusyMessage(null);
    }
  };

  // 新建這條先開 picker 選與會者（D-016 必填），選完才真的送出；補送既有會議走 submitAudioFile 原路
  const addMeeting = (file: File) => setPendingNew({ kind: 'file', file });

  /**
   * 建立會議並叫語音備忘錄開始錄。
   *
   * 開始失敗時先重讀那場會再決定要不要刪（decideAfterStartFailure）：失敗不代表沒在錄，
   * 直接刪會把一支其實已經開始的錄音切掉。確定沒在錄才刪，免得清單上多一筆沒有音檔、
   * 也沒有人會去補的空會議；刪不掉就照實講它還在，讓使用者自己處理，不當作沒事。
   */
  const beginRecording = async (participantIds: string[]) => {
    setRecordingOp('正在叫語音備忘錄開始錄音…');
    let createdId: string | null = null;
    try {
      const created = await createMeeting({
        fileName: recordingMeetingFileName(new Date()),
        fileSize: 0,
        participantIds,
      });
      createdId = created.meeting_id;
      await startRecording(created.meeting_id);
      selectRecord({ source: 'server', id: created.meeting_id });
      if (!isSidebarOpen) setIsSidebarOpen(true);
    } catch (err: any) {
      console.error('開始錄音失敗', err);
      const reason = err instanceof HttpError ? err.message : translateError(errorText(err));
      if (createdId === null) {
        showAlert('沒有開始錄音', reason);
        return;
      }
      let current: MeetingView | null = null;
      let readError: string | null = null;
      try {
        current = (await getMeetingDetail(createdId)).meeting;
      } catch (readErr: any) {
        console.error('開始錄音失敗後讀取會議狀態也失敗', readErr);
        readError = errorText(readErr);
      }
      const action = decideAfterStartFailure(current, readError);
      if (action.kind === 'keep-recording') {
        selectRecord({ source: 'server', id: createdId });
        showAlert('錄音其實已經開始', `開始錄音的回應出錯了（${reason}），但伺服器上這場會已經在錄音中，錄音不受影響。結束時照常按「停止錄音」。`);
        return;
      }
      if (action.kind === 'keep-unknown') {
        showAlert('沒有確認是否開始錄音', `${reason}\n\n${action.reason}。請到語音備忘錄確認有沒有在錄，再決定要不要刪掉清單上這場會。`);
        return;
      }
      let cleanup = '';
      try {
        await deleteMeeting(createdId);
      } catch (deleteErr: any) {
        console.error('開始錄音失敗後刪除空會議也失敗', deleteErr);
        cleanup = `\n\n剛建立的那場空會議沒有刪掉（${errorText(deleteErr)}），可以在清單裡自己刪除。`;
      }
      showAlert('沒有開始錄音', `${reason}${cleanup}`);
    } finally {
      setRecordingOp(null);
      await refreshMeetings();
    }
  };

  /**
   * 叫語音備忘錄停止、取回錄音、送進轉錄。server 的錯誤訊息原樣顯示：422 會講取回的為什麼
   * 不是這場會的錄音、接下來怎麼補，502 會講是哪個捷徑失敗，套 translateError 會把這些都蓋掉
   */
  const handleStopRecording = async (meetingId: string) => {
    setRecordingOp('正在停止錄音、取回檔案…');
    try {
      await stopRecording(meetingId);
    } catch (err: any) {
      console.error('停止錄音失敗', err);
      showAlert('錄音沒有送出', err instanceof HttpError ? err.message : translateError(errorText(err)));
    } finally {
      setRecordingOp(null);
      await refreshMeetings();
      if (selectionRef.current !== null && selectionRef.current.source === 'server' && selectionRef.current.id === meetingId) {
        await refreshActiveDetail(meetingId);
      }
    }
  };

  const handleConfirmParticipants = (participantIds: string[]) => {
    const pending = pendingNew;
    setPendingNew(null);
    if (pending === null) return;
    if (pending.kind === 'file') submitAudioFile(pending.file, null, participantIds);
    else beginRecording(participantIds);
  };

  const handleCancelParticipants = () => setPendingNew(null);

  const handleRetryMeeting = async (meetingId: string) => {
    try {
      await retryMeeting(meetingId);
      await refreshMeetings();
      if (selection !== null && selection.source === 'server' && selection.id === meetingId) {
        await refreshActiveDetail(meetingId);
      }
    } catch (err: any) {
      console.error('重跑會議失敗', err);
      showAlert('重試失敗', translateError(errorText(err)));
    }
  };

  const showLocalRetryNotice = () =>
    showAlert(
      '本機紀錄不能重跑',
      '瀏覽器端的轉錄已經移除。請先把這筆搬到伺服器，再從伺服器那一區重跑。'
    );

  const handleMigrate = () => {
    setConfirmConfig({
      isOpen: true,
      title: '把本機紀錄搬到伺服器',
      message:
        `把這台瀏覽器裡的 ${localJobs.length} 筆舊紀錄送到伺服器。\n\n`
        + '音檔這一期不搬，搬完會告訴你哪幾場的音檔還只留在瀏覽器。\n'
        + '本機紀錄不會被刪除，搬完你可以自己決定要不要清掉。',
      isDestructive: false,
      onConfirm: async () => {
        closeConfirm();
        setBusyMessage('正在把本機紀錄送到伺服器…');
        try {
          const payload = await exportAllForMigration();
          const summary = summarizeImportResponse(await importLegacyJobs(payload));
          // 報告裡叫使用者去側邊欄下載，清單就得在那之前備好，否則那句話又變成空頭支票
          setAudioBackupTargets(buildAudioBackupTargets(summary.unrecoverableMeetingIds, localJobs));
          showAlert('搬遷結果', summary.message);
          await refreshMeetings();
        } catch (err: any) {
          console.error('搬遷本機紀錄失敗', err);
          showAlert('搬遷失敗', translateError(errorText(err)));
        } finally {
          setBusyMessage(null);
        }
      }
    });
  };

  const handleDeleteLocalJob = (id: string) => {
    setConfirmConfig({
      isOpen: true,
      title: '刪除本機紀錄',
      message: '確定要從這台瀏覽器永久刪除這筆紀錄與它的音檔嗎？這筆還沒搬到伺服器，刪掉就沒了。',
      isDestructive: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          await deleteJobFromDB(id);
          await deleteFileBlob(id);
          setLocalJobs(prev => prev.filter(j => j.id !== id));
          if (selection !== null && selection.source === 'local' && selection.id === id) {
            selectRecord(null);
          }
        } catch (err: any) {
          console.error('刪除本機紀錄失敗', err);
          showAlert('刪除失敗', `這筆紀錄沒有被刪除（${errorText(err)}）。`);
        }
      }
    });
  };

  const handleClearFinishedLocalJobs = () => {
    const finishedIds = localJobs
      .filter(j => j.status === JobStatus.COMPLETED || j.status === JobStatus.FAILED)
      .map(j => j.id);
    if (finishedIds.length === 0) return;

    setConfirmConfig({
      isOpen: true,
      title: '清除本機已結束的紀錄',
      message: `確定要從這台瀏覽器刪除這 ${finishedIds.length} 筆紀錄嗎？沒搬到伺服器的部分刪掉就沒了。`,
      isDestructive: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          for (const id of finishedIds) {
            await deleteJobFromDB(id);
            await deleteFileBlob(id);
          }
          setLocalJobs(prev => prev.filter(j => !finishedIds.includes(j.id)));
          if (selection !== null && selection.source === 'local' && finishedIds.includes(selection.id)) {
            selectRecord(null);
          }
        } catch (err: any) {
          console.error('清除本機紀錄失敗', err);
          showAlert('清除失敗', `部分紀錄可能沒有被刪除（${errorText(err)}）。重新整理後再看一次實際結果。`);
        }
      }
    });
  };

  const showLocalEditNotice = () =>
    showAlert(
      '本機紀錄不能編輯',
      '這筆只存在這台瀏覽器，內容唯讀。搬到伺服器之後才能編輯逐字稿與會議記錄。'
    );

  // 409 是「正在跑，等它結束或失敗再刪」，server 那句話講了為什麼不能刪、什麼時候可以刪。
  // 套 translateError 會把它歸到「【處理失敗】」去，那句話就沒了
  const deleteFailureMessage = (err: any): string =>
    err instanceof HttpError && err.status === 409 ? err.message : translateError(errorText(err));

  const handleDeleteMeeting = (meetingId: string) => {
    const isRecording = (meetings ?? []).some(m => m.meeting_id === meetingId && m.status === 'RECORDING');
    setConfirmConfig({
      isOpen: true,
      title: '刪除這場會議',
      message: isRecording
        ? '這場會議還在錄音。刪除會先叫語音備忘錄停止錄音，再刪掉這場會議；語音備忘錄裡已經錄下的那支不會被刪。'
        : '確定要從任務清單刪除這場會議嗎？這個動作無法復原：伺服器上的逐字稿、分析與音檔都會一起刪掉；vault 裡的會議記錄副本不受影響。',
      isDestructive: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          await deleteMeeting(meetingId);
          if (selection !== null && selection.source === 'server' && selection.id === meetingId) {
            selectRecord(null);
          }
          await refreshMeetings();
        } catch (err: any) {
          console.error('刪除會議失敗', err);
          showAlert('沒有刪除這場會議', deleteFailureMessage(err));
        }
      }
    });
  };

  const handleClearFinishedMeetings = () => {
    const finished = (meetings ?? []).filter(m => !isMeetingInProgress(m));
    if (finished.length === 0) return;

    setConfirmConfig({
      isOpen: true,
      title: '清除已結束的會議',
      message: `確定要從任務清單刪除這 ${finished.length} 場已結束或失敗的會議嗎？這個動作無法復原：伺服器上的逐字稿、分析與音檔都會一起刪掉；vault 裡的會議記錄副本不受影響。`,
      isDestructive: true,
      onConfirm: async () => {
        closeConfirm();
        setBusyMessage(`正在刪除 ${finished.length} 場會議…`);
        // 逐筆記下失敗的那幾場。中途壞掉就整批當成功，使用者會以為清乾淨了，
        // 下次看到那幾場還在只會覺得是 bug
        const failures: string[] = [];
        for (const meeting of finished) {
          try {
            await deleteMeeting(meeting.meeting_id);
          } catch (err: any) {
            console.error('刪除會議失敗', meeting.meeting_id, err);
            failures.push(`${meeting.source_file_name ?? meeting.meeting_id}：${deleteFailureMessage(err)}`);
          }
        }
        setBusyMessage(null);
        await refreshMeetings();
        if (failures.length > 0) {
          showAlert(
            '有幾場沒有刪掉',
            `已刪除 ${finished.length - failures.length} 場，以下 ${failures.length} 場還在：\n`
            + failures.map(f => `・${f}`).join('\n')
          );
        }
      }
    });
  };

  /**
   * JobDetail 的編輯寫回 server。
   *
   * 寫完重新拉一次 detail，不只更新本地 state：畫面上顯示的要是 server 真的存下來的東西，
   * 不是前端以為它存進去的東西。
   */
  const handleUpdateActiveMeeting = async (updates: Partial<Job>) => {
    if (selection === null || selection.source !== 'server') {
      showLocalEditNotice();
      return;
    }
    const meetingId = selection.id;

    // 手上這份 detail 必須就是選中那場的。切會議時舊請求晚回來的路徑已經在 loadDetailForSelection
    // 擋掉了，這裡是第二道：拿 A 的 analysis 去接 B 的 metadata 不會有任何錯誤訊息
    if (activeDetail !== null && activeDetail.meeting.meeting_id !== meetingId) {
      showAlert('沒有存檔', '畫面上的內容還在切換中，為了不把別場會議的資料寫進來，這次沒有送出。請再試一次。');
      return;
    }

    const blocked = activeDetail === null ? null : editBlockedReason(activeDetail.meeting.status);
    if (blocked !== null) {
      showAlert('現在不能存檔', blocked);
      return;
    }

    setBusyMessage('正在儲存…');
    try {
      if (updates.transcript !== undefined) {
        await patchTranscript(meetingId, { segments: updates.transcript });
      }
      if (updates.polishedContent !== undefined) {
        await patchTranscript(meetingId, { polished_content: updates.polishedContent });
      }
      if (updates.analysis !== undefined) {
        // v3 每筆自帶 metadata（evidence、decided_by、assignee、created_at…），
        // SummaryView 編輯的就是這份物件，直接送出即可，不用像 v1 字串那樣猜哪一筆是哪一筆
        await patchAnalysis(meetingId, updates.analysis);
      }
      if (updates.title !== undefined) {
        await patchTitle(meetingId, updates.title);
      }
      await refreshActiveDetail(meetingId);
      await refreshMeetings();
    } catch (err: any) {
      console.error('寫回會議內容失敗', err);
      showAlert('儲存失敗', translateError(errorText(err)));
    } finally {
      setBusyMessage(null);
    }
  };

  /**
   * 一鍵確認 needs_review 的人名（人名校正 N5）。跟 handleUpdateActiveMeeting 同一個理由，
   * 寫完重新拉一次 detail：確認會連動改到 analysis 的 decided_by_employee_id／
   * assignee_employee_id，不只是 nameMentions 清單變短，畫面要反映 server 真的存下來的樣子。
   */
  const handleConfirmNameMention = async (segmentIndex: number, originalText: string, employeeId: string) => {
    if (selection === null || selection.source !== 'server') return;
    const meetingId = selection.id;
    try {
      await confirmNameMention(meetingId, segmentIndex, originalText, employeeId);
      await refreshActiveDetail(meetingId);
    } catch (err: any) {
      console.error('確認人名失敗', err);
      showAlert('確認失敗', translateError(errorText(err)));
    }
  };

  const downloadLocalAudio = async (target: AudioBackupTarget) => {
    try {
      const blob = await getFileBlob(target.meetingId);
      if (blob === null) {
        showAlert('這個音檔已經不在瀏覽器裡', `找不到「${target.fileName}」的音檔，它可能已經被清掉了。`);
        return;
      }
      // 走 exportUtils 那支共用的：anchor 要掛進 DOM、revoke 要延到下一個 tick 之後，
      // 理由寫在那邊。這條是本機音檔唯一的出口，不能自己再寫一份比較樂觀的版本
      downloadBlob(blob, target.fileName);
    } catch (err: any) {
      console.error('讀取本機音檔失敗', err);
      showAlert('下載失敗', `讀不到「${target.fileName}」的音檔（${errorText(err)}）。`);
    }
  };

  const dashboard = buildDashboardView(meetings, serverError, localJobs);
  // 正在錄的那一場。findRecordingMeeting 遇到兩場同時在錄會拋錯（不挑一場去停），
  // 在這裡接住變成橫幅，不讓整個畫面因此掛掉
  let recordingMeeting: MeetingView | null = null;
  let recordingConflict: string | null = null;
  try {
    recordingMeeting = findRecordingMeeting(meetings);
  } catch (err: any) {
    recordingConflict = errorText(err);
  }
  const canStartRecording = recordingAvailability !== null && recordingAvailability.available === true
    && recordingMeeting === null && recordingConflict === null;
  const recordingElapsed = recordingMeeting !== null && recordingMeeting.recording_started_at !== null
    ? formatRecordingElapsed(recordingMeeting.recording_started_at, now)
    : null;
  const activeMeeting = activeDetail === null ? null : activeDetail.meeting;
  const activeEditBlockedReason = activeMeeting === null ? null : editBlockedReason(activeMeeting.status);
  const activeNeedsAudio = activeMeeting !== null && needsAudioUpload(activeMeeting);
  const activeSection = selection === null
    ? undefined
    : dashboard.sections.find(s => s.key === selection.source);
  const listJob = selection === null
    ? undefined
    : activeSection?.jobs.find(j => j.id === selection.id);
  // server 的會議優先顯示 detail（有逐字稿與分析）；detail 還在讀或讀失敗時先顯示清單那一份，
  // 讀失敗這件事由上方橫幅明講，不靠「看起來正常的畫面」蓋過去
  const activeJob: Job | null = selection === null
    ? null
    : (selection.source === 'server' ? (activeServerJob ?? listJob ?? null) : (listJob ?? null));

  // 整頁拖曳上傳（AC-6）：跟按鈕走同一條 addMeeting → submitAudioFile 路徑，
  // 不是另外重寫一次上傳邏輯
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    // 一定要擋掉：瀏覽器預設行為是離開這個分頁去開啟檔案，不擋的話 drop 事件永遠不會觸發
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    // 跟 handleDragEnter 同一套判準：拖曳頁面上的文字選取也會觸發 drop 事件，
    // 但 dataTransfer.types 不含 'Files'，不該當成「拖錯檔案」跳錯誤視窗
    if (!e.dataTransfer.types.includes('Files')) return;
    const pick = pickDroppedAudioFile(e.dataTransfer.files, Array.from(e.dataTransfer.types));
    // 明寫 `=== false` 而不是 `!pick.ok`：tsconfig 沒開 strict，`!pick.ok` 這種寫法在這個 repo
    // 收斂不到 { ok: false; reason } 那一側（同樣的坑見 meetingAdapter.ts／meetingEdits.ts）
    if (pick.ok === false) {
      showAlert('無法建立任務', pick.reason);
      return;
    }
    addMeeting(pick.file);
  };

  return (
    <div
      className="h-screen bg-slate-50 flex flex-col antialiased overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-indigo-600/90 flex flex-col items-center justify-center text-white pointer-events-none">
          <i className="fa-solid fa-cloud-arrow-up text-5xl mb-4"></i>
          <p className="text-xl font-bold">放開就建立任務</p>
          <p className="text-sm text-indigo-100 mt-1">支援音訊與影片檔</p>
        </div>
      )}
      <header className="h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between sticky top-0 z-30 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-9 h-9 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-indigo-600 flex items-center justify-center transition-colors"
            title={isSidebarOpen ? "收合側邊欄" : "展開側邊欄"}
          >
             <i className={`fa-solid ${isSidebarOpen ? 'fa-chevron-left' : 'fa-bars'} text-sm`}></i>
          </button>
          
          <button
            onClick={() => selectRecord(null)}
            className="flex items-center gap-2 select-none rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-slate-100 transition-colors"
            title="回首頁"
          >
            <div className="bg-indigo-600 text-white w-8 h-8 rounded-lg flex items-center justify-center shadow-md shadow-indigo-100">
              <i className="fa-solid fa-microphone-lines text-sm"></i>
            </div>
            <span className="text-sm font-bold text-slate-900 hidden sm:inline">WhisperX & Gemini Hub</span>
          </button>
        </div>
        
        <div className="flex items-center gap-3">
          {busyMessage && (
            <span className="text-xs text-indigo-600 font-bold flex items-center gap-2">
              <i className="fa-solid fa-circle-notch fa-spin"></i>
              {busyMessage}
            </span>
          )}
          {recordingOp && (
            <span className="text-xs text-rose-600 font-bold flex items-center gap-2">
              <i className="fa-solid fa-circle-notch fa-spin"></i>
              {recordingOp}
            </span>
          )}
          {recordingMeeting !== null && (
            <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-xl pl-3 pr-1 h-10">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
              <button
                onClick={() => selectRecord({ source: 'server', id: recordingMeeting.meeting_id })}
                className="text-xs font-bold text-rose-700 tabular-nums"
                title="看這場會"
              >
                錄音中 {recordingElapsed}
              </button>
              <button
                onClick={() => handleStopRecording(recordingMeeting.meeting_id)}
                disabled={recordingOp !== null}
                className="h-8 px-3 bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300 text-white text-xs font-bold rounded-lg flex items-center gap-1 transition-colors"
              >
                <i className="fa-solid fa-stop"></i>
                停止錄音
              </button>
            </div>
          )}
          {canStartRecording && (
            <button
              onClick={() => setPendingNew({ kind: 'recording' })}
              disabled={busyMessage !== null || recordingOp !== null}
              className="h-10 px-4 bg-white hover:bg-rose-50 border border-rose-200 text-rose-600 disabled:opacity-50 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors"
              title="用這台 Mac 的語音備忘錄錄音，停止後自動送進轉錄"
            >
              <i className="fa-solid fa-microphone"></i>
              開始錄音
            </button>
          )}
          <FileUpload onFileSelect={addMeeting} onRejected={(reason) => showAlert('無法建立任務', reason)} />
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        <aside
          className={`
            bg-white border-r border-slate-200 h-full relative z-20
            transition-all duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]
            ${isSidebarOpen ? 'w-80 opacity-100' : 'w-0 opacity-0 overflow-hidden'}
          `}
        >
          <div className="w-80 h-full flex flex-col">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-bold text-slate-800">最近紀錄</h2>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"
                title="收合側邊欄"
              >
                <i className="fa-solid fa-chevron-left"></i>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
              {dashboard.serverNotice && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-[11px] leading-relaxed p-3 rounded-lg">
                  <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                  {dashboard.serverNotice}
                </div>
              )}

              {dashboard.sections.map(section => (
                <section key={section.key} className="flex flex-col gap-2">
                  <div className={`rounded-lg px-3 py-2 ${
                    section.key === 'local' ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50 border border-slate-200'
                  }`}>
                    <h3 className={`text-xs font-bold flex items-center gap-2 ${
                      section.key === 'local' ? 'text-amber-800' : 'text-slate-700'
                    }`}>
                      <i className={`fa-solid ${section.key === 'local' ? 'fa-hard-drive' : 'fa-server'}`}></i>
                      {section.title}（{section.jobs.length}）
                    </h3>
                    <p className={`text-[10px] leading-relaxed mt-1 ${
                      section.key === 'local' ? 'text-amber-700' : 'text-slate-500'
                    }`}>
                      {section.hint}
                    </p>
                    {section.key === 'local' && (
                      <button
                        onClick={handleMigrate}
                        disabled={busyMessage !== null}
                        className="mt-2 w-full bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white text-[11px] font-bold px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <i className="fa-solid fa-upload mr-1"></i>
                        把這 {section.jobs.length} 筆搬到伺服器
                      </button>
                    )}
                    {section.key === 'local' && audioBackupTargets.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-amber-200">
                        <p className="text-[10px] text-amber-800 font-bold leading-relaxed">
                          <i className="fa-solid fa-circle-exclamation mr-1"></i>
                          這 {audioBackupTargets.length} 場沒搬成功，音檔只剩這台瀏覽器這一份。
                          清掉瀏覽器資料之前先存下來。
                        </p>
                        <ul className="mt-1.5 flex flex-col gap-1">
                          {audioBackupTargets.map(target => (
                            <li key={target.meetingId} className="flex items-center justify-between gap-2">
                              <span className="text-[10px] text-amber-900 truncate flex-1" title={target.fileName}>
                                {target.fileName}
                              </span>
                              <button
                                onClick={() => downloadLocalAudio(target)}
                                className="shrink-0 bg-white hover:bg-amber-100 border border-amber-300 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded transition-colors"
                              >
                                <i className="fa-solid fa-download mr-1"></i>
                                下載音檔
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <JobDashboard
                    jobs={section.jobs}
                    activeJobId={selection !== null && selection.source === section.key ? selection.id : null}
                    onSelectJob={(id) => selectRecord({ source: section.key, id })}
                    onDeleteJob={section.key === 'local' ? handleDeleteLocalJob : handleDeleteMeeting}
                    onRetry={section.key === 'local' ? showLocalRetryNotice : handleRetryMeeting}
                    onClearAllFinished={section.key === 'local'
                      ? handleClearFinishedLocalJobs
                      : handleClearFinishedMeetings}
                  />
                </section>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex-1 min-w-0 flex flex-col h-full bg-slate-50 relative">
          <div className="flex-1 p-0 sm:p-4 h-full overflow-hidden flex flex-col">
            <div className="w-full flex-1 bg-white sm:rounded-2xl border-x sm:border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              {recordingConflict !== null && (
                <div className="bg-rose-50 border-b border-rose-200 text-rose-700 text-xs p-3 shrink-0">
                  <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                  {recordingConflict}。請到語音備忘錄確認實際在錄的是哪一支，再刪掉多出來的那場會議。
                </div>
              )}
              {activeMeeting !== null && activeMeeting.status === 'RECORDING' && (
                <div className="bg-rose-50 border-b border-rose-200 text-rose-900 text-xs p-3 shrink-0 flex flex-wrap items-center gap-3">
                  <span className="flex-1 min-w-[12rem] leading-relaxed">
                    <i className="fa-solid fa-microphone mr-1"></i>
                    語音備忘錄正在錄這場會{recordingElapsed !== null && `（${recordingElapsed}）`}。
                    錄音在語音備忘錄裡，關掉這個分頁或重新整理都不會中斷；按「停止錄音」會自動取回檔案開始轉錄。
                    筆電闔上或睡眠會不會中斷錄音還沒驗證過，開會時先讓筆電保持開著。
                  </span>
                  <button
                    onClick={() => handleStopRecording(activeMeeting.meeting_id)}
                    disabled={recordingOp !== null}
                    className="shrink-0 bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <i className="fa-solid fa-stop mr-1"></i>
                    停止錄音
                  </button>
                </div>
              )}
              {detailError && (
                <div className="bg-rose-50 border-b border-rose-200 text-rose-700 text-xs p-3 shrink-0">
                  <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                  讀取會議內容失敗（{detailError}）。下面是清單上的摘要，逐字稿與會議記錄暫時讀不到。
                </div>
              )}
              {activeNeedsAudio && (
                <div className="bg-indigo-50 border-b border-indigo-200 text-indigo-900 text-xs p-3 shrink-0 flex flex-wrap items-center gap-3">
                  <span className="flex-1 min-w-[12rem] leading-relaxed">
                    <i className="fa-solid fa-circle-info mr-1"></i>
                    這場會議已經建立，但伺服器上還沒有音檔（多半是上次上傳中斷）。
                    補上音檔就會從頭開始跑，不用重新建立一場。
                  </span>
                  <label className="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg cursor-pointer transition-colors">
                    <i className="fa-solid fa-cloud-arrow-up mr-1"></i>
                    補上音檔
                    <input
                      type="file"
                      accept="audio/*,video/*,.mov,.m4a,.mp4,.mp3,.wav,.webm"
                      className="hidden"
                      disabled={busyMessage !== null}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // 對既有的 meeting_id 補送，不走建立新會議那條
                        if (file && activeMeeting) submitAudioFile(file, activeMeeting.meeting_id);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              )}
              {activeEditBlockedReason !== null && (
                <div className="bg-slate-100 border-b border-slate-300 text-slate-700 text-xs p-3 shrink-0">
                  <i className="fa-solid fa-lock mr-1"></i>
                  {activeEditBlockedReason}
                </div>
              )}
              {selection !== null && selection.source === 'local' && (
                <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs p-3 shrink-0">
                  <i className="fa-solid fa-hard-drive mr-1"></i>
                  這是只存在本機瀏覽器、尚未搬到伺服器的舊紀錄，內容唯讀。
                </div>
              )}
              {activeJob ? (
                <div className="flex-1 overflow-y-auto">
                  <JobDetail
                    job={activeJob}
                    onUpdateJob={handleUpdateActiveMeeting}
                    onAlert={showAlert}
                    onRetry={selection !== null && selection.source === 'server'
                      ? handleRetryMeeting
                      : showLocalRetryNotice}
                    participants={selection !== null && selection.source === 'server' && activeDetail !== null
                      ? (people ?? []).filter((p) => activeDetail.participantIds.includes(p.employeeId))
                      : []}
                    nameMentions={selection !== null && selection.source === 'server' && activeDetail !== null
                      ? activeDetail.nameMentions
                      : []}
                    onConfirmNameMention={handleConfirmNameMention}
                  />
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50">
                  <div className="w-20 h-20 bg-indigo-100 text-indigo-600 rounded-3xl flex items-center justify-center mb-6 shadow-sm">
                    <i className="fa-solid fa-microphone-lines text-3xl"></i>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800 mb-2 tracking-tight">準備就緒</h2>
                  <p className="text-slate-500 max-w-sm mb-8 leading-relaxed text-sm">
                    上傳音檔後由伺服器轉錄與分析，這個分頁可以關掉，處理不會中斷。
                  </p>
                  <FileUpload
                    onFileSelect={addMeeting}
                    onRejected={(reason) => showAlert('無法建立任務', reason)}
                    variant="zone"
                  />
                  {canStartRecording && (
                    <button
                      onClick={() => setPendingNew({ kind: 'recording' })}
                      disabled={busyMessage !== null || recordingOp !== null}
                      className="mt-4 w-full max-w-md bg-white hover:bg-rose-50 border-2 border-rose-200 hover:border-rose-400 text-rose-600 disabled:opacity-50 rounded-2xl px-8 py-5 flex flex-col items-center gap-1 transition-colors"
                    >
                      <span className="text-sm font-bold"><i className="fa-solid fa-microphone mr-2"></i>開始錄音</span>
                      <span className="text-xs text-slate-500">用這台 Mac 的語音備忘錄錄，停止後自動送進轉錄</span>
                    </button>
                  )}
                  {recordingAvailability !== null && recordingAvailability.available === false && (
                    <p className="mt-4 max-w-md text-[11px] text-slate-400 leading-relaxed">
                      <i className="fa-solid fa-microphone-slash mr-1"></i>
                      語音備忘錄錄音目前不能用：{recordingAvailability.reason}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <ConfirmModal
        isOpen={confirmConfig.isOpen}
        title={confirmConfig.title}
        message={confirmConfig.message}
        onConfirm={confirmConfig.onConfirm}
        isDestructive={confirmConfig.isDestructive}
        hideCancel={confirmConfig.hideCancel}
        onCancel={closeConfirm}
      />

      <ParticipantPicker
        isOpen={pendingNew !== null}
        confirmVerb={pendingNew !== null && pendingNew.kind === 'recording' ? '開始錄音' : '建立會議'}
        people={people}
        loadError={peopleLoadError}
        onRetry={loadPeople}
        onConfirm={handleConfirmParticipants}
        onCancel={handleCancelParticipants}
      />
    </div>
  );
};

export default App;

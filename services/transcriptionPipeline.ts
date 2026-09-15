/**
 * 一場會從音檔到 READY 的整條鏈（W2 T1，SDD 1.1、1.4）。
 *
 * 這條鏈原本跑在瀏覽器分頁裡（App.tsx 的 processJob）。搬到 server 有兩個各自獨立的理由：
 * 一是分頁關掉、換一台機器，那場會就不見了；二是前端的切片方式吃滿記憶體，
 * 106 分鐘的會直接讓分頁崩潰（見 audioSlicer.ts 檔頭）。
 *
 * 續傳游標是 `meetings.processed_slices`，逐字稿與游標同一個交易寫下去
 * （見 meetingStore.saveTranscriptProgress）。狀態走
 * `TRANSCRIBING → ANALYZING → READY`，音檔在**分析成功之後**才刪；
 * 任何一段失敗都落到 `FAILED` 並保留音檔，重跑才有東西可跑。
 */
import { TranscriptSegment } from '../types';
import { upgradeAnalysisToV2 } from './analysisContract';
import { AudioFileStore } from './audioFileStore';
import { AudioSlicer, planSlices } from './audioSlicer';
import { GeminiServerClient } from './geminiServerClient';
import { MeetingStore } from './meetingStore';
import { SLICE_OVERLAP_SECONDS, mergeSliceTranscript } from './transcriptMerge';

/** 一片 10 分鐘，與搬家前瀏覽器那套的 sliceDurationMin = 10 一致 */
export const SLICE_DURATION_SECONDS = 10 * 60;

/** 合併時容許的時間誤差，沿用搬家前傳給 mergeSliceTranscript 的值 */
const MERGE_TOLERANCE_SECONDS = 0.5;

export interface TranscriptionPipelineDeps {
  store: MeetingStore;
  audioStore: AudioFileStore;
  slicer: AudioSlicer;
  gemini: GeminiServerClient;
  /** 測試注入用；正式呼叫不要傳 */
  now?: () => number;
}

/**
 * 給下一片的前文。
 *
 * 切片開頭常常接在一句話中間，沒有前文時 Gemini 會把同一個人當成新的 Speaker。
 * 取最後 10 句再截尾 1000 字，跟搬家前 App.tsx 的規則一樣——改動這裡等於改了
 * 轉錄結果，而那種差異不會有錯誤，只會讓講者編號在片與片之間跳掉。
 */
export function buildPreviousContext(transcript: readonly TranscriptSegment[]): string {
  if (transcript.length === 0) return '';
  return transcript
    .slice(-10)
    .map(s => `${s.speaker || 'Unknown'}: ${s.text}`)
    .join('\n')
    .slice(-1000);
}

export function createTranscriptionPipeline(deps: TranscriptionPipelineDeps) {
  const { store, audioStore, slicer, gemini } = deps;
  const now = deps.now ?? (() => Date.now());

  const transcribe = async (meetingId: string): Promise<void> => {
    const audioPath = audioStore.pathFor(meetingId);
    if (!audioStore.exists(meetingId)) {
      throw new Error(`Meeting ${meetingId} 的音檔不在 ${audioPath}，無法轉錄`);
    }

    const totalDurationSeconds = await slicer.probeDurationSeconds(audioPath);
    const plan = planSlices(totalDurationSeconds, SLICE_DURATION_SECONDS, SLICE_OVERLAP_SECONDS);

    const existing = store.getTranscript(meetingId);
    // 已經跑過的片數。從 0 重跑會把同一段內容再合併一次，而 mergeSliceTranscript
    // 只擋 overlap 區，擋不住整片重複
    const processedSlices = store.getMeeting(meetingId)?.processed_slices ?? 0;
    const polishedContent = existing?.polished_content ?? null;
    let transcript: TranscriptSegment[] = existing?.segments ?? [];

    store.setSliceProgress(meetingId, processedSlices, plan.length, now());

    for (const slice of plan) {
      if (slice.index < processedSlices) continue;

      const wav = await slicer.readSlice(audioPath, slice.startSeconds, slice.durationSeconds);
      const segments = await gemini.transcribeSlice({
        base64Data: wav.toString('base64'),
        offsetSeconds: slice.startSeconds,
        previousContext: buildPreviousContext(transcript),
        mimeType: 'audio/wav',
        sliceDurationSeconds: slice.durationSeconds,
      });

      transcript = mergeSliceTranscript(
        transcript,
        segments,
        slice.startSeconds,
        slice.index === 0,
        MERGE_TOLERANCE_SECONDS,
        SLICE_OVERLAP_SECONDS,
      );

      store.saveTranscriptProgress(
        meetingId,
        { segments: transcript, polished_content: polishedContent },
        slice.index + 1,
        plan.length,
        now(),
      );
    }
  };

  const analyze = async (meetingId: string): Promise<void> => {
    const meeting = store.getMeeting(meetingId);
    if (!meeting) throw new Error(`找不到 Meeting ${meetingId}`);

    const transcript = store.getTranscript(meetingId);
    if (!transcript || transcript.segments.length === 0) {
      // 每一片都轉完了卻一個字都沒有。硬送去分析會拿到一份憑空生出來的摘要，
      // 那比直接失敗難查得多
      throw new Error(`Meeting ${meetingId} 的每一片都沒有轉出內容，不進分析`);
    }

    const v1 = await gemini.analyzeTranscript({
      transcript: transcript.segments,
      meetingTags: store.getTags(meetingId),
      meetingContext: meeting.meeting_context ?? '',
    });
    store.saveAnalysis(meetingId, upgradeAnalysisToV2(v1, meetingId, now()), now());
  };

  const markFailed = (meetingId: string, reason: string, cause: unknown): void => {
    try {
      store.setStatus(meetingId, 'FAILED', now(), reason);
    } catch (saveErr) {
      // 標記失敗的那次寫入自己也失敗（資料庫被鎖、檔案不可寫）。兩個錯誤都要留下來：
      // 只印後者的話，原本壞在哪就沒有任何痕跡，而那場會還停在 TRANSCRIBING 看起來像在跑
      console.error(`[Transcription] Meeting ${meetingId} 標記 FAILED 時寫入失敗`, { cause, saveErr });
    }
  };

  return {
    /**
     * 跑完一場會。呼叫端是佇列，所以這裡不併發、不重入。
     * 失敗時先把狀態寫成 FAILED 再往上拋：狀態要落地，但錯誤不吞。
     */
    run: async (meetingId: string): Promise<void> => {
      const meeting = store.getMeeting(meetingId);
      if (!meeting) throw new Error(`找不到 Meeting ${meetingId}`);
      // CREATED 是新上傳或重跑，TRANSCRIBING 是 server 重啟後的續傳。其餘狀態代表
      // 這場會已經走過去了，重跑會把既有結果蓋掉
      if (meeting.status !== 'CREATED' && meeting.status !== 'TRANSCRIBING') {
        throw new Error(`Meeting ${meetingId} 目前是 ${meeting.status}，不是可以開始轉錄的狀態`);
      }

      try {
        if (meeting.status === 'CREATED') store.setStatus(meetingId, 'TRANSCRIBING', now());
        await transcribe(meetingId);

        store.setStatus(meetingId, 'ANALYZING', now());
        await analyze(meetingId);

        store.setStatus(meetingId, 'READY', now());

        // 音檔到這裡才刪。轉錄成功就刪的話，分析失敗的那場會再也重跑不了。
        // 刪不掉（EPERM、EBUSY）只記 log 不改狀態：狀態已經是 READY、結論已經落地，
        // 讓它被外層 catch 接住會把一場成功的會標成 FAILED，那是謊報。
        // 留一個孤兒音檔比謊報失敗好，而且啟動掃描看得到它佔著空間
        try {
          audioStore.remove(meetingId);
        } catch (removeErr) {
          console.error(
            `[Transcription] Meeting ${meetingId} 已經 READY，但音檔刪不掉（${audioStore.pathFor(meetingId)}），請手動清理：`,
            removeErr,
          );
        }
      } catch (err) {
        markFailed(meetingId, err instanceof Error ? err.message : String(err), err);
        throw err;
      }
    },
  };
}

export type TranscriptionPipeline = ReturnType<typeof createTranscriptionPipeline>;

export interface ResumeScanReport {
  requeued: string[];
  failed: { meetingId: string; reason: string }[];
  /** CREATED 但音檔不在：還沒開始跑，等使用者上傳，狀態維持 CREATED */
  waitingForAudio: string[];
}

/**
 * server 啟動時掃一次沒跑完的會（SDD 1.4）。
 *
 * 佇列在記憶體裡，server 一重啟就空了。資料庫裡停在 TRANSCRIBING 的那幾場不會有人再碰它們，
 * 畫面上卻永遠顯示「轉錄中」——那是最難發現的一種壞法，因為它看起來正常。
 *
 * 音檔還在就重新入列（從 processed_slices 續傳）。音檔不在時分兩種：TRANSCRIBING 是真的斷在
 * 半路，轉 FAILED 並寫下原因，不留在 TRANSCRIBING 假裝還在跑；CREATED 還沒開始跑，維持原狀等上傳。
 */
export function requeueInterruptedMeetings(options: {
  store: MeetingStore;
  audioStore: AudioFileStore;
  enqueue: (meetingId: string) => void;
  now?: () => number;
}): ResumeScanReport {
  const { store, audioStore, enqueue } = options;
  const now = options.now ?? (() => Date.now());
  const report: ResumeScanReport = { requeued: [], failed: [], waitingForAudio: [] };

  for (const meeting of store.listMeetings()) {
    if (meeting.status !== 'TRANSCRIBING' && meeting.status !== 'CREATED') continue;

    const meetingId = meeting.meeting_id;
    let reason: string | null = null;
    try {
      if (audioStore.exists(meetingId)) {
        // 這裡不清游標。CREATED ＋ 音檔在有兩種來源，掃描分不出來：一種是剛上傳完的新檔
        // （游標已經在收檔前清掉了，見 createApp 的 PUT audio），另一種是 retry 之後
        // 佇列還忙、輪不到它的那場會——後者的游標是**刻意保留**的，清掉等於讓 retry 退化成
        // 整場重轉，連使用者 retry 前人工修過的逐字稿也一起消失
        enqueue(meetingId);
        report.requeued.push(meetingId);
        continue;
      }
      reason = `server 重啟時音檔已經不在（${audioStore.pathFor(meetingId)}），無法續傳，請重新上傳這場會的音檔`;
    } catch (err) {
      // pathFor 對不合法的 meeting_id 會拋錯（搬過來的舊資料可能有奇怪的 id）。
      // 那代表這場會根本沒有可用的音檔路徑，原因照樣要寫下去
      reason = `無法判斷音檔位置：${err instanceof Error ? err.message : String(err)}`;
    }

    // CREATED 且音檔不在的留在 CREATED，不轉 FAILED。它根本還沒開始跑，狀態是對的：
    // 建立完還沒上傳、上傳失敗、上傳到一半重啟（只剩 .part）都會落在這裡。
    // 轉成 FAILED 反而是死路——PUT audio 只收 CREATED、retry 又要求音檔在，兩條路一起被擋死，
    // 使用者只能刪掉重建。留在 CREATED 的話重送一次音檔就能繼續。
    if (meeting.status === 'CREATED') {
      report.waitingForAudio.push(meetingId);
      continue;
    }

    store.setStatus(meetingId, 'FAILED', now(), reason);
    report.failed.push({ meetingId, reason });
  }

  return report;
}

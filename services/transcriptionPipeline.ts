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
import { buildAnalysisV3FromModelOutput } from './analysisContract';
import { AudioFileStore } from './audioFileStore';
import { AudioSlicer, planSlices } from './audioSlicer';
import { GeminiServerClient } from './geminiServerClient';
import { MeetingStore } from './meetingStore';
import { checkMeetingTitle } from './meetingTitle';
import { NameResolver } from './nameResolver';
import { PeopleStore } from './peopleStore';
import { SeamReportEntry } from './meetingApi';
import { DEFAULT_SEAM_REPAIR, RepairResult, SeamRepairConfig, repairSeamGap } from './seamRepair';
import { TopicExtractor } from './topicExtractor';
import { TopicLinker } from './topicLinker';
import { SLICE_OVERLAP_SECONDS, mergeSliceTranscript } from './transcriptMerge';
import { runProjection, VaultProjector } from './vaultProjector';

/** 一片 10 分鐘，與搬家前瀏覽器那套的 sliceDurationMin = 10 一致 */
export const SLICE_DURATION_SECONDS = 10 * 60;


export interface TranscriptionPipelineDeps {
  store: MeetingStore;
  /**
   * 人員名單（人名校正 N3）。轉錄與分析呼叫靠它把與會者姓名塞進提示，見 resolveParticipantNames。
   * **型別上是 optional／nullable，但跟 `vaultProjector` 同一個理由**：不是使用者可關的功能開關，
   * `server.ts` 一律建一個真的；optional 只是為了讓不驗證人名提示的既有測試不用注入一個真的
   */
  peopleStore?: PeopleStore | null;
  /**
   * 人名校正第 2 層（N4，SDD 1.3.2）。轉錄完成、分析之前的確定性比對，插在 `analyze()`
   * 讀到逐字稿之後、送進 `analyzeTranscript` 之前。**型別上是 optional／nullable，跟
   * `peopleStore` 同一個理由**：`server.ts` 一律建一個真的，optional 只是為了讓不驗證
   * 人名比對的既有測試不用注入一個真的。比對邏輯本身失敗時這裡接住，讓整場會照舊用
   * 原始逐字稿分析、`decided_by_employee_id`／`assignee_employee_id` 留空，不阻塞這場會
   * 進 READY（同 `topicLinker` 失敗不阻塞可見性的精神）
   */
  nameResolver?: NameResolver | null;
  audioStore: AudioFileStore;
  slicer: AudioSlicer;
  gemini: GeminiServerClient;
  /** 分析成功之後抽題目標籤（W3）。抽不到不影響這場會進 READY，理由見 topicExtractor.ts */
  topicExtractor: TopicExtractor;
  /**
   * 進 READY 之後算跨會議關聯（W4）。**null 是「關聯功能被關掉」**，那時這場會就停在 READY。
   *
   * 停在 READY 而不是 LINKED 或 LINK_FAILED 是刻意的：READY 的意思正是「還沒算關聯」，
   * 而 LINK_FAILED 的意思是「算了、失敗了」。關掉功能不是失敗，寫成失敗會讓畫面上出現
   * 一個不存在的錯誤，也會讓 6.1 的關聯成功率指標被人為關閉污染。
   * 開關本身在 server.ts 解析（SDD 4.2：Recall 要能在不重新部署的情況下停用）。
   */
  topicLinker?: TopicLinker | null;
  /**
   * 投影到 Obsidian vault（W5）。**型別上是 optional／nullable，但不是使用者可關的功能開關**
   * ——跟 `topicLinker` 不同，這裡沒有對應 `MEETPILOT_LINKING` 的 off 選項，`server.ts` 一律建
   * 一個真的。optional 只是為了讓不驗證投影行為的測試不用注入一個真的 VaultProjector。
   */
  vaultProjector?: VaultProjector | null;
  /** 破洞修復的設定。不傳就用預設（開啟、一場會最多 6 次額外轉錄） */
  seamRepair?: SeamRepairConfig;
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

/**
 * 這場會與會者的正名與已知別名，塞進轉錄／分析呼叫的提示（人名校正 N3，SDD 1.3.2 第 1 層）。
 * 沒有與會者（尚未做人名校正的舊資料、或這場會建立時還沒有這個規則）就回空陣列，
 * `geminiServerClient.ts` 收到空陣列時不會改變既有 prompt。
 *
 * 名字集合是「員編本身的正名」聯集「person_aliases 裡的所有別名」：後者在匯入當下
 * 已經含正名的一種寫法（見 rosterImport.ts 的 buildAliasCandidates），這裡仍然兩者都查，
 * 不假設匯入資料一定完整——manual 建立的 Person 可能沒有任何別名。
 */
export function resolveParticipantNames(
  meetingId: string,
  store: Pick<MeetingStore, 'getParticipants'>,
  peopleStore: Pick<PeopleStore, 'getPerson' | 'listAliasesForEmployees'> | null,
): string[] {
  if (!peopleStore) return [];
  const employeeIds = store.getParticipants(meetingId);
  if (employeeIds.length === 0) return [];

  const names = new Set<string>();
  for (const employeeId of employeeIds) {
    const person = peopleStore.getPerson(employeeId);
    if (person) names.add(person.display_name);
  }
  for (const alias of peopleStore.listAliasesForEmployees(employeeIds)) {
    names.add(alias.alias);
  }
  return Array.from(names);
}

export function createTranscriptionPipeline(deps: TranscriptionPipelineDeps) {
  const { store, audioStore, slicer, gemini, topicExtractor } = deps;
  const peopleStore = deps.peopleStore ?? null;
  const nameResolver = deps.nameResolver ?? null;
  const topicLinker = deps.topicLinker ?? null;
  const vaultProjector = deps.vaultProjector ?? null;
  const now = deps.now ?? (() => Date.now());
  const repairConfig = deps.seamRepair ?? DEFAULT_SEAM_REPAIR;

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
    // 續傳時沿用已經記下來的接縫：重跑的那幾片會覆寫自己那幾筆，跑過的不重算
    const seamReport: SeamReportEntry[] = store.getSeamReport(meetingId) ?? [];
    // 額度跨接縫共用。續傳時重新給滿：這一輪是新的一次執行，沿用上一輪的殘額沒有意義
    let repairBudgetLeft = repairConfig.budget;
    // 整場會算一次就好：與會者名單在轉錄過程中不會變，不用每片重查
    const participantNames = resolveParticipantNames(meetingId, store, peopleStore);

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
        participantNames,
        meetingId,
      });

      const merged = mergeSliceTranscript(transcript, segments, slice.startSeconds, slice.index === 0);

      // 接縫對不上代表前一片沒轉完自己的尾巴，中間那段音檔沒有人轉過。
      // 補要趁現在：音檔在分析成功之後就刪了（SDD 1.1），之後永遠補不回來
      let repair: RepairResult | null = null;
      if (merged.seam?.verdict === 'gap') {
        repair = await repairSeamGap(
          transcript,
          segments,
          slice.startSeconds,
          {
            totalDurationSeconds,
            transcribeWindow: async (startSeconds, durationSeconds) => {
              const bridgeWav = await slicer.readSlice(audioPath, startSeconds, durationSeconds);
              return gemini.transcribeSlice({
                base64Data: bridgeWav.toString('base64'),
                offsetSeconds: startSeconds,
                previousContext: buildPreviousContext(transcript),
                mimeType: 'audio/wav',
                sliceDurationSeconds: durationSeconds,
                participantNames,
                meetingId,
              });
            },
          },
          { enabled: repairConfig.enabled, budget: repairBudgetLeft },
        );
        repairBudgetLeft -= repair.attempts;
        transcript = repair.segments;
      } else {
        transcript = merged.segments;
      }

      if (merged.seam) {
        const entry: SeamReportEntry = {
          sliceIndex: slice.index,
          verdict: merged.seam.verdict,
          similarity: Number(merged.seam.similarity.toFixed(3)),
          droppedSegments: merged.seam.duplicateSegments,
          ...(repair
            ? {
                repair: {
                  outcome: repair.outcome,
                  attempts: repair.attempts,
                  ...(repair.bridgeSeconds === undefined ? {} : { bridgeSeconds: repair.bridgeSeconds }),
                },
              }
            : {}),
        };
        // 覆寫同一片的舊紀錄，不要疊上去：續傳會重跑最後一片，push 的話同一片會有兩筆，
        // 而且「有幾個破洞」這個數字會跟著錯
        const at = seamReport.findIndex(e => e.sliceIndex === slice.index);
        if (at >= 0) seamReport[at] = entry; else seamReport.push(entry);
        // 破洞要在當下就講出來。安靜吞掉的話，使用者看到的是一份「看起來完整」的逐字稿，
        // 而音檔在分析成功之後就刪了，事後沒有任何辦法知道少了什麼
        if (merged.seam.verdict === 'gap') {
          const head = `[MeetPilot] Meeting ${meetingId} 第 ${slice.index} 片與前一片接不起來`
            + `（相似度 ${merged.seam.similarity.toFixed(3)}）`;
          if (repair?.outcome === 'repaired') {
            console.warn(`${head}，已用 ${repair.bridgeSeconds} 秒的橋接補回來（送了 ${repair.attempts} 次轉錄）`);
          } else if (repair?.outcome === 'failed') {
            // 這一條是最要緊的：試過、補不回來，那段內容確實不在逐字稿裡
            console.warn(`${head}，補了 ${repair.attempts} 次都接不上：**這兩片之間有一段內容不在逐字稿裡**`);
          } else {
            console.warn(`${head}，沒有嘗試修復（修復關閉或這場會的額度用完）。接縫報告在逐字稿紀錄裡`);
          }
        }
      }

      store.saveTranscriptProgress(
        meetingId,
        { segments: transcript, polished_content: polishedContent },
        slice.index + 1,
        plan.length,
        now(),
      );
      // 每一片都寫：中途失敗時已經知道的接縫要留得下來，不要跟著整輪一起消失
      if (seamReport.length > 0) store.saveSeamReport(meetingId, seamReport);
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

    // 人名校正第 2 層（N4）：轉錄完成、分析之前的確定性比對。raw transcript.segments 不動，
    // analyzeTranscript 讀的是已解析視圖；段落索引不變，所以下面算出處時仍用 raw segments。
    // 比對邏輯本身失敗不阻塞這場會，退回用原始逐字稿分析（同 topicLinker 失敗不阻塞可見性）
    let resolvedSegments = transcript.segments;
    if (nameResolver) {
      try {
        resolvedSegments = nameResolver.resolveTranscript(meetingId, transcript.segments, now()).resolvedSegments;
      } catch (err) {
        console.error(`[Transcription] Meeting ${meetingId} 人名比對失敗，這場會的分析改用原始逐字稿：`, err);
      }
    }

    // 跟上面 resolveTranscript 同一顆風險：peopleStore 的查詢若持續性失敗（例如資料庫壞了），
    // 沒包這層的話上面才剛 catch 住、宣稱「已退回原始逐字稿」，這裡又用同一組查詢再拋一次，
    // 讓整場會還是變 FAILED，「人名相關失敗不阻塞分析」的承諾就沒做到（Codex review 2026-09-21 抓到）
    let participantNames: string[] = [];
    try {
      participantNames = resolveParticipantNames(meetingId, store, peopleStore);
    } catch (err) {
      console.error(`[Transcription] Meeting ${meetingId} 讀與會者名單失敗，分析呼叫不帶人名提示：`, err);
    }

    const output = await gemini.analyzeTranscript({
      transcript: resolvedSegments,
      meetingTags: store.getTags(meetingId),
      meetingContext: meeting.meeting_context ?? '',
      meetingId,
      participantNames,
    });
    let analysis = buildAnalysisV3FromModelOutput(output, transcript.segments, meetingId, now());

    // FN-14：反查 decided_by／assignee 對應的員編（關閉 U-007）。失敗不阻塞分析落地，
    // 兩個欄位就停在 buildAnalysisV3FromModelOutput 給的值（undefined，效果同 null）
    if (nameResolver) {
      try {
        analysis = nameResolver.resolveAnalysisEmployeeIds(analysis, meetingId);
      } catch (err) {
        console.error(`[Transcription] Meeting ${meetingId} 反查決議／待辦的員編失敗：`, err);
      }
    }

    store.saveAnalysis(meetingId, analysis, now());

    // 建議標題只在還沒有的時候填：使用者改過的名字不能被下一次分析洗掉。
    // 模型給的標題不合規則（空、超長、控制字元）時標題留 null 並記 log，不讓這場會 FAILED——
    // 標題是清單裡認得出哪一場的方便，不是分析內容，為它讓使用者重跑整場分析代價不對稱
    if (meeting.title === null) {
      const suggested = checkMeetingTitle(output.title);
      if (suggested.ok === true) {
        store.setTitle(meetingId, suggested.title, now());
      } else {
        console.warn(`[Transcription] Meeting ${meetingId} 的建議標題不可用（${suggested.reason}），標題留空`);
      }
    }
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

        // 題目標籤在進 READY 之前抽（W3）。順序是刻意的：READY 是「這場會可以用了」，
        // 而它可不可以參與關聯是使用者看得到的事實之一，不該在 READY 之後才補上。
        // 這樣一來「READY 但 topic_extraction_status 是 null」只會發生在 W3 之前的舊資料上。
        //
        // extract 自己接住模型的錯誤（記成 failed），所以抽不到不會讓這場會變 FAILED——
        // 分析已經成功了，把它標成失敗是謊報（Q2 裁決）
        await topicExtractor.extract(meetingId);

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

        // 關聯排在最後，而且**不能讓它把這場會拖成 FAILED**（SDD 2.3：關聯失敗不阻塞可見性）。
        // 逐字稿與結論已經落地、音檔已經刪掉，這時把整場會標成失敗是謊報，而且 retry 會從
        // 轉錄從頭跑一遍——音檔已經不在，那條路是死的。
        //
        // linker 自己把狀態推到 LINKED 或 LINK_FAILED，也自己接住模型的錯誤；這裡這層 try
        // 接的是它沒預期到的（例如資料庫寫不進去），一樣只記 log 不往上拋
        if (topicLinker) {
          try {
            await topicLinker.link(meetingId);
          } catch (linkErr) {
            console.error(`[Transcription] Meeting ${meetingId} 的關聯計算拋出預期外的錯誤`, linkErr);
          }
        }

        // 投影排在關聯之後、跟關聯同一條「不能拖累可見性」的原則：結論與關聯（或關聯尚未完成的
        // 事實）都已經落地，vault 寫不進去只記 log，不讓一場成功的會因為檔案系統的問題變成 FAILED
        runProjection(vaultProjector, meetingId, '[Transcription]');
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

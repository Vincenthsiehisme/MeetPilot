/**
 * Express app 的組裝（W2 T1 attempt 4，S7）。
 *
 * 為什麼從 server.ts 抽出來：server.ts 在 import 時就會開資料庫、開 log、listen，
 * 測試根本 import 不了它，所以路由這一層在 412 條測試裡一條都沒被碰到——
 * 「同一場會並行上傳會混成一個檔」就是這樣躲過去的。依賴全部從參數進來之後，
 * 路由可以用假的依賴在記憶體裡跑起來，真實的 middleware 順序也一起被測到。
 *
 * 這個檔只組 app，不碰 process.env（health 那條讀 GEMINI_API_KEY 是既有行為，照搬）、
 * 不 listen、不掛 vite 或靜態檔——那些留在 server.ts。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Meeting } from '../types';
import {
  MeetingView, NameMentionView, RECORDING_CHUNK_MAX_BYTES, RecordingMethod, audioUploadInFlightError, audioUploadQueuedError,
} from './meetingApi';
import { checkBasicAuth, createRateLimiter, describeBodyParserError, isLoopbackAddress, ListenConfig } from './httpGuards';
import { LlmLogger } from './llmTelemetry';
import { MeetingStore } from './meetingStore';
import { PeopleStore } from './peopleStore';
import { NameResolver } from './nameResolver';
import { MigrationRecord, isRejected, toMigrationRecord } from './jobMigration';
import { GeminiServerClient } from './geminiServerClient';
import { AudioFileStore } from './audioFileStore';
import { deleteMeetingRequest, isBusy, patchAnalysisRequest, patchTitleRequest, patchTranscriptRequest } from './meetingEdits';
import { checkMeetingTitle } from './meetingTitle';
import { TopicLinker } from './topicLinker';
import { runProjection, VaultProjector } from './vaultProjector';
import { RecorderTimeoutError, RecordingInfo, VoiceMemoRecorder, checkFetchedRecording } from './voiceMemoRecorder';

/**
 * `createApp` 對「有東西可以入列轉錄」的最小需求，不綁死是舊的記憶體 `TranscriptionQueue`
 * 還是新的 `jobStore`（vault plan「MeetPilot · 轉錄分析佇列架構升級」）——`server.ts` 決定
 * 給哪一個，這裡只用得到這兩個方法。`cancel` 特意不在這裡：舊佇列需要外部明講「這場不用跑了」
 * 才會把記憶體裡的項目清掉；job table 的等價操作是刪 `meetings` 列本身的 cascade，
 * `deleteMeetingRequest` 因此不再需要拿到佇列。
 */
export interface TranscriptionEnqueuer {
  /** 已經在排隊或正在跑的同一場會不重複入列 */
  enqueue(meetingId: string): void;
  /** 這場會在不在佇列裡（排隊中或正在跑）——上傳／刪除擋衝突要用 */
  has(meetingId: string): boolean;
}

/**
 * 跟 `TranscriptionEnqueuer`同形狀，但入列的是分析 job（`POST /retry` 對 `TRANSCRIBED`
 * 的會呼叫）。分開一個型別而不是共用同一個，是因為兩者入列的 job kind 不同，共用型別會讓
 * 呼叫端誤把轉錄佇列傳進分析的位置——名字不同至少讓這種接錯線在讀 server.ts 接線時看得出來。
 */
export interface AnalysisEnqueuer {
  enqueue(meetingId: string): void;
  has(meetingId: string): boolean;
}

export interface AppDeps {
  listenConfig: ListenConfig;
  meetingStore: MeetingStore;
  /** 人員名單（人名校正 N2）。`F-CREATE` 驗證與會者員編要靠它，一期沒有「不需要名單」這個情境，必填 */
  peopleStore: PeopleStore;
  /** 人名比對（人名校正 N4／N5）。跟 peopleStore 同一個理由必填：`needs_review` 確認路由沒有它不成立 */
  nameResolver: NameResolver;
  audioStore: AudioFileStore;
  transcriptionQueue: TranscriptionEnqueuer;
  /**
   * 分析佇列。`POST /retry` 對 `TRANSCRIBED` 的會呼叫這支重新排一次分析——跟轉錄失敗
   * 退回 FAILED 不同，分析失敗退回 TRANSCRIBED 之後沒有自動路徑再排一次，這是唯一的入口
   * （vault plan「MeetPilot · 轉錄分析佇列架構升級」，AC-4）。
   */
  analysisQueue: AnalysisEnqueuer;
  geminiClient: GeminiServerClient;
  llmLogger: LlmLogger;
  /** 跨會議關聯（W4）。null 代表這台 server 把關聯關掉了（`MEETPILOT_LINKING=off`） */
  topicLinker?: TopicLinker | null;
  /** 投影到 Obsidian vault（W5）。跟 topicLinker 不同，這裡沒有對應的 off 開關，見 vaultProjector.ts 檔頭 */
  vaultProjector?: VaultProjector | null;
  /**
   * 叫本機語音備忘錄錄音（vault plan「MeetPilot · 網頁錄音」）。null 代表這台 server 不提供，
   * 錄音路由一律回「不可用」並講原因
   */
  voiceMemoRecorder?: Pick<VoiceMemoRecorder, 'checkAvailability' | 'start' | 'stop' | 'fetchLatestTo' | 'probe'> | null;
  /**
   * 這台 server 用哪一種方式開始新的錄音（`MEETPILOT_RECORDER`）。預設 `voice_memo`（網頁版）；
   * 桌面 app 設 `in_app`，錄音由頁面自己用麥克風錄、分段送上來（vault plan「MeetPilot · 跨平台打包部署」E4）。
   * 只管「開始」：已經在錄的那一場照它開始時的方式收尾，記在 recordings.method
   */
  recordingMethod?: RecordingMethod;
  /**
   * 這個請求是不是從跑 server 的這台機器來（AC-6）。預設看 socket 的來源位址；
   * 測試全部從 127.0.0.1 打進來，注入假的才驗得到「別台電腦」那條
   */
  isLocalRequest?: (req: express.Request) => boolean;
  /**
   * 停止錄音後取檔的重試。語音備忘錄剛停的那一刻檔案可能還沒寫完（m4a 的索引寫在最後），
   * 取到的會是讀不出長度或比實際短的檔；等一下再取通常就好了。測試把間隔設成 0
   */
  recordingFetchPolicy?: { attempts: number; delayMs: number };
}

/** 停止錄音後最多取幾次檔、每次隔多久。4 次 × 1.5 秒是我判的，AC-8 真實錄音時校正 */
const DEFAULT_RECORDING_FETCH_POLICY = { attempts: 4, delayMs: 1500 };

/** 取檔失敗、會議退回 CREATED 時接在原因後面的那句：退路是從語音備忘錄把那支錄音拖進來 */
const RECORDING_FALLBACK_HINT =
  '語音備忘錄裡的錄音沒有被動到。這場會已經退回「等待音檔」，'
  + '從語音備忘錄把這支錄音拖進這個視窗，或用「補上音檔」選檔，就會接著轉錄。';

export function createApp(deps: AppDeps): express.Express {
  const {
    listenConfig, meetingStore, peopleStore, nameResolver, audioStore,
    transcriptionQueue, analysisQueue, geminiClient, llmLogger,
  } = deps;
  const topicLinker = deps.topicLinker ?? null;
  const vaultProjector = deps.vaultProjector ?? null;
  const voiceMemoRecorder = deps.voiceMemoRecorder ?? null;
  const isLocalRequest = deps.isLocalRequest ?? ((req: express.Request) => isLoopbackAddress(req.socket.remoteAddress));
  const recordingFetchPolicy = deps.recordingFetchPolicy ?? DEFAULT_RECORDING_FETCH_POLICY;
  const recordingMethod: RecordingMethod = deps.recordingMethod ?? 'voice_memo';

  /**
   * 正在算關聯的會（W4）。同一場會兩個重算請求同時進來時，第二個回 409。
   *
   * 不靠狀態機擋就夠了嗎？不夠：第一個請求把狀態推成 LINKING 是同步的，但整段計算有很多 await，
   * 而第二個請求讀到 LINKING 之後也會拿到「不是可以算關聯的狀態」——訊息會說成狀態不對，
   * 那是在講結果不是講原因。這個集合讓「已經有人在算」講得出來。
   */
  const linking = new Set<string>();

  /**
   * 回給前端的 Meeting 一律帶 has_audio（契約檔的 MeetingView）。
   *
   * CREATED 現在有兩種完全不同的處境：「建立了等使用者上傳」與「retry 之後在佇列裡排隊」。
   * 前端光看狀態分不出來，而兩者要做的事相反——前者該停下 polling 並提示上傳，後者要繼續等。
   * 搬遷進來的舊 Job 一律是 CREATED 且沒有音檔，不分開的話那個分頁會永遠 polling 下去。
   *
   * 值是「當下看檔案系統」的結果，所以不進 Meeting 那個型別（那是資料庫那一列的形狀）。
   * meeting_id 不合檔名規則時 pathFor 會拋錯，那代表這個 id 不可能有音檔，答案就是 false，
   * 不讓它把整張清單變成 500。
   */
  const toView = (meeting: Meeting): MeetingView => {
    let hasAudio = false;
    try {
      hasAudio = audioStore.exists(meeting.meeting_id);
    } catch {
      hasAudio = false;
    }
    const recording = recordingOf(meeting);
    return {
      ...meeting,
      has_audio: hasAudio,
      recording_started_at: recording?.started_at ?? null,
      recording_method: recording?.method ?? null,
      recording_received_chunks: recording !== null && recording.method === 'in_app' ? recording.received_chunks : null,
    };
  };

  // RECORDING 一定有起訖紀錄：startRecording 在同一個交易裡寫狀態與起訖紀錄。
  // 對不上代表資料庫被別的東西改過，畫面接不回計時、停止時也沒得比對，直接講出來
  const recordingOf = (meeting: Meeting) => {
    if (meeting.status !== 'RECORDING') return null;
    const recording = meetingStore.getRecording(meeting.meeting_id);
    if (!recording) {
      throw new Error(`Meeting ${meeting.meeting_id} 是 RECORDING，但 recordings 沒有它的開始時間`);
    }
    return recording;
  };

  const listNameMentionViews = (meetingId: string): NameMentionView[] => {
    // segment_index 是相對「analyze() 當時讀的那個版本」算的（見 transcriptionPipeline
    // 的 getCurrentTranscript），這裡要用同一個版本查，不能查 raw——版本一旦不同，
    // 索引對到的段落就是錯的
    const transcript = meetingStore.getCurrentTranscript(meetingId);
    return nameResolver.listNeedsReview(meetingId).map((mention) => {
      const segmentText = transcript?.segments[mention.segment_index]?.text;
      if (typeof segmentText !== 'string') {
        throw new Error(
          `Meeting ${meetingId} 的 name_mentions 指向不存在的逐字稿段落 ${mention.segment_index}`,
        );
      }
      return {
        segment_index: mention.segment_index,
        segment_text: segmentText,
        original_text: mention.original_text,
        employee_id: mention.employee_id,
        method: mention.method as 'short_alias_review' | 'conflict_review',
      };
    });
  };

  /**
   * 同一場會正在上傳中的集合。
   *
   * 路由從 getMeeting 檢查 CREATED 到 setStatus('TRANSCRIBING') 之間隔著整個上傳，
   * 中間狀態一直是 CREATED，所以第二個請求照樣放行。實測的後果是兩個寫入共用同一個檔：
   * 後到的先改名，先到的檔案描述子繼續往已經改名的最終音檔寫，最後那個檔是兩次上傳混出來的，
   * 而成功的那一邊沒有任何錯誤，pipeline 就去轉那個混合檔。
   */
  const uploading = new Set<string>();

  /**
   * 正在叫語音備忘錄開始或停止的那場會。語音備忘錄只有一台，兩個請求同時叫它，
   * 取檔那一步分不出「最新一支」是誰的，所以整台 server 同一時間只准一個開始／停止在跑。
   */
  let recorderBusy: string | null = null;

  /**
   * 正在寫分段的會（app 內錄音）。前端一次只送一段，但重試時上一個請求可能還在 server 這頭寫；
   * 兩個寫入同時截檔再寫，同一段會出現兩次或互相蓋掉
   */
  const chunkWriting = new Set<string>();

  /**
   * 把一條音檔位元組流收成這場會的音檔。PUT audio 與錄音停止共用這一段，
   * 「先清舊成果再收檔、失敗就刪掉最終檔」的理由見呼叫端 PUT audio 的註解。
   * 呼叫端負責狀態檢查與 uploading 集合；收完之後的空檔檢查、轉狀態、入列也由呼叫端做。
   */
  const saveIncomingAudio = async (meetingId: string, source: Readable): Promise<{ path: string; bytes: number }> => {
    try {
      meetingStore.resetTranscriptionProgress(meetingId, Date.now());
      return await audioStore.saveFrom(meetingId, source);
    } catch (err) {
      try {
        audioStore.remove(meetingId);
      } catch (removeErr) {
        console.error(`[MeetPilot] Meeting ${meetingId} 上傳失敗後清音檔也失敗：`, removeErr);
      }
      throw err;
    }
  };

  const app = express();

  // 順序重要：限流與 Basic Auth 先掛，body parser 後掛。
  // 否則未認證的請求會先把整個 50MB body 讀完、解析完，才在後面被拒絕。

  // /api/* 限流：每個 IP 每分鐘最多 MEETPILOT_API_RATE_LIMIT 次（預設 60）。放在 Basic Auth 前面，猜密碼也一起被限
  const apiRateLimiter = createRateLimiter({ limit: listenConfig.apiRateLimitPerMinute, windowMs: 60_000 });
  app.use('/api', (req, res, next) => {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = apiRateLimiter.check(clientIp);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      // 前端 services/httpResponse.ts 把 429 與 Retry-After 翻成 HttpError；訊息帶 "429" 是給人看的，也讓 translateError 分類得到
      return res.status(429).json({ error: `請求太頻繁 (HTTP 429)，請 ${result.retryAfterSeconds} 秒後再試` });
    }
    next();
  });

  // /api/* Basic Auth：只有設定了帳密才掛，本機位址不設帳密就不要求認證
  if (listenConfig.basicAuth) {
    const credentials = listenConfig.basicAuth;
    app.use('/api', (req, res, next) => {
      if (!checkBasicAuth(req.headers.authorization, credentials)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="MeetPilot", charset="UTF-8"');
        return res.status(401).json({ error: '需要 Basic Auth 認證' });
      }
      next();
    });
  }

  // 音檔上傳掛在 body parser 之前，body 直接 pipe 進檔案，一個位元組都不進記憶體。
  // express.json 只認 application/json、express.urlencoded 只認 form，理論上不會碰 octet-stream，
  // 但那是「它們現在的設定剛好不匹配」，不是保證；掛在前面才是這條路徑不經 body parser 的保證。
  // 限流與 Basic Auth 在更前面，所以未認證的上傳一樣連檔案都建不起來。
  app.put('/api/meetings/:id/audio', async (req, res) => {
    const meetingId = req.params.id;
    // 這一段到 uploading.add 之間沒有 await，所以「檢查再加入」是原子的。
    // 擋在這裡而不是靠狀態：狀態要等整個上傳寫完才會離開 CREATED，中間放行的那個請求
    // 會跟前一個寫同一場會的音檔
    if (uploading.has(meetingId)) {
      return res.status(409).json({
        error: audioUploadInFlightError(meetingId),
      });
    }

    try {
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (meeting.status !== 'CREATED') {
        return res.status(409).json({
          error: `Meeting ${meetingId} 目前是 ${meeting.status}，只有 CREATED 能上傳音檔`,
        });
      }
      // CREATED 不代表沒人要處理它：retry 之後佇列正忙、或重啟掃描一次入列好幾場時，
      // 那些會都停在 CREATED 而音檔已經在 server 上。這時收新音檔，rename 會落在 pipeline
      // 讀兩片之間，前幾片來自舊音檔、後幾片來自新音檔，合成一份逐字稿而且沒有任何錯誤。
      //
      // 判準刻意是「在不在佇列裡」而不是「有沒有音檔」：CREATED ＋ 音檔在 ＋ 不在佇列
      // 是 setStatus 拋錯之後的處境，重送音檔是那種情況的唯一自救路，不能一起堵掉。
      if (transcriptionQueue.has(meetingId)) {
        return res.status(409).json({
          error: audioUploadQueuedError(meetingId),
        });
      }

      uploading.add(meetingId);
      let saved: { path: string; bytes: number };
      try {
        // saveIncomingAudio 做兩件事，理由都在這裡：
        //
        // 清游標與舊逐字稿要在收檔**之前**，不是之後。
        //
        // 之後清的話有兩個窗口：一是「音檔已改名、這兩行還沒寫進去」就斷電，重啟看到
        // 新音檔配舊游標，直接從舊游標續跑，把新音檔的後半接到舊音檔的逐字稿後面；
        // 二是 reset 自己拋錯（資料庫被鎖、磁碟滿），留下 CREATED ＋ 音檔在 ＋ 不在佇列裡。
        //
        // 先清消掉的是這兩個：斷在「清完但音檔沒寫完」是 CREATED ＋ 無音檔（等上傳，正確），
        // 斷在「清完、音檔寫完、還沒改狀態」是 CREATED ＋ 音檔在 ＋ 游標 null（從頭跑，正確）。
        // 沒消掉的是下面那行 setStatus 自己拋錯：那仍然留下 CREATED ＋ 音檔在 ＋ 不在佇列，
        // 靠重啟掃描把它撿回來入列（掃描不清游標，而游標這時已經是 null，所以從頭跑）。
        // 代價是上傳失敗會先清掉前一輪成果——而能走到這裡的只有 CREATED，它要嘛沒東西可清，
        // 要嘛是使用者自己選擇重送音檔（那本來就是從頭跑）。
        //
        // 上傳失敗時舊音檔不能留在最終路徑：前一輪的逐字稿與游標剛剛已經清掉了，留著會變成
        // 「舊音檔 ＋ 空游標」，下次重啟掃描看到 CREATED ＋ 音檔在就把整個舊音檔重轉一遍
        // （一場 100 分鐘的會就是全額 Gemini 費用），而那正是使用者剛剛想換掉的內容。
        // 清掉之後它回到 CREATED ＋ 無音檔，前端會給上傳入口，使用者重送就好。
        // 清不掉只記 log 不換掉原始錯誤：上傳失敗的原因才是使用者要看的那個
        saved = await saveIncomingAudio(meetingId, req);
      } finally {
        uploading.delete(meetingId);
      }

      if (saved.bytes === 0) {
        // 空檔案照收的話，ffprobe 會在背景才失敗，使用者要等到狀態變 FAILED 才知道上傳有問題。
        // 刪掉剛收的空檔、狀態留在 CREATED，使用者重送一次就好
        audioStore.remove(meetingId);
        return res.status(400).json({ error: '上傳的音檔是空的，沒有內容可以轉錄' });
      }

      // 大小以收到的位元組為準，不信建立時前端報的數字：錄音按鍵建立的會先寫 0，取回失敗、
      // 改用這條補送音檔時不更新的話，這場會與匯出的 metadata 會永遠說來源是 0 bytes
      // （2026-09-23 Codex review 抓到）。一般上傳這兩個數字本來就一樣
      meetingStore.setSourceFileSize(meetingId, saved.bytes, Date.now());
      meetingStore.setStatus(meetingId, 'TRANSCRIBING', Date.now());
      transcriptionQueue.enqueue(meetingId);
      // enqueue 會同步跑到 pipeline 的第一個 await 為止，狀態可能又往前走了。
      // 回應前重讀一次，不要送一份當下已經不成立的狀態出去
      res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // app 內錄音的一段（vault plan「MeetPilot · 跨平台打包部署」E4）。跟 PUT audio 同一個理由掛在 body parser 之前：
  // body 是原始的 webm 位元組，不經 express.json。前端每 10 秒送一段、一次只送一段，送不到就重送同一段。
  //
  // 段號是冪等的關鍵：比已收到的小就是重送（上一次其實寫進去了、只是回應沒送到），直接回目前進度；
  // 比已收到的大代表中間缺段，拒收並講出 server 要的是第幾段，不接一個缺了中間的檔。
  app.put('/api/meetings/:id/recording/chunks/:seq', async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: REMOTE_RECORDING_REASON });
    const meetingId = req.params.id;
    if (!/^\d+$/.test(req.params.seq)) {
      return res.status(400).json({ error: `段號必須是非負整數，收到 ${JSON.stringify(req.params.seq)}` });
    }
    const seq = Number(req.params.seq);
    // 這一段到 chunkWriting.add 之間沒有 await，「檢查再加入」是原子的（同 PUT audio 的 uploading）
    // 503 不是 409：這是「等一下就好」，前端的分段上傳看到 5xx 會照 Retry-After 重送，409 會停下來當成被拒收
    if (chunkWriting.has(meetingId)) {
      res.setHeader('Retry-After', '1');
      return res.status(503).json({ error: `Meeting ${meetingId} 的上一段錄音還在寫，等它寫完再送` });
    }
    chunkWriting.add(meetingId);
    try {
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (meeting.status !== 'RECORDING') {
        return res.status(409).json({ error: `Meeting ${meetingId} 目前是 ${meeting.status}，不在錄音中，不收錄音段落` });
      }
      const recording = recordingOf(meeting)!;
      if (recording.method !== 'in_app') {
        return res.status(409).json({ error: `Meeting ${meetingId} 是語音備忘錄在錄，不收 app 送來的錄音段落` });
      }
      if (recording.stopped_at !== null) {
        return res.status(409).json({ error: `Meeting ${meetingId} 的錄音已經停止，不再收錄音段落` });
      }
      if (seq < recording.received_chunks) {
        return res.json({ received_chunks: recording.received_chunks, received_bytes: recording.received_bytes });
      }
      if (seq > recording.received_chunks) {
        return res.status(409).json({
          error: `Meeting ${meetingId} 的錄音段落跳號：server 收到 ${recording.received_chunks} 段，`
            + `下一段應該是第 ${recording.received_chunks} 段，這次送來的是第 ${seq} 段`,
        });
      }
      const body = await readBodyUpTo(req, RECORDING_CHUNK_MAX_BYTES);
      if (body === null) {
        return res.status(413).json({ error: `一段錄音超過 ${RECORDING_CHUNK_MAX_BYTES} bytes，不收` });
      }
      if (body.length === 0) return res.status(400).json({ error: `第 ${seq} 段錄音是空的` });
      const bytesAfter = audioStore.appendRecordingChunk(meetingId, recording.received_bytes, body);
      const updated = meetingStore.recordChunkReceived(meetingId, seq, bytesAfter);
      res.json({ received_chunks: updated.received_chunks, received_bytes: updated.received_bytes });
    } catch (err) {
      handleStoreError(err, res);
    } finally {
      chunkWriting.delete(meetingId);
    }
  });

  // Allow large payloads for audio slices (up to 50MB)
  // 只掛在 /api 底下，通過限流與認證後才解析 body；/api 以外沒有路由讀 req.body
  app.use('/api', express.json({ limit: '50mb' }));
  app.use('/api', express.urlencoded({ limit: '50mb', extended: true }));

  // body parser 的錯要自己接：Express 預設回 HTML 錯誤頁，前端 postJson 看到 `<` 開頭會當成連線異常，
  // 使用者只看到「無法連線」，不知道是送出的 JSON 壞掉還是超過 50MB。其他錯誤原樣往下丟。
  app.use('/api', (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const described = describeBodyParserError(err);
    if (!described) return next(err);
    res.status(described.status).json({ error: described.error });
  });

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      hasKey: !!process.env.GEMINI_API_KEY,
    });
  });

  // Meeting 相關的錯誤自己接，訊息照原樣回給前端
  function handleStoreError(err: unknown, res: express.Response) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[MeetPilot Store Error]:', message);
    res.status(500).json({ error: message });
  }

  // Migration：瀏覽器 IndexedDB 的 Job 搬進 server 端 SQLite（SDD 1.5 第一段）。
  // server 讀不到 IndexedDB，所以資料一定是前端撈出來送上來的。
  app.post('/api/meetings/import', (req, res) => {
    try {
      const { jobs, blobIds = [] } = req.body ?? {};
      if (!Array.isArray(jobs)) {
        return res.status(400).json({ error: 'jobs 必須是陣列' });
      }
      // blobIds 壞掉不能當成空陣列：那會回報「沒有音檔留在瀏覽器」，是最危險的一種假回報
      if (!Array.isArray(blobIds) || !blobIds.every((id: unknown) => typeof id === 'string')) {
        return res.status(400).json({ error: 'blobIds 必須是字串陣列' });
      }

      const records: MigrationRecord[] = [];
      const rejected: { jobId: string | null; reason: string }[] = [];
      const notes: { jobId: string; note: string }[] = [];

      for (const raw of jobs) {
        const outcome = toMigrationRecord(raw);
        if (isRejected(outcome)) {
          rejected.push({ jobId: outcome.jobId, reason: outcome.reason });
          continue;
        }
        records.push(outcome.record);
        for (const note of outcome.notes) notes.push({ jobId: outcome.record.meeting.meeting_id, note });
      }

      const report = meetingStore.importMigrated(records);

      // 音檔這一期不搬：它只在「轉錄或分析失敗」的 Meeting 上還留著，而重跑需要的是 server 端的新流程。
      // 但不能安靜地不搬，否則使用者清掉 IndexedDB 之後才發現那幾場會再也重跑不了。
      //
      // 全部列出來、逐筆標出它屬於哪一群，不做交集過濾：被拒收的那幾筆正是之後要重跑的，
      // 把它們濾掉等於在最需要提醒的地方不提醒
      const importedSet = new Set(report.imported);
      const skippedSet = new Set(report.skippedExisting);
      const rejectedSet = new Set(rejected.map(r => r.jobId).filter((id): id is string => id !== null));
      const audioStillInBrowser = blobIds.map((meetingId: string) => ({
        meetingId,
        // orphan：這個音檔在 IndexedDB 裡，但沒有對應的 job 被送上來
        group: importedSet.has(meetingId) ? 'imported'
          : skippedSet.has(meetingId) ? 'skippedExisting'
          : rejectedSet.has(meetingId) ? 'rejected'
          : 'orphan',
      }));

      res.json({ ...report, rejected, notes, audioStillInBrowser });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 給上傳畫面的與會者選取器用。只回在職的人：離職的人不該再被選成新會議的與會者，
  // 即使他過去參與過的舊會議仍然看得到他（那筆資料在 meeting_participants，不受這裡影響）
  app.get('/api/people', (req, res) => {
    try {
      const people = peopleStore.listPeople().filter((p) => p.active);
      // 搜尋要能搜到英文名（別名裡的 alias／display_names／match_keys），不只中文正名：
      // 一次查完這批人的所有別名再分組，避免每個人各自查一次
      const aliasesByEmployee = new Map<string, string[]>();
      for (const a of peopleStore.listAliasesForEmployees(people.map((p) => p.employee_id))) {
        const list = aliasesByEmployee.get(a.employee_id);
        if (list) list.push(a.alias); else aliasesByEmployee.set(a.employee_id, [a.alias]);
      }
      res.json({
        people: people.map((p) => ({
          employeeId: p.employee_id,
          displayName: p.display_name,
          title: p.title,
          department: p.department,
          aliases: aliasesByEmployee.get(p.employee_id) ?? [],
        })),
      });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // ---------------------------------------------------------------------------
  // 語音備忘錄錄音（vault plan「MeetPilot · 網頁錄音」）
  //
  // 流程：前端先照常 POST /api/meetings 建立會議（與會者必填，D-016 不變），再 start 叫語音備忘錄
  // 開始錄；stop 叫它停、用捷徑取回剛錄的那支、比對是不是這場會的錄音，對得上就跟 PUT audio 一樣
  // 收檔、進轉錄。錄音本身在語音備忘錄裡，這裡只記開始與停止時間。
  // ---------------------------------------------------------------------------

  const REMOTE_RECORDING_REASON =
    '錄音會用到跑 MeetPilot server 那台電腦的麥克風，只能在那台電腦上操作';

  /** 錄音路由的共同前置：只收本機請求、這台 server 要有接語音備忘錄。回 null 代表已經回應了 */
  const recorderFor = (req: express.Request, res: express.Response) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: REMOTE_RECORDING_REASON });
      return null;
    }
    if (!voiceMemoRecorder) {
      res.status(503).json({ error: '這台 server 沒有接語音備忘錄錄音' });
      return null;
    }
    return voiceMemoRecorder;
  };

  const recorderBusyError = (): string =>
    `語音備忘錄正在處理 Meeting ${recorderBusy} 的開始或停止，等它結束再試`;

  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * 把請求 body 讀成 Buffer，超過 maxBytes 就回 null（呼叫端回 413）。只給錄音段落用：一段只有幾十 KB，
   * 讀進記憶體比串流寫檔簡單，而且要先確定整段收完才能截檔、寫入、記進度，收到一半的段落不能寫進去。
   * 請求中途斷掉要拋錯，不能把收到的一半當成完整的一段
   */
  const readBodyUpTo = (req: express.Request, maxBytes: number): Promise<Buffer | null> =>
    new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.resume();
        resolve(null);
        return;
      }
      const parts: Buffer[] = [];
      let total = 0;
      let settled = false;
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          req.resume();
          resolve(null);
          return;
        }
        parts.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(parts));
      });
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      req.on('close', () => {
        if (settled) return;
        settled = true;
        reject(new Error('錄音段落的請求沒送完就斷了'));
      });
    });

  /**
   * 取檔、讀長度、比對，對不上就等一下再取。最後一次的失敗原因原樣回傳，不改寫成籠統的「失敗」：
   * 使用者要靠那句話判斷是捷徑設錯、檔案還沒寫完，還是最新一支根本不是這場會的。
   */
  const fetchCheckedRecording = async (
    recorder: NonNullable<typeof voiceMemoRecorder>,
    tempPath: string,
    recording: { startedAt: number; stoppedAt: number },
  ): Promise<{ ok: true; info: RecordingInfo } | { ok: false; reason: string }> => {
    let lastReason = '沒有取過檔';
    for (let attempt = 1; attempt <= recordingFetchPolicy.attempts; attempt += 1) {
      if (attempt > 1) await wait(recordingFetchPolicy.delayMs);
      try {
        rmSync(tempPath, { force: true });
        await recorder.fetchLatestTo(tempPath);
        const info = await recorder.probe(tempPath);
        const check = checkFetchedRecording(info, recording);
        if (check.ok === true) return { ok: true, info };
        lastReason = check.reason;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, reason: lastReason };
  };

  app.get('/api/recording/availability', async (req, res) => {
    // 這條不回 403：它本來就是用來回答「能不能錄、為什麼不能」的，別台電腦開頁面時
    // 錄音按鍵要能講出原因，而不是一個讀不到狀態的錯誤
    if (!isLocalRequest(req)) return res.json({ available: false, reason: REMOTE_RECORDING_REASON });
    // app 內錄音的麥克風只有頁面問得到瀏覽器，server 這頭沒有東西可以查
    if (recordingMethod === 'in_app') return res.json({ available: true, method: 'in_app' });
    if (!voiceMemoRecorder) return res.json({ available: false, reason: '這台 server 沒有接語音備忘錄錄音' });
    try {
      const availability = await voiceMemoRecorder.checkAvailability();
      res.json(availability.available === true ? { available: true, method: 'voice_memo' } : availability);
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  /**
   * 這場會現在能不能開始錄，不能就回原因（兩種錄音方式共用）。回 null 代表可以。
   *
   * 只有「建立了、還沒有音檔」的會能開始錄。CREATED ＋ 有音檔是 retry 之後在排隊的會，
   * 在那上面錄音，停止時收檔會把 retry 刻意保留的逐字稿與游標整個清掉。
   * 一次只能錄一場：語音備忘錄第二場也開始的話，兩場停止時取到的「最新一支」會是同一個檔；
   * app 內錄音只有一支麥克風、一個錄音按鍵，第二場只可能是另一個視窗誤按
   */
  const cannotStartRecording = (meetingId: string, meeting: Meeting): string | null => {
    if (meeting.status !== 'CREATED' || audioStore.exists(meetingId)
      || uploading.has(meetingId) || transcriptionQueue.has(meetingId)) {
      return `Meeting ${meetingId} 目前是 ${meeting.status}，只有剛建立、還沒有音檔的會能開始錄音`;
    }
    const others = meetingStore.listRecordingMeetings().filter(m => m.meeting_id !== meetingId);
    if (others.length > 0) {
      const who = recordingMethod === 'in_app' ? 'MeetPilot' : '語音備忘錄';
      return `${who}一次只能錄一場，Meeting ${others[0].meeting_id} 還在錄，先停止它`;
    }
    return null;
  };

  app.post('/api/meetings/:id/recording/start', async (req, res) => {
    const meetingId = req.params.id;
    if (recordingMethod === 'in_app') {
      // app 內錄音：麥克風在頁面手上，server 只記開始時間，之後收分段。頁面先拿到麥克風才建會議、呼叫這支，
      // 所以這裡沒有「叫錄音程式失敗」要退回的情況
      if (!isLocalRequest(req)) return res.status(403).json({ error: REMOTE_RECORDING_REASON });
      try {
        const meeting = meetingStore.getMeeting(meetingId);
        if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
        const reason = cannotStartRecording(meetingId, meeting);
        if (reason !== null) return res.status(409).json({ error: reason });
        // 上一次同一場會開始後又被退回 CREATED 的話可能留著舊段落；第 0 段會整個蓋掉，這裡先清，
        // 不讓一個跟這次無關的檔在第 0 段送到之前被當成這場的錄音
        audioStore.removeRecording(meetingId);
        meetingStore.startRecording(meetingId, Date.now(), 'in_app');
        return res.json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
      } catch (err) {
        return handleStoreError(err, res);
      }
    }

    const recorder = recorderFor(req, res);
    if (!recorder) return;
    if (recorderBusy !== null) return res.status(409).json({ error: recorderBusyError() });

    try {
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      const reason = cannotStartRecording(meetingId, meeting);
      if (reason !== null) return res.status(409).json({ error: reason });

      recorderBusy = meetingId;
      try {
        // 先落地再叫語音備忘錄：反過來的話，叫成功之後寫資料庫失敗，語音備忘錄就在錄一支
        // 沒有任何會議認領的錄音，畫面上也沒有停止按鍵
        meetingStore.startRecording(meetingId, Date.now(), 'voice_memo');
        try {
          await recorder.start();
        } catch (err) {
          meetingStore.abortRecording(meetingId, Date.now());
          const reason = err instanceof Error ? err.message : String(err);
          // 逾時是「結果不明」不是「確定失敗」：卡住的那次可能晚一點才被派出去，不能說成沒開始
          const headline = err instanceof RecorderTimeoutError ? '叫語音備忘錄開始錄音沒有回應' : '語音備忘錄沒有開始錄音';
          return res.status(502).json({ error: `${headline}：${reason}` });
        }
      } finally {
        recorderBusy = null;
      }
      res.json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  /**
   * 收尾一場 app 內錄音：把收到的段落變成這場會的音檔、進轉錄（E4）。
   *
   * body 一定要講是哪一種收尾（契約見 meetingApi 的 StopInAppRecordingRequest）：正常停止帶段數，
   * server 收到的對不上就拒收、狀態不動，前端把沒送到的補送完再停一次；救回中斷的錄音帶 partial，
   * 收到幾段送幾段。一段都沒有的話沒東西可轉，退回 CREATED 讓使用者刪掉或補音檔。
   */
  const finishInAppRecording = (
    req: express.Request, res: express.Response, meetingId: string,
    recording: NonNullable<ReturnType<typeof recordingOf>>,
  ) => {
    const body = req.body ?? {};
    const partial = body.partial === true;
    const expected = body.chunks;
    if (!partial && !(Number.isInteger(expected) && expected >= 0)) {
      return res.status(400).json({
        error: '停止 app 內錄音要帶 chunks（這次一共錄了幾段）或 partial: true（救回中斷的錄音），兩個都沒有',
      });
    }
    if (!partial && expected !== recording.received_chunks) {
      return res.status(409).json({
        error: `錄音還沒送完：這次錄了 ${expected} 段，server 只收到 ${recording.received_chunks} 段。`
          + '沒送到的段落還在這個視窗裡，送完之後再停止一次',
      });
    }
    if (chunkWriting.has(meetingId)) {
      return res.status(409).json({ error: `Meeting ${meetingId} 的最後一段錄音還在寫，等它寫完再停止` });
    }
    // 停止時間只在第一次收尾時記：上一次收尾記下停止時間之後才失敗（例如錄音檔比收到的短）的話，
    // 再按一次停止要能照常走完或講出同一個原因，不能每次都卡在「已經停過、記不下停止時間」
    if (recording.stopped_at === null) meetingStore.markRecordingStopped(meetingId, Date.now());
    if (recording.received_chunks === 0) {
      meetingStore.setStatus(meetingId, 'CREATED', Date.now());
      audioStore.removeRecording(meetingId);
      return res.status(422).json({
        error: '這場錄音一段都沒有送到 server，沒有東西可以轉錄。這場會已經退回「等待音檔」，'
          + '可以刪掉它，或用「補上音檔」選一個檔送出',
      });
    }
    // 收過段落、錄音檔跟音檔卻都不在（斷電時新檔的目錄項沒落盤、被人刪掉）：段落已經沒了，救不回來。
    // 跟一段都沒有同一個出口，不然每次收尾都是 500，這場會只剩刪除一條路（fable review）
    if (!existsSync(audioStore.recordingPathFor(meetingId)) && !audioStore.exists(meetingId)) {
      meetingStore.setStatus(meetingId, 'CREATED', Date.now());
      return res.status(422).json({
        error: `server 記得收過 ${recording.received_chunks} 段錄音，但錄音檔不見了，這些段落救不回來。`
          + '這場會已經退回「等待音檔」，可以刪掉它，或用「補上音檔」選一個檔送出',
      });
    }

    // 清游標與舊逐字稿在收檔之前，理由同 PUT audio 的註解（saveIncomingAudio）
    meetingStore.resetTranscriptionProgress(meetingId, Date.now());
    const saved = audioStore.promoteRecording(meetingId, recording.received_bytes);
    meetingStore.setSourceFileSize(meetingId, saved.bytes, Date.now());
    meetingStore.setStatus(meetingId, 'TRANSCRIBING', Date.now());
    transcriptionQueue.enqueue(meetingId);
    // 理由同 PUT audio：enqueue 可能已經把狀態往前推，回應前重讀一次
    return res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
  };

  app.post('/api/meetings/:id/recording/stop', async (req, res) => {
    const meetingId = req.params.id;
    if (!isLocalRequest(req)) return res.status(403).json({ error: REMOTE_RECORDING_REASON });

    try {
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (meeting.status !== 'RECORDING') {
        return res.status(409).json({ error: `Meeting ${meetingId} 目前是 ${meeting.status}，不在錄音中` });
      }
      const recording = recordingOf(meeting)!;
      // 照這場開始時的方式收尾，不看 server 現在的設定：換過 MEETPILOT_RECORDER 之後重開，
      // 上一次沒停的那場還是要照原本的方式收
      if (recording.method === 'in_app') return finishInAppRecording(req, res, meetingId, recording);

      const recorder = recorderFor(req, res);
      if (!recorder) return;
      if (recorderBusy !== null) return res.status(409).json({ error: recorderBusyError() });

      recorderBusy = meetingId;
      const tempPath = audioStore.tempPathFor(meetingId);
      try {
        let stoppedAt = recording.stopped_at;
        // stopped_at 已經有值：上一次停止時語音備忘錄停了、時間也記了，但取檔之前 server 就斷了。
        // 這時再叫一次停止沒有意義（不在錄了），直接用那一次的停止時間去取檔比對
        if (stoppedAt === null) {
          try {
            await recorder.stop();
          } catch (err) {
            // 停不下來就留在 RECORDING：錄音可能還在跑，退回 CREATED 會讓畫面失去停止按鍵
            const reason = err instanceof Error ? err.message : String(err);
            return res.status(502).json({
              error: `語音備忘錄沒有停止：${reason}。錄音可能還在進行，請到語音備忘錄確認，再按一次停止`,
            });
          }
          stoppedAt = Date.now();
          meetingStore.markRecordingStopped(meetingId, stoppedAt);
        }

        const fetched = await fetchCheckedRecording(recorder, tempPath, { startedAt: recording.started_at, stoppedAt });
        if (fetched.ok === false) {
          meetingStore.setStatus(meetingId, 'CREATED', Date.now());
          return res.status(422).json({ error: `${fetched.reason}\n\n${RECORDING_FALLBACK_HINT}` });
        }

        uploading.add(meetingId);
        let saved: { path: string; bytes: number };
        try {
          saved = await saveIncomingAudio(meetingId, createReadStream(tempPath));
        } catch (err) {
          meetingStore.setStatus(meetingId, 'CREATED', Date.now());
          const reason = err instanceof Error ? err.message : String(err);
          return res.status(500).json({ error: `取回的錄音存不進 server：${reason}\n\n${RECORDING_FALLBACK_HINT}` });
        } finally {
          uploading.delete(meetingId);
        }

        meetingStore.setSourceFileSize(meetingId, saved.bytes, Date.now());
        meetingStore.setStatus(meetingId, 'TRANSCRIBING', Date.now());
        transcriptionQueue.enqueue(meetingId);
        // 理由同 PUT audio：enqueue 可能已經把狀態往前推，回應前重讀一次
        res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
      } finally {
        recorderBusy = null;
        rmSync(tempPath, { force: true });
      }
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 建立一場會。音檔另外用 PUT /api/meetings/:id/audio 送，分兩步是因為上傳要走原始位元組、
  // 不經 body parser，而這些欄位是 JSON；混在一起就得自己解 multipart
  app.post('/api/meetings', (req, res) => {
    try {
      const { fileName, fileSize, title, meetingContext, tags = [], participantIds } = req.body ?? {};
      if (typeof fileName !== 'string' || fileName.trim() === '') {
        return res.status(400).json({ error: 'fileName 必須是非空字串' });
      }
      if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
        return res.status(400).json({ error: 'fileSize 必須是非負數字' });
      }
      if (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string')) {
        return res.status(400).json({ error: 'tags 必須是字串陣列' });
      }
      // 跟 PATCH /title 走同一支檢查：不然一個帶空白／超長／控制字元標題的建立請求能繞過驗證，
      // 把不合規則的值直接存成 title，pipeline 的「title === null 才填建議」判斷因此永遠不會補正
      // （2026-09-20 Codex review 抓到），畫面上就會一直顯示那個壞掉的值
      let checkedTitle: string | null = null;
      if (title !== undefined) {
        const check = checkMeetingTitle(title);
        if (check.ok === false) return res.status(400).json({ error: check.reason });
        checkedTitle = check.title;
      }
      if (meetingContext !== undefined && typeof meetingContext !== 'string') {
        return res.status(400).json({ error: 'meetingContext 必須是字串' });
      }
      // D-016：至少一位與會者是 F-CREATE 的前置條件，不是選填的方便欄位。
      // 空清單靜默放行的話，這場會轉錄與分析呼叫都拿不到人名提示（人名校正三層設計的第 1 層），
      // 而那個缺口不會有任何錯誤訊息，事後也查不出這場會為什麼沒對到提示
      if (!Array.isArray(participantIds) || participantIds.length === 0
        || !participantIds.every((id: unknown) => typeof id === 'string' && id.trim() !== '')) {
        return res.status(400).json({ error: 'participantIds 必須是至少一個員編字串的陣列' });
      }
      // 不信任前端送來的員編：對照名單擋掉打錯字或名單裡沒有的人，錯誤裡列出哪幾個查無此人，
      // 不讓它一路寫進 meeting_participants 之後才在別處（提示、NameResolver）查無此人時再爆炸
      const unknownIds = participantIds.filter((id: string) => !peopleStore.getPerson(id));
      if (unknownIds.length > 0) {
        return res.status(400).json({ error: `找不到員編：${unknownIds.join('、')}` });
      }

      // randomUUID 不含路徑字元，可以直接當音檔檔名（見 audioFileStore 的 SAFE_MEETING_ID）
      const meetingId = randomUUID();
      const meeting = meetingStore.createMeeting({
        meeting_id: meetingId,
        title: checkedTitle,
        created_at: Date.now(),
        source_file_name: fileName,
        source_file_size: fileSize,
        meeting_context: meetingContext ?? null,
        participant_ids: participantIds,
      });
      if (tags.length > 0) meetingStore.setTags(meetingId, tags);

      res.status(201).json({ meeting: toView(meeting) });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  app.get('/api/meetings', (req, res) => {
    try {
      // 每一筆各做一次 exists（N 次 stat）。一年約 1,040 場、單人使用，先不加快取：
      // 快取要處理失效，而這裡的值必須跟磁碟一致，不然 has_audio 會比狀態還難懂
      res.json({ meetings: meetingStore.listMeetings().map(toView) });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  app.get('/api/meetings/:id', (req, res) => {
    try {
      const meeting = meetingStore.getMeeting(req.params.id);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${req.params.id}` });
      res.json({
        meeting: toView(meeting),
        // 目前顯示的版本（人工編輯過就是編輯後的），不是固定不變的 raw：PATCH 之後
        // 重新整理要看得到剛存的修改，否則編輯功能形同寫進黑洞
        transcript: meetingStore.getCurrentTranscript(req.params.id),
        analysis: meetingStore.getAnalysis(req.params.id),
        tags: meetingStore.getTags(req.params.id),
        // 題目標籤與上面的 tags 分成兩個欄位送（契約檔有寫為什麼不能併）
        topicTags: meetingStore.getTopicTags(req.params.id),
        seamReport: meetingStore.getSeamReport(req.params.id),
        // 關聯與它的覆蓋率（W4）。空陣列要配 status 一起讀，理由在契約檔
        links: meetingStore.getLinks(req.params.id),
        linkRun: meetingStore.getLinkRun(req.params.id),
        // 與會者（人名校正 N2）跟待確認的人名（N4／N5）：前者是後者的選人來源
        participantIds: meetingStore.getParticipants(req.params.id),
        nameMentions: listNameMentionViews(req.params.id),
      });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  /**
   * 人一鍵確認 needs_review 的人名（人名校正 N5，SDD 1.3.2 第 3 層）。
   *
   * 只認這場會的與會者：`needs_review` 本來就是「只在與會者別名集合裡比對」找不出答案的結果，
   * 確認的對象也只該是與會者，不是全公司名單。確認結果寫進 `person_aliases`（`source = manual`）
   * 並直接覆寫這場會的 `name_mentions`（`nameResolver.confirmMention`，理由見那支函式的檔頭：
   * `conflict_review` 沒辦法只靠別名表升級解決）；有分析結果的話同一次也重算
   * `decided_by_employee_id`／`assignee_employee_id`（FN-14 現在查得到人了）。都是本機查表，
   * 不花任何 Gemini 額度。
   */
  app.post('/api/meetings/:id/name-mentions/confirm', (req, res) => {
    try {
      const meetingId = req.params.id;
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (isBusy(meeting.status)) {
        return res.status(409).json({
          error: `Meeting ${meetingId} 目前是 ${meeting.status}，這場正在處理，等它跑完再確認人名`,
        });
      }

      const { segment_index: segmentIndex, original_text: originalText, employee_id: employeeId } = req.body ?? {};
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
        return res.status(400).json({ error: 'segment_index 必須是非負整數' });
      }
      if (typeof originalText !== 'string' || originalText.trim() === '') {
        return res.status(400).json({ error: 'original_text 必須是非空字串' });
      }
      if (typeof employeeId !== 'string' || employeeId.trim() === '') {
        return res.status(400).json({ error: 'employee_id 必須是非空字串' });
      }
      const participantIds = meetingStore.getParticipants(meetingId);
      if (!participantIds.includes(employeeId)) {
        return res.status(400).json({ error: `員編 ${employeeId} 不是這場會的與會者，只能確認成與會者名單裡的人` });
      }

      // 直接覆寫這場會的 name_mentions，不是重跑 resolveTranscript：conflict_review 沒辦法
      // 只靠別名表升級解決（另一個候選人還在別名集合裡），重跑比對只會再判一次 conflict_review，
      // 使用者確認就等於沒做（見 nameResolver.ts 的 confirmMention 檔頭說明）
      nameResolver.confirmMention(meetingId, segmentIndex, originalText, employeeId, Date.now());

      const analysis = meetingStore.getAnalysis(meetingId);
      if (analysis) {
        const overrides = nameResolver.listResolvedByText(meetingId);
        meetingStore.saveAnalysis(meetingId, nameResolver.resolveAnalysisEmployeeIds(analysis, meetingId, overrides), Date.now());
      }

      res.json({
        nameMentions: listNameMentionViews(meetingId),
      });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  /**
   * 重算這場會的關聯（W4）。換演算法版本、補上漏掉的候選、額度恢復之後重跑，走這一條。
   *
   * **同步等它跑完再回**，不像 `PUT audio` 那樣回 202 丟到背景：這是單人本機工具的手動動作，
   * 最多 20 次 LLM 呼叫，而回 202 就得再開一套佇列與進度查詢，那一套的唯一用途就是這條路由。
   * 代價寫在這裡：候選滿的時候這個請求會跑上幾分鐘。
   */
  app.post('/api/meetings/:id/link', async (req, res) => {
    const meetingId = req.params.id;
    if (!topicLinker) {
      return res.status(503).json({ error: '這台 server 的跨會議關聯是關閉的（MEETPILOT_LINKING=off）' });
    }
    try {
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (linking.has(meetingId)) {
        return res.status(409).json({ error: `Meeting ${meetingId} 的關聯正在計算中，等它跑完再試` });
      }
      if (meeting.status !== 'READY' && meeting.status !== 'LINKED' && meeting.status !== 'LINK_FAILED') {
        return res.status(409).json({
          error: `Meeting ${meetingId} 目前是 ${meeting.status}，要 READY、LINKED 或 LINK_FAILED 才能算關聯`,
        });
      }

      linking.add(meetingId);
      try {
        await topicLinker.link(meetingId);
      } finally {
        linking.delete(meetingId);
      }

      // 手動重算之後同步重投影，理由同 transcriptionPipeline：vault 寫不進去只記 log，
      // 不讓這個請求因為檔案系統的問題而失敗——關聯已經落地，回應本來就該是成功的
      runProjection(vaultProjector, meetingId, '[MeetPilot]');

      res.json({
        meeting: toView(meetingStore.getMeeting(meetingId)!),
        links: meetingStore.getLinks(meetingId),
        linkRun: meetingStore.getLinkRun(meetingId),
      });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 重跑失敗的會。processed_slices 不歸零：續傳游標就是為了不用把已經轉好的片再送一次，
  // 重跑一次失敗的分析不該連帶重跑兩小時的轉錄
  //
  // 兩種可重跑的狀態，各自對到不同的佇列（vault plan「MeetPilot · 轉錄分析佇列架構升級」AC-4）：
  // FAILED 是轉錄失敗（job 重試次數用盡），退回 CREATED 重新入列轉錄；TRANSCRIBED 是分析失敗
  // 退回來的落點（`runAnalysisPhase` 一律退回這裡，不管 job 重試次數有沒有用盡），逐字稿已經
  // 在，不用重新轉錄，重新入列一個分析 job 就好，meeting 狀態本身不用改（worker claim 到之後
  // 自己會轉 ANALYZING）。
  app.post('/api/meetings/:id/retry', (req, res) => {
    try {
      const meetingId = req.params.id;
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });

      if (meeting.status === 'TRANSCRIBED') {
        if (analysisQueue.has(meetingId)) {
          return res.status(409).json({ error: `Meeting ${meetingId} 已經在分析佇列裡，正在等著跑` });
        }
        analysisQueue.enqueue(meetingId);
        return res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
      }

      if (meeting.status !== 'FAILED') {
        return res.status(409).json({
          error: `Meeting ${meetingId} 目前是 ${meeting.status}，只有 FAILED 或 TRANSCRIBED 能重跑`,
        });
      }
      if (!audioStore.exists(meetingId)) {
        return res.status(409).json({
          error: `Meeting ${meetingId} 的音檔已經不在 server 上，無法重跑，請重新上傳`,
        });
      }

      meetingStore.setStatus(meetingId, 'CREATED', Date.now());
      transcriptionQueue.enqueue(meetingId);
      // enqueue 是同步走到 pipeline 第一個 await 為止的，那時狀態已經是 TRANSCRIBING。
      // 送出 setStatus 當下那份就是說謊：body 寫 CREATED、資料庫已經不是。
      // 照契約讀它的人會把「CREATED ＋ has_audio」判成「等使用者上傳」，那是相反的意思
      res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 刪除整場會。規則與錯誤路徑在 services/meetingEdits.ts，這裡只把結果攤成 HTTP
  //
  // 不傳 queue：`meetings` 刪除時 `jobs` 表的對應列靠外鍵 `ON DELETE CASCADE` 自動清掉
  // （`services/meetingDb.ts` 的 `jobs` 表定義），不像舊的記憶體 `TranscriptionQueue` 需要
  // 外部明講一次「這場不用跑了」才會清掉排隊中的項目——job table 本身就是真相源，
  // 刪除 meeting 這件事本身已經足夠
  //
  // 錄音中的會要先叫語音備忘錄停止才刪：直接刪掉的話語音備忘錄會一直錄下去，而畫面上
  // 再也沒有任何停止按鍵。停不下來就不刪。語音備忘錄裡已經錄的那支不動，那是使用者的檔案
  app.delete('/api/meetings/:id', async (req, res) => {
    const meetingId = req.params.id;
    try {
      const meeting = meetingStore.getMeeting(meetingId);
      // app 內錄音在頁面手上，server 叫不動也不用叫：頁面刪除前自己停掉麥克風，已送到的段落跟著會議一起刪。
      // 但有一段正在寫就不刪：它寫完會在會議刪掉之後重建 `<id>.recording`，變成沒有任何清理路徑認領的檔（Codex review）
      if (meeting?.status === 'RECORDING' && chunkWriting.has(meetingId)) {
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ error: `Meeting ${meetingId} 有一段錄音正在寫，等它寫完再刪` });
      }
      if (meeting?.status === 'RECORDING' && recordingOf(meeting)!.method === 'voice_memo') {
        const recorder = recorderFor(req, res);
        if (!recorder) return;
        if (recorderBusy !== null) return res.status(409).json({ error: recorderBusyError() });
        const recording = meetingStore.getRecording(meetingId);
        if (recording?.stopped_at === null) {
          recorderBusy = meetingId;
          try {
            await recorder.stop();
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return res.status(502).json({
              error: `語音備忘錄沒有停止，所以這場會沒有刪除：${reason}。請到語音備忘錄確認錄音狀態`,
            });
          } finally {
            recorderBusy = null;
          }
          // 停止成功就先落地，再往下刪（Codex review 抓到）：下面刪檔或刪紀錄失敗時這場會還在，
          // 沒記下停止時間的話，重試停止或刪除會再叫一次 Stop，而使用者那之間若在語音備忘錄
          // 開了另一支錄音，被停的就是那一支
          meetingStore.markRecordingStopped(meetingId, Date.now());
        }
      }
      const outcome = deleteMeetingRequest(
        { store: meetingStore, audioStore, uploading },
        meetingId,
      );
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 人工編輯逐字稿（含儲存潤稿）。只更新有給的欄位
  app.patch('/api/meetings/:id/transcript', (req, res) => {
    try {
      const outcome = patchTranscriptRequest({ store: meetingStore }, req.params.id, req.body, Date.now());
      // 逐字稿的總長度會投影成 vault 檔的 duration_minutes，編輯成功就要重投影，
      // 不然 vault 內容會跟 SQLite 永久對不起來（code review 2026-09-18：這兩條 PATCH
      // 路由原本沒接線，是唯一會改到投影內容卻不會觸發重投影的路徑）
      if (outcome.status === 200) runProjection(vaultProjector, req.params.id, '[MeetPilot]');
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 人工編輯會議記錄。整份覆寫，前端送的是編輯後的完整 v2
  app.patch('/api/meetings/:id/analysis', (req, res) => {
    try {
      const outcome = patchAnalysisRequest({ store: meetingStore }, req.params.id, req.body, Date.now());
      // 理由同上面的 /transcript：結論、待辦、討論題目、標題全部來自 analysis，
      // 人工修正之後不重投影的話 vault 檔會永遠停在修正前的版本
      if (outcome.status === 200) runProjection(vaultProjector, req.params.id, '[MeetPilot]');
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 改標題。不重投影：vault 檔的 heading 與檔名取自 analysis.overview（SDD 1.3.1），跟這個欄位無關
  app.patch('/api/meetings/:id/title', (req, res) => {
    try {
      const outcome = patchTitleRequest({ store: meetingStore }, req.params.id, req.body, Date.now());
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      handleStoreError(err, res);
    }
  });

  // 沒有對外的 Gemini 路由。轉錄與分析的路由在 W2 T2 之後零呼叫端（那兩件事的發起點
  // 改成 server 端的 transcriptionPipeline），已經移除；問答串流路由在 2026-09-20 連同前端一起拿掉；
  // 全文修潤（POST /api/gemini/polish）在 2026-10-10 連同前端按鈕一起拿掉。
  // geminiServerClient 的 transcribeSlice 與 analyzeTranscript 都是 pipeline 內部呼叫，沒有對外路由。

  return app;
}

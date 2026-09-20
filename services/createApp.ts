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
import { Meeting } from '../types';
import { MeetingView, audioUploadInFlightError, audioUploadQueuedError } from './meetingApi';
import { checkBasicAuth, createRateLimiter, describeBodyParserError, ListenConfig } from './httpGuards';
import { LlmLogger } from './llmTelemetry';
import { MeetingStore } from './meetingStore';
import { MigrationRecord, isRejected, toMigrationRecord } from './jobMigration';
import { GeminiServerClient, formatTranscriptWithTimeForAI, getAI } from './geminiServerClient';
import { AudioFileStore } from './audioFileStore';
import { TranscriptionQueue } from './transcriptionQueue';
import { deleteMeetingRequest, patchAnalysisRequest, patchTranscriptRequest } from './meetingEdits';
import { TopicLinker } from './topicLinker';
import { runProjection, VaultProjector } from './vaultProjector';

export interface AppDeps {
  listenConfig: ListenConfig;
  meetingStore: MeetingStore;
  audioStore: AudioFileStore;
  transcriptionQueue: TranscriptionQueue;
  geminiClient: GeminiServerClient;
  llmLogger: LlmLogger;
  /** 跨會議關聯（W4）。null 代表這台 server 把關聯關掉了（`MEETPILOT_LINKING=off`） */
  topicLinker?: TopicLinker | null;
  /** 投影到 Obsidian vault（W5）。跟 topicLinker 不同，這裡沒有對應的 off 開關，見 vaultProjector.ts 檔頭 */
  vaultProjector?: VaultProjector | null;
}

export function createApp(deps: AppDeps): express.Express {
  const { listenConfig, meetingStore, audioStore, transcriptionQueue, geminiClient, llmLogger } = deps;
  const topicLinker = deps.topicLinker ?? null;
  const vaultProjector = deps.vaultProjector ?? null;

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
    return { ...meeting, has_audio: hasAudio };
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
      // 前端 services/retryPolicy.ts 靠 HttpError.status === 429 加 Retry-After 決定退避；訊息帶 "429" 是給人看的，也讓 translateError 分類得到
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
        meetingStore.resetTranscriptionProgress(meetingId, Date.now());
        saved = await audioStore.saveFrom(meetingId, req);
      } catch (err) {
        // 上傳失敗時舊音檔不能留在最終路徑：前一輪的逐字稿與游標剛剛已經清掉了，留著會變成
        // 「舊音檔 ＋ 空游標」，下次重啟掃描看到 CREATED ＋ 音檔在就把整個舊音檔重轉一遍
        // （一場 100 分鐘的會就是全額 Gemini 費用），而那正是使用者剛剛想換掉的內容。
        // 清掉之後它回到 CREATED ＋ 無音檔，前端會給上傳入口，使用者重送就好。
        // 清不掉只記 log 不換掉原始錯誤：上傳失敗的原因才是使用者要看的那個
        try {
          audioStore.remove(meetingId);
        } catch (removeErr) {
          console.error(`[MeetPilot] Meeting ${meetingId} 上傳失敗後清音檔也失敗：`, removeErr);
        }
        throw err;
      } finally {
        uploading.delete(meetingId);
      }

      if (saved.bytes === 0) {
        // 空檔案照收的話，ffprobe 會在背景才失敗，使用者要等到狀態變 FAILED 才知道上傳有問題。
        // 刪掉剛收的空檔、狀態留在 CREATED，使用者重送一次就好
        audioStore.remove(meetingId);
        return res.status(400).json({ error: '上傳的音檔是空的，沒有內容可以轉錄' });
      }

      meetingStore.setStatus(meetingId, 'TRANSCRIBING', Date.now());
      transcriptionQueue.enqueue(meetingId);
      // enqueue 會同步跑到 pipeline 的第一個 await 為止，狀態可能又往前走了。
      // 回應前重讀一次，不要送一份當下已經不成立的狀態出去
      res.status(202).json({ meeting: toView(meetingStore.getMeeting(meetingId)!) });
    } catch (err) {
      handleStoreError(err, res);
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

  function handleApiError(err: any, res: express.Response) {
    console.error('[Gemini API Server Error]:', err?.message || err);
    let statusCode = 500;
    let message = err?.message || 'Gemini API 處理發生錯誤';

    try {
      if (typeof err?.message === 'string' && err.message.trim().startsWith('{')) {
        const parsed = JSON.parse(err.message);
        if (parsed?.error) {
          statusCode = parsed.error.code || 500;
          message = parsed.error.message || message;
        }
      }
    } catch {}

    if (err?.status && typeof err.status === 'number') {
      statusCode = err.status;
    }

    // Prevent reverse proxies (e.g. nginx in container) from intercepting 502/503/504
    // and returning an HTML page (<!doctype html>) instead of our JSON response.
    if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
      statusCode = 500;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: message,
      rawError: err?.message,
    });
  }

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      hasKey: !!process.env.GEMINI_API_KEY,
    });
  });

  // Meeting 相關的錯誤自己接：handleApiError 是為 Gemini 的錯誤形狀寫的（會去解析 err.message 裡的 JSON），
  // 用在這裡會把 store 的錯誤印成 Gemini 錯誤，出事時找錯地方
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

  // 建立一場會。音檔另外用 PUT /api/meetings/:id/audio 送，分兩步是因為上傳要走原始位元組、
  // 不經 body parser，而這些欄位是 JSON；混在一起就得自己解 multipart
  app.post('/api/meetings', (req, res) => {
    try {
      const { fileName, fileSize, title, meetingContext, tags = [] } = req.body ?? {};
      if (typeof fileName !== 'string' || fileName.trim() === '') {
        return res.status(400).json({ error: 'fileName 必須是非空字串' });
      }
      if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
        return res.status(400).json({ error: 'fileSize 必須是非負數字' });
      }
      if (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string')) {
        return res.status(400).json({ error: 'tags 必須是字串陣列' });
      }
      if (title !== undefined && typeof title !== 'string') {
        return res.status(400).json({ error: 'title 必須是字串' });
      }
      if (meetingContext !== undefined && typeof meetingContext !== 'string') {
        return res.status(400).json({ error: 'meetingContext 必須是字串' });
      }

      // randomUUID 不含路徑字元，可以直接當音檔檔名（見 audioFileStore 的 SAFE_MEETING_ID）
      const meetingId = randomUUID();
      const meeting = meetingStore.createMeeting({
        meeting_id: meetingId,
        title: title ?? null,
        created_at: Date.now(),
        source_file_name: fileName,
        source_file_size: fileSize,
        meeting_context: meetingContext ?? null,
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
        transcript: meetingStore.getTranscript(req.params.id),
        analysis: meetingStore.getAnalysis(req.params.id),
        tags: meetingStore.getTags(req.params.id),
        // 題目標籤與上面的 tags 分成兩個欄位送（契約檔有寫為什麼不能併）
        topicTags: meetingStore.getTopicTags(req.params.id),
        seamReport: meetingStore.getSeamReport(req.params.id),
        // 關聯與它的覆蓋率（W4）。空陣列要配 status 一起讀，理由在契約檔
        links: meetingStore.getLinks(req.params.id),
        linkRun: meetingStore.getLinkRun(req.params.id),
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
  app.post('/api/meetings/:id/retry', (req, res) => {
    try {
      const meetingId = req.params.id;
      const meeting = meetingStore.getMeeting(meetingId);
      if (!meeting) return res.status(404).json({ error: `找不到 Meeting ${meetingId}` });
      if (meeting.status !== 'FAILED') {
        return res.status(409).json({ error: `Meeting ${meetingId} 目前是 ${meeting.status}，只有 FAILED 能重跑` });
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
  app.delete('/api/meetings/:id', (req, res) => {
    try {
      const outcome = deleteMeetingRequest(
        { store: meetingStore, audioStore, queue: transcriptionQueue, uploading },
        req.params.id,
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

  // 前端仍在用的一條 Gemini 路由。轉錄與分析的路由在 W2 T2 之後零呼叫端（那兩條事的發起點
  // 改成 server 端的 transcriptionPipeline），已經移除；geminiServerClient 的
  // transcribeSlice 留著，pipeline 在用；分析改走 analysisClient.ts 的 Claude client
  // （2026-09-20），同樣是 pipeline 內部呼叫，沒有對外路由。

  // 1. Polish Transcript（components/TranscriptView.tsx）
  app.post('/api/gemini/polish', async (req, res) => {
    try {
      const { transcript } = req.body;
      if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
        return res.json({ content: '' });
      }

      const content = await geminiClient.polishTranscript(transcript);
      res.json({ content });
    } catch (err: any) {
      handleApiError(err, res);
    }
  });

  // 2. Chat Q&A Streaming (SSE)（components/ChatView.tsx）
  app.post('/api/gemini/chat-stream', async (req, res) => {
    try {
      const { transcript = [], history = [], question } = req.body;
      if (!question) {
        return res.status(400).json({ error: 'Question is required' });
      }

      const ai = getAI();
      const docContext = formatTranscriptWithTimeForAI(transcript);
      const recentHistory = history.slice(-6).map((h: any) => ({
        role: h.role,
        parts: [{ text: h.text }],
      }));

      const chatHistory = [
        {
          role: 'user',
          parts: [{ text: `這是本次會議的完整逐字稿內容 (含時間戳記)：\n\n${docContext}\n\n請閱讀並記住上述內容，準備回答問題。` }],
        },
        {
          role: 'model',
          parts: [{ text: '好的，我已經閱讀並理解了會議逐字稿。請問有什麼關於這次會議的問題需要我協助解答？我將會基於上述文件內容進行精準回覆並附上時間引用。' }],
        },
        ...recentHistory,
      ];

      const chatConfig = {
        systemInstruction: '你是一位專業的會議助理。任務是回答用戶關於「會議逐字稿」的具體問題。準則：嚴格基於事實，引用時間戳記 [MM:SS]，繁體中文回答。',
      };

      const models = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
      let responseStream: any = null;
      let lastErr: any;
      // 這條路徑不走 generateContentWithFallback，紀錄要自己埋，而且跨「建立」與「消費」兩段：
      // 成功建立的那個 model 與起算時間要傳到下面
      let streamModel = '';
      let streamModelIndex = -1;
      let streamStartedAt = 0;

      for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const model = models[modelIndex];
        const startedAt = Date.now();
        try {
          const chat = ai.chats.create({
            model,
            history: chatHistory,
            config: chatConfig,
          });
          responseStream = await chat.sendMessageStream({ message: question });
          streamModel = model;
          streamModelIndex = modelIndex;
          streamStartedAt = startedAt;
          break;
        } catch (err: any) {
          lastErr = err;
          const msg = (err?.message || '').toLowerCase();
          const isTransient = msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') || msg.includes('429');
          llmLogger.log({
            kind: 'chat-stream',
            model,
            modelIndex,
            attempt: 1,
            streamed: true,
            latencyMs: Date.now() - startedAt,
            outcome: isTransient ? 'transient' : 'fatal',
            error: err,
          });
          if (!isTransient) throw err;
        }
      }

      if (!responseStream) throw (lastErr || new Error('無法建立對話串流'));

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let firstChunkAt: number | null = null;
      // Gemini 在串流尾端才給完整的 usageMetadata，留住最後一個帶它的 chunk
      let usageChunk: unknown = null;

      // 消費串流的錯誤在這裡就記，不留給外層 catch：外層也接得到上面建立階段的錯，
      // 在那裡記會把已經記過的那一筆再記第二次
      try {
        for await (const chunk of responseStream) {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          if (chunk.usageMetadata) usageChunk = chunk;
          if (chunk.text) {
            res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
          }
        }
      } catch (err) {
        llmLogger.log({
          kind: 'chat-stream',
          model: streamModel,
          modelIndex: streamModelIndex,
          attempt: 1,
          streamed: true,
          latencyMs: Date.now() - streamStartedAt,
          ttfbMs: firstChunkAt === null ? null : firstChunkAt - streamStartedAt,
          // 斷在中途不算可重試：部分內容已經送出去了
          outcome: 'fatal',
          error: err,
        });
        throw err;
      }

      llmLogger.log({
        kind: 'chat-stream',
        model: streamModel,
        modelIndex: streamModelIndex,
        attempt: 1,
        streamed: true,
        latencyMs: Date.now() - streamStartedAt,
        ttfbMs: firstChunkAt === null ? null : firstChunkAt - streamStartedAt,
        outcome: 'ok',
        response: usageChunk,
      });

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err: any) {
      if (!res.headersSent) {
        handleApiError(err, res);
      } else {
        res.write(`data: ${JSON.stringify({ error: err?.message || '串流錯誤' })}\n\n`);
        res.end();
      }
    }
  });

  return app;
}

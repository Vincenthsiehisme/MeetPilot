import express from 'express';
import path from 'path';
import { writeSync } from 'node:fs';
import { resolveListenConfig } from './services/httpGuards';
import { createLlmLogger, resolveLlmLogPath } from './services/llmTelemetry';
import { openMeetingDb, resolveDbPath } from './services/meetingDb';
import { createMeetingStore } from './services/meetingStore';
import { createPeopleStore } from './services/peopleStore';
import { importRosterFromFile, resolveRosterCsvPath } from './services/rosterImportRunner';
import { importRosterDocumentFromFile, resolveRosterDocumentPath } from './services/rosterDocument';
import { createNameResolver } from './services/nameResolver';
import { createGeminiServerClient } from './services/geminiServerClient';
import { createAudioFileStore, resolveAudioDir } from './services/audioFileStore';
import { createAudioSlicer, resolveFfmpegPaths } from './services/audioSlicer';
import { backfillInterruptedMeetings, createTranscriptionPipeline } from './services/transcriptionPipeline';
import { createTopicExtractor } from './services/topicExtractor';
import { createTopicLinker, isLinkingEnabled } from './services/topicLinker';
import { resolveSeamRepairConfig } from './services/seamRepair';
import { createJobStore } from './services/jobStore';
import { createJobWorker } from './services/jobWorker';
import { createApp } from './services/createApp';
import { createVaultProjector, resolveVaultDir } from './services/vaultProjector';
import { createVoiceMemoRecorder } from './services/voiceMemoRecorder';

// 這個檔只做三件事：把真的依賴組出來、交給 createApp、listen。
// 路由與 middleware 全部在 services/createApp.ts，理由見那個檔的檔頭（測得動）。

const DECIMAL_INTEGER = /^\d+$/;

/**
 * 轉錄／分析各自可以同時跑幾場會（vault plan「MeetPilot · 轉錄分析佇列架構升級」）。
 * 預設都是 1，沿用升級前完全序列的行為——拆解本身的價值先體現在「失敗互不阻塞、可以獨立
 * 重跑」，調高併發是可選的加值，不是升級當天就要開。
 */
function resolveJobConcurrency(env: NodeJS.ProcessEnv, key: string): number {
  const raw = (env[key] ?? '').trim();
  if (raw === '') return 1;
  if (!DECIMAL_INTEGER.test(raw) || Number(raw) < 1) {
    throw new Error(`${key}="${raw}" 必須是正整數，請修正 .env`);
  }
  return Number(raw);
}

// 監聽設定在啟動時就解析：HOST 不是本機位址又沒設 Basic Auth 會在這裡直接拋錯，不進 listen
const listenConfig = resolveListenConfig(process.env);

// Gemini 呼叫紀錄也在啟動時開檔：log 路徑不可寫要在這裡爆，不要等到第一次轉錄才發現沒留下任何紀錄
const llmLogger = createLlmLogger(resolveLlmLogPath(process.env));

// 一期的結構化儲存。同樣在啟動時開：資料庫開不起來（路徑不可寫、schema 版本比程式碼新）
// 要在這裡爆，不要等到使用者送出第一場會才發現存不進去
const meetingDb = openMeetingDb(resolveDbPath(process.env));
const meetingStore = createMeetingStore(meetingDb);
// 人員名單（人名校正 N1／N2）。同一個 DB 檔案，跟 meetingStore 共用交易與備份邊界，
// 手動匯入仍是 scripts/importRoster.ts 的事（CLI 而非 API，2026-09-21 決策不變）。
// 啟動時的自動匯入有兩個來源，只能設一個：
// - MEETPILOT_ROSTER_DOCUMENT（桌面 app，E3）：外殼每次啟動從 gateway 拿名單寫成這個檔，
//   server 每次啟動都匯入（upsert），admin 發布新名單後各台 app 下次啟動就跟上。
// - MEETPILOT_ROSTER_CSV（網頁版）：people 表還是空的時候補一次（2026-09-22 決策）。
// 兩個都設的話不默默挑一個：挑錯的那個看起來完全正常，只是名單不是你以為的那份。
// 格式錯誤要在這裡爆，不要吞掉讓 server 帶著沒匯入名單的假象繼續跑。
const peopleStore = createPeopleStore(meetingDb);
const rosterDocumentPath = resolveRosterDocumentPath(process.env);
const rosterCsvPath = resolveRosterCsvPath(process.env);
if (rosterDocumentPath && rosterCsvPath) {
  throw new Error(
    'MEETPILOT_ROSTER_DOCUMENT 與 MEETPILOT_ROSTER_CSV 只能設一個：前者是桌面 app 從 gateway 拿的名單，'
    + '後者是網頁版的本機 CSV',
  );
}
if (rosterDocumentPath) {
  const outcome = importRosterDocumentFromFile(rosterDocumentPath, peopleStore, Date.now());
  console.log(
    `[MeetPilot] 啟動時匯入 gateway 名單（${rosterDocumentPath}）：`
    + `people ${outcome.peopleWritten} 筆，person_aliases 新增 ${outcome.aliasesAdded} 筆`,
  );
} else if (peopleStore.listPeople().length === 0) {
  if (rosterCsvPath) {
    const outcome = importRosterFromFile(rosterCsvPath, peopleStore, Date.now());
    console.log(
      `[MeetPilot] 啟動時自動匯入人員名單（${rosterCsvPath}）：`
      + `people ${outcome.peopleWritten} 筆，person_aliases 新增 ${outcome.aliasesAdded} 筆`,
    );
  } else {
    console.warn(
      '[MeetPilot] 人員名單是空的：建立會議需要至少一位與會者，上傳會卡在選人畫面。'
      + '設定 MEETPILOT_ROSTER_CSV 讓 server 啟動時自動匯入，或手動執行'
      + ' `npx tsx scripts/importRoster.ts <csv-path>`。',
    );
  }
}
// 人名校正第 2 層（人名校正 N4）。同一個 DB 檔案，`name_mentions` 表跟其他資料共用
// 交易與備份邊界，理由同 peopleStore
const nameResolver = createNameResolver(meetingDb, peopleStore, meetingStore);

// 轉錄鏈的相依物件。音檔目錄同樣在啟動時就建：目錄不可寫要在這裡爆，
// 不要等到使用者上傳第一個音檔才發現寫不進去
const audioStore = createAudioFileStore(resolveAudioDir(process.env));
const ffmpegPaths = resolveFfmpegPaths(process.env);
const geminiClient = createGeminiServerClient(llmLogger);
// 破洞修復的設定同樣在啟動時解析：budget 寫錯值要在這裡爆，不要等到跑了一小時的會
// 才發現修復從頭到尾沒開過
const seamRepair = resolveSeamRepairConfig(process.env);

// 跨會議關聯（W4）。關掉時整個 module 不建，pipeline 收到 null 就跳過關聯、會議停在 READY
// ——那是「還沒算」，跟 LINK_FAILED（算了、失敗了）不是同一件事
const topicLinker = isLinkingEnabled(process.env)
  ? createTopicLinker({ store: meetingStore, gemini: geminiClient })
  : null;
if (!topicLinker) {
  console.log('[MeetPilot] MEETPILOT_LINKING=off，跨會議關聯關閉，會議會停在 READY');
}

// 投影到 Obsidian vault（W5）。跟 topicLinker 不同，沒有 off 開關：目錄不可寫要在啟動時就爆，
// 不要等到第一場會 READY 才發現寫不進去（同一套理由見上面 audioStore／llmLogger 的註解）
const vaultDir = resolveVaultDir(process.env);
const vaultProjector = createVaultProjector({ store: meetingStore, vaultDir, nameResolver });
console.log(`[MeetPilot] 會議 markdown 投影到 ${vaultDir}`);

const transcriptionPipeline = createTranscriptionPipeline({
  store: meetingStore,
  peopleStore,
  nameResolver,
  seamRepair,
  audioStore,
  slicer: createAudioSlicer({ ffmpegPath: ffmpegPaths.ffmpeg, ffprobePath: ffmpegPaths.ffprobe }),
  gemini: geminiClient,
  topicExtractor: createTopicExtractor({ store: meetingStore, gemini: geminiClient }),
  topicLinker,
  vaultProjector,
});
// job table：轉錄與分析各自一條持久化 queue（vault plan「MeetPilot · 轉錄分析佇列架構升級」）。
// 跟 meetingStore 共用同一個 DB 檔案（jobs 表對 meetings 的外鍵靠它做 cascade 刪除）。
const jobStore = createJobStore(meetingDb);

// lease 要蓋過一次完整執行最壞情況的時間，寧可設寬也不要讓還在跑的 job 被錯誤回收
// （單一 process 下提早回收會導致同一場會被兩個呼叫同時跑，見 jobStore.ts 的 CAS 說明）。
// 轉錄可能是好幾小時的長會逐片轉，分析是一次 Gemini 呼叫加關聯與投影，正常應該在幾分鐘內完成。
const TRANSCRIPTION_LEASE_MS = 3 * 60 * 60_000;
const ANALYSIS_LEASE_MS = 30 * 60_000;

// analysisWorker 要給 transcriptionWorker 的 onSuccess 用（轉錄完自動接著排分析），
// 兩個 worker 互相不呼叫對方，只是轉錄成功時「順手 enqueue 一個分析 job」，用 let 處理宣告順序
let analysisWorker: ReturnType<typeof createJobWorker>;

const transcriptionWorker = createJobWorker({
  jobs: jobStore,
  kind: 'transcription',
  concurrency: resolveJobConcurrency(process.env, 'MEETPILOT_TRANSCRIPTION_CONCURRENCY'),
  workerId: `transcription-${process.pid}`,
  leaseMs: TRANSCRIPTION_LEASE_MS,
  run: (meetingId) => transcriptionPipeline.runTranscriptionPhase(meetingId),
  onSuccess: (meetingId) => {
    // 轉錄完自動接著排分析（今天的行為：轉完自動分析）。這裡才第一次讀「目前顯示的版本」，
    // 幾乎必然是 raw——PATCH 要等到 TRANSCRIBED 之後才會放行，而這個 onSuccess 是轉錄一成功
    // 就同步觸發的，中間沒有時間窗讓使用者搶進來編輯
    const transcript = meetingStore.getCurrentTranscript(meetingId);
    jobStore.enqueue(
      meetingId, 'analysis',
      { source_kind: transcript?.source_kind ?? 'raw', source_edit_version: transcript?.source_edit_version ?? null },
      Date.now(),
    );
    analysisWorker.poke();
  },
  onFailure: (meetingId, outcome, err) => {
    console.error(`[Transcription Worker] Meeting ${meetingId} 轉錄失敗（${outcome}）：`, err);
    if (outcome === 'failed') {
      transcriptionPipeline.markTranscriptionFailed(
        meetingId, err instanceof Error ? err.message : String(err),
      );
    }
    // outcome === 'queued'：meeting 還停在 TRANSCRIBING，worker 下一輪 tick 會自動撿回來重試
    // （不用在這裡做什麼；見 jobWorker.ts 的 runOne 檔頭關於「沒有 backoff」的說明）
  },
});

analysisWorker = createJobWorker({
  jobs: jobStore,
  kind: 'analysis',
  concurrency: resolveJobConcurrency(process.env, 'MEETPILOT_ANALYSIS_CONCURRENCY'),
  workerId: `analysis-${process.pid}`,
  leaseMs: ANALYSIS_LEASE_MS,
  run: (meetingId, payload) => transcriptionPipeline.runAnalysisPhase(meetingId, payload),
  onFailure: (meetingId, outcome, err) => {
    console.error(`[Analysis Worker] Meeting ${meetingId} 分析失敗（${outcome}）：`, err);
    // runAnalysisPhase 自己已經把 meeting 退回 TRANSCRIBED（不管 outcome 是 queued 還是
    // failed，那支都是正確的落點），這裡不用再做什麼
  },
});

// 給 createApp 的最小介面：只需要 enqueue／has，見 services/createApp.ts 的
// TranscriptionEnqueuer／AnalysisEnqueuer
const transcriptionQueue = {
  enqueue: (meetingId: string): void => {
    jobStore.enqueue(meetingId, 'transcription', null, Date.now());
    transcriptionWorker.poke();
  },
  has: (meetingId: string): boolean => jobStore.hasActive(meetingId, 'transcription'),
};
const analysisQueue = {
  enqueue: (meetingId: string): void => {
    const transcript = meetingStore.getCurrentTranscript(meetingId);
    jobStore.enqueue(
      meetingId, 'analysis',
      { source_kind: transcript?.source_kind ?? 'raw', source_edit_version: transcript?.source_edit_version ?? null },
      Date.now(),
    );
    analysisWorker.poke();
  },
  has: (meetingId: string): boolean => jobStore.hasActive(meetingId, 'analysis'),
};

// 語音備忘錄錄音（vault plan「MeetPilot · 網頁錄音」）。一律建起來、不設 off 開關：
// 能不能錄（是不是 macOS、三個捷徑在不在）每次由 GET /api/recording/availability 當下去查，
// 前端靠它決定錄音按鍵要不要出現，這裡不先判斷一次就記住
const voiceMemoRecorder = createVoiceMemoRecorder({
  shortcutsPath: 'shortcuts',
  ffprobePath: ffmpegPaths.ffprobe,
  platform: process.platform,
});

const app = createApp({
  listenConfig,
  meetingStore,
  peopleStore,
  nameResolver,
  audioStore,
  transcriptionQueue,
  analysisQueue,
  geminiClient,
  llmLogger,
  topicLinker,
  vaultProjector,
  voiceMemoRecorder,
});

// Vite middleware & Production static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // vite 是 devDependency，只有開發模式用得到。寫成檔頭的 static import 的話，esbuild 會把它
    // 轉成 dist/server.cjs 檔頭無條件的 require("vite")，不裝 devDependencies 的安裝（打包成
    // 桌面 app、`npm install --omit=dev`）一啟動就炸，跟有沒有走到這個分支無關
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 上次沒寫完的上傳留下的 .part 沒有任何其他路徑會刪它，在這裡一起清掉
  const removedPartials = audioStore.removePartialUploads();
  if (removedPartials.length > 0) {
    console.log(`[MeetPilot] 清掉 ${removedPartials.length} 個沒上傳完的暫存音檔：${removedPartials.join(', ')}`);
  }

  // job table 是持久化的，但「這個 process 還活著在跑它」這件事本身不是——server 一重啟，
  // 上一輪停在 claimed／running 的 job 一定是上一個 process 死掉留下的（單一 process 前提，
  // 見 jobStore.reclaimAllActive 的檔頭），先無條件全部回收。
  const reclaimed = jobStore.reclaimAllActive(Date.now());
  for (const { job, outcome } of reclaimed) {
    if (job.kind === 'analysis') {
      // runAnalysisPhase 的前置條件是 TRANSCRIBED；job 中斷代表這次分析沒跑完，
      // 不管等一下會不會重試，都要先把 meeting 退回去，這支同時是兩種 outcome 的正確落點
      transcriptionPipeline.markAnalysisFailed(
        job.meeting_id,
        new Error(outcome === 'failed' ? '分析多次中斷失敗（server 重啟），已用盡重試次數' : 'server 重啟前這次分析沒跑完'),
      );
    } else if (outcome === 'failed') {
      transcriptionPipeline.markTranscriptionFailed(job.meeting_id, '轉錄多次中斷失敗（server 重啟），已用盡重試次數');
    }
    // kind === 'transcription' && outcome === 'queued'：meeting 已經在 TRANSCRIBING，
    // 不用做什麼，worker 重新 claim 到之後 runTranscriptionPhase 會靠 processed_slices 續傳
  }
  if (reclaimed.length > 0) {
    console.log(
      `[MeetPilot] 回收 ${reclaimed.length} 個上次沒跑完的 job：`
      + reclaimed.map(r => `${r.job.meeting_id}(${r.job.kind}→${r.outcome})`).join(', '),
    );
  }

  // 回收完，再幫「沒有 active job 顧著」的在途會議補一筆——這次升級前就卡住的舊資料，
  // 或極短的競態窗口（見 backfillInterruptedMeetings 檔頭）
  const backfill = backfillInterruptedMeetings({ store: meetingStore, jobs: jobStore, audioStore });
  if (backfill.transcriptionRequeued.length > 0) {
    console.log(`[MeetPilot] 補上轉錄 job：${backfill.transcriptionRequeued.join(', ')}`);
  }
  if (backfill.analysisRequeued.length > 0) {
    console.log(`[MeetPilot] 補上分析 job：${backfill.analysisRequeued.join(', ')}`);
  }
  for (const failure of backfill.failed) {
    console.warn(`[MeetPilot] Meeting ${failure.meetingId} 轉為 FAILED：${failure.reason}`);
  }
  if (backfill.waitingForAudio.length > 0) {
    console.log(
      `[MeetPilot] ${backfill.waitingForAudio.length} 場會建立了但音檔還沒上傳，維持 CREATED 等上傳：`
      + backfill.waitingForAudio.join(', '),
    );
  }

  // 回收與補齊都是直接寫 job table，不是呼叫 transcriptionQueue.enqueue／analysisQueue.enqueue，
  // 不會自動觸發 worker 去搶——啟動流程的最後手動 poke 兩個 worker 一次
  transcriptionWorker.poke();
  analysisWorker.poke();

  const { host, port, basicAuth } = listenConfig;
  // Express 5 把 listen 失敗（EADDRINUSE、EACCES）交給這個 callback。不看 err 的話會印出「Server running」
  // 然後因為沒有任何東西撐住事件迴圈而以結束碼 0 安靜退出，看起來像成功（2026-09-24 實測）
  app.listen(port, host, (err?: Error) => {
    if (err) {
      // 同步寫 stderr 再結束：stderr 是 pipe（桌面版）時，console.error 的非同步寫入可能被 process.exit 截掉
      writeSync(2, `[MeetPilot] 無法在 ${host}:${port} 監聽：${err.message}\n`);
      process.exit(1);
    }
    console.log(`Server running on http://${host}:${port}${basicAuth ? ' (Basic Auth on /api/*)' : ''}`);
  });
}

startServer();

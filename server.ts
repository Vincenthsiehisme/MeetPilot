import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { resolveListenConfig } from './services/httpGuards';
import { createLlmLogger, resolveLlmLogPath } from './services/llmTelemetry';
import { openMeetingDb, resolveDbPath } from './services/meetingDb';
import { createMeetingStore } from './services/meetingStore';
import { createPeopleStore } from './services/peopleStore';
import { createNameResolver } from './services/nameResolver';
import { createGeminiServerClient } from './services/geminiServerClient';
import { createAudioFileStore, resolveAudioDir } from './services/audioFileStore';
import { createAudioSlicer, resolveFfmpegPaths } from './services/audioSlicer';
import { createTranscriptionPipeline, requeueInterruptedMeetings } from './services/transcriptionPipeline';
import { createTopicExtractor } from './services/topicExtractor';
import { createTopicLinker, isLinkingEnabled } from './services/topicLinker';
import { resolveSeamRepairConfig } from './services/seamRepair';
import { createTranscriptionQueue } from './services/transcriptionQueue';
import { createApp } from './services/createApp';
import { createVaultProjector, resolveVaultDir } from './services/vaultProjector';

// 這個檔只做三件事：把真的依賴組出來、交給 createApp、listen。
// 路由與 middleware 全部在 services/createApp.ts，理由見那個檔的檔頭（測得動）。

// 監聽設定在啟動時就解析：HOST 不是本機位址又沒設 Basic Auth 會在這裡直接拋錯，不進 listen
const listenConfig = resolveListenConfig(process.env);

// Gemini 呼叫紀錄也在啟動時開檔：log 路徑不可寫要在這裡爆，不要等到第一次轉錄才發現沒留下任何紀錄
const llmLogger = createLlmLogger(resolveLlmLogPath(process.env));

// 一期的結構化儲存。同樣在啟動時開：資料庫開不起來（路徑不可寫、schema 版本比程式碼新）
// 要在這裡爆，不要等到使用者送出第一場會才發現存不進去
const meetingDb = openMeetingDb(resolveDbPath(process.env));
const meetingStore = createMeetingStore(meetingDb);
// 人員名單（人名校正 N1／N2）。同一個 DB 檔案，跟 meetingStore 共用交易與備份邊界，
// 名單怎麼進來是 scripts/importRoster.ts 的事，這裡只負責讀
const peopleStore = createPeopleStore(meetingDb);
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
const vaultProjector = createVaultProjector({ store: meetingStore, vaultDir });
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
// in-process 序列佇列：同一時間只跑一場會（理由見 services/transcriptionQueue.ts 檔頭）
const transcriptionQueue = createTranscriptionQueue(transcriptionPipeline.run);

const app = createApp({
  listenConfig,
  meetingStore,
  peopleStore,
  nameResolver,
  audioStore,
  transcriptionQueue,
  geminiClient,
  llmLogger,
  topicLinker,
  vaultProjector,
});

// Vite middleware & Production static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
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

  // 佇列在記憶體裡，server 一重啟就空了。停在 TRANSCRIBING 的那幾場不掃回來的話，
  // 畫面上會永遠顯示轉錄中而其實沒有人在跑它
  const resume = requeueInterruptedMeetings({
    store: meetingStore,
    audioStore,
    enqueue: (meetingId: string) => transcriptionQueue.enqueue(meetingId),
  });
  if (resume.requeued.length > 0) {
    console.log(`[MeetPilot] 續傳 ${resume.requeued.length} 場未跑完的會：${resume.requeued.join(', ')}`);
  }
  for (const failure of resume.failed) {
    console.warn(`[MeetPilot] Meeting ${failure.meetingId} 轉為 FAILED：${failure.reason}`);
  }
  if (resume.waitingForAudio.length > 0) {
    console.log(
      `[MeetPilot] ${resume.waitingForAudio.length} 場會建立了但音檔還沒上傳，維持 CREATED 等上傳：`
      + resume.waitingForAudio.join(', '),
    );
  }

  const { host, port, basicAuth } = listenConfig;
  app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}${basicAuth ? ' (Basic Auth on /api/*)' : ''}`);
  });
}

startServer();

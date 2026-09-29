/**
 * MeetPilot 桌面 app 的主程序（vault plan「MeetPilot · 跨平台打包部署」E1）。
 *
 * 外殼刻意很薄：現有的 server（dist/server.cjs）原樣跑在 utilityProcess 裡，主視窗載它的網址。
 * server 用的是同步的 node:sqlite，放主程序會把視窗與托盤一起凍住，所以一定要是獨立程序。
 *
 * 三條不能退的規則：
 * - **只能有一個實例。** job table 的回收邏輯建立在「同一個 DB 只有一個 process」上
 *   （jobStore.reclaimAllActive），開兩個 app 會讓兩個 worker 搶同一場會。
 * - **server 掛了要看得見。** 不安靜重啟：跳視窗顯示 exit code 與最後幾行輸出，讓使用者決定重啟或結束。
 * - **關視窗不等於結束。** 錄音中關掉視窗很常見，app 縮到托盤繼續跑；只有托盤選單的「結束」會停 server。
 *
 * E4 起錄音在主視窗的頁面裡（MediaRecorder）。視窗藏起來時頁面照常跑（關掉背景節流），錄音中擋系統閒置睡眠；
 * 會讓頁面消失的動作（結束、托盤「設定…」）在錄音中先確認或拒絕，因為頁面一換掉錄音就斷了。
 *
 * E3 起，server 啟動前要先有三樣東西：gateway 的 token、Gemini key、投影資料夾。缺任何一樣就顯示外殼自己的
 * 設定頁（electron/setup.html）。三樣都有就每次啟動向 gateway 拿最新的 key 與名單：連不上用上次的、
 * 畫面標示離線；gateway 回 401（被撤銷）就刪掉 token 與 key、回設定頁，不退回上次的。
 *
 * E5 起從共享資料夾更新（electron/updater.ts）：啟動時與每 4 小時看一次投影資料夾旁邊的 `_更新/`，
 * 有驗過的新版就在托盤與畫面右上角提示，使用者按了才裝。錄音中不裝，因為更新要結束 app。
 * Windows 靜默安裝後自動重開；macOS 沒有簽章不能自動換版，打開 dmg 讓使用者自己拖。
 */
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, session, shell, systemPreferences, Tray,
  utilityProcess,
} from 'electron';
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildServerEnv, serverLogPathFor } from './serverEnv';
import { createLogTail } from './logTail';
import { resolveBundledFfmpeg } from './bundledFfmpeg';
import { GATEWAY_URL, GatewayError, createGatewayClient, syncWithGateway } from './gatewayClient';
import { DesktopCredentials, DesktopStoreError, createDesktopStore } from './desktopStore';
import { VaultFolderError, checkVaultFolder } from './vaultFolder';
import {
  PENDING_UPDATE_FILE, PendingUpdate, UpdateCheck, WINDOWS_INSTALL_ARGS, checkForUpdate, describeUpdateCheck, parsePendingUpdate,
  pendingUpdateDone, stageInstaller, updateFolderFor,
} from './updater';

// userData 固定叫 MeetPilot，不跟 package.json 的 name 走：資料夾名要穩定，改套件名或產品名不能讓資料「消失」。
// MEETPILOT_DESKTOP_USER_DATA 只給 scripts/smokeDesktop.mjs 用：冒煙測試要用拋棄式的資料夾，
// 不能拿正式資料啟動（server 一起來就會 migrate、回收 job、開始跑 worker）。單一實例鎖也跟著 userData 走，
// 所以測試跟正式 app 可以同時開
app.setPath('userData', process.env.MEETPILOT_DESKTOP_USER_DATA || join(app.getPath('appData'), 'MeetPilot'));

// MEETPILOT_DESKTOP_GATEWAY_URL 只給 scripts/smokeDesktop.mjs 用：冒煙測試指到自己起的假 gateway，
// 才驗得到首次設定、離線、撤銷三條路，又不用真的邀請碼
const gateway = createGatewayClient({ baseUrl: process.env.MEETPILOT_DESKTOP_GATEWAY_URL || GATEWAY_URL });

// token 與 key 只以 safeStorage 加密後落地（macOS Keychain、Windows DPAPI）。不能用的電腦拒絕存，不退回明文
const store = createDesktopStore(app.getPath('userData'), {
  encrypt(plain) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('這台電腦的安全儲存（macOS 鑰匙圈／Windows 資料保護）不能用，MeetPilot 不會把 Gemini key 存成明文');
    }
    return safeStorage.encryptString(plain);
  },
  decrypt: (cipher) => safeStorage.decryptString(cipher),
});

const SERVER_READY_TIMEOUT_MS = 30_000;
// 每次健康檢查自己的上限：連接埠被別的程式搶走、對方收了連線卻不回應時，不能卡過整體的就緒上限
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const LOG_TAIL_LINES = 40;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let serverOrigin: string | null = null;
let quitting = false;

// 錄音中（頁面經 preload 告訴主程序，E4）。powerSaveBlocker 的 id 是 null 代表沒擋
let recordingActive = false;
let sleepBlockerId: number | null = null;
// 錄音中按結束、使用者確認過了：第二次進 before-quit 就放行
let quitConfirmed = false;

function setRecordingActive(active: boolean, why: string): void {
  if (recordingActive === active) return;
  recordingActive = active;
  writeLog(`--- 錄音${active ? '開始' : '結束'}（${why}）---\n`);
  // 只擋「閒置睡眠讓 app 被暫停」，不擋螢幕關閉；筆電闔上蓋子擋不了，畫面上有講
  if (active && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!active && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

/** 這一輪 server 用的設定，向 gateway 同步完才有。錯誤視窗按「重新啟動」沿用同一份，不重新同步 */
interface ServerRuntime {
  geminiApiKey: string;
  vaultDir: string;
  rosterDocument?: string;
  /** 非空代表至少一樣用的是上次存的，server 的畫面上要掛離線橫幅 */
  offlineProblems: string[];
}
let runtime: ServerRuntime | null = null;
// 為了換設定而主動收掉的 server：它的結束不是崩潰，不跳錯誤視窗
const retiredServers = new WeakSet<UtilityProcess>();
// 設定頁上方要顯示的訊息（撤銷、登入資料壞掉、連不上），設定頁打開時來拿
let setupMessage: string | null = null;
let setupBusy = false;
const setupPagePath = () => join(app.getAppPath(), 'electron', 'setup.html');
const setupPageUrl = () => pathToFileURL(setupPagePath()).href;
// 用路徑比、不用網址字串比：Chromium 回報的 file 網址跟 pathToFileURL 在百分比編碼、Windows 磁碟代號大小寫上可能不同
function isSetupPageUrl(url: string | undefined): boolean {
  if (!url?.startsWith('file:')) return false;
  let path: string;
  try {
    path = resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  const expected = resolve(setupPagePath());
  return process.platform === 'win32' ? path.toLowerCase() === expected.toLowerCase() : path === expected;
}

/** 啟動階段的失敗：帶著結束碼與最後幾行輸出，交給唯一負責復原的地方（bootServerIntoWindow） */
class ServerStartupError extends Error {
  /** 這一輪 fork 出來的子程序；fork 之前就失敗（例如缺 ffmpeg）是 null */
  constructor(message: string, readonly code: number, readonly lines: string[], readonly child: UtilityProcess | null = null) {
    super(message);
  }
}

const logDir = () => join(app.getPath('userData'), 'logs');
const serverLogPath = () => serverLogPathFor(app.getPath('userData'));

// log 寫不進去（磁碟滿、權限、同名目錄）不能讓錯誤視窗跟著出不來：寫入失敗只記下原因，
// 在錯誤視窗裡講出來，不往上拋（Codex review 2026-09-24）
let logWriteError: string | null = null;
// killAndWait 等不到舊 server 結束時的警告，顯示在錯誤視窗裡；下一輪啟動時清掉
let staleServerWarning: string | null = null;
function writeLog(text: string): void {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(serverLogPath(), text);
  } catch (err) {
    logWriteError ??= (err as Error).message;
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('拿不到可用的連接埠'));
      });
    });
  });
}

async function waitForServer(origin: string, child: UtilityProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let exited = false;
  child.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server 在就緒之前就結束了');
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining)),
      });
      if (res.ok) return;
    } catch {
      // 還沒 listen（連線被拒）或這次沒在時限內回應，都是等待中的正常狀態，下一輪再試
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${SERVER_READY_TIMEOUT_MS / 1000} 秒內 server 沒有就緒`);
}

const statusPage = (title: string, body: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>MeetPilot</title>
     <body style="font-family:-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;padding:48px;color:#334155">
     <h2 style="margin:0 0 12px">${title}</h2><p style="color:#64748b">${body}</p></body>`,
  )}`;

async function startServer(): Promise<void> {
  if (runtime === null) throw new Error('還沒向 gateway 拿到 Gemini key 就要啟動 server（外殼的流程錯了）');
  const logTail = createLogTail(LOG_TAIL_LINES);
  // 寫入錯誤跟著這一輪 server 走：上次磁碟滿、這次空出來了，不該還顯示上次的原因
  logWriteError = null;
  staleServerWarning = null;
  const appPath = app.getAppPath();
  // 打包後缺 ffmpeg 在這裡就拋，由 bootServerIntoWindow 跳錯誤視窗，不讓 server 帶著「沒有 ffmpeg」起來
  const ffmpeg = resolveBundledFfmpeg({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath,
    platform: process.platform,
    arch: process.arch,
  });
  const port = await pickFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = utilityProcess.fork(join(appPath, 'dist', 'server.cjs'), [], {
    // server 從 cwd 找 dist/（前端）與 prompts/（會議記錄規範），所以 cwd 是 app 目錄，不是 userData
    cwd: appPath,
    env: buildServerEnv({
      baseEnv: process.env,
      userDataDir: app.getPath('userData'),
      port,
      geminiApiKey: runtime.geminiApiKey,
      vaultDir: runtime.vaultDir,
      rosterDocument: runtime.rosterDocument,
      ffmpeg,
      appVersion: app.getVersion(),
    }),
    stdio: 'pipe',
    serviceName: 'MeetPilot Server',
  });
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    logTail.push(text);
    writeLog(text);
  };
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', onOutput);
  writeLog(`\n--- ${new Date().toISOString()} 啟動 server（port ${port}）---\n`);
  writeLog(`ffmpeg：${ffmpeg ? ffmpeg.ffmpeg : '沒有隨附，走 PATH（開發模式）'}\n`);

  // 就緒之前的結束不在這裡處理：waitForServer 會拋，由 bootServerIntoWindow 的 catch 負責，
  // 只有一個地方跳錯誤視窗。兩邊都處理的話，使用者按兩次「重新啟動」就會起兩個 server 搶同一個 DB
  // （Codex review 2026-09-24）
  let ready = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code;
    if (server === child) server = null;
    if (quitting || !ready || retiredServers.has(child)) return;
    void onServerExit(code, logTail.lines());
  });
  server = child;
  try {
    await waitForServer(origin, child);
  } catch (err) {
    throw new ServerStartupError((err as Error).message, exitCode ?? -1, [...logTail.lines(), (err as Error).message], child);
  }
  // health 回 200 之後才處理到 exit 事件的話，exit listener 看到 ready === false 已經 return 了；
  // 這裡不再確認一次，這次崩潰就沒有任何地方處理（沒有錯誤視窗）
  if (exitCode !== null) {
    throw new ServerStartupError('server 回應健康檢查之後就結束了', exitCode, logTail.lines(), child);
  }
  ready = true;
  serverOrigin = origin;
}

async function onServerExit(code: number, lines: string[]): Promise<void> {
  serverOrigin = null;
  // 寫進同一份 log：事後查的時候看得出 server 什麼時候、以什麼結束碼停的，以及使用者看到了錯誤視窗
  writeLog(`--- ${new Date().toISOString()} server 結束（結束碼 ${code}），顯示錯誤視窗 ---\n`);
  const logNote = logWriteError === null
    ? `完整紀錄：${serverLogPath()}`
    : `紀錄檔寫不進去（${logWriteError}），這次沒有完整紀錄：${serverLogPath()}`;
  loadInWindow(statusPage('MeetPilot 的背景程式停止了', `結束碼 ${code}。${logNote}`));
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'MeetPilot',
    message: `MeetPilot 的背景程式停止了（結束碼 ${code}）`,
    detail: `最後幾行輸出：\n${lines.join('\n') || '（沒有輸出）'}\n\n${logNote}`
      + (staleServerWarning === null ? '' : `\n\n注意：${staleServerWarning}`),
    buttons: ['重新啟動', '結束 MeetPilot'],
    defaultId: 0,
    cancelId: 1,
  });
  writeLog(`--- 使用者選擇：${response === 0 ? '重新啟動' : '結束'} ---\n`);
  // 對話框開著的時候，使用者可能已經從托盤「設定…」換過設定、新的 server 也起來了：那就不再起一個
  if (response === 0) await requestBoot({ replaceRunning: false });
  else app.quit();
}

// loadURL 在下一次載入打斷它時會以 ERR_ABORTED reject（例如 server 在頁面載入途中崩潰，改載錯誤頁）。
// 那是預期的，其他失敗寫進 log，不留 unhandled rejection
function loadInWindow(url: string): void {
  mainWindow?.loadURL(url).catch((err: Error & { code?: string }) => {
    if (err.code === 'ERR_ABORTED') return;
    writeLog(`--- 視窗載入失敗（${url.slice(0, 80)}）：${err.message} ---\n`);
    // 不要留一個空白視窗：server 還活著但頁面載不出來時，把原因講在畫面上
    if (!url.startsWith('data:')) {
      loadInWindow(statusPage('MeetPilot 的畫面載不出來', `${err.message}。完整紀錄：${serverLogPath()}`));
    }
  });
}

// 殺掉子程序之後等它真的結束，才讓使用者按「重新啟動」：同一個 userData 只能有一個 server，
// 不能靠「SIGTERM 通常很快」這種時間差成立
function killAndWait(child: UtilityProcess | null, timeoutMs = 5_000): Promise<boolean> {
  if (!child) return Promise.resolve(true);
  // pid 是 undefined 有兩種情況：還沒 spawn 完成，或 exit 已經發出。兩種都先呼叫一次 kill()（結束後是 no-op），
  // 已經結束的就不用等
  if (child.pid === undefined) {
    child.kill();
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 這是「一個 userData 一個 server」唯一可能失守的時刻，不能安靜往下走
      staleServerWarning = `上一個背景程式（pid ${child.pid}）${timeoutMs / 1000} 秒內沒有結束，重新啟動前請先確認它已經停了`;
      writeLog(`--- ${staleServerWarning} ---\n`);
      resolve(false);
    }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
    child.kill();
  });
}

// 向 gateway 同步、存設定、起 server、換 server 一律排進這條佇列，一次只做一件：啟動時的同步、設定頁送出、
// 錯誤視窗的「重新啟動」可能同時發生，各自直接做的話，同一個 userData 會起兩個 server，或舊的同步結果
// 蓋掉剛存的新設定（2026-09-24 fable 與 Codex review）
let lifecycle: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(task, task);
  // 佇列本身不因為某一項失敗而斷掉；失敗由各呼叫端自己處理（設定頁轉成訊息、requestBoot 寫 log）
  lifecycle = next.catch(() => {});
  return next;
}

/**
 * replaceRunning：true 是換設定，先收掉現在的 server 再起新的；false 是「沒有 server 在跑才起」
 * （第一次啟動、崩潰後按重新啟動）。佇列裡不等錯誤對話框：對話框由 bootServerIntoWindow 丟出去就放手，
 * 按「重新啟動」會再排一次，不然佇列會卡在等使用者按按鈕
 */
function requestBoot(opts: { replaceRunning: boolean }): Promise<void> {
  return serialized(async () => {
    if (quitting) return;
    if (opts.replaceRunning) {
      if (!(await retireServer())) {
        loadInWindow(statusPage('MeetPilot 沒辦法換設定', `${staleServerWarning ?? '上一個背景程式沒有結束'}。請結束 MeetPilot 再重新打開，新的設定已經存好了。`));
        return;
      }
    } else if (server !== null) {
      showWindow();
      return;
    }
    await bootServerIntoWindow();
  }).catch((err: Error) => {
    // 呼叫端都是 void，這裡是唯一留下紀錄的地方
    writeLog(`--- 啟動流程出錯：${err.stack ?? err.message} ---\n`);
  });
}

async function bootServerIntoWindow(): Promise<void> {
  if (quitting) return;
  loadInWindow(statusPage('MeetPilot 啟動中…', '正在準備資料庫與背景程式。'));
  try {
    await startServer();
  } catch (err) {
    // 就緒失敗時子程序可能還活著（例如卡在啟動），先收掉，再交給跟崩潰同一條路處理。
    // 只收這一輪自己 fork 的那個，不碰全域的 server（那可能已經是別人起的）
    const child = err instanceof ServerStartupError ? err.child : null;
    if (server === child) server = null;
    await killAndWait(child);
    // 啟動途中使用者按了「結束」，或換設定把它收掉了：不是壞了，不跳錯誤視窗
    if (quitting || (child !== null && retiredServers.has(child))) return;
    const failure = err instanceof ServerStartupError ? err : new ServerStartupError(String(err), -1, [String(err)]);
    writeLog(`--- 啟動失敗：${failure.message} ---\n`);
    void onServerExit(failure.code, failure.lines);
    return;
  }
  loadInWindow(`${serverOrigin}/`);
}

// ---- gateway 與設定頁（E3） ----

function showSetup(message: string | null): void {
  setupMessage = message;
  if (message !== null) writeLog(`--- 顯示設定頁：${message} ---\n`);
  mainWindow?.loadURL(setupPageUrl()).catch((err: Error & { code?: string }) => {
    if (err.code !== 'ERR_ABORTED') writeLog(`--- 設定頁載入失敗：${err.message} ---\n`);
  });
}

/** 讀存著的設定與登入資料；讀不懂或解不開時講原因、回設定頁，不當成第一次安裝 */
function readStoredState(): { vaultDir: string | null; credentials: DesktopCredentials | null; problem: string | null } {
  let vaultDir: string | null = null;
  let credentials: DesktopCredentials | null = null;
  const problems: string[] = [];
  try {
    vaultDir = store.readSettings()?.vaultDir ?? null;
  } catch (err) {
    if (!(err instanceof DesktopStoreError)) throw err;
    problems.push(`上次的設定讀不出來，請重新選資料夾（${err.message}）`);
  }
  try {
    credentials = store.readCredentials();
  } catch (err) {
    if (!(err instanceof DesktopStoreError)) throw err;
    // 不刪：讀不到可能是暫時的（Windows 防毒鎖檔、macOS 鑰匙圈詢問時按了拒絕），刪了就只能重拿邀請碼。
    // 重新輸入邀請碼存檔時會整份蓋掉；只有 gateway 回 401 才刪（2026-09-24 review）
    // 兩個平台讀不出來的常見原因不同：macOS 是鑰匙圈詢問時按了拒絕；Windows 的加密金鑰存在 userData 的
    // Local State，設定完不到十秒 app 就被強制結束的話金鑰沒寫下來（2026-09-24 CI 實測）
    const hint = process.platform === 'darwin'
      ? '如果剛才鑰匙圈跳出詢問，請結束後重新打開 MeetPilot 並按「允許」；不然就重新輸入邀請碼'
      : '上次設定完 MeetPilot 可能很快就被強制結束，加密用的金鑰沒存下來，請重新輸入邀請碼';
    problems.push(`上次存的登入資料讀不出來（${err.message}）。${hint}`);
  }
  return { vaultDir, credentials, problem: problems.length === 0 ? null : problems.join('\n') };
}

/**
 * 向 gateway 同步，成功（含離線）就把設定交給 runtime，回 null；要回設定頁的話回原因。
 * 只存這次真的拿到的東西：拿不到的那一樣維持上次存的，不拿舊值重寫一次。
 */
async function syncIntoRuntime(credentials: DesktopCredentials, vaultDir: string): Promise<string | null> {
  const sync = await syncWithGateway(gateway, credentials.token, {
    geminiApiKey: credentials.geminiApiKey,
    hasRoster: store.hasRoster(),
  });
  if (sync.outcome === 'revoked') {
    store.clearCredentials();
    writeLog(`--- gateway 回 401，已刪掉存著的登入資料：${sync.message} ---\n`);
    return `這台電腦的邀請碼已失效（gateway：${sync.message}）。請向 admin 拿新的邀請碼。`;
  }
  if (sync.outcome === 'no-key') return `拿不到 Gemini key：${sync.message}`;
  // 跟設定頁同一道守衛：沒有上次的名單、這次也拿不到，起來的 server 建不了會議（Codex review 第二輪）
  if (sync.freshRoster === null && !store.hasRoster()) {
    return `拿不到人員名單，也沒有上次存的：${sync.problems.join('；')}。確認網路後按「儲存並開始」再試一次。`;
  }
  if (sync.freshKey !== null && sync.freshKey !== credentials.geminiApiKey) {
    store.writeCredentials({ ...credentials, geminiApiKey: sync.freshKey });
  }
  if (sync.freshRoster !== null) store.writeRoster(sync.freshRoster);
  runtime = {
    geminiApiKey: sync.geminiApiKey,
    vaultDir,
    rosterDocument: store.hasRoster() ? store.rosterPath : undefined,
    offlineProblems: sync.problems,
  };
  writeLog(sync.problems.length === 0
    ? '--- gateway：key 與名單都是最新的 ---\n'
    : `--- gateway：離線，${sync.problems.join('；')} ---\n`);
  return null;
}

async function startApp(): Promise<void> {
  // 同步與起 server 在同一個佇列項目裡做完：中間讓設定頁插進來的話，這裡拿到的就是換設定之前的結果
  const outcome = await serialized(async (): Promise<Error | null> => {
    try {
      const { vaultDir, credentials, problem } = readStoredState();
      if (vaultDir === null || credentials === null) {
        showSetup(problem);
        return null;
      }
      // 上次選的共享資料夾可能已經被取消同步、刪掉或變唯讀。不驗的話 server 會自己建一個不會同步的本機資料夾，
      // 投影失敗也只寫 log，記錄人以為記錄有出去（Codex review 第三輪）
      try {
        checkVaultFolder(vaultDir);
      } catch (err) {
        if (!(err instanceof VaultFolderError)) throw err;
        showSetup(`上次選的會議記錄資料夾現在不能用：${err.message}。請重新選一個。`);
        return null;
      }
      loadInWindow(statusPage('MeetPilot 啟動中…', '正在向 gateway 更新 Gemini key 與人員名單。'));
      const failure = await syncIntoRuntime(credentials, vaultDir);
      if (failure !== null) {
        showSetup(failure);
        return null;
      }
      if (server === null) await bootServerIntoWindow();
      return null;
    } catch (err) {
      return err as Error;
    }
  });
  if (outcome !== null) {
    // 寫不進 userData（磁碟滿、權限）、安全儲存加密失敗這類：不能讓畫面停在「啟動中」、什麼都不說
    const reason = outcome.message;
    writeLog(`--- 啟動前的準備失敗：${outcome.stack ?? reason} ---\n`);
    loadInWindow(statusPage('MeetPilot 沒辦法啟動', `${reason}。完整紀錄：${serverLogPath()}`));
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'MeetPilot',
      message: 'MeetPilot 啟動前的準備失敗',
      detail: `${reason}\n\n完整紀錄：${serverLogPath()}`,
      buttons: ['再試一次', '結束 MeetPilot'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await startApp();
    else app.quit();
  }
}

/**
 * 換設定前收掉目前的 server：同一個 userData 只能有一個 server，而且它的結束不是崩潰。回傳它有沒有真的結束。
 * 等不到結束就不放掉它：server 仍指著它，下一次換設定會再收一次，「沒有 server 才起」也不會誤判（Codex review）
 */
async function retireServer(): Promise<boolean> {
  const child = server;
  serverOrigin = null;
  if (!child) return true;
  retiredServers.add(child);
  const exited = await killAndWait(child);
  if (exited && server === child) server = null;
  return exited;
}

function fromSetupPage(event: IpcMainInvokeEvent): boolean {
  const ok = isSetupPageUrl(event.senderFrame?.url);
  if (!ok) writeLog(`--- 拒絕不是從設定頁來的設定請求（${event.senderFrame?.url ?? '未知'}）---\n`);
  return ok;
}

function registerSetupHandlers(): void {
  ipcMain.handle('recording:set', (event, active: unknown) => {
    if (!isServerUrl(event.senderFrame?.url ?? '')) {
      writeLog(`--- 拒絕不是從 server 頁面來的錄音狀態（${event.senderFrame?.url ?? '未知'}）---\n`);
      throw new Error('只有 server 的頁面能回報錄音狀態');
    }
    if (typeof active !== 'boolean') throw new Error('錄音狀態要是 true 或 false');
    setRecordingActive(active, '頁面回報');
  });

  // 右上角提示卡的「安裝新版」（E5）。跟錄音狀態一樣只收 server 頁面來的
  ipcMain.handle('update:install', (event) => {
    if (!isServerUrl(event.senderFrame?.url ?? '')) {
      writeLog(`--- 拒絕不是從 server 頁面來的安裝請求（${event.senderFrame?.url ?? '未知'}）---\n`);
      throw new Error('只有 server 的頁面能要求安裝新版');
    }
    void installUpdate();
  });

  ipcMain.handle('setup:load', (event) => {
    if (!fromSetupPage(event)) throw new Error('只有設定頁能叫');
    let vaultDir = '';
    try {
      vaultDir = store.readSettings()?.vaultDir ?? '';
    } catch (err) {
      if (!(err instanceof DesktopStoreError)) throw err;
    }
    let hasCredentials = false;
    try {
      hasCredentials = store.readCredentials() !== null;
    } catch (err) {
      if (!(err instanceof DesktopStoreError)) throw err;
    }
    // 取消只有 server 在跑時才有地方回去
    return { vaultDir, hasCredentials, canCancel: serverOrigin !== null, message: setupMessage };
  });

  ipcMain.handle('setup:choose-folder', async (event, current: unknown) => {
    if (!fromSetupPage(event) || !mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '選擇會議記錄資料夾',
      defaultPath: typeof current === 'string' && current.trim() !== '' ? current : app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('setup:cancel', (event) => {
    if (!fromSetupPage(event)) return;
    if (serverOrigin !== null) loadInWindow(`${serverOrigin}/`);
  });

  ipcMain.handle('setup:submit', async (event, input: unknown) => {
    if (!fromSetupPage(event)) return { ok: false, error: '只有設定頁能送出設定' };
    if (setupBusy) return { ok: false, error: '上一次送出還在處理' };
    setupBusy = true;
    try {
      const { code, vaultDir: rawVault } = (input ?? {}) as { code?: unknown; vaultDir?: unknown };
      const vaultDir = checkVaultFolder(typeof rawVault === 'string' ? rawVault : '');
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: '這台電腦的安全儲存（macOS 鑰匙圈／Windows 資料保護）不能用，MeetPilot 不會把 Gemini key 存成明文。' };
      }
      const newCode = typeof code === 'string' ? code.trim() : '';
      return await serialized(() => saveSetup(newCode, vaultDir));
    } catch (err) {
      if (err instanceof VaultFolderError || err instanceof GatewayError) return { ok: false, error: err.message };
      writeLog(`--- 儲存設定失敗：${(err as Error).stack ?? String(err)} ---\n`);
      return { ok: false, error: `儲存設定失敗：${(err as Error).message}` };
    } finally {
      setupBusy = false;
    }
  });
}

/** 設定頁送出的本體，在 lifecycle 佇列裡跑。錯誤往上拋，由 setup:submit 轉成畫面上的訊息 */
async function saveSetup(newCode: string, vaultDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = readStoredState().credentials;
  let credentials: DesktopCredentials;
  if (newCode !== '') {
    const redeemed = await gateway.redeem(newCode);
    // key 先沿用手上的（同一把給所有人），同步拿到新的會蓋掉；第一次設定就是空的，同步拿不到就不能開始
    credentials = { ...redeemed, geminiApiKey: existing?.geminiApiKey ?? '' };
  } else if (existing !== null) {
    credentials = existing;
  } else {
    return { ok: false, error: '請輸入邀請碼' };
  }
  const sync = await syncWithGateway(gateway, credentials.token, {
    geminiApiKey: credentials.geminiApiKey === '' ? null : credentials.geminiApiKey,
    hasRoster: store.hasRoster(),
  });
  if (sync.outcome === 'revoked') {
    if (newCode === '') {
      // 沿用的那組被撤銷了：跟啟動時一樣刪掉，而且正在跑的 server 手上還是舊 key，要一起停，
      // 不能讓使用者按「取消」回去繼續用到下次重開（Codex review）
      // 刪檔失敗（Windows 鎖檔）也一定要停 server；停不掉就明講，不回報成「已撤銷」（Codex review 第二輪）
      runtime = null;
      let stopped = false;
      try {
        store.clearCredentials();
      } finally {
        stopped = await retireServer();
      }
      writeLog(`--- 設定頁沿用的登入資料被 gateway 拒絕（401），已刪掉${stopped ? '並停掉 server' : '，但 server 沒有停下來'}：${sync.message} ---\n`);
      if (!stopped) {
        return { ok: false, error: `邀請碼已失效，但背景程式沒有停下來（${staleServerWarning ?? '逾時'}）。請結束 MeetPilot 再重新打開。` };
      }
    }
    return { ok: false, error: `gateway 不接受這組登入資料，請輸入新的邀請碼（gateway：${sync.message}）` };
  }
  if (sync.outcome === 'no-key') return { ok: false, error: `拿不到 Gemini key，設定沒有存：${sync.message}` };
  // 第一次設定就拿不到名單：server 起來也建不了會議（至少要選一位與會者），這種「完成」沒有意義，
  // 留在設定頁講原因。手上有上次的名單才走離線（Codex review）
  if (sync.freshRoster === null && !store.hasRoster()) {
    return { ok: false, error: `拿不到人員名單，設定沒有存：${sync.problems.join('；')}` };
  }
  // 到這裡才落地：邀請碼換到了、key 也拿到了，設定才算完成
  // 順序是契約：名單 → 登入資料 → 設定。啟動時兩個檔都在才算設定過，所以設定最後寫，等於「完成」的標記；
  // 中途失敗或斷電留下的是「沒設定過」，不是一個缺名單的假完成（Codex review 第二輪）
  if (sync.freshRoster !== null) store.writeRoster(sync.freshRoster);
  store.writeCredentials({ ...credentials, geminiApiKey: sync.geminiApiKey });
  store.writeSettings({ vaultDir });
  runtime = {
    geminiApiKey: sync.geminiApiKey,
    vaultDir,
    rosterDocument: store.hasRoster() ? store.rosterPath : undefined,
    offlineProblems: sync.problems,
  };
  setupMessage = null;
  writeLog(`--- 設定已儲存（邀請碼 ${newCode === '' ? '沿用' : `換成 ${credentials.inviteId}`}，資料夾 ${vaultDir}）---\n`);
  // 回應先送回設定頁，再換 server：換 server 排在這個佇列項目之後，頁面接著會被啟動畫面蓋掉
  void requestBoot({ replaceRunning: true });
  // 換了投影資料夾，更新資料夾也跟著換
  void runUpdateCheck('換設定', { recheck: true });
  return { ok: true };
}

// 離線時在 server 的畫面底部掛一條橫幅。外殼注入，不改前端：這是桌面版才有的狀態
function injectOfflineBanner(): void {
  if (!mainWindow || runtime === null || runtime.offlineProblems.length === 0) return;
  if (!isServerUrl(mainWindow.webContents.getURL())) return;
  const text = `離線：連不上 gateway，這次用上次存的資料。${runtime.offlineProblems.join('；')}。網路恢復後重新打開 MeetPilot 就會更新。`;
  void mainWindow.webContents.executeJavaScript(`(() => {
    if (document.getElementById('meetpilot-offline-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'meetpilot-offline-banner';
    bar.setAttribute('role', 'status');
    bar.textContent = ${JSON.stringify(text)};
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 16px;'
      + 'background:#fef3c7;color:#78350f;border-top:1px solid #f59e0b;font:13px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif';
    document.body.appendChild(bar);
  })()`).catch((err: Error) => writeLog(`--- 離線橫幅掛不上去：${err.message} ---\n`));
}

// ---- 從共享資料夾更新（E5） ----

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** 最近一次檢查的結果；null 是還沒檢查過或這次檢查失敗（失敗原因在 updateProblem） */
let updateCheck: UpdateCheck | null = null;
/** 檢查本身失敗（清單讀不懂、這版的版本號不合法）：不是「沒有新版」，要講出來 */
let updateProblem: string | null = null;
let updateCheckInFlight: Promise<UpdateCheck | null> | null = null;
/** 檢查進行中又要求重查（例如換了投影資料夾）：這一輪結束後再跑一次，不拿舊資料夾的結果 */
let updateRecheckTrigger: string | null = null;
let installingUpdate = false;
const pendingUpdatePath = () => join(app.getPath('userData'), PENDING_UPDATE_FILE);

/** 還沒設定過投影資料夾（或設定讀不懂）就沒有更新資料夾可看，回 null */
function vaultDirForUpdate(): string | null {
  try {
    return store.readSettings()?.vaultDir ?? null;
  } catch (err) {
    if (!(err instanceof DesktopStoreError)) throw err;
    return null;
  }
}

async function checkUpdateOnce(trigger: string): Promise<UpdateCheck | null> {
  const vaultDir = vaultDirForUpdate();
  if (vaultDir === null) {
    updateCheck = null;
    updateProblem = null;
    writeLog(`--- 更新檢查（${trigger}）[not-configured]：還沒設定投影資料夾 ---\n`);
    return null;
  }
  try {
    updateCheck = await checkForUpdate({
      folder: updateFolderFor(vaultDir), currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
    });
    updateProblem = null;
    writeLog(`--- 更新檢查（${trigger}）[${updateCheck.state}]：${describeUpdateCheck(updateCheck)} ---\n`);
  } catch (err) {
    updateCheck = null;
    updateProblem = (err as Error).message;
    writeLog(`--- 更新檢查（${trigger}）[error]：${updateProblem} ---\n`);
  }
  return updateCheck;
}

/**
 * 同一時間只跑一次；排程、托盤、安裝前各自叫的話拿到同一次的結果。
 * recheck：檢查的前提換了（投影資料夾），進行中的那一輪算的是舊資料夾，結束後要再跑一次
 */
function runUpdateCheck(trigger: string, opts: { recheck?: boolean } = {}): Promise<UpdateCheck | null> {
  if (updateCheckInFlight !== null) {
    if (opts.recheck) updateRecheckTrigger = trigger;
    return updateCheckInFlight;
  }
  updateCheckInFlight = (async () => {
    let result = await checkUpdateOnce(trigger);
    while (updateRecheckTrigger !== null) {
      const again = updateRecheckTrigger;
      updateRecheckTrigger = null;
      result = await checkUpdateOnce(again);
    }
    return result;
  })().finally(() => {
    updateCheckInFlight = null;
    refreshTrayMenu();
    injectUpdateBanner();
  });
  return updateCheckInFlight;
}

/** 托盤最上面那行狀態 */
function updateStatusLine(): string {
  const version = `版本 ${app.getVersion()}`;
  if (updateProblem !== null) return `${version}：更新檢查失敗，請通知 admin`;
  if (updateCheck === null) return version;
  return `${version}：${describeUpdateCheck(updateCheck)}`;
}

// 有新版、或安裝檔對不上、或檢查失敗時，在 server 的畫面右上角掛一張提示卡。外殼注入，跟離線橫幅同一種做法
function injectUpdateBanner(): void {
  if (!mainWindow || !isServerUrl(mainWindow.webContents.getURL())) return;
  const spec = updateCheck?.state === 'ready'
    ? { text: `MeetPilot ${updateCheck.version} 可以安裝了。`, button: '安裝新版', tone: 'info' }
    : updateProblem !== null
      ? { text: `更新檢查失敗，不會安裝：${updateProblem}`, button: null, tone: 'warn' }
      : updateCheck?.state === 'corrupt'
        ? { text: describeUpdateCheck(updateCheck), button: null, tone: 'warn' }
        : null;
  void mainWindow.webContents.executeJavaScript(`(() => {
    const spec = ${JSON.stringify(spec)};
    let card = document.getElementById('meetpilot-update-banner');
    if (spec === null) { card?.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.id = 'meetpilot-update-banner';
      card.setAttribute('role', 'status');
      document.body.appendChild(card);
    }
    card.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:380px;padding:10px 14px;border-radius:8px;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.15);font:13px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;'
      + (spec.tone === 'warn' ? 'background:#fef3c7;color:#78350f;border:1px solid #f59e0b' : 'background:#eff6ff;color:#1e3a8a;border:1px solid #93c5fd');
    card.replaceChildren();
    const text = document.createElement('span');
    text.textContent = spec.text;
    card.appendChild(text);
    if (spec.button) {
      const b = document.createElement('button');
      b.textContent = spec.button;
      b.style.cssText = 'margin-left:10px;padding:2px 10px;border-radius:6px;border:1px solid #3b82f6;background:#fff;color:#1d4ed8;cursor:pointer';
      b.onclick = () => window.meetpilotDesktop.installUpdate();
      card.appendChild(b);
    }
  })()`).catch((err: Error) => writeLog(`--- 更新提示掛不上去：${err.message} ---\n`));
}

/** detached 起安裝程式，等它真的起來（或起不來）才回傳：起不來的話不能先把 app 結束掉 */
function launchDetached(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const refuseWhileRecording = () => dialog.showMessageBox({
  type: 'info',
  title: 'MeetPilot',
  message: '錄音中不能更新',
  detail: '更新要結束 MeetPilot，錄音會斷掉。先按「停止錄音」，再從系統匣或右上角的提示安裝。',
});

/** justChecked：呼叫端剛檢查完、拿到 ready，就不再重算一次一百多 MB 的雜湊（複製到暫存後仍會再驗一次） */
async function installUpdate(justChecked?: Extract<UpdateCheck, { state: 'ready' }>): Promise<void> {
  if (installingUpdate) {
    showWindow();
    return;
  }
  // 先佔住：錄音中連按提示卡不會疊出好幾個對話框
  installingUpdate = true;
  try {
    showWindow();
    if (recordingActive) {
      await refuseWhileRecording();
      return;
    }
    // 提示可能是幾個小時前的，這段時間 admin 可能換過版本、或檔案被換過，所以重新檢查一次
    const check = justChecked ?? await runUpdateCheck('安裝前');
    if (check === null || check.state !== 'ready') {
      await dialog.showMessageBox({
        type: 'info',
        title: 'MeetPilot',
        message: '現在沒有可以安裝的新版',
        detail: updateProblem ?? (check === null ? '還沒設定投影資料夾。' : describeUpdateCheck(check)),
      });
      return;
    }
    const isMac = process.platform === 'darwin';
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'MeetPilot',
      message: `安裝 MeetPilot ${check.version}？`,
      detail: isMac
        ? 'MeetPilot 會打開新版的安裝檔並結束。在打開的視窗裡把 MeetPilot 拖到「應用程式」、選「取代」，再從「應用程式」打開。'
          + 'macOS 說無法確認開發者的話，照第一次安裝時的放行步驟做一次。'
        : 'MeetPilot 會結束、在背景安裝新版，裝完自動重新開啟。進行中的轉錄重新開啟後會接著跑。',
      buttons: [isMac ? '打開安裝檔並結束 MeetPilot' : '安裝並重新開啟', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    const staged = await stageInstaller(check, join(app.getPath('temp'), 'MeetPilot-update'));
    // 對話框開著、或複製與驗雜湊的那幾秒，都可能已經開始錄音了。Windows 的安裝程式一起來就會把 app 關掉
    // （更新模式下等不到就強制結束），所以這是最後一次能停的地方
    if (recordingActive) {
      await refuseWhileRecording();
      return;
    }
    writeLog(`--- 安裝新版 ${check.version}（${app.getVersion()} → ${check.version}），驗過的安裝檔：${staged} ---\n`);
    const pending: PendingUpdate = { from: app.getVersion(), to: check.version, startedAt: new Date().toISOString() };
    writeFileSync(pendingUpdatePath(), JSON.stringify(pending));
    if (isMac) {
      const error = await shell.openPath(staged);
      if (error !== '') {
        rmSync(pendingUpdatePath(), { force: true });
        throw new Error(`打不開安裝檔（${staged}）：${error}`);
      }
    } else {
      try {
        await launchDetached(staged, WINDOWS_INSTALL_ARGS);
      } catch (err) {
        rmSync(pendingUpdatePath(), { force: true });
        throw err;
      }
      // 安裝程式已經起來了，接著一定會關掉這個 app：不能再讓 before-quit 的錄音確認擋住
      quitConfirmed = true;
    }
    app.quit();
  } catch (err) {
    writeLog(`--- 更新沒有完成：${(err as Error).stack ?? String(err)} ---\n`);
    await dialog.showMessageBox({
      type: 'error',
      title: 'MeetPilot',
      message: '更新沒有完成，MeetPilot 照舊繼續用',
      detail: `${(err as Error).message}\n\n完整紀錄：${serverLogPath()}`,
    });
  } finally {
    installingUpdate = false;
  }
}

/** 托盤的「檢查更新…」：使用者自己按的，結果一定要回話，包括「已經是最新版」 */
async function checkUpdatesFromTray(): Promise<void> {
  if (installingUpdate) {
    showWindow();
    await dialog.showMessageBox({ type: 'info', title: 'MeetPilot', message: '正在準備安裝新版，請看 MeetPilot 視窗上的對話框' });
    return;
  }
  const check = await runUpdateCheck('托盤');
  if (check?.state === 'ready') {
    await installUpdate(check);
    return;
  }
  const vaultDir = vaultDirForUpdate();
  await dialog.showMessageBox({
    type: updateProblem === null ? 'info' : 'warning',
    title: 'MeetPilot',
    message: updateStatusLine(),
    detail: updateProblem ?? (vaultDir === null ? '還沒設定投影資料夾。' : `更新資料夾：${updateFolderFor(vaultDir)}`),
  });
}

/**
 * 上次起了安裝程式、這次啟動版本卻沒變：安裝失敗了（Windows 按掉提權詢問、檔案被占用，macOS 開了 dmg 沒拖），
 * 而那時 app 已經結束，沒有任何畫面講過。這裡補講一次，標記用完就刪
 */
async function reportPendingUpdate(): Promise<void> {
  let text: string;
  try {
    text = readFileSync(pendingUpdatePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    writeLog(`--- 讀不到上次更新的標記（${pendingUpdatePath()}）：${(err as Error).message} ---\n`);
    return;
  }
  rmSync(pendingUpdatePath(), { force: true });
  let pending: PendingUpdate;
  try {
    pending = parsePendingUpdate(text, pendingUpdatePath());
  } catch (err) {
    writeLog(`--- 上次更新的標記壞了，刪掉：${(err as Error).message} ---\n`);
    return;
  }
  if (pendingUpdateDone(pending, app.getVersion())) {
    writeLog(`--- 更新完成：${pending.from} → ${app.getVersion()} ---\n`);
    return;
  }
  writeLog(`--- 上次更新沒有完成：要裝 ${pending.to}，現在還是 ${app.getVersion()}（${pending.startedAt} 起的安裝程式）---\n`);
  await dialog.showMessageBox({
    type: 'warning',
    title: 'MeetPilot',
    message: `上次更新到 ${pending.to} 沒有完成，現在還是 ${app.getVersion()}`,
    detail: (process.platform === 'darwin'
      ? '打開的安裝檔裡，要把 MeetPilot 拖到「應用程式」取代舊版，再從「應用程式」打開。'
      : '安裝程式可能被取消（例如按掉系統的權限詢問），或檔案被別的程式占用。')
      + `可以從系統匣「檢查更新…」再裝一次，再不行請通知 admin。\n\n完整紀錄：${serverLogPath()}`,
  });
}

async function openSettings(): Promise<void> {
  showWindow();
  // 設定頁會蓋掉 server 的頁面，錄音就跟著斷了；存檔還會重啟 server
  if (recordingActive) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'MeetPilot',
      message: '錄音中不能開設定',
      detail: '先在 MeetPilot 按「停止錄音」，再從系統匣開設定。',
    });
    return;
  }
  // 排進佇列：啟動還在跑的話，等它把畫面換完再開設定頁，不然表單會被接著載入的啟動畫面蓋掉（Codex review 第三輪）
  await serialized(async () => { showSetup(null); });
}

/**
 * macOS 的麥克風系統權限。2026-09-24 第一次實機錄音，31 秒只收到 7 KB、幾乎是空白，Gemini 卻轉出一段編的內容；
 * 最可能的原因是這台 Mac 沒給 MeetPilot 麥克風權限（沒簽章的 app，系統詢問容易被略過），未證實。
 * 所以頁面要麥克風時先查：還沒問過就請系統問；被拒就講怎麼打開，不給頁面麥克風，讓「開始錄音」直接失敗、看得見。
 * 冒煙測試用 Chromium 的假麥克風，不經過系統的麥克風，不用查（CI 的機器上系統詢問沒有人會按）。
 * Windows 的麥克風隱私設定關掉時 getUserMedia 會直接失敗，這裡不另外處理（沒有實機驗過）。
 */
async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin' || app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    writeLog(`--- 系統詢問麥克風權限：${granted ? '允許' : '拒絕'} ---\n`);
    if (granted) return true;
  }
  writeLog(`--- 沒有麥克風權限（${systemPreferences.getMediaAccessStatus('microphone')}），不給頁面麥克風 ---\n`);
  showWindow();
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'MeetPilot',
    message: 'MeetPilot 沒有使用麥克風的權限，這次沒有開始錄音',
    detail: '到「系統設定 → 隱私權與安全性 → 麥克風」打開 MeetPilot，然後結束 MeetPilot 再重新打開，才能錄音。',
    buttons: ['打開系統設定', '稍後'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  return false;
}

function isServerUrl(url: string): boolean {
  return serverOrigin !== null && (url === serverOrigin || url.startsWith(`${serverOrigin}/`));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'MeetPilot',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'setupPreload.cjs'),
      // 錄音中視窗會被關到系統匣（其實是藏起來）。藏起來的頁面預設會被節流，分段上傳的重送計時器與音量取樣會被拖慢（E4）
      backgroundThrottling: false,
      // 音量取樣用 AudioContext；沒有使用者手勢時它會停在 suspended，取到的永遠是 0，靜音警告就會誤報
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.webContents.on('did-finish-load', injectOfflineBanner);
  mainWindow.webContents.on('did-finish-load', injectUpdateBanner);
  // 頁面換掉或當掉，裡面的錄音就沒了：不能繼續擋睡眠、也不該再擋結束。server 那頭留著的是「中斷的錄音」，畫面會給救法
  mainWindow.webContents.on('did-navigate', () => setRecordingActive(false, '頁面換掉了'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => setRecordingActive(false, `頁面程序結束：${details.reason}`));
  // 視窗只顯示 server 的頁面；外部連結開系統瀏覽器，不在 app 裡換頁。
  // 唯一放行的新視窗是 about:blank：會議記錄的列印是 window.open('', '_blank') 寫入內容再 print()
  // （components/SummaryView.tsx），全擋的話 window.open 回 null，列印按了沒反應（Codex review 2026-09-24）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          title: 'MeetPilot 列印',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:\/\//.test(url) && !isServerUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 列印視窗只准停在 about:blank，不准再導去別的地方，也不准再開視窗
  mainWindow.webContents.on('did-create-window', (child) => {
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isServerUrl(url)) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    // 冒煙測試靠這一行確認「關到系統匣之後錄音還在收段落」；事後查「錄音中關過視窗嗎」也看這裡
    writeLog(`--- 視窗關到系統匣${recordingActive ? '（錄音中）' : ''} ---\n`);
  });
}

function showWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const assets = join(app.getAppPath(), 'electron', 'assets');
  // macOS 用 template 圖（系統依深淺色自動上色），Windows 用彩色圖
  const icon = nativeImage.createFromPath(
    join(assets, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  tray = new Tray(icon);
  tray.setToolTip('MeetPilot');
  refreshTrayMenu();
  tray.on('click', showWindow);
}

// 選單上有更新狀態，每次檢查完重建
function refreshTrayMenu(): void {
  if (!tray) return;
  const ready = updateCheck?.state === 'ready' ? updateCheck : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 MeetPilot', click: showWindow },
    { label: '設定…', click: () => void openSettings() },
    { type: 'separator' },
    { label: updateStatusLine(), enabled: false },
    ...(ready === null ? [] : [{ label: `安裝新版 ${ready.version}…`, click: () => void installUpdate() }]),
    { label: '檢查更新…', click: () => void checkUpdatesFromTray() },
    { type: 'separator' },
    { label: '結束 MeetPilot', click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    // 錄音中結束會切掉錄音。先問一次；確認了才真的結束，已送到的段落留在 server，下次打開可以送出
    if (recordingActive && !quitConfirmed) {
      event.preventDefault();
      showWindow();
      void dialog.showMessageBox({
        type: 'warning',
        title: 'MeetPilot',
        message: '正在錄音，要結束 MeetPilot 嗎？',
        detail: '結束會中斷錄音。已經送出的部分會留著，下次打開 MeetPilot 可以把它送去轉錄；最後幾秒可能沒送到。',
        buttons: ['繼續錄音', '結束 MeetPilot'],
        defaultId: 0,
        cancelId: 0,
      }).then(({ response }) => {
        if (response !== 1) return;
        quitConfirmed = true;
        writeLog('--- 錄音中使用者確認結束 ---\n');
        app.quit();
      });
      return;
    }
    quitting = true;
    server?.kill();
  });
  // 托盤常駐：所有視窗關掉（其實是藏起來）不結束
  app.on('window-all-closed', () => {});

  void app.whenReady().then(async () => {
    // 只有 server 自己的頁面能要麥克風（E4 的 app 內錄音），其他權限一律拒絕；給之前先確認系統層的麥克風權限
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission !== 'media' || !isServerUrl(webContents.getURL())) {
        callback(false);
        return;
      }
      ensureMicrophoneAccess().then(callback, (err: Error) => {
        writeLog(`--- 查麥克風權限失敗，不給頁面麥克風：${err.stack ?? err.message} ---\n`);
        callback(false);
      });
    });
    registerSetupHandlers();
    createWindow();
    createTray();
    await startApp();
    void reportPendingUpdate();
    void runUpdateCheck('啟動');
    setInterval(() => void runUpdateCheck('排程'), UPDATE_CHECK_INTERVAL_MS);
  });
}

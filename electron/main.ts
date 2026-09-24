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
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { buildServerEnv } from './serverEnv';
import { createLogTail } from './logTail';

// userData 固定叫 MeetPilot，不跟 package.json 的 name 走：資料夾名要穩定，改套件名或產品名不能讓資料「消失」。
// MEETPILOT_DESKTOP_USER_DATA 只給 scripts/smokeDesktop.mjs 用：冒煙測試要用拋棄式的資料夾，
// 不能拿正式資料啟動（server 一起來就會 migrate、回收 job、開始跑 worker）。單一實例鎖也跟著 userData 走，
// 所以測試跟正式 app 可以同時開
app.setPath('userData', process.env.MEETPILOT_DESKTOP_USER_DATA || join(app.getPath('appData'), 'MeetPilot'));

const SERVER_READY_TIMEOUT_MS = 30_000;
// 每次健康檢查自己的上限：連接埠被別的程式搶走、對方收了連線卻不回應時，不能卡過整體的就緒上限
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const LOG_TAIL_LINES = 40;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let serverOrigin: string | null = null;
let quitting = false;

/** 啟動階段的失敗：帶著結束碼與最後幾行輸出，交給唯一負責復原的地方（bootServerIntoWindow） */
class ServerStartupError extends Error {
  constructor(message: string, readonly code: number, readonly lines: string[]) {
    super(message);
  }
}

const logDir = () => join(app.getPath('userData'), 'logs');
const serverLogPath = () => join(logDir(), 'server.log');

// log 寫不進去（磁碟滿、權限、同名目錄）不能讓錯誤視窗跟著出不來：寫入失敗只記下原因，
// 在錯誤視窗裡講出來，不往上拋（Codex review 2026-09-24）
let logWriteError: string | null = null;
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
  const logTail = createLogTail(LOG_TAIL_LINES);
  // 寫入錯誤跟著這一輪 server 走：上次磁碟滿、這次空出來了，不該還顯示上次的原因
  logWriteError = null;
  const port = await pickFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const appPath = app.getAppPath();
  const child = utilityProcess.fork(join(appPath, 'dist', 'server.cjs'), [], {
    // server 從 cwd 找 dist/（前端）與 prompts/（會議記錄規範），所以 cwd 是 app 目錄，不是 userData
    cwd: appPath,
    env: buildServerEnv({
      baseEnv: process.env,
      userDataDir: app.getPath('userData'),
      port,
      geminiApiKey: process.env.GEMINI_API_KEY,
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

  // 就緒之前的結束不在這裡處理：waitForServer 會拋，由 bootServerIntoWindow 的 catch 負責，
  // 只有一個地方跳錯誤視窗。兩邊都處理的話，使用者按兩次「重新啟動」就會起兩個 server 搶同一個 DB
  // （Codex review 2026-09-24）
  let ready = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code;
    if (server === child) server = null;
    if (quitting || !ready) return;
    void onServerExit(code, logTail.lines());
  });
  server = child;
  try {
    await waitForServer(origin, child);
  } catch (err) {
    throw new ServerStartupError((err as Error).message, exitCode ?? -1, [...logTail.lines(), (err as Error).message]);
  }
  // health 回 200 之後才處理到 exit 事件的話，exit listener 看到 ready === false 已經 return 了；
  // 這裡不再確認一次，這次崩潰就沒有任何地方處理（沒有錯誤視窗）
  if (exitCode !== null) {
    throw new ServerStartupError('server 回應健康檢查之後就結束了', exitCode, logTail.lines());
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
    detail: `最後幾行輸出：\n${lines.join('\n') || '（沒有輸出）'}\n\n${logNote}`,
    buttons: ['重新啟動', '結束 MeetPilot'],
    defaultId: 0,
    cancelId: 1,
  });
  writeLog(`--- 使用者選擇：${response === 0 ? '重新啟動' : '結束'} ---\n`);
  if (response === 0) await bootServerIntoWindow();
  else app.quit();
}

// loadURL 在下一次載入打斷它時會以 ERR_ABORTED reject（例如 server 在頁面載入途中崩潰，改載錯誤頁）。
// 那是預期的，其他失敗寫進 log，不留 unhandled rejection
function loadInWindow(url: string): void {
  mainWindow?.loadURL(url).catch((err: Error & { code?: string }) => {
    if (err.code !== 'ERR_ABORTED') writeLog(`--- 視窗載入失敗（${url.slice(0, 80)}）：${err.message} ---\n`);
  });
}

// 殺掉子程序之後等它真的結束，才讓使用者按「重新啟動」：同一個 userData 只能有一個 server，
// 不能靠「SIGTERM 通常很快」這種時間差成立
function killAndWait(child: UtilityProcess | null, timeoutMs = 5_000): Promise<void> {
  if (!child || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function bootServerIntoWindow(): Promise<void> {
  loadInWindow(statusPage('MeetPilot 啟動中…', '正在準備資料庫與背景程式。'));
  try {
    await startServer();
  } catch (err) {
    // 就緒失敗時子程序可能還活著（例如卡在啟動），先收掉，再交給跟崩潰同一條路處理
    const child = server;
    server = null;
    await killAndWait(child);
    // 啟動途中使用者按了「結束」：server 是被 before-quit 收掉的，不是壞了，不跳錯誤視窗
    if (quitting) return;
    const failure = err instanceof ServerStartupError ? err : new ServerStartupError(String(err), -1, [String(err)]);
    await onServerExit(failure.code, failure.lines);
    return;
  }
  loadInWindow(`${serverOrigin}/`);
}

function isServerUrl(url: string): boolean {
  return serverOrigin !== null && (url === serverOrigin || url.startsWith(`${serverOrigin}/`));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'MeetPilot',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 MeetPilot', click: showWindow },
    { type: 'separator' },
    { label: '結束 MeetPilot', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
  // 托盤常駐：所有視窗關掉（其實是藏起來）不結束
  app.on('window-all-closed', () => {});

  void app.whenReady().then(async () => {
    // 只有 server 自己的頁面能要麥克風（E4 的 app 內錄音），其他權限一律拒絕
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media' && isServerUrl(webContents.getURL()));
    });
    createWindow();
    createTray();
    await bootServerIntoWindow();
  });
}

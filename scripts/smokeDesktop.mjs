// 桌面 app 冒煙測試：啟動打包好的執行檔，走一遍記錄人會遇到的三種啟動，確認裡面的 server 起得來、拿到的東西對。
//
//   node scripts/smokeDesktop.mjs <打包後的執行檔>
//     macOS：release/mac-arm64/MeetPilot.app/Contents/MacOS/MeetPilot
//     Windows：release/win-unpacked/MeetPilot.exe
//
// 三條 gate 與 smokeProduction.mjs 都碰不到打包後的東西：檔案有沒有被打進去（dist/、prompts/、設定頁）、
// cwd 對不對、utilityProcess 與 safeStorage 在那個平台能不能用。這支是唯一會真的跑安裝檔內容的檢查，
// CI 在兩個平台各跑一次；本機只有 macOS，Windows 的結果只有 CI 看得到。
//
// 四段，同一份 userData 接著跑（E3）：
//   1. 首次設定：出現設定頁 → 經 CDP 填邀請碼與資料夾、按儲存 → server 起來，拿到 gateway 的 key 與名單。
//   2. 離線：gateway 連不上 → server 用上次存的 key 照樣起來，畫面底部有離線橫幅。
//   2b. 資料夾不見了：上次選的投影資料夾被刪掉 → 回設定頁講原因，不起 server、不重建資料夾。
//   3. 撤銷：gateway 回 401 → 不起 server，回到設定頁講原因，存著的 token、key、名單都刪掉。
// gateway 是這支自己起的假的（MEETPILOT_DESKTOP_GATEWAY_URL），不用真的邀請碼。設定頁用 CDP
// （--remote-debugging-port）操作；原生的選資料夾視窗驅動不了，所以直接填路徑欄。
//
// server 用動態 port，外殼把它寫進 userData 的 logs/server.log（「啟動 server（port N）」），這裡從那裡讀。
//
// userData 一律用拋棄式暫存目錄（MEETPILOT_DESKTOP_USER_DATA），跑完刪掉。不能用正式的：
// server 一啟動就 migrate、回收上次沒跑完的 job、開始跑 worker，冒煙測試又會把它強制關掉，
// 在用過桌面版的電腦上會動到真的會議狀態（Codex review 2026-09-24）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 60_000;
// 整支腳本的硬上限：收尾時 app 卡住不結束（例如 macOS 的錯誤對話框卡住主程序）也不能讓 CI 無限等下去。
// 2026-09-24 CI 的 macOS 那格就這樣卡了 40 分鐘以上
const WATCHDOG_MS = 5 * 60_000;
setTimeout(() => {
  console.error(`[desktop-smoke] 失敗：超過 ${WATCHDOG_MS / 1000} 秒還沒結束，強制退出`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error(`[desktop-smoke] 找不到執行檔：${exe}`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'meetpilot-desktop-smoke-'));
const userData = join(root, 'userData');
const vaultDir = join(root, 'records');
mkdirSync(vaultDir);
const logPath = join(userData, 'logs', 'server.log');
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
const cleanup = () => {
  // 程序剛被收掉時 Windows 可能還鎖著檔案，刪不掉就留著並說出來，不讓冒煙結果被清理失敗蓋掉
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.warn(`[desktop-smoke] 暫存目錄沒刪乾淨（${root}）：${err.message}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 假 gateway：契約照 meetpilot-gateway 的 README ----
const INVITE_CODE = 'SMOKE-INVITE-CODE';
const TOKEN = 'smoke-token-not-a-secret';
const GEMINI_KEY = 'smoke-gemini-key-not-a-secret';
const ROSTER = {
  version: 1,
  rows: [
    { employeeId: 'S001', displayName: '冒煙測試一號', title: null, email: 's001@example.com', department: null, aliases: ['Smoke One'] },
    { employeeId: 'S002', displayName: '冒煙測試二號', title: '測試', email: 's002@example.com', department: '品保', aliases: [] },
  ],
};
let gatewayMode = 'ok'; // ok | down（直接斷線） | revoked（token 一律 401） | no-roster（名單回 503）
const gatewayServer = createHttpServer((req, res) => {
  if (gatewayMode === 'down') {
    req.socket.destroy();
    return;
  }
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api/redeem') {
      let code;
      try { code = JSON.parse(body).code; } catch { return send(400, { error: 'body 要是 JSON' }); }
      return code === INVITE_CODE ? send(200, { token: TOKEN, inviteId: 'smoke' }) : send(401, { error: '邀請碼不對或已被撤銷' });
    }
    if (req.method === 'GET' && (req.url === '/api/config' || req.url === '/api/people')) {
      if (gatewayMode === 'no-roster' && req.url === '/api/people') return send(503, { error: '名單還沒上傳' });
      const authorized = ['ok', 'no-roster'].includes(gatewayMode) && req.headers.authorization === `Bearer ${TOKEN}`;
      if (!authorized) return send(401, { error: 'token 無效或已被撤銷，請重新輸入邀請碼' });
      return send(200, req.url === '/api/config' ? { geminiApiKey: GEMINI_KEY } : ROSTER);
    }
    return send(404, { error: 'not found' });
  });
});
await new Promise((r) => gatewayServer.listen(0, '127.0.0.1', r));
const gatewayUrl = `http://127.0.0.1:${gatewayServer.address().port}`;

const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ---- 啟動與收掉 app ----
let app = null; // { child, exited, cdpPort }
const launch = async () => {
  const cdpPort = await freePort();
  const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    env: { ...process.env, MEETPILOT_DESKTOP_USER_DATA: userData, MEETPILOT_DESKTOP_GATEWAY_URL: gatewayUrl },
  });
  app = { child, exited: null, cdpPort };
  const current = app;
  child.on('exit', (code) => { current.exited = code; });
};

// 只對主程序送結束訊號，讓它照正常流程（before-quit）先把 server 收掉。對整個行程群組送的話，
// server 跟主程序同時收到，server 先死，主程序當成崩潰跳錯誤對話框，macOS 的對話框會卡住主程序、
// 再也處理不到結束訊號。10 秒內沒結束才強制砍整個群組
const stop = async () => {
  if (app === null || app.exited !== null) return;
  const { child } = app;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    for (let i = 0; i < 20 && app.exited === null; i += 1) await sleep(500);
    return;
  }
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && app.exited === null; i += 1) await sleep(500);
  if (app.exited === null) {
    console.warn('[desktop-smoke] app 10 秒內沒有自己結束，強制砍整個行程群組');
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已經結束 */ }
  }
};
const fail = async (phase, message) => {
  await stop();
  gatewayServer.close();
  console.error(`[desktop-smoke] 失敗（${phase}）：${message}\n--- server.log 最後 40 行 ---\n${readLog().split(/\r?\n/).slice(-40).join('\n')}`);
  cleanup();
  process.exit(1);
};

// ---- CDP：找頁面、在頁面裡跑一段 JS ----
async function findPage(match) {
  try {
    const res = await fetch(`http://127.0.0.1:${app.cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
    const targets = await res.json();
    return targets.find((t) => t.type === 'page' && match(t.url)) ?? null;
  } catch {
    return null; // app 還沒開好 debug port
  }
}

function evaluate(target, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 10 秒內沒有回應')); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 連線失敗')); };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description ?? '頁面裡的 JS 拋錯'));
      else resolve(msg.result?.result?.value);
    };
  });
}

/** 一直試到 check 回有內容的值，或時間到 */
async function waitFor(phase, what, check, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.exited !== null) await fail(phase, `app 在${what}之前就結束了（exit ${app.exited}）`);
    let value = null;
    try { value = await check(); } catch { value = null; }
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(500);
  }
  return fail(phase, `${timeoutMs / 1000} 秒內沒等到「${what}」`);
}

const isSetupPage = (url) => url.startsWith('file:') && url.endsWith('/setup.html');
const startCount = () => [...readLog().matchAll(/啟動 server（port (\d+)）/g)].length;
const messageShown = `(() => { const m = document.getElementById('message'); return m && m.classList.contains('show') ? m.textContent : null; })()`;

/** 等這次啟動的 server 回應健康檢查，回 { port, health } */
async function waitForServer(phase, previousStarts) {
  return waitFor(phase, 'server 就緒', async () => {
    const starts = [...readLog().matchAll(/啟動 server（port (\d+)）/g)];
    if (starts.length <= previousStarts) return null;
    const port = starts[starts.length - 1][1];
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { port, health: await res.json() } : null;
  });
}

// ======== 1. 首次設定 ========
let phase = '首次設定';
await launch();
const setup = await waitFor(phase, '出現設定頁', () => findPage(isSetupPage));
await waitFor(phase, '設定頁載好', () => evaluate(setup, `document.readyState === 'complete' && typeof window.meetpilotSetup === 'object'`));
// 錯的邀請碼先試一次：要留在設定頁講原因，不能起 server
await evaluate(setup, `(() => {
  document.getElementById('invite-code').value = 'WRONG-CODE';
  document.getElementById('vault-dir').value = ${JSON.stringify(vaultDir)};
  document.getElementById('save').click();
})()`);
const wrongCodeMessage = await waitFor(phase, '錯的邀請碼被擋下', () => evaluate(setup, messageShown));
if (!wrongCodeMessage.includes('邀請碼不對')) await fail(phase, `錯的邀請碼應該顯示 gateway 的原因，實際是：${wrongCodeMessage}`);
if (startCount() !== 0) await fail(phase, '錯的邀請碼也啟動了 server');

// 邀請碼對、key 拿得到，但名單拿不到：第一次設定沒有上次的名單可用，要留在設定頁，不能起一個建不了會議的 server
gatewayMode = 'no-roster';
await evaluate(setup, `(() => {
  document.getElementById('invite-code').value = ${JSON.stringify(INVITE_CODE)};
  document.getElementById('save').click();
})()`);
const noRosterMessage = await waitFor(phase, '拿不到名單被擋下', () =>
  evaluate(setup, `(() => { const m = document.getElementById('message'); return m.classList.contains('show') && !m.textContent.includes('邀請碼不對') ? m.textContent : null; })()`));
if (!noRosterMessage.includes('拿不到人員名單')) await fail(phase, `名單拿不到時應該講原因，實際是：${noRosterMessage}`);
if (startCount() !== 0) await fail(phase, '名單拿不到也啟動了 server');
if (existsSync(join(userData, 'credentials.json'))) await fail(phase, '名單拿不到時就把登入資料存下來了');

gatewayMode = 'ok';
await evaluate(setup, `(() => {
  document.getElementById('invite-code').value = ${JSON.stringify(INVITE_CODE)};
  document.getElementById('save').click();
})()`);
const first = await waitForServer(phase, 0);
if (first.health.hasKey !== true) await fail(phase, `server 沒拿到 Gemini key（/api/health：${JSON.stringify(first.health)}）`);
const people = await (await fetch(`http://127.0.0.1:${first.port}/api/people`)).json();
const names = (people.people ?? []).map((p) => p.displayName).sort();
if (JSON.stringify(names) !== JSON.stringify(['冒煙測試一號', '冒煙測試二號'])) {
  await fail(phase, `server 的名單不是 gateway 給的那份：${JSON.stringify(names)}`);
}
if (!readLog().includes('啟動時匯入 gateway 名單')) await fail(phase, 'server.log 沒有「啟動時匯入 gateway 名單」');
const credentialsPath = join(userData, 'credentials.json');
const credentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : null;
if (credentials === null) await fail(phase, 'credentials.json 沒有寫出來');
// 欄位是 base64，明文轉成 base64 存也看不出來，所以兩層都查：原始檔案、每個欄位解開之後
const decodedFields = Object.values(JSON.parse(credentials))
  .filter((v) => typeof v === 'string')
  .map((v) => Buffer.from(v, 'base64').toString('latin1'));
if ([credentials, ...decodedFields].some((text) => text.includes(GEMINI_KEY) || text.includes(TOKEN))) {
  await fail(phase, 'credentials.json 裡的 key 或 token 沒有加密');
}
if (!existsSync(join(userData, 'roster.json'))) await fail(phase, 'roster.json 沒有寫出來');
const settings = JSON.parse(readFileSync(join(userData, 'desktop-settings.json'), 'utf8'));
if (settings.vaultDir !== vaultDir) await fail(phase, `投影資料夾存成 ${settings.vaultDir}，不是 ${vaultDir}`);
if (!readLog().includes(`會議 markdown 投影到 ${vaultDir}`)) await fail(phase, `server 沒有投影到設定的資料夾 ${vaultDir}`);

// 打包後一定要用隨附的 ffmpeg（E2）：退回 PATH 的話，記錄人電腦上沒有 ffmpeg，每場會都會在轉錄一開始 FAILED
const ffmpegLine = readLog().match(/^ffmpeg：(.*)$/m)?.[1];
if (!ffmpegLine || ffmpegLine.includes('沒有隨附') || !/[\\/]ffmpeg[\\/]ffmpeg(\.exe)?$/.test(ffmpegLine)) {
  await fail(phase, `打包後的 app 沒有用隨附的 ffmpeg（server.log：${ffmpegLine ?? '沒有 ffmpeg 那一行'}）`);
}
let html;
try {
  const page = await fetch(`http://127.0.0.1:${first.port}/`, { signal: AbortSignal.timeout(10_000) });
  html = page.ok ? await page.text() : `HTTP ${page.status}`;
} catch (err) {
  // 逾時或連線中斷也要走 fail()：收掉 app、刪暫存目錄、印 server.log
  await fail(phase, `GET / 失敗：${err.message}`);
}
if (!html.includes('<div id="root">')) await fail(phase, `GET / 的內容不是 build 出來的 index.html：${html.slice(0, 120)}`);
const serverPageOnline = await waitFor(phase, '主視窗換到 server 的頁面', () => findPage((u) => u.startsWith(`http://127.0.0.1:${first.port}/`)));
await waitFor(phase, 'server 的頁面載好', () => evaluate(serverPageOnline, `document.readyState === 'complete'`));
if (await evaluate(serverPageOnline, `document.getElementById('meetpilot-offline-banner') !== null`)) {
  await fail(phase, 'gateway 正常時也掛了離線橫幅');
}
await stop();
console.log(`[desktop-smoke] ${phase}通過：錯的邀請碼與拿不到名單都留在設定頁；正確的換到 key 與 ${names.length} 人名單，port ${first.port}，ffmpeg 用隨附的 ${ffmpegLine}`);

// ======== 2. 離線 ========
phase = '離線';
gatewayMode = 'down';
const beforeOffline = startCount();
await launch();
const offline = await waitForServer(phase, beforeOffline);
if (offline.health.hasKey !== true) await fail(phase, `離線時 server 沒拿到上次存的 key（/api/health：${JSON.stringify(offline.health)}）`);
const serverPageOffline = await waitFor(phase, '主視窗換到 server 的頁面', () => findPage((u) => u.startsWith(`http://127.0.0.1:${offline.port}/`)));
const banner = await waitFor(phase, '出現離線橫幅', () =>
  evaluate(serverPageOffline, `document.getElementById('meetpilot-offline-banner')?.textContent ?? null`), 15_000);
if (!banner.includes('離線')) await fail(phase, `離線橫幅的內容不對：${banner}`);
// 連不上不是撤銷：名單快取要還在，server 也照樣匯入它
if (!existsSync(join(userData, 'roster.json'))) await fail(phase, '離線時 roster.json 被刪掉了');
if (!existsSync(credentialsPath)) await fail(phase, '離線時 credentials.json 被刪掉了');
const offlineLog = readLog().split(/啟動 server（port \d+）/).pop();
if (!offlineLog.includes('啟動時匯入 gateway 名單')) await fail(phase, '離線時 server 沒有匯入上次的名單');
await stop();
console.log(`[desktop-smoke] ${phase}通過：gateway 斷線時 server 用上次的 key 起來，橫幅：${banner}`);

// ======== 2b. 資料夾不見了 ========
// 共享資料夾被取消同步或刪掉：要回設定頁講原因，不能讓 server 自己建一個不會同步的本機資料夾
phase = '資料夾不見了';
gatewayMode = 'ok';
rmSync(vaultDir, { recursive: true, force: true });
const beforeMissing = startCount();
await launch();
const missingSetup = await waitFor(phase, '回到設定頁', () => findPage(isSetupPage));
const missingMessage = await waitFor(phase, '設定頁講出資料夾的問題', () => evaluate(missingSetup, messageShown));
if (!missingMessage.includes('資料夾')) await fail(phase, `設定頁的訊息沒講資料夾：${missingMessage}`);
if (startCount() !== beforeMissing) await fail(phase, '資料夾不見了還啟動 server');
if (existsSync(vaultDir)) await fail(phase, '資料夾不見了卻被重建');
await stop();
mkdirSync(vaultDir);
console.log(`[desktop-smoke] ${phase}通過：不起 server、不重建資料夾，設定頁：${missingMessage}`);

// ======== 3. 撤銷 ========
phase = '撤銷';
gatewayMode = 'revoked';
const beforeRevoked = startCount();
await launch();
const revokedSetup = await waitFor(phase, '回到設定頁', () => findPage(isSetupPage));
const revokedMessage = await waitFor(phase, '設定頁講出撤銷的原因', () => evaluate(revokedSetup, messageShown));
if (!revokedMessage.includes('失效')) await fail(phase, `設定頁的訊息沒講邀請碼失效：${revokedMessage}`);
const prefilled = await evaluate(revokedSetup, `document.getElementById('vault-dir').value`);
if (prefilled !== vaultDir) await fail(phase, `投影資料夾沒有沿用（設定頁顯示 ${prefilled}）`);
if (existsSync(credentialsPath)) await fail(phase, '撤銷後 credentials.json 還在');
if (existsSync(join(userData, 'roster.json'))) await fail(phase, '撤銷後 roster.json 還在');
if (startCount() !== beforeRevoked) await fail(phase, '撤銷了還啟動 server');
await stop();
console.log(`[desktop-smoke] ${phase}通過：gateway 回 401 時不起 server、刪掉登入資料，設定頁：${revokedMessage}`);

gatewayServer.close();
await sleep(1500);
cleanup();
console.log('[desktop-smoke] 通過：首次設定、離線、資料夾不見了、撤銷四段都對');
process.exit(0);

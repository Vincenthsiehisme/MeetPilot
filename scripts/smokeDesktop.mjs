// 桌面 app 冒煙測試：啟動打包好的執行檔，等它裡面的 server 就緒，確認 /api/health 與前端頁回得出來。
//
//   node scripts/smokeDesktop.mjs <打包後的執行檔>
//     macOS：release/mac-arm64/MeetPilot.app/Contents/MacOS/MeetPilot
//     Windows：release/win-unpacked/MeetPilot.exe
//
// 三條 gate 與 smokeProduction.mjs 都碰不到打包後的東西：檔案有沒有被打進去（dist/、prompts/）、
// cwd 對不對、utilityProcess 在那個平台起不起得來。這支是唯一會真的跑安裝檔內容的檢查，
// CI 在兩個平台各跑一次；本機只有 macOS，Windows 的結果只有 CI 看得到。
//
// server 用動態 port，外殼把它寫進 userData 的 logs/server.log（「啟動 server（port N）」），這裡從那裡讀。
//
// userData 一律用拋棄式暫存目錄（MEETPILOT_DESKTOP_USER_DATA），跑完刪掉。不能用正式的：
// server 一啟動就 migrate、回收上次沒跑完的 job、開始跑 worker，冒煙測試又會把它強制關掉，
// 在用過桌面版的電腦上會動到真的會議狀態（Codex review 2026-09-24）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 60_000;
// 整支腳本的硬上限：收尾時 app 卡住不結束（例如 macOS 的錯誤對話框卡住主程序）也不能讓 CI 無限等下去。
// 2026-09-24 CI 的 macOS 那格就這樣卡了 40 分鐘以上
const WATCHDOG_MS = TIMEOUT_MS + 60_000;
setTimeout(() => {
  console.error(`[desktop-smoke] 失敗：超過 ${WATCHDOG_MS / 1000} 秒還沒結束，強制退出`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error(`[desktop-smoke] 找不到執行檔：${exe}`);
  process.exit(1);
}

const userData = mkdtempSync(join(tmpdir(), 'meetpilot-desktop-smoke-'));
const logPath = join(userData, 'logs', 'server.log');
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
const cleanup = () => {
  // 程序剛被收掉時 Windows 可能還鎖著檔案，刪不掉就留著並說出來，不讓冒煙結果被清理失敗蓋掉
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.warn(`[desktop-smoke] 暫存 userData 沒刪乾淨（${userData}）：${err.message}`);
  }
};

const child = spawn(exe, [], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
  env: { ...process.env, MEETPILOT_DESKTOP_USER_DATA: userData },
});
let exited = null;
child.on('exit', (code) => { exited = code; });

// 只對主程序送結束訊號，讓它照正常流程（before-quit）先把 server 收掉。對整個行程群組送的話，
// server 跟主程序同時收到，server 先死，主程序當成崩潰跳錯誤對話框，macOS 的對話框會卡住主程序、
// 再也處理不到結束訊號。10 秒內沒結束才強制砍整個群組
const stop = async () => {
  if (exited !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && exited === null; i += 1) await new Promise((r) => setTimeout(r, 500));
  if (exited === null) {
    console.warn('[desktop-smoke] app 10 秒內沒有自己結束，強制砍整個行程群組');
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已經結束 */ }
  }
};
const fail = async (message) => {
  await stop();
  console.error(`[desktop-smoke] 失敗：${message}\n--- server.log 最後 40 行 ---\n${readLog().split(/\r?\n/).slice(-40).join('\n')}`);
  cleanup();
  process.exit(1);
};

const deadline = Date.now() + TIMEOUT_MS;
let port = null;
let health = null;
while (Date.now() < deadline) {
  if (exited !== null) await fail(`app 在 server 就緒之前就結束了（exit ${exited}）`);
  const starts = [...readLog().matchAll(/啟動 server（port (\d+)）/g)];
  if (starts.length > 0) {
    port = starts[starts.length - 1][1];
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) { health = await res.json(); break; }
    } catch {
      // server 還沒 listen，下一輪再試
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (health === null) await fail(port === null ? `${TIMEOUT_MS / 1000} 秒內 server.log 沒出現新的啟動紀錄` : `${TIMEOUT_MS / 1000} 秒內 port ${port} 的 /api/health 沒有回 200`);

// 打包後一定要用隨附的 ffmpeg（E2）：退回 PATH 的話，記錄人電腦上沒有 ffmpeg，每場會都會在轉錄一開始 FAILED
const ffmpegLine = readLog().match(/^ffmpeg：(.*)$/m)?.[1];
if (!ffmpegLine || ffmpegLine.includes('沒有隨附') || !/[\\/]ffmpeg[\\/]ffmpeg(\.exe)?$/.test(ffmpegLine)) {
  await fail(`打包後的 app 沒有用隨附的 ffmpeg（server.log：${ffmpegLine ?? '沒有 ffmpeg 那一行'}）`);
}

let page;
let html;
try {
  page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
  html = await page.text();
} catch (err) {
  // 逾時或連線中斷也要走 fail()：收掉 app、刪暫存目錄、印 server.log
  await fail(`GET / 失敗：${err.message}`);
}
if (!page.ok || !html.includes('<div id="root">')) await fail(`GET / 回 ${page.status}，內容不是 build 出來的 index.html`);

await stop();
await new Promise((r) => setTimeout(r, 1500));
cleanup();
console.log(`[desktop-smoke] 通過：打包後的 app 在 port ${port} 啟動 server，/api/health 回 ${JSON.stringify(health)}，前端頁正常，ffmpeg 用隨附的 ${ffmpegLine}`);
process.exit(0);

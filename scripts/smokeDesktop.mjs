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

const stop = () => {
  if (exited !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGTERM');
};
const fail = (message) => {
  stop();
  console.error(`[desktop-smoke] 失敗：${message}\n--- server.log 最後 40 行 ---\n${readLog().split(/\r?\n/).slice(-40).join('\n')}`);
  cleanup();
  process.exit(1);
};

const deadline = Date.now() + TIMEOUT_MS;
let port = null;
let health = null;
while (Date.now() < deadline) {
  if (exited !== null) fail(`app 在 server 就緒之前就結束了（exit ${exited}）`);
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
if (health === null) fail(port === null ? `${TIMEOUT_MS / 1000} 秒內 server.log 沒出現新的啟動紀錄` : `${TIMEOUT_MS / 1000} 秒內 port ${port} 的 /api/health 沒有回 200`);

const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
const html = await page.text();
if (!page.ok || !html.includes('<div id="root">')) fail(`GET / 回 ${page.status}，內容不是 build 出來的 index.html`);

stop();
await new Promise((r) => setTimeout(r, 1500));
cleanup();
console.log(`[desktop-smoke] 通過：打包後的 app 在 port ${port} 啟動 server，/api/health 回 ${JSON.stringify(health)}，前端頁正常`);

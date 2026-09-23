// 正式版冒煙測試：`npm start` 跑 dist/server.cjs，確認 server 起得來、API 與前端頁都回得出來。
//
// 三條 gate 都守不到這件事：tsc 與 vitest 不碰 dist/，`npm run build` 只證明 bundle 產得出來，
// 不證明它跑得起來。2026-09-16 就查出 dist/server.cjs 檔頭無條件 require("vite")，在沒裝
// devDependencies 的環境一啟動就炸，而三條 gate 全綠。CI 在 `npm prune --omit=dev` 之後跑這支，
// 同時守 `npm start` 在 Windows 上能啟動（cross-env）。
//
// 用法：node scripts/smokeProduction.mjs（先 npm run build）。資料全部寫進暫存目錄，不碰 data/。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = '3999';
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 30_000;

const work = mkdtempSync(join(tmpdir(), 'meetpilot-smoke-'));
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT,
  MEETPILOT_DB: join(work, 'meetpilot.db'),
  MEETPILOT_AUDIO_DIR: join(work, 'audio'),
  MEETPILOT_VAULT: join(work, 'vault'),
  MEETPILOT_LLM_LOG: 'off',
};

// Windows 上 npm 是 npm.cmd，要經 shell 才叫得起來；detached 讓 POSIX 上能整個 process group 一起收掉
const isWindows = process.platform === 'win32';
const child = spawn('npm', ['start'], { env, shell: isWindows, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
let exited = null;
child.on('exit', code => { exited = code; });

const stop = () => {
  if (exited !== null) return;
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGKILL');
};

const fail = (message) => {
  stop();
  console.error(`[smoke] 失敗：${message}\n--- server 輸出 ---\n${output}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
};

const deadline = Date.now() + TIMEOUT_MS;
let health = null;
while (Date.now() < deadline) {
  if (exited !== null) fail(`server 在回應之前就結束了（exit ${exited}）`);
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok) { health = await res.json(); break; }
  } catch {
    // 還沒 listen，連線被拒是等待中的正常狀態，下一輪再試
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (health === null) fail(`${TIMEOUT_MS / 1000} 秒內 /api/health 沒有回 200`);

// 正式模式走 express.static(dist)；拿到的不是 build 出來的 index.html，代表跑成了開發模式或 dist 沒進去
const page = await fetch(`${BASE}/`);
const html = await page.text();
if (!page.ok || !html.includes('<div id="root">')) fail(`GET / 回 ${page.status}，內容不是 build 出來的 index.html`);

stop();
rmSync(work, { recursive: true, force: true });
console.log(`[smoke] 通過：/api/health 回 ${JSON.stringify(health)}，GET / 回 build 出來的 index.html`);

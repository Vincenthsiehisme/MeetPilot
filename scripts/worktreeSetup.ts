/**
 * 開一個可以直接跑 `npm run dev` 的 worktree，不動呼叫端的 clone，也不讓新 worktree 寫到共用位置。
 *
 *   npx tsx scripts/worktreeSetup.ts <分支名> [--path <目錄>] [--base <ref>]
 *
 * 從主 clone 跑。預設 base 是 `origin/main`（本機 main 可能落後），預設目錄是主 clone 旁邊的
 * `<repo 名>-<分支最後一段>`。做四件事，每件的規則都是下面一支純函式，測試釘住：
 *
 * 1. `gitSteps`：先 `git fetch origin`，再 `git worktree add -b`。**呼叫端的 clone 不做 checkout、pull、reset**：
 *    正式 server 可能就從那個目錄跑，在那裡切分支等於換掉正在跑的碼（vault 坑檔 2026-09-24，兩次）。
 * 2. `installStep`：在新 worktree 裡 `npm ci`。不 symlink 主 clone 的 `node_modules`：
 *    Codex 的沙箱寫不進 symlink 過去的目錄，`cp -R` 蓋在 symlink 上會複製進主 clone 裡。
 * 3. `buildWorktreeEnv`：從主 clone 的 `.env` 逐行複製，再改三類：
 *    - 一定改：`PORT` 與 `MEETPILOT_HMR_PORT` 換成空的 port；`MEETPILOT_VAULT` 指到暫存目錄（沒設時預設是 `~/MeetPilot Vault`，跟正式共用）。
 *    - 會寫檔的路徑（`WRITE_TARGET_KEYS`）解析後不在 worktree 裡（絕對路徑、`~`、UNC、`../` 跑出去）就拿掉，
 *      讓它落回 cwd 相對的預設（`data/meetpilot.db` 這類）；留在 worktree 裡的相對路徑與 `off` 原樣留。
 *    - 只讀的輸入路徑（`READ_INPUT_KEYS`）若是相對路徑，改成指回主 clone 的絕對路徑：那些檔多半 gitignored
 *      （名單 CSV 在 `eval-data/`），worktree 裡沒有，server 一啟動就找不到檔而退出（2026-09-25 試跑踩到）。
 *    值只在記憶體裡處理，回傳的報告只有 key 名，不印任何值（`.env` 裡有 API key 與 Basic Auth 密碼）。
 * 4. `findFreePort`：從 3001 往上找 server 的 port、從 24679 往上找 Vite 熱更新的 port（`MEETPILOT_HMR_PORT`），
 *    都要是 127.0.0.1 上沒被佔用的。熱更新的預設 24678 會被主 clone 的 `npm run dev` 佔住。
 *
 * 動手之前先擋一種情況：呼叫的 shell 已經 export 了 `WRITE_TARGET_KEYS`、`PORT`、`MEETPILOT_HMR_PORT`。
 * Node 的 `--env-file` 讓既有環境變數優先，`.env` 寫的安全值會被蓋掉（`inheritedIsolationKeys`）。
 * 暫存 vault 每次用 `mkdtemp` 開新的，不同 worktree、同名重建都不會共用。放在系統暫存目錄，macOS 會清掉
 * 三天沒碰的檔，投影出來的 markdown 可能消失（server 會安靜重建目錄）；worktree 的測試 vault 可以接受這個。
 * 任何一步失敗就停下並 exit 1，已經建好的 worktree 留著讓人看，不自動清掉。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** server 會往裡寫的路徑型設定。新增會寫檔的 `MEETPILOT_*` 時要加進來，不然 worktree 會寫到正式那份。 */
export const WRITE_TARGET_KEYS = ['MEETPILOT_DB', 'MEETPILOT_AUDIO_DIR', 'MEETPILOT_LLM_LOG', 'MEETPILOT_VAULT'] as const;

/** server 只讀不寫的路徑型設定。相對路徑是相對主 clone 寫的，搬到 worktree 要改成絕對路徑。 */
export const READ_INPUT_KEYS = ['MEETPILOT_ROSTER_CSV', 'MEETPILOT_ROSTER_DOCUMENT', 'MEETPILOT_ANALYSIS_SPEC_PATH', 'MEETPILOT_FFMPEG', 'MEETPILOT_FFPROBE'] as const;

export interface GitStep {
  args: string[];
  cwd: string;
}

export function gitSteps(input: { mainClone: string; branch: string; path: string; base: string }): GitStep[] {
  return [
    { args: ['fetch', 'origin'], cwd: input.mainClone },
    // --no-track：不然新分支的 upstream 是 origin/main，push 被拒時 git 提示的正是直推 main 的指令
    { args: ['worktree', 'add', '--no-track', '-b', input.branch, input.path, input.base], cwd: input.mainClone },
  ];
}

export function installStep(worktree: string): { command: string; args: string[]; cwd: string } {
  return { command: 'npm', args: ['ci', '--no-audit', '--no-fund'], cwd: worktree };
}

export function defaultWorktreePath(mainClone: string, branch: string): string {
  const leaf = branch.split('/').pop() ?? branch;
  return join(dirname(mainClone), `${basename(mainClone)}-${leaf}`);
}

export interface EnvReport {
  copied: string[];
  dropped: string[];
  repointed: string[];
  set: string[];
}

/** `/`、`~`、`C:\`、UNC 的 `\\server`、Windows 根目錄相對的 `\foo` 都算絕對。 */
const isAbsoluteLike = (value: string) =>
  value.startsWith('/') || value.startsWith('~') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);

/** 相對路徑解析後跑出 worktree 外（`../shared/x.db`）也不行：寫入路徑只准留在 worktree 裡。 */
export function staysInside(worktree: string, value: string): boolean {
  if (isAbsoluteLike(value)) return false;
  const rel = relative(worktree, resolve(worktree, value));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Node 的 `--env-file` 不蓋掉已經存在的環境變數：shell 裡 export 過這些 key，`.env` 寫的安全值就不生效。
 * 回傳目前環境裡有設的那幾個 key 名（不含值），main 在動手前就擋。
 */
export function inheritedIsolationKeys(env: NodeJS.ProcessEnv): string[] {
  return [...WRITE_TARGET_KEYS, 'PORT', 'MEETPILOT_HMR_PORT'].filter((k) => (env[k] ?? '').trim() !== '');
}

/**
 * 照 Node `--env-file` 的語意取出值：引號開頭就取到對應的收尾引號為止（後面的 `# 註解` 不算值）；
 * 沒有引號就切掉第一個 `#` 之後的行尾註解。不展開變數。
 */
export function parseDotenvValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === '`') {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  const hash = v.indexOf('#');
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** ffmpeg／ffprobe 可以只寫命令名稱（走 PATH），不是相對路徑；其餘只讀輸入的相對值一律是路徑。 */
const COMMAND_NAME_KEYS = ['MEETPILOT_FFMPEG', 'MEETPILOT_FFPROBE'];

/** `.env` 一行一個 `KEY=value`；註解與空行原樣留。 */
export function buildWorktreeEnv(
  source: string,
  overrides: { port: number; hmrPort: number; vaultDir: string; mainClone: string; worktree: string },
): { text: string; report: EnvReport } {
  const report: EnvReport = { copied: [], dropped: [], repointed: [], set: [] };
  const out: string[] = [];
  const forced: Record<string, string> = {
    PORT: String(overrides.port),
    MEETPILOT_HMR_PORT: String(overrides.hmrPort),
    MEETPILOT_VAULT: overrides.vaultDir,
  };
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1];
    const value = parseDotenvValue(m[2]);
    if (key in forced) continue;
    if ((WRITE_TARGET_KEYS as readonly string[]).includes(key) && value === '') {
      out.push(line);
      report.copied.push(key);
      continue;
    }
    if ((WRITE_TARGET_KEYS as readonly string[]).includes(key) && value.toLowerCase() !== 'off' && !staysInside(overrides.worktree, value)) {
      report.dropped.push(key);
      continue;
    }
    const bareCommand = COMMAND_NAME_KEYS.includes(key) && !/[\\/]/.test(value);
    if ((READ_INPUT_KEYS as readonly string[]).includes(key) && value !== '' && !isAbsoluteLike(value) && !bareCommand) {
      out.push(`${key}=${join(overrides.mainClone, value)}`);
      report.repointed.push(key);
      continue;
    }
    out.push(line);
    report.copied.push(key);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push('', '# worktreeSetup.ts 寫的：這個 worktree 專用，不跟正式共用', ...Object.entries(forced).map(([k, v]) => `${k}=${v}`), '');
  report.set.push(...Object.keys(forced));
  return { text: out.join('\n'), report };
}

const canListen = (port: number, host: string | undefined) =>
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });

/**
 * 127.0.0.1 與所有介面都要能 listen 才算空的。Vite 的熱更新 WebSocket 綁所有介面，
 * 只探 127.0.0.1 會把別人綁 `::` 的 port 當成空的，第二個 worktree 拿到同一個 port、熱更新安靜失效。
 */
export const portIsFree = async (port: number) => (await canListen(port, '127.0.0.1')) && (await canListen(port, undefined));

export async function findFreePort(start = 3001, limit = 200): Promise<number> {
  for (let port = start; port < start + limit; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`從 ${start} 往上 ${limit} 個 port 都被佔用`);
}

function parseArgs(argv: string[]): { branch: string; path?: string; base: string } {
  const [branch, ...rest] = argv;
  if (!branch || branch.startsWith('--')) throw new Error('用法：npx tsx scripts/worktreeSetup.ts <分支名> [--path <目錄>] [--base <ref>]');
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  return { branch, path: opt('--path'), base: opt('--base') ?? 'origin/main' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inherited = inheritedIsolationKeys(process.env);
  if (inherited.length) {
    throw new Error(`這個 shell export 了 ${inherited.join('、')}：Node 的 --env-file 不會蓋掉它們，worktree 的 .env 等於沒寫。先 unset 再跑。`);
  }
  const mainClone = resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(), '..');
  const path = resolve(args.path ?? defaultWorktreePath(mainClone, args.branch));
  if (existsSync(path)) throw new Error(`${path} 已經存在，換一個 --path 或先收掉它`);

  for (const step of gitSteps({ mainClone, branch: args.branch, path, base: args.base })) {
    execFileSync('git', step.args, { cwd: step.cwd, stdio: 'inherit' });
  }
  const install = installStep(path);
  execFileSync(install.command, install.args, { cwd: install.cwd, stdio: 'inherit', shell: process.platform === 'win32' });

  const port = await findFreePort();
  const hmrPort = await findFreePort(24679);
  const vaultDir = mkdtempSync(join(tmpdir(), `meetpilot-vault-${basename(path)}-`));
  const sourceEnv = join(mainClone, '.env');
  const source = existsSync(sourceEnv) ? readFileSync(sourceEnv, 'utf8') : '';
  const { text, report } = buildWorktreeEnv(source, { port, hmrPort, vaultDir, mainClone, worktree: path });
  writeFileSync(join(path, '.env'), text, { mode: 0o600 });

  console.log(`\nworktree：${path}（${args.branch}，從 ${args.base}）`);
  console.log(`.env：${existsSync(sourceEnv) ? '從主 clone 複製' : '主 clone 沒有 .env，只寫了下面兩行'}；PORT=${port}、MEETPILOT_HMR_PORT=${hmrPort}、MEETPILOT_VAULT=${vaultDir}`);
  if (report.dropped.length) console.log(`拿掉（指到 worktree 外，改用 worktree 內的預設）：${report.dropped.join('、')}`);
  if (report.repointed.length) console.log(`改指回主 clone（只讀的輸入檔）：${report.repointed.join('、')}`);
  console.log(`複製的 key：${report.copied.join('、') || '無'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

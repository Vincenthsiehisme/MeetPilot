/**
 * 列出（加 `--apply` 才收掉）已經用完的 worktree。
 *
 *   npx tsx scripts/worktreeClean.ts            # 只列候選，不動任何東西
 *   npx tsx scripts/worktreeClean.ts --apply    # 候選移到垃圾桶，再 git worktree prune
 *
 * 從主 clone 或任一 worktree 跑都可以。先 `git fetch origin`（不動 HEAD），再逐一判斷。
 * **只有正面證據才算用完**，三條全成立才是候選（`isCandidate`）：
 *   1. HEAD 已經在 `origin/main` 裡（`git merge-base --is-ancestor`）
 *   2. 工作樹乾淨（`git status --porcelain --untracked-files=all` 空：明寫 untracked，使用者設了
 *      `status.showUntrackedFiles=no` 也不會把有新檔的 worktree 判成乾淨）
 *   3. 沒有任何行程的 cwd 在它底下（`lsof -d cwd`）：dev server 還開著就不收。非 root 的 lsof 只看得到
 *      自己的行程，別的使用者或 sudo 起的行程不算進來；這支假設 worktree 只有自己在用。
 * 主 clone 與 `git worktree lock` 鎖住的永遠不是候選。整支只在 macOS 與 Linux 跑（`lsof`）。判斷不了（例如 lsof 失敗）就整支停下，不當成「沒有人在用」。
 *
 * 收的方式是搬進 `~/.Trash`，可以還原，不做永久刪除；分支不刪，已合併的分支之後用
 * `git branch --merged origin/main` 自己看。gitignored 的東西（`.env`、`data/`）會跟著目錄一起進垃圾桶，
 * 列候選時會標出有沒有 `data/`，裡面可能有那個 worktree 自己的 DB。
 * `--apply` 只支援 macOS（垃圾桶位置），其他平台 exit 1。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  /** `git worktree lock` 鎖住的。鎖是有人明說「別動」，一律保留。 */
  locked: boolean;
}

/** `git worktree list --porcelain`：每個 worktree 一段，段之間空行；第一段是主 clone。 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const blocks = porcelain.trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.map((block, i) => {
    const get = (k: string) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? null;
    const path = get('worktree');
    const head = get('HEAD');
    if (!path || !head) throw new Error(`看不懂 git worktree list 的第 ${i + 1} 段：${block.split('\n')[0]}`);
    const ref = get('branch');
    const locked = block.split('\n').some((l) => l === 'locked' || l.startsWith('locked '));
    return { path, head, branch: ref ? ref.replace(/^refs\/heads\//, '') : null, isMain: i === 0, locked };
  });
}

export interface WorktreeFacts {
  merged: boolean;
  clean: boolean;
  busy: boolean;
}

export function isCandidate(entry: WorktreeEntry, facts: WorktreeFacts): boolean {
  return !entry.isMain && !entry.locked && facts.merged && facts.clean && !facts.busy;
}

/** 行程的 cwd 是這個目錄或在它底下就算在用。只比完整路徑段，`/a/App` 不會吃到 `/a/App-x`。 */
export function isBusy(worktree: string, cwds: string[]): boolean {
  const root = worktree.endsWith(sep) ? worktree : worktree + sep;
  return cwds.some((c) => c === worktree || c.startsWith(root));
}

/** 垃圾桶裡撞名就加編號，不覆蓋。 */
export function trashTarget(trash: string, name: string, exists: (p: string) => boolean): string {
  let target = join(trash, name);
  for (let n = 2; exists(target); n++) target = join(trash, `${name} ${n}`);
  return target;
}

/** 行程檢查靠 `lsof`，Windows 沒有。在任何 git 或 lsof 呼叫之前就停，不要跑到一半 ENOENT。 */
export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === 'win32') throw new Error('worktreeClean 只支援 macOS 與 Linux：判斷「有沒有行程在用」靠 lsof，Windows 沒有');
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function processCwds(): string[] {
  const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
}

function main() {
  assertSupportedPlatform(process.platform);
  const apply = process.argv.includes('--apply');
  if (apply && process.platform !== 'darwin') throw new Error('--apply 只支援 macOS（搬進 ~/.Trash）');
  const here = process.cwd();
  git(here, 'fetch', 'origin');
  const entries = parseWorktreeList(git(here, 'worktree', 'list', '--porcelain'));
  const cwds = processCwds();
  const candidates: WorktreeEntry[] = [];
  for (const e of entries) {
    if (e.isMain) continue;
    if (!existsSync(e.path)) {
      console.log(`已不存在（prune 會清掉紀錄）：${e.path}`);
      continue;
    }
    let merged = true;
    try {
      git(here, 'merge-base', '--is-ancestor', e.head, 'origin/main');
    } catch {
      merged = false;
    }
    const facts = { merged, clean: git(e.path, 'status', '--porcelain', '--untracked-files=all').trim() === '', busy: isBusy(e.path, cwds) };
    const why = [e.locked && '被 git worktree lock 鎖住', !facts.merged && '未合併', !facts.clean && '有未提交的改動', facts.busy && '有行程在用'].filter(Boolean).join('、');
    if (isCandidate(e, facts)) {
      candidates.push(e);
      console.log(`候選：${e.path}（${e.branch ?? 'detached'}）${existsSync(join(e.path, 'data')) ? '，有 data/' : ''}`);
    } else {
      console.log(`保留：${e.path}（${why}）`);
    }
  }
  if (!apply) {
    console.log(`\n${candidates.length} 個候選。加 --apply 才會搬進垃圾桶。`);
    return;
  }
  const trash = join(homedir(), '.Trash');
  const trashDev = statSync(trash).dev;
  const crossVolume = candidates.filter((e) => statSync(e.path).dev !== trashDev);
  if (crossVolume.length) {
    throw new Error(`這幾個跟垃圾桶不在同一個磁碟，搬不過去（rename 跨磁碟會失敗），一個都沒動：${crossVolume.map((e) => e.path).join('、')}`);
  }
  for (const e of candidates) {
    const target = trashTarget(trash, basename(e.path), existsSync);
    renameSync(e.path, target);
    console.log(`已搬進垃圾桶：${e.path} → ${target}`);
  }
  git(here, 'worktree', 'prune');
  console.log(`完成，${candidates.length} 個。分支沒刪。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

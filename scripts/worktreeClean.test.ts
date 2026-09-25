import { describe, expect, it } from 'vitest';
import { isBusy, isCandidate, parseWorktreeList, trashTarget } from './worktreeClean';

const porcelain = [
  'worktree /dev/App',
  'HEAD aaa111',
  'branch refs/heads/main',
  '',
  'worktree /dev/App-feature',
  'HEAD bbb222',
  'branch refs/heads/feat/feature',
  '',
  'worktree /dev/App-detached',
  'HEAD ccc333',
  'detached',
  '',
].join('\n');

describe('parseWorktreeList', () => {
  it('第一段是主 clone，分支去掉 refs/heads/，detached 的分支是 null', () => {
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/dev/App', head: 'aaa111', branch: 'main', isMain: true },
      { path: '/dev/App-feature', head: 'bbb222', branch: 'feat/feature', isMain: false },
      { path: '/dev/App-detached', head: 'ccc333', branch: null, isMain: false },
    ]);
  });

  it('缺 worktree 或 HEAD 的段直接拋錯，不猜', () => {
    expect(() => parseWorktreeList('worktree /dev/App\nbranch refs/heads/main')).toThrow('看不懂');
  });
});

describe('isCandidate', () => {
  const wt = { path: '/dev/App-x', head: 'b', branch: 'x', isMain: false };
  const ok = { merged: true, clean: true, busy: false };

  it('三條都成立才是候選', () => {
    expect(isCandidate(wt, ok)).toBe(true);
  });

  it('未合併、髒、有人在用，任一條就保留', () => {
    expect(isCandidate(wt, { ...ok, merged: false })).toBe(false);
    expect(isCandidate(wt, { ...ok, clean: false })).toBe(false);
    expect(isCandidate(wt, { ...ok, busy: true })).toBe(false);
  });

  it('主 clone 永遠不是候選', () => {
    expect(isCandidate({ ...wt, isMain: true }, ok)).toBe(false);
  });
});

describe('isBusy', () => {
  it('cwd 是它本身或在它底下就算在用', () => {
    expect(isBusy('/dev/App-x', ['/dev/App-x'])).toBe(true);
    expect(isBusy('/dev/App-x', ['/dev/App-x/server'])).toBe(true);
  });

  it('名字是前綴的兄弟目錄不算', () => {
    expect(isBusy('/dev/App', ['/dev/App-x'])).toBe(false);
  });
});

describe('trashTarget', () => {
  it('撞名加編號，不覆蓋', () => {
    const taken = new Set(['/T/App-x', '/T/App-x 2']);
    expect(trashTarget('/T', 'App-x', (p) => taken.has(p))).toBe('/T/App-x 3');
    expect(trashTarget('/T', 'App-y', (p) => taken.has(p))).toBe('/T/App-y');
  });
});

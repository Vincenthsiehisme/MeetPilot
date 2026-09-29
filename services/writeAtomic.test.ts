import { describe, it, expect, vi, beforeEach } from 'vitest';

// rename 與刪暫存檔都失敗的情況只能用換掉 node:fs 的方式造：真的檔案系統上造不出
// 「寫得進 .part、rename 不過、.part 又刪不掉」這個組合（Windows 上 OneDrive 鎖著 .part 就是它）
const { renameSync, rmSync } = vi.hoisted(() => ({ renameSync: vi.fn(), rmSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(), renameSync, rmSync };
});

const { writeAtomic } = await import('./vaultProjector');

beforeEach(() => {
  renameSync.mockReset();
  rmSync.mockReset();
});

describe('writeAtomic', () => {
  it('rename 失敗、暫存檔也刪不掉時，拋出的錯誤同時帶原因與留下的 .part 路徑', () => {
    renameSync.mockImplementation(() => { throw new Error('EPERM: operation not permitted, rename'); });
    rmSync.mockImplementation(() => { throw new Error('EBUSY: resource busy or locked, unlink'); });

    let thrown: unknown;
    try {
      writeAtomic('/shared/王小明/_診斷/server.log', 'x');
    } catch (err) {
      thrown = err;
    }

    const message = (thrown as Error).message;
    expect(message).toMatch(/^EPERM: operation not permitted, rename；暫存檔 .*server\.log\..*\.part 也沒清掉：EBUSY/);
    expect(((thrown as Error).cause as Error).message).toBe('EPERM: operation not permitted, rename');
  });

  it('rename 失敗、暫存檔刪得掉時，原樣拋出 rename 的錯誤', () => {
    const renameErr = new Error('EPERM: operation not permitted, rename');
    renameSync.mockImplementation(() => { throw renameErr; });

    expect(() => writeAtomic('/shared/a.md', 'x')).toThrow(renameErr);
    expect(rmSync).toHaveBeenCalledTimes(1);
  });
});

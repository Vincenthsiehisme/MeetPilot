import { describe, expect, it } from 'vitest';
import { INITIAL_SECRET_STATE, applySecretKeys } from './secretInput';

const type = (...chunks: string[]) => chunks.reduce(applySecretKeys, INITIAL_SECRET_STATE);

describe('applySecretKeys', () => {
  it('貼上一整串再按 Enter：Windows 的 \\r 與 macOS 的 \\n 都算結束', () => {
    expect(type('vercel_blob_rw_abc', '\r')).toMatchObject({ value: 'vercel_blob_rw_abc', done: true, aborted: false });
    expect(type('vercel_blob_rw_abc\n')).toMatchObject({ value: 'vercel_blob_rw_abc', done: true, aborted: false });
  });

  it('Enter 之後的字不算進值（\\r\\n 連著來也只結束一次）', () => {
    expect(type('abc\r\nxyz').value).toBe('abc');
  });

  it('Backspace 的兩種字元都刪一個字', () => {
    expect(type('abcd', '\u007f', '\b', 'x').value).toBe('abx');
    expect(type('\u007f\u007f').value).toBe('');
  });

  it('Ctrl-C 取消，不回半截的值', () => {
    expect(type('abc', '\u0003')).toMatchObject({ aborted: true, done: false });
  });

  it('方向鍵整段跳脫序列都不算進值，包含分兩次送達的情況', () => {
    expect(type('ab\u001b[Dc').value).toBe('abc');
    expect(type('ab\u001b', '[', 'D', 'c').value).toBe('abc');
    expect(type('a\u001b[1;5Cb').value).toBe('ab');
  });

  it('其他控制字元不算進值', () => {
    expect(type('a\u0000\tb').value).toBe('ab');
  });
});

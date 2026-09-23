import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// analyses.prompt_version 是規範檔原始位元組的雜湊。同一版規範只要換行字元不同，雜湊就不同，
// 所以取出來的規範檔一律要是 LF。macOS 上這條永遠綠，它真正在守的是 Windows 的 CI：
// 拿掉 .gitattributes 的 eol=lf，Windows runner 預設的 core.autocrlf=true 會讓它紅。
describe('規範檔的換行字元', () => {
  it('prompts/meeting-record-spec.md 不含 CR，兩個平台算出同一個 prompt_version', () => {
    const spec = readFileSync(new URL('./prompts/meeting-record-spec.md', import.meta.url), 'utf8');
    expect(spec.length).toBeGreaterThan(0);
    expect(spec.includes('\r')).toBe(false);
  });
});

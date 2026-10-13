import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractReleaseNotes, formatTagMessage } from './releaseNotes';

const changelog = [
  '# 版本說明',
  '',
  '前言不算任何一版。',
  '',
  '## v0.3.0：第三版',
  '',
  '這版之後：',
  '- 第一點',
  '',
  '## v0.2.0：第二版',
  '',
  '第二版內文',
  '',
].join('\n');

describe('extractReleaseNotes', () => {
  it('抽到下一個 ## 為止，前後空行去掉', () => {
    expect(extractReleaseNotes(changelog, '0.3.0')).toEqual({ title: 'v0.3.0：第三版', body: '這版之後：\n- 第一點' });
  });

  it('最後一段抽到檔尾', () => {
    expect(extractReleaseNotes(changelog, '0.2.0')).toEqual({ title: 'v0.2.0：第二版', body: '第二版內文' });
  });

  it('CRLF 換行也抽得到', () => {
    expect(extractReleaseNotes(changelog.replace(/\n/g, '\r\n'), '0.2.0').body).toBe('第二版內文');
  });

  it('沒有這一版就報錯，版本號要整段相符', () => {
    expect(() => extractReleaseNotes(changelog, '0.4.0')).toThrow('沒有 v0.4.0');
    expect(() => extractReleaseNotes('## v0.3.0：x\n\nbody\n', '0.3')).toThrow('沒有 v0.3');
  });

  it('標題或內文空白就報錯', () => {
    expect(() => extractReleaseNotes('## v0.3.0：  \n\nbody\n', '0.3.0')).toThrow('標題是空的');
    expect(() => extractReleaseNotes('## v0.3.0：標題\n\n\n## v0.2.0：舊\n\nx\n', '0.3.0')).toThrow('內文是空的');
  });

  it('同一版兩段就報錯', () => {
    expect(() => extractReleaseNotes('## v0.3.0：a\n\nx\n\n## v0.3.0：b\n\ny\n', '0.3.0')).toThrow('出現 2 段');
  });

  it('標題用半形冒號不算，免得 tag 格式跟既有的不一樣', () => {
    expect(() => extractReleaseNotes('## v0.3.0: 標題\n\nbody\n', '0.3.0')).toThrow('沒有 v0.3.0');
  });
});

describe('formatTagMessage', () => {
  it('第一行標題、空一行、內文，跟既有 annotated tag 同格式', () => {
    expect(formatTagMessage({ title: 'v0.3.0：第三版', body: '內文' })).toBe('v0.3.0：第三版\n\n內文\n');
  });
});

describe('CHANGELOG.md', () => {
  it('package.json 這一版抽得到說明', () => {
    const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(extractReleaseNotes(readFileSync(resolve('CHANGELOG.md'), 'utf8'), version).title).toMatch(`v${version}：`);
  });
});

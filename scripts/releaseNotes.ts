/**
 * 從 CHANGELOG.md 抽出 package.json 這一版的說明，印成 tag message（vault plan「MeetPilot · CI 安裝檔改傳 GitHub Release」）。
 *
 *   npx tsx scripts/releaseNotes.ts            # stdout 印 tag message，抽不到就 exit 1
 *
 * 一版一段，標題行是 `## v<版本>：<標題>`，到下一個 `## ` 為止是內文。印出來的格式跟 `v0.1.0`～`v0.2.0` 的
 * annotated tag 一樣：第一行 `v<版本>：<標題>`、空一行、內文。CI 拿第一行當 Release 標題、第三行起當 Release 說明，
 * 整段當 annotated tag 的 message，三處是同一份文字。
 * 找不到這一版、標題空白、內文空白、同一版出現兩段，都報錯：版本要發卻沒有說明時 CI 要紅，不發一個沒有說明的版本。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ReleaseNotes {
  /** `v<版本>：<標題>`，Release 標題與 tag message 的第一行。 */
  title: string;
  body: string;
}

const HEADING = /^## (v\d+\.\d+\.\d+)：(.*)$/;

export function extractReleaseNotes(changelog: string, version: string): ReleaseNotes {
  const tag = `v${version}`;
  const lines = changelog.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (HEADING.exec(line)?.[1] === tag ? [i] : []));
  if (starts.length === 0) throw new Error(`CHANGELOG.md 沒有 ${tag} 這一段（標題行要寫成「## ${tag}：<標題>」）`);
  if (starts.length > 1) throw new Error(`CHANGELOG.md 的 ${tag} 出現 ${starts.length} 段，只能有一段`);
  const start = starts[0];
  const heading = (HEADING.exec(lines[start])?.[2] ?? '').trim();
  if (!heading) throw new Error(`CHANGELOG.md 的 ${tag} 標題是空的`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const body = lines.slice(start + 1, next === -1 ? undefined : next).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md 的 ${tag} 內文是空的`);
  return { title: `${tag}：${heading}`, body };
}

export function formatTagMessage(notes: ReleaseNotes): string {
  return `${notes.title}\n\n${notes.body}\n`;
}

function main(): void {
  const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
  const notes = extractReleaseNotes(readFileSync(resolve('CHANGELOG.md'), 'utf8'), version);
  process.stdout.write(formatTagMessage(notes));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * 把名單 CSV 發到 gateway 的私有 Vercel Blob store（vault plan「MeetPilot · 跨平台打包部署」）。
 *
 *   BLOB_READ_WRITE_TOKEN=<token> npx tsx scripts/publishRoster.ts <CSV 路徑>
 *
 * token 在 Vercel 的 Blob store 頁面（或 gateway 專案 `vercel env pull` 之後的 .env.local）。
 * 不要寫進 repo 的 .env，也不要貼進 shell history 以外的地方。
 *
 * 先用 buildRosterDocument 整份驗過（跟 CLI 匯入同一套 parseRosterCsv），有任何一列錯就整批不發。
 * 覆寫同一個 pathname，gateway 讀的時候不走 CDN 快取，發完各台 app 下次啟動就拿到新名單。
 * 名單是 PII，只放 Blob，不進任何 git repo。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { put } from '@vercel/blob';
import { ROSTER_BLOB_PATHNAME, buildRosterDocument } from '../services/rosterDocument';
import { DEFAULT_ROSTER_EMAIL_DOMAIN, RosterImportFileError } from '../services/rosterImportRunner';

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('用法：BLOB_READ_WRITE_TOKEN=<token> npx tsx scripts/publishRoster.ts <CSV 路徑>');
    process.exitCode = 1;
    return;
  }
  // 沒有 token 時 SDK 自己的錯誤訊息看不出要去哪裡拿，這裡先擋
  if (!(process.env.BLOB_READ_WRITE_TOKEN ?? '').trim()) {
    console.error('BLOB_READ_WRITE_TOKEN 沒設：到 Vercel 的 Blob store 頁面拿，只在這次指令的環境變數裡帶');
    process.exitCode = 1;
    return;
  }

  let body: string;
  let count: number;
  try {
    const doc = buildRosterDocument(readFileSync(resolve(csvPath), 'utf-8'), DEFAULT_ROSTER_EMAIL_DOMAIN);
    body = JSON.stringify(doc);
    count = doc.rows.length;
  } catch (err) {
    if (err instanceof RosterImportFileError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const blob = await put(ROSTER_BLOB_PATHNAME, body, {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  console.log(`已發布 ${count} 人到 ${blob.pathname}（${Buffer.byteLength(body)} bytes）。各台 app 下次啟動會拿到新名單。`);
}

main();

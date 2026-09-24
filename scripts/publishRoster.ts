/**
 * 把名單 CSV 發到 gateway 的私有 Vercel Blob store（vault plan「MeetPilot · 跨平台打包部署」）。
 *
 *   npx tsx scripts/publishRoster.ts <CSV 路徑>
 *
 * 跑起來會提示貼上 Blob token（Vercel 的 Blob store 頁面拿），輸入不回顯。token 不走指令列：
 * `BLOB_READ_WRITE_TOKEN=<token> cmd` 會把能讀寫整份名單的憑證留在 shell history，而且 Windows 的
 * cmd／PowerShell 不吃這種寫法。非互動環境（CI）才用 BLOB_READ_WRITE_TOKEN 環境變數。
 * token 不要寫進 repo 的 .env。
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
import { promptSecret } from './secretInput';

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('用法：npx tsx scripts/publishRoster.ts <CSV 路徑>');
    process.exitCode = 1;
    return;
  }

  // 先驗 CSV 再要 token：名單有錯的話不用讓人先去找 token
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
  console.log(`名單驗過：${count} 人。`);

  let token = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (token === '') {
    try {
      token = await promptSecret('貼上 Blob token（Vercel 的 Blob store 頁面，輸入不顯示）後按 Enter：');
    } catch (err) {
      console.error(`沒有拿到 token：${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  // 空的 token 交給 SDK，錯誤訊息看不出是 token 的問題，這裡先擋
  if (token === '') {
    console.error('token 是空的，沒有發布');
    process.exitCode = 1;
    return;
  }

  const blob = await put(ROSTER_BLOB_PATHNAME, body, {
    token,
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  console.log(`已發布 ${count} 人到 ${blob.pathname}（${Buffer.byteLength(body)} bytes）。各台 app 下次啟動會拿到新名單。`);
}

main();

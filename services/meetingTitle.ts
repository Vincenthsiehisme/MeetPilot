/**
 * 會議標題的規則，只有這一份：pipeline 填模型的建議、PATCH 收人改的、匯出與列印組下載檔名，
 * 三處都從這裡拿。兩邊各寫一份的話，「模型給得出、人卻存不進去」那種不一致不會有任何錯誤訊息。
 * 純函式、不帶 node 依賴，前端與 server 都能 import（同 meetingApi.ts 的理由）。
 */
import { Job } from '../types';

export const MEETING_TITLE_MAX_LENGTH = 100;

export type TitleCheck =
  | { ok: true; title: string }
  | { ok: false; reason: string };

/**
 * 值要嘛是可以存的標題（trim 過），要嘛帶一句能直接回給使用者的理由。
 * 長度用 code point 數，不用 `.length`：後者算 UTF-16 code unit，一個 emoji 算 2。
 */
export const checkMeetingTitle = (value: unknown): TitleCheck => {
  if (typeof value !== 'string') return { ok: false, reason: '標題必須是字串' };
  const title = value.trim();
  if (title === '') return { ok: false, reason: '標題不能是空的' };
  if (/\p{Cc}/u.test(title)) return { ok: false, reason: '標題不能含換行或其他控制字元' };
  const length = Array.from(title).length;
  if (length > MEETING_TITLE_MAX_LENGTH) {
    return { ok: false, reason: `標題最多 ${MEETING_TITLE_MAX_LENGTH} 字（收到 ${length} 字）` };
  }
  return { ok: true, title };
};

type Named = Pick<Job, 'title' | 'fileName'>;

/** 畫面上叫這場會什麼：有標題用標題，沒有就是原始檔名 */
export const jobDisplayName = (job: Named): string => job.title ?? job.fileName;

/**
 * 下載檔名的主體（不含 `_minutes.md` 之類的後綴）。
 *
 * 有標題就用標題，去掉檔案系統不收的字元（跟 vaultProjector.ts 的 sanitizeTitle 同一組）與控制字元，
 * 連續空白收成一個；清完是空的（標題全是不合法字元）才退回原始檔名。沒有標題時原始檔名**原樣**回傳，
 * 不清理：那是使用者硬碟上存在過的檔名，改它等於改掉使用者認得的東西。
 */
export const jobDownloadBaseName = (job: Named): string => {
  if (job.title === undefined) return job.fileName;
  const cleaned = job.title
    .replace(/[/\\:*?"<>|[\]]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? job.fileName : cleaned;
};

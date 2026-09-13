import { GeminiOutput, Job } from '../types';
import { escapeHtml } from './escapeHtml';

/**
 * 從結構化的 Job 與分析結果組出列印用的完整 HTML 字串。
 * 檔名與 AI 產生的內容都是使用者可控字串，每個值進 HTML 前都經過 escapeHtml；
 * 不讀畫面 DOM、不用正則改寫標籤。純函式，可在 node 環境測。
 */

const PRINT_STYLE = `
  body { font-family: sans-serif; padding: 40px; color: #333; line-height: 1.6; }
  h1 { font-size: 24px; margin-bottom: 5px; }
  h2 { font-size: 16px; text-transform: uppercase; border-bottom: 2px solid #eee; padding-bottom: 5px; margin-top: 30px; }
  h3 { font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
  .meta { font-size: 12px; color: #666; margin-bottom: 30px; }
  .pre { white-space: pre-wrap; }
  .topic-item { margin-bottom: 20px; }
  .topic-title { font-weight: bold; display: block; margin-bottom: 5px; }
  .empty { color: #999; font-style: italic; }
  ul { padding-left: 20px; }
  li { margin-bottom: 8px; white-space: pre-wrap; }
`;

const renderList = (items: string[], emptyText: string): string => {
  if (items.length === 0) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
};

const renderTopics = (topics: GeminiOutput['topics']): string => {
  if (topics.length === 0) {
    return '<p class="empty">無議題</p>';
  }
  return topics
    .map(
      (topic) =>
        `<div class="topic-item"><span class="topic-title">${escapeHtml(topic.title)}</span><div class="pre">${escapeHtml(topic.content)}</div></div>`
    )
    .join('');
};

export function buildPrintDocument(job: Job, analysis: GeminiOutput): string {
  const fileName = escapeHtml(job.fileName);
  const date = escapeHtml(new Date(job.createdAt).toLocaleDateString());

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${fileName} - Meeting Minutes</title>
<style>${PRINT_STYLE}</style>
</head>
<body>
<h1>會議記錄</h1>
<div class="meta">FILE: ${fileName} | DATE: ${date}</div>
<h3>會議主旨</h3>
<div class="pre">${escapeHtml(analysis.overview)}</div>
<h2>議題</h2>
${renderTopics(analysis.topics)}
<h2>決議事項</h2>
${renderList(analysis.decisions, '無明確決議')}
<h2>待辦事項</h2>
${renderList(analysis.action_items, '無待辦事項')}
</body>
</html>`;
}

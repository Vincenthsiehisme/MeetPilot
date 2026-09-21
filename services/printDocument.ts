import { Job } from '../types';
import { ActionItemV3, AnalysisV3, DecisionV3, Evidence, OpenQuestionV3 } from './analysisContract';
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
  .meta-inline { font-size: 11px; color: #999; }
  .pre { white-space: pre-wrap; }
  .topic-item { margin-bottom: 20px; }
  .topic-title { font-weight: bold; display: block; margin-bottom: 5px; }
  .empty { color: #999; font-style: italic; }
  ul { padding-left: 20px; }
  li { margin-bottom: 8px; white-space: pre-wrap; }
`;

/** v3 的 evidence 顯示成 MM:SS–MM:SS，跟 vaultProjector.ts／exportUtils.ts 同一種格式 */
const formatEvidenceRange = (evidence: Evidence | null): string | null => {
  if (evidence === null) return null;
  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  return `${fmt(evidence.start)}–${fmt(evidence.end)}`;
};

const renderTopics = (topics: AnalysisV3['topics']): string => {
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

const renderDecisions = (decisions: readonly DecisionV3[], emptyText: string): string => {
  if (decisions.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${decisions.map((d) => {
    const meta = [d.decided_by ? `拍板：${d.decided_by}` : null, formatEvidenceRange(d.evidence)]
      .filter((x): x is string => x !== null);
    const metaHtml = meta.length > 0 ? ` <span class="meta-inline">（${escapeHtml(meta.join('，'))}）</span>` : '';
    return `<li>${escapeHtml(d.text)}${metaHtml}</li>`;
  }).join('')}</ul>`;
};

const renderActionItems = (items: readonly ActionItemV3[], emptyText: string): string => {
  if (items.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((a) => {
    const meta = [
      a.assignee ? `負責人：${a.assignee}` : null,
      a.due ? `期限：${a.due}` : null,
      formatEvidenceRange(a.evidence),
    ].filter((x): x is string => x !== null);
    const metaHtml = meta.length > 0 ? ` <span class="meta-inline">（${escapeHtml(meta.join('；'))}）</span>` : '';
    return `<li>${escapeHtml(a.text)}${metaHtml}</li>`;
  }).join('')}</ul>`;
};

const renderOpenQuestions = (questions: readonly OpenQuestionV3[], emptyText: string): string => {
  if (questions.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${questions.map((q) => {
    const meta = formatEvidenceRange(q.evidence);
    const metaHtml = meta !== null ? ` <span class="meta-inline">（${escapeHtml(meta)}）</span>` : '';
    return `<li>${escapeHtml(q.text)}${metaHtml}</li>`;
  }).join('')}</ul>`;
};

export function buildPrintDocument(job: Job, analysis: AnalysisV3): string {
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
<h2>討論</h2>
${renderTopics(analysis.topics)}
<h2>決議</h2>
${renderDecisions(analysis.decisions, '本場沒有明確決議')}
<h2>待辦</h2>
${renderActionItems(analysis.action_items, '本場沒有待辦')}
<h2>未決事項</h2>
${renderOpenQuestions(analysis.open_questions, '本場沒有未決事項')}
</body>
</html>`;
}

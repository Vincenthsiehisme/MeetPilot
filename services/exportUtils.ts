
import { Job, TranscriptSegment } from "../types";
import { ActionItemV3, AnalysisV3, DecisionV3, Evidence, OpenQuestionV3, TopicV3 } from "./analysisContract";
import { jobDisplayName, jobDownloadBaseName } from "./meetingTitle";

/**
 * revoke 要等的時間。
 *
 * 瀏覽器是**非同步**去讀這個 blob URL 的：`click()` 只是把下載排進去，真正開始讀檔在之後。
 * 同一個 tick 就 revoke 會跟下載啟動搶時間，Safari 上會下載到空檔或整個不動。
 * 多留一秒才收記憶體，跟「檔案沒下載到」比起來不是同一個量級的代價 ——
 * 尤其這條路徑是本機音檔唯一的出口，那份音檔失敗就真的沒了。
 */
const REVOKE_DELAY_MS = 1000;

/**
 * 把一份 Blob 交給使用者下載。所有下載都走這裡，不要各寫一份。
 *
 * anchor 要先掛進 DOM 再 click：部分 Firefox 版本對沒進過文件樹的 detached anchor，
 * `click()` 不會觸發下載，而且不會報錯 —— 使用者按了沒反應，也不知道要回報什麼。
 */
export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};

const downloadFile = (content: string, fileName: string, contentType: string) => {
  downloadBlob(new Blob([content], { type: contentType }), fileName);
};

// --- Time Formatters ---

const formatTimeSRT = (seconds: number): string => {
  const date = new Date(0);
  date.setUTCMilliseconds(seconds * 1000);
  const iso = date.toISOString().substr(11, 12); // HH:MM:SS.mmm
  return iso.replace('.', ',');
};

const formatTimeSimple = (seconds: number): string => {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `[${m}:${s}]`;
};

/** v3 的 evidence 顯示成 MM:SS–MM:SS，跟 vaultProjector.ts 的投影格式一致，
 * 不用 formatTimeSimple 的方括號單點格式（那是逐字稿一個時間點，這裡是一段區間） */
const formatEvidenceRange = (evidence: Evidence | null): string | null => {
  if (evidence === null) return null;
  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  return `${fmt(evidence.start)}–${fmt(evidence.end)}`;
};

const renderDecisionLine = (d: DecisionV3): string => {
  const meta = [d.decided_by ? `拍板：${d.decided_by}` : null, formatEvidenceRange(d.evidence)]
    .filter((x): x is string => x !== null);
  return meta.length > 0 ? `${d.text}（${meta.join('，')}）` : d.text;
};

const renderActionItemLine = (a: ActionItemV3): string => {
  const meta = [
    a.assignee ? `負責人：${a.assignee}` : null,
    a.due ? `期限：${a.due}` : null,
    formatEvidenceRange(a.evidence),
  ].filter((x): x is string => x !== null);
  return meta.length > 0 ? `${a.text}（${meta.join('；')}）` : a.text;
};

const renderOpenQuestionLine = (q: OpenQuestionV3): string => {
  const meta = formatEvidenceRange(q.evidence);
  return meta === null ? q.text : `${q.text}（${meta}）`;
};

// --- Export Functions ---

export const exportTranscriptAsSRT = (fileName: string, segments: TranscriptSegment[]) => {
  const srtContent = segments.map((seg, index) => {
    return `${index + 1}\n${formatTimeSRT(seg.start)} --> ${formatTimeSRT(seg.end)}\n${seg.text}\n`;
  }).join('\n');
  
  downloadFile(srtContent, `${fileName}.srt`, "text/plain");
};

export const exportTranscriptAsText = (fileName: string, segments: TranscriptSegment[], withTimestamps: boolean) => {
  const content = segments.map(seg => {
    const speaker = seg.speaker ? `${seg.speaker}: ` : '';
    const time = withTimestamps ? `${formatTimeSimple(seg.start)} ` : '';
    return `${time}${speaker}${seg.text}`;
  }).join('\n\n');

  downloadFile(content, `${fileName}_transcript.txt`, "text/plain");
};

export const exportPolishedContent = (fileName: string, content: string) => {
  downloadFile(content, `${fileName}_polished.md`, "text/markdown");
};

/** 議題：小標、走到哪、條列要點；要點的出處用行內程式碼當縮小標籤，跟 vaultProjector.ts 同一種寫法。
 * 舊資料沒有 points，只印 content */
const renderTopicMarkdown = (t: TopicV3): string => [
  `### ${t.title}`,
  t.content,
  ...(t.points ?? []).map((pt) => {
    const range = formatEvidenceRange(pt.evidence);
    return range === null ? `- ${pt.text}` : `- ${pt.text} \`${range}\``;
  }),
].join('\n');

// 會議記錄的匯出收整個 job 不只收檔名：檔名用標題（jobDownloadBaseName），內文的「來源檔名」仍是原始檔名，
// 兩者不是同一個字串，收一個字串進來就得在呼叫端二選一
export const exportSummaryAsMarkdown = (job: Pick<Job, 'title' | 'fileName'>, analysis: AnalysisV3) => {
  const { overview, topics, decisions, action_items, open_questions } = analysis;

  const topicsSection = topics.map((t) => renderTopicMarkdown(t)).join('\n\n');

  const md = `
# ${jobDisplayName(job)}
**來源檔名：** ${job.fileName}
**產出時間：** ${new Date().toLocaleString()}

---

## 1. 會議主旨 (Overview)
${overview}

## 2. 議題討論紀錄 (Topics)
${topicsSection || '*本場沒有討論題目*'}

## 3. 決議事項 (Decisions)
${decisions.length > 0 ? decisions.map((d) => `- ${renderDecisionLine(d)}`).join('\n') : '*本場沒有明確決議*'}

## 4. 待辦事項 (Action Items)
${action_items.length > 0 ? action_items.map((a) => `- [ ] ${renderActionItemLine(a)}`).join('\n') : '*本場沒有待辦*'}

## 5. 未決事項 (Open Questions)
${open_questions.length > 0 ? open_questions.map((q) => `- ${renderOpenQuestionLine(q)}`).join('\n') : '*本場沒有未決事項*'}

---
*Generated by WhisperX & Gemini*
  `.trim();

  downloadFile(md, `${jobDownloadBaseName(job)}_minutes.md`, "text/markdown");
};

export const exportSummaryAsText = (job: Pick<Job, 'title' | 'fileName'>, analysis: AnalysisV3) => {
   const { overview, topics, decisions, action_items, open_questions } = analysis;

   const topicsSection = topics.map((t) => [
     `【${t.title}】`,
     t.content,
     ...(t.points ?? []).map((pt) => {
       const range = formatEvidenceRange(pt.evidence);
       return range === null ? `・${pt.text}` : `・${pt.text}（${range}）`;
     }),
   ].join('\n')).join('\n\n');

   const txt = `
 ${jobDisplayName(job)}
 來源檔名：${job.fileName}
 ----------------------------------------

 [1] 會議主旨
 ${overview}

 [2] 議題討論紀錄
 ${topicsSection || '(本場沒有討論題目)'}

 [3] 決議事項
 ${decisions.length > 0 ? decisions.map((d) => `• ${renderDecisionLine(d)}`).join('\n') : '(無)'}

 [4] 待辦事項
 ${action_items.length > 0 ? action_items.map((a) => `[ ] ${renderActionItemLine(a)}`).join('\n') : '(無)'}

 [5] 未決事項
 ${open_questions.length > 0 ? open_questions.map((q) => `• ${renderOpenQuestionLine(q)}`).join('\n') : '(無)'}
   `.trim();

   downloadFile(txt, `${jobDownloadBaseName(job)}_minutes.txt`, "text/plain");
 };

// --- System Exports ---

export const exportJobAsJSON = (job: Job) => {
  const sortedSegments = [...(job.transcript || [])].sort((a, b) => a.start - b.start);
  
  const data = {
    job_id: job.id,
    title: job.title ?? null,
    file_name: job.fileName,
    created_at: new Date(job.createdAt).toISOString(),
    status: job.status,
    transcript_full: {
      segments: sortedSegments
    },
    polished_content: job.polishedContent,
    gemini_output: job.analysis || null,
    metadata: {
      file_size_bytes: job.fileSize,
      file_size_mb: (job.fileSize / (1024 * 1024)).toFixed(2),
      total_slices: job.totalSlices,
      processed_at: new Date(job.updatedAt).toISOString()
    }
  };
  
  const jsonString = JSON.stringify(data, null, 2);
  downloadFile(jsonString, `${jobDownloadBaseName(job)}_backup.json`, "application/json");
};

export const exportErrorAsJSON = (job: Job) => {
  const errorData = {
    job_id: job.id,
    file_name: job.fileName,
    error_code: job.status,
    error_message: job.error,
    timestamp: new Date().toISOString(),
    last_step: job.steps[job.currentStep]?.name
  };
  const jsonString = JSON.stringify(errorData, null, 2);
  downloadFile(jsonString, `error_${job.id}.json`, "application/json");
};

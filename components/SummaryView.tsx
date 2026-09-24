
import React, { useRef, useEffect, useState } from 'react';
import { Job } from '../types';
import { ActionItemV3, AnalysisV3, DecisionV3, Evidence, OpenQuestionV3 } from '../services/analysisContract';
import { exportSummaryAsMarkdown, exportSummaryAsText } from '../services/exportUtils';
import { jobDisplayName } from '../services/meetingTitle';
import { buildPrintDocument } from '../services/printDocument';
import { createDraftSync } from '../services/editSaves';

interface SummaryViewProps {
  analysis: AnalysisV3;
  jobMetadata: Job;
  /** 送出一份完整快照去存。回傳有沒有存進去；沒有的話原因已經由呼叫端講給使用者 */
  onUpdate: (analysis: AnalysisV3) => Promise<boolean>;
}

const AutoResizeTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = (props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [props.value]);

  return (
    <textarea
      ref={textareaRef}
      {...props}
      onChange={(e) => {
        adjustHeight();
        props.onChange?.(e);
      }}
      className={`resize-none overflow-hidden ${props.className || ''}`}
    />
  );
};

/** 秒數轉 MM:SS。跟 geminiServerClient.ts／exportUtils.ts 是同一種簡單格式，這裡不特別共用模組 */
const formatTimestamp = (seconds: number): string => {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

const formatEvidence = (evidence: Evidence | null): string | null =>
  evidence === null ? null : `${formatTimestamp(evidence.start)}–${formatTimestamp(evidence.end)}`;

/** 出處與人名／期限這些 metadata 一律唯讀顯示，只有 text 可編輯——規範要求「沒出處的不寫」，
 * 使用者改文字不該連帶讓出處失效或被偽造成新出處 */
const MetaTags: React.FC<{ parts: (string | null)[] }> = ({ parts }) => {
  const visible = parts.filter((p): p is string => p !== null && p !== '');
  if (visible.length === 0) return null;
  return (
    <div className="text-[10px] text-slate-400 mt-1 flex gap-3 flex-wrap">
      {visible.map((p, i) => <span key={i}>{p}</span>)}
    </div>
  );
};

/** 討論要點的出處：接在文字後面的縮小標籤（vault plan「MeetPilot · 會議記錄結構化與逐點出處」，使用者 2026-09-24 指定） */
const EvidenceTag: React.FC<{ evidence: Evidence | null }> = ({ evidence }) => {
  const range = formatEvidence(evidence);
  if (range === null) return null;
  return (
    <span className="shrink-0 mt-1 text-[10px] leading-4 text-slate-500 bg-slate-100 rounded px-1.5 tabular-nums">{range}</span>
  );
};

const newDecision = (): DecisionV3 => ({ text: '', evidence: null, decided_by: null });

const newActionItem = (meetingId: string): ActionItemV3 => ({
  text: '',
  source_meeting_id: meetingId,
  created_at: Date.now(),
  status: 'unknown',
  assignee: null,
  due: null,
  evidence: null,
});

const newOpenQuestion = (): OpenQuestionV3 => ({ text: '', evidence: null });

const SummaryView: React.FC<SummaryViewProps> = ({ analysis, jobMetadata, onUpdate }) => {
  // 畫面上顯示與編輯的是這份草稿，不是 prop。原本每打一個字就用 prop 組整份快照送出，prop 要等存檔
  // 後重拉才會變，受控的輸入框在那之前被還原成舊值，下一個字接在舊值後面：逐鍵打 26 個字，server 只
  // 留下最後一個（2026-09-24 實測，細節在 services/editSaves.ts）
  const [draft, setDraft] = useState<AnalysisV3>(analysis);
  const [sync] = useState(createDraftSync);

  // server 的版本只在草稿沒有未送出修改、也沒有存檔在路上時才換上來，理由在 createDraftSync
  useEffect(() => {
    if (sync.canAdoptServer()) setDraft(analysis);
  }, [analysis, sync]);

  const save = async (next: AnalysisV3) => {
    sync.saveStarted();
    const saved = await onUpdate(next);
    sync.saveSettled(saved);
  };

  // 打字只改草稿，離開欄位才存：一次編輯一次 PATCH，不是一個字一次
  const edit = (next: AnalysisV3) => {
    sync.edited();
    setDraft(next);
  };
  const saveIfEdited = () => {
    if (sync.hasUnsent()) save(draft);
  };

  // 新增與刪除是一次完成的動作，當下就存
  const commit = (next: AnalysisV3) => {
    setDraft(next);
    save(next);
  };

  const withField = <K extends keyof AnalysisV3>(field: K, value: AnalysisV3[K]): AnalysisV3 =>
    ({ ...draft, [field]: value });

  const updateDecisionText = (index: number, text: string) => {
    const list = [...draft.decisions];
    list[index] = { ...list[index], text };
    edit(withField('decisions', list));
  };
  const removeDecision = (index: number) =>
    commit(withField('decisions', draft.decisions.filter((_, i) => i !== index)));
  const addDecision = () => commit(withField('decisions', [...draft.decisions, newDecision()]));

  const updateActionItemText = (index: number, text: string) => {
    const list = [...draft.action_items];
    list[index] = { ...list[index], text };
    edit(withField('action_items', list));
  };
  const removeActionItem = (index: number) =>
    commit(withField('action_items', draft.action_items.filter((_, i) => i !== index)));
  const addActionItem = () =>
    commit(withField('action_items', [...draft.action_items, newActionItem(jobMetadata.id)]));

  const updateOpenQuestionText = (index: number, text: string) => {
    const list = [...draft.open_questions];
    list[index] = { ...list[index], text };
    edit(withField('open_questions', list));
  };
  const removeOpenQuestion = (index: number) =>
    commit(withField('open_questions', draft.open_questions.filter((_, i) => i !== index)));
  const addOpenQuestion = () => commit(withField('open_questions', [...draft.open_questions, newOpenQuestion()]));

  const updateTopic = (index: number, key: 'title' | 'content', value: string) => {
    const newTopics = [...draft.topics];
    newTopics[index] = { ...newTopics[index], [key]: value };
    edit(withField('topics', newTopics));
  };
  // 要點只改文字、只能刪不能加：出處是唯讀的，新增的要點沒有出處，違反規範「沒出處的不寫」
  const updateTopicPoint = (topicIndex: number, pointIndex: number, text: string) => {
    const newTopics = [...draft.topics];
    const points = [...(newTopics[topicIndex].points ?? [])];
    points[pointIndex] = { ...points[pointIndex], text };
    newTopics[topicIndex] = { ...newTopics[topicIndex], points };
    edit(withField('topics', newTopics));
  };
  const removeTopicPoint = (topicIndex: number, pointIndex: number) => {
    const newTopics = [...draft.topics];
    newTopics[topicIndex] = {
      ...newTopics[topicIndex],
      points: (newTopics[topicIndex].points ?? []).filter((_, j) => j !== pointIndex),
    };
    commit(withField('topics', newTopics));
  };

  const handlePrint = () => {
    // 開啟新視窗列印，避免 CSS 污染與隱藏問題
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    // 從結構化資料組列印文件，每個值都經過跳脫；不讀畫面 innerHTML
    printWindow.document.write(buildPrintDocument(jobMetadata, draft));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  return (
    <div className="w-full h-full overflow-y-auto bg-slate-50/20 pb-20">
      <div className="max-w-4xl mx-auto my-6 sm:my-10 bg-white shadow-sm border border-slate-200 rounded-none sm:rounded-xl min-h-[800px] flex flex-col relative print:shadow-none print:border-none">

        {/* Document Header */}
        <div className="px-8 sm:px-12 pt-12 pb-8 border-b border-slate-100">
           <div className="flex justify-between items-start">
             <div>
               <h1 className="text-2xl sm:text-3xl font-serif font-bold text-slate-900 mb-2">{jobDisplayName(jobMetadata)}</h1>
               <div className="text-xs text-slate-500 font-medium flex gap-4">
                 <span><i className="fa-regular fa-file-audio mr-1.5"></i>{jobMetadata.fileName}</span>
                 <span><i className="fa-regular fa-calendar mr-1.5"></i>{new Date(jobMetadata.createdAt).toLocaleDateString()}</span>
               </div>
             </div>
             <div className="flex flex-col items-end gap-3">
               <span className="inline-block px-3 py-1 bg-slate-900 text-white text-[10px] font-bold uppercase tracking-widest rounded">CONFIDENTIAL</span>

               {/* Context Aware Export Buttons */}
               <div className="flex bg-slate-100 rounded-lg p-0.5" role="group">
                  <button
                    onClick={() => exportSummaryAsMarkdown(jobMetadata, draft)}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition-all"
                    title="匯出 Markdown"
                  >
                    <i className="fa-brands fa-markdown text-sm"></i>
                  </button>
                  <div className="w-px bg-slate-200 my-1"></div>
                  <button
                    onClick={() => exportSummaryAsText(jobMetadata, draft)}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition-all"
                    title="匯出純文字"
                  >
                    <i className="fa-regular fa-file-lines text-sm"></i>
                  </button>
                  <div className="w-px bg-slate-200 my-1"></div>
                  <button
                    onClick={handlePrint}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition-all"
                    title="列印 / 另存 PDF"
                  >
                    <i className="fa-solid fa-print text-sm"></i>
                  </button>
               </div>
             </div>
           </div>

           {/* Overview Section */}
           <div className="mt-8 bg-slate-50 p-4 rounded-lg border border-slate-100">
             <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">會議主旨</h3>
             <AutoResizeTextarea
                className="w-full text-slate-700 font-medium text-sm leading-relaxed bg-transparent border-none focus:bg-white focus:ring-1 focus:ring-indigo-100 p-1 rounded transition-colors outline-none whitespace-pre-wrap break-words"
                value={draft.overview}
                onChange={(e) => edit(withField('overview', e.target.value))}
                onBlur={saveIfEdited}
                placeholder="輸入會議主旨..."
              />
           </div>
        </div>

        {/* Document Body */}
        <div className="px-8 sm:px-12 py-8 space-y-12 flex-1">

          {/* Topics Section (Structured Minutes) */}
          <section>
            <div className="flex items-center gap-2 mb-6 border-l-4 border-indigo-500 pl-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">討論</h2>
              <span className="bg-indigo-50 text-indigo-600 text-[10px] px-2 py-0.5 rounded-full font-bold">{draft.topics.length}</span>
            </div>

            <div className="space-y-6">
              {draft.topics.map((topic, i) => (
                <div key={i} className="group relative pl-4 border-l border-slate-200 hover:border-indigo-300 transition-colors topic-item">
                  <div className="absolute -left-1.5 top-0 w-3 h-3 rounded-full bg-slate-200 group-hover:bg-indigo-500 border-2 border-white transition-colors"></div>

                  <div className="mb-2">
                    <input
                      className="w-full font-bold text-slate-800 text-base bg-transparent border-none focus:ring-0 p-0 placeholder:text-slate-300 topic-title"
                      value={topic.title}
                      onChange={(e) => updateTopic(i, 'title', e.target.value)}
                      onBlur={saveIfEdited}
                      placeholder="議題標題"
                    />
                  </div>

                  <AutoResizeTextarea
                    className="w-full text-slate-600 text-sm leading-7 bg-transparent border-none focus:bg-slate-50 p-2 -ml-2 rounded outline-none whitespace-pre-wrap break-words"
                    value={topic.content}
                    onChange={(e) => updateTopic(i, 'content', e.target.value)}
                    onBlur={saveIfEdited}
                    placeholder={topic.points === undefined ? '議題內容...' : '這個議題走到哪...'}
                  />
                  {/* 舊資料沒有 points：只有上面那段 content，照原本顯示 */}
                  {topic.points !== undefined && topic.points.length > 0 && (
                    <ul className="mt-1 space-y-1.5 topic-points">
                      {topic.points.map((point, j) => (
                        <li key={j} className="flex gap-2 items-start group/point">
                          <span className="text-slate-300 mt-1.5 text-[8px]"><i className="fa-solid fa-circle"></i></span>
                          <AutoResizeTextarea
                            rows={1}
                            className="flex-1 bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-indigo-200 outline-none rounded-sm px-1 py-0.5 whitespace-pre-wrap break-words"
                            value={point.text}
                            onChange={(e) => updateTopicPoint(i, j, e.target.value)}
                            onBlur={saveIfEdited}
                          />
                          <EvidenceTag evidence={point.evidence} />
                          <button onClick={() => removeTopicPoint(i, j)} className="opacity-0 group-hover/point:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all" title="刪除這一點"><i className="fa-solid fa-times text-xs"></i></button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {draft.topics.length === 0 && <p className="text-xs text-slate-400 italic pl-1">本場沒有討論題目</p>}
            </div>
          </section>

          {/* Grid for Decisions & Actions */}
          <div className="grid grid-cols-1 gap-10 border-t border-slate-100 pt-10">
            {/* Decisions */}
            <section>
              <div className="flex justify-between items-center mb-3 border-l-4 border-emerald-500 pl-3">
                 <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">決議</h2>
                 <button onClick={addDecision} className="text-slate-300 hover:text-emerald-600 transition-colors"><i className="fa-solid fa-plus text-xs"></i></button>
              </div>
              <div className="bg-emerald-50/30 rounded-lg p-4 border border-emerald-100/50">
                <ul className="space-y-4">
                  {draft.decisions.map((item, i) => (
                    <li key={i} className="flex gap-3 group items-start">
                      <span className="text-emerald-600 font-bold mt-1.5 text-xs">●</span>
                      <div className="w-full">
                        <AutoResizeTextarea
                          rows={1}
                          className="w-full bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-emerald-200 outline-none rounded-sm px-1 py-0.5 whitespace-pre-wrap break-words"
                          value={item.text}
                          onChange={(e) => updateDecisionText(i, e.target.value)}
                          onBlur={saveIfEdited}
                        />
                        <MetaTags parts={[
                          item.decided_by ? `拍板：${item.decided_by}` : null,
                          formatEvidence(item.evidence),
                        ]} />
                      </div>
                      <button onClick={() => removeDecision(i)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all"><i className="fa-solid fa-times text-xs"></i></button>
                    </li>
                  ))}
                  {draft.decisions.length === 0 && <p className="text-xs text-slate-400 italic pl-1">本場沒有明確決議</p>}
                </ul>
              </div>
            </section>

            {/* Action Items */}
            <section>
              <div className="flex justify-between items-center mb-3 border-l-4 border-blue-500 pl-3">
                 <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">待辦</h2>
                 <button onClick={addActionItem} className="text-slate-300 hover:text-blue-600 transition-colors"><i className="fa-solid fa-plus text-xs"></i></button>
              </div>
              <div className="bg-blue-50/30 rounded-lg p-4 border border-blue-100/50">
                <ul className="space-y-4">
                  {draft.action_items.map((item, i) => (
                    <li key={i} className="flex gap-3 items-start group">
                      <div className="mt-1.5 w-3 h-3 border-2 border-blue-400 rounded-sm shrink-0"></div>
                      <div className="w-full">
                        <AutoResizeTextarea
                          rows={1}
                          className="w-full bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-blue-200 outline-none rounded-sm px-1 py-0.5 font-medium whitespace-pre-wrap break-words"
                          value={item.text}
                          onChange={(e) => updateActionItemText(i, e.target.value)}
                          onBlur={saveIfEdited}
                        />
                        <MetaTags parts={[
                          item.assignee ? `負責人：${item.assignee}` : null,
                          item.due ? `期限：${item.due}` : null,
                          formatEvidence(item.evidence),
                        ]} />
                      </div>
                      <button onClick={() => removeActionItem(i)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all"><i className="fa-solid fa-times text-xs"></i></button>
                    </li>
                  ))}
                   {draft.action_items.length === 0 && <p className="text-xs text-slate-400 italic pl-1">本場沒有待辦</p>}
                </ul>
              </div>
            </section>

            {/* Open Questions */}
            <section>
              <div className="flex justify-between items-center mb-3 border-l-4 border-amber-500 pl-3">
                 <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">未決事項</h2>
                 <button onClick={addOpenQuestion} className="text-slate-300 hover:text-amber-600 transition-colors"><i className="fa-solid fa-plus text-xs"></i></button>
              </div>
              <div className="bg-amber-50/30 rounded-lg p-4 border border-amber-100/50">
                <ul className="space-y-4">
                  {draft.open_questions.map((item, i) => (
                    <li key={i} className="flex gap-3 group items-start">
                      <span className="text-amber-600 font-bold mt-1.5 text-xs">?</span>
                      <div className="w-full">
                        <AutoResizeTextarea
                          rows={1}
                          className="w-full bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-amber-200 outline-none rounded-sm px-1 py-0.5 whitespace-pre-wrap break-words"
                          value={item.text}
                          onChange={(e) => updateOpenQuestionText(i, e.target.value)}
                          onBlur={saveIfEdited}
                        />
                        <MetaTags parts={[formatEvidence(item.evidence)]} />
                      </div>
                      <button onClick={() => removeOpenQuestion(i)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all"><i className="fa-solid fa-times text-xs"></i></button>
                    </li>
                  ))}
                  {draft.open_questions.length === 0 && <p className="text-xs text-slate-400 italic pl-1">本場沒有未決事項</p>}
                </ul>
              </div>
            </section>
          </div>
        </div>

        {/* Document Footer */}
        <div className="bg-slate-50 px-12 py-6 border-t border-slate-100 rounded-b-xl flex justify-between items-center text-[10px] text-slate-400">
           <span>GENERATED BY WHISPERX & GEMINI</span>
           <span>CONFIDENTIAL</span>
        </div>
      </div>
    </div>
  );
};

export default SummaryView;


import React, { useRef, useEffect } from 'react';
import { GeminiOutput, Job } from '../types';
import { exportSummaryAsMarkdown, exportSummaryAsText } from '../services/exportUtils';
import { buildPrintDocument } from '../services/printDocument';

interface SummaryViewProps {
  analysis: GeminiOutput;
  jobMetadata: Job;
  onUpdate: (analysis: GeminiOutput) => void;
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

const SummaryView: React.FC<SummaryViewProps> = ({ analysis, jobMetadata, onUpdate }) => {
  
  const updateField = (field: keyof GeminiOutput, value: any) => {
    onUpdate({ ...analysis, [field]: value });
  };

  const handleListUpdate = (field: 'decisions' | 'action_items', index: number, value: string) => {
    const list = [...analysis[field]];
    list[index] = value;
    updateField(field, list);
  };

  const removeListItem = (field: 'decisions' | 'action_items', index: number) => {
    const list = [...analysis[field]].filter((_, i) => i !== index);
    updateField(field, list);
  };

  const addListItem = (field: 'decisions' | 'action_items') => {
    const list = [...analysis[field]];
    list.push("");
    updateField(field, list);
  };

  const updateTopic = (index: number, key: 'title' | 'content', value: string) => {
    const newTopics = [...analysis.topics];
    newTopics[index] = { ...newTopics[index], [key]: value };
    updateField('topics', newTopics);
  };

  const handlePrint = () => {
    // 開啟新視窗列印，避免 CSS 污染與隱藏問題
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    // 從結構化資料組列印文件，每個值都經過跳脫；不讀畫面 innerHTML
    printWindow.document.write(buildPrintDocument(jobMetadata, analysis));
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
               <h1 className="text-2xl sm:text-3xl font-serif font-bold text-slate-900 mb-2">會議記錄</h1>
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
                    onClick={() => exportSummaryAsMarkdown(jobMetadata.fileName, analysis)}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition-all"
                    title="匯出 Markdown"
                  >
                    <i className="fa-brands fa-markdown text-sm"></i>
                  </button>
                  <div className="w-px bg-slate-200 my-1"></div>
                  <button 
                    onClick={() => exportSummaryAsText(jobMetadata.fileName, analysis)}
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
                value={analysis.overview}
                onChange={(e) => updateField('overview', e.target.value)}
                placeholder="輸入會議主旨..."
              />
           </div>
        </div>

        {/* Document Body */}
        <div className="px-8 sm:px-12 py-8 space-y-12 flex-1">
          
          {/* Topics Section (Structured Minutes) */}
          <section>
            <div className="flex items-center gap-2 mb-6 border-l-4 border-indigo-500 pl-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">議題討論紀錄</h2>
              <span className="bg-indigo-50 text-indigo-600 text-[10px] px-2 py-0.5 rounded-full font-bold">{analysis.topics.length}</span>
            </div>
            
            <div className="space-y-6">
              {analysis.topics.map((topic, i) => (
                <div key={i} className="group relative pl-4 border-l border-slate-200 hover:border-indigo-300 transition-colors topic-item">
                  <div className="absolute -left-1.5 top-0 w-3 h-3 rounded-full bg-slate-200 group-hover:bg-indigo-500 border-2 border-white transition-colors"></div>
                  
                  <div className="mb-2">
                    <input 
                      className="w-full font-bold text-slate-800 text-base bg-transparent border-none focus:ring-0 p-0 placeholder:text-slate-300 topic-title"
                      value={topic.title}
                      onChange={(e) => updateTopic(i, 'title', e.target.value)}
                      placeholder="議題標題"
                    />
                  </div>
                  
                  <AutoResizeTextarea
                    className="w-full text-slate-600 text-sm leading-7 bg-transparent border-none focus:bg-slate-50 p-2 -ml-2 rounded outline-none whitespace-pre-wrap break-words"
                    value={topic.content}
                    onChange={(e) => updateTopic(i, 'content', e.target.value)}
                    placeholder="議題內容..."
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Grid for Decisions & Actions */}
          <div className="grid grid-cols-1 gap-10 border-t border-slate-100 pt-10">
            {/* Decisions */}
            <section>
              <div className="flex justify-between items-center mb-3 border-l-4 border-emerald-500 pl-3">
                 <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">決議事項</h2>
                 <button onClick={() => addListItem('decisions')} className="text-slate-300 hover:text-emerald-600 transition-colors"><i className="fa-solid fa-plus text-xs"></i></button>
              </div>
              <div className="bg-emerald-50/30 rounded-lg p-4 border border-emerald-100/50">
                <ul className="space-y-4">
                  {analysis.decisions.map((item, i) => (
                    <li key={i} className="flex gap-3 group items-start">
                      <span className="text-emerald-600 font-bold mt-1.5 text-xs">●</span>
                      <AutoResizeTextarea
                        rows={1}
                        className="w-full bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-emerald-200 outline-none rounded-sm px-1 py-0.5 whitespace-pre-wrap break-words"
                        value={item}
                        onChange={(e) => handleListUpdate('decisions', i, e.target.value)}
                      />
                      <button onClick={() => removeListItem('decisions', i)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all"><i className="fa-solid fa-times text-xs"></i></button>
                    </li>
                  ))}
                  {analysis.decisions.length === 0 && <p className="text-xs text-slate-400 italic pl-1">無明確決議</p>}
                </ul>
              </div>
            </section>

            {/* Action Items */}
            <section>
              <div className="flex justify-between items-center mb-3 border-l-4 border-blue-500 pl-3">
                 <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">待辦事項</h2>
                 <button onClick={() => addListItem('action_items')} className="text-slate-300 hover:text-blue-600 transition-colors"><i className="fa-solid fa-plus text-xs"></i></button>
              </div>
              <div className="bg-blue-50/30 rounded-lg p-4 border border-blue-100/50">
                <ul className="space-y-4">
                  {analysis.action_items.map((item, i) => (
                    <li key={i} className="flex gap-3 items-start group">
                      <div className="mt-1.5 w-3 h-3 border-2 border-blue-400 rounded-sm shrink-0"></div>
                      <AutoResizeTextarea
                        rows={1}
                        className="w-full bg-transparent text-slate-700 text-sm leading-relaxed border-b border-transparent focus:border-blue-200 outline-none rounded-sm px-1 py-0.5 font-medium whitespace-pre-wrap break-words"
                        value={item}
                        onChange={(e) => handleListUpdate('action_items', i, e.target.value)}
                      />
                      <button onClick={() => removeListItem('action_items', i)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 pt-1 transition-all"><i className="fa-solid fa-times text-xs"></i></button>
                    </li>
                  ))}
                   {analysis.action_items.length === 0 && <p className="text-xs text-slate-400 italic pl-1">無待辦事項</p>}
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

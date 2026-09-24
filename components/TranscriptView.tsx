
import React, { useState, useRef, useEffect } from 'react';
import { TranscriptSegment } from '../types';
import { polishTranscript } from '../services/geminiService';
import { exportTranscriptAsSRT, exportTranscriptAsText, exportPolishedContent } from '../services/exportUtils';
import { splitForHighlight } from '../services/searchHighlight';
import { createDraftSync } from '../services/editSaves';

interface TranscriptViewProps {
  /** 下載檔名的主體（標題或原始檔名，JobDetail 算好傳進來）。這個元件只拿它組匯出檔名 */
  exportBaseName: string;
  segments: TranscriptSegment[];
  polishedContent?: string;
  /** 送出一份完整的段落快照去存。回傳有沒有存進去；沒有的話原因已經由呼叫端講給使用者 */
  onUpdate: (segments: TranscriptSegment[]) => Promise<boolean>;
  /** 存修潤稿，回傳同 onUpdate */
  onSavePolished: (text: string) => Promise<boolean>;
  onAlert: (title: string, message: string) => void;
}

const TranscriptView: React.FC<TranscriptViewProps> = ({ exportBaseName, segments, polishedContent, onUpdate, onSavePolished, onAlert }) => {
  const [viewMode, setViewMode] = useState<'original' | 'polished'>('original');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [showTimestamps, setShowTimestamps] = useState<boolean>(false);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const exportMenuRef = useRef<HTMLDivElement>(null);
  // 畫面上顯示與編輯的是這份草稿，不是 prop。原本每打一個字就用 prop 組整份段落送出，prop 要等存檔
  // 後重拉才會變，受控的 textarea 在那之前被還原成舊值，跟 SummaryView 同一個 bug（細節在 services/editSaves.ts）。
  // 逐字稿這邊每次 PATCH 還會多存一個編輯版本、清掉人名比對結果，一個字一次代價更高
  const [draft, setDraft] = useState<TranscriptSegment[]>(segments);
  const [sync] = useState(createDraftSync);

  // server 的版本只在草稿沒有未送出修改、也沒有存檔在路上時才換上來，理由在 createDraftSync
  useEffect(() => {
    if (sync.canAdoptServer()) setDraft(segments);
  }, [segments, sync]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // 打字只改草稿
  const handleTextChange = (idx: number, newText: string) => {
    const next = [...draft];
    next[idx] = { ...next[idx], text: newText };
    sync.edited();
    setDraft(next);
  };

  // 離開那一段才存：一段編輯一次 PATCH，沒改過就不送
  const finishEditing = async () => {
    setEditingIdx(null);
    if (!sync.hasUnsent()) return;
    sync.saveStarted();
    const saved = await onUpdate(draft);
    sync.saveSettled(saved);
  };

  const handlePolish = async () => {
    setIsPolishing(true);
    try {
      // 修潤讀的是畫面上的草稿：按修潤之前 textarea 已經失焦，改過的段落已經送出去存
      const result = await polishTranscript(draft);
      // 等存完才放掉「修潤中」：修潤稿要等存檔後重拉才出現在 prop，提早放掉的話這段期間畫面又是
      // 「開始修潤」按鈕，再按一次就是再付一次模型費用。沒存進去的話 App 已經講了原因
      await onSavePolished(result);
      setViewMode('polished');
    } catch (e: any) {
      onAlert('修潤失敗', e.message);
    } finally {
      setIsPolishing(false);
    }
  };

  const highlightText = (text: string) => {
    if (!searchTerm.trim()) return text;
    const parts = splitForHighlight(text, searchTerm);
    return (
      <span>
        {parts.map((part, i) =>
          part.match
            ? <mark key={i} className="bg-yellow-200 text-slate-900 rounded-sm px-0.5">{part.text}</mark>
            : part.text
        )}
      </span>
    );
  };

  const handleCopyText = () => {
    let textToCopy = '';
    if (viewMode === 'original') {
      textToCopy = draft.map(s => `[${formatTime(s.start)}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`).join('\n');
    } else {
      textToCopy = polishedContent || '';
    }
    
    if (!textToCopy) return;

    navigator.clipboard.writeText(textToCopy).then(() => {
      onAlert('複製成功', '逐字稿內容已複製到剪貼簿');
    }).catch(err => {
      onAlert('複製失敗', '無法存取剪貼簿');
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-20 pt-6 px-4">
      {/* View Mode Toggle & Actions */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex bg-slate-100 p-1 rounded-lg">
          <button 
            onClick={() => setViewMode('original')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${
              viewMode === 'original' 
                ? 'bg-white text-slate-800 shadow-sm' 
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            原始逐字稿
          </button>
          <button 
             onClick={() => setViewMode('polished')}
             className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${
               viewMode === 'polished' 
                 ? 'bg-white text-indigo-600 shadow-sm' 
                 : 'text-slate-500 hover:text-slate-700'
             }`}
          >
            <i className="fa-solid fa-wand-magic-sparkles text-[10px]"></i>
            AI 智慧修潤
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={handleCopyText}
            className="text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all flex items-center gap-2"
            title="複製純文字內容"
          >
            <i className="fa-regular fa-copy"></i>
            <span className="hidden sm:inline">複製文字</span>
          </button>

          <div className="relative hidden md:block">
            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]"></i>
            <input 
              type="text"
              placeholder="搜尋逐字稿..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-40 bg-white border border-slate-200 rounded-lg py-1.5 pl-8 pr-3 text-[11px] focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-400"
            />
          </div>

          {viewMode === 'original' && (
            <button 
              onClick={() => setShowTimestamps(!showTimestamps)}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all flex items-center gap-2 ${
                showTimestamps 
                  ? 'bg-indigo-50 text-indigo-600 border-indigo-200 shadow-sm' 
                  : 'bg-white text-slate-400 border-slate-200 hover:text-slate-600'
              }`}
            >
              <i className={`fa-solid ${showTimestamps ? 'fa-stopwatch' : 'fa-book-open'}`}></i>
              <span className="hidden sm:inline">{showTimestamps ? '隱藏時間' : '顯示時間'}</span>
            </button>
          )}

          {/* Context Aware Export Menu */}
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold shadow-md shadow-indigo-100 transition-all flex items-center gap-2"
            >
              <i className="fa-solid fa-download"></i>
              匯出
            </button>

            {isExportMenuOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200 origin-top-right">
                <div className="p-1">
                  {viewMode === 'original' ? (
                    <>
                      <div className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        字幕與時間軸
                      </div>
                      <button 
                        onClick={() => { exportTranscriptAsSRT(exportBaseName, draft); setIsExportMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg flex items-center gap-2"
                      >
                        <i className="fa-regular fa-file-video text-slate-400 w-4"></i>
                        SRT 字幕檔 (.srt)
                      </button>
                      <button 
                        onClick={() => { exportTranscriptAsText(exportBaseName, draft, true); setIsExportMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg flex items-center gap-2"
                      >
                         <i className="fa-regular fa-clock text-slate-400 w-4"></i>
                         含時間戳記 (.txt)
                      </button>
                      <div className="my-1 border-t border-slate-100"></div>
                      <button 
                        onClick={() => { exportTranscriptAsText(exportBaseName, draft, false); setIsExportMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg flex items-center gap-2"
                      >
                         <i className="fa-regular fa-file-lines text-slate-400 w-4"></i>
                         純文字內容 (.txt)
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        修潤文章
                      </div>
                      <button 
                        disabled={!polishedContent}
                        onClick={() => { if(polishedContent) exportPolishedContent(exportBaseName, polishedContent); setIsExportMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg flex items-center gap-2 disabled:opacity-50"
                      >
                        <i className="fa-brands fa-markdown text-slate-400 w-4"></i>
                        Markdown 文章 (.md)
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden min-h-[500px]">
        
        {/* Original View */}
        {viewMode === 'original' && (
          <div className="divide-y divide-slate-50">
            {draft.map((seg, idx) => {
              const isSameSpeaker = idx > 0 && draft[idx - 1].speaker === seg.speaker;
              const showSpeaker = !isSameSpeaker || showTimestamps;
              
              return (
                <div 
                  key={idx} 
                  className={`flex group transition-colors hover:bg-slate-50 ${
                    showTimestamps ? 'py-4 px-6 gap-6' : 
                    (isSameSpeaker ? 'pt-1 pb-2 px-8 pl-[5.5rem]' : 'pt-6 pb-2 px-8 pl-8 gap-6')
                  }`}
                >
                  {showTimestamps && (
                    <div className="w-16 shrink-0 pt-1">
                      <span className="text-[10px] font-mono font-bold text-indigo-400 bg-indigo-50 px-2 py-1 rounded">
                        {formatTime(seg.start)}
                      </span>
                    </div>
                  )}

                  <div className="flex-1 relative">
                    {showSpeaker && seg.speaker && (
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="h-6 w-6 rounded-full bg-slate-100 flex items-center justify-center text-[10px] text-slate-500 font-bold">
                          {seg.speaker.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[11px] font-black text-slate-900 uppercase tracking-wider">
                          {seg.speaker}
                        </span>
                      </div>
                    )}
                    
                    {editingIdx === idx ? (
                      <textarea
                        autoFocus
                        className="w-full text-slate-700 leading-relaxed text-base bg-indigo-50 p-2 rounded-lg border border-indigo-200 outline-none resize-none"
                        value={seg.text}
                        onChange={(e) => handleTextChange(idx, e.target.value)}
                        onBlur={finishEditing}
                        rows={Math.max(2, Math.ceil(seg.text.length / 40))}
                      />
                    ) : (
                      <p 
                        onClick={() => setEditingIdx(idx)}
                        className="text-slate-700 leading-8 cursor-text rounded transition-colors text-base"
                      >
                        {highlightText(seg.text)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Polished View */}
        {viewMode === 'polished' && (
          <div className="p-8 sm:p-12">
            {!polishedContent ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
                  <i className="fa-solid fa-wand-magic-sparkles text-2xl text-indigo-500"></i>
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">生成 AI 修潤稿</h3>
                <p className="text-sm text-slate-500 max-w-sm mb-8 leading-relaxed">
                  AI 將閱讀整份逐字稿，修正口語贅字與文法錯誤，並整理成通順的訪談文章或劇本格式。
                </p>
                <button
                  onClick={handlePolish}
                  disabled={isPolishing}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-200 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPolishing ? (
                    <><i className="fa-solid fa-circle-notch fa-spin"></i> 正在修潤中...</>
                  ) : (
                    <><i className="fa-solid fa-pen-nib"></i> 開始修潤</>
                  )}
                </button>
              </div>
            ) : (
              <div className="prose prose-slate max-w-none prose-p:leading-relaxed prose-headings:font-bold prose-headings:text-slate-800">
                <div className="whitespace-pre-wrap font-serif text-lg text-slate-700 leading-8">
                  {polishedContent}
                </div>
                <div className="mt-12 pt-6 border-t border-slate-100 flex justify-end">
                   <button 
                     onClick={handlePolish}
                     disabled={isPolishing}
                     className="text-xs font-bold text-indigo-600 hover:bg-indigo-50 px-3 py-2 rounded transition-colors flex items-center gap-2"
                   >
                     <i className={`fa-solid fa-rotate ${isPolishing ? 'fa-spin' : ''}`}></i> 重新生成
                   </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TranscriptView;

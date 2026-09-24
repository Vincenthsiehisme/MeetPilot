
import React, { useEffect, useState } from 'react';
import { Job, JobStatus, StepStatus } from '../types';
import TranscriptView from './TranscriptView';
import SummaryView from './SummaryView';
import NameReviewPanel from './NameReviewPanel';
import { exportJobAsJSON, exportErrorAsJSON } from '../services/exportUtils';
import { MEETING_TITLE_MAX_LENGTH, checkMeetingTitle, jobDisplayName, jobDownloadBaseName } from '../services/meetingTitle';
import { NameMentionView, PersonSummary } from '../services/meetingApi';
import { isDesktopApp } from '../services/micRecorder';

interface JobDetailProps {
  job: Job;
  /** 回傳這次有沒有存進去（沒有的話原因已經講給使用者了）。SummaryView、TranscriptView 靠它決定草稿要不要留著 */
  onUpdateJob: (updates: Partial<Job>) => Promise<boolean>;
  onAlert: (title: string, message: string) => void;
  onRetry?: (id: string) => void;
  /** 這場會的與會者（人名校正 N2）。本機舊紀錄沒有這個概念，傳空陣列 */
  participants?: PersonSummary[];
  /** 還沒確認的人名（人名校正 N4／N5）。本機舊紀錄沒有這個概念，傳空陣列 */
  nameMentions?: NameMentionView[];
  onConfirmNameMention?: (segmentIndex: number, originalText: string, employeeId: string) => void | Promise<void>;
}

const JobDetail: React.FC<JobDetailProps> = ({
  job, onUpdateJob, onAlert, onRetry, participants = [], nameMentions = [], onConfirmNameMention,
}) => {
  const [activeTab, setActiveTab] = useState<'status' | 'transcript' | 'summary'>('status');
  // null 是「沒在編輯標題」；編輯中是輸入框裡的草稿
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  // 換會議時把草稿與分頁都重置：這個元件實例不會因為切換選中對象而重新掛載（沒有 key）。
  // 草稿不清的話，會議 A 編輯到一半沒存就切去 B，按儲存會把 A 的草稿寫成 B 的標題
  // （2026-09-20 Codex review 抓到）；分頁不清的話，在會議 A 停在「AI 會議記錄」分頁時切去
  // 還沒有 analysis 的會議 B，三個分頁的顯示條件全部對不上 activeTab，內容區會整個變空白，
  // 分頁列也因為 disabled 蓋掉了 active 樣式而看不出選到哪個。「任務進度」永遠有內容可顯示，
  // 是唯一安全的重置目標
  useEffect(() => {
    setTitleDraft(null);
    setActiveTab('status');
  }, [job.id]);

  const saveTitle = () => {
    const check = checkMeetingTitle(titleDraft);
    // 明寫 === false：tsconfig 沒開 strict，!check.ok 收斂不到 reason 那一側（AGENTS.md〈gate 守不到哪裡〉）
    if (check.ok === false) {
      onAlert('標題不能用', check.reason);
      return;
    }
    setTitleDraft(null);
    if (check.title !== job.title) onUpdateJob({ title: check.title });
  };

  const getStepIcon = (status: StepStatus) => {
    switch (status) {
      case StepStatus.IDLE: return <i className="fa-regular fa-circle text-slate-200"></i>;
      case StepStatus.PROCESSING: return <i className="fa-solid fa-circle-notch fa-spin text-indigo-500"></i>;
      case StepStatus.SUCCESS: return <i className="fa-solid fa-circle-check text-emerald-500"></i>;
      case StepStatus.ERROR: return <i className="fa-solid fa-circle-xmark text-rose-500"></i>;
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex border-b border-slate-100 bg-white shrink-0 overflow-x-auto items-center justify-between pr-4">
        <div className="flex">
          <TabButton active={activeTab === 'status'} onClick={() => setActiveTab('status')} label="任務進度" />
          <TabButton active={activeTab === 'transcript'} onClick={() => setActiveTab('transcript')} label="完整逐字稿" count={job.transcript?.length} disabled={!job.transcript} />
          <TabButton active={activeTab === 'summary'} onClick={() => setActiveTab('summary')} label="AI 會議記錄" disabled={!job.analysis} />
        </div>

        <div className="flex items-center gap-3 py-2">
          {job.status === JobStatus.FAILED && (
             <button 
               onClick={() => exportErrorAsJSON(job)}
               className="text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded text-xs font-bold flex items-center gap-2"
             >
               <i className="fa-solid fa-bug"></i> 診斷
             </button>
          )}

          <div className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider hidden sm:block ${
            job.status === JobStatus.COMPLETED ? 'bg-emerald-50 text-emerald-600' :
            job.status === JobStatus.FAILED ? 'bg-rose-50 text-rose-600' :
            job.status === JobStatus.RUNNING ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'
          }`.trim().concat(' ')}>
             {job.status === JobStatus.RUNNING ? '處理中' : 
              job.status === JobStatus.COMPLETED ? '已完成' : 
              job.status === JobStatus.FAILED ? '失敗' : '等待'}
          </div>
        </div>
      </div>

      <div className="flex-1 relative overflow-y-auto bg-slate-50/30">
        {activeTab === 'status' && (
          <div className="max-w-xl mx-auto space-y-8 py-12 px-6 pb-24">
            <div className="text-center mb-8">
              {titleDraft === null ? (
                <div className="flex items-center justify-center gap-2">
                  <h2 className="text-lg font-bold text-slate-800 break-words">{jobDisplayName(job)}</h2>
                  <button
                    type="button"
                    onClick={() => setTitleDraft(job.title ?? '')}
                    className="text-slate-300 hover:text-indigo-600 transition-colors p-1"
                    title="改標題"
                  >
                    <i className="fa-solid fa-pen text-xs"></i>
                  </button>
                </div>
              ) : (
                <form
                  className="flex items-center justify-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); saveTitle(); }}
                >
                  <input
                    autoFocus
                    value={titleDraft}
                    maxLength={MEETING_TITLE_MAX_LENGTH}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setTitleDraft(null); }}
                    placeholder="這場會叫什麼"
                    className="flex-1 max-w-sm border border-indigo-300 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                  <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg">
                    儲存
                  </button>
                  <button type="button" onClick={() => setTitleDraft(null)} className="text-slate-500 hover:text-slate-700 text-xs font-bold px-2 py-1.5">
                    取消
                  </button>
                </form>
              )}
              {job.title !== undefined && (
                <p className="text-xs text-slate-400 mt-1">來源檔案：{job.fileName}</p>
              )}
              <p className="text-xs text-slate-400 mt-1">建立於 {new Date(job.createdAt).toLocaleString()}</p>
            </div>

            {job.status === JobStatus.FAILED && (
              <div className="bg-rose-50 border border-rose-100 p-6 rounded-2xl flex gap-4 items-start shadow-sm animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="bg-rose-500 text-white p-2 rounded-full text-xs shrink-0">
                  <i className="fa-solid fa-triangle-exclamation"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-rose-900 font-bold text-sm mb-1">任務處理中斷</h4>
                  <p className="text-rose-600 text-xs leading-relaxed mb-3">{job.error || '發生未知錯誤，請檢查網路連線或金鑰權限。'}</p>
                  {onRetry && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-3.5 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                    >
                      <i className="fa-solid fa-rotate-right"></i>
                      重新處理此任務
                    </button>
                  )}
                </div>
              </div>
            )}

            {job.status === JobStatus.RUNNING && job.etaSeconds && job.etaSeconds > 0 && (
              <div className="bg-indigo-900 text-white p-4 rounded-xl shadow-lg flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">AI 預估剩餘時間</p>
                  <p className="text-xl font-bold">{Math.floor(job.etaSeconds / 60)} 分 {job.etaSeconds % 60} 秒</p>
                </div>
                <div className="text-4xl opacity-20"><i className="fa-solid fa-hourglass-half animate-pulse"></i></div>
              </div>
            )}

            <div className="relative">
              <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-slate-100"></div>
              <div className="space-y-10 relative">
                {job.steps.map((step, idx) => (
                  <div key={idx} className="flex gap-6 items-start">
                    <div className="z-10 bg-white rounded-full p-1 border border-slate-100">
                      {getStepIcon(step.status)}
                    </div>
                    <div className="flex-1 pt-0.5">
                      <p className={`text-sm font-bold ${
                        step.status === StepStatus.IDLE ? 'text-slate-300' : 
                        step.status === StepStatus.ERROR ? 'text-rose-600' : 'text-slate-700'
                      }`}>
                        {step.name}
                      </p>
                      {step.status === StepStatus.PROCESSING && (
                        <div className="mt-3">
                          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                            <div className="h-full bg-indigo-500 animate-[shimmer_1.5s_infinite] origin-left"></div>
                          </div>
                          <p className="text-[10px] text-slate-400 mt-2 font-medium flex items-center gap-1">
                            <i className="fa-solid fa-bolt-lightning animate-pulse"></i>
                            {/* 處理從 W2 起全在 server 跑、語音備忘錄的錄音在語音備忘錄裡，這兩種不需要這個分頁開著。
                                app 內錄音（E4）是這個視窗自己在錄：關視窗只是縮到系統匣，重新整理或結束 MeetPilot 就會中斷 */}
                            {job.recordingMethod === 'in_app'
                              ? isDesktopApp()
                                ? 'MeetPilot 正在用麥克風錄音，按「停止錄音」後自動送進轉錄。關掉視窗會縮到系統匣繼續錄；結束 MeetPilot 或重新整理會中斷'
                                : '這個分頁正在用麥克風錄音，按「停止錄音」後自動送進轉錄。關掉分頁或重新整理會中斷'
                              : job.recordingStartedAt !== undefined
                                ? '語音備忘錄錄音中，按「停止錄音」後自動取回檔案開始轉錄。這個分頁可以關掉，錄音不會中斷'
                                : '伺服器正在處理，這個分頁可以關掉，處理不會中斷'}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {nameMentions.length > 0 && onConfirmNameMention && (
              <NameReviewPanel
                participants={participants}
                nameMentions={nameMentions}
                onConfirm={onConfirmNameMention}
              />
            )}

            {/* Data Management Section */}
            {(job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) && (
              <div className="pt-12 mt-12 border-t border-slate-200">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">資料管理</h3>
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-slate-700">原始任務數據 (.json)</h4>
                    <p className="text-[10px] text-slate-400 mt-1">
                      下載包含逐字稿、分析結果與除錯資訊的完整備份。
                    </p>
                  </div>
                  <button 
                    onClick={() => exportJobAsJSON(job)}
                    className="text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 px-3 py-2 rounded-lg transition-all text-xs font-bold"
                  >
                    <i className="fa-solid fa-download mr-1"></i>
                    下載備份
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* key：理由同下面的 SummaryView */}
        {activeTab === 'transcript' && job.transcript && (
          <TranscriptView
            key={job.id}
            exportBaseName={jobDownloadBaseName(job)}
            segments={job.transcript}
            polishedContent={job.polishedContent}
            onUpdate={(segments) => onUpdateJob({ transcript: segments })}
            onSavePolished={(text) => onUpdateJob({ polishedContent: text })}
            onAlert={onAlert}
          />
        )}
        
        {/* key：草稿是一場會一份，換會議一定重新掛載，不讓上一場沒送出的草稿留到下一場 */}
        {activeTab === 'summary' && job.analysis && (
          <SummaryView
            key={job.id}
            analysis={job.analysis}
            jobMetadata={job} 
            onUpdate={(analysis) => onUpdateJob({ analysis })}
          />
        )}
      </div>
      
      <style>{`
        @keyframes shimmer {
          0% { transform: scaleX(0.1); opacity: 0.3; }
          50% { transform: scaleX(0.8); opacity: 1; }
          100% { transform: scaleX(1); opacity: 0; }
        }
      `}</style>
    </div>
  );
};

const TabButton: React.FC<{active: boolean, onClick: () => void, label: string, disabled?: boolean, count?: number, icon?: string}> = ({ active, onClick, label, disabled, count, icon }) => (
  <button
    disabled={disabled}
    onClick={onClick}
    className={`px-6 py-4 text-[11px] font-bold uppercase tracking-[0.1em] border-b-2 transition-all whitespace-nowrap flex items-center gap-2 ${
      disabled ? 'opacity-30 cursor-not-allowed border-transparent' :
      active ? 'border-indigo-600 text-indigo-600 bg-white' : 'border-transparent text-slate-400 hover:text-slate-600'
    }`}
  >
    {icon && <i className={`fa-solid ${icon}`}></i>}
    {label} 
    {count !== undefined && <span className="opacity-50">({count})</span>}
  </button>
);

export default JobDetail;

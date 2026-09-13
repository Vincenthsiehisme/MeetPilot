
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Job, JobStatus, StepStatus, TranscriptSegment, GeminiOutput, SubAgentType } from './types';
import JobDashboard from './components/JobDashboard';
import JobDetail from './components/JobDetail';
import FileUpload from './components/FileUpload';
import ConfirmModal from './components/ConfirmModal';
import { transcribeSlice, analyzeTranscript } from './services/geminiService';
import { generateAudioSlices, getAudioDuration } from './services/audioService';
import { mergeSliceTranscript } from './services/transcriptMerge';
import { 
  saveJobToDB, 
  getAllJobsFromDB, 
  saveFileBlob, 
  getFileBlob, 
  deleteFileBlob, 
  deleteJobFromDB,
  getAllFileIds
} from './services/storageService';

const STALE_JOB_THRESHOLD = 5 * 60 * 1000;
const SLICE_OVERLAP_SECONDS = 15; // generateAudioSlices 與 mergeSliceTranscript 必須用同一個值

const translateError = (error: string) => {
  const e = (error || '').toLowerCase();
  if (e.includes('api_key') || e.includes('gemini_api_key')) {
    return '【系統提示】尚未偵測到 Gemini API 金鑰，請確認環境設定。';
  }
  if (e.includes('403') || e.includes('permission_denied') || e.includes('permission') || e.includes('unregistered callers')) {
    return '【金鑰權限錯誤】Gemini API 金鑰權限不足 (PERMISSION_DENIED)。請前往 Google AI Studio 確認專案權限或重新綁定 API 金鑰。';
  }
  if (e.includes('prepayment') || e.includes('credits are depleted')) {
    return '【額度用罄】Gemini API 預付額度已耗盡 (Prepayment credits depleted)。請至 Google AI Studio (ai.studio/projects) 儲值或調整專案計費設定。';
  }
  if (e.includes('429') || e.includes('resource_exhausted')) {
    return '【AI 額度上限】目前的處理量已達 AI 限制或用量配額上限，請稍候再重試。';
  }
  if (e.includes('503') || e.includes('unavailable') || e.includes('high demand') || e.includes('overloaded')) {
    return '【AI 服務繁忙】模型目前需求量極大 (503 High Demand)。系統已嘗試自動切換模型，請稍候重試。';
  }
  if (e.includes('developer instruction is not enabled')) {
    return '【模型指令錯誤】使用的模型不支援開發者指令，已修正為通用多模態模型。請點擊重試。';
  }
  if (e.includes('unexpected token') || e.includes('<!doctype') || e.includes('is not valid json') || e.includes('網頁內容') || e.includes('html')) {
    return '【連線異常】伺服器回應了非預期的網頁格式，可能連線短暫中斷或正在重啟，請點擊重試。';
  }
  if (e.includes('decode') || e.includes('解碼')) {
    return '【媒體格式錯誤】瀏覽器無法解碼。若是大型 MOV 影片或 iPhone M4A 錄音，請嘗試轉檔 (如轉為 MP3) 後再上傳。';
  }
  return `【處理失敗】${error}`;
};

const App: React.FC = () => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive?: boolean;
    hideCancel?: boolean;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    isDestructive: true,
    hideCancel: false
  });
  const isProcessingRef = useRef<boolean>(false);
  // jobs 的同步鏡像：持久化要在 setJobs updater 外面算出新 job，所以所有 jobs 變更都走 commitJobs，
  // 讓 ref 與 state 同步，之後才能拿最新的 job 出來 await 寫入。
  const jobsRef = useRef<Job[]>([]);

  const commitJobs = useCallback((updater: (prev: Job[]) => Job[]) => {
    const next = updater(jobsRef.current);
    jobsRef.current = next;
    setJobs(next);
  }, []);

  // 初始化與清理孤立檔案
  useEffect(() => {
    const initialize = async () => {
      let loadedJobs = await getAllJobsFromDB();
      const now = Date.now();
      let hasUpdates = false;

      // 1. 處理中斷的任務（逾時標記回 Pending）
      loadedJobs = loadedJobs.map(job => {
        if (job.status === JobStatus.RUNNING && (now - job.updatedAt > STALE_JOB_THRESHOLD)) {
          hasUpdates = true;
          return { ...job, status: JobStatus.PENDING, updatedAt: now };
        }
        return job;
      });

      if (hasUpdates) {
        for (const job of loadedJobs.filter(j => j.status === JobStatus.PENDING)) {
          await saveJobToDB(job);
        }
      }

      // 2. 清理孤立檔案
      const fileIds = await getAllFileIds();
      const jobIds = new Set(loadedJobs.map(j => j.id));
      for (const fId of fileIds) {
        if (!jobIds.has(fId)) {
          await deleteFileBlob(fId);
        }
      }

      const sorted = loadedJobs.sort((a, b) => b.createdAt - a.createdAt);
      commitJobs(() => sorted);
      if (sorted.length > 0 && !activeJobId) setActiveJobId(sorted[0].id);
    };
    initialize();
  }, []);

  const updateJobInStateAndDB = useCallback(async (jobId: string, updates: Partial<Job>) => {
    const current = jobsRef.current.find(j => j.id === jobId);
    if (!current) return;
    const updated: Job = { ...current, ...updates, updatedAt: Date.now() };
    commitJobs(prev => prev.map(j => (j.id === jobId ? updated : j)));
    await saveJobToDB(updated);
  }, [commitJobs]);

  const updateJobStep = useCallback(async (jobId: string, stepIdx: number, status: StepStatus, customData?: any) => {
    const current = jobsRef.current.find(j => j.id === jobId);
    if (!current) return;
    const newSteps = [...current.steps];
    newSteps[stepIdx] = { ...newSteps[stepIdx], status, ...customData };
    const updated: Job = { ...current, steps: newSteps, ...customData, updatedAt: Date.now() };
    commitJobs(prev => prev.map(j => (j.id === jobId ? updated : j)));
    await saveJobToDB(updated);
  }, [commitJobs]);

  const addJob = async (file: File) => {
    const now = Date.now();
    const jobId = `job_${now}`;
    const newJob: Job = {
      id: jobId,
      fileName: file.name,
      fileSize: file.size,
      createdAt: now,
      updatedAt: now,
      status: JobStatus.PENDING,
      currentStep: 0,
      processedSlices: 0,
      steps: [
        { name: '音訊預處理與降噪', status: StepStatus.IDLE },
        { name: 'AI 語音轉錄 (Smart Verbatim)', status: StepStatus.IDLE },
        { name: 'Gemini 中文分析摘要', status: StepStatus.IDLE }
      ]
    };
    await saveFileBlob(jobId, file);
    await saveJobToDB(newJob);
    commitJobs(prev => [newJob, ...prev]);
    setActiveJobId(jobId);
    if (!isSidebarOpen) setIsSidebarOpen(true); // 自動展開側邊欄以便查看新任務
  };

  const processJob = useCallback(async (job: Job) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    const { id } = job;
    
    try {
      const blob = await getFileBlob(id);
      if (!blob) throw new Error("音檔資源遺失或已被清理");
      const file = new File([blob], job.fileName);

      await updateJobStep(id, 0, StepStatus.PROCESSING, { status: JobStatus.RUNNING, currentStep: 0 });
      
      let duration = 0;
      try {
        duration = await getAudioDuration(file);
      } catch (e) {
        console.warn("無法取得音訊時長", e);
      }
      
      const sliceDurationMin = 10;
      // metadata duration 可能是 Infinity/NaN（見 services/audioDuration.ts），不能拿去除；那時先當 1 片，進度文字用 Math.max 撐著
      const expectedSlices = Number.isFinite(duration) && duration > 0 ? Math.ceil(duration / (sliceDurationMin * 60)) : 1;
      
      const sliceGenerator = generateAudioSlices(file, sliceDurationMin, SLICE_OVERLAP_SECONDS);
      
      await updateJobStep(id, 0, StepStatus.SUCCESS, { 
        totalSlices: expectedSlices,
        currentStep: 1
      });

      let fullTranscript: TranscriptSegment[] = job.transcript || [];
      
      for await (const slice of sliceGenerator) {
        const currentJobs = await getAllJobsFromDB();
        if (!currentJobs.find(j => j.id === id)) return;

        if (slice.index < (job.processedSlices || 0)) continue;

        await updateJobStep(id, 1, StepStatus.PROCESSING, {
          steps: [
            { name: `音訊預處理完成`, status: StepStatus.SUCCESS },
            { name: `正在轉錄片段 ${slice.index + 1}/${Math.max(slice.index + 1, expectedSlices)}...`, status: StepStatus.PROCESSING },
            { name: 'Gemini 中文分析摘要', status: StepStatus.IDLE }
          ]
        });

        // 提取上下文：從目前的 fullTranscript 中取出最後 1000 個字
        // 這有助於 AI 在處理切片開頭時，知道誰在說話以及語氣連貫性
        let contextText = "";
        if (fullTranscript.length > 0) {
          const contextSegments = fullTranscript.slice(-10); // 取最後 10 句
          contextText = contextSegments.map(s => `${s.speaker || 'Unknown'}: ${s.text}`).join('\n').slice(-1000);
        }

        const sliceTranscript = await transcribeSlice(slice.data, slice.startTime, contextText, slice.mimeType || 'audio/wav');
        
        // 智慧接合：以既有逐字稿已涵蓋到的時間為準去掉 overlap 重複（規則見 transcriptMerge.ts）
        fullTranscript = mergeSliceTranscript(fullTranscript, sliceTranscript, slice.startTime, slice.index === 0, 0.5, SLICE_OVERLAP_SECONDS);

        await updateJobInStateAndDB(id, { 
          transcript: fullTranscript,
          processedSlices: slice.index + 1
        });
      }

      await updateJobStep(id, 1, StepStatus.SUCCESS, { 
        currentStep: 2,
        steps: [
          { name: `音訊預處理完成`, status: StepStatus.SUCCESS },
          { name: `轉錄已完成 (${expectedSlices} 個片段)`, status: StepStatus.SUCCESS },
          { name: '正在生成中文摘要與行動建議...', status: StepStatus.PROCESSING }
        ]
      });

      const analysis = await analyzeTranscript(
        fullTranscript, 
        job.meetingTags || [], 
        job.meetingContext || ""
      );
      await updateJobStep(id, 2, StepStatus.SUCCESS, { 
        analysis, 
        status: JobStatus.COMPLETED,
        steps: [
          { name: `音訊預處理完成`, status: StepStatus.SUCCESS },
          { name: `轉錄已完成`, status: StepStatus.SUCCESS },
          { name: '中文分析報告已產出', status: StepStatus.SUCCESS }
        ]
      });

      await deleteFileBlob(id);

    } catch (err: any) {
      console.error("Job Failed:", err);
      await updateJobInStateAndDB(id, { 
        status: JobStatus.FAILED, 
        error: translateError(err.message)
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [updateJobStep, updateJobInStateAndDB]);

  // 單併發控制
  useEffect(() => {
    if (isProcessingRef.current) return;
    
    const runningJob = jobs.find(j => j.status === JobStatus.RUNNING);
    if (runningJob) {
      processJob(runningJob);
      return;
    }

    const pendingJobs = jobs.filter(j => j.status === JobStatus.PENDING).sort((a, b) => a.createdAt - b.createdAt);
    if (pendingJobs.length > 0) {
      processJob(pendingJobs[0]);
    }
  }, [jobs, processJob]);

  const activeJob = jobs.find(j => j.id === activeJobId);

  const handleDeleteJob = (id: string) => {
    setConfirmConfig({
      isOpen: true,
      title: '刪除任務',
      message: '確定要永久刪除此任務與相關檔案嗎？此操作無法復原。',
      onConfirm: async () => {
        await deleteJobFromDB(id);
        await deleteFileBlob(id);
        commitJobs(prev => prev.filter(j => j.id !== id));
        if (activeJobId === id) setActiveJobId(null);
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
      }
    });
  };

  const showAlert = (title: string, message: string) => {
    setConfirmConfig({
      isOpen: true,
      title,
      message,
      onConfirm: () => setConfirmConfig(prev => ({ ...prev, isOpen: false })),
      hideCancel: true,
      isDestructive: false
    });
  };

  const handleClearAllFinished = () => {
    const finishedIds = jobs
      .filter(j => j.status === JobStatus.COMPLETED || j.status === JobStatus.FAILED)
      .map(j => j.id);
    
    if (finishedIds.length === 0) return;

    setConfirmConfig({
      isOpen: true,
      title: '清除完成任務',
      message: `確定要清除這 ${finishedIds.length} 個已完成或失敗的任務紀錄嗎？`,
      onConfirm: async () => {
        for (const id of finishedIds) {
          await deleteJobFromDB(id);
          await deleteFileBlob(id);
        }
        commitJobs(prev => prev.filter(j => !finishedIds.includes(j.id)));
        if (activeJobId && finishedIds.includes(activeJobId)) setActiveJobId(null);
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
      }
    });
  };

  return (
    <div className="h-screen bg-slate-50 flex flex-col antialiased overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between sticky top-0 z-30 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-9 h-9 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-indigo-600 flex items-center justify-center transition-colors"
            title={isSidebarOpen ? "收合側邊欄" : "展開側邊欄"}
          >
             <i className={`fa-solid ${isSidebarOpen ? 'fa-chevron-left' : 'fa-bars'} text-sm`}></i>
          </button>
          
          <div className="flex items-center gap-2 select-none">
            <div className="bg-indigo-600 text-white w-8 h-8 rounded-lg flex items-center justify-center shadow-md shadow-indigo-100">
              <i className="fa-solid fa-microphone-lines text-sm"></i>
            </div>
            <span className="text-sm font-bold text-slate-900 hidden sm:inline">WhisperX & Gemini Hub</span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <FileUpload onFileSelect={addJob} />
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        <aside
          className={`
            bg-white border-r border-slate-200 h-full relative z-20
            transition-all duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]
            ${isSidebarOpen ? 'w-80 opacity-100' : 'w-0 opacity-0 overflow-hidden'}
          `}
        >
          <div className="w-80 h-full flex flex-col">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-bold text-slate-800">最近紀錄</h2>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"
                title="收合側邊欄"
              >
                <i className="fa-solid fa-chevron-left"></i>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <JobDashboard 
                jobs={jobs} 
                activeJobId={activeJobId} 
                onSelectJob={(id) => {
                  setActiveJobId(id);
                }}
                onDeleteJob={handleDeleteJob}
                onRetry={(id) => updateJobInStateAndDB(id, { status: JobStatus.PENDING, error: undefined })}
                onClearAllFinished={handleClearAllFinished}
              />
            </div>
          </div>
        </aside>

        <main className="flex-1 min-w-0 flex flex-col h-full bg-slate-50 relative">
          <div className="flex-1 p-0 sm:p-4 h-full overflow-hidden flex flex-col">
            <div className="w-full flex-1 bg-white sm:rounded-2xl border-x sm:border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              {activeJob ? (
                <div className="flex-1 overflow-y-auto">
                  <JobDetail 
                    job={activeJob} 
                    onUpdateJob={(updates) => updateJobInStateAndDB(activeJob.id, updates)}
                    onAlert={showAlert}
                    onRetry={(id) => updateJobInStateAndDB(id, { status: JobStatus.PENDING, error: undefined })}
                  />
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50">
                  <div className="w-20 h-20 bg-indigo-100 text-indigo-600 rounded-3xl flex items-center justify-center mb-6 shadow-sm">
                    <i className="fa-solid fa-microphone-lines text-3xl"></i>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800 mb-2 tracking-tight">準備就緒</h2>
                  <p className="text-slate-500 max-w-sm mb-8 leading-relaxed text-sm">
                    請從上方按鈕開始「建立新任務」來處理您的語音內容。
                  </p>
                  <div className="flex gap-4 items-center">
                    <FileUpload onFileSelect={addJob} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <ConfirmModal
        isOpen={confirmConfig.isOpen}
        title={confirmConfig.title}
        message={confirmConfig.message}
        onConfirm={confirmConfig.onConfirm}
        isDestructive={confirmConfig.isDestructive}
        hideCancel={confirmConfig.hideCancel}
        onCancel={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
};

export default App;

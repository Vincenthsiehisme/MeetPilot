
import React from 'react';
import { Job, JobStatus } from '../types';

interface JobDashboardProps {
  jobs: Job[];
  activeJobId: string | null;
  onSelectJob: (id: string) => void;
  onDeleteJob: (id: string) => void;
  onRetry: (id: string) => void;
  onClearAllFinished: () => void;
}

const JobDashboard: React.FC<JobDashboardProps> = ({ 
  jobs, activeJobId, onSelectJob, onDeleteJob, onRetry, onClearAllFinished 
}) => {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<JobStatus | 'ALL'>('ALL');

  const getStatusConfig = (status: JobStatus) => {
    switch (status) {
      case JobStatus.PENDING: return { color: 'text-slate-400', label: '等待中' };
      case JobStatus.RUNNING: return { color: 'text-indigo-600', label: '處理中' };
      case JobStatus.COMPLETED: return { color: 'text-emerald-600', label: '已完成' };
      case JobStatus.FAILED: return { color: 'text-rose-600', label: '失敗' };
      default: return { color: 'text-slate-400', label: '未知狀態' };
    }
  };

  const formatETA = (seconds: number) => {
    if (seconds <= 0) return '即將完成';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `約剩 ${m} 分 ${s} 秒`;
  };

  const hasFinishedJobs = jobs.some(j => j.status === JobStatus.COMPLETED || j.status === JobStatus.FAILED);

  const filteredJobs = jobs.filter(job => {
    const matchesSearch = job.fileName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterStatus === 'ALL' || job.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <div className="flex justify-between items-center shrink-0 pl-1 h-8">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <i className="fa-solid fa-list-check"></i>
          任務列表 ({jobs.length})
        </h3>
        {hasFinishedJobs && (
          <button 
            onClick={onClearAllFinished}
            className="text-[10px] font-bold text-rose-400 hover:text-rose-600 transition-colors uppercase tracking-tight px-2 py-1 hover:bg-rose-50 rounded"
            title="清除所有已完成紀錄"
          >
            清除完成
          </button>
        )}
      </div>

      <div className="shrink-0 flex flex-col gap-2 px-1">
        <div className="relative">
          <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]"></i>
          <input 
            type="text"
            placeholder="搜尋任務名稱..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 border-none rounded-lg py-2 pl-8 pr-3 text-xs focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-400"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
          {(['ALL', JobStatus.RUNNING, JobStatus.COMPLETED, JobStatus.FAILED] as const).map(status => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              className={`whitespace-nowrap px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                filterStatus === status 
                  ? 'bg-indigo-600 text-white shadow-sm' 
                  : 'bg-white text-slate-500 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              {status === 'ALL' ? '全部' : getStatusConfig(status as JobStatus).label}
            </button>
          ))}
        </div>
      </div>
      
      <div className="flex-1 flex flex-col gap-3 overflow-y-auto pr-2 pb-4 scrollbar-thin scrollbar-thumb-slate-200">
        {filteredJobs.length === 0 ? (
          <div className="py-20 text-center flex flex-col items-center">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-300">
              <i className={`fa-solid ${searchQuery ? 'fa-magnifying-glass' : 'fa-inbox'} text-2xl`}></i>
            </div>
            <p className="text-xs text-slate-400 font-medium">
              {searchQuery ? '找不到符合的任務' : '目前沒有任務，開始建立一個吧！'}
            </p>
          </div>
        ) : (
          filteredJobs.map(job => {
            const config = getStatusConfig(job.status);
            const isActive = activeJobId === job.id;
            const progress = job.totalSlices ? Math.round(((job.processedSlices || 0) / job.totalSlices) * 100) : 0;

            return (
              <div
                key={job.id}
                onClick={() => onSelectJob(job.id)}
                className={`group p-3.5 rounded-xl border transition-all cursor-pointer relative overflow-hidden select-none ${
                  isActive ? 'border-indigo-600 bg-white shadow-md ring-1 ring-indigo-600 ring-opacity-10' : 'border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm'
                }`}
              >
                {job.status === JobStatus.RUNNING && (
                  <div 
                    className="absolute bottom-0 left-0 h-0.5 bg-indigo-500 transition-all duration-500" 
                    style={{ width: `${progress}%` }}
                  />
                )}
                
                <div className="mb-2">
                  <div className="flex justify-between items-start gap-2">
                    <h4 className={`font-bold text-sm truncate flex-1 ${isActive ? 'text-indigo-900' : 'text-slate-700'}`}>{job.fileName}</h4>
                    <button 
                      onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id); }}
                      className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 transition-all p-0.5"
                      title="刪除任務"
                    >
                      <i className="fa-solid fa-trash-can text-xs"></i>
                    </button>
                  </div>
                  <div className="flex justify-between items-center mt-1.5">
                    <span className="text-[10px] text-slate-400 font-medium flex items-center gap-1">
                      <i className="fa-regular fa-clock text-[9px]"></i>
                      {new Date(job.createdAt).toLocaleDateString()}
                    </span>
                    {job.status === JobStatus.RUNNING && (
                       <div className="text-right flex flex-col items-end">
                         <span className="text-[10px] font-mono text-indigo-600 font-bold">{progress}%</span>
                         {job.etaSeconds ? (
                           <span className="text-[9px] text-slate-400 font-medium scale-90 origin-right">{formatETA(job.etaSeconds)}</span>
                         ) : null}
                       </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-50">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      job.status === JobStatus.COMPLETED ? 'bg-emerald-500' :
                      job.status === JobStatus.RUNNING ? 'bg-indigo-500 animate-pulse' :
                      job.status === JobStatus.FAILED ? 'bg-rose-500' : 'bg-slate-300'
                    }`}></span>
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${config.color}`}>
                      {config.label}
                    </span>
                  </div>
                  
                  {job.status === JobStatus.FAILED && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); onRetry(job.id); }}
                      className="text-[10px] bg-rose-50 text-rose-600 hover:bg-rose-100 px-2 py-0.5 rounded font-bold transition-colors"
                    >
                      重試
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default JobDashboard;

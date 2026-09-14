
export enum JobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export enum StepStatus {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface GeminiOutput {
  overview: string; // 會議主旨/一句話摘要
  topics: {
    title: string;
    content: string;
  }[];
  decisions: string[];
  action_items: string[];
  // risk 與 open_questions 已移除，移至 Chat 功能
}

export interface Job {
  id: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  currentStep: number;
  error?: string;
  transcript?: TranscriptSegment[];
  polishedContent?: string; // 新增：儲存 AI 修潤後的完整文章
  analysis?: GeminiOutput;
  meetingTags?: string[]; // 新增：會議標籤 (Context Tags)
  meetingContext?: string; // 新增：一句話補充背景
  processedSlices?: number;
  totalSlices?: number;
  etaSeconds?: number;
  steps: {
    name: string;
    status: StepStatus;
    logs?: string[];
  }[];
  notified?: boolean; // 是否已發送通知
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface AppState {
  jobs: Job[];
  activeJobId: string | null;
}

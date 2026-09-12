
export enum JobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export enum SubAgentType {
  BUSINESS_NEGOTIATOR = 'BUSINESS_NEGOTIATOR',
  METRICS_EXPERT = 'METRICS_EXPERT',
  PROJECT_MANAGER = 'PROJECT_MANAGER',
  FIRST_PRINCIPLES_AUDITOR = 'FIRST_PRINCIPLES_AUDITOR'
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
  strategies?: string[]; // 新增：即時策略建議
  agentType?: SubAgentType; // 新增：使用的子代理類型
  meetingTags?: string[]; // 新增：會議標籤 (Context Tags)
  meetingContext?: string; // 新增：一句話補充背景
  segmentedSummaries?: string[]; // 新增：分段節錄摘要
  consensus?: string[]; // 新增：已達成的共識 (長期記憶)
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

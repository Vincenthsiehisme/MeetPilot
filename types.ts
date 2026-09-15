import { MeetingStatus } from './services/meetingState';
import { TopicExtractionStatus } from './services/topicTag';
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

/**
 * Meeting：一場實際會議在系統中的唯一代表（SDD 1.1）。
 *
 * 它取代以「一個音檔」為單位的 Job。Job 這個型別暫時留著，因為 migration 要讀舊資料，
 * 而且瀏覽器 IndexedDB 裡的既有記錄仍是 Job 形狀。新的碼一律用 Meeting。
 */
export interface Meeting {
  meeting_id: string;
  title: string | null;
  status: MeetingStatus;
  created_at: number;
  updated_at: number;
  source_file_name: string | null;
  source_file_size: number | null;
  /** 這筆是原生建立的，還是從 IndexedDB 搬過來的。rehearsal 逐筆比對時要分得開 */
  origin: 'native' | 'migrated';
  error: string | null;
  processed_slices: number | null;
  total_slices: number | null;
  meeting_context: string | null;
  /**
   * 題目標籤抽取的結果（W3）。**null 是「還沒抽過」**——W3 之前就 READY 的會與搬遷進來的會
   * 都是這個值，跟 'empty'（抽過、模型一條都沒回）不是同一件事。
   * 'empty' 與 'failed' 的會永遠不會參與任何關聯，靠這一欄查得出來
   */
  topic_extraction_status: TopicExtractionStatus | null;
  /** 抽取失敗的原因。只有 'failed' 會有值，其餘一律 null */
  topic_extraction_error: string | null;
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

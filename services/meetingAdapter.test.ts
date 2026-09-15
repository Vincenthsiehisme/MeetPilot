import { describe, it, expect, vi } from 'vitest';
import { GeminiOutput, Job, JobStatus, StepStatus } from '../types';
import { MEETING_STATUSES, MeetingStatus } from './meetingState';
import { AnalysisV2 } from './analysisContract';
import {
  AUDIO_ALREADY_ON_SERVER_HINTS,
  ImportResponse,
  MeetingDetailResponse,
  MeetingView,
  audioUploadInFlightError,
  audioUploadQueuedError,
} from './meetingApi';
import type { SelectionRef } from './meetingAdapter';
import {
  LOCAL_SECTION_TITLE,
  LOCAL_STALLED_ERROR,
  MISSING_ERROR_MESSAGE,
  SERVER_SECTION_TITLE,
  UNKNOWN_STAGE_STEP_NAME,
  buildDashboardView,
  formatSliceProgress,
  hasMeetingsInProgress,
  AUDIO_BACKUP_HINT,
  buildAudioBackupTargets,
  editBlockedReason,
  geminiOutputToAnalysisV2,
  audioSubmitFailureMessage,
  isMeetingBusy,
  isMeetingInProgress,
  loadDetailForSelection,
  meetingDetailToJob,
  meetingToJob,
  needsAudioUpload,
  shouldApplyDetail,
  summarizeImportResponse,
} from './meetingAdapter';

const makeMeeting = (overrides: Partial<MeetingView> = {}): MeetingView => ({
  meeting_id: 'm_1',
  // 預設沒抽過題目標籤（null），不是 'empty'：在意這個欄位的測試自己覆寫
  topic_extraction_status: null,
  topic_extraction_error: null,
  // 預設有音檔：絕大多數測試不在意這個欄位，在意的那幾條自己覆寫
  has_audio: true,
  title: null,
  status: 'CREATED',
  created_at: 1000,
  updated_at: 2000,
  source_file_name: 'a.m4a',
  source_file_size: 123,
  origin: 'native',
  error: null,
  processed_slices: null,
  total_slices: null,
  meeting_context: null,
  ...overrides,
});

const makeLocalJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job_1',
  fileName: 'old.wav',
  fileSize: 1,
  createdAt: 1,
  updatedAt: 1,
  status: JobStatus.COMPLETED,
  currentStep: 2,
  steps: [],
  ...overrides,
});

interface Expectation {
  jobStatus: JobStatus;
  stageStatuses: StepStatus[];
  currentStep: number;
}

// 八個狀態逐一寫死。用 Record<MeetingStatus, ...> 是刻意的：server 之後多一個狀態，
// 這張表沒補就在 tsc 壞掉，不會安靜地走進某個看起來正常的分支。
const EXPECTED: Record<MeetingStatus, Expectation> = {
  CREATED: { jobStatus: JobStatus.PENDING, stageStatuses: [StepStatus.IDLE, StepStatus.IDLE, StepStatus.IDLE], currentStep: 0 },
  TRANSCRIBING: { jobStatus: JobStatus.RUNNING, stageStatuses: [StepStatus.PROCESSING, StepStatus.IDLE, StepStatus.IDLE], currentStep: 0 },
  ANALYZING: { jobStatus: JobStatus.RUNNING, stageStatuses: [StepStatus.SUCCESS, StepStatus.PROCESSING, StepStatus.IDLE], currentStep: 1 },
  READY: { jobStatus: JobStatus.COMPLETED, stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.IDLE], currentStep: 2 },
  LINKING: { jobStatus: JobStatus.RUNNING, stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.PROCESSING], currentStep: 2 },
  LINKED: { jobStatus: JobStatus.COMPLETED, stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.SUCCESS], currentStep: 2 },
  LINK_FAILED: { jobStatus: JobStatus.FAILED, stageStatuses: [StepStatus.SUCCESS, StepStatus.SUCCESS, StepStatus.ERROR], currentStep: 2 },
  // FAILED 只有一個節點：Meeting 沒記錄斷在哪一階段，填三個階段的成敗都是編造
  FAILED: { jobStatus: JobStatus.FAILED, stageStatuses: [StepStatus.ERROR], currentStep: 0 },
};

describe('meetingToJob 的狀態對應', () => {
  it('這張表涵蓋 meetingState 宣告的每一個狀態', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...MEETING_STATUSES].sort());
    expect(MEETING_STATUSES).toHaveLength(8);
  });

  for (const status of MEETING_STATUSES) {
    it(`${status} 對到明確的 JobStatus 與步驟顯示`, () => {
      const expected = EXPECTED[status];
      const job = meetingToJob(makeMeeting({ status }));

      expect(job.status).toBe(expected.jobStatus);
      expect(job.currentStep).toBe(expected.currentStep);
      expect(job.steps.map(s => s.status)).toEqual(expected.stageStatuses);
      expect(job.steps.every(s => s.name.length > 0)).toBe(true);
    });
  }

  it('FAILED 用單一節點講明「不知道斷在哪一階段」，不假裝某幾步成功', () => {
    const job = meetingToJob(makeMeeting({ status: 'FAILED', error: '轉錄逾時' }));
    expect(job.steps).toEqual([{ name: UNKNOWN_STAGE_STEP_NAME, status: StepStatus.ERROR }]);
    expect(job.error).toBe('轉錄逾時');
  });

  it('FAILED 但 server 沒給錯誤訊息時明講沒給，不留空白', () => {
    const job = meetingToJob(makeMeeting({ status: 'FAILED', error: null }));
    expect(job.error).toBe(MISSING_ERROR_MESSAGE);
  });

  it('LINK_FAILED 是失敗，而且講清楚壞的只有關聯、結論還在', () => {
    const job = meetingToJob(makeMeeting({ status: 'LINK_FAILED', error: '關聯服務逾時' }));
    expect(job.status).toBe(JobStatus.FAILED);
    expect(job.error).toContain('結論已完成可用');
    expect(job.error).toContain('關聯服務逾時');
    expect(job.steps[2].status).toBe(StepStatus.ERROR);
  });

  it('不認得的狀態直接拋錯，不吞成某個看起來正常的值', () => {
    const rogue = makeMeeting({ status: 'ARCHIVED' as MeetingStatus });
    expect(() => meetingToJob(rogue)).toThrow('未知的 Meeting 狀態');
  });

  it('可為 null 的欄位轉成 Job 時不會變成 null', () => {
    const job = meetingToJob(makeMeeting({
      status: 'READY',
      source_file_name: null,
      source_file_size: null,
      title: '週會',
      meeting_context: null,
    }));
    expect(job.fileName).toBe('週會');
    expect(job.fileSize).toBe(0);
    expect(job.meetingContext).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it('檔名與標題都沒有時退回 meeting_id，畫面上還認得出是哪一場', () => {
    const job = meetingToJob(makeMeeting({ source_file_name: null, title: null, meeting_id: 'm_42' }));
    expect(job.fileName).toBe('m_42');
  });
});

describe('片段進度', () => {
  it('兩個數字都有就給分母', () => {
    expect(formatSliceProgress(3, 12)).toBe('已完成 3/12 片段');
  });

  it('總數還沒回報時講出來，不推算、不補 0', () => {
    expect(formatSliceProgress(3, null)).toBe('已完成 3 個片段（總片段數 server 尚未回報）');
  });

  it('連已完成數都沒有就不顯示進度文字', () => {
    expect(formatSliceProgress(null, 12)).toBeNull();
  });

  it('進度掛在轉錄那一步，並同時餵給進度條用的欄位', () => {
    const job = meetingToJob(makeMeeting({ status: 'TRANSCRIBING', processed_slices: 3, total_slices: 12 }));
    expect(job.steps[0].name).toContain('已完成 3/12 片段');
    expect(job.steps[1].name).not.toContain('片段');
    expect(job.processedSlices).toBe(3);
    expect(job.totalSlices).toBe(12);
  });
});

describe('meetingDetailToJob', () => {
  const analysis: AnalysisV2 = {
    contract_version: 2,
    overview: '總結',
    topics: [{ title: 'T', content: 'C' }],
    decisions: ['D'],
    action_items: [
      { text: '寄簡報', source_meeting_id: 'm_1', created_at: 1, status: 'unknown' },
      { text: '訂會議室', source_meeting_id: 'm_1', created_at: 1, status: 'open', assignee: '小美' },
      { text: '對帳', source_meeting_id: 'm_1', created_at: 1, status: 'done' },
    ],
  };

  const detail = (overrides: Partial<MeetingDetailResponse> = {}): MeetingDetailResponse => ({
    meeting: makeMeeting({ status: 'READY' }),
    transcript: { segments: [{ start: 0, end: 1, text: '嗨' }], polished_content: '嗨。' },
    analysis,
    tags: ['週會'],
    topicTags: [],
    seamReport: null,
    ...overrides,
  });

  it('逐字稿、修潤稿、標籤都接進 Job', () => {
    const job = meetingDetailToJob(detail());
    expect(job.transcript).toHaveLength(1);
    expect(job.polishedContent).toBe('嗨。');
    expect(job.meetingTags).toEqual(['週會']);
  });

  it('還沒產出時是 undefined，不是空陣列或空物件', () => {
    const job = meetingDetailToJob(detail({ transcript: null, analysis: null }));
    expect(job.transcript).toBeUndefined();
    expect(job.polishedContent).toBeUndefined();
    expect(job.analysis).toBeUndefined();
  });

  it('v2 的 action_item 降成字串時只給 text，不加後綴', () => {
    // 加後綴會被使用者當成正文編回來，存一次多一層括號
    const job = meetingDetailToJob(detail());
    expect(job.analysis!.action_items).toEqual(['寄簡報', '訂會議室', '對帳']);
  });
});

describe('geminiOutputToAnalysisV2：使用者改完寫回 v2', () => {
  const previous: AnalysisV2 = {
    contract_version: 2,
    overview: '舊總結',
    topics: [{ title: '舊', content: '舊' }],
    decisions: ['舊決議'],
    action_items: [
      { text: 'A', source_meeting_id: 'm_old', created_at: 11, status: 'unknown' },
      { text: 'B', source_meeting_id: 'm_old', created_at: 22, status: 'open', assignee: '小美' },
      { text: 'C', source_meeting_id: 'm_old', created_at: 33, status: 'done' },
    ],
  };

  const edit = (action_items: string[]): GeminiOutput => ({
    overview: '新總結',
    topics: [{ title: '新', content: '新' }],
    decisions: ['新決議'],
    action_items,
  });

  it('只改文字時 metadata 全部保留', () => {
    const next = geminiOutputToAnalysisV2(edit(['A', 'B 改過', 'C']), previous, 'm_now', 999);

    expect(next.contract_version).toBe(2);
    expect(next.overview).toBe('新總結');
    expect(next.action_items).toEqual([
      { text: 'A', source_meeting_id: 'm_old', created_at: 11, status: 'unknown' },
      { text: 'B 改過', source_meeting_id: 'm_old', created_at: 22, status: 'open', assignee: '小美' },
      { text: 'C', source_meeting_id: 'm_old', created_at: 33, status: 'done' },
    ]);
  });

  it('新增一筆補 unknown，不是 open', () => {
    const next = geminiOutputToAnalysisV2(edit(['A', 'B', 'C', 'D']), previous, 'm_now', 999);

    expect(next.action_items).toHaveLength(4);
    expect(next.action_items[3]).toEqual({
      text: 'D', source_meeting_id: 'm_now', created_at: 999, status: 'unknown',
    });
    // 補 open 是替使用者宣告它待處理
    expect(next.action_items[3].status).not.toBe('open');
    expect(next.action_items[3].assignee).toBeUndefined();
  });

  it('刪掉中間一筆時後面那筆的 metadata 不會位移', () => {
    const next = geminiOutputToAnalysisV2(edit(['A', 'C']), previous, 'm_now', 999);

    expect(next.action_items).toEqual([
      { text: 'A', source_meeting_id: 'm_old', created_at: 11, status: 'unknown' },
      // 純按位置對齊的話這筆會拿到 B 的 created_at 22 與 assignee 小美
      { text: 'C', source_meeting_id: 'm_old', created_at: 33, status: 'done' },
    ]);
  });

  it('同一次又刪又改時，沒動過的那筆認領自己的 metadata，改過的那筆當成新增', () => {
    const next = geminiOutputToAnalysisV2(edit(['C', 'B 改過']), previous, 'm_now', 999);

    expect(next.action_items[0]).toEqual({
      text: 'C', source_meeting_id: 'm_old', created_at: 33, status: 'done',
    });
    // 筆數從 3 變 2，位置已經沒有「還是同一筆」的意思。
    // 舊版在這裡照順序配到 A，等於把別筆的來源與時間戳安靜貼上去
    expect(next.action_items[1]).toEqual({
      text: 'B 改過', source_meeting_id: 'm_now', created_at: 999, status: 'unknown',
    });
  });

  it('刪掉第一筆又改了第二筆時，不會把別場會議的 metadata 搬過來（V5 回歸）', () => {
    // verifier 跑出來的輸入：兩筆來自不同場會議、狀態不同、其中一筆有負責人
    const crossMeeting: AnalysisV2 = {
      contract_version: 2,
      overview: '總結',
      topics: [],
      decisions: [],
      action_items: [
        { text: '上週就做完的事', source_meeting_id: 'm_上週', created_at: 11, status: 'done' },
        { text: '小美要追的事', source_meeting_id: 'm_本週', created_at: 22, status: 'open', assignee: '小美' },
      ],
    };

    const next = geminiOutputToAnalysisV2(
      { overview: '總結', topics: [], decisions: [], action_items: ['小美要追的事（補上期限）'] },
      crossMeeting,
      'm_now',
      999
    );

    expect(next.action_items).toHaveLength(1);
    const only = next.action_items[0];
    // 一筆進行中的待辦絕對不能變成別場會議的已完成待辦
    expect(only.source_meeting_id).not.toBe('m_上週');
    expect(only.status).not.toBe('done');
    expect(only).toEqual({
      text: '小美要追的事（補上期限）', source_meeting_id: 'm_now', created_at: 999, status: 'unknown',
    });
  });

  it('兩筆文字相同時，第一輪是貪心的：第 i 筆認領第 i 個還沒被認領的', () => {
    // v1 的字串沒有 id，一模一樣的兩筆在這一層本來就分不出誰是誰，
    // 所以行為只能定義成貪心，並且寫下來
    const duplicated: AnalysisV2 = {
      contract_version: 2,
      overview: '總結',
      topics: [],
      decisions: [],
      action_items: [
        { text: '對帳', source_meeting_id: 'm_1', created_at: 11, status: 'unknown' },
        { text: '對帳', source_meeting_id: 'm_2', created_at: 22, status: 'open' },
      ],
    };

    const kept = geminiOutputToAnalysisV2(
      { overview: '總結', topics: [], decisions: [], action_items: ['對帳', '對帳'] },
      duplicated,
      'm_now',
      999
    );
    expect(kept.action_items.map(i => i.created_at)).toEqual([11, 22]);

    // 只留一筆時配到的是第一筆，第二筆的 metadata 就此丟掉（筆數變了，不做順序回退）
    const halved = geminiOutputToAnalysisV2(
      { overview: '總結', topics: [], decisions: [], action_items: ['對帳'] },
      duplicated,
      'm_now',
      999
    );
    expect(halved.action_items[0].created_at).toBe(11);
  });

  it('全部刪光時 action_items 是空的，不會憑空留下舊的', () => {
    const next = geminiOutputToAnalysisV2(edit([]), previous, 'm_now', 999);
    expect(next.action_items).toEqual([]);
  });

  it('同一份輸入轉兩次結果一樣，時間戳由呼叫端給', () => {
    const a = geminiOutputToAnalysisV2(edit(['A', 'D']), previous, 'm_now', 999);
    const b = geminiOutputToAnalysisV2(edit(['A', 'D']), previous, 'm_now', 999);
    expect(a).toEqual(b);
  });
});

describe('action_items 的往返無損', () => {
  it('v2 → 顯示字串 → 編輯 → 寫回 v2，四個 metadata 欄位原樣', () => {
    const original: AnalysisV2 = {
      contract_version: 2,
      overview: '總結',
      topics: [],
      decisions: [],
      action_items: [
        { text: '寄簡報', source_meeting_id: 'm_1', created_at: 100, status: 'unknown' },
        { text: '訂會議室', source_meeting_id: 'm_2', created_at: 200, status: 'open', assignee: '小美' },
        { text: '對帳', source_meeting_id: 'm_3', created_at: 300, status: 'done' },
      ],
    };

    const shown = meetingDetailToJob({
      meeting: makeMeeting({ status: 'READY' }),
      seamReport: null,
      transcript: null,
      analysis: original,
      tags: [],
      topicTags: [],
    }).analysis!;

    // 使用者只動了 overview，action_items 原樣送回
    const roundTripped = geminiOutputToAnalysisV2(
      { ...shown, overview: '改過的總結' },
      original,
      'm_now',
      999
    );

    expect(roundTripped.action_items).toEqual(original.action_items);
    expect(roundTripped.overview).toBe('改過的總結');

    // 再走一圈也不會多出東西
    const shownAgain = meetingDetailToJob({
      meeting: makeMeeting({ status: 'READY' }),
      seamReport: null,
      transcript: null,
      analysis: roundTripped,
      tags: [],
      topicTags: [],
    }).analysis!;
    expect(shownAgain.action_items).toEqual(['寄簡報', '訂會議室', '對帳']);
  });
});

describe('polling 的停止條件與批次清除的名單（W3）', () => {
  it('server 正在寫的那幾個狀態要 poll', () => {
    expect(hasMeetingsInProgress([makeMeeting({ status: 'TRANSCRIBING' })])).toBe(true);
    expect(hasMeetingsInProgress([makeMeeting({ status: 'ANALYZING' })])).toBe(true);
    expect(hasMeetingsInProgress([makeMeeting({ status: 'LINKING' })])).toBe(true);
  });

  it('CREATED 沒有音檔＝等使用者上傳，不算處理中', () => {
    // 搬遷進來的舊 Job 一律是 CREATED 且刻意不搬音檔。這裡回 true 的話，
    // 搬完 20 筆之後這個分頁就永久每 3 秒打兩支 API，而限流是 60 次/分鐘
    const waiting = makeMeeting({ status: 'CREATED', has_audio: false });
    expect(isMeetingInProgress(waiting)).toBe(false);
    expect(hasMeetingsInProgress([waiting])).toBe(false);
  });

  it('CREATED 有音檔＝retry 之後在佇列排隊，算處理中', () => {
    const queued = makeMeeting({ status: 'CREATED', has_audio: true });
    expect(isMeetingInProgress(queued)).toBe(true);
    expect(hasMeetingsInProgress([queued])).toBe(true);
  });

  it('批次清除清得到等上傳的那幾場，清不到排隊中的', () => {
    // App 的「清除已結束的會議」就是用 !isMeetingInProgress 過濾
    const meetings = [
      makeMeeting({ meeting_id: 'm_搬遷待上傳', status: 'CREATED', has_audio: false }),
      makeMeeting({ meeting_id: 'm_排隊中', status: 'CREATED', has_audio: true }),
      makeMeeting({ meeting_id: 'm_完成', status: 'LINKED' }),
      makeMeeting({ meeting_id: 'm_轉錄中', status: 'TRANSCRIBING' }),
    ];
    const clearable = meetings.filter(m => !isMeetingInProgress(m)).map(m => m.meeting_id);
    expect(clearable).toEqual(['m_搬遷待上傳', 'm_完成']);
  });

  it('全部到終點就不再 poll', () => {
    expect(hasMeetingsInProgress([
      makeMeeting({ status: 'READY' }),
      makeMeeting({ status: 'LINKED' }),
      makeMeeting({ status: 'LINK_FAILED' }),
      makeMeeting({ status: 'FAILED' }),
    ])).toBe(false);
    expect(hasMeetingsInProgress([])).toBe(false);
  });
});

describe('雙讀：server 的 Meeting 與本機舊 Job 同時上畫面', () => {
  it('兩邊都有東西時分成兩區，標題分得出來', () => {
    const view = buildDashboardView([makeMeeting({ status: 'READY' })], null, [makeLocalJob()]);
    expect(view.sections.map(s => s.key)).toEqual(['server', 'local']);
    expect(view.sections[0].title).toBe(SERVER_SECTION_TITLE);
    expect(view.sections[1].title).toBe(LOCAL_SECTION_TITLE);
    expect(view.sections[1].hint).toContain('只存在這台瀏覽器');
    expect(view.serverNotice).toBeNull();
  });

  it('沒有本機舊紀錄就不放那一區', () => {
    const view = buildDashboardView([makeMeeting()], null, []);
    expect(view.sections.map(s => s.key)).toEqual(['server']);
  });

  it('server 讀不到時本機紀錄照樣顯示，而且明講 server 讀取失敗', () => {
    const view = buildDashboardView(null, 'Failed to fetch', [makeLocalJob()]);
    const local = view.sections.find(s => s.key === 'local')!;
    expect(local.jobs).toHaveLength(1);
    expect(view.serverNotice).toContain('伺服器清單讀取失敗');
    expect(view.serverNotice).toContain('Failed to fetch');
  });

  it('server 讀不到時上一次讀到的清單留著，不會被清空', () => {
    const view = buildDashboardView([makeMeeting({ status: 'READY' })], 'Failed to fetch', []);
    expect(view.sections[0].jobs).toHaveLength(1);
    expect(view.serverNotice).not.toBeNull();
  });

  it('本機停在處理中的舊紀錄標成失敗並說明它不會再前進', () => {
    const view = buildDashboardView([], null, [
      makeLocalJob({ id: 'job_running', status: JobStatus.RUNNING }),
      makeLocalJob({ id: 'job_pending', status: JobStatus.PENDING }),
      makeLocalJob({ id: 'job_done', status: JobStatus.COMPLETED }),
    ]);
    const local = view.sections.find(s => s.key === 'local')!;
    expect(local.jobs[0].status).toBe(JobStatus.FAILED);
    expect(local.jobs[0].error).toBe(LOCAL_STALLED_ERROR);
    expect(local.jobs[1].status).toBe(JobStatus.FAILED);
    expect(local.jobs[2].status).toBe(JobStatus.COMPLETED);
    expect(local.jobs[2].error).toBeUndefined();
  });
});

describe('搬遷結果', () => {
  const response: ImportResponse = {
    imported: ['m_a'],
    skippedExisting: ['m_b'],
    rejected: [{ jobId: 'job_c', reason: '分析內容是空的' }, { jobId: null, reason: '沒有 id' }],
    notes: [{ jobId: 'job_a', note: '逐字稿有缺口' }],
    audioStillInBrowser: [
      { meetingId: 'm_a', group: 'imported' },
      { meetingId: 'm_c', group: 'rejected' },
      { meetingId: 'm_d', group: 'orphan' },
    ],
  };

  it('五個欄位原樣帶出來，不合併也不省略', () => {
    const summary = summarizeImportResponse(response);
    expect(summary.imported).toEqual(['m_a']);
    expect(summary.skippedExisting).toEqual(['m_b']);
    expect(summary.rejected).toHaveLength(2);
    expect(summary.notes).toHaveLength(1);
    expect(summary.audioStillInBrowser).toHaveLength(3);
  });

  it('被退件又只剩瀏覽器有音檔的那幾筆單獨標出來', () => {
    expect(summarizeImportResponse(response).unrecoverableMeetingIds).toEqual(['m_c']);
  });

  it('報告文字五段各自出現，退件原因與重跑不了的會議都寫在裡面', () => {
    const { message } = summarizeImportResponse(response);
    expect(message).toContain('已搬進伺服器（1）');
    expect(message).toContain('伺服器上已經有、略過（1）');
    expect(message).toContain('退件、沒有搬進去（2）');
    expect(message).toContain('job_c：分析內容是空的');
    expect(message).toContain('搬進去但有附註（1）');
    expect(message).toContain('音檔仍留在這台瀏覽器（3）');
    expect(message).toContain('清掉瀏覽器資料後就重跑不了的（1）');
    expect(message).toContain('m_c');
  });

  it('什麼都沒有時每一段都寫「無」，不是整段消失', () => {
    const { message, unrecoverableMeetingIds } = summarizeImportResponse({
      imported: [], skippedExisting: [], rejected: [], notes: [], audioStillInBrowser: [],
    });
    expect(unrecoverableMeetingIds).toEqual([]);
    expect(message.match(/（無）/g)).toHaveLength(6);
  });
});

describe('切換會議時的舊回應（C-P1）', () => {
  const selected = (id: string): SelectionRef => ({ source: 'server', id });

  it('回應回來時還停在同一場就套用', () => {
    expect(shouldApplyDetail('m_1', selected('m_1'))).toBe(true);
  });

  it('已經切到別場、切到本機紀錄、或什麼都沒選，一律不套用', () => {
    expect(shouldApplyDetail('m_1', selected('m_2'))).toBe(false);
    expect(shouldApplyDetail('m_1', { source: 'local', id: 'm_1' })).toBe(false);
    expect(shouldApplyDetail('m_1', null)).toBe(false);
  });

  it('A 的回應晚於切到 B 時被丟棄，B 的照常套用', async () => {
    // 兩個 deferred：A 先送出、後回來，剛好是會把 A 寫進 B 的那個順序
    let resolveA: (v: MeetingDetailResponse) => void = () => {};
    let resolveB: (v: MeetingDetailResponse) => void = () => {};
    const detailA = { seamReport: null, meeting: makeMeeting({ meeting_id: 'm_A', status: 'READY' }), transcript: null, analysis: null, tags: [], topicTags: [] };
    const detailB = { seamReport: null, meeting: makeMeeting({ meeting_id: 'm_B', status: 'READY' }), transcript: null, analysis: null, tags: [], topicTags: [] };

    const fetchDetail = vi.fn((id: string) => new Promise<MeetingDetailResponse>(resolve => {
      if (id === 'm_A') resolveA = resolve; else resolveB = resolve;
    }));

    let current: SelectionRef = selected('m_A');
    const applied: string[] = [];
    const failed: string[] = [];
    const handlers = {
      onDetail: (d: MeetingDetailResponse) => { applied.push(d.meeting.meeting_id); },
      onError: (e: unknown) => { failed.push(String(e)); },
    };

    const runA = loadDetailForSelection('m_A', fetchDetail, () => current, handlers);
    // 使用者切到 B，B 的請求也送出去
    current = selected('m_B');
    const runB = loadDetailForSelection('m_B', fetchDetail, () => current, handlers);

    resolveB(detailB);
    await runB;
    resolveA(detailA);
    await runA;

    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['m_B']);
    expect(applied).not.toContain('m_A');
    expect(failed).toEqual([]);
  });

  it('舊請求的失敗也不會蓋掉新畫面', async () => {
    let rejectA: (e: unknown) => void = () => {};
    const fetchDetail = vi.fn(() => new Promise<MeetingDetailResponse>((_, reject) => { rejectA = reject; }));

    let current: SelectionRef = selected('m_A');
    const failed: string[] = [];
    const run = loadDetailForSelection('m_A', fetchDetail, () => current, {
      onDetail: () => { throw new Error('不該套用'); },
      onError: (e: unknown) => { failed.push(String(e)); },
    });

    current = selected('m_B');
    rejectA(new Error('boom'));
    await run;

    expect(failed).toEqual([]);
  });

  it('還停在同一場時的失敗要報出來，不要一起吞掉', async () => {
    const fetchDetail = vi.fn(() => Promise.reject(new Error('boom')));
    const failed: string[] = [];
    await loadDetailForSelection('m_A', fetchDetail, () => selected('m_A'), {
      onDetail: () => { throw new Error('不該套用'); },
      onError: (e: unknown) => { failed.push(String(e)); },
    });
    expect(failed).toEqual(['Error: boom']);
  });
});

describe('處理中不讓編輯（配合 T1 的 V2）', () => {
  it('BUSY_STATUSES 的三個狀態擋下來並說明原因', () => {
    for (const status of ['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const) {
      expect(isMeetingBusy(status)).toBe(true);
      const reason = editBlockedReason(status);
      expect(reason).not.toBeNull();
      expect(reason).toContain(status);
      // 擋的理由是「存了會安靜不見」，不是「衝突」
      expect(reason).toContain('蓋掉');
    }
  });

  it('其餘狀態可以編輯', () => {
    for (const status of ['CREATED', 'READY', 'LINKED', 'LINK_FAILED', 'FAILED'] as const) {
      expect(isMeetingBusy(status)).toBe(false);
      expect(editBlockedReason(status)).toBeNull();
    }
  });
});

describe('CREATED 要補音檔（C-P2、S2）', () => {
  it('CREATED 且 server 上沒有音檔時才給上傳入口', () => {
    expect(needsAudioUpload(makeMeeting({ status: 'CREATED', has_audio: false }))).toBe(true);
  });

  it('CREATED 但音檔在 server 上（retry 排隊中）不給上傳入口', () => {
    // 這段期間顯示「伺服器上還沒有音檔」是假話，而使用者照做按下去，
    // server 的 PUT 會把 retry 刻意保留的逐字稿與游標全刪掉
    expect(needsAudioUpload(makeMeeting({ status: 'CREATED', has_audio: true }))).toBe(false);
  });

  it('其餘狀態一律不給上傳入口，有沒有音檔都一樣', () => {
    for (const status of ['TRANSCRIBING', 'ANALYZING', 'READY', 'LINKING', 'LINKED', 'LINK_FAILED', 'FAILED'] as const) {
      expect(needsAudioUpload(makeMeeting({ status, has_audio: true }))).toBe(false);
      expect(needsAudioUpload(makeMeeting({ status, has_audio: false }))).toBe(false);
    }
  });
});

describe('送出音檔失敗要說哪一句（S3）', () => {
  it('建立階段就失敗時，不叫使用者去清單裡找那筆會議', () => {
    const message = audioSubmitFailureMessage('【連不上伺服器】', false);
    expect(message).toContain('【連不上伺服器】');
    expect(message).toContain('沒有建立這場會議');
    // 那筆根本不存在，叫他去選中它就是叫他找一筆不存在的紀錄
    expect(message).not.toContain('選中它');
    expect(message).not.toContain('補上音檔');
  });

  it('會議已經建立、只是音檔沒上去時，指路去補上音檔', () => {
    const message = audioSubmitFailureMessage('【處理失敗】寫入音檔失敗', true);
    expect(message).toContain('【處理失敗】寫入音檔失敗');
    expect(message).toContain('選中它');
    expect(message).toContain('補上音檔');
    expect(message).toContain('不用重新建立');
  });

  it('server 發的兩句 409 各自含得住前端用來認它的線索', () => {
    // 訊息正本與線索是兩份字面值，改一邊忘一邊的話前端會安靜地認不出來，
    // 回頭接上「這場會還沒有音檔」那段假話，而且三條 gate 全綠
    const messages = [audioUploadInFlightError('m_1'), audioUploadQueuedError('m_1')];
    for (const hint of AUDIO_ALREADY_ON_SERVER_HINTS) {
      expect(messages.some(message => message.includes(hint))).toBe(true);
    }
    for (const message of messages) {
      expect(AUDIO_ALREADY_ON_SERVER_HINTS.some(hint => message.includes(hint))).toBe(true);
    }
  });

  it.each([
    ['排隊中', audioUploadQueuedError('m_1')],
    ['另一個上傳正在進行', audioUploadInFlightError('m_1')],
  ])('%s 的 409 不接「去補上音檔」那段假話：音檔已經在 server 上', (_label, serverError) => {
    const message = audioSubmitFailureMessage(`【處理失敗】${serverError}`, true);
    expect(message).toContain(serverError);
    expect(message).toContain('音檔已經在伺服器上');
    // 這兩句是這條修復的重點：叫使用者再送一次剛被拒絕的動作，而且「還沒有音檔」是假的
    expect(message).not.toContain('還沒有音檔');
    expect(message).not.toContain('補上音檔');
    expect(message).not.toContain('重送一次');
  });

  it('兩種情況說的不是同一句話', () => {
    expect(audioSubmitFailureMessage('x', true)).not.toBe(audioSubmitFailureMessage('x', false));
  });
});

describe('音檔備份清單（V15）', () => {
  it('配回本機紀錄拿原本的檔名', () => {
    const targets = buildAudioBackupTargets(['job_1', 'job_2'], [
      makeLocalJob({ id: 'job_1', fileName: '週會.m4a' }),
      makeLocalJob({ id: 'job_2', fileName: '客戶訪談.wav' }),
    ]);
    expect(targets).toEqual([
      { meetingId: 'job_1', fileName: '週會.m4a' },
      { meetingId: 'job_2', fileName: '客戶訪談.wav' },
    ]);
  });

  it('配不回去就用 meetingId 當檔名，不會拿到別人的檔名', () => {
    const targets = buildAudioBackupTargets(['job_missing'], [makeLocalJob({ id: 'job_1', fileName: '週會.m4a' })]);
    expect(targets).toEqual([{ meetingId: 'job_missing', fileName: 'job_missing' }]);
  });

  it('搬遷報告指向畫面上真的做得到的動作，不再叫使用者自行備份', () => {
    const { message } = summarizeImportResponse({
      imported: [], skippedExisting: [],
      rejected: [{ jobId: 'job_c', reason: '分析內容是空的' }],
      notes: [],
      audioStillInBrowser: [{ meetingId: 'job_c', group: 'rejected' }],
    });
    expect(message).toContain(AUDIO_BACKUP_HINT);
    expect(message).toContain('下載音檔');
    // 「請先自行備份音檔」是空頭支票：前端當時沒有任何讀得到 blob 的路徑
    expect(message).not.toContain('自行備份');
  });
});

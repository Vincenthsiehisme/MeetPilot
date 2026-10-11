import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { TranscriptSegment } from '../types';
import { AnalysisModelOutput } from './analysisContract';
import { AudioFileStore } from './audioFileStore';
import { AudioSlicer } from './audioSlicer';
import { silentWav, toneWav } from './wavFixture';
import { GeminiServerClient } from './geminiServerClient';
import { createJobStore } from './jobStore';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { SLICE_OVERLAP_SECONDS } from './transcriptMerge';
import { createTopicExtractor } from './topicExtractor';
import { PeopleStore, createPeopleStore } from './peopleStore';
import { NameResolver, createNameResolver } from './nameResolver';
import { DiagnosticsExporter } from './diagnosticsExport';
import { VaultProjector } from './vaultProjector';
import {
  SLICE_DURATION_SECONDS,
  TranscriptionPipelineDeps,
  backfillInterruptedMeetings,
  buildPreviousContext,
  createTranscriptionPipeline,
  resolveParticipantNames,
} from './transcriptionPipeline';

const T0 = 1_700_000_000_000;
// 3 片：600 + 600 + 300（planSlices 的規則見 audioSlicer.test.ts）
const THREE_SLICE_DURATION = SLICE_DURATION_SECONDS * 2 + 300;

let db: DatabaseSync;
let store: MeetingStore;
let statuses: string[];

// 記憶體版的音檔存放處。真正的檔案 I/O 在 audioFileStore.test.ts 驗，這裡只在意
// 「音檔還在不在」——那是續傳與重跑的唯一依據
const fakeAudioStore = (present: Set<string>): AudioFileStore => ({
  dir: '/fake/audio',
  pathFor: (id: string) => `/fake/audio/${id}.audio`,
  exists: (id: string) => present.has(id),
  tempPathFor: (id: string) => `/fake/audio/${id}_tmp_part`,
  sizeOf: () => 1024,
  saveFrom: async (id: string) => { present.add(id); return { path: `/fake/audio/${id}.audio`, bytes: 1024 }; },
  removePartialUploads: () => [],
  remove: (id: string) => { present.delete(id); },
  recordingPathFor: (id: string) => `/fake/audio/${id}.recording`,
  appendRecordingChunk: () => { throw new Error('這支測試用不到 app 內錄音'); },
  promoteRecording: () => { throw new Error('這支測試用不到 app 內錄音'); },
  removeRecording: () => {},
});

const fakeSlicer = (durationSeconds: number, readSlice?: AudioSlicer['readSlice']): AudioSlicer => ({
  probeDurationRemuxingIfMissing: async () => durationSeconds,
  // 預設切出有聲音的 WAV：轉錄前會先量音量，全是靜音的音檔不送 Gemini（services/audioLevel.ts）
  readSlice: readSlice ?? (async () => toneWav()),
});

/** gemini.analyzeTranscript 的回傳形狀（segment_from／segment_to，不是秒數）。
 * segment_from/to 都指第 1 段：analyze() 呼叫前已經擋掉空逐字稿，至少有第 1 段可以指 */
const analysisOutput: AnalysisModelOutput = {
  title: '預算與時程',
  overview: '一句話主旨',
  topics: [{ title: '議題 A', content: '內容', points: [{ text: '要點 A', segment_from: 1, segment_to: 1 }] }],
  decisions: [{ text: '決定 A', segment_from: 1, segment_to: 1, decided_by: null }],
  action_items: [{ text: '待辦 A', segment_from: 1, segment_to: 1, assignee: null, due: null }],
  open_questions: [],
};

/**
 * 比較像真實 LLM 的假 Gemini：對每一片**逐 10 秒輸出整片內容**，包含跟前一片重疊的那 15 秒。
 *
 * 為什麼要這樣假：每片只回一段互不重疊的內容時，mergeSliceTranscript 的去重分支從來不會被踩到，
 * 把 `slice.index === 0` 改成 `true`（等於完全不去重）整包測試還是綠的——那種測試對這條接線
 * 零鑑別力，而多片合併正是搬到 server 之後唯一沒有整合證據的地方。
 *
 * 時間是絕對秒數（transcribeSlice 在正式路徑上已經把 offset 加進去了）。
 */
const CHUNK_SECONDS = 10;
const overlappingGemini = (
  seen: { offsetSeconds: number; previousContext: string }[] = [],
): GeminiServerClient => fakeGemini({
  transcribeSlice: async ({ offsetSeconds = 0, previousContext = '', sliceDurationSeconds = 0 }) => {
    seen.push({ offsetSeconds, previousContext });
    const segments: TranscriptSegment[] = [];
    for (let t = 0; t < sliceDurationSeconds; t += CHUNK_SECONDS) {
      const start = offsetSeconds + t;
      const end = offsetSeconds + Math.min(t + CHUNK_SECONDS, sliceDurationSeconds);
      segments.push({ start, end, text: `${start}s 開始的內容`, speaker: 'Speaker 1' });
    }
    return segments;
  },
});

const fakeGemini = (overrides: Partial<GeminiServerClient> = {}): GeminiServerClient => ({
  transcribeSlice: async ({ offsetSeconds = 0 }) => [
    { start: offsetSeconds, end: offsetSeconds + 30, text: `第 ${offsetSeconds} 秒開始`, speaker: 'Speaker 1' },
  ],
  analyzeTranscript: async () => analysisOutput,
  extractTopicTags: async () => [{ title: '題目 A', content: '這場會對題目 A 的討論' }],
  embeddingModel: 'fake-embedding',
  // W4 的兩支。這一層不算關聯，形狀要在，缺了型別就對不上
  embedTopicTags: async (texts) => ({ model: 'fake-embedding', dimensions: 1, vectors: texts.map(() => [1]) }),
  judgeMeetingPair: async () => ({ sameTopic: false, confidence: 0, reason: '假的判定', sharedTopics: [] }),
  ...overrides,
});

/**
 * 每一條測試都用**真的** TopicExtractor（假的只有 Gemini）。
 *
 * 給它一個假的 extractor 的話，「抽標籤掛掉會不會害這場會變成 FAILED」這條接線就沒有人測，
 * 而那正是 W3 唯一會改變既有流程的地方
 */
const pipelineWith = (deps: Omit<TranscriptionPipelineDeps, 'topicExtractor'>) =>
  createTranscriptionPipeline({
    ...deps,
    topicExtractor: createTopicExtractor({ store: deps.store, gemini: deps.gemini, now: deps.now }),
  });

const newMeeting = (id = 'm-1') =>
  store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 10 });

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  // 狀態轉移的「順序」是驗收條件之一，只看最後結果看不出中間有沒有走過 ANALYZING
  statuses = [];
  const setStatus = store.setStatus;
  store.setStatus = (id, to, updatedAt, error) => {
    statuses.push(to);
    return setStatus(id, to, updatedAt, error);
  };
});

afterEach(() => {
  db.close();
});

describe('buildPreviousContext', () => {
  it('沒有前文時是空字串，不送一段空的 Context 給模型', () => {
    expect(buildPreviousContext([])).toBe('');
  });

  it('只取最後 10 句', () => {
    const segments: TranscriptSegment[] = Array.from({ length: 12 }, (_, i) => ({
      start: i, end: i + 1, text: `第 ${i} 句`, speaker: 'Speaker 1',
    }));
    const context = buildPreviousContext(segments);
    expect(context.split('\n')).toHaveLength(10);
    expect(context).toContain('第 11 句');
    expect(context).not.toContain('第 1 句\n');
  });

  it('超過 1000 字時截尾巴，留最靠近下一片的內容', () => {
    const context = buildPreviousContext([{ start: 0, end: 1, text: 'x'.repeat(2000), speaker: 'S' }]);
    expect(context).toHaveLength(1000);
    expect(context.endsWith('x')).toBe(true);
  });
});

describe('run：整場跑完', () => {
  it('狀態依序走 TRANSCRIBING → ANALYZING → READY，且分析成功之後才刪音檔', async () => {
    newMeeting();
    const present = new Set(['m-1']);
    const audioStore = fakeAudioStore(present);
    const removedAt: string[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: { ...audioStore, remove: (id: string) => { removedAt.push(store.getMeeting(id)!.status); audioStore.remove(id); } },
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'READY']);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(present.has('m-1')).toBe(false);
    // 刪檔發生在 READY 之後：轉錄成功就刪的話，分析失敗的那場會再也重跑不了
    expect(removedAt).toEqual(['READY']);
  });

  it('三片都送給 Gemini，逐字稿與進度一起落地', async () => {
    newMeeting();
    const offsets: number[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0 }) => {
          offsets.push(offsetSeconds);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(offsets).toEqual([0, 600, 1200]);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(3);
    expect(store.getMeeting('m-1')?.total_slices).toBe(3);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(3);
    expect(store.getAnalysis('m-1')?.action_items[0]).toMatchObject({
      text: '待辦 A', source_meeting_id: 'm-1', status: 'unknown',
    });
  });

  it('第二片開始要帶前文，否則講者編號會在片與片之間跳掉', async () => {
    newMeeting();
    const contexts: string[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, previousContext = '' }) => {
          contexts.push(previousContext);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(contexts[0]).toBe('');
    expect(contexts[1]).toBe('S: 片段 0');
    expect(contexts[2]).toBe('S: 片段 0\nS: 片段 600');
  });
});

describe('resolveParticipantNames（人名校正 N3）', () => {
  let peopleStore: PeopleStore;

  beforeEach(() => {
    peopleStore = createPeopleStore(db);
  });

  it('沒有 peopleStore（null）時回空陣列，不影響既有沒有這個依賴的呼叫端', () => {
    newMeeting();
    expect(resolveParticipantNames('m-1', store, null)).toEqual([]);
  });

  it('這場會沒有與會者時回空陣列，即使 peopleStore 有資料', () => {
    newMeeting();
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen'] }],
      T0,
    );
    expect(resolveParticipantNames('m-1', store, peopleStore)).toEqual([]);
  });

  it('回傳正名與別名的聯集，去重', () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen', 'philchen'] }],
      T0,
    );
    store.createMeeting({ meeting_id: 'm-1', created_at: T0, participant_ids: ['p-1'] });

    expect(resolveParticipantNames('m-1', store, peopleStore).sort()).toEqual(['Philchen', 'philchen', '陳國煌'].sort());
  });

  it('多個與會者的名字合併成一份清單', () => {
    peopleStore.importRoster(
      [
        { employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: [] },
        { employeeId: 'p-2', displayName: '陳雅婷', title: null, email: 'p2@liontravel.com', department: null, aliases: ['Tina'] },
      ],
      T0,
    );
    store.createMeeting({ meeting_id: 'm-1', created_at: T0, participant_ids: ['p-1', 'p-2'] });

    expect(resolveParticipantNames('m-1', store, peopleStore).sort()).toEqual(['Tina', '陳國煌', '陳雅婷'].sort());
  });
});

describe('與會者提示接進轉錄與分析呼叫（人名校正 N3）', () => {
  let peopleStore: PeopleStore;

  beforeEach(() => {
    peopleStore = createPeopleStore(db);
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen'] }],
      T0,
    );
  });

  it('轉錄的每一片與分析呼叫都收到 participantNames', async () => {
    store.createMeeting({
      meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, participant_ids: ['p-1'],
    });
    const transcribeCalls: (string[] | undefined)[] = [];
    const analyzeCalls: (string[] | undefined)[] = [];
    const pipeline = pipelineWith({
      store,
      peopleStore,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, participantNames }) => {
          transcribeCalls.push(participantNames);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
        analyzeTranscript: async ({ participantNames }) => {
          analyzeCalls.push(participantNames);
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(transcribeCalls).toHaveLength(3); // 三片
    for (const names of transcribeCalls) expect(names?.sort()).toEqual(['Philchen', '陳國煌'].sort());
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]?.sort()).toEqual(['Philchen', '陳國煌'].sort());
  });

  it('建會議時填的背景補充（meeting_context）帶進分析呼叫的 meetingContext', async () => {
    store.createMeeting({
      meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, meeting_context: '第三次談採購',
    });
    const seen: (string | undefined)[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        analyzeTranscript: async ({ meetingContext }) => {
          seen.push(meetingContext);
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(seen).toEqual(['第三次談採購']);
  });

  it('沒帶 peopleStore 時 participantNames 是空陣列，既有不關心人名校正的測試不受影響', async () => {
    newMeeting(); // 這場會沒有 participant_ids
    const seen: (string[] | undefined)[] = [];
    const pipeline = pipelineWith({
      store,
      // 刻意不傳 peopleStore：驗證它是真的 optional，不是「忘了給會壞」
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, participantNames }) => {
          seen.push(participantNames);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(seen.every(names => names?.length === 0)).toBe(true);
  });
});

describe('NameResolver 接進 analyze（人名校正 N4）', () => {
  let peopleStore: PeopleStore;
  let nameResolver: NameResolver;

  beforeEach(() => {
    peopleStore = createPeopleStore(db);
    nameResolver = createNameResolver(db, peopleStore, store);
    peopleStore.importRoster(
      [{ employeeId: 'p-1', displayName: '陳國煌', title: null, email: 'p1@liontravel.com', department: null, aliases: ['Philchen'] }],
      T0,
    );
  });

  it('analyzeTranscript 收到的是已解析視圖，不是原始逐字稿', async () => {
    store.createMeeting({
      meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, participant_ids: ['p-1'],
    });
    let seenTranscript: TranscriptSegment[] = [];
    const pipeline = pipelineWith({
      store,
      peopleStore,
      nameResolver,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        transcribeSlice: async () => [{ start: 0, end: 30, text: 'Philchen 報告進度', speaker: 'S' }],
        analyzeTranscript: async ({ transcript }) => {
          seenTranscript = transcript;
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(seenTranscript[0].text).toBe('陳國煌 報告進度');
    // raw 逐字稿不受影響，畫面上看到的仍是原始聽寫
    expect(store.getTranscript('m-1')!.segments[0].text).toBe('Philchen 報告進度');
  });

  it('decided_by／assignee 逐字對得上與會者時，存下來的分析帶對應員編', async () => {
    store.createMeeting({
      meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, participant_ids: ['p-1'],
    });
    const pipeline = pipelineWith({
      store,
      peopleStore,
      nameResolver,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        transcribeSlice: async () => [{ start: 0, end: 30, text: '討論預算分配', speaker: 'S' }],
        analyzeTranscript: async () => ({
          ...analysisOutput,
          decisions: [{ text: '採用方案 A', segment_from: 1, segment_to: 1, decided_by: '陳國煌' }],
        }),
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const analysis = store.getAnalysis('m-1')!;
    expect(analysis.decisions[0].decided_by_employee_id).toBe('p-1');
  });

  it('分析完成時把這場會已確認的人名覆寫表帶進 FN-14', async () => {
    newMeeting();
    const overrides = new Map([['Tina', 'p-1']]);
    const resolveAnalysisEmployeeIds = vi.fn((analysis: any, _meetingId: string, received: ReadonlyMap<string, string>) => {
      expect(received).toBe(overrides);
      return analysis;
    });
    const nameResolver: NameResolver = {
      resolveTranscript: (_meetingId, segments) => ({ mentions: [], resolvedSegments: [...segments] }),
      listNeedsReview: () => [],
      resolveAnalysisEmployeeIds,
      confirmMention: () => {},
      listResolvedByText: () => overrides,
    };
    const pipeline = pipelineWith({
      store,
      nameResolver,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(resolveAnalysisEmployeeIds).toHaveBeenCalledWith(expect.any(Object), 'm-1', overrides);
  });

  it('NameResolver 比對失敗時不阻塞這場會，改用原始逐字稿分析並照樣進 READY', async () => {
    store.createMeeting({
      meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, participant_ids: ['p-1'],
    });
    const brokenResolver: NameResolver = {
      resolveTranscript: () => { throw new Error('比對邏輯壞了'); },
      listNeedsReview: () => [],
      resolveAnalysisEmployeeIds: () => { throw new Error('反查邏輯壞了'); },
      confirmMention: () => { throw new Error('確認邏輯壞了'); },
      listResolvedByText: () => new Map(),
    };
    let seenTranscript: TranscriptSegment[] = [];
    const pipeline = pipelineWith({
      store,
      peopleStore,
      nameResolver: brokenResolver,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        transcribeSlice: async () => [{ start: 0, end: 30, text: 'Philchen 報告進度', speaker: 'S' }],
        analyzeTranscript: async ({ transcript }) => {
          seenTranscript = transcript;
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(seenTranscript[0].text).toBe('Philchen 報告進度'); // 退回原始逐字稿
    expect(store.getMeeting('m-1')!.status).toBe('READY');
  });

  it('沒帶 nameResolver 時既有行為不受影響（既有測試靠這條，optional 是真的 optional）', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(store.getMeeting('m-1')!.status).toBe('READY');
  });
});

describe('provenance：逐字稿版本分層與來源標記', () => {
  it('轉錄逐片實際打中的模型落地成 slice_models', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, onModelUsed }) => {
          // 前兩片假裝首選模型可用，第三片假裝退到了 fallback，跟真實世界的混模型情況對齊
          onModelUsed?.(offsetSeconds === 1200 ? 'gemini-3.1-flash-lite' : 'gemini-3.8-flash', 1);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `第 ${offsetSeconds} 秒`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const models = store.getSliceModels('m-1');
    expect(models).toEqual([
      { sliceIndex: 0, model: 'gemini-3.8-flash', attempt: 1, kind: 'slice' },
      { sliceIndex: 1, model: 'gemini-3.8-flash', attempt: 1, kind: 'slice' },
      { sliceIndex: 2, model: 'gemini-3.1-flash-lite', attempt: 1, kind: 'slice' },
    ]);
  });

  it('分析成功落地 provenance：raw 逐字稿、實際模型、prompt 版本', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        transcribeSlice: async () => [{ start: 0, end: 30, text: '開場', speaker: 'S' }],
        analyzeTranscript: async ({ onProvenance }) => {
          onProvenance?.({ model: 'gemini-3.8-flash', promptVersion: 'abc123' });
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(store.getAnalysisProvenance('m-1')).toEqual({
      source_kind: 'raw',
      source_edit_version: null,
      // 沒帶 nameResolver：不對 name_mentions 做版本化，快照留 null（見 meetingStore 的
      // AnalysisProvenance 設計）
      resolved_segments_snapshot: null,
      model: 'gemini-3.8-flash',
      prompt_version: 'abc123',
    });
  });

  it('假 client 不回報 provenance 時，saveAnalysis 沿用舊行為（不寫壞成帶 null 的假紀錄）', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(store.getAnalysis('m-1')).not.toBeNull();
    expect(store.getAnalysisProvenance('m-1')).toBeNull();
  });

  it('分析讀的是目前顯示的版本（人工編輯過就是編輯後的），provenance 記成 edited 與正確的 edit_version', async () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '原始開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    // 模擬「轉錄完成、停在 TRANSCRIBED 時使用者訂正過逐字稿」：直接在 store 層造一筆編輯，
    // 不經過 HTTP 層的 BUSY_STATUSES 檢查（那一層在 meetingEdits.ts，這裡只驗 store／pipeline 的接線）
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 3, text: '訂正後的開場', speaker: 'S' }] }, T0 + 2);

    let seenTranscript: TranscriptSegment[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(30),
      gemini: fakeGemini({
        transcribeSlice: async () => [{ start: 0, end: 3, text: '原始開場', speaker: 'S' }],
        analyzeTranscript: async ({ transcript, onProvenance }) => {
          seenTranscript = transcript;
          onProvenance?.({ model: 'gemini-3.8-flash', promptVersion: 'abc123' });
          return analysisOutput;
        },
      }),
      now: () => T0 + 3,
    });

    await pipeline.run('m-1');

    expect(seenTranscript[0].text).toBe('訂正後的開場');
    expect(store.getTranscript('m-1')!.segments[0].text).toBe('原始開場'); // raw 不受影響
    const provenance = store.getAnalysisProvenance('m-1')!;
    expect(provenance.source_kind).toBe('edited');
    expect(provenance.source_edit_version).toBe(1);
  });

  it('分析 job 的 payload 釘住 enqueue 當下的版本，執行時就算又多了新編輯也不會偷偷換版本（Codex adversarial review 抓到）', async () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '原始開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    // enqueue 當下：第一版編輯存在，payload 釘住 edit_version=1
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 3, text: '第一版訂正', speaker: 'S' }] }, T0 + 2);
    const pinnedPayload = { source_kind: 'edited' as const, source_edit_version: 1 };
    // 排隊排到一半，使用者又編輯了一次（enqueue 之後才發生）
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 3, text: '第二版訂正（enqueue 之後才發生）', speaker: 'S' }] }, T0 + 3);

    let seenTranscript: TranscriptSegment[] = [];
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30),
      gemini: fakeGemini({
        analyzeTranscript: async ({ transcript, onProvenance }) => {
          seenTranscript = transcript;
          onProvenance?.({ model: 'gemini-3.8-flash', promptVersion: 'abc123' });
          return analysisOutput;
        },
      }),
      now: () => T0 + 4,
    });

    await pipeline.runAnalysisPhase('m-1', pinnedPayload);

    // 讀到的是 enqueue 當下釘住的第一版，不是執行當下已經存在的第二版
    expect(seenTranscript[0].text).toBe('第一版訂正');
    const provenance = store.getAnalysisProvenance('m-1')!;
    expect(provenance.source_edit_version).toBe(1);
  });

  it('沒有 payload（run() 那種舊呼叫端）時沿用即時讀取，行為不變', async () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '原始開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 3, text: '最新版本', speaker: 'S' }] }, T0 + 2);

    let seenTranscript: TranscriptSegment[] = [];
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30),
      gemini: fakeGemini({
        analyzeTranscript: async ({ transcript }) => { seenTranscript = transcript; return analysisOutput; },
      }),
      now: () => T0 + 3,
    });

    await pipeline.runAnalysisPhase('m-1'); // 沒帶 payload

    expect(seenTranscript[0].text).toBe('最新版本');
  });

  it('payload 釘住的 edit_version 已經不存在時直接拋錯，不悄悄退回別的版本', async () => {
    newMeeting();
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '原始開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30), gemini: fakeGemini(),
      now: () => T0 + 2,
    });

    // edit_version=1 從來沒存在過（沒有任何 updateTranscript 呼叫過）
    await expect(pipeline.runAnalysisPhase('m-1', { source_kind: 'edited', source_edit_version: 1 }))
      .rejects.toThrow(/找不到 edit_version 1/);
  });
});

describe('run：接縫報告落地', () => {
  // 每片回一段真的無關的內容 → 每個接縫都對不上 → 每個接縫都是破洞。
  // 內容必須實際不同，不能只差一個編號：「第 0 個主題」對「第 1 個主題」的 bigram 相似度是 0.93，
  // 那是公式化字串的天生問題（第一版 fixture 就是這樣寫壞的）
  const DISJOINT_TEXTS = [
    '關於報價的部分，我們決定沿用去年的級距，下週把試算表寄給客戶確認。',
    '倉儲那邊反映棧板不夠用，採購說最快也要到月底才補得到貨。',
    '招募的進度目前卡在第二輪面談，人資希望我們把時間壓在兩週內。',
  ];
  const disjointGemini = (): GeminiServerClient => fakeGemini({
    transcribeSlice: async ({ offsetSeconds = 0 }) => {
      // 破洞會觸發修復，而修復的橋接窗 offset 不會落在切片起點上。
      // 不明寫這一條的話 DISJOINT_TEXTS[0.8] 會是 undefined，測試靠一個 undefined 在跑
      const index = offsetSeconds / 600;
      const text = Number.isInteger(index)
        ? DISJOINT_TEXTS[index]
        : '橋接窗轉出來的東西跟兩邊都接不上,這場會補不回來。';
      return [{ start: offsetSeconds, end: offsetSeconds + 60, text, speaker: 'Speaker 1' }];
    },
  });

  it('接不起來的接縫記進 seam_report，逐字稿照樣全收（不吞內容）', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: disjointGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const report = store.getSeamReport('m-1');
    expect(report).not.toBeNull();
    // 三片有兩個接縫，第 0 片沒有接縫所以不在報告裡
    expect(report!.map(e => e.sliceIndex)).toEqual([1, 2]);
    expect(report!.every(e => e.verdict === 'gap')).toBe(true);
    expect(report!.every(e => e.droppedSegments === 0)).toBe(true);
    // 破洞不代表丟內容：三片的內容一段都不能少
    expect(store.getTranscript('m-1')!.segments).toHaveLength(3);
  });

  it('接得上的接縫記成 duplicate，並寫出丟了幾段', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: overlappingGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const report = store.getSeamReport('m-1')!;
    expect(report.map(e => e.sliceIndex)).toEqual([1, 2]);
    expect(report.every(e => e.verdict === 'duplicate')).toBe(true);
    expect(report.every(e => e.droppedSegments > 0)).toBe(true);
  });
});

describe('run：破洞修復（W2-2b）', () => {
  const A_TAIL = '那排程這件事情就先這樣,之後每一組自己排自己的批次。';
  const A_TAIL_RETAKE = '那排程這件事就先這樣,以後每一組自己排自己的批次。';
  const MISSING = '至於權限要怎麼開,資訊部說要走正式的申請單,我下週跟他們確認。';
  const B_HEAD = '那倉儲那邊呢,棧板的數量從上個月開始就一直不夠用。';
  const B_HEAD_RETAKE = '那倉儲那邊呢,棧板數量從上個月開始就一直不夠用。';

  /**
   * 兩片內容不相干（＝破洞）；橋接窗回得出兩端都錨得住的內容。
   *
   * 用**呼叫順序**分辨切片本體與橋接窗，不要用 offset 或 duration：最後一片只有 200 秒、
   * 而最大的橋接窗夾回檔頭之後 offset 與長度都跟第一片一樣，兩種都會撞在一起
   * （第一版 fixture 就是這樣寫壞的，把第二片本體當成橋接餵回去，接縫直接變 duplicate）
   */
  const gappyGemini = (repairable: boolean, calls: number[] = []): GeminiServerClient => {
    let n = 0;
    return fakeGemini({
      transcribeSlice: async ({ offsetSeconds = 0 }) => {
        calls.push(offsetSeconds);
        n += 1;
        if (n === 1) return [seg(0, 60, '先講第一件事情,關於這季的排程調整。'), seg(60, 120, A_TAIL)];
        if (n === 2) {
          return [
            seg(offsetSeconds, offsetSeconds + 8, B_HEAD),
            seg(offsetSeconds + 8, offsetSeconds + 20, '採購說最快也要月底才補得到貨。'),
          ];
        }
        if (!repairable) return [seg(offsetSeconds, offsetSeconds + 10, '完全不相干的一段話,跟兩邊都接不上。')];
        return [
          seg(offsetSeconds, offsetSeconds + 8, A_TAIL_RETAKE),
          seg(offsetSeconds + 10, offsetSeconds + 20, MISSING),
          seg(SLICE_DURATION_SECONDS, SLICE_DURATION_SECONDS + 8, B_HEAD_RETAKE),
        ];
      },
    });
  };

  const seg = (start: number, end: number, text: string) => ({ start, end, text, speaker: 'Speaker 1' });

  const runWith = async (gemini: GeminiServerClient, seamRepair?: { enabled: boolean; budget: number }) => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS + 200),
      gemini,
      seamRepair,
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');
    return { report: store.getSeamReport('m-1')!, texts: store.getTranscript('m-1')!.segments.map(s => s.text) };
  };

  it('補得回來時把缺的內容接進逐字稿，並記成 repaired', async () => {
    const calls: number[] = [];
    const { report, texts } = await runWith(gappyGemini(true, calls));

    expect(report[0].verdict).toBe('gap');
    expect(report[0].repair?.outcome).toBe('repaired');
    expect(report[0].repair!.attempts).toBeGreaterThan(0);
    expect(report[0].repair!.bridgeSeconds).toBeGreaterThan(0);
    // 缺的那段真的進了逐字稿
    expect(texts).toContain(MISSING);
    // 橋接重轉的兩端不能變成第二份
    expect(texts).not.toContain(A_TAIL_RETAKE);
    expect(texts.filter(t => t === B_HEAD || t === B_HEAD_RETAKE)).toHaveLength(1);
    // 額外的轉錄確實送出去了（切片兩次 ＋ 橋接至少一次）
    expect(calls.length).toBeGreaterThan(2);
  });

  it('橋接窗也切 FLAC、mimeType 是 audio/flac，跟切片本體同一種格式（AC-5）', async () => {
    const inner = gappyGemini(true);
    const mimeTypes: (string | undefined)[] = [];
    const formats: string[] = [];
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS + 200, async (_path, _start, _duration, format) => {
        formats.push(format);
        return toneWav();
      }),
      gemini: { ...inner, transcribeSlice: (input) => { mimeTypes.push(input.mimeType); return inner.transcribeSlice(input); } },
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');

    expect(store.getSeamReport('m-1')![0].repair?.outcome).toBe('repaired');
    // 切片兩次 ＋ 橋接至少一次
    expect(mimeTypes.length).toBeGreaterThan(2);
    expect(mimeTypes.every(m => m === 'audio/flac')).toBe(true);
    // 第一個是量音量的 WAV，其餘全是送 Gemini 的 FLAC
    expect(formats[0]).toBe('wav');
    expect(formats.slice(1).length).toBe(mimeTypes.length);
    expect(formats.slice(1).every(f => f === 'flac')).toBe(true);
  });

  it('補不回來時記成 failed，而且不把接不上的橋接塞進逐字稿', async () => {
    const { report, texts } = await runWith(gappyGemini(false));

    expect(report[0].repair?.outcome).toBe('failed');
    expect(report[0].repair!.attempts).toBe(3);
    expect(texts).not.toContain('完全不相干的一段話,跟兩邊都接不上。');
    // 兩片的內容一段都不能少
    expect(texts).toContain(A_TAIL);
    expect(texts).toContain(B_HEAD);
  });

  it('額度跨接縫共用：第一個破洞吃光之後，第二個記成 skipped 而不是 failed', async () => {
    // skipped 與 failed 不可混為一談：failed 是「試過補不回來」，skipped 是「還不知道有沒有缺」
    newMeeting();
    const seen = new Map<number, number>();
    const calls: number[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0 }) => {
          calls.push(offsetSeconds);
          const nth = (seen.get(offsetSeconds) ?? 0) + 1;
          seen.set(offsetSeconds, nth);
          // 第一次碰到某個切片起點＝切片本體，其餘（含同一個 offset 的第二次）都是橋接
          const isSliceBody = nth === 1 && offsetSeconds % SLICE_DURATION_SECONDS === 0;
          if (isSliceBody) {
            // 三段內容必須真的不同。差一個字的公式化字串 bigram 相似度會到 0.9 以上，
            // 接縫全部變成 duplicate，測不到破洞（這個坑這一包踩了三次）
            const bodies = [
              '先講第一件事情,關於這季的排程調整,每一組自己排自己的批次就好。',
              '那倉儲那邊呢,棧板的數量從上個月開始就一直不夠用,採購說要等到月底。',
              '招募的進度目前卡在第二輪面談,人資希望我們把時間壓在兩週以內。',
            ];
            return [seg(offsetSeconds, offsetSeconds + 60, bodies[offsetSeconds / SLICE_DURATION_SECONDS])];
          }
          return [seg(offsetSeconds, offsetSeconds + 10, '橋接也接不上任何一邊的內容。')];
        },
      }),
      seamRepair: { enabled: true, budget: 3 },
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const report = store.getSeamReport('m-1')!;
    expect(report.map(e => e.verdict)).toEqual(['gap', 'gap']);
    expect(report[0].repair).toEqual({ outcome: 'failed', attempts: 3 });
    expect(report[1].repair).toEqual({ outcome: 'skipped', attempts: 0 });
    // 三片本體 ＋ 第一個破洞的三次橋接，第二個破洞一次都沒送
    expect(calls).toHaveLength(6);
  });

  it('關掉修復時一次都不送，記成 skipped', async () => {
    const calls: number[] = [];
    const { report } = await runWith(gappyGemini(true, calls), { enabled: false, budget: 6 });

    expect(report[0].repair?.outcome).toBe('skipped');
    expect(report[0].repair!.attempts).toBe(0);
    // 只有兩片本體，沒有橋接
    expect(calls).toHaveLength(2);
  });

  it('接得上的接縫不送任何額外轉錄：修復只為破洞付錢', async () => {
    newMeeting();
    const calls: number[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, sliceDurationSeconds = 0 }) => {
          calls.push(offsetSeconds);
          const out = [];
          for (let t = 0; t < sliceDurationSeconds; t += 10) {
            out.push({ start: offsetSeconds + t, end: offsetSeconds + t + 10, text: `${offsetSeconds + t}s 開始的內容`, speaker: 'Speaker 1' });
          }
          return out;
        },
      }),
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');

    expect(store.getSeamReport('m-1')!.every(e => e.verdict === 'duplicate')).toBe(true);
    expect(store.getSeamReport('m-1')!.every(e => e.repair === undefined)).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

describe('run：多片合併（overlap 去重）', () => {
  it('每片都回含 overlap 的完整內容時，合併結果沒有缺口、時間不倒退、接縫重複有界', async () => {
    newMeeting();
    const seen: { offsetSeconds: number; previousContext: string }[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: overlappingGemini(seen),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const segments = store.getTranscript('m-1')!.segments;
    expect(seen.map(s => s.offsetSeconds)).toEqual([0, 600, 1200]);
    expect(segments.length).toBeGreaterThan(0);

    // 從頭到尾連續覆蓋：第一段從 0 開始，最後一段收在總長度
    expect(segments[0].start).toBe(0);
    expect(segments[segments.length - 1].end).toBe(THREE_SLICE_DURATION);

    for (let i = 1; i < segments.length; i += 1) {
      const prev = segments[i - 1];
      const curr = segments[i];
      // 不倒退：去重壞掉（例如 isFirstSlice 恆真）時，第二片的開頭會跳回 overlap 之前
      expect(curr.start).toBeGreaterThanOrEqual(prev.start);
      // 不缺口：下一段的開始不能晚於上一段的結束，否則中間那幾秒的內容被丟掉了
      expect(curr.start).toBeLessThanOrEqual(prev.end);
      // 接縫的重複要落在 overlap 的容忍範圍內
      expect(prev.end - curr.start).toBeLessThanOrEqual(SLICE_OVERLAP_SECONDS);
      expect(curr.end).toBeGreaterThanOrEqual(curr.start);
    }
  });

  it('同一秒的內容不會被重複收太多次：overlap 區只留一段接縫', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: overlappingGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    const segments = store.getTranscript('m-1')!.segments;
    // 每一秒被幾段涵蓋。去重完全失效時，overlap 那 15 秒會被兩片各蓋一次以上
    const coverage = new Map<number, number>();
    for (const seg of segments) {
      for (let t = Math.floor(seg.start); t < Math.ceil(seg.end); t += 1) {
        coverage.set(t, (coverage.get(t) ?? 0) + 1);
      }
    }
    const doubled = [...coverage.entries()].filter(([, n]) => n > 1).map(([t]) => t);
    // 接縫本來就允許幾秒重疊（寧可重疊不可掉字），但兩個接縫加起來也不該超過一個 overlap 區。
    // 去重完全失效時這裡會是 30（兩片各把整個 overlap 區重收一次）
    expect(doubled.length).toBeLessThanOrEqual(SLICE_OVERLAP_SECONDS);
    expect(coverage.get(600)).toBe(1);
    // 每一秒都有人涵蓋，一秒都沒漏
    expect(coverage.size).toBe(THREE_SLICE_DURATION);
  });
});

describe('run：失敗', () => {
  it('轉錄中途失敗時狀態是 FAILED 帶原因，而且音檔還在', async () => {
    newMeeting();
    const present = new Set(['m-1']);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(present),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0 }) => {
          if (offsetSeconds === 600) throw new Error('Gemini 回 500');
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('Gemini 回 500');

    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('FAILED');
    expect(meeting?.error).toBe('Gemini 回 500');
    // 音檔保留供重試，第一片的成果也留著，重跑時從第二片繼續
    expect(present.has('m-1')).toBe(true);
    expect(meeting?.processed_slices).toBe(1);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('直接呼叫 runTranscriptionPhase 失敗時不自動轉 FAILED，meeting 留在 TRANSCRIBING 可以重試', async () => {
    // 給 job-based worker 用的介面（vault plan「MeetPilot · 轉錄分析佇列架構升級」）：
    // job 重試次數還沒用盡時，meeting 要留在可重入的狀態，不能被單次失敗就轉成終態 FAILED
    newMeeting();
    let attempts = 0;
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0 }) => {
          attempts += 1;
          if (attempts === 1) throw new Error('第一次轉錄失敗');
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: '內容', speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await expect(pipeline.runTranscriptionPhase('m-1')).rejects.toThrow('第一次轉錄失敗');
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBING');
    expect(store.getMeeting('m-1')?.error).toBeNull();

    // 重試：直接再呼叫一次，不用重新走 run()
    await pipeline.runTranscriptionPhase('m-1');
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBED');
    expect(attempts).toBe(2);
  });

  it('markTranscriptionFailed 給 worker 在 job 重試次數用盡時呼叫，把 meeting 轉成真正的 FAILED', () => {
    newMeeting();
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30), gemini: fakeGemini(),
    });

    pipeline.markTranscriptionFailed('m-1', '重試三次都失敗');

    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('FAILED');
    expect(meeting?.error).toBe('重試三次都失敗');
  });

  it('run() 呼叫在已完成的會（READY）上只拋錯，不會把它改寫成 FAILED', async () => {
    // 這條釘住一個真的踩過的迴歸：run() 的失敗處理不能連呼叫端傳錯狀態都一起接住，
    // 那會把一場已經 READY 的會覆寫成 FAILED
    newMeeting();
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30), gemini: fakeGemini(),
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');
    expect(store.getMeeting('m-1')?.status).toBe('READY');

    await expect(pipeline.run('m-1')).rejects.toThrow(/目前是 READY/);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });

  it('分析失敗時退回 TRANSCRIBED（不是 FAILED），音檔還在、逐字稿留著，可以重跑分析', async () => {
    // vault plan「MeetPilot · 轉錄分析佇列架構升級」的狀態機：分析失敗不連坐已經成功的
    // 轉錄結果，退回 TRANSCRIBED 而不是全場 FAILED。error 訊息不記在 meetings.error——
    // TRANSCRIBED 不是 FAILED／LINK_FAILED，setStatus 只在那兩個狀態保留 error 欄位
    newMeeting();
    const present = new Set(['m-1']);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(present),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({ analyzeTranscript: async () => { throw new Error('分析逾時'); } }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('分析逾時');
    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'TRANSCRIBED']);
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBED');
    expect(store.getMeeting('m-1')?.error).toBeNull();
    expect(present.has('m-1')).toBe(true);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('分析失敗退回 TRANSCRIBED 之後，重跑分析階段不用重新轉錄就能成功', async () => {
    newMeeting();
    let attempts = 0;
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({
        analyzeTranscript: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('第一次分析逾時');
          return analysisOutput;
        },
      }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('第一次分析逾時');
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBED');

    // 只重跑分析階段，不經過 runTranscriptionPhase：這正是拆兩條 queue 之後想要的效果
    await pipeline.runAnalysisPhase('m-1');

    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(attempts).toBe(2);
  });

  it('每一片都沒轉出內容時擋在分析前面，不送空逐字稿去生一份憑空的摘要，退回 TRANSCRIBED', async () => {
    newMeeting();
    const analyzeTranscript = vi.fn(async () => analysisOutput);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({ transcribeSlice: async () => [], analyzeTranscript }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/每一片都沒有轉出內容/);
    expect(analyzeTranscript).not.toHaveBeenCalled();
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBED');
  });

  it('音檔不在時直接 FAILED，不會去呼叫 ffprobe', async () => {
    newMeeting();
    const probeDurationRemuxingIfMissing = vi.fn(async () => THREE_SLICE_DURATION);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set()),
      slicer: { probeDurationRemuxingIfMissing, readSlice: async () => Buffer.from('x') },
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/音檔不在/);
    expect(probeDurationRemuxingIfMissing).not.toHaveBeenCalled();
    expect(store.getMeeting('m-1')?.status).toBe('FAILED');
  });

  it('分析成功後刪音檔失敗時只記 log，不把一場成功的會標成 FAILED', async () => {
    newMeeting();
    const audioStore = fakeAudioStore(new Set(['m-1']));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = pipelineWith({
      store,
      audioStore: {
        ...audioStore,
        remove: () => { throw new Error('EBUSY: resource busy or locked'); },
      },
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(store.getMeeting('m-1')?.error).toBeNull();
    expect(store.getAnalysis('m-1')).not.toBeNull();
    expect(String(errors.mock.calls[0][0])).toMatch(/音檔刪不掉/);
    errors.mockRestore();
  });

  it('已經跑完的會不給重跑，不覆蓋既有結果', async () => {
    newMeeting();
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 2);
    store.setStatus('m-1', 'ANALYZING', T0 + 2);
    store.setStatus('m-1', 'READY', T0 + 3);
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(600), gemini: fakeGemini(),
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/目前是 READY/);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });
});

describe('run：續傳', () => {
  it('從 processed_slices = 2 起跑時前兩片不會再送 Gemini，也不會再切一次', async () => {
    newMeeting();
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.saveTranscriptProgress(
      'm-1',
      { segments: [{ start: 0, end: 30, text: '片段 0', speaker: 'S' }], polished_content: null },
      2,
      3,
      T0 + 2,
    );

    const sliced: number[] = [];
    const offsets: number[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION, async (_path, start) => {
        sliced.push(start);
        return Buffer.from('wav');
      }),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0 }) => {
          offsets.push(offsetSeconds);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 3,
    });

    // 準備階段自己那次 setStatus 不算進驗收
    statuses.length = 0;
    await pipeline.run('m-1');

    expect(offsets).toEqual([1200]);
    expect(sliced).toEqual([1200]);
    // 續傳不重走 CREATED → TRANSCRIBING，它已經在 TRANSCRIBING 了
    expect(statuses).toEqual(['TRANSCRIBED', 'ANALYZING', 'READY']);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(2);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(3);
  });
});

describe('轉錄前擋掉整支沒有聲音的音檔', () => {
  it('每一片都沒聲音 → 不送 Gemini，這場會 FAILED 並講原因', async () => {
    newMeeting();
    const transcribeSlice = vi.fn(fakeGemini().transcribeSlice);
    const sliced: number[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION, async (_path, start) => { sliced.push(start); return silentWav(); }),
      gemini: fakeGemini({ transcribeSlice }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/幾乎沒有聲音/);
    expect(transcribeSlice).not.toHaveBeenCalled();
    expect(sliced).toEqual([0, 600, 1200]);
    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('FAILED');
    expect(meeting?.error).toContain('完全是 0');
    expect(meeting?.error).toContain('麥克風');
    expect(store.getTranscript('m-1')).toBeNull();
  });

  it('切出來的不是 WAV（上游壞了）→ 拋、不送 Gemini，不當成有聲音放行', async () => {
    newMeeting();
    const transcribeSlice = vi.fn(fakeGemini().transcribeSlice);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION, async () => Buffer.from('not a wav')),
      gemini: fakeGemini({ transcribeSlice }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/不是 WAV/);
    expect(transcribeSlice).not.toHaveBeenCalled();
    expect(store.getMeeting('m-1')?.status).toBe('FAILED');
  });

  it('第一片沒聲音、後面有 → 照常轉錄每一片，每片送的是自己那段音訊（會議開頭安靜是正常的）', async () => {
    newMeeting();
    const sent: { offset: number; data: string }[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION, async (_path, start) => (start === 0 ? silentWav() : toneWav())),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, base64Data = '' }) => {
          sent.push({ offset: offsetSeconds, data: base64Data });
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(sent.map((s) => s.offset)).toEqual([0, 600, 1200]);
    // 量音量時在第二片才找到聲音，不能把第二片的音訊當成第一片送出去
    expect(sent[0].data).toBe(silentWav().toString('base64'));
    expect(sent[1].data).toBe(toneWav().toString('base64'));
    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });

  it('第一片就有聲音 → 量音量切 WAV、找到聲音就停；送 Gemini 的每一片另切 FLAC、mimeType 是 audio/flac（AC-5）', async () => {
    newMeeting();
    const sliced: string[] = [];
    const mimeTypes: (string | undefined)[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION, async (_path, start, _duration, format) => {
        sliced.push(`${start}:${format}`);
        return toneWav();
      }),
      gemini: fakeGemini({
        transcribeSlice: async ({ offsetSeconds = 0, mimeType }) => {
          mimeTypes.push(mimeType);
          return [{ start: offsetSeconds, end: offsetSeconds + 30, text: `片段 ${offsetSeconds}`, speaker: 'S' }];
        },
      }),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    // wavLevel 只讀得懂 WAV，所以量音量那一片不能沿用成送出去的那一片
    expect(sliced).toEqual(['0:wav', '0:flac', '600:flac', '1200:flac']);
    expect(mimeTypes).toEqual(['audio/flac', 'audio/flac', 'audio/flac']);
  });
});

describe('backfillInterruptedMeetings', () => {
  const jobsFor = () => createJobStore(db);

  it('TRANSCRIBING 且音檔還在、沒有 active job 時補一筆轉錄 job', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 2,
    });

    expect(report.transcriptionRequeued).toEqual(['m-1']);
    expect(jobs.hasActive('m-1', 'transcription')).toBe(true);
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBING');
  });

  it('TRANSCRIBING 但音檔不在的轉 FAILED 帶原因，不留在 TRANSCRIBING 假裝還在跑', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set()), now: () => T0 + 2,
    });

    expect(report.transcriptionRequeued).toEqual([]);
    expect(report.failed).toHaveLength(1);
    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('FAILED');
    expect(meeting?.error).toMatch(/音檔已經不在/);
  });

  it('已經有 active 轉錄 job 的不重複補（避免跟正常流程搶著 enqueue 同一場會兩次）', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const jobs = jobsFor();
    jobs.enqueue('m-1', 'transcription', null, T0 + 1);

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 2,
    });

    expect(report.transcriptionRequeued).toEqual([]); // 沒有補第二筆
  });

  it('CREATED ＋ 音檔在 ＋ 游標不為 0 時只入列，不清游標：那可能是 retry 之後還在排隊的會', () => {
    // retry 把狀態設回 CREATED 並保留游標，但佇列正忙時它會停在這個狀態好幾小時。
    // 掃描分不出「剛上傳的新檔」與「排隊中的 retry」，所以一律不清——
    // 清掉的話 retry 會退化成整場重轉，連使用者 retry 前人工修過的逐字稿也一起消失。
    // 新上傳那條路徑的游標是在 PUT audio 收檔之前就清掉的（見 createApp.test.ts）
    newMeeting('m-1');
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 10, text: '人工修正過的內容' }], polished_content: '潤稿' }, 12, 20, T0 + 1,
    );
    const jobs = jobsFor();

    backfillInterruptedMeetings({ store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 2 });

    expect(jobs.hasActive('m-1', 'transcription')).toBe(true);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(12);
    expect(store.getTranscript('m-1')?.segments[0].text).toBe('人工修正過的內容');
  });

  it('CREATED 但音檔不在時留在 CREATED，不轉 FAILED：轉了就是死路，PUT 與 retry 都會被擋', () => {
    newMeeting('m-1');
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set()), now: () => T0 + 2,
    });

    expect(report.transcriptionRequeued).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.waitingForAudio).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.status).toBe('CREATED');
    expect(store.getMeeting('m-1')?.error).toBeNull();
  });

  it('CREATED 且音檔還在的也要續傳：上傳完成但還沒開跑就重啟的那幾場', () => {
    newMeeting('m-1');
    const jobs = jobsFor();

    backfillInterruptedMeetings({ store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 2 });

    expect(jobs.hasActive('m-1', 'transcription')).toBe(true);
  });

  it('ANALYZING 停在半路的補一筆分析 job，並把 meeting 退回 TRANSCRIBED（讓 job 真的跑得動）', () => {
    // Codex adversarial review 抓到的真缺口：原本只 enqueue job，沒退回 TRANSCRIBED，
    // runAnalysisPhase 的前置條件過不了，這種舊資料永遠救不回來
    newMeeting('m-1');
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    store.setStatus('m-1', 'ANALYZING', T0 + 2);
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 3,
    });

    expect(report.analysisRequeued).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBED');
    const job = jobs.claim('analysis', 'w', 60_000, T0 + 4);
    expect(job?.payload).toEqual({ source_kind: 'raw', source_edit_version: null });
  });

  it('backfill 補回來的分析 job 真的執行得完，不會因為前置條件卡死', async () => {
    newMeeting('m-1');
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    store.setStatus('m-1', 'ANALYZING', T0 + 2);
    const jobs = jobsFor();
    backfillInterruptedMeetings({ store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 3 });

    const job = jobs.claim('analysis', 'w', 60_000, T0 + 4)!;
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30), gemini: fakeGemini(),
      now: () => T0 + 5,
    });

    await pipeline.runAnalysisPhase('m-1', job.payload);

    expect(store.getMeeting('m-1')?.status).toBe('READY');
  });

  it('TRANSCRIBED（分析失敗退回來的）也補一筆分析 job，讀到編輯過的版本就帶 edited payload', () => {
    newMeeting('m-1');
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    store.updateTranscript('m-1', { segments: [{ start: 0, end: 3, text: '訂正過的開場', speaker: 'S' }] }, T0 + 2);
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 3,
    });

    expect(report.analysisRequeued).toEqual(['m-1']);
    const job = jobs.claim('analysis', 'w', 60_000, T0 + 4);
    expect(job?.payload).toEqual({ source_kind: 'edited', source_edit_version: 1 });
  });

  it('已經用盡重試轉 failed 的分析 job 不會被 backfill 復活（Codex adversarial review 抓到）', () => {
    // 這是跟上面「已經有 active job 不重複補」同一類保護，但故意驗最容易漏掉的那個情境：
    // job 不是 active（是 failed），如果 backfill 只看 hasActive 會誤判成「沒有 job」
    // 然後每次重啟都重新 enqueue 一個 attempt=0 的新 job，繞過 max_attempts 這個煞車
    newMeeting('m-1');
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    const jobs = jobsFor();
    const jobId = jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0 + 1, 1)!;
    jobs.claim('analysis', 'w', 60_000, T0 + 2);
    expect(jobs.markFailed(jobId, '模擬用盡重試', T0 + 3)).toBe('failed'); // max_attempts=1，一次就用盡

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 4,
    });

    expect(report.analysisRequeued).toEqual([]);
    expect(jobs.hasActive('m-1', 'analysis')).toBe(false); // 沒有偷偷生出新的 active job
  });

  it('已經有 active 分析 job 的不重複補', () => {
    newMeeting('m-1');
    store.saveTranscript('m-1', { segments: [{ start: 0, end: 3, text: '開場', speaker: 'S' }], polished_content: null }, T0);
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-1', 'TRANSCRIBED', T0 + 1);
    const jobs = jobsFor();
    jobs.enqueue('m-1', 'analysis', { source_kind: 'raw', source_edit_version: null }, T0 + 1);

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-1'])), now: () => T0 + 3,
    });

    expect(report.analysisRequeued).toEqual([]);
  });

  it('已經跑完或還沒開始的狀態一律不碰', () => {
    newMeeting('m-ready');
    store.setStatus('m-ready', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-ready', 'TRANSCRIBED', T0 + 2);
    store.setStatus('m-ready', 'ANALYZING', T0 + 2);
    store.setStatus('m-ready', 'READY', T0 + 3);
    newMeeting('m-failed');
    store.setStatus('m-failed', 'FAILED', T0 + 1, '上次就失敗了');
    const jobs = jobsFor();

    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: fakeAudioStore(new Set(['m-ready', 'm-failed'])), now: () => T0 + 4,
    });

    expect(report.transcriptionRequeued).toEqual([]);
    expect(report.analysisRequeued).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(store.getMeeting('m-ready')?.status).toBe('READY');
    expect(store.getMeeting('m-failed')?.error).toBe('上次就失敗了');
  });

  it('meeting_id 不能當檔名時也寫下原因，不讓整個啟動掃描炸掉', () => {
    store.importMigrated([{
      meeting: {
        meeting_id: 'job/怪 id', title: null, status: 'TRANSCRIBING', created_at: T0, updated_at: T0,
        source_file_name: null, source_file_size: null, origin: 'migrated', error: null,
        processed_slices: null, total_slices: null, meeting_context: null,
        topic_extraction_status: null, topic_extraction_error: null,
      },
      transcript: null, analysis: null, tags: [],
    }]);

    const jobs = jobsFor();
    const report = backfillInterruptedMeetings({
      store, jobs, audioStore: createAudioFileStoreStub(), now: () => T0 + 1,
    });

    expect(report.failed[0].reason).toMatch(/無法判斷音檔位置/);
    expect(store.getMeeting('job/怪 id')?.status).toBe('FAILED');
    expect(jobs.hasActive('job/怪 id', 'transcription')).toBe(false);
  });
});

describe('題目標籤（W3）', () => {
  const runOnce = async (gemini: GeminiServerClient) => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini,
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');
  };

  it('分析成功之後抽標籤，而且是在進 READY 之前：READY 的會一定有抽取結果', async () => {
    const statusWhenExtracting: (string | undefined)[] = [];
    await runOnce(fakeGemini({
      extractTopicTags: async () => {
        statusWhenExtracting.push(store.getMeeting('m-1')?.status);
        return [{ title: 'POC 時程', content: '卡在報價' }];
      },
    }));

    expect(statusWhenExtracting).toEqual(['ANALYZING']);
    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'READY']);
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('ok');
    expect(store.getTopicTags('m-1').map(t => t.title)).toEqual(['POC 時程']);
  });

  it('**抽不出標籤不會讓這場會變成 FAILED**：分析已經成功，標成失敗是謊報（Q2 裁決）', async () => {
    await runOnce(fakeGemini({
      extractTopicTags: async () => { throw new Error('模型輸出被截斷'); },
    }));

    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'READY']);
    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('READY');
    expect(meeting?.topic_extraction_status).toBe('failed');
    expect(meeting?.topic_extraction_error).toBe('模型輸出被截斷');
    // 這場會的 error 欄是給狀態機用的，抽標籤失敗不該污染它
    expect(meeting?.error).toBeNull();
  });

  it('一條標籤都沒抽到時是 empty，這場會照樣 READY', async () => {
    await runOnce(fakeGemini({ extractTopicTags: async () => [] }));

    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(store.getMeeting('m-1')?.topic_extraction_status).toBe('empty');
  });
});

// pathFor 會對不合法的 meeting_id 拋錯，與正式的 audioFileStore 同一條規則
const createAudioFileStoreStub = (): AudioFileStore => ({
  dir: '/fake/audio',
  pathFor: (id: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`meeting_id ${JSON.stringify(id)} 不能當成檔名`);
    return `/fake/audio/${id}.audio`;
  },
  exists: () => false,
  tempPathFor: (id: string) => `/fake/audio/${id}_tmp_part`,
  sizeOf: () => 0,
  saveFrom: async () => ({ path: '', bytes: 0 }),
  removePartialUploads: () => [],
  remove: () => {},
  recordingPathFor: (id: string) => `/fake/audio/${id}.recording`,
  appendRecordingChunk: () => { throw new Error('這支測試用不到 app 內錄音'); },
  promoteRecording: () => { throw new Error('這支測試用不到 app 內錄音'); },
  removeRecording: () => {},
});

describe('run：關聯接在 READY 之後（W4）', () => {
  it('關聯排在 READY 且音檔刪掉之後才跑', async () => {
    newMeeting();
    const present = new Set(['m-1']);
    const seen: { status: string; hasAudio: boolean }[] = [];
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(present),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
      topicLinker: {
        link: async (id: string) => {
          seen.push({ status: store.getMeeting(id)!.status, hasAudio: present.has(id) });
          return { status: 'LINKED' as const, links: 0, coverage: {
            candidates: 0, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
        incomparable_pairs: 0, error: null,
          } };
        },
      },
    });

    await pipeline.run('m-1');

    // 音檔已經刪掉、狀態已經是 READY 才輪到關聯：關聯失敗不該讓一場已經可用的會回不去
    expect(seen).toEqual([{ status: 'READY', hasAudio: false }]);
  });

  it('關聯拋出預期外的錯誤時，這場會不會被標成 FAILED（AC-6）', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
      topicLinker: { link: async () => { throw new Error('資料庫寫不進去'); } },
    });

    await expect(pipeline.run('m-1')).resolves.toBeUndefined();

    // 逐字稿與結論都已經落地、音檔已經刪掉，這時標 FAILED 是謊報，而且 retry 會去重跑
    // 一條音檔已經不在的轉錄——那是死路
    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(store.getMeeting('m-1')?.error).toBeNull();
    expect(store.getTranscript('m-1')?.segments.length).toBeGreaterThan(0);
    expect(store.getAnalysis('m-1')).not.toBeNull();
  });

  it('關聯關掉時（linker 是 null）這場會停在 READY，不是 LINK_FAILED', async () => {
    newMeeting();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
      topicLinker: null,
    });

    await pipeline.run('m-1');

    // READY 的意思正是「還沒算關聯」；寫成 LINK_FAILED 會讓畫面出現一個不存在的錯誤，
    // 也會讓 6.1 的關聯成功率指標被人為關閉污染
    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'READY']);
    expect(store.getMeeting('m-1')?.error).toBeNull();
  });
});

describe('run：建議標題', () => {
  const runWith = async (title: string, existingTitle: string | null = null) => {
    store.createMeeting({ meeting_id: 'm-1', created_at: T0, source_file_name: 'a.m4a', source_file_size: 10, title: existingTitle });
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({ analyzeTranscript: async () => ({ ...analysisOutput, title }) }),
      now: () => T0 + 1,
    });
    await pipeline.run('m-1');
  };

  it('分析完成後把模型的建議標題（trim 過）寫進 meeting.title', async () => {
    await runWith('  預算與時程  ');
    expect(store.getMeeting('m-1')?.title).toBe('預算與時程');
  });

  it('已經有標題的會不覆蓋：人改過的名字不能被下一次分析洗掉', async () => {
    await runWith('模型的建議', '我自己取的');
    expect(store.getMeeting('m-1')?.title).toBe('我自己取的');
  });

  it('建議標題不合規則時標題留 null 並 warn，這場會照樣 READY', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runWith('   ');
    expect(store.getMeeting('m-1')?.title).toBeNull();
    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('建議標題不可用'));
    warn.mockRestore();
  });
});

describe('診斷 log 跟著會議記錄出去', () => {
  // 假的 exporter：只記「在哪個狀態、第幾步被叫」。真的檔案 I/O 在 diagnosticsExport.test.ts 驗
  const recorder = (order: string[] = []) => {
    const calls: { meetingId: string; status: string | null }[] = [];
    const exporter: Pick<DiagnosticsExporter, 'dir' | 'schedule'> = {
      dir: '/fake/vault/_診斷',
      schedule: (meetingId, status) => {
        order.push('diagnostics');
        calls.push({ meetingId, status });
      },
    };
    return { calls, exporter };
  };

  it('整場跑完：投影之後匯出一次，帶的是當下的狀態', async () => {
    newMeeting();
    const order: string[] = [];
    const { calls, exporter } = recorder(order);
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
      topicLinker: null,
      vaultProjector: { project: () => { order.push('project'); return { status: 'written' as const, path: '/fake/vault/a.md' }; } } as unknown as VaultProjector,
      diagnostics: exporter,
    });

    await pipeline.run('m-1');

    expect(calls).toEqual([{ meetingId: 'm-1', status: 'READY' }]);
    expect(order).toEqual(['project', 'diagnostics']);
  });

  it('轉錄失敗轉 FAILED 時也匯出：失敗的會不會投影，只跟著投影走就收不到最需要看的 log', async () => {
    newMeeting();
    const { calls, exporter } = recorder();
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({ transcribeSlice: async () => { throw new Error('fetch failed'); } }),
      now: () => T0 + 1,
      diagnostics: exporter,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('fetch failed');

    expect(calls).toEqual([{ meetingId: 'm-1', status: 'FAILED' }]);
  });

  it('worker 重試用盡呼叫 markTranscriptionFailed 時也匯出', () => {
    newMeeting();
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const { calls, exporter } = recorder();
    const pipeline = pipelineWith({
      store, audioStore: fakeAudioStore(new Set(['m-1'])), slicer: fakeSlicer(30), gemini: fakeGemini(), diagnostics: exporter,
    });

    pipeline.markTranscriptionFailed('m-1', '重試三次都失敗');

    expect(calls).toEqual([{ meetingId: 'm-1', status: 'FAILED' }]);
  });

  it('分析失敗退回 TRANSCRIBED 時也匯出', async () => {
    newMeeting();
    const { calls, exporter } = recorder();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini({ analyzeTranscript: async () => { throw new Error('分析逾時'); } }),
      now: () => T0 + 1,
      diagnostics: exporter,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('分析逾時');

    expect(calls).toEqual([{ meetingId: 'm-1', status: 'TRANSCRIBED' }]);
    error.mockRestore();
  });

  it('排匯出拋錯時這場會照樣 READY，只記一行 log', async () => {
    newMeeting();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = pipelineWith({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
      topicLinker: null,
      diagnostics: { dir: '/fake/vault/_診斷', schedule: () => { throw new Error('排程失敗'); } },
    });

    await expect(pipeline.run('m-1')).resolves.toBeUndefined();

    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(statuses).toEqual(['TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'READY']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/fake/vault/_診斷'), expect.any(Error));
    error.mockRestore();
  });
});

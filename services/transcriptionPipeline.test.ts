import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GeminiOutput, TranscriptSegment } from '../types';
import { AudioFileStore } from './audioFileStore';
import { AudioSlicer } from './audioSlicer';
import { GeminiServerClient } from './geminiServerClient';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { SLICE_OVERLAP_SECONDS } from './transcriptMerge';
import {
  SLICE_DURATION_SECONDS,
  buildPreviousContext,
  createTranscriptionPipeline,
  requeueInterruptedMeetings,
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
  sizeOf: () => 1024,
  saveFrom: async (id: string) => { present.add(id); return { path: `/fake/audio/${id}.audio`, bytes: 1024 }; },
  removePartialUploads: () => [],
  remove: (id: string) => { present.delete(id); },
});

const fakeSlicer = (durationSeconds: number, readSlice?: AudioSlicer['readSlice']): AudioSlicer => ({
  probeDurationSeconds: async () => durationSeconds,
  readSlice: readSlice ?? (async (_path, start) => Buffer.from(`wav@${start}`)),
});

const analysis: GeminiOutput = {
  overview: '一句話主旨',
  topics: [{ title: '議題 A', content: '內容' }],
  decisions: ['決定 A'],
  action_items: ['待辦 A'],
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
  polishTranscript: async () => '潤過的',
  analyzeTranscript: async () => analysis,
  ...overrides,
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
    const pipeline = createTranscriptionPipeline({
      store,
      audioStore: { ...audioStore, remove: (id: string) => { removedAt.push(store.getMeeting(id)!.status); audioStore.remove(id); } },
      slicer: fakeSlicer(THREE_SLICE_DURATION),
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await pipeline.run('m-1');

    expect(statuses).toEqual(['TRANSCRIBING', 'ANALYZING', 'READY']);
    expect(store.getMeeting('m-1')?.status).toBe('READY');
    expect(present.has('m-1')).toBe(false);
    // 刪檔發生在 READY 之後：轉錄成功就刪的話，分析失敗的那場會再也重跑不了
    expect(removedAt).toEqual(['READY']);
  });

  it('三片都送給 Gemini，逐字稿與進度一起落地', async () => {
    newMeeting();
    const offsets: number[] = [];
    const pipeline = createTranscriptionPipeline({
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
    const pipeline = createTranscriptionPipeline({
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
    transcribeSlice: async ({ offsetSeconds = 0 }) => [{
      start: offsetSeconds,
      end: offsetSeconds + 60,
      text: DISJOINT_TEXTS[offsetSeconds / 600],
      speaker: 'Speaker 1',
    }],
  });

  it('接不起來的接縫記進 seam_report，逐字稿照樣全收（不吞內容）', async () => {
    newMeeting();
    const pipeline = createTranscriptionPipeline({
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
    const pipeline = createTranscriptionPipeline({
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

describe('run：多片合併（overlap 去重）', () => {
  it('每片都回含 overlap 的完整內容時，合併結果沒有缺口、時間不倒退、接縫重複有界', async () => {
    newMeeting();
    const seen: { offsetSeconds: number; previousContext: string }[] = [];
    const pipeline = createTranscriptionPipeline({
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
    const pipeline = createTranscriptionPipeline({
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
    const pipeline = createTranscriptionPipeline({
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

  it('分析失敗時一樣 FAILED 且音檔還在，逐字稿留著', async () => {
    newMeeting();
    const present = new Set(['m-1']);
    const pipeline = createTranscriptionPipeline({
      store,
      audioStore: fakeAudioStore(present),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({ analyzeTranscript: async () => { throw new Error('分析逾時'); } }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow('分析逾時');
    expect(statuses).toEqual(['TRANSCRIBING', 'ANALYZING', 'FAILED']);
    expect(store.getMeeting('m-1')?.error).toBe('分析逾時');
    expect(present.has('m-1')).toBe(true);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('每一片都沒轉出內容時擋在分析前面，不送空逐字稿去生一份憑空的摘要', async () => {
    newMeeting();
    const analyzeTranscript = vi.fn(async () => analysis);
    const pipeline = createTranscriptionPipeline({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      slicer: fakeSlicer(SLICE_DURATION_SECONDS),
      gemini: fakeGemini({ transcribeSlice: async () => [], analyzeTranscript }),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/每一片都沒有轉出內容/);
    expect(analyzeTranscript).not.toHaveBeenCalled();
    expect(store.getMeeting('m-1')?.status).toBe('FAILED');
  });

  it('音檔不在時直接 FAILED，不會去呼叫 ffprobe', async () => {
    newMeeting();
    const probeDurationSeconds = vi.fn(async () => THREE_SLICE_DURATION);
    const pipeline = createTranscriptionPipeline({
      store,
      audioStore: fakeAudioStore(new Set()),
      slicer: { probeDurationSeconds, readSlice: async () => Buffer.from('x') },
      gemini: fakeGemini(),
      now: () => T0 + 1,
    });

    await expect(pipeline.run('m-1')).rejects.toThrow(/音檔不在/);
    expect(probeDurationSeconds).not.toHaveBeenCalled();
    expect(store.getMeeting('m-1')?.status).toBe('FAILED');
  });

  it('分析成功後刪音檔失敗時只記 log，不把一場成功的會標成 FAILED', async () => {
    newMeeting();
    const audioStore = fakeAudioStore(new Set(['m-1']));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = createTranscriptionPipeline({
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
    store.setStatus('m-1', 'ANALYZING', T0 + 2);
    store.setStatus('m-1', 'READY', T0 + 3);
    const pipeline = createTranscriptionPipeline({
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
    const pipeline = createTranscriptionPipeline({
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
    expect(statuses).toEqual(['ANALYZING', 'READY']);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(2);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(3);
  });
});

describe('requeueInterruptedMeetings', () => {
  it('TRANSCRIBING 且音檔還在的重新入列', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const enqueued: string[] = [];

    const report = requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 2,
    });

    expect(enqueued).toEqual(['m-1']);
    expect(report.requeued).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.status).toBe('TRANSCRIBING');
  });

  it('TRANSCRIBING 但音檔不在的轉 FAILED 帶原因，不留在 TRANSCRIBING 假裝還在跑', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    const enqueued: string[] = [];

    const report = requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set()),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 2,
    });

    expect(enqueued).toEqual([]);
    expect(report.failed).toHaveLength(1);
    const meeting = store.getMeeting('m-1');
    expect(meeting?.status).toBe('FAILED');
    expect(meeting?.error).toMatch(/音檔已經不在/);
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
    const enqueued: string[] = [];

    requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 2,
    });

    expect(enqueued).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(12);
    expect(store.getTranscript('m-1')?.segments[0].text).toBe('人工修正過的內容');
  });

  it('TRANSCRIBING ＋ 音檔在時不歸零：那是真正的續傳，游標要留著', () => {
    newMeeting('m-1');
    store.setStatus('m-1', 'TRANSCRIBING', T0 + 1);
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 10, text: '第一片' }], polished_content: null }, 1, 3, T0 + 2,
    );
    const enqueued: string[] = [];

    requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 3,
    });

    expect(enqueued).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.processed_slices).toBe(1);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('CREATED 但音檔不在時留在 CREATED，不轉 FAILED：轉了就是死路，PUT 與 retry 都會被擋', () => {
    newMeeting('m-1');
    const enqueued: string[] = [];

    const report = requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set()),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 2,
    });

    expect(enqueued).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.waitingForAudio).toEqual(['m-1']);
    expect(store.getMeeting('m-1')?.status).toBe('CREATED');
    expect(store.getMeeting('m-1')?.error).toBeNull();
  });

  it('CREATED 且音檔還在的也要續傳：上傳完成但還沒開跑就重啟的那幾場', () => {
    newMeeting('m-1');
    const enqueued: string[] = [];

    requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set(['m-1'])),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 2,
    });

    expect(enqueued).toEqual(['m-1']);
  });

  it('已經跑完或還沒開始的狀態一律不碰', () => {
    newMeeting('m-ready');
    store.setStatus('m-ready', 'TRANSCRIBING', T0 + 1);
    store.setStatus('m-ready', 'ANALYZING', T0 + 2);
    store.setStatus('m-ready', 'READY', T0 + 3);
    newMeeting('m-failed');
    store.setStatus('m-failed', 'FAILED', T0 + 1, '上次就失敗了');
    const enqueued: string[] = [];

    const report = requeueInterruptedMeetings({
      store,
      audioStore: fakeAudioStore(new Set(['m-ready', 'm-failed'])),
      enqueue: (id) => enqueued.push(id),
      now: () => T0 + 4,
    });

    expect(enqueued).toEqual([]);
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
      },
      transcript: null, analysis: null, tags: [],
    }]);

    const realStore = createAudioFileStoreStub();
    const report = requeueInterruptedMeetings({
      store, audioStore: realStore, enqueue: () => { throw new Error('不該入列'); }, now: () => T0 + 1,
    });

    expect(report.failed[0].reason).toMatch(/無法判斷音檔位置/);
    expect(store.getMeeting('job/怪 id')?.status).toBe('FAILED');
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
  sizeOf: () => 0,
  saveFrom: async () => ({ path: '', bytes: 0 }),
  removePartialUploads: () => [],
  remove: () => {},
});

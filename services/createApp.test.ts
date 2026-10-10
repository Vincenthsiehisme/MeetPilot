import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioFileStore, createAudioFileStore } from './audioFileStore';
import { createApp } from './createApp';
import { GeminiServerClient } from './geminiServerClient';
import { ListenConfig } from './httpGuards';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { PeopleStore, createPeopleStore } from './peopleStore';
import { NameResolver, createNameResolver } from './nameResolver';
import { MATCH_KEY_VERSION } from './topicTag';
import { TopicLinker } from './topicLinker';
import { createVaultProjector, VaultProjector } from './vaultProjector';
import { RecorderTimeoutError, RecordingInfo, VoiceMemoRecorder } from './voiceMemoRecorder';

/**
 * 路由層測試：跑的是 server.ts 真的用的那個 app（同一支 createApp、同一組 middleware 順序）。
 *
 * 之前上傳路由一條測試都沒有，「同一場會並行上傳會混成一個檔」就是這樣躲過 412 條測試的。
 */

const T0 = 1_700_000_000_000;
const TEST_EMPLOYEE_ID = 'p-1';

let db: DatabaseSync;
let store: MeetingStore;
let peopleStore: PeopleStore;
let nameResolver: NameResolver;
let audioDir: string;
let audioStore: AudioFileStore;
let server: Server;
let url: string;
let enqueued: string[];
let cancelled: string[];
let analysisEnqueued: string[];

const fakeGemini = (): GeminiServerClient => ({
  transcribeSlice: async () => [],
  polishTranscript: async () => '潤過的',
  analyzeTranscript: async () => ({ title: 't', overview: 'x', topics: [], decisions: [], action_items: [], open_questions: [] }),
  // 路由這一層不跑轉錄鏈，抽標籤也不會被呼叫到；形狀要在，缺了型別就對不上
  extractTopicTags: async () => [],
  embeddingModel: 'fake-embedding',
  // W4 的兩支。這一層不算關聯，形狀要在，缺了型別就對不上
  embedTopicTags: async (texts) => ({ model: 'fake-embedding', dimensions: 1, vectors: texts.map(() => [1]) }),
  judgeMeetingPair: async () => ({ sameTopic: false, confidence: 0, reason: '假的判定', sharedTopics: [] }),
});

/**
 * 只需要 `TranscriptionEnqueuer` 的最小介面（enqueue／has），`cancel` 多留著是因為部分
 * 舊測試仍會斷言它有沒有被呼叫（見 DELETE 路由那條，現在斷言的是「不會被呼叫」）。
 */
interface FakeTranscriptionQueue {
  enqueue(meetingId: string): void;
  has(meetingId: string): boolean;
  cancel(meetingId: string): boolean;
}

// 假佇列預設模仿真實佇列的同步行為：enqueue 會一路跑到 pipeline 的第一個 await，
// 那時狀態已經被改成 TRANSCRIBING。S5 要驗的就是回應有沒有反映這件事
const fakeQueue = (onEnqueue?: (id: string) => void, queued: string[] = []): FakeTranscriptionQueue => ({
  enqueue: (id: string) => { enqueued.push(id); onEnqueue?.(id); },
  has: (id: string) => queued.includes(id),
  cancel: (id: string) => { cancelled.push(id); return true; },
});

/** 分析佇列的假實作，只需要 AnalysisEnqueuer 的最小介面（enqueue／has） */
const fakeAnalysisQueue = (queued: string[] = []): { enqueue(id: string): void; has(id: string): boolean } => ({
  enqueue: (id: string) => { analysisEnqueued.push(id); },
  has: (id: string) => queued.includes(id),
});

type FakeRecorder = Pick<VoiceMemoRecorder, 'checkAvailability' | 'start' | 'stop' | 'fetchLatestTo' | 'probe'>;

const startWith = async (options: {
  listenConfig?: Partial<ListenConfig>;
  queue?: FakeTranscriptionQueue;
  analysisQueue?: { enqueue(id: string): void; has(id: string): boolean };
  audioStore?: AudioFileStore;
  topicLinker?: TopicLinker | null;
  vaultProjector?: VaultProjector | null;
  voiceMemoRecorder?: FakeRecorder | null;
  isLocalRequest?: () => boolean;
  recordingFetchPolicy?: { attempts: number; delayMs: number };
  recordingMethod?: 'voice_memo' | 'in_app';
} = {}) => {
  const app = createApp({
    listenConfig: {
      host: '127.0.0.1',
      port: 0,
      basicAuth: null,
      apiRateLimitPerMinute: 1000,
      ...options.listenConfig,
    },
    meetingStore: store,
    peopleStore,
    nameResolver,
    audioStore: options.audioStore ?? audioStore,
    // 預設佇列照 pipeline.run 的第一步做：只有 CREATED 才推進 TRANSCRIBING（已經在轉的不重設）
    transcriptionQueue: options.queue ?? fakeQueue(id => {
      if (store.getMeeting(id)?.status === 'CREATED') store.setStatus(id, 'TRANSCRIBING', Date.now());
    }),
    analysisQueue: options.analysisQueue ?? fakeAnalysisQueue(),
    geminiClient: fakeGemini(),
    llmLogger: { log: () => {} },
    // 預設不給 linker：既有的測試不該因為 W4 多出一條背景呼叫而改變行為
    topicLinker: options.topicLinker ?? null,
    // 預設不給 projector：既有的測試不該因為 W5 多出一條檔案 I/O 而改變行為
    vaultProjector: options.vaultProjector ?? null,
    // 預設不接語音備忘錄：既有的測試不該因為錄音多出任何外部指令
    voiceMemoRecorder: options.voiceMemoRecorder ?? null,
    isLocalRequest: options.isLocalRequest,
    recordingFetchPolicy: options.recordingFetchPolicy ?? { attempts: 2, delayMs: 0 },
    recordingMethod: options.recordingMethod,
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const start = (options: {
  listenConfig?: Partial<ListenConfig>;
  queue?: FakeTranscriptionQueue;
  analysisQueue?: { enqueue(id: string): void; has(id: string): boolean };
  topicLinker?: TopicLinker | null;
  vaultProjector?: VaultProjector | null;
} = {}) =>
  startWith(options);

const createMeeting = async (
  body: Record<string, unknown> = { fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] },
) => {
  const res = await fetch(`${url}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
};

const putAudio = (meetingId: string, payload: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/meetings/${meetingId}/audio`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: payload,
  });

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  peopleStore = createPeopleStore(db);
  nameResolver = createNameResolver(db, peopleStore, store);
  // 既有測試多半不關心與會者，統一先種一個人（TEST_EMPLOYEE_ID），
  // createMeeting() helper 的預設 body 用它，個別測試要測「查無此人」再自己蓋掉
  peopleStore.importRoster(
    [{ employeeId: TEST_EMPLOYEE_ID, displayName: '測試員工', title: null, email: 'test@liontravel.com', department: null, aliases: [] }],
    T0,
  );
  audioDir = mkdtempSync(join(tmpdir(), 'meetpilot-app-'));
  audioStore = createAudioFileStore(audioDir);
  enqueued = [];
  cancelled = [];
  analysisEnqueued = [];
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  rmSync(audioDir, { recursive: true, force: true });
});

describe('POST /api/meetings：與會者必填（D-016）', () => {
  it('沒有 participantIds 回 400，不靜默放行', async () => {
    await start();
    const { status, body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10 });
    expect(status).toBe(400);
    expect(body.error).toContain('participantIds');
  });

  it('participantIds 是空陣列回 400', async () => {
    await start();
    const { status } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [] });
    expect(status).toBe(400);
  });

  it('participantIds 含查無此人的員編回 400，錯誤訊息列出哪個員編', async () => {
    await start();
    const { status, body } = await createMeeting({
      fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID, 'no-such-id'],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('no-such-id');
  });

  it('合法的 participantIds 寫進 meeting_participants', async () => {
    await start();
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '第二個人', title: null, email: 'p2@liontravel.com', department: null, aliases: [] }],
      T0,
    );
    const { status, body } = await createMeeting({
      fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID, 'p-2'],
    });
    expect(status).toBe(201);
    expect(store.getParticipants(body.meeting.meeting_id).sort()).toEqual([TEST_EMPLOYEE_ID, 'p-2'].sort());
  });
});

describe('GET /api/people', () => {
  it('只回在職的人，欄位形狀不含 email 與 active', async () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '第二個人', title: '經理', email: 'p2@liontravel.com', department: '某部門', aliases: [] }],
      T0,
    );
    db.prepare('UPDATE people SET active = 0 WHERE employee_id = ?').run('p-2');
    await start();

    const res = await fetch(`${url}/api/people`);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.people).toHaveLength(1); // p-2 離職，不出現
    expect(body.people[0]).toEqual({
      employeeId: TEST_EMPLOYEE_ID,
      displayName: '測試員工',
      title: null,
      department: null,
      aliases: [],
    });
  });

  it('帶出每個人的別名（含英文名），搜尋英文名靠這個欄位', async () => {
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '陳大明', title: null, email: 'p2@liontravel.com', department: null, aliases: ['David Chen', 'Dave'] }],
      T0,
    );
    await start();

    const res = await fetch(`${url}/api/people`);
    const body = await res.json() as any;

    const p2 = body.people.find((p: any) => p.employeeId === 'p-2');
    expect(p2.aliases.sort()).toEqual(['Dave', 'David Chen']);
    const p1 = body.people.find((p: any) => p.employeeId === TEST_EMPLOYEE_ID);
    expect(p1.aliases).toEqual([]); // 沒有別名的人回空陣列，不是 undefined
  });
});

describe('PUT /api/meetings/:id/audio', () => {
  it('清掉上一輪的逐字稿與游標：這次上傳的可能是另一個音檔', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    // 模擬 retry 之後的狀態：游標與舊逐字稿都還在
    store.saveTranscriptProgress(
      id, { segments: [{ start: 0, end: 10, text: '舊音檔的內容' }], polished_content: '舊潤稿' }, 2, 3, T0,
    );

    const res = await putAudio(id, Buffer.alloc(2048, 7));

    expect(res.status).toBe(202);
    expect(store.getTranscript(id)).toBeNull();
    expect(store.getMeeting(id)?.processed_slices).toBeNull();
    expect(store.getMeeting(id)?.total_slices).toBeNull();
    expect(enqueued).toEqual([id]);
  });

  it('游標是在收檔之前清的：收檔失敗時它已經清掉了', async () => {
    // 之後清會留兩個窗口（音檔已落地但游標沒清就斷電、清游標那步自己拋錯），
    // 兩個都會讓下一次啟動從舊游標續跑新音檔。用「收檔一定失敗」的 audioStore 反過來證明順序
    const failing: AudioFileStore = {
      ...audioStore,
      saveFrom: async () => { throw new Error('連線中斷'); },
    };
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 10, text: '舊音檔的內容' }], polished_content: '舊潤稿' }, 2, 3, T0,
    );
    await startWith({ audioStore: failing });

    const res = await putAudio('m-1', Buffer.alloc(1024, 1));

    expect(res.status).toBe(500);
    expect(store.getMeeting('m-1')?.processed_slices).toBeNull();
    expect(store.getTranscript('m-1')).toBeNull();
    // 狀態留在 CREATED ＋ 沒有音檔：重啟掃描會讓它等使用者重送
    expect(store.getMeeting('m-1')?.status).toBe('CREATED');
    expect(audioStore.exists('m-1')).toBe(false);
  });

  it('上傳失敗時把舊音檔一起清掉：不然下次重啟會把使用者想換掉的那個檔整份重轉一遍', async () => {
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    await startWith({ queue: fakeQueue(undefined, []) });
    await putAudio('m-1', Buffer.from('OLD-AUDIO'));
    store.setStatus('m-1', 'FAILED', T0 + 1, '假裝失敗');
    store.setStatus('m-1', 'CREATED', T0 + 2);
    expect(audioStore.exists('m-1')).toBe(true);

    const failing: AudioFileStore = {
      ...audioStore,
      saveFrom: async () => { throw new Error('連線中斷'); },
    };
    await new Promise<void>(resolve => server.close(() => resolve()));
    await startWith({ audioStore: failing, queue: fakeQueue(undefined, []) });

    const res = await putAudio('m-1', Buffer.from('NEW-AUDIO'));

    expect(res.status).toBe(500);
    // CREATED ＋ 無音檔＝等使用者重送，前端會給上傳入口
    expect(audioStore.exists('m-1')).toBe(false);
    expect(store.getMeeting('m-1')?.status).toBe('CREATED');
    expect(store.getMeeting('m-1')?.processed_slices).toBeNull();
  });

  it('上傳進行中對同一場會 DELETE 回 409，音檔與 Meeting 列都還在', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: AudioFileStore = {
      ...audioStore,
      saveFrom: async (meetingId, source) => {
        await gate;
        return audioStore.saveFrom(meetingId, source);
      },
    };
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    await startWith({ audioStore: slow });

    const uploading = putAudio('m-1', Buffer.alloc(4096, 3));
    // 等上傳真的進到 saveFrom（in-flight 鎖已經加上去）
    await new Promise(resolve => setTimeout(resolve, 50));

    const deleted = await fetch(`${url}/api/meetings/m-1`, { method: 'DELETE' });
    expect(deleted.status).toBe(409);
    expect((await deleted.json() as any).error).toContain('正在上傳');
    expect(store.getMeeting('m-1')).not.toBeNull();

    release();
    expect((await uploading).status).toBe(202);
    // 刪掉的話這個檔會變成沒有任何路徑清得掉的孤兒
    expect(audioStore.exists('m-1')).toBe(true);
  });

  it('同一場會的第二個並行上傳回 409，最終音檔是單次上傳的大小，不是兩次相加', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    const small = Buffer.alloc(1 * 1024 * 1024, 2);

    const [a, b] = await Promise.all([putAudio(id, big), putAudio(id, small)]);
    const codes = [a.status, b.status].sort();

    expect(codes).toEqual([202, 409]);
    const bytes = statSync(audioStore.pathFor(id)).size;
    // 混在一起的話會是兩者相加（實測過的壞法），或某個對不上的數字
    expect([big.length, small.length]).toContain(bytes);
    expect(bytes).not.toBe(big.length + small.length);
  });

  it('這場會已經在佇列裡時回 409，音檔與游標都沒被動過', async () => {
    // retry 之後佇列正忙、或重啟掃描一次入列好幾場時，那些會都停在 CREATED 而音檔已經在。
    // 這時收新音檔，rename 會落在 pipeline 讀兩片之間，轉出前半舊檔、後半新檔的混合逐字稿
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    const queuedIds: string[] = [];
    await startWith({ queue: fakeQueue(undefined, queuedIds) });
    await putAudio('m-1', Buffer.from('OLD-AUDIO'));
    // 上一行把它變成 TRANSCRIBING，退回 CREATED 模擬 retry 之後「排隊中但還沒輪到」
    store.setStatus('m-1', 'FAILED', T0 + 1, '假裝失敗');
    store.setStatus('m-1', 'CREATED', T0 + 2);
    queuedIds.push('m-1');
    store.saveTranscriptProgress(
      'm-1', { segments: [{ start: 0, end: 10, text: '已經轉好的內容' }], polished_content: null }, 3, 9, T0 + 3,
    );

    const res = await putAudio('m-1', Buffer.from('NEW-AUDIO-NEW-AUDIO'));

    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('已經在佇列裡');
    // 音檔沒被換掉，游標與逐字稿也沒被清
    expect(readFileSync(audioStore.pathFor('m-1')).toString()).toBe('OLD-AUDIO');
    expect(store.getMeeting('m-1')?.processed_slices).toBe(3);
    expect(store.getTranscript('m-1')?.segments).toHaveLength(1);
  });

  it('CREATED ＋ 音檔在 ＋ 不在佇列時仍然可以上傳：那是 setStatus 拋錯之後的唯一自救路', async () => {
    // 判準是「在不在佇列裡」不是「有沒有音檔」。用音檔當判準會把這條自救路一起堵掉，
    // 那種會就只剩重啟或刪掉重建
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    // 佇列全程是空的：音檔在、狀態 CREATED，但沒有人要處理它
    await startWith({ queue: fakeQueue(undefined, []) });
    await putAudio('m-1', Buffer.from('OLD-AUDIO'));
    store.setStatus('m-1', 'FAILED', T0 + 1, '假裝失敗');
    store.setStatus('m-1', 'CREATED', T0 + 2);
    enqueued.length = 0;

    const res = await putAudio('m-1', Buffer.from('NEW-AUDIO-NEW-AUDIO'));

    expect(res.status).toBe(202);
    expect(readFileSync(audioStore.pathFor('m-1')).toString()).toBe('NEW-AUDIO-NEW-AUDIO');
    expect(enqueued).toEqual(['m-1']);
  });

  it('狀態不是 CREATED 時回 409，不覆蓋正在處理的音檔', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    await putAudio(id, Buffer.alloc(1024, 3));

    const res = await putAudio(id, Buffer.alloc(2048, 4));

    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('只有 CREATED 能上傳音檔');
    expect(statSync(audioStore.pathFor(id)).size).toBe(1024);
  });

  it('空音檔回 400 並刪掉剛收的檔，狀態留在 CREATED 讓使用者重送', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;

    const res = await putAudio(id, Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(audioStore.exists(id)).toBe(false);
    expect(store.getMeeting(id)?.status).toBe('CREATED');
  });

  it('找不到 Meeting 時回 404，不建檔', async () => {
    await start();
    const res = await putAudio('沒有這場會', Buffer.alloc(16));
    expect(res.status).toBe(404);
  });
});

describe('middleware 順序（限流 → Basic Auth → 音檔路由 → body parser）', () => {
  it('octet-stream 的 body 原樣落地，不被 body parser 吃掉', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    // 含 0x00 與非 UTF-8 的位元組：被 body parser 碰過就會壞掉
    const payload = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff, 0x01]);

    const res = await putAudio(id, payload);

    expect(res.status).toBe(202);
    expect(statSync(audioStore.pathFor(id)).size).toBe(payload.length);
  });

  it('Content-Type 寫 application/json 的二進位上傳照樣落地：body parser 掛在音檔路由後面', async () => {
    // 這條是順序的鑑別器。body parser 若搬到 PUT audio 之前，它會先去 parse 這包二進位，
    // 解析失敗回 400，檔案一個位元組都不會落地
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    const payload = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff, 0x01, 0x02, 0x03]);

    const res = await putAudio(id, payload, { 'Content-Type': 'application/json' });

    expect(res.status).toBe(202);
    expect(statSync(audioStore.pathFor(id)).size).toBe(payload.length);
  });

  it('沒有 Basic Auth 時上傳被擋在 401，檔案不會被建立', async () => {
    await start({ listenConfig: { basicAuth: { user: 'u', password: 'p' } } });
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });

    const res = await putAudio('m-1', Buffer.alloc(64));

    expect(res.status).toBe(401);
    expect(audioStore.exists('m-1')).toBe(false);
  });

  it('限流在最前面，超過就連認證都不用做', async () => {
    await start({ listenConfig: { apiRateLimitPerMinute: 1 } });

    expect((await fetch(`${url}/api/meetings`)).status).toBe(200);
    const blocked = await fetch(`${url}/api/meetings`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('JSON 壞掉時回 JSON 錯誤而不是 HTML 錯誤頁', async () => {
    await start();
    const res = await fetch(`${url}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{壞掉的 JSON',
    });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('JSON 格式錯誤');
  });
});

describe('GET /api/meetings/:id 的題目標籤（W3）', () => {
  it('題目標籤與會議標籤分成兩個欄位回出去，不會混成同一組', async () => {
    await start({ queue: fakeQueue() });
    store.createMeeting({ meeting_id: 'm-tagged', created_at: T0 });
    // 使用者自己打的會議標籤
    store.setTags('m-tagged', ['週會']);
    // 模型抽的題目標籤
    store.saveTopicExtraction('m-tagged', {
      status: 'ok',
      tags: [{ title: 'POC 時程', content: '卡在報價', match_key: 'poc時程', match_key_version: MATCH_KEY_VERSION }],
    }, T0 + 1);

    const detail = await (await fetch(`${url}/api/meetings/m-tagged`)).json() as any;

    expect(detail.tags).toEqual(['週會']);
    expect(detail.topicTags).toHaveLength(1);
    expect(detail.topicTags[0]).toMatchObject({ title: 'POC 時程', content: '卡在報價', source: 'auto' });
    expect(detail.meeting.topic_extraction_status).toBe('ok');
  });

  it('沒抽過的會回空陣列，而 topic_extraction_status 是 null：兩者合起來才分得出「還沒抽」與「抽了沒有」', async () => {
    await start({ queue: fakeQueue() });
    store.createMeeting({ meeting_id: 'm-plain', created_at: T0 });

    const detail = await (await fetch(`${url}/api/meetings/m-plain`)).json() as any;

    expect(detail.topicTags).toEqual([]);
    expect(detail.meeting.topic_extraction_status).toBeNull();
  });
});

describe('GET /api/meetings/:id 的 participantIds／nameMentions（人名校正 N4／N5）', () => {
  it('回這場會的與會者員編，跟建立時送的一致', async () => {
    await start({ queue: fakeQueue() });
    const created = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] });

    const detail = await (await fetch(`${url}/api/meetings/${created.body.meeting.meeting_id}`)).json() as any;

    expect(detail.participantIds).toEqual([TEST_EMPLOYEE_ID]);
  });

  it('needs_review 的人名比對結果會出現在 nameMentions，確認後從清單移除', async () => {
    await start({ queue: fakeQueue() });
    // 種第二個人，兩人共用一個兩字短別名，製造 needs_review
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '陳小明', title: null, email: 'p2@liontravel.com', department: null, aliases: ['小明'] }],
      T0,
    );
    const created = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID, 'p-2'] });
    const meetingId = created.body.meeting.meeting_id;
    store.setStatus(meetingId, 'TRANSCRIBING', T0);
    store.saveTranscript(meetingId, { segments: [{ start: 0, end: 5, text: '小明報告進度' }], polished_content: null }, T0);
    nameResolver.resolveTranscript(meetingId, [{ start: 0, end: 5, text: '小明報告進度' }], T0);
    store.setStatus(meetingId, 'TRANSCRIBED', T0);
    store.setStatus(meetingId, 'ANALYZING', T0);
    store.setStatus(meetingId, 'READY', T0);

    const before = await (await fetch(`${url}/api/meetings/${meetingId}`)).json() as any;
    expect(before.nameMentions).toEqual([{
      segment_index: 0,
      segment_text: '小明報告進度',
      original_text: '小明',
      employee_id: 'p-2',
      method: 'short_alias_review',
    }]);

    const confirmRes = await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_index: 0, original_text: '小明', employee_id: 'p-2' }),
    });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json() as any).nameMentions).toEqual([]);

    const after = await (await fetch(`${url}/api/meetings/${meetingId}`)).json() as any;
    expect(after.nameMentions).toEqual([]);
  });

  it('conflict_review（撞到兩個員編）確認後也會從清單移除，不會因為另一位候選人還在而重判', async () => {
    await start({ queue: fakeQueue() });
    peopleStore.importRoster(
      [{ employeeId: 'p-2', displayName: '林雅婷', title: null, email: 'p2@liontravel.com', department: null, aliases: ['Tina'] }],
      T0,
    );
    peopleStore.addManualAlias(TEST_EMPLOYEE_ID, 'Tina', T0); // 讓 TEST_EMPLOYEE_ID 也用 Tina，製造衝突
    const created = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID, 'p-2'] });
    const meetingId = created.body.meeting.meeting_id;
    store.setStatus(meetingId, 'TRANSCRIBING', T0);
    store.saveTranscript(meetingId, { segments: [{ start: 0, end: 5, text: 'Tina 說明狀況' }], polished_content: null }, T0);
    nameResolver.resolveTranscript(meetingId, [{ start: 0, end: 5, text: 'Tina 說明狀況' }], T0);
    store.setStatus(meetingId, 'TRANSCRIBED', T0);
    store.setStatus(meetingId, 'ANALYZING', T0);
    store.setStatus(meetingId, 'READY', T0);

    const before = await (await fetch(`${url}/api/meetings/${meetingId}`)).json() as any;
    expect(before.nameMentions).toEqual([{
      segment_index: 0,
      segment_text: 'Tina 說明狀況',
      original_text: 'Tina',
      employee_id: null,
      method: 'conflict_review',
    }]);

    const confirmRes = await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_index: 0, original_text: 'Tina', employee_id: TEST_EMPLOYEE_ID }),
    });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json() as any).nameMentions).toEqual([]);
  });

  it('確認後重算 decided_by_employee_id：原本反查不到的決議現在能對上員編', async () => {
    await start({ queue: fakeQueue() });
    const created = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] });
    const meetingId = created.body.meeting.meeting_id;
    store.setStatus(meetingId, 'TRANSCRIBING', T0);
    store.saveTranscript(meetingId, { segments: [{ start: 0, end: 5, text: '討論預算' }], polished_content: null }, T0);
    store.setStatus(meetingId, 'TRANSCRIBED', T0);
    store.setStatus(meetingId, 'ANALYZING', T0);
    store.saveAnalysis(meetingId, {
      contract_version: 3, overview: '摘要', topics: [], open_questions: [],
      decisions: [{ text: '採用方案 A', evidence: null, decided_by: '小美' }],
      action_items: [],
    }, T0);
    store.setStatus(meetingId, 'READY', T0);

    await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_index: 0, original_text: '小美', employee_id: TEST_EMPLOYEE_ID }),
    });

    const detail = await (await fetch(`${url}/api/meetings/${meetingId}`)).json() as any;
    expect(detail.analysis.decisions[0].decided_by_employee_id).toBe(TEST_EMPLOYEE_ID);
  });

  it.each([
    ['缺 segment_index', { original_text: '小美', employee_id: TEST_EMPLOYEE_ID }, 400, 'segment_index'],
    ['segment_index 是負數', { segment_index: -1, original_text: '小美', employee_id: TEST_EMPLOYEE_ID }, 400, 'segment_index'],
    ['缺 original_text', { segment_index: 0 }, 400, 'original_text'],
    ['original_text 是空字串', { segment_index: 0, original_text: '  ', employee_id: TEST_EMPLOYEE_ID }, 400, 'original_text'],
    ['缺 employee_id', { segment_index: 0, original_text: '小美' }, 400, 'employee_id'],
  ])('%s 時回 400', async (_label, body, expectedStatus, expectedFragment) => {
    await start({ queue: fakeQueue() });
    const created = await createMeeting();
    const meetingId = created.body.meeting.meeting_id;

    const res = await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(expectedStatus);
    expect((await res.json() as any).error).toContain(expectedFragment);
  });

  it('employee_id 不是這場會的與會者時回 400，不寫進 person_aliases', async () => {
    await start({ queue: fakeQueue() });
    peopleStore.importRoster(
      [{ employeeId: 'p-outsider', displayName: '局外人', title: null, email: 'x@liontravel.com', department: null, aliases: [] }],
      T0,
    );
    const created = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] });
    const meetingId = created.body.meeting.meeting_id;

    const res = await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_index: 0, original_text: '小美', employee_id: 'p-outsider' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('不是這場會的與會者');
    expect(peopleStore.listAliasesForEmployees(['p-outsider'])).toEqual([]);
  });

  it('Meeting 不存在時回 404', async () => {
    await start({ queue: fakeQueue() });
    const res = await fetch(`${url}/api/meetings/nope/name-mentions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_index: 0, original_text: '小美', employee_id: TEST_EMPLOYEE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it.each(['TRANSCRIBING', 'ANALYZING', 'LINKING'] as const)(
    'Meeting 是 %s 時確認人名回 409，不寫入 manual alias',
    async (status) => {
      await start({ queue: fakeQueue() });
      const created = await createMeeting();
      const meetingId = created.body.meeting.meeting_id;
      store.setStatus(meetingId, 'TRANSCRIBING', T0);
      if (status === 'ANALYZING' || status === 'LINKING') {
        store.setStatus(meetingId, 'TRANSCRIBED', T0);
        store.setStatus(meetingId, 'ANALYZING', T0);
      }
      if (status === 'LINKING') {
        store.setStatus(meetingId, 'READY', T0);
        store.setStatus(meetingId, 'LINKING', T0);
      }

      const res = await fetch(`${url}/api/meetings/${meetingId}/name-mentions/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment_index: 0, original_text: '小美', employee_id: TEST_EMPLOYEE_ID }),
      });

      expect(res.status).toBe(409);
      expect((await res.json() as any).error).toContain('等它跑完再確認人名');
      expect(peopleStore.listAliasesForEmployees([TEST_EMPLOYEE_ID]).some((a) => a.alias === '小美')).toBe(false);
    },
  );
});

describe('has_audio', () => {
  it('五條回 meeting 的端點都帶 has_audio', async () => {
    await start({ queue: fakeQueue() });
    const created = await createMeeting();
    const id = created.body.meeting.meeting_id;

    // 1. POST /api/meetings：還沒上傳，音檔不在
    expect(created.status).toBe(201);
    expect(created.body.meeting.has_audio).toBe(false);

    // 2. GET /api/meetings：同一筆，仍然沒有音檔
    const list = await (await fetch(`${url}/api/meetings`)).json() as any;
    expect(list.meetings[0].has_audio).toBe(false);

    // 3. GET /api/meetings/:id
    const detail = await (await fetch(`${url}/api/meetings/${id}`)).json() as any;
    expect(detail.meeting.has_audio).toBe(false);

    // 4. PUT audio：上傳完音檔就在了
    const uploaded = await (await putAudio(id, Buffer.alloc(512, 9))).json() as any;
    expect(uploaded.meeting.has_audio).toBe(true);
    expect(audioStore.exists(id)).toBe(true);

    // 5. POST retry：FAILED 且音檔還在才能重跑，回的那份一樣要有
    store.setStatus(id, 'FAILED', Date.now(), '假裝失敗');
    const retried = await (await fetch(`${url}/api/meetings/${id}/retry`, { method: 'POST' })).json() as any;
    expect(retried.meeting.has_audio).toBe(true);
  });

  it('CREATED 且音檔在 → true；CREATED 且音檔不在 → false（搬遷進來的舊 Job 就是後者）', async () => {
    await start({ queue: fakeQueue() });
    store.createMeeting({ meeting_id: 'm-waiting', created_at: T0 });
    store.createMeeting({ meeting_id: 'm-ready-to-run', created_at: T0 + 1 });
    await putAudio('m-ready-to-run', Buffer.alloc(256, 1));
    store.setStatus('m-ready-to-run', 'FAILED', T0 + 2, '假裝失敗');
    store.setStatus('m-ready-to-run', 'CREATED', T0 + 3);

    const list = await (await fetch(`${url}/api/meetings`)).json() as any;
    const byId = Object.fromEntries(list.meetings.map((m: any) => [m.meeting_id, m]));

    expect(byId['m-waiting'].status).toBe('CREATED');
    expect(byId['m-waiting'].has_audio).toBe(false);
    expect(byId['m-ready-to-run'].status).toBe('CREATED');
    expect(byId['m-ready-to-run'].has_audio).toBe(true);
  });
});

describe('POST /api/meetings/:id/retry', () => {
  it('回應的狀態與資料庫當下一致：enqueue 已經把它推進 TRANSCRIBING', async () => {
    await start();
    const { body } = await createMeeting();
    const id = body.meeting.meeting_id;
    await putAudio(id, Buffer.alloc(128, 5));
    store.setStatus(id, 'FAILED', Date.now(), '假裝失敗');

    const res = await fetch(`${url}/api/meetings/${id}/retry`, { method: 'POST' });
    const payload = await res.json() as any;

    expect(res.status).toBe(202);
    expect(payload.meeting.status).toBe(store.getMeeting(id)?.status);
    expect(payload.meeting.status).toBe('TRANSCRIBING');
  });

  it('音檔不在時回 409，不入列', async () => {
    await start();
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    store.setStatus('m-1', 'FAILED', T0 + 1, '失敗過');

    const res = await fetch(`${url}/api/meetings/m-1/retry`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(enqueued).toEqual([]);
  });
});

describe('DELETE /api/meetings/:id', () => {
  it('刪掉會議成功，不需要另外通知佇列——job table 靠外鍵 cascade 自動清掉排隊中的項目', async () => {
    // 跟舊版記憶體 TranscriptionQueue 不同：這裡不再呼叫 queue.cancel()（deleteMeetingRequest
    // 沒有拿到 queue 這個依賴，見 createApp.ts 那條路由的註解），`cancelled` 因此保持空陣列
    await start({ queue: fakeQueue() });
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });

    const res = await fetch(`${url}/api/meetings/m-1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(cancelled).toEqual([]);
    expect(store.getMeeting('m-1')).toBeNull();
  });
});

describe('W4：關聯的路由', () => {
  /** 把一場會推到 READY，並讓它有一筆既有關聯可查 */
  const readyPair = () => {
    for (const id of ['m-1', 'm-2']) {
      store.createMeeting({ meeting_id: id, created_at: Date.now(), source_file_name: 'a.m4a', source_file_size: 1 });
      store.setStatus(id, 'TRANSCRIBING', Date.now());
      store.setStatus(id, 'TRANSCRIBED', Date.now());
      store.setStatus(id, 'ANALYZING', Date.now());
      store.setStatus(id, 'READY', Date.now());
    }
  };

  const fakeLinker = (impl?: (id: string) => Promise<void>): TopicLinker => ({
    link: async (id: string) => {
      await impl?.(id);
      return { status: 'LINKED', links: 0, coverage: {
        candidates: 0, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
        incomparable_pairs: 0, error: null,
      } };
    },
  });

  it('GET 詳情帶著 links 與 linkRun', async () => {
    readyPair();
    store.saveLinkResult('m-1', {
      algo_version: 'test-v1',
      links: [{ other_meeting_id: 'm-2', confidence: 0.9, evidence: '理由', shared_topics: ['共同題目'] }],
      coverage: { candidates: 1, judged: 1, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
            incomparable_pairs: 0, error: null },
    }, Date.now());
    await start();

    const res = await fetch(`${url}/api/meetings/m-1`);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].evidence).toBe('理由');
    expect(body.linkRun).toMatchObject({ candidates: 1, judged: 1, skipped_error: 0 });
  });

  it('沒算過的會 linkRun 是 null、links 是空陣列', async () => {
    readyPair();
    await start();

    const body = await (await fetch(`${url}/api/meetings/m-1`)).json() as any;
    // 空陣列要配 status 讀才有意義：這裡是 READY，意思是「還沒算」不是「沒有相關會議」
    expect(body.links).toEqual([]);
    expect(body.linkRun).toBeNull();
    expect(body.meeting.status).toBe('READY');
  });

  it('POST link 重算之後回新的 links 與 linkRun', async () => {
    readyPair();
    await start({
      topicLinker: fakeLinker(async (id) => {
        store.setStatus(id, 'LINKING', Date.now());
        store.saveLinkResult(id, {
          algo_version: 'test-v1',
          links: [{ other_meeting_id: 'm-2', confidence: 0.7, evidence: '重算的理由', shared_topics: [] }],
          coverage: { candidates: 1, judged: 1, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
            incomparable_pairs: 0, error: null },
        }, Date.now());
        store.setStatus(id, 'LINKED', Date.now());
      }),
    });

    const res = await fetch(`${url}/api/meetings/m-1/link`, { method: 'POST' });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.meeting.status).toBe('LINKED');
    expect(body.links[0].evidence).toBe('重算的理由');
    expect(body.linkRun.judged).toBe(1);
  });

  it('關聯關掉時回 503，而且講得出是被關掉不是壞掉', async () => {
    readyPair();
    await start({ topicLinker: null });

    const res = await fetch(`${url}/api/meetings/m-1/link`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toContain('MEETPILOT_LINKING=off');
  });

  it('找不到的會回 404', async () => {
    await start({ topicLinker: fakeLinker() });
    const res = await fetch(`${url}/api/meetings/m-nope/link`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('還沒 READY 的會回 409，而且不去呼叫 linker', async () => {
    store.createMeeting({ meeting_id: 'm-1', created_at: Date.now(), source_file_name: 'a.m4a', source_file_size: 1 });
    let called = 0;
    await start({ topicLinker: fakeLinker(async () => { called += 1; }) });

    const res = await fetch(`${url}/api/meetings/m-1/link`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('CREATED');
    expect(called).toBe(0);
  });

  it('同一場會兩個重算同時進來，第二個回 409 而且講得出原因是「正在算」', async () => {
    readyPair();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await start({ topicLinker: fakeLinker(async () => { await gate; }) });

    const first = fetch(`${url}/api/meetings/m-1/link`, { method: 'POST' });
    // 讓第一個請求走到 await 為止
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await fetch(`${url}/api/meetings/m-1/link`, { method: 'POST' });

    expect(second.status).toBe(409);
    // 只靠狀態機擋的話訊息會說成「狀態不對」，那是在講結果不是講原因
    expect((await second.json() as any).error).toContain('正在計算中');

    release();
    expect((await first).status).toBe(200);
  });
});

describe('W5：PATCH 逐字稿／分析之後同步重投影', () => {
  /**
   * 這兩條路由原本沒接 vaultProjector（code review 2026-09-18 抓到）：改逐字稿會改
   * duration_minutes、改分析會改結論／待辦／標題，兩者都是投影的內容，編輯成功卻不重投影，
   * vault 檔會永遠停在編輯前的版本，跟 SQLite 的真相源永久對不起來。
   */
  let vaultDir: string;

  const readyMeeting = (id = 'm-1') => {
    store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
    store.setStatus(id, 'TRANSCRIBING', T0);
    store.saveTranscript(id, { segments: [{ start: 0, end: 60, text: '第一版逐字稿' }], polished_content: null }, T0);
    store.setStatus(id, 'TRANSCRIBED', T0);
    store.setStatus(id, 'ANALYZING', T0);
    store.saveAnalysis(id, {
      contract_version: 3, overview: '第一版標題', topics: [],
      decisions: [{ text: '第一版結論', evidence: null, decided_by: null }],
      action_items: [], open_questions: [],
    }, T0);
    store.setStatus(id, 'READY', T0);
  };

  const vaultFileContent = (): string => {
    const files = readdirSync(vaultDir).filter(n => n.endsWith('.md'));
    return readFileSync(join(vaultDir, files[0]), 'utf8');
  };

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'meetpilot-app-vault-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('PATCH /transcript 成功之後 vault 檔反映新的逐字稿長度', async () => {
    readyMeeting();
    const vaultProjector = createVaultProjector({ store, vaultDir, nameResolver, now: () => T0 });
    vaultProjector.project('m-1'); // 先投影一次，模擬轉錄鏈跑完之後的既有狀態
    await start({ vaultProjector });

    const res = await fetch(`${url}/api/meetings/m-1/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: [{ start: 0, end: 600, text: '改過的逐字稿' }] }),
    });

    expect(res.status).toBe(200);
    expect(vaultFileContent()).toContain('duration_minutes: 10'); // 600 秒
  });

  it('PATCH /analysis 成功之後 vault 檔反映新的結論與標題', async () => {
    readyMeeting();
    const vaultProjector = createVaultProjector({ store, vaultDir, nameResolver, now: () => T0 });
    vaultProjector.project('m-1');
    await start({ vaultProjector });

    const res = await fetch(`${url}/api/meetings/m-1/analysis`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis: {
          contract_version: 3, overview: '人工修正過的標題', topics: [],
          decisions: [{ text: '人工修正過的結論', evidence: null, decided_by: null }],
          action_items: [], open_questions: [],
        },
      }),
    });

    expect(res.status).toBe(200);
    const content = vaultFileContent();
    expect(content).toContain('# 人工修正過的標題');
    expect(content).toContain('人工修正過的結論');
    expect(content).not.toContain('第一版結論');
  });

  it('PATCH 失敗（驗證錯誤）不會觸發重投影，vault 檔維持原樣', async () => {
    readyMeeting();
    const vaultProjector = createVaultProjector({ store, vaultDir, nameResolver, now: () => T0 });
    vaultProjector.project('m-1');
    await start({ vaultProjector });
    const before = vaultFileContent();

    // meetingEdits 的驗證錯誤：analysis 缺必要欄位應該回非 200
    const res = await fetch(`${url}/api/meetings/m-1/analysis`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).not.toBe(200);
    expect(vaultFileContent()).toBe(before);
  });
});

describe('POST /api/meetings 帶 title', () => {
  // 跟 PATCH /title 走同一支 checkMeetingTitle：不然帶不合規則標題的建立請求能繞過驗證，
  // 把壞掉的值直接存成 title，pipeline「title === null 才填建議」的判斷永遠不會補正
  // （2026-09-20 Codex review 抓到）
  it('合法標題 trim 後存下來', async () => {
    await start();
    const { status, body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, title: '  週會  ', participantIds: [TEST_EMPLOYEE_ID] });
    expect(status).toBe(201);
    expect(body.meeting.title).toBe('週會');
  });

  it('空白、超過 100 字、含控制字元的標題回 400，不建立會議', async () => {
    await start();
    for (const title of ['   ', 'x'.repeat(101), '週會\n第二週']) {
      const { status, body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, title, participantIds: [TEST_EMPLOYEE_ID] });
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    }
    expect((await (await fetch(`${url}/api/meetings`)).json() as any).meetings).toEqual([]);
  });

  it('沒給 title 時是 null，不是空字串', async () => {
    await start();
    const { body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] });
    expect(body.meeting.title).toBeNull();
  });
});

describe('POST /api/meetings 帶 meetingContext（背景補充）', () => {
  it('存進 meeting_context，pipeline 分析時讀的就是這一欄', async () => {
    await start();
    const { status, body } = await createMeeting({
      fileName: 'a.m4a', fileSize: 10, meetingContext: '第三次談採購', participantIds: [TEST_EMPLOYEE_ID],
    });
    expect(status).toBe(201);
    expect(body.meeting.meeting_context).toBe('第三次談採購');
    expect(store.getMeeting(body.meeting.meeting_id)!.meeting_context).toBe('第三次談採購');
  });

  it('沒給是 null', async () => {
    await start();
    const { body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, participantIds: [TEST_EMPLOYEE_ID] });
    expect(body.meeting.meeting_context).toBeNull();
  });
});

describe('PATCH /api/meetings/:id/title', () => {
  const readyMeeting = (id = 'm-1') => {
    store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
    store.setStatus(id, 'TRANSCRIBING', T0);
    store.setStatus(id, 'TRANSCRIBED', T0);
    store.setStatus(id, 'ANALYZING', T0);
    store.setStatus(id, 'READY', T0);
  };
  const patchTitle = (id: string, body: unknown) =>
    fetch(`${url}/api/meetings/${id}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('寫入標題，之後 GET 詳情帶新標題', async () => {
    readyMeeting();
    await start();
    const res = await patchTitle('m-1', { title: ' 週會 ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: '週會' });
    const detail = await (await fetch(`${url}/api/meetings/m-1`)).json() as any;
    expect(detail.meeting.title).toBe('週會');
  });

  it('空標題回 400，訊息講得出原因', async () => {
    readyMeeting();
    await start();
    const res = await patchTitle('m-1', { title: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('空');
  });

  it('找不到的會回 404', async () => {
    await start();
    expect((await patchTitle('nope', { title: '週會' })).status).toBe(404);
  });
});

describe('語音備忘錄錄音的路由（vault plan「MeetPilot · 網頁錄音」）', () => {
  interface RecorderScript {
    startFails?: boolean;
    stopFails?: boolean;
    /** 第幾次取檔（從 1 算）要失敗；沒列的都成功 */
    fetchFailsOn?: number[];
    /** 讀取回檔案時回什麼。預設回一支對得上這場會起訖時間的錄音 */
    probe?: () => RecordingInfo;
    availability?: Awaited<ReturnType<FakeRecorder['checkAvailability']>>;
  }

  let recorderCalls: string[];

  const fakeRecorder = (script: RecorderScript = {}): FakeRecorder => {
    let fetches = 0;
    return {
      checkAvailability: async () => { recorderCalls.push('availability'); return script.availability ?? { available: true }; },
      start: async () => {
        recorderCalls.push('start');
        if (script.startFails) throw new Error('執行捷徑「MeetPilot 開始錄音」失敗（shortcuts 結束碼 1）');
      },
      stop: async () => {
        recorderCalls.push('stop');
        if (script.stopFails) throw new Error('執行捷徑「MeetPilot 停止錄音」失敗（shortcuts 結束碼 1）');
      },
      fetchLatestTo: async (destPath: string) => {
        fetches += 1;
        recorderCalls.push('fetch');
        if (script.fetchFailsOn?.includes(fetches)) throw new Error('捷徑「MeetPilot 取檔」執行完了，但沒有交出任何檔案');
        writeFileSync(destPath, Buffer.from('voice-memo-audio'));
      },
      probe: async () => {
        recorderCalls.push('probe');
        return script.probe ? script.probe() : { durationSeconds: 0.5, creationTimeMs: Date.now() };
      },
    };
  };

  const post = async (path: string) => {
    const res = await fetch(`${url}${path}`, { method: 'POST' });
    return { status: res.status, body: await res.json() as any };
  };

  const createRecordingMeeting = async (): Promise<string> => {
    const { body } = await createMeeting({ fileName: '語音備忘錄錄音', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    return body.meeting.meeting_id;
  };

  beforeEach(() => {
    recorderCalls = [];
  });

  describe('GET /api/recording/availability', () => {
    it('本機請求照 recorder 的判斷回', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder({ availability: { available: false, reason: '找不到捷徑' } }) });
      const res = await fetch(`${url}/api/recording/availability`);
      expect(await res.json()).toEqual({ available: false, reason: '找不到捷徑' });
    });

    it('別台電腦來的請求一律不可用並講原因，不去跑 shortcuts', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder(), isLocalRequest: () => false });
      const body = await (await fetch(`${url}/api/recording/availability`)).json() as any;
      expect(body.available).toBe(false);
      expect(body.reason).toContain('只能在那台電腦上操作');
      expect(recorderCalls).toEqual([]);
    });

    it('能錄的時候講是哪一種方式，前端照它決定按下去做什麼', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const body = await (await fetch(`${url}/api/recording/availability`)).json() as any;
      expect(body).toEqual({ available: true, method: 'voice_memo' });
    });

    it('沒接語音備忘錄的 server 講清楚沒接', async () => {
      await startWith();
      const body = await (await fetch(`${url}/api/recording/availability`)).json() as any;
      expect(body).toEqual({ available: false, reason: '這台 server 沒有接語音備忘錄錄音' });
    });
  });

  describe('開始錄音', () => {
    it('狀態進 RECORDING、回應帶開始時間，語音備忘錄被叫一次', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      const before = Date.now();
      const { status, body } = await post(`/api/meetings/${id}/recording/start`);
      expect(status).toBe(200);
      expect(body.meeting.status).toBe('RECORDING');
      expect(body.meeting.recording_started_at).toBeGreaterThanOrEqual(before);
      expect(recorderCalls).toEqual(['start']);
      // 清單也帶開始時間：重開頁面時計時要從這裡接回來（AC-4）
      const list = await (await fetch(`${url}/api/meetings`)).json() as any;
      expect(list.meetings[0].recording_started_at).toBe(body.meeting.recording_started_at);
    });

    it('語音備忘錄沒被叫起來：退回 CREATED、不留起訖紀錄，錯誤講是哪個捷徑', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder({ startFails: true }) });
      const id = await createRecordingMeeting();
      const { status, body } = await post(`/api/meetings/${id}/recording/start`);
      expect(status).toBe(502);
      expect(body.error).toContain('MeetPilot 開始錄音');
      expect(store.getMeeting(id)?.status).toBe('CREATED');
      expect(store.getRecording(id)).toBeNull();
    });

    it('已經有一場在錄，第二場不能開始，也不去叫語音備忘錄', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const first = await createRecordingMeeting();
      const second = await createRecordingMeeting();
      await post(`/api/meetings/${first}/recording/start`);
      const { status, body } = await post(`/api/meetings/${second}/recording/start`);
      expect(status).toBe(409);
      expect(body.error).toContain(first);
      expect(recorderCalls).toEqual(['start']);
      expect(store.getMeeting(second)?.status).toBe('CREATED');
    });

    it('已經有音檔的會不能開始錄（停止時收檔會清掉它的成果）', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      await audioStore.saveFrom(id, Readable.from([Buffer.from('existing')]));
      const { status } = await post(`/api/meetings/${id}/recording/start`);
      expect(status).toBe(409);
      expect(recorderCalls).toEqual([]);
    });

    it('別台電腦來的請求回 403，不碰麥克風（AC-6）', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder(), isLocalRequest: () => false });
      const id = await createRecordingMeeting();
      const { status, body } = await post(`/api/meetings/${id}/recording/start`);
      expect(status).toBe(403);
      expect(body.error).toContain('只能在那台電腦上操作');
      expect(recorderCalls).toEqual([]);
      expect(store.getMeeting(id)?.status).toBe('CREATED');
    });

    it('沒接語音備忘錄的 server 回 503', async () => {
      await startWith();
      const id = await createRecordingMeeting();
      expect((await post(`/api/meetings/${id}/recording/start`)).status).toBe(503);
    });
  });

  describe('停止錄音', () => {
    it('停止、取檔、收檔、進轉錄：音檔落地、大小補上、暫存檔清掉', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const { status, body } = await post(`/api/meetings/${id}/recording/stop`);

      expect(status).toBe(202);
      expect(body.meeting.status).toBe('TRANSCRIBING');
      expect(body.meeting.has_audio).toBe(true);
      expect(body.meeting.recording_started_at).toBeNull();
      expect(recorderCalls).toEqual(['start', 'stop', 'fetch', 'probe']);
      expect(enqueued).toEqual([id]);
      expect(readFileSync(audioStore.pathFor(id), 'utf8')).toBe('voice-memo-audio');
      expect(store.getMeeting(id)?.source_file_size).toBe(Buffer.byteLength('voice-memo-audio'));
      expect(store.getRecording(id)?.stopped_at).not.toBeNull();
      expect(readdirSync(audioDir).filter(name => name.endsWith('.part') || name.endsWith('_part'))).toEqual([]);
    });

    it('第一次取檔失敗（檔案還沒寫完）會再取一次', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder({ fetchFailsOn: [1] }) });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const { status } = await post(`/api/meetings/${id}/recording/stop`);
      expect(status).toBe(202);
      expect(recorderCalls.filter(c => c === 'fetch')).toHaveLength(2);
    });

    it('取回的不是這場會的錄音：不送轉錄、退回 CREATED 等補音檔，原因與退路都講', async () => {
      await startWith({
        voiceMemoRecorder: fakeRecorder({ probe: () => ({ durationSeconds: 3600, creationTimeMs: Date.now() - 86_400_000 }) }),
        recordingFetchPolicy: { attempts: 3, delayMs: 0 },
      });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const { status, body } = await post(`/api/meetings/${id}/recording/stop`);

      expect(status).toBe(422);
      expect(body.error).toContain('不在這場會的錄音期間');
      expect(body.error).toContain('補上音檔');
      expect(store.getMeeting(id)?.status).toBe('CREATED');
      expect(audioStore.exists(id)).toBe(false);
      expect(enqueued).toEqual([]);
      // 照重試次數取了三次，不是取一次就放棄
      expect(recorderCalls.filter(c => c === 'fetch')).toHaveLength(3);
      expect(readdirSync(audioDir).filter(name => name.endsWith('.part') || name.endsWith('_part'))).toEqual([]);
    });

    it('語音備忘錄停不下來：留在 RECORDING，停止按鍵還在，可以再按一次', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder({ stopFails: true }) });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const { status, body } = await post(`/api/meetings/${id}/recording/stop`);
      expect(status).toBe(502);
      expect(body.error).toContain('再按一次停止');
      expect(store.getMeeting(id)?.status).toBe('RECORDING');
      expect(store.getRecording(id)?.stopped_at).toBeNull();
      expect(recorderCalls).not.toContain('fetch');
    });

    it('停止捷徑逾時：留在 RECORDING、講清楚，而且不會把整台 server 的錄音操作鎖住（2026-09-23 實測捷徑會卡住）', async () => {
      let stopTimesOut = true;
      const recorder = fakeRecorder();
      await startWith({
        voiceMemoRecorder: {
          ...recorder,
          stop: async () => {
            recorderCalls.push('stop');
            if (stopTimesOut) throw new RecorderTimeoutError('執行捷徑「MeetPilot 停止錄音」超過 20 秒沒有回應，已經中止');
          },
        },
      });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);

      const first = await post(`/api/meetings/${id}/recording/stop`);
      expect(first.status).toBe(502);
      expect(first.body.error).toContain('沒有回應');
      expect(first.body.error).toContain('再按一次停止');
      expect(store.getMeeting(id)?.status).toBe('RECORDING');

      // 鎖有放開：馬上再按一次停止照常處理，不是 409「正在處理另一個開始或停止」
      stopTimesOut = false;
      const second = await post(`/api/meetings/${id}/recording/stop`);
      expect(second.status).toBe(202);
    });

    it('開始捷徑逾時：退回 CREATED，訊息說「沒有回應」而不是「確定沒開始」', async () => {
      const recorder = fakeRecorder();
      await startWith({
        voiceMemoRecorder: {
          ...recorder,
          start: async () => { throw new RecorderTimeoutError('執行捷徑「MeetPilot 開始錄音」超過 20 秒沒有回應，已經中止。語音備忘錄有可能晚一點才開始錄'); },
        },
      });
      const id = await createRecordingMeeting();
      const { status, body } = await post(`/api/meetings/${id}/recording/start`);
      expect(status).toBe(502);
      expect(body.error.startsWith('叫語音備忘錄開始錄音沒有回應')).toBe(true);
      expect(body.error).toContain('晚一點才開始錄');
      expect(store.getMeeting(id)?.status).toBe('CREATED');
    });

    it('上一次停了但沒取到檔就斷線：這次不再叫停止，用記下的停止時間直接取檔', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      store.markRecordingStopped(id, Date.now());
      recorderCalls = [];
      const { status } = await post(`/api/meetings/${id}/recording/stop`);
      expect(status).toBe(202);
      expect(recorderCalls).toEqual(['fetch', 'probe']);
    });

    it('不在錄音中的會回 409', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      expect((await post(`/api/meetings/${id}/recording/stop`)).status).toBe(409);
      expect(recorderCalls).toEqual([]);
    });

    it('別台電腦來的請求回 403', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder(), isLocalRequest: () => false });
      const id = await createRecordingMeeting();
      store.startRecording(id, Date.now(), 'voice_memo');
      expect((await post(`/api/meetings/${id}/recording/stop`)).status).toBe(403);
      expect(recorderCalls).toEqual([]);
    });
  });

  it('取回失敗後改用 PUT audio 補送：大小以收到的位元組為準，不留建立時的 0（Codex review 抓到）', async () => {
    await startWith({ voiceMemoRecorder: fakeRecorder({ probe: () => ({ durationSeconds: 3600, creationTimeMs: 0 }) }) });
    const id = await createRecordingMeeting();
    await post(`/api/meetings/${id}/recording/start`);
    expect((await post(`/api/meetings/${id}/recording/stop`)).status).toBe(422);
    expect(store.getMeeting(id)?.source_file_size).toBe(0);

    const payload = Buffer.from('dragged-in-from-voice-memos');
    expect((await putAudio(id, payload)).status).toBe(202);
    expect(store.getMeeting(id)?.source_file_size).toBe(payload.length);
  });

  describe('刪除錄音中的會', () => {
    it('先叫語音備忘錄停止再刪，不留一支沒人停得了的錄音', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder() });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const res = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(recorderCalls).toEqual(['start', 'stop']);
      expect(store.getMeeting(id)).toBeNull();
    });

    it('停止成功但刪除失敗：停止時間已經落地，重試刪除不會再叫一次 Stop（Codex review 抓到）', async () => {
      let removeFails = true;
      const flakyStore: AudioFileStore = {
        ...audioStore,
        remove: (meetingId: string) => {
          if (removeFails) throw new Error('EACCES: permission denied');
          audioStore.remove(meetingId);
        },
      };
      await startWith({ voiceMemoRecorder: fakeRecorder(), audioStore: flakyStore });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);

      const first = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
      expect(first.status).toBe(500);
      expect(store.getMeeting(id)?.status).toBe('RECORDING');
      expect(store.getRecording(id)?.stopped_at).not.toBeNull();

      removeFails = false;
      const second = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
      expect(second.status).toBe(200);
      expect(recorderCalls.filter(c => c === 'stop')).toHaveLength(1);
    });

    it('停不下來就不刪', async () => {
      await startWith({ voiceMemoRecorder: fakeRecorder({ stopFails: true }) });
      const id = await createRecordingMeeting();
      await post(`/api/meetings/${id}/recording/start`);
      const res = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).error).toContain('沒有刪除');
      expect(store.getMeeting(id)?.status).toBe('RECORDING');
    });
  });
});

describe('app 內錄音的路由（vault plan「MeetPilot · 跨平台打包部署」E4）', () => {
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const putChunk = async (id: string, seq: number | string, data: Buffer | string) => {
    const res = await fetch(`${url}/api/meetings/${id}/recording/chunks/${seq}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: typeof data === 'string' ? Buffer.from(data) : data,
    });
    return { status: res.status, body: await res.json() as any };
  };
  const startRecording = async (): Promise<string> => {
    const { body } = await createMeeting({ fileName: 'MeetPilot 錄音', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    const id = body.meeting.meeting_id;
    const started = await post(`/api/meetings/${id}/recording/start`);
    expect(started.status).toBe(200);
    return id;
  };

  it('availability 說可以錄、方式是 in_app，不去碰語音備忘錄', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const body = await (await fetch(`${url}/api/recording/availability`)).json() as any;
    expect(body).toEqual({ available: true, method: 'in_app' });
  });

  it('開始：狀態進 RECORDING，清單帶來源與段數 0', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    const list = await (await fetch(`${url}/api/meetings`)).json() as any;
    expect(list.meetings[0]).toMatchObject({
      status: 'RECORDING', recording_method: 'in_app', recording_received_chunks: 0,
    });
    expect(store.getRecording(id)?.method).toBe('in_app');
  });

  it('開始時清掉同一場會的舊段落：第 0 段送到之前，不讓無關的檔被當成這場的錄音', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const { body } = await createMeeting({ fileName: 'x', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    const id = body.meeting.meeting_id;
    writeFileSync(audioStore.recordingPathFor(id), 'stale');
    expect((await post(`/api/meetings/${id}/recording/start`)).status).toBe(200);
    expect(readdirSync(audioDir).filter(n => n.endsWith('.recording'))).toEqual([]);
  });

  it('一次只能錄一場', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const first = await startRecording();
    const { body } = await createMeeting({ fileName: 'x', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    const second = await post(`/api/meetings/${body.meeting.meeting_id}/recording/start`);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain(first);
  });

  it('別台電腦來的開始、分段、停止一律 403', async () => {
    await startWith({ recordingMethod: 'in_app', isLocalRequest: () => false });
    const { body } = await createMeeting({ fileName: 'x', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    const id = body.meeting.meeting_id;
    expect((await post(`/api/meetings/${id}/recording/start`)).status).toBe(403);
    store.startRecording(id, Date.now(), 'in_app');
    expect((await putChunk(id, 0, 'aaa')).status).toBe(403);
    expect((await post(`/api/meetings/${id}/recording/stop`, { chunks: 0 })).status).toBe(403);
  });

  it('分段依序接上，停止帶段數：檔案變成音檔、大小補上、進轉錄', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    expect((await putChunk(id, 0, 'webm-head')).body).toEqual({ received_chunks: 1, received_bytes: 9 });
    expect((await putChunk(id, 1, '-cluster')).body).toEqual({ received_chunks: 2, received_bytes: 17 });

    const stopped = await post(`/api/meetings/${id}/recording/stop`, { chunks: 2 });
    expect(stopped.status).toBe(202);
    expect(stopped.body.meeting).toMatchObject({ status: 'TRANSCRIBING', has_audio: true, recording_method: null });
    expect(readFileSync(audioStore.pathFor(id), 'utf8')).toBe('webm-head-cluster');
    expect(store.getMeeting(id)?.source_file_size).toBe(17);
    expect(store.getRecording(id)?.stopped_at).not.toBeNull();
    expect(enqueued).toEqual([id]);
    expect(readdirSync(audioDir).filter(n => n.endsWith('.recording'))).toEqual([]);
  });

  it('重送已經收到的段：回目前進度、不重寫；跳號：409 講出要第幾段', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    const again = await putChunk(id, 0, 'aaa');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received_chunks: 1, received_bytes: 3 });
    const skipped = await putChunk(id, 2, 'ccc');
    expect(skipped.status).toBe(409);
    expect(skipped.body.error).toContain('下一段應該是第 1 段');
    expect(readFileSync(audioStore.recordingPathFor(id), 'utf8')).toBe('aaa');
  });

  it('空的段、超過上限的段、壞掉的段號都不收', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    expect((await putChunk(id, 0, Buffer.alloc(0))).status).toBe(400);
    expect((await putChunk(id, 'x', 'aaa')).status).toBe(400);
    expect((await putChunk(id, 0, Buffer.alloc(8 * 1024 * 1024 + 1))).status).toBe(413);
    expect(store.getRecording(id)?.received_chunks).toBe(0);
  });

  it('上一段還在寫的時候又送來一段：503 叫它等一下再送，不讓兩個寫入同時截檔', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    const { request } = await import('node:http');
    const port = Number(new URL(url).port);
    // 第一個請求只送一半 body、不結束，server 那頭就一直停在「讀這一段」
    const slow = request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/meetings/${id}/recording/chunks/0`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '6' } });
    slow.on('error', () => {});
    slow.write('aaa');
    await new Promise(r => setTimeout(r, 50));
    const res = await fetch(`${url}/api/meetings/${id}/recording/chunks/0`, { method: 'PUT', body: 'bbb' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    slow.end('aaa');
    await new Promise(r => setTimeout(r, 50));
    expect(readFileSync(audioStore.recordingPathFor(id), 'utf8')).toBe('aaaaaa');
    expect(store.getRecording(id)?.received_chunks).toBe(1);
  });

  it('上一次收尾改完檔名就斷了（狀態還是 RECORDING）：再按一次停止照常進轉錄（Codex review）', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    // 模擬 promoteRecording 做完、後面的資料庫更新還沒跑 server 就掛了
    store.markRecordingStopped(id, Date.now());
    audioStore.promoteRecording(id, 3);
    const res = await post(`/api/meetings/${id}/recording/stop`, { partial: true });
    expect(res.status).toBe(202);
    expect(readFileSync(audioStore.pathFor(id), 'utf8')).toBe('aaa');
  });

  it('有一段正在寫的時候不刪：503，寫完再刪就不留下沒人認領的錄音檔（Codex review）', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    const { request } = await import('node:http');
    const port = Number(new URL(url).port);
    const slow = request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/meetings/${id}/recording/chunks/0`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '6' } });
    const slowDone = new Promise<void>(resolve => slow.on('response', res => { res.resume(); res.on('end', () => resolve()); }));
    slow.on('error', () => {});
    slow.write('aaa');
    await new Promise(r => setTimeout(r, 50));
    const blocked = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(503);
    expect(store.getMeeting(id)).not.toBeNull();
    slow.end('aaa');
    await slowDone;
    expect((await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(readdirSync(audioDir).filter(n => n.endsWith('.recording'))).toEqual([]);
  });

  it('段數對不上不停止：狀態留在 RECORDING，訊息講差幾段', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    const res = await post(`/api/meetings/${id}/recording/stop`, { chunks: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('server 只收到 1 段');
    expect(store.getMeeting(id)?.status).toBe('RECORDING');
    expect(store.getRecording(id)?.stopped_at).toBeNull();
    // 補送完再停一次就好
    await putChunk(id, 1, 'bbb');
    await putChunk(id, 2, 'ccc');
    expect((await post(`/api/meetings/${id}/recording/stop`, { chunks: 3 })).status).toBe(202);
  });

  it('收尾失敗（錄音檔比收到的短）之後再按停止：講出同一個原因，不卡在「已經停過」', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaaaaa');
    writeFileSync(audioStore.recordingPathFor(id), 'aa');
    const first = await post(`/api/meetings/${id}/recording/stop`, { chunks: 1 });
    expect(first.status).toBe(500);
    expect(first.body.error).toContain('比已經收到的 6 bytes 短');
    const second = await post(`/api/meetings/${id}/recording/stop`, { chunks: 1 });
    expect(second.body.error).toContain('比已經收到的 6 bytes 短');
    // 救得回來的話（檔案補回去）照常收尾
    writeFileSync(audioStore.recordingPathFor(id), 'aaaaaa');
    expect((await post(`/api/meetings/${id}/recording/stop`, { chunks: 1 })).status).toBe(202);
  });

  it('收過段落、錄音檔卻不見了：退回 CREATED 講清楚，不每次收尾都 500（fable review）', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    rmSync(audioStore.recordingPathFor(id));
    const res = await post(`/api/meetings/${id}/recording/stop`, { partial: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('錄音檔不見了');
    expect(store.getMeeting(id)?.status).toBe('CREATED');
    expect(enqueued).toEqual([]);
  });

  it('停止沒講是哪一種收尾：400，不默默當成「收到幾段算幾段」', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    expect((await post(`/api/meetings/${id}/recording/stop`)).status).toBe(400);
    expect((await post(`/api/meetings/${id}/recording/stop`, { chunks: '1' })).status).toBe(400);
    expect(store.getMeeting(id)?.status).toBe('RECORDING');
  });

  it('救回中斷的錄音（partial）：收到幾段送幾段', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    const res = await post(`/api/meetings/${id}/recording/stop`, { partial: true });
    expect(res.status).toBe(202);
    expect(readFileSync(audioStore.pathFor(id), 'utf8')).toBe('aaa');
  });

  it('一段都沒收到就停止：退回 CREATED 等補音檔，不送一個空檔去轉錄', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    const res = await post(`/api/meetings/${id}/recording/stop`, { partial: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('一段都沒有送到');
    expect(store.getMeeting(id)?.status).toBe('CREATED');
    expect(audioStore.exists(id)).toBe(false);
    expect(enqueued).toEqual([]);
  });

  it('server 換成語音備忘錄模式重開，上一次 app 內錄音照 in_app 收尾，不去叫語音備忘錄', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    await new Promise<void>(resolve => server.close(() => resolve()));
    await startWith({ recordingMethod: 'voice_memo', voiceMemoRecorder: null });
    expect((await post(`/api/meetings/${id}/recording/stop`, { chunks: 1 })).status).toBe(202);
  });

  it('語音備忘錄在錄的會不收 app 的段落', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const { body } = await createMeeting({ fileName: 'x', fileSize: 0, participantIds: [TEST_EMPLOYEE_ID] });
    const id = body.meeting.meeting_id;
    store.startRecording(id, Date.now(), 'voice_memo');
    const res = await putChunk(id, 0, 'aaa');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('語音備忘錄在錄');
  });

  it('停止之後再送段落：409，不接在已經變成音檔的檔後面', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    await post(`/api/meetings/${id}/recording/stop`, { chunks: 1 });
    expect((await putChunk(id, 1, 'late')).status).toBe(409);
  });

  it('刪除錄音中的會：不叫語音備忘錄，已送到的段落一起刪', async () => {
    await startWith({ recordingMethod: 'in_app' });
    const id = await startRecording();
    await putChunk(id, 0, 'aaa');
    const res = await fetch(`${url}/api/meetings/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.getMeeting(id)).toBeNull();
    expect(readdirSync(audioDir).filter(n => n.endsWith('.recording'))).toEqual([]);
  });
});

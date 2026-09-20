import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioFileStore, createAudioFileStore } from './audioFileStore';
import { createApp } from './createApp';
import { GeminiServerClient } from './geminiServerClient';
import { ListenConfig } from './httpGuards';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { MATCH_KEY_VERSION } from './topicTag';
import { TranscriptionQueue } from './transcriptionQueue';
import { TopicLinker } from './topicLinker';
import { createVaultProjector, VaultProjector } from './vaultProjector';

/**
 * 路由層測試：跑的是 server.ts 真的用的那個 app（同一支 createApp、同一組 middleware 順序）。
 *
 * 之前上傳路由一條測試都沒有，「同一場會並行上傳會混成一個檔」就是這樣躲過 412 條測試的。
 */

const T0 = 1_700_000_000_000;

let db: DatabaseSync;
let store: MeetingStore;
let audioDir: string;
let audioStore: AudioFileStore;
let server: Server;
let url: string;
let enqueued: string[];
let cancelled: string[];

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

// 假佇列預設模仿真實佇列的同步行為：enqueue 會一路跑到 pipeline 的第一個 await，
// 那時狀態已經被改成 TRANSCRIBING。S5 要驗的就是回應有沒有反映這件事
const fakeQueue = (onEnqueue?: (id: string) => void, queued: string[] = []): TranscriptionQueue => ({
  enqueue: (id: string) => { enqueued.push(id); onEnqueue?.(id); },
  has: (id: string) => queued.includes(id),
  cancel: (id: string) => { cancelled.push(id); return true; },
  pending: 0,
  running: null,
  whenIdle: async () => {},
});

const startWith = async (options: {
  listenConfig?: Partial<ListenConfig>;
  queue?: TranscriptionQueue;
  audioStore?: AudioFileStore;
  topicLinker?: TopicLinker | null;
  vaultProjector?: VaultProjector | null;
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
    audioStore: options.audioStore ?? audioStore,
    // 預設佇列照 pipeline.run 的第一步做：只有 CREATED 才推進 TRANSCRIBING（已經在轉的不重設）
    transcriptionQueue: options.queue ?? fakeQueue(id => {
      if (store.getMeeting(id)?.status === 'CREATED') store.setStatus(id, 'TRANSCRIBING', Date.now());
    }),
    geminiClient: fakeGemini(),
    llmLogger: { log: () => {} },
    // 預設不給 linker：既有的測試不該因為 W4 多出一條背景呼叫而改變行為
    topicLinker: options.topicLinker ?? null,
    // 預設不給 projector：既有的測試不該因為 W5 多出一條檔案 I/O 而改變行為
    vaultProjector: options.vaultProjector ?? null,
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const start = (options: {
  listenConfig?: Partial<ListenConfig>;
  queue?: TranscriptionQueue;
  topicLinker?: TopicLinker | null;
  vaultProjector?: VaultProjector | null;
} = {}) =>
  startWith(options);

const createMeeting = async (body: Record<string, unknown> = { fileName: 'a.m4a', fileSize: 10 }) => {
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
  audioDir = mkdtempSync(join(tmpdir(), 'meetpilot-app-'));
  audioStore = createAudioFileStore(audioDir);
  enqueued = [];
  cancelled = [];
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  rmSync(audioDir, { recursive: true, force: true });
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
  it('刪掉會議時順手把排隊中的那筆從佇列移除', async () => {
    await start({ queue: fakeQueue() });
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });

    const res = await fetch(`${url}/api/meetings/m-1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(cancelled).toEqual(['m-1']);
    expect(store.getMeeting('m-1')).toBeNull();
  });
});

describe('W4：關聯的路由', () => {
  /** 把一場會推到 READY，並讓它有一筆既有關聯可查 */
  const readyPair = () => {
    for (const id of ['m-1', 'm-2']) {
      store.createMeeting({ meeting_id: id, created_at: Date.now(), source_file_name: 'a.m4a', source_file_size: 1 });
      store.setStatus(id, 'TRANSCRIBING', Date.now());
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
    const vaultProjector = createVaultProjector({ store, vaultDir, now: () => T0 });
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
    const vaultProjector = createVaultProjector({ store, vaultDir, now: () => T0 });
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
    const vaultProjector = createVaultProjector({ store, vaultDir, now: () => T0 });
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
    const { status, body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, title: '  週會  ' });
    expect(status).toBe(201);
    expect(body.meeting.title).toBe('週會');
  });

  it('空白、超過 100 字、含控制字元的標題回 400，不建立會議', async () => {
    await start();
    for (const title of ['   ', 'x'.repeat(101), '週會\n第二週']) {
      const { status, body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10, title });
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    }
    expect((await (await fetch(`${url}/api/meetings`)).json() as any).meetings).toEqual([]);
  });

  it('沒給 title 時是 null，不是空字串', async () => {
    await start();
    const { body } = await createMeeting({ fileName: 'a.m4a', fileSize: 10 });
    expect(body.meeting.title).toBeNull();
  });
});

describe('PATCH /api/meetings/:id/title', () => {
  const readyMeeting = (id = 'm-1') => {
    store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 1 });
    store.setStatus(id, 'TRANSCRIBING', T0);
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

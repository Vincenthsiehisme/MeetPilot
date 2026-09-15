import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioFileStore, createAudioFileStore } from './audioFileStore';
import { createApp } from './createApp';
import { GeminiServerClient } from './geminiServerClient';
import { ListenConfig } from './httpGuards';
import { openMeetingDb } from './meetingDb';
import { MeetingStore, createMeetingStore } from './meetingStore';
import { TranscriptionQueue } from './transcriptionQueue';

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
  analyzeTranscript: async () => ({ overview: 'x', topics: [], decisions: [], action_items: [] }),
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
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const start = (options: { listenConfig?: Partial<ListenConfig>; queue?: TranscriptionQueue } = {}) =>
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

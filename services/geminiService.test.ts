import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { polishTranscript, askDocumentStream } from './geminiService';
import { HttpError } from './httpError';
import type { TranscriptSegment } from '../types';

// 這個檔測的是重試鏈本身：postJson / postStream 怎麼把回應翻成 HttpError，
// 以及 withRetry 在什麼時候重試、什麼時候放棄。fetch 全部換成替身，退避用 fake timers 推，
// 測試不用真的等 8 秒。

const transcript: TranscriptSegment[] = [{ start: 0, end: 3, text: '測試內容' }];

// 串流回應替身：reads 是每次 reader.read() 要回的東西。字串代表一段 SSE 內容，
// Error 代表那次 read 直接 reject。不用真的 ReadableStream，才能精準指定第幾次 read 壞掉。
const streamResponse = (reads: Array<string | Error>): Response => {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= reads.length) return { done: true, value: undefined };
          const next = reads[i++];
          if (next instanceof Error) throw next;
          return { done: false, value: encoder.encode(next) };
        },
      }),
    },
  } as unknown as Response;
};

let fetchMock: ReturnType<typeof vi.fn>;

// 每次 fetch 都要給新的 Response：body 只能讀一次，重用同一個物件第二次重試就會炸在讀 body 上
const respondWith = (make: () => Response) => fetchMock.mockImplementation(async () => make());

// withRetry 的退避是真的 setTimeout。下一輪的 timer 要等上一次 fetch 的 microtask 跑完才排得出來，
// 所以分多輪推進，一次推滿整個可能的退避區間。
const drainRetries = async () => {
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(120_000);
  }
};

describe('geminiService 的重試鏈', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // withRetry 每次重試都會 console.warn，測試輸出不需要看
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('429 回應翻成帶 status 與 Retry-After 的 HttpError，訊息用 server 的 error 欄位', async () => {
    respondWith(() => new Response(JSON.stringify({ error: '請求過於頻繁，請稍後再試' }), {
      status: 429,
      headers: { 'Retry-After': '7' },
    }));

    const settled = polishTranscript(transcript).catch(err => err);
    await drainRetries();
    const err = await settled;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(7);
    expect(err.message).toBe('請求過於頻繁，請稍後再試');
  });

  it('500 回 HTML 時給「伺服器短暫無回應」，沒有 Retry-After 就是 undefined', async () => {
    respondWith(() => new Response('<!doctype html><html><body>Bad Gateway</body></html>', { status: 500 }));

    const settled = polishTranscript(transcript).catch(err => err);
    await drainRetries();
    const err = await settled;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('伺服器短暫無回應 (HTTP 500)，請稍候重試。');
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('Retry-After 是 HTTP-date 這種非純數字時當作 server 沒給', async () => {
    respondWith(() => new Response(JSON.stringify({ error: '請求過於頻繁' }), {
      status: 429,
      headers: { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    }));

    const settled = polishTranscript(transcript).catch(err => err);
    await drainRetries();
    const err = await settled;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('第一次 429、第二次成功時回傳成功結果，fetch 剛好兩次', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: '請求過於頻繁' }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ content: '修潤後的內容' }), { status: 200 }));

    const settled = polishTranscript(transcript);
    await drainRetries();

    await expect(settled).resolves.toBe('修潤後的內容');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('連續三次 429 就放棄，丟出最後那個 HttpError，fetch 剛好三次', async () => {
    respondWith(() => new Response(JSON.stringify({ error: '請求過於頻繁' }), {
      status: 429,
      headers: { 'Retry-After': '2' },
    }));

    const settled = polishTranscript(transcript).catch(err => err);
    await drainRetries();
    const err = await settled;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    // maxRetries = 3：第三次失敗後不再重試
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('askDocumentStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('連線撞 429 會重試，接上串流後完整 yield 內容', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: '請求過於頻繁' }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockImplementationOnce(async () => streamResponse([
        'data: {"text":"你好"}\n\n',
        'data: {"text":"世界"}\n\n',
        'data: [DONE]\n\n',
      ]));

    const received: string[] = [];
    const settled = (async () => {
      for await (const chunk of askDocumentStream(transcript, [], '問題')) received.push(chunk);
    })().catch(err => err);

    await drainRetries();
    const outcome = await settled;

    expect(outcome).toBeUndefined();
    expect(received).toEqual(['你好', '世界']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('連線階段一直 429 就丟 HttpError，一個字都不會 yield', async () => {
    respondWith(() => new Response(JSON.stringify({ error: '請求過於頻繁' }), {
      status: 429,
      headers: { 'Retry-After': '2' },
    }));

    const received: string[] = [];
    const settled = (async () => {
      for await (const chunk of askDocumentStream(transcript, [], '問題')) received.push(chunk);
    })().catch(err => err);

    await drainRetries();
    const err = await settled;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(received).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('開始 yield 之後不重試：串流讀到一半壞掉就直接往外丟', async () => {
    respondWith(() => streamResponse([
      'data: {"text":"開頭"}\n\n',
      new Error('串流中斷'),
    ]));

    const received: string[] = [];
    const settled = (async () => {
      for await (const chunk of askDocumentStream(transcript, [], '問題')) received.push(chunk);
    })().catch(err => err);

    await drainRetries();
    const err = await settled;

    expect(received).toEqual(['開頭']);
    expect(err.message).toBe('串流中斷');
    // 重試會讓使用者在同一則回覆裡看到重複的字，所以只連線一次
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

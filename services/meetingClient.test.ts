import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  confirmNameMention,
  createMeeting,
  deleteMeeting,
  getMeetingDetail,
  importLegacyJobs,
  listMeetings,
  listPeopleWithSingleRetry,
  meetingContextField,
  patchAnalysis,
  patchTitle,
  patchTranscript,
  retryMeeting,
  submitAudio,
  uploadAudio
} from './meetingClient';
import { AUDIO_CONTENT_TYPE } from './meetingApi';
import { HttpError } from './httpError';
import type { Meeting } from '../types';
import type { AnalysisV3 } from './analysisContract';

// 這個檔測的是「送出音檔的新路徑」長什麼樣：建立 Meeting 之後把 File 本體 PUT 上去。
// 上傳那一次的 body 與 Content-Type 是防回歸的重點 —— 包成 JSON 或 base64 就是把
// 106 分鐘會議壓垮分頁的那個記憶體天花板裝回去。

const meeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  meeting_id: 'm_1',
  topic_extraction_status: null,
  topic_extraction_error: null,
  title: null,
  status: 'CREATED',
  created_at: 1000,
  updated_at: 1000,
  source_file_name: 'a.m4a',
  source_file_size: 12,
  origin: 'native',
  error: null,
  processed_slices: null,
  total_slices: null,
  meeting_context: null,
  ...overrides,
});

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 201 ? 'Created' : status === 202 ? 'Accepted' : 'OK',
  headers: new Headers(headers),
  text: async () => body,
} as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

describe('meetingClient', () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('建立 Meeting 後把 File 本體 PUT 上去，不包 JSON、不 base64', async () => {
    const created = meeting();
    const transcribing = meeting({ status: 'TRANSCRIBING' });
    fetchMock
      .mockResolvedValueOnce(respond(201, JSON.stringify({ meeting: created })))
      .mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: transcribing })));

    const file = new File([new Uint8Array([1, 2, 3])], 'a.m4a', { type: 'audio/mp4' });

    const createdBack = await createMeeting({ fileName: file.name, fileSize: file.size, participantIds: ['p-1'] });
    expect(createdBack).toEqual(created);

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('/api/meetings');
    expect(createInit.method).toBe('POST');
    expect(createInit.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(createInit.body)).toEqual({ fileName: 'a.m4a', fileSize: 3, participantIds: ['p-1'] });

    const uploaded = await uploadAudio(createdBack.meeting_id, file);
    expect(uploaded).toEqual(transcribing);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe('/api/meetings/m_1/audio');
    expect(uploadInit.method).toBe('PUT');
    expect(uploadInit.headers['Content-Type']).toBe(AUDIO_CONTENT_TYPE);
    expect(uploadInit.headers['Content-Type']).toBe('application/octet-stream');
    // body 必須是 File／Blob 本身。字串就代表被 JSON 或 base64 包過了
    expect(uploadInit.body).toBe(file);
    expect(uploadInit.body).toBeInstanceOf(Blob);
    expect(typeof uploadInit.body).not.toBe('string');
  });

  it('meeting_id 有特殊字元時會被 encode，不會拼出別條路徑', async () => {
    fetchMock.mockResolvedValue(respond(202, JSON.stringify({ meeting: meeting() })));
    await uploadAudio('a/b?c', new File(['x'], 'x.wav'));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/meetings/a%2Fb%3Fc/audio');
  });

  it('清單、詳情與重試各自打對的路徑與方法', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ meetings: [meeting()] })));
    expect(await listMeetings()).toEqual([meeting()]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/meetings');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');

    const detail = { meeting: meeting(), transcript: null, analysis: null, tags: [] };
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify(detail)));
    expect(await getMeetingDetail('m_1')).toEqual(detail);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/meetings/m_1');
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');

    fetchMock.mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: meeting({ status: 'TRANSCRIBING' }) })));
    expect((await retryMeeting('m_1')).status).toBe('TRANSCRIBING');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/meetings/m_1/retry');
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
  });

  it('人員名單第一次載入失敗時自動重試一次', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(respond(200, JSON.stringify({
        people: [{ employeeId: 'p-1', displayName: '陳國煌', title: null, department: null }],
      })));

    await expect(listPeopleWithSingleRetry()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('搬遷把 jobs 與 blobIds 一起送到 import 端點', async () => {
    const response = {
      imported: ['m_1'], skippedExisting: [], rejected: [], notes: [], audioStillInBrowser: [],
    };
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify(response)));

    expect(await importLegacyJobs({ jobs: [], blobIds: ['job_1'] })).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ jobs: [], blobIds: ['job_1'] });
  });

  it('刪除會議打 DELETE，回傳 server 說刪掉的是哪一場', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ deleted: true, meetingId: 'm_1' })));

    expect(await deleteMeeting('m_1')).toEqual({ deleted: true, meetingId: 'm_1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/meetings/m_1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('刪除正在跑的會議回 409 時，server 的訊息原樣帶出來', async () => {
    // 「為什麼不能刪、什麼時候可以刪」全在這句話裡，被翻掉就沒了
    const reason = '這場會議正在轉錄，等它結束或失敗之後再刪。';
    fetchMock.mockResolvedValueOnce(respond(409, JSON.stringify({ error: reason })));

    const err = await deleteMeeting('m_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toBe(reason);
  });

  it('刪除不存在的會議回 404，訊息也照 server 的', async () => {
    fetchMock.mockResolvedValueOnce(respond(404, JSON.stringify({ error: '找不到這場會議' })));

    const err = await deleteMeeting('nope').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toBe('找不到這場會議');
  });

  it('改逐字稿只送有給的欄位，PATCH 到 transcript 子路徑', async () => {
    const transcript = { segments: [{ start: 0, end: 1, text: '改過' }], polished_content: null };
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ transcript })));

    expect(await patchTranscript('m_1', { segments: transcript.segments })).toEqual(transcript);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/m_1/transcript');
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ segments: transcript.segments });
    expect(Object.keys(JSON.parse(init.body))).not.toContain('polished_content');
  });

  it('清掉潤稿送的是 null，跟沒給這個欄位不一樣', async () => {
    const transcript = { segments: [], polished_content: null };
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ transcript })));

    await patchTranscript('m_1', { polished_content: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ polished_content: null });
  });

  it('還沒轉錄完就改逐字稿回 404，訊息帶出來', async () => {
    fetchMock.mockResolvedValueOnce(respond(404, JSON.stringify({ error: '這場會議還沒有逐字稿' })));

    const err = await patchTranscript('m_1', { segments: [] }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toBe('這場會議還沒有逐字稿');
  });

  it('改分析是整份覆寫，body 包在 analysis 底下', async () => {
    const analysis: AnalysisV3 = {
      contract_version: 3,
      overview: '總結',
      topics: [],
      decisions: [],
      action_items: [{
        text: '寄簡報', source_meeting_id: 'm_1', created_at: 1, status: 'unknown',
        assignee: null, due: null, evidence: null,
      }],
      open_questions: [],
    };
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ analysis })));

    expect(await patchAnalysis('m_1', analysis)).toEqual(analysis);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/m_1/analysis');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ analysis });
  });

  it('分析五欄全空被 server 擋下時回 400，訊息帶出來', async () => {
    fetchMock.mockResolvedValueOnce(respond(400, JSON.stringify({ error: '分析內容是空的，不寫入' })));

    const empty: AnalysisV3 = { contract_version: 3, overview: '', topics: [], decisions: [], action_items: [], open_questions: [] };
    const err = await patchAnalysis('m_1', empty).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe('分析內容是空的，不寫入');
  });

  it('對既有的 CREATED 會議補送音檔只打 PUT，不會再 POST 建新的一筆', async () => {
    // 上傳失敗留下的 CREATED 會議要能救回來。這裡再 POST 一次的話，
    // 每失敗一次列表就多一筆殭屍會議，舊的那筆永遠沒人補音檔
    fetchMock.mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: meeting({ status: 'TRANSCRIBING' }) })));
    const onCreated = vi.fn();

    const back = await submitAudio(new File(['x'], 'b.wav'), { meetingId: 'm_existing' }, null, null, onCreated);

    expect(back.status).toBe('TRANSCRIBING');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/meetings/m_existing/audio');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(fetchMock.mock.calls.some(([, init]: any[]) => init.method === 'POST')).toBe(false);
    // 沒有建立新的一場，就不該通知呼叫端「建好了」
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('沒有指定既有會議時才建立新的一場，並在開始上傳前先通知呼叫端', async () => {
    const created = meeting();
    fetchMock
      .mockResolvedValueOnce(respond(201, JSON.stringify({ meeting: created })))
      .mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: meeting({ status: 'TRANSCRIBING' }) })));
    const onCreated = vi.fn();

    await submitAudio(new File(['x'], 'a.m4a'), null, ['p-1'], null, onCreated);

    expect(fetchMock.mock.calls.map(([url, init]: any[]) => `${init.method} ${url}`)).toEqual([
      'POST /api/meetings',
      'PUT /api/meetings/m_1/audio',
    ]);
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('新建時背景補充帶進 POST 的 meetingContext，頭尾空白去掉', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(201, JSON.stringify({ meeting: meeting() })))
      .mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: meeting({ status: 'TRANSCRIBING' }) })));

    await submitAudio(new File(['x'], 'a.m4a'), null, ['p-1'], '  第三次談採購  ');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      fileName: 'a.m4a', fileSize: 1, participantIds: ['p-1'], meetingContext: '第三次談採購',
    });
  });

  it('背景補充是空白或 null 時 POST 不帶 meetingContext 這個欄位', async () => {
    for (const blank of ['', '   \n ', null]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(respond(201, JSON.stringify({ meeting: meeting() })))
        .mockResolvedValueOnce(respond(202, JSON.stringify({ meeting: meeting({ status: 'TRANSCRIBING' }) })));

      await submitAudio(new File(['x'], 'a.m4a'), null, ['p-1'], blank);

      expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body))).not.toContain('meetingContext');
    }
  });

  it('meetingContextField：錄音建會議用同一支判斷，空白回空物件', () => {
    expect(meetingContextField('  ')).toEqual({});
    expect(meetingContextField(null)).toEqual({});
    expect(meetingContextField(' 季度檢討 ')).toEqual({ meetingContext: '季度檢討' });
  });

  it('建立成功但上傳失敗時，呼叫端已經拿到那場會的 id（才找得到它去補音檔）', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(201, JSON.stringify({ meeting: meeting() })))
      .mockResolvedValueOnce(respond(500, JSON.stringify({ error: '寫入音檔失敗' })));
    const onCreated = vi.fn();

    await expect(submitAudio(new File(['x'], 'a.m4a'), null, ['p-1'], null, onCreated)).rejects.toThrow('寫入音檔失敗');
    expect(onCreated).toHaveBeenCalledWith(meeting());
  });

  it('錯誤回應翻成 HttpError，訊息取契約的 error 欄位，Retry-After 帶著', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, JSON.stringify({ error: '請求過於頻繁' }), { 'Retry-After': '30' }));

    const err = await listMeetings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).message).toBe('請求過於頻繁');
    expect((err as HttpError).retryAfterSeconds).toBe(30);
  });

  it('Retry-After 不是整數秒就當 server 沒給，不自己編一個時間', async () => {
    fetchMock.mockResolvedValueOnce(respond(429, JSON.stringify({ error: '太快了' }), { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }));

    const err = await listMeetings().catch((e: unknown) => e);
    expect((err as HttpError).retryAfterSeconds).toBeUndefined();
  });

  it('server 重啟時回的 HTML 不會被當成資料吞下去', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, '<!doctype html><html><body>502</body></html>'));
    await expect(listMeetings()).rejects.toThrow('網頁內容');
  });

  it('非 2xx 的 HTML 回應講的是伺服器無回應，不是解析失敗', async () => {
    fetchMock.mockResolvedValueOnce(respond(502, '<html>bad gateway</html>'));
    const err = await listMeetings().catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).message).toContain('伺服器短暫無回應');
  });

  it('改標題打 PATCH /title，body 只有 title，回傳 server 存下來的那一份', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ title: '週會' })));

    await expect(patchTitle('m_1', ' 週會 ')).resolves.toBe('週會');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/m_1/title');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: ' 週會 ' });
  });

  it('確認人名打 POST /name-mentions/confirm，body 帶 segment_index／original_text／employee_id', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, JSON.stringify({ nameMentions: [] })));

    await expect(confirmNameMention('m_1', 3, '小明', 'p-1')).resolves.toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/meetings/m_1/name-mentions/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ segment_index: 3, original_text: '小明', employee_id: 'p-1' });
  });

  it('確認的人不是這場會的與會者時回 400，訊息帶出來', async () => {
    fetchMock.mockResolvedValueOnce(respond(400, JSON.stringify({ error: '員編 p-2 不是這場會的與會者' })));

    const err = await confirmNameMention('m_1', 0, '小明', 'p-2').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe('員編 p-2 不是這場會的與會者');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { AudioFileStore, createAudioFileStore, resolveAudioDir } from './audioFileStore';
import { checkBasicAuth, createRateLimiter } from './httpGuards';

// node:fs 的 ESM 匯出不能 vi.spyOn，只能整個模組換掉，其餘原樣代理給真實實作（同 audioSlicer.test.ts）。
// 預設 rmSync 照真的刪；只有測「殘檔被鎖住」那一條才覆寫
const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => rmSyncMock(...args) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

let dir: string;
let store: AudioFileStore;

beforeEach(() => {
  rmSyncMock.mockImplementation((...args: Parameters<typeof realFs.rmSync>) => realFs.rmSync(...args));
  dir = mkdtempSync(join(tmpdir(), 'meetpilot-audio-'));
  store = createAudioFileStore(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  realFs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveAudioDir', () => {
  it('沒設就用 data/audio', () => {
    expect(resolveAudioDir({})).toBe(resolve('data/audio'));
  });

  it('設了就用設的，前後空白不算', () => {
    expect(resolveAudioDir({ MEETPILOT_AUDIO_DIR: '  /var/meetpilot/audio  ' })).toBe(resolve('/var/meetpilot/audio'));
  });
});

describe('pathFor', () => {
  it('檔名只由 meeting_id 決定，重啟後只憑 id 就找得到', () => {
    expect(store.pathFor('m-1')).toBe(join(dir, 'm-1.audio'));
    expect(store.pathFor('job_1700000000000')).toBe(join(dir, 'job_1700000000000.audio'));
  });

  it.each(['../etc/passwd', 'a/b', '', 'm 1', 'm.1'])(
    'meeting_id %s 不能當檔名時拋錯，不消毒後照用',
    (badId) => {
      expect(() => store.pathFor(badId)).toThrow(/不能當成檔名/);
    },
  );
});

describe('saveFrom', () => {
  it('寫進去的內容與讀出來的位元組一致，並回報大小', async () => {
    const payload = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10]);
    const saved = await store.saveFrom('m-1', Readable.from([payload]));

    expect(saved.bytes).toBe(payload.length);
    expect(readFileSync(saved.path)).toEqual(payload);
    expect(store.exists('m-1')).toBe(true);
    expect(store.sizeOf('m-1')).toBe(payload.length);
  });

  it('來源中途壞掉時不留半個檔案：續傳掃描不能把截斷的上傳當成完整音檔', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from('RIFF'));
        this.destroy(new Error('連線中斷'));
      },
    });

    await expect(store.saveFrom('m-1', broken)).rejects.toThrow(/連線中斷/);
    expect(store.exists('m-1')).toBe(false);
    expect(existsSync(`${store.pathFor('m-1')}.part`)).toBe(false);
  });

  it('寫入途中最終檔名不能存在：重啟掃描看到它就會把半個上傳當成完整音檔送去轉錄', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('RIFF'));
    const saving = store.saveFrom('m-1', source);
    // createWriteStream 開檔是非同步的，等第一塊真的落到磁碟再看這一刻的目錄狀態。
    // .part 的名字每次唯一（並行上傳不能共用），所以用副檔名找而不是寫死路徑
    const parts = () => readdirSync(dir).filter(name => name.endsWith('.part'));
    for (let i = 0; i < 50 && parts().length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(parts()).toHaveLength(1);
    // 這一行是重點：寫到一半時最終檔名不能出現，否則重啟掃描的 exists() 會是 true
    expect(store.exists('m-1')).toBe(false);

    source.push(null);
    await saving;
    expect(store.exists('m-1')).toBe(true);
    expect(parts()).toEqual([]);
  });

  it('重新上傳同一場會時覆蓋掉舊的', async () => {
    await store.saveFrom('m-1', Readable.from([Buffer.from('old-and-longer')]));
    await store.saveFrom('m-1', Readable.from([Buffer.from('new')]));
    expect(readFileSync(store.pathFor('m-1')).toString()).toBe('new');
  });
});

describe('同一場會的並行寫入', () => {
  // 逐塊送、每塊之間讓出 event loop，讓兩個寫入真的交錯。整份一次 push 的話不會交錯，測不到東西
  const chunked = (fill: number, chunks: number) => Readable.from((async function* () {
    for (let i = 0; i < chunks; i += 1) {
      yield Buffer.alloc(64 * 1024, fill);
      await new Promise(resolve => setImmediate(resolve));
    }
  })());

  it('兩個並行寫入各自開一個 .part，固定檔名那個從頭到尾不存在', async () => {
    // 上一支測試靠內容同質性抓混檔，那要兩邊真的交錯才驗得到，全套跑起來時
    // 負載會改變交錯時機，實測 12 次有 2 次即使把檔名改回固定的也全綠。
    // 這一支直接看檔名：固定名的話兩邊開的是同一個檔，永遠只會有一個 .part，
    // 而且它的名字就是 `<id>.audio.part`。與負載無關
    const a = new Readable({ read() {} });
    const b = new Readable({ read() {} });
    const savingA = store.saveFrom('m-1', a);
    const savingB = store.saveFrom('m-1', b);
    a.push(Buffer.alloc(64 * 1024, 1));
    b.push(Buffer.alloc(64 * 1024, 2));

    const parts = () => readdirSync(dir).filter(name => name.endsWith('.part'));
    for (let i = 0; i < 200 && parts().length < 2; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(parts()).toHaveLength(2);
    expect(new Set(parts()).size).toBe(2);
    expect(existsSync(`${store.pathFor('m-1')}.part`)).toBe(false);

    a.push(null);
    b.push(null);
    await Promise.allSettled([savingA, savingB]);
  });

  it('兩個並行寫入不會混成一個檔：.part 的名字每次唯一', async () => {
    await Promise.allSettled([
      store.saveFrom('m-1', chunked(1, 48)),
      store.saveFrom('m-1', chunked(2, 16)),
    ]);

    const content = readFileSync(store.pathFor('m-1'));
    // 固定的 .part 名會讓兩邊寫進同一個檔：後到的先改名，先到的 fd 繼續往已經改名的檔案寫，
    // 最後那個檔是兩次上傳混出來的（實測過）。內容只能整份來自其中一次
    expect(content.every(byte => byte === content[0])).toBe(true);
    expect([48 * 64 * 1024, 16 * 64 * 1024]).toContain(content.length);
  });
});

describe('removePartialUploads', () => {
  it('清掉沒寫完的 .part，完整音檔不動', async () => {
    await store.saveFrom('m-done', Readable.from([Buffer.from('RIFF')]));
    writeFileSync(join(dir, 'm-broken.audio.7f3a.part'), 'RI');
    writeFileSync(join(dir, 'm-another.audio.9c21.part'), 'RI');

    const removed = store.removePartialUploads();

    expect(removed).toHaveLength(2);
    expect(existsSync(join(dir, 'm-broken.audio.7f3a.part'))).toBe(false);
    expect(existsSync(join(dir, 'm-another.audio.9c21.part'))).toBe(false);
    expect(store.exists('m-done')).toBe(true);
  });

  it('目錄乾淨時回空陣列，不拋錯', () => {
    expect(store.removePartialUploads()).toEqual([]);
  });

  it('某個 .part 被鎖住刪不掉（EBUSY）時其餘照刪、整支不拋、只 warn 路徑與錯誤碼，回傳不含刪不掉的那個', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const locked = join(dir, 'm-locked.audio.slice-1.part');
    const other = join(dir, 'm-other.audio.7f3a.part');
    const temp = store.tempPathFor('m-rec');
    writeFileSync(locked, 'x');
    writeFileSync(other, 'x');
    writeFileSync(temp, 'x');
    rmSyncMock.mockImplementation((path: string, ...rest: unknown[]) => {
      if (path === locked) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY' });
      }
      return (realFs.rmSync as (...args: unknown[]) => void)(path, ...rest);
    });

    // server 在 listen 前呼叫這支：拋了 server 就起不來
    const removed = store.removePartialUploads();

    expect([...removed].sort()).toEqual([other, temp].sort());
    expect(existsSync(other)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(locked)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain(locked);
    expect(String(warn.mock.calls[0].join(' '))).toContain('EBUSY');
  });

  it('語音備忘錄取檔留下的 _part 暫存檔一起清掉', async () => {
    await store.saveFrom('m-done', Readable.from([Buffer.from('RIFF')]));
    const temp = store.tempPathFor('m-rec');
    writeFileSync(temp, 'half');
    expect(store.removePartialUploads()).toEqual([temp]);
    expect(store.exists('m-done')).toBe(true);
  });
});

describe('tempPathFor', () => {
  it('在音檔目錄裡、每次唯一、整個檔名沒有點（shortcuts 遇到不認得的副檔名會安靜不寫檔）', () => {
    const a = store.tempPathFor('m-1');
    const b = store.tempPathFor('m-1');
    expect(a).not.toBe(b);
    expect(a.startsWith(`${dir}${sep}`)).toBe(true);
    expect(basename(a)).not.toContain('.');
  });

  it('不合法的 meeting_id 拋錯，跟 pathFor 同一條規則', () => {
    expect(() => store.tempPathFor('../evil')).toThrow(/不能當成檔名/);
  });
});

describe('remove', () => {
  it('刪掉之後 exists 是 false', async () => {
    await store.saveFrom('m-1', Readable.from([Buffer.from('x')]));
    store.remove('m-1');
    expect(store.exists('m-1')).toBe(false);
  });

  it('刪一個不存在的不拋錯：呼叫端要的是「之後不會再佔著空間」', () => {
    expect(() => store.remove('m-nope')).not.toThrow();
  });
});

/**
 * 上傳路徑的 middleware 順序（AC-T1-6）。
 *
 * 這裡照 server.ts 的順序疊一份：限流 → Basic Auth → 原始位元組的 PUT → express.json /
 * express.urlencoded。要驗的是三件事：octet-stream 的 body 不會被 body parser 吃掉、
 * 限流與 Basic Auth 在這條路徑上仍然生效。middleware 順序是這個 repo 的已知地雷（AGENTS.md），
 * 順序改錯不會有任何錯誤，只會變成未認證的請求先被讀完整個 body。
 */
const startUploadApp = async (store: AudioFileStore, options: { limit: number }) => {
  const app = express();
  const limiter = createRateLimiter({ limit: options.limit, windowMs: 60_000 });
  const credentials = { user: 'u', password: 'p' };

  app.use('/api', (req, res, next) => {
    if (!limiter.check(req.ip ?? 'unknown').allowed) return res.status(429).json({ error: 'too many' });
    next();
  });
  app.use('/api', (req, res, next) => {
    if (!checkBasicAuth(req.headers.authorization, credentials)) return res.status(401).json({ error: 'auth' });
    next();
  });
  app.put('/api/meetings/:id/audio', async (req, res) => {
    const saved = await store.saveFrom(req.params.id, req);
    res.status(202).json({ bytes: saved.bytes });
  });
  app.use('/api', express.json({ limit: '50mb' }));
  app.use('/api', express.urlencoded({ limit: '50mb', extended: true }));

  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}` };
};

describe('app 內錄音的段落（E4）', () => {
  const chunk = (text: string) => Buffer.from(text);

  it('依序接起來，回傳的長度就是檔案長度', () => {
    expect(store.appendRecordingChunk('m-1', 0, chunk('aaa'))).toBe(3);
    expect(store.appendRecordingChunk('m-1', 3, chunk('bbbb'))).toBe(7);
    expect(readFileSync(store.recordingPathFor('m-1'), 'utf8')).toBe('aaabbbb');
  });

  it('上一次寫到一半或沒記進資料庫就斷了：多出來的先截掉，重送的那段不會跟殘留混在一起', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    // 資料庫還記著 3，檔案後面卻多了一截（server 在寫檔途中、或寫完檔還沒更新進度時掛掉）。
    // 殘留比重送的那段長：只靠「同一個位置再寫一次」蓋不掉尾巴
    writeFileSync(store.recordingPathFor('m-1'), 'aaa-torn-write-leftover');
    expect(store.appendRecordingChunk('m-1', 3, chunk('bbbb'))).toBe(7);
    expect(readFileSync(store.recordingPathFor('m-1'), 'utf8')).toBe('aaabbbb');
  });

  it('檔案比已收到的短（被刪掉一截）就拋錯，不接出一個缺了中間的檔', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    expect(() => store.appendRecordingChunk('m-1', 10, chunk('bbbb'))).toThrow(/比已經收到的 10 bytes 短/);
    expect(readFileSync(store.recordingPathFor('m-1'), 'utf8')).toBe('aaa');
  });

  it('已經收過段落、檔案卻不見了：拋錯，不從頭建一個新檔', () => {
    expect(() => store.appendRecordingChunk('m-1', 3, chunk('bbbb'))).toThrow(/錄音檔不見了/);
    expect(existsSync(store.recordingPathFor('m-1'))).toBe(false);
  });

  it('第 0 段蓋掉同名的舊檔（上一次開始又被退回的殘留）', () => {
    writeFileSync(store.recordingPathFor('m-1'), 'stale-bytes');
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    expect(readFileSync(store.recordingPathFor('m-1'), 'utf8')).toBe('aaa');
  });

  it('收尾：截到確定收到的長度再改名成音檔，錄音中的檔不留', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    store.appendRecordingChunk('m-1', 3, chunk('bbbb'));
    // 多出來的是最後一段寫進檔案、沒記進資料庫的那一次
    expect(store.promoteRecording('m-1', 3)).toEqual({ path: store.pathFor('m-1'), bytes: 3 });
    expect(readFileSync(store.pathFor('m-1'), 'utf8')).toBe('aaa');
    expect(existsSync(store.recordingPathFor('m-1'))).toBe(false);
  });

  it('收尾時檔案比收到的短或不見了：拋錯，不送一個缺一截的檔去轉錄', () => {
    expect(() => store.promoteRecording('m-1', 3)).toThrow(/錄音檔不見了/);
    store.appendRecordingChunk('m-1', 0, chunk('aa'));
    expect(() => store.promoteRecording('m-1', 3)).toThrow(/比已經收到的 3 bytes 短/);
    expect(store.exists('m-1')).toBe(false);
  });

  it('收尾可以重跑：上一次改名成功、資料庫還沒更新就斷了，這次直接用已經改好名的音檔', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    store.promoteRecording('m-1', 3);
    expect(store.promoteRecording('m-1', 3)).toEqual({ path: store.pathFor('m-1'), bytes: 3 });
    // 長度對不上的音檔不算：那不是這一次收尾改名過來的
    expect(() => store.promoteRecording('m-1', 5)).toThrow(/錄音檔不見了/);
  });

  it('啟動清理不碰錄音中的檔：server 重啟時已經送到的段落要留著', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    expect(store.removePartialUploads()).toEqual([]);
    expect(existsSync(store.recordingPathFor('m-1'))).toBe(true);
  });

  it('removeRecording 刪掉錄音中的檔，不在也不拋錯', () => {
    store.appendRecordingChunk('m-1', 0, chunk('aaa'));
    store.removeRecording('m-1');
    expect(existsSync(store.recordingPathFor('m-1'))).toBe(false);
    expect(() => store.removeRecording('m-1')).not.toThrow();
  });

  it('不合法的 meeting_id 一樣拋錯', () => {
    expect(() => store.recordingPathFor('../x')).toThrow(/不能當成檔名/);
  });
});

describe('PUT /api/meetings/:id/audio 的 middleware 順序', () => {
  let server: Server;
  let url: string;

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('application/octet-stream 的 body 原樣落地，不被 body parser 吃掉', async () => {
    ({ server, url } = await startUploadApp(store, { limit: 10 }));
    // 含 0x00 與非 UTF-8 的位元組：被 body parser 碰過的話這些會壞掉
    const payload = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff, 0x01]);

    const res = await fetch(`${url}/api/meetings/m-1/audio`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
      },
      body: payload,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ bytes: payload.length });
    expect(readFileSync(store.pathFor('m-1'))).toEqual(payload);
  });

  it('沒有 Basic Auth 時擋在 401，音檔不會被建立', async () => {
    ({ server, url } = await startUploadApp(store, { limit: 10 }));
    const res = await fetch(`${url}/api/meetings/m-1/audio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('RIFF'),
    });

    expect(res.status).toBe(401);
    expect(store.exists('m-1')).toBe(false);
  });

  it('超過限流時擋在 429，限流在認證前面所以連猜密碼也一起被限', async () => {
    ({ server, url } = await startUploadApp(store, { limit: 1 }));
    const send = () => fetch(`${url}/api/meetings/m-1/audio`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
      },
      body: Buffer.from('RIFF'),
    });

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
  });
});

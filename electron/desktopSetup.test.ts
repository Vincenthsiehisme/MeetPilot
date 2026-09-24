import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError, createGatewayClient, syncWithGateway } from './gatewayClient';
import { DesktopStoreError, createDesktopStore } from './desktopStore';
import { VaultFolderError, checkVaultFolder } from './vaultFolder';
import type { RosterDocument } from '../services/rosterDocument';

const ROSTER: RosterDocument = {
  version: 1,
  rows: [{ employeeId: '1001', displayName: '王小明', title: null, email: 'ming@example.com', department: null, aliases: ['Ming'] }],
};

const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** 照路徑回應的假 fetch，記下每次請求 */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`沒設 ${path}`);
    return route();
  };
  return { fetch, calls };
}

describe('createGatewayClient', () => {
  const base = 'https://gw.example/';

  it('redeem 送 { code }（去掉前後空白），回 token 與 inviteId；key 與名單帶 Bearer token', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/redeem': () => respond(200, { token: 't1', inviteId: 'fde01' }),
      '/api/config': () => respond(200, { geminiApiKey: 'k1' }),
      '/api/people': () => respond(200, ROSTER),
    });
    const client = createGatewayClient({ baseUrl: base, fetch });
    expect(await client.redeem('  CODE  ')).toEqual({ token: 't1', inviteId: 'fde01' });
    expect(calls[0].url).toBe('https://gw.example/api/redeem');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ code: 'CODE' });
    expect(await client.fetchGeminiKey('t1')).toBe('k1');
    expect(await client.fetchRoster('t1')).toEqual(ROSTER);
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer t1');
    expect((calls[2].init.headers as Record<string, string>).authorization).toBe('Bearer t1');
  });

  it('401 是 unauthorized，訊息用 gateway 自己的 error', async () => {
    const { fetch } = fakeFetch({ '/api/config': () => respond(401, { error: 'token 無效或已被撤銷，請重新輸入邀請碼' }) });
    const err = await createGatewayClient({ baseUrl: base, fetch }).fetchGeminiKey('t').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.kind).toBe('unauthorized');
    expect(err.message).toBe('token 無效或已被撤銷，請重新輸入邀請碼');
  });

  it('不是 gateway 形狀的 401（Vercel 的驗證頁、代理）不算撤銷：當成撤銷會把所有人的登入資料一起刪掉', async () => {
    const { fetch } = fakeFetch({ '/api/config': () => respond(401, '<html>Authentication Required</html>') });
    const err = await createGatewayClient({ baseUrl: base, fetch }).fetchGeminiKey('t').catch((e) => e);
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('Authentication Required');
  });

  it('連不上、逾時、5xx、非 401 的 4xx 都是 unavailable，不是撤銷', async () => {
    const cases: Record<string, () => Response | Promise<Response>> = {
      '/api/config': () => { throw new TypeError('fetch failed'); },
      '/api/people': () => respond(503, { error: '名單還沒上傳' }),
      '/api/redeem': () => respond(400, '<html>bad</html>'),
    };
    const client = createGatewayClient({ baseUrl: base, fetch: fakeFetch(cases).fetch });
    const e1 = await client.fetchGeminiKey('t').catch((e) => e);
    expect([e1.kind, e1.message]).toEqual(['unavailable', '連不上 gateway：fetch failed']);
    const e2 = await client.fetchRoster('t').catch((e) => e);
    expect([e2.kind, e2.message]).toEqual(['unavailable', 'gateway 回 503：名單還沒上傳']);
    const e3 = await client.redeem('c').catch((e) => e);
    expect(e3.kind).toBe('unavailable');
    expect(e3.message).toContain('<html>bad</html>');

    const slow = createGatewayClient({
      baseUrl: base,
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    });
    const e4 = await slow.fetchGeminiKey('t').catch((e) => e);
    expect([e4.kind, e4.message]).toEqual(['unavailable', '連不上 gateway：0.02 秒內沒有回應']);
  });

  it('200 但內容不對也不算成功：空的 key、沒有 token、名單欄位壞掉，都是 unavailable', async () => {
    const client = createGatewayClient({
      baseUrl: base,
      fetch: fakeFetch({
        '/api/config': () => respond(200, { geminiApiKey: '  ' }),
        '/api/redeem': () => respond(200, { inviteId: 'x' }),
        '/api/people': () => respond(200, { version: 1, rows: [{ ...ROSTER.rows[0], displayName: '' }] }),
      }).fetch,
    });
    for (const call of [client.fetchGeminiKey('t'), client.redeem('c'), client.fetchRoster('t')]) {
      const err = await call.catch((e) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.kind).toBe('unavailable');
    }
    const notJson = createGatewayClient({ baseUrl: base, fetch: fakeFetch({ '/api/config': () => respond(200, 'ok') }).fetch });
    expect((await notJson.fetchGeminiKey('t').catch((e) => e)).message).toMatch(/不是 JSON 物件/);
  });
});

describe('syncWithGateway', () => {
  const ok = { fetchGeminiKey: async () => 'fresh-key', fetchRoster: async () => ROSTER };
  const down = (what: string) => async () => { throw new GatewayError('unavailable', `${what} 連不上`); };
  const revoked = async () => { throw new GatewayError('unauthorized', 'token 無效或已被撤銷'); };
  const client = (overrides: Partial<GatewayClient>): GatewayClient => ({ redeem: async () => ({ token: 't', inviteId: 'i' }), ...ok, ...overrides });

  it('兩樣都拿到：沒有 problems，fresh 的兩樣都交回去存', async () => {
    const sync = await syncWithGateway(client({}), 't', { geminiApiKey: 'old', hasRoster: true });
    expect(sync).toEqual({ outcome: 'ready', geminiApiKey: 'fresh-key', freshKey: 'fresh-key', freshRoster: ROSTER, problems: [] });
  });

  it('任何一支 401 就是撤銷，就算另一支成功、手上有上次的 key 也不能繼續', async () => {
    expect((await syncWithGateway(client({ fetchRoster: revoked }), 't', { geminiApiKey: 'old', hasRoster: true })).outcome)
      .toBe('revoked');
    expect((await syncWithGateway(client({ fetchGeminiKey: revoked, fetchRoster: down('名單') }), 't', { geminiApiKey: 'old', hasRoster: true })))
      .toEqual({ outcome: 'revoked', message: 'token 無效或已被撤銷' });
  });

  it('連不上：用上次的 key，problems 講出哪一樣是舊的；fresh 的是 null，不拿舊的蓋回去', async () => {
    const sync = await syncWithGateway(client({ fetchGeminiKey: down('key'), fetchRoster: down('名單') }), 't', { geminiApiKey: 'old', hasRoster: true });
    expect(sync).toEqual({
      outcome: 'ready',
      geminiApiKey: 'old',
      freshKey: null,
      freshRoster: null,
      problems: ['Gemini key 用的是上次的（key 連不上）', '名單用的是上次的（名單 連不上）'],
    });
  });

  it('兩支同一個原因失敗只講一次；只有 key 沒拿到時名單是新的，不說名單是舊的', async () => {
    const same = await syncWithGateway(client({ fetchGeminiKey: down('gw'), fetchRoster: down('gw') }), 't', { geminiApiKey: 'old', hasRoster: true });
    expect(same.outcome === 'ready' && same.problems).toEqual(['Gemini key 與名單都用上次的（gw 連不上）']);
    const keyOnly = await syncWithGateway(client({ fetchGeminiKey: down('key') }), 't', { geminiApiKey: 'old', hasRoster: true });
    expect(keyOnly.outcome === 'ready' && keyOnly.problems).toEqual(['Gemini key 用的是上次的（key 連不上）']);
    expect(keyOnly.outcome === 'ready' && keyOnly.freshRoster).toEqual(ROSTER);
  });

  it('只有名單沒拿到、而且從來沒拿過：不能說「用上次的」，要講清楚選人畫面會是空的', async () => {
    const sync = await syncWithGateway(client({ fetchRoster: down('名單') }), 't', { geminiApiKey: null, hasRoster: false });
    expect(sync.outcome).toBe('ready');
    expect(sync.outcome === 'ready' && sync.problems).toEqual(['拿不到名單，建立會議時沒有人可選（名單 連不上）']);
  });

  it('拿不到 key、手上也沒有：no-key，起不了 server', async () => {
    expect(await syncWithGateway(client({ fetchGeminiKey: down('key') }), 't', { geminiApiKey: null, hasRoster: false }))
      .toEqual({ outcome: 'no-key', message: 'key 連不上' });
  });

  it('不是 GatewayError 的例外（程式錯）原樣往上拋，不當成離線', async () => {
    await expect(syncWithGateway(client({ fetchRoster: async () => { throw new TypeError('bug'); } }), 't', { geminiApiKey: 'old', hasRoster: true }))
      .rejects.toThrow('bug');
  });
});

describe('createDesktopStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'meetpilot-desktop-store-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  // 假的加密：前面加標記再反轉，確認落地的不是明文、也確認讀回來有走解密
  const box = {
    encrypt: (plain: string) => Buffer.from(`sealed:${[...plain].reverse().join('')}`),
    decrypt: (cipher: Buffer) => {
      const text = cipher.toString();
      if (!text.startsWith('sealed:')) throw new Error('不是這台電腦加密的');
      return [...text.slice('sealed:'.length)].reverse().join('');
    },
  };
  let n = 0;
  const fresh = () => {
    const dir = join(root, String(n += 1));
    mkdirSync(dir);
    return { dir, store: createDesktopStore(dir, box) };
  };

  it('第一次啟動什麼都沒有：設定與登入資料都回 null，沒有名單', () => {
    const { store } = fresh();
    expect(store.readSettings()).toBeNull();
    expect(store.readCredentials()).toBeNull();
    expect(store.hasRoster()).toBe(false);
  });

  it('寫了讀得回來；token 與 key 落地的是加密後的內容，檔案裡找不到明文', () => {
    const { dir, store } = fresh();
    store.writeSettings({ vaultDir: '/shared/records' });
    store.writeCredentials({ inviteId: 'fde01', token: 'secret-token', geminiApiKey: 'secret-key' });
    expect(store.readSettings()).toEqual({ vaultDir: '/shared/records' });
    expect(store.readCredentials()).toEqual({ inviteId: 'fde01', token: 'secret-token', geminiApiKey: 'secret-key' });
    // 欄位是 base64：明文轉成 base64 存的話原始檔案裡也找不到，所以每個欄位解開再查一次
    const raw = readFileSync(join(dir, 'credentials.json'), 'utf-8');
    const decoded = Object.values(JSON.parse(raw)).map((v) => Buffer.from(String(v), 'base64').toString());
    for (const text of [raw, ...decoded]) {
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('secret-key');
    }
    expect(existsSync(join(dir, 'credentials.json.tmp'))).toBe(false);
  });

  it('名單寫成 roster.json；clearCredentials 刪登入資料與名單，投影資料夾留著', () => {
    const { store } = fresh();
    store.writeSettings({ vaultDir: '/v' });
    store.writeCredentials({ inviteId: 'i', token: 't', geminiApiKey: 'k' });
    store.writeRoster(ROSTER);
    expect(JSON.parse(readFileSync(store.rosterPath, 'utf-8'))).toEqual(ROSTER);
    store.clearCredentials();
    expect(store.readCredentials()).toBeNull();
    expect(store.hasRoster()).toBe(false);
    expect(store.readSettings()).toEqual({ vaultDir: '/v' });
  });

  it('檔案在但壞了不當成沒設定過：讀不懂、版本不對、缺欄位、解不開都拋 DesktopStoreError', () => {
    const { dir, store } = fresh();
    writeFileSync(join(dir, 'desktop-settings.json'), '{');
    expect(() => store.readSettings()).toThrow(DesktopStoreError);
    writeFileSync(join(dir, 'desktop-settings.json'), JSON.stringify({ version: 2, vaultDir: '/v' }));
    expect(() => store.readSettings()).toThrow(/version 是 2/);
    writeFileSync(join(dir, 'desktop-settings.json'), JSON.stringify({ version: 1 }));
    expect(() => store.readSettings()).toThrow(/缺 vaultDir/);
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      version: 1, inviteId: 'i', token: Buffer.from('plain').toString('base64'), geminiApiKey: 'x',
    }));
    expect(() => store.readCredentials()).toThrow(/token 解不開：不是這台電腦加密的/);
  });

  it('解出來是空字串也擋：空的 key 交給 server 會每場會轉錄失敗', () => {
    const { dir, store } = fresh();
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      version: 1, inviteId: 'i', token: box.encrypt('t').toString('base64'), geminiApiKey: box.encrypt('').toString('base64'),
    }));
    expect(() => store.readCredentials()).toThrow(/geminiApiKey 解出來是空的/);
  });

  it('加密失敗（這台電腦的安全儲存不能用）就不寫，不退回明文', () => {
    const dir = join(root, 'no-safe-storage');
    mkdirSync(dir);
    const store = createDesktopStore(dir, { encrypt: () => { throw new Error('安全儲存不能用'); }, decrypt: () => '' });
    expect(() => store.writeCredentials({ inviteId: 'i', token: 't', geminiApiKey: 'k' })).toThrow('安全儲存不能用');
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });
});

describe('checkVaultFolder', () => {
  const root = mkdtempSync(join(tmpdir(), 'meetpilot-vault-folder-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('存在、寫得進去的資料夾回傳正規化的路徑，不留測試檔', () => {
    const dir = join(root, 'ok');
    mkdirSync(dir);
    expect(checkVaultFolder(`  ${dir}  `)).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('空的、相對路徑、不存在、是檔案、家目錄本身都擋，訊息講是哪一種', () => {
    expect(() => checkVaultFolder(' ')).toThrow(/還沒選/);
    expect(() => checkVaultFolder('records')).toThrow(/完整路徑/);
    expect(() => checkVaultFolder(join(root, 'missing'))).toThrow(/找不到這個資料夾/);
    const file = join(root, 'file.txt');
    writeFileSync(file, '');
    expect(() => checkVaultFolder(file)).toThrow(/不是資料夾/);
    expect(() => checkVaultFolder(homedir())).toThrow(VaultFolderError);
    expect(() => checkVaultFolder(homedir())).toThrow(/投影資料夾不能是家目錄本身/);
  });

  it.skipIf(process.platform === 'win32')('寫不進去的資料夾擋下（Windows 不吃目錄權限位元，這條只在 POSIX 跑）', () => {
    const dir = join(root, 'readonly');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      expect(() => checkVaultFolder(dir)).toThrow(/寫不進去/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

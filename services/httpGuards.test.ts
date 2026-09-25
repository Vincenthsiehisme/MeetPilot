import { describe, it, expect } from 'vitest';
import {
  isLoopbackAddress,
  resolveListenConfig,
  checkBasicAuth,
  createRateLimiter,
  isLoopbackHost,
  describeBodyParserError,
  resolveHmrPort,
} from './httpGuards';

const basicHeader = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

describe('resolveListenConfig', () => {
  it('AC-1：不設 HOST 時綁 127.0.0.1、PORT 預設 3000、不啟用 Basic Auth', () => {
    expect(resolveListenConfig({})).toEqual({ host: '127.0.0.1', port: 3000, basicAuth: null, apiRateLimitPerMinute: 60 });
  });

  it('AC-1：HOST 為空字串視同未設定', () => {
    expect(resolveListenConfig({ HOST: '', PORT: '' }).host).toBe('127.0.0.1');
  });

  it('AC-2：HOST=0.0.0.0 且兩個 Basic Auth 變數都缺時拋出帶定位訊息的錯誤', () => {
    expect(() => resolveListenConfig({ HOST: '0.0.0.0' })).toThrowError(
      'HOST=0.0.0.0 不是本機位址，必須同時設定 MEETPILOT_BASIC_AUTH_USER 與 MEETPILOT_BASIC_AUTH_PASSWORD 才能對外監聽（見 .env.example）'
    );
  });

  it('AC-2：HOST=0.0.0.0 且只設 USER 沒設 PASSWORD 時拋錯', () => {
    expect(() =>
      resolveListenConfig({ HOST: '0.0.0.0', MEETPILOT_BASIC_AUTH_USER: 'admin' })
    ).toThrowError(
      'MEETPILOT_BASIC_AUTH_USER 與 MEETPILOT_BASIC_AUTH_PASSWORD 必須同時設定，目前只設了其中一個，請修正 .env'
    );
  });

  it('AC-2：HOST=0.0.0.0 且只設 PASSWORD 沒設 USER 時拋錯', () => {
    expect(() =>
      resolveListenConfig({ HOST: '0.0.0.0', MEETPILOT_BASIC_AUTH_PASSWORD: 'secret' })
    ).toThrowError('必須同時設定');
  });

  it('HOST=0.0.0.0 且兩個變數都設時回傳帳密與位址', () => {
    expect(
      resolveListenConfig({
        HOST: '0.0.0.0',
        PORT: '8080',
        MEETPILOT_BASIC_AUTH_USER: 'admin',
        MEETPILOT_BASIC_AUTH_PASSWORD: 'secret',
      })
    ).toEqual({ host: '0.0.0.0', port: 8080, basicAuth: { user: 'admin', password: 'secret' }, apiRateLimitPerMinute: 60 });
  });

  it('AC-3：本機位址（127.0.0.1、localhost、::1）不設帳密時不要求認證', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(resolveListenConfig({ HOST: host }).basicAuth).toBeNull();
    }
  });

  it('不設 MEETPILOT_API_RATE_LIMIT 時每 IP 每分鐘 60 次', () => {
    expect(resolveListenConfig({}).apiRateLimitPerMinute).toBe(60);
  });

  it('MEETPILOT_API_RATE_LIMIT="20" 時是 20', () => {
    expect(resolveListenConfig({ MEETPILOT_API_RATE_LIMIT: '20' }).apiRateLimitPerMinute).toBe(20);
  });

  it('MEETPILOT_API_RATE_LIMIT 不是正整數時拋錯且訊息含變數名', () => {
    expect(() => resolveListenConfig({ MEETPILOT_API_RATE_LIMIT: 'abc' })).toThrowError(
      'MEETPILOT_API_RATE_LIMIT="abc" 必須是正整數（每 IP 每分鐘的請求數），請修正 .env'
    );
    expect(() => resolveListenConfig({ MEETPILOT_API_RATE_LIMIT: '0' })).toThrowError(
      'MEETPILOT_API_RATE_LIMIT="0" 必須是正整數（每 IP 每分鐘的請求數），請修正 .env'
    );
  });

  it('PORT 不是合法連接埠時拋錯', () => {
    expect(() => resolveListenConfig({ PORT: 'abc' })).toThrowError(
      'PORT="abc" 不是合法的連接埠（1-65535），請修正 .env'
    );
    expect(() => resolveListenConfig({ PORT: '70000' })).toThrowError('不是合法的連接埠');
  });

  it('MEETPILOT_API_RATE_LIMIT 只收十進位整數字串，Number() 吃得下的變形一律拋錯', () => {
    for (const raw of ['6e1', '0x3c', '60.0', '+60']) {
      expect(() => resolveListenConfig({ MEETPILOT_API_RATE_LIMIT: raw })).toThrowError(
        `MEETPILOT_API_RATE_LIMIT="${raw}" 必須是正整數（每 IP 每分鐘的請求數），請修正 .env`
      );
    }
    expect(resolveListenConfig({ MEETPILOT_API_RATE_LIMIT: '60' }).apiRateLimitPerMinute).toBe(60);
  });

  it('PORT 只收十進位整數字串，"3e3" 這種寫法拋錯', () => {
    expect(() => resolveListenConfig({ PORT: '3e3' })).toThrowError(
      'PORT="3e3" 不是合法的連接埠（1-65535），請修正 .env'
    );
    expect(() => resolveListenConfig({ PORT: '0x3c' })).toThrowError('不是合法的連接埠');
    expect(() => resolveListenConfig({ PORT: '3000.0' })).toThrowError('不是合法的連接埠');
    expect(() => resolveListenConfig({ PORT: '+3000' })).toThrowError('不是合法的連接埠');
    expect(resolveListenConfig({ PORT: '3000' }).port).toBe(3000);
  });
});

describe('isLoopbackHost', () => {
  it('只認 127.0.0.1、localhost、::1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('checkBasicAuth', () => {
  const credentials = { user: 'admin', password: 'p@ss:word' };

  it('AC-3：帳密正確回 true', () => {
    expect(checkBasicAuth(basicHeader('admin', 'p@ss:word'), credentials)).toBe(true);
  });

  it('AC-3：沒帶 header 回 false', () => {
    expect(checkBasicAuth(undefined, credentials)).toBe(false);
    expect(checkBasicAuth('', credentials)).toBe(false);
  });

  it('AC-3：帳號或密碼錯回 false', () => {
    expect(checkBasicAuth(basicHeader('admin', 'wrong'), credentials)).toBe(false);
    expect(checkBasicAuth(basicHeader('root', 'p@ss:word'), credentials)).toBe(false);
    expect(checkBasicAuth(basicHeader('admin', 'p@ss:wor'), credentials)).toBe(false);
  });

  it('AC-3：不是 Basic scheme 或 base64 壞掉回 false', () => {
    expect(checkBasicAuth('Bearer abc', credentials)).toBe(false);
    expect(checkBasicAuth('Basic', credentials)).toBe(false);
    expect(checkBasicAuth('Basic !!!', credentials)).toBe(false);
    expect(checkBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, credentials)).toBe(false);
  });

  it('scheme 名稱不分大小寫', () => {
    const encoded = Buffer.from('admin:p@ss:word').toString('base64');
    expect(checkBasicAuth(`basic ${encoded}`, credentials)).toBe(true);
  });
});

describe('createRateLimiter', () => {
  it('AC-4：同一 IP 60 秒內第 21 次請求被擋，第 20 次還放行', () => {
    const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 1; i <= 20; i++) {
      expect(limiter.check('1.2.3.4', t0 + i)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(limiter.check('1.2.3.4', t0 + 21)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('AC-4：不同 IP 各自計數', () => {
    const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) limiter.check('1.1.1.1', t0);
    expect(limiter.check('1.1.1.1', t0).allowed).toBe(false);
    expect(limiter.check('2.2.2.2', t0).allowed).toBe(true);
  });

  it('AC-4：視窗過了 60 秒後重新計數', () => {
    const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 21; i++) limiter.check('1.2.3.4', t0);
    expect(limiter.check('1.2.3.4', t0 + 59_999).allowed).toBe(false);
    expect(limiter.check('1.2.3.4', t0 + 60_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('retryAfterSeconds 依剩餘時間無條件進位、最少 1 秒', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 0;
    limiter.check('ip', t0);
    expect(limiter.check('ip', t0 + 30_500).retryAfterSeconds).toBe(30);
    expect(limiter.check('ip', t0 + 59_999).retryAfterSeconds).toBe(1);
  });

  it('limit 或 windowMs 不合法時建立就拋錯', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 60_000 })).toThrowError(
      'rate limit 的 limit 必須是正整數，收到 0'
    );
    expect(() => createRateLimiter({ limit: 20, windowMs: 0 })).toThrowError(
      'rate limit 的 windowMs 必須大於 0，收到 0'
    );
  });
});

describe('describeBodyParserError', () => {
  it('JSON 解析失敗回 400 與可讀訊息', () => {
    expect(describeBodyParserError({ type: 'entity.parse.failed' })).toEqual({
      status: 400,
      error: '請求的 JSON 格式錯誤',
    });
  });

  it('body 超過上限回 413', () => {
    expect(describeBodyParserError({ type: 'entity.too.large' })).toEqual({
      status: 413,
      error: '請求內容超過 50MB 上限',
    });
  });

  it('不是 body parser 的錯回 null，交給下一個 handler', () => {
    expect(describeBodyParserError(new Error('boom'))).toBeNull();
    expect(describeBodyParserError({ type: 'something.else' })).toBeNull();
    expect(describeBodyParserError(undefined)).toBeNull();
    expect(describeBodyParserError(null)).toBeNull();
  });
});

describe('isLoopbackAddress（錄音路由只收本機請求，AC-6）', () => {
  it('IPv4、IPv6 與雙堆疊寫法的本機來源都算', () => {
    for (const address of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
  });

  it('區網與外部位址不算，拿不到位址也不算', () => {
    for (const address of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.5', 'fe80::1', '', undefined]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  it('只比對整段位址，不被長得像的字串騙過', () => {
    expect(isLoopbackAddress('127.0.0.1.evil')).toBe(false);
    expect(isLoopbackAddress('x127.0.0.1')).toBe(false);
  });
});

describe('resolveHmrPort', () => {
  it('沒設或空白回 undefined，讓 Vite 用預設', () => {
    expect(resolveHmrPort({})).toBeUndefined();
    expect(resolveHmrPort({ MEETPILOT_HMR_PORT: '  ' })).toBeUndefined();
  });

  it('十進位整數照收', () => {
    expect(resolveHmrPort({ MEETPILOT_HMR_PORT: '24690' })).toBe(24690);
  });

  it('不是合法連接埠就啟動時拋錯，"3e3" 這種寫法也擋', () => {
    expect(() => resolveHmrPort({ MEETPILOT_HMR_PORT: 'abc' })).toThrowError('MEETPILOT_HMR_PORT="abc" 不是合法的連接埠');
    expect(() => resolveHmrPort({ MEETPILOT_HMR_PORT: '70000' })).toThrowError('不是合法的連接埠');
    expect(() => resolveHmrPort({ MEETPILOT_HMR_PORT: '3e3' })).toThrowError('不是合法的連接埠');
  });
});

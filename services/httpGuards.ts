import { timingSafeEqual } from 'node:crypto';

// Server 對外防護的純函式：監聽設定解析、Basic Auth 驗證、每 IP 限流。
// 只在 server.ts 使用，不含 express 依賴，方便單元測試。

export interface BasicAuthCredentials {
  user: string;
  password: string;
}

export interface ListenConfig {
  host: string;
  port: number;
  // null 代表不啟用 Basic Auth（只允許 host 是本機位址時）
  basicAuth: BasicAuthCredentials | null;
  // /api/* 每個 IP 每分鐘允許的請求數，來自 MEETPILOT_API_RATE_LIMIT
  apiRateLimitPerMinute: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
// 200 分鐘錄音的正常流程約 20 片轉錄加一次摘要，可能同一分鐘內回來，20 會撞到；60 仍擋得住掃描與猜密碼
const DEFAULT_API_RATE_LIMIT = 60;
// 只接受十進位整數字串。Number() 連 "6e1"、"0x3c"、"60.0"、"+60" 都收，設定看起來生效、
// 實際值卻不是寫的那個（"0x3c" 會變 60），這種誤差要在啟動時就爆出來。
const DECIMAL_INTEGER = /^\d+$/;

function parseDecimalInteger(raw: string): number {
  return DECIMAL_INTEGER.test(raw) ? Number(raw) : NaN;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

// 從環境變數決定要綁哪裡、要不要 Basic Auth。設定不完整就丟錯，不補預設值假裝能跑。
export function resolveListenConfig(env: NodeJS.ProcessEnv): ListenConfig {
  const host = readEnv(env, 'HOST') ?? DEFAULT_HOST;

  const rawPort = readEnv(env, 'PORT');
  const port = rawPort === undefined ? DEFAULT_PORT : parseDecimalInteger(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT="${rawPort}" 不是合法的連接埠（1-65535），請修正 .env`);
  }

  const rawRateLimit = readEnv(env, 'MEETPILOT_API_RATE_LIMIT');
  const apiRateLimitPerMinute =
    rawRateLimit === undefined ? DEFAULT_API_RATE_LIMIT : parseDecimalInteger(rawRateLimit);
  if (!Number.isInteger(apiRateLimitPerMinute) || apiRateLimitPerMinute < 1) {
    throw new Error(`MEETPILOT_API_RATE_LIMIT="${rawRateLimit}" 必須是正整數（每 IP 每分鐘的請求數），請修正 .env`);
  }

  const user = readEnv(env, 'MEETPILOT_BASIC_AUTH_USER');
  const password = readEnv(env, 'MEETPILOT_BASIC_AUTH_PASSWORD');

  if (user !== undefined && password !== undefined) {
    return { host, port, basicAuth: { user, password }, apiRateLimitPerMinute };
  }

  if (user !== undefined || password !== undefined) {
    throw new Error(
      'MEETPILOT_BASIC_AUTH_USER 與 MEETPILOT_BASIC_AUTH_PASSWORD 必須同時設定，目前只設了其中一個，請修正 .env'
    );
  }

  if (!isLoopbackHost(host)) {
    throw new Error(
      `HOST=${host} 不是本機位址，必須同時設定 MEETPILOT_BASIC_AUTH_USER 與 MEETPILOT_BASIC_AUTH_PASSWORD 才能對外監聽（見 .env.example）`
    );
  }

  return { host, port, basicAuth: null, apiRateLimitPerMinute };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// 檢查 Authorization header 是否等於設定的 Basic Auth 帳密。
export function checkBasicAuth(
  authorizationHeader: string | undefined,
  credentials: BasicAuthCredentials
): boolean {
  if (!authorizationHeader) return false;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorizationHeader.trim());
  if (!match) return false;

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // 兩邊都比完再合併結果，避免帳號錯就提早回傳
  const userOk = safeEqual(user, credentials.user);
  const passwordOk = safeEqual(password, credentials.password);
  return userOk && passwordOk;
}

export interface RateLimiterOptions {
  // 每個視窗允許的請求數
  limit: number;
  // 視窗長度（毫秒）
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  // 被擋時距離視窗重置還有幾秒（無條件進位），可直接放進 Retry-After
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
}

interface WindowEntry {
  windowStart: number;
  count: number;
}

// 每個 key（通常是 IP）固定視窗計數。用 Map 存，過期的項目在 map 變大時順手清掉。
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`rate limit 的 limit 必須是正整數，收到 ${limit}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`rate limit 的 windowMs 必須大於 0，收到 ${windowMs}`);
  }

  const entries = new Map<string, WindowEntry>();
  const PRUNE_THRESHOLD = 10_000;

  function prune(now: number) {
    for (const [key, entry] of entries) {
      if (now - entry.windowStart >= windowMs) entries.delete(key);
    }
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitResult {
      if (entries.size > PRUNE_THRESHOLD) prune(now);

      let entry = entries.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { windowStart: now, count: 0 };
        entries.set(key, entry);
      }

      entry.count += 1;
      if (entry.count <= limit) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const remainingMs = entry.windowStart + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    },
  };
}

export interface BodyParserErrorResponse {
  status: number;
  error: string;
}

// body parser（express.json / express.urlencoded）解析失敗時 Express 預設回 HTML 錯誤頁。
// 前端 postJson 拿到 `<` 開頭的內容會當成連線異常，看不出是 JSON 壞掉還是超過上限，
// 所以把這兩種錯誤翻成前端讀得懂的 JSON；不是 body parser 的錯就回 null 交給下一個 handler。
export function describeBodyParserError(err: unknown): BodyParserErrorResponse | null {
  const type = (err as { type?: unknown } | null | undefined)?.type;
  if (type === 'entity.parse.failed') {
    return { status: 400, error: '請求的 JSON 格式錯誤' };
  }
  if (type === 'entity.too.large') {
    return { status: 413, error: '請求內容超過 50MB 上限' };
  }
  return null;
}

/**
 * 桌面 app 跟 gateway（meetpilot-gateway，部署在 Vercel）講話的那一層（vault plan「MeetPilot · 跨平台打包部署」E3）。
 *
 * 三支端點的契約在 gateway 的 README：`POST /api/redeem` 拿邀請碼換 token，`GET /api/config` 拿 Gemini key，
 * `GET /api/people` 拿名單。這個檔不 import electron，才測得到。
 *
 * 失敗只分兩種，因為外殼對它們的處理完全相反：
 * - `unauthorized`（gateway 自己回的 401，body 是 `{ error }`）：邀請碼不對、token 被撤銷。**不能退回上次存的 key**，
 *   被撤銷的人要真的停下來。不是 gateway 形狀的 401（Vercel 平台自己的驗證頁、代理擋下）不算：那是部署設定的事，
 *   當成撤銷的話所有記錄人會同時被刪掉登入資料。
 * - `unavailable`：連不上、逾時、5xx、回應內容不對。gateway 那邊的問題，記錄人手上的 key 還是有效的，
 *   用上次的繼續、畫面標示離線（2026-09-24 使用者裁 A）。
 * 回應內容不對算 `unavailable` 不算成功：型別對但內容空的 key 交給 server，每場會都會在轉錄時才失敗。
 */
import { RosterDocument, parseRosterDocument } from '../services/rosterDocument';

export const GATEWAY_URL = 'https://meetpilot-gateway.vercel.app';
const REQUEST_TIMEOUT_MS = 15_000;

export type GatewayFailure = 'unauthorized' | 'unavailable';

export class GatewayError extends Error {
  constructor(readonly kind: GatewayFailure, message: string) {
    super(message);
  }
}

export interface GatewayClient {
  redeem(code: string): Promise<{ token: string; inviteId: string }>;
  fetchGeminiKey(token: string): Promise<string>;
  fetchRoster(token: string): Promise<RosterDocument>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createGatewayClient(opts: {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): GatewayClient {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const url = `${base}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const reason = e.name === 'TimeoutError' ? `${timeoutMs / 1000} 秒內沒有回應` : e.message;
      throw new GatewayError('unavailable', `連不上 gateway：${reason}`);
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // 不是 JSON（例如 Vercel 自己的錯誤頁）：下面依狀態碼處理，訊息裡帶一小段原文
    }
    // gateway 的錯誤一律是 { error }，有就用它，記錄人看得懂；沒有就講狀態碼與開頭一段原文
    const fromGateway = typeof (body as { error?: unknown } | null)?.error === 'string';
    const gatewaySays = fromGateway
      ? (body as { error: string }).error
      : `HTTP ${res.status}${text === '' ? '' : `：${text.slice(0, 120)}`}`;
    if (res.status === 401 && fromGateway) throw new GatewayError('unauthorized', gatewaySays);
    if (!res.ok) {
      // 4xx 除了 401 都是 app 這邊送錯了（契約對不上），不是記錄人能處理的，但也不是撤銷：當成暫時拿不到
      throw new GatewayError('unavailable', `gateway 回 ${res.status}：${gatewaySays}`);
    }
    if (body === null || typeof body !== 'object') {
      throw new GatewayError('unavailable', `gateway 的 ${path} 回了不是 JSON 物件的內容：${text.slice(0, 120)}`);
    }
    return body;
  }

  const requireString = (body: unknown, field: string, path: string): string => {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new GatewayError('unavailable', `gateway 的 ${path} 回應裡沒有 ${field}`);
    }
    return value.trim();
  };

  return {
    async redeem(code) {
      const body = await call('/api/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      return { token: requireString(body, 'token', '/api/redeem'), inviteId: requireString(body, 'inviteId', '/api/redeem') };
    },
    async fetchGeminiKey(token) {
      const body = await call('/api/config', { headers: { authorization: `Bearer ${token}` } });
      return requireString(body, 'geminiApiKey', '/api/config');
    },
    async fetchRoster(token) {
      const body = await call('/api/people', { headers: { authorization: `Bearer ${token}` } });
      try {
        return parseRosterDocument(JSON.stringify(body), `${base}/api/people`);
      } catch (err) {
        throw new GatewayError('unavailable', (err as Error).message);
      }
    },
  };
}

/** 每次啟動向 gateway 同步的結果，外殼據此決定開設定頁還是起 server */
export type GatewaySync =
  /** 401：token 被撤銷或失效。外殼要刪掉存著的 token、key、名單，回設定頁 */
  | { outcome: 'revoked'; message: string }
  /** 拿不到 key，手上也沒有上次的：起不了 server */
  | { outcome: 'no-key'; message: string }
  /**
   * 起得了 server。`problems` 空的代表兩樣都拿到最新的；非空代表至少一樣用的是上次的，畫面要標示離線。
   * `freshKey`／`freshRoster` 是這次真的從 gateway 拿到的，外殼只存這兩個，不拿舊的蓋回去
   */
  | { outcome: 'ready'; geminiApiKey: string; freshKey: string | null; freshRoster: RosterDocument | null; problems: string[] };

export async function syncWithGateway(
  client: GatewayClient,
  token: string,
  cached: { geminiApiKey: string | null; hasRoster: boolean },
): Promise<GatewaySync> {
  // 兩支一起打：任何一支 401 都算撤銷（token 是同一個）
  const [key, roster] = await Promise.allSettled([client.fetchGeminiKey(token), client.fetchRoster(token)]);
  const failures = [key, roster]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  for (const err of failures) {
    if (!(err instanceof GatewayError)) throw err;
  }
  const revoked = failures.find((err: GatewayError) => err.kind === 'unauthorized') as GatewayError | undefined;
  if (revoked) return { outcome: 'revoked', message: revoked.message };

  const freshKey = key.status === 'fulfilled' ? key.value : null;
  const freshRoster = roster.status === 'fulfilled' ? roster.value : null;
  const problems: string[] = [];
  const keyReason = key.status === 'rejected' ? (key.reason as Error).message : null;
  const rosterReason = roster.status === 'rejected' ? (roster.reason as Error).message : null;
  if (keyReason !== null && keyReason === rosterReason && cached.hasRoster) {
    // 最常見的離線：兩支因為同一個原因失敗，講一次就好
    problems.push(`Gemini key 與名單都用上次的（${keyReason}）`);
  } else {
    if (keyReason !== null) problems.push(`Gemini key 用的是上次的（${keyReason}）`);
    // 第一次設定就拿不到名單的話沒有「上次的」，不能說得好像有：選人畫面會是空的，要講清楚
    if (rosterReason !== null) {
      problems.push(cached.hasRoster
        ? `名單用的是上次的（${rosterReason}）`
        : `拿不到名單，建立會議時沒有人可選（${rosterReason}）`);
    }
  }
  const geminiApiKey = freshKey ?? cached.geminiApiKey;
  if (geminiApiKey === null) {
    return { outcome: 'no-key', message: (key as PromiseRejectedResult).reason.message };
  }
  return { outcome: 'ready', geminiApiKey, freshKey, freshRoster, problems };
}

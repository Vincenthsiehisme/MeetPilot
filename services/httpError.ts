// 前端 postJson 對非 2xx 回應丟的錯誤：帶 HTTP 狀態碼與 Retry-After（秒），
// 讓 withRetry 能照 server 給的時間退避，不用從訊息字串猜。App.tsx 的 translateError 仍只看 message。
export class HttpError extends Error {
  readonly status: number;
  // 來自 Retry-After header，只有 server 有給且是非負整數秒數時才有值
  readonly retryAfterSeconds?: number;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

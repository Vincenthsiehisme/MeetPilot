import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractUsage,
  describeLlmError,
  buildLlmRecord,
  resolveLlmLogPath,
  createLlmLogger,
} from './llmTelemetry';

// 時間寫死，紀錄裡的 ts 才驗得了
const FIXED_NOW = new Date('2026-09-14T08:30:00.000Z');

const tempDirs: string[] = [];
function tempLogPath(name = 'llm.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'meetpilot-llmlog-'));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('extractUsage', () => {
  it('四個 token 欄位都在時原樣取出', () => {
    expect(
      extractUsage({
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 340,
          thoughtsTokenCount: 56,
          totalTokenCount: 1596,
        },
      })
    ).toEqual({ promptTokens: 1200, outputTokens: 340, thoughtsTokens: 56, totalTokens: 1596 });
  });

  it('缺的欄位是 null 不是 0：分得出「沒回」與「真的是 0」', () => {
    expect(
      extractUsage({ usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 0 } })
    ).toEqual({ promptTokens: 900, outputTokens: 0, thoughtsTokens: null, totalTokens: null });
  });

  it('沒有 usageMetadata、null、undefined 一律整組 null', () => {
    const allNull = { promptTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null };
    expect(extractUsage({})).toEqual(allNull);
    expect(extractUsage(null)).toEqual(allNull);
    expect(extractUsage(undefined)).toEqual(allNull);
  });

  it('token 欄位不是有限數字時當成沒拿到', () => {
    expect(
      extractUsage({ usageMetadata: { promptTokenCount: '1200', candidatesTokenCount: NaN } })
    ).toEqual({ promptTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null });
  });
});

describe('describeLlmError', () => {
  it('message 是 JSON 字串時讀得到 error.code，訊息取裡面那句給人看的', () => {
    const err = new Error(JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }));
    expect(describeLlmError(err)).toEqual({ status: 429, message: 'Resource exhausted' });
  });

  it('JSON 裡沒有 error.message 時退回原字串，不是空字串', () => {
    const raw = JSON.stringify({ error: { code: 400 } });
    expect(describeLlmError(new Error(raw))).toEqual({ status: 400, message: raw });
  });

  it('Gemini 那種長 JSON 錯誤只留人看得懂的那句，不是砍一半的 JSON', () => {
    const raw = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    });
    expect(describeLlmError(new Error(raw)).message).toBe('API key not valid. Please pass a valid API key.');
  });

  it('err.status 蓋過 JSON 裡的 code', () => {
    const err = Object.assign(new Error(JSON.stringify({ error: { code: 500 } })), { status: 503 });
    expect(describeLlmError(err).status).toBe(503);
  });

  it('message 看起來像 JSON 但解析失敗時 status 是 null，訊息照留', () => {
    const result = describeLlmError(new Error('{ 這不是 JSON'));
    expect(result.status).toBeNull();
    expect(result.message).toBe('{ 這不是 JSON');
  });

  it('沒有狀態碼線索時 status 是 null', () => {
    expect(describeLlmError(new Error('model overloaded'))).toEqual({
      status: null,
      message: 'model overloaded',
    });
  });

  it('message 不是字串時轉成字串', () => {
    expect(describeLlmError('plain string error').message).toBe('plain string error');
    expect(describeLlmError(null).message).toBe('');
  });

  it('訊息截斷到 200 字：這份紀錄不放會議內容，不靠第三方訊息格式維持這件事', () => {
    const result = describeLlmError(new Error('x'.repeat(500)));
    expect(result.message).toHaveLength(200);
  });
});

describe('buildLlmRecord', () => {
  it('成功的呼叫帶 usage、error 欄位是 null', () => {
    expect(
      buildLlmRecord({
        kind: 'transcribe',
        model: 'gemini-3.8-flash',
        modelIndex: 0,
        attempt: 1,
        streamed: false,
        latencyMs: 4200,
        outcome: 'ok',
        response: { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 } },
        now: FIXED_NOW,
      })
    ).toEqual({
      ts: '2026-09-14T08:30:00.000Z',
      kind: 'transcribe',
      meetingId: null,
      model: 'gemini-3.8-flash',
      modelIndex: 0,
      attempt: 1,
      streamed: false,
      latencyMs: 4200,
      ttfbMs: null,
      outcome: 'ok',
      promptTokens: 1000,
      outputTokens: 200,
      thoughtsTokens: null,
      totalTokens: 1200,
      errorStatus: null,
      errorMessage: null,
    });
  });

  it('meetingId 有傳就記得下來，沒傳（含前端 polish／chat-stream 舊路由）記 null', () => {
    const withId = buildLlmRecord({
      kind: 'transcribe',
      meetingId: 'meeting-123',
      model: 'gemini-3.8-flash',
      modelIndex: 0,
      attempt: 1,
      streamed: false,
      latencyMs: 100,
      outcome: 'ok',
      now: FIXED_NOW,
    });
    expect(withId.meetingId).toBe('meeting-123');

    const withoutId = buildLlmRecord({
      kind: 'chat-stream',
      model: 'gemini-3.8-flash',
      modelIndex: 0,
      attempt: 1,
      streamed: true,
      latencyMs: 100,
      outcome: 'ok',
      now: FIXED_NOW,
    });
    expect(withoutId.meetingId).toBeNull();
  });

  it('退到 fallback 鏈第二個模型時 modelIndex 記得下來', () => {
    const record = buildLlmRecord({
      kind: 'analyze',
      model: 'gemini-3.1-flash-lite',
      modelIndex: 1,
      attempt: 2,
      streamed: false,
      latencyMs: 8100,
      outcome: 'transient',
      error: Object.assign(new Error('503 model unavailable'), { status: 503 }),
      now: FIXED_NOW,
    });
    expect(record.modelIndex).toBe(1);
    expect(record.attempt).toBe(2);
    expect(record.outcome).toBe('transient');
    expect(record.errorStatus).toBe(503);
    expect(record.totalTokens).toBeNull();
  });

  it('串流成功時 ttfbMs 記得下來', () => {
    const record = buildLlmRecord({
      kind: 'chat-stream',
      model: 'gemini-3.8-flash',
      modelIndex: 0,
      attempt: 1,
      streamed: true,
      latencyMs: 12000,
      ttfbMs: 850,
      outcome: 'ok',
      response: { usageMetadata: { totalTokenCount: 30000 } },
      now: FIXED_NOW,
    });
    expect(record.ttfbMs).toBe(850);
    expect(record.streamed).toBe(true);
    expect(record.totalTokens).toBe(30000);
  });

  it('失敗的呼叫不會因為沒有 response 就把 token 記成 0', () => {
    const record = buildLlmRecord({
      kind: 'polish',
      model: 'gemini-flash-latest',
      modelIndex: 2,
      attempt: 1,
      streamed: false,
      latencyMs: 300,
      outcome: 'fatal',
      error: new Error('API key not valid'),
      now: FIXED_NOW,
    });
    expect(record.promptTokens).toBeNull();
    expect(record.outputTokens).toBeNull();
    expect(record.totalTokens).toBeNull();
    expect(record.errorMessage).toBe('API key not valid');
  });
});

describe('resolveLlmLogPath', () => {
  it('未設定時用預設路徑', () => {
    expect(resolveLlmLogPath({})).toBe('logs/llm.jsonl');
  });

  it('空字串與純空白視同未設定', () => {
    expect(resolveLlmLogPath({ MEETPILOT_LLM_LOG: '' })).toBe('logs/llm.jsonl');
    expect(resolveLlmLogPath({ MEETPILOT_LLM_LOG: '   ' })).toBe('logs/llm.jsonl');
  });

  it('off 關閉紀錄，大小寫都認', () => {
    expect(resolveLlmLogPath({ MEETPILOT_LLM_LOG: 'off' })).toBeNull();
    expect(resolveLlmLogPath({ MEETPILOT_LLM_LOG: 'OFF' })).toBeNull();
  });

  it('其他值當成檔案路徑，前後空白去掉', () => {
    expect(resolveLlmLogPath({ MEETPILOT_LLM_LOG: ' /var/log/meetpilot.jsonl ' })).toBe(
      '/var/log/meetpilot.jsonl'
    );
  });
});

describe('createLlmLogger', () => {
  const sampleCall = {
    kind: 'transcribe' as const,
    model: 'gemini-3.8-flash',
    modelIndex: 0,
    attempt: 1,
    streamed: false,
    latencyMs: 4200,
    outcome: 'ok' as const,
    response: { usageMetadata: { promptTokenCount: 1000, totalTokenCount: 1200 } },
    now: FIXED_NOW,
  };

  it('路徑是 null 時不建任何檔案', () => {
    const logger = createLlmLogger(null);
    logger.log(sampleCall);
    // 不拋錯就是預期行為；沒有路徑就沒有檔案可以驗
    expect(typeof logger.log).toBe('function');
  });

  it('每筆一行 JSON，兩筆就是兩行', () => {
    const logPath = tempLogPath();
    const logger = createLlmLogger(logPath);
    logger.log(sampleCall);
    logger.log({ ...sampleCall, kind: 'polish', modelIndex: 1, outcome: 'ok' });

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'transcribe', modelIndex: 0, totalTokens: 1200 });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'polish', modelIndex: 1 });
  });

  it('呼叫成功卻拿不到任何 token 數時警告一次，不是每筆都洗版', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = createLlmLogger(tempLogPath());
      // response 沒有 usageMetadata：SDK 換形狀時就是這個樣子
      logger.log({ ...sampleCall, response: {} });
      logger.log({ ...sampleCall, response: {} });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('取不到 token 數');
    } finally {
      warn.mockRestore();
    }
  });

  it('拿得到 token 數時不警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createLlmLogger(tempLogPath()).log(sampleCall);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('失敗的呼叫本來就沒有 token 數，不該因此警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createLlmLogger(tempLogPath()).log({
        ...sampleCall,
        outcome: 'fatal',
        response: undefined,
        error: new Error('API key not valid'),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('目錄不存在時建出來，並在啟動當下就建好檔案', () => {
    const logPath = join(tempLogPath('x'), '..', 'nested', 'deeper', 'llm.jsonl');
    createLlmLogger(logPath);
    expect(existsSync(logPath)).toBe(true);
  });

  it('路徑不可寫時在建立當下就拋錯，訊息指得出是哪個設定與哪條路徑', () => {
    const logPath = tempLogPath();
    const dir = join(logPath, '..');
    const blocked = join(dir, 'blocked.jsonl');
    chmodSync(dir, 0o500);
    expect(() => createLlmLogger(blocked)).toThrowError(
      new RegExp(`MEETPILOT_LLM_LOG="${blocked}" 無法寫入：.*設成 off 關閉呼叫紀錄`)
    );
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DIAGNOSTICS_DIR_NAME,
  DiagnosticsConfig,
  FLUSH_DELAY_MS,
  createDiagnosticsExporter,
  resolveDiagnosticsConfig,
  runDiagnosticsExport,
} from './diagnosticsExport';

const T0 = Date.UTC(2026, 8, 29, 4, 39, 0);

let root: string;
let vaultDir: string;
let config: DiagnosticsConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'meetpilot-diag-'));
  vaultDir = join(root, 'MeetPilot 記錄', '王小明');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(join(root, 'logs'));
  config = {
    vaultDir,
    serverLogPath: join(root, 'logs', 'server.log'),
    llmLogPath: join(root, 'logs', 'llm.jsonl'),
    appVersion: '0.1.2',
  };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const diagDir = () => join(vaultDir, DIAGNOSTICS_DIR_NAME);
const readInfo = () => JSON.parse(readFileSync(join(diagDir(), 'info.json'), 'utf8'));

describe('createDiagnosticsExporter', () => {
  it('把兩份 log 原樣複製進投影資料夾的 _診斷/，info.json 記下觸發的會議、狀態、版本與 bytes', () => {
    const serverLog = '--- 啟動 server ---\n[Gemini Request] Model gemini-3.8-flash (attempt 1) failed: fetch failed\n';
    const llmLog = '{"kind":"transcribe","meetingId":"m-1","outcome":"ok"}\n';
    writeFileSync(config.serverLogPath, serverLog);
    writeFileSync(config.llmLogPath!, llmLog);

    createDiagnosticsExporter(config, { now: () => T0 }).export('m-1', 'LINKED');

    expect(readFileSync(join(diagDir(), 'server.log'), 'utf8')).toBe(serverLog);
    expect(readFileSync(join(diagDir(), 'llm.jsonl'), 'utf8')).toBe(llmLog);
    expect(readInfo()).toEqual({
      exportedAt: '2026-09-29T04:39:00.000Z',
      trigger: { meetingId: 'm-1', status: 'LINKED' },
      appVersion: '0.1.2',
      platform: process.platform,
      arch: process.arch,
      files: {
        'server.log': { bytes: Buffer.byteLength(serverLog) },
        'llm.jsonl': { bytes: Buffer.byteLength(llmLog) },
      },
    });
  });

  it('下一場會再匯出時整份換成新的內容，不留暫存檔', () => {
    writeFileSync(config.serverLogPath, '第一場\n');
    writeFileSync(config.llmLogPath!, '{"a":1}\n');
    const exporter = createDiagnosticsExporter(config);
    exporter.export('m-1', 'READY');
    writeFileSync(config.serverLogPath, '第一場\n第二場失敗\n');
    exporter.export('m-2', 'FAILED');

    expect(readFileSync(join(diagDir(), 'server.log'), 'utf8')).toBe('第一場\n第二場失敗\n');
    expect(readInfo().trigger).toEqual({ meetingId: 'm-2', status: 'FAILED' });
    expect(readdirSync(diagDir()).sort()).toEqual(['info.json', 'llm.jsonl', 'server.log']);
  });

  it('來源檔不在時 info.json 寫明找不到哪個路徑，另一份照樣複製', () => {
    writeFileSync(config.serverLogPath, 'server 有\n');

    createDiagnosticsExporter(config).export('m-1', 'FAILED');

    expect(readInfo().files).toEqual({
      'server.log': { bytes: Buffer.byteLength('server 有\n') },
      'llm.jsonl': { missing: `找不到 ${config.llmLogPath}` },
    });
    expect(existsSync(join(diagDir(), 'llm.jsonl'))).toBe(false);
  });

  it('MEETPILOT_LLM_LOG=off 時 info.json 講明是關掉的，不是找不到', () => {
    writeFileSync(config.serverLogPath, 'x\n');

    createDiagnosticsExporter({ ...config, llmLogPath: null }).export('m-1', 'READY');

    expect(readInfo().files['llm.jsonl']).toEqual({ missing: 'MEETPILOT_LLM_LOG=off，沒有 Gemini 呼叫紀錄' });
  });

  it('來源是目錄這類讀得到路徑但讀不出內容的情況，記成 error 而不是 missing', () => {
    writeFileSync(config.serverLogPath, 'x\n');
    mkdirSync(config.llmLogPath!);

    createDiagnosticsExporter(config).export('m-1', 'READY');

    expect(readInfo().files['llm.jsonl'].error).toContain(`讀不到 ${config.llmLogPath}`);
  });

  it('rename 失敗（Windows 上 OneDrive 鎖住檔案這類）時拋錯，不留暫存檔在共享資料夾裡', () => {
    writeFileSync(config.serverLogPath, 'x\n');
    mkdirSync(join(diagDir(), 'server.log'), { recursive: true });

    expect(() => createDiagnosticsExporter(config).export('m-1', 'READY')).toThrow();
    expect(readdirSync(diagDir())).toEqual(['server.log']);
  });

  it('投影資料夾不見了就拋錯，不自己建一個不會同步的本機資料夾', () => {
    writeFileSync(config.serverLogPath, 'x\n');
    rmSync(vaultDir, { recursive: true });

    expect(() => createDiagnosticsExporter(config).export('m-1', 'READY')).toThrow();
    expect(existsSync(vaultDir)).toBe(false);
  });
});

describe('runDiagnosticsExport', () => {
  it('延後才複製：延遲期間 main process 才寫進 server.log 的失敗原因也在副本裡，狀態是觸發當下的', () => {
    vi.useFakeTimers();
    writeFileSync(config.serverLogPath, '轉錄開始\n');
    writeFileSync(config.llmLogPath!, '{}\n');
    const exporter = createDiagnosticsExporter(config);

    runDiagnosticsExport(exporter, 'm-1', () => 'FAILED', '[Test]');
    // server 印出的失敗原因還在 pipe 裡，main process 稍後才寫進檔
    writeFileSync(config.serverLogPath, '轉錄開始\n[Transcription] Meeting m-1 轉錄失敗：ECONNRESET\n');
    expect(existsSync(diagDir())).toBe(false);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(readFileSync(join(diagDir(), 'server.log'), 'utf8')).toContain('ECONNRESET');
    expect(readInfo().trigger).toEqual({ meetingId: 'm-1', status: 'FAILED' });
  });

  it('延後的匯出失敗只記一行帶路徑的 log，不往上拋', () => {
    vi.useFakeTimers();
    rmSync(vaultDir, { recursive: true });
    const exporter = createDiagnosticsExporter(config);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => runDiagnosticsExport(exporter, 'm-1', () => 'FAILED', '[Test]')).not.toThrow();
    expect(() => vi.advanceTimersByTime(FLUSH_DELAY_MS)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(join(vaultDir, DIAGNOSTICS_DIR_NAME));
    error.mockRestore();
  });

  it('讀狀態時拋錯也接住：匯出不能拖累已經落地的會議狀態', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = createDiagnosticsExporter(config);

    expect(() => runDiagnosticsExport(exporter, 'm-1', () => { throw new Error('資料庫被鎖'); }, '[Test]')).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('exporter 是 null 時什麼都不做', () => {
    const readStatus = vi.fn(() => 'READY' as const);
    runDiagnosticsExport(null, 'm-1', readStatus, '[Test]');
    expect(readStatus).not.toHaveBeenCalled();
  });
});

describe('resolveDiagnosticsConfig', () => {
  it('沒設 MEETPILOT_SERVER_LOG（網頁版）就不開', () => {
    expect(resolveDiagnosticsConfig({}, vaultDir)).toBeNull();
    expect(resolveDiagnosticsConfig({ MEETPILOT_SERVER_LOG: '  ' }, vaultDir)).toBeNull();
  });

  it('桌面版：路徑轉成絕對路徑，llm log 跟 server 用同一套解析，版本照給', () => {
    expect(resolveDiagnosticsConfig({
      MEETPILOT_SERVER_LOG: ' logs/server.log ',
      MEETPILOT_LLM_LOG: 'logs/llm.jsonl',
      MEETPILOT_APP_VERSION: '0.1.2',
    }, vaultDir)).toEqual({
      vaultDir,
      serverLogPath: resolve('logs/server.log'),
      llmLogPath: resolve('logs/llm.jsonl'),
      appVersion: '0.1.2',
    });
  });

  it('llm log 關掉是 null、沒給版本也是 null，都不塞預設值', () => {
    expect(resolveDiagnosticsConfig({ MEETPILOT_SERVER_LOG: 'a.log', MEETPILOT_LLM_LOG: 'off' }, vaultDir)).toEqual({
      vaultDir,
      serverLogPath: resolve('a.log'),
      llmLogPath: null,
      appVersion: null,
    });
  });
});

/**
 * 診斷 log 跟著會議記錄出去（vault plan「MeetPilot · 診斷 log 跟著會議記錄上傳」）。
 *
 * 每位記錄人的 app 各跑在自己的電腦上，log 只在那台的 userData 裡，出事時只能請對方找檔案傳過來。
 * 投影資料夾是共享 OneDrive 裡這位記錄人的子資料夾，本來就會同步出去，所以會議走到流程終點時
 * 把 `server.log`、`llm.jsonl` 整份複製進它底下的 `_診斷/`，順著同一條同步出去。
 *
 * - **整份複製，不按會議過濾**：`server.log` 沒有時間戳，Gemini 重試、網路錯誤的 cause 這類行
 *   不帶 meetingId，過濾掉就看不出前因。
 * - **放子資料夾**：投影器只掃投影資料夾這一層的 `.md`（`scanVaultIndex`），子資料夾不會被當成會議記錄。
 * - **不建投影資料夾本身**：只建 `_診斷/` 這一層。共享資料夾被取消同步或刪掉時，自己建一個
 *   不會同步的本機資料夾等於安靜地收不到（跟桌面 app 啟動時「資料夾不見了」的處理同一個理由）。
 * - 每個檔先寫暫存檔再 rename，OneDrive 不會同步到半截的檔。
 * - **延後 `FLUSH_DELAY_MS` 才複製**：`server.log` 是桌面 app 的 main process 從 server 的 stdout／stderr
 *   pipe 收下來再寫的，跟 server 不同步。當下就複製，剛印出來的失敗原因還在 pipe 裡，副本剛好缺最該看的那幾行。
 *   狀態在觸發當下讀，不是複製時讀。延後期間 app 被關掉就這次不寫，下一場會再寫。
 * - 來源檔不在、讀不到，寫進 `info.json` 講清楚，不安靜略過；投影資料夾寫不進去就拋，由呼叫端記 log。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLlmLogPath } from './llmTelemetry';
import { MeetingStatus } from './meetingState';
import { writeAtomic } from './vaultProjector';

export const DIAGNOSTICS_DIR_NAME = '_診斷';

/** 本機 pipe 的延遲是毫秒級，2 秒是寬裕的上限；延後的代價只是晚 2 秒同步 */
export const FLUSH_DELAY_MS = 2000;

export interface DiagnosticsConfig {
  vaultDir: string;
  serverLogPath: string;
  /** null 是 `MEETPILOT_LLM_LOG=off`：沒有這份紀錄，`info.json` 會寫明 */
  llmLogPath: string | null;
  /** 桌面 app 傳 `app.getVersion()`；沒設是 null，不猜 */
  appVersion: string | null;
}

/**
 * `MEETPILOT_SERVER_LOG` 沒設就回 null，整個功能不開：網頁版的 server 輸出在終端機，沒有檔可以複製。
 * 桌面 app 的 `serverEnv` 一律設它。
 */
export function resolveDiagnosticsConfig(env: NodeJS.ProcessEnv, vaultDir: string): DiagnosticsConfig | null {
  const serverLog = (env.MEETPILOT_SERVER_LOG ?? '').trim();
  if (serverLog === '') return null;
  const llmLog = resolveLlmLogPath(env);
  const appVersion = (env.MEETPILOT_APP_VERSION ?? '').trim();
  return {
    vaultDir,
    serverLogPath: resolve(serverLog),
    llmLogPath: llmLog === null ? null : resolve(llmLog),
    appVersion: appVersion === '' ? null : appVersion,
  };
}

/** 一個來源檔的結果：複製了幾 bytes，或為什麼沒有 */
export type CopiedFile = { bytes: number } | { missing: string } | { error: string };

export interface DiagnosticsInfo {
  exportedAt: string;
  trigger: { meetingId: string; status: MeetingStatus | null };
  appVersion: string | null;
  platform: string;
  arch: string;
  files: Record<'server.log' | 'llm.jsonl', CopiedFile>;
}

export function createDiagnosticsExporter(
  config: DiagnosticsConfig,
  deps: { now?: () => number; flushDelayMs?: number } = {},
) {
  const now = deps.now ?? (() => Date.now());
  const flushDelayMs = deps.flushDelayMs ?? FLUSH_DELAY_MS;
  const dir = join(config.vaultDir, DIAGNOSTICS_DIR_NAME);

  // 來源讀不到只記在 info.json：另一個檔照樣要出去。寫進 `_診斷/` 失敗就往上拋，那是整件事沒做成
  const copy = (source: string | null, name: string, offReason: string): CopiedFile => {
    if (source === null) return { missing: offReason };
    let content: Buffer;
    try {
      content = readFileSync(source);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? { missing: `找不到 ${source}` } : { error: `讀不到 ${source}：${(err as Error).message}` };
    }
    writeAtomic(join(dir, name), content);
    return { bytes: content.length };
  };

  /** 同步執行。回傳寫進 `info.json` 的內容，給呼叫端與測試看 */
  const exportFor = (meetingId: string, status: MeetingStatus | null): DiagnosticsInfo => {
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const info: DiagnosticsInfo = {
      exportedAt: new Date(now()).toISOString(),
      trigger: { meetingId, status },
      appVersion: config.appVersion,
      platform: process.platform,
      arch: process.arch,
      files: {
        'server.log': copy(config.serverLogPath, 'server.log', '沒有 server log'),
        'llm.jsonl': copy(config.llmLogPath, 'llm.jsonl', 'MEETPILOT_LLM_LOG=off，沒有 Gemini 呼叫紀錄'),
      },
    };
    writeAtomic(join(dir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
    return info;
  };

  /** 延後匯出，不拋錯：寫不進去只記一行帶路徑與原因的 log。狀態由呼叫端在觸發當下讀好傳進來 */
  const schedule = (meetingId: string, status: MeetingStatus | null, logPrefix: string): void => {
    setTimeout(() => {
      try {
        exportFor(meetingId, status);
      } catch (err) {
        console.error(`${logPrefix} Meeting ${meetingId} 的診斷 log 沒有寫進 ${dir}：`, err);
      }
    }, flushDelayMs);
  };

  return { dir, export: exportFor, schedule };
}

export type DiagnosticsExporter = ReturnType<typeof createDiagnosticsExporter>;

/**
 * 呼叫端共用的「排一次匯出」（同 `runProjection` 的形狀）。匯出失敗不能拖累會議：狀態已經落地，
 * 讀狀態失敗也只記一行 log，不往上拋。`exporter` 是 null 就是 no-op。
 */
export const runDiagnosticsExport = (
  exporter: Pick<DiagnosticsExporter, 'dir' | 'schedule'> | null | undefined,
  meetingId: string,
  readStatus: () => MeetingStatus | null,
  logPrefix: string,
): void => {
  if (!exporter) return;
  try {
    exporter.schedule(meetingId, readStatus(), logPrefix);
  } catch (err) {
    console.error(`${logPrefix} Meeting ${meetingId} 的診斷 log 沒有排進匯出（${exporter.dir}）：`, err);
  }
};

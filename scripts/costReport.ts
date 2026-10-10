/**
 * 成本總覽（只給使用者看，不進 app）。
 *
 *   npm run cost:report                      # 共享資料夾取桌面 app 設定檔 vaultDir 的上一層，輸出到 ~/MeetPilot 成本/
 *   npm run cost:report -- --shared <資料夾> --out <資料夾>
 *
 * 讀共享資料夾底下每個子資料夾（一位記錄人一個）的 `_診斷/llm.jsonl` 與 `_狀態.json`，
 * 輸出分人、分月、逐場的估算花費與各步驟分項，失敗重試另列一欄。價目表在 `scripts/geminiPrices.json`。
 * 輸出不寫進共享資料夾（`--out` 落在裡面就拒絕）。不設花費上限，只呈現。
 *
 * 獨立可執行，純函式 export 給測試；CLI 入口只在直接執行時跑。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMeetingStatus, type MeetingStatus } from '../services/meetingState';

export const DIAGNOSTICS_DIR = '_診斷';
export const LLM_LOG_NAME = 'llm.jsonl';
export const STATUS_FILE_NAME = '_狀態.json';
export const DEFAULT_PRICES_PATH = new URL('./geminiPrices.json', import.meta.url);
const CONFLICT_INFIX = '.conflict-';
const UNATTRIBUTED = '未歸屬';

// ---------- 價目表 ----------

export interface PriceRow {
  model: string;
  /** YYYY-MM-DD，以呼叫時間的 UTC 日期比對 */
  effectiveFrom: string;
  inputPerM: number;
  /** 有就在 `kind` 是 `transcribe` 時用；沒有就用 inputPerM */
  audioInputPerM?: number;
  outputPerM: number;
}

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parsePriceTable(raw: unknown, source: string): PriceRow[] {
  if (!Array.isArray(raw)) throw new Error(`${source} 要是陣列，每列 { model, effectiveFrom, inputPerM, audioInputPerM?, outputPerM }`);
  return raw.map((row, i) => {
    const r = row as Record<string, unknown> | null;
    const where = `${source} 第 ${i + 1} 列`;
    if (typeof r?.model !== 'string' || r.model === '') throw new Error(`${where} 缺 model`);
    if (typeof r.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom)) {
      throw new Error(`${where} 的 effectiveFrom 要是 YYYY-MM-DD`);
    }
    if (!isPrice(r.inputPerM)) throw new Error(`${where} 的 inputPerM 要是非負數字`);
    if (!isPrice(r.outputPerM)) throw new Error(`${where} 的 outputPerM 要是非負數字`);
    const audio = r.audioInputPerM;
    if (audio !== undefined && !isPrice(audio)) throw new Error(`${where} 的 audioInputPerM 要是非負數字`);
    return {
      model: r.model,
      effectiveFrom: r.effectiveFrom,
      inputPerM: r.inputPerM,
      ...(isPrice(audio) ? { audioInputPerM: audio } : {}),
      outputPerM: r.outputPerM,
    };
  });
}

export function loadPriceTable(path: string | URL = DEFAULT_PRICES_PATH): PriceRow[] {
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`價目表 ${String(path)} 不是合法 JSON：${(err as Error).message}`);
  }
  return parsePriceTable(raw, String(path));
}

/** 呼叫當下有效的那列：同一模型 effectiveFrom 不晚於呼叫 UTC 日期的最晚一列。找不到就拋，不當 0 */
export function priceFor(prices: readonly PriceRow[], model: string, ts: string): PriceRow {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) throw new Error(`呼叫時間 ${JSON.stringify(ts)} 不是 ISO 時間`);
  const day = ts.slice(0, 10);
  const rows = prices.filter((p) => p.model === model);
  if (rows.length === 0) throw new Error(`價目表沒有模型 ${model}，請在 scripts/geminiPrices.json 補上價格`);
  const effective = rows.filter((p) => p.effectiveFrom <= day).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (effective.length === 0) {
    throw new Error(`價目表裡 ${model} 最早從 ${rows.map((p) => p.effectiveFrom).sort()[0]} 生效，${ts} 的呼叫沒有適用的價格`);
  }
  return effective[0];
}

// ---------- 紀錄與單筆花費 ----------

export interface CallRecord {
  ts: string;
  kind: string;
  meetingId: string | null;
  model: string;
  outcome: string;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

const tokenOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseLlmLog(text: string, source: string): CallRecord[] {
  const records: CallRecord[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source} 第 ${i + 1} 行不是合法 JSON：${(err as Error).message}`);
    }
    const where = `${source} 第 ${i + 1} 行`;
    for (const field of ['ts', 'kind', 'model', 'outcome'] as const) {
      if (typeof r[field] !== 'string' || r[field] === '') throw new Error(`${where} 缺 ${field}`);
    }
    if (Number.isNaN(Date.parse(r.ts as string))) throw new Error(`${where} 的 ts 不是時間：${String(r.ts)}`);
    records.push({
      ts: r.ts as string,
      kind: r.kind as string,
      meetingId: typeof r.meetingId === 'string' && r.meetingId !== '' ? r.meetingId : null,
      model: r.model as string,
      outcome: r.outcome as string,
      promptTokens: tokenOrNull(r.promptTokens),
      outputTokens: tokenOrNull(r.outputTokens),
      thoughtsTokens: tokenOrNull(r.thoughtsTokens),
    });
  });
  return records;
}

/**
 * 單筆估算。`amount` 是 null 代表「未計」：
 * - `embed`：紀錄沒有 token 數，不算進金額，也不查價（embedding 模型不在價目表）。
 * - `no-tokens`：三個 token 欄都是 null（失敗在拿到回應之前，或 SDK 沒回用量），沒有數字可乘，不查價也不當 0 金額。
 * - `unpriced`：有 token 但價目表完全沒有這個模型（例如 fallback 鏈最後的 `gemini-flash-latest`）。不猜價、不當 0，
 *   不算進金額，由呼叫端另列「價目表沒有的模型」並在 CLI 警告。
 * 價目表有這個模型、但呼叫日早於最早生效日，仍然拋（那是價目表寫錯，不是新模型）。`thoughtsTokens` 為 null 當 0。
 */
export function costOfCall(
  rec: CallRecord,
  prices: readonly PriceRow[],
): { amount: number | null; uncounted: 'embed' | 'no-tokens' | 'unpriced' | null } {
  if (rec.kind === 'embed') return { amount: null, uncounted: 'embed' };
  if (rec.promptTokens === null && rec.outputTokens === null && rec.thoughtsTokens === null) {
    return { amount: null, uncounted: 'no-tokens' };
  }
  if (!prices.some((p) => p.model === rec.model)) return { amount: null, uncounted: 'unpriced' };
  const price = priceFor(prices, rec.model, rec.ts);
  const inputRate = rec.kind === 'transcribe' && price.audioInputPerM !== undefined ? price.audioInputPerM : price.inputPerM;
  const amount = ((rec.promptTokens ?? 0) * inputRate + ((rec.outputTokens ?? 0) + (rec.thoughtsTokens ?? 0)) * price.outputPerM) / 1_000_000;
  return { amount, uncounted: null };
}

// ---------- 狀態檔：卡住的會議 ----------

/** 狀態檔 `writtenAt` 超過這麼久沒更新，視為 app 沒在跑 */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** 處理中的會議 `updatedAt` 超過這麼久沒變，視為卡住 */
export const PROGRESS_STALE_MS = 30 * 60_000;
/** 錄音中的會議 `updatedAt` 超過這麼久，改列需要處理 */
export const RECORDING_STALE_MS = 3 * 60 * 60_000;

export interface StatusMeeting {
  meetingId: string;
  title: string | null;
  status: MeetingStatus;
  inProgress: boolean;
  updatedAt: string;
  error: string | null;
}

export interface StatusFile {
  writtenAt: string;
  meetings: StatusMeeting[];
}

const stringOrNull = (v: unknown, where: string): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`${where} 要是字串或 null`);
  return v;
};

export function parseStatusFile(text: string, source: string): StatusFile {
  let raw: Record<string, unknown> | null;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} 不是合法 JSON：${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || raw.schema !== 1) {
    throw new Error(`${source} 的 schema 是 ${JSON.stringify((raw as { schema?: unknown } | null)?.schema)}，這支腳本只認 1`);
  }
  const isoField = (v: unknown, where: string): string => {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${where} 不是 ISO 時間：${JSON.stringify(v)}`);
    return v;
  };
  const writtenAt = isoField(raw.writtenAt, `${source} 的 writtenAt`);
  if (!Array.isArray(raw.meetings)) throw new Error(`${source} 缺 meetings 陣列`);
  const meetings = raw.meetings.map((m: Record<string, unknown> | null, i: number): StatusMeeting => {
    const where = `${source} meetings[${i}]`;
    const { meetingId, status, inProgress, title, error } = m ?? {};
    if (typeof meetingId !== 'string' || meetingId === '') throw new Error(`${where} 缺 meetingId`);
    if (!isMeetingStatus(status)) throw new Error(`${where} 的 status 不認得：${JSON.stringify(status)}`);
    if (typeof inProgress !== 'boolean') throw new Error(`${where} 的 inProgress 要是 boolean`);
    return {
      meetingId,
      title: stringOrNull(title, `${where} 的 title`),
      status,
      inProgress,
      updatedAt: isoField(m?.updatedAt, `${where} 的 updatedAt`),
      error: stringOrNull(error, `${where} 的 error`),
    };
  });
  return { writtenAt, meetings };
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分鐘';
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小時 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`;
}

export type StatusClass = '卡住' | '處理中' | '錄音中' | '需要處理';
export const STATUS_CLASSES: readonly StatusClass[] = ['卡住', '處理中', '錄音中', '需要處理'];

export interface ClassifiedMeeting {
  meeting: StatusMeeting;
  klass: StatusClass;
  /** 從 `updatedAt` 到 now 的毫秒數：卡住是「卡多久」，需要處理的 RECORDING 是「已過多久」 */
  ageMs: number;
  /** 為什麼落在這一類（卡住與需要處理才有） */
  reasons: string[];
}

/**
 * 每一場恰好落一類：
 * - `inProgress` 為 true：`writtenAt` 超過 10 分鐘（app 沒在跑）或 `updatedAt` 超過 30 分鐘 → 卡住，否則處理中。
 * - `inProgress` 為 false 且 `RECORDING`：`updatedAt` 超過 3 小時 → 需要處理，否則錄音中。
 * - 其餘 `inProgress` 為 false 的（含停在 TRANSCRIBING／TRANSCRIBED／ANALYZING 卻沒有進行中 job 的）→ 需要處理。
 */
export function classifyMeeting(meeting: StatusMeeting, writtenAt: string, now: Date): ClassifiedMeeting {
  const ageMs = now.getTime() - Date.parse(meeting.updatedAt);
  const heartbeatMs = now.getTime() - Date.parse(writtenAt);
  if (meeting.inProgress) {
    const reasons: string[] = [];
    if (heartbeatMs > HEARTBEAT_STALE_MS) reasons.push(`app 已 ${formatDuration(heartbeatMs)}沒有更新狀態檔`);
    if (ageMs > PROGRESS_STALE_MS) reasons.push(`狀態 ${formatDuration(ageMs)}沒有變化`);
    return { meeting, klass: reasons.length > 0 ? '卡住' : '處理中', ageMs, reasons };
  }
  if (meeting.status === 'RECORDING') {
    if (ageMs > RECORDING_STALE_MS) return { meeting, klass: '需要處理', ageMs, reasons: [`錄音狀態已過 ${formatDuration(ageMs)}`] };
    return { meeting, klass: '錄音中', ageMs, reasons: [] };
  }
  return { meeting, klass: '需要處理', ageMs, reasons: [`停在 ${meeting.status}，沒有進行中的 job`] };
}

export interface StatusSection {
  writtenAt: string;
  heartbeatMs: number;
  items: ClassifiedMeeting[];
}

// ---------- 彙總 ----------

export interface Totals {
  /** 全部有算出金額的呼叫，含失敗 */
  cost: number;
  /** 其中 outcome 不是 ok 的 */
  failedCost: number;
  calls: number;
  failedCalls: number;
  /** 沒有金額的呼叫數（embed、沒有 token 數的、價目表沒有模型的） */
  uncounted: number;
  /** uncounted 裡「價目表沒有這個模型」的那幾次 */
  unpriced: number;
}

export interface Bucket extends Totals {
  byKind: Map<string, Totals>;
}

const emptyTotals = (): Totals => ({ cost: 0, failedCost: 0, calls: 0, failedCalls: 0, uncounted: 0, unpriced: 0 });
const emptyBucket = (): Bucket => ({ ...emptyTotals(), byKind: new Map() });

function addTo(t: Totals, amount: number | null, failed: boolean, unpriced: boolean): void {
  t.calls += 1;
  if (unpriced) t.unpriced += 1;
  if (failed) t.failedCalls += 1;
  if (amount === null) {
    t.uncounted += 1;
    return;
  }
  t.cost += amount;
  if (failed) t.failedCost += amount;
}

function addCall(bucket: Bucket, kind: string, amount: number | null, failed: boolean, unpriced: boolean): void {
  addTo(bucket, amount, failed, unpriced);
  let k = bucket.byKind.get(kind);
  if (!k) bucket.byKind.set(kind, (k = emptyTotals()));
  addTo(k, amount, failed, unpriced);
}

export interface MeetingRow {
  month: string;
  /** null 是「未歸屬」 */
  meetingId: string | null;
  title: string;
  firstTs: string;
  bucket: Bucket;
}

/** 價目表沒有、但有 token 的模型：沒算進金額，逐模型列次數與 token 數，提醒使用者補價目表 */
export interface UnpricedModel {
  model: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export interface PersonReport {
  name: string;
  /** false：`_診斷/llm.jsonl` 不存在 */
  hasLlmLog: boolean;
  total: Bucket;
  months: Map<string, Bucket>;
  meetings: MeetingRow[];
  /** null：沒有 `_狀態.json` */
  status: StatusSection | null;
  /** 兩個 kind 以外的計數，給頁尾說明 */
  embedCalls: number;
  noTokenCalls: number;
  unpricedCalls: number;
  unpricedModels: Map<string, UnpricedModel>;
}

export interface CostReport {
  generatedAt: string;
  sharedRoot: string;
  people: PersonReport[];
  total: Bucket;
  /** 人 × 月彙總 */
  personMonths: Array<{ person: string; month: string; bucket: Bucket }>;
  /** 月彙總（所有人） */
  months: Map<string, Bucket>;
  /** 價目表沒有的模型（所有人合併），依模型名排序 */
  unpricedModels: UnpricedModel[];
}

/** 掃一位記錄人資料夾第一層的 .md，建 meetpilot_id → 檔名（不含 .md）。規則跟 `vaultProjector` 的 `scanVaultIndex` 一致：跳過 conflict 副本，同 id 兩檔就拋 */
export function loadMeetingTitles(personDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const name of readdirSync(personDir).sort()) {
    if (!name.endsWith('.md') || name.includes(CONFLICT_INFIX)) continue;
    const path = join(personDir, name);
    if (!statSync(path).isFile()) continue;
    const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw);
    const id = fm ? /^meetpilot_id:[ \t]*(.*)$/m.exec(fm[1])?.[1].trim().replace(/^["']|["']$/g, '') : undefined;
    if (!id) continue;
    const existing = owner.get(id);
    if (existing) throw new Error(`meetpilot_id ${id} 同時出現在兩個檔案：${existing} 與 ${path}，請先確認哪一份是對的`);
    owner.set(id, path);
    titles.set(id, name.slice(0, -'.md'.length));
  }
  return titles;
}

/** 台灣沒有日光節約，固定 UTC+8。月份用台灣時間分組；換價日不走這裡，`priceFor` 另用 UTC 日期 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60_000;
export const monthOf = (ts: string): string => new Date(Date.parse(ts) + TAIPEI_OFFSET_MS).toISOString().slice(0, 7);

function buildPerson(shared: string, name: string, prices: readonly PriceRow[], now: Date): PersonReport {
  const personDir = join(shared, name);
  const logPath = join(personDir, DIAGNOSTICS_DIR, LLM_LOG_NAME);
  const person: PersonReport = {
    name,
    hasLlmLog: existsSync(logPath),
    total: emptyBucket(),
    months: new Map(),
    meetings: [],
    status: null,
    embedCalls: 0,
    noTokenCalls: 0,
    unpricedCalls: 0,
    unpricedModels: new Map(),
  };
  const titles = loadMeetingTitles(personDir);

  const statusPath = join(personDir, STATUS_FILE_NAME);
  if (existsSync(statusPath)) {
    const file = parseStatusFile(readFileSync(statusPath, 'utf8'), statusPath);
    const items = file.meetings.map((m) => classifyMeeting({ ...m, title: titles.get(m.meetingId) ?? m.title ?? m.meetingId.slice(0, 8) }, file.writtenAt, now));
    person.status = { writtenAt: file.writtenAt, heartbeatMs: now.getTime() - Date.parse(file.writtenAt), items };
  }

  if (!person.hasLlmLog) return person;

  const records = parseLlmLog(readFileSync(logPath, 'utf8'), logPath);
  const rows = new Map<string, MeetingRow>();

  for (const rec of records) {
    const { amount, uncounted } = costOfCall(rec, prices);
    if (uncounted === 'embed') person.embedCalls += 1;
    if (uncounted === 'no-tokens') person.noTokenCalls += 1;
    const isUnpriced = uncounted === 'unpriced';
    if (isUnpriced) {
      person.unpricedCalls += 1;
      let u = person.unpricedModels.get(rec.model);
      if (!u) person.unpricedModels.set(rec.model, (u = { model: rec.model, calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 }));
      u.calls += 1;
      u.promptTokens += rec.promptTokens ?? 0;
      u.outputTokens += rec.outputTokens ?? 0;
      u.thoughtsTokens += rec.thoughtsTokens ?? 0;
    }
    const failed = rec.outcome !== 'ok';
    const month = monthOf(rec.ts);

    addCall(person.total, rec.kind, amount, failed, isUnpriced);
    let m = person.months.get(month);
    if (!m) person.months.set(month, (m = emptyBucket()));
    addCall(m, rec.kind, amount, failed, isUnpriced);

    // 一場跨月就分成兩列，這樣逐場的列加起來等於分月的數字
    const key = `${month}\u0000${rec.meetingId ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      const title = rec.meetingId === null ? UNATTRIBUTED : (titles.get(rec.meetingId) ?? rec.meetingId.slice(0, 8));
      rows.set(key, (row = { month, meetingId: rec.meetingId, title, firstTs: rec.ts, bucket: emptyBucket() }));
    }
    if (rec.ts < row.firstTs) row.firstTs = rec.ts;
    addCall(row.bucket, rec.kind, amount, failed, isUnpriced);
  }

  person.meetings = [...rows.values()].sort((a, b) => a.firstTs.localeCompare(b.firstTs));
  return person;
}

function mergeInto(target: Bucket, source: Bucket): void {
  for (const k of ['cost', 'failedCost', 'calls', 'failedCalls', 'uncounted', 'unpriced'] as const) target[k] += source[k];
  for (const [kind, t] of source.byKind) {
    let dst = target.byKind.get(kind);
    if (!dst) target.byKind.set(kind, (dst = emptyTotals()));
    for (const k of ['cost', 'failedCost', 'calls', 'failedCalls', 'uncounted', 'unpriced'] as const) dst[k] += t[k];
  }
}

export function buildCostReport(sharedRoot: string, prices: readonly PriceRow[], now: Date): CostReport {
  if (!existsSync(sharedRoot) || !statSync(sharedRoot).isDirectory()) throw new Error(`共享資料夾 ${sharedRoot} 不存在或不是資料夾`);
  const names = readdirSync(sharedRoot)
    // `_` 或 `.` 開頭的資料夾（`_更新/`、`.obsidian`）不是記錄人
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && statSync(join(sharedRoot, n)).isDirectory())
    .sort((a, b) => a.localeCompare(b));
  const people = names.map((n) => buildPerson(sharedRoot, n, prices, now));

  const report: CostReport = { generatedAt: now.toISOString(), sharedRoot, people, total: emptyBucket(), personMonths: [], months: new Map(), unpricedModels: [] };
  const unpriced = new Map<string, UnpricedModel>();
  for (const p of people) {
    mergeInto(report.total, p.total);
    for (const u of p.unpricedModels.values()) {
      const dst = unpriced.get(u.model) ?? { model: u.model, calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
      dst.calls += u.calls;
      dst.promptTokens += u.promptTokens;
      dst.outputTokens += u.outputTokens;
      dst.thoughtsTokens += u.thoughtsTokens;
      unpriced.set(u.model, dst);
    }
    for (const [month, b] of [...p.months].sort(([a], [b2]) => a.localeCompare(b2))) {
      report.personMonths.push({ person: p.name, month, bucket: b });
      let all = report.months.get(month);
      if (!all) report.months.set(month, (all = emptyBucket()));
      mergeInto(all, b);
    }
  }
  report.unpricedModels = [...unpriced.values()].sort((a, b) => a.model.localeCompare(b.model));
  report.months = new Map([...report.months].sort(([a], [b]) => a.localeCompare(b)));
  return report;
}

// ---------- 輸出 ----------

const KIND_ORDER = ['transcribe', 'polish', 'analyze', 'extract-tags', 'embed', 'link-judge'];
const KIND_LABEL: Record<string, string> = {
  transcribe: '轉錄',
  polish: '修潤',
  analyze: '分析',
  'extract-tags': '題目標籤',
  embed: 'embedding',
  'link-judge': '關聯判定',
};
const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;

const money = (n: number): string => `$${n.toFixed(4)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const row = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
const table = (head: string[], body: string[][]): string[] => [row(head), row(head.map(() => '---')), ...body.map(row)];

/** 金額欄：有金額就寫金額，另有未計的呼叫就附次數；只有未計就寫「未計 n 次」 */
function amountCell(t: Totals | undefined): string {
  if (!t || t.calls === 0) return '-';
  if (t.uncounted === 0) return money(t.cost);
  if (t.uncounted === t.calls) return `未計 ${t.uncounted} 次`;
  return `${money(t.cost)}（另 ${t.uncounted} 次未計）`;
}

/** 有價目表沒有的模型時回一行警告給 CLI 印在 stderr，沒有就 null */
export function unpricedWarning(report: CostReport): string | null {
  if (report.unpricedModels.length === 0) return null;
  const list = report.unpricedModels.map((u) => `${u.model}（${u.calls} 次）`).join('、');
  return `警告：價目表沒有這些模型，它們的呼叫沒有算進金額：${list}。請到 scripts/geminiPrices.json 補上價格後重跑`;
}

function renderStatusSection(report: CostReport): string[] {
  const out: string[] = ['## 會議狀態（來自各記錄人的 _狀態.json）', ''];
  const count = (k: StatusClass): number => report.people.reduce((n, p) => n + (p.status?.items.filter((i) => i.klass === k).length ?? 0), 0);
  out.push(`卡住 ${count('卡住')} 場、需要處理 ${count('需要處理')} 場、處理中 ${count('處理中')} 場、錄音中 ${count('錄音中')} 場。`, '');
  for (const p of report.people) {
    out.push(`### ${p.name}`, '');
    if (p.status === null) {
      out.push(`沒有狀態檔（找不到 ${STATUS_FILE_NAME}）。`, '');
      continue;
    }
    out.push(`狀態檔寫於 ${p.status.writtenAt}（${formatDuration(p.status.heartbeatMs)}前）。`, '');
    if (p.status.items.length === 0) {
      out.push('沒有進行中或待處理的會議。', '');
      continue;
    }
    for (const klass of STATUS_CLASSES) {
      const items = p.status.items.filter((i) => i.klass === klass);
      if (items.length === 0) continue;
      out.push(`#### ${klass}`, '');
      out.push(...table(['會議', '狀態', klass === '卡住' ? '卡多久' : '距上次更新', '說明'], items.map((i) => [
        i.meeting.title ?? i.meeting.meetingId,
        i.meeting.status,
        formatDuration(i.ageMs),
        [...i.reasons, ...(i.meeting.error ? [`error：${i.meeting.error}`] : [])].join('；') || '-',
      ])), '');
    }
  }
  return out;
}

export function renderCostReport(report: CostReport): string {
  const kinds = new Set<string>();
  for (const k of report.total.byKind.keys()) kinds.add(k);
  const kindCols = [...KIND_ORDER.filter((k) => kinds.has(k)), ...[...kinds].filter((k) => !KIND_ORDER.includes(k)).sort()];

  const out: string[] = [];
  out.push('# MeetPilot 成本總覽', '');
  out.push(`產生時間：${report.generatedAt}`);
  out.push(`共享資料夾：${report.sharedRoot}`);
  out.push('', '金額是依價目表（`scripts/geminiPrices.json`）算的估算，不是帳單。月份用台灣時間（UTC+8）分組。價目表的換價日用呼叫時間的 UTC 日期比。');
  out.push('「其中失敗重試」是 outcome 不是 ok 且有回傳 token 的呼叫金額，已含在估算花費裡。');
  out.push('`_診斷/llm.jsonl` 只在會議走到終點時更新，最近還在跑的會議可能還沒算進來。', '');

  const summaryHead = ['估算花費', '其中失敗重試', '呼叫次數', '失敗次數', '未計次數', '未計價呼叫'];
  const summaryCells = (t: Totals): string[] => [money(t.cost), money(t.failedCost), String(t.calls), String(t.failedCalls), String(t.uncounted), String(t.unpriced)];

  out.push('## 總計', '', ...table(summaryHead, [summaryCells(report.total)]), '');

  if (report.unpricedModels.length > 0) {
    out.push('## 價目表沒有的模型', '');
    out.push('這些模型的呼叫有 token，但價目表沒有價格，沒有算進任何金額（也不猜價）。到 `scripts/geminiPrices.json` 補上價格後重跑。', '');
    out.push(...table(['模型', '呼叫次數', 'promptTokens', 'outputTokens', 'thoughtsTokens'], report.unpricedModels.map((u) => [u.model, String(u.calls), String(u.promptTokens), String(u.outputTokens), String(u.thoughtsTokens)])), '');
  }

  out.push(...renderStatusSection(report));

  out.push('## 各步驟分項（全部記錄人）', '');
  out.push(...table(['步驟', ...summaryHead], kindCols.map((k) => {
    const t = report.total.byKind.get(k) as Totals;
    return [kindLabel(k), k === 'embed' ? '未計' : money(t.cost), money(t.failedCost), String(t.calls), String(t.failedCalls), String(t.uncounted)];
  })), '');

  out.push('## 分人', '');
  out.push(...table(['記錄人', ...summaryHead], report.people.map((p) => [p.name, ...summaryCells(p.total)])), '');

  out.push('## 分月', '');
  out.push(...table(['月', ...summaryHead], [...report.months].map(([m, b]) => [m, ...summaryCells(b)])), '');

  out.push('## 分人分月', '');
  out.push(...table(['記錄人', '月', ...summaryHead], report.personMonths.map((pm) => [pm.person, pm.month, ...summaryCells(pm.bucket)])), '');

  out.push('## 逐場', '');
  for (const p of report.people) {
    out.push(`### ${p.name}`, '');
    if (!p.hasLlmLog) {
      out.push(`沒有呼叫紀錄（找不到 ${DIAGNOSTICS_DIR}/${LLM_LOG_NAME}）。`, '');
      continue;
    }
    if (p.meetings.length === 0) {
      out.push(`${LLM_LOG_NAME} 是空的。`, '');
      continue;
    }
    out.push(...table(
      ['月', '會議', ...summaryHead.slice(0, 2), ...kindCols.map(kindLabel)],
      p.meetings.map((m) => [
        m.month,
        m.title,
        money(m.bucket.cost),
        money(m.bucket.failedCost),
        ...kindCols.map((k) => amountCell(m.bucket.byKind.get(k))),
      ]),
    ), '');
    const notes: string[] = [];
    if (p.embedCalls > 0) notes.push(`embedding ${p.embedCalls} 次未計（紀錄沒有 token 數）`);
    if (p.unpricedCalls > 0) notes.push(`${p.unpricedCalls} 次呼叫的模型不在價目表，沒有算進金額`);
    if (p.noTokenCalls > 0) notes.push(`${p.noTokenCalls} 次呼叫沒有回傳 token 數，沒有算進金額`);
    if (notes.length > 0) out.push(`${notes.join('；')}。`, '');
  }
  return `${out.join('\n')}\n`;
}

// ---------- CLI ----------

export interface CliArgs {
  shared?: string;
  out?: string;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    const m = /^(--shared|--out)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`不認得的參數 ${a}。可用：--shared <資料夾>、--out <資料夾>`);
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${m[1]} 要接一個路徑`);
    if (m[1] === '--shared') args.shared = value;
    else args.out = value;
  }
  return args;
}

export function defaultSettingsPath(platform: NodeJS.Platform, home: string, appData: string | undefined): string {
  if (platform === 'win32') {
    if (!appData) throw new Error('找不到 %APPDATA%，無法定位桌面 app 的設定檔，請用 --shared 指定共享資料夾');
    return join(appData, 'MeetPilot', 'desktop-settings.json');
  }
  return join(home, 'Library', 'Application Support', 'MeetPilot', 'desktop-settings.json');
}

/** 共享資料夾：`--shared` 優先；否則讀桌面 app 設定檔 `vaultDir` 的上一層。讀不到就拋 */
export function resolveSharedRoot(shared: string | undefined, settingsPath: string): string {
  if (shared !== undefined) return resolve(shared);
  let text: string;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch (err) {
    throw new Error(`讀不到桌面 app 設定檔 ${settingsPath}（${(err as Error).message}），請用 --shared 指定共享資料夾`);
  }
  let vaultDir: unknown;
  try {
    vaultDir = (JSON.parse(text) as { vaultDir?: unknown } | null)?.vaultDir;
  } catch (err) {
    throw new Error(`桌面 app 設定檔 ${settingsPath} 不是合法 JSON：${(err as Error).message}，請用 --shared 指定共享資料夾`);
  }
  if (typeof vaultDir !== 'string' || vaultDir === '') {
    throw new Error(`桌面 app 設定檔 ${settingsPath} 沒有 vaultDir（還沒選過資料夾？），請用 --shared 指定共享資料夾`);
  }
  return dirname(resolve(vaultDir));
}

/** resolve 並展開已存在那一段的 symlink（macOS 的 /var → /private/var），還不存在的尾巴照字面接回去 */
function realResolve(p: string): string {
  const abs = resolve(p);
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    tail.unshift(existing.slice(dirname(existing).length + 1));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return join(realpathSync.native(existing), ...tail);
}

export function assertOutOutsideShared(out: string, shared: string): void {
  const rel = relative(realResolve(shared), realResolve(out));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`--out ${out} 在共享資料夾 ${shared} 裡面，成本總覽不能寫進共享資料夾，請換一個位置`);
  }
}

const USAGE = '用法：npm run cost:report -- [--shared <共享資料夾>] [--out <輸出資料夾>]\n預設共享資料夾是桌面 app 設定檔 vaultDir 的上一層，預設輸出是 ~/MeetPilot 成本/';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const shared = resolveSharedRoot(args.shared, defaultSettingsPath(process.platform, homedir(), process.env.APPDATA));
  const outDir = resolve(args.out ?? join(homedir(), 'MeetPilot 成本'));
  assertOutOutsideShared(outDir, shared);

  const report = buildCostReport(shared, loadPriceTable(), new Date());
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, '總覽.md');
  writeFileSync(outPath, renderCostReport(report));
  const warning = unpricedWarning(report);
  if (warning) console.error(warning);
  console.log(`已寫入 ${outPath}（估算總計 ${money(report.total.cost)}，其中失敗重試 ${money(report.total.failedCost)}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

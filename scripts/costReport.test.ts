import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertOutOutsideShared,
  buildCostReport,
  classifyMeeting,
  costOfCall,
  defaultSettingsPath,
  formatDuration,
  loadMeetingTitles,
  loadPriceTable,
  parseArgs,
  parseLlmLog,
  parseStatusFile,
  parsePriceTable,
  priceFor,
  renderCostReport,
  resolveSharedRoot,
  STATUS_CLASSES,
  type CallRecord,
  type StatusMeeting,
} from './costReport';
import { MEETING_STATUSES } from '../services/meetingState';

const prices = loadPriceTable();

const call = (over: Partial<CallRecord>): CallRecord => ({
  ts: '2026-10-01T02:00:00.000Z',
  kind: 'analyze',
  meetingId: 'aaaaaaaa-0000-0000-0000-000000000001',
  model: 'gemini-3.8-flash',
  outcome: 'ok',
  promptTokens: 1_000_000,
  outputTokens: 0,
  thoughtsTokens: 0,
  ...over,
});

const line = (over: Partial<CallRecord>): string => JSON.stringify(call(over));

describe('價目表', () => {
  it('3.8-flash 依呼叫日期取價，2027-01-01 前後分開', () => {
    expect(priceFor(prices, 'gemini-3.8-flash', '2026-12-31T23:59:59.999Z').inputPerM).toBe(0.75);
    expect(priceFor(prices, 'gemini-3.8-flash', '2026-12-31T23:59:59.999Z').outputPerM).toBe(3.75);
    expect(priceFor(prices, 'gemini-3.8-flash', '2027-01-01T00:00:00.000Z').inputPerM).toBe(1.5);
    expect(priceFor(prices, 'gemini-3.8-flash', '2027-01-01T00:00:00.000Z').outputPerM).toBe(7.5);
  });

  it('同一批 token 在換價前後的估算花費不同', () => {
    const base = { promptTokens: 1_000_000, outputTokens: 1_000_000, thoughtsTokens: 0 };
    expect(costOfCall(call({ ...base, ts: '2026-12-31T10:00:00Z' }), prices).amount).toBeCloseTo(0.75 + 3.75, 10);
    expect(costOfCall(call({ ...base, ts: '2027-01-01T10:00:00Z' }), prices).amount).toBeCloseTo(1.5 + 7.5, 10);
  });

  it('資料開始的 2026-09-16 算得出價', () => {
    expect(costOfCall(call({ ts: '2026-09-16T00:00:00Z' }), prices).amount).toBeCloseTo(0.75, 10);
    expect(costOfCall(call({ ts: '2026-09-16T00:00:00Z', model: 'gemini-3.1-flash-lite' }), prices).amount).toBeCloseTo(0.25, 10);
  });

  it('呼叫日早於最早生效日就報錯，不當 0', () => {
    expect(() => priceFor(prices, 'gemini-3.8-flash', '2025-12-31T23:59:59Z')).toThrow(/2026-01-01/);
  });

  it('價目表沒有的模型報錯並指向價目表', () => {
    expect(() => costOfCall(call({ model: 'gemini-9-ultra' }), prices)).toThrow(/gemini-9-ultra.*geminiPrices\.json/);
  });

  it('格式不對的價目表報錯', () => {
    expect(() => parsePriceTable({}, 'x')).toThrow(/陣列/);
    expect(() => parsePriceTable([{ model: 'm', effectiveFrom: '2026/01/01', inputPerM: 1, outputPerM: 1 }], 'x')).toThrow(/effectiveFrom/);
    expect(() => parsePriceTable([{ model: 'm', effectiveFrom: '2026-01-01', inputPerM: -1, outputPerM: 1 }], 'x')).toThrow(/inputPerM/);
    expect(() => parsePriceTable([{ model: 'm', effectiveFrom: '2026-01-01', inputPerM: 1, audioInputPerM: 'a', outputPerM: 1 }], 'x')).toThrow(/audioInputPerM/);
  });
});

describe('單筆估算', () => {
  it('轉錄用音訊價，其他步驟用文字價', () => {
    const base = { model: 'gemini-3.1-flash-lite', promptTokens: 1_000_000, outputTokens: 0, thoughtsTokens: 0 };
    expect(costOfCall(call({ ...base, kind: 'transcribe' }), prices).amount).toBeCloseTo(0.5, 10);
    expect(costOfCall(call({ ...base, kind: 'analyze' }), prices).amount).toBeCloseTo(0.25, 10);
  });

  it('沒有音訊價的模型轉錄用單一 input 價', () => {
    expect(costOfCall(call({ kind: 'transcribe' }), prices).amount).toBeCloseTo(0.75, 10);
  });

  it('output 價乘 outputTokens 加 thoughtsTokens；thoughtsTokens 為 null 當 0', () => {
    const base = { promptTokens: 0, outputTokens: 400_000 };
    expect(costOfCall(call({ ...base, thoughtsTokens: 600_000 }), prices).amount).toBeCloseTo(3.75, 10);
    expect(costOfCall(call({ ...base, thoughtsTokens: null }), prices).amount).toBeCloseTo(1.5, 10);
  });

  it('embed 不算金額、不查價（embedding 模型不在價目表）', () => {
    const r = costOfCall(call({ kind: 'embed', model: 'gemini-embedding-001', promptTokens: null, outputTokens: null, thoughtsTokens: null }), prices);
    expect(r).toEqual({ amount: null, uncounted: 'embed' });
  });

  it('沒有任何 token 數的呼叫列未計，不查價也不當 0 金額', () => {
    const r = costOfCall(call({ model: 'gemini-flash-latest', outcome: 'transient', promptTokens: null, outputTokens: null, thoughtsTokens: null }), prices);
    expect(r).toEqual({ amount: null, uncounted: 'no-tokens' });
  });
});

describe('parseLlmLog', () => {
  it('壞掉的行報錯並帶行號', () => {
    expect(() => parseLlmLog(`${line({})}\n{oops\n`, 'a/llm.jsonl')).toThrow(/a\/llm\.jsonl 第 2 行/);
  });

  it('缺必要欄位報錯', () => {
    expect(() => parseLlmLog(JSON.stringify({ ts: '2026-10-01T00:00:00Z', kind: 'analyze', model: 'm' }), 'x')).toThrow(/第 1 行 缺 outcome/);
  });

  it('空行略過，meetingId 缺或空字串都是 null', () => {
    const recs = parseLlmLog(`\n${line({ meetingId: null })}\n\n`, 'x');
    expect(recs).toHaveLength(1);
    expect(recs[0].meetingId).toBeNull();
  });
});

describe('命令列', () => {
  it('解析 --shared、--out（空格與等號兩種寫法）', () => {
    expect(parseArgs(['--shared', '/a', '--out=/b'])).toEqual({ shared: '/a', out: '/b', help: false });
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('不認得的參數與缺值報錯', () => {
    expect(() => parseArgs(['--cap', '5'])).toThrow(/不認得/);
    expect(() => parseArgs(['--out'])).toThrow(/要接一個路徑/);
  });

  it('設定檔路徑照平台', () => {
    expect(defaultSettingsPath('darwin', '/Users/v', undefined)).toBe(join('/Users/v', 'Library', 'Application Support', 'MeetPilot', 'desktop-settings.json'));
    expect(() => defaultSettingsPath('win32', 'C:\\Users\\v', undefined)).toThrow(/APPDATA/);
  });
});

describe('檔案輸入輸出', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cost-report-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, content: string): string => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  describe('resolveSharedRoot', () => {
    it('--shared 優先', () => {
      expect(resolveSharedRoot('/x/shared', '/nope/desktop-settings.json')).toBe(resolve('/x/shared'));
    });

    it('沒給 --shared 時取設定檔 vaultDir 的上一層', () => {
      const settings = write('s1/desktop-settings.json', JSON.stringify({ version: 1, vaultDir: '/data/MeetPilot 記錄/妍均' }));
      expect(resolveSharedRoot(undefined, settings)).toBe(dirname(resolve('/data/MeetPilot 記錄/妍均')));
    });

    it('讀不到設定檔報錯並提示 --shared', () => {
      expect(() => resolveSharedRoot(undefined, join(root, 'missing.json'))).toThrow(/--shared/);
    });

    it('設定檔不是 JSON 或沒有 vaultDir 都報錯', () => {
      expect(() => resolveSharedRoot(undefined, write('s2/desktop-settings.json', '{'))).toThrow(/不是合法 JSON/);
      expect(() => resolveSharedRoot(undefined, write('s3/desktop-settings.json', '{"version":1}'))).toThrow(/沒有 vaultDir/);
    });
  });

  describe('assertOutOutsideShared', () => {
    const shared = () => join(root, 'out-check', 'shared');
    beforeAll(() => {
      mkdirSync(shared(), { recursive: true });
    });

    it('在共享資料夾裡面、等於共享資料夾、尚未建立的子資料夾都拒絕', () => {
      expect(() => assertOutOutsideShared(join(shared(), '成本'), shared())).toThrow(/共享資料夾/);
      expect(() => assertOutOutsideShared(shared(), shared())).toThrow(/共享資料夾/);
      expect(() => assertOutOutsideShared(join(shared(), 'a', 'b', 'c'), shared())).toThrow(/共享資料夾/);
    });

    it.skipIf(process.platform === 'win32')('透過 symlink 指進共享資料夾也拒絕', () => {
      const link = join(root, 'out-check', 'link');
      symlinkSync(shared(), link);
      expect(() => assertOutOutsideShared(join(link, 'x'), shared())).toThrow(/共享資料夾/);
    });

    it('旁邊的資料夾、上一層、名字只是前綴相同的資料夾可以', () => {
      expect(() => assertOutOutsideShared(join(root, 'out-check', 'out'), shared())).not.toThrow();
      expect(() => assertOutOutsideShared(join(root, 'out-check'), shared())).not.toThrow();
      expect(() => assertOutOutsideShared(join(root, 'out-check', 'shared-2'), shared())).not.toThrow();
    });
  });

  describe('loadMeetingTitles', () => {
    it('取第一層 .md 的 meetpilot_id 對檔名，跳過 conflict 副本與子資料夾，CRLF 也認得', () => {
      write('titles/2026-10-01 0900 週會.md', '---\nmeetpilot_id: abc-1\n---\n# 週會\n');
      write('titles/2026-10-02 1000 規劃.md', '---\r\nmeetpilot_id: abc-2\r\n---\r\n# 規劃\r\n');
      write('titles/2026-10-01 0900 週會.conflict-1.md', '---\nmeetpilot_id: abc-1\n---\n');
      write('titles/_診斷/info.md', '---\nmeetpilot_id: abc-9\n---\n');
      write('titles/筆記.md', '沒有 frontmatter');
      const titles = loadMeetingTitles(join(root, 'titles'));
      expect([...titles]).toEqual([['abc-1', '2026-10-01 0900 週會'], ['abc-2', '2026-10-02 1000 規劃']]);
    });

    it('同 id 出現在兩個檔報錯', () => {
      write('dup/a.md', '---\nmeetpilot_id: x\n---\n');
      write('dup/b.md', '---\nmeetpilot_id: x\n---\n');
      expect(() => loadMeetingTitles(join(root, 'dup'))).toThrow(/同時出現在兩個檔案/);
    });
  });

  describe('buildCostReport', () => {
    const M1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const M2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const M3 = '33333333-cccc-4ccc-8ccc-cccccccccccc';
    const now = new Date('2026-10-10T00:00:00Z');
    let shared: string;

    beforeAll(() => {
      shared = join(root, 'report', '共享');
      const p = (rel: string, content: string) => {
        mkdirSync(join(shared, rel, '..'), { recursive: true });
        writeFileSync(join(shared, rel), content);
      };
      p('妍均/2026-10-01 0900 週會.md', `---\nmeetpilot_id: ${M1}\n---\n`);
      p('妍均/_診斷/llm.jsonl', [
        // M1：轉錄成功 1M prompt（3.8-flash 單一價 0.75）、output 100k + thoughts 100k（0.75）
        line({ kind: 'transcribe', meetingId: M1, promptTokens: 1_000_000, outputTokens: 100_000, thoughtsTokens: 100_000 }),
        // M1：轉錄失敗但有回傳 token，要算進總額並列在失敗欄（prompt 1M * 0.75）
        line({ kind: 'transcribe', meetingId: M1, outcome: 'transient', promptTokens: 1_000_000, outputTokens: 0, thoughtsTokens: 0 }),
        // M1：失敗在拿到回應前，沒有 token，算失敗次數但未計
        line({ kind: 'transcribe', meetingId: M1, outcome: 'transient', promptTokens: null, outputTokens: null, thoughtsTokens: null, model: 'gemini-flash-latest' }),
        // M1：embed 未計
        line({ kind: 'embed', meetingId: M1, model: 'gemini-embedding-001', promptTokens: null, outputTokens: null, thoughtsTokens: null }),
        // M2：沒有對應的會議記錄，標題退回 meetingId 前 8 碼
        line({ kind: 'analyze', meetingId: M2, promptTokens: 2_000_000, outputTokens: 0, thoughtsTokens: 0, ts: '2026-10-31T23:00:00Z' }),
        // M2：跨月，11 月那一列另算
        line({ kind: 'analyze', meetingId: M2, promptTokens: 1_000_000, outputTokens: 0, thoughtsTokens: 0, ts: '2026-11-01T01:00:00Z' }),
        // 未歸屬
        line({ kind: 'polish', meetingId: null, promptTokens: 1_000_000, outputTokens: 0, thoughtsTokens: 0 }),
        '',
      ].join('\n'));
      p('雪芳/_診斷/llm.jsonl', `${line({ kind: 'link-judge', meetingId: M3, model: 'gemini-3.1-flash-lite', promptTokens: 4_000_000, outputTokens: 0, thoughtsTokens: 0 })}\n`);
      p('阿明/readme.txt', 'x');
    });

    it('分人：每個子資料夾一位，缺 llm.jsonl 的標出來', () => {
      const report = buildCostReport(shared, prices, now);
      expect(report.people.map((x) => [x.name, x.hasLlmLog])).toEqual([['妍均', true], ['阿明', false], ['雪芳', true]]);
    });

    it('失敗呼叫（有 token）算進每場、每人、每月總額，另列失敗欄', () => {
      const report = buildCostReport(shared, prices, now);
      const yan = report.people[0];
      // M1 成功 0.75 + 0.75、失敗 0.75；M2 十月 1.5、十一月 0.75；未歸屬 0.75
      expect(yan.total.cost).toBeCloseTo(0.75 + 0.75 + 0.75 + 1.5 + 0.75 + 0.75, 10);
      expect(yan.total.failedCost).toBeCloseTo(0.75, 10);
      expect(yan.total.failedCalls).toBe(2);
      const m1 = yan.meetings.find((m) => m.meetingId === M1)!;
      expect(m1.bucket.cost).toBeCloseTo(2.25, 10);
      expect(m1.bucket.failedCost).toBeCloseTo(0.75, 10);
      expect(m1.bucket.byKind.get('transcribe')!.failedCalls).toBe(2);
    });

    it('embed 與沒有 token 的呼叫不算進金額，只計次數', () => {
      const yan = buildCostReport(shared, prices, now).people[0];
      expect(yan.embedCalls).toBe(1);
      expect(yan.noTokenCalls).toBe(1);
      const embed = yan.total.byKind.get('embed')!;
      expect(embed).toMatchObject({ cost: 0, calls: 1, uncounted: 1 });
    });

    it('標題從 meetpilot_id 對回檔名；對不到寫前 8 碼；meetingId null 列未歸屬', () => {
      const yan = buildCostReport(shared, prices, now).people[0];
      expect(yan.meetings.map((m) => m.title).sort()).toEqual(['2026-10-01 0900 週會', '22222222', '22222222', '未歸屬'].sort());
    });

    it('分月：跨月的一場分成兩列，逐場加總等於分月', () => {
      const report = buildCostReport(shared, prices, now);
      const yan = report.people[0];
      expect([...yan.months.keys()]).toEqual(['2026-10', '2026-11']);
      expect(yan.months.get('2026-11')!.cost).toBeCloseTo(0.75, 10);
      const rowSum = yan.meetings.reduce((s, m) => s + m.bucket.cost, 0);
      expect(rowSum).toBeCloseTo(yan.total.cost, 10);
      expect(yan.meetings.filter((m) => m.meetingId === M2).map((m) => m.month)).toEqual(['2026-10', '2026-11']);
      expect([...report.months.keys()]).toEqual(['2026-10', '2026-11']);
    });

    it('各人用各自的 kind 與價（雪芳 link-judge 走 3.1-flash-lite）', () => {
      const report = buildCostReport(shared, prices, now);
      expect(report.people[2].total.cost).toBeCloseTo(1.0, 10);
      expect(report.total.cost).toBeCloseTo(report.people[0].total.cost + 1.0, 10);
    });

    it('渲染的總覽含各段標題、失敗欄、未歸屬與未計', () => {
      const md = renderCostReport(buildCostReport(shared, prices, now));
      for (const h of ['## 總計', '## 各步驟分項', '## 分人', '## 分月', '## 分人分月', '## 逐場', '### 妍均', '### 阿明']) expect(md).toContain(h);
      expect(md).toContain('其中失敗重試');
      expect(md).toContain('未歸屬');
      expect(md).toContain('2026-10-01 0900 週會');
      expect(md).toContain('沒有呼叫紀錄');
      expect(md).toContain('embedding 1 次未計');
      expect(md).toContain('1 次呼叫沒有回傳 token 數');
      expect(md).toMatch(/\| embedding \| 未計 \|/);
    });

    it('共享資料夾不存在報錯；紀錄裡有價目表沒有的模型時整份報錯', () => {
      expect(() => buildCostReport(join(root, 'nope'), prices, now)).toThrow(/不存在/);
      const bad = join(root, 'bad');
      mkdirSync(join(bad, 'x', '_診斷'), { recursive: true });
      writeFileSync(join(bad, 'x', '_診斷', 'llm.jsonl'), `${line({ model: 'gemini-9-ultra' })}\n`);
      expect(() => buildCostReport(bad, prices, now)).toThrow(/gemini-9-ultra/);
    });
  });
});

describe('狀態檔分類', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const meeting = (over: Partial<StatusMeeting>): StatusMeeting => ({
    meetingId: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: null,
    status: 'TRANSCRIBING',
    inProgress: true,
    updatedAt: ago(1 * MIN),
    error: null,
    ...over,
  });
  const klass = (m: StatusMeeting, writtenAgo = 10_000): string => classifyMeeting(m, ago(writtenAgo), NOW).klass;

  it('每個狀態 × inProgress 都恰好落一類，沒有漏的', () => {
    for (const status of MEETING_STATUSES) {
      for (const inProgress of [true, false]) {
        for (const [updatedAgo, writtenAgo] of [[MIN, 10_000], [31 * MIN, 10_000], [MIN, 11 * MIN], [4 * HOUR, 11 * MIN]]) {
          const result = classifyMeeting(meeting({ status, inProgress, updatedAt: ago(updatedAgo) }), ago(writtenAgo), NOW);
          expect(STATUS_CLASSES.filter((k) => k === result.klass), `${status} inProgress=${inProgress}`).toHaveLength(1);
        }
      }
    }
  });

  it('inProgress 沒超時列處理中', () => {
    expect(klass(meeting({}))).toBe('處理中');
    expect(klass(meeting({ updatedAt: ago(30 * MIN) }))).toBe('處理中');
  });

  it('inProgress 且 updatedAt 超過 30 分鐘是卡住，寫卡多久', () => {
    const r = classifyMeeting(meeting({ updatedAt: ago(45 * MIN) }), ago(10_000), NOW);
    expect(r.klass).toBe('卡住');
    expect(r.ageMs).toBe(45 * MIN);
    expect(r.reasons).toEqual(['狀態 45 分鐘沒有變化']);
  });

  it('inProgress 且 writtenAt 超過 10 分鐘（app 沒在跑）是卡住，即使 updatedAt 很新', () => {
    expect(klass(meeting({ updatedAt: ago(2 * MIN) }), 10 * MIN)).toBe('處理中');
    const r = classifyMeeting(meeting({ updatedAt: ago(2 * MIN) }), ago(15 * MIN), NOW);
    expect(r.klass).toBe('卡住');
    expect(r.reasons[0]).toContain('app 已 15 分鐘');
  });

  it('RECORDING 三小時內是錄音中，超過改列需要處理並寫已過多久', () => {
    expect(klass(meeting({ status: 'RECORDING', inProgress: false, updatedAt: ago(3 * HOUR) }))).toBe('錄音中');
    const r = classifyMeeting(meeting({ status: 'RECORDING', inProgress: false, updatedAt: ago(3 * HOUR + MIN) }), ago(10_000), NOW);
    expect(r.klass).toBe('需要處理');
    expect(r.reasons).toEqual(['錄音狀態已過 3 小時 1 分']);
  });

  it('錄音中不看 writtenAt（錄音不算 inProgress）', () => {
    expect(klass(meeting({ status: 'RECORDING', inProgress: false }), 20 * MIN)).toBe('錄音中');
  });

  it('inProgress 為 false 的其餘會議都是需要處理，含停在處理狀態卻沒有 job 的', () => {
    for (const status of ['CREATED', 'FAILED', 'LINK_FAILED', 'TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING'] as const) {
      const r = classifyMeeting(meeting({ status, inProgress: false, error: status === 'FAILED' ? 'boom' : null }), ago(10_000), NOW);
      expect(r.klass, status).toBe('需要處理');
      expect(r.reasons[0]).toContain(status);
    }
  });

  it('formatDuration', () => {
    expect(formatDuration(20_000)).toBe('不到 1 分鐘');
    expect(formatDuration(59 * MIN)).toBe('59 分鐘');
    expect(formatDuration(5 * HOUR + 7 * MIN)).toBe('5 小時 7 分');
    expect(formatDuration(50 * HOUR)).toBe('2 天 2 小時');
  });
});

describe('parseStatusFile', () => {
  const good = {
    schema: 1,
    writtenAt: '2026-10-10T12:00:00.000Z',
    meetings: [{ meetingId: 'a', title: null, status: 'FAILED', inProgress: false, updatedAt: '2026-10-10T11:00:00.000Z', error: 'x' }],
  };

  it('讀得進符合契約的檔', () => {
    expect(parseStatusFile(JSON.stringify(good), 's').meetings[0]).toMatchObject({ meetingId: 'a', status: 'FAILED', error: 'x' });
  });

  it('schema 不是 1、不認得的 status、欄位型別不對、壞 JSON 都報錯', () => {
    expect(() => parseStatusFile(JSON.stringify({ ...good, schema: 2 }), 's')).toThrow(/schema/);
    expect(() => parseStatusFile('{', 's')).toThrow(/不是合法 JSON/);
    expect(() => parseStatusFile(JSON.stringify({ ...good, meetings: [{ ...good.meetings[0], status: 'DONE' }] }), 's')).toThrow(/status/);
    expect(() => parseStatusFile(JSON.stringify({ ...good, meetings: [{ ...good.meetings[0], inProgress: 'yes' }] }), 's')).toThrow(/inProgress/);
    expect(() => parseStatusFile(JSON.stringify({ ...good, writtenAt: 'x' }), 's')).toThrow(/writtenAt/);
    expect(() => parseStatusFile(JSON.stringify({ ...good, meetings: [{ ...good.meetings[0], updatedAt: 3 }] }), 's')).toThrow(/updatedAt/);
  });
});

describe('總覽列出卡住的會議', () => {
  let root: string;
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cost-report-status-'));
    const w = (rel: string, content: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    w('妍均/2026-10-10 0900 週會.md', '---\nmeetpilot_id: m-stuck\n---\n');
    w('妍均/_狀態.json', JSON.stringify({
      schema: 1,
      writtenAt: '2026-10-10T11:59:30.000Z',
      meetings: [
        { meetingId: 'm-stuck', title: '不會用到', status: 'ANALYZING', inProgress: true, updatedAt: '2026-10-10T10:00:00.000Z', error: null },
        { meetingId: 'm-run', title: '正在跑', status: 'TRANSCRIBING', inProgress: true, updatedAt: '2026-10-10T11:58:00.000Z', error: null },
        { meetingId: 'm-fail', title: '失敗的會', status: 'FAILED', inProgress: false, updatedAt: '2026-10-09T10:00:00.000Z', error: '轉錄失敗：quota' },
        { meetingId: 'm-rec', title: null, status: 'RECORDING', inProgress: false, updatedAt: '2026-10-10T11:00:00.000Z', error: null },
      ],
    }));
    w('雪芳/_診斷/llm.jsonl', '');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('每場落進一類，標題優先用會議記錄檔名', () => {
    const report = buildCostReport(root, prices, NOW);
    const items = report.people[0].status!.items;
    expect(items.map((i) => [i.meeting.title, i.klass])).toEqual([
      ['2026-10-10 0900 週會', '卡住'],
      ['正在跑', '處理中'],
      ['失敗的會', '需要處理'],
      ['m-rec', '錄音中'],
    ]);
    expect(items[0].ageMs).toBe(2 * 60 * 60_000);
  });

  it('沒有 _狀態.json 的記錄人列出「沒有狀態檔」，不當成沒事', () => {
    const report = buildCostReport(root, prices, NOW);
    expect(report.people[1].status).toBeNull();
    const md = renderCostReport(report);
    expect(md).toContain('### 雪芳\n\n沒有狀態檔');
  });

  it('渲染卡住、卡多久、需要處理的狀態與 error', () => {
    const md = renderCostReport(buildCostReport(root, prices, NOW));
    expect(md).toContain('卡住 1 場、需要處理 1 場、處理中 1 場、錄音中 1 場');
    expect(md).toContain('#### 卡住');
    expect(md).toMatch(/\| 2026-10-10 0900 週會 \| ANALYZING \| 2 小時 0 分 \| 狀態 2 小時 0 分沒有變化 \|/);
    expect(md).toContain('error：轉錄失敗：quota');
    expect(md).toContain('狀態檔寫於 2026-10-10T11:59:30.000Z');
  });
});

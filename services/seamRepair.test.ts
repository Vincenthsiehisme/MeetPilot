import { describe, it, expect } from 'vitest';
import { repairSeamGap, resolveSeamRepairConfig, BRIDGE_WINDOWS_SECONDS, DEFAULT_SEAM_REPAIR } from './seamRepair';
import { TranscriptSegment } from '../types';

const seg = (start: number, end: number, text: string): TranscriptSegment =>
  ({ start, end, text, speaker: 'Speaker 1' });

// fixture 照真實模型輸出的形狀編，不是真的逐字稿：同一段話轉兩次會有用字出入。
// 不要用「600s 開始的內容」那種公式化字串，相鄰段落天生就像，測不到行為
const TAIL_A = '那我們先把排程的部分做個結論,之後每一組自己排自己的批次。';
const TAIL_B = '那我們先把排程的部分做個結論,以後每一組就自己排自己的批次。';
const MISSING_1 = '至於權限要怎麼開,資訊部說要走正式的申請單,這件事我下週跟他們確認。';
const MISSING_2 = '另外測試環境的資料要先做遮罩,不然稽核那邊一定會有意見。';
const HEAD_A = '那倉儲那邊呢,棧板的數量從上個月開始就一直不夠用。';
const HEAD_B = '那倉儲那邊呢,棧板數量從上個月開始就一直不夠用。';

const SEAM = 1800;
const EXISTING = [seg(1760, 1770, '先講第一件事情,關於這季的排程調整。'), seg(1770, 1780, TAIL_A)];
const INCOMING = [
  seg(1800, 1808, HEAD_A),
  seg(1808, 1815, '採購說最快也要月底才補得到貨。'),
  seg(1816, 1825, '那中間這段時間就只能先調度。'),
];

/** 兩端都錨得住的橋接：開頭是既有尾巴的重轉，中間是缺的內容，結尾是後一片開頭的重轉 */
const goodBridge = (start: number): TranscriptSegment[] => [
  seg(start, start + 8, TAIL_B),
  seg(start + 10, start + 20, MISSING_1),
  seg(start + 22, start + 32, MISSING_2),
  seg(SEAM, SEAM + 8, HEAD_B),
];

/** 左端錨不住的橋接：開頭直接是缺的內容，接不回既有逐字稿 */
const leftUnanchoredBridge = (start: number): TranscriptSegment[] => [
  seg(start, start + 10, MISSING_1),
  seg(start + 12, start + 22, MISSING_2),
  seg(SEAM, SEAM + 8, HEAD_B),
];

/** 左端錨得住、右端錨不住：橋接自己也被截斷了，沒轉到後一片的開頭 */
const rightUnanchoredBridge = (start: number): TranscriptSegment[] => [
  seg(start, start + 8, TAIL_B),
  seg(start + 10, start + 20, MISSING_1),
];

const deps = (fn: (start: number, duration: number) => TranscriptSegment[], total = 3900) => {
  const calls: { start: number; duration: number }[] = [];
  return {
    calls,
    deps: {
      totalDurationSeconds: total,
      transcribeWindow: async (start: number, duration: number) => {
        calls.push({ start, duration });
        return fn(start, duration);
      },
    },
  };
};

describe('repairSeamGap', () => {
  it('兩端都錨得住時補回缺的內容，而且不留重複', async () => {
    const { deps: d, calls } = deps(start => goodBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d);

    expect(result.outcome).toBe('repaired');
    expect(result.attempts).toBe(1);
    expect(calls[0].start).toBe(SEAM - BRIDGE_WINDOWS_SECONDS[0]);

    const texts = result.segments.map(s => s.text);
    // 缺的兩段補回來了
    expect(texts).toContain(MISSING_1);
    expect(texts).toContain(MISSING_2);
    // 既有內容一段都沒少
    expect(texts).toContain(TAIL_A);
    // 橋接開頭那段是既有尾巴的重轉，不能兩份都留
    expect(texts).not.toContain(TAIL_B);
    // 後一片的內容還在，而且開頭那段沒有因為橋接也轉過就變成兩份
    expect(texts.filter(t => t === HEAD_A || t === HEAD_B)).toHaveLength(1);
    expect(texts).toContain('那中間這段時間就只能先調度。');
  });

  it('第一個窗錨不住時放大重試，用得上的那個窗才算數', async () => {
    const { deps: d, calls } = deps(start =>
      (SEAM - start >= BRIDGE_WINDOWS_SECONDS[1] ? goodBridge(start) : leftUnanchoredBridge(start)));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d);

    expect(result.outcome).toBe('repaired');
    expect(result.attempts).toBe(2);
    expect(calls.map(c => c.start)).toEqual([
      SEAM - BRIDGE_WINDOWS_SECONDS[0],
      SEAM - BRIDGE_WINDOWS_SECONDS[1],
    ]);
  });

  it('每個窗都錨不住時記成 failed，而且逐字稿一段都不少', async () => {
    const { deps: d, calls } = deps(start => leftUnanchoredBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d);

    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(BRIDGE_WINDOWS_SECONDS.length);
    expect(calls).toHaveLength(BRIDGE_WINDOWS_SECONDS.length);
    // 補不回來就維持不修的結果，不是把半成品塞進去
    expect(result.segments).toEqual([...EXISTING, ...INCOMING]);
  });

  it('左端接得上但右端接不上時不算修好：橋接自己也被截斷了', async () => {
    const { deps: d, calls } = deps(start => rightUnanchoredBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d);

    expect(result.outcome).toBe('failed');
    expect(calls).toHaveLength(BRIDGE_WINDOWS_SECONDS.length);
    // 半截的橋接不能塞進去：它補不到後一片的開頭，中間還是斷的
    expect(result.segments).toEqual([...EXISTING, ...INCOMING]);
    expect(result.segments.map(s => s.text)).not.toContain(MISSING_1);
  });

  it('關掉時一次都不送，記成 skipped', async () => {
    const { deps: d, calls } = deps(start => goodBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d, { enabled: false });

    expect(result.outcome).toBe('skipped');
    expect(result.attempts).toBe(0);
    expect(calls).toHaveLength(0);
    expect(result.segments).toEqual([...EXISTING, ...INCOMING]);
  });

  it('額度用完就不送：一場破洞很多的會不能把每日額度燒光', async () => {
    const { deps: d, calls } = deps(start => leftUnanchoredBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d, { budget: 1 });

    expect(calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.outcome).toBe('failed');
  });

  it('額度是 0 時連第一次都不送', async () => {
    const { deps: d, calls } = deps(start => goodBridge(start));
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d, { budget: 0 });
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('窗夾在檔案範圍內：接縫靠近檔頭時不會送出負的起點', async () => {
    const { deps: d, calls } = deps(start => goodBridge(start));
    await repairSeamGap(EXISTING, INCOMING, 60, d);
    expect(calls.every(c => c.start >= 0)).toBe(true);
  });

  it('橋接回空陣列時不當成修好了', async () => {
    const { deps: d } = deps(() => []);
    const result = await repairSeamGap(EXISTING, INCOMING, SEAM, d);
    expect(result.outcome).toBe('failed');
    expect(result.segments).toEqual([...EXISTING, ...INCOMING]);
  });

  it('既有逐字稿是空的時候不修：沒有東西可以當左錨點', async () => {
    const { deps: d, calls } = deps(start => goodBridge(start));
    const result = await repairSeamGap([], INCOMING, SEAM, d);
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});

describe('resolveSeamRepairConfig', () => {
  it('沒設就是開啟、預設額度', () => {
    expect(resolveSeamRepairConfig({})).toEqual(DEFAULT_SEAM_REPAIR);
  });

  it('off 關閉，大小寫與前後空白不算', () => {
    expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR: '  OFF ' }).enabled).toBe(false);
  });

  it('其他值一律當開啟：只認一個關閉字面值，免得打錯字變成安靜關掉', () => {
    expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR: 'on' }).enabled).toBe(true);
    expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR: 'false' }).enabled).toBe(true);
  });

  it('額度改得動，0 也收', () => {
    expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR_BUDGET: '2' }).budget).toBe(2);
    expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR_BUDGET: '0' }).budget).toBe(0);
  });

  it.each(['六', '-1', '2.5', '2e1', '0x2', ''])('額度是 %s 這種值時拋錯，不靜靜用預設', (raw) => {
    if (raw === '') {
      // 空字串當成沒設，這是既有環境變數的一致行為
      expect(resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR_BUDGET: raw }).budget).toBe(DEFAULT_SEAM_REPAIR.budget);
      return;
    }
    expect(() => resolveSeamRepairConfig({ MEETPILOT_SEAM_REPAIR_BUDGET: raw })).toThrow(/非負整數/);
  });
});

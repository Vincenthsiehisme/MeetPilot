import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { downloadBlob, exportJobAsJSON, exportSummaryAsMarkdown, exportSummaryAsText } from './exportUtils';
import { AnalysisV3 } from './analysisContract';
import { Job, JobStatus } from '../types';

// 這個檔只測 downloadBlob 的兩個時序，那兩件事都是「失敗時沒有任何錯誤訊息」的那種壞法：
// detached anchor 在部分 Firefox 版本按了沒反應，同步 revoke 在 Safari 會下載到空檔。
// 本機音檔只剩瀏覽器那一份時，這條是它唯一的出口，錯了就是資料真的沒了。

type FakeAnchor = {
  href: string;
  download: string;
  style: { display: string };
  click: () => void;
};

const makeDom = () => {
  const events: string[] = [];
  let anchor: FakeAnchor | null = null;

  const document = {
    createElement: (tag: string) => {
      const el: FakeAnchor = {
        href: '',
        download: '',
        style: { display: '' },
        click: () => { events.push('click'); }
      };
      if (tag === 'a') anchor = el;
      return el;
    },
    body: {
      appendChild: () => { events.push('appendChild'); },
      removeChild: () => { events.push('removeChild'); }
    }
  };

  return { document, events, getAnchor: () => anchor };
};

describe('downloadBlob 的下載時序', () => {
  let dom: ReturnType<typeof makeDom>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = makeDom();
    createObjectURL = vi.fn(() => 'blob:fake-url');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('anchor 先掛進 DOM 才 click，click 完才移除', () => {
    downloadBlob(new Blob(['x']), '週會.m4a');

    // 沒進過文件樹的 anchor，click() 在部分 Firefox 版本不會觸發下載，而且不報錯
    expect(dom.events).toEqual(['appendChild', 'click', 'removeChild']);
  });

  it('檔名與 blob URL 有掛上去', () => {
    const blob = new Blob(['x']);
    downloadBlob(blob, '週會.m4a');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(dom.getAnchor()!.href).toBe('blob:fake-url');
    expect(dom.getAnchor()!.download).toBe('週會.m4a');
  });

  it('revoke 不在同一個 tick，要等計時器到了才收', () => {
    downloadBlob(new Blob(['x']), '週會.m4a');

    // 瀏覽器是非同步去讀這個 URL 的，同步 revoke 會跟下載啟動搶時間
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

// exportSummaryAsMarkdown／exportSummaryAsText 沒有標題時要退回原始檔名，不能顯示固定的
// 「會議記錄」（2026-09-20 Codex review 抓到：畫面、列印都已經退回檔名，這兩支匯出漏了）；
// 空的討論題目也要顯式寫「本場沒有討論題目」，不能讓 join 出一個空字串留一段空白
describe('exportSummaryAsMarkdown／exportSummaryAsText 的標題與空題目', () => {
  let dom: ReturnType<typeof makeDom>;

  const analysis: AnalysisV3 = {
    contract_version: 3,
    overview: '主旨',
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dom = makeDom();
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake-url'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // 每次呼叫後讀最新一次的 blob，不是固定 index 0：同一個測試裡呼叫兩次匯出函式，
  // mock.calls 會累積兩筆，只讀 [0] 會一直讀到第一次那份，讓第二個斷言其實沒測到東西
  const lastBlob = (): Blob => {
    const calls = (globalThis.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][0];
  };

  it('Markdown：有標題用標題，沒有退回檔名', async () => {
    exportSummaryAsMarkdown({ title: '週會', fileName: 'a.m4a' }, analysis);
    expect(await lastBlob().text()).toContain('# 週會');

    exportSummaryAsMarkdown({ fileName: 'a.m4a' }, analysis);
    expect(await lastBlob().text()).toContain('# a.m4a');
  });

  it('Text：有標題用標題，沒有退回檔名', async () => {
    exportSummaryAsText({ title: '週會', fileName: 'a.m4a' }, analysis);
    const withTitle = await lastBlob().text();
    expect(withTitle.startsWith('週會\n')).toBe(true);
    expect(withTitle).toContain('來源檔名：a.m4a');

    exportSummaryAsText({ fileName: 'a.m4a' }, analysis);
    const withoutTitle = await lastBlob().text();
    expect(withoutTitle.startsWith('a.m4a\n')).toBe(true);
  });

  it('有要點時 Markdown 用行內程式碼當時間標籤、Text 用括號；舊資料沒有要點只印 content（SDD v0.9）', async () => {
    const withPoints: AnalysisV3 = {
      ...analysis,
      topics: [
        { title: '報價', content: '已對齊', points: [{ text: 'A 廠每套 1,200 元', evidence: { start: 65, end: 70 } }, { text: '沒出處', evidence: null }] },
        { title: '舊的', content: '整段舊內容' },
      ],
    };
    exportSummaryAsMarkdown({ fileName: 'a.m4a' }, withPoints);
    const md = await lastBlob().text();
    expect(md).toContain('### 報價\n已對齊\n- A 廠每套 1,200 元 `01:05–01:10`\n- 沒出處');
    expect(md).toContain('### 舊的\n整段舊內容');

    exportSummaryAsText({ fileName: 'a.m4a' }, withPoints);
    const txt = await lastBlob().text();
    expect(txt).toContain('【報價】\n已對齊\n・A 廠每套 1,200 元（01:05–01:10）\n・沒出處');
    expect(txt).toContain('【舊的】\n整段舊內容');
  });

  it('Text：沒有討論題目時顯式寫「本場沒有討論題目」，不是空白', async () => {
    exportSummaryAsText({ fileName: 'a.m4a' }, analysis);
    expect(await lastBlob().text()).toContain('(本場沒有討論題目)');
  });
});

// exportJobAsJSON 的完整備份要看得到標題：檔名已經改用標題（jobDownloadBaseName），
// 內文卻沒有帶 title 欄位的話，使用者改過標題再下載備份，檔案內容完全看不出叫什麼名字
describe('exportJobAsJSON 的 title 欄位', () => {
  let dom: ReturnType<typeof makeDom>;

  const baseJob: Job = {
    id: 'job-1',
    fileName: 'a.m4a',
    fileSize: 1024,
    createdAt: 0,
    updatedAt: 0,
    status: JobStatus.COMPLETED,
    currentStep: 0,
    steps: [],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dom = makeDom();
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake-url'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const lastBlob = (): Blob => {
    const calls = (globalThis.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][0];
  };

  it('有標題時 JSON 內文帶 title，不是只有檔名反映在檔案名稱上', async () => {
    exportJobAsJSON({ ...baseJob, title: '週會' });
    const parsed = JSON.parse(await lastBlob().text());
    expect(parsed.title).toBe('週會');
  });

  it('沒有標題時 title 是 null，不是整個欄位消失', async () => {
    exportJobAsJSON(baseJob);
    const parsed = JSON.parse(await lastBlob().text());
    expect(parsed.title).toBeNull();
  });
});

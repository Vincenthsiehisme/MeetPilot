import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { downloadBlob } from './exportUtils';

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

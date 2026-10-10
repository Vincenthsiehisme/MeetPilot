import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ParticipantPicker from './ParticipantPicker';

describe('ParticipantPicker 名單載入狀態', () => {
  const render = (loadError: string | null) => renderToStaticMarkup(
    <ParticipantPicker
      isOpen
      people={null}
      loadError={loadError}
      onRetry={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  it('載入失敗時顯示錯誤與重試入口，不會永遠顯示讀取中', () => {
    const html = render('HTTP 500');
    expect(html).toContain('名單讀取失敗');
    expect(html).toContain('重新讀取');
    expect(html).not.toContain('讀取名單中');
  });
});

describe('ParticipantPicker 背景補充欄位', () => {
  it('確認畫面有選填的背景補充輸入框，開啟時是空的', () => {
    const html = renderToStaticMarkup(
      <ParticipantPicker
        isOpen
        people={[]}
        loadError={null}
        onRetry={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        confirmVerb="開始錄音"
      />,
    );
    expect(html).toContain('背景補充（選填）');
    expect(html).toMatch(/<textarea[^>]*id="meeting-context"[^>]*><\/textarea>/);
  });
});

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

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import NameReviewPanel from './NameReviewPanel';

describe('NameReviewPanel 段落層級確認', () => {
  it('同一個名字在不同段落各自顯示完整語境', () => {
    const html = renderToStaticMarkup(
      <NameReviewPanel
        participants={[
          { employeeId: 'p-1', displayName: '陳雅婷', title: null, department: null },
          { employeeId: 'p-2', displayName: '林雅婷', title: null, department: null },
        ]}
        nameMentions={[
          {
            segment_index: 2,
            segment_text: 'Tina 說採購預算已核准',
            original_text: 'Tina',
            employee_id: null,
            method: 'conflict_review',
          },
          {
            segment_index: 7,
            segment_text: 'Tina 接著說行銷素材明天交付',
            original_text: 'Tina',
            employee_id: null,
            method: 'conflict_review',
          },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    expect(html).toContain('Tina 說採購預算已核准');
    expect(html).toContain('Tina 接著說行銷素材明天交付');
  });
});

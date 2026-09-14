import { describe, it, expect } from 'vitest';
import { GeminiOutput } from '../types';
import { isAnalysisSemanticallyEmpty, upgradeAnalysisToV2 } from './analysisContract';

const v1: GeminiOutput = {
  overview: '討論供應商報價',
  topics: [{ title: '付款條件', content: '從 30 天改成 60 天' }],
  decisions: ['採用 B 方案'],
  action_items: ['整理報價比較表', '約下週會議'],
};

describe('upgradeAnalysisToV2', () => {
  it('舊的字串待辦轉成物件，status 一律 unknown（D-004）', () => {
    const v2 = upgradeAnalysisToV2(v1, 'm-1', 1_700_000_000_000);
    expect(v2.action_items).toEqual([
      { text: '整理報價比較表', source_meeting_id: 'm-1', created_at: 1_700_000_000_000, status: 'unknown' },
      { text: '約下週會議', source_meeting_id: 'm-1', created_at: 1_700_000_000_000, status: 'unknown' },
    ]);
  });

  it('不補成 open 或 done', () => {
    const v2 = upgradeAnalysisToV2(v1, 'm-1', 1);
    expect(v2.action_items.every(a => a.status === 'unknown')).toBe(true);
  });

  it('assignee 不存在，不塞空字串頂替（U-007 未關閉）', () => {
    const v2 = upgradeAnalysisToV2(v1, 'm-1', 1);
    expect('assignee' in v2.action_items[0]).toBe(false);
  });

  it('其餘三個欄位原樣帶過去，並標上 contract_version', () => {
    const v2 = upgradeAnalysisToV2(v1, 'm-1', 1);
    expect(v2.contract_version).toBe(2);
    expect(v2.overview).toBe('討論供應商報價');
    expect(v2.topics).toEqual(v1.topics);
    expect(v2.decisions).toEqual(v1.decisions);
  });

  it('同一份輸入轉兩次結果相同，沒有 Date.now() 之類的隱含輸入', () => {
    expect(upgradeAnalysisToV2(v1, 'm-1', 5)).toEqual(upgradeAnalysisToV2(v1, 'm-1', 5));
  });

  it('沒有待辦時是空陣列，不是 undefined', () => {
    const v2 = upgradeAnalysisToV2({ ...v1, action_items: [] }, 'm-1', 1);
    expect(v2.action_items).toEqual([]);
  });
});

describe('isAnalysisSemanticallyEmpty', () => {
  it('四個欄位全空是語意空', () => {
    expect(isAnalysisSemanticallyEmpty({ overview: '', topics: [], decisions: [], action_items: [] })).toBe(true);
  });

  it('overview 只有空白也算空', () => {
    expect(isAnalysisSemanticallyEmpty({ overview: '   ', topics: [], decisions: [], action_items: [] })).toBe(true);
  });

  it('任一欄位有東西就不算空', () => {
    expect(isAnalysisSemanticallyEmpty({ overview: '', topics: [], decisions: ['x'], action_items: [] })).toBe(false);
    expect(isAnalysisSemanticallyEmpty(v1)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { GeminiOutput, TranscriptSegment } from '../types';
import {
  AnalysisModelOutput,
  AnalysisV2,
  AnalysisV3,
  assertAnalysisModelOutput,
  buildAnalysisV3FromModelOutput,
  isAnalysisSemanticallyEmpty,
  isAnalysisV3SemanticallyEmpty,
  upgradeAnalysisToV2,
  upgradeAnalysisV2ToV3,
} from './analysisContract';

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

const v2WithMetadata: AnalysisV2 = {
  contract_version: 2,
  overview: '討論供應商報價',
  topics: [{ title: '付款條件', content: '從 30 天改成 60 天' }],
  decisions: ['採用 B 方案'],
  action_items: [
    { text: '整理報價比較表', source_meeting_id: 'm-1', created_at: 1, status: 'unknown' },
    { text: '約下週會議', source_meeting_id: 'm-1', created_at: 1, status: 'open', assignee: '小美' },
  ],
};

describe('upgradeAnalysisV2ToV3', () => {
  it('decisions 的字串升成物件，evidence／decided_by 一律 null', () => {
    const v3 = upgradeAnalysisV2ToV3(v2WithMetadata);
    expect(v3.decisions).toEqual([{ text: '採用 B 方案', evidence: null, decided_by: null }]);
  });

  it('action_items 原有 metadata 保留，補上 due／evidence 為 null；assignee 缺的補 null 不留 undefined', () => {
    const v3 = upgradeAnalysisV2ToV3(v2WithMetadata);
    expect(v3.action_items).toEqual([
      { text: '整理報價比較表', source_meeting_id: 'm-1', created_at: 1, status: 'unknown', assignee: null, due: null, evidence: null },
      { text: '約下週會議', source_meeting_id: 'm-1', created_at: 1, status: 'open', assignee: '小美', due: null, evidence: null },
    ]);
  });

  it('open_questions 一律空陣列：v2 沒有這個概念，不是「沒抽到」', () => {
    expect(upgradeAnalysisV2ToV3(v2WithMetadata).open_questions).toEqual([]);
  });

  it('contract_version 標成 3，overview／topics 原樣帶過去', () => {
    const v3 = upgradeAnalysisV2ToV3(v2WithMetadata);
    expect(v3.contract_version).toBe(3);
    expect(v3.overview).toBe(v2WithMetadata.overview);
    expect(v3.topics).toEqual(v2WithMetadata.topics);
  });

  it('純函式：同一份輸入轉兩次結果相同', () => {
    expect(upgradeAnalysisV2ToV3(v2WithMetadata)).toEqual(upgradeAnalysisV2ToV3(v2WithMetadata));
  });
});

describe('isAnalysisV3SemanticallyEmpty', () => {
  const empty: AnalysisV3 = { contract_version: 3, overview: '', topics: [], decisions: [], action_items: [], open_questions: [] };

  it('五個欄位全空是語意空', () => {
    expect(isAnalysisV3SemanticallyEmpty(empty)).toBe(true);
  });

  it('只有 open_questions 有內容就不算空：一場會只吵出問題、沒有定案是合法結果', () => {
    expect(isAnalysisV3SemanticallyEmpty({
      ...empty, open_questions: [{ text: '要不要外包', evidence: null }],
    })).toBe(false);
  });
});

const seg = (start: number, end: number, text = 'x'): TranscriptSegment => ({ start, end, text });
const transcript: TranscriptSegment[] = [seg(0, 10, '第一段'), seg(10, 20, '第二段'), seg(20, 30, '第三段')];

describe('buildAnalysisV3FromModelOutput', () => {
  const baseOutput: AnalysisModelOutput = {
    title: '標題',
    overview: '主旨',
    topics: [{ title: 'T', content: 'C' }],
    decisions: [{ text: '決議', segment_from: 1, segment_to: 2, decided_by: '小美' }],
    action_items: [{ text: '待辦', segment_from: 2, segment_to: 2, assignee: null, due: '下週三' }],
    open_questions: [{ text: '未決', segment_from: 3, segment_to: 3 }],
  };

  it('段落編號換算成逐字稿的秒數區間（1-based，segment_from 取 start、segment_to 取 end）', () => {
    const v3 = buildAnalysisV3FromModelOutput(baseOutput, transcript, 'm-1', 999);
    expect(v3.decisions[0].evidence).toEqual({ start: 0, end: 20 });
    expect(v3.action_items[0].evidence).toEqual({ start: 10, end: 20 });
    expect(v3.open_questions[0].evidence).toEqual({ start: 20, end: 30 });
  });

  it('action_items 補上 source_meeting_id／created_at／status，status 一律 unknown（同 D-004）', () => {
    const v3 = buildAnalysisV3FromModelOutput(baseOutput, transcript, 'm-1', 999);
    expect(v3.action_items[0]).toMatchObject({
      text: '待辦', source_meeting_id: 'm-1', created_at: 999, status: 'unknown', assignee: null, due: '下週三',
    });
  });

  it('contract_version 標成 3，overview／topics 原樣帶過去', () => {
    const v3 = buildAnalysisV3FromModelOutput(baseOutput, transcript, 'm-1', 999);
    expect(v3.contract_version).toBe(3);
    expect(v3.overview).toBe('主旨');
    expect(v3.topics).toEqual(baseOutput.topics);
  });

  it('segment_from／segment_to 超出逐字稿範圍時拋錯，帶明細不裁切', () => {
    const bad: AnalysisModelOutput = { ...baseOutput, decisions: [{ text: 'x', segment_from: 1, segment_to: 99, decided_by: null }] };
    expect(() => buildAnalysisV3FromModelOutput(bad, transcript, 'm-1', 999))
      .toThrow(/超出逐字稿範圍（共 3 段）/);
  });

  it('segment_from 大於 segment_to 時拋錯', () => {
    const bad: AnalysisModelOutput = { ...baseOutput, action_items: [{ text: 'x', segment_from: 3, segment_to: 1, assignee: null, due: null }] };
    expect(() => buildAnalysisV3FromModelOutput(bad, transcript, 'm-1', 999))
      .toThrow(/segment_from（3）大於 segment_to（1）/);
  });

  it('segment_from／segment_to 為 0 或負數時拋錯（1-based，0 不合法）', () => {
    const bad: AnalysisModelOutput = { ...baseOutput, open_questions: [{ text: 'x', segment_from: 0, segment_to: 1 }] };
    expect(() => buildAnalysisV3FromModelOutput(bad, transcript, 'm-1', 999)).toThrow(/超出逐字稿範圍/);
  });

  it('純函式：同一份輸入與逐字稿轉兩次結果相同（migration rehearsal 的逐筆比對靠這個）', () => {
    const a = buildAnalysisV3FromModelOutput(baseOutput, transcript, 'm-1', 999);
    const b = buildAnalysisV3FromModelOutput(baseOutput, transcript, 'm-1', 999);
    expect(a).toEqual(b);
  });
});

describe('assertAnalysisModelOutput', () => {
  const valid: AnalysisModelOutput = {
    title: '標題',
    overview: 'x',
    topics: [{ title: 'T', content: 'C' }],
    decisions: [{ text: 'd', segment_from: 1, segment_to: 1, decided_by: null }],
    action_items: [{ text: 'a', segment_from: 1, segment_to: 1, assignee: null, due: null }],
    open_questions: [{ text: 'q', segment_from: 1, segment_to: 1 }],
  };

  it('形狀正確時不拋錯', () => {
    expect(() => assertAnalysisModelOutput(valid)).not.toThrow();
  });

  it('不是物件時拋錯', () => {
    expect(() => assertAnalysisModelOutput('不是物件')).toThrow(/不是物件/);
  });

  it('overview 不是字串時拋錯', () => {
    expect(() => assertAnalysisModelOutput({ ...valid, overview: 123 })).toThrow(/overview/);
  });

  it('缺 title 或 title 不是字串時拋錯', () => {
    expect(() => assertAnalysisModelOutput({ ...valid, title: undefined })).toThrow(/title/);
    expect(() => assertAnalysisModelOutput({ ...valid, title: 42 })).toThrow(/title/);
  });

  it('decisions 缺 decided_by 或型別不對時拋錯', () => {
    expect(() => assertAnalysisModelOutput({
      ...valid, decisions: [{ text: 'd', segment_from: 1, segment_to: 1, decided_by: 42 }],
    })).toThrow(/decisions/);
  });

  it('action_items 的 assignee／due 不是字串或 null 時拋錯', () => {
    expect(() => assertAnalysisModelOutput({
      ...valid, action_items: [{ text: 'a', segment_from: 1, segment_to: 1, assignee: 42, due: null }],
    })).toThrow(/action_items/);
  });

  it('open_questions 不是陣列時拋錯', () => {
    expect(() => assertAnalysisModelOutput({ ...valid, open_questions: '不是陣列' })).toThrow(/open_questions/);
  });
});

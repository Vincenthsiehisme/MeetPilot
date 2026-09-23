import { describe, it, expect } from 'vitest';
import { MEETING_STATUSES, assertTransition, canTransition, isMeetingStatus, legalNextStates } from './meetingState';

describe('canTransition', () => {
  it('照 SDD 1.4 的主線放行', () => {
    expect(canTransition('CREATED', 'TRANSCRIBING')).toBe(true);
    expect(canTransition('TRANSCRIBING', 'TRANSCRIBED')).toBe(true);
    expect(canTransition('TRANSCRIBED', 'ANALYZING')).toBe(true);
    expect(canTransition('ANALYZING', 'READY')).toBe(true);
    expect(canTransition('READY', 'LINKING')).toBe(true);
    expect(canTransition('LINKING', 'LINKED')).toBe(true);
    expect(canTransition('LINKING', 'LINK_FAILED')).toBe(true);
  });

  it('跳關被拒絕', () => {
    expect(canTransition('CREATED', 'READY')).toBe(false);
    expect(canTransition('CREATED', 'ANALYZING')).toBe(false);
    expect(canTransition('TRANSCRIBING', 'READY')).toBe(false);
    expect(canTransition('READY', 'LINKED')).toBe(false);
    // 轉錄與分析拆成兩條獨立 queue 之後，TRANSCRIBING 不能再一步跳到 ANALYZING，
    // 中間一定要先落地 TRANSCRIBED
    expect(canTransition('TRANSCRIBING', 'ANALYZING')).toBe(false);
  });

  it('ANALYZING 重試用盡可以退回 TRANSCRIBED，不連坐已成功的轉錄結果', () => {
    expect(canTransition('ANALYZING', 'TRANSCRIBED')).toBe(true);
  });

  it('READY 與 LINKED 是分開的狀態，不能互相取代（D-002）', () => {
    expect(canTransition('READY', 'LINKED')).toBe(false);
    expect(canTransition('LINKED', 'READY')).toBe(false);
  });

  it('任一段都能進 FAILED，FAILED 自己不能再進 FAILED', () => {
    for (const from of MEETING_STATUSES) {
      expect(canTransition(from, 'FAILED')).toBe(from !== 'FAILED');
    }
  });

  it('關聯可以全量重算，所以 LINKED 與 LINK_FAILED 都能回 LINKING', () => {
    expect(canTransition('LINKED', 'LINKING')).toBe(true);
    expect(canTransition('LINK_FAILED', 'LINKING')).toBe(true);
  });

  it('FAILED 可以退回 CREATED 重跑整條', () => {
    expect(canTransition('FAILED', 'CREATED')).toBe(true);
  });

  it('轉到自己不是合法轉移', () => {
    for (const s of MEETING_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('合法時不拋錯', () => {
    expect(() => assertTransition('m-1', 'CREATED', 'TRANSCRIBING')).not.toThrow();
  });

  it('非法時拋錯，訊息帶 meetingId 與前後狀態', () => {
    expect(() => assertTransition('m-1', 'CREATED', 'READY'))
      .toThrow(/m-1 不能從 CREATED 轉到 READY/);
  });

  it('訊息列出合法的下一步，含統一放行的 FAILED', () => {
    expect(() => assertTransition('m-2', 'LINKING', 'CREATED'))
      .toThrow('Meeting m-2 不能從 LINKING 轉到 CREATED（合法的下一步：LINKED, LINK_FAILED, FAILED）');
  });
});

describe('legalNextStates', () => {
  it('每個狀態都把 FAILED 列進去，FAILED 自己不列', () => {
    expect(legalNextStates('CREATED')).toEqual(['TRANSCRIBING', 'FAILED']);
    expect(legalNextStates('LINKING')).toEqual(['LINKED', 'LINK_FAILED', 'FAILED']);
    expect(legalNextStates('FAILED')).toEqual(['CREATED']);
  });

  it('列出來的每一個都真的能轉過去', () => {
    for (const from of MEETING_STATUSES) {
      for (const to of legalNextStates(from)) expect(canTransition(from, to)).toBe(true);
    }
  });
});

describe('isMeetingStatus', () => {
  it('只認九個狀態', () => {
    expect(isMeetingStatus('READY')).toBe(true);
    expect(isMeetingStatus('TRANSCRIBED')).toBe(true);
    expect(isMeetingStatus('COMPLETED')).toBe(false);
    expect(isMeetingStatus('')).toBe(false);
    expect(isMeetingStatus(undefined)).toBe(false);
    expect(MEETING_STATUSES).toHaveLength(9);
  });
});

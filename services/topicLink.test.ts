/**
 * W4 的純函式：排序、可比性、cosine、S2 判準、候選選擇（AC-1a 的機制那一半）。
 *
 * 這一層之所以要純函式，是因為 S2 的判準要測得動而不能綁著一次真實的 embedding 呼叫；
 * 而 repo 的 gate 對 `App.tsx` 與 `components/` 幾乎沒有型別覆蓋（見 AGENTS.md），
 * 所以「可測的邏輯抽進 services 的純函式」在這裡是唯一的防線，不是風格偏好。
 */
import { describe, expect, it } from 'vitest';

import {
  Candidate,
  TagVector,
  canCompare,
  composeEvidence,
  cosine,
  orderPair,
  pairKey,
  scorePair,
  selectCandidates,
} from './topicLink';

const vec = (tagId: string, title: string, vector: number[], overrides: Partial<TagVector> = {}): TagVector => ({
  tag_id: tagId,
  title,
  vector,
  model: 'test-embedding',
  dimensions: vector.length,
  ...overrides,
});

describe('orderPair / pairKey', () => {
  it('字典序小的當 a，兩個方向得到同一組', () => {
    expect(orderPair('m_b', 'm_a')).toEqual(['m_a', 'm_b']);
    expect(orderPair('m_a', 'm_b')).toEqual(['m_a', 'm_b']);
    expect(pairKey('m_b', 'm_a')).toBe(pairKey('m_a', 'm_b'));
  });

  it('兩端是同一場會就拋錯，不回一個自己跟自己的 pair', () => {
    expect(() => orderPair('m_a', 'm_a')).toThrow(/不能是同一場會/);
  });
});

describe('cosine', () => {
  it('同一個方向是 1，垂直是 0', () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('零向量回 0 而不是 NaN', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('長度不一致就拋錯', () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/向量長度不一致/);
  });
});

describe('canCompare', () => {
  const base = vec('t1', 'A', [1, 0, 0]);

  it('model 或維度不同就不可比', () => {
    expect(canCompare(base, vec('t2', 'B', [0, 1, 0]))).toBe(true);
    expect(canCompare(base, vec('t2', 'B', [0, 1, 0], { model: 'other-embedding' }))).toBe(false);
    expect(canCompare(base, vec('t2', 'B', [0, 1]))).toBe(false);
  });

  it('dimensions 欄跟實際長度對不上時也判為不可比', () => {
    expect(canCompare(base, vec('t2', 'B', [0, 1, 0], { dimensions: 4 }))).toBe(false);
  });
});

describe('scorePair（S2 的判準）', () => {
  it('數的是達門檻的標籤對數，最高那一對進 bestPair', () => {
    const a = [vec('a1', 'A1', [1, 0, 0]), vec('a2', 'A2', [0, 1, 0])];
    const b = [vec('b1', 'B1', [1, 0, 0]), vec('b2', 'B2', [0, 0, 1])];

    const score = scorePair(a, b, 0.7);
    expect(score.hits).toBe(1);
    expect(score.best).toBeCloseTo(1, 10);
    expect(score.bestPair).toEqual({ a: 'A1', b: 'B1' });
    expect(score.incomparable).toBe(0);
  });

  it('門檻是 >=，剛好等於門檻算命中', () => {
    // cos 45 度 = 0.7071...
    const a = [vec('a1', 'A1', [1, 0])];
    const b = [vec('b1', 'B1', [1, 1])];
    expect(scorePair(a, b, 0.7071067).hits).toBe(1);
    expect(scorePair(a, b, 0.8).hits).toBe(0);
  });

  it('model 不同的那幾對算進 incomparable，不算命中也不影響 best', () => {
    const a = [vec('a1', 'A1', [1, 0, 0])];
    const b = [vec('b1', 'B1', [1, 0, 0], { model: '換過的 model' })];

    const score = scorePair(a, b, 0.7);
    expect(score.hits).toBe(0);
    expect(score.best).toBe(0);
    expect(score.bestPair).toBeNull();
    // 不可比被記下來了。安靜地當成「相似度低」的話，換一次 embedding model
    // 會讓所有既有的會安靜地互相關聯不到，而畫面上看不出任何異常
    expect(score.incomparable).toBe(1);
  });
});

describe('selectCandidates', () => {
  const candidate = (id: string, hits: number, best: number): Candidate => ({
    meeting_id: id,
    score: { hits, best, bestPair: null, incomparable: 0 },
  });

  const none = () => false;

  it('命中數沒到 minHits 的不是候選', () => {
    const picked = selectCandidates([candidate('m_a', 2, 0.9), candidate('m_b', 3, 0.8)], none, 10, 3);
    expect(picked.selected.map(c => c.meeting_id)).toEqual(['m_b']);
    expect(picked.droppedByCap).toEqual([]);
  });

  it('照分數排序，超出上限的進 droppedByCap', () => {
    const picked = selectCandidates(
      [candidate('m_low', 3, 0.71), candidate('m_high', 3, 0.95), candidate('m_mid', 3, 0.83)],
      none,
      2,
      3,
    );
    expect(picked.selected.map(c => c.meeting_id)).toEqual(['m_high', 'm_mid']);
    expect(picked.droppedByCap.map(c => c.meeting_id)).toEqual(['m_low']);
  });

  it('同分時照命中數再照 meeting_id 排，不靠輸入順序', () => {
    const forward = selectCandidates([candidate('m_b', 3, 0.8), candidate('m_a', 3, 0.8)], none, 10, 3);
    const backward = selectCandidates([candidate('m_a', 3, 0.8), candidate('m_b', 3, 0.8)], none, 10, 3);
    // 排序不唯一的話，AC-5 的 idempotent 會在「誰進上限」這一格安靜失效
    expect(forward.selected.map(c => c.meeting_id)).toEqual(['m_a', 'm_b']);
    expect(backward.selected.map(c => c.meeting_id)).toEqual(['m_a', 'm_b']);
  });

  it('人標過不相關的不送去判（AC-3 的候選那一道）', () => {
    const picked = selectCandidates(
      [candidate('m_excluded', 5, 0.99), candidate('m_ok', 3, 0.8)],
      id => id === 'm_excluded',
      10,
      3,
    );
    expect(picked.selected.map(c => c.meeting_id)).toEqual(['m_ok']);
    expect(picked.excluded.map(c => c.meeting_id)).toEqual(['m_excluded']);
  });

  it('排除在上限之前扣掉，被排除的不佔名額', () => {
    // 分數最高那個被人標過不相關。排除若在上限之後做，它會佔掉唯一的名額，
    // 結果是「標記不相關讓關聯變少」——標一次就把真正該判的擠出去
    const picked = selectCandidates(
      [candidate('m_excluded', 9, 0.99), candidate('m_ok', 3, 0.8)],
      id => id === 'm_excluded',
      1,
      3,
    );
    expect(picked.selected.map(c => c.meeting_id)).toEqual(['m_ok']);
    expect(picked.droppedByCap).toEqual([]);
  });
});

describe('composeEvidence', () => {
  it('S2 的命中與 S3 的理由都留著', () => {
    const evidence = composeEvidence(
      { hits: 4, best: 0.824, bestPair: { a: '自動貼標籤', b: '標籤管理' }, incomparable: 0 },
      { sameTopic: true, confidence: 0.85, reason: '兩場都在談客服對話的自動貼標', sharedTopics: ['自動貼標'] },
    );
    expect(evidence).toContain('4 對標籤達門檻');
    expect(evidence).toContain('自動貼標籤');
    expect(evidence).toContain('0.824');
    expect(evidence).toContain('兩場都在談客服對話的自動貼標');
    expect(evidence).toContain('0.85');
  });

  it('有不可比的標籤對時講出來，不讓分數看起來是完整的', () => {
    const evidence = composeEvidence(
      { hits: 1, best: 0.8, bestPair: { a: 'A', b: 'B' }, incomparable: 12 },
      { sameTopic: true, confidence: 0.6, reason: '理由', sharedTopics: [] },
    );
    expect(evidence).toContain('12 對');
    expect(evidence).toContain('沒有比到');
  });
});

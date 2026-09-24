import { describe, it, expect } from 'vitest';
import { splitForHighlight } from './searchHighlight';

const hits = (text: string, term: string) =>
  splitForHighlight(text, term).filter(p => p.match).map(p => p.text);

describe('splitForHighlight', () => {
  it('搜尋字含 ( 不丟 SyntaxError，只命中字面的 (', () => {
    expect(splitForHighlight('預算(草案)', '(')).toEqual([
      { text: '預算', match: false },
      { text: '(', match: true },
      { text: '草案)', match: false },
    ]);
  });

  it('搜尋字含 [ 不丟 SyntaxError，只命中字面的 [', () => {
    expect(hits('見 [附件] 與 [會議記錄]', '[')).toEqual(['[', '[']);
  });

  it('. 只命中句點，不當成任意字元', () => {
    expect(splitForHighlight('v1.2 版', '.')).toEqual([
      { text: 'v1', match: false },
      { text: '.', match: true },
      { text: '2 版', match: false },
    ]);
    expect(hits('沒有句點', '.')).toEqual([]);
  });

  it('* 只命中星號，不當成量詞', () => {
    expect(hits('a*b**c', '*')).toEqual(['*', '*', '*']);
    expect(hits('aaa', 'a*')).toEqual([]);
  });

  it('不分大小寫，命中的片段保留原文大小寫', () => {
    expect(splitForHighlight('Gemini 與 GEMINI 與 gemini', 'gEmInI')).toEqual([
      { text: 'Gemini', match: true },
      { text: ' 與 ', match: false },
      { text: 'GEMINI', match: true },
      { text: ' 與 ', match: false },
      { text: 'gemini', match: true },
    ]);
  });

  it('搜尋字是空字串或只有空白時整段不命中', () => {
    expect(splitForHighlight('逐字稿內容', '')).toEqual([{ text: '逐字稿內容', match: false }]);
    expect(splitForHighlight('逐字稿內容', '   ')).toEqual([{ text: '逐字稿內容', match: false }]);
  });

  it('找不到時整段不命中', () => {
    expect(splitForHighlight('逐字稿內容', '預算')).toEqual([{ text: '逐字稿內容', match: false }]);
  });

  it('片段接回去等於原文', () => {
    const text = 'A(b)[c].d*E';
    for (const term of ['(', '[', '.', '*', 'e', 'x']) {
      expect(splitForHighlight(text, term).map(p => p.text).join('')).toBe(text);
    }
  });
});

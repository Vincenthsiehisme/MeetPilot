import { describe, it, expect } from 'vitest';
import { buildPrintDocument } from './printDocument';
import { GeminiOutput, Job, JobStatus } from '../types';

const baseJob: Job = {
  id: 'job-1',
  fileName: 'meeting.mp3',
  fileSize: 1024,
  createdAt: 1757808000000,
  updatedAt: 1757808000000,
  status: JobStatus.COMPLETED,
  currentStep: 3,
  steps: [],
};

const baseAnalysis: GeminiOutput = {
  overview: '討論 Q4 目標',
  topics: [{ title: '預算', content: '第一行\n第二行' }],
  decisions: ['決議一', '決議二'],
  action_items: ['待辦一'],
};

describe('buildPrintDocument', () => {
  it('檔名含 <script> 與引號時，輸出裡沒有未跳脫的 <script>', () => {
    const job: Job = { ...baseJob, fileName: `<script>alert("x")</script>'.mp3` };
    const html = buildPrintDocument(job, baseAnalysis);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain(
      '<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;.mp3 - Meeting Minutes</title>'
    );
    expect(html).toContain(
      'FILE: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;.mp3 | DATE: '
    );
  });

  it('topic content 含 <img onerror> 時被跳脫', () => {
    const analysis: GeminiOutput = {
      ...baseAnalysis,
      topics: [{ title: '<b>標題</b>', content: '<img src=x onerror="alert(1)">' }],
    };
    const html = buildPrintDocument(baseJob, analysis);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain(
      '<div class="topic-item"><span class="topic-title">&lt;b&gt;標題&lt;/b&gt;</span><div class="pre">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</div></div>'
    );
  });

  it('overview、decisions、action_items 都經過跳脫', () => {
    const analysis: GeminiOutput = {
      overview: 'A & B <c>',
      topics: [],
      decisions: ['<i>x</i>'],
      action_items: ['"y"'],
    };
    const html = buildPrintDocument(baseJob, analysis);

    expect(html).toContain('<div class="pre">A &amp; B &lt;c&gt;</div>');
    expect(html).toContain('<ul><li>&lt;i&gt;x&lt;/i&gt;</li></ul>');
    expect(html).toContain('<ul><li>&quot;y&quot;</li></ul>');
    expect(html).toContain('<p class="empty">無議題</p>');
  });

  it('空 decisions 印出「無明確決議」，空 action_items 印出「無待辦事項」', () => {
    const analysis: GeminiOutput = { ...baseAnalysis, decisions: [], action_items: [] };
    const html = buildPrintDocument(baseJob, analysis);

    expect(html).toContain('<h2>決議事項</h2>\n<p class="empty">無明確決議</p>');
    expect(html).toContain('<h2>待辦事項</h2>\n<p class="empty">無待辦事項</p>');
  });

  it('正常內容照順序輸出，多行內容原樣保留在 pre-wrap 容器裡', () => {
    const html = buildPrintDocument(baseJob, baseAnalysis);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>meeting.mp3 - Meeting Minutes</title>');
    expect(html).toContain('<h1>會議記錄</h1>');
    expect(html).toContain('<h3>會議主旨</h3>\n<div class="pre">討論 Q4 目標</div>');
    expect(html).toContain(
      '<div class="topic-item"><span class="topic-title">預算</span><div class="pre">第一行\n第二行</div></div>'
    );
    expect(html).toContain('<h2>決議事項</h2>\n<ul><li>決議一</li><li>決議二</li></ul>');
    expect(html).toContain('<h2>待辦事項</h2>\n<ul><li>待辦一</li></ul>');
    expect(html.indexOf('<h2>議題</h2>')).toBeLessThan(html.indexOf('<h2>決議事項</h2>'));
    expect(html.indexOf('<h2>決議事項</h2>')).toBeLessThan(html.indexOf('<h2>待辦事項</h2>'));
  });
});

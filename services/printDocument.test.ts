import { describe, it, expect } from 'vitest';
import { buildPrintDocument } from './printDocument';
import { Job, JobStatus } from '../types';
import { AnalysisV3 } from './analysisContract';

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

const baseAnalysis: AnalysisV3 = {
  contract_version: 3,
  overview: '討論 Q4 目標',
  topics: [{ title: '預算', content: '第一行\n第二行' }],
  decisions: [
    { text: '決議一', evidence: null, decided_by: null },
    { text: '決議二', evidence: { start: 60, end: 65 }, decided_by: '小美' },
  ],
  action_items: [{
    text: '待辦一', source_meeting_id: 'job-1', created_at: 1, status: 'unknown',
    assignee: null, due: null, evidence: null,
  }],
  open_questions: [],
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
    const analysis: AnalysisV3 = {
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

  it('overview、decisions、action_items、open_questions 都經過跳脫', () => {
    const analysis: AnalysisV3 = {
      contract_version: 3,
      overview: 'A & B <c>',
      topics: [],
      decisions: [{ text: '<i>x</i>', evidence: null, decided_by: '<b>人</b>' }],
      action_items: [{
        text: '"y"', source_meeting_id: 'job-1', created_at: 1, status: 'unknown',
        assignee: '<b>人</b>', due: null, evidence: null,
      }],
      open_questions: [{ text: '<u>z</u>', evidence: null }],
    };
    const html = buildPrintDocument(baseJob, analysis);

    expect(html).toContain('<div class="pre">A &amp; B &lt;c&gt;</div>');
    expect(html).toContain(
      '<li>&lt;i&gt;x&lt;/i&gt; <span class="meta-inline">（拍板：&lt;b&gt;人&lt;/b&gt;）</span></li>'
    );
    expect(html).toContain(
      '<li>&quot;y&quot; <span class="meta-inline">（負責人：&lt;b&gt;人&lt;/b&gt;）</span></li>'
    );
    expect(html).toContain('<li>&lt;u&gt;z&lt;/u&gt;</li>');
    expect(html).toContain('<p class="empty">無議題</p>');
  });

  it('空 decisions／action_items／open_questions 各印出對應的空狀態文字', () => {
    const analysis: AnalysisV3 = { ...baseAnalysis, decisions: [], action_items: [], open_questions: [] };
    const html = buildPrintDocument(baseJob, analysis);

    expect(html).toContain('<h2>決議</h2>\n<p class="empty">本場沒有明確決議</p>');
    expect(html).toContain('<h2>待辦</h2>\n<p class="empty">本場沒有待辦</p>');
    expect(html).toContain('<h2>未決事項</h2>\n<p class="empty">本場沒有未決事項</p>');
  });

  it('決議帶拍板者與時間戳，缺的部分省略（純 null 不印任何括號）', () => {
    const html = buildPrintDocument(baseJob, baseAnalysis);

    expect(html).toContain('<li>決議一</li>');
    expect(html).toContain('<li>決議二 <span class="meta-inline">（拍板：小美，01:00–01:05）</span></li>');
  });

  it('正常內容照順序輸出，多行內容原樣保留在 pre-wrap 容器裡', () => {
    const html = buildPrintDocument(baseJob, baseAnalysis);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>meeting.mp3 - Meeting Minutes</title>');
    expect(html).toContain('<h1>meeting.mp3</h1>');
    expect(html).toContain('<h3>會議主旨</h3>\n<div class="pre">討論 Q4 目標</div>');
    expect(html).toContain(
      '<div class="topic-item"><span class="topic-title">預算</span><div class="pre">第一行\n第二行</div></div>'
    );
    expect(html).toContain('<li>待辦一</li>');
    expect(html.indexOf('<h2>討論</h2>')).toBeLessThan(html.indexOf('<h2>決議</h2>'));
    expect(html.indexOf('<h2>決議</h2>')).toBeLessThan(html.indexOf('<h2>待辦</h2>'));
    expect(html.indexOf('<h2>待辦</h2>')).toBeLessThan(html.indexOf('<h2>未決事項</h2>'));
  });
});

describe('標題', () => {
  it('有標題時 <title>（另存 PDF 的預設檔名）用清過的標題、h1 用原標題，FILE 仍是原始檔名', () => {
    const html = buildPrintDocument({ ...baseJob, title: 'Q3/預算: 覆盤' }, baseAnalysis);
    expect(html).toContain('<title>Q3預算 覆盤 - Meeting Minutes</title>');
    expect(html).toContain('<h1>Q3/預算: 覆盤</h1>');
    expect(html).toContain('FILE: meeting.mp3');
  });

  it('沒有標題時 h1 退回原始檔名（跟畫面上的 SummaryView 一致），<title> 也是原始檔名', () => {
    const html = buildPrintDocument(baseJob, baseAnalysis);
    expect(html).toContain('<h1>meeting.mp3</h1>');
    expect(html).toContain('<title>meeting.mp3 - Meeting Minutes</title>');
  });
});

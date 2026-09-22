import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMeetingDb } from './meetingDb';
import { createMeetingStore, MeetingStore } from './meetingStore';
import { createPeopleStore, PeopleStore } from './peopleStore';
import { createNameResolver, NameResolver } from './nameResolver';
import { DecisionV3, Evidence } from './analysisContract';
import {
  buildFileName,
  computeChecksum,
  computeDurationMinutes,
  createVaultProjector,
  renderSystemRegion,
  resolveVaultDir,
  sanitizeTitle,
  toMeetpilotStatus,
  VaultProjector,
} from './vaultProjector';

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

let db: DatabaseSync;
let store: MeetingStore;
let peopleStore: PeopleStore;
let nameResolver: NameResolver;
let vaultDir: string;
let projector: VaultProjector;

beforeEach(() => {
  db = openMeetingDb(':memory:');
  store = createMeetingStore(db);
  peopleStore = createPeopleStore(db);
  nameResolver = createNameResolver(db, peopleStore, store);
  vaultDir = mkdtempSync(join(tmpdir(), 'meetpilot-vault-'));
  projector = createVaultProjector({ store, vaultDir, nameResolver, now: () => T0 });
});

afterEach(() => {
  db.close();
  rmSync(vaultDir, { recursive: true, force: true });
});

interface ReadyMeetingInput {
  id?: string;
  overview: string;
  /** 有帶就走 meeting.title 優先於 overview 那條路徑，不帶維持既有測試的 overview-only 行為 */
  title?: string;
  /** 純文字的簡便寫法：每則升成 { text, evidence: null, decided_by: null }。
   * 要測 evidence／decided_by 本身的測試直接用 decisionObjects */
  decisions?: string[];
  decisionObjects?: DecisionV3[];
  topics?: { title: string; content: string }[];
  actionItems?: { text: string; source_meeting_id: string; created_at: number; status: 'unknown' | 'open' | 'done'; assignee?: string | null; due?: string | null; evidence?: Evidence | null }[];
  openQuestions?: string[];
  segments?: { start: number; end: number; text: string; speaker?: string }[];
}

/** 把一場會推到 READY，帶著可以投影的最小分析內容 */
function makeReadyMeeting(input: ReadyMeetingInput): string {
  const id = input.id ?? 'm-1';
  store.createMeeting({ meeting_id: id, created_at: T0, source_file_name: 'a.m4a', source_file_size: 10 });
  if (input.title !== undefined) store.setTitle(id, input.title, T0);
  store.setStatus(id, 'TRANSCRIBING', T0);
  store.saveTranscript(
    id,
    { segments: input.segments ?? [{ start: 0, end: 600, text: '哈囉', speaker: 'Speaker 1' }], polished_content: null },
    T0,
  );
  store.setStatus(id, 'ANALYZING', T0);
  store.saveAnalysis(
    id,
    {
      contract_version: 3,
      overview: input.overview,
      topics: input.topics ?? [],
      decisions: input.decisionObjects
        ?? (input.decisions ?? []).map((text) => ({ text, evidence: null, decided_by: null })),
      action_items: (input.actionItems ?? []).map((a) => ({
        assignee: null, due: null, evidence: null, ...a,
      })),
      open_questions: (input.openQuestions ?? []).map((text) => ({ text, evidence: null })),
    },
    T0,
  );
  store.setStatus(id, 'READY', T0);
  return id;
}

/** 把兩場會標成關聯（略過真實的 S2/S3，直接落地結果） */
function linkMeetings(
  a: string,
  b: string,
  overrides: { confidence?: number; evidence?: string; sharedTopics?: string[] } = {},
): void {
  for (const id of [a, b]) {
    const status = store.getMeeting(id)!.status;
    if (status === 'READY') store.setStatus(id, 'LINKING', T0);
  }
  store.saveLinkResult(
    a,
    {
      algo_version: 's2+s3-v1',
      links: [{
        other_meeting_id: b,
        confidence: overrides.confidence ?? 0.85,
        evidence: overrides.evidence ?? 'S2：3 對標籤達門檻｜S3：信心 0.85，同一件事',
        shared_topics: overrides.sharedTopics ?? ['供應商報價'],
      }],
      coverage: {
        candidates: 1, judged: 1, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
        incomparable_pairs: 0, error: null,
      },
    },
    T0,
  );
  for (const id of [a, b]) {
    if (store.getMeeting(id)!.status === 'LINKING') store.setStatus(id, 'LINKED', T0);
  }
}

const listMdFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.md'));
const readOnlyFile = (dir: string): string => readFileSync(join(dir, listMdFiles(dir)[0]), 'utf8');

describe('resolveVaultDir', () => {
  it('沒設就用 ~/MeetPilot Vault', () => {
    expect(resolveVaultDir({})).toMatch(/MeetPilot Vault$/);
  });

  it('設了就用設的，前後空白不算', () => {
    expect(resolveVaultDir({ MEETPILOT_VAULT: '  /var/meetpilot-vault  ' })).toBe('/var/meetpilot-vault');
  });

  it('開頭 ~ 展開成家目錄', () => {
    const resolved = resolveVaultDir({ MEETPILOT_VAULT: '~/custom-vault' });
    expect(resolved.endsWith('custom-vault')).toBe(true);
    expect(resolved.startsWith('~')).toBe(false);
  });

  it('設成家目錄本身直接拒絕，不會把會議 markdown 混進整個家目錄', () => {
    expect(() => resolveVaultDir({ MEETPILOT_VAULT: '~' })).toThrow(/不能是家目錄本身/);
  });
});

describe('sanitizeTitle 與 buildFileName', () => {
  it('取前 30 字，移除路徑與 wikilink 會壞掉的字元，去頭尾空白', () => {
    expect(sanitizeTitle('  定價會議：Q4 supplier/quote "review" [draft]  ')).not.toMatch(/[/\\:*?"<>|[\]]/);
  });

  it('整段都是特殊字元或空白時回「未命名會議」', () => {
    expect(sanitizeTitle('   ///:::   ')).toBe('未命名會議');
  });

  it('檔名格式是 YYYY-MM-DD HHmm <標題>.md，用 UTC 元件算', () => {
    // T0 = 2023-11-14T22:13:20.000Z
    expect(buildFileName(T0, '定價會議')).toBe('2023-11-14 2213 定價會議.md');
  });

  it('換行與其他控制字元被移除，不會讓標題跨行、弄壞 heading 或 wikilink', () => {
    const title = sanitizeTitle('定價會議\n供應商報價\t備註');
    expect(title).not.toMatch(/[\n\t]/);
  });

  it('標題不會在 surrogate pair（例如 emoji）中間切斷', () => {
    // 第 29、30 個字元是同一個 emoji 的一對 surrogate；用 code point 切不會切壞它
    const overview = `${'字'.repeat(29)}😀尾巴`;
    const title = sanitizeTitle(overview);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('computeDurationMinutes', () => {
  it('沒有逐字稿時回 null', () => {
    expect(computeDurationMinutes([])).toBeNull();
  });

  it('取最後結束時間換算分鐘', () => {
    expect(computeDurationMinutes([{ start: 0, end: 30, text: 'a' }, { start: 30, end: 630, text: 'b' }])).toBe(11);
  });

  it('segment 數量很大時不會因為引數展開撞到呼叫堆疊上限（Math.max(...array) 的已知限制）', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => ({ start: i, end: i + 1, text: 'x' }));
    expect(() => computeDurationMinutes(many)).not.toThrow();
    expect(computeDurationMinutes(many)).toBe(Math.round(200_000 / 60));
  });
});

describe('toMeetpilotStatus', () => {
  it('只有 LINKED 與 LINK_FAILED 是終態，其餘一律 linking', () => {
    expect(toMeetpilotStatus('LINKED')).toBe('linked');
    expect(toMeetpilotStatus('LINK_FAILED')).toBe('link_failed');
    for (const s of ['CREATED', 'TRANSCRIBING', 'ANALYZING', 'READY', 'LINKING', 'FAILED'] as const) {
      expect(toMeetpilotStatus(s)).toBe('linking');
    }
  });
});

describe('project：AC-1 檔名與 frontmatter、找檔靠 id 不靠檔名', () => {
  it('還沒有分析結果時是 no-op，不寫檔', () => {
    store.createMeeting({ meeting_id: 'm-1', created_at: T0 });
    const result = projector.project('m-1');
    expect(result).toEqual({ status: 'skipped', reason: 'no-analysis' });
    expect(listMdFiles(vaultDir)).toHaveLength(0);
  });

  it('找不到 Meeting 就拋錯', () => {
    expect(() => projector.project('no-such-meeting')).toThrow(/找不到 Meeting/);
  });

  it('第一次投影用 SDD 1.3.1 的檔名與 frontmatter 規則', () => {
    const id = makeReadyMeeting({ overview: '定價會議 Q4 供應商報價' });
    const result = projector.project(id);
    expect(result.status).toBe('written');

    const files = listMdFiles(vaultDir);
    expect(files).toEqual(['2023-11-14 2213 定價會議 Q4 供應商報價.md']);

    const raw = readOnlyFile(vaultDir);
    expect(raw).toMatch(/^meetpilot_id: m-1$/m);
    expect(raw).toMatch(/^meeting_date: 2023-11-14$/m);
    expect(raw).toMatch(/^meetpilot_status: linking$/m); // READY，還沒算過關聯
    expect(raw).toMatch(/^manual_syntax_version: 1$/m);
    expect(raw).toMatch(/^auto_checksum: sha256:[0-9a-f]{64}$/m);
    expect(raw).toContain('duration_minutes: 10'); // 600 秒
  });

  it('有 meeting.title 時檔名與 heading 用 title，不用 overview 那句完整敘述（2026-09-21）', () => {
    const id = makeReadyMeeting({
      title: 'Q4 供應商報價會議',
      overview: '本次會議針對高雄演唱會套裝行程進行跨部門討論，聚焦於飯店與票券的採購與分潤',
    });
    const result = projector.project(id);
    expect(result.status).toBe('written');

    const files = listMdFiles(vaultDir);
    expect(files).toEqual(['2023-11-14 2213 Q4 供應商報價會議.md']);
    expect(readOnlyFile(vaultDir)).toContain('# Q4 供應商報價會議');
  });

  it('重複投影同一場會不會多產生檔案，靠 meetpilot_id 找到同一份', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    projector.project(id);
    expect(listMdFiles(vaultDir)).toHaveLength(1);
  });

  it('人在 Obsidian 把檔案改名之後，下一次投影仍找到同一份並寫回原檔（不是另外新建一份）', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    const originalPath = join(vaultDir, listMdFiles(vaultDir)[0]);
    const renamedPath = join(vaultDir, '使用者自己改的檔名.md');
    writeFileSync(renamedPath, readFileSync(originalPath, 'utf8'));
    rmSync(originalPath);

    const result = projector.project(id);
    expect(result).toMatchObject({ status: 'written', path: renamedPath });
    expect(listMdFiles(vaultDir)).toEqual(['使用者自己改的檔名.md']);
  });

  it('檔名只在第一次投影時決定，之後即使 overview 換了也不改檔名', () => {
    const id = makeReadyMeeting({ overview: '第一次的標題' });
    projector.project(id);
    const firstFileName = listMdFiles(vaultDir)[0];

    store.replaceAnalysis(id, {
      contract_version: 3, overview: '改過的標題', topics: [], decisions: [], action_items: [], open_questions: [],
    }, T0 + 1000);
    projector.project(id);

    expect(listMdFiles(vaultDir)).toEqual([firstFileName]);
    expect(readOnlyFile(vaultDir)).toContain('# 改過的標題');
  });

  it('兩場會同一分鐘、標題正規化後算出同一個檔名時，不會蓋掉對方，各自留一個有內容的檔案', () => {
    const a = makeReadyMeeting({ id: 'm-a', overview: '週會', decisions: ['A 的結論'] });
    const b = makeReadyMeeting({ id: 'm-b', overview: '週會', decisions: ['B 的結論'] });

    const resultA = projector.project(a);
    const resultB = projector.project(b);

    expect(resultA.status).toBe('written');
    expect(resultB.status).toBe('written');
    if (resultA.status !== 'written' || resultB.status !== 'written') throw new Error('unreachable');
    expect(resultA.path).not.toBe(resultB.path); // 沒有互相覆蓋

    const contentA = readFileSync(resultA.path, 'utf8');
    const contentB = readFileSync(resultB.path, 'utf8');
    expect(contentA).toContain('A 的結論');
    expect(contentB).toContain('B 的結論');
    expect(contentA).toContain('meetpilot_id: m-a');
    expect(contentB).toContain('meetpilot_id: m-b');
  });
});

describe('project：AC-2 系統區內容', () => {
  it('完整投影結論（帶拍板者與時間戳）、待辦（帶負責人與期限，不印 status）、未決事項、討論題目、題目標籤', () => {
    const id = makeReadyMeeting({
      overview: '定價會議',
      decisionObjects: [{ text: '採用方案 A', evidence: { start: 0, end: 30 }, decided_by: '小美' }],
      topics: [{ title: '報價', content: '討論 Q4 報價策略' }],
      actionItems: [{
        text: '確認交期', source_meeting_id: 'm-1', created_at: T0, status: 'unknown',
        assignee: '小美', due: '下週三',
      }],
      openQuestions: ['要不要外包'],
    });
    store.saveTopicExtraction(id, {
      status: 'ok',
      tags: [{ title: '供應商報價的付款條件', content: '討論付款條件', match_key: 'x', match_key_version: 1 }],
    }, T0);

    projector.project(id);
    const raw = readOnlyFile(vaultDir);

    expect(raw).toContain('## 結論\n- 採用方案 A（拍板：小美，00:00–00:30）');
    expect(raw).toContain('- 確認交期（負責人：小美；期限：下週三）');
    expect(raw).not.toContain('狀態不明');
    expect(raw).toContain('## 未決事項\n- 要不要外包');
    expect(raw).toContain('### 報價\n討論 Q4 報價策略');
    expect(raw).toContain('- 供應商報價的付款條件');
  });

  it('人工修正的題目標籤標上來源', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    store.saveTopicExtraction(id, { status: 'ok', tags: [{ title: '自動抽的', content: '', match_key: 'a', match_key_version: 1 }] }, T0);
    // 模擬人工修正：source = manual 需經 topic_tags 表直接寫（W3 沒有公開 API，這裡借 store 內部 db 驗證 render 邏輯即可）
    db.exec("UPDATE topic_tags SET source = 'manual' WHERE meeting_id = 'm-1'");

    projector.project(id);
    expect(readOnlyFile(vaultDir)).toContain('自動抽的（人工修正）');
  });

  it('沒有內容的段落各自輸出誠實的空狀態文字，不留空白段落', () => {
    const id = makeReadyMeeting({ overview: '空的會議' });
    projector.project(id);
    const raw = readOnlyFile(vaultDir);
    expect(raw).toContain('## 完整性\n轉錄沒有已知破洞。\n人名沒有待確認的項目。');
    expect(raw).toContain('## 結論\n本場沒有明確決議。');
    expect(raw).toContain('## 待辦\n本場沒有待辦。');
    expect(raw).toContain('## 未決事項\n本場沒有未決事項。');
    expect(raw).toContain('## 討論題目\n（沒有討論題目）');
    expect(raw).toContain('## 題目標籤\n（沒有抽到題目標籤）');
  });

  it('轉錄破洞與人名待確認會被寫進「完整性」段，不會安靜消失在技術欄位裡', () => {
    const id = makeReadyMeeting({ overview: '缺口會議' });
    store.saveSeamReport(id, [
      { sliceIndex: 1, verdict: 'duplicate', similarity: 0.9, droppedSegments: 3 },
      { sliceIndex: 2, verdict: 'gap', similarity: 0.2, droppedSegments: 0, repair: { outcome: 'failed', attempts: 3 } },
    ]);
    db.prepare(
      'INSERT INTO name_mentions (mention_id, meeting_id, segment_index, original_text, employee_id, method, confidence, created_at) '
      + 'VALUES (?, ?, ?, ?, NULL, ?, 0, ?)',
    ).run('nm-1', id, 4, '阿明', 'short_alias_review', T0);

    projector.project(id);
    const raw = readOnlyFile(vaultDir);

    expect(raw).toContain('## 完整性\n轉錄有 1 處接縫判定為破洞（部分內容可能沒有被轉錄到）：\n- 第 2 片與前一片之間：試過但補不回來，這段內容確實不在逐字稿裡');
    expect(raw).toContain('人名有 1 筆待確認，逐字稿裡的原話先照樣保留：\n- 「阿明」（第 5 段，別名過短，待人工確認）');
    expect(raw).not.toContain('duplicate'); // 重複判定不是缺口，不該出現在完整性提示裡
  });
});

describe('project：AC-3 三種關聯狀態分得開', () => {
  it('linking（READY，還沒算過）：關聯計算尚未完成', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    expect(readOnlyFile(vaultDir)).toContain('## 相關會議\n關聯計算尚未完成。');
  });

  it('linked 且空集合：明確說沒有找到，跟「尚未完成」文字不同', () => {
    const a = makeReadyMeeting({ id: 'm-a', overview: '會議 A' });
    store.setStatus(a, 'LINKING', T0);
    store.saveLinkRun(a, {
      algo_version: 's2+s3-v1',
      links: [],
      coverage: { candidates: 0, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0, incomparable_pairs: 0, error: null },
    }, T0);
    store.setStatus(a, 'LINKED', T0);

    projector.project(a);
    const raw = readOnlyFile(vaultDir);
    expect(raw).toContain('meetpilot_status: linked');
    expect(raw).toContain('## 相關會議\n沒有找到與這場會同題目的歷史會議。');
  });

  it('linked 且有 Link：每則帶信心值、共同題目、判定理由、對方的結論摘要', () => {
    const a = makeReadyMeeting({ id: 'm-a', overview: '定價會議' });
    const b = makeReadyMeeting({ id: 'm-b', overview: '上一季定價會議', decisions: ['調降報價 5%'] });
    linkMeetings(a, b, { confidence: 0.85, evidence: '同一件事', sharedTopics: ['供應商報價'] });

    projector.project(b); // 先投影對方，wikilink 才能接上一個真的檔名
    projector.project(a);

    const raw = readFileSync(join(vaultDir, buildFileName(T0, '定價會議')), 'utf8');
    expect(raw).toContain(`- [[${buildFileName(T0, '上一季定價會議').replace(/\.md$/, '')}]]（信心 0.85）`);
    expect(raw).toContain('共同題目：供應商報價');
    expect(raw).toContain('判定理由：同一件事');
    // 子彈清單格式（v0.6）：標籤一行，決議各自一個縮排子彈
    expect(raw).toContain('  - 那場會的結論：\n    - 調降報價 5%');
  });

  it('連到還沒被投影的會議時，wikilink 預先用對方的 meeting.title 算檔名，不是 overview（2026-09-21）', () => {
    const a = makeReadyMeeting({ id: 'm-a', overview: '新會議 M' });
    const b = makeReadyMeeting({
      id: 'm-b',
      title: '歷史會議 H 標題',
      overview: '一段很長、跟標題完全不同的分析敘述句，用來確認預先算檔名時不會誤用它',
    });
    linkMeetings(a, b);

    const result = projector.project(a); // 只投影 a，b 還沒有自己的檔案
    expect(result.status).toBe('written');
    expect(readOnlyFile(vaultDir)).toContain(`- [[${buildFileName(T0, '歷史會議 H 標題').replace(/\.md$/, '')}]]`);
  });

  it('link_failed：帶原因與重試指令', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    store.setStatus(id, 'LINKING', T0);
    store.setStatus(id, 'LINK_FAILED', T0, '模型額度用完');

    projector.project(id);
    const raw = readOnlyFile(vaultDir);
    expect(raw).toContain('meetpilot_status: link_failed');
    expect(raw).toContain(`關聯計算失敗：模型額度用完。重試方式：\`POST /api/meetings/${id}/link\`。`);
  });

  it('連到的另一場會資料讀不到時，只跳過那一則關聯，不讓它拖垮這場會自己的結論與待辦', () => {
    const a = makeReadyMeeting({ id: 'm-a', overview: '新會議 M', decisions: ['M 自己的結論'] });
    const b = makeReadyMeeting({ id: 'm-b', overview: '壞掉的歷史會議' });
    linkMeetings(a, b);
    // 模擬對方的分析事後被清掉（resetTranscriptionProgress 會連 analyses 一起刪），
    // topic_links 那一列還在，但 store.getAnalysis(b) 回 null
    store.resetTranscriptionProgress(b, T0 + 1);

    const result = projector.project(a);

    expect(result.status).toBe('written');
    const raw = readOnlyFile(vaultDir);
    expect(raw).toContain('M 自己的結論'); // 自己的內容不受牽連
    expect(raw).not.toContain('壞掉的歷史會議'); // 讀不到的那則關聯被跳過，不是編出一則假的
  });

  it('投影 M 連到的歷史會議 H 時，不會動 H 自己的檔案（H 那一側的 link_run 不被誤寫成剛重新計算過）', () => {
    const b = makeReadyMeeting({ id: 'm-b', overview: '歷史會議 H', decisions: ['既有結論'] });
    store.setStatus(b, 'LINKING', T0);
    store.saveLinkRun(b, {
      algo_version: 's2+s3-v1',
      links: [],
      coverage: { candidates: 0, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0, incomparable_pairs: 0, error: null },
    }, T0);
    store.setStatus(b, 'LINKED', T0);
    projector.project(b);
    const hPath = join(vaultDir, buildFileName(T0, '歷史會議 H'));
    const hContentBefore = readFileSync(hPath, 'utf8');

    const a = makeReadyMeeting({ id: 'm-a', overview: '新會議 M' });
    linkMeetings(a, b);
    projector.project(a); // 只投影 M，不 cascade 投影 H

    expect(readFileSync(hPath, 'utf8')).toBe(hContentBefore);
  });
});

describe('project：AC-4 checksum 與錯誤路徑', () => {
  it('重投影且系統區沒被動過時，checksum 通過，正常整份重寫', () => {
    const id = makeReadyMeeting({ overview: '週會', decisions: ['第一版結論'] });
    projector.project(id);
    store.replaceAnalysis(id, { contract_version: 3, overview: '週會', topics: [], decisions: [{ text: '第二版結論', evidence: null, decided_by: null }], action_items: [], open_questions: [] }, T0 + 1);
    const result = projector.project(id);
    expect(result.status).toBe('written');
    expect(readOnlyFile(vaultDir)).toContain('第二版結論');
  });

  it('系統區被人動過時不覆寫：現有檔案整份另存 conflict，新版才寫進原檔名', () => {
    const id = makeReadyMeeting({ overview: '週會', decisions: ['原始結論'] });
    projector.project(id);
    const path = join(vaultDir, listMdFiles(vaultDir)[0]);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('原始結論', '人手動改的結論')); // 改動系統區，checksum 會對不上

    const result = projector.project(id);
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') throw new Error('unreachable');
    expect(existsSync(result.conflictPath)).toBe(true);
    expect(readFileSync(result.conflictPath, 'utf8')).toContain('人手動改的結論'); // 人改過的版本被保留，不是丟掉
    expect(readFileSync(result.path, 'utf8')).toContain('原始結論'); // 新版是系統重新產生的
  });

  it('檔案被正規化成 CRLF 換行時，沒被人真的動過的系統區不會被誤判成衝突', () => {
    const id = makeReadyMeeting({ overview: '週會', decisions: ['原始結論'] });
    projector.project(id);
    const path = join(vaultDir, listMdFiles(vaultDir)[0]);
    const original = readFileSync(path, 'utf8');
    // 模擬 Obsidian／OS／同步工具把整份檔案的換行改成 CRLF，內容本身一個字都沒變
    writeFileSync(path, original.replace(/\n/g, '\r\n'));

    const result = projector.project(id);
    expect(result.status).toBe('written'); // 不是 conflict
  });

  it('同一個 meetpilot_id 出現在兩個（非 conflict）檔案時投影直接報錯，不猜不挑', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    const original = readFileSync(join(vaultDir, listMdFiles(vaultDir)[0]), 'utf8');
    writeFileSync(join(vaultDir, '複製出來的另一份.md'), original);

    expect(() => projector.project(id)).toThrow(/同時出現在兩個檔案/);
  });

  it('conflict 副本不算進重複偵測（它本來就跟原檔帶同一個 id）', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    const original = readFileSync(join(vaultDir, listMdFiles(vaultDir)[0]), 'utf8');
    writeFileSync(join(vaultDir, '週會.conflict-2023-01-01T00-00-00-000Z.md'), original);

    expect(() => projector.project(id)).not.toThrow();
  });

  it('frontmatter 缺 meetpilot_id 但含 auto:start 標記時報錯，不重新產生（會留下孤兒人工區）', () => {
    writeFileSync(
      join(vaultDir, '壞掉的檔案.md'),
      '---\ntitle: 沒有 id\n---\n\n<!-- meetpilot:auto:start 這一區每次由系統整份重寫，改了會被蓋掉 -->\n# x\n<!-- meetpilot:auto:end -->\n',
    );
    const id = makeReadyMeeting({ overview: '週會' });
    expect(() => projector.project(id)).toThrow(/含 meetpilot:auto:start 標記卻沒有 meetpilot_id/);
  });

  it('vault 裡跟 MeetPilot 無關的筆記（沒有 id 也沒有 auto 標記）不影響投影', () => {
    writeFileSync(join(vaultDir, '我自己的筆記.md'), '# 隨便寫點什麼\n');
    const id = makeReadyMeeting({ overview: '週會' });
    expect(() => projector.project(id)).not.toThrow();
    expect(listMdFiles(vaultDir)).toHaveLength(2);
  });

  it('manual_syntax_version 被人改壞成非數字時，重投影退回目前版本，不會把 NaN 寫回檔案', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    const path = join(vaultDir, listMdFiles(vaultDir)[0]);
    writeFileSync(path, readFileSync(path, 'utf8').replace('manual_syntax_version: 1', 'manual_syntax_version: 壞掉了'));

    projector.project(id);

    expect(readFileSync(path, 'utf8')).toContain('manual_syntax_version: 1');
    expect(readFileSync(path, 'utf8')).not.toContain('NaN');
  });
});

describe('project：AC-5 原子寫入與人工區保留', () => {
  it('寫入之後不留下暫存的 .part 檔案', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    expect(readdirSync(vaultDir).some((n) => n.endsWith('.part'))).toBe(false);
  });

  it('人工區原文在重投影後原樣保留（不解析、不清空）', () => {
    const id = makeReadyMeeting({ overview: '週會', decisions: ['第一版'] });
    projector.project(id);
    const path = join(vaultDir, listMdFiles(vaultDir)[0]);
    const manualNote = '### 標為不相關\n- [[某場會]] 題目不同\n';
    const withManualEdit = readFileSync(path, 'utf8').replace(
      /<!-- meetpilot:manual:start -->\n<!-- meetpilot:manual:end -->/,
      `<!-- meetpilot:manual:start -->\n${manualNote}<!-- meetpilot:manual:end -->`,
    );
    writeFileSync(path, withManualEdit);

    store.replaceAnalysis(id, { contract_version: 3, overview: '週會', topics: [], decisions: [{ text: '第二版', evidence: null, decided_by: null }], action_items: [], open_questions: [] }, T0 + 1);
    projector.project(id);

    const after = readFileSync(path, 'utf8');
    expect(after).toContain(manualNote);
    expect(after).toContain('第二版');
  });

  it('系統區 checksum 衝突時，新版（原檔名那份）的人工區是乾淨的——人改過的那份完整保留在 conflict 副本裡', () => {
    const id = makeReadyMeeting({ overview: '週會' });
    projector.project(id);
    const path = join(vaultDir, listMdFiles(vaultDir)[0]);
    const raw = readFileSync(path, 'utf8')
      .replace('# 週會', '# 被改過的標題') // 弄壞系統區
      .replace(
        /<!-- meetpilot:manual:start -->\n<!-- meetpilot:manual:end -->/,
        '<!-- meetpilot:manual:start -->\n- 我留的筆記\n<!-- meetpilot:manual:end -->',
      );
    writeFileSync(path, raw);

    const result = projector.project(id);
    if (result.status !== 'conflict') throw new Error('unreachable');
    expect(readFileSync(result.conflictPath, 'utf8')).toContain('我留的筆記');
    expect(readFileSync(result.path, 'utf8')).not.toContain('我留的筆記');
  });
});

describe('renderSystemRegion／computeChecksum：純函式，checksum 對輸入敏感', () => {
  const asDecisions = (texts: string[]): DecisionV3[] =>
    texts.map((text) => ({ text, evidence: null, decided_by: null }));

  it('相同輸入永遠算出相同 checksum（重算是 idempotent 的前提）', () => {
    const region = renderSystemRegion({
      title: '週會', decisions: asDecisions(['a']), actionItems: [], openQuestions: [], topics: [],
      topicTags: [], relatedSection: '關聯計算尚未完成。', seamReport: null, needsReview: [],
    });
    expect(computeChecksum(region)).toBe(computeChecksum(region));
  });

  it('內容不同 checksum 就不同', () => {
    const base = {
      title: '週會', actionItems: [], openQuestions: [], topics: [], topicTags: [],
      relatedSection: '關聯計算尚未完成。', seamReport: null, needsReview: [],
    };
    const r1 = renderSystemRegion({ ...base, decisions: asDecisions(['a']) });
    const r2 = renderSystemRegion({ ...base, decisions: asDecisions(['b']) });
    expect(computeChecksum(r1)).not.toBe(computeChecksum(r2));
  });

  it('未決事項不同 checksum 也不同（新增段，不能被漏算）', () => {
    const base = {
      title: '週會', decisions: asDecisions(['a']), actionItems: [], topics: [], topicTags: [],
      relatedSection: '關聯計算尚未完成。', seamReport: null, needsReview: [],
    };
    const r1 = renderSystemRegion({ ...base, openQuestions: [] });
    const r2 = renderSystemRegion({ ...base, openQuestions: [{ text: '要不要外包', evidence: null }] });
    expect(computeChecksum(r1)).not.toBe(computeChecksum(r2));
  });

  it('轉錄破洞不同 checksum 也不同（完整性提示要被 checksum 保護，不然人改了提示不會觸發 conflict）', () => {
    const base = {
      title: '週會', decisions: asDecisions(['a']), actionItems: [], openQuestions: [], topics: [],
      topicTags: [], relatedSection: '關聯計算尚未完成。', needsReview: [],
    };
    const r1 = renderSystemRegion({ ...base, seamReport: null });
    const r2 = renderSystemRegion({
      ...base,
      seamReport: [{ sliceIndex: 2, verdict: 'gap', similarity: 0.1, droppedSegments: 0 }],
    });
    expect(computeChecksum(r1)).not.toBe(computeChecksum(r2));
  });
});

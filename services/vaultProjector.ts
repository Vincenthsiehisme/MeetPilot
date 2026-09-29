/**
 * VaultProjector（W5，SDD 1.3.1 與第 3 節 Module 表）。
 *
 * 把一場 Meeting 從 SQLite 投影成獨立 Obsidian vault 裡的一份 markdown。SQLite 是真相源，
 * markdown 是可以整份重建的投影；唯一的例外是人工區，它承載 1.2 的人工修正與 6.3 的回饋訊號，
 * 那兩樣不可重建。**W5 只保留人工區的原文，不解析、不回寫**——解析與回寫是 W6（2026-09-16 裁決，
 * 見 W5 plan〈決策〉：W5 不讀回人工區，先把不可覆寫的投影邊界做穩）。
 *
 * `RecallComposer` 沒有另外拆出來：它的組裝跟這裡的檔案 I/O、render、人工區保護共用同一份
 * `C-RECALL` 契約，拆開會先發明尚不存在的介面（同上決策，回覆 SDD 對 v0.5 自身的批判第 1 條）。
 *
 * 不變量（SDD 第 3 節 Module 表）：系統區可整份重建；人工區系統只讀不寫；一律靠 `meetpilot_id`
 * 找檔，不靠檔名。錯誤模式：同一個 id 出現在兩個檔就報錯不猜；系統區 checksum 不符時先另存
 * `.conflict-<timestamp>.md` 再寫，不覆寫；寫檔一律先寫暫存檔再 rename。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { TranscriptSegment } from '../types';
import { ActionItemV3, DecisionV3, Evidence, OpenQuestionV3, TopicV3 } from './analysisContract';
import { SeamReportEntry } from './meetingApi';
import { MeetingStatus } from './meetingState';
import { MeetingStore } from './meetingStore';
import { NameMention, NameResolver } from './nameResolver';
import { LINK_ALGO_VERSION } from './topicLink';
import { TopicTag } from './topicTag';

const DEFAULT_VAULT_DIR = join(homedir(), 'MeetPilot Vault');

/**
 * `MEETPILOT_VAULT` 未設定時用 `~/MeetPilot Vault`（D-014，使用者 2026-09-14 裁決）。
 * 不放進 `/Users/vincent/AI Memory`：那個 vault 的 `vault-check.py` 對會議 markdown 有三條
 * 硬衝突（`status` 合法值、`INDEX_MIN`、遞迴全掃無排除清單），細節見 SDD 1.3.1〈落地位置〉。
 *
 * **設成家目錄本身直接拒絕**（code review 2026-09-18 抓到）：`MEETPILOT_VAULT=~` 這種輸入會讓
 * `raw.slice(1)` 變空字串，`vaultDir` 解析成 `homedir()` 自己。`mkdirSync` 對已存在的目錄是
 * no-op，server 會「成功」啟動，然後把會議 markdown 直接寫進使用者整個家目錄，`scanVaultIndex`
 * 也會開始把家目錄裡所有 `.md` 檔當成候選掃——這種設定錯誤沒有寫入失敗那種天然的啟動期示警，
 * 所以要自己補一個。
 */
export const resolveVaultDir = (env: NodeJS.ProcessEnv): string => {
  const raw = (env.MEETPILOT_VAULT ?? '').trim();
  const resolved = raw === '' ? DEFAULT_VAULT_DIR : raw.startsWith('~')
    ? resolve(join(homedir(), raw.slice(1)))
    : resolve(raw);
  if (resolved === resolve(homedir())) {
    throw new Error(
      `MEETPILOT_VAULT 不能是家目錄本身（目前解析成 ${resolved}）。`
      + '請指定一個子目錄，例如 ~/MeetPilot Vault，否則會議 markdown 會混進整個家目錄',
    );
  }
  return resolved;
};

const AUTO_START = '<!-- meetpilot:auto:start 這一區每次由系統整份重寫，改了會被蓋掉 -->';
const AUTO_END = '<!-- meetpilot:auto:end -->';
const MANUAL_START = '<!-- meetpilot:manual:start -->';
const MANUAL_END = '<!-- meetpilot:manual:end -->';
/** 排除 conflict 副本用。副本的 frontmatter 帶著跟原檔一樣的 meetpilot_id，掃描時不能算進索引 */
const CONFLICT_INFIX = '.conflict-';
const MANUAL_SYNTAX_VERSION = 1;

/**
 * 標題最多取前 30 個字元，移除路徑與 wikilink 會壞掉的字元、控制字元與前後空白
 * （SDD 1.3.1〈檔名與身分〉）。`[` `]` 不在 SDD 列的字集裡，但留著會讓 `[[<標題>]]` 這個
 * wikilink 本身斷掉，所以一併移除；換行與其他控制字元同理——一個標題裡的換行會讓 `# <標題>`
 * 這個 heading 與 `[[<標題>]]` 這個 wikilink 都變成非法 markdown（code review 2026-09-18）。
 *
 * 輸入是 `meeting.title`（有的話）或 `analysis.overview`（沒有 title 時的退回值，見呼叫端）。
 * 兩者都可能超過 30 字，所以這裡仍然截：`meeting.title` 上限是 100 字（`meetingTitle.ts`），
 * `analysis.overview` 是一整句話，截了才不會讓檔名長到不像標題（2026-09-21 使用者回報太長）。
 *
 * 用 `Array.from` 而不是 `.slice(0, 30)`：後者按 UTF-16 code unit 切，遇到 surrogate pair
 * （例如某些 emoji）可能切在字元中間，留下一個孤立的 surrogate，變成檔名裡一個無法呈現的字元。
 * `Array.from` 按 code point 迭代，30 個 code point 不會切壞任何一個字元。
 */
export const sanitizeTitle = (text: string): string =>
  Array.from(text).slice(0, 30).join('')
    .replace(/[/\\:*?"<>|[\]]/g, '').replace(/\p{Cc}/gu, '')
    .trim() || '未命名會議';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 檔名主體（不含 `.md`），供檔名本體與 wikilink 顯示文字共用——原本兩處各自呼叫
 * `buildFileName` 再 `.replace(/\.md$/, '')` 剝掉副檔名，副檔名的字面值因此要對齊兩個地方
 * （code review 2026-09-18：simplification）。
 */
const buildFileStem = (createdAtMs: number, title: string): string => {
  const d = new Date(createdAtMs);
  const stamp = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  return `${stamp} ${sanitizeTitle(title)}`;
};

/**
 * 檔名：`YYYY-MM-DD HHmm <標題>.md`（SDD 1.3.1）。**決定時機：首次寫入時，之後系統永不更改**
 * ——呼叫端只在「這場會第一次投影」時用它，已經投影過的一律沿用索引查到的既有檔名。
 *
 * 用 UTC 元件算，不用系統時區：同一個 `created_at` 在任何機器上、任何時候都算出同一個檔名，
 * 測試才不會因為跑測試的機器時區不同而得到不同結果。
 */
export const buildFileName = (createdAtMs: number, title: string): string => `${buildFileStem(createdAtMs, title)}.md`;

/** frontmatter 的 `auto_checksum`：系統區內容（AUTO_START 與 AUTO_END 之間，不含標記本身）的 sha256 */
export const computeChecksum = (systemRegion: string): string =>
  `sha256:${createHash('sha256').update(systemRegion, 'utf8').digest('hex')}`;

/**
 * 一場會的總長度（分鐘），從逐字稿最後一段的結束時間推。純函式抽出來是為了能單獨測：
 * `Math.max(...segments.map(s => s.end))` 這種寫法在 segment 數量夠多時會因為引數展開超過
 * V8 的呼叫堆疊上限而丟 `RangeError`（code review 2026-09-18）——長會議切很多片、逐句斷句時
 * 上萬個 segment 不是不可能，改用迴圈比大小沒有這個上限。
 */
export const computeDurationMinutes = (segments: readonly TranscriptSegment[]): number | null => {
  if (segments.length === 0) return null;
  let maxEnd = 0;
  for (const s of segments) {
    if (s.end > maxEnd) maxEnd = s.end;
  }
  return Math.round(maxEnd / 60);
};

export type MeetpilotStatus = 'linked' | 'linking' | 'link_failed';

/**
 * SDD 1.3.1〈三種狀態在畫面上必須分得開〉的三個合法值只對到 LINKED／LINK_FAILED 兩個終態，
 * 其餘（READY、LINKING、以及分析已存但意外落到 FAILED 的邊界情形）一律算「尚未完成」——
 * `RecallComposer` 的不變量原文是「關聯未完成時回傳『未完成』而非空集合」，READY 正是
 * 「還沒算」（`MEETPILOT_LINKING=off` 時的穩定終態，見 README〈跨會議關聯〉），跟這句話同義。
 */
export const toMeetpilotStatus = (status: MeetingStatus): MeetpilotStatus => {
  if (status === 'LINKED') return 'linked';
  if (status === 'LINK_FAILED') return 'link_failed';
  return 'linking';
};

interface RelatedMeetingRender {
  displayName: string;
  confidence: number;
  sharedTopics: readonly string[];
  evidence: string;
  /** 那場會的決議物件（v3），不是純字串——SDD 1.3.1 已改成子彈清單，這裡只取 text，
   * 出處是那場會自己逐字稿的位置，跟這份投影檔（另一場會）沒有對得上的意義 */
  decisions: readonly DecisionV3[];
}

/** v3 的 evidence 顯示成 MM:SS–MM:SS，跟 exportUtils.ts／printDocument.ts 同一種格式 */
const formatEvidenceRange = (evidence: Evidence | null): string | null => {
  if (evidence === null) return null;
  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  return `${fmt(evidence.start)}–${fmt(evidence.end)}`;
};

/**
 * `## 相關會議` 段。**空集合與未完成絕不可以寫成同一句話**（SDD 1.3.1，2.3 的「不會有人發現的
 * 壞法」）：`linking` 是「還沒算」，`linked` 加空陣列是「算過了，沒有同題目的會」，
 * `link_failed` 要帶原因與重試方式。
 *
 * 「那場會的結論」改成子彈清單（v0.6）：原本用全形分號串成一行，決議本身可能就含逗號或分號，
 * 串起來之後分不出是幾條；改成每條一個 `    - ` 子彈，跟本檔自己 `## 結論` 段的格式一致。
 */
const renderRelatedMeetingsSection = (
  status: MeetpilotStatus,
  related: readonly RelatedMeetingRender[],
  failureReason: string | null,
  meetingId: string,
): string => {
  if (status === 'linking') return '關聯計算尚未完成。';
  if (status === 'link_failed') {
    return `關聯計算失敗：${failureReason ?? '原因未知'}。重試方式：\`POST /api/meetings/${meetingId}/link\`。`;
  }
  if (related.length === 0) return '沒有找到與這場會同題目的歷史會議。';
  return related
    .map((r) => {
      const decisionsBlock = r.decisions.length > 0
        ? [`  - 那場會的結論：`, ...r.decisions.map((d) => `    - ${d.text}`)].join('\n')
        : '  - 那場會的結論：（那場會沒有明確決議）';
      return [
        `- [[${r.displayName}]]（信心 ${r.confidence.toFixed(2)}）`,
        `  - 共同題目：${r.sharedTopics.join('、')}`,
        `  - 判定理由：${r.evidence}`,
        decisionsBlock,
      ].join('\n');
    })
    .join('\n');
};

const renderTopicTagsSection = (tags: readonly TopicTag[]): string =>
  tags.length > 0
    ? tags.map((t) => `- ${t.title}${t.source === 'manual' ? '（人工修正）' : ''}`).join('\n')
    : '（沒有抽到題目標籤）';

/** 決議每條附出處與拍板者，缺的部分省略；v2 升上來的舊資料 evidence／decided_by 是 null，
 * 呈現退回純文字（SDD 1.3.1 v0.6） */
const renderDecisionsSection = (decisions: readonly DecisionV3[]): string => {
  if (decisions.length === 0) return '本場沒有明確決議。';
  return decisions.map((d) => {
    const meta = [d.decided_by ? `拍板：${d.decided_by}` : null, formatEvidenceRange(d.evidence)]
      .filter((x): x is string => x !== null);
    return meta.length > 0 ? `- ${d.text}（${meta.join('，')}）` : `- ${d.text}`;
  }).join('\n');
};

/** 待辦每條附負責人、期限與出處，缺的部分省略。**不印 status**（v0.6 起）：
 * status 是系統內部的追蹤欄位，留在 SQLite，不是規範要求人讀的內容 */
const renderActionItemsSection = (items: readonly ActionItemV3[]): string => {
  if (items.length === 0) return '本場沒有待辦。';
  return items.map((it) => {
    const meta = [
      it.assignee ? `負責人：${it.assignee}` : null,
      it.due ? `期限：${it.due}` : null,
      formatEvidenceRange(it.evidence),
    ].filter((x): x is string => x !== null);
    return meta.length > 0 ? `- ${it.text}（${meta.join('；')}）` : `- ${it.text}`;
  }).join('\n');
};

/** 未決事項（v3 新增段）：有人提出、當場沒結論的問題，只附出處 */
const renderOpenQuestionsSection = (questions: readonly OpenQuestionV3[]): string => {
  if (questions.length === 0) return '本場沒有未決事項。';
  return questions.map((q) => {
    const meta = formatEvidenceRange(q.evidence);
    return meta !== null ? `- ${q.text}（${meta}）` : `- ${q.text}`;
  }).join('\n');
};

/**
 * 議題：小標、「走到哪」一行、條列要點，每點後面接行內程式碼的時間範圍（Obsidian 顯示成小灰底標籤，SDD v0.9）。
 * 舊資料沒有 points（`undefined`）就只印整段 content，跟改版前一樣；有 points 但是空的，照新格式只印走到哪
 */
const renderTopicsSection = (topics: readonly TopicV3[]): string =>
  topics.length > 0
    ? topics.map((t) => {
      if (t.points === undefined) return `### ${t.title}\n${t.content}`;
      const points = t.points.map((pt) => {
        const range = formatEvidenceRange(pt.evidence);
        return range === null ? `- ${pt.text}` : `- ${pt.text} \`${range}\``;
      });
      return [`### ${t.title}`, `走到哪：${t.content}`, ...points].join('\n');
    }).join('\n\n')
    : '（沒有討論題目）';

/** `repair` 缺席只會發生在 verdict 不是 gap 的接縫，這裡只被拿來處理 gap，理論上一定有值；沒有就誠實印出來，不猜 */
const describeRepair = (repair: SeamReportEntry['repair']): string => {
  if (!repair) return '沒有嘗試修補';
  if (repair.outcome === 'repaired') return '已補回來';
  if (repair.outcome === 'failed') return '試過但補不回來，這段內容確實不在逐字稿裡';
  return '沒有嘗試修補（額度用完或功能關閉）';
};

/**
 * 完整性提示（會議記錄的完整性定義：記到＋可回查來源＋缺口要指出來，2026-09-22 使用者裁決）。
 * 轉錄破洞（`seam_report` 的 `gap`）與人名待確認（`name_mentions` 的 `needs_review`）都是
 * 技術層已經知道、但先前完全沒有進到人看的 markdown 的缺口——放在系統區最前面，讀者要先知道
 * 「這份記錄哪裡不完整」才去讀內容，不是讀完才發現漏了什麼都沒人講。
 */
const renderCompletenessSection = (
  seamReport: readonly SeamReportEntry[] | null,
  needsReview: readonly NameMention[],
): string => {
  const gaps = (seamReport ?? []).filter((e) => e.verdict === 'gap');
  const lines: string[] = [];
  lines.push(
    gaps.length === 0
      ? '轉錄沒有已知破洞。'
      : `轉錄有 ${gaps.length} 處接縫判定為破洞（部分內容可能沒有被轉錄到）：`,
  );
  for (const g of gaps) {
    lines.push(`- 第 ${g.sliceIndex} 片與前一片之間：${describeRepair(g.repair)}`);
  }
  lines.push(
    needsReview.length === 0
      ? '人名沒有待確認的項目。'
      : `人名有 ${needsReview.length} 筆待確認，逐字稿裡的原話先照樣保留：`,
  );
  for (const m of needsReview) {
    const reason = m.method === 'short_alias_review' ? '別名過短' : '同名撞到多個員編';
    lines.push(`- 「${m.original_text}」（第 ${m.segment_index + 1} 段，${reason}，待人工確認）`);
  }
  return lines.join('\n');
};

interface SystemRegionInput {
  title: string;
  decisions: readonly DecisionV3[];
  actionItems: readonly ActionItemV3[];
  openQuestions: readonly OpenQuestionV3[];
  topics: readonly TopicV3[];
  topicTags: readonly TopicTag[];
  relatedSection: string;
  seamReport: readonly SeamReportEntry[] | null;
  needsReview: readonly NameMention[];
}

/** 系統區的完整內容（純函式，不含 I/O），也是 `auto_checksum` 要雜湊的那段文字 */
export const renderSystemRegion = (input: SystemRegionInput): string => [
  `# ${input.title}`,
  '',
  '## 完整性',
  renderCompletenessSection(input.seamReport, input.needsReview),
  '',
  '## 結論',
  renderDecisionsSection(input.decisions),
  '',
  '## 待辦',
  renderActionItemsSection(input.actionItems),
  '',
  '## 未決事項',
  renderOpenQuestionsSection(input.openQuestions),
  '',
  '## 討論題目',
  renderTopicsSection(input.topics),
  '',
  '## 題目標籤',
  renderTopicTagsSection(input.topicTags),
  '',
  '## 相關會議',
  input.relatedSection,
].join('\n');

interface FrontmatterInput {
  meetpilotId: string;
  meetingDate: string;
  durationMinutes: number | null;
  meetpilotStatus: MeetpilotStatus;
  linkAlgoVersion: string;
  manualSyntaxVersion: number;
  generatedAt: string;
  autoChecksum: string;
}

const buildFrontmatter = (fm: FrontmatterInput): string => [
  '---',
  `meetpilot_id: ${fm.meetpilotId}`,
  `meeting_date: ${fm.meetingDate}`,
  `duration_minutes: ${fm.durationMinutes ?? 'null'}`,
  `meetpilot_status: ${fm.meetpilotStatus}`,
  `link_algo_version: ${fm.linkAlgoVersion}`,
  `manual_syntax_version: ${fm.manualSyntaxVersion}`,
  `generated_at: ${fm.generatedAt}`,
  `auto_checksum: ${fm.autoChecksum}`,
  '---',
].join('\n');

/**
 * 系統區前後各留一個空行（純粹排版，SDD 1.3.1 的範例就是這樣排的）。**寫入用的 padding 跟
 * 讀取時要掐掉的 padding 必須是同一個常數**：checksum 算的是 `renderSystemRegion` 的原始輸出，
 * 兩邊沒對齊的話，什麼都沒被人動過，checksum 也會對不上——第一版就是這樣栽的（重投影誤判成
 * 系統區被人改過，明明什麼都沒變）。
 */
const AUTO_PADDING = '\n\n';

const buildAutoBlock = (systemRegion: string): string => `${AUTO_START}${AUTO_PADDING}${systemRegion}${AUTO_PADDING}${AUTO_END}`;

/** 系統區被人整個刪掉、標記被改壞這類「格式跑掉」也回 null，一律當成驗不出來，交給呼叫端走 conflict 分支，不猜 */
const extractSystemRegion = (raw: string): string | null => {
  const s = raw.indexOf(AUTO_START);
  if (s === -1) return null;
  const start = s + AUTO_START.length;
  const e = raw.indexOf(AUTO_END, start);
  if (e === -1) return null;
  const content = raw.slice(start, e);
  if (!content.startsWith(AUTO_PADDING) || !content.endsWith(AUTO_PADDING)) return null;
  return content.slice(AUTO_PADDING.length, content.length - AUTO_PADDING.length);
};

/**
 * 人工區空的時候標記緊貼在一起（SDD 1.3.1 範例原文），非空時各自留一個換行。
 * 這兩種形狀都要能被 `extractManualRegion` 準確讀回來，不能只顧著寫得出來。
 */
const buildManualBlock = (manualRegionRaw: string): string =>
  manualRegionRaw === '' ? `${MANUAL_START}\n${MANUAL_END}` : `${MANUAL_START}\n${manualRegionRaw}\n${MANUAL_END}`;

/** 讀回人工區原文，找不到標記就當成空（新檔或格式壞掉，反正 W5 不解析內容，原樣帶過去最安全） */
const extractManualRegion = (raw: string): string => {
  const s = raw.indexOf(MANUAL_START);
  if (s === -1) return '';
  const start = s + MANUAL_START.length;
  const e = raw.indexOf(MANUAL_END, start);
  if (e === -1) return '';
  let content = raw.slice(start, e);
  if (content.startsWith('\n')) content = content.slice(1);
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return content;
};

/** 組出完整檔案。`manualRegionRaw` 是空字串（新檔）或從既有檔案原樣擷取出來的內容（保留人工區） */
const assembleFile = (frontmatter: string, systemRegion: string, manualRegionRaw: string): string => [
  frontmatter,
  '',
  buildAutoBlock(systemRegion),
  '',
  '## 我的修正',
  buildManualBlock(manualRegionRaw),
  '',
].join('\n');

/**
 * 讀 frontmatter 裡一個欄位的值。只認得自己寫出來的扁平 `key: value` 格式——W5 不需要、
 * 也不嘗試當一個通用 YAML parser，這裡只讀自己會寫的那幾個欄位。
 */
const extractFrontmatterField = (raw: string, key: string): string | null => {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  const block = end === -1 ? raw : raw.slice(0, end);
  const match = block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
};

/**
 * 讀一個 vault 檔案並把 CRLF 正規化成 LF（code review 2026-09-18）。**系統一律只寫 `\n`**
 * （見 `AUTO_PADDING`、`buildManualBlock`），但 Obsidian、OS 或同步工具可能把整份檔案的換行
 * 改成 `\r\n`——不正規化的話，`extractSystemRegion` 找的是字面 `\n\n`，對到 `\r\n\r\n` 會直接
 * 判定「格式跑掉」，把完全沒被人動過的系統區誤判成被改過，觸發不必要的 conflict。
 * `extractFrontmatterField` 的 `(.*)$`／`m` 也會把行尾的 `\r`吃進值裡，讓 `meetpilot_id`
 * 帶著看不見的尾碼，跟索引裡乾淨的 id 對不起來——這是同一個成因的另一個症狀，同一處正規化解決。
 */
const readVaultFile = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * 掃整個 vault，建 `meetpilot_id → path` 的索引（SDD 1.3.1〈找檔方式〉：一律靠 id，不靠檔名）。
 *
 * **每次 `project()` 都重掃，不是只在建構時掃一次快取。** vault 預期量級一年約 1,040 個檔（SDD
 * 6.4），掃一次是毫秒級；換來的是人在 Obsidian 更名後不用重啟 server 就找得到，而且外部（人手動
 * 複製）造成的同 id 兩檔能在下一次投影就抓到，不用等重啟。**逐檔讀的是整份內容不是只有
 * frontmatter**（先前這裡的註解寫得不誠實）：現在的量級下差異可忽略，但單檔內容變大（討論題目
 * 全文、多輪人工修正）之後這裡的成本會跟著漲；vault 檔案數量級漲到几千份時要重新評估要不要改成
 * 只讀檔頭一小段。
 *
 * 同一個 id 出現在兩個檔：停下來報錯，不猜、不挑一個寫（成因通常是人複製了檔案）。
 * frontmatter 缺 `meetpilot_id` 但含 `meetpilot:auto:start` 標記：報錯，不重新產生——這種檔是
 * 人手動改壞 frontmatter 的結果，直接重新產生會留下一個帶著人工區的孤兒檔。
 */
const scanVaultIndex = (vaultDir: string): Map<string, string> => {
  const index = new Map<string, string>();
  if (!existsSync(vaultDir)) return index;

  for (const name of readdirSync(vaultDir)) {
    if (!name.endsWith('.md') || name.includes(CONFLICT_INFIX)) continue;
    const path = join(vaultDir, name);
    const raw = readVaultFile(path);
    const id = extractFrontmatterField(raw, 'meetpilot_id');

    if (!id) {
      if (raw.includes('meetpilot:auto:start')) {
        throw new Error(
          `vault 檔案 ${path} 含 meetpilot:auto:start 標記卻沒有 meetpilot_id，`
          + '這是系統產出的檔案被手動改壞 frontmatter，不能重新產生（會留下帶著人工區的孤兒檔）',
        );
      }
      continue; // 不是 MeetPilot 管的檔案（人自己在這個 vault 放的筆記），略過
    }

    const existing = index.get(id);
    if (existing) {
      throw new Error(
        `meetpilot_id ${id} 同時出現在兩個檔案：${existing} 與 ${path}。`
        + '不猜、不挑一個寫，成因通常是人複製了檔案，請先手動確認哪一份是對的',
      );
    }
    index.set(id, path);
  }
  return index;
};

/**
 * 先寫暫存檔再原子 rename（同 audioFileStore 的寫入慣例）。同一個 vault 可能同時開著 Obsidian，非原子寫入會讓它讀到截斷的檔。
 * `diagnosticsExport.ts` 寫 `_診斷/` 也用這支：OneDrive 同樣不能同步到半截的檔
 */
export const writeAtomic = (path: string, content: string | Buffer): void => {
  const partPath = `${path}.${randomUUID()}.part`;
  try {
    writeFileSync(partPath, content, typeof content === 'string' ? 'utf8' : undefined);
    renameSync(partPath, path);
  } catch (err) {
    // 暫存檔也可能刪不掉（Windows 上 OneDrive 正鎖著剛建出來的 .part）。那時不能讓清理的錯誤
    // 蓋掉原本寫不進去的原因，也要講出哪個 .part 留在資料夾裡
    try {
      rmSync(partPath, { force: true });
    } catch (cleanupErr) {
      throw new Error(
        `${(err as Error).message}；暫存檔 ${partPath} 也沒清掉：${(cleanupErr as Error).message}`,
        { cause: err },
      );
    }
    throw err;
  }
};

export type ProjectionResult =
  /** 這場會還沒有分析結果（CREATED／TRANSCRIBING／ANALYZING），沒有東西可以投影 */
  | { status: 'skipped'; reason: 'no-analysis' }
  /** 正常寫入（新檔或重寫既有檔，人工區已原樣保留） */
  | { status: 'written'; path: string }
  /** 系統區 checksum 不符（人改過系統區）：舊檔已另存為 conflictPath，新版寫進 path */
  | { status: 'conflict'; path: string; conflictPath: string };

export interface VaultProjectorDeps {
  store: MeetingStore;
  vaultDir: string;
  /** 完整性提示需要的兩樣：人名待確認清單只用得到 `listNeedsReview` */
  nameResolver: Pick<NameResolver, 'listNeedsReview'>;
  /** 測試注入用；正式呼叫不要傳 */
  now?: () => number;
}

export const createVaultProjector = (deps: VaultProjectorDeps) => {
  const { store, vaultDir, nameResolver } = deps;
  const now = deps.now ?? (() => Date.now());
  mkdirSync(vaultDir, { recursive: true });

  const project = (meetingId: string): ProjectionResult => {
    const meeting = store.getMeeting(meetingId);
    if (!meeting) throw new Error(`找不到 Meeting ${meetingId}`);

    // 還沒有分析結果就沒有東西可以投影，不是錯誤：CREATED／TRANSCRIBING／ANALYZING 都會走到這裡，
    // 呼叫端（pipeline、/link 路由）不用先判斷狀態才呼叫 project，這裡自己是安全的 no-op
    const analysis = store.getAnalysis(meetingId);
    if (!analysis) return { status: 'skipped', reason: 'no-analysis' };

    const index = scanVaultIndex(vaultDir);
    // 有 meeting.title（PR #9 的會議標題功能）就用它：本來就短、不是句子中間硬切下來的。
    // 沒有的話（title 功能之前建立的舊會議、或標題抽取失敗）退回 overview（2026-09-21 裁決）
    const title = sanitizeTitle(meeting.title ?? analysis.overview);

    // 目前顯示的版本（人工編輯過就用編輯後的，見 CurrentTranscript），不是永遠不動的 raw：
    // 人改過的時長／段落是使用者現在看到的事實
    const transcript = store.getCurrentTranscript(meetingId);
    const durationMinutes = computeDurationMinutes(transcript?.segments ?? []);
    const seamReport = store.getSeamReport(meetingId);
    const needsReview = nameResolver.listNeedsReview(meetingId);

    const links = store.getLinks(meetingId);
    const linkRun = store.getLinkRun(meetingId);
    const topicTags = store.getTopicTags(meetingId);
    const meetpilotStatus = toMeetpilotStatus(meeting.status);

    // 相關會議每則四樣缺一不可（信心值、共同題目、判定理由、那場會的結論）。
    // **只讀對方的 Meeting／Analysis，不動對方的檔案**：不 cascade 投影連結到的會議，
    // 也不去讀或改對方的 link_run——那正是 AC-3 要擋的「舊會議那一側被誤寫成剛重新計算過」。
    // 對方若還沒被投影過（尚未有檔案），wikilink 用同一套檔名規則預先算出目標檔名；
    // 在 Obsidian 裡會先顯示未解析，等那場會自己被投影後才接上（W5 已知的範圍邊界，見 plan）。
    //
    // **對方的資料讀不到或壞掉時，只跳過那一則關聯，不讓它拖垮這場會自己的投影**（code review
    // 2026-09-18：原本 `store.getAnalysis(otherId)` 對 contract_version 不是 2 的資料會直接
    // 拋錯，而這裡的拋錯發生在 `.map()` 裡，會讓整個 `project(meetingId)` 連同這場會自己完全
    // 合法的結論／待辦都寫不出來，而且是永久性的——只要那筆壞掉的關聯還在，這場會每次投影都會
    // 撞同一個錯。壞掉的是對方的資料，不該連坐這場會自己的內容；錯誤仍然大聲記在 log 裡，不吞。
    const related: RelatedMeetingRender[] = [];
    for (const link of links) {
      const otherId = link.meeting_a === meetingId ? link.meeting_b : link.meeting_a;
      try {
        const otherMeeting = store.getMeeting(otherId);
        const otherAnalysis = store.getAnalysis(otherId);
        if (!otherMeeting || !otherAnalysis) {
          throw new Error('那場會沒有 Meeting 或分析資料');
        }
        const existingOtherPath = index.get(otherId);
        const displayName = existingOtherPath
          ? basename(existingOtherPath, '.md')
          : buildFileStem(otherMeeting.created_at, otherMeeting.title ?? otherAnalysis.overview);
        related.push({
          displayName,
          confidence: link.confidence,
          sharedTopics: link.shared_topics,
          evidence: link.evidence,
          decisions: otherAnalysis.decisions,
        });
      } catch (err) {
        console.error(
          `[VaultProjector] Meeting ${meetingId} 關聯到 ${otherId}，但讀那場會的資料時出錯，`
          + '這則關聯先跳過、其餘內容照常投影：',
          err,
        );
      }
    }

    // 失敗原因讀 meeting.error 不是 linkRun.error：前者是狀態機自己對 LINK_FAILED 的權威欄位
    // （SDD 1.4，setStatus 的 keepsError 規則強制它跟 LINK_FAILED 綁在一起），topicLinker 目前
    // 把兩者寫成同一個字串，但 meeting.error 是「為什麼這場沒關聯到」唯一保證有值的那一個
    const relatedSection = renderRelatedMeetingsSection(
      meetpilotStatus, related, meeting.error, meetingId,
    );

    const systemRegion = renderSystemRegion({
      title,
      decisions: analysis.decisions,
      actionItems: analysis.action_items,
      openQuestions: analysis.open_questions,
      topics: analysis.topics,
      topicTags,
      relatedSection,
      seamReport,
      needsReview,
    });
    const autoChecksum = computeChecksum(systemRegion);
    const generatedAt = new Date(now()).toISOString();
    const meetingDate = new Date(meeting.created_at).toISOString().slice(0, 10);
    const linkAlgoVersion = linkRun?.algo_version ?? LINK_ALGO_VERSION;

    /** 三個分支都要 buildFrontmatter + writeAtomic，這裡收成一個小助手，欄位只在一個地方組 */
    const writeProjection = (path: string, manualRegionRaw: string, manualSyntaxVersion: number): void => {
      const frontmatter = buildFrontmatter({
        meetpilotId: meetingId, meetingDate, durationMinutes, meetpilotStatus, linkAlgoVersion,
        manualSyntaxVersion, generatedAt, autoChecksum,
      });
      writeAtomic(path, assembleFile(frontmatter, systemRegion, manualRegionRaw));
    };

    const existingPath = index.get(meetingId);

    // 從沒投影過：檔名現在才決定，之後系統永不更改（SDD 1.3.1〈檔名與身分〉）
    if (!existingPath) {
      const stem = buildFileStem(meeting.created_at, title);
      let path = join(vaultDir, `${stem}.md`);
      if (existsSync(path)) {
        // 同一分鐘、標題正規化後撞名：這個檔名已經有別的內容佔著（通常是另一場會，也可能是人
        // 自己放的筆記），不能不驗證就蓋過去——那正是「同一個 id 永遠對到同一個檔」這個不變量
        // 要擋的事，只是這次是反過來（同一個檔名對到兩個不同的 id）。加短 id 後綴消歧義，
        // 不猜哪一份對（code review 2026-09-18）
        path = join(vaultDir, `${stem} (${meetingId.slice(0, 8)}).md`);
      }
      writeProjection(path, '', MANUAL_SYNTAX_VERSION);
      return { status: 'written', path };
    }

    // 已經投影過：驗證系統區沒被人動過，才能安全整份重寫
    const existingRaw = readVaultFile(existingPath);
    const existingChecksum = extractFrontmatterField(existingRaw, 'auto_checksum');
    const existingSystemRegion = extractSystemRegion(existingRaw);
    const systemRegionIntact = existingSystemRegion !== null
      && existingChecksum !== null
      && computeChecksum(existingSystemRegion) === existingChecksum;

    if (!systemRegionIntact) {
      // 不覆寫：現有檔案（含它的人工區）先整份另存，再寫新版到原檔名（SDD 1.3.1〈系統區被人改動時〉）
      const conflictSuffix = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const conflictPath = `${existingPath.slice(0, -3)}${CONFLICT_INFIX}${conflictSuffix}.md`;
      renameSync(existingPath, conflictPath);
      writeProjection(existingPath, '', MANUAL_SYNTAX_VERSION);
      return { status: 'conflict', path: existingPath, conflictPath };
    }

    // 正常路徑：系統區整份重寫，人工區原樣保留（不解析、不動內容，那是 W6 的事）
    const manualRegionRaw = extractManualRegion(existingRaw);
    const manualSyntaxVersionRaw = extractFrontmatterField(existingRaw, 'manual_syntax_version');
    // 讀不到或不是乾淨整數（例如人手動改壞）一律退回目前版本，不把 NaN 寫回檔案（code review
    // 2026-09-18）：這個欄位是系統自己要保持乾淨給 W6 讀的契約，寫進一個非數字的值是自己汙染自己
    const parsedManualSyntaxVersion = manualSyntaxVersionRaw !== null ? Number(manualSyntaxVersionRaw) : NaN;
    const manualSyntaxVersion = Number.isInteger(parsedManualSyntaxVersion)
      ? parsedManualSyntaxVersion
      : MANUAL_SYNTAX_VERSION;

    writeProjection(existingPath, manualRegionRaw, manualSyntaxVersion);
    return { status: 'written', path: existingPath };
  };

  return { project };
};

export type VaultProjector = ReturnType<typeof createVaultProjector>;

/**
 * 呼叫端共用的「投影並記 log」小工具（4 個呼叫點都要一樣的行為，抽出來避免各自漏寫）。
 *
 * 原本每個呼叫點都是 `if (vaultProjector) { try { vaultProjector.project(id) } catch { log } }`，
 * 把回傳值直接丟掉——`status: 'conflict'` 因此完全不會被記錄，只有真的拋出例外才留得下痕跡
 * （code review 2026-09-18〈altitude〉：conflict 的訊號被呼叫端自己弄丟了，使用者除了在 vault
 * 裡發現一個沒人跟他說過的 `.conflict-*.md` 檔之外，沒有任何管道知道系統改動過他的檔案）。
 *
 * `vaultProjector` 可以是 `null`（測試不需要驗證投影行為時不用注入一個真的），是的話整支是 no-op。
 */
export const runProjection = (
  vaultProjector: VaultProjector | null | undefined,
  meetingId: string,
  logPrefix: string,
): void => {
  if (!vaultProjector) return;
  try {
    const result = vaultProjector.project(meetingId);
    if (result.status === 'conflict') {
      console.warn(
        `${logPrefix} Meeting ${meetingId} 投影時發現系統區被人改過，`
        + `舊版已另存 ${result.conflictPath}，新版寫進 ${result.path}`,
      );
    }
  } catch (projectErr) {
    console.error(`${logPrefix} Meeting ${meetingId} 投影到 vault 時拋出錯誤`, projectErr);
  }
};

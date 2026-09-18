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
import { ActionItemV2 } from './analysisContract';
import { MeetingStatus } from './meetingState';
import { MeetingStore } from './meetingStore';
import { LINK_ALGO_VERSION } from './topicLink';
import { TopicTag } from './topicTag';

const DEFAULT_VAULT_DIR = join(homedir(), 'MeetPilot Vault');

/**
 * `MEETPILOT_VAULT` 未設定時用 `~/MeetPilot Vault`（D-014，使用者 2026-09-14 裁決）。
 * 不放進 `/Users/vincent/AI Memory`：那個 vault 的 `vault-check.py` 對會議 markdown 有三條
 * 硬衝突（`status` 合法值、`INDEX_MIN`、遞迴全掃無排除清單），細節見 SDD 1.3.1〈落地位置〉。
 */
export const resolveVaultDir = (env: NodeJS.ProcessEnv): string => {
  const raw = (env.MEETPILOT_VAULT ?? '').trim();
  if (!raw) return DEFAULT_VAULT_DIR;
  return raw.startsWith('~') ? resolve(join(homedir(), raw.slice(1))) : resolve(raw);
};

const AUTO_START = '<!-- meetpilot:auto:start 這一區每次由系統整份重寫，改了會被蓋掉 -->';
const AUTO_END = '<!-- meetpilot:auto:end -->';
const MANUAL_START = '<!-- meetpilot:manual:start -->';
const MANUAL_END = '<!-- meetpilot:manual:end -->';
/** 排除 conflict 副本用。副本的 frontmatter 帶著跟原檔一樣的 meetpilot_id，掃描時不能算進索引 */
const CONFLICT_INFIX = '.conflict-';
const MANUAL_SYNTAX_VERSION = 1;

/**
 * 標題取 overview 前 30 字，移除路徑與 wikilink 會壞掉的字元與前後空白（SDD 1.3.1〈檔名與身分〉）。
 * `[` `]` 不在 SDD 列的字集裡，但留著會讓 `[[<標題>]]` 這個 wikilink 本身斷掉，所以一併移除。
 */
export const sanitizeTitle = (overview: string): string =>
  overview.slice(0, 30).replace(/[/\\:*?"<>|[\]]/g, '').trim() || '未命名會議';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 檔名：`YYYY-MM-DD HHmm <標題>.md`（SDD 1.3.1）。**決定時機：首次寫入時，之後系統永不更改**
 * ——呼叫端只在「這場會第一次投影」時用它，已經投影過的一律沿用索引查到的既有檔名。
 *
 * 用 UTC 元件算，不用系統時區：同一個 `created_at` 在任何機器上、任何時候都算出同一個檔名，
 * 測試才不會因為跑測試的機器時區不同而得到不同結果。
 */
export const buildFileName = (createdAtMs: number, title: string): string => {
  const d = new Date(createdAtMs);
  const stamp = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  return `${stamp} ${sanitizeTitle(title)}.md`;
};

/** frontmatter 的 `auto_checksum`：系統區內容（AUTO_START 與 AUTO_END 之間，不含標記本身）的 sha256 */
export const computeChecksum = (systemRegion: string): string =>
  `sha256:${createHash('sha256').update(systemRegion, 'utf8').digest('hex')}`;

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

const ACTION_ITEM_STATUS_LABEL: Record<ActionItemV2['status'], string> = {
  unknown: '狀態不明',
  open: '待處理',
  done: '已完成',
};

interface RelatedMeetingRender {
  displayName: string;
  confidence: number;
  sharedTopics: readonly string[];
  evidence: string;
  decisions: readonly string[];
}

/**
 * `## 相關會議` 段。**空集合與未完成絕不可以寫成同一句話**（SDD 1.3.1，2.3 的「不會有人發現的
 * 壞法」）：`linking` 是「還沒算」，`linked` 加空陣列是「算過了，沒有同題目的會」，
 * `link_failed` 要帶原因與重試方式。
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
    .map((r) => [
      `- [[${r.displayName}]]（信心 ${r.confidence.toFixed(2)}）`,
      `  - 共同題目：${r.sharedTopics.join('、')}`,
      `  - 判定理由：${r.evidence}`,
      `  - 那場會的結論：${r.decisions.length > 0 ? r.decisions.join('；') : '（那場會沒有結論）'}`,
    ].join('\n'))
    .join('\n');
};

const renderTopicTagsSection = (tags: readonly TopicTag[]): string =>
  tags.length > 0
    ? tags.map((t) => `- ${t.title}${t.source === 'manual' ? '（人工修正）' : ''}`).join('\n')
    : '（沒有抽到題目標籤）';

const renderDecisionsSection = (decisions: readonly string[]): string =>
  decisions.length > 0 ? decisions.map((d) => `- ${d}`).join('\n') : '（沒有結論）';

/** `unknown` 照 D-004 原樣顯示為「狀態不明」，不補成待處理（SDD 1.3.1〈各段的內容與來源〉） */
const renderActionItemsSection = (items: readonly ActionItemV2[]): string =>
  items.length > 0
    ? items.map((it) => `- ${it.text}（狀態：${ACTION_ITEM_STATUS_LABEL[it.status]}）`).join('\n')
    : '（沒有待辦）';

const renderTopicsSection = (topics: readonly { title: string; content: string }[]): string =>
  topics.length > 0
    ? topics.map((t) => `### ${t.title}\n${t.content}`).join('\n\n')
    : '（沒有討論題目）';

interface SystemRegionInput {
  title: string;
  decisions: readonly string[];
  actionItems: readonly ActionItemV2[];
  topics: readonly { title: string; content: string }[];
  topicTags: readonly TopicTag[];
  relatedSection: string;
}

/** 系統區的完整內容（純函式，不含 I/O），也是 `auto_checksum` 要雜湊的那段文字 */
export const renderSystemRegion = (input: SystemRegionInput): string => [
  `# ${input.title}`,
  '',
  '## 結論',
  renderDecisionsSection(input.decisions),
  '',
  '## 待辦',
  renderActionItemsSection(input.actionItems),
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
 * 掃整個 vault，建 `meetpilot_id → path` 的索引（SDD 1.3.1〈找檔方式〉：一律靠 id，不靠檔名）。
 *
 * **每次 `project()` 都重掃，不是只在建構時掃一次快取。** vault 預期量級一年約 1,040 個檔（SDD
 * 6.4），逐檔只讀 frontmatter 那幾行，掃一次是毫秒級；換來的是人在 Obsidian 更名後不用重啟
 * server 就找得到，而且外部（人手動複製）造成的同 id 兩檔能在下一次投影就抓到，不用等重啟。
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
    const raw = readFileSync(path, 'utf8');
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

/** 先寫暫存檔再原子 rename（同 audioFileStore 的寫入慣例）。同一個 vault 可能同時開著 Obsidian，非原子寫入會讓它讀到截斷的檔 */
const writeAtomic = (path: string, content: string): void => {
  const partPath = `${path}.${randomUUID()}.part`;
  try {
    writeFileSync(partPath, content, 'utf8');
    renameSync(partPath, path);
  } catch (err) {
    rmSync(partPath, { force: true });
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
  /** 測試注入用；正式呼叫不要傳 */
  now?: () => number;
}

export const createVaultProjector = (deps: VaultProjectorDeps) => {
  const { store, vaultDir } = deps;
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
    const title = sanitizeTitle(analysis.overview);

    const transcript = store.getTranscript(meetingId);
    const durationMinutes = transcript && transcript.segments.length > 0
      ? Math.round(Math.max(...transcript.segments.map((s) => s.end)) / 60)
      : null;

    const links = store.getLinks(meetingId);
    const linkRun = store.getLinkRun(meetingId);
    const topicTags = store.getTopicTags(meetingId);
    const meetpilotStatus = toMeetpilotStatus(meeting.status);

    // 相關會議每則四樣缺一不可（信心值、共同題目、判定理由、那場會的結論）。
    // **只讀對方的 Meeting／Analysis，不動對方的檔案**：不 cascade 投影連結到的會議，
    // 也不去讀或改對方的 link_run——那正是 AC-3 要擋的「舊會議那一側被誤寫成剛重新計算過」。
    // 對方若還沒被投影過（尚未有檔案），wikilink 用同一套檔名規則預先算出目標檔名；
    // 在 Obsidian 裡會先顯示未解析，等那場會自己被投影後才接上（W5 已知的範圍邊界，見 plan）
    const related: RelatedMeetingRender[] = links.map((link) => {
      const otherId = link.meeting_a === meetingId ? link.meeting_b : link.meeting_a;
      const otherMeeting = store.getMeeting(otherId);
      const otherAnalysis = store.getAnalysis(otherId);
      if (!otherMeeting || !otherAnalysis) {
        throw new Error(
          `Meeting ${meetingId} 關聯到 ${otherId}，但那場會沒有 Meeting 或分析資料，資料不一致`,
        );
      }
      const existingOtherPath = index.get(otherId);
      const displayName = existingOtherPath
        ? basename(existingOtherPath, '.md')
        : buildFileName(otherMeeting.created_at, otherAnalysis.overview).replace(/\.md$/, '');
      return {
        displayName,
        confidence: link.confidence,
        sharedTopics: link.shared_topics,
        evidence: link.evidence,
        decisions: otherAnalysis.decisions,
      };
    });

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
      topics: analysis.topics,
      topicTags,
      relatedSection,
    });
    const autoChecksum = computeChecksum(systemRegion);
    const generatedAt = new Date(now()).toISOString();
    const meetingDate = new Date(meeting.created_at).toISOString().slice(0, 10);
    const linkAlgoVersion = linkRun?.algo_version ?? LINK_ALGO_VERSION;

    const existingPath = index.get(meetingId);

    // 從沒投影過：檔名現在才決定，之後系統永不更改（SDD 1.3.1〈檔名與身分〉）
    if (!existingPath) {
      const path = join(vaultDir, buildFileName(meeting.created_at, title));
      const frontmatter = buildFrontmatter({
        meetpilotId: meetingId, meetingDate, durationMinutes, meetpilotStatus, linkAlgoVersion,
        manualSyntaxVersion: MANUAL_SYNTAX_VERSION, generatedAt, autoChecksum,
      });
      writeAtomic(path, assembleFile(frontmatter, systemRegion, ''));
      return { status: 'written', path };
    }

    // 已經投影過：驗證系統區沒被人動過，才能安全整份重寫
    const existingRaw = readFileSync(existingPath, 'utf8');
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
      const frontmatter = buildFrontmatter({
        meetpilotId: meetingId, meetingDate, durationMinutes, meetpilotStatus, linkAlgoVersion,
        manualSyntaxVersion: MANUAL_SYNTAX_VERSION, generatedAt, autoChecksum,
      });
      writeAtomic(existingPath, assembleFile(frontmatter, systemRegion, ''));
      return { status: 'conflict', path: existingPath, conflictPath };
    }

    // 正常路徑：系統區整份重寫，人工區原樣保留（不解析、不動內容，那是 W6 的事）
    const manualRegionRaw = extractManualRegion(existingRaw);
    const manualSyntaxVersionRaw = extractFrontmatterField(existingRaw, 'manual_syntax_version');
    const manualSyntaxVersion = manualSyntaxVersionRaw !== null
      ? Number(manualSyntaxVersionRaw)
      : MANUAL_SYNTAX_VERSION;

    const frontmatter = buildFrontmatter({
      meetpilotId: meetingId, meetingDate, durationMinutes, meetpilotStatus, linkAlgoVersion,
      manualSyntaxVersion, generatedAt, autoChecksum,
    });
    writeAtomic(existingPath, assembleFile(frontmatter, systemRegion, manualRegionRaw));
    return { status: 'written', path: existingPath };
  };

  return { project };
};

export type VaultProjector = ReturnType<typeof createVaultProjector>;

/**
 * TopicLink 的契約、門檻與純函式（W4，SDD 1.1／1.2／1.3 的 `C-TOPICLINK` v1、`FN-04`）。
 *
 * 這個檔不 import 任何帶 node 依賴的東西：`meetingApi.ts` 讀這裡的型別，而那個檔前端也 import
 * （理由同 `topicTag.ts` 與 `meetingState.ts`）。
 *
 * **關聯不是字串比對。** W3 實測：五場會 91 條標籤，跨會議完全相同的 `match_key` 0 個，
 * 當字串做 bigram jaccard 沒有任何一對超過 0.5，而已知逐條對應的兩場會最高只有 0.211。
 * 所以 `match_key` 在這裡沒有角色，它只是同一場會內的去重鍵；跨會議走的是 embedding。
 */

/**
 * 兩段式的版本號。**任何一段改了就要換**：S2 的門檻、S3 的 prompt、判定規則、embedding model。
 *
 * 不是形式：SDD 2.4 寫「重算是 idempotent 的，前提是演算法版本相同；版本不同時產出不同結果」。
 * 版本沒跟著結果落地的話，兩個版本算出來的 Link 會混在同一張表裡，而那不會有任何錯誤訊息，
 * 只會讓人看到兩套標準產生的關聯並排在同一個畫面上。
 *
 * 命名沿用 SDD 1.3.1 vault frontmatter 的 `link_algo_version: s2+s3-v1`。
 */
export const LINK_ALGO_VERSION = 's2+s3-v1';

/**
 * S2（召回）與 S3（判定）的門檻。**2026-09-15 使用者裁決，改它是 SDD 4.1 的 L3 變更**，
 * 必要證據是對固定評測集的前後比較，不是改一個數字。
 *
 * 依據（U-001 第三輪，`MeetPilot · 團隊知識回流 Gate B 收斂`）：
 * - S2(tag>=0.7, hits>=3) 單獨跑是 P 0.750 / R **1.000**——不漏任何正例，正好適合當召回端
 * - S3(conf>=0.5) 單獨跑是 P **1.000** / R 0.667——不錯判，適合當判定端
 *
 * **S2 篩掉的 pair，S3 永遠看不到**，所以這裡放寬一格的代價是 LLM 呼叫量，放緊一格的代價是
 * 永久漏報。兩段式這個組合本身還沒有被評測過（AC-1b），在它被量到之前，這一組數字的依據
 * 只到「兩段各自單獨跑」為止。
 */
export const S2_TAG_THRESHOLD = 0.7;
export const S2_MIN_HITS = 3;
export const S3_CONFIDENCE_THRESHOLD = 0.5;

/**
 * 一場會最多送幾對去 S3。
 *
 * 一年約 1,040 場會，S2 過門檻的候選數沒有上界，而每一對候選就是一次 LLM 呼叫。
 * 上限本身不是問題，**上限造成的遺漏不落地才是**：被砍掉的那幾對與「本來就沒有更多候選」
 * 在畫面上長得一模一樣。所以 `LinkRun.skipped_cap` 一定要寫出來。
 */
export const LINK_CANDIDATE_LIMIT = 20;

/**
 * 人標記不相關的原因。前三個對到 SDD 6.3 的三分類，處置各不相同。
 *
 * `unspecified` 是誠實的第四種：人工區沒寫原因、或寫了不認得的字，就記這個值。
 * 猜一個填進去的話，6.3 的分類統計會被編造的資料稀釋，而那份統計是判斷關聯品質的唯一線上訊號。
 */
export type LinkExclusionReason = 'different_topic' | 'outdated' | 'not_needed' | 'unspecified';

export const LINK_EXCLUSION_REASONS: readonly LinkExclusionReason[] = [
  'different_topic', 'outdated', 'not_needed', 'unspecified',
];

export const isLinkExclusionReason = (value: unknown): value is LinkExclusionReason =>
  typeof value === 'string' && (LINK_EXCLUSION_REASONS as readonly string[]).includes(value);

/** 一筆關聯（`C-TOPICLINK` v1）。兩端一律正規化排序，見 orderPair */
export interface TopicLink {
  link_id: string;
  meeting_a: string;
  meeting_b: string;
  /** S3 給的信心值，0 到 1 */
  confidence: number;
  /**
   * 判定理由原文。SDD 1.3.1 的 vault markdown 逐則列它。
   *
   * **不能只存信心值**（`FN-04` 驗收條件）：人只看得到一個數字時無從判斷該不該標不相關，
   * 6.3 的回饋訊號就退化成擲骰子。
   */
  evidence: string;
  /** 共同題目的名稱。markdown 的「共同題目」那一行 */
  shared_topics: string[];
  algo_version: string;
  created_at: number;
}

/** 一筆排除紀錄。**Link 可全量重建，這個不可**，所以分開存（SDD 1.2／1.5） */
export interface LinkExclusion {
  meeting_a: string;
  meeting_b: string;
  reason_code: LinkExclusionReason;
  created_at: number;
}

/**
 * 一場會最近一次關聯計算的覆蓋率。
 *
 * **為什麼要有這張紀錄**：`LINK_CANDIDATE_LIMIT` 本來就讓「判的比候選少」變成常態，而撞到
 * Gemini 每日額度只是同一件事的另一個原因。沒有這份紀錄的話，「這就是全部的關聯」與
 * 「只跑了一半」在資料上完全一樣。
 *
 * **三種沒判到的原因分開數**，不合成一個數字：
 * - `skipped_cap` 丟掉的是分數最低那幾對，是刻意的
 * - `skipped_excluded` 是人標過不相關的，那是人的判斷不是系統的遺漏
 * - `skipped_error` 是還沒輪到就撞牆的，哪幾對取決於順序，等於隨機
 */
export interface LinkRun {
  meeting_id: string;
  algo_version: string;
  /** S2 過門檻的對數（排除與上限都還沒套用） */
  candidates: number;
  /** 真的送去 S3 判過的對數 */
  judged: number;
  /** 因為 LINK_CANDIDATE_LIMIT 沒送的對數 */
  skipped_cap: number;
  /** 因為人標過不相關而沒送的對數 */
  skipped_excluded: number;
  /** 因為 S3 呼叫失敗（通常是額度）而沒送的對數 */
  skipped_error: number;
  /**
   * 因為 embedding 的 model 或維度對不上而沒被比到的標籤對數。
   *
   * 正常永遠是 0：換 model 之後舊向量會被重算（見 MeetingStore.listTagsNeedingVectors）。
   * 不是 0 就代表這一次的相似度分數是不完整的，而不完整最常見的結局是「一個候選都沒有」
   * ——跟「真的沒有同題目的會」在資料上分不出來。這一欄就是那條分界線
   */
  incomparable_pairs: number;
  /** skipped_error > 0 時的第一個錯誤原因，其餘是 null */
  error: string | null;
  created_at: number;
}

/** 一條標籤的向量。model 與維度跟著每一筆走，理由見 canCompare */
export interface TagVector {
  tag_id: string;
  title: string;
  vector: number[];
  model: string;
  dimensions: number;
}

/**
 * 兩端正規化排序：字典序小的當 a。
 *
 * 不排序的話同一對會存成兩列（A×B 與 B×A），而去重、排除比對、重算刪除三個地方都要各寫一次
 * 雙向判斷，漏掉任何一處都是安靜地多一筆或少刪一筆。資料庫那層有 `CHECK (meeting_a < meeting_b)`
 * 兜著，繞過這個函式直接寫會被擋下來。
 */
export const orderPair = (x: string, y: string): [string, string] => {
  if (x === y) throw new Error(`關聯的兩端不能是同一場會：${x}`);
  return x < y ? [x, y] : [y, x];
};

export const pairKey = (x: string, y: string): string => orderPair(x, y).join('|');

/**
 * 兩個向量能不能比。**model 或維度不同就不比**，不是「相似度低」。
 *
 * 不同 model 的向量空間沒有任何關係，硬算 cosine 會回一個看起來很正常的小數字，
 * 而那個數字的意思是「不知道」。把它當成 0.1 的相似度，結果是兩場本來對得上的會安靜地對不上
 * ——跟 `MATCH_KEY_VERSION` 要防的是同一種壞法，所以用同一種解法：版本存在每一列旁邊。
 */
export const canCompare = (a: TagVector, b: TagVector): boolean =>
  a.model === b.model && a.dimensions === b.dimensions && a.vector.length === b.vector.length;

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) throw new Error(`向量長度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export interface PairScore {
  /** 相似度達門檻的標籤對數 */
  hits: number;
  /** 最高的那一對的相似度。一對都沒有時是 0 */
  best: number;
  /** 最高的那一對是哪兩條標籤，給 evidence 用。一對都沒有時是 null */
  bestPair: { a: string; b: string } | null;
  /** model 或維度對不上、因此沒有比的標籤對數。>0 代表這一對的分數是不完整的 */
  incomparable: number;
}

/**
 * S2：兩場會的標籤兩兩算 cosine，數有幾對達門檻。判準與 `eval/strategies/s2-embedding.ts` 相同
 * （至少 minHits 對 >= tagThreshold），讓這裡的數字跟第三輪評測的數字可以直接比。
 *
 * 純函式，向量從外面餵進來：S2 的判準要測得動，不能綁著一次真實的 embedding 呼叫。
 */
export const scorePair = (
  tagsA: readonly TagVector[],
  tagsB: readonly TagVector[],
  tagThreshold: number = S2_TAG_THRESHOLD,
): PairScore => {
  let hits = 0;
  let best = 0;
  let bestPair: { a: string; b: string } | null = null;
  let incomparable = 0;

  for (const a of tagsA) {
    for (const b of tagsB) {
      if (!canCompare(a, b)) {
        incomparable += 1;
        continue;
      }
      const sim = cosine(a.vector, b.vector);
      if (sim >= tagThreshold) hits += 1;
      if (sim > best) {
        best = sim;
        bestPair = { a: a.title, b: b.title };
      }
    }
  }
  return { hits, best, bestPair, incomparable };
};

export interface Candidate {
  meeting_id: string;
  score: PairScore;
}

export interface CandidateSelection {
  /** 要送去 S3 的，已經照分數排好 */
  selected: Candidate[];
  /** 過了 S2 門檻但超出上限而沒送的 */
  droppedByCap: Candidate[];
  /** 過了 S2 門檻但人標過不相關而沒送的 */
  excluded: Candidate[];
}

/**
 * 選候選：S2 過門檻 → 扣掉排除紀錄 → 照分數排序 → 套上限。
 *
 * **排除在上限之前扣掉**。順序反過來的話，人標過不相關的那幾對會佔掉上限的名額，
 * 把真正該判的擠出去——標記不相關反而讓關聯變差，那是最不該有的行為。
 *
 * 排序鍵明寫到唯一為止（分數、命中數、meeting_id）：只用分數排的話，同分的兩場會誰進上限
 * 未定義，而「它看起來是穩定的」正是 AC-5 要求的 idempotent 會安靜失效的地方。
 */
export const selectCandidates = (
  scored: readonly Candidate[],
  isExcluded: (meetingId: string) => boolean,
  limit: number = LINK_CANDIDATE_LIMIT,
  minHits: number = S2_MIN_HITS,
): CandidateSelection => {
  const passed = scored.filter((c) => c.score.hits >= minHits);
  const excluded = passed.filter((c) => isExcluded(c.meeting_id));
  const remaining = passed
    .filter((c) => !isExcluded(c.meeting_id))
    .sort((x, y) =>
      y.score.best - x.score.best
      || y.score.hits - x.score.hits
      || (x.meeting_id < y.meeting_id ? -1 : x.meeting_id > y.meeting_id ? 1 : 0));

  return {
    selected: remaining.slice(0, limit),
    droppedByCap: remaining.slice(limit),
    excluded,
  };
};

/** S3 回來的判定。`same` 與 `confidence` 分開：模型說同題目但信心 0.3 時，要看得出是門檻擋下來的 */
export interface PairJudgement {
  sameTopic: boolean;
  confidence: number;
  reason: string;
  sharedTopics: string[];
}

/**
 * 組出要落地的 evidence。S2 的命中數與 S3 的理由都寫進去：
 * 只留 S3 的話，之後查「為什麼這一對會被送去判」就沒有線索；只留 S2 的話，那是
 * 「哪兩條標籤最像」而不是判定理由，人沒辦法據此否決（`FN-04` 驗收條件）。
 */
export const composeEvidence = (score: PairScore, judgement: PairJudgement): string => {
  const s2 = score.bestPair
    ? `S2：${score.hits} 對標籤達門檻，最高「${score.bestPair.a}」×「${score.bestPair.b}」= ${score.best.toFixed(3)}`
    : `S2：${score.hits} 對標籤達門檻`;
  const warn = score.incomparable > 0
    ? `（有 ${score.incomparable} 對因為 embedding model 或維度不同沒有比到）`
    : '';
  return `${s2}${warn}｜S3：信心 ${judgement.confidence.toFixed(2)}，${judgement.reason}`;
};

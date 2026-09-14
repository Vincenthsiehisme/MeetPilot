// U-001（跨會議題目關聯做不做得準）離線評測的型別。
// 設計文件：vault 的 `MeetPilot · 團隊知識回流 Gate B 收斂` 的 P1 節。

/** 一場實體會議。一場會可能來自多個音檔（錄音被切斷），所以 sources 是陣列。 */
export interface EvalMeeting {
  id: string;
  /** 逐字稿檔名，相對於 eval-data/transcripts/。多個檔代表同一場會被切成多段，依序串接。 */
  sources: string[];
  /** 給人看的簡述，不參與計算。 */
  label: string;
}

/** 一個 Topic Tag。source 區分它是人工判讀的還是 Gemini 解析的。 */
export interface TopicTag {
  title: string;
  /** 補充內容；S2 的 embedding 會用到，S1 只看 title。 */
  content?: string;
  source: 'manual' | 'auto';
}

/** 一場會的 Topic Tag 集合。 */
export interface MeetingTopics {
  meetingId: string;
  tags: TopicTag[];
}

/** 黃金答案的標記。unknown 的 pair 不列入指標計算。 */
export type GoldLabel = 'same' | 'different' | 'unknown';

export interface GoldPair {
  a: string;
  b: string;
  label: GoldLabel;
  /** 為什麼這樣標。unknown 一定要寫清楚缺什麼證據。 */
  note: string;
}

/** 一個策略對單一 pair 的判定。 */
export interface PairVerdict {
  a: string;
  b: string;
  /** 策略判定為同題目。 */
  same: boolean;
  /** 0–1，越高越相關。沒有連續分數的策略回傳 0 或 1。 */
  score: number;
  /** 判定依據，人看得懂的一句話。誤判時靠它看出錯在哪。 */
  evidence: string;
}

export interface Strategy {
  id: string;
  describe(): string;
  /** 對所有 pair 給出判定。門檻由策略自己持有。 */
  run(topics: MeetingTopics[], pairs: { a: string; b: string }[]): Promise<PairVerdict[]>;
}

export interface Metrics {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  /** 分母為 0 時為 null，不是 0。「沒有東西可算」與「算出來是零」不是同一件事。 */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** 列入計算的 pair 數，不含 unknown。 */
  evaluated: number;
  /** 被排除的 unknown pair 數。 */
  skipped: number;
}

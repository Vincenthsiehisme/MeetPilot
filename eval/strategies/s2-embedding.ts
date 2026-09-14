import { EMBEDDING_MODEL, requireClient } from '../lib/client';
import type { MeetingTopics, PairVerdict, Strategy } from '../lib/types';

function cosine(a: number[], b: number[]): number {
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
}

/**
 * S2：標籤 embedding 的 cosine 相似度。
 *
 * 它是三個策略裡唯一能把「門檻」變成連續可掃的東西，所以它產出的曲線是使用者
 * 裁決 N-01、N-02 的主要材料。
 *
 * 每個標籤取 title 加 content 的 embedding。兩個 Meeting 判為同題目的條件與 S1 相同：
 * 至少 minHits 對標籤的相似度 >= tagThreshold，讓兩者的數字可以直接比。
 */
export class EmbeddingStrategy implements Strategy {
  readonly id: string;
  /** 同一批標籤在掃門檻時會被重複用到，快取避免重複呼叫 API。 */
  private static vectors = new Map<string, number[]>();

  constructor(
    private readonly tagThreshold: number,
    private readonly minHits: number,
  ) {
    this.id = `S2(tag>=${tagThreshold},hits>=${minHits})`;
  }

  describe(): string {
    return `標籤 embedding cosine >= ${this.tagThreshold}，且至少 ${this.minHits} 對標籤命中`;
  }

  /** 先把所有標籤一次送去取 embedding，之後掃門檻就不再打 API。 */
  static async warm(topics: MeetingTopics[]): Promise<void> {
    const texts: string[] = [];
    for (const entry of topics) {
      for (const tag of entry.tags) {
        const key = EmbeddingStrategy.keyOf(tag.title, tag.content);
        if (!EmbeddingStrategy.vectors.has(key) && !texts.includes(key)) texts.push(key);
      }
    }
    if (texts.length === 0) return;

    const ai = requireClient();
    const BATCH = 50;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const response = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: batch });
      const embeddings = response.embeddings;
      if (!embeddings || embeddings.length !== batch.length) {
        throw new Error(`embedding 回傳 ${embeddings?.length ?? 0} 筆，送出 ${batch.length} 筆`);
      }
      embeddings.forEach((item, index) => {
        const values = item.values;
        if (!values || values.length === 0) throw new Error(`第 ${i + index} 筆 embedding 是空的`);
        EmbeddingStrategy.vectors.set(batch[index], values);
      });
    }
  }

  private static keyOf(title: string, content?: string): string {
    return content && content.trim().length > 0 ? `${title}。${content}` : title;
  }

  async run(topics: MeetingTopics[], pairs: { a: string; b: string }[]): Promise<PairVerdict[]> {
    const byId = new Map(topics.map((t) => [t.meetingId, t]));
    const vectorsOf = (meetingId: string) => {
      const entry = byId.get(meetingId);
      if (!entry) throw new Error(`找不到 ${meetingId} 的 Topic Tag`);
      return entry.tags.map((tag) => {
        const key = EmbeddingStrategy.keyOf(tag.title, tag.content);
        const vector = EmbeddingStrategy.vectors.get(key);
        if (!vector) throw new Error(`標籤「${tag.title}」沒有 embedding，先呼叫 EmbeddingStrategy.warm()`);
        return { title: tag.title, vector };
      });
    };

    return pairs.map(({ a, b }) => {
      const hits: { a: string; b: string; sim: number }[] = [];
      for (const tagA of vectorsOf(a)) {
        for (const tagB of vectorsOf(b)) {
          const sim = cosine(tagA.vector, tagB.vector);
          if (sim >= this.tagThreshold) hits.push({ a: tagA.title, b: tagB.title, sim });
        }
      }
      hits.sort((x, y) => y.sim - x.sim);
      const best = hits[0];
      return {
        a,
        b,
        same: hits.length >= this.minHits,
        score: best ? best.sim : 0,
        evidence: best
          ? `${hits.length} 對命中，最高「${best.a}」×「${best.b}」= ${best.sim.toFixed(3)}`
          : '沒有任何一對標籤達到門檻',
      };
    });
  }
}

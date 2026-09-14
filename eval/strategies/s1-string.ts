import { bigrams, jaccard, normalize } from '../lib/normalize';
import type { MeetingTopics, PairVerdict, Strategy } from '../lib/types';

/**
 * S1：標籤字串正規化比對。零 API 成本、完全確定性、可解釋性最高。
 *
 * 它是 baseline：S2 與 S3 要贏過它，才值得為了關聯功能引入 embedding 或 LLM 呼叫。
 *
 * 兩個 Meeting 判為同題目的條件：至少 `minHits` 對標籤的 bigram Jaccard 相似度 >= `tagThreshold`。
 * 門檻設成建構參數而不是寫死，因為掃門檻畫出來的曲線才是給使用者裁決 N-01、N-02 的材料。
 */
export class StringMatchStrategy implements Strategy {
  readonly id: string;

  constructor(
    private readonly tagThreshold: number,
    private readonly minHits: number,
  ) {
    this.id = `S1(tag>=${tagThreshold},hits>=${minHits})`;
  }

  describe(): string {
    return `標籤字元 bigram Jaccard >= ${this.tagThreshold}，且至少 ${this.minHits} 對標籤命中`;
  }

  async run(topics: MeetingTopics[], pairs: { a: string; b: string }[]): Promise<PairVerdict[]> {
    const byId = new Map(topics.map((t) => [t.meetingId, t]));
    const cache = new Map<string, { title: string; grams: Set<string> }[]>();
    const gramsOf = (meetingId: string) => {
      const cached = cache.get(meetingId);
      if (cached) return cached;
      const entry = byId.get(meetingId);
      if (!entry) throw new Error(`找不到 ${meetingId} 的 Topic Tag`);
      const built = entry.tags
        .map((tag) => ({ title: tag.title, grams: bigrams(tag.title) }))
        .filter((t) => t.grams.size > 0);
      cache.set(meetingId, built);
      return built;
    };

    return pairs.map(({ a, b }) => {
      const hits: { a: string; b: string; sim: number }[] = [];
      for (const tagA of gramsOf(a)) {
        for (const tagB of gramsOf(b)) {
          const sim = jaccard(tagA.grams, tagB.grams);
          if (sim >= this.tagThreshold) {
            hits.push({ a: tagA.title, b: tagB.title, sim });
          }
        }
      }
      hits.sort((x, y) => y.sim - x.sim);
      const same = hits.length >= this.minHits;
      const best = hits[0];
      const evidence = best
        ? `${hits.length} 對命中，最高「${best.a}」×「${best.b}」= ${best.sim.toFixed(3)}`
        : '沒有任何一對標籤達到門檻';
      return { a, b, same, score: best ? best.sim : 0, evidence };
    });
  }
}

/** 完全相等變體：正規化後字串一模一樣才算命中。最保守的下界。 */
export class ExactMatchStrategy implements Strategy {
  readonly id = 'S1-exact';

  describe(): string {
    return '標籤正規化後完全相等才算命中，至少一對';
  }

  async run(topics: MeetingTopics[], pairs: { a: string; b: string }[]): Promise<PairVerdict[]> {
    const byId = new Map(
      topics.map((t) => [t.meetingId, t.tags.map((tag) => ({ raw: tag.title, norm: normalize(tag.title) }))]),
    );
    return pairs.map(({ a, b }) => {
      const tagsA = byId.get(a);
      const tagsB = byId.get(b);
      if (!tagsA || !tagsB) throw new Error(`找不到 ${a} 或 ${b} 的 Topic Tag`);
      const hits: string[] = [];
      for (const tagA of tagsA) {
        for (const tagB of tagsB) {
          if (tagA.norm.length > 0 && tagA.norm === tagB.norm) hits.push(tagA.raw);
        }
      }
      return {
        a,
        b,
        same: hits.length > 0,
        score: hits.length > 0 ? 1 : 0,
        evidence: hits.length > 0 ? `完全相等的標籤：${hits.join('、')}` : '沒有完全相等的標籤',
      };
    });
  }
}

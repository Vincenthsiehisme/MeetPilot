/**
 * TopicLinker（SDD 第 3 節 module 表、`FN-04`、流程 `F-LINK`）。
 *
 * TopicTag 進、TopicLink 出。兩段式：S2 用 embedding cosine 挑候選，S3 用 LLM 對候選產生
 * **給人看、人否決得掉的判定理由**。S3 只跑候選不跑全部 pair，SDD 6.4 擔心的平方成長因此緩解。
 *
 * **不變量**（SDD 第 3 節）：遵守排除紀錄；輸出必帶演算法版本與信心值；同一組輸入、同一版本
 * 重算兩次結果相同。**錯誤模式**：計算失敗回「未完成」（`LINK_FAILED`）而不是空集合——
 * 空集合的意思是「沒有相關會議」，那是一個結論，跟「我們沒算出來」不是同一件事。
 *
 * 這個 module 不碰 `process.env`，也不直接讀資料表（SDD 2.2 的禁止項），一律走 MeetingStore
 * 的讀取契約。
 */
import { GeminiServerClient } from './geminiServerClient';
import { LinkResult, MeetingStore, NewTopicLink } from './meetingStore';
import {
  Candidate,
  LINK_ALGO_VERSION,
  LINK_CANDIDATE_LIMIT,
  S2_MIN_HITS,
  S2_TAG_THRESHOLD,
  S3_CONFIDENCE_THRESHOLD,
  composeEvidence,
  pairKey,
  scorePair,
  selectCandidates,
} from './topicLink';

export interface TopicLinkerConfig {
  tagThreshold: number;
  minHits: number;
  confidenceThreshold: number;
  candidateLimit: number;
  algoVersion: string;
}

export const DEFAULT_LINKER_CONFIG: TopicLinkerConfig = {
  tagThreshold: S2_TAG_THRESHOLD,
  minHits: S2_MIN_HITS,
  confidenceThreshold: S3_CONFIDENCE_THRESHOLD,
  candidateLimit: LINK_CANDIDATE_LIMIT,
  algoVersion: LINK_ALGO_VERSION,
};

/**
 * `MEETPILOT_LINKING`：設 `off` 關掉跨會議關聯，其餘值（含未設）是開啟。
 *
 * SDD 4.2 要求 Recall 必須可以在**不重新部署**的情況下停用，那是 L3 rollback authority 的前提：
 * 關聯演算法出問題時，錯誤的關聯擺在人面前的每一分鐘都在消耗信任，而改碼重新部署不夠快。
 * 命名與 `MEETPILOT_LLM_LOG`／`MEETPILOT_SEAM_REPAIR` 的 off 一致。
 */
export const isLinkingEnabled = (env: NodeJS.ProcessEnv): boolean =>
  (env.MEETPILOT_LINKING ?? '').trim().toLowerCase() !== 'off';

export interface TopicLinkerDeps {
  store: MeetingStore;
  gemini: GeminiServerClient;
  /** 測試注入用；正式呼叫不要傳 */
  now?: () => number;
  /** 測試注入用。改門檻是 SDD 4.1 的 L3 變更，不要拿它當設定旋鈕 */
  config?: Partial<TopicLinkerConfig>;
}

export interface LinkCoverage {
  candidates: number;
  judged: number;
  skipped_cap: number;
  skipped_excluded: number;
  skipped_error: number;
  incomparable_pairs: number;
  error: string | null;
}

export interface LinkSummary {
  status: 'LINKED' | 'LINK_FAILED';
  /** 實際寫進去的關聯數 */
  links: number;
  coverage: LinkCoverage;
}

/** 這些狀態下才算得了關聯：READY 是第一次，LINKED 與 LINK_FAILED 是重算 */
const LINKABLE_FROM = ['READY', 'LINKED', 'LINK_FAILED'] as const;

/** embedding 的輸入。與 `eval/strategies/s2-embedding.ts` 的 keyOf 相同，兩邊的分數才可比 */
const embeddingTextOf = (title: string, content: string): string =>
  content && content.trim().length > 0 ? `${title}。${content}` : title;

export function createTopicLinker(deps: TopicLinkerDeps) {
  const { store, gemini } = deps;
  const now = deps.now ?? (() => Date.now());
  const config: TopicLinkerConfig = { ...DEFAULT_LINKER_CONFIG, ...deps.config };

  /**
   * 補上這場會還沒算過的標籤向量（Q2 裁決的 lazy 那一半）。
   *
   * 失敗一律往上拋，**不降級成「這場會就先不比」**：少了向量的那場會不會產生任何候選，
   * 而「沒有候選」跟「真的沒有相關會議」在結果上長得一模一樣。寧可整場算不出來、
   * 狀態寫 LINK_FAILED 帶原因，也不要安靜地少比幾場。
   */
  const ensureVectors = async (meetingId: string): Promise<void> => {
    // 「沒有向量」與「向量是舊 model 算的」都要重算。後者不補的話，換過 embedding model 之後
    // 舊向量會被 canCompare 全部判成不可比，那些會就安靜地關聯不到任何東西
    const missing = store.listTagsNeedingVectors(meetingId, gemini.embeddingModel);
    if (missing.length === 0) return;

    const batch = await gemini.embedTopicTags(missing.map(tag => embeddingTextOf(tag.title, tag.content)), meetingId);
    if (batch.vectors.length !== missing.length) {
      throw new Error(`Meeting ${meetingId} 送出 ${missing.length} 條標籤，embedding 回來 ${batch.vectors.length} 條`);
    }
    store.saveTagVectors(
      missing.map((tag, index) => ({
        tag_id: tag.tag_id,
        model: batch.model,
        dimensions: batch.dimensions,
        vector: batch.vectors[index],
      })),
      now(),
    );
  };

  /**
   * 算一場會的關聯。狀態由這裡推：`READY`／`LINKED`／`LINK_FAILED` → `LINKING` → `LINKED`／`LINK_FAILED`。
   *
   * 呼叫端（pipeline 與重算路由）不要自己改狀態：兩個地方各推一次的話，失敗路徑會有兩種寫法。
   */
  const link = async (meetingId: string): Promise<LinkSummary> => {
    const meeting = store.getMeeting(meetingId);
    if (!meeting) throw new Error(`找不到 Meeting ${meetingId}`);
    if (!(LINKABLE_FROM as readonly string[]).includes(meeting.status)) {
      throw new Error(
        `Meeting ${meetingId} 目前是 ${meeting.status}，不是可以算關聯的狀態`
        + `（要 ${LINKABLE_FROM.join('、')} 其中之一）`,
      );
    }

    // 覆蓋率一路累積：成功與失敗兩條路徑都要寫得出當下真實的數字，
    // 失敗時補一組 0 的話，「算到一半掛了」會被記成「一個候選都沒有」
    const coverage: LinkCoverage = {
      candidates: 0, judged: 0, skipped_cap: 0, skipped_excluded: 0, skipped_error: 0,
      incomparable_pairs: 0, error: null,
    };

    store.setStatus(meetingId, 'LINKING', now());

    try {
      await ensureVectors(meetingId);
      const targetVectors = store.getTagVectors(meetingId);

      // 沒有標籤的會永遠關聯不到（SDD 4.x），這件事已經記在 topic_extraction_status 上。
      // 這裡照樣走完 LINKED：狀態要往前走，不然它會永遠停在 READY 而看起來像「還沒算」
      const owners = store.listTopicTagOwners().filter(id => id !== meetingId);

      const scored: Candidate[] = [];
      if (targetVectors.length > 0) {
        for (const otherId of owners) {
          await ensureVectors(otherId);
          const otherVectors = store.getTagVectors(otherId);
          if (otherVectors.length === 0) continue;
          const score = scorePair(targetVectors, otherVectors, config.tagThreshold);
          coverage.incomparable_pairs += score.incomparable;
          scored.push({ meeting_id: otherId, score });
        }
      }

      const excluded = new Set(
        store.listLinkExclusions(meetingId).map(row => pairKey(row.meeting_a, row.meeting_b)),
      );
      const selection = selectCandidates(
        scored,
        otherId => excluded.has(pairKey(meetingId, otherId)),
        config.candidateLimit,
        config.minHits,
      );

      coverage.candidates = selection.selected.length + selection.droppedByCap.length + selection.excluded.length;
      coverage.skipped_cap = selection.droppedByCap.length;
      coverage.skipped_excluded = selection.excluded.length;

      const links: NewTopicLink[] = [];
      const targetTags = store.getTopicTags(meetingId);

      for (let i = 0; i < selection.selected.length; i += 1) {
        const candidate = selection.selected[i];
        try {
          const judgement = await gemini.judgeMeetingPair({
            idA: meetingId,
            tagsA: targetTags.map(t => ({ title: t.title, content: t.content })),
            idB: candidate.meeting_id,
            tagsB: store.getTopicTags(candidate.meeting_id).map(t => ({ title: t.title, content: t.content })),
          });
          coverage.judged += 1;
          if (judgement.sameTopic && judgement.confidence >= config.confidenceThreshold) {
            links.push({
              other_meeting_id: candidate.meeting_id,
              confidence: judgement.confidence,
              evidence: composeEvidence(candidate.score, judgement),
              shared_topics: judgement.sharedTopics,
            });
          }
        } catch (err) {
          // 第一次失敗就停掉剩下的。最常見的原因是每日額度用完，而額度不是暫時性的——
          // 照著把剩下 19 對各打 6 次（三個 model 各兩次）只是固定多付呼叫與退避等待，
          // 結果一樣。沒判到的對數與原因都寫進覆蓋率，所以停在哪裡是看得出來的
          coverage.error = err instanceof Error ? err.message : String(err);
          coverage.skipped_error = selection.selected.length - i;
          break;
        }
      }

      const result: LinkResult = {
        algo_version: config.algoVersion,
        links,
        coverage: { ...coverage },
      };

      // 一對都沒判到而且有錯誤 = 這一步沒有發生，不是「沒有相關會議」。
      // 這時不寫 links（不動既有的那組，理由同 W3 的 empty／failed 不刪既有標籤：
      // 這一輪沒算到不代表上一輪算到的是錯的），只留下這次的覆蓋率與原因
      if (coverage.judged === 0 && coverage.skipped_error > 0) {
        store.saveLinkRun(meetingId, result, now());
        store.setStatus(meetingId, 'LINK_FAILED', now(), coverage.error);
        console.warn(`[TopicLinker] Meeting ${meetingId} 的關聯一對都沒判成功：${coverage.error}`);
        return { status: 'LINK_FAILED', links: 0, coverage };
      }

      const report = store.saveLinkResult(meetingId, result, now());
      store.setStatus(meetingId, 'LINKED', now());

      if (report.blockedByExclusion.length > 0) {
        // 走到這裡代表候選階段的排除沒擋住，儲存層那道最後防線接住了。
        // 正常路徑不該發生，所以要講出來而不是安靜吞掉
        console.warn(
          `[TopicLinker] Meeting ${meetingId} 有 ${report.blockedByExclusion.length} 筆關聯在儲存層被排除紀錄擋下：`
          + report.blockedByExclusion.join('、'),
        );
      }
      if (coverage.skipped_error > 0) {
        console.warn(
          `[TopicLinker] Meeting ${meetingId} 的關聯只判了 ${coverage.judged} / ${coverage.candidates} 對，`
          + `剩下 ${coverage.skipped_error} 對沒判：${coverage.error}`,
        );
      }
      if (coverage.incomparable_pairs > 0) {
        // 走到這裡代表表裡還有 model 或維度對不上的向量，而重算那一步沒有把它們補掉。
        // 這一次的分數是不完整的，最可能的結局是「一個候選都沒有」——講出來，不要讓它看起來正常
        console.warn(
          `[TopicLinker] Meeting ${meetingId} 有 ${coverage.incomparable_pairs} 對標籤因為 embedding `
          + '的 model 或維度不同而沒有比到，這次的相似度分數不完整',
        );
      }
      return { status: 'LINKED', links: report.inserted, coverage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      coverage.error = message;
      // 這條是意外（embedding 掛了、資料庫寫不進去）。既有的關聯一樣不動，
      // 只把狀態與原因寫下來——關聯失敗的原因不落地的話，之後查「為什麼這場沒關聯到」沒有證據，
      // 而那正是最大不可接受失敗的偵測路徑（SDD 1.4 的 error 保留規則就是為了這個）
      try {
        store.saveLinkRun(meetingId, { algo_version: config.algoVersion, links: [], coverage: { ...coverage } }, now());
        store.setStatus(meetingId, 'LINK_FAILED', now(), message);
      } catch (saveErr) {
        console.error(`[TopicLinker] Meeting ${meetingId} 標記 LINK_FAILED 時寫入失敗`, { cause: err, saveErr });
      }
      return { status: 'LINK_FAILED', links: 0, coverage };
    }
  };

  return { link };
}

export type TopicLinker = ReturnType<typeof createTopicLinker>;

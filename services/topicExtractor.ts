/**
 * TopicExtractor（SDD 第 3 節 module 表、`FN-03`）。
 *
 * Transcript 進、TopicTag 出。**這個 module 賺自己位置的理由只有兩件事：正規化（產生比對鍵）
 * 與人工修正保護。** prompt 在 geminiServerClient、儲存在 meetingStore，如果哪天這兩件事也
 * 移走了，它就只是轉呼叫 Gemini，該被併掉（SDD 自我批判第 1 條）。W4 做完要重查這條邊界：
 * 比對鍵的生成規則若跟著 `TopicLinker` 的策略走，那它就屬於 `TopicLinker`。
 *
 * **錯誤模式（Q2 裁決，2026-09-15）**：抽不出標籤時這場會照樣進 READY，不進 FAILED。
 * 分析已經成功，逐字稿與結論對使用者已經有價值；缺標籤的後果是「這場會關聯不到」，
 * 不是「內容錯」。代價是那場會**永遠不會參與任何關聯**，所以一定要留得下標記——
 * 只寫 log 的話，事後沒有任何辦法把這種會撈出來（SDD 4.x）。
 */
import { GeminiServerClient } from './geminiServerClient';
import { MeetingStore, NewAutoTopicTag, TopicExtractionResult } from './meetingStore';
import { MATCH_KEY_VERSION, TopicExtractionStatus, toMatchKey } from './topicTag';

export interface TopicExtractorDeps {
  store: MeetingStore;
  gemini: GeminiServerClient;
  /** 測試注入用；正式呼叫不要傳 */
  now?: () => number;
}

export interface TopicExtractionSummary {
  status: TopicExtractionStatus;
  /** 實際寫進 topic_tags 的條數。status 不是 ok 時是 0 */
  inserted: number;
  /** status 是 failed 時的原因，其餘是 null */
  error: string | null;
}

export function createTopicExtractor(deps: TopicExtractorDeps) {
  const { store, gemini } = deps;
  const now = deps.now ?? (() => Date.now());

  /**
   * 抽一場會的題目標籤並落地。
   *
   * 呼叫 Gemini 的失敗自己接住（記成 failed），**不往上拋**：往上拋會讓 pipeline 的外層
   * 把一場分析成功的會標成 FAILED。寫入失敗則照拋——那代表資料庫壞了，不是模型的事。
   */
  const extract = async (meetingId: string): Promise<TopicExtractionSummary> => {
    const transcript = store.getTranscript(meetingId);
    if (!transcript || transcript.segments.length === 0) {
      // 走到這裡代表分析成功之後逐字稿不見了。這是真的壞掉，不是「抽不出標籤」，
      // 不能記成 failed 混在模型錯誤裡
      throw new Error(`Meeting ${meetingId} 沒有逐字稿，抽不了題目標籤`);
    }

    let extracted;
    try {
      extracted = await gemini.extractTopicTags({ transcript: transcript.segments, meetingId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.saveTopicExtraction(meetingId, { status: 'failed', error: message }, now());
      console.warn(`[TopicExtractor] Meeting ${meetingId} 抽不出題目標籤，這場會不會參與任何關聯：${message}`);
      return { status: 'failed', inserted: 0, error: message };
    }

    const tags: NewAutoTopicTag[] = [];
    const unmatchable: string[] = [];
    for (const tag of extracted) {
      const matchKey = toMatchKey(tag.title);
      if (matchKey === '') {
        // 整條標題都是停用詞或標點，算不出比對鍵。空鍵之間會互相「相等」，
        // 存進去會把兩件不相干的事判成同一題，所以這一條丟掉——但要講出來
        unmatchable.push(tag.title);
        continue;
      }
      tags.push({
        title: tag.title,
        content: tag.content,
        match_key: matchKey,
        match_key_version: MATCH_KEY_VERSION,
      });
    }
    if (unmatchable.length > 0) {
      console.warn(
        `[TopicExtractor] Meeting ${meetingId} 有 ${unmatchable.length} 條標籤算不出比對鍵，`
        + `已丟棄：${unmatchable.join('、')}`,
      );
    }

    const result: TopicExtractionResult = tags.length === 0 ? { status: 'empty' } : { status: 'ok', tags };
    const report = store.saveTopicExtraction(meetingId, result, now());

    if (result.status === 'empty') {
      // 模型回了、但一條可比對的標籤都沒有。這不是錯誤，是這場會的事實，
      // 而它的後果跟失敗一樣：永遠關聯不到。標記已經落地，這行是給當下看 log 的人
      console.warn(`[TopicExtractor] Meeting ${meetingId} 一條題目標籤都沒抽到，這場會不會參與任何關聯`);
      return { status: 'empty', inserted: 0, error: null };
    }
    if (report.skippedByManual.length > 0) {
      console.log(
        `[TopicExtractor] Meeting ${meetingId} 有 ${report.skippedByManual.length} 條新標籤被人工修正過的同題目蓋過，`
        + `保留人工版本：${report.skippedByManual.join('、')}`,
      );
    }
    if (report.skippedDuplicate.length > 0) {
      console.log(
        `[TopicExtractor] Meeting ${meetingId} 有 ${report.skippedDuplicate.length} 條標籤的比對鍵重複，`
        + `只留第一條：${report.skippedDuplicate.join('、')}`,
      );
    }
    return { status: 'ok', inserted: report.inserted, error: null };
  };

  return { extract };
}

export type TopicExtractor = ReturnType<typeof createTopicExtractor>;

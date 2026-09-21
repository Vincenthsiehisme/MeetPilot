/**
 * `NameResolver`（SDD 1.3.2 第 2 層，人名校正三層設計的中段）。
 *
 * 輸入是一場會完整合併後的逐字稿與該場會 `meeting_participants` 展開出的別名集合，
 * 輸出兩件事：`NameMention[]`（落地存證，第 3 層人工確認要靠它）與一份「已解析視圖」
 * （逐段原地替換為正名，段落索引不變，只服務分析呼叫）。`transcripts.segments`（raw）
 * 一個字都不動——校正邏輯或名單修正之後永遠可以重新產生視圖，不會覆蓋掉本來就沒錯的原始聽寫。
 *
 * 不變量：
 * - 只在該場會與會者的別名集合裡比對，不查全公司名單
 * - 精確字串比對優先；兩字（code point）以下的短別名一律 `needs_review`，不直接採用——
 *   短字串撞到一般詞（「小明」撞「小明白」）的機率不是比對信心分數能反映的
 * - 同一個字串在別名集合裡對到兩個不同員編：`needs_review`，不猜是哪一個
 * - `name_mentions` 可重建：每次重跑一場會的比對整批刪掉舊列重寫，不留歷史版本（SDD 1.5）
 *
 * 錯誤模式：比對邏輯本身失敗時，呼叫端（`transcriptionPipeline.ts`）接住錯誤讓整場會的
 * 名字比對跳過，不阻塞轉錄與分析繼續進行（同 `F-LINK` 失敗不阻塞 Meeting 可見性的精神）——
 * 這個模組本身不吞錯誤，錯就讓它壞得明顯，是否要讓它拖累整場會由呼叫端決定。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { TranscriptSegment } from '../types';
import { AnalysisV3 } from './analysisContract';
import { PeopleStore } from './peopleStore';
import { MeetingStore } from './meetingStore';

/** 別名 code point 數 <= 這個長度，比對命中一律 `needs_review`（SDD 1.3.2：「兩字或以下」） */
const SHORT_ALIAS_MAX_LENGTH = 2;

export interface NameMention {
  meeting_id: string;
  segment_index: number;
  /** 逐字稿裡實際比對到的原字串（可能是正名，也可能是別名） */
  original_text: string;
  /** 查不到或衝突時是 null，不猜 */
  employee_id: string | null;
  /** `exact`：唯一命中且非短別名，已解析視圖會替換成正名。其餘兩種都是 `needs_review` */
  method: 'exact' | 'short_alias_review' | 'conflict_review';
  /** 不是機率分數：確定性比對只有「採用」與「待確認」兩種狀態，`1` 或 `0` 是這兩種狀態的標記，
   * 不代表比對強度有連續分佈——之後若真的需要量測比對品質，這裡是預留欄位，不是現在就在用的分數 */
  confidence: 1 | 0;
}

export interface ResolvedTranscript {
  mentions: NameMention[];
  /** 段落數與順序跟輸入的 `segments` 完全一致，只有 `text` 可能被替換成正名 */
  resolvedSegments: TranscriptSegment[];
}

/** 這場會的別名集合：正名（`display_name`）與別名（`person_aliases`）一起收進同一份索引 */
const buildAliasIndex = (
  participantIds: readonly string[],
  peopleStore: Pick<PeopleStore, 'getPerson' | 'listAliasesForEmployees'>,
): Map<string, Set<string>> => {
  const index = new Map<string, Set<string>>();
  const add = (alias: string, employeeId: string) => {
    if (alias.trim() === '') return;
    if (!index.has(alias)) index.set(alias, new Set());
    index.get(alias)!.add(employeeId);
  };
  for (const employeeId of participantIds) {
    const person = peopleStore.getPerson(employeeId);
    if (person) add(person.display_name, employeeId);
  }
  for (const alias of peopleStore.listAliasesForEmployees(participantIds)) {
    add(alias.alias, alias.employee_id);
  }
  return index;
};

/** 比對哪一個字串命中，決定它的 method／confidence／employee_id。純函式，不碰任何 I/O */
const classifyMatch = (alias: string, employeeIds: Set<string>): Pick<NameMention, 'employee_id' | 'method' | 'confidence'> => {
  if (employeeIds.size > 1) {
    return { employee_id: null, method: 'conflict_review', confidence: 0 };
  }
  const [employeeId] = employeeIds;
  if (Array.from(alias).length <= SHORT_ALIAS_MAX_LENGTH) {
    return { employee_id: employeeId, method: 'short_alias_review', confidence: 0 };
  }
  return { employee_id: employeeId, method: 'exact', confidence: 1 };
};

interface MatchSpan {
  start: number;
  end: number;
  alias: string;
}

/**
 * 在一段文字裡找出所有不重疊的別名命中，長的別名先佔位（`aliasesByLengthDesc` 已排序）。
 *
 * 用字元範圍（不是字串比對）判斷重疊，避免兩種假陽性：一是不同人的別名互相包含
 * （員工 A 的別名「Alice Chen」跟員工 B 的別名「Chen」同時命中同一次提及，
 * 錯的那筆會把 B 也標成有被提到）；二是同一個人的正名與別名互相包含
 * （「陳小明」命中之後，它自己的子字串「小明」不該在同一個位置再命中一次）。
 * 這兩種都只發生在字元範圍重疊的時候，不重疊的兩次提及（同一段話裡分別講了
 * 「Philchen」跟「Phil」）不會互相影響，各自記一筆。
 */
const findMatchSpans = (text: string, aliasesByLengthDesc: readonly string[]): MatchSpan[] => {
  const claimed = new Array<boolean>(text.length).fill(false);
  const spans: MatchSpan[] = [];
  for (const alias of aliasesByLengthDesc) {
    let fromIndex = 0;
    for (;;) {
      const start = text.indexOf(alias, fromIndex);
      if (start === -1) break;
      const end = start + alias.length;
      fromIndex = start + 1;
      let overlapsClaimed = false;
      for (let i = start; i < end; i += 1) {
        if (claimed[i]) { overlapsClaimed = true; break; }
      }
      if (overlapsClaimed) continue;
      for (let i = start; i < end; i += 1) claimed[i] = true;
      spans.push({ start, end, alias });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
};

export const createNameResolver = (
  db: DatabaseSync,
  peopleStore: PeopleStore,
  meetingStore: Pick<MeetingStore, 'getParticipants'>,
) => {
  const deleteMentions = db.prepare('DELETE FROM name_mentions WHERE meeting_id = ?');
  const insertMention = db.prepare(
    'INSERT INTO name_mentions '
    + '(mention_id, meeting_id, segment_index, original_text, employee_id, method, confidence, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  return {
    /**
     * 轉錄完成、分析之前的確定性比對（第 2 層）。落地 `name_mentions`（整批重寫）並回傳
     * 已解析視圖給 `analyzeTranscript` 讀。沒有與會者（尚未做人名校正的舊會議）時
     * 回空 mentions 與原樣的 segments，不改變既有行為。
     */
    resolveTranscript: (meetingId: string, segments: readonly TranscriptSegment[], now: number): ResolvedTranscript => {
      const participantIds = meetingStore.getParticipants(meetingId);
      if (participantIds.length === 0) return { mentions: [], resolvedSegments: [...segments] };

      const aliasIndex = buildAliasIndex(participantIds, peopleStore);
      // 長的別名先佔位：「陳國煌 Philchen」這種來源檔組合出的長字串命中時，
      // 它涵蓋範圍內的「陳國煌」「Philchen」不該在同一個位置再各自命中一次（見 findMatchSpans）
      const aliases = Array.from(aliasIndex.keys()).sort((a, b) => b.length - a.length);

      const mentions: NameMention[] = [];

      const resolvedSegments = segments.map((segment, index) => {
        const originalText = segment.text;
        const spans = findMatchSpans(originalText, aliases);
        if (spans.length === 0) return segment;

        // findMatchSpans 已經照出現位置由左到右排序，mentions 照這個順序記錄可讀性較好
        const classifiedSpans = spans.map((span) => ({
          span,
          classified: classifyMatch(span.alias, aliasIndex.get(span.alias)!),
        }));
        for (const { span, classified } of classifiedSpans) {
          mentions.push({ meeting_id: meetingId, segment_index: index, original_text: span.alias, ...classified });
        }

        // 由後往前拼字串：exact 命中要替換成正名，取代後的字串長度可能跟原字串不同，
        // 從尾端開始改才不會讓還沒處理的位置跟著位移
        let resolvedText = originalText;
        for (let i = classifiedSpans.length - 1; i >= 0; i -= 1) {
          const { span, classified } = classifiedSpans[i];
          if (classified.method !== 'exact') continue;
          const person = peopleStore.getPerson(classified.employee_id!);
          if (person && person.display_name !== span.alias) {
            resolvedText = resolvedText.slice(0, span.start) + person.display_name + resolvedText.slice(span.end);
          }
        }
        return resolvedText === originalText ? segment : { ...segment, text: resolvedText };
      });

      db.exec('BEGIN');
      try {
        deleteMentions.run(meetingId);
        for (const mention of mentions) {
          insertMention.run(
            randomUUID(), mention.meeting_id, mention.segment_index, mention.original_text,
            mention.employee_id, mention.method, mention.confidence, now,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return { mentions, resolvedSegments };
    },

    /**
     * `FN-14`：分析完成後反查 `decided_by`／`assignee` 對應的員編。字串必須逐字對得上
     * 這場會與會者的正名或別名才查——這是「整段文字等不等於這個人的某個已知寫法」，
     * 不是像 `resolveTranscript` 那樣在一段話裡找子字串，所以這裡不套短別名的
     * `needs_review` 限制：一個兩字別名如果整段輸出剛好逐字相等，不會有「撞到別的詞」的風險。
     * 對不上（模型意譯或簡稱，例如「王小明」寫成「小明」）或撞到兩個員編，都留 `null` 並記 log，
     * 不猜是哪個人。
     */
    resolveAnalysisEmployeeIds: (analysis: AnalysisV3, meetingId: string): AnalysisV3 => {
      const participantIds = meetingStore.getParticipants(meetingId);
      const aliasIndex = buildAliasIndex(participantIds, peopleStore);

      const lookup = (text: string | null, context: string): string | null => {
        if (text === null) return null;
        // trim 只是防模型輸出多帶的前後空白，不是放寬比對——別名索引本身仍是大小寫敏感、
        // 逐字比對（跟 rosterImport.ts 的既有慣例一致），這裡不做任何正規化以外的寬鬆處理
        const employeeIds = aliasIndex.get(text.trim());
        if (!employeeIds || employeeIds.size !== 1) {
          console.warn(
            `[NameResolver] Meeting ${meetingId} 的${context}「${text}」對不上與會者的正名或別名`
            + `（${!employeeIds ? '找不到' : '對到多個員編'}），員編留空`,
          );
          return null;
        }
        return Array.from(employeeIds)[0];
      };

      return {
        ...analysis,
        decisions: analysis.decisions.map((d) => ({
          ...d,
          decided_by_employee_id: lookup(d.decided_by, '決議負責人'),
        })),
        action_items: analysis.action_items.map((a) => ({
          ...a,
          assignee_employee_id: lookup(a.assignee, '待辦負責人'),
        })),
      };
    },
  };
};

export type NameResolver = ReturnType<typeof createNameResolver>;

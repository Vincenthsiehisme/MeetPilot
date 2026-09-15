import { TranscriptSegment } from '../types';
import { SeamOptions } from './seamAlignment';
import { SLICE_OVERLAP_SECONDS, mergeSliceTranscript } from './transcriptMerge';

/**
 * 破洞修復（W2-2b）。
 *
 * W2-2a 讓破洞現形：接縫對不上，代表前一片沒把自己的尾巴轉完，中間那段音檔沒有人轉過。
 * 這個模組負責把它補回來。
 *
 * **做法是補轉一段跨接縫的橋接音檔，用同一個對齊原語接回去。**
 *
 * 缺的那段落在 `[X, S + O]`：`S` 是後一片的起點、`O` 是 overlap、**`X` 未知**——
 * 時間戳不可信，量不出前一片實際停在哪。`X` 不用猜，用對齊逼出來：橋接段要**兩端都錨得住**，
 * 開頭對得上既有逐字稿的尾巴、結尾對得上後一片的開頭。錨不住就是窗開得不夠大，放大再試。
 *
 * 兩端都走 `mergeSliceTranscript`，不另寫一套拼接邏輯：接縫就是接縫，
 * 多一份實作就多一份會漂移的規則。
 *
 * **補不回來時不補假內容**，逐字稿維持原樣並在報告裡記 `failed`。
 * 安靜地少一段跟明說這裡少一段，差別就是這一條。
 */

/** 橋接窗由小到大試。小窗省額度，大窗才接得住轉得特別短的片 */
export const BRIDGE_WINDOWS_SECONDS: readonly number[] = [120, 300, 600];

export interface SeamRepairConfig {
  enabled: boolean;
  /** 一場會最多送幾次額外轉錄。跨接縫共用 */
  budget: number;
}

/**
 * 預設開啟，一場會最多 6 次額外轉錄。
 *
 * 開啟是刻意的：破洞是**內容安靜消失**，而音檔在分析成功之後就刪了，之後補不回來。
 * 預設關掉等於預設接受掉字。
 *
 * 6 次是煞車。實測一場 65 分鐘的會有兩個破洞，一個破洞最多試三個窗，所以 6 次涵蓋得了
 * 典型情況；破洞多到吃完額度的會，剩下的接縫會記成 skipped —— 那是「還不知道有沒有缺」，
 * 跟「試過補不回來」分得開。Gemini 有每日額度，沒有上限的話一場壞掉的會就能把它燒光
 */
export const DEFAULT_SEAM_REPAIR: SeamRepairConfig = { enabled: true, budget: 6 };

/**
 * `MEETPILOT_SEAM_REPAIR` 設成 `off` 關閉修復；`MEETPILOT_SEAM_REPAIR_BUDGET` 改每場上限。
 *
 * 值解不出來時**拋錯不是靜靜用預設**：跟環境變數的既有做法一致，
 * 「看起來生效、實際值不是寫的那個」比直接起不來難查得多
 */
export function resolveSeamRepairConfig(env: NodeJS.ProcessEnv): SeamRepairConfig {
  const mode = (env.MEETPILOT_SEAM_REPAIR ?? '').trim().toLowerCase();
  const enabled = mode !== 'off';

  const rawBudget = (env.MEETPILOT_SEAM_REPAIR_BUDGET ?? '').trim();
  if (rawBudget === '') return { enabled, budget: DEFAULT_SEAM_REPAIR.budget };
  if (!/^\d+$/.test(rawBudget)) {
    throw new Error(
      `MEETPILOT_SEAM_REPAIR_BUDGET 必須是非負整數，收到 ${JSON.stringify(rawBudget)}`,
    );
  }
  return { enabled, budget: Number(rawBudget) };
}

export type RepairOutcome = 'repaired' | 'failed' | 'skipped';

export interface RepairResult {
  segments: TranscriptSegment[];
  outcome: RepairOutcome;
  /** 實際送出去的轉錄次數。skipped 是 0 */
  attempts: number;
  /** 成功時用的橋接窗長度（秒） */
  bridgeSeconds?: number;
}

export interface RepairDeps {
  /** 轉一段音檔。回傳的時間戳要已經加上 startSeconds 這個 offset */
  transcribeWindow: (startSeconds: number, durationSeconds: number) => Promise<TranscriptSegment[]>;
  /** 整個音檔多長，用來把窗夾在檔案範圍內 */
  totalDurationSeconds: number;
}

export interface RepairOptions {
  /** 關掉修復。撞每日額度或只想先看報告時用 */
  enabled?: boolean;
  /** 這一場會最多還能送幾次轉錄。跨接縫共用，避免一場破洞多的會把額度燒光 */
  budget?: number;
  windows?: readonly number[];
  overlapSeconds?: number;
  seam?: SeamOptions;
}

/**
 * 試著把 `existing` 與 `incoming` 之間的破洞補起來。
 *
 * 回傳的 `segments` 一定是完整的「既有 ＋（橋接）＋ 新片」，**任何情況下都不會比不修更少**：
 * 修不掉就等於直接把 incoming 接上去，跟 W2-2a 的行為一樣。
 */
export async function repairSeamGap(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  seamStartSeconds: number,
  deps: RepairDeps,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const {
    enabled = true,
    budget = Number.POSITIVE_INFINITY,
    windows = BRIDGE_WINDOWS_SECONDS,
    overlapSeconds = SLICE_OVERLAP_SECONDS,
    seam,
  } = options;

  const unrepaired = (outcome: RepairOutcome, attempts: number): RepairResult => ({
    segments: [...existing, ...incoming],
    outcome,
    attempts,
  });

  if (!enabled || budget <= 0 || existing.length === 0) {
    return unrepaired('skipped', 0);
  }

  let attempts = 0;
  for (const window of windows) {
    if (attempts >= budget) break;

    // 窗夾在檔案範圍內。接縫在檔頭附近時窗會被截短，那不是錯誤，只是能回去的距離有限
    const start = Math.max(0, seamStartSeconds - window);
    const end = Math.min(deps.totalDurationSeconds, seamStartSeconds + overlapSeconds);
    const duration = end - start;
    // 窗被夾到比上一個還短就不必再送：同一段音檔轉第二次不會有不同結果
    if (duration <= 0) break;

    attempts += 1;
    // 橋接回空陣列不用另外擋：alignSeam 對空的 incoming 回 inconclusive，
    // 下面的左端錨點檢查就會讓它進下一個窗（mutation 驗過，那行守衛是死碼）
    const bridge = await deps.transcribeWindow(start, duration);

    // 左端：橋接的開頭要接得上既有逐字稿
    const left = mergeSliceTranscript(existing, bridge, start, false, seam, overlapSeconds);
    if (left.seam?.verdict !== 'duplicate') {
      // 錨不住代表窗還不夠大，前一片停得比這個窗更早。放大再試
      continue;
    }

    // 右端：橋接要覆蓋到後一片的開頭
    const right = mergeSliceTranscript(left.segments, incoming, seamStartSeconds, false, seam, overlapSeconds);
    if (right.seam?.verdict !== 'duplicate') {
      // 左端接上了、右端接不上：橋接自己也被截斷了。這個窗不算數，放大再試
      continue;
    }

    return { segments: right.segments, outcome: 'repaired', attempts, bridgeSeconds: duration };
  }

  return unrepaired('failed', attempts);
}

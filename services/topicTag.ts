/**
 * TopicTag 的契約與比對鍵（W3，SDD 1.1／1.2／`FN-03` 的 `C-TOPICTAG` v1）。
 *
 * 這個檔不 import 任何帶 node 依賴的東西：`types.ts` 讀這裡的 `TopicExtractionStatus`，
 * 而 `types.ts` 前端也 import（理由同 `meetingState.ts`）。
 *
 * 題目標籤跟 `meeting_tags` 是兩件事，不要併：`meeting_tags` 是使用者建立會議時自己打的
 * 會議標籤（只當 prompt 背景），這裡的是模型從逐字稿抽出來、要拿去跨會議比對的題目。
 * 人工優先規則只該套在後者——前者本來就全部是人打的。
 */

export type TopicTagSource = 'auto' | 'manual';

/** 一條題目標籤。ID 是 `tag_id` ＋ `meeting_id`（SDD 1.1） */
export interface TopicTag {
  tag_id: string;
  meeting_id: string;
  /** 給人看的原文。vault markdown 逐條列出的就是它（SDD 1.3.1），所以不存正規化後的字串 */
  title: string;
  /** 這件事在這場會的具體內容。S3 產判定理由時要用 */
  content: string;
  source: TopicTagSource;
  /** 人改過的時間。`source = auto` 一律 null */
  corrected_at: number | null;
  /** 正規化後的比對鍵，見 toMatchKey */
  match_key: string;
  /** 產生這個鍵的規則版本，見 MATCH_KEY_VERSION */
  match_key_version: number;
  created_at: number;
}

/**
 * 抽取的結果，落在 `meetings.topic_extraction_status`。
 *
 * **沒有值（null）是「這場會還沒抽過」，跟 `empty` 不是同一件事**：前者是 W3 之前就存在
 * 或搬遷進來的會，後者是抽過、模型一條都沒回。兩者混成同一個值的話，「模型抽不出東西」
 * 會被當成「還沒輪到它」，而那種會永遠不會參與任何關聯（SDD 4.x）。
 *
 * `failed` 與 `empty` 也要分開：`failed` 是呼叫或解析壞掉（原因記在
 * `topic_extraction_error`），`empty` 是呼叫成功但沒有東西可抽。前者重跑有意義，後者沒有。
 */
export type TopicExtractionStatus = 'ok' | 'empty' | 'failed';

export const isTopicExtractionStatus = (value: unknown): value is TopicExtractionStatus =>
  value === 'ok' || value === 'empty' || value === 'failed';

/**
 * 比對鍵的規則版本。**規則改一個字就要加一**。
 *
 * 版本號不是形式：`match_key` 存在表裡，規則改了而舊鍵還在，混著比對不會有任何錯誤訊息，
 * 只會讓兩場本來對得上的會安靜地對不上。版本存在每一列旁邊，之後才查得出哪些鍵要重算。
 */
export const MATCH_KEY_VERSION = 1;

/** 全形轉半形，只處理 ASCII 可對應的區段 */
const toHalfWidth = (input: string): string =>
  input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');

/** 這些字出現在題目標籤裡幾乎不帶區別力，留著會讓任何兩個標籤都有共同的字 */
const STOPWORDS = [
  '的',
  '與',
  '和',
  '及',
  '跟',
  '這個',
  '那個',
  '我們',
  '他們',
  '一個',
  '相關',
  '部分',
  '方式',
  '進行',
  '討論',
  '問題',
];

/**
 * 產生比對鍵：全形轉半形、轉小寫、去掉空白與標點、去掉停用詞。
 *
 * 規則與 `eval/lib/normalize.ts`（U-001 的 S1 baseline 用的那支）目前一模一樣，但**刻意各留
 * 一份，不共用**。那支是離線評測的可調參數，調它是為了讓 baseline 更準；這支的輸出會跟著
 * 標籤一起落地，改它等於讓表裡的舊鍵與新鍵語意不同。兩者共用的話，調評測會安靜地改掉
 * 已經落地的比對語意——而那正是 MATCH_KEY_VERSION 要防的事。
 *
 * **回傳空字串是合法的結果**（標題整條都是停用詞或標點時會發生），意思是「這個標題沒有可比對
 * 的東西」。呼叫端要把它當成不可比對處理，不要存進表裡當成一個正常的鍵——空鍵跟空鍵會互相
 * 「相等」，那會把兩件不相干的事判成同一題。
 */
export const toMatchKey = (title: string): string => {
  let text = toHalfWidth(title).toLowerCase();
  text = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  for (const word of STOPWORDS) {
    text = text.split(word).join('');
  }
  return text;
};

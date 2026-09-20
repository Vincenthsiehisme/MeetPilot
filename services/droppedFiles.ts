/**
 * 拖曳上傳（AC-6）：從整頁 drop 事件挑出一個可用的音訊／影片檔。
 *
 * 純函式抽出來的理由跟 meetingAdapter.ts 檔頭一樣：App.tsx 沒有元件測試基礎設施，
 * 能測的判斷邏輯一律放這裡，`onDrop` 只做事件層的事（`preventDefault`、讀 `e.dataTransfer.files`）。
 */

/** 副檔名清單跟 FileUpload.tsx 的 `accept` 屬性是同一份判準，兩邊都要 import 這個常數，
 * 不要各自硬寫一份字串——那正是這個檔案要解決的「拖曳跟按鈕走兩套邏輯」的其中一半 */
export const ACCEPTED_AUDIO_EXTENSIONS = ['.mov', '.m4a', '.mp4', '.mp3', '.wav', '.webm'];

/** `<input accept>` 屬性的字串形式，兩種 MIME 類別加上面那份副檔名清單 */
export const ACCEPTED_AUDIO_ACCEPT_ATTR = ['audio/*', 'video/*', ...ACCEPTED_AUDIO_EXTENSIONS].join(',');

/**
 * 這個檔案的型別／副檔名合不合法。只看 `type` 前綴（`audio/`／`video/`）或副檔名，
 * 不讀檔案內容——跟原本 `<input accept>` 的把關強度一致，不做內容嗅探。
 *
 * 瀏覽器對某些容器格式（例如 `.m4a`）的 `File.type` 常常是空字串，只靠 MIME type 判斷
 * 會把使用者明明選對的檔案擋下來，所以副檔名是必要的備援，不是可有可無的加強。
 */
export const isAcceptedAudioFile = (file: { name: string; type: string }): boolean => {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  const lowerName = file.name.toLowerCase();
  return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
};

export type DroppedFilePick =
  | { ok: true; file: File }
  | { ok: false; reason: string };

/**
 * 從拖進頁面的檔案清單挑出唯一一個可用的音訊／影片檔。
 *
 * 三種擋下來的情況都要講清楚原因，不是安靜地什麼都不做：0 個檔案（拖進來的不是檔案，
 * 例如一段選取的文字或一張圖片連結）、超過 1 個（這裡沒有批次上傳的 UI，選第一個會讓
 * 使用者以為其餘的檔案也送出去了）、型別不對（使用者拖錯檔案，需要知道拖對的話該是什麼格式）。
 */
export const pickDroppedAudioFile = (
  files: FileList | readonly File[],
  types: readonly string[] = [],
): DroppedFilePick => {
  const list = Array.from(files);
  if (list.length === 0) {
    // 拖進來的東西沒有變成 File：可能是文字、連結，或來源 App 用瀏覽器接不到的方式交檔
    //（macOS 有些 App 拖出的是 promised file）。把 dataTransfer.types 列出來，使用者才回報得出是哪一種
    const detected = types.length > 0 ? types.join('、') : '無';
    return {
      ok: false,
      reason: `沒有偵測到檔案（拖曳內容的型別：${detected}）。請從 Finder 把錄音檔拖到這個視窗裡，或點「建立新任務」選檔。`,
    };
  }
  if (list.length > 1) {
    return { ok: false, reason: `一次只能拖曳一個檔案（偵測到 ${list.length} 個），請重新拖曳其中一個。` };
  }
  const [file] = list;
  if (!isAcceptedAudioFile(file)) {
    return {
      ok: false,
      reason: `「${file.name}」不是可接受的音訊或影片格式（支援 ${ACCEPTED_AUDIO_EXTENSIONS.join('、')} 或任何 audio／video 檔案）。`,
    };
  }
  return { ok: true, file };
};

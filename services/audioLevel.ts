/**
 * 算一片 WAV 的最大音量，用來擋「整支音檔幾乎沒有聲音」（vault plan「MeetPilot · 跨平台打包部署」E4 後續）。
 *
 * 為什麼要擋：2026-09-24 桌面 app 第一次實機錄音，31 秒只收到 7 KB（64 kbps 的話應該有 250 KB 左右），
 * 音檔幾乎是空的，Gemini 卻轉出一段像樣的獨白，連與會者的名字都用上了（轉錄提示裡有與會者名單），
 * 這份編出來的記錄直接投影進共享資料夾。沒聲音的原因可能是麥克風沒有系統權限、選錯裝置、麥克風靜音，
 * 不管哪一種，送去轉錄只會產出假的內容。
 *
 * 輸入是 audioSlicer.readSlice 的輸出：16kHz 單聲道 16-bit PCM WAV。ffmpeg 寫到 pipe 時沒辦法回頭補長度，
 * RIFF 與 data 的長度欄位是 0xFFFFFFFF，中間還夾一個 LIST chunk（2026-09-24 實測），所以逐個 chunk 找 data，
 * 長度是佔位值就讀到結尾。不是這種格式就拋：切片一定是這個格式，讀不懂代表上游壞了，不能當成「有聲音」放行。
 */

/** 最大音量低於這個值就算沒有聲音。我判、待確認：數位靜音是負無限大，正常麥克風的房間底噪偶爾也會超過 -45 dBFS，說話一定超過 */
export const SILENT_PEAK_DBFS = -45;

export class WavFormatError extends Error {}

export interface WavLevel {
  /** 最大取樣的絕對值換成 dBFS；全是 0 是 -Infinity */
  peakDbfs: number;
  seconds: number;
}

const UNKNOWN_SIZE = 0xffffffff;

export function wavLevel(wav: Buffer): WavLevel {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError(`不是 WAV（開頭 ${JSON.stringify(wav.toString('latin1', 0, 12))}）`);
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; tag: number } | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        tag: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (format === null) throw new WavFormatError('WAV 的 data 出現在 fmt 之前');
      if (format.tag !== 1 || format.bits !== 16) {
        throw new WavFormatError(`只讀得懂 16-bit PCM，這支是格式 ${format.tag}、${format.bits}-bit`);
      }
      const end = size === UNKNOWN_SIZE ? wav.length : Math.min(wav.length, body + size);
      let peak = 0;
      for (let i = body; i + 1 < end; i += 2) {
        const v = Math.abs(wav.readInt16LE(i));
        if (v > peak) peak = v;
      }
      const samples = Math.floor((end - body) / 2);
      return {
        peakDbfs: peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768),
        seconds: samples / format.channels / format.sampleRate,
      };
    }
    // chunk 長度是奇數時後面補一個 byte。長度是佔位值的非 data chunk 會跳出緩衝區，迴圈自己結束、拋找不到 data
    offset = body + size + (size % 2);
  }
  throw new WavFormatError('WAV 裡找不到 data');
}

export const isSilent = (level: WavLevel): boolean => level.peakDbfs < SILENT_PEAK_DBFS;

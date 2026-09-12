
import { extractAudio } from './ffmpegService';

/**
 * 負責處理前端音訊切片與重取樣
 * 優化為流式處理，避免一次性將大檔案載入記憶體
 */

export interface AudioSlice {
  data: string; // Base64
  startTime: number;
  index: number;
  mimeType?: string;
}

export interface LiveRecordingOptions {
  onSlice: (slice: AudioSlice) => void;
  onVolumeChange?: (volume: number) => void;
  silenceThreshold?: number;
  silenceDuration?: number;
  maxSliceDuration?: number;
}

/**
 * 快速取得音訊/影片總時長（不解碼全檔）
 * 使用 video 標籤以更好地相容 .mov, .mp4 等影片容器
 */
export const getAudioDuration = (file: File): Promise<number> => {
  return new Promise((resolve, reject) => {
    const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mov');
    const element = document.createElement(isVideo ? 'video' : 'audio');
    
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const duration = element.duration;
      URL.revokeObjectURL(element.src);
      resolve(duration);
    };
    element.onerror = () => {
      URL.revokeObjectURL(element.src);
      reject(new Error("無法讀取媒體元數據，請檢查檔案格式是否受支援。"));
    };
    element.src = URL.createObjectURL(file);
  });
};

/**
 * 音訊預處理：僅進行重取樣(16kHz)與單聲道混合，不進行破壞性濾波
 * Gemini 模型本身對抗噪有很好的能力，過度前端處理反而會導致語音失真
 */
async function preprocessAudioBuffer(buffer: AudioBuffer): Promise<AudioBuffer> {
  const targetSampleRate = 16000;
  const offlineCtx = new OfflineAudioContext(
    1, // 強制單聲道輸出
    buffer.duration * targetSampleRate,
    targetSampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;

  // 僅使用 GainNode 確保音量不會爆音，但不進行動態壓縮
  const gainNode = offlineCtx.createGain();
  
  // 簡單的峰值歸一化 (Peak Normalization) - 避免過於小聲
  let maxVal = 0;
  const data = buffer.getChannelData(0); // 取左聲道樣本檢查
  // 為了效能，只抽樣檢查峰值
  const step = Math.floor(data.length / 1000) || 1; 
  for (let i = 0; i < data.length; i += step) {
    const abs = Math.abs(data[i]);
    if (abs > maxVal) maxVal = abs;
  }
  
  // 如果音量太小 (< 0.1) 則適度放大，最大放大倍率限制在 5 倍以防底噪爆炸
  const targetPeak = 0.95;
  if (maxVal > 0) {
    const gain = targetPeak / maxVal;
    gainNode.gain.value = Math.min(gain, 5.0); 
  } else {
    gainNode.gain.value = 1.0;
  }

  source.connect(gainNode);
  gainNode.connect(offlineCtx.destination);

  source.start(0);
  return await offlineCtx.startRendering();
}

/**
 * 將 AudioBuffer 轉換為 16kHz Mono 的 WAV 格式 Base64
 */
async function bufferToWavBase64(buffer: AudioBuffer): Promise<string> {
  const numChannels = 1;
  const sampleRate = 16000;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 32 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const channelData = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < channelData.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(new Blob([view], { type: 'audio/wav' }));
  });
}

/**
 * 流式切片產生器
 */
export async function* generateAudioSlices(
  file: File, 
  sliceDurationMinutes: number = 10, 
  overlapSeconds: number = 15
): AsyncGenerator<AudioSlice> {
  const MAX_INLINE_DATA_SIZE = 14 * 1024 * 1024; // 14MB Limit for Gemini inlineData to account for Base64 size expansion (33%)
  let totalDuration = 0;
  
  try {
    totalDuration = await getAudioDuration(file);
  } catch (err) {
    if (file.size > MAX_INLINE_DATA_SIZE) {
      throw new Error("無法讀取媒體總長度，且檔案過大無法直接分析。建議轉檔(如轉為純音訊 MP3)或剪輯後再上傳。");
    }
  }

  const sliceDuration = sliceDurationMinutes * 60;
  const arrayBuffer = await file.arrayBuffer();
  
  let tempCtx;
  try {
    tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  } catch (e) {
    console.warn("Browser does not support AudioContext");
  }
  
  let rawAudioBuffer;
  if (tempCtx) {
    try {
      rawAudioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
      console.warn("Decode audio failed", e);
      tempCtx.close();
      tempCtx = null;
      rawAudioBuffer = null;
    }
  }

  if (!rawAudioBuffer) {
    try {
      console.log("Attempting fallback audio extraction with FFmpeg WASM...");
      const extractedAudio = await extractAudio(file);
      tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const extractedBuffer = await extractedAudio.arrayBuffer();
      rawAudioBuffer = await tempCtx.decodeAudioData(extractedBuffer);
      console.log("FFmpeg fallback success, duration:", rawAudioBuffer.duration);
    } catch (ffmpegErr) {
      console.warn("FFmpeg extraction failed", ffmpegErr);
      rawAudioBuffer = null;
    }
  }

  if (!rawAudioBuffer) {
    if (file.size <= MAX_INLINE_DATA_SIZE) {
      console.warn("無法解碼媒體，但檔案大小適合，將直接上傳原始檔案。");
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });
      
      let mimeType = file.type;
      if (!mimeType) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.mov')) mimeType = 'video/mp4'; // Gemini API accepts video/mp4 for unidentifiable MOV
        else if (name.endsWith('.m4a')) mimeType = 'audio/mp4';
        else mimeType = 'audio/mp3'; // safe fallback
      }
      
      yield {
        data: base64,
        startTime: 0,
        index: 0,
        mimeType: mimeType
      };
      return;
    } else {
      throw new Error("媒體解碼失敗，且檔案過大(超過14MB)無法直接發送。請嘗試剪輯檔案或轉檔(例:轉為MP3)後再上傳。");
    }
  }

  // 這裡會執行簡化版的預處理 (Resample + Mono)
  const fullAudioBuffer = await preprocessAudioBuffer(rawAudioBuffer);
  (rawAudioBuffer as any) = null; // 釋放記憶體

  // 如果前面無法獲得長度 (totalDuration 為 0)，改用解碼後的實際長度
  if (totalDuration <= 0) {
    totalDuration = fullAudioBuffer.duration;
  }

  const sampleRate = fullAudioBuffer.sampleRate;
  const channelData = fullAudioBuffer.getChannelData(0);
  let currentStart = 0;
  let index = 0;

  try {
    while (currentStart < totalDuration) {
      const end = Math.min(currentStart + sliceDuration + overlapSeconds, totalDuration);
      const frameStart = Math.floor(currentStart * sampleRate);
      const frameEnd = Math.floor(end * sampleRate);
      const frameCount = frameEnd - frameStart;

      if (frameCount <= 0) break;

      const sliceBuffer = new AudioBuffer({
        length: frameCount,
        numberOfChannels: 1,
        sampleRate: sampleRate
      });
      sliceBuffer.copyToChannel(channelData.subarray(frameStart, frameEnd), 0);

      const base64 = await bufferToWavBase64(sliceBuffer);
      
      yield {
        data: base64,
        startTime: currentStart,
        index: index++,
        mimeType: 'audio/wav'
      };

      currentStart += sliceDuration;
    }
  } finally {
    if (tempCtx) tempCtx.close();
  }
}
/**
 * 即時錄製與 VAD (Voice Activity Detection) 實作
 */
export const startLiveRecording = async (options: LiveRecordingOptions) => {
  const { 
    onSlice, 
    onVolumeChange, 
    silenceThreshold = 20, 
    silenceDuration = 1500,
    maxSliceDuration = 30000 
  } = options;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const mediaRecorder = new MediaRecorder(stream);
  let chunks: Blob[] = [];
  let isSpeaking = false;
  let silenceTimer: any = null;
  let sliceStartTime = Date.now();
  let sliceIndex = 0;
  let lastSliceTime = Date.now();

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  const checkVolume = () => {
    analyser.getByteFrequencyData(dataArray);
    const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
    if (onVolumeChange) onVolumeChange(volume);

    const now = Date.now();
    const sliceElapsed = now - lastSliceTime;

    if (volume > silenceThreshold) {
      isSpeaking = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    } else if (isSpeaking) {
      if (!silenceTimer) {
        silenceTimer = setTimeout(() => {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.requestData();
          }
          isSpeaking = false;
        }, silenceDuration);
      }
    }

    // 強制切片保險
    if (sliceElapsed >= maxSliceDuration && mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }

    if (mediaRecorder.state !== 'inactive') {
      requestAnimationFrame(checkVolume);
    }
  };

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const blob = e.data;
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const processedBuffer = await preprocessAudioBuffer(audioBuffer);
      const base64 = await bufferToWavBase64(processedBuffer);
      
      const startTime = (lastSliceTime - sliceStartTime) / 1000;
      onSlice({
        data: base64,
        startTime: startTime,
        index: sliceIndex++
      });
      lastSliceTime = Date.now();
    }
  };

  mediaRecorder.start();
  requestAnimationFrame(checkVolume);

  return () => {
    mediaRecorder.stop();
    stream.getTracks().forEach(t => t.stop());
    audioContext.close();
  };
};

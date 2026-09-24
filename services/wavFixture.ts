/**
 * 測試用：做一支跟 ffmpeg 寫到 pipe 時同樣形狀的 16kHz 單聲道 16-bit WAV（RIFF 與 data 長度是 0xFFFFFFFF，
 * fmt 與 data 中間夾一個 LIST chunk，見 services/audioLevel.ts 檔頭）。只給測試用，server 不 import。
 */
export function pipeStyleWav(samples: ArrayLike<number>, sampleRate = 16000): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // 單聲道
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const listBody = Buffer.from('INFOISFT\x0e\x00\x00\x00Lavf62.12.103\x00', 'latin1');
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(listBody.length, 4);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(0xffffffff, 4);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) pcm.writeInt16LE(samples[i], i * 2);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(0xffffffff, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, list, listBody, dataHeader, pcm]);
}

/** 一秒的 440Hz 正弦波，振幅 amplitude（0～32767） */
export const toneWav = (amplitude = 8000): Buffer =>
  pipeStyleWav(Array.from({ length: 16000 }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000))));

export const silentWav = (): Buffer => pipeStyleWav(new Array(16000).fill(0));

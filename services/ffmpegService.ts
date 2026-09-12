import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export async function extractAudio(file: File): Promise<File> {
  const ffmpeg = new FFmpeg();
  
  // Load ffmpeg.wasm-core
  await ffmpeg.load({
    coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
    wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm'
  });

  ffmpeg.on('log', ({ message }) => {
    console.log(message);
  });

  const inputName = 'input' + (file.name.substring(file.name.lastIndexOf('.')) || '.mp4');
  const outputName = 'output.mp3';

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  // Extract audio as mp3
  await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'libmp3lame', '-ac', '1', '-ar', '16000', '-b:a', '64k', outputName]);

  const data = await ffmpeg.readFile(outputName);
  
  return new File([data], outputName, { type: 'audio/mp3' });
}

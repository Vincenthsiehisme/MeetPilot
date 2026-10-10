/**
 * 驗一組 ffmpeg／ffprobe 執行檔能不能處理記錄人實際會丟進來的音檔（vault plan「MeetPilot · 跨平台打包部署」E2）。
 *
 *   npx tsx scripts/verifyFfmpeg.ts <ffmpeg 路徑> <ffprobe 路徑>
 *
 * 桌面 app 隨附的是自己編的最小 ffmpeg（只開音訊用得到的解碼器、容器與 FLAC／WAV 輸出，LGPL），少開一個元件，
 * 某種檔就會在轉錄一開始 FAILED，而三條 gate 全綠（測試全走假的 runner）。這支用 server 自己的
 * `createAudioSlicer` 跑，不另外抄一份 ffmpeg 參數：參數改了這裡跟著變。
 *
 * 每支測試音檔都是 3 秒 440Hz、16kHz（`scripts/ffmpeg-fixtures/`，用完整版 ffmpeg 產的），檢查三件事：
 * 讀得到長度（讀不到時走重包容器那條路，webm 那支刻意沒有長度）；切一段轉得出 16kHz 單聲道 16-bit FLAC
 * 而且寫得進長度（送 Gemini 的那種）；切一段轉得出 16kHz 單聲道 WAV（量音量用的那種）。
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudioSlicer, spawnCommandRunner } from '../services/audioSlicer';

const FIXTURE_SECONDS = 3;
const SLICE_START = 0.5;
const SLICE_SECONDS = 1.5;
// 16kHz × 單聲道 × 16-bit，加 WAV 檔頭
const EXPECTED_SLICE_BYTES = SLICE_SECONDS * 16000 * 2 + 44;

/**
 * 用 ffprobe 讀切出來的 FLAC：取樣率、聲道、取樣格式、長度。長度讀成 N/A 代表 STREAMINFO 沒補寫
 * （寫 pipe 時就是這樣），也算失敗
 */
async function checkFlac(ffprobePath: string, file: string): Promise<string> {
  const result = await spawnCommandRunner(ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,sample_fmt:format=duration',
    '-of', 'default=nw=1', file,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe 讀不了切出來的 FLAC：${result.stderr.trim().slice(-300)}`);
  const fields = Object.fromEntries(
    result.stdout.toString('utf8').trim().split('\n').map((line) => line.split('=') as [string, string]),
  );
  const expected = { codec_name: 'flac', sample_rate: '16000', channels: '1', sample_fmt: 's16' };
  for (const [key, value] of Object.entries(expected)) {
    if (fields[key] !== value) throw new Error(`切出來的 FLAC ${key} 是 ${fields[key]}，應該是 ${value}`);
  }
  const duration = Number(fields.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - SLICE_SECONDS) > 0.1) {
    throw new Error(`切出來的 FLAC 長度是 ${fields.duration}，應該接近 ${SLICE_SECONDS} 秒`);
  }
  return `${duration.toFixed(2)} 秒`;
}

async function main(): Promise<void> {
  const [ffmpegPath, ffprobePath] = process.argv.slice(2);
  if (!ffmpegPath || !ffprobePath) {
    console.error('用法：npx tsx scripts/verifyFfmpeg.ts <ffmpeg 路徑> <ffprobe 路徑>');
    process.exit(1);
  }
  const fixtureDir = fileURLToPath(new URL('./ffmpeg-fixtures/', import.meta.url));
  const fixtures = readdirSync(fixtureDir).filter((name) => !name.startsWith('.')).sort();
  if (fixtures.length === 0) {
    console.error(`${fixtureDir} 沒有任何測試音檔`);
    process.exit(1);
  }

  const slicer = createAudioSlicer({ ffmpegPath, ffprobePath });
  const work = mkdtempSync(join(tmpdir(), 'meetpilot-ffmpeg-verify-'));
  const failures: string[] = [];
  try {
    for (const name of fixtures) {
      // 重包容器會原地覆寫，所以複製一份來跑，不動 repo 裡的測試音檔
      const file = join(work, name);
      copyFileSync(join(fixtureDir, name), file);
      try {
        const duration = await slicer.probeDurationRemuxingIfMissing(file);
        if (Math.abs(duration - FIXTURE_SECONDS) > 0.2) throw new Error(`長度是 ${duration} 秒，應該接近 ${FIXTURE_SECONDS}`);
        const flac = await slicer.readSlice(file, SLICE_START, SLICE_SECONDS, 'flac');
        if (flac.subarray(0, 4).toString('ascii') !== 'fLaC') throw new Error('切出來的不是 FLAC');
        const flacFile = join(work, `${name}.slice.flac`);
        writeFileSync(flacFile, flac);
        const flacDuration = await checkFlac(ffprobePath, flacFile);
        const wav = await slicer.readSlice(file, SLICE_START, SLICE_SECONDS, 'wav');
        if (wav.subarray(0, 4).toString('ascii') !== 'RIFF' || wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
          throw new Error('切出來的不是 WAV');
        }
        if (Math.abs(wav.length - EXPECTED_SLICE_BYTES) > EXPECTED_SLICE_BYTES * 0.1) {
          throw new Error(`切出 ${wav.length} bytes，預期約 ${EXPECTED_SLICE_BYTES}（16kHz 單聲道 ${SLICE_SECONDS} 秒）`);
        }
        console.log(`  ok   ${name}：長度 ${duration.toFixed(2)} 秒，FLAC 切片 ${flac.length} bytes（${flacDuration}），WAV 切片 ${wav.length} bytes`);
      } catch (err) {
        failures.push(name);
        console.log(`  FAIL ${name}：${(err as Error).message.split('\n')[0]}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`[verify-ffmpeg] ${failures.length}／${fixtures.length} 支處理不了：${failures.join('、')}`);
    process.exit(1);
  }
  console.log(`[verify-ffmpeg] 通過：${fixtures.length} 支測試音檔都讀得到長度、切得出 FLAC 與 WAV`);
}

main();

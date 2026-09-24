// electron-builder 的 beforePack hook：打每一份安裝檔之前，確認那個平台與架構的隨附 ffmpeg 已經編好。
//
// extraResources 的來源資料夾不存在時，electron-builder 只印一行 warning 就繼續，產出沒帶 ffmpeg 的安裝檔，
// 記錄人一打開就是「安裝檔裡少了 ffmpeg」。例如本機只編了 mac-arm64 就跑 package:mac（它同時打 arm64 與 x64）。
// 這裡改成直接讓打包失敗，並講出要先跑哪個指令。
const { existsSync } = require('node:fs');
const { join } = require('node:path');

// electron-builder 的 Arch 列舉：0 ia32、1 x64、2 armv7l、3 arm64、4 universal
const ARCH = { 1: 'x64', 3: 'arm64' };
const OS = { darwin: 'mac', win32: 'win' };

exports.default = async function beforePack(context) {
  const os = OS[context.electronPlatformName];
  const arch = ARCH[context.arch];
  if (!os || !arch) {
    throw new Error(`隨附 ffmpeg 只支援 mac／win 的 x64／arm64，這次要打的是 ${context.electronPlatformName}／${context.arch}`);
  }
  const target = `${os}-${arch}`;
  const exe = os === 'win' ? '.exe' : '';
  const dir = join(context.packager.projectDir, 'vendor', 'ffmpeg', target);
  const missing = [`ffmpeg${exe}`, `ffprobe${exe}`, 'LICENSE-ffmpeg.txt', 'NOTICE-ffmpeg.txt'].filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new Error(`vendor/ffmpeg/${target} 缺 ${missing.join('、')}，先跑 npm run ffmpeg:build -- ${target}`);
  }
};

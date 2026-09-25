/**
 * 用 Electron 內建的 Chromium 把 SVG 渲染成透明背景的 PNG，給 `scripts/buildIcons.ts` 呼叫：
 *
 *   electron scripts/icon/renderIcons.cjs <jobs.json>
 *
 * jobs.json 是 `[{ svg, size, out }]`，svg 是 SVG 檔的絕對路徑。
 * 裝置縮放固定 1，輸出的像素就是 size；任何一張失敗就以結束碼 1 離開，不留半套。
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// 每張圖開一個視窗、畫完就關；沒有這行，關掉第一個視窗 app 就結束了
app.on('window-all-closed', () => {});

async function render({ svg, size, out }) {
  // 視窗太小時 Chromium 會拒絕載入，開大一點再只截左上角
  const win = new BrowserWindow({
    show: false, width: Math.max(size, 400), height: Math.max(size, 400),
    useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true },
  });
  try {
    const src = `data:image/svg+xml;base64,${readFileSync(svg).toString('base64')}`;
    const html = `<html><body style="margin:0;background:transparent">` +
      `<img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`;
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await win.webContents.executeJavaScript('document.images[0].decode()');
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const { width, height } = image.getSize();
    if (width !== size || height !== size) throw new Error(`${out}：要 ${size}px，截到 ${width}×${height}`);
    writeFileSync(out, image.toPNG());
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    const jobs = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'));
    for (const job of jobs) await render(job);
    app.exit(0);
  } catch (err) {
    console.error(`[icons] 渲染失敗：${err && err.stack ? err.stack : err}`);
    app.exit(1);
  }
});

// electron-builder 的 afterPack hook：macOS 的 MeetPilot.app 打包完、做成 dmg 之前，整包補一個 ad-hoc 簽章。
//
// 沒有 Apple 開發者帳號，`mac.identity` 是 null，electron-builder 不簽。這時 arm64 的 app 只有 Electron 主程式
// 編譯時 linker 自動加的 ad-hoc 簽章，沒有 sealed resources，`codesign --verify` 回
// `code has no resources but signature indicates they must be present`。檔案從瀏覽器、Teams、OneDrive 拿到時帶檢疫旗標，
// macOS 26 就把它判成「已損毀」，連「仍要打開」都沒有（vault plan「MeetPilot · 跨平台打包部署」，2026-10-05、10-19 兩例）。
// 整包 ad-hoc 簽過之後簽章是完整的，Gatekeeper 改回一般的「無法驗證開發者」，到系統設定按「仍要打開」就能用。
// x64 原本完全沒簽章、可以放行，一起簽是為了兩個架構同一個狀態。
//
// 簽完當場驗，驗不過就讓打包失敗：CI 的 desktop job 在冒煙測試之前就會紅，不會產出一個會被判成已損毀的 dmg。
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`${app} ad-hoc 簽完驗不過，這個 app 帶檢疫旗標時會被 macOS 判成已損毀：${err.message}`);
  }
};

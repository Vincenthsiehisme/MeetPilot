/**
 * 設定頁（electron/setup.html）的 preload（vault plan「MeetPilot · 跨平台打包部署」E3）。
 *
 * 主視窗開著 sandbox，preload 只能用 contextBridge 與 ipcRenderer。這一支掛在主視窗上，所以 server 的頁面
 * 也拿得到 window.meetpilotSetup；主程序的 ipcMain handler 一律驗訊息是不是從設定頁來的，其他頁面叫了會被拒絕。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meetpilotSetup', {
  load: () => ipcRenderer.invoke('setup:load'),
  chooseFolder: (current: string) => ipcRenderer.invoke('setup:choose-folder', current),
  submit: (input: { code: string; vaultDir: string }) => ipcRenderer.invoke('setup:submit', input),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
});

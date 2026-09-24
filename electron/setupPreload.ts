/**
 * 主視窗的 preload：設定頁（electron/setup.html，E3）與 server 頁面的錄音狀態（E4）。
 *
 * 主視窗開著 sandbox，preload 只能用 contextBridge 與 ipcRenderer。這一支掛在主視窗上，所以 server 的頁面
 * 也拿得到 window.meetpilotSetup；主程序的 ipcMain handler 一律驗訊息是不是從設定頁來的，其他頁面叫了會被拒絕。
 */
import { contextBridge, ipcRenderer } from 'electron';

// server 頁面用的（E4 app 內錄音）：告訴主程序現在有沒有在錄。主程序只收 server 頁面來的，
// 據此擋系統閒置睡眠、錄音中不開設定頁、結束前先確認
contextBridge.exposeInMainWorld('meetpilotDesktop', {
  setRecording: (active: boolean) => ipcRenderer.invoke('recording:set', active),
});

contextBridge.exposeInMainWorld('meetpilotSetup', {
  load: () => ipcRenderer.invoke('setup:load'),
  chooseFolder: (current: string) => ipcRenderer.invoke('setup:choose-folder', current),
  submit: (input: { code: string; vaultDir: string }) => ipcRenderer.invoke('setup:submit', input),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
});

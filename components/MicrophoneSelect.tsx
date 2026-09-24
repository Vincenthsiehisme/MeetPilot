import React, { useCallback, useEffect, useState } from 'react';
import { pickInitialDevice } from '../services/inAppRecording';
import { isDesktopApp, listMicrophones } from '../services/micRecorder';

// 上次選的麥克風記在這台電腦的 localStorage：每個人的電腦只有自己用，不必進 server。
// 讀寫都可能被擋（隱私模式、儲存被清），擋掉就當作沒記過，不影響錄音本身
const REMEMBERED_KEY = 'meetpilot.recording.deviceId';
const readRemembered = (): string | null => {
  try {
    return window.localStorage.getItem(REMEMBERED_KEY);
  } catch {
    return null;
  }
};
const remember = (deviceId: string): void => {
  try {
    window.localStorage.setItem(REMEMBERED_KEY, deviceId);
  } catch {
    // 記不住只是下次要再選一次
  }
};

interface MicrophoneSelectProps {
  deviceId: string | null;
  onChange: (deviceId: string | null) => void;
  /** 還不能開始錄的原因（讀不到麥克風、沒有權限）；null 代表可以 */
  onBlockedChange: (reason: string | null) => void;
}

/**
 * 開始錄音前選麥克風（vault plan「MeetPilot · 跨平台打包部署」E4）。Windows 上 Chromium 可能預設挑到
 * 「通訊裝置」而不是平常錄音用的那支，所以一定要讓人看得到、改得了現在用哪一支
 */
const MicrophoneSelect: React.FC<MicrophoneSelectProps> = ({ deviceId, onChange, onBlockedChange }) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);

  const load = useCallback(async () => {
    setDevices(null);
    setError(null);
    onBlockedChange('正在讀取麥克風清單');
    try {
      const found = await listMicrophones();
      const initial = pickInitialDevice(found, readRemembered());
      setDevices(found);
      setForgotten(initial.forgotten);
      onChange(initial.deviceId);
      onBlockedChange(null);
    } catch (err: any) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      onBlockedChange(reason);
    }
  }, [onChange, onBlockedChange]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="px-6 py-3 border-t border-slate-100 bg-rose-50/40">
      <label className="block text-xs font-bold text-slate-600 mb-1.5">
        <i className="fa-solid fa-microphone mr-1 text-rose-500"></i>
        用哪一支麥克風錄
      </label>
      {error !== null ? (
        <div className="text-xs text-rose-700 leading-relaxed">
          {error}
          <button onClick={load} className="ml-2 underline font-bold">再試一次</button>
        </div>
      ) : devices === null ? (
        <p className="text-xs text-slate-400">正在讀取麥克風清單…</p>
      ) : (
        <>
          <select
            value={deviceId ?? ''}
            onChange={(e) => {
              onChange(e.target.value);
              remember(e.target.value);
              setForgotten(false);
            }}
            className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `麥克風 ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          {forgotten && (
            <p className="text-[11px] text-amber-700 mt-1">上次選的麥克風現在不在，先改用上面這一支，要換就重新選。</p>
          )}
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            會關掉回音消除、噪音抑制與自動增益，保留會議室裡遠一點的人聲。
            {isDesktopApp() ? '錄音中關掉視窗會縮到系統匣繼續錄。' : '錄音在這個分頁裡，關掉分頁或重新整理會中斷。'}
          </p>
        </>
      )}
    </div>
  );
};

export default MicrophoneSelect;

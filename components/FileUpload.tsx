
import React, { useRef } from 'react';
import { ACCEPTED_AUDIO_ACCEPT_ATTR, ACCEPTED_AUDIO_EXTENSIONS, pickDroppedAudioFile } from '../services/droppedFiles';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  onRejected?: (reason: string) => void;
  /**
   * `button`：header 用的緊湊按鈕。`zone`：空狀態用的大塊虛線區，讓人看得出這裡收拖曳。
   * 拖放本身不在這個元件裡處理——App.tsx 的整頁 drop handler 接所有拖曳，這裡的 zone 只是
   * 入口的視覺提示加一個開檔案選擇器的點擊面。兩種樣式共用同一個 input 與同一份 accept 判準。
   */
  variant?: 'button' | 'zone';
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, onRejected, variant = 'button' }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    // 清空 input 以便連續上傳同名檔案（先讀 e.target.files 再清空，事件物件之後不能再用）
    e.target.value = '';
    if (!files || files.length === 0) return;
    // 跟拖曳入口走同一套判準（droppedFiles.ts），兩個入口不該有兩套把關強度
    const pick = pickDroppedAudioFile(files);
    if (pick.ok === false) {
      onRejected?.(pick.reason);
      return;
    }
    onFileSelect(pick.file);
  };

  const input = (
    <input
      type="file"
      ref={fileInputRef}
      onChange={handleChange}
      accept={ACCEPTED_AUDIO_ACCEPT_ATTR}
      className="hidden"
    />
  );

  if (variant === 'zone') {
    return (
      <div className="w-full max-w-md">
        {input}
        <button
          type="button"
          onClick={handleClick}
          className="w-full border-2 border-dashed border-indigo-300 hover:border-indigo-500 bg-indigo-50/40 hover:bg-indigo-50 rounded-2xl px-8 py-10 flex flex-col items-center gap-3 transition-colors"
        >
          <i className="fa-solid fa-cloud-arrow-up text-3xl text-indigo-500"></i>
          <span className="text-sm font-bold text-slate-800">把錄音檔拖到這裡，或點這裡選檔</span>
          <span className="text-xs text-slate-500 leading-relaxed">
            支援 {ACCEPTED_AUDIO_EXTENSIONS.join('、')} 或任何音訊／影片檔；拖到這個視窗的任何位置都可以
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end">
      {input}
      <button
        onClick={handleClick}
        className="h-10 w-36 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2 active:scale-95 text-sm"
      >
        <i className="fa-solid fa-cloud-arrow-up"></i>
        建立新任務
      </button>
    </div>
  );
};

export default FileUpload;


import React, { useRef } from 'react';
import { ACCEPTED_AUDIO_ACCEPT_ATTR, pickDroppedAudioFile } from '../services/droppedFiles';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  onRejected?: (reason: string) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, onRejected }) => {
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

  return (
    <div className="flex flex-col items-end">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleChange}
        accept={ACCEPTED_AUDIO_ACCEPT_ATTR}
        className="hidden"
      />
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


import React, { useRef } from 'react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
      // 清空 input 以便連續上傳同名檔案
      e.target.value = '';
    }
  };

  return (
    <div className="flex flex-col items-end">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleChange}
        accept="audio/*,video/*,.mov,.m4a,.mp4,.mp3,.wav,.webm"
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

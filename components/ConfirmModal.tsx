
import React from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
  hideCancel?: boolean;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = '確定',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
  isDestructive = true,
  hideCancel = false
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
          >
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDestructive ? 'bg-rose-50 text-rose-500' : 'bg-indigo-50 text-indigo-500'}`}>
                  <i className={`fa-solid ${isDestructive ? 'fa-triangle-exclamation' : 'fa-circle-info'}`}></i>
                </div>
                <h3 className="text-lg font-bold text-slate-800">{title}</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                {message}
              </p>
            </div>
            <div className="flex border-t border-slate-100">
              {!hideCancel && (
                <button
                  onClick={onCancel}
                  className="flex-1 px-6 py-4 text-sm font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  {cancelLabel}
                </button>
              )}
              <button
                onClick={onConfirm}
                className={`flex-1 px-6 py-4 text-sm font-bold transition-colors ${
                  isDestructive 
                    ? 'text-rose-600 hover:bg-rose-50' 
                    : 'text-indigo-600 hover:bg-indigo-50'
                }`}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ConfirmModal;

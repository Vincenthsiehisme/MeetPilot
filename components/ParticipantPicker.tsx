import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PersonSummary } from '../services/meetingApi';

interface ParticipantPickerProps {
  isOpen: boolean;
  /** null 代表名單還沒讀回來；是否失敗由 loadError 明確區分 */
  people: PersonSummary[] | null;
  loadError: string | null;
  onRetry: () => void;
  onConfirm: (participantIds: string[]) => void;
  onCancel: () => void;
}

/**
 * 建立新會議前的與會者選取（人名校正 N2，SDD D-016：至少一位與會者是 F-CREATE 的前置條件）。
 * 388 人的名單需要搜尋才選得動，純捲動清單不夠用。
 */
const ParticipantPicker: React.FC<ParticipantPickerProps> = ({
  isOpen, people, loadError, onRetry, onConfirm, onCancel,
}) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 開啟時重置：上一次選的結果不該帶進下一次建立會議的畫面
  useMemo(() => {
    if (isOpen) {
      setQuery('');
      setSelected(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!people) return [];
    const q = query.trim().toLowerCase();
    if (q === '') return people;
    return people.filter(
      p => p.displayName.toLowerCase().includes(q)
        || p.department?.toLowerCase().includes(q)
        || p.title?.toLowerCase().includes(q)
        || p.aliases.some(alias => alias.toLowerCase().includes(q))
    );
  }, [people, query]);

  const toggle = (employeeId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId); else next.add(employeeId);
      return next;
    });
  };

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
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]"
          >
            <div className="p-6 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-indigo-50 text-indigo-500">
                  <i className="fa-solid fa-users"></i>
                </div>
                <h3 className="text-lg font-bold text-slate-800">這場會的與會者</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                至少選一位，逐字稿的人名校正靠這份名單。找不到人先照樣選其他人建立會議，事後再人工確認。
              </p>
            </div>

            <div className="p-4 border-b border-slate-100">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜尋姓名、部門或職稱"
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                autoFocus
              />
            </div>

            <div className="flex-1 overflow-y-auto px-4">
              {people === null && loadError !== null ? (
                <div className="py-8 text-center text-sm text-rose-600">
                  <p>名單讀取失敗：{loadError}</p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 font-bold"
                  >
                    重新讀取
                  </button>
                </div>
              ) : people === null ? (
                <div className="py-8 text-center text-sm text-slate-400">讀取名單中…</div>
              ) : filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-400">沒有符合的人</div>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {filtered.map(p => (
                    <li key={p.employeeId}>
                      <label className="flex items-center gap-3 py-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(p.employeeId)}
                          onChange={() => toggle(p.employeeId)}
                          className="w-4 h-4 rounded accent-indigo-600"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-slate-700 truncate">{p.displayName}</span>
                          {(p.title || p.department) && (
                            <span className="block text-xs text-slate-400 truncate">
                              {[p.title, p.department].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex border-t border-slate-100">
              <button
                onClick={onCancel}
                className="flex-1 px-6 py-4 text-sm font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => onConfirm(Array.from(selected))}
                disabled={selected.size === 0}
                className="flex-1 px-6 py-4 text-sm font-bold text-indigo-600 hover:bg-indigo-50 transition-colors disabled:text-slate-300 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              >
                {selected.size === 0 ? '至少選一位' : `建立會議（已選 ${selected.size} 位）`}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ParticipantPicker;

import React, { useState } from 'react';
import { NameMentionView, PersonSummary } from '../services/meetingApi';

interface NameReviewPanelProps {
  /** 這場會的與會者，選人只能從這裡面選（跟 NameResolver 只在與會者別名集合裡比對同一個範圍） */
  participants: PersonSummary[];
  /** 還沒確認的人名（人名校正 N4／N5）。確認後從清單移除，交給呼叫端更新 */
  nameMentions: NameMentionView[];
  onConfirm: (originalText: string, employeeId: string) => void | Promise<void>;
}

/**
 * 人名校正第 3 層（N5）：一鍵確認 `needs_review` 的人名。
 *
 * `short_alias_review`（唯一候選但別名太短）預選那個候選，使用者多半只需要按確認；
 * `conflict_review`（撞到兩個員編）沒有預選，強制使用者自己選，不能維持空白送出——
 * 這裡不猜是哪一個人，猜錯比留著 needs_review 更糟。
 */
const NameReviewPanel: React.FC<NameReviewPanelProps> = ({ participants, nameMentions, onConfirm }) => {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  if (nameMentions.length === 0) return null;

  const handleConfirm = async (mention: NameMentionView) => {
    const employeeId = selections[mention.original_text] ?? mention.employee_id;
    if (!employeeId) return;
    setConfirming(mention.original_text);
    try {
      await onConfirm(mention.original_text, employeeId);
    } finally {
      setConfirming(null);
    }
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
      <h3 className="text-sm font-bold text-amber-900 flex items-center gap-2 mb-1">
        <i className="fa-solid fa-user-check"></i>
        待確認的人名（{nameMentions.length}）
      </h3>
      <p className="text-xs text-amber-700 mb-4">
        逐字稿裡這幾個名字系統不敢直接採用，確認之後同一個字串下次不用再確認。
      </p>
      <div className="space-y-3">
        {nameMentions.map((mention) => {
          const selected = selections[mention.original_text] ?? mention.employee_id ?? '';
          return (
            <div key={mention.original_text} className="bg-white rounded-xl border border-amber-100 p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-800">「{mention.original_text}」</p>
                <p className="text-[10px] text-slate-400">
                  {mention.method === 'conflict_review' ? '對到多個可能的人，請自己選' : '這個名字太短，先確認一下是不是這個人'}
                </p>
              </div>
              <select
                value={selected}
                onChange={(e) => setSelections((prev) => ({ ...prev, [mention.original_text]: e.target.value }))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              >
                <option value="" disabled>選一個人</option>
                {participants.map((p) => (
                  <option key={p.employeeId} value={p.employeeId}>{p.displayName}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={selected === '' || confirming === mention.original_text}
                onClick={() => handleConfirm(mention)}
                className="bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors shrink-0"
              >
                {confirming === mention.original_text ? '確認中…' : '確認'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default NameReviewPanel;


import React, { useState, useRef, useEffect } from 'react';
import { TranscriptSegment, ChatMessage } from '../types';
import { askDocumentStream } from '../services/geminiService';
import { exportChatHistory } from '../services/exportUtils';

interface ChatViewProps {
  fileName: string;
  transcript: TranscriptSegment[];
}

const SUGGESTIONS = [
  "這場會議的主要結論是什麼？",
  "專案目前有哪些潛在風險？",
  "列出待釐清的開放問題",
  "整理時間軸與關鍵事件",
  "誰負責什麼待辦事項？"
];

const ChatView: React.FC<ChatViewProps> = ({ fileName, transcript }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'model', text: '你好！我是你的 AI 會議助理。我已經閱讀了完整的逐字稿，你可以問我關於這場會議的任何細節，例如「有哪些風險？」或「會議中達成的共識是什麼？」。', timestamp: Date.now() }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = async (text: string = input) => {
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', text: text, timestamp: Date.now() };
    const placeholderMsg: ChatMessage = { role: 'model', text: '', timestamp: Date.now() };
    
    setMessages(prev => [...prev, userMsg, placeholderMsg]);
    setInput('');
    setIsLoading(true);

    let fullResponse = "";
    
    try {
      const historyContext = messages.slice(1);
      
      const stream = askDocumentStream(transcript, historyContext, text);
      
      for await (const chunk of stream) {
        fullResponse += chunk;
        setMessages(prev => {
           const newMsgs = [...prev];
           newMsgs[newMsgs.length - 1] = { 
             ...newMsgs[newMsgs.length - 1], 
             text: fullResponse 
           };
           return newMsgs;
        });
      }
    } catch (error: any) {
      setMessages(prev => {
         const newMsgs = [...prev];
         newMsgs[newMsgs.length - 1] = { 
           ...newMsgs[newMsgs.length - 1], 
           text: `抱歉，處理您的請求時發生錯誤：${error.message}` 
         };
         return newMsgs;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 relative">
      {/* Header for Chat View */}
      <div className="px-6 py-3 border-b border-slate-100 bg-white/50 backdrop-blur-sm flex justify-between items-center shrink-0 z-10">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
          <i className="fa-solid fa-robot"></i>
          AI 智慧問答
        </div>
        <button
          onClick={() => exportChatHistory(fileName, messages)}
          className="text-slate-400 hover:text-indigo-600 transition-colors text-xs flex items-center gap-1.5 px-2 py-1 rounded hover:bg-indigo-50"
          title="匯出對話紀錄"
        >
          <i className="fa-solid fa-download"></i>
          匯出紀錄
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 pb-32 scrollbar-thin scrollbar-thumb-slate-200" ref={scrollRef}>
        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          const isLast = idx === messages.length - 1;
          const showTyping = isLoading && isLast && !isUser && msg.text.length === 0;

          return (
            <div key={idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
              <div className={`flex gap-3 max-w-[90%] sm:max-w-[80%] ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm border ${isUser ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-200 text-indigo-600'}`}>
                  <i className={`fa-solid ${isUser ? 'fa-user' : 'fa-robot'} text-sm`}></i>
                </div>
                
                <div className="relative">
                  <div className={`p-4 rounded-2xl shadow-sm text-sm leading-7 whitespace-pre-wrap break-words ${
                    isUser 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'
                  }`}>
                    {msg.text}
                    {showTyping && (
                      <div className="flex items-center gap-1 h-6">
                        <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"></span>
                        <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce delay-100"></span>
                        <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce delay-200"></span>
                      </div>
                    )}
                  </div>
                  
                  {!isUser && msg.text.length > 0 && !isLoading && (
                    <button 
                      onClick={() => handleCopy(msg.text)}
                      className="absolute -bottom-6 left-0 text-[10px] text-slate-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 py-1"
                    >
                      <i className="fa-regular fa-copy"></i> 複製內容
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-200 p-4">
        {messages.length < 3 && (
          <div className="flex gap-2 overflow-x-auto pb-3 scrollbar-hide mb-2 mask-linear-fade">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                onClick={() => handleSend(s)}
                disabled={isLoading}
                className="whitespace-nowrap px-3 py-1.5 bg-white hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 text-xs font-medium rounded-full border border-slate-200 hover:border-indigo-200 transition-all shadow-sm"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        
        <div className="relative max-w-4xl mx-auto flex items-end gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-100 focus-within:border-indigo-300 transition-all shadow-inner">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
               if(e.key === 'Enter' && !e.shiftKey) {
                 e.preventDefault();
                 handleSend();
               }
            }}
            placeholder={isLoading ? "AI 正在思考中..." : "詢問關於此會議的細節..."}
            disabled={isLoading}
            className="flex-1 bg-transparent border-none focus:ring-0 text-slate-700 text-sm py-2.5 px-3 max-h-32 resize-none placeholder:text-slate-400 disabled:opacity-50"
            rows={1}
            style={{ minHeight: '44px' }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all ${
              input.trim() && !isLoading ? 'bg-indigo-600 text-white shadow-md hover:bg-indigo-700 hover:scale-105' : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {isLoading ? <i className="fa-solid fa-circle-notch fa-spin text-sm"></i> : <i className="fa-solid fa-paper-plane text-sm"></i>}
          </button>
        </div>
        <p className="text-[10px] text-center text-slate-300 mt-2">AI 提供的資訊可能包含錯誤，請查核逐字稿內容。</p>
      </div>
    </div>
  );
};

export default ChatView;

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { X, Send, HelpCircle, RotateCcw } from 'lucide-react';
import type { ChatMessage, LangCode } from '../types';

interface HelpChatModalProps {
  isOpen: boolean;
  lang: LangCode;
  onClose: () => void;
  t: Record<string, string>;
}

export function HelpChatModal({ isOpen, lang, onClose, t }: HelpChatModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  if (!isOpen) return null;

  const starterQuestions = [t.chat_q1, t.chat_q2, t.chat_q3, t.chat_q4].filter(Boolean);

  const sendQuestion = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || loading) return;

    setError(null);
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: trimmed,
    };

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
        },
        body: JSON.stringify({
          message: trimmed,
          mode: 'general',
          lang,
          history: messages.map((m) => ({ role: m.role, text: m.text })),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success || !data?.reply) {
        setError(data?.error || 'No se pudo obtener respuesta en este momento.');
        return;
      }

      const modelMsg: ChatMessage = {
        id: `m_${Date.now()}`,
        role: 'model',
        text: String(data.reply),
      };
      setMessages((prev) => [...prev, modelMsg]);
    } catch {
      setError('Error de conexión con el servidor. Inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendQuestion(input);
  };

  const handleClear = () => {
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/75 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.chat_title}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md h-[80vh] sm:h-[540px] sm:max-h-[84vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#0c121d] border border-white/12 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-white/10 bg-[#090e17] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <HelpCircle className="w-5 h-5 text-cyan-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-semibold text-sm sm:text-base text-white truncate">
                {t.chat_title}
              </h2>
              <p className="text-xs text-slate-400 truncate">{t.chat_subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                title={t.chat_clear}
                aria-label={t.chat_clear}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t.btn_close}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Conversation Thread */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3.5">
          <div className="flex justify-start">
            <div className="max-w-[90%] rounded-lg bg-white/[0.04] border border-white/10 px-3.5 py-2.5 text-sm text-slate-200 leading-relaxed">
              {t.chat_welcome}
            </div>
          </div>

          {messages.length === 0 && (
            <div className="flex flex-col gap-1.5 pt-1">
              {starterQuestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => sendQuestion(q)}
                  className="text-left text-xs px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  msg.role === 'user'
                    ? 'bg-cyan-500 text-slate-950 font-medium'
                    : 'bg-white/[0.05] border border-white/10 text-slate-100'
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-white/[0.04] border border-white/10 px-3.5 py-2 text-xs text-slate-400">
                {t.chat_thinking}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3.5 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>

        {/* Input Form */}
        <form
          onSubmit={handleSubmit}
          className="p-3.5 border-t border-white/10 bg-[#090e17] flex items-center gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.chat_placeholder}
            disabled={loading}
            maxLength={2000}
            className="flex-1 rounded-lg bg-white/[0.05] border border-white/10 focus:border-cyan-400/50 focus:outline-none px-3.5 py-2 text-sm text-white placeholder:text-slate-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label={t.chat_send}
            className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">{t.chat_send}</span>
          </button>
        </form>
      </div>
    </div>
  );
}

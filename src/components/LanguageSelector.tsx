import { useState, useRef, useEffect } from 'react';
import { Globe, ChevronDown, Check } from 'lucide-react';
import { I18N, LANG_ORDER } from '../i18n';
import type { LangCode } from '../types';

interface LanguageSelectorProps {
  lang: LangCode;
  onSelectLang: (lang: LangCode) => void;
}

export function LanguageSelector({ lang, onSelectLang }: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const currentDict = I18N[lang];

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Change language"
        aria-expanded={open}
        className="px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
      >
        <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span>{currentDict.lang_flag}</span>
        <span className="hidden sm:inline">{currentDict.lang_name}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-52 rounded-lg bg-[#0b111c] border border-white/15 p-1.5 shadow-2xl z-40">
          {LANG_ORDER.map((code) => {
            const d = I18N[code];
            const active = code === lang;
            return (
              <button
                key={code}
                type="button"
                onClick={() => {
                  onSelectLang(code);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-md text-xs text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-cyan-400/15 text-cyan-300 font-semibold'
                    : 'text-slate-200 hover:bg-white/10'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span>{d.lang_flag}</span>
                  <span>{d.lang_name}</span>
                </span>
                {active && <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

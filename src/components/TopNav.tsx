import { Upload, Menu, Cloud } from 'lucide-react';
import { LanguageSelector } from './LanguageSelector';
import { PWAInstallButton } from './PWAInstallButton';
import type { LangCode, ActiveUser } from '../types';

interface TopNavProps {
  lang: LangCode;
  user: ActiveUser | null;
  onSelectLang: (lang: LangCode) => void;
  onOpenUpload: () => void;
  onOpenDrawer: () => void;
  onOpenAuth: () => void;
  onOpenChat: () => void;
  onNavigateSection: (id: string) => void;
  t: Record<string, string>;
}

export function TopNav({
  lang,
  user,
  onSelectLang,
  onOpenUpload,
  onOpenDrawer,
  onOpenAuth,
  onOpenChat,
  onNavigateSection,
  t,
}: TopNavProps) {
  const initial = (user?.username || user?.email || 'G')[0].toUpperCase();

  return (
    <header className="max-w-5xl mx-auto px-4 sm:px-6 pt-4 w-full">
      <nav
        aria-label="Main navigation"
        className="w-full rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/[0.08] px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4"
      >
        <button
          type="button"
          onClick={() => onNavigateSection('top')}
          className="flex items-center gap-2.5 text-lg font-bold tracking-tight whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Cloud className="w-5 h-5 text-cyan-400" />
          <span>
            Letting<span className="text-cyan-400">Work</span>
          </span>
        </button>

        <div className="flex items-center gap-5 text-sm font-medium text-slate-300">
          <button
            type="button"
            onClick={() => onNavigateSection('top')}
            className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {t.nav_home}
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('about-us')}
            className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {t.nav_about}
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('recent-section')}
            className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {t.nav_files}
          </button>
          <button
            type="button"
            onClick={onOpenChat}
            className="text-cyan-300 hover:text-cyan-200 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {t.nav_help}
          </button>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={onOpenUpload}
            className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t.nav_upload}</span>
          </button>

          <PWAInstallButton t={t} variant="nav" />

          <LanguageSelector lang={lang} onSelectLang={onSelectLang} />

          {!user && (
            <button
              type="button"
              onClick={onOpenAuth}
              className="px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              {t.drawer_btn_login}
            </button>
          )}

          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label={t.nav_menu}
            className="px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/10 border border-white/10 text-xs font-medium text-white flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            {user?.photoUrl ? (
              <img
                src={user.photoUrl}
                alt={user.username || 'Avatar'}
                referrerPolicy="no-referrer"
                className="w-5 h-5 rounded-full object-cover"
              />
            ) : (
              <span className="w-5 h-5 rounded-full bg-cyan-500 text-slate-950 text-[11px] font-bold flex items-center justify-center">
                {initial}
              </span>
            )}
            <span className="max-w-[110px] truncate">
              {user ? user.username : t.nav_menu}
            </span>
            <Menu className="w-3.5 h-3.5" />
          </button>
        </div>
      </nav>
    </header>
  );
}

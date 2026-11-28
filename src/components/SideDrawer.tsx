import { useEffect, useState } from 'react';
import {
  X,
  Upload,
  Folder,
  FileText,
  Info,
  ShieldCheck,
  Activity,
  Home,
  User as UserIcon,
  LogOut,
  MessageCircleQuestion,
  Cloud,
} from 'lucide-react';
import { formatBytes } from '../i18n';
import { PWAInstallButton } from './PWAInstallButton';
import type { ActiveUser } from '../types';

interface SideDrawerProps {
  isOpen: boolean;
  user: ActiveUser | null;
  storageUsedBytes: number;
  storageLimitBytes: number;
  onClose: () => void;
  onOpenUpload: () => void;
  onOpenAuth: (tab: 'login' | 'register') => void;
  onLogout: () => void;
  onOpenSecurity: () => void;
  onOpenChat: () => void;
  onNavigateSection: (sectionId: string) => void;
  t: Record<string, string>;
}

export function SideDrawer({
  isOpen,
  user,
  storageUsedBytes,
  storageLimitBytes,
  onClose,
  onOpenUpload,
  onOpenAuth,
  onLogout,
  onOpenSecurity,
  onOpenChat,
  onNavigateSection,
  t,
}: SideDrawerProps) {
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (active) setServerOk(Boolean(data?.ok));
      })
      .catch(() => {
        if (active) setServerOk(false);
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const maxBytes = storageLimitBytes > 0 ? storageLimitBytes : (user ? 2 * 1024 * 1024 * 1024 : 500 * 1024 * 1024);
  const maxLabel = formatBytes(maxBytes, 0);
  const pct =
    storageUsedBytes > 0
      ? Math.max(1, Math.min(100, Math.round((storageUsedBytes / maxBytes) * 100)))
      : 2;
  const initial = (user?.username || user?.email || 'U')[0].toUpperCase();

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/65 backdrop-blur-xs transition-opacity duration-200 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      />

      <aside
        aria-label={t.nav_menu}
        className={`fixed top-0 right-0 z-50 h-full w-[350px] max-w-[90vw] bg-[#080d16] border-l border-white/10 shadow-2xl flex flex-col transition-transform duration-300 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="px-6 py-4 flex items-center justify-between border-b border-white/10">
          <div className="flex items-center gap-2.5 text-base font-bold tracking-tight">
            <Cloud className="w-5 h-5 text-cyan-400" />
            <span>
              Letting<span className="text-cyan-400">Work</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.btn_close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-5">
          {/* User / Guest Profile Card */}
          <div className="rounded-lg bg-white/[0.03] border border-white/10 p-4">
            <div className="flex items-center gap-3.5 mb-3.5">
              {user?.photoUrl ? (
                <img
                  src={user.photoUrl}
                  alt={user.username || 'Avatar'}
                  referrerPolicy="no-referrer"
                  className="w-10 h-10 rounded-full object-cover border border-cyan-400/40 shrink-0"
                />
              ) : (
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                    user
                      ? 'bg-cyan-500 text-slate-950'
                      : 'bg-white/10 text-slate-400'
                  }`}
                >
                  {user ? initial : <UserIcon className="w-4 h-4" />}
                </div>
              )}
              <div className="min-w-0">
                <div className="font-semibold text-sm text-white truncate">
                  {user ? user.username : t.drawer_guest_greeting}
                </div>
                <div className="text-xs text-slate-400 truncate">
                  {user ? user.email : t.drawer_guest_desc}
                </div>
              </div>
            </div>

            {!user ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuth('login');
                  }}
                  className="flex-1 py-2 px-3 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-semibold text-white whitespace-nowrap cursor-pointer"
                >
                  {t.drawer_btn_login}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuth('register');
                  }}
                  className="flex-1 py-2 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-xs font-semibold text-slate-950 whitespace-nowrap cursor-pointer"
                >
                  {t.drawer_btn_register}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onLogout}
                className="w-full py-2 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-xs font-semibold text-red-300 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{t.drawer_btn_logout}</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenUpload();
            }}
            className="w-full py-2.5 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>{t.drawer_btn_upload}</span>
          </button>

          <PWAInstallButton t={t} variant="drawer" />

          {/* Cloud Storage Meter (500 MB Guest -> 2 GB Registered) */}
          <div className="rounded-lg bg-white/[0.02] border border-white/10 p-4">
            <div className="flex items-center justify-between text-xs mb-2.5 gap-2">
              <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Folder className="w-4 h-4 text-cyan-400" />
                <span>{t.drawer_storage_title}</span>
              </div>
              <span className="text-emerald-400 font-medium text-right">
                {user ? t.drawer_storage_plan_registered : t.drawer_storage_plan}
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden mb-2">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-400 tabular-nums">
              <span>{formatBytes(storageUsedBytes)} / {maxLabel}</span>
              <span>{user ? maxLabel : t.drawer_storage_unmetered}</span>
            </div>
            {!user && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAuth('register');
                }}
                className="mt-3 w-full py-1.5 px-3 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-400/25 text-xs font-medium text-cyan-300 transition-colors cursor-pointer text-center"
              >
                {t.drawer_storage_upgrade}
              </button>
            )}
          </div>

          <ul className="space-y-1">
            <li>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateSection('top');
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer text-left"
              >
                <Home className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>{t.drawer_nav_home}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateSection('recent-section');
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer text-left"
              >
                <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>{t.drawer_nav_my_files}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateSection('about-us');
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer text-left"
              >
                <Info className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>{t.drawer_nav_about}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSecurity();
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer text-left"
              >
                <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>{t.drawer_nav_security}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenChat();
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-cyan-200 hover:bg-cyan-500/10 hover:text-white transition-colors cursor-pointer text-left"
              >
                <MessageCircleQuestion className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>{t.chat_title}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setServerOk(null);
                  fetch('/api/health')
                    .then((res) => res.json())
                    .then((data) => setServerOk(Boolean(data?.ok)))
                    .catch(() => setServerOk(false));
                }}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
              >
                <span className="flex items-center gap-3">
                  <Activity className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>
                    {serverOk === null
                      ? t.drawer_nav_checking
                      : serverOk
                        ? t.drawer_nav_status
                        : t.drawer_nav_degraded}
                  </span>
                </span>
                <span
                  className={`text-xs font-semibold ${
                    serverOk === null
                      ? 'text-slate-400'
                      : serverOk
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                  }`}
                >
                  {serverOk === null ? '...' : serverOk ? 'OK' : '!'}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div className="px-6 py-4 border-t border-white/10 text-xs text-slate-400">
          <div className="flex items-center justify-between font-medium text-slate-300 mb-1">
            <span>{t.drawer_version_text}</span>
            <span className="text-amber-400">{t.drawer_badge_beta}</span>
          </div>
          <p>LettingWork · Cloud Storage</p>
        </div>
      </aside>
    </>
  );
}

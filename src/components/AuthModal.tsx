import React, { useState, useEffect } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { X, AlertCircle, Loader2 } from 'lucide-react';
import { auth, googleProvider, syncUserProfileToFirestore } from '../firebase';
import type { ActiveUser } from '../types';

interface AuthModalProps {
  isOpen: boolean;
  initialTab: 'login' | 'register';
  onClose: () => void;
  onServerAuthSuccess: (user: ActiveUser) => void;
  onSuccessToast: (msg: string) => void;
  t: Record<string, string>;
}

export function AuthModal({
  isOpen,
  initialTab,
  onClose,
  onServerAuthSuccess,
  onSuccessToast,
  t,
}: AuthModalProps) {
  const [tab, setTab] = useState<'login' | 'register'>(initialTab);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTab(initialTab);
      setErrorMsg('');
    }
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const mapGoogleError = (err: unknown): string => {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: string }).code)
        : '';
    if (code === 'auth/popup-closed-by-user') return t.auth_err_popup_closed;
    if (code === 'auth/popup-blocked') return t.auth_err_popup_blocked;
    if (err instanceof Error && err.message) return err.message;
    return t.auth_err_generic;
  };

  const handleGoogleLogin = async () => {
    setErrorMsg('');
    setLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      await syncUserProfileToFirestore(cred.user);
      onSuccessToast(t.toast_google_success);
      onClose();
    } catch (err) {
      setErrorMsg(mapGoogleError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
        },
        body: JSON.stringify({
          identifier: loginIdentifier.trim(),
          password: loginPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.user) {
        setErrorMsg(data.error || t.auth_err_invalid_creds);
        return;
      }
      onServerAuthSuccess({
        uid: data.user.uid,
        username: data.user.username,
        email: data.user.email,
        provider: 'password',
      });
      onSuccessToast(t.toast_login_success);
      onClose();
    } catch {
      setErrorMsg(t.auth_err_generic);
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
        },
        body: JSON.stringify({
          username: regUsername.trim(),
          email: regEmail.trim(),
          password: regPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.user) {
        setErrorMsg(data.error || t.auth_err_generic);
        return;
      }
      onServerAuthSuccess({
        uid: data.user.uid,
        username: data.user.username,
        email: data.user.email,
        provider: 'password',
      });
      onSuccessToast(t.toast_register_success);
      onClose();
    } catch {
      setErrorMsg(t.auth_err_generic);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-xl bg-[#0b111c] border border-white/10 p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t.btn_close}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Tabs */}
        <div className="flex border-b border-white/10 mb-5 mt-1">
          <button
            type="button"
            onClick={() => {
              setTab('login');
              setErrorMsg('');
            }}
            className={`flex-1 py-2.5 text-sm font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              tab === 'login'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.auth_tab_login}
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('register');
              setErrorMsg('');
            }}
            className={`flex-1 py-2.5 text-sm font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
              tab === 'register'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.auth_tab_register}
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-200 leading-relaxed">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Real Google OAuth Sign In */}
        <button
          type="button"
          disabled={loading}
          onClick={handleGoogleLogin}
          className="w-full py-2.5 px-4 rounded-lg bg-white hover:bg-slate-100 text-slate-900 font-semibold text-sm flex items-center justify-center gap-3 transition-colors cursor-pointer disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.15z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.15C3.26 21.36 7.34 24 12 24z" />
            <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.24C.45 8.16 0 9.94 0 12s.45 3.84 1.24 5.42l4.04-3.15z" />
            <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.24 6.58l4.04 3.15c.95-2.83 3.6-4.98 6.72-4.98z" />
          </svg>
          <span>{t.auth_btn_google}</span>
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-500">
          <div className="flex-1 h-px bg-white/10" />
          <span>{t.auth_divider_or}</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        {tab === 'login' ? (
          <form onSubmit={handleLoginSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.auth_label_email}
              </label>
              <input
                type="text"
                required
                value={loginIdentifier}
                onChange={(e) => setLoginIdentifier(e.target.value)}
                placeholder="usuario o correo@ejemplo.com"
                className="w-full px-3.5 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.auth_label_password}
              </label>
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{loading ? t.auth_loading : t.auth_btn_submit_login}</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.auth_label_reg_username}
              </label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={48}
                value={regUsername}
                onChange={(e) => setRegUsername(e.target.value)}
                placeholder="usuario123"
                className="w-full px-3.5 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.auth_label_email}
              </label>
              <input
                type="email"
                required
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                placeholder="tu@email.com"
                className="w-full px-3.5 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {t.auth_label_password}
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                className="w-full px-3.5 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{loading ? t.auth_loading : t.auth_btn_submit_register}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import {
  FileText,
  Download,
  Copy,
  QrCode,
  ShieldCheck,
  Clock,
  Check,
  XCircle,
  ExternalLink,
  ArrowLeft,
  Plus,
  Lock,
  Pencil,
  X,
  AlertTriangle,
} from 'lucide-react';
import { formatBytes } from '../i18n';
import type { FileInfoResponse } from '../types';

interface DownloadViewProps {
  fileId: string;
  canEdit?: boolean;
  onRenameFile?: (newName: string) => Promise<{ name: string; mime: string } | null>;
  onCopyText: (text: string) => void;
  onOpenQr: (url: string) => void;
  onBackHome: () => void;
  onOpenUpload: () => void;
  t: Record<string, string>;
}

function getPreviewKind(
  mimeType: string,
  filename: string
): 'video' | 'audio' | 'image' | 'pdf' | 'text' | 'none' {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) ||
    ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
  ) {
    return 'image';
  }
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    mime === 'text/plain' ||
    mime === 'text/csv' ||
    mime === 'application/json' ||
    ['txt', 'csv', 'json', 'md', 'log'].includes(ext)
  ) {
    return 'text';
  }
  return 'none';
}

export function DownloadView({
  fileId,
  canEdit = false,
  onRenameFile,
  onCopyText,
  onOpenQr,
  onBackHome,
  onOpenUpload,
  t,
}: DownloadViewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'expired' | 'error'>('loading');
  const [file, setFile] = useState<FileInfoResponse | null>(null);
  const [accessToken, setAccessToken] = useState<string>('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setAccessToken('');
    setUnlockPassword('');
    setUnlockError('');
    setEditing(false);

    fetch(`/api/info/${encodeURIComponent(fileId)}`, { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return { httpStatus: res.status, data };
      })
      .then(({ httpStatus, data }) => {
        if (!active) return;
        if (httpStatus === 410 || data.expired) {
          setStatus('expired');
          return;
        }
        if (data.success && data.file) {
          setFile(data.file);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [fileId]);

  const handleUnlockSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!unlockPassword.trim() || unlocking) return;
    setUnlocking(true);
    setUnlockError('');

    try {
      const res = await fetch(`/api/file/${encodeURIComponent(fileId)}/unlock`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
        },
        body: JSON.stringify({ password: unlockPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 410 || data.expired) {
        setStatus('expired');
        return;
      }
      if (!res.ok || !data.success) {
        setUnlockError(t.unlock_wrong_password);
        return;
      }
      if (data.access_token) {
        setAccessToken(data.access_token);
      }
      setFile((prev) => (prev ? { ...prev, unlocked: true } : prev));
    } catch {
      setUnlockError(t.unlock_wrong_password);
    } finally {
      setUnlocking(false);
    }
  };

  const handleSaveRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!onRenameFile || !file || savingName) return;
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === file.original_name) {
      setEditing(false);
      return;
    }
    setSavingName(true);
    try {
      const updated = await onRenameFile(trimmed);
      if (updated) {
        setFile((prev) =>
          prev
            ? {
                ...prev,
                original_name: updated.name,
                mime_type: updated.mime || prev.mime_type,
              }
            : prev
        );
        setEditing(false);
      }
    } finally {
      setSavingName(false);
    }
  };

  const isLocked = Boolean(file?.requires_password && !file?.unlocked && !accessToken);
  const accessQuery = accessToken ? `?access=${encodeURIComponent(accessToken)}` : '';
  const previewKind = file ? getPreviewKind(file.mime_type, file.original_name) : 'none';
  const viewUrl = file ? `/api/view/${file.id}${accessQuery}` : '';
  const downloadUrl = file ? `/api/download/${file.id}${accessQuery}` : '';
  const shareUrl = `${window.location.origin}/f/${fileId}`;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8 pb-6 w-full">
      {/* Top Bar matching LettingWork layout */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <button
          type="button"
          onClick={onBackHome}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-xs sm:text-sm font-medium text-slate-200 hover:text-white transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-cyan-400" />
          <span>{t.btn_back_home}</span>
        </button>

        <button
          type="button"
          onClick={onOpenUpload}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs sm:text-sm font-bold transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t.btn_upload_another}</span>
        </button>
      </div>

      {status === 'loading' && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-10 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-cyan-400/10 border border-cyan-400/25 flex items-center justify-center text-cyan-400">
            <FileText className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">{t.loading_file}</h2>
          <p className="text-sm text-slate-400 mt-2">{t.loading_file_desc}</p>
        </div>
      )}

      {status === 'ready' && file && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-6 sm:p-9 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-xl bg-cyan-400/10 border border-cyan-400/25 flex items-center justify-center text-cyan-400">
            {isLocked ? <Lock className="w-7 h-7" /> : <FileText className="w-7 h-7" />}
          </div>

          {editing ? (
            <form
              onSubmit={handleSaveRename}
              className="flex flex-wrap items-center justify-center gap-2 max-w-lg mx-auto mb-3"
            >
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={220}
                autoFocus
                className="flex-1 min-w-[200px] rounded-lg bg-black/50 border border-cyan-400/60 px-3 py-2 text-sm sm:text-base text-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={savingName}
                className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{t.rename_save}</span>
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/15 text-slate-300 cursor-pointer"
                aria-label={t.btn_cancel}
              >
                <X className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <div className="flex items-center justify-center gap-2.5 mb-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-white break-all">
                {file.original_name}
              </h1>
              {canEdit && onRenameFile && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(file.original_name);
                    setEditing(true);
                  }}
                  aria-label={t.btn_edit_name}
                  title={t.btn_edit_name}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/[0.07] hover:bg-white/15 border border-white/10 text-xs font-medium text-slate-200 cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t.btn_edit_name}</span>
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-slate-400 mb-5 tabular-nums">
            <span>{formatBytes(file.size_bytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{new Date(file.upload_time).toLocaleDateString()}</span>
            <span aria-hidden="true">·</span>
            <span>
              {file.download_count} {t.downloads_suffix}
            </span>
          </div>

          {(file.requires_password || file.expires_at) && (
            <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
              {file.requires_password && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-400/30 text-xs font-semibold text-amber-300">
                  <Lock className="w-3.5 h-3.5" />
                  <span>{t.protected_badge}</span>
                </span>
              )}
              {file.expires_at && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-cyan-500/10 border border-cyan-400/25 text-xs font-semibold text-cyan-300 tabular-nums">
                  <Clock className="w-3.5 h-3.5" />
                  <span>
                    {t.expires_badge}: {new Date(file.expires_at).toLocaleString()}
                  </span>
                </span>
              )}
            </div>
          )}

          {isLocked ? (
            <form
              onSubmit={handleUnlockSubmit}
              className="max-w-md mx-auto rounded-xl bg-black/45 border border-white/10 p-6 space-y-4 mb-6"
            >
              <div className="text-base font-bold text-white">{t.unlock_title}</div>
              <p className="text-xs sm:text-sm text-slate-400">{t.unlock_desc}</p>
              <input
                type="password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                placeholder={t.unlock_placeholder}
                required
                autoFocus
                className="w-full rounded-lg bg-black/50 border border-white/15 focus:border-cyan-400/60 focus:outline-none px-3.5 py-2.5 text-sm text-white"
              />
              {unlockError && (
                <p className="text-xs text-red-400 font-medium">{unlockError}</p>
              )}
              <button
                type="submit"
                disabled={unlocking}
                className="w-full py-2.5 px-5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-slate-950 font-bold text-sm cursor-pointer"
              >
                {unlocking ? t.auth_loading : t.unlock_btn}
              </button>
            </form>
          ) : (
            <>
              {/* Inline Media / File Preview */}
              {previewKind === 'video' && (
                <div className="mb-6 rounded-lg overflow-hidden border border-white/10 bg-black">
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={viewUrl}
                    className="w-full max-h-[460px] mx-auto"
                  />
                </div>
              )}

              {previewKind === 'image' && (
                <div className="mb-6 rounded-lg overflow-hidden border border-white/10 bg-black/60 p-2">
                  <img
                    src={viewUrl}
                    alt={file.original_name}
                    className="max-w-full max-h-[460px] mx-auto rounded object-contain"
                  />
                </div>
              )}

              {previewKind === 'audio' && (
                <div className="mb-6 rounded-lg border border-white/10 bg-black/40 p-4">
                  <audio controls src={viewUrl} className="w-full" />
                </div>
              )}

              {previewKind === 'pdf' && (
                <div className="mb-6 rounded-lg overflow-hidden border border-white/10 bg-black/40">
                  <iframe
                    src={viewUrl}
                    title={file.original_name}
                    className="w-full h-[420px] border-0"
                  />
                </div>
              )}

              {/* Share Link Bar directly on the file page */}
              <div className="flex gap-2 bg-black/40 p-1.5 rounded-lg border border-white/10 mb-5 text-left">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
                  className="flex-1 bg-transparent px-2.5 text-xs sm:text-sm text-slate-200 outline-none min-w-0"
                />
                <button
                  type="button"
                  onClick={() => onCopyText(shareUrl)}
                  className="px-3.5 py-2 rounded-md bg-white/10 hover:bg-white/15 border border-white/10 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t.btn_copy_link}</span>
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                <a
                  href={downloadUrl}
                  className="flex-1 py-3.5 px-6 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-colors"
                >
                  <Download className="w-5 h-5" />
                  <span>
                    {t.btn_download_file} ({formatBytes(file.size_bytes)})
                  </span>
                </a>

                {previewKind !== 'none' && (
                  <a
                    href={viewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="py-3.5 px-5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>{t.btn_view_file}</span>
                  </a>
                )}
              </div>

              <div className="flex flex-wrap justify-center gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => onOpenQr(shareUrl)}
                  className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>{t.btn_qr_code}</span>
                </button>
              </div>
            </>
          )}

          <div className="flex flex-wrap justify-center gap-4 mt-7 pt-5 border-t border-white/10 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              {t.badge_secure}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-cyan-400" />
              {t.badge_no_wait}
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="w-4 h-4 text-cyan-400" />
              {t.badge_clean}
            </span>
          </div>
        </div>
      )}

      {status === 'expired' && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-10 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-400">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">{t.link_expired_title}</h2>
          <p className="text-sm text-slate-400 mt-2 mb-6">{t.link_expired_desc}</p>
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold cursor-pointer"
          >
            {t.btn_back_home}
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-10 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center text-red-400">
            <XCircle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">{t.error_not_available}</h2>
          <p className="text-sm text-slate-400 mt-2 mb-6">{t.error_not_available_desc}</p>
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold cursor-pointer"
          >
            {t.btn_back_home}
          </button>
        </div>
      )}
    </div>
  );
}

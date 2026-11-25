import { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { formatBytes } from '../i18n';
import type { FileInfoResponse } from '../types';

interface DownloadViewProps {
  fileId: string;
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
  onCopyText,
  onOpenQr,
  onBackHome,
  onOpenUpload,
  t,
}: DownloadViewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [file, setFile] = useState<FileInfoResponse | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    fetch(`/api/info/${encodeURIComponent(fileId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
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

  const previewKind = file ? getPreviewKind(file.mime_type, file.original_name) : 'none';
  const viewUrl = file ? `/api/view/${file.id}` : '';
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
            <FileText className="w-7 h-7" />
          </div>

          <h1 className="text-xl sm:text-2xl font-bold text-white break-all mb-2">
            {file.original_name}
          </h1>

          <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-slate-400 mb-6 tabular-nums">
            <span>{formatBytes(file.size_bytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{new Date(file.upload_time).toLocaleDateString()}</span>
            <span aria-hidden="true">·</span>
            <span>
              {file.download_count} {t.downloads_suffix}
            </span>
          </div>

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
              href={`/api/download/${file.id}`}
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

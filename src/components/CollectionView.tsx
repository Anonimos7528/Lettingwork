import { useEffect, useState } from 'react';
import {
  FolderOpen,
  FileText,
  Download,
  Copy,
  QrCode,
  ArrowLeft,
  Plus,
  ExternalLink,
  Lock,
  Clock,
  XCircle,
} from 'lucide-react';
import { formatBytes } from '../i18n';
import type { CollectionDetailResponse } from '../types';

interface CollectionViewProps {
  collectionId: string;
  onNavigateFile: (fileId: string) => void;
  onCopyText: (text: string) => void;
  onOpenQr: (url: string) => void;
  onBackHome: () => void;
  onOpenUpload: () => void;
  t: Record<string, string>;
}

export function CollectionView({
  collectionId,
  onNavigateFile,
  onCopyText,
  onOpenQr,
  onBackHome,
  onOpenUpload,
  t,
}: CollectionViewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [collection, setCollection] = useState<CollectionDetailResponse | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    fetch(`/api/collections/${encodeURIComponent(collectionId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (data.success && data.collection) {
          setCollection(data.collection);
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
  }, [collectionId]);

  const shareUrl = `${window.location.origin}/c/${collectionId}`;
  const totalBytes = collection
    ? collection.files.reduce((acc, f) => acc + (f.size_bytes || 0), 0)
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-6 w-full">
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
            <FolderOpen className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">{t.loading_file}</h2>
          <p className="text-sm text-slate-400 mt-2">{t.loading_file_desc}</p>
        </div>
      )}

      {status === 'ready' && collection && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-12 h-12 rounded-xl bg-cyan-400/10 border border-cyan-400/25 flex items-center justify-center text-cyan-400 shrink-0">
                <FolderOpen className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold text-white break-words">
                  {collection.title}
                </h1>
                <div className="text-xs sm:text-sm text-slate-400 tabular-nums mt-0.5">
                  {(t.collection_files_count || '{count} files').replace(
                    '{count}',
                    String(collection.files.length)
                  )}{' '}
                  · {formatBytes(totalBytes)} ·{' '}
                  {new Date(collection.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onOpenQr(shareUrl)}
              className="px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <QrCode className="w-3.5 h-3.5 text-cyan-400" />
              <span>{t.btn_qr_code}</span>
            </button>
          </div>

          <div className="flex gap-2 bg-black/40 p-1.5 rounded-lg border border-white/10">
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
              className="px-3.5 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{t.btn_copy_link}</span>
            </button>
          </div>

          {collection.files.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 bg-black/25 p-8 text-center text-sm text-slate-400">
              {t.collection_empty}
            </div>
          ) : (
            <div className="divide-y divide-white/[0.07] border border-white/[0.08] rounded-xl bg-black/30 overflow-hidden">
              {collection.files.map((file) => (
                <div
                  key={file.id}
                  className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-2 rounded-lg bg-white/[0.05] text-cyan-400 shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-slate-100 truncate">
                          {file.original_name}
                        </span>
                        {file.requires_password && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 text-[10px] font-semibold text-amber-300">
                            <Lock className="w-2.5 h-2.5" />
                            <span>{t.protected_badge}</span>
                          </span>
                        )}
                        {file.expires_at && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-400/25 text-[10px] font-medium text-cyan-300">
                            <Clock className="w-2.5 h-2.5" />
                            <span>{new Date(file.expires_at).toLocaleDateString()}</span>
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 tabular-nums mt-0.5">
                        {formatBytes(file.size_bytes)} · {file.download_count}{' '}
                        {t.downloads_suffix}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <button
                      type="button"
                      onClick={() => onNavigateFile(file.id)}
                      className="px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/15 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
                      <span>{t.btn_view_file}</span>
                    </button>
                    {!file.requires_password && (
                      <a
                        href={`/api/download/${file.id}`}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>{t.btn_direct_download}</span>
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="rounded-xl bg-[#0a101b]/90 backdrop-blur-sm border border-white/10 p-10 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center text-red-400">
            <XCircle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">{t.collection_not_found}</h2>
          <p className="text-sm text-slate-400 mt-2 mb-6">{t.collection_not_found_desc}</p>
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

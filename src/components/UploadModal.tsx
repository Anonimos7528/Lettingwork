import { useRef, useState, useEffect, type FormEvent } from 'react';
import {
  Upload,
  X,
  FileText,
  Pencil,
  AlertTriangle,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { auth } from '../firebase';
import { formatBytes } from '../i18n';
import type { UploadedFileRecord } from '../types';

interface UploadModalProps {
  isOpen: boolean;
  pendingFile: File | null;
  isAuthenticated: boolean;
  storageUsedBytes: number;
  storageLimitBytes: number;
  onClearPendingFile: () => void;
  onClose: () => void;
  onUploadComplete: (record: UploadedFileRecord) => void;
  onPromptSignUp: (blockedFile: File) => void;
  onToast: (msg: string, isError?: boolean) => void;
  t: Record<string, string>;
}

export function UploadModal({
  isOpen,
  pendingFile,
  isAuthenticated,
  storageUsedBytes,
  storageLimitBytes,
  onClearPendingFile,
  onClose,
  onUploadComplete,
  onPromptSignUp,
  onToast,
  t,
}: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<'idle' | 'ready' | 'uploading' | 'quota_exceeded'>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customName, setCustomName] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadSize, setUploadSize] = useState(0);
  const [percent, setPercent] = useState(0);
  const [transferredText, setTransferredText] = useState('');

  const exceedsQuota = (fileSize: number) => storageUsedBytes + fileSize > storageLimitBytes;

  const prepareFile = (file: File) => {
    setSelectedFile(file);
    setCustomName(file.name);
    if (exceedsQuota(file.size)) {
      setStage('quota_exceeded');
      onToast(
        isAuthenticated ? t.quota_account_exceeded_title : t.quota_guest_exceeded_title,
        true
      );
      return;
    }
    setStage('ready');
  };

  const startUpload = async (file: File, finalName: string) => {
    if (exceedsQuota(file.size)) {
      setStage('quota_exceeded');
      return;
    }

    const cleanName = finalName.trim() || file.name;
    setStage('uploading');
    setUploadName(cleanName);
    setUploadSize(file.size);
    setPercent(0);
    setTransferredText(`0 / ${formatBytes(file.size)}`);

    let idToken: string | null = null;
    if (auth.currentUser) {
      try {
        idToken = await auth.currentUser.getIdToken();
      } catch {
        idToken = null;
      }
    }

    const startTime = Date.now();
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setPercent(pct);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? e.loaded / elapsed : 0;
        setTransferredText(
          `${formatBytes(e.loaded)} / ${formatBytes(e.total)} (${formatBytes(speed)}/s)`
        );
      }
    });

    xhr.addEventListener('load', () => {
      xhrRef.current = null;
      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.success) {
            const record: UploadedFileRecord = {
              id: data.id,
              original_name: data.original_name,
              size_bytes: data.size_bytes,
              mime_type: data.mime_type || 'application/octet-stream',
              share_url: data.share_url,
              delete_token: data.delete_token,
              timestamp: new Date().toISOString(),
            };
            setSelectedFile(null);
            setCustomName('');
            setStage('idle');
            if (inputRef.current) inputRef.current.value = '';
            onUploadComplete(record);
            onToast(t.toast_uploaded);
            return;
          }
          onToast(data.error || 'Upload error', true);
        } catch {
          onToast('Server response error', true);
        }
      } else {
        try {
          const errData = JSON.parse(xhr.responseText);
          if (
            xhr.status === 413 &&
            (errData.code === 'GUEST_QUOTA_EXCEEDED' || errData.code === 'ACCOUNT_QUOTA_EXCEEDED')
          ) {
            setStage('quota_exceeded');
            onToast(errData.error || t.quota_guest_exceeded_title, true);
            return;
          }
          onToast(errData.error || `Error (${xhr.status})`, true);
        } catch {
          onToast(`Error (${xhr.status})`, true);
        }
      }
      setStage('ready');
    });

    xhr.addEventListener('error', () => {
      xhrRef.current = null;
      onToast('Network error during upload', true);
      setStage('ready');
    });

    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Requested-With', 'LettingWork');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(cleanName));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (idToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    }
    xhr.send(file);
  };

  useEffect(() => {
    if (isOpen && pendingFile) {
      prepareFile(pendingFile);
      onClearPendingFile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingFile]);

  const handleConfirmUpload = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;
    startUpload(selectedFile, customName);
  };

  const handleCancel = () => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
      onToast(t.btn_cancel);
    }
    setStage('idle');
    setSelectedFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const resetForm = () => {
    setStage('idle');
    setSelectedFile(null);
    setCustomName('');
    if (inputRef.current) inputRef.current.value = '';
  };

  if (!isOpen) return null;

  const projectedBytes = selectedFile ? storageUsedBytes + selectedFile.size : storageUsedBytes;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl rounded-xl bg-[#0b111c] border border-white/10 p-7 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 text-lg font-bold text-white">
            <Upload className="w-5 h-5 text-cyan-400" />
            <span>{t.upload_modal_title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.btn_close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {stage === 'idle' && (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length > 0) {
                prepareFile(e.dataTransfer.files[0]);
              }
            }}
            className={`rounded-xl border border-dashed p-10 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-cyan-400 bg-cyan-400/10'
                : 'border-white/20 bg-white/[0.02] hover:border-cyan-400/70 hover:bg-cyan-400/[0.04]'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  prepareFile(e.target.files[0]);
                }
              }}
            />
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-cyan-400/10 flex items-center justify-center text-cyan-400">
              <Upload className="w-6 h-6" />
            </div>
            <div className="text-base font-bold text-white mb-1">{t.dropzone_title}</div>
            <div className="text-sm text-slate-400 mb-2">{t.dropzone_subtitle}</div>
            <div className="text-xs text-slate-500">{t.dropzone_hint}</div>
          </div>
        )}

        {stage === 'quota_exceeded' && selectedFile && (
          <div className="rounded-xl bg-amber-500/[0.06] border border-amber-400/35 p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-amber-400/15 text-amber-300 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white">
                  {isAuthenticated ? t.quota_account_exceeded_title : t.quota_guest_exceeded_title}
                </h3>
                <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed">
                  {isAuthenticated ? t.quota_account_exceeded_desc : t.quota_guest_exceeded_desc}
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-black/40 border border-white/10 p-3.5 text-xs space-y-2">
              <div className="flex items-center justify-between text-slate-300 gap-2">
                <span className="truncate font-medium">{selectedFile.name}</span>
                <span className="tabular-nums text-slate-400 shrink-0">
                  {formatBytes(selectedFile.size)}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full w-full bg-amber-400 rounded-full" />
              </div>
              <div className="flex items-center justify-between text-slate-400 tabular-nums">
                <span>{t.quota_usage_label}: {formatBytes(projectedBytes)}</span>
                <span className="font-semibold text-amber-300">
                  / {formatBytes(storageLimitBytes, 0)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-xs sm:text-sm font-medium text-slate-200 cursor-pointer"
              >
                {t.btn_change_file}
              </button>
              {!isAuthenticated && (
                <button
                  type="button"
                  onClick={() => onPromptSignUp(selectedFile)}
                  className="px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs sm:text-sm font-bold flex items-center gap-2 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{t.quota_btn_signup_10gb}</span>
                  <Sparkles className="w-3.5 h-3.5 hidden sm:inline" />
                </button>
              )}
            </div>
          </div>
        )}

        {stage === 'ready' && selectedFile && (
          <form onSubmit={handleConfirmUpload} className="rounded-xl bg-white/[0.03] border border-white/10 p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-lg bg-cyan-400/10 text-cyan-400 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{selectedFile.name}</div>
                  <div className="text-xs text-slate-400 tabular-nums">
                    {formatBytes(selectedFile.size)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={resetForm}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-slate-200 cursor-pointer shrink-0"
              >
                {t.btn_change_file}
              </button>
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1.5">
                <Pencil className="w-3.5 h-3.5 text-cyan-400" />
                <span>{t.upload_filename_label}</span>
              </label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                maxLength={220}
                required
                className="w-full rounded-lg bg-black/40 border border-white/15 focus:border-cyan-400/60 focus:outline-none px-3.5 py-2.5 text-sm text-white"
              />
              <p className="text-xs text-slate-400 mt-1.5">{t.upload_filename_hint}</p>
            </div>

            <div className="flex justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-xs sm:text-sm font-medium text-slate-200 cursor-pointer"
              >
                {t.btn_cancel}
              </button>
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs sm:text-sm font-bold flex items-center gap-2 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>{t.btn_start_upload}</span>
              </button>
            </div>
          </form>
        )}

        {stage === 'uploading' && (
          <div className="rounded-xl bg-white/[0.03] border border-white/10 p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-lg bg-cyan-400/10 text-cyan-400 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{uploadName}</div>
                  <div className="text-xs text-slate-400 tabular-nums">{formatBytes(uploadSize)}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white cursor-pointer shrink-0"
              >
                {t.btn_cancel}
              </button>
            </div>
            <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden mb-2.5">
              <div
                className="h-full bg-cyan-400 transition-all duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-400 tabular-nums">
              <span>{transferredText}</span>
              <span className="font-bold text-cyan-400">{percent}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useRef, useState, useEffect, type FormEvent } from 'react';
import {
  Upload,
  X,
  FileText,
  Pencil,
  AlertTriangle,
  Sparkles,
  UserPlus,
  Plus,
  Lock,
  Clock,
  FolderPlus,
  CheckCircle2,
  Copy,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import { auth } from '../firebase';
import { formatBytes } from '../i18n';
import type {
  ExpirationPreset,
  FileCollectionSummary,
  UploadedFileRecord,
} from '../types';

interface QueuedFileItem {
  id: string;
  file: File;
  customName: string;
}

interface UploadModalProps {
  isOpen: boolean;
  pendingFiles: File[];
  isAuthenticated: boolean;
  storageUsedBytes: number;
  storageLimitBytes: number;
  onClearPendingFiles: () => void;
  onClose: () => void;
  onFilesUploaded: (
    records: UploadedFileRecord[],
    createdCollection: FileCollectionSummary | null
  ) => void;
  onPromptSignUp: (blockedFiles: File[]) => void;
  onCopyText: (text: string) => void;
  onOpenFilePage: (fileId: string) => void;
  onOpenCollectionPage: (collectionId: string) => void;
  onToast: (msg: string, isError?: boolean) => void;
  t: Record<string, string>;
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '1s';
  const secs = Math.ceil(totalSeconds);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

export function UploadModal({
  isOpen,
  pendingFiles,
  isAuthenticated,
  storageUsedBytes,
  storageLimitBytes,
  onClearPendingFiles,
  onClose,
  onFilesUploaded,
  onPromptSignUp,
  onCopyText,
  onOpenFilePage,
  onOpenCollectionPage,
  onToast,
  t,
}: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const cancelledRef = useRef(false);

  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<'idle' | 'ready' | 'uploading' | 'quota_exceeded' | 'done'>(
    'idle'
  );
  const [queue, setQueue] = useState<QueuedFileItem[]>([]);
  const [password, setPassword] = useState('');
  const [expiresPreset, setExpiresPreset] = useState<ExpirationPreset>('never');
  const [createCollection, setCreateCollection] = useState(false);
  const [collectionTitle, setCollectionTitle] = useState('');

  // Progress state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [currentFileSize, setCurrentFileSize] = useState(0);
  const [overallPercent, setOverallPercent] = useState(0);
  const [transferredText, setTransferredText] = useState('');
  const [etaText, setEtaText] = useState('');

  // Batch completion state
  const [uploadedResults, setUploadedResults] = useState<UploadedFileRecord[]>([]);
  const [createdCollection, setCreatedCollection] = useState<FileCollectionSummary | null>(null);

  const totalQueueBytes = queue.reduce((acc, item) => acc + item.file.size, 0);
  const exceedsQuota = (extraBytes: number) => storageUsedBytes + extraBytes > storageLimitBytes;

  const addFilesToQueue = (files: File[]) => {
    if (!files || files.length === 0) return;
    const nextItems: QueuedFileItem[] = files.map((file, idx) => ({
      id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      file,
      customName: file.name,
    }));

    setQueue((prev) => {
      const merged = [...prev, ...nextItems];
      const mergedBytes = merged.reduce((acc, q) => acc + q.file.size, 0);
      if (exceedsQuota(mergedBytes)) {
        setStage('quota_exceeded');
        onToast(
          isAuthenticated ? t.quota_account_exceeded_title : t.quota_guest_exceeded_title,
          true
        );
      } else {
        setStage('ready');
      }
      return merged;
    });
  };

  useEffect(() => {
    if (isOpen && pendingFiles.length > 0) {
      addFilesToQueue(pendingFiles);
      onClearPendingFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingFiles]);

  const resetForm = () => {
    cancelledRef.current = false;
    setStage('idle');
    setQueue([]);
    setPassword('');
    setExpiresPreset('never');
    setCreateCollection(false);
    setCollectionTitle('');
    setUploadedResults([]);
    setCreatedCollection(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleCloseModal = () => {
    if (stage === 'uploading') {
      cancelledRef.current = true;
      if (xhrRef.current) {
        xhrRef.current.abort();
        xhrRef.current = null;
      }
      setStage('ready');
    }
    if (stage === 'done') {
      resetForm();
    }
    onClose();
  };

  const handleCancelUpload = () => {
    cancelledRef.current = true;
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    onToast(t.btn_cancel);
    setStage('ready');
  };

  const uploadSingleFileXhr = async (
    item: QueuedFileItem,
    idToken: string | null,
    completedBytesBefore: number,
    batchTotalBytes: number,
    batchStartTime: number
  ): Promise<UploadedFileRecord> => {
    const cleanName = item.customName.trim() || item.file.name;
    setCurrentFileName(cleanName);
    setCurrentFileSize(item.file.size);

    const updateProgress = (loadedBytes: number) => {
      const totalLoaded = completedBytesBefore + loadedBytes;
      const pct = batchTotalBytes > 0 ? Math.min(100, Math.round((totalLoaded / batchTotalBytes) * 100)) : 0;
      setOverallPercent(pct);

      const elapsed = (Date.now() - batchStartTime) / 1000;
      const speed = elapsed > 0.25 ? totalLoaded / elapsed : 0;
      const remainingBytes = Math.max(0, batchTotalBytes - totalLoaded);
      const etaSecs = speed > 0 ? remainingBytes / speed : 0;

      setTransferredText(
        `${formatBytes(totalLoaded)} / ${formatBytes(batchTotalBytes)} (${formatBytes(speed)}/s)`
      );
      if (speed > 0 && remainingBytes > 0) {
        setEtaText(
          (t.upload_eta_remaining || '{time} left').replace('{time}', formatDuration(etaSecs))
        );
      } else {
        setEtaText('');
      }
    };

    // Check whether direct Supabase Storage signed upload is enabled (required on Vercel for >4.5 MB files)
    let directInit: { signedUrl?: string; completeToken?: string; mimeType?: string } | null = null;
    try {
      const initRes = await fetch('/api/upload-init', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          original_name: cleanName,
          size_bytes: item.file.size,
          mime_type: item.file.type || 'application/octet-stream',
          password: password.trim() || undefined,
          expires_in: expiresPreset !== 'never' ? expiresPreset : undefined,
        }),
      });

      const initData = await initRes.json().catch(() => ({}));
      if (!initRes.ok) {
        if (
          initRes.status === 413 &&
          (initData.code === 'GUEST_QUOTA_EXCEEDED' || initData.code === 'ACCOUNT_QUOTA_EXCEEDED')
        ) {
          const quotaErr = new Error(initData.error || t.quota_guest_exceeded_title) as Error & {
            isQuota?: boolean;
          };
          quotaErr.isQuota = true;
          throw quotaErr;
        }
        throw new Error(initData.error || `Error (${initRes.status})`);
      }
      if (initData.mode === 'direct' && initData.signedUrl && initData.completeToken) {
        directInit = initData;
      }
    } catch (err) {
      if ((err as Error & { isQuota?: boolean })?.isQuota || (err as Error)?.message) {
        if (directInit === null && (err as Error).message.includes('50 MB')) {
          throw err;
        }
        if ((err as Error & { isQuota?: boolean }).isQuota) {
          throw err;
        }
      }
    }

    if (directInit?.signedUrl && directInit.completeToken) {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) updateProgress(e.loaded);
        });

        xhr.addEventListener('load', () => {
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Cloud storage upload error (${xhr.status})`));
          }
        });

        xhr.addEventListener('error', () => {
          xhrRef.current = null;
          reject(new Error('Network error during cloud upload'));
        });

        xhr.addEventListener('abort', () => {
          xhrRef.current = null;
          reject(new Error('ABORTED'));
        });

        xhr.open('PUT', directInit.signedUrl!);
        xhr.setRequestHeader('Content-Type', directInit.mimeType || item.file.type || 'application/octet-stream');
        xhr.send(item.file);
      });

      const completeRes = await fetch('/api/upload-complete', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
        },
        body: JSON.stringify({ completeToken: directInit.completeToken }),
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok || !completeData.success) {
        throw new Error(completeData.error || 'Could not finalize upload');
      }
      return {
        id: completeData.id,
        original_name: completeData.original_name,
        size_bytes: completeData.size_bytes,
        mime_type: completeData.mime_type || 'application/octet-stream',
        share_url: completeData.share_url,
        delete_token: completeData.delete_token,
        timestamp: new Date().toISOString(),
        download_count: 0,
        has_password: Boolean(completeData.has_password),
        expires_at: completeData.expires_at || null,
      };
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.withCredentials = true;

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) updateProgress(e.loaded);
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
                download_count: 0,
                has_password: Boolean(data.has_password),
                expires_at: data.expires_at || null,
              };
              resolve(record);
              return;
            }
            reject(new Error(data.error || 'Upload error'));
          } catch {
            reject(new Error('Server response error'));
          }
          return;
        }

        try {
          const errData = JSON.parse(xhr.responseText);
          if (
            xhr.status === 413 &&
            (errData.code === 'GUEST_QUOTA_EXCEEDED' || errData.code === 'ACCOUNT_QUOTA_EXCEEDED')
          ) {
            const quotaErr = new Error(errData.error || t.quota_guest_exceeded_title) as Error & {
              isQuota?: boolean;
            };
            quotaErr.isQuota = true;
            reject(quotaErr);
            return;
          }
          reject(new Error(errData.error || `Error (${xhr.status})`));
        } catch {
          reject(new Error(`Error (${xhr.status})`));
        }
      });

      xhr.addEventListener('error', () => {
        xhrRef.current = null;
        reject(new Error('Network error during upload'));
      });

      xhr.addEventListener('abort', () => {
        xhrRef.current = null;
        reject(new Error('ABORTED'));
      });

      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Requested-With', 'LettingWork');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(cleanName));
      xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
      if (password.trim()) {
        xhr.setRequestHeader('X-File-Password', encodeURIComponent(password.trim()));
      }
      if (expiresPreset !== 'never') {
        xhr.setRequestHeader('X-File-Expires', expiresPreset);
      }
      if (idToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
      }
      xhr.send(item.file);
    });
  };

  const handleConfirmUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (queue.length === 0) return;

    if (exceedsQuota(totalQueueBytes)) {
      setStage('quota_exceeded');
      return;
    }

    cancelledRef.current = false;
    setStage('uploading');
    setTotalCount(queue.length);
    setCurrentIndex(1);
    setOverallPercent(0);
    setEtaText('');
    setTransferredText(`0 / ${formatBytes(totalQueueBytes)}`);

    let idToken: string | null = null;
    if (auth.currentUser) {
      try {
        idToken = await auth.currentUser.getIdToken();
      } catch {
        idToken = null;
      }
    }

    const batchStartTime = Date.now();
    let completedBytes = 0;
    const uploaded: UploadedFileRecord[] = [];

    try {
      for (let i = 0; i < queue.length; i++) {
        if (cancelledRef.current) break;
        setCurrentIndex(i + 1);
        const item = queue[i];
        const record = await uploadSingleFileXhr(
          item,
          idToken,
          completedBytes,
          totalQueueBytes,
          batchStartTime
        );
        uploaded.push(record);
        completedBytes += item.file.size;
      }

      if (cancelledRef.current) {
        if (uploaded.length > 0) {
          onFilesUploaded(uploaded, null);
        }
        return;
      }

      let collectionSummary: FileCollectionSummary | null = null;
      if (createCollection && uploaded.length >= 2) {
        try {
          const tokens: Record<string, string> = {};
          uploaded.forEach((rec) => {
            if (rec.delete_token) tokens[rec.id] = rec.delete_token;
          });
          const colRes = await fetch('/api/collections', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'LettingWork',
              ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
            },
            body: JSON.stringify({
              title: collectionTitle.trim() || t.collection_default_title || 'Shared Folder',
              file_ids: uploaded.map((r) => r.id),
              tokens,
            }),
          });
          const colData = await colRes.json();
          if (colRes.ok && colData.success && colData.collection) {
            collectionSummary = colData.collection;
          }
        } catch {
          // Non-fatal if collection creation fails; uploaded files still succeeded
        }
      }

      onToast(t.toast_uploaded);

      if (uploaded.length === 1 && !collectionSummary) {
        resetForm();
        onFilesUploaded(uploaded, null);
      } else {
        setUploadedResults(uploaded);
        setCreatedCollection(collectionSummary);
        setStage('done');
        onFilesUploaded(uploaded, collectionSummary);
      }
    } catch (err: unknown) {
      if (uploaded.length > 0) {
        onFilesUploaded(uploaded, null);
      }
      const errObj = err as Error & { isQuota?: boolean };
      if (errObj.message === 'ABORTED') {
        setStage('ready');
        return;
      }
      if (errObj.isQuota) {
        setStage('quota_exceeded');
        onToast(errObj.message, true);
        return;
      }
      onToast(errObj.message || 'Upload error', true);
      setStage('ready');
    }
  };

  if (!isOpen) return null;

  const projectedBytes = storageUsedBytes + totalQueueBytes;
  const batchProgressLabel = (t.upload_batch_progress || 'File {current} of {total}')
    .replace('{current}', String(currentIndex))
    .replace('{total}', String(totalCount));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={handleCloseModal}
    >
      <div
        className="relative w-full max-w-xl rounded-xl bg-[#0b111c] border border-white/10 p-6 sm:p-7 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 text-lg font-bold text-white">
            <Upload className="w-5 h-5 text-cyan-400" />
            <span>{t.upload_modal_title}</span>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            aria-label={t.btn_close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              addFilesToQueue(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
        />

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
                addFilesToQueue(Array.from(e.dataTransfer.files));
              }
            }}
            className={`rounded-xl border border-dashed p-10 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-cyan-400 bg-cyan-400/10'
                : 'border-white/20 bg-white/[0.02] hover:border-cyan-400/70 hover:bg-cyan-400/[0.04]'
            }`}
          >
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-cyan-400/10 flex items-center justify-center text-cyan-400">
              <Upload className="w-6 h-6" />
            </div>
            <div className="text-base font-bold text-white mb-1">{t.dropzone_title}</div>
            <div className="text-sm text-slate-400 mb-2">{t.dropzone_subtitle}</div>
            <div className="text-xs text-slate-500">{t.dropzone_hint}</div>
          </div>
        )}

        {stage === 'quota_exceeded' && queue.length > 0 && (
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
                <span className="truncate font-medium">
                  {queue.length === 1
                    ? queue[0].customName
                    : (t.upload_files_count || '{count} files ready').replace(
                        '{count}',
                        String(queue.length)
                      )}
                </span>
                <span className="tabular-nums text-slate-400 shrink-0">
                  {formatBytes(totalQueueBytes)}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full w-full bg-amber-400 rounded-full" />
              </div>
              <div className="flex items-center justify-between text-slate-400 tabular-nums">
                <span>
                  {t.quota_usage_label}: {formatBytes(projectedBytes)}
                </span>
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
                  onClick={() => onPromptSignUp(queue.map((q) => q.file))}
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

        {stage === 'ready' && queue.length > 0 && (
          <form
            onSubmit={handleConfirmUpload}
            className="rounded-xl bg-white/[0.03] border border-white/10 p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-cyan-300">
                {(t.upload_files_count || '{count} files ready').replace(
                  '{count}',
                  String(queue.length)
                )}{' '}
                · {formatBytes(totalQueueBytes)}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-slate-200 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t.upload_add_more}</span>
                </button>
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-xs font-medium text-slate-300 cursor-pointer"
                >
                  {t.btn_change_file}
                </button>
              </div>
            </div>

            {/* Editable filename queue */}
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {queue.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg bg-black/40 border border-white/10 p-2.5 flex items-center gap-2.5"
                >
                  <div className="p-2 rounded-md bg-cyan-400/10 text-cyan-400 shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Pencil className="w-3 h-3 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        value={item.customName}
                        onChange={(e) => {
                          const val = e.target.value;
                          setQueue((prev) =>
                            prev.map((q) => (q.id === item.id ? { ...q, customName: val } : q))
                          );
                        }}
                        maxLength={220}
                        required
                        aria-label={t.upload_filename_label}
                        className="w-full bg-transparent border-b border-white/10 focus:border-cyan-400/70 focus:outline-none text-xs sm:text-sm text-white py-0.5"
                      />
                    </div>
                    <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                      {formatBytes(item.file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setQueue((prev) => {
                        const filtered = prev.filter((q) => q.id !== item.id);
                        if (filtered.length === 0) setStage('idle');
                        return filtered;
                      });
                    }}
                    aria-label={t.btn_cancel}
                    className="p-1.5 rounded-md text-slate-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400">{t.upload_filename_hint}</p>

            {/* Optional Security & Expiration controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-white/[0.08]">
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1.5">
                  <Lock className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t.upload_password_label}</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={128}
                  placeholder={t.upload_password_placeholder}
                  className="w-full rounded-lg bg-black/40 border border-white/15 focus:border-cyan-400/60 focus:outline-none px-3 py-2 text-xs sm:text-sm text-white placeholder:text-slate-500"
                />
              </div>

              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1.5">
                  <Clock className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t.upload_expires_label}</span>
                </label>
                <select
                  value={expiresPreset}
                  onChange={(e) => setExpiresPreset(e.target.value as ExpirationPreset)}
                  className="w-full rounded-lg bg-black/40 border border-white/15 focus:border-cyan-400/60 focus:outline-none px-3 py-2 text-xs sm:text-sm text-white cursor-pointer"
                >
                  <option value="never" className="bg-[#0b111c] text-white">
                    {t.expires_never}
                  </option>
                  <option value="1h" className="bg-[#0b111c] text-white">
                    {t.expires_1h}
                  </option>
                  <option value="24h" className="bg-[#0b111c] text-white">
                    {t.expires_24h}
                  </option>
                  <option value="7d" className="bg-[#0b111c] text-white">
                    {t.expires_7d}
                  </option>
                  <option value="30d" className="bg-[#0b111c] text-white">
                    {t.expires_30d}
                  </option>
                </select>
              </div>
            </div>

            {queue.length >= 2 && (
              <div className="rounded-lg bg-cyan-500/[0.06] border border-cyan-400/20 p-3 space-y-2">
                <label className="flex items-center gap-2.5 text-xs font-semibold text-slate-200 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={createCollection}
                    onChange={(e) => setCreateCollection(e.target.checked)}
                    className="w-4 h-4 rounded accent-cyan-400 cursor-pointer"
                  />
                  <FolderPlus className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>{t.upload_create_collection}</span>
                </label>
                {createCollection && (
                  <input
                    type="text"
                    value={collectionTitle}
                    onChange={(e) => setCollectionTitle(e.target.value)}
                    maxLength={120}
                    placeholder={t.upload_collection_name_placeholder}
                    className="w-full rounded-lg bg-black/40 border border-white/15 focus:border-cyan-400/60 focus:outline-none px-3 py-2 text-xs text-white placeholder:text-slate-500"
                  />
                )}
              </div>
            )}

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
          <div className="rounded-xl bg-white/[0.03] border border-white/10 p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-lg bg-cyan-400/10 text-cyan-400 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  {totalCount > 1 && (
                    <div className="text-[11px] font-semibold text-cyan-400 mb-0.5">
                      {batchProgressLabel}
                    </div>
                  )}
                  <div className="text-sm font-semibold text-white truncate">{currentFileName}</div>
                  <div className="text-xs text-slate-400 tabular-nums">
                    {formatBytes(currentFileSize)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelUpload}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white cursor-pointer shrink-0"
              >
                {t.btn_cancel}
              </button>
            </div>

            <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-cyan-400 transition-all duration-150"
                style={{ width: `${overallPercent}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 tabular-nums">
              <span>{transferredText}</span>
              <div className="flex items-center gap-3">
                {etaText && <span className="text-slate-300">{etaText}</span>}
                <span className="font-bold text-cyan-400">{overallPercent}%</span>
              </div>
            </div>
          </div>
        )}

        {stage === 'done' && (
          <div className="rounded-xl bg-white/[0.03] border border-white/10 p-5 space-y-4">
            <div className="flex items-center gap-2.5 text-emerald-400 font-bold text-base">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <span>{t.upload_multi_done_title}</span>
            </div>

            {createdCollection && (
              <div className="rounded-lg bg-cyan-500/10 border border-cyan-400/35 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-white min-w-0">
                    <FolderOpen className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span className="truncate">{createdCollection.title}</span>
                  </div>
                  <span className="text-xs text-cyan-300 shrink-0">
                    {(t.collection_files_count || '{count} files').replace(
                      '{count}',
                      String(createdCollection.file_count)
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onCopyText(`${window.location.origin}${createdCollection.share_url}`)
                    }
                    className="flex-1 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t.btn_copy_link}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const cid = createdCollection.id;
                      resetForm();
                      onClose();
                      onOpenCollectionPage(cid);
                    }}
                    className="px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>{t.btn_open_collection}</span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {uploadedResults.map((rec) => {
                const fullUrl = `${window.location.origin}${rec.share_url}`;
                return (
                  <div
                    key={rec.id}
                    className="rounded-lg bg-black/40 border border-white/10 p-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-medium text-white truncate">
                        {rec.original_name}
                      </div>
                      <div className="text-[11px] text-slate-400 tabular-nums">
                        {formatBytes(rec.size_bytes)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onCopyText(fullUrl)}
                        className="px-2.5 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-xs font-medium text-white flex items-center gap-1 cursor-pointer"
                      >
                        <Copy className="w-3 h-3 text-cyan-400" />
                        <span>{t.btn_copy_short}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          resetForm();
                          onClose();
                          onOpenFilePage(rec.id);
                        }}
                        aria-label={t.btn_open_page}
                        className="p-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-200 cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs sm:text-sm font-bold cursor-pointer"
              >
                {t.btn_done}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

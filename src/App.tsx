import { useEffect, useState, useCallback, useMemo } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  updateDoc,
  writeBatch,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import {
  Upload,
  Menu,
  Globe,
  Zap,
  Lock,
  Clock,
  FileText,
  Copy,
  ExternalLink,
  Trash2,
  ShieldCheck,
  X,
  HelpCircle,
  Pencil,
  Check,
  Search,
} from 'lucide-react';
import pdfBgSvg from './assets/lettingwork_pdf_bg.svg';
import portadaImg from './assets/lettingwork_portada.png';
import aboutUsImg from './assets/lettingwork_about_us.png';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  GUEST_STORAGE_LIMIT_BYTES,
  REGISTERED_STORAGE_LIMIT_BYTES,
  STORAGE_TIER_REGISTERED,
  syncUserProfileToFirestore,
} from './firebase';
import { I18N, formatBytes } from './i18n';
import type { LangCode, UploadedFileRecord, ActiveUser, FirestoreUserProfile } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopNav } from './components/TopNav';
import { SideDrawer } from './components/SideDrawer';
import { UploadModal } from './components/UploadModal';
import { AuthModal } from './components/AuthModal';
import { QrModal } from './components/QrModal';
import { DownloadView } from './components/DownloadView';
import { HelpChatModal } from './components/HelpChatModal';
import { StorageQuotaBar } from './components/StorageQuotaBar';

const LOCAL_FILES_KEY = 'lettingwork_uploads';

function readLocalFiles(): UploadedFileRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_FILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalFiles(items: UploadedFileRecord[]) {
  try {
    localStorage.setItem(LOCAL_FILES_KEY, JSON.stringify(items.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

function LettingWorkApp() {
  const [lang, setLang] = useState<LangCode>(() => {
    const saved = localStorage.getItem('lettingwork_lang_v2') as LangCode | null;
    return saved && I18N[saved] ? saved : 'en';
  });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [firestoreProfile, setFirestoreProfile] = useState<FirestoreUserProfile | null>(null);
  const [serverUser, setServerUser] = useState<ActiveUser | null>(null);

  const [localFiles, setLocalFiles] = useState<UploadedFileRecord[]>(() => readLocalFiles());
  const [cloudFiles, setCloudFiles] = useState<UploadedFileRecord[]>([]);
  const [serverFiles, setServerFiles] = useState<UploadedFileRecord[]>([]);
  const [cloudFilesLoading, setCloudFilesLoading] = useState(false);
  const [serverFilesLoading, setServerFilesLoading] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingDropFile, setPendingDropFile] = useState<File | null>(null);
  const [queuedQuotaFile, setQueuedQuotaFile] = useState<File | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialTab, setAuthInitialTab] = useState<'login' | 'register'>('login');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  const [heroImgError, setHeroImgError] = useState(false);
  const [aboutImgError, setAboutImgError] = useState(false);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigateToPath = useCallback((nextPath: string) => {
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
      setCurrentPath(nextPath);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const t = I18N[lang];
  const isDownloadRoute = currentPath.startsWith('/f/');
  const downloadFileId = isDownloadRoute
    ? currentPath.replace(/^\/f\//, '').replace(/\/+$/, '')
    : '';

  const showToast = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleSelectLang = useCallback((next: LangCode) => {
    setLang(next);
    localStorage.setItem('lettingwork_lang_v2', next);
  }, []);

  const loadServerUserFiles = useCallback(async () => {
    setServerFilesLoading(true);
    try {
      const res = await fetch('/api/user/files', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.files)) {
        const mapped: UploadedFileRecord[] = data.files.map(
          (f: {
            id: string;
            original_name: string;
            size_bytes: number;
            mime_type?: string;
            delete_token?: string;
            upload_time: string;
          }) => ({
            id: f.id,
            original_name: f.original_name,
            size_bytes: f.size_bytes,
            mime_type: f.mime_type || 'application/octet-stream',
            share_url: `/f/${f.id}`,
            delete_token: f.delete_token || '',
            timestamp: f.upload_time,
          })
        );
        setServerFiles(mapped);
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setServerFilesLoading(false);
    }
  }, []);

  // Listen to Firebase Auth state (Google OAuth)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setFirebaseUser(fbUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Check persistent server session on startup
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setServerUser({
            uid: data.user.uid,
            username: data.user.username,
            email: data.user.email,
            provider: 'password',
            storageTier: data.user.storage_tier || 'free_10gb',
            storageLimitBytes: data.user.storage_limit_bytes || REGISTERED_STORAGE_LIMIT_BYTES,
            storageUsedBytes: data.user.storage_used_bytes || 0,
          });
          loadServerUserFiles();
        }
      })
      .catch(() => {});
  }, [loadServerUserFiles]);

  // Unified active user
  const activeUser: ActiveUser | null = useMemo(() => {
    if (firebaseUser) {
      return {
        uid: firebaseUser.uid,
        username:
          firestoreProfile?.username ||
          firebaseUser.displayName ||
          firebaseUser.email?.split('@')[0] ||
          'User',
        email: firestoreProfile?.email || firebaseUser.email || '',
        provider: 'google',
        photoUrl: firestoreProfile?.photoUrl || firebaseUser.photoURL,
        storageTier: firestoreProfile?.storageTier || STORAGE_TIER_REGISTERED,
        storageLimitBytes: firestoreProfile?.storageLimitBytes || REGISTERED_STORAGE_LIMIT_BYTES,
        storageUsedBytes: firestoreProfile?.storageUsedBytes ?? 0,
      };
    }
    return serverUser;
  }, [firebaseUser, firestoreProfile, serverUser]);

  // Sync persistent 10GB UserProfile document in Firestore
  useEffect(() => {
    if (!authReady || !firebaseUser) {
      setFirestoreProfile(null);
      return;
    }

    const profilePath = `users/${firebaseUser.uid}`;
    syncUserProfileToFirestore(firebaseUser).catch(() => {});

    const unsub = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        setFirestoreProfile({
          uid: String(data.uid || firebaseUser.uid),
          username: String(data.username || firebaseUser.displayName || 'User'),
          email: String(data.email || firebaseUser.email || ''),
          provider: data.provider === 'password' ? 'password' : 'google',
          photoUrl: typeof data.photoUrl === 'string' ? data.photoUrl : undefined,
          storageTier: STORAGE_TIER_REGISTERED,
          storageLimitBytes:
            typeof data.storageLimitBytes === 'number'
              ? data.storageLimitBytes
              : REGISTERED_STORAGE_LIMIT_BYTES,
          storageUsedBytes: typeof data.storageUsedBytes === 'number' ? data.storageUsedBytes : 0,
        });
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, profilePath);
      }
    );

    return () => unsub();
  }, [authReady, firebaseUser]);

  // Sync Firestore files for Google OAuth user
  useEffect(() => {
    if (!authReady || !firebaseUser) {
      setCloudFiles([]);
      setCloudFilesLoading(false);
      return;
    }
    setCloudFilesLoading(true);
    const filesPath = `users/${firebaseUser.uid}/files`;
    const q = query(collection(db, 'users', firebaseUser.uid, 'files'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: UploadedFileRecord[] = snap.docs.map((d) => {
          const data = d.data();
          const created = data.createdAt?.toDate
            ? data.createdAt.toDate().toISOString()
            : new Date().toISOString();
          return {
            id: String(data.id || d.id),
            original_name: String(data.originalName || 'file'),
            size_bytes: Number(data.sizeBytes || 0),
            mime_type: String(data.mimeType || 'application/octet-stream'),
            share_url: String(data.shareUrl || `/f/${d.id}`),
            delete_token: String(data.deleteToken || ''),
            timestamp: created,
          };
        });
        setCloudFiles(rows);
        setCloudFilesLoading(false);
      },
      (error) => {
        setCloudFilesLoading(false);
        handleFirestoreError(error, OperationType.LIST, filesPath);
      }
    );
    return () => unsub();
  }, [authReady, firebaseUser]);

  // Reconcile persisted Firestore storageUsedBytes with cloudFiles
  useEffect(() => {
    if (!authReady || !firebaseUser || !firestoreProfile) return;
    const cloudTotal = cloudFiles.reduce((acc, item) => acc + (item.size_bytes || 0), 0);
    const clampedTotal = Math.min(REGISTERED_STORAGE_LIMIT_BYTES, Math.max(0, Math.round(cloudTotal)));
    if (firestoreProfile.storageUsedBytes !== clampedTotal) {
      const profilePath = `users/${firebaseUser.uid}`;
      updateDoc(doc(db, 'users', firebaseUser.uid), {
        storageTier: STORAGE_TIER_REGISTERED,
        storageLimitBytes: REGISTERED_STORAGE_LIMIT_BYTES,
        storageUsedBytes: clampedTotal,
        updatedAt: serverTimestamp(),
      }).catch((err) => {
        handleFirestoreError(err, OperationType.UPDATE, profilePath);
      });
    }
  }, [authReady, firebaseUser, firestoreProfile, cloudFiles]);

  // Resume queued upload if user signed up after hitting the 5GB guest limit
  useEffect(() => {
    if (activeUser && queuedQuotaFile) {
      setPendingDropFile(queuedQuotaFile);
      setQueuedQuotaFile(null);
      setAuthModalOpen(false);
      setUploadOpen(true);
    }
  }, [activeUser, queuedQuotaFile]);

  // Global drag-and-drop on Home
  useEffect(() => {
    if (isDownloadRoute) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (uploadOpen) return;
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        setPendingDropFile(e.dataTransfer.files[0]);
        setUploadOpen(true);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [isDownloadRoute, uploadOpen]);

  const combinedFiles = useMemo(() => {
    const map = new Map<string, UploadedFileRecord>();
    cloudFiles.forEach((f) => map.set(f.id, f));
    serverFiles.forEach((f) => {
      if (!map.has(f.id)) map.set(f.id, f);
    });
    localFiles.forEach((f) => {
      if (!map.has(f.id)) map.set(f.id, f);
    });
    return Array.from(map.values());
  }, [cloudFiles, serverFiles, localFiles]);

  const filteredFiles = useMemo(() => {
    const q = fileSearchQuery.trim().toLowerCase();
    if (!q) return combinedFiles;
    return combinedFiles.filter((file) =>
      file.original_name.toLowerCase().includes(q)
    );
  }, [combinedFiles, fileSearchQuery]);

  const storageUsedBytes = useMemo(() => {
    const combinedUsed = combinedFiles.reduce((acc, item) => acc + (item.size_bytes || 0), 0);
    if (firebaseUser && firestoreProfile) {
      return Math.max(combinedUsed, firestoreProfile.storageUsedBytes);
    }
    return combinedUsed;
  }, [combinedFiles, firebaseUser, firestoreProfile]);

  const activeStorageLimitBytes = activeUser
    ? firestoreProfile?.storageLimitBytes || serverUser?.storageLimitBytes || REGISTERED_STORAGE_LIMIT_BYTES
    : GUEST_STORAGE_LIMIT_BYTES;

  const handleCopyText = useCallback(
    (text: string) => {
      if (navigator.clipboard) {
        navigator.clipboard
          .writeText(text)
          .then(() => showToast(t.toast_copied))
          .catch(() => showToast('Error copying link', true));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(t.toast_copied);
      }
    },
    [showToast, t.toast_copied]
  );

  const handleUploadComplete = useCallback(
    async (record: UploadedFileRecord) => {
      const nextLocal = [record, ...localFiles.filter((f) => f.id !== record.id)].slice(0, 40);
      setLocalFiles(nextLocal);
      writeLocalFiles(nextLocal);

      if (serverUser) {
        loadServerUserFiles();
      }

      if (firebaseUser) {
        const path = `users/${firebaseUser.uid}/files/${record.id}`;
        try {
          if (!firestoreProfile) {
            await syncUserProfileToFirestore(firebaseUser);
          }
          const existingCloudUsed = cloudFiles.reduce(
            (acc, f) => acc + (f.id === record.id ? 0 : f.size_bytes || 0),
            0
          );
          const nextCloudUsed = Math.min(
            REGISTERED_STORAGE_LIMIT_BYTES,
            Math.max(0, Math.round(existingCloudUsed + record.size_bytes))
          );

          const batch = writeBatch(db);
          batch.set(doc(db, 'users', firebaseUser.uid, 'files', record.id), {
            id: record.id,
            userId: firebaseUser.uid,
            originalName: record.original_name.slice(0, 255),
            sizeBytes: record.size_bytes,
            mimeType: (record.mime_type || 'application/octet-stream').slice(0, 128),
            shareUrl: record.share_url.slice(0, 256),
            deleteToken: record.delete_token.slice(0, 128),
            createdAt: serverTimestamp(),
          });
          batch.update(doc(db, 'users', firebaseUser.uid), {
            storageTier: STORAGE_TIER_REGISTERED,
            storageLimitBytes: REGISTERED_STORAGE_LIMIT_BYTES,
            storageUsedBytes: nextCloudUsed,
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, path);
        }
      }

      setUploadOpen(false);
      navigateToPath(`/f/${record.id}`);
    },
    [cloudFiles, firebaseUser, firestoreProfile, loadServerUserFiles, localFiles, navigateToPath, serverUser]
  );

  const handleDeleteFile = useCallback(
    async (file: UploadedFileRecord) => {
      if (!window.confirm(t.confirm_delete)) return;

      try {
        const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'LettingWork',
            ...(file.delete_token ? { 'X-Delete-Token': file.delete_token } : {}),
          },
        });
        const data = await res.json();
        if (!res.ok && res.status !== 403 && res.status !== 404) {
          showToast(data.error || 'Delete failed', true);
          return;
        }
      } catch {
        showToast('Network error deleting file', true);
        return;
      }

      const nextLocal = localFiles.filter((f) => f.id !== file.id);
      setLocalFiles(nextLocal);
      writeLocalFiles(nextLocal);
      setServerFiles((prev) => prev.filter((f) => f.id !== file.id));

      if (firebaseUser) {
        const path = `users/${firebaseUser.uid}/files/${file.id}`;
        try {
          const nextCloudUsed = Math.max(
            0,
            Math.round(
              cloudFiles
                .filter((f) => f.id !== file.id)
                .reduce((acc, f) => acc + (f.size_bytes || 0), 0)
            )
          );
          const batch = writeBatch(db);
          batch.delete(doc(db, 'users', firebaseUser.uid, 'files', file.id));
          batch.update(doc(db, 'users', firebaseUser.uid), {
            storageUsedBytes: nextCloudUsed,
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, path);
        }
      }

      showToast(t.toast_deleted);
    },
    [cloudFiles, firebaseUser, localFiles, showToast, t.confirm_delete, t.toast_deleted]
  );

  const handleRenameFile = useCallback(
    async (file: UploadedFileRecord, nextRawName: string) => {
      const nextName = nextRawName.trim();
      if (!nextName || nextName === file.original_name) {
        setEditingFileId(null);
        return;
      }

      let updatedMime = file.mime_type || 'application/octet-stream';
      let finalName = nextName;
      try {
        const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'LettingWork',
            ...(file.delete_token ? { 'X-Delete-Token': file.delete_token } : {}),
          },
          body: JSON.stringify({
            name: nextName,
            ...(file.delete_token ? { delete_token: file.delete_token } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          showToast(data.error || 'Rename failed', true);
          return;
        }
        finalName = String(data.original_name || nextName);
        updatedMime = String(data.mime_type || updatedMime);
      } catch {
        showToast('Network error renaming file', true);
        return;
      }

      const nextLocal = localFiles.map((f) =>
        f.id === file.id ? { ...f, original_name: finalName, mime_type: updatedMime } : f
      );
      setLocalFiles(nextLocal);
      writeLocalFiles(nextLocal);
      setServerFiles((prev) =>
        prev.map((f) =>
          f.id === file.id ? { ...f, original_name: finalName, mime_type: updatedMime } : f
        )
      );

      if (firebaseUser) {
        const path = `users/${firebaseUser.uid}/files/${file.id}`;
        try {
          await updateDoc(doc(db, 'users', firebaseUser.uid, 'files', file.id), {
            originalName: finalName.slice(0, 255),
            mimeType: updatedMime.slice(0, 128),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, path);
        }
      }

      setEditingFileId(null);
      showToast(t.toast_renamed);
    },
    [firebaseUser, localFiles, showToast, t.toast_renamed]
  );

  const handleLogout = useCallback(async () => {
    try {
      if (firebaseUser) {
        await signOut(auth);
      }
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'LettingWork' },
      });
      setServerUser(null);
      setServerFiles([]);
      showToast(t.toast_logout);
    } catch {
      showToast(t.auth_err_generic, true);
    }
  }, [firebaseUser, showToast, t.auth_err_generic, t.toast_logout]);

  const navigateToSection = useCallback(
    (sectionId: string) => {
      if (currentPath.startsWith('/f/')) {
        navigateToPath('/');
        if (sectionId !== 'top') {
          window.setTimeout(() => {
            document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
          }, 80);
        }
        return;
      }
      if (sectionId === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const el = document.getElementById(sectionId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    },
    [currentPath, navigateToPath]
  );

  return (
    <div id="top" className="relative min-h-screen flex flex-col text-slate-100">
      {/* Continuous subtle full-page vector background extracted from PDF (zero text/logos) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 -z-10 pointer-events-none overflow-hidden bg-[#04070d] lw-bg-layer"
      >
        <picture className="block w-full h-full">
          <source
            media="(min-resolution: 2dppx)"
            type="image/svg+xml"
            srcSet={`${pdfBgSvg} 2x, ${pdfBgSvg} 3x`}
          />
          <source
            type="image/svg+xml"
            srcSet={`${pdfBgSvg} 1x, ${pdfBgSvg} 2x`}
          />
          <img
            src={pdfBgSvg}
            alt=""
            decoding="async"
            fetchPriority="low"
            draggable={false}
            className="w-full h-full object-cover object-center opacity-35 select-none transform-gpu"
          />
        </picture>
        <div className="absolute inset-0 bg-[#04070d]/55" />
      </div>

      {/* Slim Non-Sticky Beta Notice */}
      <div className="border-b border-white/[0.07] bg-black/30 px-4 py-2 text-center text-xs text-slate-300 flex items-center justify-center gap-2 flex-wrap">
        <span>{t.beta_notice}</span>
        <a
          href="https://github.com/ivandoski/lettingwork/issues"
          target="_blank"
          rel="noreferrer"
          className="text-cyan-400 underline underline-offset-2 font-medium hover:text-cyan-300"
        >
          {t.beta_report}
        </a>
      </div>

      {/* Main Navigation Block at the Top (including Language Selector) */}
      <TopNav
        lang={lang}
        user={activeUser}
        onSelectLang={handleSelectLang}
        onOpenUpload={() => setUploadOpen(true)}
        onOpenDrawer={() => setDrawerOpen(true)}
        onOpenAuth={() => {
          setAuthInitialTab('login');
          setAuthModalOpen(true);
        }}
        onOpenChat={() => setChatOpen(true)}
        onNavigateSection={navigateToSection}
        t={t}
      />

      {/* Main Content */}
      <main className="flex-1">
        {isDownloadRoute ? (
          <DownloadView
            fileId={downloadFileId}
            onCopyText={handleCopyText}
            onOpenQr={(url) => setQrUrl(url)}
            onBackHome={() => navigateToPath('/')}
            onOpenUpload={() => setUploadOpen(true)}
            t={t}
          />
        ) : (
          <>
            {/* 1. Portada e Imagen Principal (intacta y 100% visible) */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 pb-12">
              <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
                {!heroImgError ? (
                  <img
                    src={portadaImg}
                    alt="LettingWork"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImgError(true)}
                    className="w-full h-auto block object-contain"
                  />
                ) : (
                  <div className="aspect-video w-full flex flex-col items-center justify-center bg-[#04070d] p-8 text-center">
                    <h1 className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-white">
                      Letting<span className="text-cyan-400">Work</span>
                    </h1>
                    <p className="text-sm text-slate-400 mt-2">High-Speed Cloud File Sharing</p>
                  </div>
                )}
              </div>

              {/* Clean Separated Action Bar Below Portada */}
              <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
                <div className="flex items-center flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setUploadOpen(true)}
                    className="px-6 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm sm:text-base flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Upload className="w-4 h-4" />
                    <span>{t.btn_upload_file}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDrawerOpen(true)}
                    className="px-5 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 text-white font-medium text-sm sm:text-base flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                  >
                    <Menu className="w-4 h-4" />
                    <span>{t.hero_cta_menu}</span>
                  </button>
                </div>

                <a
                  href="https://lettingwork.onrender.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-xs sm:text-sm text-slate-300 hover:text-cyan-300 transition-colors whitespace-nowrap"
                >
                  <Globe className="w-4 h-4 text-cyan-400" />
                  <span>lettingwork.onrender.com</span>
                </a>
              </div>

              {/* Natural inline feature highlights */}
              <div className="mt-5 flex flex-wrap items-center justify-center sm:justify-start gap-x-6 gap-y-2 text-xs sm:text-sm text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-cyan-400" />
                  <span>{t.hero_stat_speed}</span>
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="w-4 h-4 text-cyan-400" />
                  <span>{t.hero_stat_privacy}</span>
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-cyan-400" />
                  <span>{t.hero_stat_nowait}</span>
                </span>
              </div>
            </section>

            {/* 2. Apartado About Us (Imagen en alta resolución 4K extraída del PDF) */}
            <section id="about-us" className="max-w-5xl mx-auto px-4 sm:px-6 pt-10 pb-12">
              <div className="mb-7">
                <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400 mb-1.5">
                  {t.about_badge}
                </p>
                <h2 className="font-display text-2xl sm:text-3xl font-bold text-white mb-1.5">
                  {t.about_title}
                </h2>
                <p className="text-sm sm:text-base text-slate-400 max-w-2xl">
                  {t.about_subtitle}
                </p>
              </div>

              <div className="rounded-xl overflow-hidden border border-white/10 bg-black mb-8">
                {!aboutImgError ? (
                  <img
                    src={aboutUsImg}
                    alt="LettingWork About Us"
                    referrerPolicy="no-referrer"
                    onError={() => setAboutImgError(true)}
                    className="w-full h-auto block object-contain"
                  />
                ) : (
                  <div className="aspect-video w-full flex flex-col items-center justify-center bg-[#080d16] p-8 text-center">
                    <h3 className="text-2xl font-bold text-white">{t.about_title}</h3>
                    <p className="text-sm text-slate-400 mt-2 max-w-md">{t.about_subtitle}</p>
                  </div>
                )}
              </div>

              {/* Clean typographic metric strip without boxy card clones */}
              <div className="grid grid-cols-2 md:grid-cols-4 border-y border-white/[0.08] py-5 gap-y-4 sm:divide-x divide-white/[0.08] text-center">
                <div className="px-3">
                  <div className="text-2xl font-bold text-cyan-400 tabular-nums">99.9%</div>
                  <div className="text-xs text-slate-400 mt-1">{t.metric_uptime}</div>
                </div>
                <div className="px-3">
                  <div className="text-2xl font-bold text-cyan-400 tabular-nums">0s</div>
                  <div className="text-xs text-slate-400 mt-1">{t.metric_queues}</div>
                </div>
                <div className="px-3">
                  <div className="text-2xl font-bold text-cyan-400 tabular-nums">5–10 GB</div>
                  <div className="text-xs text-slate-400 mt-1">{t.drawer_storage_title}</div>
                </div>
                <div className="px-3">
                  <div className="text-2xl font-bold text-cyan-400 tabular-nums">100%</div>
                  <div className="text-xs text-slate-400 mt-1">{t.metric_direct}</div>
                </div>
              </div>
            </section>

            {/* 3. Tus Subidas Recientes / Mis Archivos */}
            <section id="recent-section" className="max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-display text-xl sm:text-2xl font-bold text-white">
                    {t.recent_title}
                  </h2>
                  <p className="text-sm text-slate-400 mt-0.5">{t.recent_subtitle}</p>
                </div>
                {activeUser && (
                  <div className="text-xs text-slate-400">
                    {activeUser.provider === 'google'
                      ? t.auth_provider_google
                      : t.auth_provider_password}
                    {' · '}
                    <span className="text-cyan-400 font-medium">{activeUser.email}</span>
                  </div>
                )}
              </div>

              <StorageQuotaBar
                usedBytes={storageUsedBytes}
                limitBytes={activeStorageLimitBytes}
                isAuthenticated={Boolean(activeUser)}
                onUpgradeClick={() => {
                  setAuthInitialTab('register');
                  setAuthModalOpen(true);
                }}
                t={t}
              />

              <div className="relative mb-4">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                />
                <input
                  type="search"
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  placeholder={t.recent_search_placeholder}
                  aria-label={t.recent_search_placeholder}
                  className="w-full rounded-xl bg-[#090f19]/80 border border-white/[0.08] focus:border-cyan-400/50 pl-10 pr-24 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors"
                />
                {fileSearchQuery.trim().length > 0 && (
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      {filteredFiles.length}/{combinedFiles.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFileSearchQuery('')}
                      aria-label={t.recent_search_clear}
                      title={t.recent_search_clear}
                      className="p-1 rounded-md bg-white/[0.06] hover:bg-white/15 text-slate-300 hover:text-white cursor-pointer transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {(!authReady || cloudFilesLoading || serverFilesLoading) && combinedFiles.length === 0 ? (
                <div
                  role="status"
                  aria-live="polite"
                  aria-label="Loading files"
                  className="divide-y divide-white/[0.07] border border-white/[0.08] rounded-xl bg-[#090f19]/80 backdrop-blur-sm overflow-hidden"
                >
                  {[0, 1, 2].map((idx) => (
                    <div
                      key={idx}
                      className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-pulse"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/[0.05] shrink-0" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div
                            className={`h-3.5 rounded bg-white/[0.09] ${
                              idx === 0 ? 'w-48 sm:w-72' : idx === 1 ? 'w-40 sm:w-56' : 'w-44 sm:w-64'
                            }`}
                          />
                          <div className="h-2.5 w-28 sm:w-36 rounded bg-white/[0.05]" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                        <div className="h-8 w-20 rounded-lg bg-white/[0.06]" />
                        <div className="h-8 w-8 rounded-lg bg-white/[0.05]" />
                        <div className="h-8 w-8 rounded-lg bg-white/[0.05]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : combinedFiles.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/15 bg-black/25 p-10 text-center text-sm text-slate-400">
                  {t.recent_empty}
                </div>
              ) : filteredFiles.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/15 bg-black/25 p-10 text-center text-sm text-slate-400 flex flex-col items-center gap-3">
                  <span>{t.recent_search_empty}</span>
                  <button
                    type="button"
                    onClick={() => setFileSearchQuery('')}
                    className="px-3.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-xs font-medium text-slate-200 hover:text-white cursor-pointer transition-colors"
                  >
                    {t.recent_search_clear}
                  </button>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.07] border border-white/[0.08] rounded-xl bg-[#090f19]/80 backdrop-blur-sm overflow-hidden">
                  {filteredFiles.map((file) => {
                    const fullUrl = file.share_url.startsWith('http')
                      ? file.share_url
                      : `${window.location.origin}${file.share_url}`;
                    return (
                      <div
                        key={file.id}
                        className="group relative px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all duration-200 ease-out hover:bg-white/[0.045]"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-cyan-400 opacity-0 -translate-x-1 transition-all duration-200 ease-out group-hover:opacity-100 group-hover:translate-x-0"
                        />
                        <div className="flex items-center gap-3.5 min-w-0 flex-1">
                          <div className="p-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-cyan-400 transition-all duration-200 ease-out group-hover:bg-cyan-400/10 group-hover:border-cyan-400/25 group-hover:scale-[1.03] shrink-0">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            {editingFileId === file.id ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleRenameFile(file, editingName);
                                }}
                                className="flex items-center gap-2"
                              >
                                <input
                                  type="text"
                                  value={editingName}
                                  onChange={(e) => setEditingName(e.target.value)}
                                  maxLength={220}
                                  autoFocus
                                  className="flex-1 min-w-0 rounded-md bg-black/50 border border-cyan-400/50 px-2.5 py-1 text-sm text-white focus:outline-none"
                                />
                                <button
                                  type="submit"
                                  aria-label={t.rename_save}
                                  className="p-1.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 cursor-pointer transition-colors"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingFileId(null)}
                                  aria-label={t.btn_cancel}
                                  className="p-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-300 cursor-pointer transition-colors"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </form>
                            ) : (
                              <>
                                <div className="font-medium text-sm text-slate-100 truncate transition-colors duration-200 group-hover:text-white">
                                  {file.original_name}
                                </div>
                                <div className="text-xs text-slate-400 tabular-nums mt-0.5 transition-colors duration-200 group-hover:text-slate-300">
                                  {formatBytes(file.size_bytes)} · {new Date(file.timestamp).toLocaleDateString()}
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopyText(fullUrl)}
                            className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-all duration-150"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            <span>{t.btn_copy_short}</span>
                          </button>
                          {(file.delete_token || serverUser) && editingFileId !== file.id && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingFileId(file.id);
                                setEditingName(file.original_name);
                              }}
                              aria-label={t.btn_rename}
                              title={t.btn_rename}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-slate-200 hover:text-white cursor-pointer transition-all duration-150"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <a
                            href={fullUrl}
                            onClick={(e) => {
                              e.preventDefault();
                              navigateToPath(`/f/${file.id}`);
                            }}
                            aria-label={t.btn_open_page}
                            title={t.btn_open_page}
                            className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-slate-200 hover:text-white transition-all duration-150"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                          {(file.delete_token || serverUser) && (
                            <button
                              type="button"
                              onClick={() => handleDeleteFile(file)}
                              aria-label="Delete file"
                              className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 hover:border-red-400/40 text-red-400 cursor-pointer transition-all duration-150"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {(cloudFilesLoading || serverFilesLoading) && (
                    <div
                      role="status"
                      aria-live="polite"
                      aria-label="Syncing cloud files"
                      className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-pulse bg-white/[0.015]"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-lg bg-white/[0.06] shrink-0" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="h-3.5 w-44 sm:w-60 rounded bg-white/[0.08]" />
                          <div className="h-2.5 w-28 rounded bg-white/[0.05]" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                        <div className="h-8 w-20 rounded-lg bg-white/[0.05]" />
                        <div className="h-8 w-8 rounded-lg bg-white/[0.05]" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-white/[0.08] mt-10 py-7 px-4 text-center text-xs text-slate-400">
        <p>
          LettingWork · <span>{t.footer_tagline}</span>
        </p>
        <p className="mt-1.5 text-slate-500">
          {t.drawer_version_text} · {t.drawer_badge_beta}
        </p>
      </footer>

      <SideDrawer
        isOpen={drawerOpen}
        user={activeUser}
        storageUsedBytes={storageUsedBytes}
        storageLimitBytes={activeStorageLimitBytes}
        onClose={() => setDrawerOpen(false)}
        onOpenUpload={() => setUploadOpen(true)}
        onOpenAuth={(tab) => {
          setAuthInitialTab(tab);
          setAuthModalOpen(true);
        }}
        onLogout={handleLogout}
        onOpenSecurity={() => setSecurityOpen(true)}
        onOpenChat={() => setChatOpen(true)}
        onNavigateSection={navigateToSection}
        t={t}
      />

      <UploadModal
        isOpen={uploadOpen}
        pendingFile={pendingDropFile}
        isAuthenticated={Boolean(activeUser)}
        storageUsedBytes={storageUsedBytes}
        storageLimitBytes={activeStorageLimitBytes}
        onClearPendingFile={() => setPendingDropFile(null)}
        onClose={() => setUploadOpen(false)}
        onUploadComplete={handleUploadComplete}
        onPromptSignUp={(blockedFile) => {
          setQueuedQuotaFile(blockedFile);
          setUploadOpen(false);
          setAuthInitialTab('register');
          setAuthModalOpen(true);
        }}
        onToast={showToast}
        t={t}
      />

      <AuthModal
        isOpen={authModalOpen}
        initialTab={authInitialTab}
        onClose={() => setAuthModalOpen(false)}
        onServerAuthSuccess={(u) => {
          setServerUser(u);
          loadServerUserFiles();
        }}
        onSuccessToast={(msg) => showToast(msg)}
        t={t}
      />

      <QrModal url={qrUrl} onClose={() => setQrUrl(null)} t={t} />

      {securityOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setSecurityOpen(false)}
        >
          <div
            className="relative w-full max-w-md rounded-xl bg-[#0b111c] border border-white/10 p-7 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSecurityOpen(false)}
              aria-label={t.btn_close}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2.5 text-cyan-400 font-bold text-base mb-3">
              <ShieldCheck className="w-5 h-5" />
              <h3>{t.security_modal_title}</h3>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed mb-5">{t.security_modal_desc}</p>
            <button
              type="button"
              onClick={() => setSecurityOpen(false)}
              className="w-full py-2.5 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 text-sm font-semibold text-white cursor-pointer"
            >
              {t.btn_close}
            </button>
          </div>
        </div>
      )}

      <HelpChatModal
        isOpen={chatOpen}
        lang={lang}
        onClose={() => setChatOpen(false)}
        t={t}
      />

      {/* Natural Help Center Launcher */}
      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          aria-label={t.chat_title}
          className="fixed bottom-5 right-5 z-30 px-3.5 py-2.5 rounded-lg bg-[#0d1420]/95 hover:bg-[#131d2e] border border-white/15 text-slate-100 shadow-lg backdrop-blur-sm flex items-center gap-2 text-xs sm:text-sm font-medium transition-colors cursor-pointer"
        >
          <HelpCircle className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="hidden sm:inline">{t.chat_btn_label}</span>
        </button>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed bottom-20 right-6 z-50 px-5 py-3 rounded-lg bg-[#0b111c] border shadow-2xl text-sm font-medium text-white ${
            toast.isError ? 'border-red-500/60' : 'border-emerald-500/60'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <LettingWorkApp />
    </ErrorBoundary>
  );
}

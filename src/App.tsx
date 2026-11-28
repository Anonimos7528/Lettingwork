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
  QrCode,
  FolderPlus,
  FolderOpen,
  ArrowUpDown,
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
import type {
  LangCode,
  UploadedFileRecord,
  ActiveUser,
  FirestoreUserProfile,
  FileCollectionSummary,
} from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopNav } from './components/TopNav';
import { SideDrawer } from './components/SideDrawer';
import { UploadModal } from './components/UploadModal';
import { AuthModal } from './components/AuthModal';
import { QrModal } from './components/QrModal';
import { DownloadView } from './components/DownloadView';
import { CollectionView } from './components/CollectionView';
import { HelpChatModal } from './components/HelpChatModal';
import { StorageQuotaBar } from './components/StorageQuotaBar';
import { OfflineIndicator } from './components/OfflineIndicator';

const LOCAL_FILES_KEY = 'lettingwork_uploads';
const LOCAL_COLLECTIONS_KEY = 'lettingwork_collections';

type FileCategory = 'all' | 'images' | 'videos' | 'audio' | 'docs' | 'other';
type FileSortMode = 'newest' | 'oldest' | 'name' | 'size' | 'downloads';

function getFileCategory(file: UploadedFileRecord): Exclude<FileCategory, 'all'> {
  const mime = (file.mime_type || '').split(';')[0].trim().toLowerCase();
  const ext = (file.original_name.split('.').pop() || '').toLowerCase();

  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) {
    return 'images';
  }
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'].includes(ext)) {
    return 'videos';
  }
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
    return 'audio';
  }
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    ['pdf', 'txt', 'csv', 'json', 'md', 'log', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)
  ) {
    return 'docs';
  }
  return 'other';
}

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
    localStorage.setItem(LOCAL_FILES_KEY, JSON.stringify(items.slice(0, 60)));
  } catch {
    // Ignore storage quota errors
  }
}

function readLocalCollections(): FileCollectionSummary[] {
  try {
    const raw = localStorage.getItem(LOCAL_COLLECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalCollections(items: FileCollectionSummary[]) {
  try {
    localStorage.setItem(LOCAL_COLLECTIONS_KEY, JSON.stringify(items.slice(0, 30)));
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
  const [pendingDropFiles, setPendingDropFiles] = useState<File[]>([]);
  const [queuedQuotaFiles, setQueuedQuotaFiles] = useState<File[]>([]);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialTab, setAuthInitialTab] = useState<'login' | 'register'>('login');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileCategory, setFileCategory] = useState<FileCategory>('all');
  const [fileSort, setFileSort] = useState<FileSortMode>('newest');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [collections, setCollections] = useState<FileCollectionSummary[]>(() =>
    readLocalCollections()
  );
  const [collectionDraftOpen, setCollectionDraftOpen] = useState(false);
  const [collectionDraftTitle, setCollectionDraftTitle] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);
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
  const isCollectionRoute = currentPath.startsWith('/c/');
  const collectionId = isCollectionRoute
    ? currentPath.replace(/^\/c\//, '').replace(/\/+$/, '')
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

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (auth.currentUser) {
      try {
        const idToken = await auth.currentUser.getIdToken();
        if (idToken) return { Authorization: `Bearer ${idToken}` };
      } catch {
        // Ignore token errors
      }
    }
    return {};
  }, []);

  const loadUserCollections = useCallback(async () => {
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch('/api/user/collections', {
        credentials: 'include',
        headers: authHeaders,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.collections)) {
        setCollections((prev) => {
          const map = new Map<string, FileCollectionSummary>();
          (data.collections as FileCollectionSummary[]).forEach((c) => map.set(c.id, c));
          prev.forEach((c) => {
            if (!map.has(c.id)) map.set(c.id, c);
          });
          const merged = Array.from(map.values());
          writeLocalCollections(merged);
          return merged;
        });
      }
    } catch {
      // Ignore transient network errors
    }
  }, [getAuthHeaders]);

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
            download_count?: number;
            has_password?: boolean;
            expires_at?: string | null;
          }) => ({
            id: f.id,
            original_name: f.original_name,
            size_bytes: f.size_bytes,
            mime_type: f.mime_type || 'application/octet-stream',
            share_url: `/f/${f.id}`,
            delete_token: f.delete_token || '',
            timestamp: f.upload_time,
            download_count: Number(f.download_count || 0),
            has_password: Boolean(f.has_password),
            expires_at: f.expires_at || null,
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
            storageTier: data.user.storage_tier || STORAGE_TIER_REGISTERED,
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
          storageLimitBytes: REGISTERED_STORAGE_LIMIT_BYTES,
          storageUsedBytes: typeof data.storageUsedBytes === 'number' ? data.storageUsedBytes : 0,
        });
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, profilePath);
      }
    );

    return () => unsub();
  }, [authReady, firebaseUser]);

  // Load user collections on auth changes
  useEffect(() => {
    if (!authReady) return;
    loadUserCollections();
  }, [authReady, firebaseUser, serverUser, loadUserCollections]);

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
            has_password: typeof data.hasPassword === 'boolean' ? data.hasPassword : false,
            expires_at: typeof data.expiresAt === 'string' ? data.expiresAt : null,
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
    if (activeUser && queuedQuotaFiles.length > 0) {
      setPendingDropFiles(queuedQuotaFiles);
      setQueuedQuotaFiles([]);
      setAuthModalOpen(false);
      setUploadOpen(true);
    }
  }, [activeUser, queuedQuotaFiles]);

  // Global drag-and-drop on Home
  useEffect(() => {
    if (isDownloadRoute || isCollectionRoute) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (uploadOpen) return;
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        setPendingDropFiles(Array.from(e.dataTransfer.files));
        setUploadOpen(true);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [isDownloadRoute, isCollectionRoute, uploadOpen]);

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
    const filtered = combinedFiles.filter((file) => {
      if (fileCategory !== 'all' && getFileCategory(file) !== fileCategory) return false;
      if (q && !file.original_name.toLowerCase().includes(q)) return false;
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (fileSort === 'oldest') {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      }
      if (fileSort === 'name') {
        return a.original_name.localeCompare(b.original_name);
      }
      if (fileSort === 'size') {
        return (b.size_bytes || 0) - (a.size_bytes || 0);
      }
      if (fileSort === 'downloads') {
        return (b.download_count || 0) - (a.download_count || 0);
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    return sorted;
  }, [combinedFiles, fileSearchQuery, fileCategory, fileSort]);

  // Keep selectedFileIds synced when files are removed
  useEffect(() => {
    const validIds = new Set(combinedFiles.map((f) => f.id));
    setSelectedFileIds((prev) => {
      const next = prev.filter((id) => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [combinedFiles]);

  const selectedSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);

  const selectedFiles = useMemo(
    () => combinedFiles.filter((f) => selectedSet.has(f.id)),
    [combinedFiles, selectedSet]
  );

  const deletableSelectedFiles = useMemo(
    () => selectedFiles.filter((f) => Boolean(f.delete_token || serverUser || firebaseUser)),
    [selectedFiles, serverUser, firebaseUser]
  );

  const allVisibleSelected = useMemo(
    () => filteredFiles.length > 0 && filteredFiles.every((f) => selectedSet.has(f.id)),
    [filteredFiles, selectedSet]
  );

  const someVisibleSelected = useMemo(
    () => filteredFiles.some((f) => selectedSet.has(f.id)),
    [filteredFiles, selectedSet]
  );

  const toggleFileSelection = useCallback((fileId: string) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    const visibleIds = filteredFiles.map((f) => f.id);
    if (visibleIds.length === 0) return;
    setSelectedFileIds((prev) => {
      const prevSet = new Set(prev);
      const everyVisible = visibleIds.every((id) => prevSet.has(id));
      if (everyVisible) {
        const visibleSet = new Set(visibleIds);
        return prev.filter((id) => !visibleSet.has(id));
      }
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  }, [filteredFiles]);

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
    (text: string, customToast?: string) => {
      const successMsg = customToast || t.toast_copied;
      if (navigator.clipboard) {
        navigator.clipboard
          .writeText(text)
          .then(() => showToast(successMsg))
          .catch(() => showToast('Error copying link', true));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(successMsg);
      }
    },
    [showToast, t.toast_copied]
  );

  const handleCopySelectedLinks = useCallback(() => {
    if (selectedFiles.length === 0) return;
    const links = selectedFiles.map((file) =>
      file.share_url.startsWith('http')
        ? file.share_url
        : `${window.location.origin}${file.share_url}`
    );
    const bulkMsg = (t.toast_copied_bulk || '{count} links copied!').replace(
      '{count}',
      String(links.length)
    );
    handleCopyText(links.join('\n'), bulkMsg);
  }, [handleCopyText, selectedFiles, t.toast_copied_bulk]);

  const handleFilesUploaded = useCallback(
    async (records: UploadedFileRecord[], createdCollection: FileCollectionSummary | null) => {
      if (records.length === 0) return;

      const uploadedIds = new Set(records.map((r) => r.id));
      const nextLocal = [
        ...records,
        ...localFiles.filter((f) => !uploadedIds.has(f.id)),
      ].slice(0, 60);
      setLocalFiles(nextLocal);
      writeLocalFiles(nextLocal);

      if (createdCollection) {
        setCollections((prev) => {
          const nextCols = [createdCollection, ...prev.filter((c) => c.id !== createdCollection.id)];
          writeLocalCollections(nextCols);
          return nextCols;
        });
      }

      if (serverUser) {
        loadServerUserFiles();
      }

      if (firebaseUser) {
        const path = `users/${firebaseUser.uid}/files`;
        try {
          if (!firestoreProfile) {
            await syncUserProfileToFirestore(firebaseUser);
          }
          const existingCloudUsed = cloudFiles.reduce(
            (acc, f) => acc + (uploadedIds.has(f.id) ? 0 : f.size_bytes || 0),
            0
          );
          const addedBytes = records.reduce((acc, r) => acc + (r.size_bytes || 0), 0);
          const nextCloudUsed = Math.min(
            REGISTERED_STORAGE_LIMIT_BYTES,
            Math.max(0, Math.round(existingCloudUsed + addedBytes))
          );

          const batch = writeBatch(db);
          records.forEach((record) => {
            const docPayload: Record<string, unknown> = {
              id: record.id,
              userId: firebaseUser.uid,
              originalName: record.original_name.slice(0, 255),
              sizeBytes: record.size_bytes,
              mimeType: (record.mime_type || 'application/octet-stream').slice(0, 128),
              shareUrl: record.share_url.slice(0, 256),
              deleteToken: record.delete_token.slice(0, 128),
              createdAt: serverTimestamp(),
            };
            if (typeof record.has_password === 'boolean') {
              docPayload.hasPassword = record.has_password;
            }
            if (typeof record.expires_at === 'string' && record.expires_at.length > 0 && record.expires_at.length <= 64) {
              docPayload.expiresAt = record.expires_at;
            }
            batch.set(doc(db, 'users', firebaseUser.uid, 'files', record.id), docPayload);
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

      if (records.length === 1 && !createdCollection) {
        setUploadOpen(false);
        navigateToPath(`/f/${records[0].id}`);
      }
    },
    [
      cloudFiles,
      firebaseUser,
      firestoreProfile,
      loadServerUserFiles,
      localFiles,
      navigateToPath,
      serverUser,
    ]
  );

  const handleCreateCollectionFromSelection = useCallback(async () => {
    if (selectedFiles.length === 0 || creatingCollection) return;
    setCreatingCollection(true);
    try {
      const authHeaders = await getAuthHeaders();
      const tokens: Record<string, string> = {};
      selectedFiles.forEach((f) => {
        if (f.delete_token) tokens[f.id] = f.delete_token;
      });
      const title = collectionDraftTitle.trim() || t.collection_default_title || 'Shared Folder';
      const res = await fetch('/api/collections', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'LettingWork',
          ...authHeaders,
        },
        body: JSON.stringify({
          title,
          file_ids: selectedFiles.map((f) => f.id),
          tokens,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.collection) {
        showToast(data.error || 'Could not create collection', true);
        return;
      }
      const created = data.collection as FileCollectionSummary;
      setCollections((prev) => {
        const nextCols = [created, ...prev.filter((c) => c.id !== created.id)];
        writeLocalCollections(nextCols);
        return nextCols;
      });
      setCollectionDraftOpen(false);
      setCollectionDraftTitle('');
      setSelectedFileIds([]);
      const shareUrl = `${window.location.origin}${created.share_url}`;
      handleCopyText(shareUrl, t.collection_created_toast);
    } catch {
      showToast('Network error creating collection', true);
    } finally {
      setCreatingCollection(false);
    }
  }, [
    collectionDraftTitle,
    creatingCollection,
    getAuthHeaders,
    handleCopyText,
    selectedFiles,
    showToast,
    t.collection_created_toast,
    t.collection_default_title,
  ]);

  const handleDeleteCollection = useCallback(
    async (col: FileCollectionSummary) => {
      if (!window.confirm(t.confirm_delete)) return;
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`/api/collections/${encodeURIComponent(col.id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'LettingWork',
            ...authHeaders,
            ...(col.delete_token ? { 'X-Delete-Token': col.delete_token } : {}),
          },
        });
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Delete failed', true);
          return;
        }
        setCollections((prev) => {
          const next = prev.filter((c) => c.id !== col.id);
          writeLocalCollections(next);
          return next;
        });
        showToast(t.toast_deleted);
      } catch {
        showToast('Network error deleting collection', true);
      }
    },
    [getAuthHeaders, showToast, t.confirm_delete, t.toast_deleted]
  );

  const handleDeleteFile = useCallback(
    async (file: UploadedFileRecord) => {
      if (!window.confirm(t.confirm_delete)) return;

      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'LettingWork',
            ...authHeaders,
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
    [cloudFiles, firebaseUser, getAuthHeaders, localFiles, showToast, t.confirm_delete, t.toast_deleted]
  );

  const handleBulkDeleteSelected = useCallback(async () => {
    if (deletableSelectedFiles.length === 0 || bulkDeleting) return;
    const confirmMsg = (t.confirm_delete_bulk || t.confirm_delete).replace(
      '{count}',
      String(deletableSelectedFiles.length)
    );
    if (!window.confirm(confirmMsg)) return;

    setBulkDeleting(true);
    const deletedIds = new Set<string>();
    let failedCount = 0;

    try {
      const authHeaders = await getAuthHeaders();
      for (const file of deletableSelectedFiles) {
        try {
          const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: {
              'X-Requested-With': 'LettingWork',
              ...authHeaders,
              ...(file.delete_token ? { 'X-Delete-Token': file.delete_token } : {}),
            },
          });
          if (res.ok || res.status === 404 || res.status === 403) {
            deletedIds.add(file.id);
          } else {
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
        }
      }

      if (deletedIds.size > 0) {
        const nextLocal = localFiles.filter((f) => !deletedIds.has(f.id));
        setLocalFiles(nextLocal);
        writeLocalFiles(nextLocal);
        setServerFiles((prev) => prev.filter((f) => !deletedIds.has(f.id)));
        setSelectedFileIds((prev) => prev.filter((id) => !deletedIds.has(id)));

        if (firebaseUser) {
          const cloudDeletedIds = cloudFiles
            .filter((f) => deletedIds.has(f.id))
            .map((f) => f.id);

          if (cloudDeletedIds.length > 0) {
            const path = `users/${firebaseUser.uid}/files`;
            try {
              const nextCloudUsed = Math.max(
                0,
                Math.round(
                  cloudFiles
                    .filter((f) => !deletedIds.has(f.id))
                    .reduce((acc, f) => acc + (f.size_bytes || 0), 0)
                )
              );

              const CHUNK_SIZE = 400;
              for (let i = 0; i < cloudDeletedIds.length; i += CHUNK_SIZE) {
                const chunk = cloudDeletedIds.slice(i, i + CHUNK_SIZE);
                const batch = writeBatch(db);
                chunk.forEach((id) => {
                  batch.delete(doc(db, 'users', firebaseUser.uid, 'files', id));
                });
                const isLastChunk = i + CHUNK_SIZE >= cloudDeletedIds.length;
                if (isLastChunk) {
                  batch.update(doc(db, 'users', firebaseUser.uid), {
                    storageUsedBytes: nextCloudUsed,
                    updatedAt: serverTimestamp(),
                  });
                }
                await batch.commit();
              }
            } catch (err) {
              handleFirestoreError(err, OperationType.DELETE, path);
            }
          }
        }

        const toastMsg = (t.toast_deleted_bulk || t.toast_deleted).replace(
          '{count}',
          String(deletedIds.size)
        );
        showToast(toastMsg, failedCount > 0);
      } else if (failedCount > 0) {
        showToast('Network error deleting selected files', true);
      }
    } finally {
      setBulkDeleting(false);
    }
  }, [
    bulkDeleting,
    cloudFiles,
    deletableSelectedFiles,
    firebaseUser,
    getAuthHeaders,
    localFiles,
    showToast,
    t.confirm_delete,
    t.confirm_delete_bulk,
    t.toast_deleted,
    t.toast_deleted_bulk,
  ]);

  const handleRenameFile = useCallback(
    async (
      file: UploadedFileRecord,
      nextRawName: string
    ): Promise<{ name: string; mime: string } | null> => {
      const nextName = nextRawName.trim();
      if (!nextName || nextName === file.original_name) {
        setEditingFileId(null);
        return null;
      }

      let updatedMime = file.mime_type || 'application/octet-stream';
      let finalName = nextName;
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'LettingWork',
            ...authHeaders,
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
          return null;
        }
        finalName = String(data.original_name || nextName);
        updatedMime = String(data.mime_type || updatedMime);
      } catch {
        showToast('Network error renaming file', true);
        return null;
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
      return { name: finalName, mime: updatedMime };
    },
    [firebaseUser, getAuthHeaders, localFiles, showToast, t.toast_renamed]
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
      if (currentPath.startsWith('/f/') || currentPath.startsWith('/c/')) {
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
        {isCollectionRoute ? (
          <CollectionView
            collectionId={collectionId}
            onNavigateFile={(fId) => navigateToPath(`/f/${fId}`)}
            onCopyText={handleCopyText}
            onOpenQr={(url) => setQrUrl(url)}
            onBackHome={() => navigateToPath('/')}
            onOpenUpload={() => setUploadOpen(true)}
            t={t}
          />
        ) : isDownloadRoute ? (
          (() => {
            const currentFile = combinedFiles.find((f) => f.id === downloadFileId);
            const canEditCurrent = Boolean(
              currentFile && (currentFile.delete_token || serverUser || firebaseUser)
            );
            return (
              <DownloadView
                fileId={downloadFileId}
                canEdit={canEditCurrent}
                onRenameFile={
                  currentFile
                    ? (newName) => handleRenameFile(currentFile, newName)
                    : undefined
                }
                onCopyText={handleCopyText}
                onOpenQr={(url) => setQrUrl(url)}
                onBackHome={() => navigateToPath('/')}
                onOpenUpload={() => setUploadOpen(true)}
                t={t}
              />
            );
          })()
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
                  href="https://lettingwork.vercel.app"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-xs sm:text-sm text-slate-300 hover:text-cyan-300 transition-colors whitespace-nowrap"
                >
                  <Globe className="w-4 h-4 text-cyan-400" />
                  <span>lettingwork.vercel.app</span>
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
                  <div className="text-2xl font-bold text-cyan-400 tabular-nums">500 MB – 2 GB</div>
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

              <div className="space-y-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="relative flex-1">
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

                  <div className="relative shrink-0">
                    <ArrowUpDown
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cyan-400"
                    />
                    <select
                      value={fileSort}
                      onChange={(e) => setFileSort(e.target.value as FileSortMode)}
                      aria-label="Sort files"
                      className="w-full sm:w-48 rounded-xl bg-[#090f19]/80 border border-white/[0.08] focus:border-cyan-400/50 pl-9 pr-3 py-2.5 text-xs sm:text-sm text-slate-200 focus:outline-none cursor-pointer"
                    >
                      <option value="newest" className="bg-[#090f19] text-white">
                        {t.sort_newest}
                      </option>
                      <option value="oldest" className="bg-[#090f19] text-white">
                        {t.sort_oldest}
                      </option>
                      <option value="name" className="bg-[#090f19] text-white">
                        {t.sort_name}
                      </option>
                      <option value="size" className="bg-[#090f19] text-white">
                        {t.sort_size}
                      </option>
                      <option value="downloads" className="bg-[#090f19] text-white">
                        {t.sort_downloads}
                      </option>
                    </select>
                  </div>
                </div>

                {/* Category Filter Tabs */}
                {combinedFiles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        ['all', t.filter_all],
                        ['images', t.filter_images],
                        ['videos', t.filter_videos],
                        ['audio', t.filter_audio],
                        ['docs', t.filter_docs],
                        ['other', t.filter_other],
                      ] as Array<[FileCategory, string]>
                    ).map(([catKey, label]) => {
                      const active = fileCategory === catKey;
                      return (
                        <button
                          key={catKey}
                          type="button"
                          onClick={() => setFileCategory(catKey)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                            active
                              ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-300'
                              : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.08] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
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
                    onClick={() => {
                      setFileSearchQuery('');
                      setFileCategory('all');
                    }}
                    className="px-3.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-xs font-medium text-slate-200 hover:text-white cursor-pointer transition-colors"
                  >
                    {t.recent_search_clear}
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {selectedFiles.length > 0 && (
                    <div
                      role="region"
                      aria-label="Bulk actions"
                      className="sticky top-3 z-20 rounded-xl bg-[#0d1828]/95 backdrop-blur-md border border-cyan-400/35 px-4 py-2.5 shadow-lg shadow-black/40 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 text-xs sm:text-sm font-semibold text-white">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-400/30 text-cyan-300 tabular-nums">
                            {(t.selected_count || '{count} selected').replace(
                              '{count}',
                              String(selectedFiles.length)
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedFileIds([]);
                              setCollectionDraftOpen(false);
                            }}
                            className="text-xs font-medium text-slate-400 hover:text-white transition-colors cursor-pointer"
                          >
                            {t.deselect_all}
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={handleCopySelectedLinks}
                            className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/15 border border-white/15 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                          >
                            <Copy className="w-3.5 h-3.5 text-cyan-400" />
                            <span>{t.btn_copy_selected}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setCollectionDraftOpen((v) => !v)}
                            className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/35 text-xs font-semibold text-cyan-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                          >
                            <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
                            <span>{t.btn_create_collection}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleBulkDeleteSelected}
                            disabled={bulkDeleting || deletableSelectedFiles.length === 0}
                            className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 disabled:opacity-50 disabled:cursor-not-allowed border border-red-500/35 text-xs font-semibold text-red-300 hover:text-red-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>{t.btn_delete_selected}</span>
                          </button>
                        </div>
                      </div>

                      {collectionDraftOpen && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleCreateCollectionFromSelection();
                          }}
                          className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10"
                        >
                          <input
                            type="text"
                            value={collectionDraftTitle}
                            onChange={(e) => setCollectionDraftTitle(e.target.value)}
                            maxLength={120}
                            autoFocus
                            placeholder={t.upload_collection_name_placeholder}
                            className="flex-1 min-w-[180px] rounded-lg bg-black/50 border border-cyan-400/40 px-3 py-1.5 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={creatingCollection}
                            className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-slate-950 text-xs font-bold cursor-pointer"
                          >
                            {t.rename_save}
                          </button>
                          <button
                            type="button"
                            onClick={() => setCollectionDraftOpen(false)}
                            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-slate-300 cursor-pointer"
                          >
                            {t.btn_cancel}
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                  <div className="divide-y divide-white/[0.07] border border-white/[0.08] rounded-xl bg-[#090f19]/80 backdrop-blur-sm overflow-hidden">
                    <div className="px-4 sm:px-5 py-2.5 bg-white/[0.025] flex items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-3 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          ref={(el) => {
                            if (el) {
                              el.indeterminate = someVisibleSelected && !allVisibleSelected;
                            }
                          }}
                          onChange={toggleSelectAllVisible}
                          aria-label={t.select_all}
                          className="w-4 h-4 rounded border-white/25 bg-black/40 accent-cyan-400 cursor-pointer"
                        />
                        <span>{t.select_all}</span>
                      </label>
                      <span className="text-[11px] text-slate-400 tabular-nums">
                        {filteredFiles.length}
                      </span>
                    </div>

                    {filteredFiles.map((file) => {
                      const fullUrl = file.share_url.startsWith('http')
                        ? file.share_url
                        : `${window.location.origin}${file.share_url}`;
                      const isSelected = selectedSet.has(file.id);
                      const canManageFile = Boolean(file.delete_token || serverUser || firebaseUser);
                      return (
                        <div
                          key={file.id}
                          className={`group relative px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all duration-200 ease-out hover:bg-white/[0.045] ${
                            isSelected ? 'bg-cyan-500/[0.06]' : ''
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-cyan-400 transition-all duration-200 ease-out ${
                              isSelected
                                ? 'opacity-100 translate-x-0'
                                : 'opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0'
                            }`}
                          />
                          <div className="flex items-center gap-3.5 min-w-0 flex-1">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleFileSelection(file.id)}
                              aria-label={`Select ${file.original_name}`}
                              className="w-4 h-4 rounded border-white/25 bg-black/40 accent-cyan-400 cursor-pointer shrink-0"
                            />
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
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    onDoubleClick={() => {
                                      if (!canManageFile) return;
                                      setEditingFileId(file.id);
                                      setEditingName(file.original_name);
                                    }}
                                    title={canManageFile ? t.btn_edit_name : undefined}
                                    className="font-medium text-sm text-slate-100 truncate transition-colors duration-200 group-hover:text-white"
                                  >
                                    {file.original_name}
                                  </span>
                                  {file.has_password && (
                                    <span
                                      title={t.protected_badge}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 text-[10px] font-semibold text-amber-300 shrink-0"
                                    >
                                      <Lock className="w-2.5 h-2.5" />
                                    </span>
                                  )}
                                  {file.expires_at && (
                                    <span
                                      title={`${t.expires_badge}: ${new Date(file.expires_at).toLocaleString()}`}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-400/25 text-[10px] font-medium text-cyan-300 shrink-0"
                                    >
                                      <Clock className="w-2.5 h-2.5" />
                                      <span>{new Date(file.expires_at).toLocaleDateString()}</span>
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-400 tabular-nums mt-0.5 transition-colors duration-200 group-hover:text-slate-300">
                                  {formatBytes(file.size_bytes)} · {new Date(file.timestamp).toLocaleDateString()}
                                  {typeof file.download_count === 'number' && (
                                    <> · {file.download_count} {t.downloads_suffix}</>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 sm:gap-2 self-end sm:self-center shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopyText(fullUrl)}
                            className="px-2.5 sm:px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-all duration-150"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            <span>{t.btn_copy_short}</span>
                          </button>
                          {canManageFile && editingFileId !== file.id && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingFileId(file.id);
                                setEditingName(file.original_name);
                              }}
                              aria-label={t.btn_edit_name}
                              title={t.btn_edit_name}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-slate-200 hover:text-white cursor-pointer transition-all duration-150"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setQrUrl(fullUrl)}
                            aria-label={t.btn_qr_code}
                            title={t.btn_qr_code}
                            className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 hover:border-white/20 text-slate-200 hover:text-white cursor-pointer transition-all duration-150"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                          </button>
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
                          {canManageFile && (
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
                </div>
              )}

              {/* Shared Collections Strip */}
              {collections.length > 0 && (
                <div className="mt-7">
                  <h3 className="text-sm font-bold text-slate-200 mb-2.5 flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-cyan-400" />
                    <span>{t.collections_heading}</span>
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {collections.map((col) => {
                      const colUrl = `${window.location.origin}${col.share_url}`;
                      return (
                        <div
                          key={col.id}
                          className="rounded-xl bg-[#090f19]/80 border border-white/[0.08] px-4 py-3 flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white truncate">
                              {col.title}
                            </div>
                            <div className="text-xs text-slate-400 tabular-nums mt-0.5">
                              {(t.collection_files_count || '{count} files').replace(
                                '{count}',
                                String(col.file_count)
                              )}{' '}
                              · {formatBytes(col.total_bytes)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleCopyText(colUrl)}
                              aria-label={t.btn_copy_short}
                              title={t.btn_copy_link}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-slate-200 cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5 text-cyan-400" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setQrUrl(colUrl)}
                              aria-label={t.btn_qr_code}
                              title={t.btn_qr_code}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-slate-200 cursor-pointer"
                            >
                              <QrCode className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => navigateToPath(`/c/${col.id}`)}
                              aria-label={t.btn_open_collection}
                              title={t.btn_open_collection}
                              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-slate-200 cursor-pointer"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCollection(col)}
                              aria-label="Delete collection"
                              className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-red-400 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
        pendingFiles={pendingDropFiles}
        isAuthenticated={Boolean(activeUser)}
        storageUsedBytes={storageUsedBytes}
        storageLimitBytes={activeStorageLimitBytes}
        onClearPendingFiles={() => setPendingDropFiles([])}
        onClose={() => setUploadOpen(false)}
        onFilesUploaded={handleFilesUploaded}
        onPromptSignUp={(blockedFiles) => {
          setQueuedQuotaFiles(blockedFiles);
          setUploadOpen(false);
          setAuthInitialTab('register');
          setAuthModalOpen(true);
        }}
        onCopyText={handleCopyText}
        onOpenFilePage={(fId) => navigateToPath(`/f/${fId}`)}
        onOpenCollectionPage={(cId) => navigateToPath(`/c/${cId}`)}
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
      <OfflineIndicator t={t} />
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

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

export const GUEST_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const REGISTERED_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const STORAGE_TIER_REGISTERED = 'free_10gb' as const;

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Persist user session securely across browser reloads and restarts
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.error('Failed to set auth persistence:', err);
});

// Startup Firestore connectivity validation
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration: client is offline.');
    }
  }
}
testConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function syncUserProfileToFirestore(user: User, knownUsedBytes?: number): Promise<void> {
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const rawName = (user.displayName || user.email?.split('@')[0] || 'User').trim().slice(0, 64);
  const username = rawName.length >= 2 ? rawName : 'User';
  const email = (user.email || '').trim().toLowerCase().slice(0, 160);
  const photoUrl = user.photoURL ? user.photoURL.slice(0, 512) : '';

  try {
    const existingSnap = await getDoc(userRef);
    if (!existingSnap.exists()) {
      const clampedUsed = Math.min(
        REGISTERED_STORAGE_LIMIT_BYTES,
        Math.max(0, Math.round(knownUsedBytes ?? 0))
      );
      const payload: Record<string, unknown> = {
        uid: user.uid,
        username,
        email,
        provider: 'google',
        storageTier: STORAGE_TIER_REGISTERED,
        storageLimitBytes: REGISTERED_STORAGE_LIMIT_BYTES,
        storageUsedBytes: clampedUsed,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (photoUrl) payload.photoUrl = photoUrl;
      await setDoc(userRef, payload);
      return;
    }

    const prev = existingSnap.data();
    const currentUsed =
      typeof knownUsedBytes === 'number'
        ? knownUsedBytes
        : typeof prev.storageUsedBytes === 'number'
          ? prev.storageUsedBytes
          : 0;
    const clampedUsed = Math.min(REGISTERED_STORAGE_LIMIT_BYTES, Math.max(0, Math.round(currentUsed)));

    const needsUpgrade =
      prev.storageTier !== STORAGE_TIER_REGISTERED ||
      prev.storageLimitBytes !== REGISTERED_STORAGE_LIMIT_BYTES ||
      typeof prev.storageUsedBytes !== 'number' ||
      prev.username !== username ||
      prev.email !== email ||
      (photoUrl && prev.photoUrl !== photoUrl);

    if (needsUpgrade) {
      const updatePayload: Record<string, unknown> = {
        username: username.length >= 2 ? username : String(prev.username || 'User').slice(0, 64),
        email: email || String(prev.email || ''),
        provider: 'google',
        storageTier: STORAGE_TIER_REGISTERED,
        storageLimitBytes: REGISTERED_STORAGE_LIMIT_BYTES,
        storageUsedBytes: clampedUsed,
        updatedAt: serverTimestamp(),
      };
      if (photoUrl) updatePayload.photoUrl = photoUrl;
      await updateDoc(userRef, updatePayload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export { firebaseConfig };

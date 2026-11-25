export type LangCode = 'es' | 'en' | 'it' | 'de' | 'fr' | 'pt' | 'nl-be';

export interface UploadedFileRecord {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type?: string;
  share_url: string;
  delete_token: string;
  timestamp: string;
}

export interface FileInfoResponse {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type: string;
  upload_time: string;
  download_count: number;
}

export type StorageTier = 'guest_5gb' | 'free_10gb';

export interface ActiveUser {
  uid: string;
  username: string;
  email: string;
  provider: 'google' | 'password';
  photoUrl?: string | null;
  storageTier?: StorageTier;
  storageLimitBytes?: number;
  storageUsedBytes?: number;
}

export interface FirestoreUserProfile {
  uid: string;
  username: string;
  email: string;
  provider: 'google' | 'password';
  photoUrl?: string;
  storageTier: 'free_10gb';
  storageLimitBytes: number;
  storageUsedBytes: number;
}

export type ChatModelMode = 'general' | 'fast';

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
}

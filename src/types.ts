export type LangCode = 'es' | 'en' | 'it' | 'de' | 'fr' | 'pt' | 'nl-be';

export type ExpirationPreset = 'never' | '1h' | '24h' | '7d' | '30d';

export interface UploadedFileRecord {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type?: string;
  share_url: string;
  delete_token: string;
  timestamp: string;
  download_count?: number;
  has_password?: boolean;
  expires_at?: string | null;
}

export interface FileInfoResponse {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type: string;
  upload_time: string;
  download_count: number;
  requires_password?: boolean;
  unlocked?: boolean;
  expires_at?: string | null;
}

export interface FileCollectionSummary {
  id: string;
  title: string;
  share_url: string;
  delete_token?: string;
  created_at: string;
  file_count: number;
  total_bytes: number;
}

export interface CollectionDetailResponse {
  id: string;
  title: string;
  created_at: string;
  files: Array<{
    id: string;
    original_name: string;
    size_bytes: number;
    mime_type: string;
    upload_time: string;
    download_count: number;
    requires_password: boolean;
    expires_at: string | null;
  }>;
}

export type StorageTier = 'guest_500mb' | 'free_2gb';

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
  storageTier: 'free_2gb';
  storageLimitBytes: number;
  storageUsedBytes: number;
}

export type ChatModelMode = 'general' | 'fast';

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
}

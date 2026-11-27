import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

const BASE_DIR = path.resolve(process.cwd());
const IS_VERCEL = Boolean(process.env.VERCEL);
const WRITABLE_BASE_DIR = IS_VERCEL ? path.resolve('/tmp', 'lettingwork') : BASE_DIR;
const UPLOADS_DIR = path.resolve(WRITABLE_BASE_DIR, 'uploads');
const DB_PATH = path.resolve(WRITABLE_BASE_DIR, 'lettingwork.db');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB per upload (local/node)
const SUPABASE_FREE_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB max single file on Supabase Free
const GUEST_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB free guest tier
const REGISTERED_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB registered tier
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE_NAME = 'lw_session';
const GUEST_COOKIE_NAME = 'lw_guest';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_STORAGE_BUCKET = (process.env.SUPABASE_STORAGE_BUCKET || 'lettingwork-files').trim();
const B2_HOST = (process.env.B2_ENDPOINT || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');
const B2_BUCKET = (process.env.B2_BUCKET || '').trim();
const B2_KEY_ID = (process.env.B2_KEY_ID || '').trim();
const B2_APPLICATION_KEY = (process.env.B2_APPLICATION_KEY || '').trim();
const B2_REGION =
  (process.env.B2_REGION || '').trim() ||
  B2_HOST.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i)?.[1] ||
  'us-west-004';

let FIREBASE_PROJECT_ID = '';
try {
  const fbCfg = JSON.parse(
    fs.readFileSync(path.resolve(BASE_DIR, 'firebase-applet-config.json'), 'utf8')
  );
  FIREBASE_PROJECT_ID = String(fbCfg.projectId || '');
} catch {
  FIREBASE_PROJECT_ID = '';
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_REMOTE_KEY = '_system/lettingwork.db';
let db!: DatabaseSync;
let FILE_ACCESS_SECRET = '';

async function restoreDbFromSupabase(force = false): Promise<boolean> {
  if (!isSupabaseStorageEnabled()) return false;
  if (!force && fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0) return false;

  try {
    await ensureSupabaseBucket();
    const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${DB_REMOTE_KEY}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) {
      const tmpPath = `${DB_PATH}.restore.${process.pid}`;
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, DB_PATH);
      console.log(`Restored SQLite database from Supabase (${buf.length} bytes).`);
      return true;
    }
  } catch (err) {
    console.warn('Could not restore SQLite DB from Supabase (starting fresh if none):', err);
  }
  return false;
}

let lastServerlessRefreshAt = 0;

async function refreshDbIfServerlessMissing(force = false): Promise<void> {
  if (!IS_VERCEL || !isSupabaseStorageEnabled()) return;
  const now = Date.now();
  if (!force && now - lastServerlessRefreshAt < 4000) return;
  lastServerlessRefreshAt = now;
  const restored = await restoreDbFromSupabase(true);
  if (restored) {
    try {
      db?.close();
    } catch {
      // Ignore close error
    }
    db = new DatabaseSync(DB_PATH);
  }
}

let dbSyncInFlight: Promise<void> | null = null;
let dbSyncQueued = false;
let dbSyncTimer: ReturnType<typeof setTimeout> | null = null;

async function syncDbToSupabase(): Promise<void> {
  if (!isSupabaseStorageEnabled() || !db) return;
  if (dbSyncInFlight) {
    dbSyncQueued = true;
    await dbSyncInFlight;
    return;
  }

  dbSyncInFlight = (async () => {
    const snapshotPath = path.resolve(WRITABLE_BASE_DIR, `lettingwork.db.snapshot.${process.pid}`);
    try {
      await ensureSupabaseBucket();
      if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
      const escaped = snapshotPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}';`);
      const data = await fs.promises.readFile(snapshotPath);
      const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${DB_REMOTE_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/octet-stream',
          'x-upsert': 'true',
        },
        body: data,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`Supabase DB sync failed (${res.status}): ${text}`);
      }
    } catch (err) {
      console.warn('Supabase DB sync error:', err);
    } finally {
      try {
        if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
      } catch {
        // Ignore temp cleanup errors
      }
    }
  })();

  try {
    await dbSyncInFlight;
  } finally {
    dbSyncInFlight = null;
  }

  if (dbSyncQueued) {
    dbSyncQueued = false;
    await syncDbToSupabase();
  }
}

function scheduleDbSync(delayMs = 300): void {
  if (!isSupabaseStorageEnabled()) return;
  if (dbSyncTimer) clearTimeout(dbSyncTimer);
  dbSyncTimer = setTimeout(() => {
    dbSyncTimer = null;
    void syncDbToSupabase();
  }, delayMs);
}

async function initDatabase(): Promise<void> {
  await restoreDbFromSupabase();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      upload_time TEXT DEFAULT (datetime('now')),
      download_count INTEGER DEFAULT 0,
      delete_token TEXT NOT NULL,
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      user_id TEXT,
      guest_id TEXT,
      delete_token TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_files (
      collection_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      PRIMARY KEY (collection_id, file_id)
    );
  `);

  for (const alterSql of [
    `ALTER TABLE files ADD COLUMN user_id TEXT;`,
    `ALTER TABLE files ADD COLUMN guest_id TEXT;`,
    `ALTER TABLE files ADD COLUMN password_hash TEXT;`,
    `ALTER TABLE files ADD COLUMN password_salt TEXT;`,
    `ALTER TABLE files ADD COLUMN expires_at TEXT;`,
    `ALTER TABLE files ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local';`,
    `ALTER TABLE users ADD COLUMN storage_tier TEXT NOT NULL DEFAULT 'free_10gb';`,
    `ALTER TABLE users ADD COLUMN storage_limit_bytes INTEGER NOT NULL DEFAULT 10737418240;`,
  ]) {
    try {
      db.exec(alterSql);
    } catch {
      // Column already exists
    }
  }

  FILE_ACCESS_SECRET = (() => {
    if (process.env.FILE_ACCESS_SECRET && process.env.FILE_ACCESS_SECRET.length >= 16) {
      return process.env.FILE_ACCESS_SECRET;
    }
    const existingRow = db
      .prepare(`SELECT value FROM app_config WHERE key = 'file_access_secret'`)
      .get() as { value: string } | undefined;
    if (existingRow?.value) return existingRow.value;
    const generated = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('file_access_secret', ?)`).run(generated);
    scheduleDbSync();
    return generated;
  })();
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: string;
}

interface FileRow {
  id: string;
  original_name: string;
  stored_name: string;
  size_bytes: number;
  mime_type: string;
  upload_time: string;
  download_count: number;
  delete_token: string;
  user_id: string | null;
  guest_id?: string | null;
  password_hash?: string | null;
  password_salt?: string | null;
  expires_at?: string | null;
  storage_provider?: string | null;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

function generateFileId(): string {
  return `lw_${crypto.randomBytes(6).toString('hex')}`;
}

function generateCollectionId(): string {
  return `col_${crypto.randomBytes(6).toString('hex')}`;
}

function generateUserId(): string {
  return `usr_${crypto.randomBytes(8).toString('hex')}`;
}

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, actualSalt, 64).toString('hex');
  return { hash: derived, salt: actualSalt };
}

function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const derived = crypto.scryptSync(password, salt, 64);
  const target = Buffer.from(storedHash, 'hex');
  if (derived.length !== target.length) return false;
  return crypto.timingSafeEqual(derived, target);
}

function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || 'archivo').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return base.slice(0, 240) || 'archivo';
}

function resolveUploadPath(storedName: string): string | null {
  const safeBase = path.basename(storedName);
  const resolved = path.resolve(UPLOADS_DIR, safeBase);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function guessMimeType(filename: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  return map[ext] || fallback;
}

function isSafeInlineMime(mime: string): boolean {
  const base = mime.split(';')[0].trim().toLowerCase();
  return (
    base.startsWith('video/') ||
    base.startsWith('audio/') ||
    base === 'image/png' ||
    base === 'image/jpeg' ||
    base === 'image/webp' ||
    base === 'image/gif' ||
    base === 'application/pdf' ||
    base === 'text/plain' ||
    base === 'text/csv' ||
    base === 'application/json'
  );
}

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function getSessionUser(req: Request): { id: string; username: string; email: string } | null {
  const cookies = parseCookies(req.header('Cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.email, s.expires_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ?`
    )
    .get(token) as { id: string; username: string; email: string; expires_at: number } | undefined;

  if (!row) return null;
  if (row.expires_at <= nowEpoch) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, email: row.email };
}

function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSeconds}`;
}

function isSameOriginOrCustomHeader(req: Request): boolean {
  if (req.header('X-Requested-With') === 'LettingWork') return true;
  const origin = req.header('Origin');
  const host = req.header('X-Forwarded-Host') || req.header('Host');
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function getUserStorageUsage(userId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files WHERE user_id = ?')
    .get(userId) as { total: number } | undefined;
  return Number(row?.total || 0);
}

function getGuestStorageUsage(guestId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files WHERE user_id IS NULL AND guest_id = ?')
    .get(guestId) as { total: number } | undefined;
  return Number(row?.total || 0);
}

function getOrCreateGuestId(req: Request, res: Response): string {
  const cookies = parseCookies(req.header('Cookie'));
  const existing = cookies[GUEST_COOKIE_NAME];
  if (existing && /^[a-zA-Z0-9_-]{12,64}$/.test(existing)) {
    return existing;
  }
  const guestId = `gst_${crypto.randomBytes(12).toString('hex')}`;
  res.append(
    'Set-Cookie',
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(guestId)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${SESSION_TTL_SECONDS}`
  );
  return guestId;
}

function readGuestIdIfPresent(req: Request): string | null {
  const cookies = parseCookies(req.header('Cookie'));
  const existing = cookies[GUEST_COOKIE_NAME];
  if (existing && /^[a-zA-Z0-9_-]{12,64}$/.test(existing)) {
    return existing;
  }
  return null;
}

function computeExpiresAt(rawPreset: string | undefined): string | null {
  const preset = (rawPreset || '').trim().toLowerCase();
  const hoursMap: Record<string, number> = {
    '1h': 1,
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  };
  const hours = hoursMap[preset];
  if (!hours) return null;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function isFileExpired(row: Pick<FileRow, 'expires_at'>): boolean {
  if (!row.expires_at) return false;
  const ms = new Date(row.expires_at).getTime();
  return !Number.isNaN(ms) && ms <= Date.now();
}

function signUnlockToken(fileId: string, ttlSeconds = 7200): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', FILE_ACCESS_SECRET)
    .update(`${fileId}:${exp}`)
    .digest('hex');
  return `${exp}.${sig}`;
}

function verifyUnlockToken(fileId: string, token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac('sha256', FILE_ACCESS_SECRET)
    .update(`${fileId}:${exp}`)
    .digest('hex');
  return timingSafeMatch(parts[1], expected);
}

function hasValidFileUnlock(req: Request, fileId: string): boolean {
  const queryToken = typeof req.query.access === 'string' ? req.query.access : undefined;
  const headerToken = req.header('X-File-Access');
  const cookies = parseCookies(req.header('Cookie'));
  const cookieToken = cookies[`lw_unlock_${fileId}`];
  return (
    verifyUnlockToken(fileId, queryToken) ||
    verifyUnlockToken(fileId, headerToken) ||
    verifyUnlockToken(fileId, cookieToken)
  );
}

function isSupabaseStorageEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

let supabaseBucketEnsured = false;

async function ensureSupabaseBucket(): Promise<void> {
  if (!isSupabaseStorageEnabled() || supabaseBucketEnsured) return;
  const checkRes = await fetch(
    `${SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    }
  );
  if (checkRes.ok) {
    supabaseBucketEnsured = true;
    return;
  }
  const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: SUPABASE_STORAGE_BUCKET,
      name: SUPABASE_STORAGE_BUCKET,
      public: false,
    }),
  });
  if (createRes.ok || createRes.status === 409) {
    supabaseBucketEnsured = true;
    return;
  }
  const errBody = await createRes.text().catch(() => '');
  throw new Error(`Supabase bucket check failed (${createRes.status}): ${errBody}`);
}

async function uploadLocalFileToSupabase(
  localPath: string,
  storedName: string,
  mimeType: string
): Promise<boolean> {
  if (!isSupabaseStorageEnabled()) return false;
  await ensureSupabaseBucket();
  const objectUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(storedName)}`;
  const fileStream = fs.createReadStream(localPath);
  const res = await fetch(objectUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: Readable.toWeb(fileStream) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed (${res.status}): ${text}`);
  }
  try {
    fs.unlinkSync(localPath);
  } catch {
    // Ignore local cleanup error
  }
  return true;
}

async function deleteFromSupabase(storedName: string): Promise<void> {
  if (!isSupabaseStorageEnabled()) return;
  try {
    const objectUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(storedName)}`;
    await fetch(objectUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });
  } catch {
    // Ignore remote cleanup errors
  }
}

function isB2Enabled(): boolean {
  return Boolean(B2_HOST && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getB2SigningKey(dateStamp: string): Buffer {
  const kDate = hmacSha256(`AWS4${B2_APPLICATION_KEY}`, dateStamp);
  const kRegion = hmacSha256(kDate, B2_REGION);
  const kService = hmacSha256(kRegion, 's3');
  return hmacSha256(kService, 'aws4_request');
}

function generateB2PresignedUrl(
  method: 'GET' | 'PUT',
  objectKey: string,
  expiresInSeconds: number,
  extraQuery?: Record<string, string>
): string {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${B2_REGION}/s3/aws4_request`;

  const encodedBucket = encodeRfc3986(B2_BUCKET);
  const encodedKey = objectKey.split('/').map(encodeRfc3986).join('/');
  const canonicalUri = `/${encodedBucket}/${encodedKey}`;

  const queryParams: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${B2_KEY_ID}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (extraQuery) {
    for (const [k, v] of Object.entries(extraQuery)) {
      queryParams.push([k, v]);
    }
  }

  const canonicalQueryString = queryParams
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalHeaders = `host:${B2_HOST}\n`;
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(getB2SigningKey(dateStamp), stringToSign).toString('hex');

  return `https://${B2_HOST}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

async function signedB2Request(
  method: 'GET' | 'PUT' | 'DELETE',
  objectKey: string | null,
  rawQuery = '',
  body?: string | Buffer,
  contentType?: string
): Promise<globalThis.Response> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${B2_REGION}/s3/aws4_request`;

  const encodedBucket = encodeRfc3986(B2_BUCKET);
  const canonicalUri = objectKey
    ? `/${encodedBucket}/${objectKey.split('/').map(encodeRfc3986).join('/')}`
    : `/${encodedBucket}/`;

  const payloadHash = body !== undefined ? sha256Hex(body) : sha256Hex('');
  const headersToSign: Record<string, string> = {
    host: B2_HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (body !== undefined) {
    headersToSign['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
  }
  if (contentType) {
    headersToSign['content-type'] = contentType;
  }

  const sortedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalQuery = rawQuery
    ? rawQuery
        .split('&')
        .map((pair) => {
          const [k, v = ''] = pair.split('=');
          return `${encodeRfc3986(decodeURIComponent(k))}=${encodeRfc3986(decodeURIComponent(v))}`;
        })
        .sort()
        .join('&')
    : '';

  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(getB2SigningKey(dateStamp), stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${B2_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${B2_HOST}${canonicalUri}${rawQuery ? `?${rawQuery}` : ''}`;

  const fetchHeaders: Record<string, string> = {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (headersToSign['content-md5']) fetchHeaders['Content-MD5'] = headersToSign['content-md5'];
  if (contentType) fetchHeaders['Content-Type'] = contentType;

  return fetch(url, {
    method,
    headers: fetchHeaders,
    body: body as BodyInit | undefined,
  });
}

let b2CorsEnsured = false;

async function ensureB2BucketCors(): Promise<void> {
  if (!isB2Enabled() || b2CorsEnsured) return;
  const corsXml = `<CORSConfiguration><CORSRule><ID>LettingWorkBrowserUploads</ID><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  try {
    const res = await signedB2Request('PUT', null, 'cors=', corsXml, 'application/xml');
    if (res.ok) {
      b2CorsEnsured = true;
    } else {
      const errText = await res.text().catch(() => '');
      console.warn(`B2 PutBucketCors note (${res.status}): ${errText}`);
    }
  } catch (err) {
    console.warn('Could not auto-configure B2 CORS:', err);
  }
}

async function deleteFromB2(storedName: string): Promise<void> {
  if (!isB2Enabled()) return;
  try {
    await signedB2Request('DELETE', storedName);
  } catch {
    // Ignore remote cleanup errors
  }
}

async function removeStoredFile(row: Pick<FileRow, 'id' | 'stored_name' | 'storage_provider'>): Promise<void> {
  db.prepare('DELETE FROM collection_files WHERE file_id = ?').run(row.id);
  db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
  if (row.storage_provider === 'b2') {
    await deleteFromB2(row.stored_name);
    return;
  }
  if (row.storage_provider === 'supabase') {
    await deleteFromSupabase(row.stored_name);
    return;
  }
  const diskPath = resolveUploadPath(row.stored_name);
  if (diskPath && fs.existsSync(diskPath)) {
    try {
      fs.unlinkSync(diskPath);
    } catch {
      // Ignore cleanup failure
    }
  }
}

let cachedFirebaseJwks: { keys: Record<string, crypto.JsonWebKey>; expiresAt: number } | null = null;

async function getFirebaseJwks(): Promise<Record<string, crypto.JsonWebKey>> {
  const now = Date.now();
  if (cachedFirebaseJwks && cachedFirebaseJwks.expiresAt > now) {
    return cachedFirebaseJwks.keys;
  }
  const resp = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error(`JWK fetch failed (${resp.status})`);
  }
  const data = (await resp.json()) as { keys?: Array<crypto.JsonWebKey & { kid?: string }> };
  const keys: Record<string, crypto.JsonWebKey> = {};
  for (const k of data.keys || []) {
    if (k.kid) keys[k.kid] = k;
  }
  cachedFirebaseJwks = { keys, expiresAt: now + 3600 * 1000 };
  return keys;
}

async function verifyFirebaseIdToken(req: Request): Promise<string | null> {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ') || !FIREBASE_PROJECT_ID) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
    };

    if (
      header.alg !== 'RS256' ||
      !header.kid ||
      payload.aud !== FIREBASE_PROJECT_ID ||
      payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` ||
      !payload.sub ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub) ||
      !payload.exp ||
      payload.exp * 1000 <= Date.now()
    ) {
      return null;
    }

    const keys = await getFirebaseJwks();
    const jwk = keys[header.kid];
    if (!jwk) return null;

    const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      pubKey,
      Buffer.from(parts[2], 'base64url')
    );
    return verified ? payload.sub : null;
  } catch {
    return null;
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const clean = sanitizeFilename(file.originalname);
    const ext = path.extname(clean).slice(0, 16);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const SUPPORT_SYSTEM_INSTRUCTION = `Eres el asistente de soporte al usuario de LettingWork (https://lettingwork-production.up.railway.app), una plataforma web de almacenamiento y compartición rápida de archivos en la nube.

Información clave sobre LettingWork que debes conocer:
- Subida de archivos y nombre personalizado: Permite arrastrar y soltar o seleccionar archivos de hasta 500 MB por subida sin compresión forzada ni captchas, y cambiar el nombre del archivo antes de subirlo o posteriormente desde "Tus Subidas Recientes".
- Enlaces, vista previa y descarga: Cada archivo genera un enlace único (/f/<id>), un código QR y permite ver o reproducir directamente vídeos, imágenes, audios o documentos PDF en el navegador, además de descargar el archivo completo.
- Borrado seguro: Cada archivo cuenta con un token privado de eliminación verificado en servidor; los usuarios registrados pueden gestionar, renombrar y borrar sus archivos desde "Tus Subidas Recientes".
- Cuentas y almacenamiento: Sin registro (Modo Invitado) se ofrecen 5 GB gratuitos. Al crear una cuenta gratuita (con correo/contraseña o con Google), el almacenamiento sube automáticamente a 10 GB gratuitos y los archivos quedan sincronizados entre dispositivos.
- Idiomas disponibles: Español, Inglés, Italiano, Alemán, Francés, Portugués y Neerlandés (Bélgica), accesibles desde el menú inferior.

Reglas de respuesta:
- Responde siempre en el idioma en que te escriba el usuario (o en el idioma activo de la interfaz si no está claro).
- Sé claro, natural, directo y conciso (2 a 4 frases o pasos breves).
- No inventes funciones que no existen ni pidas claves API o contraseñas al usuario.`;

async function createSupabaseSignedUploadUrl(storedName: string): Promise<string> {
  await ensureSupabaseBucket();
  const signEndpoint = `${SUPABASE_URL}/storage/v1/object/upload/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(storedName)}`;
  const res = await fetch(signEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ upsert: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase signed upload failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) {
    throw new Error('Supabase did not return a signed upload URL');
  }
  return data.url.startsWith('http') ? data.url : `${SUPABASE_URL}/storage/v1${data.url}`;
}

async function createSupabaseSignedDownloadUrl(
  storedName: string,
  downloadFilename?: string
): Promise<string> {
  await ensureSupabaseBucket();
  const signEndpoint = `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(storedName)}`;
  const res = await fetch(signEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase signed download failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { signedURL?: string };
  if (!data.signedURL) {
    throw new Error('Supabase did not return a signed download URL');
  }
  const base = data.signedURL.startsWith('http')
    ? data.signedURL
    : `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  if (!downloadFilename) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}download=${encodeURIComponent(downloadFilename)}`;
}

function signUploadCompleteToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', FILE_ACCESS_SECRET).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

function verifyUploadCompleteToken<T>(token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto.createHmac('sha256', FILE_ACCESS_SECRET).update(encoded).digest('hex');
  if (!timingSafeMatch(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T & {
      exp?: number;
    };
    if (!parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function createApp() {
  await initDatabase();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({
        ok: true,
        status: 'operational',
        db: 'connected',
        storage: isB2Enabled() ? 'b2' : isSupabaseStorageEnabled() ? 'supabase' : 'local',
      });
    } catch {
      res.status(500).json({ ok: false, status: 'degraded' });
    }
  });

  // Multi-turn User Help Chat powered by Gemini
  app.post('/api/chat', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({
        success: false,
        error: 'El servicio de chat no está configurado en este momento (falta GEMINI_API_KEY).',
      });
      return;
    }

    const rawMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!rawMessage || rawMessage.length > 2000) {
      res.status(400).json({
        success: false,
        error: 'Escribe una pregunta válida (entre 1 y 2000 caracteres).',
      });
      return;
    }

    const mode = req.body?.mode === 'fast' ? 'fast' : 'general';
    const model = mode === 'fast' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
    const uiLang = typeof req.body?.lang === 'string' ? req.body.lang.slice(0, 12) : 'es';

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const formattedHistory = rawHistory
      .slice(-20)
      .filter(
        (item: unknown): item is { role: 'user' | 'model'; text: string } =>
          Boolean(
            item &&
              typeof item === 'object' &&
              ((item as { role?: unknown }).role === 'user' ||
                (item as { role?: unknown }).role === 'model') &&
              typeof (item as { text?: unknown }).text === 'string' &&
              (item as { text: string }).text.trim().length > 0
          )
      )
      .map((item: { role: 'user' | 'model'; text: string }) => ({
        role: item.role,
        parts: [{ text: item.text.slice(0, 4000) }],
      }));

    try {
      const response = await (async () => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const chat = ai.chats.create({
              model,
              config: {
                systemInstruction: `${SUPPORT_SYSTEM_INSTRUCTION}\nIdioma activo de la interfaz del usuario: ${uiLang}.`,
              },
              history: formattedHistory,
            });
            return await chat.sendMessage({ message: rawMessage });
          } catch (err: unknown) {
            lastErr = err;
            const status = typeof (err as { status?: number })?.status === 'number'
              ? (err as { status: number }).status
              : 500;
            if ((status === 503 || status === 500) && attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 600 * Math.pow(2, attempt)));
              continue;
            }
            throw err;
          }
        }
        throw lastErr;
      })();

      const reply = (response.text || '').trim();

      if (!reply) {
        res.status(502).json({
          success: false,
          error: 'El asistente no devolvió una respuesta válida. Inténtalo de nuevo.',
        });
        return;
      }

      res.json({ success: true, reply, model });
    } catch (err: unknown) {
      const errObj = err as { status?: number; message?: string };
      const status = typeof errObj?.status === 'number' ? errObj.status : 500;
      const msg = errObj?.message || 'Error al consultar el asistente.';
      console.error('Gemini chat error:', status, msg);

      if (status === 400 || status === 403) {
        res.status(status).json({
          success: false,
          error: 'La clave API de Gemini no es válida o no tiene permisos. Revísala en Settings > Secrets.',
        });
        return;
      }

      if (status === 429) {
        res.status(429).json({
          success: false,
          error: 'Se alcanzó el límite temporal de consultas. Inténtalo de nuevo en unos segundos.',
        });
        return;
      }

      if (status === 503) {
        res.status(503).json({
          success: false,
          error: 'El servicio del asistente está temporalmente saturado o en mantenimiento. Inténtalo de nuevo en unos segundos.',
        });
        return;
      }

      res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: 'No se pudo obtener respuesta del asistente en este momento.',
      });
    }
  });

  // Auth: Register persistent account in SQLite
  app.post('/api/auth/register', express.json(), (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (username.length < 3 || username.length > 48) {
      res.status(400).json({ success: false, error: 'El nombre de usuario debe tener entre 3 y 48 caracteres.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
      res.status(400).json({ success: false, error: 'Correo electrónico inválido.' });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
      .get(username, email);
    if (existing) {
      res.status(409).json({ success: false, error: 'El nombre de usuario o correo ya está registrado.' });
      return;
    }

    const userId = generateUserId();
    const { hash, salt } = hashPassword(password);
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, salt, storage_tier, storage_limit_bytes)
       VALUES (?, ?, ?, ?, ?, 'free_10gb', ?)`
    ).run(userId, username, email, hash, salt, REGISTERED_QUOTA_BYTES);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      userId,
      expiresAt
    );
    scheduleDbSync();

    res.setHeader('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));
    res.json({
      success: true,
      user: {
        uid: userId,
        username,
        email,
        provider: 'password',
        storage_tier: 'free_10gb',
        storage_limit_bytes: REGISTERED_QUOTA_BYTES,
        storage_used_bytes: 0,
      },
    });
  });

  // Auth: Login with username or email + password
  app.post('/api/auth/login', express.json(), (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      res.status(400).json({ success: false, error: 'Ingresa tu usuario/correo y contraseña.' });
      return;
    }

    const user = db
      .prepare(
        `SELECT id, username, email, password_hash, salt
         FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?`
      )
      .get(identifier, identifier) as UserRow | undefined;

    if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
      res.status(401).json({ success: false, error: 'Credenciales inválidas. Revisa tu correo o contraseña.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      user.id,
      expiresAt
    );
    scheduleDbSync();

    res.setHeader('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));
    res.json({
      success: true,
      user: {
        uid: user.id,
        username: user.username,
        email: user.email,
        provider: 'password',
        storage_tier: 'free_10gb',
        storage_limit_bytes: REGISTERED_QUOTA_BYTES,
        storage_used_bytes: getUserStorageUsage(user.id),
      },
    });
  });

  // Auth: Check current persistent session
  app.get('/api/auth/me', (req: Request, res: Response) => {
    const user = getSessionUser(req);
    if (!user) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      user: {
        uid: user.id,
        username: user.username,
        email: user.email,
        provider: 'password',
        storage_tier: 'free_10gb',
        storage_limit_bytes: REGISTERED_QUOTA_BYTES,
        storage_used_bytes: getUserStorageUsage(user.id),
      },
    });
  });

  // Auth: Logout
  app.post('/api/auth/logout', (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const cookies = parseCookies(req.header('Cookie'));
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      scheduleDbSync();
    }
    res.setHeader('Set-Cookie', buildSessionCookie('', 0));
    res.json({ success: true });
  });

  // User's persistent uploaded files
  app.get('/api/user/files', (req: Request, res: Response) => {
    const user = getSessionUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'No autenticado' });
      return;
    }

    const rows = db
      .prepare(
        `SELECT id, original_name, size_bytes, mime_type, upload_time, download_count, delete_token, expires_at,
                CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 1 ELSE 0 END AS has_password
         FROM files WHERE user_id = ? ORDER BY upload_time DESC`
      )
      .all(user.id)
      .map((r: Record<string, unknown>) => ({
        ...r,
        has_password: Boolean(r.has_password),
      }));

    res.json({
      success: true,
      files: rows,
      storage_tier: 'free_10gb',
      storage_limit_bytes: REGISTERED_QUOTA_BYTES,
      storage_used_bytes: getUserStorageUsage(user.id),
    });
  });

  app.get('/api/recent', (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, original_name, size_bytes, mime_type, upload_time, download_count
           FROM files ORDER BY upload_time DESC LIMIT 12`
        )
        .all();
      res.json({ success: true, files: rows });
    } catch {
      res.status(500).json({ success: false, error: 'Database query failed' });
    }
  });

  app.get('/api/info/:id', async (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).json({ success: false, error: 'Invalid file ID' });
      return;
    }

    let row = db
      .prepare(
        `SELECT id, original_name, stored_name, size_bytes, mime_type, upload_time, download_count, password_hash, expires_at, storage_provider
         FROM files WHERE id = ?`
      )
      .get(fileId) as FileRow | undefined;

    if (!row && IS_VERCEL) {
      await refreshDbIfServerlessMissing(true);
      row = db
        .prepare(
          `SELECT id, original_name, stored_name, size_bytes, mime_type, upload_time, download_count, password_hash, expires_at, storage_provider
           FROM files WHERE id = ?`
        )
        .get(fileId) as FileRow | undefined;
    }

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found or deleted' });
      return;
    }

    if (isFileExpired(row)) {
      await removeStoredFile(row);
      res.status(410).json({ success: false, expired: true, error: 'This link has expired' });
      return;
    }

    const requiresPassword = Boolean(row.password_hash);
    const unlocked = !requiresPassword || hasValidFileUnlock(req, row.id);

    res.json({
      success: true,
      file: {
        id: row.id,
        original_name: row.original_name,
        size_bytes: row.size_bytes,
        mime_type: row.mime_type,
        upload_time: row.upload_time,
        download_count: row.download_count,
        requires_password: requiresPassword,
        unlocked,
        expires_at: row.expires_at || null,
      },
    });
  });

  app.post('/api/file/:id/unlock', express.json(), async (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).json({ success: false, error: 'Invalid file ID' });
      return;
    }

    const row = db
      .prepare('SELECT id, stored_name, password_hash, password_salt, expires_at, storage_provider FROM files WHERE id = ?')
      .get(fileId) as FileRow | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    if (isFileExpired(row)) {
      await removeStoredFile(row);
      res.status(410).json({ success: false, expired: true, error: 'This link has expired' });
      return;
    }

    if (row.password_hash && row.password_salt) {
      const candidate = String(req.body?.password || '');
      if (!candidate || !verifyPassword(candidate, row.password_hash, row.password_salt)) {
        res.status(401).json({ success: false, error: 'Incorrect password' });
        return;
      }
    }

    const accessToken = signUnlockToken(fileId);
    res.append(
      'Set-Cookie',
      `lw_unlock_${fileId}=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=7200`
    );
    res.json({ success: true, access_token: accessToken });
  });

  app.get('/api/download/:id', async (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).send('Invalid file ID');
      return;
    }

    let row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row && IS_VERCEL) {
      await refreshDbIfServerlessMissing(true);
      row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    }
    if (!row) {
      res.status(404).send('File not found');
      return;
    }

    if (isFileExpired(row)) {
      await removeStoredFile(row);
      res.status(410).send('Link expired');
      return;
    }

    if (row.password_hash && !hasValidFileUnlock(req, row.id)) {
      res.status(401).send('Password required');
      return;
    }

    const encodedName = encodeURIComponent(row.original_name);
    const asciiName = row.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');

    if (row.storage_provider === 'b2' && isB2Enabled()) {
      try {
        const signedDownloadUrl = generateB2PresignedUrl('GET', row.stored_name, 300, {
          'response-content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        });
        db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(fileId);
        if (IS_VERCEL) {
          await syncDbToSupabase();
        } else {
          scheduleDbSync();
        }
        res.redirect(302, signedDownloadUrl);
        return;
      } catch {
        if (!res.headersSent) res.status(500).send('Backblaze B2 read error');
        return;
      }
    }

    if (row.storage_provider === 'supabase' && isSupabaseStorageEnabled()) {
      try {
        if (IS_VERCEL) {
          const signedDownloadUrl = await createSupabaseSignedDownloadUrl(
            row.stored_name,
            row.original_name
          );
          db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(fileId);
          await syncDbToSupabase();
          res.redirect(302, signedDownloadUrl);
          return;
        }
        const objectUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(row.stored_name)}`;
        const upstream = await fetch(objectUrl, {
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
          },
        });
        if (!upstream.ok || !upstream.body) {
          res.status(404).send('File unavailable on cloud storage');
          return;
        }
        db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(fileId);
        scheduleDbSync();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const len = upstream.headers.get('content-length');
        if (len) res.setHeader('Content-Length', len);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
        );
        Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
        return;
      } catch {
        if (!res.headersSent) res.status(500).send('Cloud storage read error');
        return;
      }
    }

    const diskPath = resolveUploadPath(row.stored_name);
    if (!diskPath || !fs.existsSync(diskPath)) {
      res.status(404).send('File unavailable on storage');
      return;
    }

    db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(fileId);

    const stat = fs.statSync(diskPath);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
    );

    const stream = fs.createReadStream(diskPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end('Read error');
    });
    stream.pipe(res);
  });

  // Inline preview / media streaming (supports HTTP Range for video/audio playback)
  app.get('/api/view/:id', async (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).send('Invalid file ID');
      return;
    }

    let row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row && IS_VERCEL) {
      await refreshDbIfServerlessMissing(true);
      row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    }
    if (!row) {
      res.status(404).send('File not found');
      return;
    }

    if (isFileExpired(row)) {
      await removeStoredFile(row);
      res.status(410).send('Link expired');
      return;
    }

    if (row.password_hash && !hasValidFileUnlock(req, row.id)) {
      res.status(401).send('Password required');
      return;
    }

    const detectedMime = guessMimeType(row.original_name, row.mime_type);
    const contentType = isSafeInlineMime(detectedMime) ? detectedMime : 'application/octet-stream';
    const disposition = isSafeInlineMime(detectedMime) ? 'inline' : 'attachment';
    const encodedName = encodeURIComponent(row.original_name);
    const asciiName = row.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const range = req.header('Range');

    if (row.storage_provider === 'b2' && isB2Enabled()) {
      try {
        const signedViewUrl = generateB2PresignedUrl('GET', row.stored_name, 300, {
          'response-content-type': contentType,
          'response-content-disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        });
        res.redirect(302, signedViewUrl);
        return;
      } catch {
        if (!res.headersSent) res.status(500).send('Backblaze B2 read error');
        return;
      }
    }

    if (row.storage_provider === 'supabase' && isSupabaseStorageEnabled()) {
      try {
        if (IS_VERCEL) {
          const signedViewUrl = await createSupabaseSignedDownloadUrl(
            row.stored_name,
            disposition === 'attachment' ? row.original_name : undefined
          );
          res.redirect(302, signedViewUrl);
          return;
        }
        const objectUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(row.stored_name)}`;
        const upstreamHeaders: Record<string, string> = {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        };
        if (range) upstreamHeaders.Range = range;
        const upstream = await fetch(objectUrl, { headers: upstreamHeaders });
        if (!upstream.ok && upstream.status !== 206) {
          res.status(upstream.status === 416 ? 416 : 404).send('File unavailable on cloud storage');
          return;
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
        );
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        if (upstream.body) {
          Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
        } else {
          res.end();
        }
        return;
      } catch {
        if (!res.headersSent) res.status(500).send('Cloud storage read error');
        return;
      }
    }

    const diskPath = resolveUploadPath(row.stored_name);
    if (!diskPath || !fs.existsSync(diskPath)) {
      res.status(404).send('File unavailable on storage');
      return;
    }

    const stat = fs.statSync(diskPath);
    const total = stat.size;

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
    );

    if (range && total > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (!Number.isNaN(start) && !Number.isNaN(end) && start >= 0 && start <= end && end < total) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          const stream = fs.createReadStream(diskPath, { start, end });
          stream.on('error', () => {
            if (!res.headersSent) res.status(500).end('Read error');
          });
          stream.pipe(res);
          return;
        }
      }
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }

    res.setHeader('Content-Length', String(total));
    const stream = fs.createReadStream(diskPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end('Read error');
    });
    stream.pipe(res);
  });

  app.post('/api/upload-init', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const useB2 = isB2Enabled();
    const useSupabase = !useB2 && isSupabaseStorageEnabled();

    if (!useB2 && !useSupabase) {
      res.json({ success: true, mode: 'proxy' });
      return;
    }

    await refreshDbIfServerlessMissing(false);
    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const ownerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = ownerUserId ? null : getOrCreateGuestId(req, res);
    const quotaLimit = ownerUserId ? REGISTERED_QUOTA_BYTES : GUEST_QUOTA_BYTES;
    const currentUsedBytes = ownerUserId
      ? getUserStorageUsage(ownerUserId)
      : getGuestStorageUsage(guestId!);

    const originalName = sanitizeFilename(String(req.body?.original_name || 'archivo'));
    const sizeBytes = Number(req.body?.size_bytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      res.status(400).json({ success: false, error: 'Invalid file size' });
      return;
    }

    const maxAllowedBytes = useB2 ? MAX_UPLOAD_BYTES : SUPABASE_FREE_MAX_FILE_BYTES;
    if (sizeBytes > maxAllowedBytes) {
      res.status(413).json({
        success: false,
        error: useB2
          ? 'El límite máximo por archivo es de 500 MB.'
          : 'El límite máximo por archivo en el plan gratuito en la nube es de 50 MB.',
      });
      return;
    }

    if (currentUsedBytes + sizeBytes > quotaLimit) {
      res.status(413).json({
        success: false,
        code: ownerUserId ? 'ACCOUNT_QUOTA_EXCEEDED' : 'GUEST_QUOTA_EXCEEDED',
        limit_bytes: quotaLimit,
        used_bytes: currentUsedBytes,
        error: ownerUserId
          ? '10 GB storage limit reached.'
          : '5 GB free guest limit reached. Sign up free to unlock 10 GB.',
      });
      return;
    }

    const rawPassword = typeof req.body?.password === 'string' ? req.body.password.slice(0, 128) : '';
    const passwordCreds = rawPassword ? hashPassword(rawPassword) : null;
    const expiresAt = computeExpiresAt(
      typeof req.body?.expires_in === 'string' ? req.body.expires_in : undefined
    );
    const mimeType = guessMimeType(
      originalName,
      typeof req.body?.mime_type === 'string' ? req.body.mime_type : 'application/octet-stream'
    );
    const ext = path.extname(originalName).slice(0, 16);
    const storedName = `${crypto.randomUUID()}${ext}`;

    try {
      let signedUrl: string;
      const storageProvider = useB2 ? 'b2' : 'supabase';
      if (useB2) {
        await ensureB2BucketCors();
        signedUrl = generateB2PresignedUrl('PUT', storedName, 900);
      } else {
        signedUrl = await createSupabaseSignedUploadUrl(storedName);
      }

      const completeToken = signUploadCompleteToken({
        storedName,
        originalName,
        sizeBytes,
        mimeType,
        ownerUserId,
        guestId,
        passwordHash: passwordCreds ? passwordCreds.hash : null,
        passwordSalt: passwordCreds ? passwordCreds.salt : null,
        expiresAt,
        storageProvider,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      res.json({
        success: true,
        mode: 'direct',
        signedUrl,
        completeToken,
        mimeType,
        storageProvider,
      });
    } catch (err) {
      console.error('upload-init failed:', err);
      if (IS_VERCEL) {
        res.status(502).json({ success: false, error: 'Could not initialize cloud upload' });
        return;
      }
      res.json({ success: true, mode: 'proxy' });
    }
  });

  app.post('/api/upload-complete', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const token = String(req.body?.completeToken || '').trim();
    const payload = verifyUploadCompleteToken<{
      storedName: string;
      originalName: string;
      sizeBytes: number;
      mimeType: string;
      ownerUserId: string | null;
      guestId: string | null;
      passwordHash: string | null;
      passwordSalt: string | null;
      expiresAt: string | null;
      storageProvider?: string;
    }>(token);

    if (!payload) {
      res.status(400).json({ success: false, error: 'Invalid or expired upload token' });
      return;
    }

    await refreshDbIfServerlessMissing(false);
    const fileId = generateFileId();
    const deleteToken = crypto.randomBytes(24).toString('hex');
    const storageProvider = payload.storageProvider === 'b2' ? 'b2' : 'supabase';

    db.prepare(
      `INSERT INTO files (id, original_name, stored_name, size_bytes, mime_type, delete_token, user_id, guest_id, password_hash, password_salt, expires_at, storage_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      fileId,
      payload.originalName,
      payload.storedName,
      payload.sizeBytes,
      payload.mimeType,
      deleteToken,
      payload.ownerUserId,
      payload.guestId,
      payload.passwordHash,
      payload.passwordSalt,
      payload.expiresAt,
      storageProvider
    );

    await syncDbToSupabase();

    res.json({
      success: true,
      id: fileId,
      original_name: payload.originalName,
      size_bytes: payload.sizeBytes,
      mime_type: payload.mimeType,
      share_url: `/f/${fileId}`,
      delete_token: deleteToken,
      download_count: 0,
      has_password: Boolean(payload.passwordHash),
      expires_at: payload.expiresAt,
      storage_provider: storageProvider,
    });
  });

  app.post('/api/upload', async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const ownerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = ownerUserId ? null : getOrCreateGuestId(req, res);
    const quotaLimit = ownerUserId ? REGISTERED_QUOTA_BYTES : GUEST_QUOTA_BYTES;
    const currentUsedBytes = ownerUserId
      ? getUserStorageUsage(ownerUserId)
      : getGuestStorageUsage(guestId!);
    const rawHeaderFilename = req.header('X-Filename');
    const rawHeaderPassword = req.header('X-File-Password');
    const rawHeaderExpires = req.header('X-File-Expires');

    let decodedPassword = '';
    if (rawHeaderPassword) {
      try {
        decodedPassword = decodeURIComponent(rawHeaderPassword).slice(0, 128);
      } catch {
        decodedPassword = rawHeaderPassword.slice(0, 128);
      }
    }
    const passwordCreds = decodedPassword ? hashPassword(decodedPassword) : null;
    const expiresAt = computeExpiresAt(rawHeaderExpires);

    if (rawHeaderFilename) {
      let decodedName = rawHeaderFilename;
      try {
        decodedName = decodeURIComponent(rawHeaderFilename);
      } catch {
        decodedName = rawHeaderFilename;
      }

      const originalName = sanitizeFilename(decodedName);
      const ext = path.extname(originalName).slice(0, 16);
      const storedName = `${crypto.randomUUID()}${ext}`;
      const destPath = resolveUploadPath(storedName);
      if (!destPath) {
        res.status(400).json({ success: false, error: 'Invalid upload destination' });
        return;
      }

      const contentLength = Number(req.header('Content-Length') || 0);
      if (contentLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ success: false, error: 'File exceeds 500 MB server limit' });
        return;
      }
      if (contentLength > 0 && currentUsedBytes + contentLength > quotaLimit) {
        res.status(413).json({
          success: false,
          code: ownerUserId ? 'ACCOUNT_QUOTA_EXCEEDED' : 'GUEST_QUOTA_EXCEEDED',
          limit_bytes: quotaLimit,
          used_bytes: currentUsedBytes,
          error: ownerUserId
            ? '10 GB storage limit reached.'
            : '5 GB free guest limit reached. Sign up free to unlock 10 GB.',
        });
        return;
      }

      let bytesWritten = 0;
      let aborted = false;
      const writeStream = fs.createWriteStream(destPath);

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_UPLOAD_BYTES) {
          aborted = true;
          writeStream.destroy();
          fs.unlink(destPath, () => {});
          if (!res.headersSent) {
            res.status(413).json({ success: false, error: 'File exceeds 500 MB server limit' });
          }
          req.destroy();
          return;
        }
        if (currentUsedBytes + bytesWritten > quotaLimit) {
          aborted = true;
          writeStream.destroy();
          fs.unlink(destPath, () => {});
          if (!res.headersSent) {
            res.status(413).json({
              success: false,
              code: ownerUserId ? 'ACCOUNT_QUOTA_EXCEEDED' : 'GUEST_QUOTA_EXCEEDED',
              limit_bytes: quotaLimit,
              used_bytes: currentUsedBytes,
              error: ownerUserId
                ? '10 GB storage limit reached.'
                : '5 GB free guest limit reached. Sign up free to unlock 10 GB.',
            });
          }
          req.destroy();
          return;
        }
        if (!writeStream.write(chunk)) {
          req.pause();
          writeStream.once('drain', () => req.resume());
        }
      });

      req.on('end', () => {
        if (aborted) return;
        writeStream.end(async () => {
          const fileId = generateFileId();
          const deleteToken = crypto.randomBytes(24).toString('hex');
          const mimeType = guessMimeType(originalName, req.header('Content-Type') || 'application/octet-stream');
          let storageProvider = 'local';

          if (isSupabaseStorageEnabled()) {
            try {
              const uploaded = await uploadLocalFileToSupabase(destPath, storedName, mimeType);
              if (uploaded) storageProvider = 'supabase';
            } catch (err) {
              console.error('External storage upload fallback to local:', err);
            }
          }

          db.prepare(
            `INSERT INTO files (id, original_name, stored_name, size_bytes, mime_type, delete_token, user_id, guest_id, password_hash, password_salt, expires_at, storage_provider)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            fileId,
            originalName,
            storedName,
            bytesWritten,
            mimeType,
            deleteToken,
            ownerUserId,
            guestId,
            passwordCreds ? passwordCreds.hash : null,
            passwordCreds ? passwordCreds.salt : null,
            expiresAt,
            storageProvider
          );
          await syncDbToSupabase();

          res.json({
            success: true,
            id: fileId,
            original_name: originalName,
            size_bytes: bytesWritten,
            mime_type: mimeType,
            share_url: `/f/${fileId}`,
            delete_token: deleteToken,
            download_count: 0,
            has_password: Boolean(passwordCreds),
            expires_at: expiresAt,
            storage_provider: storageProvider,
          });
        });
      });

      req.on('error', () => {
        aborted = true;
        writeStream.destroy();
        fs.unlink(destPath, () => {});
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Upload stream interrupted' });
        }
      });
      return;
    }

    uploadMiddleware.single('file')(req, res, async (err) => {
      if (err) {
        res.status(400).json({ success: false, error: err.message || 'Upload error' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: 'No file provided in request' });
        return;
      }

      if (currentUsedBytes + req.file.size > quotaLimit) {
        fs.unlink(req.file.path, () => {});
        res.status(413).json({
          success: false,
          code: ownerUserId ? 'ACCOUNT_QUOTA_EXCEEDED' : 'GUEST_QUOTA_EXCEEDED',
          limit_bytes: quotaLimit,
          used_bytes: currentUsedBytes,
          error: ownerUserId
            ? '10 GB storage limit reached.'
            : '5 GB free guest limit reached. Sign up free to unlock 10 GB.',
        });
        return;
      }

      const fileId = generateFileId();
      const deleteToken = crypto.randomBytes(24).toString('hex');
      const originalName = sanitizeFilename(req.file.originalname);
      const mimeType = guessMimeType(originalName, req.file.mimetype);
      let storageProvider = 'local';

      if (isSupabaseStorageEnabled()) {
        try {
          const uploaded = await uploadLocalFileToSupabase(req.file.path, req.file.filename, mimeType);
          if (uploaded) storageProvider = 'supabase';
        } catch (uploadErr) {
          console.error('External storage upload fallback to local:', uploadErr);
        }
      }

      db.prepare(
        `INSERT INTO files (id, original_name, stored_name, size_bytes, mime_type, delete_token, user_id, guest_id, password_hash, password_salt, expires_at, storage_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fileId,
        originalName,
        req.file.filename,
        req.file.size,
        mimeType,
        deleteToken,
        ownerUserId,
        guestId,
        passwordCreds ? passwordCreds.hash : null,
        passwordCreds ? passwordCreds.salt : null,
        expiresAt,
        storageProvider
      );
      await syncDbToSupabase();

      res.json({
        success: true,
        id: fileId,
        original_name: originalName,
        size_bytes: req.file.size,
        mime_type: mimeType,
        share_url: `/f/${fileId}`,
        delete_token: deleteToken,
        download_count: 0,
        has_password: Boolean(passwordCreds),
        expires_at: expiresAt,
        storage_provider: storageProvider,
      });
    });
  });

  app.delete('/api/file/:id', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).json({ success: false, error: 'Invalid file ID' });
      return;
    }

    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const callerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const token = String(
      req.header('X-Delete-Token') || (req.body && req.body.delete_token) || ''
    ).trim();

    const row = db
      .prepare('SELECT id, stored_name, delete_token, user_id, storage_provider FROM files WHERE id = ?')
      .get(fileId) as Pick<FileRow, 'id' | 'stored_name' | 'delete_token' | 'user_id' | 'storage_provider'> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const ownsBySession = Boolean(callerUserId && row.user_id && row.user_id === callerUserId);
    const ownsByToken = Boolean(token && timingSafeMatch(token, row.delete_token));

    if (!ownsBySession && !ownsByToken) {
      res.status(403).json({ success: false, error: 'Invalid deletion token or permissions' });
      return;
    }

    await removeStoredFile(row);
    await syncDbToSupabase();
    res.json({ success: true, message: 'File deleted successfully' });
  });

  app.patch('/api/file/:id', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).json({ success: false, error: 'Invalid file ID' });
      return;
    }

    const rawName = String(req.body?.name || '').trim();
    const newName = sanitizeFilename(rawName);
    if (!rawName || newName.length < 1) {
      res.status(400).json({ success: false, error: 'El nombre del archivo no puede estar vacío.' });
      return;
    }

    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const callerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = readGuestIdIfPresent(req);
    const token = String(
      req.header('X-Delete-Token') || (req.body && req.body.delete_token) || ''
    ).trim();

    const row = db
      .prepare('SELECT original_name, mime_type, delete_token, user_id, guest_id FROM files WHERE id = ?')
      .get(fileId) as Pick<FileRow, 'original_name' | 'mime_type' | 'delete_token' | 'user_id' | 'guest_id'> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const ownsBySession = Boolean(callerUserId && row.user_id && row.user_id === callerUserId);
    const ownsByGuest = Boolean(guestId && row.guest_id && row.guest_id === guestId);
    const ownsByToken = Boolean(token && timingSafeMatch(token, row.delete_token));

    if (!ownsBySession && !ownsByGuest && !ownsByToken) {
      res.status(403).json({ success: false, error: 'No tienes permiso para renombrar este archivo.' });
      return;
    }

    const updatedMime = guessMimeType(newName, row.mime_type);
    db.prepare('UPDATE files SET original_name = ?, mime_type = ? WHERE id = ?').run(
      newName,
      updatedMime,
      fileId
    );
    await syncDbToSupabase();

    res.json({
      success: true,
      id: fileId,
      original_name: newName,
      mime_type: updatedMime,
    });
  });

  // Shareable Folder / Collection Links
  app.post('/api/collections', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const rawTitle = String(req.body?.title || '').trim();
    const title = (rawTitle || 'Shared Collection').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
    const rawFileIds = Array.isArray(req.body?.file_ids) ? req.body.file_ids : [];
    const tokensMap = (req.body?.tokens && typeof req.body.tokens === 'object') ? req.body.tokens as Record<string, string> : {};

    const uniqueIds: string[] = Array.from(
      new Set<string>(
        rawFileIds
          .filter((id: unknown): id is string => typeof id === 'string' && VALID_ID_REGEX.test(id.trim()))
          .map((id: string) => id.trim())
      )
    ).slice(0, 100);

    if (uniqueIds.length === 0) {
      res.status(400).json({ success: false, error: 'Select at least one valid file.' });
      return;
    }

    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const ownerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = ownerUserId ? readGuestIdIfPresent(req) : getOrCreateGuestId(req, res);

    const validRows: FileRow[] = [];
    for (const fId of uniqueIds) {
      const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fId) as FileRow | undefined;
      if (!row || isFileExpired(row)) continue;
      const tokenMatch = Boolean(tokensMap[fId] && timingSafeMatch(String(tokensMap[fId]), row.delete_token));
      const userMatch = Boolean(ownerUserId && row.user_id && row.user_id === ownerUserId);
      const guestMatch = Boolean(guestId && row.guest_id && row.guest_id === guestId);
      if (tokenMatch || userMatch || guestMatch) {
        validRows.push(row);
      }
    }

    if (validRows.length === 0) {
      res.status(403).json({ success: false, error: 'No eligible files found for collection.' });
      return;
    }

    const collectionId = generateCollectionId();
    const deleteToken = crypto.randomBytes(24).toString('hex');
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO collections (id, title, created_at, user_id, guest_id, delete_token)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(collectionId, title, createdAt, ownerUserId, guestId, deleteToken);

    const insertItem = db.prepare(
      `INSERT INTO collection_files (collection_id, file_id, sort_order) VALUES (?, ?, ?)`
    );
    validRows.forEach((f, index) => {
      insertItem.run(collectionId, f.id, index);
    });

    const totalBytes = validRows.reduce((acc, f) => acc + (f.size_bytes || 0), 0);
    await syncDbToSupabase();

    res.json({
      success: true,
      collection: {
        id: collectionId,
        title,
        share_url: `/c/${collectionId}`,
        delete_token: deleteToken,
        created_at: createdAt,
        file_count: validRows.length,
        total_bytes: totalBytes,
      },
    });
  });

  app.get('/api/user/collections', async (req: Request, res: Response) => {
    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const ownerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = readGuestIdIfPresent(req);

    if (!ownerUserId && !guestId) {
      res.json({ success: true, collections: [] });
      return;
    }

    const rows = ownerUserId
      ? db
          .prepare(
            `SELECT c.id, c.title, c.created_at, c.delete_token,
                    COUNT(f.id) AS file_count,
                    COALESCE(SUM(f.size_bytes), 0) AS total_bytes
             FROM collections c
             LEFT JOIN collection_files cf ON cf.collection_id = c.id
             LEFT JOIN files f ON f.id = cf.file_id
             WHERE c.user_id = ?
             GROUP BY c.id
             ORDER BY c.created_at DESC`
          )
          .all(ownerUserId)
      : db
          .prepare(
            `SELECT c.id, c.title, c.created_at, c.delete_token,
                    COUNT(f.id) AS file_count,
                    COALESCE(SUM(f.size_bytes), 0) AS total_bytes
             FROM collections c
             LEFT JOIN collection_files cf ON cf.collection_id = c.id
             LEFT JOIN files f ON f.id = cf.file_id
             WHERE c.user_id IS NULL AND c.guest_id = ?
             GROUP BY c.id
             ORDER BY c.created_at DESC`
          )
          .all(guestId!);

    const collections = rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title),
      share_url: `/c/${String(r.id)}`,
      delete_token: String(r.delete_token || ''),
      created_at: String(r.created_at),
      file_count: Number(r.file_count || 0),
      total_bytes: Number(r.total_bytes || 0),
    }));

    res.json({ success: true, collections });
  });

  app.get('/api/collections/:id', (req: Request, res: Response) => {
    const collectionId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(collectionId)) {
      res.status(400).json({ success: false, error: 'Invalid collection ID' });
      return;
    }

    const col = db
      .prepare('SELECT id, title, created_at FROM collections WHERE id = ?')
      .get(collectionId) as { id: string; title: string; created_at: string } | undefined;

    if (!col) {
      res.status(404).json({ success: false, error: 'Collection not found' });
      return;
    }

    const rawFiles = db
      .prepare(
        `SELECT f.id, f.original_name, f.size_bytes, f.mime_type, f.upload_time, f.download_count,
                f.password_hash, f.expires_at
         FROM collection_files cf
         JOIN files f ON f.id = cf.file_id
         WHERE cf.collection_id = ?
         ORDER BY cf.sort_order ASC`
      )
      .all(collectionId) as unknown as Array<
      Pick<
        FileRow,
        | 'id'
        | 'original_name'
        | 'size_bytes'
        | 'mime_type'
        | 'upload_time'
        | 'download_count'
        | 'password_hash'
        | 'expires_at'
      >
    >;

    const files = rawFiles
      .filter((f) => !isFileExpired(f))
      .map((f) => ({
        id: f.id,
        original_name: f.original_name,
        size_bytes: f.size_bytes,
        mime_type: f.mime_type,
        upload_time: f.upload_time,
        download_count: f.download_count,
        requires_password: Boolean(f.password_hash),
        expires_at: f.expires_at || null,
      }));

    res.json({
      success: true,
      collection: {
        id: col.id,
        title: col.title,
        created_at: col.created_at,
        files,
      },
    });
  });

  app.delete('/api/collections/:id', express.json(), async (req: Request, res: Response) => {
    if (!isSameOriginOrCustomHeader(req)) {
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return;
    }

    const collectionId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(collectionId)) {
      res.status(400).json({ success: false, error: 'Invalid collection ID' });
      return;
    }

    const sessionUser = getSessionUser(req);
    const verifiedFirebaseUid = sessionUser ? null : await verifyFirebaseIdToken(req);
    const callerUserId = sessionUser ? sessionUser.id : verifiedFirebaseUid;
    const guestId = readGuestIdIfPresent(req);
    const token = String(req.header('X-Delete-Token') || (req.body && req.body.delete_token) || '').trim();

    const col = db
      .prepare('SELECT id, user_id, guest_id, delete_token FROM collections WHERE id = ?')
      .get(collectionId) as { id: string; user_id: string | null; guest_id: string | null; delete_token: string } | undefined;

    if (!col) {
      res.status(404).json({ success: false, error: 'Collection not found' });
      return;
    }

    const ownsBySession = Boolean(callerUserId && col.user_id && col.user_id === callerUserId);
    const ownsByGuest = Boolean(guestId && col.guest_id && col.guest_id === guestId);
    const ownsByToken = Boolean(token && timingSafeMatch(token, col.delete_token));

    if (!ownsBySession && !ownsByGuest && !ownsByToken) {
      res.status(403).json({ success: false, error: 'Unauthorized' });
      return;
    }

    db.prepare('DELETE FROM collection_files WHERE collection_id = ?').run(collectionId);
    db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
    await syncDbToSupabase();
    res.json({ success: true });
  });

  if (process.env.NODE_ENV !== 'production' && !IS_VERCEL) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!IS_VERCEL) {
    const distDir = path.resolve(BASE_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  return app;
}

if (!IS_VERCEL) {
  createApp()
    .then((app) => {
      const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`LettingWork server listening on http://0.0.0.0:${PORT}`);
      });

      const gracefulShutdown = async () => {
        try {
          await syncDbToSupabase();
        } finally {
          server.close(() => process.exit(0));
        }
      };

      process.on('SIGTERM', () => void gracefulShutdown());
      process.on('SIGINT', () => void gracefulShutdown());
    })
    .catch((err) => {
      console.error('Failed to start LettingWork server:', err);
      process.exit(1);
    });
}

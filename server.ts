import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const BASE_DIR = path.resolve(process.cwd());
const UPLOADS_DIR = path.resolve(BASE_DIR, 'uploads');
const DB_PATH = path.resolve(BASE_DIR, 'lettingwork.db');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB per upload
const GUEST_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB free guest tier
const REGISTERED_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB registered tier
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE_NAME = 'lw_session';
const GUEST_COOKIE_NAME = 'lw_guest';

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

const db = new DatabaseSync(DB_PATH);
db.exec(`
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
`);

try {
  db.exec(`ALTER TABLE files ADD COLUMN user_id TEXT;`);
} catch {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE files ADD COLUMN guest_id TEXT;`);
} catch {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN storage_tier TEXT NOT NULL DEFAULT 'free_10gb';`);
} catch {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN storage_limit_bytes INTEGER NOT NULL DEFAULT 10737418240;`);
} catch {
  // Column already exists
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
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

function generateFileId(): string {
  return `lw_${crypto.randomBytes(6).toString('hex')}`;
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

const SUPPORT_SYSTEM_INSTRUCTION = `Eres el asistente de soporte al usuario de LettingWork (https://lettingwork.onrender.com), una plataforma web de almacenamiento y compartición rápida de archivos en la nube.

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

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, status: 'operational', db: 'connected' });
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
        `SELECT id, original_name, size_bytes, mime_type, upload_time, download_count, delete_token
         FROM files WHERE user_id = ? ORDER BY upload_time DESC`
      )
      .all(user.id);

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

  app.get('/api/info/:id', (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).json({ success: false, error: 'Invalid file ID' });
      return;
    }

    const row = db
      .prepare(
        `SELECT id, original_name, size_bytes, mime_type, upload_time, download_count
         FROM files WHERE id = ?`
      )
      .get(fileId) as Omit<FileRow, 'stored_name' | 'delete_token' | 'user_id'> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found or deleted' });
      return;
    }

    res.json({ success: true, file: row });
  });

  app.get('/api/download/:id', (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).send('Invalid file ID');
      return;
    }

    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row) {
      res.status(404).send('File not found');
      return;
    }

    const diskPath = resolveUploadPath(row.stored_name);
    if (!diskPath || !fs.existsSync(diskPath)) {
      res.status(404).send('File unavailable on storage');
      return;
    }

    db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(fileId);

    const encodedName = encodeURIComponent(row.original_name);
    const asciiName = row.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
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
  app.get('/api/view/:id', (req: Request, res: Response) => {
    const fileId = String(req.params.id || '').trim();
    if (!VALID_ID_REGEX.test(fileId)) {
      res.status(400).send('Invalid file ID');
      return;
    }

    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row) {
      res.status(404).send('File not found');
      return;
    }

    const diskPath = resolveUploadPath(row.stored_name);
    if (!diskPath || !fs.existsSync(diskPath)) {
      res.status(404).send('File unavailable on storage');
      return;
    }

    const detectedMime = guessMimeType(row.original_name, row.mime_type);
    const contentType = isSafeInlineMime(detectedMime) ? detectedMime : 'application/octet-stream';
    const disposition = isSafeInlineMime(detectedMime) ? 'inline' : 'attachment';
    const encodedName = encodeURIComponent(row.original_name);
    const asciiName = row.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const stat = fs.statSync(diskPath);
    const total = stat.size;

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
    );

    const range = req.header('Range');
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
        writeStream.end(() => {
          const fileId = generateFileId();
          const deleteToken = crypto.randomBytes(24).toString('hex');
          const mimeType = guessMimeType(originalName, req.header('Content-Type') || 'application/octet-stream');

          db.prepare(
            `INSERT INTO files (id, original_name, stored_name, size_bytes, mime_type, delete_token, user_id, guest_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(fileId, originalName, storedName, bytesWritten, mimeType, deleteToken, ownerUserId, guestId);

          res.json({
            success: true,
            id: fileId,
            original_name: originalName,
            size_bytes: bytesWritten,
            mime_type: mimeType,
            share_url: `/f/${fileId}`,
            delete_token: deleteToken,
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

    uploadMiddleware.single('file')(req, res, (err) => {
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

      db.prepare(
        `INSERT INTO files (id, original_name, stored_name, size_bytes, mime_type, delete_token, user_id, guest_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(fileId, originalName, req.file.filename, req.file.size, mimeType, deleteToken, ownerUserId, guestId);

      res.json({
        success: true,
        id: fileId,
        original_name: originalName,
        size_bytes: req.file.size,
        mime_type: mimeType,
        share_url: `/f/${fileId}`,
        delete_token: deleteToken,
      });
    });
  });

  app.delete('/api/file/:id', express.json(), (req: Request, res: Response) => {
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
    const token = String(
      req.header('X-Delete-Token') || (req.body && req.body.delete_token) || ''
    ).trim();

    const row = db
      .prepare('SELECT stored_name, delete_token, user_id FROM files WHERE id = ?')
      .get(fileId) as Pick<FileRow, 'stored_name' | 'delete_token' | 'user_id'> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const ownsBySession = Boolean(sessionUser && row.user_id && row.user_id === sessionUser.id);
    const ownsByToken = Boolean(token && timingSafeMatch(token, row.delete_token));

    if (!ownsBySession && !ownsByToken) {
      res.status(403).json({ success: false, error: 'Invalid deletion token or permissions' });
      return;
    }

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    const diskPath = resolveUploadPath(row.stored_name);
    if (diskPath && fs.existsSync(diskPath)) {
      try {
        fs.unlinkSync(diskPath);
      } catch {
        // Ignore cleanup failure
      }
    }

    res.json({ success: true, message: 'File deleted successfully' });
  });

  app.patch('/api/file/:id', express.json(), (req: Request, res: Response) => {
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
    const token = String(
      req.header('X-Delete-Token') || (req.body && req.body.delete_token) || ''
    ).trim();

    const row = db
      .prepare('SELECT original_name, mime_type, delete_token, user_id FROM files WHERE id = ?')
      .get(fileId) as Pick<FileRow, 'original_name' | 'mime_type' | 'delete_token' | 'user_id'> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const ownsBySession = Boolean(sessionUser && row.user_id && row.user_id === sessionUser.id);
    const ownsByToken = Boolean(token && timingSafeMatch(token, row.delete_token));

    if (!ownsBySession && !ownsByToken) {
      res.status(403).json({ success: false, error: 'No tienes permiso para renombrar este archivo.' });
      return;
    }

    const updatedMime = guessMimeType(newName, row.mime_type);
    db.prepare('UPDATE files SET original_name = ?, mime_type = ? WHERE id = ?').run(
      newName,
      updatedMime,
      fileId
    );

    res.json({
      success: true,
      id: fileId,
      original_name: newName,
      mime_type: updatedMime,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(BASE_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LettingWork server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LettingWork server:', err);
  process.exit(1);
});

// Usuarios del dashboard — distintos de las API keys.
//
// Modelo:
//   - role: 'admin' → puede ver todos los tenants y gestionar usuarios
//   - role: 'client' → scope forzado a su tenantId (casi-admin de su tenant,
//     puede hacer todo dentro de él menos ver otros o gestionar usuarios)
//
// Storage: data/users.json. Passwords nunca se guardan en claro — scrypt
// con salt por usuario. scrypt es nativo de Node (cero deps nuevas) y
// expone parámetros que tunean costo CPU/memoria.
//
// Bootstrap: si users.json está vacío pero DASHBOARD_USER/PASS están
// configurados via env, el authMiddleware acepta esas credenciales como
// admin implícito (legacy fallback). Cuando se crea el primer admin
// desde la UI, users.json toma precedencia y el fallback deja de usarse.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from './state.js';

const USERS_FILE = path.join(DATA_ROOT, 'users.json');
const SCRYPT_N = 16384;  // 2^14 — balance entre seguridad y latencia en VPS
const SCRYPT_KEYLEN = 64;

let _cache = null;
let _writeQueue = Promise.resolve();

async function load() {
  if (_cache) return _cache;
  try {
    const buf = await fs.readFile(USERS_FILE, 'utf8');
    _cache = JSON.parse(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[users] load falló:', e.message);
    _cache = [];
  }
  return _cache;
}

async function persist() {
  _writeQueue = _writeQueue.then(async () => {
    try {
      await fs.mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await fs.writeFile(USERS_FILE, JSON.stringify(_cache, null, 2), 'utf8');
    } catch (e) {
      console.warn('[users] persist falló:', e.message);
    }
  });
  return _writeQueue;
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex'));
    });
  });
}

function normalizeUsername(s) {
  return String(s || '').trim().toLowerCase();
}

function validateRole(role) {
  if (role !== 'admin' && role !== 'client') throw new Error("role debe ser 'admin' o 'client'");
}

// Crea un usuario nuevo. role='client' requiere tenantId. Devuelve el
// usuario sin passHash. NO devuelve el password — el caller que lo generó
// debe mostrarlo al admin una vez.
export async function createUser({ username, password, role, tenantId }) {
  const u = normalizeUsername(username);
  if (!u) throw new Error('username requerido');
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('username inválido (3-32 chars: a-z 0-9 . _ -)');
  if (!password || password.length < 8) throw new Error('password debe tener al menos 8 caracteres');
  validateRole(role);
  if (role === 'client' && !tenantId) throw new Error('role=client requiere tenantId');

  await load();
  if (_cache.find((x) => x.username === u)) throw new Error(`usuario '${u}' ya existe`);

  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await hashPassword(password, salt);
  const entry = {
    username: u,
    passHash,
    salt,
    role,
    tenantId: role === 'admin' ? null : tenantId,
    createdAt: Date.now(),
    lastLoginAt: null,
    disabledAt: null,
  };
  _cache.push(entry);
  await persist();
  return publicView(entry);
}

export async function listUsers() {
  await load();
  return _cache.map(publicView);
}

export async function findUser(username) {
  await load();
  const u = normalizeUsername(username);
  return _cache.find((x) => x.username === u) || null;
}

// Verifica credenciales. Devuelve el usuario (vista pública) si OK y no
// está deshabilitado; null si user no existe o pass no coincide o disabled.
// Side effect: actualiza lastLoginAt al éxito.
export async function verifyCredentials(username, password) {
  const entry = await findUser(username);
  if (!entry || entry.disabledAt) return null;
  const expected = entry.passHash;
  const actual = await hashPassword(password, entry.salt);
  // Comparación tiempo-constante
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) return null;
  entry.lastLoginAt = Date.now();
  persist().catch(() => {});
  return publicView(entry);
}

// Cambia el password de un usuario (sin requerir el viejo — solo admin debería llamar esto).
export async function setPassword(username, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('password debe tener al menos 8 caracteres');
  await load();
  const u = normalizeUsername(username);
  const entry = _cache.find((x) => x.username === u);
  if (!entry) throw new Error(`usuario '${u}' no existe`);
  entry.salt = crypto.randomBytes(16).toString('hex');
  entry.passHash = await hashPassword(newPassword, entry.salt);
  await persist();
  return publicView(entry);
}

// Deshabilita un usuario (no lo borra — queda en log para forense).
// Hace que verifyCredentials devuelva null para él.
export async function disableUser(username) {
  await load();
  const u = normalizeUsername(username);
  const entry = _cache.find((x) => x.username === u);
  if (!entry) return false;
  if (entry.disabledAt) return true;
  entry.disabledAt = Date.now();
  await persist();
  return true;
}

// Re-habilita un usuario previamente deshabilitado.
export async function enableUser(username) {
  await load();
  const u = normalizeUsername(username);
  const entry = _cache.find((x) => x.username === u);
  if (!entry) return false;
  entry.disabledAt = null;
  await persist();
  return true;
}

// True si el archivo de usuarios todavía está vacío. Se usa para decidir
// si el fallback de DASHBOARD_USER/PASS sigue activo.
export async function hasAnyUsers() {
  await load();
  return _cache.length > 0;
}

// Genera un password aleatorio legible (sin caracteres ambiguos). El admin
// lo comparte con el cliente una vez por canal seguro.
export function generatePassword(length = 14) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function publicView(entry) {
  return {
    username: entry.username,
    role: entry.role,
    tenantId: entry.tenantId,
    createdAt: entry.createdAt,
    lastLoginAt: entry.lastLoginAt,
    disabledAt: entry.disabledAt,
  };
}

// ----------------- Cookie de sesión del dashboard -----------------
// Formato: base64(JSON({u, r, t, exp})).hmac
// - u: username
// - r: role ('admin' | 'client')
// - t: tenantId (null para admin)
// - exp: epoch ms de expiración

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, mismo TTL que embed

function getSecret() {
  return process.env.SESSION_SECRET || process.env.GHL_SHARED_SECRET || 'dev';
}

export function signDashboardSession({ username, role, tenantId, ttlMs = SESSION_TTL_MS }) {
  const payload = { u: username, r: role, t: tenantId || null, exp: Date.now() + ttlMs };
  const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(value).digest('hex').slice(0, 32);
  return `${value}.${sig}`;
}

export function verifyDashboardSession(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const idx = cookie.lastIndexOf('.');
  if (idx < 0) return null;
  const value = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(value).digest('hex').slice(0, 32);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return { username: payload.u, role: payload.r, tenantId: payload.t };
}

export const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

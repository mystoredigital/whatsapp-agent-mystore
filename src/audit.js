// Append-only log de acciones del operador en el dashboard.
// Una línea JSON por evento (JSONL) en data/audit.jsonl. Rotación por tamaño:
// al pasar AUDIT_MAX_BYTES se renombra a audit-YYYYMMDD-HHMMSS.jsonl y se mantienen
// los últimos AUDIT_MAX_FILES archivos rotados.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './state.js';

const AUDIT_FILE = path.join(DATA_ROOT, 'audit.jsonl');
const AUDIT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const AUDIT_MAX_FILES = 7;

let _writeQueue = Promise.resolve();

async function ensureDataDir() {
  await fs.mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
}

async function rotateIfNeeded() {
  try {
    const stat = await fs.stat(AUDIT_FILE);
    if (stat.size < AUDIT_MAX_BYTES) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    const rotated = path.join(DATA_ROOT, `audit-${ts}.jsonl`);
    await fs.rename(AUDIT_FILE, rotated);
    // Limpia archivos rotados más antiguos
    const entries = await fs.readdir(DATA_ROOT);
    const rotatedFiles = entries
      .filter((n) => /^audit-\d{8}T\d{6}\.jsonl$/.test(n))
      .sort()
      .reverse();
    for (const old of rotatedFiles.slice(AUDIT_MAX_FILES)) {
      await fs.unlink(path.join(DATA_ROOT, old)).catch(() => {});
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[audit] rotate falló:', e.message);
  }
}

// Resuelve quién hizo la acción a partir del req. Embed cookie > Basic Auth > 'system'.
export function actorFrom(req) {
  if (!req) return 'system';
  if (req.embedUser?.email) return `embed:${req.embedUser.email}`;
  if (req.embedLocationId) return `embed:${req.embedLocationId}`;
  const header = req.headers?.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const user = decoded.split(':')[0];
      if (user) return user;
    } catch {}
  }
  return 'anonymous';
}

// Registra una acción. Fire-and-forget en los handlers (no bloquea la response).
export function logAudit(entry) {
  const line = JSON.stringify({
    ts: Date.now(),
    tenantId: entry.tenantId || null,
    actor: entry.actor || 'system',
    type: entry.type,
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.meta ? { meta: entry.meta } : {}),
  }) + '\n';

  _writeQueue = _writeQueue.then(async () => {
    try {
      await ensureDataDir();
      await rotateIfNeeded();
      await fs.appendFile(AUDIT_FILE, line, 'utf8');
    } catch (e) {
      console.warn('[audit] append falló:', e.message);
    }
  });
  return _writeQueue;
}

// Lee las últimas N entries con filtros opcionales. Lee solo el archivo actual
// (los rotados quedan archivados pero no se exponen — son para forense, no UI).
export async function listAudit({ tenantId, type, since, limit = 200 } = {}) {
  try {
    const buf = await fs.readFile(AUDIT_FILE, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    const out = [];
    // Recorremos de atrás hacia adelante para devolver lo más reciente primero
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (tenantId && e.tenantId !== tenantId) continue;
        if (type && e.type !== type) continue;
        if (since && e.ts < since) continue;
        out.push(e);
      } catch {}
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

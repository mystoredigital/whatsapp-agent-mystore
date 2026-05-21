// Webhooks salientes: notifica a URLs registradas cuando ocurren eventos
// (message.received, message.sent, message.blocked, connection.changed, mode.changed).
//
// Cada delivery va con header X-Webhook-Signature: sha256=<hex> donde
// hex = HMAC_SHA256(secret, raw_json_body). El receptor recalcula y compara
// con timingSafeEqual para validar autenticidad.
//
// Storage: data/webhooks.json — array de {id, tenantId, url, events[], secret,
// createdAt, lastDeliveryAt, lastStatus, lastError, revokedAt}.
// El secret se guarda en claro (necesario para firmar cada delivery, no es un
// password). Para gestionarlo: solo Basic Auth o embed cookie (igual que keys).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from './state.js';

const WEBHOOKS_FILE = path.join(DATA_ROOT, 'webhooks.json');
const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2000, 8000]; // dos reintentos: 2s y 8s tras el primer fallo

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.blocked',
  'connection.changed',
  'mode.changed',
];

let _cache = null;
let _writeQueue = Promise.resolve();

async function load() {
  if (_cache) return _cache;
  try {
    const buf = await fs.readFile(WEBHOOKS_FILE, 'utf8');
    _cache = JSON.parse(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[webhooks] load falló:', e.message);
    _cache = [];
  }
  return _cache;
}

async function persist() {
  _writeQueue = _writeQueue.then(async () => {
    try {
      await fs.mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await fs.writeFile(WEBHOOKS_FILE, JSON.stringify(_cache, null, 2), 'utf8');
    } catch (e) {
      console.warn('[webhooks] persist falló:', e.message);
    }
  });
  return _writeQueue;
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function createWebhook({ tenantId, url, events }) {
  if (!tenantId) throw new Error('tenantId requerido');
  if (!url || !/^https?:\/\//.test(url)) throw new Error('url debe empezar con http:// o https://');
  if (!Array.isArray(events) || !events.length) throw new Error('events[] requerido');
  const unknown = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (unknown.length) throw new Error(`eventos desconocidos: ${unknown.join(', ')}`);
  await load();
  const id = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const entry = {
    id,
    tenantId,
    url,
    events,
    secret,
    createdAt: Date.now(),
    lastDeliveryAt: null,
    lastStatus: null,
    lastError: null,
    revokedAt: null,
  };
  _cache.push(entry);
  await persist();
  return { ...entry };
}

export async function listWebhooks({ tenantId } = {}) {
  await load();
  return _cache
    .filter((w) => !tenantId || w.tenantId === tenantId)
    .map(({ secret, ...pub }) => pub); // no exponemos el secret en list
}

// Devuelve incluyendo el secret. Solo para mostrar al crear (UI lo enseña una vez).
export async function getWebhook(id) {
  await load();
  return _cache.find((w) => w.id === id) || null;
}

export async function revokeWebhook(id) {
  await load();
  const entry = _cache.find((w) => w.id === id);
  if (!entry) return false;
  if (entry.revokedAt) return true;
  entry.revokedAt = Date.now();
  await persist();
  return true;
}

// Envia el evento a TODOS los webhooks del tenant que esten suscritos a `event`
// y no revocados. Fire-and-forget; los errores se loggean y se reflejan en
// lastStatus/lastError del registro. No bloquea al caller.
export function dispatch(tenantId, event, payload, { onFailure } = {}) {
  if (!tenantId || !WEBHOOK_EVENTS.includes(event)) return;
  // Carga sin await — si _cache aun no esta, se inicializa la primera vez por load().
  load().then((all) => {
    const targets = all.filter(
      (w) => w.tenantId === tenantId && !w.revokedAt && w.events.includes(event),
    );
    for (const w of targets) {
      deliver(w, event, payload, 0).catch((e) => {
        console.warn(`[webhooks] dispatch ${w.id} fatal: ${e.message}`);
        onFailure?.({ webhookId: w.id, event, error: e.message });
      });
    }
  });
}

async function deliver(webhook, event, payload, attempt) {
  const body = JSON.stringify({
    event,
    tenantId: webhook.tenantId,
    deliveredAt: Date.now(),
    attempt,
    payload,
  });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'whatsapp-agent-mystore-webhooks/1.0',
    'X-Webhook-Id': webhook.id,
    'X-Webhook-Event': event,
    'X-Webhook-Signature': sign(webhook.secret, body),
    'X-Webhook-Attempt': String(attempt),
  };
  try {
    const resp = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    webhook.lastDeliveryAt = Date.now();
    webhook.lastStatus = resp.status;
    webhook.lastError = resp.ok ? null : `HTTP ${resp.status}`;
    persist().catch(() => {});
    if (!resp.ok && attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(webhook, event, payload, attempt + 1).catch(() => {}), RETRY_DELAYS_MS[attempt]);
    }
  } catch (e) {
    webhook.lastDeliveryAt = Date.now();
    webhook.lastStatus = 0;
    webhook.lastError = e.message;
    persist().catch(() => {});
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(webhook, event, payload, attempt + 1).catch(() => {}), RETRY_DELAYS_MS[attempt]);
    }
  }
}

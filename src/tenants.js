import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_ROOT, TenantStore, migrateLegacyIfNeeded } from './state.js';
import { WhatsAppSession } from './whatsapp.js';

class TenantRegistry extends EventEmitter {
  constructor() {
    super();
    this.tenants = new Map();
    this.sessions = new Map();
  }

  async bootstrap() {
    await fs.mkdir(DATA_ROOT, { recursive: true });
    await migrateLegacyIfNeeded();

    // Asegurar tenant _local siempre
    if (!fsSync.existsSync(path.join(DATA_ROOT, '_local'))) {
      await fs.mkdir(path.join(DATA_ROOT, '_local'), { recursive: true });
    }

    const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // _agencies guarda tokens de Agency, no es un tenant
      if (e.name === '_agencies') continue;
      await this.load(e.name);
    }

    // Validaciones post-boot — gritar fuerte si una integración GHL existente
    // queda inservible por una env var faltante (en vez de fallar silenciosamente
    // al primer mensaje real).
    const hasGhlTenant = Array.from(this.tenants.values()).some((t) => t.ghl?.accessToken);
    if (hasGhlTenant && !process.env.GHL_CONVERSATION_PROVIDER_ID) {
      console.warn('[bootstrap] ⚠️ Hay tenants con GHL conectado pero GHL_CONVERSATION_PROVIDER_ID no está configurado — el mirroring a GHL Conversations no funcionará');
    }
    if (hasGhlTenant && !process.env.GHL_WEBHOOK_PUBLIC_KEY) {
      console.warn('[bootstrap] ⚠️ GHL_WEBHOOK_PUBLIC_KEY no configurado — los webhooks de eventos (POST /webhooks/ghl) se aceptan sin firma');
    }
  }

  async load(tenantId) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = new TenantStore(tenantId);
    await store.load();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);

    const session = new WhatsAppSession(store);
    this.sessions.set(tenantId, session);
    session.start().catch((e) => console.error(`[tenant ${tenantId}] start fallo:`, e.message));

    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  async create(tenantId, meta = {}) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = new TenantStore(tenantId, meta);
    await store.load();
    await store.persistMeta();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);

    const session = new WhatsAppSession(store);
    this.sessions.set(tenantId, session);
    session.start().catch((e) => console.error(`[tenant ${tenantId}] start fallo:`, e.message));

    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  get(tenantId) {
    return this.tenants.get(tenantId);
  }

  session(tenantId) {
    return this.sessions.get(tenantId);
  }

  list() {
    return Array.from(this.tenants.values()).map((t) => t.snapshot());
  }

  _wireEvents(store) {
    for (const ev of ['message', 'mode', 'config', 'connection', 'metrics']) {
      store.on(ev, (payload) => this.emit(ev, payload));
    }
  }
}

export const tenants = new TenantRegistry();

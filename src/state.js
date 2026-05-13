import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const DATA_ROOT = path.resolve('./data');

const DEFAULT_PROMPT = `Eres el agente de WhatsApp de ${process.env.BUSINESS_NAME || 'My Store Digital'}.

NEGOCIO: ${process.env.BUSINESS_DESCRIPTION || 'Agencia de automatización con IA.'}

TU ROL:
- Responder consultas con claridad, en español, tono cercano y profesional.
- Calificar al lead (qué necesita, presupuesto aproximado, urgencia).
- Si el cliente quiere reunirse, usa la herramienta list_availability para ver huecos libres y propone 2-3 opciones; luego usa book_appointment para confirmar.
- Si no sabes algo, dilo y ofrece que un humano lo conteste.

REGLAS:
- Mensajes cortos (máx 3-4 líneas), tipo chat de WhatsApp.
- No inventes precios. Si preguntan, indica que un humano confirmará el detalle.
- Zona horaria: ${process.env.TIMEZONE || 'America/Guayaquil'}.`;

export class TenantStore extends EventEmitter {
  constructor(tenantId, meta = {}) {
    super();
    this.tenantId = tenantId;
    this.dir = path.join(DATA_ROOT, tenantId);
    this.authDir = path.join(this.dir, 'auth_baileys');
    this.convFile = path.join(this.dir, 'conversations.json');
    this.configFile = path.join(this.dir, 'config.json');
    this.metaFile = path.join(this.dir, 'meta.json');
    this.tokensFile = path.join(this.dir, 'tokens.json');
    this.contactsFile = path.join(this.dir, 'contacts.json');

    this.conversations = new Map();
    this.config = { systemPrompt: DEFAULT_PROMPT, aiEnabled: true };
    this.connection = { state: 'disconnected', qr: null };
    this.meta = { tenantId, kind: meta.kind || 'local', ...meta };
    this.ghl = null;
    this.jidByContactId = new Map(); // contactId GHL → jid WhatsApp
    this.contactIdByJid = new Map();
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.convFile, 'utf8');
      let dirty = false;
      for (const [jid, conv] of Object.entries(JSON.parse(raw))) {
        if (conv?.name && jid.endsWith('@lid') && conv.name === jid.split('@')[0]) {
          delete conv.name;
          dirty = true;
        }
        this.conversations.set(jid, conv);
      }
      if (dirty) this.persistConversations().catch(() => {});
    } catch {}
    try {
      this.config = { ...this.config, ...JSON.parse(await fs.readFile(this.configFile, 'utf8')) };
    } catch {}
    try {
      this.meta = { ...this.meta, ...JSON.parse(await fs.readFile(this.metaFile, 'utf8')) };
    } catch {}
    try {
      this.ghl = JSON.parse(await fs.readFile(this.tokensFile, 'utf8'));
    } catch {}
    try {
      const map = JSON.parse(await fs.readFile(this.contactsFile, 'utf8'));
      for (const [contactId, jid] of Object.entries(map)) {
        this.jidByContactId.set(contactId, jid);
        this.contactIdByJid.set(jid, contactId);
      }
    } catch {}
  }

  linkContact(contactId, jid) {
    if (!contactId || !jid) return;
    this.jidByContactId.set(contactId, jid);
    this.contactIdByJid.set(jid, contactId);
    fs.writeFile(this.contactsFile, JSON.stringify(Object.fromEntries(this.jidByContactId), null, 2)).catch(() => {});
  }

  getJidByContactId(contactId) {
    return this.jidByContactId.get(contactId);
  }

  getContactIdByJid(jid) {
    return this.contactIdByJid.get(jid);
  }

  async persistConversations() {
    await fs.writeFile(this.convFile, JSON.stringify(Object.fromEntries(this.conversations), null, 2));
  }
  async persistConfig() {
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2));
  }
  async persistMeta() {
    await fs.writeFile(this.metaFile, JSON.stringify(this.meta, null, 2));
  }
  async persistTokens() {
    if (!this.ghl) return;
    await fs.writeFile(this.tokensFile, JSON.stringify(this.ghl, null, 2));
  }

  getOrCreateConversation(jid, name) {
    if (!this.conversations.has(jid)) {
      const isGroup = jid.endsWith('@g.us');
      const fallback = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
      this.conversations.set(jid, {
        jid, name: name || fallback,
        isGroup,
        // Grupos arrancan en modo humano para evitar que la IA conteste a todo en
        // chats grupales. El operador puede flipear a IA per-grupo si quiere.
        mode: isGroup ? 'human' : 'ai',
        messages: [], updatedAt: Date.now(),
      });
    } else if (name && !this.conversations.get(jid).name) {
      this.conversations.get(jid).name = name;
    }
    return this.conversations.get(jid);
  }

  setGroupName(jid, groupName) {
    const conv = this.conversations.get(jid);
    if (!conv) return;
    if (conv.name !== groupName) {
      conv.name = groupName;
      this.persistConversations().catch(() => {});
    }
  }

  addMessage(jid, msg, name) {
    const conv = this.getOrCreateConversation(jid, name);
    conv.messages.push({ ...msg, ts: msg.ts || Date.now() });
    if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
    conv.updatedAt = Date.now();
    this.persistConversations().catch(() => {});
    this.emit('message', { tenantId: this.tenantId, jid, message: msg, conversation: conv });
    return conv;
  }

  setMode(jid, mode) {
    const conv = this.getOrCreateConversation(jid);
    conv.mode = mode === 'human' ? 'human' : 'ai';
    this.persistConversations().catch(() => {});
    this.emit('mode', { tenantId: this.tenantId, jid, mode: conv.mode });
    return conv;
  }

  setPrompt(prompt) {
    this.config.systemPrompt = prompt;
    this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  setAiEnabled(enabled) {
    this.config.aiEnabled = !!enabled;
    this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  setConnection(state, qr = null) {
    this.connection = { state, qr };
    this.emit('connection', { tenantId: this.tenantId, connection: this.connection });
  }

  setGhlTokens(tokens) {
    this.ghl = { ...(this.ghl || {}), ...tokens };
    this.persistTokens().catch(() => {});
  }

  snapshot() {
    return {
      tenantId: this.tenantId,
      meta: this.meta,
      conversations: Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      config: this.config,
      connection: this.connection,
      ghl: this.ghl ? {
        locationId: this.ghl.locationId,
        companyId: this.ghl.companyId,
        hasToken: true,
        conversationProviderId: this.ghl.conversationProviderId || null,
      } : null,
    };
  }
}

// Migra layout legacy (data/auth_baileys, data/conversations.json) a data/_local/
export async function migrateLegacyIfNeeded() {
  const legacyAuth = path.join(DATA_ROOT, 'auth_baileys');
  const legacyConv = path.join(DATA_ROOT, 'conversations.json');
  const legacyConfig = path.join(DATA_ROOT, 'config.json');
  const localDir = path.join(DATA_ROOT, '_local');

  if (!fsSync.existsSync(legacyAuth) && !fsSync.existsSync(legacyConv)) return false;
  if (fsSync.existsSync(localDir)) return false;

  await fs.mkdir(localDir, { recursive: true });
  if (fsSync.existsSync(legacyAuth)) await fs.rename(legacyAuth, path.join(localDir, 'auth_baileys'));
  if (fsSync.existsSync(legacyConv)) await fs.rename(legacyConv, path.join(localDir, 'conversations.json'));
  if (fsSync.existsSync(legacyConfig)) await fs.rename(legacyConfig, path.join(localDir, 'config.json'));
  console.log('[migration] data/ legacy → data/_local/');
  return true;
}

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'node:fs/promises';
import { generateReply } from './ai.js';
import { GHLClient } from './ghl/client.js';
import { resolvePhoneAndJid } from './ghl/phone.js';

const logger = pino({ level: 'warn' });

// Anti-ban / human-like behavior config (overridable via env)
const HUMAN_DELAY_MIN_MS = Number(process.env.HUMAN_DELAY_MIN_MS ?? 3000);
const HUMAN_DELAY_MAX_MS = Number(process.env.HUMAN_DELAY_MAX_MS ?? 12000);
const PER_CHAT_COOLDOWN_MS = Number(process.env.PER_CHAT_COOLDOWN_MS ?? 4000);
const GLOBAL_MAX_PER_MIN = Number(process.env.GLOBAL_MAX_PER_MIN ?? 20);
const QUIET_HOURS_START = Number(process.env.QUIET_HOURS_START ?? 23);
const QUIET_HOURS_END = Number(process.env.QUIET_HOURS_END ?? 7);
const QUIET_HOURS_TZ = process.env.TIMEZONE || 'America/Guayaquil';
const NEW_CONTACT_REQUIRES_HUMAN = (process.env.NEW_CONTACT_REQUIRES_HUMAN || 'false') === 'true';

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jitter(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function isInQuietHours(now = new Date()) {
  if (QUIET_HOURS_START === QUIET_HOURS_END) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: QUIET_HOURS_TZ }).format(now)
  );
  return QUIET_HOURS_START < QUIET_HOURS_END
    ? hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END
    : hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

class RateLimiter {
  constructor() {
    this._lastByJid = new Map();
    this._window = [];
  }
  check(jid) {
    const now = Date.now();
    const last = this._lastByJid.get(jid) || 0;
    if (now - last < PER_CHAT_COOLDOWN_MS) return { ok: false, reason: 'per-chat cooldown' };
    this._window = this._window.filter((t) => now - t < 60_000);
    if (this._window.length >= GLOBAL_MAX_PER_MIN) return { ok: false, reason: 'global rate limit' };
    return { ok: true };
  }
  record(jid) {
    const now = Date.now();
    this._lastByJid.set(jid, now);
    this._window.push(now);
  }
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  );
}

export class WhatsAppSession {
  constructor(store) {
    this.store = store;
    this.sock = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._outboundSeen = new Set();
    this._sentByUs = new Set();
    this._limiter = new RateLimiter();
    this.metrics = {
      sent: 0,
      skippedRateLimit: 0,
      skippedQuietHours: 0,
      skippedGreylist: 0,
      skippedAiDisabled: 0,
      reconnects: 0,
    };
  }

  getMetrics() {
    return { ...this.metrics };
  }

  _bump(key) {
    if (!(key in this.metrics)) return;
    this.metrics[key]++;
    this.store.emit('metrics', { tenantId: this.store.tenantId, metrics: this.getMetrics() });
  }

  _rememberSentByUs(messageId) {
    if (!messageId) return;
    this._sentByUs.add(messageId);
    setTimeout(() => this._sentByUs.delete(messageId), 5 * 60_000);
  }

  // Marca un messageId como "ya enviado por nosotros" para evitar loops cuando
  // GHL devuelve el outbound webhook de un mensaje que originamos.
  markOutboundSent(messageId) {
    if (!messageId) return;
    this._outboundSeen.add(messageId);
    setTimeout(() => this._outboundSeen.delete(messageId), 60_000);
  }
  isOutboundSeen(messageId) {
    return messageId ? this._outboundSeen.has(messageId) : false;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.store.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '120.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        this.store.setConnection('qr', dataUrl);
      }
      if (connection === 'open') {
        this._reconnectAttempt = 0;
        this.store.setConnection('connected');
        console.log(`[wa:${this.store.tenantId}] conectado`);
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error).output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.store.setConnection(loggedOut ? 'logged_out' : 'disconnected');
        if (!loggedOut) {
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this._reconnectAttempt);
          this._reconnectAttempt = Math.min(this._reconnectAttempt + 1, 10);
          console.log(`[wa:${this.store.tenantId}] cerrado code=${code} reconnect en ${delay}ms`);
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this.start().catch(console.error), delay);
          this._bump('reconnects');
        } else {
          console.log(`[wa:${this.store.tenantId}] cerrado code=${code} (loggedOut, no reconnect)`);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        await this._handleIncoming(m).catch((e) =>
          console.error(`[wa:${this.store.tenantId}] handle`, e.message)
        );
      }
    });

    return this.sock;
  }

  async _handleIncoming(msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const text = extractText(msg.message);
    if (!text.trim()) return;

    // Mensaje enviado desde otro dispositivo vinculado (p.ej. el celular del operador):
    // lo registramos como reply manual y forzamos modo humano para que la IA no siga respondiendo.
    if (msg.key.fromMe) {
      if (this._sentByUs.has(msg.key.id)) return; // echo de algo que enviamos nosotros
      this.store.addMessage(jid, { role: 'assistant', text, manual: true });
      const current = this.store.getOrCreateConversation(jid);
      if (current.mode !== 'human') this.store.setMode(jid, 'human');
      return;
    }

    // Resolver teléfono real (manejando LID mode)
    const resolved = resolvePhoneAndJid(msg);

    const name = msg.pushName || resolved?.phone || undefined;
    const conv = this.store.addMessage(jid, { role: 'user', text }, name);

    // Mirror a GHL si el tenant está conectado Y tenemos teléfono real
    if (resolved?.phone) {
      this._pushInboundToGHL({ jid, phone: resolved.phone, text, name, altId: msg.key.id }).catch((e) => {
        console.error(`[ghl:${this.store.tenantId}] push inbound`, e.message);
        this.store.addMessage(jid, { role: 'system', text: `⚠️ Push GHL falló: ${e.message}` });
      });
    } else if (this.store.ghl?.accessToken) {
      console.warn(`[wa:${this.store.tenantId}] jid sin teléfono resoluble: ${jid}`);
    }

    if (conv.mode !== 'ai') return;

    // Kill switch global: si el operador pausó la IA para todo el tenant, saltar
    // sin tocar el modo per-chat (cuando se reactive, el flujo vuelve a su estado).
    if (this.store.config.aiEnabled === false) {
      console.log(`[wa:${this.store.tenantId}] IA pausada globalmente, skip ${jid}`);
      this._bump('skippedAiDisabled');
      return;
    }

    // Greylist: primer mensaje de un contacto nuevo → operador humano lo atiende.
    if (NEW_CONTACT_REQUIRES_HUMAN) {
      const priorUserMsgs = conv.messages.filter((m) => m.role === 'user').length;
      if (priorUserMsgs <= 1) {
        this.store.setMode(jid, 'human');
        console.log(`[wa:${this.store.tenantId}] greylist: contacto nuevo ${jid} → modo humano`);
        this._bump('skippedGreylist');
        return;
      }
    }

    if (isInQuietHours()) {
      console.log(`[wa:${this.store.tenantId}] quiet hours: skip auto-reply para ${jid}`);
      this._bump('skippedQuietHours');
      return;
    }

    const limit = this._limiter.check(jid);
    if (!limit.ok) {
      console.warn(`[wa:${this.store.tenantId}] rate limit (${limit.reason}): skip ${jid}`);
      this._bump('skippedRateLimit');
      return;
    }

    try {
      const startedAt = Date.now();
      await this.sock.sendPresenceUpdate('composing', jid);
      const reply = await generateReply({
        systemPrompt: this.store.config.systemPrompt,
        history: conv.messages,
      });
      if (reply && reply.trim()) {
        const target = jitter(HUMAN_DELAY_MIN_MS, HUMAN_DELAY_MAX_MS);
        const elapsed = Date.now() - startedAt;
        if (elapsed < target) await sleep(target - elapsed);
        const sent = await this.sock.sendMessage(jid, { text: reply });
        this._rememberSentByUs(sent?.key?.id);
        this._limiter.record(jid);
        this._bump('sent');
        this.store.addMessage(jid, { role: 'assistant', text: reply });
        // Mirror la respuesta de IA a GHL como inbound del lado business
        if (resolved?.phone) {
          this._pushAIReplyToGHL({ jid, phone: resolved.phone, text: reply }).catch((e) => {
            console.error(`[ghl:${this.store.tenantId}] push reply`, e.message);
            this.store.addMessage(jid, { role: 'system', text: `⚠️ Push reply GHL falló: ${e.message}` });
          });
        }
      }
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
      console.error(`[ai:${this.store.tenantId}]`, e.message);
      this.store.addMessage(jid, { role: 'system', text: `Error IA: ${e.message}` });
    }
  }

  async _pushInboundToGHL({ jid, phone, text, name, altId }) {
    if (!this.store.ghl?.accessToken) return;
    const providerId = process.env.GHL_CONVERSATION_PROVIDER_ID;
    if (!providerId) return;

    const ghl = new GHLClient(this.store);
    const contact = await ghl.findOrCreateContact({ phone, name });
    const contactId = contact?.id;
    if (!contactId) {
      console.warn(`[ghl:${this.store.tenantId}] sin contactId para ${phone}`);
      return;
    }
    // Mapeo crítico: contactId → jid para enrutar outbound de GHL al JID correcto (especialmente con LID)
    this.store.linkContact(contactId, jid);

    await ghl.sendInboundMessage({
      contactId,
      message: text,
      conversationProviderId: providerId,
      altId: `wa:${altId}`,
    });
    console.log(`[ghl:${this.store.tenantId}] inbound → contact ${contactId} (jid=${jid})`);
  }

  async _pushAIReplyToGHL({ jid, phone, text }) {
    if (!this.store.ghl?.accessToken) return;
    const providerId = process.env.GHL_CONVERSATION_PROVIDER_ID;
    if (!providerId) return;

    const ghl = new GHLClient(this.store);
    // Reutiliza el contactId mapeado si existe
    const existingContactId = this.store.getContactIdByJid(jid);
    let contactId = existingContactId;
    if (!contactId) {
      const contact = await ghl.findOrCreateContact({ phone });
      contactId = contact?.id;
      if (contactId) this.store.linkContact(contactId, jid);
    }
    if (!contactId) return;
    await ghl.sendInboundMessage({
      contactId,
      message: `🤖 ${text}`,
      conversationProviderId: providerId,
    });
  }

  async send(jid, text, opts = {}) {
    if (!this.sock) throw new Error('WhatsApp no conectado');
    const sent = await this.sock.sendMessage(jid, { text });
    this._rememberSentByUs(sent?.key?.id);
    this.store.addMessage(jid, { role: 'assistant', text, manual: true });
    if (opts.skipGhlMirror) return;
    // Si vino desde GHL outbound webhook, ya está en GHL → skip mirror para evitar duplicado
  }

  // Cierra sock, borra creds Baileys y reinicia para forzar nuevo QR.
  // Necesario cuando se removió el dispositivo desde el celular (code=401 / loggedOut)
  // — el authDir conserva creds inválidas que Baileys no recupera solo.
  async relink() {
    clearTimeout(this._reconnectTimer);
    this._reconnectAttempt = 0;
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
    await fs.rm(this.store.authDir, { recursive: true, force: true });
    this.store.setConnection('disconnected');
    console.log(`[wa:${this.store.tenantId}] relink: authDir borrado, reiniciando…`);
    return this.start();
  }
}

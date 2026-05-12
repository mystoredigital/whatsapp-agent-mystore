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
    this._outboundSeen = new Set();
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
      browser: [`MyStore Agent · ${this.store.tenantId}`, 'Chrome', '1.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        this.store.setConnection('qr', dataUrl);
      }
      if (connection === 'open') {
        this.store.setConnection('connected');
        console.log(`[wa:${this.store.tenantId}] conectado`);
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error).output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.store.setConnection(loggedOut ? 'logged_out' : 'disconnected');
        console.log(`[wa:${this.store.tenantId}] cerrado code=${code} reconnect=${!loggedOut}`);
        if (!loggedOut) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this.start().catch(console.error), 3000);
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
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const text = extractText(msg.message);
    if (!text.trim()) return;

    const name = msg.pushName || undefined;
    const conv = this.store.addMessage(jid, { role: 'user', text }, name);

    // Resolver teléfono real (manejando LID mode)
    const resolved = resolvePhoneAndJid(msg);

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

    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      const reply = await generateReply({
        systemPrompt: this.store.config.systemPrompt,
        history: conv.messages,
      });
      if (reply && reply.trim()) {
        await this.sock.sendMessage(jid, { text: reply });
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
    await this.sock.sendMessage(jid, { text });
    this.store.addMessage(jid, { role: 'assistant', text, manual: true });
    if (opts.skipGhlMirror) return;
    // Si vino desde GHL outbound webhook, ya está en GHL → skip mirror para evitar duplicado
  }

  // Cierra sock, borra creds Baileys y reinicia para forzar nuevo QR.
  // Necesario cuando se removió el dispositivo desde el celular (code=401 / loggedOut)
  // — el authDir conserva creds inválidas que Baileys no recupera solo.
  async relink() {
    clearTimeout(this._reconnectTimer);
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
    await fs.rm(this.store.authDir, { recursive: true, force: true });
    this.store.setConnection('disconnected');
    console.log(`[wa:${this.store.tenantId}] relink: authDir borrado, reiniciando…`);
    return this.start();
  }
}

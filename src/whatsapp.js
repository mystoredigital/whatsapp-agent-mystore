import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import path from 'node:path';
import { store } from './state.js';
import { generateReply } from './ai.js';

const AUTH_DIR = path.resolve('./data/auth_baileys');
const logger = pino({ level: 'warn' });

let sock = null;

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

async function handleIncoming(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  const text = extractText(msg.message);
  if (!text.trim()) return;

  const name = msg.pushName || undefined;
  const conv = store.addMessage(jid, { role: 'user', text }, name);

  if (conv.mode !== 'ai') return;

  try {
    await sock.sendPresenceUpdate('composing', jid);
    const reply = await generateReply({
      systemPrompt: store.config.systemPrompt,
      history: conv.messages,
    });
    if (reply && reply.trim()) {
      await sock.sendMessage(jid, { text: reply });
      store.addMessage(jid, { role: 'assistant', text: reply });
    }
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    console.error('[ai] error', e.message);
    store.addMessage(jid, { role: 'system', text: `Error IA: ${e.message}` });
  }
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['MyStore Agent', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr);
      store.setConnection('qr', dataUrl);
      console.log('[wa] QR generado — escanéalo desde el dashboard');
    }
    if (connection === 'open') {
      store.setConnection('connected');
      console.log('[wa] conectado');
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error).output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      store.setConnection(loggedOut ? 'logged_out' : 'disconnected');
      console.log('[wa] cerrado', code, 'reconectar:', !loggedOut);
      if (!loggedOut) setTimeout(() => startWhatsApp().catch(console.error), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      await handleIncoming(m).catch((e) => console.error('[wa] handle', e));
    }
  });

  return sock;
}

export async function sendManual(jid, text) {
  if (!sock) throw new Error('WhatsApp no conectado');
  await sock.sendMessage(jid, { text });
  store.addMessage(jid, { role: 'assistant', text, manual: true });
}

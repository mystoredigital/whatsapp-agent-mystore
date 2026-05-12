import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATA_DIR = path.resolve('./data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

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

class Store extends EventEmitter {
  constructor() {
    super();
    this.conversations = new Map();
    this.config = { systemPrompt: DEFAULT_PROMPT };
    this.connection = { state: 'disconnected', qr: null };
  }

  async load() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(CONV_FILE, 'utf8');
      const obj = JSON.parse(raw);
      for (const [jid, conv] of Object.entries(obj)) {
        this.conversations.set(jid, conv);
      }
    } catch {}
    try {
      const raw = await fs.readFile(CONFIG_FILE, 'utf8');
      this.config = { ...this.config, ...JSON.parse(raw) };
    } catch {}
  }

  async persistConversations() {
    const obj = Object.fromEntries(this.conversations);
    await fs.writeFile(CONV_FILE, JSON.stringify(obj, null, 2));
  }

  async persistConfig() {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  getOrCreateConversation(jid, name) {
    if (!this.conversations.has(jid)) {
      this.conversations.set(jid, {
        jid,
        name: name || jid.split('@')[0],
        mode: 'ai',
        messages: [],
        updatedAt: Date.now(),
      });
    } else if (name && !this.conversations.get(jid).name) {
      this.conversations.get(jid).name = name;
    }
    return this.conversations.get(jid);
  }

  addMessage(jid, msg, name) {
    const conv = this.getOrCreateConversation(jid, name);
    conv.messages.push({
      ...msg,
      ts: msg.ts || Date.now(),
    });
    if (conv.messages.length > 200) {
      conv.messages = conv.messages.slice(-200);
    }
    conv.updatedAt = Date.now();
    this.persistConversations().catch(() => {});
    this.emit('message', { jid, message: msg, conversation: conv });
    return conv;
  }

  setMode(jid, mode) {
    const conv = this.getOrCreateConversation(jid);
    conv.mode = mode === 'human' ? 'human' : 'ai';
    this.persistConversations().catch(() => {});
    this.emit('mode', { jid, mode: conv.mode });
    return conv;
  }

  setPrompt(prompt) {
    this.config.systemPrompt = prompt;
    this.persistConfig().catch(() => {});
    this.emit('config', this.config);
  }

  setConnection(state, qr = null) {
    this.connection = { state, qr };
    this.emit('connection', this.connection);
  }

  snapshot() {
    return {
      conversations: Array.from(this.conversations.values()).sort(
        (a, b) => b.updatedAt - a.updatedAt
      ),
      config: this.config,
      connection: this.connection,
    };
  }
}

export const store = new Store();

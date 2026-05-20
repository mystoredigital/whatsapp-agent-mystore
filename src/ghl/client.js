import { refreshToken as oauthRefresh } from './oauth.js';

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

export class GHLClient {
  constructor(store) {
    this.store = store;
  }

  async _ensureFreshToken() {
    if (!this.store.ghl) throw new Error('Tenant sin tokens GHL');
    const expiresAt = this.store.ghl.expiresAt || 0;
    // Refresca 60s antes de expirar
    if (Date.now() <= expiresAt - 60000) return this.store.ghl.accessToken;

    // Single-flight: el refresh token rota al usarse — si dos requests refrescan
    // en paralelo, una de las dos pierde el nuevo refresh y queda fuera. El lock
    // vive en el store para que múltiples GHLClient compartan el mismo refresh.
    if (!this.store._refreshPromise) {
      this.store._refreshPromise = (async () => {
        const fresh = await oauthRefresh({
          refreshToken: this.store.ghl.refreshToken,
          clientId: process.env.GHL_CLIENT_ID,
          clientSecret: process.env.GHL_CLIENT_SECRET,
          userType: this.store.ghl.userType || 'Location',
        });
        this.store.setGhlTokens(fresh);
        console.log(`[ghl:${this.store.tenantId}] token refrescado`);
      })().finally(() => { this.store._refreshPromise = null; });
    }
    await this.store._refreshPromise;
    return this.store.ghl.accessToken;
  }

  async _req(method, pathname, { json, query } = {}) {
    const token = await this._ensureFreshToken();
    const url = new URL(API_BASE + pathname);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: API_VERSION,
          Accept: 'application/json',
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error(`GHL ${method} ${pathname} timeout (15s)`);
      }
      throw e;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GHL ${method} ${pathname} ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async findContactByPhone(phone) {
    const locationId = this.store.ghl.locationId;
    const res = await this._req('GET', '/contacts/', { query: { locationId, query: phone } }).catch(() => null);
    return res?.contacts?.[0] || null;
  }

  async createContact({ phone, name }) {
    const locationId = this.store.ghl.locationId;
    const res = await this._req('POST', '/contacts/', {
      json: { locationId, phone, firstName: name || phone, source: 'WhatsApp · My Store' },
    });
    return res?.contact || res;
  }

  async findOrCreateContact({ phone, name }) {
    const existing = await this.findContactByPhone(phone);
    if (existing) {
      // Si el contacto existe pero tiene un nombre placeholder (vacío o solo número),
      // y nosotros tenemos un pushName REAL (no otro número), actualizamos. Evita que
      // la lista de GHL quede llena de '+593...' cuando el cliente ya tiene display name.
      const newNameIsReal = name && name.trim() && !/^\+?\d{6,}$/.test(name.trim());
      if (newNameIsReal && this._isPlaceholderName(existing, phone)) {
        await this.updateContactName(existing.id, name).catch((e) =>
          console.warn(`[ghl] update contact name falló: ${e.message}`)
        );
        existing.firstName = name;
      }
      return existing;
    }
    return await this.createContact({ phone, name });
  }

  _isPlaceholderName(contact, phone) {
    const candidates = [contact?.firstName, contact?.contactName, contact?.name]
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim());
    if (candidates.length === 0) return true;
    const looksLikePhone = (s) => /^\+?\d{6,}$/.test(s);
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    return candidates.every((c) => !c || looksLikePhone(c) || c.includes(phoneDigits));
  }

  async updateContactName(contactId, name) {
    if (!contactId || !name) return null;
    return this._req('PUT', `/contacts/${contactId}`, {
      json: { firstName: name },
    });
  }

  async sendInboundMessage({ contactId, message, conversationProviderId, altId, attachments, type = 'Custom' }) {
    return this._req('POST', '/conversations/messages/inbound', {
      json: {
        type,
        contactId,
        message,
        conversationProviderId,
        ...(altId ? { altId } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      },
    });
  }

  // Actualiza el status de un mensaje GHL (read/delivered/failed). Necesario para
  // sincronizar lectura: cuando el operador abre el chat en la app, marcamos los
  // mensajes como read en GHL para que dejen de aparecer como "sin leer".
  async updateMessageStatus(messageId, status) {
    if (!messageId) return null;
    return this._req('PUT', `/conversations/messages/${messageId}/status`, {
      json: { status },
    });
  }

  // Crea un Custom Conversation Provider scoped a esta location. Patrón multi-tenant:
  // cada sub-account que instala la app obtiene su propio providerId — el providerId
  // del Marketplace está scoped a la sub-account donde se creó originalmente.
  async createConversationProvider({ name, deliveryUrl }) {
    const locationId = this.store.ghl.locationId;
    if (!locationId) throw new Error('Tenant sin locationId');
    if (!deliveryUrl) throw new Error('deliveryUrl requerido');
    return this._req('POST', '/conversations/providers', {
      json: {
        locationId,
        name: name || 'WhatsApp Agent',
        type: 'Custom',
        deliveryUrl,
      },
    });
  }
}

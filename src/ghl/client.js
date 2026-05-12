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
    if (Date.now() > expiresAt - 60000) {
      const fresh = await oauthRefresh({
        refreshToken: this.store.ghl.refreshToken,
        clientId: process.env.GHL_CLIENT_ID,
        clientSecret: process.env.GHL_CLIENT_SECRET,
        userType: this.store.ghl.userType || 'Location',
      });
      this.store.setGhlTokens(fresh);
      console.log(`[ghl:${this.store.tenantId}] token refrescado`);
    }
    return this.store.ghl.accessToken;
  }

  async _req(method, pathname, { json, query } = {}) {
    const token = await this._ensureFreshToken();
    const url = new URL(API_BASE + pathname);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });
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
    if (existing) return existing;
    return await this.createContact({ phone, name });
  }

  async sendInboundMessage({ contactId, message, conversationProviderId, altId }) {
    return this._req('POST', '/conversations/messages/inbound', {
      json: {
        type: 'SMS',
        contactId,
        message,
        conversationProviderId,
        ...(altId ? { altId } : {}),
      },
    });
  }
}

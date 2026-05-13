import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { tenants } from './tenants.js';
import { buildAuthorizeUrl, exchangeCode, listLocations, getLocationToken } from './ghl/oauth.js';
import { saveAgencyTokens, getFreshAgencyToken } from './ghl/agencies.js';
import { phoneToJid } from './ghl/phone.js';
import { GHLClient } from './ghl/client.js';
import { decryptGhlPayload, signSession, verifySession } from './ghl/sso.js';
import { ghlWebhookGuard } from './ghl/webhook.js';
import { uploadBufferToR2, mimeToWa, isMediaConfigured } from './media.js';

// Decodifica un JWT GHL para inspeccionar scopes (sin verificación — solo para debug).
function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch { return null; }
}

// Provisiona un Custom Conversation Provider para un tenant recién conectado.
// Custom Providers son operación a nivel agencia en GHL — el location token, aunque
// declare conversations.write, no tiene permiso. Usamos el agency token (Company)
// cuando existe; con fallback al location token por si en algún flujo no hay agency.
// Idempotente: si ya tiene conversationProviderId no hace nada.
async function ensureConversationProvider(tenant) {
  if (tenant.ghl?.conversationProviderId) return tenant.ghl.conversationProviderId;
  if (!tenant.ghl?.accessToken) return null;

  const deliveryUrl = `${process.env.OPENROUTER_SITE_URL || 'https://wa.mystoredigital.cloud'}/webhooks/ghl/outbound`;
  const name = `${process.env.BUSINESS_NAME || 'WhatsApp Agent'} (${tenant.tenantId.slice(0, 8)})`;
  const body = { locationId: tenant.ghl.locationId, name, type: 'Custom', deliveryUrl };

  async function callWith(token, method, source, urlSuffix = '') {
    const resp = await fetch(`https://services.leadconnectorhq.com/conversations/providers${urlSuffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const claims = decodeJwtPayload(token);
      console.error(`[ghl:${tenant.tenantId}] ${method} providers ${source} ${resp.status}: ${text.slice(0, 300)}`);
      console.error(`[ghl:${tenant.tenantId}] token scopes (${source}): ${claims?.oauthMeta?.scopes || claims?.scope || '(no scope claim)'}`);
      throw new Error(`${method} ${resp.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  function pickProviderId(payload) {
    if (!payload) return null;
    if (payload.id || payload.providerId || payload._id) return payload.id || payload.providerId || payload._id;
    const list = payload.providers || payload.data || (Array.isArray(payload) ? payload : null);
    if (Array.isArray(list)) {
      // Preferir uno cuyo nombre coincida con esta app
      const ours = list.find((p) => /whatsapp|mystore/i.test(p?.name || ''));
      const pick = ours || list[0];
      return pick?.id || pick?.providerId || pick?._id || null;
    }
    return null;
  }

  // Estrategia A: listar providers existentes (GHL auto-registra el provider de la app
  // al instalarse en una sub-account). Probamos con agency token y luego location.
  const locationId = tenant.ghl.locationId;
  const tokensToTry = [];
  if (tenant.ghl.companyId) {
    try {
      const agency = await getFreshAgencyToken(tenant.ghl.companyId);
      tokensToTry.push({ token: agency.accessToken, source: 'agency' });
    } catch (e) {
      console.warn(`[ghl:${tenant.tenantId}] no se pudo obtener agency token:`, e.message);
    }
  }
  try {
    const client = new GHLClient(tenant);
    tokensToTry.push({ token: await client._ensureFreshToken(), source: 'location' });
  } catch (e) {
    console.warn(`[ghl:${tenant.tenantId}] no se pudo obtener location token:`, e.message);
  }

  for (const { token, source } of tokensToTry) {
    try {
      const list = await callWith(token, 'GET', source + '-list', `?locationId=${encodeURIComponent(locationId)}`);
      const providerId = pickProviderId(list);
      if (providerId) {
        tenant.setGhlTokens({ conversationProviderId: providerId });
        console.log(`[ghl:${tenant.tenantId}] provider existente encontrado (${source}): ${providerId}`);
        return providerId;
      }
      console.log(`[ghl:${tenant.tenantId}] GET providers (${source}) sin resultados utilizables:`, JSON.stringify(list).slice(0, 200));
    } catch (e) {
      console.warn(`[ghl:${tenant.tenantId}] GET providers ${source} falló:`, e.message);
    }
  }

  // Estrategia B: intentar crear (esperado que falle si la app no tiene scopes/feature
  // habilitado para esto, pero dejamos el intento por completitud y diagnóstico).
  for (const { token, source } of tokensToTry) {
    try {
      const provider = await callWith(token, 'POST', source);
      const providerId = pickProviderId(provider);
      if (providerId) {
        tenant.setGhlTokens({ conversationProviderId: providerId });
        console.log(`[ghl:${tenant.tenantId}] provider creado (${source}): ${providerId}`);
        return providerId;
      }
    } catch (e) {
      // Ya logueado dentro de callWith
    }
  }
  return null;
}

const EMBED_COOKIE = 'embed_session';
const SESSION_TTL = 60 * 60 * 12; // 12h

function authMiddleware(req, res, next) {
  // Rutas siempre públicas (las requiere GHL o son endpoints de salud)
  if (
    req.path.startsWith('/oauth/') ||
    req.path.startsWith('/webhooks/') ||
    req.path === '/embed' ||
    req.path === '/embed.html' ||
    req.path === '/api/embed/sso' ||
    req.path === '/api/health'
  ) return next();

  // 1) Embed session cookie (válido y firmado)
  const cookie = req.cookies?.[EMBED_COOKIE];
  if (cookie) {
    const locationId = verifySession(cookie, process.env.GHL_SHARED_SECRET || 'dev');
    if (locationId) {
      req.embedLocationId = locationId;
      return next();
    }
  }

  // 2) Basic auth
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="MyStore Agent"');
  res.status(401).send('Auth required');
}

function getTenant(req) {
  // Cuando viene una embed session, el tenant queda fijado por la cookie y no se puede sobrescribir
  if (req.embedLocationId) {
    const t = tenants.get(req.embedLocationId);
    if (!t) throw Object.assign(new Error(`Tenant ${req.embedLocationId} no existe`), { status: 404 });
    return t;
  }
  const id = req.query.tenant || req.body?.tenant || '_local';
  const t = tenants.get(id);
  if (!t) throw Object.assign(new Error(`Tenant ${id} no existe`), { status: 404 });
  return t;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mini-parser de multipart/form-data. Solo soporta un archivo + campos planos —
// suficiente para /api/send-media. Evita añadir multer/busboy como dependencia.
function parseMultipart(buf, boundary) {
  const result = { fields: {}, files: {} };
  const boundaryBuf = Buffer.from(boundary);
  const endMarker = Buffer.from('--');
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  let pos = data.indexOf(boundaryBuf);
  if (pos === -1) return result;
  pos += boundaryBuf.length + 2; // skip CRLF after boundary

  while (pos < data.length) {
    const headerEnd = data.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = data.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = data.indexOf(boundaryBuf, bodyStart);
    if (nextBoundary === -1) break;
    const body = data.slice(bodyStart, nextBoundary - 2); // strip CRLF antes del boundary

    const disp = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (disp) {
      const name = disp[1];
      const filename = disp[2];
      if (filename) {
        result.files[name] = { filename, contentType: ctMatch?.[1]?.trim() || 'application/octet-stream', buffer: body };
      } else {
        result.fields[name] = body.toString('utf8');
      }
    }
    // Si después de este boundary viene '--' es el end marker → terminar
    const afterBoundary = nextBoundary + boundaryBuf.length;
    if (data.subarray(afterBoundary, afterBoundary + 2).equals(endMarker)) break;
    pos = afterBoundary + 2; // skip CRLF
  }
  return result;
}

function pageShell(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
.box{background:#16202a;padding:32px;border-radius:12px;max-width:640px;width:100%;border:1px solid #2a3744}
.ok{color:#4caf50;font-size:48px;text-align:center}
h2{margin:8px 0 24px;text-align:center}
.row{display:flex;align-items:center;gap:12px;padding:12px;background:#1a2530;border-radius:8px;margin-bottom:8px}
.row .info{flex:1}
.row .name{font-weight:500}
.row .id{font-size:12px;color:#8899a6;font-family:ui-monospace,Menlo,monospace}
button{background:#1d9bf0;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px}
button:hover{background:#1a8cd8}
button:disabled{opacity:0.4;cursor:not-allowed;background:#3a4d5e}
a{color:#1d9bf0}
.empty{text-align:center;color:#8899a6;padding:32px}
</style></head><body><div class="box">${body}</div></body></html>`;
}

function successPage({ tenantId, companyId }) {
  return pageShell('Instalación exitosa', `
<div class="ok">✓</div>
<h2>Conectado a GHL</h2>
<p>Location ID: <code>${escapeHtml(tenantId)}</code></p>
${companyId ? `<p>Agency: <code>${escapeHtml(companyId)}</code></p>` : ''}
<p>Próximo paso: abre el dashboard, selecciona este tenant y escanea el QR de WhatsApp.</p>
<p style="text-align:center;margin-top:24px"><a href="/?tenant=${encodeURIComponent(tenantId)}">Abrir dashboard →</a></p>`);
}

function selectLocationPage({ companyId, locations, connected }) {
  const rows = locations.length
    ? locations.map((l) => {
        const isConn = connected.has(l.id);
        const label = isConn ? 'Reconectar' : 'Conectar';
        const title = isConn ? 'Re-deriva el location token desde el agency token actual — útil tras actualizar scopes de la app' : '';
        return `<div class="row">
          <div class="info">
            <div class="name">${escapeHtml(l.name || '(sin nombre)')}${isConn ? ' <span style="color:#4caf50;font-size:11px">● conectada</span>' : ''}</div>
            <div class="id">${escapeHtml(l.id)}</div>
          </div>
          <form method="POST" action="/oauth/connect-location" style="margin:0">
            <input type="hidden" name="companyId" value="${escapeHtml(companyId)}">
            <input type="hidden" name="locationId" value="${escapeHtml(l.id)}">
            <button type="submit" title="${escapeHtml(title)}">${label}</button>
          </form>
        </div>`;
      }).join('')
    : '<div class="empty">No hay sub-accounts en esta agencia.</div>';
  return pageShell('Elige una sub-account', `
<h2>Elige la sub-account a conectar</h2>
<p style="text-align:center;color:#8899a6">Agency: <code>${escapeHtml(companyId)}</code> · ${locations.length} sub-account(s)</p>
${rows}
<p style="text-align:center;margin-top:24px"><a href="/oauth/install">← Volver al install</a></p>`);
}

const GHL_SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
];

export function startServer(port = 3000) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({
    limit: '1mb',
    // Capturamos el cuerpo raw para que ghlWebhookGuard pueda verificar firmas RSA.
    verify: (req, _res, buf) => { if (buf?.length) req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: true }));
  app.use(authMiddleware);
  app.use(express.static(path.resolve('./public')));

  // Servir /embed sin extensión
  app.get('/embed', (_req, res) => res.sendFile(path.resolve('./public/embed.html')));

  app.get('/api/health', (_req, res) => res.json({ ok: true, tenants: tenants.list().length }));

  app.get('/api/tenants', (_req, res) => res.json({ tenants: tenants.list() }));

  app.get('/api/state', (req, res) => {
    try {
      const t = getTenant(req);
      const snap = t.snapshot();
      snap.metrics = tenants.session(t.tenantId)?.getMetrics() || null;
      res.json(snap);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/config', (req, res) => {
    try {
      const t = getTenant(req);
      const { systemPrompt } = req.body || {};
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt requerido' });
      t.setPrompt(systemPrompt);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/mode', (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, mode } = req.body || {};
      if (!jid || !['ai', 'human'].includes(mode)) return res.status(400).json({ error: 'jid y mode requeridos' });
      res.json({ ok: true, conversation: t.setMode(jid, mode) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/ai-enabled', (req, res) => {
    try {
      const t = getTenant(req);
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requerido' });
      t.setAiEnabled(enabled);
      res.json({ ok: true, aiEnabled: t.config.aiEnabled });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Provisiona (o re-provisiona si force=true) el Conversation Provider del tenant.
  // Útil para sub-accounts conectadas antes del fix multi-tenant.
  app.post('/api/ghl/provision-provider', async (req, res) => {
    try {
      const t = getTenant(req);
      if (!t.ghl?.accessToken) return res.status(400).json({ error: 'Tenant sin GHL conectado' });
      if (req.body?.force) t.setGhlTokens({ conversationProviderId: null });
      const providerId = await ensureConversationProvider(t);
      if (!providerId) return res.status(500).json({ error: 'No se pudo crear (revisa logs del server)' });
      res.json({ ok: true, conversationProviderId: providerId });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/relink', async (req, res) => {
    try {
      const t = getTenant(req);
      const session = tenants.session(t.tenantId);
      if (!session) return res.status(404).json({ error: 'session no existe' });
      session.relink().catch((e) => console.error(`[relink ${t.tenantId}]`, e.message));
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, text } = req.body || {};
      if (!jid || !text) return res.status(400).json({ error: 'jid y text requeridos' });
      const session = tenants.session(t.tenantId);
      await session.send(jid, text);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Sube un archivo a R2 y lo envía via WhatsApp. Body: multipart/form-data con
  // 'file' (binario), 'jid' y opcional 'caption'. Tenant viene de query/cookie.
  // Usamos multipart raw parser local para evitar añadir dependencias (multer/busboy).
  app.post('/api/send-media', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    try {
      if (!isMediaConfigured()) return res.status(500).json({ error: 'R2 no configurado en el server' });
      const t = getTenant(req);
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!boundaryMatch) return res.status(400).json({ error: 'Content-Type debe ser multipart/form-data' });
      const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);
      const parts = parseMultipart(req.body, boundary);
      const jid = parts.fields.jid;
      const caption = parts.fields.caption || '';
      const file = parts.files.file;
      if (!jid || !file) return res.status(400).json({ error: 'jid y file requeridos' });

      const mimetype = file.contentType || 'application/octet-stream';
      const { ext } = mimeToWa(mimetype);
      const uploaded = await uploadBufferToR2(file.buffer, {
        contentType: mimetype,
        extension: file.filename ? file.filename.split('.').pop() : ext,
        prefix: `wa/${t.tenantId}/manual`,
      });

      const session = tenants.session(t.tenantId);
      await session.sendMedia(jid, { url: uploaded.url, mimetype, fileName: file.filename, caption });
      res.json({ ok: true, url: uploaded.url });
    } catch (e) {
      console.error('[send-media]', e);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // --- GHL Embed SSO ---
  app.post('/api/embed/sso', async (req, res) => {
    try {
      const { encryptedData, locationId: locFromUrl, userId, userEmail } = req.body || {};
      let locationId, userInfo = {};

      if (encryptedData) {
        const data = decryptGhlPayload(encryptedData, process.env.GHL_SHARED_SECRET);
        locationId = data.activeLocation || data.locationId;
        userInfo = { userId: data.userId, role: data.role, email: data.email, source: 'postmessage' };
      } else if (locFromUrl) {
        // Soft SSO: GHL substituyó {{location.id}} en el URL del Custom Menu Link.
        // Sin firma criptográfica, pero el link solo lo ven usuarios con acceso a esa sub-account.
        locationId = locFromUrl;
        userInfo = { userId, email: userEmail, source: 'url' };
      } else {
        return res.status(400).json({ error: 'encryptedData o locationId requerido' });
      }

      if (!locationId) return res.status(400).json({ error: 'locationId no encontrado en payload' });
      const tenant = tenants.get(locationId);
      if (!tenant) return res.status(404).json({ error: `Tenant ${locationId} no existe (instalar app primero)` });

      const signed = signSession(locationId, process.env.GHL_SHARED_SECRET);
      res.cookie(EMBED_COOKIE, signed, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: SESSION_TTL * 1000,
      });
      res.json({ locationId, ...userInfo });
    } catch (e) {
      console.error('[embed sso]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // --- GHL OAuth ---
  app.get('/oauth/install', (_req, res) => {
    const clientId = process.env.GHL_CLIENT_ID;
    const redirectUri = process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`;
    if (!clientId) return res.status(500).send('GHL_CLIENT_ID no configurado');
    res.redirect(buildAuthorizeUrl({ clientId, redirectUri, scopes: GHL_SCOPES }));
  });

  app.get('/oauth/callback', async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) return res.status(400).send(`GHL OAuth error: ${error} ${error_description || ''}`);
      if (!code) return res.status(400).send('Falta code en callback');

      const tokens = await exchangeCode({
        code: String(code),
        clientId: process.env.GHL_CLIENT_ID,
        clientSecret: process.env.GHL_CLIENT_SECRET,
        redirectUri: process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`,
        userType: 'Location',
      });

      // Caso A: token de Location directo → crear tenant
      if (tokens.locationId) {
        const tenantId = tokens.locationId;
        let tenant = tenants.get(tenantId);
        if (!tenant) tenant = await tenants.create(tenantId, { kind: 'ghl', companyId: tokens.companyId });
        tenant.setGhlTokens(tokens);
        console.log(`[oauth] tenant ${tenantId} instalado (company=${tokens.companyId})`);
        return res.send(successPage({ tenantId, companyId: tokens.companyId }));
      }

      // Caso B: token de Company (instalación a nivel agencia) → guardar y mostrar selector
      if (tokens.companyId) {
        await saveAgencyTokens(tokens);
        console.log(`[oauth] agency ${tokens.companyId} conectada — redirigiendo a selector`);
        return res.redirect(`/oauth/select-location?companyId=${encodeURIComponent(tokens.companyId)}`);
      }

      return res.status(500).send(`Tokens sin locationId ni companyId. userType=${tokens.userType}`);
    } catch (e) {
      console.error('[oauth callback]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // GET selector de location (cuando se instaló a nivel agencia)
  app.get('/oauth/select-location', async (req, res) => {
    try {
      const companyId = String(req.query.companyId || '');
      if (!companyId) return res.status(400).send('Falta companyId');
      const agency = await getFreshAgencyToken(companyId);
      const data = await listLocations({ accessToken: agency.accessToken, companyId });
      const locs = data.locations || [];
      const connected = new Set(
        tenants.list().filter((t) => t.ghl && t.ghl.companyId === companyId).map((t) => t.tenantId)
      );
      res.send(selectLocationPage({ companyId, locations: locs, connected }));
    } catch (e) {
      console.error('[select-location]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // POST conectar una location → derivar location token + crear tenant
  app.post('/oauth/connect-location', async (req, res) => {
    try {
      const { companyId, locationId } = req.body || {};
      if (!companyId || !locationId) return res.status(400).send('companyId y locationId requeridos');
      const agency = await getFreshAgencyToken(companyId);
      const locTokens = await getLocationToken({
        accessToken: agency.accessToken,
        companyId,
        locationId,
      });
      locTokens.locationId = locTokens.locationId || locationId;
      locTokens.companyId = locTokens.companyId || companyId;

      let tenant = tenants.get(locationId);
      if (!tenant) tenant = await tenants.create(locationId, { kind: 'ghl', companyId });
      tenant.setGhlTokens(locTokens);
      console.log(`[oauth] tenant ${locationId} conectado desde agencia ${companyId}`);

      res.send(successPage({ tenantId: locationId, companyId }));
    } catch (e) {
      console.error('[connect-location]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // --- GHL webhooks ---
  // GHL valida la delivery URL con GET antes de aceptarla
  app.get('/webhooks/ghl/outbound', (_req, res) => {
    res.json({ ok: true, service: 'whatsapp-agent-mystore', endpoint: 'ghl-outbound' });
  });

  app.post('/webhooks/ghl/outbound', async (req, res) => {
    // GHL → nosotros cuando el operador escribe en la UI de Conversations.
    // Payload típico: { type, locationId, contactId, messageId, message, phone, attachments, userId }
    const body = req.body || {};
    const { locationId, contactId, phone, message, messageId, attachments } = body;
    const hasMedia = Array.isArray(attachments) && attachments.length > 0;
    console.log(`[webhook outbound] location=${locationId} contact=${contactId} phone=${phone} msgId=${messageId} attachments=${hasMedia ? attachments.length : 0}`);

    res.json({ ok: true, queued: true });

    if (!locationId) return;
    if (!message && !hasMedia) return;
    const tenant = tenants.get(locationId);
    if (!tenant) return console.warn(`[webhook outbound] tenant ${locationId} no existe`);
    const session = tenants.session(locationId);
    if (!session) return console.warn(`[webhook outbound] session ${locationId} no existe`);

    // 1) intentar resolver JID via contactId (correcto incluso con LID)
    let jid = contactId ? tenant.getJidByContactId(contactId) : null;
    // 2) fallback: convertir phone → JID estándar (solo válido si no es LID)
    if (!jid && phone) jid = phoneToJid(phone);
    if (!jid) return console.warn(`[webhook outbound] no se pudo resolver jid: contactId=${contactId} phone=${phone}`);

    session.markOutboundSent(messageId);

    // Retry con backoff exponencial. Cubre desconexiones cortas de Baileys + glitches transitorios.
    const delays = [1_000, 3_000, 9_000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        if (hasMedia) {
          // Enviar cada attachment como media, con el texto como caption del primero
          for (let i = 0; i < attachments.length; i++) {
            const url = typeof attachments[i] === 'string' ? attachments[i] : attachments[i]?.url;
            if (!url) continue;
            await session.sendMedia(jid, {
              url,
              caption: i === 0 ? (message || undefined) : undefined,
            }, { skipGhlMirror: true });
          }
        } else {
          await session.send(jid, message, { skipGhlMirror: true });
        }
        if (tenant.getOrCreateConversation(jid).mode !== 'human') {
          tenant.setMode(jid, 'human');
          console.log(`[webhook outbound] modo humano activado para ${jid}`);
        }
        console.log(`[webhook outbound] enviado a ${jid}${attempt ? ` (tras ${attempt} reintento(s))` : ''}`);
        return;
      } catch (e) {
        lastErr = e;
        const next = delays[attempt];
        console.warn(`[webhook outbound] intento ${attempt + 1} falló: ${e.message}${next ? ` — reintento en ${next}ms` : ''}`);
        if (next) await new Promise((r) => setTimeout(r, next));
      }
    }
    console.error(`[webhook outbound] dropped tras ${delays.length + 1} intentos: ${lastErr?.message}`);
    tenant.addMessage(jid, {
      role: 'system',
      text: `⚠️ Mensaje desde GHL no entregado tras ${delays.length + 1} intentos: ${lastErr?.message || 'desconocido'}\nContenido: ${message || '(solo media)'}`,
    });
  });

  // Debug: empuja un mensaje de prueba a GHL Conversations para diagnosticar
  app.post('/api/debug/ghl-inbound', async (req, res) => {
    try {
      const { tenant: tenantId = '_local', phone, message = 'test desde debug', type } = req.body || {};
      const tenant = tenants.get(tenantId);
      if (!tenant) return res.status(404).json({ error: `tenant ${tenantId} no existe` });
      if (!tenant.ghl) return res.status(400).json({ error: 'tenant sin GHL conectado' });
      if (!phone) return res.status(400).json({ error: 'phone requerido (E.164 con +)' });

      const client = new GHLClient(tenant);
      const contact = await client.findOrCreateContact({ phone, name: 'Debug' }).catch((e) => ({ _err: e.message }));
      if (contact?._err) return res.json({ step: 'findOrCreateContact', error: contact._err });

      const args = {
        contactId: contact.id,
        message,
        conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID,
        altId: `debug:${Date.now()}`,
        ...(type ? { type } : {}),
      };
      const resp = await client.sendInboundMessage(args).catch((e) => ({ _err: e.message }));

      res.json({ tried: { type: type || 'default', providerId: process.env.GHL_CONVERSATION_PROVIDER_ID }, contact: { id: contact.id, name: contact.firstName, phone: contact.phone }, ghlResponse: resp });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // Webhook genérico de eventos (ContactCreate, OutboundMessage, etc.).
  // GHL firma estos con x-wh-signature (RSA-SHA256) — el guard valida cuando
  // GHL_WEBHOOK_PUBLIC_KEY está set. NO aplica a /webhooks/ghl/outbound porque
  // el Conversation Provider outbound NO viene firmado por GHL.
  app.post('/webhooks/ghl', ghlWebhookGuard, (req, res) => {
    console.log('[webhook ghl] type:', req.body?.type, 'location:', req.body?.locationId);
    res.json({ ok: true });
  });

  // --- Socket.io ---
  const httpServer = http.createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.on('subscribe', (tenantId) => {
      socket.join(`tenant:${tenantId}`);
      const t = tenants.get(tenantId);
      if (t) {
        const snap = t.snapshot();
        snap.metrics = tenants.session(tenantId)?.getMetrics() || null;
        socket.emit('state', snap);
      }
    });
  });

  for (const ev of ['message', 'mode', 'config', 'connection', 'metrics']) {
    tenants.on(ev, (payload) => {
      io.to(`tenant:${payload.tenantId}`).emit(ev, payload);
    });
  }
  tenants.on('tenant:added', ({ tenantId }) => io.emit('tenant:added', { tenantId }));

  httpServer.listen(port, () => {
    console.log(`[server] http://localhost:${port}`);
  });
  return httpServer;
}

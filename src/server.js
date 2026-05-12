import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { tenants } from './tenants.js';
import { buildAuthorizeUrl, exchangeCode, listLocations, getLocationToken } from './ghl/oauth.js';
import { saveAgencyTokens, getFreshAgencyToken } from './ghl/agencies.js';
import { phoneToJid } from './ghl/phone.js';

function basicAuth(req, res, next) {
  // No autenticar rutas públicas necesarias para el flujo GHL
  if (req.path.startsWith('/oauth/') || req.path.startsWith('/webhooks/')) return next();
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
  const id = req.query.tenant || req.body?.tenant || '_local';
  const t = tenants.get(id);
  if (!t) throw Object.assign(new Error(`Tenant ${id} no existe`), { status: 404 });
  return t;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
        return `<div class="row">
          <div class="info">
            <div class="name">${escapeHtml(l.name || '(sin nombre)')}</div>
            <div class="id">${escapeHtml(l.id)}</div>
          </div>
          <form method="POST" action="/oauth/connect-location" style="margin:0">
            <input type="hidden" name="companyId" value="${escapeHtml(companyId)}">
            <input type="hidden" name="locationId" value="${escapeHtml(l.id)}">
            <button type="submit" ${isConn ? 'disabled' : ''}>${isConn ? 'Conectada' : 'Conectar'}</button>
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
  app.use(basicAuth);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.resolve('./public')));

  app.get('/api/health', (_req, res) => res.json({ ok: true, tenants: tenants.list().length }));

  app.get('/api/tenants', (_req, res) => res.json({ tenants: tenants.list() }));

  app.get('/api/state', (req, res) => {
    try { res.json(getTenant(req).snapshot()); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
  app.post('/webhooks/ghl/outbound', async (req, res) => {
    // GHL → nosotros cuando el operador escribe en la UI de Conversations.
    // Payload típico: { type, locationId, contactId, messageId, message, phone, attachments, userId }
    const body = req.body || {};
    const { locationId, phone, message, messageId } = body;
    console.log(`[webhook outbound] location=${locationId} phone=${phone} msgId=${messageId}`);

    // Responder 200 rápido a GHL antes de hacer el trabajo
    res.json({ ok: true, queued: true });

    try {
      if (!locationId || !phone || !message) return;
      const tenant = tenants.get(locationId);
      if (!tenant) return console.warn(`[webhook outbound] tenant ${locationId} no existe`);
      const session = tenants.session(locationId);
      if (!session) return console.warn(`[webhook outbound] session ${locationId} no existe`);
      const jid = phoneToJid(phone);
      if (!jid) return console.warn(`[webhook outbound] phone inválido: ${phone}`);
      session.markOutboundSent(messageId);
      await session.send(jid, message, { skipGhlMirror: true });
      console.log(`[webhook outbound] enviado a ${jid}`);
    } catch (e) {
      console.error('[webhook outbound] error post-ack:', e.message);
    }
  });

  app.post('/webhooks/ghl', (req, res) => {
    // Webhook genérico para eventos como ContactCreate, etc. — por ahora solo log.
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
      if (t) socket.emit('state', t.snapshot());
    });
  });

  for (const ev of ['message', 'mode', 'config', 'connection']) {
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

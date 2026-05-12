import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { store } from './state.js';
import { sendManual } from './whatsapp.js';

function basicAuth(req, res, next) {
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

export function startServer(port = 3000) {
  const app = express();
  app.use(basicAuth);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.resolve('./public')));

  app.get('/api/state', (_req, res) => res.json(store.snapshot()));
  app.get('/api/health', (_req, res) => res.json({ ok: true, connection: store.connection.state }));

  app.post('/api/config', (req, res) => {
    const { systemPrompt } = req.body || {};
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      return res.status(400).json({ error: 'systemPrompt requerido' });
    }
    store.setPrompt(systemPrompt);
    res.json({ ok: true });
  });

  app.post('/api/mode', (req, res) => {
    const { jid, mode } = req.body || {};
    if (!jid || !['ai', 'human'].includes(mode)) {
      return res.status(400).json({ error: 'jid y mode (ai|human) requeridos' });
    }
    const conv = store.setMode(jid, mode);
    res.json({ ok: true, conversation: conv });
  });

  app.post('/api/send', async (req, res) => {
    const { jid, text } = req.body || {};
    if (!jid || !text) return res.status(400).json({ error: 'jid y text requeridos' });
    try {
      await sendManual(jid, text);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const httpServer = http.createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.emit('state', store.snapshot());
  });

  for (const ev of ['message', 'mode', 'config', 'connection']) {
    store.on(ev, (payload) => io.emit(ev, payload));
  }

  httpServer.listen(port, () => {
    console.log(`[server] http://localhost:${port}`);
  });
  return httpServer;
}

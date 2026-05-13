const socket = io();

const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
if (EMBED) document.body.classList.add('embed');

const state = {
  tenantId: params.get('tenant') || '_local',
  tenants: [],
  conversations: [],
  config: { systemPrompt: '', aiEnabled: true },
  connection: { state: 'disconnected', qr: null },
  meta: null,
  ghl: null,
  metrics: null,
  activeJid: null,
};

const $ = (id) => document.getElementById(id);

function withTenant(path, params = {}) {
  const p = new URLSearchParams({ tenant: state.tenantId, ...params });
  return `${path}?${p}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderConnection() {
  const el = $('connStatus');
  el.className = `status ${state.connection.state}`;
  const labels = {
    connected: '● Conectado',
    qr: '● Escanea el QR',
    disconnected: '● Desconectado',
    logged_out: '● Sesión cerrada',
    error: '● Error',
  };
  el.textContent = labels[state.connection.state] || state.connection.state;

  // Botón re-link: solo visible cuando hay que regenerar QR (logged_out)
  $('btnRelink').classList.toggle('hidden', state.connection.state !== 'logged_out');

  const modal = $('qrModal');
  if (state.connection.state === 'qr' && state.connection.qr) {
    $('qrImg').src = state.connection.qr;
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

async function relink() {
  if (!confirm('Cerrar la sesión actual y generar un QR nuevo?')) return;
  $('btnRelink').disabled = true;
  $('btnRelink').textContent = 'Reiniciando…';
  try {
    await fetch('/api/relink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: state.tenantId }),
    });
  } finally {
    $('btnRelink').disabled = false;
    $('btnRelink').textContent = 'Re-link QR';
  }
}

function renderTenantBar() {
  const sel = $('tenantSelect');
  sel.innerHTML = '';
  for (const t of state.tenants) {
    const opt = document.createElement('option');
    opt.value = t.tenantId;
    const label = t.tenantId === '_local' ? 'Local (sin GHL)' : `${t.tenantId.slice(0, 12)}…  · GHL`;
    opt.textContent = label;
    if (t.tenantId === state.tenantId) opt.selected = true;
    sel.appendChild(opt);
  }
  $('ghlBadge').textContent = state.ghl ? `🔗 GHL: ${state.ghl.locationId.slice(0, 8)}…` : '';
  // El botón de provisión vía API no funciona — GHL gestiona los Custom Providers
  // solo desde el Marketplace UI del developer. Lo mantenemos oculto.
  $('btnProvisionProvider').classList.add('hidden');
  renderMetrics();
}

async function provisionProvider() {
  const btn = $('btnProvisionProvider');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Creando…';
  try {
    const r = await fetch('/api/ghl/provision-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: state.tenantId }),
    });
    const data = await r.json();
    if (!r.ok) { alert('Error: ' + (data.error || r.status)); return; }
    alert('Provider creado: ' + data.conversationProviderId);
    await loadState();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderMetrics() {
  const el = $('metricsBar');
  const m = state.metrics;
  if (!m) { el.textContent = ''; return; }
  const cell = (label, val, warn) => {
    const cls = warn && val > 0 ? 'warn' : 'val';
    return `<span class="lbl">${label}:</span> <span class="${cls}">${val}</span>`;
  };
  el.innerHTML = [
    cell('IA', m.sent),
    cell('rate', m.skippedRateLimit, true),
    cell('silencio', m.skippedQuietHours),
    cell('greylist', m.skippedGreylist),
    cell('pausada', m.skippedAiDisabled || 0, true),
    cell('reconn', m.reconnects, true),
  ].join(' · ');
}

function renderAiGlobal() {
  const wrap = $('aiGlobalToggle')?.closest('.ai-global');
  const tog = $('aiGlobalToggle');
  const lbl = $('aiGlobalLabel');
  if (!wrap || !tog || !lbl) return;
  const paused = state.config.aiEnabled === false;
  tog.checked = paused;
  wrap.classList.toggle('paused', paused);
  lbl.textContent = paused ? 'IA pausada (todas)' : 'Modo humano global';
}

async function setAiEnabled(enabled) {
  await fetch('/api/ai-enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, enabled }),
  });
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  for (const conv of state.conversations) {
    const li = document.createElement('li');
    if (conv.jid === state.activeJid) li.classList.add('active');
    const last = conv.messages[conv.messages.length - 1];
    const previewPrefix = conv.isGroup && last?.senderName ? `${last.senderName}: ` : '';
    const groupBadge = conv.isGroup ? '<span class="group-badge" title="Grupo">👥</span> ' : '';
    li.innerHTML = `
      <div class="name">${groupBadge}${escapeHtml(displayName(conv))}</div>
      <div class="preview">${last ? escapeHtml((previewPrefix + (last.text || '')).slice(0, 60)) : '(sin mensajes)'}</div>
      <div class="meta">
        <span class="mode-badge ${conv.mode}">${conv.mode === 'ai' ? 'IA' : 'HUMANO'}</span>
        <span>${last ? fmtTime(last.ts) : ''}</span>
      </div>`;
    li.onclick = () => selectChat(conv.jid);
    list.appendChild(li);
  }
}

function renderMessages() {
  const wrap = $('messages');
  wrap.innerHTML = '';
  const conv = state.conversations.find((c) => c.jid === state.activeJid);
  if (!conv) {
    $('chatTitle').textContent = 'Selecciona un chat';
    $('modeToggle').checked = false;
    $('modeToggle').disabled = true;
    $('manualInput').disabled = true;
    $('manualSend').disabled = true;
    return;
  }
  $('chatTitle').textContent = displayName(conv);
  $('modeToggle').checked = conv.mode === 'human';
  $('modeToggle').disabled = false;
  const isHuman = conv.mode === 'human';
  $('manualInput').disabled = !isHuman;
  $('manualSend').disabled = !isHuman;
  $('manualFile').disabled = !isHuman;
  $('manualFile').parentElement.classList.toggle('disabled', !isHuman);

  for (const m of conv.messages) {
    const div = document.createElement('div');
    div.className = `bubble ${m.manual ? 'manual' : m.role}`;
    // En grupos, el remitente va en una línea pequeña arriba del bubble
    const senderTag = (conv.isGroup && m.role === 'user' && m.senderName)
      ? `<div class="sender">${escapeHtml(m.senderName)}</div>`
      : '';
    div.innerHTML = senderTag + renderBubbleBody(m) + `<span class="time">${fmtTime(m.ts)}</span>`;
    wrap.appendChild(div);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function renderBubbleBody(m) {
  let html = '';
  if (m.attachment && m.attachment.url) {
    const { url, type, mimetype, fileName, transcription } = m.attachment;
    const safeUrl = escapeHtml(url);
    if (type === 'image' || type === 'sticker') {
      html += `<img src="${safeUrl}" alt="" loading="lazy">`;
    } else if (type === 'video') {
      html += `<video src="${safeUrl}" controls preload="metadata"></video>`;
    } else if (type === 'audio' || type === 'voice') {
      html += `<audio src="${safeUrl}" controls preload="metadata"></audio>`;
      if (transcription) {
        html += `<div class="transcription">🎙 ${escapeHtml(transcription)}</div>`;
      }
    } else {
      html += `<a class="doc-link" href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(fileName || mimetype || 'archivo')}</a>`;
    }
    // Si el texto coincide con la transcripción, evitamos duplicarlo abajo
    if (m.text && m.text.trim() && m.text !== transcription) {
      html += `<div class="caption">${escapeHtml(m.text)}</div>`;
    }
  } else if (m.text && m.text.trim()) {
    html += `<div>${escapeHtml(m.text)}</div>`;
  }
  return html;
}

function displayName(conv) {
  if (conv.name) return conv.name;
  if (conv.jid.endsWith('@s.whatsapp.net')) return `+${conv.jid.split('@')[0]}`;
  if (conv.jid.endsWith('@lid')) return 'Sin identificar';
  return conv.jid;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function selectChat(jid) {
  state.activeJid = jid;
  renderChatList();
  renderMessages();
}

async function setMode(jid, mode) {
  await fetch('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, jid, mode }),
  });
}

let _stagedFile = null;

function stageFile(file) {
  _stagedFile = file || null;
  const btn = $('manualFile').parentElement;
  if (file) {
    btn.classList.add('staged');
    btn.title = `Adjunto listo: ${file.name} (${Math.round(file.size / 1024)} KB) — click para cambiar`;
  } else {
    btn.classList.remove('staged');
    btn.title = 'Adjuntar archivo';
  }
}

async function sendManual() {
  if (!state.activeJid) return;
  const text = $('manualInput').value.trim();
  if (!text && !_stagedFile) return;

  const sendBtn = $('manualSend');
  sendBtn.disabled = true;
  try {
    if (_stagedFile) {
      const fd = new FormData();
      fd.append('tenant', state.tenantId);
      fd.append('jid', state.activeJid);
      if (text) fd.append('caption', text);
      fd.append('file', _stagedFile);
      const r = await fetch(`/api/send-media?tenant=${encodeURIComponent(state.tenantId)}`, { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert('Error enviando media: ' + (err.error || r.status));
        return;
      }
      stageFile(null);
      $('manualFile').value = '';
    } else {
      await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant: state.tenantId, jid: state.activeJid, text }),
      });
    }
    $('manualInput').value = '';
  } finally {
    sendBtn.disabled = false;
  }
}

async function savePrompt() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, systemPrompt: $('promptText').value }),
  });
  $('promptModal').classList.add('hidden');
}

function switchTenant(newId) {
  const url = new URL(location.href);
  url.searchParams.set('tenant', newId);
  location.href = url.toString();
}

async function loadTenants() {
  const r = await fetch('/api/tenants');
  const { tenants } = await r.json();
  state.tenants = tenants;
  renderTenantBar();
}

async function loadState() {
  const r = await fetch(withTenant('/api/state'));
  const snap = await r.json();
  if (snap.error) {
    document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#f44">${snap.error}</div>`;
    return;
  }
  state.conversations = snap.conversations;
  state.config = snap.config;
  state.connection = snap.connection;
  state.meta = snap.meta;
  state.ghl = snap.ghl;
  state.metrics = snap.metrics || null;
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
  renderAiGlobal();
}

$('modeToggle').addEventListener('change', (e) => state.activeJid && setMode(state.activeJid, e.target.checked ? 'human' : 'ai'));
$('aiGlobalToggle').addEventListener('change', (e) => setAiEnabled(!e.target.checked));
$('manualSend').addEventListener('click', sendManual);
$('manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual(); });
$('manualFile').addEventListener('change', (e) => stageFile(e.target.files?.[0] || null));
$('btnPrompt').addEventListener('click', () => {
  $('promptText').value = state.config.systemPrompt;
  $('promptModal').classList.remove('hidden');
});
$('promptCancel').addEventListener('click', () => $('promptModal').classList.add('hidden'));
$('promptSave').addEventListener('click', savePrompt);
$('tenantSelect').addEventListener('change', (e) => switchTenant(e.target.value));
$('btnRelink').addEventListener('click', relink);
$('btnProvisionProvider').addEventListener('click', provisionProvider);

socket.emit('subscribe', state.tenantId);
socket.on('state', (snap) => {
  state.conversations = snap.conversations;
  state.config = snap.config;
  state.connection = snap.connection;
  state.meta = snap.meta;
  state.ghl = snap.ghl;
  state.metrics = snap.metrics || null;
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
  renderAiGlobal();
});
socket.on('connection', ({ connection }) => { state.connection = connection; renderConnection(); });
socket.on('metrics', ({ metrics }) => { state.metrics = metrics; renderMetrics(); });
socket.on('config', ({ config }) => { state.config = config; renderAiGlobal(); });
socket.on('mode', ({ jid, mode }) => {
  const conv = state.conversations.find((c) => c.jid === jid);
  if (!conv) return;
  conv.mode = mode;
  renderChatList();
  if (jid === state.activeJid) renderMessages();
});
socket.on('message', ({ conversation }) => {
  const i = state.conversations.findIndex((c) => c.jid === conversation.jid);
  if (i >= 0) state.conversations[i] = conversation;
  else state.conversations.unshift(conversation);
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  renderChatList();
  if (conversation.jid === state.activeJid) renderMessages();
});
socket.on('tenant:added', () => loadTenants());

(async () => {
  await loadTenants();
  await loadState();
})();

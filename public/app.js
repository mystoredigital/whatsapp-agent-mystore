const socket = io();

const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
if (EMBED) document.body.classList.add('embed');

const state = {
  tenantId: params.get('tenant') || '_local',
  tenants: [],
  conversations: [],
  config: { systemPrompt: '' },
  connection: { state: 'disconnected', qr: null },
  meta: null,
  ghl: null,
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
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  for (const conv of state.conversations) {
    const li = document.createElement('li');
    if (conv.jid === state.activeJid) li.classList.add('active');
    const last = conv.messages[conv.messages.length - 1];
    li.innerHTML = `
      <div class="name">${escapeHtml(displayName(conv))}</div>
      <div class="preview">${last ? escapeHtml((last.text || '').slice(0, 60)) : '(sin mensajes)'}</div>
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

  for (const m of conv.messages) {
    const div = document.createElement('div');
    div.className = `bubble ${m.manual ? 'manual' : m.role}`;
    div.innerHTML = `${escapeHtml(m.text)}<span class="time">${fmtTime(m.ts)}</span>`;
    wrap.appendChild(div);
  }
  wrap.scrollTop = wrap.scrollHeight;
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

async function sendManual() {
  const text = $('manualInput').value.trim();
  if (!text || !state.activeJid) return;
  $('manualInput').value = '';
  await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, jid: state.activeJid, text }),
  });
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
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
}

$('modeToggle').addEventListener('change', (e) => state.activeJid && setMode(state.activeJid, e.target.checked ? 'human' : 'ai'));
$('manualSend').addEventListener('click', sendManual);
$('manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual(); });
$('btnPrompt').addEventListener('click', () => {
  $('promptText').value = state.config.systemPrompt;
  $('promptModal').classList.remove('hidden');
});
$('promptCancel').addEventListener('click', () => $('promptModal').classList.add('hidden'));
$('promptSave').addEventListener('click', savePrompt);
$('tenantSelect').addEventListener('change', (e) => switchTenant(e.target.value));
$('btnRelink').addEventListener('click', relink);

socket.emit('subscribe', state.tenantId);
socket.on('state', (snap) => {
  state.conversations = snap.conversations;
  state.config = snap.config;
  state.connection = snap.connection;
  state.meta = snap.meta;
  state.ghl = snap.ghl;
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
});
socket.on('connection', ({ connection }) => { state.connection = connection; renderConnection(); });
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

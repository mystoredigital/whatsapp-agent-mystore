const socket = io();

const state = {
  conversations: [],
  config: { systemPrompt: '' },
  connection: { state: 'disconnected', qr: null },
  activeJid: null,
};

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  const modal = $('qrModal');
  if (state.connection.state === 'qr' && state.connection.qr) {
    $('qrImg').src = state.connection.qr;
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  for (const conv of state.conversations) {
    const li = document.createElement('li');
    if (conv.jid === state.activeJid) li.classList.add('active');
    const last = conv.messages[conv.messages.length - 1];
    li.innerHTML = `
      <div class="name">${conv.name || conv.jid}</div>
      <div class="preview">${last ? (last.text || '').slice(0, 60) : '(sin mensajes)'}</div>
      <div class="meta">
        <span class="mode-badge ${conv.mode}">${conv.mode === 'ai' ? 'IA' : 'HUMANO'}</span>
        <span>${last ? fmtTime(last.ts) : ''}</span>
      </div>
    `;
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
  $('chatTitle').textContent = `${conv.name} · ${conv.jid.split('@')[0]}`;
  $('modeToggle').checked = conv.mode === 'human';
  $('modeToggle').disabled = false;
  const isHuman = conv.mode === 'human';
  $('manualInput').disabled = !isHuman;
  $('manualSend').disabled = !isHuman;

  for (const m of conv.messages) {
    const div = document.createElement('div');
    const cls = m.manual ? 'manual' : m.role;
    div.className = `bubble ${cls}`;
    div.innerHTML = `${escapeHtml(m.text)}<span class="time">${fmtTime(m.ts)}</span>`;
    wrap.appendChild(div);
  }
  wrap.scrollTop = wrap.scrollHeight;
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
    body: JSON.stringify({ jid, mode }),
  });
}

async function sendManual() {
  const text = $('manualInput').value.trim();
  if (!text || !state.activeJid) return;
  $('manualInput').value = '';
  await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, text }),
  });
}

async function savePrompt() {
  const systemPrompt = $('promptText').value;
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemPrompt }),
  });
  $('promptModal').classList.add('hidden');
}

$('modeToggle').addEventListener('change', (e) => {
  if (!state.activeJid) return;
  setMode(state.activeJid, e.target.checked ? 'human' : 'ai');
});
$('manualSend').addEventListener('click', sendManual);
$('manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual(); });
$('btnPrompt').addEventListener('click', () => {
  $('promptText').value = state.config.systemPrompt;
  $('promptModal').classList.remove('hidden');
});
$('promptCancel').addEventListener('click', () => $('promptModal').classList.add('hidden'));
$('promptSave').addEventListener('click', savePrompt);

socket.on('state', (snap) => {
  state.conversations = snap.conversations;
  state.config = snap.config;
  state.connection = snap.connection;
  renderConnection();
  renderChatList();
  renderMessages();
});

socket.on('connection', (conn) => {
  state.connection = conn;
  renderConnection();
});

socket.on('message', ({ jid, conversation }) => {
  const i = state.conversations.findIndex((c) => c.jid === jid);
  if (i >= 0) state.conversations[i] = conversation;
  else state.conversations.unshift(conversation);
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  renderChatList();
  if (jid === state.activeJid) renderMessages();
});

socket.on('mode', ({ jid }) => {
  // El message handler ya actualizó el conversation; refresca por si acaso.
  fetch('/api/state').then((r) => r.json()).then((snap) => {
    state.conversations = snap.conversations;
    renderChatList();
    if (jid === state.activeJid) renderMessages();
  });
});

socket.on('config', (cfg) => { state.config = cfg; });

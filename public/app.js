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
  numbers: [], // [{ id, label, connection: { state, qr } }, ...]
  meta: null,
  ghl: null,
  metrics: null,
  activeJid: null,
  searchQuery: '',
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
  const numbers = state.numbers || [];
  // Estado agregado: 'connected' si TODOS conectados, 'qr' si alguno necesita QR,
  // si no, usa el estado del default. Para tenants single-number el resultado es el mismo.
  let aggregateState = state.connection.state || 'disconnected';
  let qrSrc = null, qrLabel = null;
  if (numbers.length > 0) {
    const qrNumber = numbers.find((n) => n.connection?.state === 'qr');
    if (qrNumber) {
      aggregateState = 'qr';
      qrSrc = qrNumber.connection.qr;
      qrLabel = qrNumber.label;
    } else {
      const allConnected = numbers.every((n) => n.connection?.state === 'connected');
      aggregateState = allConnected ? 'connected' : (numbers.find((n) => n.connection?.state === 'connected') ? 'mixed' : numbers[0].connection?.state || 'disconnected');
    }
  }
  el.className = `status ${aggregateState}`;
  const labels = {
    connected: '● Conectado',
    qr: '● Escanea el QR',
    disconnected: '● Desconectado',
    logged_out: '● Sesión cerrada',
    error: '● Error',
    mixed: '● Algunos conectados',
  };
  el.textContent = numbers.length > 1
    ? `${labels[aggregateState] || aggregateState} (${numbers.length} números)`
    : (labels[aggregateState] || aggregateState);

  // Botón re-link: visible cuando algún número está logged_out
  const anyLoggedOut = numbers.some((n) => n.connection?.state === 'logged_out') || state.connection.state === 'logged_out';
  $('btnRelink').classList.toggle('hidden', !anyLoggedOut);

  const modal = $('qrModal');
  // Muestra QR del primer número en estado 'qr' (o el legacy state.connection.qr)
  if (qrSrc) {
    $('qrImg').src = qrSrc;
    const titleEl = modal.querySelector('h3');
    if (titleEl) titleEl.textContent = qrLabel ? `Escanea para vincular: ${qrLabel}` : 'Escanea para vincular WhatsApp';
    modal.classList.remove('hidden');
  } else if (state.connection.state === 'qr' && state.connection.qr) {
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

let _groupsCache = [];
let _groupsFilter = '';

async function openGroupsModal() {
  $('groupsModal').classList.remove('hidden');
  $('groupsSearch').value = '';
  _groupsFilter = '';
  await loadGroups();
}

async function loadGroups() {
  const list = $('groupsList');
  list.innerHTML = '<div class="empty">Cargando grupos…</div>';
  try {
    const r = await fetch(withTenant('/api/groups'));
    const data = await r.json();
    if (!r.ok) {
      list.innerHTML = `<div class="empty">Error: ${escapeHtml(data.error || r.status)}</div>`;
      return;
    }
    _groupsCache = data.groups || [];
    renderGroups();
  } catch (e) {
    list.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderGroups() {
  const list = $('groupsList');
  const q = _groupsFilter.toLowerCase();
  const filtered = q
    ? _groupsCache.filter((g) => (g.name || '').toLowerCase().includes(q) || (g.jid || '').toLowerCase().includes(q))
    : _groupsCache;
  if (!filtered.length) {
    list.innerHTML = '<div class="empty">No hay grupos para mostrar.</div>';
    return;
  }
  list.innerHTML = filtered.map((g) => {
    const meta = [
      g.participantCount != null ? `${g.participantCount} miembros` : null,
      g.hasMessages ? 'con historial' : null,
      g.stale ? 'archivado/abandonado' : null,
    ].filter(Boolean).join(' · ');
    return `<div class="group-row" data-jid="${escapeHtml(g.jid)}">
      <div class="info">
        <div class="name">${escapeHtml(g.name)}</div>
        <div class="meta">${escapeHtml(meta || '')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" data-jid="${escapeHtml(g.jid)}" ${g.enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>`;
  }).join('');
}

async function openNumbersModal() {
  $('numbersModal').classList.remove('hidden');
  await loadNumbers();
}

async function loadNumbers() {
  const list = $('numbersList');
  list.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const r = await fetch(withTenant('/api/numbers'));
    const data = await r.json();
    if (!r.ok) {
      list.innerHTML = `<div class="empty">Error: ${escapeHtml(data.error || r.status)}</div>`;
      return;
    }
    state.numbers = data.numbers || [];
    renderNumbersList();
  } catch (e) {
    list.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderNumbersList() {
  const list = $('numbersList');
  if (!state.numbers.length) {
    list.innerHTML = '<div class="empty">Aún no hay números. Añade uno abajo.</div>';
    return;
  }
  list.innerHTML = state.numbers.map((n) => {
    const st = n.connection?.state || 'disconnected';
    const stLabels = { connected: 'conectado', qr: 'escanea QR', disconnected: 'desconectado', logged_out: 'sesión cerrada' };
    const qrHtml = st === 'qr' && n.connection?.qr
      ? `<div class="qr-block"><img src="${escapeHtml(n.connection.qr)}" alt="QR"></div>`
      : '';
    const isOnlyOne = state.numbers.length === 1;
    return `<div class="number-row" data-numberid="${escapeHtml(n.id)}">
      <div class="info">
        <div class="label">${escapeHtml(n.label || n.id)}</div>
        <div class="id">${escapeHtml(n.id)}</div>
      </div>
      <span class="state ${st}">${stLabels[st] || st}</span>
      <div class="actions">
        <button class="btn" data-action="relink" data-numberid="${escapeHtml(n.id)}">Re-link QR</button>
        ${isOnlyOne ? '' : `<button class="btn" data-action="remove" data-numberid="${escapeHtml(n.id)}">Eliminar</button>`}
      </div>
      ${qrHtml}
    </div>`;
  }).join('');
}

async function addNumber() {
  const id = $('newNumberId').value.trim();
  const label = $('newNumberLabel').value.trim();
  if (!id) { alert('id requerido'); return; }
  const btn = $('numbersAdd');
  btn.disabled = true;
  try {
    const r = await fetch('/api/numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: state.tenantId, id, label: label || id }),
    });
    const data = await r.json();
    if (!r.ok) { alert('Error: ' + (data.error || r.status)); return; }
    $('newNumberId').value = '';
    $('newNumberLabel').value = '';
    await loadNumbers();
  } finally { btn.disabled = false; }
}

async function relinkNumber(numberId) {
  if (!confirm(`Re-link el número '${numberId}'? Esto cierra la sesión actual y genera un QR nuevo.`)) return;
  await fetch('/api/relink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, numberId }),
  });
  // El estado se actualizará via socket; refrescamos la lista por si acaso
  setTimeout(loadNumbers, 1500);
}

async function removeNumber(numberId) {
  if (!confirm(`Eliminar el número '${numberId}'? Se borrarán las credenciales y la sesión se cierra. Esto NO borra las conversaciones.`)) return;
  const r = await fetch(`/api/numbers/${encodeURIComponent(numberId)}?tenant=${encodeURIComponent(state.tenantId)}`, {
    method: 'DELETE',
  });
  const data = await r.json();
  if (!r.ok) { alert('Error: ' + (data.error || r.status)); return; }
  await loadNumbers();
}

async function toggleGroup(jid, enabled) {
  const r = await fetch('/api/groups/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: state.tenantId, jid, enabled }),
  });
  const data = await r.json();
  if (!r.ok) {
    alert('Error: ' + (data.error || r.status));
    return false;
  }
  // Actualiza cache local
  const g = _groupsCache.find((x) => x.jid === jid);
  if (g) g.enabled = enabled;
  // Sync state.config.enabledGroups para que renderChatList filtre correctamente
  state.config.enabledGroups = data.enabledGroups || [];
  renderChatList();
  return true;
}

function filterConversations(convs, query) {
  // Esconder grupos no habilitados explícitamente (los datos persisten en el server)
  const enabled = new Set(state.config.enabledGroups || []);
  let base = convs.filter((c) => !c.isGroup || enabled.has(c.jid));
  if (!query) return base;
  const q = query.toLowerCase();
  return base.filter((c) => {
    if ((c.name || '').toLowerCase().includes(q)) return true;
    if ((c.jid || '').toLowerCase().includes(q)) return true;
    const recent = c.messages.slice(-50);
    for (const m of recent) {
      if ((m.text || '').toLowerCase().includes(q)) return true;
      if (m.senderName && m.senderName.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  const filtered = filterConversations(state.conversations, state.searchQuery);
  if (state.searchQuery && filtered.length === 0) {
    list.innerHTML = '<li class="empty-search" style="cursor:default">Sin resultados</li>';
    return;
  }
  for (const conv of filtered) {
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
  if (m.quoted && (m.quoted.text || m.quoted.mediaType)) {
    const preview = m.quoted.text
      ? escapeHtml(m.quoted.text.slice(0, 160))
      : `<em>${escapeHtml(m.quoted.mediaType)}</em>`;
    html += `<div class="quoted">${preview}</div>`;
  }
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
  state.numbers = snap.numbers || [];
  state.meta = snap.meta;
  state.ghl = snap.ghl;
  state.metrics = snap.metrics || null;
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
  renderAiGlobal();
}

// Null-safe — si el navegador tiene HTML cacheado sin algún elemento nuevo,
// no rompemos toda la cadena de event listeners por un TypeError.
function on(id, evt, fn) {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
  else console.warn(`[app] elemento #${id} no existe — listener no enganchado`);
}

on('modeToggle', 'change', (e) => state.activeJid && setMode(state.activeJid, e.target.checked ? 'human' : 'ai'));
on('aiGlobalToggle', 'change', (e) => setAiEnabled(!e.target.checked));
on('manualSend', 'click', sendManual);
on('manualInput', 'keydown', (e) => { if (e.key === 'Enter') sendManual(); });
on('manualFile', 'change', (e) => stageFile(e.target.files?.[0] || null));
on('searchInput', 'input', (e) => {
  state.searchQuery = e.target.value.trim();
  renderChatList();
});
on('btnNumbers', 'click', openNumbersModal);
on('numbersClose', 'click', () => $('numbersModal').classList.add('hidden'));
on('numbersAdd', 'click', addNumber);
on('numbersList', 'click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.numberid;
  if (action === 'relink') await relinkNumber(id);
  else if (action === 'remove') await removeNumber(id);
});
on('btnGroups', 'click', openGroupsModal);
on('groupsClose', 'click', () => $('groupsModal').classList.add('hidden'));
on('groupsRefresh', 'click', loadGroups);
on('groupsSearch', 'input', (e) => { _groupsFilter = e.target.value.trim(); renderGroups(); });
on('groupsList', 'change', async (e) => {
  if (e.target.matches('input[type="checkbox"][data-jid]')) {
    const jid = e.target.dataset.jid;
    const ok = await toggleGroup(jid, e.target.checked);
    if (!ok) e.target.checked = !e.target.checked;
  }
});
on('btnPrompt', 'click', () => {
  $('promptText').value = state.config.systemPrompt;
  $('promptModal').classList.remove('hidden');
});
on('promptCancel', 'click', () => $('promptModal').classList.add('hidden'));
on('promptSave', 'click', savePrompt);
on('tenantSelect', 'change', (e) => switchTenant(e.target.value));
on('btnRelink', 'click', relink);
on('btnProvisionProvider', 'click', provisionProvider);

socket.emit('subscribe', state.tenantId);
socket.on('state', (snap) => {
  state.conversations = snap.conversations;
  state.config = snap.config;
  state.connection = snap.connection;
  state.numbers = snap.numbers || [];
  state.meta = snap.meta;
  state.ghl = snap.ghl;
  state.metrics = snap.metrics || null;
  renderConnection();
  renderTenantBar();
  renderChatList();
  renderMessages();
  renderAiGlobal();
});
socket.on('connection', (payload) => {
  // Multi-número: el evento ahora viene como { numberId, connection, aggregate }
  if (payload.numberId) {
    const idx = state.numbers.findIndex((n) => n.id === payload.numberId);
    if (idx >= 0) state.numbers[idx] = { ...state.numbers[idx], connection: payload.connection };
    if (payload.aggregate) state.connection = payload.aggregate;
    // Si el modal Números está abierto, re-renderiza para mostrar el cambio
    if (!$('numbersModal').classList.contains('hidden')) renderNumbersList();
  } else if (payload.connection) {
    // Retro-compat: evento legacy sin numberId
    state.connection = payload.connection;
  }
  renderConnection();
});
socket.on('metrics', ({ metrics }) => { state.metrics = metrics; renderMetrics(); });
socket.on('config', ({ config }) => { state.config = config; renderAiGlobal(); renderChatList(); });
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

// Computa estadísticas agregadas para la vista "Resumen" del dashboard.
// Fuentes:
//  - audit.jsonl (persistente) → counts de send / send-media / send-blocked / mode / etc por ventana de tiempo.
//  - tenants.list() + sessions (vivo) → conexión, conversaciones, top por actividad.

import { listAudit } from './audit.js';
import { tenants } from './tenants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function bucketTs(ts, now) {
  const diff = now - ts;
  if (diff < DAY_MS) return 'today';
  if (diff < 7 * DAY_MS) return 'week';
  if (diff < 30 * DAY_MS) return 'month';
  return null;
}

export async function computeStats({ tenantId } = {}) {
  const now = Date.now();
  const since = now - 30 * DAY_MS;

  // Audit log: hasta 5000 entries en la ventana de 30d cubre uso normal.
  const audit = await listAudit({ tenantId: tenantId || null, since, limit: 5000 });

  const sentBuckets = { today: 0, week: 0, month: 0 };
  const blockedBuckets = { today: 0, week: 0, month: 0 };
  const modeBuckets = { today: 0, week: 0, month: 0 };
  for (const e of audit) {
    const b = bucketTs(e.ts, now);
    if (!b) continue;
    if (e.type === 'send' || e.type === 'send-media') {
      // cuenta acumulada: today queda dentro de week, week dentro de month
      sentBuckets.month++;
      if (b === 'today' || b === 'week') sentBuckets.week++;
      if (b === 'today') sentBuckets.today++;
    } else if (e.type === 'send-blocked') {
      blockedBuckets.month++;
      if (b === 'today' || b === 'week') blockedBuckets.week++;
      if (b === 'today') blockedBuckets.today++;
    } else if (e.type === 'mode') {
      modeBuckets.month++;
      if (b === 'today' || b === 'week') modeBuckets.week++;
      if (b === 'today') modeBuckets.today++;
    }
  }

  // Tenants y sesiones vivas
  const tenantList = tenants.list();
  const scopedTenants = tenantId ? tenantList.filter((t) => t.tenantId === tenantId) : tenantList;
  let sessionsTotal = 0, sessionsOpen = 0;
  let convsTotal = 0, convsActiveToday = 0;
  const topConvs = [];

  for (const t of scopedTenants) {
    const store = tenants.get(t.tenantId);
    if (!store) continue;
    for (const [, n] of store.numbers) {
      sessionsTotal++;
      if (n.connection?.state === 'connected') sessionsOpen++;
    }
    for (const conv of store.conversations.values()) {
      convsTotal++;
      if (now - conv.updatedAt < DAY_MS) convsActiveToday++;
      topConvs.push({
        tenantId: t.tenantId,
        jid: conv.jid,
        name: conv.name || conv.jid,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages?.length || 0,
        isGroup: !!conv.isGroup,
      });
    }
  }
  topConvs.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    asOf: now,
    scope: tenantId || 'all',
    tenants: {
      total: tenantList.length,
      // un tenant "connected" si tiene al menos una sesion conectada
      connected: tenantList.filter((t) => {
        const store = tenants.get(t.tenantId);
        if (!store) return false;
        for (const [, n] of store.numbers) {
          if (n.connection?.state === 'connected') return true;
        }
        return false;
      }).length,
    },
    sessions: { total: sessionsTotal, open: sessionsOpen },
    conversations: {
      total: convsTotal,
      activeToday: convsActiveToday,
      top: topConvs.slice(0, 5),
    },
    messages: {
      sent: sentBuckets,
      blocked: blockedBuckets,
      modeChanges: modeBuckets,
    },
  };
}

// JID Baileys ↔ E.164 phone

// Extrae teléfono REAL del mensaje considerando LID mode (WhatsApp Hide Number).
// Si el jid es @lid, intenta resolver via remoteJidAlt o senderPn del key.
// Devuelve { phone: '+E164', jidForRouting: 'jid para sendMessage' } o null.
export function resolvePhoneAndJid(msg) {
  const key = msg?.key || {};
  const jid = key.remoteJid;
  if (!jid) return null;

  // Caso normal: @s.whatsapp.net
  if (jid.endsWith('@s.whatsapp.net')) {
    const num = jid.split('@')[0].split(':')[0];
    if (!/^\d+$/.test(num)) return null;
    return { phone: `+${num}`, jidForRouting: jid };
  }

  // Caso LID: WhatsApp Hide Number / direcciones de privacidad
  if (jid.endsWith('@lid')) {
    // remoteJidAlt suele tener la versión @s.whatsapp.net
    const alt = key.remoteJidAlt;
    if (alt && alt.endsWith('@s.whatsapp.net')) {
      const num = alt.split('@')[0].split(':')[0];
      if (/^\d+$/.test(num)) return { phone: `+${num}`, jidForRouting: jid }; // ¡routeamos por el LID, no por el phone JID!
    }
    // Fallback: senderPn como string
    const pn = key.senderPn;
    if (pn && /^\+?\d+$/.test(pn)) {
      const cleaned = pn.startsWith('+') ? pn : `+${pn}`;
      return { phone: cleaned, jidForRouting: jid };
    }
    return null; // No podemos identificar el teléfono real
  }

  return null;
}

// Legacy helper — usado por outbound webhook como fallback
export function jidToPhone(jid) {
  if (!jid) return null;
  const num = jid.split('@')[0].split(':')[0];
  if (!/^\d+$/.test(num)) return null;
  return `+${num}`;
}

export function phoneToJid(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

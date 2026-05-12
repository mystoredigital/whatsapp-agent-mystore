// JID Baileys ↔ E.164 phone

export function jidToPhone(jid) {
  if (!jid) return null;
  const num = jid.split('@')[0].split(':')[0]; // strips :NNN suffix de algunos jids
  if (!/^\d+$/.test(num)) return null;
  return `+${num}`;
}

export function phoneToJid(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

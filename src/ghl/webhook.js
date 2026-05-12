import crypto from 'node:crypto';

// GHL firma sus webhooks con RSA-SHA256 sobre el cuerpo raw. La firma viaja en
// el header `x-wh-signature` (base64). El público es la public key de la app
// (la misma que GHL publica en su panel del Marketplace).
//
// Nota: existe un nuevo header `x-ghl-signature` (Ed25519) que reemplazará a
// este en julio 2026. Cuando GHL lo habilite por completo, agregar verificación
// alternativa aquí.
export function verifyWebhookSignature(rawBody, signatureB64, publicKeyPem) {
  if (!rawBody || !signatureB64 || !publicKeyPem) return false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}

let warnedMissingKey = false;

// Middleware Express para webhooks de eventos GHL (NO aplicar al outbound del
// Conversation Provider — GHL no firma ese). Si GHL_WEBHOOK_PUBLIC_KEY está
// configurado, rechaza peticiones sin firma válida. Sin key acepta con warning.
export function ghlWebhookGuard(req, res, next) {
  // GET (validación del delivery URL en el panel de GHL) — no se firma
  if (req.method !== 'POST') return next();

  // Aceptamos PEM con saltos reales O con \n escapados (.env single-line)
  const publicKey = process.env.GHL_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (!publicKey) {
    if (!warnedMissingKey) {
      console.warn('[webhook guard] GHL_WEBHOOK_PUBLIC_KEY no configurado — aceptando webhooks sin firma (NO usar en producción)');
      warnedMissingKey = true;
    }
    return next();
  }

  const sig = req.headers['x-wh-signature'];
  if (!sig) {
    console.warn('[webhook guard] sin header x-wh-signature — rechazado');
    return res.status(401).json({ error: 'firma requerida' });
  }
  if (!req.rawBody) {
    console.error('[webhook guard] rawBody ausente — verificación imposible');
    return res.status(500).json({ error: 'raw body no capturado' });
  }
  if (!verifyWebhookSignature(req.rawBody, String(sig), publicKey)) {
    console.warn('[webhook guard] firma inválida — rechazado');
    return res.status(401).json({ error: 'firma inválida' });
  }
  next();
}

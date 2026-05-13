import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';

const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const BUCKET = process.env.R2_BUCKET;

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  if (!BUCKET || !PUBLIC_URL || !process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 no configurado (faltan R2_BUCKET / R2_PUBLIC_URL / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)');
  }
  _s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _s3;
}

export function isMediaConfigured() {
  return !!(BUCKET && PUBLIC_URL && process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

// Sube un buffer a R2 con una key derivada del hash del contenido, retorna URL pública.
// Idempotente — si el mismo contenido se sube dos veces, queda en la misma key.
export async function uploadBufferToR2(buffer, { contentType = 'application/octet-stream', extension = '', prefix = 'wa' } = {}) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const ext = extension ? `.${extension.replace(/^\./, '')}` : '';
  const key = `${prefix}/${hash}${ext}`;
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Cache aggressively — content is immutable by hash
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return { url: `${PUBLIC_URL}/${key}`, key, contentType };
}

// Descarga un URL público a buffer (para outbound: GHL nos da URL, hay que descargarla
// antes de enviar via Baileys). Tiene timeout y límite de tamaño defensivo.
export async function downloadUrlToBuffer(url, { maxBytes = 50 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`download ${url}: tamaño ${len} excede ${maxBytes}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error(`download ${url}: body ${ab.byteLength} excede ${maxBytes}`);
  return { buffer: Buffer.from(ab), contentType };
}

// Mapea mime type → extension razonable y categoría de WhatsApp.
const MIME_MAP = {
  'image/jpeg': { ext: 'jpg', waType: 'image' },
  'image/png': { ext: 'png', waType: 'image' },
  'image/webp': { ext: 'webp', waType: 'image' },
  'image/gif': { ext: 'gif', waType: 'image' },
  'video/mp4': { ext: 'mp4', waType: 'video' },
  'video/quicktime': { ext: 'mov', waType: 'video' },
  'video/webm': { ext: 'webm', waType: 'video' },
  'audio/ogg': { ext: 'ogg', waType: 'audio' },
  'audio/mpeg': { ext: 'mp3', waType: 'audio' },
  'audio/mp4': { ext: 'm4a', waType: 'audio' },
  'audio/wav': { ext: 'wav', waType: 'audio' },
  'application/pdf': { ext: 'pdf', waType: 'document' },
};

export function mimeToWa(mimeType) {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (MIME_MAP[base]) return MIME_MAP[base];
  // Fallbacks por familia
  if (base.startsWith('image/')) return { ext: base.split('/')[1] || 'bin', waType: 'image' };
  if (base.startsWith('video/')) return { ext: base.split('/')[1] || 'mp4', waType: 'video' };
  if (base.startsWith('audio/')) return { ext: base.split('/')[1] || 'mp3', waType: 'audio' };
  return { ext: 'bin', waType: 'document' };
}

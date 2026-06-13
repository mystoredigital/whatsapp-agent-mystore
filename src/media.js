import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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

// Calcula waveform (64 bytes, valores 0-100) y duración en segundos a partir
// de un audio (en cualquier formato que ffmpeg pueda decodificar). Usado para
// PTT: WhatsApp invalida la nota de voz si llega sin waveform. Baileys lo
// calcularía internamente con `audio-decode` (dep opcional), pero ese path es
// frágil — falla silenciosamente en Docker/Alpine, queda waveform vacía, y
// WhatsApp muestra "Este audio ya no está disponible". Calcularlo nosotros con
// ffmpeg + JS garantiza que SIEMPRE llegue.
export function computePttMetadata(inputBuffer) {
  return new Promise((resolve, reject) => {
    const SAMPLE_RATE = 16000;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',           // raw PCM signed 16-bit little-endian
      '-ac', '1',              // mono
      '-ar', String(SAMPLE_RATE),
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', (e) => reject(new Error(`ffmpeg no disponible: ${e.message}`)));
    ff.on('close', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString('utf8').slice(0, 300);
        return reject(new Error(`ffmpeg pcm fail (${code}): ${err}`));
      }
      const pcm = Buffer.concat(chunks);
      const sampleCount = Math.floor(pcm.length / 2);
      if (sampleCount === 0) return reject(new Error('PCM vacío'));
      const seconds = Math.max(1, Math.round(sampleCount / SAMPLE_RATE));
      const BUCKETS = 64;
      const samplesPerBucket = Math.max(1, Math.floor(sampleCount / BUCKETS));
      // RMS por bucket → normalizado 0-100 (escalado al pico para que la
      // onda se vea expresiva incluso en voces bajas).
      const rms = new Float32Array(BUCKETS);
      let peak = 0;
      for (let i = 0; i < BUCKETS; i++) {
        const start = i * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, sampleCount);
        let sum = 0;
        for (let j = start; j < end; j++) {
          const s = pcm.readInt16LE(j * 2);
          sum += s * s;
        }
        const r = Math.sqrt(sum / Math.max(1, end - start));
        rms[i] = r;
        if (r > peak) peak = r;
      }
      const scale = peak > 0 ? 100 / peak : 0;
      const waveform = Buffer.alloc(BUCKETS);
      for (let i = 0; i < BUCKETS; i++) {
        waveform[i] = Math.min(100, Math.max(0, Math.round(rms[i] * scale)));
      }
      resolve({ waveform, seconds });
    });
    ff.stdin.on('error', () => { /* ffmpeg puede cerrar stdin antes */ });
    ff.stdin.end(inputBuffer);
  });
}

// Transcodifica cualquier audio (webm/opus, mp3, mp4, wav, etc.) a OGG/Opus
// mono 32kbps — formato que WhatsApp acepta como nota de voz reproducible (PTT).
// Sin esta transcodificación los audios del navegador (WebM/Opus de Chrome,
// MP4/AAC de Safari) llegan al contacto como archivo descargable, no como
// burbuja redonda con onda. Requiere ffmpeg en el container (apk add ffmpeg).
//
// Devuelve { buffer, mimetype: 'audio/ogg', extension: 'ogg' }.
export function transcodeToOggOpus(inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',         // entrada via stdin
      '-vn',                  // descartar video si lo hay
      '-c:a', 'libopus',      // codec opus
      '-b:a', '32k',          // bitrate ideal para voz
      '-ac', '1',             // mono
      '-ar', '16000',         // sample rate 16kHz (típico voz WhatsApp)
      '-f', 'ogg',            // container OGG
      'pipe:1',               // salida via stdout
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', (e) => reject(new Error(`ffmpeg no disponible: ${e.message}`)));
    ff.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        return reject(new Error(`ffmpeg salió con código ${code}: ${errMsg}`));
      }
      resolve({
        buffer: Buffer.concat(chunks),
        mimetype: 'audio/ogg; codecs=opus',
        extension: 'ogg',
      });
    });
    // Escribimos el input y cerramos stdin para que ffmpeg arranque a procesar
    ff.stdin.on('error', () => { /* puede cerrarse antes; ignoramos */ });
    ff.stdin.end(inputBuffer);
  });
}

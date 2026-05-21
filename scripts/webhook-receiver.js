// Receiver minimo para smoke test de webhooks. HTTP en :4321
// Verifica la firma HMAC del header X-Webhook-Signature.
// Uso: SECRET=<hex> node scripts/webhook-receiver.js
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.SECRET || '';
const PORT = Number(process.env.PORT || 4321);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const got = req.headers['x-webhook-signature'] || '';
    const expected = SECRET
      ? 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex')
      : '(no SECRET configured)';
    const valid = !!SECRET && got === expected;
    console.log('---');
    console.log('event:', req.headers['x-webhook-event']);
    console.log('id:', req.headers['x-webhook-id']);
    console.log('attempt:', req.headers['x-webhook-attempt']);
    console.log('VALID:', valid ? 'YES' : 'NO');
    console.log('body:', body);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, valid }));
  });
}).listen(PORT, () => console.log(`receiver listening on :${PORT}`));

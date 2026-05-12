import 'dotenv/config';
import { store } from './state.js';
import { startServer } from './server.js';
import { startWhatsApp } from './whatsapp.js';

async function main() {
  await store.load();
  startServer(Number(process.env.PORT) || 3000);
  startWhatsApp().catch((e) => {
    console.error('[wa] fallo al iniciar', e);
    store.setConnection('error');
  });
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

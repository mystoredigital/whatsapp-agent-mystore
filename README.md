# WhatsApp Agent · My Store Digital

Agente de WhatsApp con IA: Baileys + OpenRouter (GPT-4o Mini) + Google Calendar + dashboard web con toggle IA/humano.

## Stack
- **Node.js 20** (ESM)
- **Baileys** — conexión WhatsApp Web
- **OpenRouter** — LLM gateway
- **Google Calendar API** — disponibilidad y agendamiento (service account)
- **Express + Socket.io** — dashboard en tiempo real

## Setup local
```bash
cp .env.example .env       # rellena OPENROUTER_API_KEY
# coloca credenciales en credentials/google-service-account.json
npm install
npm start
```

Abre `http://localhost:3000`, escanea el QR con WhatsApp.

## Deploy
Dokploy VPS en `wa.mystoredigital.cloud`. Volúmenes persistentes:
- `/app/data` — sesión Baileys + conversaciones + config del prompt
- `/app/credentials` — service account de Google

## Dashboard
- Lista de conversaciones en vivo
- Toggle IA / humano por chat
- Editor de system prompt en vivo
- Envío manual de mensajes cuando está en modo humano

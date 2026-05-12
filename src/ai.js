import { listAvailability, bookAppointment, isConfigured as calendarConfigured } from './calendar.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_availability',
      description: 'Lista horarios disponibles en el calendario para una fecha dada. Úsalo cuando el cliente pide reunirse.',
      parameters: {
        type: 'object',
        properties: {
          dateISO: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          durationMinutes: { type: 'integer', description: 'Duración del slot en minutos. Default 60.', default: 60 },
        },
        required: ['dateISO'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Reserva una cita en el calendario. Solo úsalo después de confirmar fecha/hora exacta con el cliente.',
      parameters: {
        type: 'object',
        properties: {
          startISO: { type: 'string', description: 'Inicio en ISO 8601 con timezone' },
          endISO: { type: 'string', description: 'Fin en ISO 8601 con timezone' },
          summary: { type: 'string', description: 'Título del evento' },
          description: { type: 'string', description: 'Descripción / agenda' },
          attendeeName: { type: 'string' },
          attendeePhone: { type: 'string' },
        },
        required: ['startISO', 'endISO', 'attendeeName'],
      },
    },
  },
];

async function executeTool(name, args) {
  if (!calendarConfigured()) {
    return { error: 'Calendar no configurado en el servidor.' };
  }
  if (name === 'list_availability') return await listAvailability(args);
  if (name === 'book_appointment') return await bookAppointment(args);
  return { error: `Tool desconocida: ${name}` };
}

function toOpenAIMessages(systemPrompt, history) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: m.text });
  }
  return msgs;
}

export async function generateReply({ systemPrompt, history }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no definido');
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  const messages = toOpenAIMessages(systemPrompt, history);
  // Recordatorio de fecha actual para el LLM
  messages.push({
    role: 'system',
    content: `Fecha y hora actual del servidor: ${new Date().toISOString()}. Timezone: ${process.env.TIMEZONE || 'America/Guayaquil'}.`,
  });

  const tools = calendarConfigured() ? TOOLS : undefined;

  for (let iter = 0; iter < 5; iter++) {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_SITE_NAME || 'WhatsApp Agent',
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: tools ? 'auto' : undefined }),
      signal: AbortSignal.timeout(45_000),
    }).catch((e) => {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('OpenRouter timeout (45s)');
      throw e;
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('OpenRouter sin choices');

    const msg = choice.message;
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      return (msg.content || '').trim();
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      let result;
      try {
        result = await executeTool(tc.function.name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }
  return 'Lo siento, no pude procesar tu solicitud. ¿Puedes reformularla?';
}

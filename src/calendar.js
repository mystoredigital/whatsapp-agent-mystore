import { google } from 'googleapis';
import path from 'node:path';
import fs from 'node:fs';

const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './credentials/google-service-account.json';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const TZ = process.env.TIMEZONE || 'America/Guayaquil';

let calendarClient = null;

function getClient() {
  if (calendarClient) return calendarClient;
  const absPath = path.resolve(KEY_FILE);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Service account file no encontrado: ${absPath}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: absPath,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  calendarClient = google.calendar({ version: 'v3', auth });
  return calendarClient;
}

export async function listAvailability({ dateISO, durationMinutes = 60 }) {
  const cal = getClient();
  const day = new Date(dateISO);
  if (isNaN(day.getTime())) throw new Error('dateISO inválido');
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);

  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: TZ,
      items: [{ id: CALENDAR_ID }],
    },
  });
  const busy = (fb.data.calendars?.[CALENDAR_ID]?.busy || []).map((b) => ({
    start: b.start,
    end: b.end,
  }));

  // Construye ventanas libres 9:00-18:00 cada `durationMinutes` minutos
  const slots = [];
  const workStart = new Date(start);
  workStart.setHours(9, 0, 0, 0);
  const workEnd = new Date(start);
  workEnd.setHours(18, 0, 0, 0);
  for (
    let t = workStart.getTime();
    t + durationMinutes * 60000 <= workEnd.getTime();
    t += durationMinutes * 60000
  ) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + durationMinutes * 60000);
    const overlaps = busy.some(
      (b) => new Date(b.start) < slotEnd && new Date(b.end) > slotStart
    );
    if (!overlaps && slotStart > new Date()) {
      slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
    }
  }
  return { date: dateISO, slots };
}

export async function bookAppointment({ startISO, endISO, summary, description, attendeeName, attendeePhone }) {
  const cal = getClient();
  const res = await cal.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: summary || `Reunión con ${attendeeName || 'cliente'}`,
      description: [
        description,
        attendeePhone ? `WhatsApp: ${attendeePhone}` : null,
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO, timeZone: TZ },
      end: { dateTime: endISO, timeZone: TZ },
    },
  });
  return {
    id: res.data.id,
    htmlLink: res.data.htmlLink,
    start: res.data.start?.dateTime,
    end: res.data.end?.dateTime,
  };
}

export function isConfigured() {
  return fs.existsSync(path.resolve(KEY_FILE));
}

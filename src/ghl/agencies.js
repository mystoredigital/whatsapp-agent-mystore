import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { refreshToken as oauthRefresh } from './oauth.js';

const AGENCIES_DIR = path.resolve('./data/_agencies');

async function ensureDir() {
  await fs.mkdir(AGENCIES_DIR, { recursive: true });
}

function fileFor(companyId) {
  return path.join(AGENCIES_DIR, `${companyId}.json`);
}

export async function saveAgencyTokens(tokens) {
  if (!tokens.companyId) throw new Error('Tokens sin companyId');
  await ensureDir();
  await fs.writeFile(fileFor(tokens.companyId), JSON.stringify(tokens, null, 2));
}

export async function loadAgencyTokens(companyId) {
  try {
    return JSON.parse(await fs.readFile(fileFor(companyId), 'utf8'));
  } catch {
    return null;
  }
}

export async function listAgencyIds() {
  if (!fsSync.existsSync(AGENCIES_DIR)) return [];
  const files = await fs.readdir(AGENCIES_DIR);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
}

// Single-flight por companyId — el refresh token rota al usarse, dos refresh
// paralelos = uno pierde y queda fuera.
const refreshInFlight = new Map();

export async function getFreshAgencyToken(companyId) {
  const tokens = await loadAgencyTokens(companyId);
  if (!tokens) throw new Error(`Sin tokens de agencia ${companyId}`);
  if (Date.now() < (tokens.expiresAt || 0) - 60000) return tokens;

  if (!refreshInFlight.has(companyId)) {
    const p = (async () => {
      const fresh = await oauthRefresh({
        refreshToken: tokens.refreshToken,
        clientId: process.env.GHL_CLIENT_ID,
        clientSecret: process.env.GHL_CLIENT_SECRET,
        userType: 'Company',
      });
      fresh.companyId = fresh.companyId || tokens.companyId;
      await saveAgencyTokens(fresh);
      return fresh;
    })().finally(() => refreshInFlight.delete(companyId));
    refreshInFlight.set(companyId, p);
  }
  return refreshInFlight.get(companyId);
}

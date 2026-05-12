const TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const AUTHORIZE_URL = 'https://marketplace.leadconnectorhq.com/oauth/chooselocation';

export function buildAuthorizeUrl({ clientId, redirectUri, scopes }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scopes.join(' '));
  return u.toString();
}

async function fetchWithTimeout(url, init, label, ms = 15_000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`GHL ${label} timeout (${ms / 1000}s)`);
    }
    throw e;
  }
}

async function postForm(body) {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  }, 'token');
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL token ${res.status}: ${text}`);
  return JSON.parse(text);
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, userType = 'Location' }) {
  const data = await postForm({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    user_type: userType,
  });
  return normalize(data);
}

export async function refreshToken({ refreshToken, clientId, clientSecret, userType = 'Location' }) {
  const data = await postForm({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    user_type: userType,
  });
  return normalize(data);
}

// Lista sub-accounts (locations) de una agencia
export async function listLocations({ accessToken, companyId, limit = 100, skip = 0 }) {
  const u = new URL('https://services.leadconnectorhq.com/locations/search');
  u.searchParams.set('companyId', companyId);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('skip', String(skip));
  const res = await fetchWithTimeout(u, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  }, 'listLocations');
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL listLocations ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Deriva Location-token desde Agency-token
export async function getLocationToken({ accessToken, companyId, locationId }) {
  const res = await fetchWithTimeout('https://services.leadconnectorhq.com/oauth/locationToken', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: '2021-07-28',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ companyId, locationId }).toString(),
  }, 'locationToken');
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL locationToken ${res.status}: ${text}`);
  return normalize(JSON.parse(text));
}

function normalize(d) {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresIn: d.expires_in,
    expiresAt: Date.now() + (d.expires_in || 0) * 1000,
    scope: d.scope,
    tokenType: d.token_type,
    userType: d.userType,
    companyId: d.companyId,
    locationId: d.locationId,
    userId: d.userId,
    raw: d,
  };
}

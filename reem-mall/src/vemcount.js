// Minimal client for Vemcount's Sales Ingestion API (Reem Mall).
//   POST /oauth/token                    -> Bearer token (6 hours)
//   POST /api/v4/integrations/sales-data -> { accepted, results[] }
// One credential = one location (Dorko Reem Mall). 60 requests/minute.
// The secret is only ever sent to the token endpoint, never logged.

export function createVemcount({ baseUrl = 'https://vemcount.app', clientId, clientSecret, fetchImpl = fetch, timeoutMs = 90000 }) {
  if (!clientId || !clientSecret) throw new Error('Vemcount client_id and client_secret are required');
  const root = baseUrl.replace(/\/+$/, '');
  let token = null;
  let expiresAt = 0;

  async function getToken() {
    if (token && Date.now() < expiresAt) return token;
    const res = await fetchImpl(`${root}/oauth/token`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'sales-data:write',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new VemcountError(`Token request failed (${res.status})`, res.status, redact(body));
    }
    token = body.access_token;
    expiresAt = Date.now() + Math.max(60, (body.expires_in ?? 21600) - 300) * 1000;
    return token;
  }

  return {
    getToken,
    // Sends rows in one batch. Vemcount rolls back the whole batch if any
    // row fails validation, so callers can safely retry the same batch.
    async pushSales(rows) {
      const send = async () => fetchImpl(`${root}/api/v4/integrations/sales-data`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify({ sales: rows }),
      });
      let res = await send();
      if (res.status === 401) { token = null; res = await send(); } // expired token
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new VemcountError(`Sales push failed (${res.status})`, res.status, body);
      return body;
    },
  };
}

function redact(body) {
  const copy = { ...body };
  delete copy.access_token;
  return copy;
}

export class VemcountError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

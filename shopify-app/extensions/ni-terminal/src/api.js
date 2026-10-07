// Client for our own middleware. The extension never talks to Network
// International directly: NI credentials live only on the server.
//
// Every request carries a Shopify session token so the middleware can reject
// anyone who isn't a signed-in POS session on an approved store.

// Set per environment before deploy. Dev: the tunnel URL from
// `shopify app dev` or a local tunnel. Prod: the client's server.
export const MIDDLEWARE_URL = 'https://example.com';

async function call(path, options = {}) {
  const token = await shopify.session.getSessionToken();
  if (!token) {
    throw new Error('Not authorised on this POS device. Ask a manager to check app permissions.');
  }
  const res = await fetch(`${MIDDLEWARE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Server error (${res.status})`);
  }
  return body;
}

// Starts a sale on the terminal. Returns { sourceId, status }.
export function startSale({ amount, currency }) {
  return call('/api/payments', {
    method: 'POST',
    body: JSON.stringify({ amount, currency }),
  });
}

// Current status. The middleware decides internally whether to call NI's
// Get Result, so the POS side works the same whether NI turns out to be
// synchronous or callback-based.
export function getStatus(sourceId) {
  return call(`/api/payments/${encodeURIComponent(sourceId)}`);
}

// Cancels a pending sale, or voids an approved one before the order closes.
export function cancelSale(sourceId) {
  return call(`/api/payments/${encodeURIComponent(sourceId)}/cancel`, { method: 'POST' });
}

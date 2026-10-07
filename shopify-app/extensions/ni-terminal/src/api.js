// Client for our own middleware. The extension never talks to Network
// International directly: NI credentials live only on the server.
//
// Relative URLs resolve against the app's application_url (the dev tunnel
// during `shopify app dev`, the client's server in production), and POS
// attaches the Shopify session token automatically. Needs POS 10.6+ and
// the POS user signed in with permission for this app.

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error('Could not reach the payment server. Check the iPad is online.');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error('This POS login has no permission for the NI payment app. Ask a manager.');
  }
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

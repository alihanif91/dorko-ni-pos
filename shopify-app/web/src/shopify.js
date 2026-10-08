// Reads the NI details saved on a Shopify order. Used for refunds, because
// the POS order screen only gives the extension the order's ID.
//
// Store access comes from Shopify "token exchange": the POS session token is
// swapped for an offline Admin API token (read_orders), cached per shop.
// No OAuth redirect or separate install step is needed.

const API_VERSION = '2026-07';

export function createShopifyClient({ apiKey, apiSecret, tokenStore, fetchImpl = fetch }) {
  async function offlineToken(shop, sessionToken) {
    const cached = tokenStore.get(shop);
    if (cached) return cached;
    const body = new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });
    const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new ShopifyError(`Token exchange failed (${res.status})`);
    const json = await res.json();
    if (!json.access_token) throw new ShopifyError('Token exchange returned no token');
    tokenStore.set(shop, json.access_token);
    return json.access_token;
  }

  async function graphql(shop, token, query, variables) {
    const res = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) {
      tokenStore.delete(shop); // stale token: next call exchanges a fresh one
      throw new ShopifyError('Shopify rejected the stored token');
    }
    if (!res.ok) throw new ShopifyError(`Shopify API error (${res.status})`);
    const json = await res.json();
    if (json.errors?.length) throw new ShopifyError(json.errors[0].message);
    return json.data;
  }

  return {
    // Returns { name, sourceId } or null when the order has no NI payment.
    async getOrderNiDetails({ shop, sessionToken, orderId }) {
      const token = await offlineToken(shop, sessionToken);
      const data = await graphql(
        shop,
        token,
        'query NiOrder($id: ID!) { order(id: $id) { name customAttributes { key value } } }',
        { id: `gid://shopify/Order/${orderId}` },
      );
      const order = data?.order;
      if (!order) return null;
      const attr = Object.fromEntries((order.customAttributes || []).map((a) => [a.key, a.value]));
      if (!attr._ni_source_id) return { name: order.name, sourceId: null };
      return { name: order.name, sourceId: attr._ni_source_id };
    },
  };
}

export class ShopifyError extends Error {}

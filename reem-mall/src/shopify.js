// Reads Dorko's POS orders from the Shopify Admin API.
//
// Auth: client credentials grant. The "Reem Mall Sales Feed" app lives in
// Dorko's own Shopify organization, so it exchanges its client ID + secret
// for a 24-hour token on every run. Nothing is stored. Scopes: read_orders,
// read_locations.

const API_VERSION = '2026-07';

export function createShopify({ shop, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!shop || !clientId || !clientSecret) throw new Error('Shopify shop, client ID and secret are required');
  const base = `https://${shop}`;
  let token = null;

  async function getToken() {
    if (token) return token;
    const res = await fetchImpl(`${base}/admin/oauth/access_token`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Shopify token request failed (${res.status}) ${body.error_description || body.error || ''}`.trim());
    }
    token = body.access_token;
    return token;
  }

  async function graphql(query, variables) {
    const res = await fetchImpl(`${base}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Shopify API error (${res.status})`);
    if (body.errors?.length) throw new Error(`Shopify: ${body.errors[0].message}`);
    return body.data;
  }

  return {
    async findLocation(name) {
      const data = await graphql('query { locations(first: 50) { nodes { id name isActive } } }');
      const loc = data.locations.nodes.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!loc) {
        throw new Error(`Location "${name}" not found. Locations: ${data.locations.nodes.map((l) => l.name).join(', ')}`);
      }
      return loc;
    },

    // All orders matching a Shopify search query, every page.
    async orders(search) {
      const out = [];
      let after = null;
      do {
        const data = await graphql(ORDERS, { q: search, after });
        out.push(...data.orders.nodes);
        after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      } while (after);
      return out;
    },
  };
}

const ORDERS = `query FeedOrders($q: String!, $after: String) {
  orders(first: 50, after: $after, query: $q, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt sourceName taxesIncluded currencyCode test
      retailLocation { id name }
      lineItems(first: 100) { nodes {
        id quantity
        originalUnitPriceSet { shopMoney { amount } }
        discountAllocations { allocatedAmountSet { shopMoney { amount } } }
        taxLines { rate priceSet { shopMoney { amount } } }
      } }
      refunds { id createdAt refundLineItems(first: 100) { nodes { quantity lineItem { id } } } }
    }
  }
}`;

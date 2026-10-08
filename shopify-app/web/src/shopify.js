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
    if (!sessionToken) throw new ShopifyError('No stored Shopify access for this shop yet');
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
        'query NiOrder($id: ID!) { order(id: $id) { name displayFinancialStatus refunds { id } customAttributes { key value } } }',
        { id: `gid://shopify/Order/${orderId}` },
      );
      const order = data?.order;
      if (!order) return null;
      const attr = Object.fromEntries((order.customAttributes || []).map((a) => [a.key, a.value]));
      return {
        name: order.name,
        sourceId: attr._ni_source_id || null,
        refundedInShopify: (order.refunds || []).length > 0,
      };
    },

    // Records a full refund of the NI card payment in Shopify, so Shopify's
    // books match the terminal. Restocks to the order's POS location when
    // possible. Never creates a second refund if one already exists.
    async recordFullRefund({ shop, sessionToken, orderId, gateway, restock = true, note }) {
      const token = await offlineToken(shop, sessionToken);
      const gid = `gid://shopify/Order/${orderId}`;
      const data = await graphql(shop, token, REFUND_CONTEXT, { id: gid });
      const order = data?.order;
      if (!order) throw new ShopifyError('Order not found in Shopify');
      if (order.refunds.length) return { refundId: order.refunds[0].id, restocked: null, existing: true };

      const sales = order.transactions.filter((t) => t.kind === 'SALE' && t.status === 'SUCCESS');
      const niSales = sales.filter((t) => t.gateway === gateway);
      const paid = niSales.length ? niSales : sales.length === 1 ? sales : [];
      if (!paid.length) throw new ShopifyError(`No "${gateway}" payment on this order`);
      const amount = paid.reduce((sum, t) => sum + Number(t.amountSet.shopMoney.amount), 0).toFixed(2);

      let locationId = null;
      if (restock) {
        try {
          const loc = await graphql(shop, token, ORDER_LOCATION, { id: gid });
          locationId = loc?.order?.retailLocation?.id ?? null;
        } catch {
          locationId = null; // e.g. read_locations not granted yet: refund without restock
        }
      }

      const build = (restockType) => ({
        orderId: gid,
        notify: false,
        note,
        refundLineItems: order.lineItems.nodes
          .filter((li) => li.refundableQuantity > 0)
          .map((li) => ({
            lineItemId: li.id,
            quantity: li.refundableQuantity,
            restockType,
            ...(restockType === 'RETURN' ? { locationId } : {}),
          })),
        transactions: [{
          orderId: gid, gateway: paid[0].gateway, kind: 'REFUND', amount, parentId: paid[0].id,
        }],
      });

      const attempt = async (restockType) => {
        const res = await graphql(shop, token, REFUND_CREATE, { input: build(restockType) });
        return res.refundCreate;
      };

      let restocked = Boolean(locationId);
      let result = await attempt(restocked ? 'RETURN' : 'NO_RESTOCK');
      if (result.userErrors?.length && restocked) {
        restocked = false; // restocking rejected: still record the money
        result = await attempt('NO_RESTOCK');
      }
      if (result.userErrors?.length) throw new ShopifyError(result.userErrors[0].message);
      return { refundId: result.refund.id, restocked, existing: false };
    },
  };
}

const REFUND_CONTEXT = `query RefundContext($id: ID!) { order(id: $id) {
  id name refunds { id }
  lineItems(first: 100) { nodes { id refundableQuantity } }
  transactions { id gateway kind status amountSet { shopMoney { amount currencyCode } } }
} }`;

const ORDER_LOCATION = 'query OrderLocation($id: ID!) { order(id: $id) { retailLocation { id } } }';

const REFUND_CREATE = `mutation RecordRefund($input: RefundInput!) { refundCreate(input: $input) {
  refund { id } userErrors { field message }
} }`;

export class ShopifyError extends Error {}

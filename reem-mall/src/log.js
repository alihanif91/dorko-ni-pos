// Records what the feed did inside Dorko's Shopify admin, so the store can
// see and reconcile it without leaving Shopify:
//   - one "Reem Mall feed day" entry (app-owned metaobject) for EVERY day,
//     including days with no sales and days that failed
//   - on each order that was sent: a "Reem Mall feed" record (app-owned JSON
//     metafield) listing every row sent for it, plus a tag
// The dashboard in the app reads these. Nothing here changes order amounts.

export const DAY_TYPE = '$app:reem_feed_day';
export const SALE_TAG = 'reem-mall-sent';
export const REFUND_TAG = 'reem-mall-refund-sent';

const UPSERT_DAY = `mutation UpsertDay($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id handle } userErrors { field message code } }
}`;
const SET_METAFIELDS = `mutation SetFeed($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
}`;
const ADD_TAGS = `mutation Tag($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;
const REMOVE_TAGS = `mutation Untag($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;
const DELETE_METAFIELDS = `mutation ClearFeed($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
}`;

// status: sent | no_sales | failed | partial
export function dayFields({ day, status, totals, accepted, message, rows, ranAt }) {
  const t = totals || {};
  const f = (key, value) => ({ key, value: String(value ?? '') });
  return [
    f('day', day),
    f('status', status),
    f('invoices', t.invoices ?? 0),
    f('refunds', t.refunds ?? 0),
    f('turnover', (t.turnover ?? 0).toFixed(2)),
    f('discount', (t.discount ?? 0).toFixed(2)),
    f('net', (t.net ?? 0).toFixed(2)),
    f('vat', (t.vat ?? 0).toFixed(2)),
    f('items', t.items ?? 0),
    f('accepted', accepted ?? 0),
    f('ran_at', ranAt),
    f('message', (message || '').slice(0, 250)),
    f('rows', JSON.stringify((rows || []).map((r) => ({
      id: r.transaction_id, order: r._orderId, name: r._orderName, kind: r._kind, at: r.created_at,
      turnover: r.turnover, discount: r.discount, vat: r.vat, items: r.items,
    })))),
  ];
}

export function createLog(graphql) {
  const check = (res, path) => {
    const errs = res?.[path]?.userErrors || [];
    if (errs.length) throw new Error(`${path}: ${errs.map((e) => e.message).join('; ')}`);
    return res[path];
  };

  return {
    async recordDay(entry) {
      const res = await graphql(UPSERT_DAY, {
        handle: { type: DAY_TYPE, handle: `day-${entry.day}` },
        metaobject: { fields: dayFields(entry) },
      });
      return check(res, 'metaobjectUpsert');
    },

    // existing: Map orderId -> previously stored array (from the order query)
    async recordOrders(rows, existing, sentAt) {
      const byOrder = new Map();
      for (const r of rows) {
        if (!byOrder.has(r._orderId)) byOrder.set(r._orderId, { rows: [], kinds: new Set() });
        const o = byOrder.get(r._orderId);
        o.rows.push(r);
        o.kinds.add(r._kind);
      }
      const metafields = [];
      for (const [orderId, o] of byOrder) {
        const history = (existing.get(orderId) || []).filter((h) => !o.rows.some((r) => r.transaction_id === h.id));
        for (const r of o.rows) {
          history.push({
            id: r.transaction_id, kind: r._kind, at: r.created_at, sent_at: sentAt,
            turnover: r.turnover, discount: r.discount, vat: r.vat, items: r.items, status: 'accepted',
          });
        }
        metafields.push({ ownerId: orderId, namespace: '$app', key: 'reem_feed', type: 'json', value: JSON.stringify(history) });
      }
      for (let i = 0; i < metafields.length; i += 25) {
        check(await graphql(SET_METAFIELDS, { metafields: metafields.slice(i, i + 25) }), 'metafieldsSet');
      }
      for (const [orderId, o] of byOrder) {
        const tags = [...o.kinds].map((k) => (k === 'refund' ? REFUND_TAG : SALE_TAG));
        check(await graphql(ADD_TAGS, { id: orderId, tags }), 'tagsAdd');
      }
      return byOrder.size;
    },

    // Excluded (test) orders that were sent before they were excluded: take
    // off the "sent" tags and feed record so they don't look sent in admin.
    async clearOrders(orders) {
      const marked = orders.filter((o) => o.metafield?.value
        || (o.tags || []).some((t) => t === SALE_TAG || t === REFUND_TAG));
      for (let i = 0; i < marked.length; i += 25) {
        const metafields = marked.slice(i, i + 25).map((o) => ({ ownerId: o.id, namespace: '$app', key: 'reem_feed' }));
        check(await graphql(DELETE_METAFIELDS, { metafields }), 'metafieldsDelete');
      }
      for (const o of marked) {
        check(await graphql(REMOVE_TAGS, { id: o.id, tags: [SALE_TAG, REFUND_TAG] }), 'tagsRemove');
      }
      return marked.map((o) => o.name);
    },
  };
}

export function parseExisting(orders) {
  const map = new Map();
  for (const o of orders) {
    try { if (o.metafield?.value) map.set(o.id, JSON.parse(o.metafield.value)); } catch { /* ignore bad value */ }
  }
  return map;
}

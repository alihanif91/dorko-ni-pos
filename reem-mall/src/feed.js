// Builds one night's Vemcount rows from Shopify orders.
//
// Rules (Ziad, 18 Oct 2026; Reem Mall, 20 Oct 2026):
//   - strictly POS sales at the Reem Mall location; nothing online, ever
//   - one row per invoice (sale) and one row per refund, each on the day it
//     happened in Dubai time
//   - test orders are skipped
// Re-sending a day is safe: the same transaction_id updates the same row.
import { saleRow, refundRow, exchangeRow } from './mapping.js';
import { dubaiTime } from '../scripts/scenarios.js';

const sumMoney = (list, pick) => list.reduce((s, x) => s + Number(pick(x)), 0);

// Shopify GraphQL order -> the shape mapping.js expects.
export function normaliseOrder(o) {
  return {
    name: o.name,
    createdAt: dubaiTime(new Date(o.processedAt)),
    currency: o.currencyCode,
    taxesIncluded: o.taxesIncluded,
    lineItems: o.lineItems.nodes.map((li) => ({
      id: li.id,
      quantity: li.quantity,
      unitPrice: li.originalUnitPriceSet.shopMoney.amount,
      discount: sumMoney(li.discountAllocations, (d) => d.allocatedAmountSet.shopMoney.amount).toFixed(2),
      tax: sumMoney(li.taxLines, (t) => t.priceSet.shopMoney.amount).toFixed(2),
      taxRate: li.taxLines[0]?.rate ?? 0,
    })),
  };
}

// Dubai calendar day "YYYY-MM-DD" -> [start, end) as UTC Dates.
export function dubaiDayWindow(day) {
  const start = new Date(`${day}T00:00:00+04:00`);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

// Staff can tag any order with this to keep it away from Reem Mall for good,
// e.g. test or training sales. Its refunds are skipped too.
export const EXCLUDE_TAG = 'no-reem';

// Also never sent: order numbers listed in reem-mall/excluded-orders.txt.
export function loadExcludedOrders(text) {
  return new Set(String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => /^#?\d+$/.test(l)).map((l) => (l.startsWith('#') ? l : `#${l}`)));
}

export function isExcluded(order, excludedNames = new Set()) {
  return excludedNames.has(order.name)
    || (order.tags || []).some((t) => t.trim().toLowerCase() === EXCLUDE_TAG);
}

export function isReemMallPos(order, locationId) {
  return order.sourceName === 'pos' && order.retailLocation?.id === locationId && !order.test;
}

// Nothing is sent for days before the go-live date (REEM_FEED_START_DATE).
// No date set means not live yet: the feed holds everything.
export function isLive(day, startDate) {
  return Boolean(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && day >= startDate;
}

// orders: Shopify orders processed OR updated in the window (refunds can
// arrive on older orders). Returns { rows, skipped, excluded }.
export function buildRows(orders, locationId, { start, end }, excludedNames = new Set()) {
  const rows = [];
  const skipped = [];
  const excluded = [];
  const inWindow = (iso) => { const t = new Date(iso); return t >= start && t < end; };

  for (const o of orders) {
    if (!isReemMallPos(o, locationId)) continue;
    if (isExcluded(o, excludedNames)) {
      const touched = inWindow(o.processedAt) || o.refunds.some((r) => inWindow(r.createdAt));
      if (touched) excluded.push(o.name);
      continue;
    }
    // Native POS exchanges: the new items sit on the same order. They are not
    // part of the original sale, and the exchange is not a refund.
    // In the order's sales history an exchange is a RETURN agreement that
    // both takes items back and adds new ones (sales with action ORDER).
    const exchanges = (o.agreements || [])
      .filter((a) => a.reason === 'RETURN')
      .map((a, i) => {
        const product = a.sales.nodes.filter((x) => x.lineItem);
        return {
          id: `agreement-${i}`,
          createdAt: a.happenedAt,
          added: product.filter((x) => x.actionType === 'ORDER').map((x) => x.lineItem.id),
          returned: product.filter((x) => x.actionType === 'RETURN')
            .map((x) => ({ lineItemId: x.lineItem.id, quantity: Math.abs(x.quantity || 0) })),
        };
      })
      .filter((x) => x.added.length)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    // Returned quantities per line that belong to exchanges, so the matching
    // refund records are recognised and not sent as refunds.
    const exchangedBack = new Map();
    for (const x of exchanges) for (const r of x.returned) exchangedBack.set(r.lineItemId, (exchangedBack.get(r.lineItemId) || 0) + r.quantity);
    const isExchangeRefund = (r) => {
      const n = r.refundLineItems.nodes;
      if (!n.length || !n.every((l) => (exchangedBack.get(l.lineItem.id) || 0) >= l.quantity)) return false;
      for (const l of n) exchangedBack.set(l.lineItem.id, exchangedBack.get(l.lineItem.id) - l.quantity);
      return true;
    };
    const addedIds = new Set(exchanges.flatMap((x) => x.added));

    const order = normaliseOrder(o);
    const original = { ...order, lineItems: order.lineItems.filter((l) => !addedIds.has(l.id)) };
    const produced = new Set();
    const push = (row, kind) => {
      produced.add(row.transaction_id);
      rows.push({ ...row, _orderId: o.id, _orderName: o.name, _kind: kind });
    };
    if (inWindow(o.processedAt)) push(saleRow(original), 'sale');

    exchanges.forEach((x, i) => {
      if (!inWindow(x.createdAt)) return;
      const row = exchangeRow(order, { ...x, createdAt: dubaiTime(new Date(x.createdAt)) }, i + 1);
      if (row) push(row, 'exchange');
    });

    const refunds = [...o.refunds].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    refunds.forEach((r, i) => {
      if (isExchangeRefund(r)) return; // part of an exchange, not money back
      if (!inWindow(r.createdAt)) return;
      const lines = r.refundLineItems.nodes.map((n) => ({ lineItemId: n.lineItem.id, quantity: n.quantity }));
      if (!lines.length) {
        // Money-only refund with no items returned: can't be split into
        // turnover/VAT reliably, so it is reported for manual follow-up.
        skipped.push({ order: o.name, refund: r.id, reason: 'refund without returned items' });
        return;
      }
      push(refundRow(order, { id: r.id, createdAt: dubaiTime(new Date(r.createdAt)), lineItems: lines }, i + 1), 'refund');
    });

    // A row sent earlier for this day that no longer applies (e.g. an exchange
    // first sent as a refund) is sent again as zero, so it cancels out at the
    // mall. Vemcount can't delete single rows.
    let history = [];
    try { history = JSON.parse(o.metafield?.value || '[]'); } catch { history = []; }
    for (const h of history) {
      if (produced.has(h.id) || !h.at || !inWindow(h.at)) continue;
      if (!Number(h.turnover) && !Number(h.discount) && !Number(h.vat) && !Number(h.items)) continue;
      push({
        transaction_id: h.id, created_at: h.at, turnover: 0, discount: 0, vat: 0,
        transactions: 1, items: 0, currency_code: order.currency, category: '',
      }, 'void');
    }
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { rows, skipped, excluded };
}

// Shopify search: every order updated since the window began. That covers
// orders processed in the window (updated_at >= processed_at) and any order
// refunded in it (a refund updates the order), even if the order was touched
// again before the job runs. The exact cut is done in buildRows.
export function searchFor({ start }) {
  const from = new Date(start.getTime() - 3600 * 1000).toISOString();
  return `updated_at:>='${from}'`;
}

// Strips the internal fields (order link etc.) before sending to Vemcount.
export function toVemcount(row) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));
}

// Totals for a set of rows. "net" follows Reem Mall's report:
// turnover + discount (discount is negative on sales).
export function totals(rows) {
  const sum = (k) => Number(rows.reduce((s, r) => s + r[k], 0).toFixed(2));
  return {
    invoices: rows.filter((r) => r._kind === 'sale').length,
    refunds: rows.filter((r) => r._kind === 'refund').length,
    turnover: sum('turnover'),
    discount: sum('discount'),
    net: Number((sum('turnover') + sum('discount')).toFixed(2)),
    vat: sum('vat'),
    items: sum('items'),
  };
}

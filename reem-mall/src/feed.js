// Builds one night's Vemcount rows from Shopify orders.
//
// Rules (Ziad, 18 Oct 2026; Reem Mall, 20 Oct 2026):
//   - strictly POS sales at the Reem Mall location; nothing online, ever
//   - one row per invoice (sale) and one row per refund, each on the day it
//     happened in Dubai time
//   - test orders are skipped
// Re-sending a day is safe: the same transaction_id updates the same row.
import { saleRow, refundRow } from './mapping.js';
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

export function isReemMallPos(order, locationId) {
  return order.sourceName === 'pos' && order.retailLocation?.id === locationId && !order.test;
}

// orders: Shopify orders processed OR updated in the window (refunds can
// arrive on older orders). Returns { rows, skipped }.
export function buildRows(orders, locationId, { start, end }) {
  const rows = [];
  const skipped = [];
  const inWindow = (iso) => { const t = new Date(iso); return t >= start && t < end; };

  for (const o of orders) {
    if (!isReemMallPos(o, locationId)) continue;
    const order = normaliseOrder(o);
    if (inWindow(o.processedAt)) rows.push({ ...saleRow(order), _orderId: o.id, _orderName: o.name, _kind: 'sale' });

    const refunds = [...o.refunds].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    refunds.forEach((r, i) => {
      if (!inWindow(r.createdAt)) return;
      const lines = r.refundLineItems.nodes.map((n) => ({ lineItemId: n.lineItem.id, quantity: n.quantity }));
      if (!lines.length) {
        // Money-only refund with no items returned: can't be split into
        // turnover/VAT reliably, so it is reported for manual follow-up.
        skipped.push({ order: o.name, refund: r.id, reason: 'refund without returned items' });
        return;
      }
      rows.push({
        ...refundRow(order, { id: r.id, createdAt: dubaiTime(new Date(r.createdAt)), lineItems: lines }, i + 1),
        _orderId: o.id, _orderName: o.name, _kind: 'refund',
      });
    });
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { rows, skipped };
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

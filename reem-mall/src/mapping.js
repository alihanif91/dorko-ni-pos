// Turns Shopify orders and refunds into Vemcount sales rows.
//
// Reem Mall's format (Harshit, 6 Oct 2026, and the Vemcount ingestion doc):
//   turnover  = sale value before VAT and before discount
//   discount  = discount before VAT, as a NEGATIVE number on sales
//   vat       = VAT amount, separately
//   items     = quantity sold
//   one row per invoice, with the real invoice timestamp
//   refunds   = their own row: negative turnover, own transaction_id,
//               category "refund" (full) or "partial-refund"
// Example: 1,100 list price, 100 discount, 5% VAT -> paid 1,050
//   -> turnover 1100.00, discount -100.00, vat 50.00
//
// A refund row mirrors the sale with every sign flipped, so a sale plus its
// full refund nets to zero in every column (discount becomes positive).
//
// All maths is done in fils (integers) to avoid floating-point errors.
//
// Input shape (normalised from the Shopify Admin API):
//   order = { name, createdAt, currency, taxesIncluded, lineItems: [
//     { id, quantity, unitPrice, discount, tax, taxRate } ] }
//   unitPrice / discount / tax are decimal strings or numbers in the shop
//   currency; discount and tax are line totals (all units); taxRate e.g. 0.05.
//   refund = { id, createdAt, lineItems: [{ lineItemId, quantity }] }

const toFils = (v) => Math.round(Number(v) * 100);
const toAed = (fils) => Number((fils / 100).toFixed(2));

// Invoice number as shown on the receipt, without the "#".
export function invoiceId(orderName) {
  return String(orderName).replace(/^#/, '').trim();
}

// Splits one line (or part of it) into turnover / discount / vat in fils.
function lineParts(line, qty, taxesIncluded) {
  const share = qty / line.quantity;
  const gross = toFils(line.unitPrice) * qty;
  const disc = Math.round(toFils(line.discount || 0) * share);
  const tax = Math.round(toFils(line.tax || 0) * share);
  if (!taxesIncluded) {
    return { turnover: gross, discount: disc, vat: tax, paid: gross - disc + tax };
  }
  // Prices include VAT: strip VAT from the discounted amount, and from the
  // discount itself, so turnover is "before VAT and before discount".
  const rate = Number(line.taxRate ?? 0);
  const netExVat = gross - disc - tax;
  const discExVat = Math.round(disc / (1 + rate));
  return { turnover: netExVat + discExVat, discount: discExVat, vat: tax, paid: gross - disc };
}

function sum(parts) {
  return parts.reduce((a, p) => ({
    turnover: a.turnover + p.turnover,
    discount: a.discount + p.discount,
    vat: a.vat + p.vat,
    paid: a.paid + p.paid,
  }), { turnover: 0, discount: 0, vat: 0, paid: 0 });
}

// Keeps turnover - discount + vat equal to what the customer actually paid,
// to the fil, by absorbing any 1-fil rounding into turnover.
function reconcile(t) {
  const diff = t.paid - (t.turnover - t.discount + t.vat);
  return { ...t, turnover: t.turnover + diff };
}

export function saleRow(order) {
  const t = reconcile(sum(order.lineItems.map((l) => lineParts(l, l.quantity, order.taxesIncluded))));
  return {
    transaction_id: invoiceId(order.name),
    created_at: order.createdAt,
    turnover: toAed(t.turnover),
    discount: toAed(-t.discount),
    vat: toAed(t.vat),
    transactions: 1,
    items: order.lineItems.reduce((n, l) => n + l.quantity, 0),
    currency_code: order.currency,
    category: '',
  };
}

// refundIndex: 1 for the order's first refund, 2 for the second, and so on.
export function refundRow(order, refund, refundIndex = 1) {
  const byId = new Map(order.lineItems.map((l) => [l.id, l]));
  const parts = refund.lineItems.map((r) => {
    const line = byId.get(r.lineItemId);
    if (!line) throw new Error(`Refund ${refund.id} has an unknown line item ${r.lineItemId}`);
    if (r.quantity > line.quantity) throw new Error(`Refund ${refund.id} returns more than was sold`);
    return lineParts(line, r.quantity, order.taxesIncluded);
  });
  const t = reconcile(sum(parts));
  const refundedQty = refund.lineItems.reduce((n, r) => n + r.quantity, 0);
  const soldQty = order.lineItems.reduce((n, l) => n + l.quantity, 0);
  return {
    transaction_id: `${invoiceId(order.name)}-R${refundIndex}`,
    created_at: refund.createdAt,
    turnover: toAed(-t.turnover),
    discount: toAed(t.discount),
    vat: toAed(-t.vat),
    transactions: 1,
    items: -refundedQty,
    currency_code: order.currency,
    category: refundedQty >= soldQty ? 'refund' : 'partial-refund',
  };
}

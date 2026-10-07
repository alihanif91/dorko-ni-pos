// Cart helpers shared by the tile and the modal.
//
// After the terminal approves, we stamp the approval onto the cart as cart
// properties. Cart properties carry through to the order, so the NI
// reference ends up on the order itself without a separate Admin API call.
// (To confirm on the dev store: check how these appear on the order record.)
//
// Keys start with "_" so they stay out of customer-facing views.

export const PROP = {
  sourceId: '_ni_source_id',
  amount: '_ni_amount',
  approvalCode: '_ni_approval_code',
  rrn: '_ni_rrn',
};

// Cart totals are currency strings. Convert to integer minor units (fils) so
// we never compare or send floating-point money.
export function toMinorUnits(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.\-]/g, '');
  if (!cleaned || isNaN(Number(cleaned))) return 0;
  const negative = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const minor = Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -minor : minor;
}

export function formatMinor(minor, currency) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

// What state is the cart in, from the terminal's point of view?
//  - empty:     nothing to charge
//  - unpaid:    has a total, no approval yet
//  - approved:  approval matches the current total, cashier can tender
//  - stale:     approved earlier, but the total changed since (item added,
//               discount applied). Must void and charge again.
export function cartPaymentState(cart) {
  const total = toMinorUnits(cart?.grandTotal);
  const props = cart?.properties || {};
  if (total <= 0) return { state: 'empty', total };
  if (!props[PROP.sourceId]) return { state: 'unpaid', total };
  const approvedAmount = Number(props[PROP.amount]);
  if (approvedAmount === total) {
    return { state: 'approved', total, sourceId: props[PROP.sourceId] };
  }
  return { state: 'stale', total, approvedAmount, sourceId: props[PROP.sourceId] };
}

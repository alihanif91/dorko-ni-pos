// Harshit's (Reem Mall IT) test scenarios, 19 Oct 2026, built from sample
// Shopify orders so the real mapping code is what gets tested.
// Transaction IDs start with TEST- so Reem Mall can find and clear them.
// Re-sending the same IDs updates the rows instead of duplicating them.
import { saleRow, refundRow } from '../src/mapping.js';

// Dubai time, ISO 8601 with offset, e.g. 2026-10-19T21:30:00+04:00
export function dubaiTime(date) {
  const d = new Date(date.getTime() + 4 * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, '+04:00');
}

export function buildScenarios(now = new Date()) {
  const at = (minutesAgo) => dubaiTime(new Date(now.getTime() - minutesAgo * 60000));
  const tshirt = (id, discount = 0) => ({
    id, quantity: 1, unitPrice: '210.00', discount, taxRate: 0.05,
    tax: ((210 - discount) / 1.05 * 0.05).toFixed(2),
  });
  const cap = (id, discount = 0) => ({
    id, quantity: 1, unitPrice: '105.00', discount, taxRate: 0.05,
    tax: ((105 - discount) / 1.05 * 0.05).toFixed(2),
  });
  const order = (name, minutesAgo, lineItems) => ({
    name, createdAt: at(minutesAgo), currency: 'AED', taxesIncluded: true, lineItems,
  });

  const normal = order('#TEST-1001', 50, [tshirt('a1')]);
  const discounted = order('#TEST-1002', 45, [tshirt('b1', 21), cap('b2', 10.5)]);
  const discountedForPartial = order('#TEST-1003', 40, [tshirt('c1', 21), cap('c2', 10.5)]);

  return [
    { name: '1. Normal sale', note: 'T-shirt 210.00 incl. VAT, no discount',
      rows: [saleRow(normal)] },
    { name: '2. Sale with discount', note: 'T-shirt 210.00 + Cap 105.00, 10% discount (paid 283.50). TEST-1003 is the same sale, used for the partial return',
      rows: [saleRow(discounted), saleRow(discountedForPartial)] },
    { name: '3. Full return', note: 'Full return of TEST-1001',
      rows: [refundRow(normal, { id: 'r1', createdAt: at(30), lineItems: [{ lineItemId: 'a1', quantity: 1 }] })] },
    { name: '4. Partial return', note: 'Cap returned from TEST-1003 (paid 94.50 for it after discount)',
      rows: [refundRow(discountedForPartial, { id: 'r2', createdAt: at(20), lineItems: [{ lineItemId: 'c2', quantity: 1 }] })] },
    { name: '5. Full return with discount', note: 'Full return of discounted sale TEST-1002',
      rows: [refundRow(discounted, { id: 'r3', createdAt: at(10), lineItems: [{ lineItemId: 'b1', quantity: 1 }, { lineItemId: 'b2', quantity: 1 }] })] },
  ];
}

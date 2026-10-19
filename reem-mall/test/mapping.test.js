import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleRow, refundRow, invoiceId } from '../src/mapping.js';
import { buildScenarios, dubaiTime } from '../scripts/scenarios.js';
import { createVemcount } from '../src/vemcount.js';

const line = (id, qty, unit, discount, tax) => ({ id, quantity: qty, unitPrice: unit, discount, tax, taxRate: 0.05 });
const order = (lineItems, taxesIncluded = true) =>
  ({ name: '#1001', createdAt: '2026-10-19T12:00:00+04:00', currency: 'AED', taxesIncluded, lineItems });
const paid = (r) => Number((r.turnover + r.discount + r.vat).toFixed(2));

test("Harshit's example: 1,100 with 100 discount and 5% VAT, prices excluding VAT", () => {
  const r = saleRow(order([line('a', 1, '1100.00', '100.00', '50.00')], false));
  assert.deepEqual([r.turnover, r.discount, r.vat], [1100, -100, 50]);
  assert.equal(paid(r), 1050);
});

test('same sale with VAT-inclusive prices (how Shopify POS in the UAE works)', () => {
  // 1,155 incl. VAT, 105 discount incl. VAT -> customer pays 1,050
  const r = saleRow(order([line('a', 1, '1155.00', '105.00', '50.00')]));
  assert.deepEqual([r.turnover, r.discount, r.vat], [1100, -100, 50]);
  assert.equal(paid(r), 1050);
});

test('normal sale, quantity and invoice number', () => {
  const r = saleRow(order([line('a', 2, '105.00', 0, '10.00')]));
  assert.deepEqual([r.transaction_id, r.turnover, r.discount, r.vat, r.items], ['1001', 200, 0, 10, 2]);
  assert.equal(invoiceId('#TEST-1002'), 'TEST-1002');
});

test('full refund mirrors the sale with all signs flipped', () => {
  const o = order([line('a', 1, '210.00', '21.00', '9.00'), line('b', 1, '105.00', '10.50', '4.50')]);
  const sale = saleRow(o);
  const ref = refundRow(o, { id: 'r', createdAt: o.createdAt, lineItems: [{ lineItemId: 'a', quantity: 1 }, { lineItemId: 'b', quantity: 1 }] });
  assert.deepEqual([sale.turnover, sale.discount, sale.vat, sale.items], [300, -30, 13.5, 2]);
  assert.deepEqual([ref.turnover, ref.discount, ref.vat, ref.items], [-300, 30, -13.5, -2]);
  assert.equal(ref.transaction_id, '1001-R1');
  assert.equal(ref.category, 'refund');
});

test('partial refund of one unit out of three', () => {
  const o = order([line('a', 3, '105.00', '31.50', '13.50')]);
  const ref = refundRow(o, { id: 'r', createdAt: o.createdAt, lineItems: [{ lineItemId: 'a', quantity: 1 }] }, 2);
  assert.deepEqual([ref.turnover, ref.discount, ref.vat, ref.items, ref.category], [-100, 10, -4.5, -1, 'partial-refund']);
  assert.equal(ref.transaction_id, '1001-R2');
});

test('rounding never breaks turnover + discount + VAT = amount paid', () => {
  const o = order([line('a', 3, '33.33', '3.33', '4.29'), line('b', 1, '19.99', 0, '0.95')]);
  const r = saleRow(o);
  assert.equal(paid(r), Number((99.99 - 3.33 + 19.99).toFixed(2)));
});

test('refund rejects unknown lines and over-returns', () => {
  const o = order([line('a', 1, '105.00', 0, '5.00')]);
  assert.throws(() => refundRow(o, { id: 'r', lineItems: [{ lineItemId: 'x', quantity: 1 }] }), /unknown line item/);
  assert.throws(() => refundRow(o, { id: 'r', lineItems: [{ lineItemId: 'a', quantity: 2 }] }), /more than was sold/);
});

test("Harshit's five scenarios produce the expected rows", () => {
  const s = buildScenarios(new Date('2026-10-19T17:00:00Z'));
  const pick = (r) => [r.transaction_id, r.turnover, r.discount, r.vat, r.items, r.category];
  assert.deepEqual(s[0].rows.map(pick), [['TEST-1001', 200, 0, 10, 1, '']]);
  assert.deepEqual(s[1].rows.map(pick), [['TEST-1002', 300, -30, 13.5, 2, ''], ['TEST-1003', 300, -30, 13.5, 2, '']]);
  assert.deepEqual(s[2].rows.map(pick), [['TEST-1001-R1', -200, 0, -10, -1, 'refund']]);
  assert.deepEqual(s[3].rows.map(pick), [['TEST-1003-R1', -100, 10, -4.5, -1, 'partial-refund']]);
  assert.deepEqual(s[4].rows.map(pick), [['TEST-1002-R1', -300, 30, -13.5, -2, 'refund']]);
  assert.equal(s[0].rows[0].created_at, '2026-10-19T20:10:00+04:00');
  assert.equal(dubaiTime(new Date('2026-10-19T17:00:00Z')), '2026-10-19T21:00:00+04:00');
});

test('vemcount client: gets a token once, sends sales as a direct array', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (url.endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 21600 }) };
    return { ok: true, status: 200, json: async () => ({ accepted: 1, results: [{ transaction_id: 'x', action: 'created' }] }) };
  };
  const v = createVemcount({ clientId: 'id', clientSecret: 'sec', fetchImpl });
  await v.pushSales([{ transaction_id: 'x' }]);
  await v.pushSales([{ transaction_id: 'y' }]);
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1);
  const push = calls.find((c) => c.url.endsWith('/api/v4/integrations/sales-data'));
  assert.equal(push.auth, 'Bearer tok');
  assert.ok(Array.isArray(push.body.sales));
  assert.equal(push.body.client_secret, undefined);
});

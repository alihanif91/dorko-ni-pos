import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, dubaiDayWindow, normaliseOrder, searchFor } from '../src/feed.js';

const REEM = 'gid://shopify/Location/1';
const money = (a) => ({ shopMoney: { amount: String(a) } });
const li = (id, qty, unit, disc, tax) => ({
  id, quantity: qty, originalUnitPriceSet: money(unit),
  discountAllocations: disc ? [{ allocatedAmountSet: money(disc) }] : [],
  taxLines: [{ rate: 0.05, priceSet: money(tax) }],
});
const order = (over = {}) => ({
  id: 'o1', name: '#1001', processedAt: '2026-10-21T10:00:00Z', sourceName: 'pos', test: false,
  taxesIncluded: true, currencyCode: 'AED', retailLocation: { id: REEM, name: 'Reem Mall Shop' },
  lineItems: { nodes: [li('l1', 1, '210.00', '21.00', '9.00'), li('l2', 1, '105.00', '10.50', '4.50')] },
  refunds: [], ...over,
});
const day = dubaiDayWindow('2026-10-21');

test('Dubai day window is midnight to midnight +04:00', () => {
  assert.equal(day.start.toISOString(), '2026-10-20T20:00:00.000Z');
  assert.equal(day.end.toISOString(), '2026-10-21T20:00:00.000Z');
  assert.equal(searchFor(day), "updated_at:>='2026-10-20T19:00:00.000Z'");
});

test('Shopify order is normalised and mapped like the approved test rows', () => {
  const { rows } = buildRows([order()], REEM, day);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.transaction_id, r.turnover, r.discount, r.vat, r.items], ['1001', 300, -30, 13.5, 2]);
  assert.equal(r.created_at, '2026-10-21T14:00:00+04:00');
  assert.equal(normaliseOrder(order()).lineItems[0].discount, '21.00');
});

test('only Reem Mall POS, never online, other locations or test orders', () => {
  const orders = [
    order({ id: 'a', name: '#2001', sourceName: 'web' }),
    order({ id: 'b', name: '#2002', retailLocation: { id: 'gid://shopify/Location/9' } }),
    order({ id: 'c', name: '#2003', test: true }),
    order({ id: 'd', name: '#2004', retailLocation: null, sourceName: 'pos' }),
    order({ id: 'e', name: '#2005' }),
  ];
  assert.deepEqual(buildRows(orders, REEM, day).rows.map((r) => r.transaction_id), ['2005']);
});

test('sales outside the day are not re-sent; refunds land on the day they happen', () => {
  const old = order({
    processedAt: '2026-10-19T10:00:00Z',
    refunds: [
      { id: 'r1', createdAt: '2026-10-20T08:00:00Z', refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'l2' } }] } },
      { id: 'r2', createdAt: '2026-10-21T09:00:00Z', refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'l1' } }] } },
    ],
  });
  const { rows } = buildRows([old], REEM, day);
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.turnover, r.category]), [['1001-R2', -200, 'partial-refund']]);
});

test('money-only refunds are flagged instead of guessed', () => {
  const o = order({ refunds: [{ id: 'r9', createdAt: '2026-10-21T12:00:00Z', refundLineItems: { nodes: [] } }] });
  const { rows, skipped } = buildRows([o], REEM, day);
  assert.equal(rows.length, 1);
  assert.equal(skipped[0].reason, 'refund without returned items');
});

import { isExcluded, loadExcludedOrders } from '../src/feed.js';

test('orders tagged no-reem are never sent, nor their refunds', () => {
  const tagged = order({
    tags: ['Staff test', 'NO-REEM'],
    refunds: [{ id: 'r1', createdAt: '2026-10-21T12:00:00Z', refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'l1' } }] } }],
  });
  assert.equal(isExcluded(tagged), true);
  const { rows, excluded } = buildRows([tagged, order({ id: 'o2', name: '#1002' })], REEM, day);
  assert.deepEqual(rows.map((r) => r.transaction_id), ['1002']);
  assert.deepEqual(excluded, ['#1001']);
});

test('orders listed in excluded-orders.txt are skipped with their refunds', () => {
  const names = loadExcludedOrders('# comment\n#1001\n1005\nnot an order\n');
  assert.deepEqual([...names], ['#1001', '#1005']);
  const o = order({ refunds: [{ id: 'r1', createdAt: '2026-10-21T12:00:00Z', refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'l1' } }] } }] });
  const { rows, excluded } = buildRows([o], REEM, day, names);
  assert.equal(rows.length, 0);
  assert.deepEqual(excluded, ['#1001']);
});

// Order #1098, 25 Oct: 1 pair sold at 429, swapped for another pair at 429
// with POS "Return or exchange". Shopify adds the new pair to the order and
// records a refund for the returned pair.
const exchanged = (over = {}) => order({
  id: 'o98', name: '#1098', processedAt: '2026-10-21T09:51:00Z',
  lineItems: { nodes: [li('l1', 1, '429.00', 0, '20.43'), li('l9', 1, '429.00', 0, '20.43')] },
  refunds: [{ id: 'r1', createdAt: '2026-10-21T10:53:00Z',
    refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'l1' } }] } }],
  agreements: [
    { happenedAt: '2026-10-21T09:51:00Z', reason: 'ORDER', sales: { nodes: [{ actionType: 'ORDER', quantity: 1, lineItem: { id: 'l1' } }] } },
    { happenedAt: '2026-10-21T10:53:00Z', reason: 'RETURN', sales: { nodes: [
      { actionType: 'RETURN', quantity: -1, lineItem: { id: 'l1' } },
      { actionType: 'ORDER', quantity: 1, lineItem: { id: 'l9' } },
    ] } },
  ],
  ...over,
});

test('an even POS exchange is not a refund: one sale of the original item, nothing else', () => {
  const { rows } = buildRows([exchanged()], REEM, day);
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.turnover, r.vat, r.items]), [['1098', 408.57, 20.43, 1]]);
});

test('an exchange with a price difference sends only the difference', () => {
  const o = exchanged({ lineItems: { nodes: [li('l1', 1, '429.00', 0, '20.43'), li('l9', 1, '525.00', 0, '25.00')] } });
  const { rows } = buildRows([o], REEM, day);
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.turnover, r.vat, r.items, r.category]),
    [['1098', 408.57, 20.43, 1, ''], ['1098-X1', 91.43, 4.57, 0, '']]);
});

test('an exchange on a later day leaves the earlier sale alone', () => {
  const o = exchanged({ processedAt: '2026-10-19T09:51:00Z' });
  assert.deepEqual(buildRows([o], REEM, day).rows, []);
});

test('a refund sent earlier for what was really an exchange is cancelled with a zero row', () => {
  const sent = [
    { id: '1098', at: '2026-10-21T13:51:00+04:00', turnover: 817.14, discount: 0, vat: 40.86, items: 2 },
    { id: '1098-R1', at: '2026-10-21T14:53:00+04:00', turnover: -408.57, discount: 0, vat: -20.43, items: -1 },
  ];
  const o = exchanged({ metafield: { value: JSON.stringify(sent) } });
  const { rows } = buildRows([o], REEM, day);
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.turnover, r.vat, r.items]),
    [['1098', 408.57, 20.43, 1], ['1098-R1', 0, 0, 0]]);
});

test('a plain return (no new items) is still a refund', () => {
  const o = exchanged({ agreements: [{ happenedAt: '2026-10-21T10:53:00Z', reason: 'RETURN',
    sales: { nodes: [{ actionType: 'RETURN', quantity: -1, lineItem: { id: 'l1' } }] } }] });
  const { rows } = buildRows([o], REEM, day);
  assert.deepEqual(rows.map((r) => r.transaction_id), ['1098', '1098-R1']);
});

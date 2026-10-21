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

import { isLive, isExcluded } from '../src/feed.js';

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

test('go-live date: nothing before it, and nothing at all without one', () => {
  assert.equal(isLive('2026-10-20', '2026-10-25'), false);
  assert.equal(isLive('2026-10-25', '2026-10-25'), true);
  assert.equal(isLive('2026-10-26', '2026-10-25'), true);
  assert.equal(isLive('2026-10-26', ''), false);
  assert.equal(isLive('2026-10-26', 'soon'), false);
});

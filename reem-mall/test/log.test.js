import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog, dayFields, parseExisting, DAY_TYPE, SALE_TAG, REFUND_TAG } from '../src/log.js';
import { totals, toVemcount } from '../src/feed.js';

const sale = { transaction_id: '1001', created_at: 't1', turnover: 300, discount: -30, vat: 13.5, items: 2, _orderId: 'gid://shopify/Order/1', _orderName: '#1001', _kind: 'sale' };
const refund = { transaction_id: '1001-R1', created_at: 't2', turnover: -100, discount: 10, vat: -4.5, items: -1, _orderId: 'gid://shopify/Order/1', _orderName: '#1001', _kind: 'refund' };

test('totals follow Reem Mall: net = turnover + discount', () => {
  assert.deepEqual(totals([sale, refund]), { invoices: 1, refunds: 1, turnover: 200, discount: -20, net: 180, vat: 9, items: 1 });
});

test('internal fields never reach Vemcount', () => {
  assert.deepEqual(Object.keys(toVemcount(sale)).filter((k) => k.startsWith('_')), []);
});

test('a day with no sales is still recorded', async () => {
  const calls = [];
  const log = createLog(async (q, v) => { calls.push(v); return { metaobjectUpsert: { metaobject: { id: 'm' }, userErrors: [] } }; });
  await log.recordDay({ day: '2026-10-21', status: 'no_sales', rows: [], totals: totals([]), ranAt: 'now' });
  assert.deepEqual(calls[0].handle, { type: DAY_TYPE, handle: 'day-2026-10-21' });
  const f = Object.fromEntries(calls[0].metaobject.fields.map((x) => [x.key, x.value]));
  assert.equal(f.status, 'no_sales');
  assert.equal(f.invoices, '0');
  assert.equal(f.rows, '[]');
});

test('day fields carry totals and rows with order links', () => {
  const f = Object.fromEntries(dayFields({ day: 'd', status: 'sent', totals: totals([sale]), accepted: 1, rows: [sale], ranAt: 'r' }).map((x) => [x.key, x.value]));
  assert.equal(f.net, '270.00');
  assert.equal(JSON.parse(f.rows)[0].order, 'gid://shopify/Order/1');
});

test('orders get one merged history record and the right tags; re-sends replace, not duplicate', async () => {
  const calls = [];
  const log = createLog(async (q, v) => {
    calls.push({ q, v });
    if (q.includes('metafieldsSet')) return { metafieldsSet: { metafields: [], userErrors: [] } };
    return { tagsAdd: { node: { id: v.id }, userErrors: [] } };
  });
  const existing = parseExisting([{ id: 'gid://shopify/Order/1', metafield: { value: JSON.stringify([{ id: '1001', kind: 'sale', sent_at: 'old' }]) } }]);
  const n = await log.recordOrders([sale, refund], existing, 'now');
  assert.equal(n, 1);
  const history = JSON.parse(calls.find((c) => c.q.includes('metafieldsSet')).v.metafields[0].value);
  assert.deepEqual(history.map((h) => [h.id, h.sent_at]), [['1001', 'now'], ['1001-R1', 'now']]);
  assert.deepEqual(calls.find((c) => c.q.includes('tagsAdd')).v.tags.sort(), [REFUND_TAG, SALE_TAG].sort());
});

test('Shopify errors surface instead of being silently ignored', async () => {
  const log = createLog(async () => ({ metaobjectUpsert: { userErrors: [{ message: 'Access denied' }] } }));
  await assert.rejects(log.recordDay({ day: 'd', status: 'sent', ranAt: 'r' }), /Access denied/);
});

test('clearOrders removes feed marks only from orders that have them', async () => {
  const calls = [];
  const log = createLog(async (q, v) => {
    calls.push({ q, v });
    return q.includes('metafieldsDelete')
      ? { metafieldsDelete: { deletedMetafields: [], userErrors: [] } }
      : { tagsRemove: { node: { id: v.id }, userErrors: [] } };
  });
  const cleared = await log.clearOrders([
    { id: 'gid://shopify/Order/1', name: '#1082', tags: [SALE_TAG], metafield: { value: '[]' } },
    { id: 'gid://shopify/Order/2', name: '#1083', tags: ['no-reem'], metafield: null },
  ]);
  assert.deepEqual(cleared, ['#1082']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].v.metafields, [{ ownerId: 'gid://shopify/Order/1', namespace: '$app', key: 'reem_feed' }]);
  assert.deepEqual(calls[1].v, { id: 'gid://shopify/Order/1', tags: [SALE_TAG, REFUND_TAG] });
});

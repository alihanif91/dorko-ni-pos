import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDays, withMissingDays, filterDays, summarise, byMonth, searchRows, orderLink, yesterdayInDubai, months,
} from '../shopify-app/extensions/reem-dashboard/src/data.js';
import { dayFields } from '../src/log.js';
import { totals } from '../src/feed.js';

const sale = { transaction_id: '1045', created_at: '2026-10-22T18:10:00+04:00', turnover: 300, discount: -30, vat: 13.5, items: 2, _orderId: 'gid://shopify/Order/77', _orderName: '#1045', _kind: 'sale' };
const node = (entry) => ({ handle: `day-${entry.day}`, fields: dayFields(entry) });

const nodes = [
  node({ day: '2026-10-22', status: 'sent', totals: totals([sale]), accepted: 1, rows: [sale], ranAt: 'x' }),
  node({ day: '2026-10-23', status: 'no_sales', totals: totals([]), rows: [], ranAt: 'x' }),
  node({ day: '2026-11-01', status: 'failed', totals: totals([]), rows: [], message: 'timeout', ranAt: 'x' }),
];

test('the dashboard reads exactly what the nightly job writes', () => {
  const days = parseDays(nodes);
  assert.deepEqual(days.map((d) => d.day), ['2026-11-01', '2026-10-23', '2026-10-22']);
  assert.equal(days[2].net, 270);
  assert.equal(days[2].rows[0].order, 'gid://shopify/Order/77');
});

test('nights with no record show up as "No record", not silence', () => {
  const days = withMissingDays(parseDays(nodes), '2026-11-02');
  const missing = days.filter((d) => d.status === 'missing').map((d) => d.day);
  assert.ok(missing.includes('2026-10-24'));
  assert.ok(missing.includes('2026-11-02'));
  assert.ok(!missing.includes('2026-10-22'));
});

test('filters, monthly accounting and search', () => {
  const days = parseDays(nodes);
  assert.deepEqual(months(days), ['2026-11', '2026-10']);
  assert.equal(filterDays(days, { month: '2026-10' }).length, 2);
  assert.equal(filterDays(days, { status: 'failed' })[0].day, '2026-11-01');
  const oct = summarise(filterDays(days, { month: '2026-10' }));
  assert.deepEqual([oct.sent, oct.no_sales, oct.invoices, oct.net, oct.vat], [1, 1, 1, 270, 13.5]);
  assert.equal(byMonth(days)[1].net, 270);
  assert.equal(searchRows(days, '#1045')[0].day, '2026-10-22');
  assert.equal(orderLink('gid://shopify/Order/77'), 'shopify://admin/orders/77');
  assert.equal(yesterdayInDubai(new Date('2026-10-22T21:00:00Z')), '2026-10-22');
});

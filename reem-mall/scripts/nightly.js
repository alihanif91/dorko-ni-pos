// Nightly Reem Mall feed: yesterday's (Dubai time) POS sales and refunds at
// the Reem Mall location -> Vemcount.
//
// Usage: node scripts/nightly.js <dry-run|send> [YYYY-MM-DD] [out.json]
//   no date = yesterday in Dubai. Re-running a day is safe (rows update).
// Env: DORKO_SHOP, DORKO_SHOPIFY_CLIENT_ID, DORKO_SHOPIFY_CLIENT_SECRET,
//      REEM_LOCATION_NAME (default "Reem Mall Shop"),
//      VEMCOUNT_CLIENT_ID, VEMCOUNT_CLIENT_SECRET, VEMCOUNT_BASE_URL (send only)
import { writeFileSync } from 'node:fs';
import { createShopify } from '../src/shopify.js';
import { createVemcount } from '../src/vemcount.js';
import { buildRows, dubaiDayWindow, searchFor } from '../src/feed.js';

const [mode = 'dry-run', dayArg, out] = process.argv.slice(2);
const env = process.env;

function yesterdayInDubai(now = new Date()) {
  const dubai = new Date(now.getTime() + 4 * 3600 * 1000);
  dubai.setUTCDate(dubai.getUTCDate() - 1);
  return dubai.toISOString().slice(0, 10);
}

const day = dayArg && /^\d{4}-\d{2}-\d{2}$/.test(dayArg) ? dayArg : yesterdayInDubai();
const report = { mode, day, ranAt: new Date().toISOString() };
let exitCode = 0;

try {
  const shopify = createShopify({
    shop: env.DORKO_SHOP || '6zhh3e-ne.myshopify.com',
    clientId: env.DORKO_SHOPIFY_CLIENT_ID,
    clientSecret: env.DORKO_SHOPIFY_CLIENT_SECRET,
  });
  const location = await shopify.findLocation(env.REEM_LOCATION_NAME || 'Reem Mall Shop');
  report.location = location.name;
  const window = dubaiDayWindow(day);
  const orders = await shopify.orders(searchFor(window));
  const { rows, skipped } = buildRows(orders, location.id, window);
  Object.assign(report, { ordersScanned: orders.length, rows, skipped });

  const total = (k) => Number(rows.reduce((s, r) => s + r[k], 0).toFixed(2));
  report.totals = { rows: rows.length, turnover: total('turnover'), discount: total('discount'), vat: total('vat'), items: total('items') };
  console.log(`${day} (Dubai): ${rows.length} rows from ${orders.length} orders scanned at "${location.name}"`);
  console.table(rows.map(({ transaction_id, created_at, turnover, discount, vat, items, category }) =>
    ({ transaction_id, created_at, turnover, discount, vat, items, category })));
  console.log('totals', report.totals);
  if (skipped.length) console.warn('NEEDS A LOOK:', skipped);

  if (mode === 'send' && rows.length) {
    const vemcount = createVemcount({
      baseUrl: env.VEMCOUNT_BASE_URL || 'https://vemcount.app',
      clientId: env.VEMCOUNT_CLIENT_ID,
      clientSecret: env.VEMCOUNT_CLIENT_SECRET,
    });
    report.responses = [];
    for (let i = 0; i < rows.length; i += 100) {           // batches of 100
      report.responses.push(await vemcount.pushSales(rows.slice(i, i + 100)));
    }
    const accepted = report.responses.reduce((n, r) => n + (r.accepted || 0), 0);
    report.accepted = accepted;
    console.log(`Vemcount accepted ${accepted}/${rows.length}`);
    if (accepted !== rows.length) exitCode = 1;
  }
  if (skipped.length) exitCode = exitCode || 2;
} catch (err) {
  report.error = { message: err.message, status: err.status, body: err.body };
  console.error(err.message);
  exitCode = 1;
}

if (out) writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(exitCode);

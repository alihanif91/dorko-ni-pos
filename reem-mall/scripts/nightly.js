// Nightly Reem Mall feed: yesterday's (Dubai time) POS sales and refunds at
// the Reem Mall location -> Vemcount, then a record of it in Shopify.
//
// Usage: node scripts/nightly.js <dry-run|send> [YYYY-MM-DD] [out.json]
//   no date = yesterday in Dubai. Re-running a day is safe (rows update).
//   dry-run reads only: nothing is sent and nothing is written to Shopify.
// Env: DORKO_SHOP, DORKO_SHOPIFY_CLIENT_ID, DORKO_SHOPIFY_CLIENT_SECRET,
//      REEM_LOCATION_NAME (default "Reem Mall Shop"),
//      REEM_LOG_ENABLED ("true" to write the day log + order records),
//      (orders tagged no-reem or listed in excluded-orders.txt are never sent)
//      REEM_CATCHUP ("true" on backup runs: skip if the day is already done),
//      VEMCOUNT_CLIENT_ID, VEMCOUNT_CLIENT_SECRET, VEMCOUNT_BASE_URL (send only)
// Exit codes: 0 ok, 1 send failed, 2 something needs a look, 3 sent but the
// Shopify log could not be written.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createShopify } from '../src/shopify.js';
import { createVemcount } from '../src/vemcount.js';
import { buildRows, dubaiDayWindow, searchFor, toVemcount, totals, loadExcludedOrders, EXCLUDE_TAG } from '../src/feed.js';
import { createLog, parseExisting } from '../src/log.js';

const [mode = 'dry-run', dayArg, out] = process.argv.slice(2);
const env = process.env;
const logEnabled = env.REEM_LOG_ENABLED === 'true' && mode === 'send';
const excludedFile = new URL('../excluded-orders.txt', import.meta.url);
const excludedNames = loadExcludedOrders(existsSync(excludedFile) ? readFileSync(excludedFile, 'utf8') : '');

function yesterdayInDubai(now = new Date()) {
  const dubai = new Date(now.getTime() + 4 * 3600 * 1000);
  dubai.setUTCDate(dubai.getUTCDate() - 1);
  return dubai.toISOString().slice(0, 10);
}

const day = dayArg && /^\d{4}-\d{2}-\d{2}$/.test(dayArg) ? dayArg : yesterdayInDubai();
const report = { mode, day, ranAt: new Date().toISOString(), logEnabled };
let exitCode = 0;
let shopify = null;
let rows = [];
let status = 'failed';
let message = '';

try {
  shopify = createShopify({
    shop: env.DORKO_SHOP || '6zhh3e-ne.myshopify.com',
    clientId: env.DORKO_SHOPIFY_CLIENT_ID,
    clientSecret: env.DORKO_SHOPIFY_CLIENT_SECRET,
  });
  // Backup runs: if an earlier run already handled this day, stop here.
  if (env.REEM_CATCHUP === 'true' && mode === 'send') {
    const done = await shopify.dayEntry(day);
    if (done && done.status !== 'failed') {
      console.log(`${day} already recorded as "${done.status}" by an earlier run; nothing to do.`);
      if (out) writeFileSync(out, JSON.stringify({ ...report, status: 'already_done' }, null, 2));
      process.exit(0);
    }
  }

  const location = await shopify.findLocation(env.REEM_LOCATION_NAME || 'Reem Mall Shop');
  report.location = location.name;
  const window = dubaiDayWindow(day);
  const orders = await shopify.orders(searchFor(window));
  const built = buildRows(orders, location.id, window, excludedNames);
  rows = built.rows;
  Object.assign(report, { ordersScanned: orders.length, rows: rows.map(toVemcount), skipped: built.skipped, excluded: built.excluded });
  const notes = [];
  if (built.excluded.length) notes.push(`Not sent (test, tagged ${EXCLUDE_TAG} or excluded): ${built.excluded.join(', ')}`);
  report.totals = totals(rows);
  report.existing = parseExisting(orders);

  console.log(`${day} (Dubai): ${rows.length} rows from ${orders.length} orders scanned at "${location.name}"`);
  console.table(rows.map(({ transaction_id, created_at, turnover, discount, vat, items, category }) =>
    ({ transaction_id, created_at, turnover, discount, vat, items, category })));
  console.log('totals', report.totals);
  if (built.skipped.length) console.warn('NEEDS A LOOK:', built.skipped);

  if (mode === 'send') {
    if (rows.length) {
      const vemcount = createVemcount({
        baseUrl: env.VEMCOUNT_BASE_URL || 'https://vemcount.app',
        clientId: env.VEMCOUNT_CLIENT_ID,
        clientSecret: env.VEMCOUNT_CLIENT_SECRET,
      });
      report.responses = [];
      for (let i = 0; i < rows.length; i += 100) {           // batches of 100
        report.responses.push(await vemcount.pushSales(rows.slice(i, i + 100).map(toVemcount)));
      }
    } else {
      report.responses = [];
    }
    report.accepted = report.responses.reduce((n, r) => n + (r.accepted || 0), 0);
    console.log(`Vemcount accepted ${report.accepted}/${rows.length}`);
    if (report.accepted !== rows.length) {
      status = 'failed';
      message = `Vemcount accepted ${report.accepted} of ${rows.length}`;
      exitCode = 1;
    } else if (built.skipped.length) {
      status = 'partial';
      message = built.skipped.map((s) => `${s.order}: ${s.reason}`).join('; ');
      exitCode = 2;
    } else {
      status = rows.length ? 'sent' : 'no_sales';
    }
    if (status !== 'failed' && notes.length) message = [message, ...notes].filter(Boolean).join(' · ');
  }
} catch (err) {
  report.error = { message: err.message, status: err.status, body: err.body };
  console.error(err.message);
  status = 'failed';
  message = err.message;
  exitCode = 1;
}

// Shopify activity log: one entry per day whatever happened, plus a record
// on each order that was accepted by Vemcount.
if (logEnabled && shopify) {
  try {
    const log = createLog(shopify.graphql);
    await log.recordDay({
      day, status, message, rows, totals: report.totals || totals([]),
      accepted: report.accepted || 0, ranAt: report.ranAt,
    });
    if (status === 'sent' || status === 'partial') {
      report.ordersRecorded = await log.recordOrders(rows, report.existing || new Map(), report.ranAt);
    }
    report.logged = true;
  } catch (err) {
    report.logError = err.message;
    console.error(`Shopify log failed: ${err.message}`);
    if (exitCode === 0) exitCode = 3;
  }
}

delete report.existing;
report.status = mode === 'send' ? status : 'dry-run';
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(exitCode);

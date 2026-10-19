// Usage:
//   node scripts/test-scenarios.js dry-run [out.json]   prints the rows only
//   node scripts/test-scenarios.js send [out.json]      sends them to Vemcount
// Env (send only): VEMCOUNT_CLIENT_ID, VEMCOUNT_CLIENT_SECRET, VEMCOUNT_BASE_URL
import { writeFileSync } from 'node:fs';
import { buildScenarios } from './scenarios.js';
import { createVemcount } from '../src/vemcount.js';

const [mode = 'dry-run', out] = process.argv.slice(2);
const scenarios = buildScenarios();
const report = { mode, ranAt: new Date().toISOString(), baseUrl: process.env.VEMCOUNT_BASE_URL || 'https://vemcount.app', scenarios: [] };

let failed = false;
let client = null;
if (mode === 'send') {
  client = createVemcount({
    baseUrl: report.baseUrl,
    clientId: process.env.VEMCOUNT_CLIENT_ID,
    clientSecret: process.env.VEMCOUNT_CLIENT_SECRET,
  });
  try {
    await client.getToken();
    report.token = 'ok';
  } catch (err) {
    report.token = { error: err.message, cause: String(err.cause?.code || err.cause?.message || err.name || ''), status: err.status, body: err.body };
    failed = true;
  }
}

for (const s of scenarios) {
  const entry = { ...s };
  if (client && !failed) {
    try {
      entry.response = await client.pushSales(s.rows);
    } catch (err) {
      entry.response = { error: err.message, cause: String(err.cause?.code || err.cause?.message || err.name || ''), status: err.status, body: err.body };
      failed = true;
    }
  }
  report.scenarios.push(entry);
  console.log(`\n${s.name}: ${s.note}`);
  console.table(s.rows.map(({ transaction_id, created_at, turnover, discount, vat, items, category }) =>
    ({ transaction_id, created_at, turnover, discount, vat, items, category })));
  if (entry.response) console.log('response:', JSON.stringify(entry.response));
}

if (out) writeFileSync(out, JSON.stringify(report, null, 2));
if (failed) { console.error('\nAt least one request failed; see the report.'); process.exit(1); }

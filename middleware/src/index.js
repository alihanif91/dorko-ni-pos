import { openDb, makeRepo } from './db.js';
import { createNiClient } from './ni/index.js';
import { createPayments } from './payments.js';
import { createServer } from './server.js';

const env = process.env;

if (env.NODE_ENV === 'production' && !env.SHOPIFY_API_SECRET) {
  throw new Error('SHOPIFY_API_SECRET is required in production');
}

const repo = makeRepo(openDb(env.DB_PATH || './data.sqlite'));
const ni = createNiClient(env);
const payments = createPayments({
  repo,
  ni,
  recoveryAfterMs: Number(env.RECOVERY_AFTER_MS || 20000),
});

const port = Number(env.PORT || 3000);
createServer({ payments, env }).listen(port, () => {
  console.log(`NI middleware on :${port} (NI mode: ${ni.mode})`);
});

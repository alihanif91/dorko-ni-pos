import { openDb, makeRepo, makeTokenStore } from './db.js';
import { createShopifyClient } from './shopify.js';
import { createNiClient } from './ni/index.js';
import { createPayments } from './payments.js';
import { createServer } from './server.js';

const env = process.env;

if (env.NODE_ENV === 'production' && !env.SHOPIFY_API_SECRET) {
  throw new Error('SHOPIFY_API_SECRET is required in production');
}

const db = openDb(env.DB_PATH || './data.sqlite');
const repo = makeRepo(db);
const shopify = createShopifyClient({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecret: env.SHOPIFY_API_SECRET,
  tokenStore: makeTokenStore(db),
});
const ni = createNiClient(env);
const payments = createPayments({
  repo,
  ni,
  shopify,
  gateway: env.PAYMENT_GATEWAY_NAME || undefined,
  restock: env.REFUND_RESTOCK !== 'false',
  recoveryAfterMs: Number(env.RECOVERY_AFTER_MS || 20000),
});

const port = Number(env.PORT || 3000);
createServer({ payments, env }).listen(port, () => {
  console.log(`NI middleware on :${port} (NI mode: ${ni.mode})`);
});

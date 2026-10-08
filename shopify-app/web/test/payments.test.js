import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb, makeRepo } from '../src/db.js';
import { createMockNi } from '../src/ni/mock.js';
import { createPayments, NotFoundError } from '../src/payments.js';
import { createServer } from '../src/server.js';
import { newSourceId, isValidSourceId } from '../src/sourceId.js';
import { verifySessionToken } from '../src/auth.js';
import { toMinorUnits, cartPaymentState, PROP } from '../../extensions/ni-terminal/src/cart.js';

const SHOP = 'dorko-dev.myshopify.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLog = { warn() {} };

function setup({ approveMs = 30, recoveryAfterMs = 60 } = {}) {
  const repo = makeRepo(openDb());
  const ni = createMockNi({ approveMs });
  return { repo, ni, payments: createPayments({ repo, ni, recoveryAfterMs, log: quietLog }) };
}

async function pollUntilFinal(payments, sourceId, shop = SHOP, limitMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const s = await payments.getStatus({ shop, sourceId });
    if (s.status !== 'pending') return s;
    await wait(20);
  }
  throw new Error('never left pending');
}

// --- SourceID ---------------------------------------------------------------

test('SourceIDs fit NI rules (max 15, alphanumeric) and are unique', () => {
  const ids = new Set(Array.from({ length: 5000 }, () => newSourceId()));
  assert.equal(ids.size, 5000);
  for (const id of ids) {
    assert.ok(isValidSourceId(id), id);
    assert.ok(id.length <= 15, id);
  }
});

// --- Payment flows ------------------------------------------------------------

test('sale is approved and carries approval code + RRN', async () => {
  const { payments } = setup();
  const start = await payments.startSale({ shop: SHOP, amountMinor: 8000, currency: 'AED' });
  assert.equal(start.status, 'pending');
  const final = await pollUntilFinal(payments, start.sourceId);
  assert.equal(final.status, 'approved');
  assert.equal(final.amount, 8000);
  assert.ok(final.approvalCode);
  assert.ok(final.rrn);
});

test('amount ending .13 is declined', async () => {
  const { payments } = setup();
  const start = await payments.startSale({ shop: SHOP, amountMinor: 1013, currency: 'AED' });
  const final = await pollUntilFinal(payments, start.sourceId);
  assert.equal(final.status, 'declined');
});

test('dropped connection (amount .99) is recovered through Get Result', async () => {
  const { payments } = setup({ approveMs: 30, recoveryAfterMs: 50 });
  const start = await payments.startSale({ shop: SHOP, amountMinor: 1099, currency: 'AED' });
  // The sale call itself never returns a result; only recovery can settle it.
  const final = await pollUntilFinal(payments, start.sourceId);
  assert.equal(final.status, 'approved');
});

test('approved payment can be voided', async () => {
  const { payments } = setup();
  const start = await payments.startSale({ shop: SHOP, amountMinor: 5000, currency: 'AED' });
  await pollUntilFinal(payments, start.sourceId);
  const voided = await payments.cancel({ shop: SHOP, sourceId: start.sourceId });
  assert.equal(voided.status, 'cancelled');
});

test('a late NI answer cannot overwrite a void', async () => {
  const { payments, repo } = setup({ approveMs: 80 });
  const start = await payments.startSale({ shop: SHOP, amountMinor: 5000, currency: 'AED' });
  await payments.cancel({ shop: SHOP, sourceId: start.sourceId });
  await wait(150); // background sale result arrives after the void
  assert.equal(repo.get(start.sourceId).status, 'cancelled');
});

test('another shop cannot read or void a payment', async () => {
  const { payments } = setup();
  const start = await payments.startSale({ shop: SHOP, amountMinor: 5000, currency: 'AED' });
  await assert.rejects(payments.getStatus({ shop: 'other.myshopify.com', sourceId: start.sourceId }), NotFoundError);
  await assert.rejects(payments.cancel({ shop: 'other.myshopify.com', sourceId: start.sourceId }), NotFoundError);
});

test('rejects bad amounts and currencies', async () => {
  const { payments } = setup();
  for (const amountMinor of [0, -100, 12.5, '8000', null]) {
    await assert.rejects(payments.startSale({ shop: SHOP, amountMinor, currency: 'AED' }), /Amount/);
  }
  await assert.rejects(payments.startSale({ shop: SHOP, amountMinor: 100, currency: 'aed' }), /currency/);
});

// --- Session token auth -----------------------------------------------------

const API_KEY = 'test-key';
const SECRET = 'test-secret';

function makeToken(claims, secret = SECRET) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const goodClaims = () => ({
  aud: API_KEY,
  dest: `https://${SHOP}`,
  exp: Math.floor(Date.now() / 1000) + 60,
  nbf: Math.floor(Date.now() / 1000) - 5,
  sub: '42',
});
const opts = { apiKey: API_KEY, apiSecret: SECRET, allowedShops: [SHOP] };

test('accepts a valid session token', () => {
  assert.deepEqual(verifySessionToken(makeToken(goodClaims()), opts), { shop: SHOP, userId: '42' });
});

test('rejects forged, expired, wrong-app and wrong-shop tokens', () => {
  assert.throws(() => verifySessionToken(makeToken(goodClaims(), 'wrong-secret'), opts), /signature/);
  assert.throws(() => verifySessionToken(makeToken({ ...goodClaims(), exp: 1 }), opts), /expired/);
  assert.throws(() => verifySessionToken(makeToken({ ...goodClaims(), aud: 'other' }), opts), /different app/);
  assert.throws(() => verifySessionToken(makeToken({ ...goodClaims(), dest: 'https://evil.myshopify.com' }), opts), /not allowed/);
});

// --- HTTP end to end ----------------------------------------------------------

test('HTTP: 401 without token, full sale with token', async () => {
  const { payments } = setup();
  const env = { SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_ALLOWED_SHOPS: SHOP };
  const server = createServer({ payments, env }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noAuth = await fetch(`${base}/api/payments`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${makeToken(goodClaims())}` };
    const created = await fetch(`${base}/api/payments`, {
      method: 'POST', headers, body: JSON.stringify({ amount: 8000, currency: 'AED' }),
    });
    assert.equal(created.status, 201);
    const { sourceId } = await created.json();

    let status;
    for (let i = 0; i < 50; i++) {
      status = await (await fetch(`${base}/api/payments/${sourceId}`, { headers })).json();
      if (status.status !== 'pending') break;
      await wait(20);
    }
    assert.equal(status.status, 'approved');

    const bad = await fetch(`${base}/api/payments/not-valid!!`, { headers });
    assert.equal(bad.status, 404);
  } finally {
    server.close();
  }
});

// --- POS extension cart logic -----------------------------------------------

test('cart totals convert to fils without float errors', () => {
  assert.equal(toMinorUnits('80.00'), 8000);
  assert.equal(toMinorUnits('80'), 8000);
  assert.equal(toMinorUnits('0.1'), 10);
  assert.equal(toMinorUnits('1,234.56'), 123456);
  assert.equal(toMinorUnits('AED 19.99'), 1999);
  assert.equal(toMinorUnits(''), 0);
  assert.equal(toMinorUnits(undefined), 0);
});

test('cart state flags a total that changed after approval', () => {
  assert.equal(cartPaymentState({ grandTotal: '0.00', properties: {} }).state, 'empty');
  assert.equal(cartPaymentState({ grandTotal: '80.00', properties: {} }).state, 'unpaid');
  const approved = { [PROP.sourceId]: 'D123', [PROP.amount]: '8000' };
  assert.equal(cartPaymentState({ grandTotal: '80.00', properties: approved }).state, 'approved');
  const changed = cartPaymentState({ grandTotal: '95.00', properties: approved });
  assert.equal(changed.state, 'stale');
  assert.equal(changed.approvedAmount, 8000);
});

// --- Refunds ----------------------------------------------------------------

import { createShopifyClient } from '../src/shopify.js';
import { makeTokenStore } from '../src/db.js';

// Fake Shopify: orderId -> { name, sourceId }. Records token exchanges.
function fakeShopify(orders) {
  return {
    async getOrderNiDetails({ orderId }) {
      return orders[orderId] ?? null;
    },
  };
}

async function approvedSale(payments) {
  const s = await payments.startSale({ shop: SHOP, amountMinor: 8000, currency: 'AED' });
  await pollUntilFinal(payments, s.sourceId);
  return s.sourceId;
}

function setupWithShopify(orders) {
  const repo = makeRepo(openDb());
  const ni = createMockNi({ approveMs: 30 });
  const shopify = fakeShopify(orders);
  return { repo, payments: createPayments({ repo, ni, shopify, recoveryAfterMs: 60, log: quietLog }) };
}

test('refund: full refund of an approved NI sale', async () => {
  const orders = {};
  const { payments } = setupWithShopify(orders);
  const sourceId = await approvedSale(payments);
  orders['1001'] = { name: '#1001', sourceId };

  const before = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '1001' });
  assert.equal(before.refundable, true);
  assert.equal(before.sale.amount, 8000);

  const refund = await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '1001' });
  assert.equal(refund.type, 'refund');
  assert.equal(refund.amount, 8000);
  const final = await pollUntilFinal(payments, refund.sourceId);
  assert.equal(final.status, 'approved');

  const after = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '1001' });
  assert.equal(after.refundable, false);
  assert.match(after.reason, /already been refunded/);
});

test('refund: cannot refund twice, even while the first is in progress', async () => {
  const orders = {};
  const { payments } = setupWithShopify(orders);
  orders['1'] = { name: '#1', sourceId: await approvedSale(payments) };
  await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '1' });
  await assert.rejects(payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '1' }), /in progress/);
});

test('refund: rejected for non-NI orders, declined sales and other shops', async () => {
  const orders = { '2': { name: '#2', sourceId: null } };
  const { payments } = setupWithShopify(orders);

  const cashOrder = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '2' });
  assert.equal(cashOrder.refundable, false);
  assert.match(cashOrder.reason, /not paid on the Network International terminal/);

  const declined = await payments.startSale({ shop: SHOP, amountMinor: 1013, currency: 'AED' });
  await pollUntilFinal(payments, declined.sourceId);
  orders['3'] = { name: '#3', sourceId: declined.sourceId };
  await assert.rejects(payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '3' }), /not approved/);

  orders['4'] = { name: '#4', sourceId: await approvedSale(payments) };
  const other = await payments.getOrder({ shop: 'other.myshopify.com', sessionToken: 't', orderId: '4' });
  assert.equal(other.refundable, false);

  await assert.rejects(payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: 'abc' }), NotFoundError);
  await assert.rejects(payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '999' }), NotFoundError);
});

test('shopify client: exchanges the session token once, then reads the order', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
      assert.equal(body.get('subject_token'), 'session-jwt');
      assert.equal(body.get('requested_token_type'), 'urn:shopify:params:oauth:token-type:offline-access-token');
      return { ok: true, status: 200, json: async () => ({ access_token: 'shpat_x' }) };
    }
    assert.equal(opts.headers['X-Shopify-Access-Token'], 'shpat_x');
    assert.equal(JSON.parse(opts.body).variables.id, 'gid://shopify/Order/1001');
    return { ok: true, status: 200, json: async () => ({ data: { order: { name: '#1001',
      customAttributes: [{ key: '_ni_source_id', value: 'DABC' }, { key: '_ni_rrn', value: 'R' }] } } }) };
  };
  const client = createShopifyClient({
    apiKey: 'k', apiSecret: 's', tokenStore: makeTokenStore(openDb()), fetchImpl,
  });
  assert.deepEqual(await client.getOrderNiDetails({ shop: SHOP, sessionToken: 'session-jwt', orderId: '1001' }),
    { name: '#1001', sourceId: 'DABC' });
  await client.getOrderNiDetails({ shop: SHOP, sessionToken: 'session-jwt', orderId: '1001' });
  assert.equal(calls.filter((u) => u.endsWith('access_token')).length, 1, 'token cached after first exchange');
});

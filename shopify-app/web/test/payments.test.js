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

// Fake Shopify: orderId -> { name, sourceId }. Records refunds it creates.
function fakeShopify(orders, { failTimes = 0 } = {}) {
  const created = [];
  let failures = 0;
  return {
    created,
    async getOrderNiDetails({ orderId }) {
      const o = orders[orderId];
      return o ? { ...o, refundedInShopify: Boolean(o.refundedInShopify) } : null;
    },
    async recordFullRefund(args) {
      if (failures < failTimes) { failures++; throw new Error('Shopify down'); }
      created.push(args);
      orders[args.orderId].refundedInShopify = true;
      return { refundId: `gid://shopify/Refund/${created.length}`, restocked: args.restock, existing: false };
    },
  };
}

async function approvedSale(payments) {
  const s = await payments.startSale({ shop: SHOP, amountMinor: 8000, currency: 'AED' });
  await pollUntilFinal(payments, s.sourceId);
  return s.sourceId;
}

function setupWithShopify(orders, opts = {}) {
  const repo = makeRepo(openDb());
  const ni = createMockNi({ approveMs: 30 });
  const shopify = fakeShopify(orders, opts);
  const payments = createPayments({
    repo, ni, shopify, recoveryAfterMs: 60, log: quietLog, restock: opts.restock ?? true,
  });
  return { repo, shopify, payments };
}

async function pollUntilRecorded(payments, sourceId, limitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const s = await payments.getStatus({ shop: SHOP, sourceId });
    if (s.shopifyRefund === 'recorded') return s;
    await wait(50);
  }
  throw new Error('Shopify refund never recorded');
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

  const recorded = await pollUntilRecorded(payments, refund.sourceId);
  assert.equal(recorded.restocked, true);

  const after = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '1001' });
  assert.equal(after.refundable, false);
  assert.match(after.reason, /already been refunded/);
});

test('refund: one step records the Shopify refund with the NI gateway and restock', async () => {
  const orders = {};
  const { payments, shopify } = setupWithShopify(orders);
  orders['5'] = { name: '#5', sourceId: await approvedSale(payments) };
  const r = await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '5' });
  await pollUntilRecorded(payments, r.sourceId);
  assert.equal(shopify.created.length, 1, 'exactly one Shopify refund');
  assert.equal(shopify.created[0].orderId, '5');
  assert.equal(shopify.created[0].gateway, 'Card – Network International');
  assert.equal(shopify.created[0].restock, true);
});

test('refund: restock can be switched off', async () => {
  const orders = {};
  const { payments, shopify } = setupWithShopify(orders, { restock: false });
  orders['6'] = { name: '#6', sourceId: await approvedSale(payments) };
  const r = await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '6' });
  const s = await pollUntilRecorded(payments, r.sourceId);
  assert.equal(shopify.created[0].restock, false);
  assert.equal(s.restocked, false);
});

test('refund: Shopify failure is retried, and never refunds the card twice', async () => {
  const orders = {};
  const { payments, shopify } = setupWithShopify(orders, { failTimes: 1 });
  orders['7'] = { name: '#7', sourceId: await approvedSale(payments) };
  const r = await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '7' });
  const first = await pollUntilFinal(payments, r.sourceId);
  assert.equal(first.status, 'approved');

  // Card refunded but Shopify failed: the order offers "record" only.
  let o;
  for (let i = 0; i < 100; i++) {
    o = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '7' });
    if (o.refund?.shopifyRefund === 'failed' || o.refund?.shopifyRefund === 'recorded') break;
    await wait(20);
  }
  assert.equal(o.refund.shopifyRefund, 'failed');
  assert.equal(o.action, 'record');

  const fixed = await payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '7' });
  assert.equal(fixed.sourceId, r.sourceId, 'same refund, no second card refund');
  assert.equal(fixed.shopifyRefund, 'recorded');
  assert.equal(shopify.created.length, 1);
});

test('refund: order already refunded in Shopify (without terminal) is not refunded again', async () => {
  const orders = {};
  const { payments } = setupWithShopify(orders);
  orders['8'] = { name: '#8', sourceId: await approvedSale(payments), refundedInShopify: true };
  const o = await payments.getOrder({ shop: SHOP, sessionToken: 't', orderId: '8' });
  assert.equal(o.refundable, false);
  assert.match(o.reason, /already refunded in Shopify/);
  await assert.rejects(payments.startRefund({ shop: SHOP, sessionToken: 't', orderId: '8' }), /already refunded in Shopify/);
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
    { name: '#1001', sourceId: 'DABC', refundedInShopify: false });
  await client.getOrderNiDetails({ shop: SHOP, sessionToken: 'session-jwt', orderId: '1001' });
  assert.equal(calls.filter((u) => u.endsWith('access_token')).length, 1, 'token cached after first exchange');
});

test('shopify client: full refund uses the NI sale, restocks at the POS location', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/admin/oauth/access_token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'shpat_x' }) };
    }
    const body = JSON.parse(opts.body);
    sent.push(body);
    if (body.query.includes('RefundContext')) {
      return { ok: true, status: 200, json: async () => ({ data: { order: {
        id: 'gid://shopify/Order/9', name: '#9', refunds: [],
        lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1', refundableQuantity: 2 },
          { id: 'gid://shopify/LineItem/2', refundableQuantity: 0 }] },
        transactions: [
          { id: 'gid://shopify/OrderTransaction/50', gateway: 'Card – Network International', kind: 'SALE',
            status: 'SUCCESS', amountSet: { shopMoney: { amount: '80.0', currencyCode: 'AED' } } },
        ],
      } } }) };
    }
    if (body.query.includes('OrderLocation')) {
      return { ok: true, status: 200, json: async () => ({ data: { order: { retailLocation: { id: 'gid://shopify/Location/3' } } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { refundCreate: {
      refund: { id: 'gid://shopify/Refund/77' }, userErrors: [] } } }) };
  };
  const client = createShopifyClient({ apiKey: 'k', apiSecret: 's', tokenStore: makeTokenStore(openDb()), fetchImpl });
  const r = await client.recordFullRefund({
    shop: SHOP, sessionToken: 'jwt', orderId: '9', gateway: 'Card – Network International', restock: true, note: 'n',
  });
  assert.deepEqual(r, { refundId: 'gid://shopify/Refund/77', restocked: true, existing: false });
  const input = sent.find((b) => b.query.includes('refundCreate')).variables.input;
  assert.equal(input.orderId, 'gid://shopify/Order/9');
  assert.deepEqual(input.refundLineItems, [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 2,
    restockType: 'RETURN', locationId: 'gid://shopify/Location/3' }]);
  assert.deepEqual(input.transactions, [{ orderId: 'gid://shopify/Order/9', gateway: 'Card – Network International',
    kind: 'REFUND', amount: '80.00', parentId: 'gid://shopify/OrderTransaction/50' }]);
  assert.equal(input.notify, false);
});

test('shopify client: skips if the order already has a refund', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 'x' }) };
    return { ok: true, status: 200, json: async () => ({ data: { order: {
      id: 'o', name: '#1', refunds: [{ id: 'gid://shopify/Refund/1' }], lineItems: { nodes: [] }, transactions: [],
    } } }) };
  };
  const client = createShopifyClient({ apiKey: 'k', apiSecret: 's', tokenStore: makeTokenStore(openDb()), fetchImpl });
  const r = await client.recordFullRefund({ shop: SHOP, sessionToken: 'jwt', orderId: '1', gateway: 'g' });
  assert.equal(r.existing, true);
});

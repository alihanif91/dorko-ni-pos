import express from 'express';
import { requireSession } from './auth.js';
import { ValidationError, NotFoundError } from './payments.js';
import { isValidSourceId } from './sourceId.js';
import { ShopifyError } from './shopify.js';

export function createServer({ payments, env = process.env }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // POS extensions call from Shopify's extension sandbox. Auth is a bearer
  // token, not cookies, so allowing any origin is safe here.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  // The app has no admin screens; this is what opening the app URL shows.
  app.get('/', (req, res) => {
    res.type('text').send('Dorko NI Payments: server running. Use the "Pay by card (NI)" tile in Shopify POS.');
  });

  const api = express.Router();
  api.use(requireSession(env));

  api.post('/payments', async (req, res) => {
    const { amount, currency } = req.body || {};
    res.status(201).json(await payments.startSale({
      shop: req.session.shop,
      amountMinor: amount,
      currency,
      staffId: req.session.userId,
    }));
  });

  api.get('/payments/:id', async (req, res) => {
    checkId(req.params.id);
    res.json(await payments.getStatus({ shop: req.session.shop, sourceId: req.params.id }));
  });

  api.post('/payments/:id/cancel', async (req, res) => {
    checkId(req.params.id);
    res.json(await payments.cancel({ shop: req.session.shop, sourceId: req.params.id }));
  });

  // Refunds: look up the NI payment behind a Shopify order, then refund it
  // in full on the terminal. Progress is polled via GET /payments/:id.
  api.get('/orders/:orderId', async (req, res) => {
    res.json(await payments.getOrder({
      shop: req.session.shop, sessionToken: req.sessionToken, orderId: req.params.orderId,
    }));
  });

  api.post('/orders/:orderId/refund', async (req, res) => {
    res.status(201).json(await payments.startRefund({
      shop: req.session.shop,
      sessionToken: req.sessionToken,
      orderId: req.params.orderId,
      staffId: req.session.userId,
    }));
  });

  app.use('/api', api);

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ShopifyError) {
      console.error(`Shopify: ${err.message}`);
      return res.status(502).json({ error: 'Could not read this order from Shopify. Try again.' });
    }
    console.error(err);
    res.status(502).json({ error: 'Could not reach the card terminal service. Try again.' });
  });

  return app;
}

function checkId(id) {
  if (!isValidSourceId(id)) throw new NotFoundError('Payment not found');
}

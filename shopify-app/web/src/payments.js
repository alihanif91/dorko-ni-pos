import { newSourceId } from './sourceId.js';

const FINAL = new Set(['approved', 'declined', 'cancelled']);

// Payment logic, independent of HTTP. The NI call runs in the background so
// the POS never holds a request open while the customer taps their card;
// the POS polls status instead. That works whether NI's API turns out to be
// a long synchronous call or callback-based.
// Name of the POS custom payment type the cashier tenders with. Must match
// the Shopify setting exactly (note the en dash).
export const DEFAULT_GATEWAY = 'Card – Network International';
const SHOPIFY_RETRY_MS = 10000;

export function createPayments({
  repo, ni, shopify = null, recoveryAfterMs = 20000, log = console,
  gateway = DEFAULT_GATEWAY, restock = true,
}) {
  const settling = new Set();
  const lastShopifyAttempt = new Map();

  // After the terminal approves a refund, record the same refund in Shopify
  // so the order shows as refunded. Safe to call repeatedly: one attempt at
  // a time, throttled on failure, and Shopify never gets a second refund.
  async function settleShopify(row, sessionToken = null, { force = false } = {}) {
    if (!row || row.type !== 'refund' || row.status !== 'approved') return row;
    if (row.shopify_refund_id || !row.order_id || !shopify) return row;
    if (settling.has(row.source_id)) return row;
    const last = lastShopifyAttempt.get(row.source_id) ?? 0;
    // Background retries are throttled; a retry staff asked for is not.
    if (!force && row.shopify_error && Date.now() - last < SHOPIFY_RETRY_MS) return row;
    settling.add(row.source_id);
    lastShopifyAttempt.set(row.source_id, Date.now());
    try {
      const r = await shopify.recordFullRefund({
        shop: row.shop,
        sessionToken,
        orderId: row.order_id,
        gateway,
        restock,
        note: `Refunded on the Network International terminal (ref ${row.source_id})`,
      });
      return repo.setShopifyRefund(row.source_id, { refundId: r.refundId, restocked: r.restocked });
    } catch (err) {
      log.warn(`refund ${row.source_id}: Shopify record failed (${err.message})`);
      return repo.setShopifyRefund(row.source_id, { error: err.message });
    } finally {
      settling.delete(row.source_id);
    }
  }

  // Runs a sale or refund against NI in the background.
  function runTxn(row) {
    const args = {
      sourceId: row.source_id,
      parentId: row.parent_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
    };
    const call = row.type === 'refund' ? ni.refund(args) : ni.sale(args);
    call
      .then((result) => {
        if (result?.status && result.status !== 'pending') {
          const updated = applyResult(row.source_id, result);
          settleShopify(updated).catch(() => {});
        }
      })
      .catch((err) => {
        // Don't mark it failed: the card may still have been charged.
        // Recovery via Get Result settles it.
        log.warn(`${row.type} ${row.source_id}: no answer from NI (${err.message}); will recover`);
      });
  }

  function applyResult(sourceId, result) {
    const current = repo.get(sourceId);
    if (!current || FINAL.has(current.status)) return current; // first final answer wins
    return repo.setResult(sourceId, result);
  }

  function allocate(fields) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return repo.create({ ...fields, sourceId: newSourceId() });
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err; // retry only on ID clash
      }
    }
    throw new Error('Could not allocate a SourceID');
  }

  // Finds the NI sale behind a Shopify order and its refund state.
  async function orderPayment({ shop, sessionToken, orderId }) {
    if (!shopify) throw new Error('Shopify client not configured');
    if (!/^\d+$/.test(String(orderId))) throw new NotFoundError('Order not found');
    const details = await shopify.getOrderNiDetails({ shop, sessionToken, orderId });
    if (!details) throw new NotFoundError('Order not found');
    const sale = details.sourceId ? repo.get(details.sourceId) : null;
    if (!sale || sale.shop !== shop || sale.type !== 'sale') {
      return { orderName: details.name, sale: null, refund: null, refundable: false,
        reason: 'This order was not paid on the Network International terminal.' };
    }
    const refunds = repo.refundsOf(sale.source_id);
    const active = refunds.find((r) => r.status === 'approved' || r.status === 'pending');
    let reason = null;
    let action = 'refund';
    if (sale.status !== 'approved') reason = 'The original card payment was not approved.';
    else if (active?.status === 'pending') reason = 'A refund for this payment is already in progress.';
    else if (active?.status === 'approved' && !active.shopify_refund_id && !details.refundedInShopify) {
      action = 'record'; // card refunded on the terminal, Shopify not updated yet
    } else if (active?.status === 'approved') reason = 'This payment has already been refunded.';
    else if (details.refundedInShopify) {
      reason = 'This order was already refunded in Shopify without the terminal. '
        + 'If the customer still needs the money back, refund the card directly on the terminal.';
    }
    if (reason) action = null;
    return {
      orderName: details.name,
      sale,
      refund: active ?? refunds[0] ?? null,
      action,
      refundable: action === 'refund',
      reason,
    };
  }

  return {
    async getOrder(args) {
      const p = await orderPayment(args);
      return {
        orderName: p.orderName,
        sale: p.sale ? publicView(p.sale) : null,
        refund: p.refund ? publicView(p.refund) : null,
        action: p.action ?? null,
        refundable: p.refundable,
        reason: p.reason ?? undefined,
      };
    },

    // Full refund only (agreed scope). Runs on the terminal like a sale; the
    // POS polls GET /payments/:sourceId for the result.
    // If the card was already refunded on the terminal but Shopify wasn't
    // updated, this only records the Shopify refund (no second card refund).
    async startRefund({ shop, sessionToken, orderId, staffId }) {
      const p = await orderPayment({ shop, sessionToken, orderId });
      if (p.action === 'record') {
        const fixed = await settleShopify(p.refund.order_id ? p.refund
          : repo.setOrderId(p.refund.source_id, orderId), sessionToken, { force: true });
        return publicView(fixed);
      }
      if (p.action !== 'refund') throw new ValidationError(p.reason);
      const row = allocate({
        shop,
        type: 'refund',
        parentId: p.sale.source_id,
        amountMinor: p.sale.amount_minor,
        currency: p.sale.currency,
        staffId,
        orderId,
      });
      runTxn(row);
      return publicView(row);
    },

    async startSale({ shop, amountMinor, currency, staffId }) {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new ValidationError('Amount must be a positive whole number of fils');
      }
      if (!/^[A-Z]{3}$/.test(currency || '')) throw new ValidationError('Invalid currency');

      const row = allocate({ shop, amountMinor, currency, staffId });
      runTxn(row);
      return publicView(row);
    },

    async getStatus({ shop, sourceId }) {
      let row = ownedRow(shop, sourceId);
      if (row.status === 'pending') {
        const since = Date.now() - (row.last_recovery_at ?? row.created_at);
        if (since >= recoveryAfterMs) {
          repo.markRecovery(sourceId);
          const result = await ni.getResult(sourceId);
          if (result?.status && result.status !== 'pending' && result.status !== 'error') {
            row = applyResult(sourceId, result);
          }
        }
      }
      row = await settleShopify(row);
      return publicView(row);
    },

    async cancel({ shop, sourceId }) {
      const row = ownedRow(shop, sourceId);
      if (row.status === 'declined' || row.status === 'cancelled') return publicView(row);
      const result = await ni.void(sourceId);
      if (result?.status !== 'cancelled') {
        throw new Error(result?.message || 'Terminal did not confirm the void');
      }
      // Void overrides an earlier approval, so set it directly.
      return publicView(repo.setResult(sourceId, result));
    },
  };

  function ownedRow(shop, sourceId) {
    const row = repo.get(sourceId);
    if (!row || row.shop !== shop) throw new NotFoundError('Payment not found');
    return row;
  }
}

function publicView(row) {
  return {
    sourceId: row.source_id,
    type: row.type,
    status: row.status,
    amount: row.amount_minor,
    currency: row.currency,
    approvalCode: row.approval_code ?? undefined,
    rrn: row.rrn ?? undefined,
    message: row.message ?? undefined,
    // Refunds only: whether Shopify's books were updated too.
    shopifyRefund: row.type !== 'refund' ? undefined
      : row.shopify_refund_id ? 'recorded'
        : row.shopify_error ? 'failed' : 'pending',
    shopifyError: row.type === 'refund' ? (row.shopify_error ?? undefined) : undefined,
    restocked: row.type === 'refund' && row.restocked != null ? Boolean(row.restocked) : undefined,
  };
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

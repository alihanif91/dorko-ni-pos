import { newSourceId } from './sourceId.js';

const FINAL = new Set(['approved', 'declined', 'cancelled']);

// Payment logic, independent of HTTP. The NI call runs in the background so
// the POS never holds a request open while the customer taps their card;
// the POS polls status instead. That works whether NI's API turns out to be
// a long synchronous call or callback-based.
export function createPayments({ repo, ni, shopify = null, recoveryAfterMs = 20000, log = console }) {
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
        if (result?.status && result.status !== 'pending') applyResult(row.source_id, result);
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
    if (sale.status !== 'approved') reason = 'The original card payment was not approved.';
    else if (active?.status === 'approved') reason = 'This payment has already been refunded.';
    else if (active?.status === 'pending') reason = 'A refund for this payment is already in progress.';
    return {
      orderName: details.name,
      sale,
      refund: refunds[0] ?? null,
      refundable: !reason,
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
        refundable: p.refundable,
        reason: p.reason ?? undefined,
      };
    },

    // Full refund only (agreed scope). Runs on the terminal like a sale; the
    // POS polls GET /payments/:sourceId for the result.
    async startRefund({ shop, sessionToken, orderId, staffId }) {
      const p = await orderPayment({ shop, sessionToken, orderId });
      if (!p.refundable) throw new ValidationError(p.reason);
      const row = allocate({
        shop,
        type: 'refund',
        parentId: p.sale.source_id,
        amountMinor: p.sale.amount_minor,
        currency: p.sale.currency,
        staffId,
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
  };
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

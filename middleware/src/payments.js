import { newSourceId } from './sourceId.js';

const FINAL = new Set(['approved', 'declined', 'cancelled']);

// Payment logic, independent of HTTP. The NI call runs in the background so
// the POS never holds a request open while the customer taps their card;
// the POS polls status instead. That works whether NI's API turns out to be
// a long synchronous call or callback-based.
export function createPayments({ repo, ni, recoveryAfterMs = 20000, log = console }) {
  function runSale(row) {
    ni.sale({ sourceId: row.source_id, amountMinor: row.amount_minor, currency: row.currency })
      .then((result) => {
        if (result?.status && result.status !== 'pending') applyResult(row.source_id, result);
      })
      .catch((err) => {
        // Don't mark it failed: the card may still have been charged.
        // Recovery via Get Result settles it.
        log.warn(`sale ${row.source_id}: no answer from NI (${err.message}); will recover`);
      });
  }

  function applyResult(sourceId, result) {
    const current = repo.get(sourceId);
    if (!current || FINAL.has(current.status)) return current; // first final answer wins
    return repo.setResult(sourceId, result);
  }

  return {
    async startSale({ shop, amountMinor, currency, staffId }) {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new ValidationError('Amount must be a positive whole number of fils');
      }
      if (!/^[A-Z]{3}$/.test(currency || '')) throw new ValidationError('Invalid currency');

      let row;
      for (let attempt = 0; attempt < 3 && !row; attempt++) {
        try {
          row = repo.create({ sourceId: newSourceId(), shop, amountMinor, currency, staffId });
        } catch (err) {
          if (!String(err.message).includes('UNIQUE')) throw err; // retry only on ID clash
        }
      }
      if (!row) throw new Error('Could not allocate a SourceID');
      runSale(row);
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

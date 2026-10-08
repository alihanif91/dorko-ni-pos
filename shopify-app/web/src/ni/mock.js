// Fake Network International terminal for building and testing before the
// real Push to Pay docs arrive. Same interface as the live client will have.
//
// Behaviour is chosen by the amount, so every path can be tested from POS:
//   amount ending in .13  -> declined
//   amount ending in .99  -> sale call never answers; only Get Result does
//                            (exercises timeout recovery)
//   anything else         -> approved after MOCK_APPROVE_MS
//
// Every result has the same normalised shape:
//   { status: 'pending'|'approved'|'declined'|'cancelled', approvalCode, rrn, message }

export function createMockNi({ approveMs = 4000 } = {}) {
  const outcomes = new Map(); // sourceId -> final result
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function decide(sourceId, amountMinor) {
    const cents = amountMinor % 100;
    if (cents === 13) {
      return { status: 'declined', message: 'Mock: card declined (amount ends in .13)' };
    }
    return {
      status: 'approved',
      approvalCode: String(100000 + (amountMinor % 900000)).slice(0, 6),
      rrn: `MOCK${sourceId.slice(-8)}`,
    };
  }

  return {
    mode: 'mock',

    async sale({ sourceId, amountMinor }) {
      const result = decide(sourceId, amountMinor);
      outcomes.set(sourceId, { result, readyAt: Date.now() + approveMs });
      if (amountMinor % 100 === 99) {
        // Simulate a dropped connection: the request hangs, then errors.
        await wait(approveMs * 3);
        throw new Error('Mock: connection to NI dropped');
      }
      await wait(approveMs);
      return result;
    },

    async getResult(sourceId) {
      const entry = outcomes.get(sourceId);
      if (!entry) return { status: 'error', message: 'Mock: unknown SourceID' };
      if (Date.now() < entry.readyAt) return { status: 'pending' };
      return entry.result;
    },

    async void(sourceId) {
      const entry = outcomes.get(sourceId);
      if (entry) entry.result = { status: 'cancelled', message: 'Mock: voided' };
      return { status: 'cancelled', message: 'Voided' };
    },

    async refund({ sourceId }) {
      const result = { status: 'approved', approvalCode: '999999', rrn: `MOCKR${sourceId.slice(-8)}` };
      outcomes.set(sourceId, { result, readyAt: Date.now() + approveMs });
      await wait(approveMs);
      return result;
    },
  };
}

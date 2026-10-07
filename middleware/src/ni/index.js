import { createMockNi } from './mock.js';

// Picks the NI client. The live client gets written once NI sends the Push to
// Pay docs; everything else in the middleware only uses this interface:
//   sale({ sourceId, amountMinor, currency }) -> result
//   getResult(sourceId)                       -> result
//   void(sourceId)                            -> result
//   refund({ sourceId, parentId, amountMinor, currency }) -> result
export function createNiClient(env = process.env) {
  if (env.NI_MODE === 'live') {
    throw new Error('Live NI client not built yet: waiting on Push to Pay documentation.');
  }
  return createMockNi({ approveMs: Number(env.MOCK_APPROVE_MS || 4000) });
}

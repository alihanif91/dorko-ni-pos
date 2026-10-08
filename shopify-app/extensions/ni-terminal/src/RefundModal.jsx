import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getOrderPayment, getStatus, startRefund, waitForFinal } from './api.js';
import { formatMinor } from './cart.js';

export default async () => {
  render(<RefundModal />, document.body);
};

// One step: refunds the full amount on the terminal, then the server records
// the same refund in Shopify (and restocks). Staff don't do a separate Return.
function RefundModal() {
  const orderId = shopify.order.id;
  // loading | ready | refunding | recording | done | error
  const [phase, setPhase] = useState('loading');
  const [info, setInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [refundId, setRefundId] = useState(null);
  const stopped = useRef(false);

  useEffect(() => {
    load();
    return () => { stopped.current = true; };
  }, []);

  async function load() {
    setPhase('loading');
    try {
      const data = await getOrderPayment(orderId);
      setInfo(data);
      setRefundId(data.refund?.sourceId ?? null);
      setPhase('ready');
    } catch (err) {
      setMessage(err.message);
      setPhase('error');
    }
  }

  async function refund() {
    setPhase('refunding');
    setMessage('');
    try {
      const r = await startRefund(orderId);
      setRefundId(r.sourceId);
      if (r.status === 'approved') return finishShopify(r); // "record" path
      const final = await waitForFinal(r.sourceId, { isStopped: () => stopped.current });
      if (stopped.current) return;
      if (final.status === 'pending') {
        setMessage('No answer from the terminal yet. Do not refund again. Tap "Check again".');
        return setPhase('error');
      }
      if (final.status !== 'approved') {
        setMessage(final.message || 'The refund was not approved. No money was returned.');
        return setPhase('error');
      }
      await finishShopify(final);
    } catch (err) {
      setMessage(err.message);
      setPhase('error');
    }
  }

  // Card refund is approved; wait briefly for the Shopify record to land.
  async function finishShopify(r) {
    setPhase('recording');
    let latest = r;
    const started = Date.now();
    while (!stopped.current && latest.shopifyRefund === 'pending' && Date.now() - started < 30000) {
      await new Promise((res) => setTimeout(res, 1500));
      latest = await getStatus(latest.sourceId);
    }
    if (stopped.current) return;
    setResult(latest);
    setPhase('done');
  }

  async function checkAgain() {
    if (!refundId) return load();
    setPhase('refunding');
    try {
      const final = await waitForFinal(refundId, { isStopped: () => stopped.current });
      if (final.status === 'approved') return finishShopify(final);
      setMessage(final.status === 'pending'
        ? 'Still no answer from the terminal. Do not refund again.'
        : final.message || 'The refund was not approved.');
      setPhase('error');
    } catch (err) {
      setMessage(err.message);
      setPhase('error');
    }
  }

  const sale = info?.sale;
  const amount = sale ? formatMinor(sale.amount, sale.currency) : '';

  return (
    <s-page heading={`NI refund${info?.orderName ? ` · ${info.orderName}` : ''}`}>
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          {phase === 'loading' && <s-text>Looking up the card payment…</s-text>}

          {phase === 'ready' && info && !info.action && (
            <s-banner heading="Can't refund on the terminal" tone="warning">{info.reason}</s-banner>
          )}

          {phase === 'ready' && info?.action === 'refund' && (
            <>
              <s-text>Card payment: {amount} (approval {sale.approvalCode || '–'})</s-text>
              <s-text>
                The full amount goes back to the customer's card, and the order is marked refunded in
                Shopify. Ask the customer to have the card ready.
              </s-text>
              <s-button variant="primary" tone="critical" onClick={refund}>Refund {amount}</s-button>
            </>
          )}

          {phase === 'ready' && info?.action === 'record' && (
            <>
              <s-banner heading="Card already refunded" tone="warning">
                {amount} was refunded on the terminal, but this order isn't marked refunded in Shopify yet.
              </s-banner>
              <s-button variant="primary" onClick={refund}>Record refund in Shopify</s-button>
            </>
          )}

          {phase === 'refunding' && <s-text>Refunding {amount} on the terminal…</s-text>}
          {phase === 'recording' && <s-text>Card refunded. Recording the refund in Shopify…</s-text>}

          {phase === 'done' && result?.shopifyRefund === 'recorded' && (
            <s-banner heading="Refund complete" tone="success">
              {amount} is back on the card and the order is marked refunded in Shopify.
              {result.restocked === false ? ' Items were not restocked.' : ' Items are back in stock.'}
            </s-banner>
          )}

          {phase === 'done' && result?.shopifyRefund !== 'recorded' && (
            <>
              <s-banner heading="Card refunded, Shopify not updated" tone="critical">
                The card refund of {amount} is done. Shopify couldn't record it
                {result?.shopifyError ? ` (${result.shopifyError})` : ''}. Don't refund the card again.
              </s-banner>
              <s-button onClick={() => { setPhase('loading'); refund(); }}>Record refund in Shopify</s-button>
            </>
          )}

          {phase === 'error' && (
            <>
              <s-banner heading="Problem" tone="critical">{message}</s-banner>
              <s-button onClick={checkAgain}>{refundId ? 'Check again' : 'Try again'}</s-button>
            </>
          )}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

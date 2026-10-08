import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getOrderPayment, startRefund, waitForFinal } from './api.js';
import { formatMinor } from './cart.js';

export default async () => {
  render(<RefundModal />, document.body);
};

// Full refund only (agreed scope). The card refund happens on the terminal
// first; staff then record the return in Shopify POS as usual.
function RefundModal() {
  const orderId = shopify.order.id;
  // loading | ready | refunding | done | error
  const [phase, setPhase] = useState('loading');
  const [info, setInfo] = useState(null);
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
      await follow(r.sourceId);
    } catch (err) {
      setMessage(err.message);
      setPhase('error');
    }
  }

  async function follow(id) {
    const result = await waitForFinal(id, { isStopped: () => stopped.current });
    if (stopped.current) return;
    if (result.status === 'approved') {
      setPhase('done');
    } else if (result.status === 'pending') {
      setMessage('No answer from the terminal yet. Do not refund again. Tap "Check again".');
      setPhase('error');
    } else {
      setMessage(result.message || 'The refund was not approved. No money was returned.');
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

          {phase === 'ready' && info && !info.refundable && (
            <s-banner heading="Can't refund on the terminal" tone="warning">{info.reason}</s-banner>
          )}

          {phase === 'ready' && info?.refundable && (
            <>
              <s-text>Card payment: {amount} (approval {sale.approvalCode || '–'})</s-text>
              <s-text>The full amount goes back to the customer's card. Ask them to have the card ready.</s-text>
              <s-button variant="primary" tone="critical" onClick={refund}>Refund {amount} on terminal</s-button>
            </>
          )}

          {phase === 'refunding' && <s-text>Refunding {amount} on the terminal…</s-text>}

          {phase === 'done' && (
            <s-banner heading="Refund approved on the terminal" tone="success">
              Now record it in Shopify: close this screen, tap Return on this order, and refund {amount} to
              "Card – Network International".
            </s-banner>
          )}

          {phase === 'error' && (
            <>
              <s-banner heading="Problem" tone="critical">{message}</s-banner>
              {refundId ? (
                <s-button onClick={() => { setPhase('refunding'); follow(refundId); }}>Check again</s-button>
              ) : (
                <s-button onClick={load}>Try again</s-button>
              )}
            </>
          )}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

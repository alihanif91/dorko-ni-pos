import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { startSale, getStatus, cancelSale } from './api.js';
import { cartPaymentState, formatMinor, PROP } from './cart.js';

export default async () => {
  render(<PaymentModal />, document.body);
};

const POLL_MS = 1500;
// Stop waiting on our side after this long. The middleware keeps the
// transaction and recovers its result through NI's Get Result.
const GIVE_UP_MS = 120000;

function PaymentModal() {
  const currency = shopify.session.currentSession.currency || 'AED';
  const cart = shopify.cart.current.value;
  const initial = cartPaymentState(cart);

  // idle | starting | waiting | approved | declined | error | cancelling
  const [phase, setPhase] = useState(initial.state === 'approved' ? 'approved' : 'idle');
  const [message, setMessage] = useState('');
  const [sourceId, setSourceId] = useState(initial.sourceId || null);
  const stopped = useRef(false);

  useEffect(() => () => { stopped.current = true; }, []);

  async function charge() {
    const { total } = cartPaymentState(shopify.cart.current.value);
    if (total <= 0) return;
    setPhase('starting');
    setMessage('');
    try {
      const sale = await startSale({ amount: total, currency });
      setSourceId(sale.sourceId);
      setPhase('waiting');
      await waitForResult(sale.sourceId, total);
    } catch (err) {
      setPhase('error');
      setMessage(err.message);
    }
  }

  async function waitForResult(id, total) {
    const started = Date.now();
    while (!stopped.current && Date.now() - started < GIVE_UP_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const result = await getStatus(id);
      if (result.status === 'approved') {
        await shopify.cart.addCartProperties({
          [PROP.sourceId]: id,
          [PROP.amount]: String(total),
          [PROP.approvalCode]: result.approvalCode || '',
          [PROP.rrn]: result.rrn || '',
        });
        setPhase('approved');
        // Back to the home screen so the cashier can go straight to Checkout.
        setTimeout(() => { if (!stopped.current) shopify.navigation.close(); }, 1500);
        return;
      }
      if (result.status === 'declined' || result.status === 'cancelled') {
        setPhase('declined');
        setMessage(result.message || 'Card declined. No money was taken.');
        return;
      }
    }
    if (!stopped.current) {
      setPhase('error');
      setMessage(
        'No answer from the terminal yet. Do not charge again. Tap "Check again" to recover the result.',
      );
    }
  }

  async function checkAgain() {
    if (!sourceId) return;
    setPhase('waiting');
    const { total } = cartPaymentState(shopify.cart.current.value);
    try {
      await waitForResult(sourceId, total);
    } catch (err) {
      setPhase('error');
      setMessage(err.message);
    }
  }

  async function voidPayment() {
    if (!sourceId) return;
    setPhase('cancelling');
    try {
      await cancelSale(sourceId);
      await shopify.cart.removeCartProperties(Object.values(PROP));
      setSourceId(null);
      setPhase('idle');
      setMessage('Payment voided. You can charge again.');
    } catch (err) {
      setPhase('error');
      setMessage(err.message);
    }
  }

  const live = cartPaymentState(shopify.cart.current.value);
  const amountText = formatMinor(live.total, currency);

  return (
    <s-page heading="Pay by card (Network International)">
      <s-scroll-box>
        <s-stack direction="block" gap="base">
          {live.state === 'stale' && phase !== 'cancelling' && (
            <s-banner heading="Total changed after approval" tone="critical">
              The card was approved for {formatMinor(live.approvedAmount, currency)} but the cart is
              now {amountText}. Void the approved payment, then charge the new total.
            </s-banner>
          )}

          {phase === 'idle' && live.state === 'unpaid' && (
            <>
              <s-text>Amount to charge: {amountText}</s-text>
              <s-button variant="primary" onClick={charge}>
                Send {amountText} to terminal
              </s-button>
            </>
          )}

          {(phase === 'starting' || phase === 'waiting') && (
            <s-text>Waiting for the customer to pay {amountText} on the terminal…</s-text>
          )}

          {phase === 'approved' && live.state === 'approved' && (
            <s-banner heading="Approved" tone="success">
              Returning to the cart. Tap Checkout and choose "Card – Network International" for {amountText}.
            </s-banner>
          )}

          {phase === 'declined' && (
            <>
              <s-banner heading="Not approved" tone="warning">{message}</s-banner>
              <s-button onClick={() => setPhase('idle')}>Try again</s-button>
            </>
          )}

          {phase === 'error' && (
            <>
              <s-banner heading="Problem" tone="critical">{message}</s-banner>
              {sourceId && <s-button onClick={checkAgain}>Check again</s-button>}
            </>
          )}

          {phase === 'cancelling' && <s-text>Voiding the payment on the terminal…</s-text>}

          {sourceId && (phase === 'approved' || live.state === 'stale') && (
            <s-button tone="critical" onClick={voidPayment}>
              Void this payment
            </s-button>
          )}

          {phase === 'idle' && message && <s-text>{message}</s-text>}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}

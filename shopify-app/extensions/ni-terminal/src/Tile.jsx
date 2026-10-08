import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cartPaymentState, formatMinor } from './cart.js';

export default async () => {
  render(<Tile />, document.body);
};

function Tile() {
  const currency = shopify.session.currentSession.currency || 'AED';
  const [info, setInfo] = useState(cartPaymentState(shopify.cart.current.value));

  useEffect(() => {
    const unsubscribe = shopify.cart.current.subscribe((cart) => {
      setInfo(cartPaymentState(cart));
    });
    return unsubscribe;
  }, []);

  const subheading = {
    empty: 'Add items to charge',
    unpaid: `Charge ${formatMinor(info.total, currency)}`,
    approved: 'Approved: tap Checkout',
    stale: 'Total changed. Tap to fix',
  }[info.state];

  return (
    <s-tile
      heading="Pay by card (NI)"
      subheading={subheading}
      disabled={info.state === 'empty'}
      onClick={() => shopify.action.presentModal()}
    />
  );
}

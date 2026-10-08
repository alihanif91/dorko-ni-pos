import '@shopify/ui-extensions/preact';
import { render } from 'preact';

// "Refund on NI terminal" entry in the POS order details menu.
export default async () => {
  render(<s-button onClick={() => shopify.action.presentModal()}>Refund on NI terminal</s-button>, document.body);
};

import { useEffect, useState } from 'preact/hooks';
import { getTerminals, setActiveTerminal } from './api.js';

// Shows which NI terminal will be used and lets staff switch to the other
// one (backup failover). Hidden while a payment is in progress.
export function TerminalSwitch({ disabled = false }) {
  const [terminals, setTerminals] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getTerminals().then((r) => setTerminals(r.terminals)).catch(() => setTerminals(null));
  }, []);

  if (!terminals || terminals.length === 0) return null;
  const active = terminals.find((t) => t.active) ?? terminals[0];
  const others = terminals.filter((t) => t.tid !== active.tid);

  async function switchTo(tid) {
    setBusy(true);
    setError('');
    try {
      setTerminals((await setActiveTerminal(tid)).terminals);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-stack direction="block" gap="small">
      <s-text>Terminal: {active.name}</s-text>
      {!disabled && others.map((t) => (
        <s-button key={t.tid} disabled={busy} onClick={() => switchTo(t.tid)}>
          Use {t.name} terminal
        </s-button>
      ))}
      {error && <s-text>{error}</s-text>}
    </s-stack>
  );
}

// The store's NI terminals and which one is active.
//
// NI routes each Push to Pay request by the MID and TID in the API URL
// (Shahrukh, NI, 12 Oct 2026). Dorko has a main and a backup terminal, so
// "failover" is simply choosing which TID new sales go to. The choice is
// per shop and stored in the database; each transaction remembers the TID
// it was sent to, so Get Result and void always go back to that terminal.
//
// Config:
//   NI_MID=<merchant ID>
//   NI_TERMINALS=Main:<TID>,Backup:<TID>     (first one is the default)

const MOCK = { mid: 'MOCKMID', list: 'Main:MOCKT1,Backup:MOCKT2' };

export function parseTerminals(env = process.env) {
  const live = env.NI_MODE === 'live';
  const mid = env.NI_MID || (live ? '' : MOCK.mid);
  const list = env.NI_TERMINALS || (live ? '' : MOCK.list);
  if (!mid || !list) throw new Error('NI_MID and NI_TERMINALS are required in live mode');
  const terminals = list.split(',').map((entry) => {
    const [name, tid] = entry.split(':').map((s) => s?.trim());
    if (!name || !tid) throw new Error(`Bad NI_TERMINALS entry "${entry}" (expected Name:TID)`);
    return { name, tid };
  });
  if (new Set(terminals.map((t) => t.tid)).size !== terminals.length) {
    throw new Error('NI_TERMINALS has a duplicate TID');
  }
  return { mid, terminals };
}

export function createTerminals(db, config = parseTerminals({})) {
  const { mid, terminals } = config;
  const getActive = db.prepare('SELECT tid FROM shop_terminal WHERE shop = ?');
  const setActive = db.prepare(
    'INSERT INTO shop_terminal (shop, tid, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(shop) DO UPDATE SET tid = excluded.tid, updated_at = excluded.updated_at',
  );
  const byTid = (tid) => terminals.find((t) => t.tid === tid) ?? null;

  return {
    mid,
    // The terminal new sales and refunds go to.
    active(shop) {
      return byTid(getActive.get(shop)?.tid) ?? terminals[0];
    },
    setActive(shop, tid) {
      const t = byTid(tid);
      if (!t) return null;
      setActive.run(shop, t.tid, Date.now());
      return t;
    },
    // A transaction's own terminal (falls back to the default for rows
    // created before terminals were recorded).
    forRow(row) {
      return byTid(row?.tid) ?? terminals[0];
    },
    list(shop) {
      const current = this.active(shop).tid;
      return terminals.map((t) => ({ name: t.name, tid: t.tid, active: t.tid === current }));
    },
  };
}

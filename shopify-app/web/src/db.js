import { DatabaseSync } from 'node:sqlite';

// One row per terminal transaction. This is what lets us recover a result
// after a timeout: the SourceID is stored before NI is ever called.
export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      source_id      TEXT PRIMARY KEY,
      shop           TEXT NOT NULL,
      type           TEXT NOT NULL,          -- sale | refund
      parent_id      TEXT,                   -- refund: the original sale
      amount_minor   INTEGER NOT NULL,       -- fils
      currency       TEXT NOT NULL,
      status         TEXT NOT NULL,          -- pending | approved | declined | cancelled | error
      approval_code  TEXT,
      rrn            TEXT,
      message        TEXT,
      staff_id       TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_recovery_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_parent ON transactions(parent_id);
    -- Offline Admin API tokens from token exchange, one per shop.
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop       TEXT PRIMARY KEY,
      token      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Columns added after the first release (8 Oct): link refunds to the
  // Shopify order and record whether Shopify's refund was created.
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  for (const [name, type] of [
    ['order_id', 'TEXT'], ['shopify_refund_id', 'TEXT'], ['shopify_error', 'TEXT'], ['restocked', 'INTEGER'],
  ]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`);
  }
  return db;
}

export function makeRepo(db) {
  const insert = db.prepare(`
    INSERT INTO transactions (source_id, shop, type, parent_id, amount_minor, currency,
      status, staff_id, order_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`);
  const setOrder = db.prepare('UPDATE transactions SET order_id = ? WHERE source_id = ?');
  const setShopify = db.prepare(`
    UPDATE transactions SET shopify_refund_id = ?, shopify_error = ?, restocked = ?, updated_at = ?
    WHERE source_id = ?`);
  const get = db.prepare('SELECT * FROM transactions WHERE source_id = ?');
  const update = db.prepare(`
    UPDATE transactions SET status = ?, approval_code = COALESCE(?, approval_code),
      rrn = COALESCE(?, rrn), message = ?, updated_at = ?
    WHERE source_id = ?`);
  const markRecovery = db.prepare(
    'UPDATE transactions SET last_recovery_at = ? WHERE source_id = ?',
  );

  const refundsOf = db.prepare(
    "SELECT * FROM transactions WHERE parent_id = ? AND type = 'refund' ORDER BY created_at DESC",
  );

  return {
    refundsOf(parentId) {
      return refundsOf.all(parentId);
    },
    create({ sourceId, shop, type = 'sale', parentId = null, amountMinor, currency, staffId, orderId = null }) {
      const now = Date.now();
      insert.run(sourceId, shop, type, parentId, amountMinor, currency, staffId ?? null,
        orderId == null ? null : String(orderId), now, now);
      return get.get(sourceId);
    },
    get(sourceId) {
      return get.get(sourceId) ?? null;
    },
    setResult(sourceId, { status, approvalCode = null, rrn = null, message = null }) {
      update.run(status, approvalCode, rrn, message, Date.now(), sourceId);
      return get.get(sourceId);
    },
    setOrderId(sourceId, orderId) {
      setOrder.run(String(orderId), sourceId);
      return get.get(sourceId);
    },
    setShopifyRefund(sourceId, { refundId = null, error = null, restocked = null }) {
      setShopify.run(refundId, error, restocked == null ? null : (restocked ? 1 : 0), Date.now(), sourceId);
      return get.get(sourceId);
    },
    markRecovery(sourceId) {
      markRecovery.run(Date.now(), sourceId);
    },
  };
}

export function makeTokenStore(db) {
  const get = db.prepare('SELECT token FROM shop_tokens WHERE shop = ?');
  const set = db.prepare(
    'INSERT INTO shop_tokens (shop, token, created_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(shop) DO UPDATE SET token = excluded.token, created_at = excluded.created_at',
  );
  const del = db.prepare('DELETE FROM shop_tokens WHERE shop = ?');
  return {
    get: (shop) => get.get(shop)?.token ?? null,
    set: (shop, token) => { set.run(shop, token, Date.now()); },
    delete: (shop) => { del.run(shop); },
  };
}

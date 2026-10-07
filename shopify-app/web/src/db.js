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
  `);
  return db;
}

export function makeRepo(db) {
  const insert = db.prepare(`
    INSERT INTO transactions (source_id, shop, type, parent_id, amount_minor, currency,
      status, staff_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`);
  const get = db.prepare('SELECT * FROM transactions WHERE source_id = ?');
  const update = db.prepare(`
    UPDATE transactions SET status = ?, approval_code = COALESCE(?, approval_code),
      rrn = COALESCE(?, rrn), message = ?, updated_at = ?
    WHERE source_id = ?`);
  const markRecovery = db.prepare(
    'UPDATE transactions SET last_recovery_at = ? WHERE source_id = ?',
  );

  return {
    create({ sourceId, shop, type = 'sale', parentId = null, amountMinor, currency, staffId }) {
      const now = Date.now();
      insert.run(sourceId, shop, type, parentId, amountMinor, currency, staffId ?? null, now, now);
      return get.get(sourceId);
    },
    get(sourceId) {
      return get.get(sourceId) ?? null;
    },
    setResult(sourceId, { status, approvalCode = null, rrn = null, message = null }) {
      update.run(status, approvalCode, rrn, message, Date.now(), sourceId);
      return get.get(sourceId);
    },
    markRecovery(sourceId) {
      markRecovery.run(Date.now(), sourceId);
    },
  };
}

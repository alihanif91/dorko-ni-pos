// Pure helpers for the Reem Mall dashboard (tested in reem-mall/test).

export const STATUS_LABEL = {
  sent: 'Sent', no_sales: 'No sales', not_live: 'Before go-live', failed: 'Failed', partial: 'Sent, needs a look', missing: 'No record',
};
export const STATUS_TONE = {
  sent: 'success', no_sales: 'neutral', not_live: 'info', failed: 'critical', partial: 'warning', missing: 'warning',
};

const num = (v) => (v === '' || v == null ? 0 : Number(v));

// Metaobject nodes -> day entries, newest first.
export function parseDays(nodes) {
  return nodes.map((n) => {
    const f = Object.fromEntries(n.fields.map((x) => [x.key, x.value]));
    let rows = [];
    try { rows = JSON.parse(f.rows || '[]'); } catch { rows = []; }
    return {
      day: f.day,
      status: f.status || 'failed',
      invoices: num(f.invoices), refunds: num(f.refunds),
      turnover: num(f.turnover), discount: num(f.discount), net: num(f.net), vat: num(f.vat),
      items: num(f.items), accepted: num(f.accepted),
      ranAt: f.ran_at || '', message: f.message || '', rows,
    };
  }).filter((d) => d.day).sort((a, b) => b.day.localeCompare(a.day));
}

// Adds "No record" days between the first logged day and `until` (yesterday
// in Dubai) so a night the job didn't run is visible, not silent.
export function withMissingDays(days, until) {
  if (!days.length) return days;
  const have = new Set(days.map((d) => d.day));
  const first = days[days.length - 1].day;
  const out = [...days];
  for (let t = new Date(`${first}T00:00:00Z`); t <= new Date(`${until}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1)) {
    const day = t.toISOString().slice(0, 10);
    if (!have.has(day)) {
      out.push({ day, status: 'missing', invoices: 0, refunds: 0, turnover: 0, discount: 0, net: 0, vat: 0, items: 0, accepted: 0, ranAt: '', message: 'The nightly job did not record this day', rows: [] });
    }
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

export function yesterdayInDubai(now = new Date()) {
  const d = new Date(now.getTime() + 4 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const monthOf = (day) => day.slice(0, 7);

export function months(days) {
  return [...new Set(days.map((d) => monthOf(d.day)))].sort().reverse();
}

export function filterDays(days, { month = 'all', status = 'all' } = {}) {
  return days.filter((d) => (month === 'all' || monthOf(d.day) === month) && (status === 'all' || d.status === status));
}

const round = (n) => Number(n.toFixed(2));

export function summarise(days) {
  const s = { sent: 0, no_sales: 0, not_live: 0, failed: 0, partial: 0, missing: 0, invoices: 0, refunds: 0, turnover: 0, discount: 0, net: 0, vat: 0, items: 0 };
  for (const d of days) {
    s[d.status] = (s[d.status] || 0) + 1;
    for (const k of ['invoices', 'refunds', 'turnover', 'discount', 'net', 'vat', 'items']) s[k] += d[k];
  }
  for (const k of ['turnover', 'discount', 'net', 'vat']) s[k] = round(s[k]);
  return s;
}

// Accounting view: one line per month, newest first.
export function byMonth(days) {
  return months(days).map((m) => ({ month: m, ...summarise(days.filter((d) => monthOf(d.day) === m)) }));
}

// Search rows by invoice/order number across the given days.
export function searchRows(days, term) {
  const t = term.trim().replace(/^#/, '').toLowerCase();
  if (!t) return [];
  const out = [];
  for (const d of days) {
    for (const r of d.rows) {
      if (String(r.id).toLowerCase().includes(t) || String(r.name || '').replace(/^#/, '').toLowerCase().includes(t)) out.push({ ...r, day: d.day });
    }
  }
  return out;
}

export function money(n) {
  return `AED ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function orderLink(gid) {
  const id = String(gid || '').split('/').pop();
  return id ? `shopify://admin/orders/${id}` : null;
}

export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

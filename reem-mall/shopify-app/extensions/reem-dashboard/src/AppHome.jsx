import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  STATUS_LABEL, STATUS_TONE, parseDays, withMissingDays, yesterdayInDubai, months, filterDays,
  summarise, byMonth, searchRows, money, orderLink, monthLabel,
} from './data.js';

export default async () => {
  render(<Dashboard />, document.body);
};

const DAYS_QUERY = `query Days($after: String) {
  metaobjects(type: "$app:reem_feed_day", first: 250, after: $after, sortKey: "display_name", reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { handle fields { key value } }
  }
}`;

async function loadDays() {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 8; page++) {
    const res = await shopify.query(DAYS_QUERY, { variables: { after } });
    if (res.errors?.length) throw new Error(res.errors[0].message);
    const conn = res.data.metaobjects;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return withMissingDays(parseDays(nodes), yesterdayInDubai());
}

function Dashboard() {
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  const [month, setMonth] = useState('all');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState(null);
  const [term, setTerm] = useState('');

  const refresh = () => {
    setError('');
    loadDays().then((d) => {
      setDays(d);
      if (d.length && month === 'all') setMonth(d[0].day.slice(0, 7));
    }).catch((e) => setError(e.message));
  };
  useEffect(refresh, []);

  const visible = useMemo(() => (days ? filterDays(days, { month, status }) : []), [days, month, status]);
  const totals = useMemo(() => summarise(filterDays(days || [], { month })), [days, month]);
  const monthly = useMemo(() => byMonth((days || []).filter((d) => d.status !== 'missing')), [days]);
  const found = useMemo(() => searchRows(filterDays(days || [], { month }), term), [days, month, term]);
  const latest = days?.[0];
  const day = selected && days?.find((d) => d.day === selected);

  if (error) {
    return (
      <s-page heading="Reem Mall sales feed">
        <s-banner tone="critical" heading="Couldn't load the feed log">{error}</s-banner>
        <s-button onClick={refresh}>Try again</s-button>
      </s-page>
    );
  }
  if (!days) return <s-page heading="Reem Mall sales feed"><s-spinner /></s-page>;

  return (
    <s-page heading="Reem Mall sales feed">
      <s-button slot="secondary-actions" onClick={refresh}>Refresh</s-button>

      {!days.length && (
        <s-banner tone="info" heading="Nothing recorded yet">
          The nightly job sends yesterday's Reem Mall POS sales to the mall at 3:15 AM and records each day here.
        </s-banner>
      )}
      {latest && (latest.status === 'failed' || latest.status === 'missing') && (
        <s-banner tone="critical" heading={`${latest.day}: ${STATUS_LABEL[latest.status]}`}>
          {latest.message || 'Check the nightly job.'}
        </s-banner>
      )}
      {latest && latest.status === 'partial' && (
        <s-banner tone="warning" heading={`${latest.day}: sent, but something needs a look`}>{latest.message}</s-banner>
      )}

      <s-section heading="Filters">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <s-select label="Month" value={month} onChange={(e) => { setMonth(e.currentTarget.value); setSelected(null); }}>
            <s-option value="all">All months</s-option>
            {months(days).map((m) => <s-option value={m}>{monthLabel(m)}</s-option>)}
          </s-select>
          <s-select label="Status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <s-option value="all">All days</s-option>
            {Object.keys(STATUS_LABEL).map((s) => <s-option value={s}>{STATUS_LABEL[s]}</s-option>)}
          </s-select>
          <s-search-field label="Find invoice or order" placeholder="e.g. 1045" value={term}
            onInput={(e) => setTerm(e.currentTarget.value)} />
        </s-grid>
      </s-section>

      <s-section heading={month === 'all' ? 'All time' : monthLabel(month)}>
        <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
          <Stat label="Net sales (before VAT)" value={money(totals.net)} />
          <Stat label="VAT" value={money(totals.vat)} />
          <Stat label="Turnover (before discount)" value={money(totals.turnover)} />
          <Stat label="Discount" value={money(totals.discount)} />
          <Stat label="Invoices" value={totals.invoices} />
          <Stat label="Refunds" value={totals.refunds} />
          <Stat label="Items (net)" value={totals.items} />
          <Stat label="Days sent / no sales / failed" value={`${totals.sent + totals.partial} / ${totals.no_sales} / ${totals.failed + totals.missing}`} />
        </s-grid>
        <s-text color="subdued">Net sales = turnover + discount, the same figure as the Turnover column in Reem Mall's report.</s-text>
      </s-section>

      {term && (
        <s-section heading={`Search: ${term}`}>
          {found.length ? <RowsTable rows={found} showDay /> : <s-text>No invoice or refund matches "{term}" in this period.</s-text>}
        </s-section>
      )}

      <s-section heading="Daily activity">
        <s-table>
          <s-table-header-row>
            <s-table-header>Day</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header format="numeric">Invoices</s-table-header>
            <s-table-header format="numeric">Refunds</s-table-header>
            <s-table-header format="currency">Net sales</s-table-header>
            <s-table-header format="currency">VAT</s-table-header>
            <s-table-header format="numeric">Accepted</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {visible.map((d) => (
              <s-table-row>
                <s-table-cell>{d.day}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-300">
                    <s-badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status] || d.status}</s-badge>
                    {d.message && d.status !== 'missing' && <s-text color="subdued">{d.message}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{d.invoices}</s-table-cell>
                <s-table-cell>{d.refunds}</s-table-cell>
                <s-table-cell>{money(d.net)}</s-table-cell>
                <s-table-cell>{money(d.vat)}</s-table-cell>
                <s-table-cell>{d.status === 'missing' || d.status === 'not_live' ? '–' : `${d.accepted}/${d.rows.length}`}</s-table-cell>
                <s-table-cell>
                  {d.rows.length > 0 && <s-button variant="tertiary" onClick={() => setSelected(d.day)}>View</s-button>}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!visible.length && <s-text>No days match these filters.</s-text>}
      </s-section>

      {day && (
        <s-section heading={`What was sent for ${day.day}`}>
          <s-stack direction="block" gap="base">
            <s-text>{STATUS_LABEL[day.status]}{day.ranAt ? ` · ran ${new Date(day.ranAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })}` : ''}{day.message ? ` · ${day.message}` : ''}</s-text>
            <RowsTable rows={day.rows} />
            <s-button variant="tertiary" onClick={() => setSelected(null)}>Close</s-button>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Monthly accounting">
        <s-table>
          <s-table-header-row>
            <s-table-header>Month</s-table-header>
            <s-table-header format="numeric">Invoices</s-table-header>
            <s-table-header format="numeric">Refunds</s-table-header>
            <s-table-header format="currency">Turnover</s-table-header>
            <s-table-header format="currency">Discount</s-table-header>
            <s-table-header format="currency">Net sales</s-table-header>
            <s-table-header format="currency">VAT</s-table-header>
            <s-table-header format="numeric">Items</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {monthly.map((m) => (
              <s-table-row>
                <s-table-cell>{monthLabel(m.month)}</s-table-cell>
                <s-table-cell>{m.invoices}</s-table-cell>
                <s-table-cell>{m.refunds}</s-table-cell>
                <s-table-cell>{money(m.turnover)}</s-table-cell>
                <s-table-cell>{money(m.discount)}</s-table-cell>
                <s-table-cell>{money(m.net)}</s-table-cell>
                <s-table-cell>{money(m.vat)}</s-table-cell>
                <s-table-cell>{m.items}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-stack direction="block" gap="small-200" alignItems="center" paddingBlock="large">
        <s-divider />
        <s-text color="subdued">
          Built and maintained by <s-link href="https://ali.hanif.pk" target="_blank">Ali Hanif</s-link> · Ecommerce Consultant, UX &amp; Shopify Development
        </s-text>
        <s-text color="subdued">
          Questions or changes: <s-link href="mailto:ali@hanif.pk">ali@hanif.pk</s-link> · <s-link href="https://wa.me/971582285766" target="_blank">+971 58 228 5766</s-link>
        </s-text>
      </s-stack>
    </s-page>
  );
}

function Stat({ label, value }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

function RowsTable({ rows, showDay = false }) {
  return (
    <s-table>
      <s-table-header-row>
        {showDay && <s-table-header>Day</s-table-header>}
        <s-table-header>Invoice / refund</s-table-header>
        <s-table-header>Type</s-table-header>
        <s-table-header>Time</s-table-header>
        <s-table-header format="currency">Turnover</s-table-header>
        <s-table-header format="currency">Discount</s-table-header>
        <s-table-header format="currency">VAT</s-table-header>
        <s-table-header format="numeric">Items</s-table-header>
        <s-table-header>Order</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((r) => (
          <s-table-row>
            {showDay && <s-table-cell>{r.day}</s-table-cell>}
            <s-table-cell>{r.id}</s-table-cell>
            <s-table-cell><s-badge tone={r.kind === 'refund' ? 'warning' : 'info'}>{r.kind === 'refund' ? 'Refund' : 'Sale'}</s-badge></s-table-cell>
            <s-table-cell>{String(r.at || '').slice(11, 16)}</s-table-cell>
            <s-table-cell>{money(r.turnover)}</s-table-cell>
            <s-table-cell>{money(r.discount)}</s-table-cell>
            <s-table-cell>{money(r.vat)}</s-table-cell>
            <s-table-cell>{r.items}</s-table-cell>
            <s-table-cell>{orderLink(r.order) ? <s-link href={orderLink(r.order)}>{r.name || 'Open'}</s-link> : r.name}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

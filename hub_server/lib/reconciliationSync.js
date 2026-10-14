// Pushes the hub's cash-up records to the cloud (Supabase). Companion to invoiceSync.js, with
// one difference that matters: a closed shift is immutable, so these are inserted with
// ON CONFLICT DO NOTHING rather than upserted. A retry after a push that succeeded but was never
// confirmed is then a no-op, and the table needs no UPDATE grant.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.
//
// See database/migrations/006_reconciliation_cloud_replication.sql.

/** Money as the migration's NUMERIC(12,2) expects. A cash-up exists to surface small variances. */
const money = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const when = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const json = value => (value && typeof value === 'object' ? value : null);

/** One stored cash-up as the row the cloud holds. */
export function reconciliationRow(restaurantId, record) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(record.id),
    seq: Number(record.seq) || 0,
    number: String(record.number),

    period_start: when(record.period_start),
    period_end: when(record.period_end),

    opening_float: money(record.opening_float),
    counted_cash: money(record.counted_cash),
    cash_removed: money(record.cash_removed),
    closing_float: money(record.closing_float),
    expected_cash: money(record.expected_cash),
    cash_variance: money(record.cash_variance),

    status: record.status === 'variance' ? 'variance' : 'balanced',
    has_variance: Boolean(record.has_variance),

    methods: json(record.methods),
    totals: json(record.totals),
    voided: json(record.voided),
    unpaid_at_close: json(record.unpaid_at_close),

    notes: record.notes || null,
    closed_by: record.closed_by || null,
    synced_at: new Date().toISOString()
  };
}

function check(result) {
  if (result?.error) {
    const err = new Error(result.error.message || 'Supabase rejected the cash-up push');
    err.code = result.error.code;
    err.details = result.error.details || result.error.hint || null;
    throw err;
  }
  return result;
}

/** Inserts one cash-up, ignoring a record the cloud already holds. Throws on rejection. */
export async function pushReconciliation(client, restaurantId, record) {
  const row = reconciliationRow(restaurantId, record);
  check(await client.from('reconciliations').upsert([row], {
    onConflict: 'restaurant_id,hub_ref',
    ignoreDuplicates: true
  }));
  return { number: row.number, status: row.status };
}

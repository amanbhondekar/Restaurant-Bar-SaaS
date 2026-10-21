// Pushes the hub's invoices to the cloud (Supabase). The hub is the single writer: each push is a
// full snapshot of one bill, upserted on (restaurant_id, hub_ref), so a bill that is later paid,
// voided, refunded or split updates in place. Bills are never deleted -- a void is a state
// transition, not a removal -- so there is no delete-stale pass like the catalog has.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.
//
// See database/migrations/005_invoice_cloud_replication.sql. Until that migration, a tenant's
// revenue history lived only on the reception laptop.

/** Money as the migration's NUMERIC(12,2) expects: a number, or 0 for anything unusable. */
const money = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** A timestamp column: a valid ISO string or null, never the empty string. */
const when = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** JSONB columns: keep arrays whole, and send null rather than an empty placeholder. */
const json = value => (Array.isArray(value) && value.length ? value : Array.isArray(value) ? [] : null);

/**
 * One on-disk invoice as the row the cloud holds.
 *
 * The hub's own id becomes hub_ref; the cloud's `id` is its own UUID and is never read back, so a
 * bill keeps its hub identity across pushes and re-pairings of the same tenant.
 */
export function invoiceRow(restaurantId, invoice) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(invoice.id),
    invoice_number: String(invoice.invoice_number),

    table_id: invoice.table_id === null || invoice.table_id === undefined ? null : String(invoice.table_id),
    table_name: invoice.table_name || null,
    currency: invoice.currency || '₹',

    subtotal: money(invoice.subtotal),
    discount_total: money(invoice.discount_total),
    subtotal_after_discount: money(invoice.subtotal_after_discount),
    service_charge_percent: money(invoice.service_charge_percent),
    service_charge_amount: money(invoice.service_charge_amount),
    taxable_base: money(invoice.taxable_base),
    tax_total: money(invoice.tax_total),
    grand_total: money(invoice.grand_total),

    payment_status: invoice.payment_status || 'pending',
    payment_method: invoice.payment_method || null,
    payment_ref: invoice.payment_ref || null,
    paid_at: when(invoice.paid_at),
    voided_at: when(invoice.voided_at),
    void_reason: invoice.void_reason || null,
    refunded_at: when(invoice.refunded_at),
    refund_reason: invoice.refund_reason || null,

    tickets: json(invoice.tickets),
    ticket_ids: json(invoice.ticket_ids),
    items: json(invoice.items),
    tax_rows: json(invoice.tax_rows),
    discount_rows: json(invoice.discount_rows),
    splits: json(invoice.splits),

    issued_at: when(invoice.issued_at),
    synced_at: new Date().toISOString()
  };
}

/**
 * One cloud row as the hub's on-disk invoice.
 *
 * The inverse of invoiceRow: hub_ref carries the hub's own id, so a restored bill keeps the
 * identity its tickets and splits referred to. `synced_to_cloud` is true by construction -- it
 * came from the cloud, so the cloud has it.
 */
export function invoiceFromCloud(row) {
  return {
    id: String(row.hub_ref || row.id),
    restaurant_id: row.restaurant_id,
    invoice_number: row.invoice_number,

    table_id: row.table_id ?? null,
    table_name: row.table_name ?? null,
    currency: row.currency || '₹',

    subtotal: Number(row.subtotal) || 0,
    discount_total: Number(row.discount_total) || 0,
    subtotal_after_discount: Number(row.subtotal_after_discount) || 0,
    service_charge_percent: Number(row.service_charge_percent) || 0,
    service_charge_amount: Number(row.service_charge_amount) || 0,
    taxable_base: Number(row.taxable_base) || 0,
    tax_total: Number(row.tax_total) || 0,
    grand_total: Number(row.grand_total) || 0,

    payment_status: row.payment_status || 'pending',
    ...(row.payment_method ? { payment_method: row.payment_method } : {}),
    ...(row.payment_ref ? { payment_ref: row.payment_ref } : {}),
    ...(row.paid_at ? { paid_at: row.paid_at } : {}),
    ...(row.voided_at ? { voided_at: row.voided_at } : {}),
    ...(row.void_reason ? { void_reason: row.void_reason } : {}),
    ...(row.refunded_at ? { refunded_at: row.refunded_at } : {}),
    ...(row.refund_reason ? { refund_reason: row.refund_reason } : {}),

    tickets: row.tickets || [],
    ticket_ids: row.ticket_ids || [],
    items: row.items || [],
    tax_rows: row.tax_rows || [],
    discount_rows: row.discount_rows || [],
    ...(row.splits ? { splits: row.splits } : {}),

    issued_at: row.issued_at,
    synced_to_cloud: true
  };
}

/**
 * How many bills the cloud holds for this tenant, without downloading any of them. `head: true`
 * asks PostgREST for the count and no rows, so this stays cheap enough to run at boot.
 */
export async function countInvoices(client, restaurantId) {
  const { count, error } = await client
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId);
  if (error) {
    const err = new Error(error.message || 'Supabase refused to count invoices');
    err.code = error.code;
    throw err;
  }
  return Number(count) || 0;
}

/** Every bill the cloud holds for this tenant, newest first -- the order the hub stores them in. */
export async function pullInvoices(client, restaurantId) {
  const { data, error } = await client
    .from('invoices')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('issued_at', { ascending: false });
  if (error) {
    const err = new Error(error.message || 'Supabase refused to read invoices');
    err.code = error.code;
    throw err;
  }
  return (data || []).map(invoiceFromCloud);
}

function check(result) {
  if (result?.error) {
    const err = new Error(result.error.message || 'Supabase rejected the invoice push');
    err.code = result.error.code;
    err.details = result.error.details || result.error.hint || null;
    throw err;
  }
  return result;
}

/** Upserts one bill. Throws on rejection so the queue can count the attempt and retry. */
export async function pushInvoice(client, restaurantId, invoice) {
  const row = invoiceRow(restaurantId, invoice);
  check(await client.from('invoices').upsert([row], { onConflict: 'restaurant_id,hub_ref' }));
  return { invoice_number: row.invoice_number, payment_status: row.payment_status };
}

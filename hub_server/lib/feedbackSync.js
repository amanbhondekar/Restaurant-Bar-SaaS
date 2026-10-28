// Pushes guest feedback to the cloud (migration 013). A guest's rating is a statement already made, so it
// is inserted with ON CONFLICT DO NOTHING, like a cash-up: a retry after a push that succeeded but was
// never confirmed is a no-op, and the table needs no UPDATE grant.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.

const when = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** One stored entry as the row the cloud holds. `table` on the hub is `table_label` in the cloud. */
export function feedbackRow(restaurantId, entry) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(entry.id),
    rating: Number(entry.rating),
    comment: entry.comment ?? null,
    table_label: entry.table ?? null,
    invoice_number: entry.invoice_number ?? null,
    invoice_ref: entry.invoice_id ?? null,
    created_at: when(entry.created_at) ?? new Date().toISOString(),
    synced_at: new Date().toISOString()
  };
}

/** One cloud row as the hub's own entry. The inverse of feedbackRow. */
export function feedbackFromCloud(row) {
  return {
    id: String(row.hub_ref || row.id),
    restaurant_id: row.restaurant_id,
    table: row.table_label ?? null,
    rating: Number(row.rating),
    comment: row.comment ?? null,
    invoice_number: row.invoice_number ?? null,
    invoice_id: row.invoice_ref ?? null,
    created_at: row.created_at,
    synced_to_cloud: true
  };
}

function check(result, what) {
  if (result?.error) {
    const err = new Error(result.error.message || `Supabase rejected the ${what}`);
    err.code = result.error.code;
    err.details = result.error.details || result.error.hint || null;
    throw err;
  }
  return result;
}

/** Inserts one entry, ignoring one the cloud already holds. Throws on rejection. */
export async function pushFeedback(client, restaurantId, entry) {
  const row = feedbackRow(restaurantId, entry);
  check(await client.from('guest_feedback').upsert([row], {
    onConflict: 'restaurant_id,hub_ref',
    ignoreDuplicates: true
  }), 'feedback push');
  return { id: row.hub_ref, rating: row.rating };
}

/** Every entry the cloud holds for this tenant, oldest first (the order the hub appends in). */
export async function pullFeedback(client, restaurantId) {
  const { data, error } = await client
    .from('guest_feedback')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true });
  check({ error }, 'feedback read');
  return (data || []).filter(r => r.hub_ref).map(feedbackFromCloud);
}

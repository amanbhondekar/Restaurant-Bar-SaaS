// Pushes the history of a bill to the cloud (migration 022). An event is a statement already made, so it is inserted with
// ON CONFLICT DO NOTHING, like a cash-up or a guest's feedback: a retry after a push that succeeded but was never confirmed is a no-op,
// and the table has no UPDATE and no DELETE. The cloud also refuses a history that skips an event, does not chain, or puts a DIFFERENT
// event under a number already used, so a fork is an error here and not a silent no-op.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.

const PAGE = 1000;

const iso = value => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
};

/** One hub event as the row the cloud holds. The bill's hub id is `invoice_hub_ref` there. */
export function eventRow(restaurantId, event) {
  if (event.restaurant_id !== restaurantId) throw new Error(`Event ${event.id} belongs to restaurant ${event.restaurant_id}, not ${restaurantId}.`);
  return {
    restaurant_id: restaurantId,
    invoice_hub_ref: event.invoice_ref,
    seq: event.seq,
    event_type: event.type,
    actor: event.actor ?? null,
    occurred_at: event.occurred_at,
    payload: event.payload,
    prev_hash: event.prev_hash,
    hash: event.hash,
    synced_at: new Date().toISOString()
  };
}

/** One cloud row as the hub's own event. The inverse of eventRow. */
export function eventFromCloud(row) {
  return {
    id: `${row.invoice_hub_ref}#${row.seq}`,
    restaurant_id: row.restaurant_id,
    invoice_ref: row.invoice_hub_ref,
    seq: Number(row.seq),
    type: row.event_type,
    actor: row.actor ?? null,
    occurred_at: iso(row.occurred_at),
    payload: row.payload,
    prev_hash: row.prev_hash,
    hash: row.hash
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

/** Inserts these events, which must be in order and may overlap what the cloud holds. Throws on rejection. */
export async function pushInvoiceEvents(client, restaurantId, events) {
  if (!events.length) return { ids: [] };
  const rows = events.map(e => eventRow(restaurantId, e));
  check(await client.from('invoice_events').upsert(rows, {
    onConflict: 'restaurant_id,invoice_hub_ref,seq',
    ignoreDuplicates: true
  }), 'invoice event push');
  return { ids: events.map(e => e.id) };
}

/** Every event the cloud holds for this tenant, a bill at a time and in order within a bill. Read a page at a time: PostgREST caps a response. */
export async function pullInvoiceEvents(client, restaurantId) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('invoice_events')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('invoice_hub_ref', { ascending: true })
      .order('seq', { ascending: true })
      .range(from, from + PAGE - 1);
    check({ error }, 'invoice event read');
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows
    .filter(r => r.invoice_hub_ref)
    .map(eventFromCloud)
    .sort((a, b) => (a.invoice_ref < b.invoice_ref ? -1 : a.invoice_ref > b.invoice_ref ? 1 : a.seq - b.seq));
}

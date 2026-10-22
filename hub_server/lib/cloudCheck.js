import { cloudSchema } from './sqlSchema.js';
import { invoiceRow, pushInvoice, pullInvoices } from './invoiceSync.js';

// Proving the cloud copy against a REAL Supabase project, once there is one.
//
// Everything about replication so far has been proven against fakes, which cannot say whether the project
// the hub will talk to has the tables, the columns, and the migrations the hub assumes. This does, and says
// which migration to run when it does not. It is read-only unless a probe is asked for, and the probe is a
// single clearly-named bill that is deleted again.
//
// `client` is a supabase-js client with a key that may read the tables (the service role, in practice). It
// is a parameter so the logic is tested against a fake with the same error shapes PostgREST gives.

/** What a refused query means: the table is not there, or a column in it is not. */
export function classify(error, table) {
  if (!error) return null;
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  if (error.code === 'PGRST205' || error.code === '42P01' || /could not find the table|relation .* does not exist/i.test(text)) {
    return { kind: 'table', table };
  }
  const col = /could not find the '([^']+)' column|column "?([a-z0-9_.]+)"? (?:of relation "?\w+"? )?does not exist/i.exec(error.message ?? '');
  if (error.code === 'PGRST204' || error.code === '42703' || col) {
    return { kind: 'column', table, column: (col?.[1] ?? col?.[2] ?? '').split('.').pop() || null };
  }
  if (error.code === '42501' || /permission denied|row-level security/i.test(text)) return { kind: 'permission', table };
  return { kind: 'other', table, message: error.message ?? String(error) };
}

/**
 * Asks the project for every column the migrations define on every table the hub or the operator service
 * writes to, one table at a time, with no rows. Returns one finding per table.
 */
export async function checkTables(client, schema = cloudSchema(), tables = Object.keys(schema)) {
  const findings = [];
  for (const table of tables) {
    const t = schema[table];
    if (!t) continue;
    const columns = [...t.columns.keys()];
    let { error } = await client.from(table).select(columns.join(',')).limit(0);
    if (!error) { findings.push({ table, ok: true }); continue; }

    const what = classify(error, table);
    // A missing column is probed one by one, so the answer names every absent column and the migration
    // that adds each, not just the first one PostgREST happened to complain about.
    const missing = [];
    if (what.kind === 'column') {
      for (const name of columns) {
        ({ error } = await client.from(table).select(name).limit(0));
        if (error && classify(error, table)?.kind === 'column') missing.push({ column: name, migration: t.columns.get(name).source });
      }
    }
    // A table that is not there is created by one file; say which.
    findings.push({ table, ok: false, problem: what, missing, ...(what.kind === 'table' ? { migration: t.source } : {}) });
  }
  return findings;
}

/** The distinct migrations that findings say are missing, in order: what to run. */
export function migrationsToRun(findings) {
  return [...new Set(findings.flatMap(f => [...(f.missing?.map(m => m.migration) ?? []), ...(f.migration ? [f.migration] : [])]))]
    .filter(m => m !== 'supabase_schema.sql').sort();
}

const PROBE_REF = 'cloud_check_probe';
const PROBE_BILL = {
  id: PROBE_REF, invoice_number: 'CLOUD-CHECK', table_id: 0, table_name: 'cloud:check', currency: '₹',
  subtotal: 1, discount_total: 0, subtotal_after_discount: 1, service_charge_percent: 0, service_charge_amount: 0,
  taxable_base: 1, tax_total: 0, grand_total: 1, payment_status: 'void', void_reason: 'cloud:check probe, safe to delete',
  tickets: [], ticket_ids: [], items: [{ name: 'probe', qty: 1 }], tax_rows: [], discount_rows: [], splits: [],
  issued_at: '2026-01-01T00:00:00.000Z', voided_at: '2026-01-01T00:00:00.000Z'
};

/**
 * Writes one voided probe bill for `restaurantId`, reads it back through the hub's own restore path, and
 * deletes it. Proves the write, the unique key, the read and the row-level security for that tenant. A bill
 * left behind by a crash between the write and the delete is voided, named, and removed by the next run.
 */
export async function roundTrip(client, restaurantId) {
  const steps = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); steps.push({ name, ok: true, detail }); return true; } catch (e) { steps.push({ name, ok: false, detail: e?.message ?? String(e) }); return false; }
  };
  const remove = async () => {
    const { error } = await client.from('invoices').delete().eq('restaurant_id', restaurantId).eq('hub_ref', PROBE_REF);
    if (error) throw new Error(error.message);
  };

  await step('clear any probe left by an earlier run', remove);
  const wrote = await step('write the probe bill with the hub\'s own push', () => pushInvoice(client, restaurantId, PROBE_BILL));
  if (wrote) {
    await step('write it again: the upsert updates in place rather than duplicating', async () => {
      await pushInvoice(client, restaurantId, { ...PROBE_BILL, void_reason: 'cloud:check probe, second write' });
      const { data, error } = await client.from('invoices').select('hub_ref').eq('restaurant_id', restaurantId).eq('hub_ref', PROBE_REF);
      if (error) throw new Error(error.message);
      if (data.length !== 1) throw new Error(`expected one row, found ${data.length}`);
    });
    await step('read it back through the hub\'s restore path, unchanged', async () => {
      const found = (await pullInvoices(client, restaurantId)).find(i => i.id === PROBE_REF);
      if (!found) throw new Error('the probe bill did not come back');
      if (found.invoice_number !== 'CLOUD-CHECK' || found.grand_total !== 1) throw new Error('it came back changed');
      if (found.payment_status !== 'void') throw new Error(`status came back as ${found.payment_status}`);
    });
    await step('delete the probe bill', remove);
  }
  return { ok: steps.every(s => s.ok), steps, row: invoiceRow(restaurantId, PROBE_BILL).hub_ref };
}

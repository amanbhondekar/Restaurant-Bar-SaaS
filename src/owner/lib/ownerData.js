import { invoiceFromCloud } from '../../../hub_server/lib/invoiceSync.js';
import { reconciliationFromCloud } from '../../../hub_server/lib/reconciliationSync.js';
import { windowFor, salesReport, PRESET_IDS } from '../../../hub_server/lib/analytics.js';

// What the owner sees from a browser, away from the restaurant (§3 owner console). Everything here is READ from the
// cloud copy the hub keeps; nothing is written, and the database enforces that, not this file: an owner's login is
// read-only whatever this code does (migration 015).
//
// The numbers are the hub's own. A bill comes back from the cloud as the hub would have held it
// (`invoiceFromCloud`) and goes through the same `salesReport` the reception Sales tab uses, so "takings today" cannot
// differ between the two screens.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a fake, or one backed by a real Postgres.

const PAGE = 1000;           // PostgREST returns at most this many rows a request
const MAX_ROWS = 20000;      // beyond this the figures say they are partial rather than quietly wrong

/** Every row a query matches, a page at a time. `build()` must return a fresh, ordered query each call. */
async function readAll(build) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** 'out' at nothing, 'low' at or below the level reception set, else 'ok'. Mirrors the hub's levelOf (inventory.js). */
export function levelOf(item) {
  if (item.on_hand <= 0) return 'out';
  if (item.low_at > 0 && item.on_hand <= item.low_at) return 'low';
  return 'ok';
}

const iso = d => d.toISOString();

/**
 * The earliest moment any report needs: the start of the oldest comparison window. A bill is wanted if ANYTHING
 * happened to it since then (issued, paid, refunded or voided), because takings are counted on the day the money
 * moved: a bill issued last month and refunded today belongs in today's figures.
 */
export function earliestNeeded(now = new Date()) {
  return new Date(Math.min(...PRESET_IDS.map(p => windowFor(p, now).previous.from.getTime())));
}

/**
 * One consistent picture of the restaurant. Each section is read on its own, so one that fails is reported in
 * `errors` and the others still show.
 */
export async function loadOwnerSnapshot(client, { now = new Date() } = {}) {
  const errors = {};
  const guard = async (name, fn) => {
    try { return await fn(); } catch (e) { errors[name] = e?.message || String(e); return null; }
  };

  const restaurant = await guard('restaurant', async () => {
    const { data, error } = await client.from('restaurants')
      .select('id, name, city, currency, plan, plan_status, trial_ends_at, current_period_end')
      .limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  });

  // Nothing else is worth asking if this login is attached to no restaurant: row-level security would answer empty.
  // `attached` is false when the answer was empty (this login works for no restaurant) and null when it could not be
  // asked at all, which are different things to tell a person.
  if (!restaurant) return { restaurant: null, errors, attached: errors.restaurant ? null : false };

  const since = iso(earliestNeeded(now));
  const [bills, cashups, stock, feedback] = await Promise.all([
    guard('sales', () => readAll(() => client.from('invoices').select('*')
      .or(`issued_at.gte.${since},paid_at.gte.${since},refunded_at.gte.${since},voided_at.gte.${since}`)
      .order('issued_at', { ascending: false }).order('id'))),
    guard('cashups', async () => {
      const { data, error } = await client.from('reconciliations').select('*').order('seq', { ascending: false }).limit(10);
      if (error) throw error;
      return data || [];
    }),
    guard('stock', async () => {
      const { data, error } = await client.from('inventory_items').select('hub_ref, name, unit, on_hand, low_at, par, unit_cost').order('name');
      if (error) throw error;
      return data || [];
    }),
    guard('feedback', async () => {
      const { data, error } = await client.from('guest_feedback').select('hub_ref, rating, comment, table_label, invoice_number, created_at')
        .order('created_at', { ascending: false }).limit(500);
      if (error) throw error;
      return data || [];
    })
  ]);

  const out = { restaurant, attached: true, errors, generated_at: iso(now), currency: restaurant.currency || '₹' };

  if (bills) {
    const invoices = bills.rows.map(row => invoiceFromCloud(row));
    out.sales = Object.fromEntries(PRESET_IDS.map(p => [p, salesReport({ invoices, visits: [], restaurantId: restaurant.id, window: windowFor(p, now) })]));
    out.salesPartial = bills.truncated;
    out.syncedAt = bills.rows.reduce((latest, r) => (r.synced_at && r.synced_at > latest ? r.synced_at : latest), '') || null;
  }
  if (cashups) out.cashups = cashups.map(reconciliationFromCloud);
  if (stock) {
    const items = stock.map(i => ({ ...i, on_hand: Number(i.on_hand), low_at: Number(i.low_at), level: levelOf({ on_hand: Number(i.on_hand), low_at: Number(i.low_at) }) }));
    out.stock = { items, out: items.filter(i => i.level === 'out'), low: items.filter(i => i.level === 'low') };
  }
  if (feedback) {
    const total = feedback.reduce((s, f) => s + Number(f.rating), 0);
    out.feedback = {
      count: feedback.length,
      average: feedback.length ? Math.round((total / feedback.length) * 10) / 10 : null,
      low: feedback.filter(f => Number(f.rating) <= 2).slice(0, 5),
      capped: feedback.length === 500
    };
  }
  return out;
}

/** How long ago the hub last got anything to the cloud, in words a person acts on; null with nothing to go on. */
export function freshness(syncedAt, now = new Date()) {
  if (!syncedAt) return null;
  const mins = Math.max(0, Math.round((now.getTime() - new Date(syncedAt).getTime()) / 60000));
  const text = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return { text, stale: mins > 360 };
}

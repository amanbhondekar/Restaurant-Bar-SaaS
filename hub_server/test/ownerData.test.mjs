import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient } from './helpers/pgrest.mjs';

// The data behind the owner's remote view (src/owner/lib/ownerData.js). First against a fake client, for what is
// about the client code itself (paging, one failing section, an unattached login); then against the REAL schema,
// row-level security and column privileges, signed in as an owner, for what the numbers are and who may see them.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-data-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { loadOwnerSnapshot, levelOf, freshness, earliestNeeded } = await import('../../src/owner/lib/ownerData.js');
const { levelOf: hubLevelOf } = await import('../lib/inventory.js');
const { invoiceRow, invoiceFromCloud } = await import('../lib/invoiceSync.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationRow } = await import('../lib/reconciliationSync.js');
const { inventoryItemRow } = await import('../lib/inventorySync.js');
const { feedbackRow } = await import('../lib/feedbackSync.js');
const { windowFor, salesReport } = await import('../lib/analytics.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const NOW = new Date(2026, 9, 22, 15, 0, 0);               // Thursday 22 Oct 2026, 3 pm, local
const at = (m, d, h = 12) => new Date(2026, m - 1, d, h).toISOString();

// --- the client code, against a fake ------------------------------------------------------------------------

/** A client that answers from fixed tables, honours range/limit, records what it was asked, and can fail a table. */
function fakeClient(tables, { failing = [] } = {}) {
  const asked = [];
  return {
    asked,
    from(table) {
      const q = { table, skip: 0, max: Infinity, or: null };
      const run = () => {
        asked.push({ table, skip: q.skip, max: q.max, or: q.or });
        if (failing.includes(table)) return { data: null, error: { message: `boom in ${table}`, code: 'XX000' } };
        const rows = tables[table] || [];
        return { data: rows.slice(q.skip, q.skip + q.max), error: null };
      };
      const api = {
        select: () => api, eq: () => api, order: () => api, or: expr => { q.or = expr; return api; },
        limit: n => { q.max = n; return api; },
        range: (a, b) => { q.skip = a; q.max = b - a + 1; return api; },
        then: (ok, no) => Promise.resolve(run()).then(ok, no)
      };
      return api;
    }
  };
}
const RESTAURANT = { id: 'r1', name: 'Test Kitchen', city: 'Pune', currency: '₹', plan: 'pro', plan_status: 'active' };
const billRow = (i, over = {}) => ({ id: `u${i}`, hub_ref: `inv_${i}`, restaurant_id: 'r1', invoice_number: `INV-${i}`, grand_total: 100, payment_status: 'paid', payment_method: 'cash', issued_at: at(10, 22, 12), paid_at: at(10, 22, 12), items: [], synced_at: at(10, 22, 12), ...over });

test('fake: a long ledger is read a page at a time until it runs out, and every bill is counted', async () => {
  const bills = Array.from({ length: 2500 }, (_, i) => billRow(i));
  const client = fakeClient({ restaurants: [RESTAURANT], invoices: bills });
  const snap = await loadOwnerSnapshot(client, { now: NOW });
  const reads = client.asked.filter(a => a.table === 'invoices');
  assert.deepEqual(reads.map(r => [r.skip, r.max]), [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal(snap.sales.today.current.bills.count, 2500);
  assert.equal(snap.salesPartial, false);
});

test('fake: a ledger past the limit says its figures are partial rather than quietly wrong', async () => {
  const bills = Array.from({ length: 20000 }, (_, i) => billRow(i));
  const snap = await loadOwnerSnapshot(fakeClient({ restaurants: [RESTAURANT], invoices: bills }), { now: NOW });
  assert.equal(snap.salesPartial, true);
});

test('fake: the bills asked for are those anything happened to since the oldest comparison window starts, not just those issued then', async () => {
  const client = fakeClient({ restaurants: [RESTAURANT], invoices: [] });
  await loadOwnerSnapshot(client, { now: NOW });
  const since = earliestNeeded(NOW).toISOString();
  const { or } = client.asked.find(a => a.table === 'invoices');
  for (const col of ['issued_at', 'paid_at', 'refunded_at', 'voided_at']) assert.ok(or.includes(`${col}.gte.${since}`), col);
  assert.equal(new Date(since).getMonth(), 8, 'the 22nd of October looks back to the start of September for last month');
});

test('fake: a login attached to no restaurant is told so, and nothing else is asked', async () => {
  const client = fakeClient({ restaurants: [], invoices: [billRow(1)] });
  const snap = await loadOwnerSnapshot(client, { now: NOW });
  assert.deepEqual([snap.restaurant, snap.attached], [null, false]);
  assert.deepEqual(client.asked.map(a => a.table), ['restaurants']);
});

test('fake: when the restaurant cannot be read at all that is a different answer from "attached to none"', async () => {
  const snap = await loadOwnerSnapshot(fakeClient({}, { failing: ['restaurants'] }), { now: NOW });
  assert.equal(snap.attached, null);
  assert.match(snap.errors.restaurant, /boom in restaurants/);
});

test('fake: one section failing does not take the others with it, and says which', async () => {
  const client = fakeClient({ restaurants: [RESTAURANT], invoices: [billRow(1)], inventory_items: [], guest_feedback: [], reconciliations: [] }, { failing: ['inventory_items'] });
  const snap = await loadOwnerSnapshot(client, { now: NOW });
  assert.match(snap.errors.stock, /boom in inventory_items/);
  assert.equal(snap.stock, undefined);
  assert.equal(snap.sales.today.current.bills.count, 1);
  assert.deepEqual(snap.cashups, []);
  assert.equal(snap.feedback.count, 0);
});

test('fake: feedback is averaged to one decimal, two stars and under are the ones worth reading, and no more than five are shown', async () => {
  const fb = ratings => ratings.map((rating, i) => ({ hub_ref: `fb${i}`, rating, comment: `c${i}`, created_at: at(10, 21, 20) }));
  const read = async ratings => (await loadOwnerSnapshot(fakeClient({ restaurants: [RESTAURANT], invoices: [], guest_feedback: fb(ratings) }), { now: NOW })).feedback;
  assert.equal((await read([5, 4, 4])).average, 4.3);                       // 4.333...
  assert.equal((await read([5, 2, 2, 1])).average, 2.5);
  assert.deepEqual((await read([3, 2, 5, 1, 3])).low.map(f => f.rating), [2, 1], 'a 3 is not low, a 2 is');
  assert.equal((await read([1, 1, 1, 1, 1, 1, 1])).low.length, 5);
  assert.deepEqual(await read([]), { count: 0, average: null, low: [], capped: false });
});

test('fake: the sales are the hub\'s own sums, not a second set of them', async () => {
  const rows = [billRow(1, { grand_total: 300 }), billRow(2, { grand_total: 120, payment_method: 'upi' }), billRow(3, { payment_status: 'void', voided_at: at(10, 22, 13), paid_at: null })];
  const snap = await loadOwnerSnapshot(fakeClient({ restaurants: [RESTAURANT], invoices: rows }), { now: NOW });
  const direct = salesReport({ invoices: rows.map(invoiceFromCloud), visits: [], restaurantId: 'r1', window: windowFor('today', NOW) });
  assert.deepEqual(snap.sales.today, direct);
  assert.equal(snap.sales.today.current.takings.net, 420);
  assert.equal(snap.sales.today.current.voided.count, 1, 'a cloud "void" is the hub\'s "voided"');
});

test('levelOf says what the hub\'s own does, for every kind of stock', () => {
  for (const on_hand of [-1, 0, 0.5, 1, 5, 10, 11, 100]) {
    for (const low_at of [0, 1, 5, 10]) assert.equal(levelOf({ on_hand, low_at }), hubLevelOf({ on_hand, low_at }), `${on_hand}/${low_at}`);
  }
});

test('freshness: how long ago the hub last got anything to the cloud, and when that is worth worrying about', () => {
  const ago = mins => new Date(NOW.getTime() - mins * 60000).toISOString();
  assert.deepEqual(freshness(ago(0), NOW), { text: 'just now', stale: false });
  assert.deepEqual(freshness(ago(42), NOW), { text: '42 min ago', stale: false });
  assert.deepEqual(freshness(ago(180), NOW), { text: '3 h ago', stale: false });
  assert.deepEqual(freshness(ago(7 * 60), NOW), { text: '7 h ago', stale: true });
  assert.deepEqual(freshness(ago(3 * 1440), NOW), { text: '3 days ago', stale: true });
  assert.equal(freshness(null, NOW), null);
});

// --- the same code against the real schema, signed in as an owner --------------------------------------------

let cloud;
let T;
let owner;
let hubLogin;
let stranger;
before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  const user = async label => (await cloud.pg.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${label}@example.test`])).rows[0].id;
  owner = await user('owner');
  stranger = await user('stranger');
  hubLogin = T.A.user;
  await cloud.as('service_role', null, () => cloud.pg.query(`SELECT public.provision_owner($1, $2, 'Owner', 'owner')`, [T.A.restaurant, owner]));

  const base = invoiceStore.issueInvoice({ tickets: [{ id: 'tk', ticket_number: 1, restaurant_id: 'x', table_id: 1, table_name: 'T1', items: [{ id: 'd', name: 'Dal', qty: 2, price: 100 }], total_amount: 200 }], tableId: 1, tableName: 'T1', restaurantId: 'x', currency: '₹', taxConfig: {}, adjustments: {} }).invoice;
  const bill = (rid, id, over) => cloud.put('invoices', invoiceRow(rid, { ...base, id, invoice_number: id.toUpperCase(), restaurant_id: rid, ...over }), { conflict: 'update' });
  // Today: 400 paid. Yesterday: 200 paid. A bill from LAST MONTH, paid then, refunded today: 300 handed back today.
  await bill(T.A.restaurant, 'inv_today', { grand_total: 400, payment_status: 'paid', payment_method: 'cash', issued_at: at(10, 22, 12), paid_at: at(10, 22, 12) });
  await bill(T.A.restaurant, 'inv_yesterday', { grand_total: 200, payment_status: 'paid', payment_method: 'upi', issued_at: at(10, 21, 12), paid_at: at(10, 21, 12) });
  await bill(T.A.restaurant, 'inv_old_refunded', { grand_total: 300, payment_status: 'refunded', payment_method: 'cash', issued_at: at(9, 20, 12), paid_at: at(9, 20, 12), refund_at: at(10, 22, 13) });
  await bill(T.A.restaurant, 'inv_ancient', { grand_total: 999, payment_status: 'paid', payment_method: 'cash', issued_at: at(3, 1, 12), paid_at: at(3, 1, 12) });
  await bill(T.B.restaurant, 'inv_other_tenant', { grand_total: 7777, payment_status: 'paid', payment_method: 'cash', issued_at: at(10, 22, 12), paid_at: at(10, 22, 12) });

  const recs = (rid, n, variance) => cloud.put('reconciliations', reconciliationRow(rid, { id: `rec_${n}`, seq: n, number: `REC-${n}`, period_start: at(10, n, 6), period_end: at(10, n, 22), opening_float: 1000, counted_cash: 5000, cash_removed: 4000, closing_float: 1000, expected_cash: 5000 + variance, cash_variance: -variance, status: variance ? 'variance' : 'balanced', has_variance: Boolean(variance), methods: {}, totals: {}, voided: {}, unpaid_at_close: {} }), { conflict: 'ignore' });
  for (const [n, v] of [[19, 0], [20, 50], [21, 0]]) await recs(T.A.restaurant, n, v);

  const stock = (rid, id, name, on_hand, low_at) => cloud.put('inventory_items', inventoryItemRow(rid, { id, name, unit: 'g', on_hand, low_at }), { conflict: 'update' });
  await stock(T.A.restaurant, 'i_out', 'Cheese', 0, 10); await stock(T.A.restaurant, 'i_low', 'Rice', 4, 5); await stock(T.A.restaurant, 'i_ok', 'Oil', 50, 5);
  await stock(T.B.restaurant, 'i_theirs', 'Their saffron', 0, 1);

  const fb = (rid, id, rating, comment) => cloud.put('guest_feedback', feedbackRow(rid, { id, table: 'T1', rating, comment, created_at: at(10, 21, 20) }), { conflict: 'ignore' });
  await fb(T.A.restaurant, 'fb1', 5, 'Great'); await fb(T.A.restaurant, 'fb2', 1, 'Cold'); await fb(T.A.restaurant, 'fb3', 3, 'OK'); await fb(T.B.restaurant, 'fb_other', 1, 'Not ours');
});
after(async () => { await cloud?.close(); });

test('real: an owner\'s snapshot is their restaurant, their numbers, and nothing of anyone else\'s', async () => {
  const snap = await loadOwnerSnapshot(pgrestClient(cloud, owner), { now: NOW });
  assert.deepEqual(snap.errors, {}, JSON.stringify(snap.errors));
  assert.deepEqual([snap.restaurant.id, snap.restaurant.name, snap.attached], [T.A.restaurant, 'Restaurant A', true]);
  assert.equal(snap.sales.today.current.bills.count, 1);
  assert.deepEqual([snap.sales.today.current.takings.payments, snap.sales.today.current.takings.refunds, snap.sales.today.current.takings.net], [400, 300, 100]);
  assert.ok(!JSON.stringify(snap).includes('7777') && !JSON.stringify(snap).includes('saffron') && !JSON.stringify(snap).includes('Not ours'), 'none of the other tenant\'s data');
});

test('real: a bill issued LAST MONTH and refunded TODAY is in today\'s refunds -- takings are counted on the day the money moved', async () => {
  const snap = await loadOwnerSnapshot(pgrestClient(cloud, owner), { now: NOW });
  assert.equal(snap.sales.today.current.takings.refunds, 300);
  const old = (await pgrestClient(cloud, owner).from('invoices').select('hub_ref').eq('hub_ref', 'inv_ancient')).data;
  assert.equal(old.length, 1, 'while a bill from March is in the database');
  assert.ok(snap.sales.month.current.takings.payments < 999, 'but is nowhere in this month\'s figures, and was never read');
});

test('real: the owner\'s Sales are the numbers the hub\'s own report gives for the same bills', async () => {
  const snap = await loadOwnerSnapshot(pgrestClient(cloud, owner), { now: NOW });
  const rows = (await cloud.pg.query(`SELECT * FROM public.invoices WHERE restaurant_id = $1`, [T.A.restaurant])).rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
  for (const period of ['today', 'week', 'month']) {
    const direct = salesReport({ invoices: rows.map(invoiceFromCloud), visits: [], restaurantId: T.A.restaurant, window: windowFor(period, NOW) });
    assert.deepEqual(snap.sales[period].current.takings, direct.current.takings, period);
  }
});

test('real: cash-ups newest first, stock split into out and low, feedback averaged with the low ratings picked out', async () => {
  const snap = await loadOwnerSnapshot(pgrestClient(cloud, owner), { now: NOW });
  assert.deepEqual(snap.cashups.map(c => c.number), ['REC-21', 'REC-20', 'REC-19']);
  assert.equal(snap.cashups.find(c => c.number === 'REC-20').has_variance, true);
  assert.deepEqual(snap.stock.out.map(i => i.name), ['Cheese']);
  assert.deepEqual(snap.stock.low.map(i => i.name), ['Rice']);
  assert.deepEqual([snap.feedback.count, snap.feedback.average], [3, 3]);
  assert.deepEqual(snap.feedback.low.map(f => f.comment), ['Cold']);
  assert.ok(snap.syncedAt, 'and when the hub last got anything here');
});

test('real: the hub\'s own login sees the same restaurant, and a login attached to nothing sees none of it', async () => {
  const hubSnap = await loadOwnerSnapshot(pgrestClient(cloud, hubLogin), { now: NOW });
  assert.equal(hubSnap.restaurant.id, T.A.restaurant);
  const lost = await loadOwnerSnapshot(pgrestClient(cloud, stranger), { now: NOW });
  assert.deepEqual([lost.restaurant, lost.attached], [null, false]);
});

test('real: the secret\'s hash is out of reach of the owner\'s own client, and the view never asks for it', async () => {
  const client = pgrestClient(cloud, owner);
  const refused = await client.from('restaurants').select('*');
  assert.match(refused.error.message, /permission denied/i);
  const hash = await client.from('restaurants').select('hub_provisioning_secret_hash');
  assert.match(hash.error.message, /permission denied/i);
  const snap = await loadOwnerSnapshot(client, { now: NOW });
  assert.ok(!('hub_provisioning_secret_hash' in snap.restaurant));
});

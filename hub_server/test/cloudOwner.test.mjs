import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudDb } from './helpers/cloudDb.mjs';

// Two things the cloud has to get right for a restaurant to be run from anywhere but its own laptop, tested on a real
// Postgres engine (see helpers/cloudDb.mjs):
//
//   1. A hub that has not yet bound itself to a restaurant must be able to look it up by the pairing code on its
//      screen. Row-level security shows a login only its own restaurant, and an unbound login has none, so a plain
//      query finds nothing: a freshly provisioned restaurant could never be paired. (Found by running it.)
//   2. An OWNER logs in from a browser, with the same database role the hub uses. The role they hold in staff_users
//      has to be what limits them: they read everything about their restaurant and change nothing.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-owner-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { invoiceRow } = await import('../lib/invoiceSync.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationRow } = await import('../lib/reconciliationSync.js');
const { inventoryItemRow } = await import('../lib/inventorySync.js');
const { reservationRow } = await import('../lib/reservationSync.js');
const { categoryRow, menuItemRow, tableRow } = await import('../lib/catalogSync.js');
const { feedbackRow } = await import('../lib/feedbackSync.js');

let cloud;
let T;
let owner;       // owner of A
let manager;     // manager of A
let otherOwner;  // owner of B
before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  await seedOwners();
});
after(async () => { await cloud?.close(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const q = (sql, params) => cloud.pg.query(sql, params);
const NOW = '2026-10-22T10:00:00.000Z';
const SECRET = 'a-long-random-secret-for-this-hub';
const as = (user, fn) => cloud.as('authenticated', user, fn);
const newUser = async label => (await q(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${label}@example.test`])).rows[0].id;
const rejected = async (fn, pattern) => {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, 'expected the database to refuse this');
  if (pattern) assert.match(error.message, pattern);
  return error;
};
const provision = (name, city = 'Pune') => cloud.as('service_role', null, async () => (await q(`SELECT * FROM public.provision_restaurant($1, $2, $3)`, [name, city, SECRET])).rows[0]);
const makeOwner = (restaurantId, userId, role = 'owner') => cloud.as('service_role', null, async () => (await q(`SELECT public.provision_owner($1, $2, 'The Owner', $3) AS id`, [restaurantId, userId, role])).rows[0].id);

// --- 1. pairing ------------------------------------------------------------------------------------------

test('a hub that is not yet bound to any restaurant can look its restaurant up by the pairing code, and gets only what pairing needs', async () => {
  const t = await provision('Pairing Bistro');
  const unbound = await newUser('unbound-hub');
  const found = await as(unbound, async () => (await q(`SELECT * FROM public.restaurant_for_pairing_code($1)`, [t.pairing_code])).rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, t.restaurant_id);
  assert.deepEqual(Object.keys(found[0]).sort(), ['city', 'current_period_end', 'id', 'name', 'pairing_code', 'plan', 'plan_status', 'slug', 'trial_ends_at']);
  assert.ok(!JSON.stringify(found[0]).includes('$2'), 'and never the secret\'s hash');
});

test('the code is matched however it is typed, an unknown code finds nothing, and nothing is learned from a near miss', async () => {
  const t = await provision('Typing Bistro');
  const unbound = await newUser('unbound-hub-2');
  const look = code => as(unbound, async () => (await q(`SELECT id FROM public.restaurant_for_pairing_code($1)`, [code])).rows);
  assert.equal((await look(t.pairing_code.toLowerCase())).length, 1);
  assert.equal((await look(`  ${t.pairing_code}  `)).length, 1);
  assert.equal((await look('ZZZ-0000')).length, 0);
  assert.equal((await look('')).length, 0);
  assert.equal((await look(null)).length, 0);
  assert.equal((await look('%')).length, 0, 'a wildcard is not a pattern');
});

test('an unauthenticated caller cannot ask: pairing needs the hub\'s own (anonymous) sign-in', async () => {
  const t = await provision('Closed Bistro');
  await rejected(() => cloud.as('anon', null, async () => q(`SELECT * FROM public.restaurant_for_pairing_code($1)`, [t.pairing_code])), /permission denied/i);
});

test('the lookup is the only way in: an unbound login still cannot read the restaurants table itself', async () => {
  const t = await provision('Table Bistro');
  const unbound = await newUser('unbound-hub-3');
  const rows = await as(unbound, async () => (await q(`SELECT id FROM public.restaurants WHERE pairing_code = $1`, [t.pairing_code])).rows);
  assert.deepEqual(rows, []);
});

// --- 2. the owner ----------------------------------------------------------------------------------------

const TENANT_ROWS = {
  tables: (rid, tag) => tableRow(rid, { id: `t_${tag}`, name: `T${tag}`, section: 'Main', capacity: 4 }, 0),
  menu_categories: (rid, tag) => categoryRow(rid, `Mains ${tag}`, 1),
  menu_items: (rid, tag) => menuItemRow(rid, { id: `m_${tag}`, name: 'Dal', price: 220, category: 'Mains', isVeg: true, available: true, variants: [], modifier_groups: [], day_parts: [], station: 'hot' }),
  invoices: (rid, tag) => invoiceRow(rid, { ...invoiceStore.issueInvoice({ tickets: [{ id: `tk_${tag}`, ticket_number: 1, restaurant_id: 'x', table_id: 1, table_name: 'T1', items: [{ id: 'd', name: 'Dal', qty: 2, price: 100 }], total_amount: 200 }], tableId: 1, tableName: 'T1', restaurantId: 'x', currency: '₹', taxConfig: {}, adjustments: {} }).invoice, id: `inv_${tag}`, invoice_number: `INV-${tag}`, restaurant_id: rid }),
  reconciliations: (rid, tag) => reconciliationRow(rid, { id: `rec_${tag}`, seq: 1, number: `REC-${tag}`, period_start: NOW, period_end: NOW, opening_float: 0, counted_cash: 0, cash_removed: 0, closing_float: 0, expected_cash: 0, cash_variance: 0, status: 'balanced', has_variance: false, methods: {}, totals: {}, voided: {}, unpaid_at_close: {} }),
  inventory_items: (rid, tag) => inventoryItemRow(rid, { id: `ing_${tag}`, name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10 }),
  reservations: (rid, tag) => reservationRow(rid, { id: `r_${tag}`, guest_name: 'Asha', phone: '919876543210', phone_key: 'k', party_size: 4, at: NOW, duration_mins: 90, status: 'booked', overbooked: false, created_at: NOW }),
  guest_feedback: (rid, tag) => feedbackRow(rid, { id: `fb_${tag}`, table: 'T1', rating: 4, comment: 'Lovely', created_at: NOW })
};

async function seedOwners() {
  owner = await newUser('owner-a');
  manager = await newUser('manager-a');
  otherOwner = await newUser('owner-b');
  await makeOwner(T.A.restaurant, owner, 'owner');
  await makeOwner(T.A.restaurant, manager, 'manager');
  await makeOwner(T.B.restaurant, otherOwner, 'owner');
  for (const [table, build] of Object.entries(TENANT_ROWS)) {
    await cloud.put(table, build(T.A.restaurant, 'a'));
    await cloud.put(table, build(T.B.restaurant, 'b'));
  }
}

test('an owner reads everything about their own restaurant, and nothing about anyone else\'s', async () => {
  for (const table of Object.keys(TENANT_ROWS)) {
    const rows = await as(owner, async () => (await q(`SELECT restaurant_id FROM public.${table}`)).rows);
    assert.ok(rows.length > 0, `${table}: the owner can read it`);
    assert.ok(rows.every(r => r.restaurant_id === T.A.restaurant), `${table}: and only their own`);
  }
  const mine = await as(owner, async () => (await q(`SELECT id FROM public.restaurants`)).rows.map(r => r.id));
  assert.deepEqual(mine, [T.A.restaurant]);
});

test('an owner changes nothing: no insert, no update, no delete, on any table', async () => {
  for (const [table, build] of Object.entries(TENANT_ROWS)) {
    await rejected(() => as(owner, async () => cloud.put(table, build(T.A.restaurant, 'owner-wrote'))), /row-level security|permission denied/i);
    const before = (await q(`SELECT count(*)::int AS n FROM public.${table} WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n;
    for (const sql of [`UPDATE public.${table} SET restaurant_id = restaurant_id WHERE restaurant_id = $1`, `DELETE FROM public.${table} WHERE restaurant_id = $1`]) {
      const affected = await as(owner, async () => { try { return (await q(sql, [T.A.restaurant])).affectedRows ?? 0; } catch { return 0; } });
      assert.equal(affected, 0, `${table}: ${sql.split(' ')[0]} by an owner changed rows`);
    }
    const after = (await q(`SELECT count(*)::int AS n FROM public.${table} WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n;
    assert.equal(after, before, `${table} is as it was`);
  }
});

test('a manager reads like an owner and writes like one: not at all', async () => {
  const rows = await as(manager, async () => (await q(`SELECT restaurant_id FROM public.invoices`)).rows);
  assert.ok(rows.length > 0 && rows.every(r => r.restaurant_id === T.A.restaurant));
  await rejected(() => as(manager, async () => cloud.put('invoices', TENANT_ROWS.invoices(T.A.restaurant, 'manager-wrote'))), /row-level security|permission denied/i);
});

test('the hub itself (the kitchen identity) is unchanged: it still writes its own restaurant\'s rows and still cannot write another\'s', async () => {
  for (const [table, build] of Object.entries(TENANT_ROWS)) {
    await as(T.A.user, async () => cloud.put(table, build(T.A.restaurant, 'hub-wrote'), { conflict: 'ignore' }));
    await rejected(() => as(T.A.user, async () => cloud.put(table, build(T.B.restaurant, 'hub-wrote-b'))), /row-level security|permission denied/i);
  }
});

test('an owner of one restaurant cannot read another\'s, and the other\'s owner cannot read theirs', async () => {
  const theirs = await as(otherOwner, async () => (await q(`SELECT restaurant_id FROM public.invoices`)).rows);
  assert.ok(theirs.length > 0 && theirs.every(r => r.restaurant_id === T.B.restaurant));
});

test('nobody who signs in can read the hub\'s secret or a PIN hash, not even the owner', async () => {
  for (const user of [owner, T.A.user]) {
    await rejected(() => as(user, async () => q(`SELECT hub_provisioning_secret_hash FROM public.restaurants`)), /permission denied/i);
    await rejected(() => as(user, async () => q(`SELECT * FROM public.restaurants`)), /permission denied/i);
    await rejected(() => as(user, async () => q(`SELECT pin_hash FROM public.staff_users`)), /permission denied/i);
    await rejected(() => as(user, async () => q(`SELECT * FROM public.staff_users`)), /permission denied/i);
  }
  const ok = await as(owner, async () => (await q(`SELECT id, name, plan, plan_status, city FROM public.restaurants`)).rows);
  assert.equal(ok.length, 1, 'while the columns that are theirs to read still are');
  const staff = await as(owner, async () => (await q(`SELECT full_name, role FROM public.staff_users ORDER BY role`)).rows);
  assert.deepEqual(staff.map(s => s.role).sort(), ['kitchen', 'manager', 'owner']);
});

test('a login that is not an owner, a manager or the hub -- a waiter row, a role it was not meant to have -- reads its restaurant but writes nothing', async () => {
  const waiter = await newUser('waiter-with-login');
  await q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Waiter', 'waiter')`, [T.A.restaurant, waiter]);
  await rejected(() => as(waiter, async () => cloud.put('invoices', TENANT_ROWS.invoices(T.A.restaurant, 'waiter-wrote'))), /row-level security|permission denied/i);
});

// --- binding an owner -----------------------------------------------------------------------------------------

test('only the operator can make someone an owner: not a tenant\'s login, not an anonymous caller', async () => {
  const stranger = await newUser('stranger');
  for (const role of ['anon', 'authenticated']) {
    await rejected(() => cloud.as(role, stranger, async () => q(`SELECT public.provision_owner($1, $2, 'Me', 'owner')`, [T.A.restaurant, stranger])), /permission denied/i);
  }
  await rejected(() => as(T.A.user, async () => q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Me', 'owner')`, [T.A.restaurant, stranger])), /permission denied/i);
});

test('making an owner is safe to repeat, and refuses what could not be right', async () => {
  const t = await provision('Owner Bistro');
  const me = await newUser('owner-bistro');
  const first = await makeOwner(t.restaurant_id, me);
  assert.equal(await makeOwner(t.restaurant_id, me), first, 'the same row, not a second');

  await rejected(async () => makeOwner('c0c0c0c0-0000-4000-8000-00000000dead', await newUser('x1')), /No such restaurant/);
  await rejected(async () => makeOwner(t.restaurant_id, await newUser('x2'), 'kitchen'), /owner or manager/);
  await rejected(() => makeOwner(t.restaurant_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), /violates foreign key|No such user/i);
  // one login, one restaurant: an owner of one cannot be quietly attached to another
  await rejected(() => makeOwner(T.B.restaurant, me), /already works for another restaurant/);
});

// --- orders and their lines (order_items has no restaurant_id of its own: it belongs to its order) -----------------

test('orders and their lines follow the same rule: the hub writes them, an owner reads them, and a line cannot be hung on another restaurant\'s order', async () => {
  const orderA = (await as(T.A.user, async () => q(`INSERT INTO public.orders (restaurant_id, table_name, ticket_number, total_amount) VALUES ($1, 'T1', 101, 200) RETURNING id`, [T.A.restaurant]))).rows[0].id;
  await as(T.A.user, async () => q(`INSERT INTO public.order_items (order_id, name, qty, price) VALUES ($1, 'Dal', 2, 100)`, [orderA]));
  const orderB = (await q(`INSERT INTO public.orders (restaurant_id, table_name, ticket_number, total_amount) VALUES ($1, 'T9', 7, 50) RETURNING id`, [T.B.restaurant])).rows[0].id;
  await q(`INSERT INTO public.order_items (order_id, name, qty, price) VALUES ($1, 'Tea', 1, 50)`, [orderB]);

  const lines = await as(owner, async () => (await q(`SELECT name FROM public.order_items`)).rows.map(r => r.name));
  assert.deepEqual(lines, ['Dal'], 'the owner reads their own restaurant\'s lines and not the other\'s');
  const orders = await as(owner, async () => (await q(`SELECT ticket_number FROM public.orders`)).rows.map(r => r.ticket_number));
  assert.deepEqual(orders, [101]);

  await rejected(() => as(owner, async () => q(`INSERT INTO public.orders (restaurant_id, table_name, ticket_number) VALUES ($1, 'T1', 102)`, [T.A.restaurant])), /row-level security|permission denied/i);
  await rejected(() => as(owner, async () => q(`INSERT INTO public.order_items (order_id, name, qty, price) VALUES ($1, 'Free dal', 1, 0)`, [orderA])), /row-level security|permission denied/i);
  await rejected(() => as(T.A.user, async () => q(`INSERT INTO public.order_items (order_id, name, qty, price) VALUES ($1, 'Smuggled', 1, 0)`, [orderB])), /row-level security/i);
  const touched = await as(owner, async () => (await q(`UPDATE public.order_items SET qty = 99`)).affectedRows ?? 0);
  assert.equal(touched, 0);
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudDb } from './helpers/cloudDb.mjs';

// The SQL, run. Every other cloud test reads the migrations or fakes the client; this one applies them to a real
// Postgres engine (PGlite) and acts as a tenant's hub would -- as the `authenticated` role, bound to a restaurant
// through staff_users -- to see what the database really allows. See helpers/cloudDb.mjs for what is stubbed.
//
// The stub gives every new table in public the privileges a hosted Supabase project gives it by default (all of
// them, to anon and authenticated). That is the worst case, and the realistic one: a migration that is meant to
// make a table insert-only has to say so, because the default has already granted everything.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sql-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { invoiceRow } = await import('../lib/invoiceSync.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationRow } = await import('../lib/reconciliationSync.js');
const { inventoryItemRow, recipeRow } = await import('../lib/inventorySync.js');
const { reservationRow, walkInRow } = await import('../lib/reservationSync.js');
const { categoryRow, menuItemRow, tableRow } = await import('../lib/catalogSync.js');
const { feedbackRow } = await import('../lib/feedbackSync.js');

let cloud;
let T;   // { A: { restaurant, user }, B: { ... } }
before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
});
after(async () => {
  await cloud?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NOW = '2026-10-22T10:00:00.000Z';
const q = (sql, params) => cloud.pg.query(sql, params);
const asHub = (tenant, fn) => cloud.as('authenticated', T[tenant].user, fn);
const rejected = async (fn, pattern) => {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, 'expected the database to refuse this');
  if (pattern) assert.match(error.message, pattern);
  return error;
};

// --- the migrations themselves -----------------------------------------------------------------------

test('every migration applies on a real Postgres, in order, and a second run changes nothing and fails nothing', async () => {
  // before() already applied them all once; "safe to re-run" is a claim the files make about themselves.
  await cloud.applyAll({ onlyMigrations: true });
  const tables = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n;
  assert.ok(tables >= 18, `the schema is there (${tables} tables)`);
});

test('every table that belongs to a restaurant has row-level security switched on, and a policy unless it is the operator\'s', async () => {
  const owned = (await q(`
    SELECT c.relname AS name, c.relrowsecurity AS rls,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname IN ('restaurants', 'order_items') OR EXISTS (
              SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'restaurant_id'))
     ORDER BY c.relname`)).rows;
  assert.ok(owned.length >= 15, 'the tenant tables were found');
  // subscriptions and subscription_events are the operator service's, reached only with the service key: RLS on and
  // NO policy is how they say "nobody else".
  const operatorOnly = new Set(['subscriptions', 'subscription_events']);
  for (const t of owned) {
    assert.equal(t.rls, true, `${t.name} has RLS off: every tenant could read every other tenant's rows`);
    if (!operatorOnly.has(t.name)) assert.ok(t.policies > 0, `${t.name} has RLS on and no policy: nothing could use it`);
    else assert.equal(t.policies, 0, `${t.name} is the operator's and should have no tenant policy`);
  }
});

// --- what each role may do to each table -------------------------------------------------------------

// What a tenant's hub (the `authenticated` role) is meant to be able to do, from what the code actually does:
//   S select, I insert, U update, D delete.
const INTENDED = {
  restaurants: 'S',            // the hub reads its plan; only the operator service writes it
  staff_users: 'S',            // the hub reads who it is; people are added by provision_kitchen_staff()
  tables: 'DISU', menu_categories: 'DISU', menu_items: 'DISU',   // the hub is the single writer of the catalogs
  orders: 'ISU', order_items: 'ISU',                              // inserted, then moved along; never deleted
  invoices: 'ISU',                                                // a void is a state, not a removal
  reconciliations: 'IS',       // a closed shift is signed off: inserted, never changed
  guest_feedback: 'IS',        // a guest's statement: inserted, never edited
  inventory_items: 'DISU', recipes: 'DISU', reservations: 'DISU', walkins: 'DISU',
  waitlist_entries: '', device_pairings: '',                      // the hub does not use them
  subscriptions: '', subscription_events: ''                      // the operator's, service key only
};
const LETTER = { SELECT: 'S', INSERT: 'I', UPDATE: 'U', DELETE: 'D' };
// Table-level privileges, plus SELECT where it was granted on some columns only (restaurants and staff_users keep a
// secret column out of reach, so their SELECT is per column).
const privsOf = async (role, table) => {
  const rows = (await q(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2`, [table, role])).rows.map(r => r.privilege_type);
  const columns = (await q(`SELECT DISTINCT privilege_type FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = 'SELECT'`, [table, role])).rows.map(r => r.privilege_type);
  return [...new Set([...rows, ...columns])].sort();
};

test('a tenant\'s hub can do to each table what the code needs and no more', async () => {
  const wrong = [];
  for (const [table, want] of Object.entries(INTENDED)) {
    const have = (await privsOf('authenticated', table));
    const letters = have.filter(p => LETTER[p]).map(p => LETTER[p]).sort().join('');
    const extras = have.filter(p => !LETTER[p]);   // TRUNCATE, REFERENCES, TRIGGER: none of them is ever wanted
    if (letters !== [...want].sort().join('') || extras.length) wrong.push(`${table}: has ${letters || 'nothing'}${extras.length ? ' + ' + extras.join(',') : ''}, wants ${want || 'nothing'}`);
  }
  assert.deepEqual(wrong, []);
});

test('an unauthenticated caller (anon) has no privilege on any table: the hub is the only client and it signs in', async () => {
  const holders = [];
  for (const table of Object.keys(INTENDED)) if ((await privsOf('anon', table)).length) holders.push(table);
  assert.deepEqual(holders, []);
});

// --- what a tenant's login can actually do -----------------------------------------------------------

test('a tenant cannot change its own plan: the plan is what it pays for, and only the operator service writes it', async () => {
  const error = await rejected(() => asHub('A', async () => q(`UPDATE public.restaurants SET plan = 'enterprise', plan_status = 'active' WHERE id = $1`, [T.A.restaurant])), /permission denied/i);
  assert.ok(error);
  const row = (await q(`SELECT plan FROM public.restaurants WHERE id = $1`, [T.A.restaurant])).rows[0];
  assert.equal(row.plan, 'starter');
});

test('a tenant cannot rewrite who works for it: roles and the user a staff row is bound to are not its to change', async () => {
  await rejected(() => asHub('A', async () => q(`UPDATE public.staff_users SET role = 'owner' WHERE restaurant_id = $1`, [T.A.restaurant])), /permission denied/i);
  await rejected(() => asHub('A', async () => q(`UPDATE public.staff_users SET user_id = $1 WHERE restaurant_id = $2`, [T.B.user, T.A.restaurant])), /permission denied/i);
  await rejected(() => asHub('A', async () => q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Me', 'owner')`, [T.A.restaurant, T.A.user])), /permission denied/i);
});

test('a tenant reads its own restaurant and its own staff, and nobody else\'s', async () => {
  const mine = await asHub('A', async () => (await q(`SELECT id FROM public.restaurants`)).rows);
  assert.deepEqual(mine.map(r => r.id), [T.A.restaurant]);
  const staff = await asHub('A', async () => (await q(`SELECT restaurant_id FROM public.staff_users`)).rows);
  assert.deepEqual(staff.map(r => r.restaurant_id), [T.A.restaurant]);
});

const BILL = invoiceStore.issueInvoice({
  tickets: [{ id: 't1', ticket_number: 1, restaurant_id: 'x', table_id: 1, table_name: 'T1', items: [{ id: 'd', name: 'Dal', qty: 2, price: 100 }], total_amount: 200 }],
  tableId: 1, tableName: 'T1', restaurantId: 'x', currency: '₹', taxConfig: {}, adjustments: {}
}).invoice;

// One row for each table the hub writes, built by the hub's own row builders, for a given restaurant and tag.
const ROWS = {
  menu_categories: (rid, tag) => categoryRow(rid, `Mains ${tag}`, 1),
  menu_items: (rid, tag) => menuItemRow(rid, { id: `m_${tag}`, name: 'Dal', price: 220, category: 'Mains', isVeg: true, available: true, variants: [], modifier_groups: [], day_parts: [], station: 'hot' }),
  tables: (rid, tag) => tableRow(rid, { id: `t_${tag}`, name: `T${tag}`, section: 'Main', capacity: 4 }, 0),
  invoices: (rid, tag) => invoiceRow(rid, { ...BILL, id: `inv_${tag}`, invoice_number: `INV-${tag}`, restaurant_id: rid }),
  reconciliations: (rid, tag) => reconciliationRow(rid, { id: `rec_${tag}`, seq: 1, number: `REC-${tag}`, period_start: NOW, period_end: NOW, opening_float: 0, counted_cash: 0, cash_removed: 0, closing_float: 0, expected_cash: 0, cash_variance: 0, status: 'balanced', has_variance: false, methods: {}, totals: {}, voided: {}, unpaid_at_close: {} }),
  inventory_items: (rid, tag) => inventoryItemRow(rid, { id: `ing_${tag}`, name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10 }),
  recipes: (rid, tag) => recipeRow(rid, { id: `rec_${tag}`, item_id: `m_${tag}`, variant_id: null, lines: [] }),
  reservations: (rid, tag) => reservationRow(rid, { id: `r_${tag}`, guest_name: 'Asha', phone: '919876543210', phone_key: 'k', party_size: 4, at: NOW, duration_mins: 90, status: 'booked', overbooked: false, created_at: NOW }),
  walkins: (rid, tag) => walkInRow(rid, { id: `w_${tag}`, guest_name: 'Dev', party_size: 2, quoted_wait_mins: 15, status: 'waiting', created_at: NOW }),
  guest_feedback: (rid, tag) => feedbackRow(rid, { id: `fb_${tag}`, table: 'T1', rating: 4, comment: 'Lovely', created_at: NOW })
};

test('every row the hub builds is accepted by the real table, and pushing it twice is safe', async () => {
  for (const [table, build] of Object.entries(ROWS)) {
    const row = build(T.A.restaurant, 'a');
    // As the hub would: signed in as its own tenant, upserting on (restaurant_id, hub_ref).
    await asHub('A', async () => {
      await cloud.put(table, row, { conflict: table === 'reconciliations' || table === 'guest_feedback' ? 'ignore' : 'update' });
      await cloud.put(table, row, { conflict: table === 'reconciliations' || table === 'guest_feedback' ? 'ignore' : 'update' });
    });
    const n = (await q(`SELECT count(*)::int AS n FROM public.${table} WHERE restaurant_id = $1 AND hub_ref = $2`, [T.A.restaurant, row.hub_ref])).rows[0].n;
    assert.equal(n, 1, `${table}: one row, however many times it is pushed`);
  }
});

test('a tenant sees none of another tenant\'s rows, and cannot write one', async () => {
  for (const [table, build] of Object.entries(ROWS)) {
    await cloud.put(table, build(T.B.restaurant, 'b'));   // as the superuser: B's data is there
    const seen = await asHub('A', async () => (await q(`SELECT restaurant_id FROM public.${table}`)).rows);
    assert.ok(seen.length > 0 && seen.every(r => r.restaurant_id === T.A.restaurant), `${table}: A reads only its own`);

    await rejected(() => asHub('A', async () => cloud.put(table, build(T.B.restaurant, 'x'))), /row-level security|violates/i);   // a row FOR B
    const touched = await asHub('A', async () => {
      const u = await q(`UPDATE public.${table} SET restaurant_id = restaurant_id WHERE restaurant_id = $1`, [T.B.restaurant]).catch(e => ({ affectedRows: 0, denied: e }));
      return u.affectedRows ?? 0;
    });
    assert.equal(touched, 0, `${table}: A changed some of B's rows`);
  }
});

test('and an unauthenticated caller reads nothing at all', async () => {
  for (const table of Object.keys(ROWS)) {
    await rejected(() => cloud.as('anon', null, async () => q(`SELECT 1 FROM public.${table} LIMIT 1`)), /permission denied/i);
  }
});

test('a closed shift and a guest\'s statement can be added and read but never changed or removed, even by their own tenant', async () => {
  for (const table of ['reconciliations', 'guest_feedback']) {
    await rejected(() => asHub('A', async () => q(`UPDATE public.${table} SET restaurant_id = restaurant_id WHERE restaurant_id = $1`, [T.A.restaurant])), /permission denied/i);
    await rejected(() => asHub('A', async () => q(`DELETE FROM public.${table} WHERE restaurant_id = $1`, [T.A.restaurant])), /permission denied/i);
    await rejected(() => asHub('A', async () => q(`TRUNCATE public.${table}`)), /permission denied/i);
  }
  const kept = (await q(`SELECT count(*)::int AS n FROM public.guest_feedback WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n;
  assert.equal(kept, 1);
});

test('a bill can be updated (a void is a state) but not deleted', async () => {
  await asHub('A', async () => q(`UPDATE public.invoices SET payment_status = 'void' WHERE restaurant_id = $1`, [T.A.restaurant]));
  await rejected(() => asHub('A', async () => q(`DELETE FROM public.invoices WHERE restaurant_id = $1`, [T.A.restaurant])), /permission denied/i);
});

test('the operator\'s tables are closed to a tenant, and the provisioning functions are closed to everyone but the service key', async () => {
  for (const table of ['subscriptions', 'subscription_events']) {
    await rejected(() => asHub('A', async () => q(`SELECT 1 FROM public.${table}`)), /permission denied/i);
  }
  for (const role of ['anon', 'authenticated']) {
    await rejected(() => cloud.as(role, T.A.user, async () => q(`SELECT * FROM public.provision_restaurant('Spice Garden', 'Pune', 'a-long-random-secret-for-the-hub')`)), /permission denied/i);
    await rejected(() => cloud.as(role, T.A.user, async () => q(`SELECT public.set_hub_provisioning_secret($1, 'x')`, [T.A.restaurant])), /permission denied/i);
  }
});

test('the service key reaches everything, as the operator service and cloud:check need it to', async () => {
  const ids = await cloud.as('service_role', null, async () => (await q(`SELECT id FROM public.restaurants`)).rows.map(r => r.id));
  assert.ok(ids.includes(T.A.restaurant) && ids.includes(T.B.restaurant), 'both tenants, which no single tenant login can see');
  await cloud.as('service_role', null, async () => q(`SELECT count(*) FROM public.subscriptions`));
});

// --- onboarding: the operator creates a tenant, the hub binds itself with its secret --------------------

const SECRET = 'a-long-random-secret-for-this-hub';
const newUser = async label => {
  const id = (await q(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${label}@example.test`])).rows[0].id;
  return id;
};
const provision = (name = 'Spice Garden Bistro', city = 'Pune', secret = SECRET, ...rest) =>
  cloud.as('service_role', null, async () => (await q(`SELECT * FROM public.provision_restaurant($1, $2, $3${rest.length ? ', ' + rest.map((_, i) => `$${i + 4}`).join(', ') : ''})`, [name, city, secret, ...rest])).rows[0]);
const bind = (user, restaurantId, secret) => cloud.as('authenticated', user, async () => (await q(`SELECT public.provision_kitchen_staff($1, $2) AS id`, [restaurantId, secret])).rows[0].id);
const visibleTo = user => cloud.as('authenticated', user, async () => (await q(`SELECT id FROM public.restaurants`)).rows.map(r => r.id));

test('the operator provisions a complete, trialing tenant in one call, and the secret is stored only as a hash', async () => {
  const t = await provision();
  assert.match(t.pairing_code, /^[A-Z]{3}-\d{4}$/);
  assert.equal(t.slug, 'spice-garden-bistro');
  const days = (new Date(t.trial_ends_at) - Date.now()) / 86400000;
  assert.ok(days > 13 && days < 15, `a 14-day trial (${days.toFixed(1)})`);

  const row = (await q(`SELECT plan, plan_status, hub_provisioning_secret_hash AS h FROM public.restaurants WHERE id = $1`, [t.restaurant_id])).rows[0];
  assert.deepEqual([row.plan, row.plan_status], ['pro', 'trialing']);
  assert.ok(row.h && !row.h.includes(SECRET) && row.h.startsWith('$2'), 'bcrypt, never the plaintext');
});

test('two restaurants with the same name get different slugs and different pairing codes', async () => {
  const a = await provision('Twin Kitchen');
  const b = await provision('Twin Kitchen');
  assert.notEqual(a.slug, b.slug);
  assert.notEqual(a.pairing_code, b.pairing_code);
  assert.equal(b.slug, 'twin-kitchen-2');
});

test('it refuses a tenant that could never work: no name, no city, a short secret, an unknown plan', async () => {
  await rejected(() => provision('  ', 'Pune'), /name is required/);
  await rejected(() => provision('X Kitchen', ''), /city is required/);
  await rejected(() => provision('X Kitchen', 'Pune', 'too-short'), /at least 16 characters/);
  await rejected(() => provision('X Kitchen', 'Pune', SECRET, 'platinum'), /Unknown plan/);
  const made = (await q(`SELECT count(*)::int AS n FROM public.restaurants WHERE name = 'X Kitchen'`)).rows[0].n;
  assert.equal(made, 0, 'a refusal leaves nothing half-made');
});

test('a hub binds itself with the right secret and then sees its own restaurant, and only that', async () => {
  const t = await provision('Binding Bistro');
  const hub = await newUser('hub-binding');
  assert.deepEqual(await visibleTo(hub), [], 'before it is bound it sees nothing');
  await bind(hub, t.restaurant_id, SECRET);
  assert.deepEqual(await visibleTo(hub), [t.restaurant_id]);
});

test('a wrong secret, an unknown restaurant and a restaurant with no secret all fail with the same words: nothing to enumerate', async () => {
  const t = await provision('Locked Bistro');
  const intruder = await newUser('intruder');
  const messages = new Set();
  for (const attempt of [
    () => bind(intruder, t.restaurant_id, 'not-the-secret-at-all-0000'),
    () => bind(intruder, 'c0c0c0c0-0000-4000-8000-00000000dead', SECRET),
    () => bind(intruder, T.A.restaurant, SECRET)   // a real tenant that was set up by hand, with no secret
  ]) {
    const e = await rejected(attempt, /Invalid hub provisioning credentials/);
    messages.add(e.message);
  }
  assert.equal(messages.size, 1);
  assert.deepEqual(await visibleTo(intruder), []);
});

test('the cross-tenant takeover migration 001 closed stays closed: one tenant\'s login cannot rebind to another tenant without its secret', async () => {
  const victim = await provision('Victim Kitchen');
  const victimHub = await newUser('victim-hub');
  await bind(victimHub, victim.restaurant_id, SECRET);

  const attacker = await provision('Attacker Kitchen', 'Pune', 'the-attackers-own-long-secret');
  const attackerHub = await newUser('attacker-hub');
  await bind(attackerHub, attacker.restaurant_id, 'the-attackers-own-long-secret');

  await rejected(() => bind(attackerHub, victim.restaurant_id, 'the-attackers-own-long-secret'), /Invalid hub provisioning credentials/);
  assert.deepEqual(await visibleTo(victimHub), [victim.restaurant_id], 'the victim still has its own restaurant');
  assert.deepEqual(await visibleTo(attackerHub), [attacker.restaurant_id], 'and the attacker still has only its own');
});

test('a reinstalled hub can rebind with the secret, and the old login then loses access', async () => {
  const t = await provision('Reinstall Bistro');
  const oldHub = await newUser('old-hub');
  const newHub = await newUser('new-hub');
  const first = await bind(oldHub, t.restaurant_id, SECRET);
  const again = await bind(newHub, t.restaurant_id, SECRET);
  assert.equal(again, first, 'the same staff row, rebound');
  assert.deepEqual(await visibleTo(newHub), [t.restaurant_id]);
  assert.deepEqual(await visibleTo(oldHub), []);
});

test('binding needs a signed-in session: with no user it is refused with an authentication error, and anon cannot call it at all', async () => {
  const t = await provision('Anonymous Bistro');
  await rejected(() => cloud.as('authenticated', null, async () => q(`SELECT public.provision_kitchen_staff($1, $2)`, [t.restaurant_id, SECRET])), /Authentication required/);
  await rejected(() => cloud.as('anon', null, async () => q(`SELECT public.provision_kitchen_staff($1, $2)`, [t.restaurant_id, SECRET])), /permission denied/);
});

test('a table added later starts with nothing for anon and authenticated, so a forgotten grant fails loudly instead of opening it to everyone', async () => {
  await q(`CREATE TABLE public.future_thing (id int, restaurant_id uuid)`);
  assert.deepEqual(await privsOf('authenticated', 'future_thing'), []);
  assert.deepEqual(await privsOf('anon', 'future_thing'), []);
  assert.ok((await privsOf('service_role', 'future_thing')).length > 0, 'the operator\'s key still reaches it');
  await q(`DROP TABLE public.future_thing`);
});

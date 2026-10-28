import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';

// Migration 021: what the operator can see of every restaurant at once (the operator console, §4.9).
//
// Two things are new. A hub now says, every few minutes, that it is alive and how its sync is doing (`hub_status`): until now the only
// sign of life the cloud had was a bill arriving, which on a quiet day is no sign at all. And two views join the tables the operator needs
// to answer "which restaurants need me?" without anyone having to read a table: `ops_tenants` and `ops_events`.
//
// The views span EVERY restaurant, so who may read them is the point: only the service role (the operator service). A tenant's own login
// must not be able to see another restaurant exist, and `anon` must not see anything.

let cloud;
let T;
let service;
let hubA;
let hubB;
let ownerA;
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

before(async () => {
  cloud = await cloudDb();
  // The base schema seeds two demo restaurants, which would be in every fleet count below.
  await cloud.pg.query(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  await cloud.pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner-a@example.test')`, [OWNER_A]);
  await cloud.pg.query(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  service = pgrestServiceClient(cloud);
  hubA = pgrestClient(cloud, T.A.user);
  hubB = pgrestClient(cloud, T.B.user);
  ownerA = pgrestClient(cloud, OWNER_A);
});
after(async () => { await cloud?.close(); });

const PERMISSION_DENIED = '42501';
const refusedBy = ({ error }) => error?.code;
const beat = (restaurant, over = {}) => ({
  restaurant_id: restaurant, reported_at: '2026-10-24T09:00:00Z', started_at: '2026-10-24T06:00:00Z', version: '1.4.0',
  queued: 3, quarantined: 0, last_synced_at: '2026-10-24T08:58:00Z', devices: 2, waiters: 4, ...over
});
const rows = async sql => (await cloud.pg.query(sql)).rows;

// --- the hub's report -------------------------------------------------------------------------------------------------------

test('a hub reports on itself: one row per restaurant, written by its own login, again and again', async () => {
  const first = await hubA.from('hub_status').upsert(beat(T.A.restaurant), { onConflict: 'restaurant_id' });
  assert.equal(first.error, null, JSON.stringify(first.error));
  const again = await hubA.from('hub_status').upsert(beat(T.A.restaurant, { queued: 5, reported_at: '2026-10-24T09:05:00Z' }), { onConflict: 'restaurant_id' });
  assert.equal(again.error, null, JSON.stringify(again.error));
  const stored = await rows('SELECT * FROM public.hub_status');
  assert.equal(stored.length, 1, 'one row, however often it reports');
  assert.deepEqual([stored[0].restaurant_id, stored[0].queued, stored[0].version, stored[0].devices, stored[0].waiters], [T.A.restaurant, 5, '1.4.0', 2, 4]);
});

test('a report needs its time, and a count cannot be negative', async () => {
  const withoutTime = beat(T.A.restaurant);
  delete withoutTime.reported_at;
  assert.equal(refusedBy(await hubA.from('hub_status').upsert(withoutTime, { onConflict: 'restaurant_id' })), '23502');
  for (const bad of [{ queued: -1 }, { quarantined: -1 }, { devices: -1 }, { waiters: -1 }]) {
    assert.equal(refusedBy(await hubA.from('hub_status').upsert(beat(T.A.restaurant, bad), { onConflict: 'restaurant_id' })), '23514', JSON.stringify(bad));
  }
  for (const column of ['queued', 'quarantined', 'devices', 'waiters']) {
    assert.equal(refusedBy(await hubA.from('hub_status').upsert(beat(T.A.restaurant, { [column]: null }), { onConflict: 'restaurant_id' })), '23502', `${column}: no report is not a report of nothing`);
  }
  assert.equal(refusedBy(await hubA.from('hub_status').upsert(beat(T.A.restaurant, { version: 'x'.repeat(41) }), { onConflict: 'restaurant_id' })), '22001', 'a version is a short string');
  assert.equal((await hubA.from('hub_status').upsert(beat(T.A.restaurant, { version: 'v'.repeat(40) }), { onConflict: 'restaurant_id' })).error, null, 'forty is the longest');
  const ok = await hubA.from('hub_status').upsert(beat(T.A.restaurant, { queued: 0, quarantined: 0, devices: 0, waiters: 0, version: null, started_at: null, last_synced_at: null }), { onConflict: 'restaurant_id' });
  assert.equal(ok.error, null, 'zero is a count, and a hub that has never synced has no time for it');
});

test('the database stamps when it heard, whatever the hub claims', async () => {
  // A first report, so that it is the insert that is stamped, and not only the updates after it.
  await cloud.pg.query('DELETE FROM public.hub_status WHERE restaurant_id = $1', [T.A.restaurant]);
  await hubA.from('hub_status').upsert(beat(T.A.restaurant, { received_at: '2000-01-01T00:00:00Z' }), { onConflict: 'restaurant_id' });
  const first = (await rows(`SELECT received_at, extract(epoch FROM (now() - received_at)) AS age FROM public.hub_status`))[0];
  assert.ok(first.age >= 0 && first.age < 120, `stamped now, not in 2000 (${first.age}s ago)`);
  await new Promise(r => setTimeout(r, 25));
  await hubA.from('hub_status').upsert(beat(T.A.restaurant, { received_at: '2000-01-01T00:00:00Z', queued: 9 }), { onConflict: 'restaurant_id' });
  const second = (await rows(`SELECT received_at, queued FROM public.hub_status`))[0];
  assert.equal(second.queued, 9);
  assert.ok(new Date(second.received_at) > new Date(first.received_at), 'and again each time it reports');
});

test('a hub writes its own report and no one else\'s, and reads only its own', async () => {
  const forged = await hubA.from('hub_status').upsert(beat(T.B.restaurant), { onConflict: 'restaurant_id' });
  assert.equal(refusedBy(forged), PERMISSION_DENIED, 'not a report for someone else');
  assert.equal((await rows(`SELECT 1 FROM public.hub_status WHERE restaurant_id = '${T.B.restaurant}'`)).length, 0);
  // A plain insert has no read check behind it, so here it is the insert policy alone that says no.
  assert.equal(refusedBy(await hubA.from('hub_status').insert(beat(T.B.restaurant))), PERMISSION_DENIED, 'nor by inserting plainly');
  assert.equal((await rows(`SELECT 1 FROM public.hub_status WHERE restaurant_id = '${T.B.restaurant}'`)).length, 0);

  await cloud.pg.query(`INSERT INTO public.hub_status (restaurant_id, reported_at, queued) VALUES ($1, now(), 7)`, [T.B.restaurant]);
  const theirs = await hubA.from('hub_status').update({ queued: 0 }).eq('restaurant_id', T.B.restaurant).select('queued');
  assert.deepEqual(theirs.data, [], 'row-level security hides it, so nothing is changed');
  assert.equal((await rows(`SELECT queued FROM public.hub_status WHERE restaurant_id = '${T.B.restaurant}'`))[0].queued, 7);

  assert.deepEqual((await hubA.from('hub_status').select('restaurant_id')).data.map(r => r.restaurant_id), [T.A.restaurant]);
  assert.deepEqual((await hubB.from('hub_status').select('restaurant_id')).data.map(r => r.restaurant_id), [T.B.restaurant]);
  // To a restaurant with no report of its own, so that it is the policy refusing it and not a duplicate key.
  const THIRD = 'c0c0c0c0-0000-4000-8000-000000000003';
  await cloud.pg.query(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ($1, 'Restaurant C', 'restaurant-c', 'Nagpur', 'PC-C')`, [THIRD]);
  // No RETURNING: with one, the row-level policy for reading would refuse the moved row too, and hide whether the update's own check does.
  const moved = await hubA.from('hub_status').update({ restaurant_id: THIRD }).eq('restaurant_id', T.A.restaurant);
  assert.equal(refusedBy(moved), PERMISSION_DENIED, 'a report cannot be handed to another restaurant');
  assert.equal((await rows(`SELECT 1 FROM public.hub_status WHERE restaurant_id = '${T.A.restaurant}'`)).length, 1);
  await cloud.pg.query('DELETE FROM public.restaurants WHERE id = $1', [THIRD]);
});

test('an owner can read the hub\'s report and change nothing', async () => {
  assert.equal((await ownerA.from('hub_status').select('queued')).data.length, 1);
  const edit = await ownerA.from('hub_status').update({ queued: 0 }).eq('restaurant_id', T.A.restaurant).select('queued');
  assert.deepEqual(edit.data, [], 'not allowed to rewrite it');
  assert.equal(refusedBy(await ownerA.from('hub_status').upsert(beat(T.A.restaurant, { queued: 1 }), { onConflict: 'restaurant_id' })), PERMISSION_DENIED);
  assert.equal(refusedBy(await ownerA.from('hub_status').delete().eq('restaurant_id', T.A.restaurant)), PERMISSION_DENIED);

  // Nor can an owner put one where there is none: that is the hub's alone.
  await cloud.pg.query('DELETE FROM public.hub_status WHERE restaurant_id = $1', [T.A.restaurant]);
  assert.equal(refusedBy(await ownerA.from('hub_status').insert(beat(T.A.restaurant))), PERMISSION_DENIED, 'an owner, inserting plainly');
  assert.equal(refusedBy(await ownerA.from('hub_status').upsert(beat(T.A.restaurant), { onConflict: 'restaurant_id' })), PERMISSION_DENIED, 'and so is an owner, upserting');
  assert.equal((await rows(`SELECT 1 FROM public.hub_status WHERE restaurant_id = '${T.A.restaurant}'`)).length, 0);
  assert.equal((await hubA.from('hub_status').upsert(beat(T.A.restaurant), { onConflict: 'restaurant_id' })).error, null, 'while the hub can');
});

test('the function that stamps the time is for the trigger alone: nobody may call it', async () => {
  for (const role of ['anon', 'authenticated']) {
    const can = (await cloud.pg.query(`SELECT has_function_privilege($1, 'public.hub_status_stamp()', 'EXECUTE') AS ok`, [role])).rows[0].ok;
    assert.equal(can, false, role);
  }
});

test('anonymous callers can neither read nor write the report', async () => {
  const outcomes = await cloud.as('anon', null, async () => {
    const out = {};
    for (const sql of [
      'SELECT * FROM public.hub_status', 'DELETE FROM public.hub_status', `UPDATE public.hub_status SET queued = 0`,
      `INSERT INTO public.hub_status (restaurant_id, reported_at) VALUES ('${T.A.restaurant}', now())`
    ]) {
      try { await cloud.pg.query(sql); out[sql] = 'allowed'; } catch (e) { out[sql] = e.code; }
    }
    return out;
  });
  for (const [sql, outcome] of Object.entries(outcomes)) assert.equal(outcome, PERMISSION_DENIED, sql);
});

// --- who may read the fleet ---------------------------------------------------------------------------------------------------

test('only the service role can read the fleet views: not anon, not a tenant\'s hub, not its owner', async () => {
  for (const view of ['ops_tenants', 'ops_events']) {
    const anon = await cloud.as('anon', null, async () => { try { await cloud.pg.query(`SELECT * FROM public.${view}`); return 'allowed'; } catch (e) { return e.code; } });
    assert.equal(anon, PERMISSION_DENIED, `anon reading ${view}`);
    for (const [who, client] of [['a hub', hubA], ['an owner', ownerA]]) {
      assert.equal(refusedBy(await client.from(view).select('*')), PERMISSION_DENIED, `${who} reading ${view}`);
    }
    const read = await service.from(view).select('*');
    assert.equal(read.error, null, `the operator service reading ${view}: ${JSON.stringify(read.error)}`);
  }
});

test('the privileges are exactly these: the report for the hub to write, the views for the operator service alone', async () => {
  const can = async (role, object, privilege) => (await cloud.pg.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${object}`, privilege])).rows[0].ok;
  const held = async (role, object) => {
    const out = [];
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) if (await can(role, object, p)) out.push(p);
    return out;
  };
  for (const object of ['hub_status', 'ops_tenants', 'ops_events']) assert.deepEqual(await held('anon', object), [], `anon on ${object}`);
  assert.deepEqual(await held('authenticated', 'hub_status'), ['SELECT', 'INSERT', 'UPDATE'], 'the hub reports; it never removes its report');
  for (const view of ['ops_tenants', 'ops_events']) {
    assert.deepEqual(await held('authenticated', view), [], `a tenant's login on ${view}`);
    assert.deepEqual(await held('service_role', view), ['SELECT'], `the operator service reads ${view} and writes nothing`);
  }
  assert.ok(await can('service_role', 'hub_status', 'SELECT'));
});

// --- what the operator sees ---------------------------------------------------------------------------------------------------

const TENANT_COLUMNS = [
  'restaurant_id', 'name', 'slug', 'city', 'phone', 'plan', 'plan_status', 'trial_ends_at', 'current_period_end', 'created_at',
  'subscription_status', 'subscription_plan', 'subscription_cancel_requested_at', 'subscription_plan_change_to', 'subscription_period_end', 'subscription_last_event_at',
  'hub_seen_at', 'hub_reported_at', 'hub_started_at', 'hub_version', 'hub_queued', 'hub_quarantined', 'hub_last_synced_at', 'hub_devices', 'hub_waiters',
  'last_invoice_at', 'invoices_7d'
];

test('a restaurant with nothing yet still has a row, with nothing where the hub, the subscription and the billing would be', async () => {
  await cloud.pg.query('DELETE FROM public.hub_status');
  const all = (await service.from('ops_tenants').select('*')).data;
  assert.deepEqual(all.map(r => r.name).sort(), ['Restaurant A', 'Restaurant B'], 'every restaurant, once');
  const b = all.find(r => r.restaurant_id === T.B.restaurant);
  assert.deepEqual([b.city, b.plan, b.plan_status], ['Nagpur', 'starter', 'active']);
  for (const column of TENANT_COLUMNS.filter(c => /^(subscription_|hub_)/.test(c) && !/_(queued|quarantined|devices|waiters)$/.test(c))) assert.equal(b[column], null, column);
  assert.deepEqual([b.hub_queued, b.hub_quarantined, b.hub_devices, b.hub_waiters], [null, null, null, null], 'no report is not a report of zero');
  assert.deepEqual([b.last_invoice_at, b.invoices_7d], [null, 0]);
});

test('a restaurant\'s row joins its plan, its newest subscription, its hub\'s last report and the week\'s bills', async () => {
  await cloud.pg.query(`UPDATE public.restaurants SET plan = 'pro', plan_status = 'past_due', trial_ends_at = '2026-09-20T00:00:00Z', current_period_end = '2026-10-20T00:00:00Z', phone = '9876500000' WHERE id = $1`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan, current_end, created_at) VALUES ($1, 'sub_old', 'cancelled', 'starter', '2026-09-30T00:00:00Z', '2026-09-01T00:00:00Z')`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan, cancel_requested_at, plan_change_to, current_end, last_event_at, created_at, short_url)
    VALUES ($1, 'sub_new', 'halted', 'pro', '2026-10-21T00:00:00Z', 'starter', '2026-10-20T00:00:00Z', '2026-10-19T00:00:00Z', '2026-10-01T00:00:00Z', 'https://rzp.io/secret-payment-link')`, [T.A.restaurant]);
  await hubA.from('hub_status').upsert(beat(T.A.restaurant, { queued: 12, quarantined: 2 }), { onConflict: 'restaurant_id' });
  for (const [ref, issued, synced] of [['b1', "now() - interval '2 days'", 'now()'], ['b2', "now() - interval '6 days'", 'now()'], ['b3', "now() - interval '20 days'", 'now()'], ['b4', 'NULL', "now() - interval '1 day'"], ['b5', "now() - interval '7 days 12 hours'", 'now()']]) {
    await cloud.pg.query(`INSERT INTO public.invoices (restaurant_id, hub_ref, invoice_number, issued_at, synced_at) VALUES ($1, '${ref}', '${ref}', ${issued}, ${synced})`, [T.A.restaurant]);
  }
  await cloud.pg.query(`INSERT INTO public.invoices (restaurant_id, hub_ref, invoice_number, issued_at) VALUES ($1, 'other', 'other', now())`, [T.B.restaurant]);

  const found = (await service.from('ops_tenants').select('*').eq('restaurant_id', T.A.restaurant)).data;
  assert.equal(found.length, 1, 'one row, however many subscriptions it has had');
  const a = found[0];
  assert.deepEqual([a.name, a.slug, a.city, a.phone, a.plan, a.plan_status], ['Restaurant A', 'restaurant-a', 'Nagpur', '9876500000', 'pro', 'past_due']);
  assert.deepEqual([a.trial_ends_at, a.current_period_end], ['2026-09-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  assert.deepEqual(
    [a.subscription_status, a.subscription_plan, a.subscription_cancel_requested_at, a.subscription_plan_change_to, a.subscription_period_end, a.subscription_last_event_at],
    ['halted', 'pro', '2026-10-21T00:00:00.000Z', 'starter', '2026-10-20T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    'the newest subscription, not the first and not both'
  );
  assert.deepEqual([a.hub_reported_at, a.hub_started_at, a.hub_version, a.hub_queued, a.hub_quarantined, a.hub_last_synced_at, a.hub_devices, a.hub_waiters],
    ['2026-10-24T09:00:00.000Z', '2026-10-24T06:00:00.000Z', '1.4.0', 12, 2, '2026-10-24T08:58:00.000Z', 2, 4]);
  assert.ok(a.hub_seen_at, 'when the database heard');
  assert.equal(a.invoices_7d, 2, 'bills issued in the last seven days: not the one from twenty days ago, and not one that was only ever synced');
  assert.ok(Math.abs(new Date(a.last_invoice_at) - Date.now() + 2 * 24 * 3600 * 1000) < 120000, 'the newest of them, two days ago');
  const b = (await service.from('ops_tenants').select('*').eq('restaurant_id', T.B.restaurant)).data[0];
  assert.equal(b.invoices_7d, 1, 'and not another restaurant\'s');
  assert.deepEqual([b.subscription_status, b.subscription_plan], [null, null], 'nor is a subscription another restaurant\'s');
});

test('the row says nothing it has no business saying: no pairing code, secret, setting or payment link', async () => {
  const a = (await service.from('ops_tenants').select('*').eq('restaurant_id', T.A.restaurant)).data[0];
  assert.deepEqual(Object.keys(a).sort(), [...TENANT_COLUMNS].sort());
  assert.equal(JSON.stringify(a).includes('secret-payment-link'), false);
});

test('the event log lists what happened, with the restaurant\'s name, and not what Razorpay sent', async () => {
  await cloud.pg.query(`INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, applied_plan_status, payload, received_at)
    VALUES ($1, 'sub_new', 'subscription.halted', 'past_due', '{"customer": {"email": "someone@example.test"}}', '2026-10-19T00:00:00Z')`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, received_at) VALUES (NULL, 'sub_unknown', 'subscription.charged', '2026-10-20T00:00:00Z')`);
  const events = (await service.from('ops_events').select('*').order('received_at', { ascending: false })).data;
  assert.deepEqual(events.map(e => [e.event, e.restaurant_name, e.applied_plan_status]), [['subscription.charged', null, null], ['subscription.halted', 'Restaurant A', 'past_due']],
    'an event that matched no restaurant is still listed');
  assert.deepEqual(Object.keys(events[1]).sort(), ['applied_plan_status', 'event', 'id', 'razorpay_subscription_id', 'received_at', 'restaurant_id', 'restaurant_name']);
  assert.equal(JSON.stringify(events).includes('someone@example.test'), false);
});

// --- housekeeping -----------------------------------------------------------------------------------------------------------------

test('removing a restaurant removes its report', async () => {
  await cloud.pg.query(`INSERT INTO public.hub_status (restaurant_id, reported_at) VALUES ($1, now())`, [T.B.restaurant]);
  await cloud.pg.query(`DELETE FROM public.staff_users WHERE restaurant_id = $1`, [T.B.restaurant]);
  await cloud.pg.query(`DELETE FROM public.restaurants WHERE id = $1`, [T.B.restaurant]);
  assert.equal((await rows(`SELECT 1 FROM public.hub_status WHERE restaurant_id = '${T.B.restaurant}'`)).length, 0);
});

test('the migration is safe to run again, and does not touch what is there', async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'migrations', '021_ops_console.sql');
  const before = (await rows('SELECT * FROM public.hub_status')).length;
  await cloud.pg.exec(fs.readFileSync(file, 'utf8'));
  await cloud.pg.exec(fs.readFileSync(file, 'utf8'));
  assert.equal((await rows('SELECT * FROM public.hub_status')).length, before);
  assert.equal((await service.from('ops_tenants').select('*')).data.length, 1, 'and the view still answers');
});

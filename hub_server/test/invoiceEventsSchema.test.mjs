import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';
import { buildEvent, GENESIS_HASH } from '../lib/invoiceEvents.js';
import { eventRow } from '../lib/invoiceEventsSync.js';

// Migration 022: a bill's event history, in the cloud (G0-4). Run on a real Postgres engine (PGlite) with Supabase's default
// privileges modelled. The point of the table is what it will NOT do: nobody changes or removes an event, and the cloud refuses
// a history that forks, skips an event or does not start at the beginning.

let cloud;
let T;
let hubA;
let hubB;
let service;
let ownerA;
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AT = '2026-10-26T10:00:00.000Z';

before(async () => {
  cloud = await cloudDb();
  await cloud.pg.query(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  await cloud.pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner-a@example.test')`, [OWNER_A]);
  await cloud.pg.query(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  hubA = pgrestClient(cloud, T.A.user);
  hubB = pgrestClient(cloud, T.B.user);
  ownerA = pgrestClient(cloud, OWNER_A);
  service = pgrestServiceClient(cloud);
});
after(async () => { await cloud?.close(); });

const PERMISSION_DENIED = '42501';
const q = (sql, params) => cloud.pg.query(sql, params);
const count = async (where = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM public.invoice_events WHERE ${where}`, params)).rows[0].n;

/** A chain of `n` events for a bill, built by the hub's own code and shaped as the hub would push them. */
function chain(restaurant, ref, n, { types = [] } = {}) {
  const rows = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const e = buildEvent({ restaurantId: restaurant, invoiceRef: ref, seq, type: types[seq - 1] || (seq === 1 ? 'issued' : 'paid'), actor: 'Priya', occurredAt: AT, payload: { n: seq }, prevHash: prev });
    rows.push(eventRow(restaurant, e));
    prev = e.hash;
  }
  return rows;
}
const push = (client, rows) => client.from('invoice_events').upsert(rows, { onConflict: 'restaurant_id,invoice_hub_ref,seq', ignoreDuplicates: true });
const code = r => r.error?.code;

// --- the migration ---------------------------------------------------------------------------------------------------------

test('the migration applies on top of the others, and again, and changes nothing the second time', async () => {
  const before = (await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.invoice_events'::regclass`)).rows[0].n;
  await cloud.applyAll({ onlyMigrations: true });
  const after = (await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.invoice_events'::regclass`)).rows[0].n;
  assert.ok(before >= 4, 'row guard, update/delete guard, truncate guard and the RLS/constraint triggers');
  assert.equal(after, before);
});

// --- what the hub writes -----------------------------------------------------------------------------------------------------

test('a hub adds a bill\'s events, in order, and reads them back', async () => {
  const r = await push(hubA, chain(T.A.restaurant, 'inv_ok', 3));
  assert.equal(r.error, null, JSON.stringify(r.error));
  const { data } = await hubA.from('invoice_events').select('*').eq('invoice_hub_ref', 'inv_ok').order('seq');
  assert.deepEqual(data.map(e => e.seq), [1, 2, 3]);
  assert.deepEqual(data.map(e => e.event_type), ['issued', 'paid', 'paid']);
  assert.equal(data[0].actor, 'Priya');
  assert.deepEqual(data[1].payload, { n: 2 });
});

test('pushing the same events again is a no-op', async () => {
  const rows = chain(T.A.restaurant, 'inv_twice', 2);
  assert.equal((await push(hubA, rows)).error, null);
  assert.equal((await push(hubA, rows)).error, null);
  assert.equal(await count(`invoice_hub_ref = 'inv_twice'`), 2);
});

test('the rest of a bill\'s history can be added later, one event or several at a time', async () => {
  const rows = chain(T.A.restaurant, 'inv_later', 4);
  assert.equal((await push(hubA, rows.slice(0, 1))).error, null);
  assert.equal((await push(hubA, rows.slice(1, 2))).error, null);
  assert.equal((await push(hubA, rows.slice(1))).error, null, 'overlapping what is already there');
  assert.equal(await count(`invoice_hub_ref = 'inv_later'`), 4);
});

test('the time the hub stamped is kept to the millisecond', async () => {
  const [row] = chain(T.A.restaurant, 'inv_time', 1);
  row.occurred_at = '2026-10-26T10:00:00.123Z';
  const e = buildEvent({ restaurantId: T.A.restaurant, invoiceRef: 'inv_time', seq: 1, type: 'issued', actor: 'P', occurredAt: row.occurred_at, payload: { n: 1 }, prevHash: GENESIS_HASH });
  assert.equal((await push(hubA, [eventRow(T.A.restaurant, e)])).error, null);
  const { data } = await hubA.from('invoice_events').select('occurred_at').eq('invoice_hub_ref', 'inv_time');
  assert.equal(data[0].occurred_at, '2026-10-26T10:00:00.123Z');
});

test('every kind of event the hub records is accepted', async () => {
  const types = ['baseline', 'issued', 'split', 'unsplit', 'paid', 'split_paid', 'voided', 'refunded'];
  const rows = chain(T.A.restaurant, 'inv_kinds', types.length, { types });
  assert.equal((await push(hubA, rows)).error, null);
  assert.equal(await count(`invoice_hub_ref = 'inv_kinds'`), types.length);
});

// --- nobody changes or removes an event ----------------------------------------------------------------------------------------

test('no login can change an event: not the hub, not the owner, not the service role, not even the table owner', async () => {
  await push(hubA, chain(T.A.restaurant, 'inv_fixed', 2));
  for (const who of ['hub', 'owner', 'service']) {
    const client = { hub: hubA, owner: ownerA, service }[who];
    const r = await client.from('invoice_events').update({ actor: 'Someone else' }).eq('invoice_hub_ref', 'inv_fixed').select('actor');
    assert.ok(r.error || r.count === 0 || (r.data || []).length === 0, `${who} changed an event: ${JSON.stringify(r)}`);
  }
  await assert.rejects(() => q(`UPDATE public.invoice_events SET actor = 'x' WHERE invoice_hub_ref = 'inv_fixed'`), /append-only/i);
  assert.equal((await q(`SELECT count(*)::int AS n FROM public.invoice_events WHERE invoice_hub_ref = 'inv_fixed' AND actor = 'Priya'`)).rows[0].n, 2);
});

test('no login can remove an event', async () => {
  await push(hubA, chain(T.A.restaurant, 'inv_kept', 2));
  for (const client of [hubA, ownerA, service]) {
    const r = await client.from('invoice_events').delete().eq('invoice_hub_ref', 'inv_kept');
    assert.ok(r.error || r.count === 0, JSON.stringify(r));
  }
  await assert.rejects(() => q(`DELETE FROM public.invoice_events WHERE invoice_hub_ref = 'inv_kept'`), /append-only/i);
  assert.equal(await count(`invoice_hub_ref = 'inv_kept'`), 2);
});

test('the table cannot be emptied in one statement', async () => {
  await assert.rejects(() => q(`TRUNCATE public.invoice_events`), /append-only/i);
  await assert.rejects(() => cloud.as('authenticated', T.A.user, () => q(`TRUNCATE public.invoice_events`)), /permission denied|append-only/i);
  await assert.rejects(() => cloud.as('service_role', null, () => q(`TRUNCATE public.invoice_events`)), /permission denied|append-only/i);
});

test('the privileges are stated, not inherited: the hub and the service role may read and add, and no one else may do anything', async () => {
  const grants = async role => (await q(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'invoice_events' AND grantee = $1 ORDER BY 1`, [role])).rows.map(r => r.privilege_type);
  assert.deepEqual(await grants('authenticated'), ['INSERT', 'SELECT']);
  assert.deepEqual(await grants('service_role'), ['INSERT', 'SELECT']);
  assert.deepEqual(await grants('anon'), []);
});

test('an unauthenticated caller reads and writes nothing', async () => {
  await assert.rejects(() => cloud.as('anon', null, () => q(`SELECT 1 FROM public.invoice_events LIMIT 1`)), /permission denied/i);
  await assert.rejects(() => cloud.as('anon', null, () => q(`INSERT INTO public.invoice_events (restaurant_id) VALUES ($1)`, [T.A.restaurant])), /permission denied/i);
});

test('removing a restaurant removes its history with it, and that is the only way history goes', async () => {
  await cloud.pg.query(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ('c0c0c0c0-0000-4000-8000-000000000003', 'Gone', 'gone', 'Nagpur', 'PC-C')`);
  await q(`INSERT INTO public.invoice_events (restaurant_id, invoice_hub_ref, seq, event_type, actor, occurred_at, payload, prev_hash, hash)
           VALUES ('c0c0c0c0-0000-4000-8000-000000000003', 'inv_g', 1, 'issued', 'P', now(), '{}', $1, $2)`, [GENESIS_HASH, 'a'.repeat(64)]);
  assert.equal(await count(`restaurant_id = 'c0c0c0c0-0000-4000-8000-000000000003'`), 1);
  await q(`DELETE FROM public.restaurants WHERE id = 'c0c0c0c0-0000-4000-8000-000000000003'`);
  assert.equal(await count(`restaurant_id = 'c0c0c0c0-0000-4000-8000-000000000003'`), 0);
});

// --- the cloud refuses a bad history -----------------------------------------------------------------------------------------

test('the first event of a bill must start at the genesis hash', async () => {
  const [row] = chain(T.A.restaurant, 'inv_bad_start', 1);
  const r = await push(hubA, [{ ...row, prev_hash: 'a'.repeat(64) }]);
  assert.ok(r.error, 'accepted a history that does not begin at the beginning');
  assert.equal(await count(`invoice_hub_ref = 'inv_bad_start'`), 0);
});

test('an event cannot skip ahead: event 3 without event 2 is refused', async () => {
  const rows = chain(T.A.restaurant, 'inv_gap', 3);
  assert.equal((await push(hubA, rows.slice(0, 1))).error, null);
  const r = await push(hubA, rows.slice(2));
  assert.ok(r.error, 'accepted an event with a gap before it');
  assert.equal(await count(`invoice_hub_ref = 'inv_gap'`), 1);
});

test('an event must name the hash of the one before it', async () => {
  const rows = chain(T.A.restaurant, 'inv_link', 2);
  assert.equal((await push(hubA, rows.slice(0, 1))).error, null);
  const r = await push(hubA, [{ ...rows[1], prev_hash: 'b'.repeat(64) }]);
  assert.ok(r.error);
  assert.equal(await count(`invoice_hub_ref = 'inv_link'`), 1);
});

test('a different event under a number already used is refused, not silently ignored', async () => {
  const rows = chain(T.A.restaurant, 'inv_fork', 2);
  assert.equal((await push(hubA, rows)).error, null);
  const forged = buildEvent({ restaurantId: T.A.restaurant, invoiceRef: 'inv_fork', seq: 2, type: 'voided', actor: 'Someone else', occurredAt: AT, payload: { n: 'forged' }, prevHash: rows[0].hash });
  const r = await push(hubA, [eventRow(T.A.restaurant, forged)]);
  assert.ok(r.error, 'the fork was swallowed by ON CONFLICT DO NOTHING');
  assert.match(r.error.message, /fork|already|different/i);
  assert.equal((await q(`SELECT actor FROM public.invoice_events WHERE invoice_hub_ref = 'inv_fork' AND seq = 2`)).rows[0].actor, 'Priya');
});

test('a batch is judged event by event, in order, so a whole history can go up in one call', async () => {
  const r = await push(hubA, chain(T.A.restaurant, 'inv_batch', 6));
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.equal(await count(`invoice_hub_ref = 'inv_batch'`), 6);
});

test('a bad event in a batch refuses the whole batch', async () => {
  const rows = chain(T.A.restaurant, 'inv_atomic', 3);
  rows[2] = { ...rows[2], prev_hash: 'c'.repeat(64) };
  assert.ok((await push(hubA, rows)).error);
  assert.equal(await count(`invoice_hub_ref = 'inv_atomic'`), 0);
});

test('the shape of a row is checked: a kind that does not exist, a malformed hash, a number below 1, a payload that is not an object', async () => {
  const [ok] = chain(T.A.restaurant, 'inv_shape', 1);
  for (const [name, bad] of Object.entries({
    kind: { event_type: 'edited' },
    hash: { hash: 'xyz' },
    uppercase: { hash: 'A'.repeat(64) },
    prev: { prev_hash: 'short' },
    seq: { seq: 0 },
    payload: { payload: [1, 2] },
    noActorLength: { actor: 'x'.repeat(61) }
  })) {
    const r = await push(hubA, [{ ...ok, ...bad }]);
    assert.ok(r.error, `${name} was accepted`);
  }
  assert.equal(await count(`invoice_hub_ref = 'inv_shape'`), 0);
});

test('an event with no actor is allowed, because some changes have no named person', async () => {
  const e = buildEvent({ restaurantId: T.A.restaurant, invoiceRef: 'inv_anon', seq: 1, type: 'issued', actor: null, occurredAt: AT, payload: { n: 1 }, prevHash: GENESIS_HASH });
  assert.equal((await push(hubA, [eventRow(T.A.restaurant, e)])).error, null);
});

// --- tenants -------------------------------------------------------------------------------------------------------------------

test('a restaurant reads only its own history and cannot write into another\'s', async () => {
  await push(hubB, chain(T.B.restaurant, 'inv_b', 2));
  const seenByA = await hubA.from('invoice_events').select('restaurant_id');
  assert.ok(seenByA.data.length > 0 && seenByA.data.every(r => r.restaurant_id === T.A.restaurant));
  const intoB = await push(hubA, chain(T.B.restaurant, 'inv_into_b', 1));
  assert.ok(intoB.error, 'wrote a row for another restaurant');
  assert.equal(await count(`invoice_hub_ref = 'inv_into_b'`), 0);
});

test('a plain insert for another restaurant is refused by row-level security, not by anything else', async () => {
  const [row] = chain(T.B.restaurant, 'inv_plain_b', 1);
  await assert.rejects(() => cloud.as('authenticated', T.A.user, () => q(
    `INSERT INTO public.invoice_events (restaurant_id, invoice_hub_ref, seq, event_type, actor, occurred_at, payload, prev_hash, hash)
     VALUES ($1, $2, 1, 'issued', 'P', now(), '{}', $3, $4)`, [T.B.restaurant, row.invoice_hub_ref, GENESIS_HASH, row.hash]
  )), /row-level security/i);
});

test('the column checks hold on their own, even if the guard trigger were out of the way', async () => {
  await q('ALTER TABLE public.invoice_events DISABLE TRIGGER invoice_events_guard_insert');
  try {
    const bad = {
      seq: [0, 'invoice_events_seq_check'],
      prev: ['short', 'invoice_events_prev_check'],
      hash: ['xyz', 'invoice_events_hash_check']
    };
    for (const [name, [value, constraint]] of Object.entries(bad)) {
      const params = { seq: [0, GENESIS_HASH, 'a'.repeat(64)], prev: [1, value, 'a'.repeat(64)], hash: [1, GENESIS_HASH, value] }[name];
      await assert.rejects(() => q(
        `INSERT INTO public.invoice_events (restaurant_id, invoice_hub_ref, seq, event_type, actor, occurred_at, payload, prev_hash, hash)
         VALUES ($1, 'inv_checks', $2, 'issued', 'P', now(), '{}', $3, $4)`, [T.A.restaurant, ...params]
      ), new RegExp(constraint), name);
    }
  } finally {
    await q('ALTER TABLE public.invoice_events ENABLE TRIGGER invoice_events_guard_insert');
  }
});

test('two restaurants can use the same hub reference without sharing a chain', async () => {
  assert.equal((await push(hubA, chain(T.A.restaurant, 'inv_same', 2))).error, null);
  assert.equal((await push(hubB, chain(T.B.restaurant, 'inv_same', 1))).error, null);
  assert.equal(await count(`invoice_hub_ref = 'inv_same'`), 3);
});

test('an owner can read the history and cannot add to it: only the hub writes', async () => {
  const read = await ownerA.from('invoice_events').select('invoice_hub_ref').eq('invoice_hub_ref', 'inv_ok');
  assert.equal(read.error, null);
  assert.ok(read.data.length > 0);
  const write = await push(ownerA, chain(T.A.restaurant, 'inv_owner_write', 1));
  assert.ok(write.error, 'an owner login added an event');
  assert.equal(await count(`invoice_hub_ref = 'inv_owner_write'`), 0);
});

test('the service role can read and add, because that is how the operator checks the cloud, but still cannot change anything', async () => {
  assert.equal((await push(service, chain(T.A.restaurant, 'inv_service', 1))).error, null);
  assert.equal(code(await service.from('invoice_events').delete().eq('invoice_hub_ref', 'inv_service')) ?? PERMISSION_DENIED, PERMISSION_DENIED);
  assert.equal(await count(`invoice_hub_ref = 'inv_service'`), 1);
});

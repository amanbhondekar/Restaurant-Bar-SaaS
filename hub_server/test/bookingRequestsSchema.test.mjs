import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';

// Migration 020: where a guest's request for a table waits for the restaurant (§4.6, the public reservation page).
//
// The tables are the first a stranger's data ends up in, so what each caller may NOT do matters more than what it may. A guest never
// touches the database at all: the operator service (the service role) writes the request on their behalf, after its own checks.
// The restaurant's hub reads its inbox and clears what it has dealt with; an owner or manager may look; nobody else may do anything.

let cloud;
let T;
let service;
let hubA;
let hubB;
let ownerA;
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  await cloud.pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner-a@example.test')`, [OWNER_A]);
  await cloud.pg.query(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  service = pgrestServiceClient(cloud);
  hubA = pgrestClient(cloud, T.A.user);
  hubB = pgrestClient(cloud, T.B.user);
  ownerA = pgrestClient(cloud, OWNER_A);
});
after(async () => { await cloud?.close(); });

const request = (restaurant, over = {}) => ({
  restaurant_id: restaurant, guest_name: 'Asha', phone: '919876543210', party_size: 4, requested_for: '2026-11-01T13:30:00Z', note: 'Window, if possible', ...over
});
const refusedBy = ({ error }) => error?.code;
const PERMISSION_DENIED = '42501';

test('a booking page belongs to one restaurant, has a public code, and a code is used once', async () => {
  const made = await service.from('booking_pages').insert({ restaurant_id: T.A.restaurant, code: 'abcd1234ef' });
  assert.equal(made.error, null, JSON.stringify(made.error));
  const row = (await cloud.pg.query('SELECT * FROM public.booking_pages')).rows[0];
  assert.deepEqual([row.restaurant_id, row.code, row.enabled], [T.A.restaurant, 'abcd1234ef', true], 'on from the start: turning it on is what created it');

  assert.equal(refusedBy(await service.from('booking_pages').insert({ restaurant_id: T.A.restaurant, code: 'zzzzzzzzzz' })), '23505', 'one page per restaurant');
  assert.equal(refusedBy(await service.from('booking_pages').insert({ restaurant_id: T.B.restaurant, code: 'abcd1234ef' })), '23505', 'a code names one restaurant');
  for (const code of ['short', 'UPPERCASE12', 'has space 12', 'semi;colon12', 'x'.repeat(33)]) {
    assert.equal(refusedBy(await service.from('booking_pages').insert({ restaurant_id: T.B.restaurant, code })), '23514', `"${code}" is not a code`);
  }
  await cloud.pg.query('DELETE FROM public.booking_pages');
});

test('a request needs a name, a number, a party of 1 to 40 and a time; the rest is optional', async () => {
  const ok = await service.from('booking_requests').insert(request(T.A.restaurant, { note: undefined }));
  assert.equal(ok.error, null, JSON.stringify(ok.error));
  for (const bad of [{ guest_name: null }, { phone: null }, { party_size: 0 }, { party_size: 41 }, { requested_for: null }]) {
    assert.ok(refusedBy(await service.from('booking_requests').insert(request(T.A.restaurant, bad))), JSON.stringify(bad));
  }
  assert.equal(refusedBy(await service.from('booking_requests').insert(request('00000000-0000-4000-8000-00000000dead'))), '23503', 'it must belong to a restaurant');
  await cloud.pg.query('DELETE FROM public.booking_requests');
});

test('anonymous callers can neither read nor write either table', async () => {
  await service.from('booking_pages').insert({ restaurant_id: T.A.restaurant, code: 'abcd1234ef' });
  await service.from('booking_requests').insert(request(T.A.restaurant));
  const anon = await cloud.as('anon', null, async () => {
    const out = {};
    for (const sql of [
      'SELECT * FROM public.booking_pages', 'SELECT * FROM public.booking_requests',
      `INSERT INTO public.booking_requests (restaurant_id, guest_name, phone, party_size, requested_for) VALUES ('${T.A.restaurant}', 'x', '1', 1, now())`,
      `INSERT INTO public.booking_pages (restaurant_id, code) VALUES ('${T.B.restaurant}', 'qqqqqqqqqq')`,
      'DELETE FROM public.booking_requests', 'UPDATE public.booking_pages SET enabled = false'
    ]) {
      try { await cloud.pg.query(sql); out[sql] = 'allowed'; } catch (e) { out[sql] = e.code; }
    }
    return out;
  });
  for (const [sql, outcome] of Object.entries(anon)) assert.equal(outcome, PERMISSION_DENIED, sql);
});

test('a restaurant\'s hub sees only its own page and requests', async () => {
  await service.from('booking_pages').insert({ restaurant_id: T.B.restaurant, code: 'bbbb1234ef' });
  await service.from('booking_requests').insert(request(T.B.restaurant, { guest_name: 'Theirs' }));
  const mine = await hubA.from('booking_requests').select('guest_name');
  assert.deepEqual(mine.data.map(r => r.guest_name), ['Asha'], 'not the other restaurant\'s guest');
  assert.deepEqual((await hubA.from('booking_pages').select('code')).data.map(r => r.code), ['abcd1234ef']);
  assert.deepEqual((await hubB.from('booking_requests').select('guest_name')).data.map(r => r.guest_name), ['Theirs']);
});

test('the hub clears its own inbox and no one else\'s, and cannot put a request in it', async () => {
  assert.ok(refusedBy(await hubA.from('booking_requests').insert(request(T.A.restaurant, { guest_name: 'Forged' }))) === PERMISSION_DENIED, 'only the operator service writes a guest\'s request');
  const wrong = await hubA.from('booking_requests').delete().eq('restaurant_id', T.B.restaurant);
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_requests WHERE restaurant_id = $1`, [T.B.restaurant])).rows[0].n, 1, `their request is still there (${JSON.stringify(wrong.error)})`);
  const own = await hubA.from('booking_requests').delete().eq('restaurant_id', T.A.restaurant);
  assert.equal(own.error, null);
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_requests WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n, 0);
  assert.equal(refusedBy(await hubA.from('booking_requests').update({ guest_name: 'Edited' }).eq('restaurant_id', T.B.restaurant)), PERMISSION_DENIED, 'a request is read and cleared, never edited');
});

test('the hub turns its own page on and off and gives it a new address, and cannot touch another restaurant\'s', async () => {
  const off = await hubA.from('booking_pages').update({ enabled: false }).eq('restaurant_id', T.A.restaurant).select('enabled');
  assert.deepEqual(off.data, [{ enabled: false }]);
  const rotated = await hubA.from('booking_pages').update({ code: 'newcode12345' }).eq('restaurant_id', T.A.restaurant).select('code');
  assert.deepEqual(rotated.data, [{ code: 'newcode12345' }]);
  const theirs = await hubA.from('booking_pages').update({ enabled: false }).eq('restaurant_id', T.B.restaurant).select('enabled');
  assert.deepEqual(theirs.data, [], 'RLS hides it, so nothing is changed');
  assert.equal((await cloud.pg.query(`SELECT enabled FROM public.booking_pages WHERE restaurant_id = $1`, [T.B.restaurant])).rows[0].enabled, true);

  // To a restaurant with no page of its own, so that it is the policy refusing it and not a duplicate key.
  const THIRD = 'c0c0c0c0-0000-4000-8000-000000000003';
  await cloud.pg.query(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ($1, 'Restaurant C', 'restaurant-c', 'Nagpur', 'PC-C')`, [THIRD]);
  // No RETURNING: with one, the row-level policy for reading would refuse the moved row too, and hide whether the update's own check does.
  const moved = await hubA.from('booking_pages').update({ restaurant_id: THIRD }).eq('restaurant_id', T.A.restaurant);
  assert.equal(refusedBy(moved), PERMISSION_DENIED, 'a page cannot be handed to another restaurant');
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_pages WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n, 1);
  await cloud.pg.query('DELETE FROM public.restaurants WHERE id = $1', [THIRD]);

  await cloud.pg.query(`DELETE FROM public.booking_pages WHERE restaurant_id IN ($1, $2)`, [T.A.restaurant, T.B.restaurant]);
  const forged = await hubA.from('booking_pages').insert({ restaurant_id: T.B.restaurant, code: 'forged12345' });
  assert.equal(refusedBy(forged), PERMISSION_DENIED, 'not a page for someone else');
  assert.equal((await cloud.pg.query('SELECT count(*)::int AS n FROM public.booking_pages')).rows[0].n, 0);
  const own = await hubA.from('booking_pages').insert({ restaurant_id: T.A.restaurant, code: 'hubmade1234' });
  assert.equal(own.error, null, JSON.stringify(own.error));
  await cloud.pg.query(`INSERT INTO public.booking_pages (restaurant_id, code) VALUES ($1, 'bbbb1234ef')`, [T.B.restaurant]);
});

test('an owner can look at the requests and the page and change nothing', async () => {
  await service.from('booking_requests').insert(request(T.A.restaurant, { guest_name: 'Visible' }));
  assert.deepEqual((await ownerA.from('booking_requests').select('guest_name')).data.map(r => r.guest_name), ['Visible']);
  assert.equal((await ownerA.from('booking_pages').select('code')).data.length, 1);
  assert.ok((await ownerA.from('booking_pages').update({ enabled: false }).eq('restaurant_id', T.A.restaurant).select('enabled')).data.length === 0, 'not allowed to turn it off');
  await ownerA.from('booking_requests').delete().eq('restaurant_id', T.A.restaurant);
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_requests WHERE restaurant_id = $1`, [T.A.restaurant])).rows[0].n, 1, 'and not allowed to delete one');

  await cloud.pg.query(`DELETE FROM public.booking_pages WHERE restaurant_id = $1`, [T.A.restaurant]);
  assert.equal(refusedBy(await ownerA.from('booking_pages').insert({ restaurant_id: T.A.restaurant, code: 'ownermade123' })), PERMISSION_DENIED, 'nor to switch a page on');
  await cloud.pg.query(`INSERT INTO public.booking_pages (restaurant_id, code) VALUES ($1, 'hubmade1234')`, [T.A.restaurant]);
});

test('the privileges are exactly these: nothing for anon, and for a tenant login only what the hub does', async () => {
  const can = async (role, table, privilege) => (await cloud.pg.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, privilege])).rows[0].ok;
  const held = async (role, table) => {
    const out = [];
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) if (await can(role, table, p)) out.push(p);
    return out;
  };
  for (const table of ['booking_pages', 'booking_requests']) assert.deepEqual(await held('anon', table), [], `anon on ${table}`);
  assert.deepEqual(await held('authenticated', 'booking_pages'), ['SELECT', 'INSERT', 'UPDATE'], 'the hub switches a page on and off, and never removes one');
  assert.deepEqual(await held('authenticated', 'booking_requests'), ['SELECT', 'DELETE'], 'the hub reads its inbox and clears it, and never writes or edits a request');
  assert.ok(await can('service_role', 'booking_requests', 'INSERT'), 'the operator service writes a guest\'s request');
});

test('removing a restaurant removes its page and its requests', async () => {
  await cloud.pg.query(`DELETE FROM public.staff_users WHERE restaurant_id = $1`, [T.B.restaurant]);
  await cloud.pg.query(`DELETE FROM public.restaurants WHERE id = $1`, [T.B.restaurant]);
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_requests WHERE restaurant_id = $1`, [T.B.restaurant])).rows[0].n, 0);
  assert.equal((await cloud.pg.query(`SELECT count(*)::int AS n FROM public.booking_pages WHERE restaurant_id = $1`, [T.B.restaurant])).rows[0].n, 0);
});

test('the migration is safe to run again', async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'migrations', '020_booking_requests.sql');
  await cloud.pg.exec(fs.readFileSync(file, 'utf8'));
  await cloud.pg.exec(fs.readFileSync(file, 'utf8'));
  assert.equal((await cloud.pg.query('SELECT count(*)::int AS n FROM public.booking_requests')).rows[0].n, 1, 'and it does not touch what is there');
});

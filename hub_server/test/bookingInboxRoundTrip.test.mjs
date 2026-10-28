import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReservationStore } from '../lib/reservationStore.js';
import { readPage, enablePage, disablePage, newAddress, pullInbox } from '../lib/bookingInbox.js';
import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';

// The hub's booking-page code against the REAL schema, signed in as the hub's own `kitchen` identity, so row-level security and the
// grants of migration 020 are in the way as they will be in production. bookingInbox.test.mjs proves the decisions with a stand-in;
// this proves the queries mean what the code thinks: the page is made on, the inbox is read and cleared by id, and neither reaches
// another restaurant.

const NOW = new Date(2026, 9, 23, 12, 0, 0);
const HOUR = 3600 * 1000;
const when = hours => new Date(NOW.getTime() + hours * HOUR).toISOString();

let cloud;
let T;
let hubA;
let service;
let dir;
let store;

before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  hubA = pgrestClient(cloud, T.A.user);
  service = pgrestServiceClient(cloud);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kullina-inbox-rt-'));
  store = new ReservationStore(path.join(dir, 'reservations.json'));
  store.ensureTenant(T.A.restaurant);
});
after(async () => {
  await store?.flush();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await cloud?.close();
});

const ask = (restaurant, over = {}) => service.from('booking_requests').insert({
  restaurant_id: restaurant, guest_name: 'Asha', phone: '919876543210', party_size: 4, requested_for: when(6), ...over
});
const inbox = async restaurant => (await cloud.pg.query('SELECT guest_name FROM public.booking_requests WHERE restaurant_id = $1 ORDER BY guest_name', [restaurant])).rows.map(r => r.guest_name);

test('real schema: the hub switches its page on, off, on, and gives it a new address, and the rows say so', async () => {
  assert.deepEqual(await readPage(hubA, T.A.restaurant), { ok: true, page: null });
  const on = await enablePage(hubA, T.A.restaurant);
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.deepEqual((await cloud.pg.query('SELECT code, enabled FROM public.booking_pages WHERE restaurant_id = $1', [T.A.restaurant])).rows, [{ code: on.page.code, enabled: true }]);

  assert.equal((await disablePage(hubA, T.A.restaurant)).page.enabled, false);
  assert.equal((await cloud.pg.query('SELECT enabled FROM public.booking_pages')).rows[0].enabled, false);
  assert.equal((await enablePage(hubA, T.A.restaurant)).page.code, on.page.code, 'the same address when it comes back');

  const moved = await newAddress(hubA, T.A.restaurant);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.notEqual(moved.page.code, on.page.code);
  assert.match(moved.page.code, /^[a-z0-9]{12}$/, 'a code the database\'s own check accepts');
  assert.equal((await cloud.pg.query('SELECT code FROM public.booking_pages')).rows[0].code, moved.page.code);
});

test('real schema: the hub cannot read or change another restaurant\'s page', async () => {
  await cloud.pg.query(`INSERT INTO public.booking_pages (restaurant_id, code) VALUES ($1, 'theirpage123')`, [T.B.restaurant]);
  assert.deepEqual(await readPage(hubA, T.B.restaurant), { ok: true, page: null }, 'it is simply not there, as far as this hub can see');
  await disablePage(hubA, T.B.restaurant);
  assert.equal((await cloud.pg.query('SELECT enabled FROM public.booking_pages WHERE restaurant_id = $1', [T.B.restaurant])).rows[0].enabled, true);
});

test('real schema: the inbox is read, kept until answered, then cleared by id, and only this restaurant\'s', async () => {
  await ask(T.A.restaurant, { guest_name: 'Asha' });
  await ask(T.A.restaurant, { guest_name: 'Bina' });
  await ask(T.A.restaurant, { guest_name: 'Chitra' });
  await ask(T.B.restaurant, { guest_name: 'Theirs' });

  const first = await pullInbox(hubA, T.A.restaurant, store, { now: NOW });
  assert.deepEqual([first.ok, first.received, first.cleared], [true, 3, 0]);
  assert.deepEqual(store.pendingRequests(T.A.restaurant, { now: NOW }).map(r => r.guest_name), ['Asha', 'Bina', 'Chitra']);
  assert.deepEqual(await inbox(T.A.restaurant), ['Asha', 'Bina', 'Chitra'], 'still there until someone answers');

  const [asha, bina] = store.pendingRequests(T.A.restaurant, { now: NOW });
  store.declineRequest(T.A.restaurant, asha.id, { now: NOW });
  assert.equal(store.acceptRequest(T.A.restaurant, bina.id, { now: NOW, tables: [{ id: 1, name: 'T1', capacity: 4 }], seatedWalkIns: 0 }).ok, true);

  const second = await pullInbox(hubA, T.A.restaurant, store, { now: NOW });
  assert.deepEqual([second.received, second.cleared], [0, 2]);
  assert.deepEqual(await inbox(T.A.restaurant), ['Chitra']);
  assert.deepEqual(await inbox(T.B.restaurant), ['Theirs'], 'another restaurant\'s inbox was never ours to touch');

  const third = await pullInbox(hubA, T.A.restaurant, store, { now: NOW });
  assert.deepEqual([third.received, third.cleared], [0, 0]);
});

test('real schema: a hub that is signed out of the cloud gets a plain answer, and the diary is untouched', async () => {
  const stranger = pgrestClient(cloud, '00000000-0000-4000-8000-0000000000ff');
  const before = store.stateFor(T.A.restaurant).revision;
  const r = await pullInbox(stranger, T.A.restaurant, store, { now: NOW });
  assert.equal(r.ok, true, 'a login with no restaurant sees an empty inbox, not an error');
  assert.equal(r.received, 0);
  assert.equal(store.stateFor(T.A.restaurant).revision, before);
});

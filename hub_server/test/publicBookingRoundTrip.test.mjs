import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { BOOKING_LIMITS } from '../../signup_server/lib/bookingPage.js';
import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestServiceClient } from './helpers/pgrest.mjs';

// The public booking page against the REAL schema. publicBooking.test.mjs proves the service's decisions against an in-memory
// stand-in; this proves that what it writes is accepted by the database (migration 020: the columns, the constraints, the privileges
// the service role holds) and that the queries it relies on, a count, a delete of lapsed rows and a lookup by code, mean what it
// thinks they mean.

const NOW = Date.parse('2026-10-23T10:00:00Z');
const HOUR = 3600 * 1000;
const at = hours => new Date(NOW + hours * HOUR).toISOString();
const CODE = 'pagecode12';

let cloud;
let T;
let app;
let base;

before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  const service = pgrestServiceClient(cloud);
  const server = http.createServer(createApp({ cloud: { from: service.from, auth: {} }, razorpay: { configured: () => false }, env: {}, operatorToken: 'op', webhookSecret: 'w', now: () => NOW, trustProxy: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  app = { stop: () => new Promise(resolve => server.close(resolve)) };
  await cloud.pg.query(`INSERT INTO public.booking_pages (restaurant_id, code) VALUES ($1, $2), ($3, 'otherpage12')`, [T.A.restaurant, CODE, T.B.restaurant]);
});
after(async () => { await app?.stop(); await cloud?.close(); });

let nextIp = 1;
const ask = (body, code = CODE) => fetch(`${base}/public/booking/${code}/requests`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${nextIp++ % 250}` }, body: JSON.stringify(body)
});
const q = async (sql, params = []) => (await cloud.pg.query(sql, params)).rows;
const good = (over = {}) => ({ guest_name: 'Asha Rao', phone: '98765 43210', party_size: 4, at: at(5), note: 'Window, if possible', ...over });

test('real schema: the page is found by its code and tells only the restaurant\'s name and city', async () => {
  const r = await fetch(`${base}/public/booking/${CODE}`);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).restaurant, { name: 'Restaurant A', city: 'Nagpur' });
  await cloud.pg.query('UPDATE public.booking_pages SET enabled = false WHERE restaurant_id = $1', [T.A.restaurant]);
  assert.equal((await fetch(`${base}/public/booking/${CODE}`)).status, 404, 'switched off');
  await cloud.pg.query('UPDATE public.booking_pages SET enabled = true WHERE restaurant_id = $1', [T.A.restaurant]);
});

test('real schema: a request lands in the inbox of the restaurant whose page it came to, in the shape the database holds', async () => {
  const r = await ask({ ...good(), restaurant_id: T.B.restaurant });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const rows = await q('SELECT * FROM public.booking_requests');
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row.restaurant_id, row.guest_name, row.phone, row.party_size, row.note], [T.A.restaurant, 'Asha Rao', '919876543210', 4, 'Window, if possible']);
  assert.equal(new Date(row.requested_for).toISOString(), at(5));
  assert.ok(row.id && row.created_at, 'the database gave it an id and a time');
});

test('real schema: only this restaurant\'s lapsed requests are cleared, and the inbox cap counts only its own', async () => {
  await cloud.pg.query('DELETE FROM public.booking_requests');
  const ins = (restaurant, name, when) => cloud.pg.query(
    `INSERT INTO public.booking_requests (restaurant_id, guest_name, phone, party_size, requested_for) VALUES ($1, $2, '9199', 2, $3)`, [restaurant, name, when]);
  await ins(T.A.restaurant, 'Lapsed', at(-48));
  await ins(T.A.restaurant, 'Tonight', at(3));
  await ins(T.A.restaurant, 'Earlier today', at(-2));
  await ins(T.B.restaurant, 'Theirs, lapsed', at(-72));
  assert.equal((await ask(good({ phone: '98765 40001' }))).status, 201);
  const names = (await q('SELECT guest_name FROM public.booking_requests ORDER BY guest_name')).map(r => r.guest_name);
  assert.deepEqual(names, ['Asha Rao', 'Earlier today', 'Theirs, lapsed', 'Tonight']);

  await cloud.pg.query('DELETE FROM public.booking_requests');
  for (let i = 0; i < BOOKING_LIMITS.pendingCap; i += 1) await ins(T.A.restaurant, `Waiting ${i}`, at(10 + i));
  const full = await ask(good({ phone: '98765 40002' }));
  assert.deepEqual([full.status, (await full.json()).code], [503, 'NOT_TAKING_REQUESTS']);
  assert.equal((await ask(good({ phone: '98765 40003' }), 'otherpage12')).status, 201, 'another restaurant\'s inbox is empty');
});

test('real schema: what the database would refuse is never sent to it: a party of 41, a blank name', async () => {
  await cloud.pg.query('DELETE FROM public.booking_requests');
  for (const bad of [{ party_size: 41 }, { guest_name: '' }, { phone: '12' }]) assert.equal((await ask(good(bad))).status, 400, JSON.stringify(bad));
  assert.equal((await q('SELECT count(*)::int AS n FROM public.booking_requests'))[0].n, 0);
});

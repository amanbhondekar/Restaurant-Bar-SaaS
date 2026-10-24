import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestServiceClient } from './helpers/pgrest.mjs';

// The operator service against the REAL schema. subscriptionService.test.mjs proves the service's decisions against an
// in-memory stand-in; this proves its writes are ones the database accepts: the columns exist (migration 018), the unique index
// that recognises a redelivered event is really there, the foreign key does what the code assumes, and the service role holds the
// privileges it needs, because a stand-in cannot be wrong about any of that and the real thing can.

const SECRET = 'whsec_roundtrip';
const sign = raw => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const ENV = { RAZORPAY_PLAN_PRO: 'plan_pro_1', RAZORPAY_PLAN_ENTERPRISE: 'plan_ent_1' };

let cloud;
let T;
let app;
let base;
let created = 0;
const razorpayCalls = [];

before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  const tokens = { 'tok-a': T.A.user, 'tok-b': T.B.user };
  const service = pgrestServiceClient(cloud);
  const operatorCloud = {
    from: service.from,
    auth: { getUser: async token => (tokens[token] ? { data: { user: { id: tokens[token] } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }) }
  };
  const razorpay = {
    configured: () => true,
    createSubscription: async payload => { razorpayCalls.push(['create', payload]); created += 1; return { ok: true, data: { id: `sub_RT${created}`, status: 'created', short_url: `https://rzp.io/i/rt${created}` } }; },
    cancelSubscription: async (id, opts) => { razorpayCalls.push(['cancel', id, opts]); return { ok: true, data: { id } }; },
    changePlan: async (id, opts) => { razorpayCalls.push(['change', id, opts]); return { ok: true, data: { id } }; },
    fetchSubscription: async () => ({ ok: false, code: 'UNUSED' })
  };
  const server = http.createServer(createApp({ cloud: operatorCloud, razorpay, env: ENV, operatorToken: 'op', webhookSecret: SECRET, minGapMs: 0 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  app = { stop: () => new Promise(resolve => server.close(resolve)) };
});
after(async () => { await app?.stop(); await cloud?.close(); });

const ask = (method, path, token, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
});
const webhook = (event, entity = {}, { id = 'evt_x', at = 1793000000 } = {}) => {
  const raw = JSON.stringify({
    event, created_at: at,
    payload: { subscription: { entity: { id: 'sub_RT1', plan_id: 'plan_pro_1', current_start: 1792000000, current_end: 1795000000, notes: { restaurant_id: T.A.restaurant, plan: 'pro' }, ...entity } } }
  });
  return fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(raw), 'X-Razorpay-Event-Id': id }, body: raw });
};
const q = async (sql, params = []) => (await cloud.pg.query(sql, params)).rows;
const restaurant = async id => (await q('SELECT plan, plan_status, current_period_end FROM public.restaurants WHERE id = $1', [id]))[0];
const subscription = async id => (await q('SELECT * FROM public.subscriptions WHERE razorpay_subscription_id = $1', [id]))[0];

test('real schema: a restaurant\'s hub starts a subscription, and the row the database holds is the one the service meant', async () => {
  const res = await ask('POST', '/subscriptions', 'tok-a', { plan: 'pro' });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.deepEqual([body.recorded, body.subscription.short_url], [true, 'https://rzp.io/i/rt1']);

  const row = await subscription('sub_RT1');
  assert.deepEqual([row.restaurant_id, row.razorpay_plan_id, row.plan, row.status, row.short_url], [T.A.restaurant, 'plan_pro_1', 'pro', 'created', 'https://rzp.io/i/rt1']);
  assert.equal(row.cancel_requested_at, null);
  assert.equal((await q('SELECT count(*)::int AS n FROM public.subscription_events'))[0].n, 0, 'nothing is logged or applied until Razorpay says something happened');
  assert.equal(razorpayCalls[0][1].notes.restaurant_id, T.A.restaurant);
});

test('real schema: the other restaurant sees none of it, and the same plan asked for again returns the open page', async () => {
  const current = await (await ask('GET', '/subscriptions/current', 'tok-b')).json();
  assert.equal(current.subscription, null);
  const again = await (await ask('POST', '/subscriptions', 'tok-a', { plan: 'pro' })).json();
  assert.deepEqual([again.reused, again.subscription.id], [true, 'sub_RT1']);
  assert.equal(created, 1, 'one subscription at Razorpay, not two');
});

test('real schema: the first payment puts the restaurant on the plan, records the subscription and logs the event', async () => {
  const r = await webhook('subscription.activated', {}, { id: 'evt_activated' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  const after = await restaurant(T.A.restaurant);
  assert.deepEqual([after.plan, after.plan_status], ['pro', 'active']);
  assert.equal(new Date(after.current_period_end).toISOString(), new Date(1795000000 * 1000).toISOString());

  const row = await subscription('sub_RT1');
  assert.deepEqual([row.status, row.plan, row.razorpay_plan_id], ['active', 'pro', 'plan_pro_1']);
  assert.equal(new Date(row.current_end).toISOString(), new Date(1795000000 * 1000).toISOString());
  assert.equal(new Date(row.last_event_at).toISOString(), new Date(1793000000 * 1000).toISOString());
  assert.equal(row.short_url, 'https://rzp.io/i/rt1', 'what was recorded at creation survives the update: an upsert only touches the columns it names');

  const events = await q('SELECT event, applied_plan_status, razorpay_event_id, payload FROM public.subscription_events WHERE razorpay_event_id = $1', ['evt_activated']);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].event, events[0].applied_plan_status], ['subscription.activated', 'active']);
  assert.equal(events[0].payload.event, 'subscription.activated');
});

test('real schema: the same event delivered again is recognised by the unique index and logged once', async () => {
  const again = await webhook('subscription.activated', {}, { id: 'evt_activated' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  assert.equal((await q('SELECT count(*)::int AS n FROM public.subscription_events WHERE razorpay_event_id = $1', ['evt_activated']))[0].n, 1);
});

test('real schema: events with no id do not collide with each other', async () => {
  for (let i = 0; i < 2; i++) {
    const raw = JSON.stringify({ event: 'subscription.charged', created_at: 1793000100 + i, payload: { subscription: { entity: { id: 'sub_RT1', plan_id: 'plan_pro_1', notes: { restaurant_id: T.A.restaurant } } } } });
    const r = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'X-Razorpay-Signature': sign(raw) }, body: raw });
    assert.equal(r.status, 200);
  }
  assert.equal((await q('SELECT count(*)::int AS n FROM public.subscription_events WHERE razorpay_event_id IS NULL'))[0].n, 2);
});

test('real schema: older news does not put a paid restaurant back to past_due', async () => {
  const stale = await webhook('subscription.halted', {}, { id: 'evt_old', at: 1790000000 });
  assert.equal((await stale.json()).reason, 'STALE');
  assert.equal((await restaurant(T.A.restaurant)).plan_status, 'active');
  const logged = (await q('SELECT applied_plan_status FROM public.subscription_events WHERE razorpay_event_id = $1', ['evt_old']))[0];
  assert.equal(logged.applied_plan_status, null);
});

test('real schema: a change of plan is scheduled, then takes effect on the first charge at the new plan', async () => {
  const asked = await ask('POST', '/subscriptions/change-plan', 'tok-a', { plan: 'enterprise' });
  assert.equal(asked.status, 200, JSON.stringify(await asked.clone().json()));
  assert.deepEqual(razorpayCalls.at(-1), ['change', 'sub_RT1', { planId: 'plan_ent_1', atCycleEnd: true }]);
  let row = await subscription('sub_RT1');
  assert.deepEqual([row.plan, row.plan_change_to], ['pro', 'enterprise']);
  assert.equal((await restaurant(T.A.restaurant)).plan, 'pro', 'still what was paid for');

  const charged = await webhook('subscription.charged', { plan_id: 'plan_ent_1' }, { id: 'evt_ent', at: 1794000000 });
  assert.equal(charged.status, 200);
  row = await subscription('sub_RT1');
  assert.deepEqual([row.plan, row.plan_change_to], ['enterprise', null]);
  assert.equal((await restaurant(T.A.restaurant)).plan, 'enterprise');
});

test('real schema: cancelling is recorded, the plan runs on, and the end of the period is what degrades it', async () => {
  const asked = await ask('POST', '/subscriptions/cancel', 'tok-a');
  assert.equal(asked.status, 200);
  assert.deepEqual(razorpayCalls.at(-1), ['cancel', 'sub_RT1', { atCycleEnd: true }]);
  assert.ok((await subscription('sub_RT1')).cancel_requested_at);
  assert.deepEqual((await restaurant(T.A.restaurant)).plan_status, 'active', 'nothing changes the day it is asked for');

  assert.equal((await webhook('subscription.cancelled', { plan_id: 'plan_ent_1' }, { id: 'evt_end', at: 1795000100 })).status, 200);
  const r = await restaurant(T.A.restaurant);
  assert.deepEqual([r.plan, r.plan_status], ['enterprise', 'cancelled'], 'the status is what degrades it; the plan is left as it was');
  assert.equal((await subscription('sub_RT1')).status, 'cancelled');
});

test('real schema: once it has ended a new subscription can be started, and it is the newest that counts', async () => {
  const res = await ask('POST', '/subscriptions', 'tok-a', { plan: 'enterprise' });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const current = await (await ask('GET', '/subscriptions/current', 'tok-a')).json();
  assert.equal(current.subscription.id, 'sub_RT2');
  assert.equal(current.subscription.plan, 'enterprise');
});

test('real schema: an event for a restaurant that does not exist is acknowledged, not retried for ever', async () => {
  const raw = JSON.stringify({ event: 'subscription.charged', created_at: 1796000000, payload: { subscription: { entity: { id: 'sub_GHOST', notes: { restaurant_id: 'c0c0c0c0-0000-4000-8000-000000000009' } } } } });
  const r = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { 'X-Razorpay-Signature': sign(raw) }, body: raw });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).reason, 'UNKNOWN_TENANT');
  assert.equal((await q('SELECT count(*)::int AS n FROM public.subscriptions WHERE razorpay_subscription_id = $1', ['sub_GHOST']))[0].n, 0);
});

test('real schema: a login that is not staff anywhere cannot use any of it', async () => {
  for (const [method, path, body] of [['GET', '/subscriptions/current'], ['POST', '/subscriptions', { plan: 'pro' }], ['POST', '/subscriptions/cancel'], ['POST', '/subscriptions/change-plan', { plan: 'pro' }]]) {
    assert.equal((await ask(method, path, 'tok-nobody', body)).status, 401, path);
  }
});

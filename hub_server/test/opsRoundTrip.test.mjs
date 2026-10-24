import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { buildReport, sendReport } from '../lib/heartbeat.js';
import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';

// The operator console's queries against the REAL schema, as the service role the operator service holds: so the views, the grants of
// migration 021 and every column the routes name are in the way as they will be in production. opsRoutes.test.mjs proves the decisions
// with a stand-in; this proves the queries mean what the code thinks, and that what the routes return is what a hub and a webhook put there.

const TOKEN = 'round-trip-token-value-123';
const NOW = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let cloud;
let T;
let app;
let base;
let server;

before(async () => {
  cloud = await cloudDb();
  await cloud.pg.query(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  app = createApp({ cloud: pgrestServiceClient(cloud), razorpay: { configured: () => false }, env: {}, operatorToken: 'op', webhookSecret: 'w', opsToken: TOKEN, now: () => NOW });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server?.close(resolve));
  await cloud?.close();
});

const get = async p => { const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } }); return { status: r.status, body: await r.json() }; };

test('a restaurant that has just signed up is in the fleet, with no hub and no subscription, and is not yet anything to worry about', async () => {
  const { status, body } = await get('/ops/api/fleet');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.tenants.map(t => t.name).sort(), ['Restaurant A', 'Restaurant B']);
  const a = body.tenants.find(t => t.id === T.A.restaurant);
  assert.deepEqual([a.plan, a.plan_status, a.hub.state, a.subscription, a.activity.invoices_7d], ['starter', 'active', 'never', null, 0]);
  assert.deepEqual(body.summary.hubs, { live: 0, quiet: 0, silent: 0, never: 2 });
  assert.equal(body.truncated, false);
});

test('what a hub reports, what a webhook did and what a till printed all arrive on the restaurant\'s row', async () => {
  const hubA = pgrestClient(cloud, T.A.user);
  const sent = await sendReport(hubA, T.A.restaurant, buildReport({ now: new Date(NOW - 60 * 1000), startedAt: new Date(NOW - 5 * HOUR), version: '1.0.0', sync: { queued: 60, quarantined: 2, last_synced_at: new Date(NOW - 10 * 60 * 1000) }, devices: 3, waiters: 6 }));
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await cloud.pg.query(`UPDATE public.restaurants SET plan = 'pro', plan_status = 'past_due', phone = '9822012345' WHERE id = $1`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan, current_end, created_at, short_url) VALUES ($1, 'sub_1', 'halted', 'pro', now() + interval '3 days', now() - interval '40 days', 'https://rzp.io/pay-me-secretly')`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan, created_at) VALUES ($1, 'sub_0', 'cancelled', 'starter', now() - interval '90 days')`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, applied_plan_status, payload, received_at) VALUES ($1, 'sub_1', 'subscription.halted', 'past_due', '{"customer":"someone@example.test"}', now() - interval '2 hours')`, [T.A.restaurant]);
  await cloud.pg.query(`INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, applied_plan_status, received_at) VALUES ($1, 'sub_1', 'subscription.charged', 'active', now() - interval '31 days')`, [T.A.restaurant]);
  for (const [ref, issued] of [['b1', "now() - interval '1 day'"], ['b2', "now() - interval '3 days'"], ['b3', "now() - interval '30 days'"]]) {
    await cloud.pg.query(`INSERT INTO public.invoices (restaurant_id, hub_ref, invoice_number, issued_at) VALUES ($1, '${ref}', '${ref}', ${issued})`, [T.A.restaurant]);
  }

  const { status, body } = await get('/ops/api/fleet');
  assert.equal(status, 200, JSON.stringify(body));
  const a = body.tenants.find(t => t.id === T.A.restaurant);
  assert.equal(body.tenants[0].id, T.A.restaurant, 'the restaurant that needs looking at is first');
  assert.deepEqual([a.plan, a.plan_status, a.phone, a.severity], ['pro', 'past_due', '9822012345', 'high']);
  assert.deepEqual([a.subscription.status, a.subscription.plan], ['halted', 'pro'], 'the newest subscription');
  assert.deepEqual([a.hub.state, a.hub.version, a.hub.queued, a.hub.quarantined, a.hub.devices, a.hub.waiters], ['live', '1.0.0', 60, 2, 3, 6]);
  assert.deepEqual(a.attention.map(x => x.code), ['past_due', 'shelved', 'sync_backlog']);
  assert.equal(a.activity.invoices_7d, 2);
  assert.ok(a.activity.last_invoice_at);
  assert.deepEqual(body.summary.attention, { high: 1, medium: 0 });
  assert.deepEqual(body.summary.hubs, { live: 1, quiet: 0, silent: 0, never: 1 });
  assert.deepEqual(body.events.map(e => [e.event, e.restaurant_name]), [['subscription.halted', 'Restaurant A'], ['subscription.charged', 'Restaurant A']], 'newest first');
  assert.doesNotMatch(JSON.stringify(body), /pay-me-secretly|someone@example|PC-A|hub_provisioning/);
});

test('one restaurant: its subscriptions, newest first, and its events, from the real tables', async () => {
  const { status, body } = await get(`/ops/api/tenants/${T.A.restaurant}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.tenant.name, 'Restaurant A');
  assert.deepEqual(body.subscriptions.map(s => [s.razorpay_subscription_id, s.status]), [['sub_1', 'halted'], ['sub_0', 'cancelled']]);
  assert.deepEqual(Object.keys(body.subscriptions[0]).sort(), ['cancel_requested_at', 'created_at', 'current_end', 'current_start', 'last_event_at', 'plan', 'plan_change_to', 'razorpay_subscription_id', 'status']);
  assert.equal(body.events.length, 2);
  assert.doesNotMatch(JSON.stringify(body), /pay-me-secretly|someone@example/);

  const none = await get(`/ops/api/tenants/${T.B.restaurant}`);
  assert.deepEqual([none.body.subscriptions, none.body.events], [[], []], 'another restaurant has none of A\'s');
  assert.equal((await get('/ops/api/tenants/00000000-0000-4000-8000-00000000dead')).status, 404);
});

test('a tenant\'s own login cannot reach the console\'s data through the database either', async () => {
  const hubA = pgrestClient(cloud, T.A.user);
  assert.equal((await hubA.from('ops_tenants').select('*')).error.code, '42501');
  assert.equal((await hubA.from('ops_events').select('*')).error.code, '42501');
});

test('the console cannot write through the database either', async () => {
  // Refused, either for want of a privilege (migration 021) or because a view that joins tables cannot be written to at all; the
  // privileges themselves are pinned in opsSchema.test.mjs. Here what matters is that it is refused and nothing changed.
  const service = pgrestServiceClient(cloud);
  for (const view of ['ops_tenants', 'ops_events']) {
    assert.ok((await service.from(view).delete().eq('restaurant_id', T.A.restaurant)).error, `delete from ${view}`);
    assert.ok((await service.from(view).update({ restaurant_id: T.B.restaurant }).eq('restaurant_id', T.A.restaurant)).error, `update ${view}`);
  }
  assert.equal((await get('/ops/api/fleet')).body.tenants.length, 2);
});

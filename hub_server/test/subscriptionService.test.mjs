import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';

// Creating and managing a restaurant's subscription through the operator service (§4.4), and the webhooks that keep it honest.
//
// What matters most is who may do what. A restaurant's own hub (or its owner) may ask for ITS subscription and nobody else's; the
// restaurant is taken from the cloud session, never from the request body; no money moves without the owner authorising it at
// Razorpay; and a webhook can be neither forged, nor replayed over newer news, nor lost.

const WEBHOOK_SECRET = 'whsec_value';
const sign = (data, secret = WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const ENV = { RAZORPAY_PLAN_PRO: 'plan_pro_1', RAZORPAY_PLAN_ENTERPRISE: 'plan_ent_1' };
const NOW = Date.parse('2026-10-23T10:00:00Z');

const USERS = {
  'tok-owner': { id: 'u-owner' }, 'tok-hub': { id: 'u-hub' }, 'tok-manager': { id: 'u-manager' }, 'tok-waiter': { id: 'u-waiter' },
  'tok-nobody': { id: 'u-nobody' }, 'tok-other': { id: 'u-other' }
};
const STAFF = [
  { user_id: 'u-owner', restaurant_id: 'r-uuid', role: 'owner' },
  { user_id: 'u-hub', restaurant_id: 'r-uuid', role: 'kitchen' },
  { user_id: 'u-manager', restaurant_id: 'r-uuid', role: 'manager' },
  { user_id: 'u-waiter', restaurant_id: 'r-uuid', role: 'waiter' },
  { user_id: 'u-other', restaurant_id: 'r-other', role: 'owner' }
];
const as = token => ({ Authorization: `Bearer ${token}` });

function fakeRazorpay(over = {}) {
  const calls = [];
  const step = (name, fallback) => async (...args) => {
    calls.push({ name, args });
    const r = over[name];
    return typeof r === 'function' ? r(...args) : (r ?? fallback);
  };
  return {
    calls,
    configured: () => over.configured !== false,
    createSubscription: step('createSubscription', { ok: true, data: { id: 'sub_NEW', status: 'created', short_url: 'https://rzp.io/i/new' } }),
    cancelSubscription: step('cancelSubscription', { ok: true, data: { id: 'sub_1', status: 'active' } }),
    changePlan: step('changePlan', { ok: true, data: { id: 'sub_1', status: 'active' } }),
    fetchSubscription: step('fetchSubscription', { ok: true, data: { id: 'sub_1', status: 'active' } })
  };
}

async function serve({ cloud = memoryCloud({ users: USERS, staff: STAFF }), razorpay = fakeRazorpay(), ...rest } = {}) {
  const server = http.createServer(createApp({ cloud, razorpay, env: ENV, operatorToken: 'op', webhookSecret: WEBHOOK_SECRET, now: () => NOW, minGapMs: 5000, ...rest }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  return { cloud, razorpay, base, stop: () => new Promise(resolve => server.close(resolve)), get: (p, h) => send('GET', p, undefined, h), call: (method, p, body, h) => (method === 'get' ? send('GET', p, undefined, h) : send('POST', p, body ?? {}, h)), post: (p, b, h) => send('POST', p, b ?? {}, h) };
}
const sub = (over = {}) => ({
  restaurant_id: 'r-uuid', razorpay_subscription_id: 'sub_1', razorpay_plan_id: 'plan_pro_1', plan: 'pro', status: 'active',
  short_url: null, current_end: '2026-11-23T00:00:00.000Z', cancel_requested_at: null, plan_change_to: null, created_at: '2026-10-01T00:00:00Z', ...over
});
const json = r => r.json();

// --- who may ask --------------------------------------------------------------------------------------------------------

test('every subscription route refuses a caller with no cloud session, a session the cloud does not know, or no restaurant', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }) });
  try {
    const routes = [['get', '/subscriptions/current'], ['post', '/subscriptions', { plan: 'pro' }], ['post', '/subscriptions/cancel'], ['post', '/subscriptions/change-plan', { plan: 'enterprise' }]];
    for (const [method, path, body] of routes) {
      const none = await app.call(method, path, body, {});
      assert.deepEqual([none.status, (await json(none)).code], [401, 'NOT_SIGNED_IN'], `${path} with no token`);
      const bad = await app.call(method, path, body, as('forged'));
      assert.deepEqual([bad.status, (await json(bad)).code], [401, 'NOT_SIGNED_IN'], `${path} with a token the cloud does not know`);
      const orphan = await app.call(method, path, body, as('tok-nobody'));
      assert.deepEqual([orphan.status, (await json(orphan)).code], [403, 'NO_RESTAURANT'], `${path} with a login that belongs to no restaurant`);
    }
    assert.deepEqual(app.razorpay.calls, [], 'Razorpay was never asked');
  } finally { await app.stop(); }
});

test('a waiter cannot start, change or cancel the restaurant\'s subscription; an owner, a manager and the hub itself can', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }) });
  try {
    for (const path of ['/subscriptions/current', '/subscriptions', '/subscriptions/cancel', '/subscriptions/change-plan']) {
      const waiter = await (path === '/subscriptions/current' ? app.get(path, as('tok-waiter')) : app.post(path, { plan: 'enterprise' }, as('tok-waiter')));
      assert.deepEqual([waiter.status, (await json(waiter)).code], [403, 'ROLE_NOT_ALLOWED'], path);
    }
    for (const token of ['tok-owner', 'tok-manager', 'tok-hub']) assert.equal((await app.get('/subscriptions/current', as(token))).status, 200, token);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('the restaurant is the one the session belongs to; a restaurant named in the body is ignored', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ restaurant_id: 'r-other', razorpay_subscription_id: 'sub_other', plan: 'enterprise' })] }) });
  try {
    const res = await app.post('/subscriptions', { plan: 'pro', restaurant_id: 'r-other' }, as('tok-owner'));
    assert.equal(res.status, 201, 'the other restaurant\'s live subscription is not this one\'s');
    assert.equal(app.razorpay.calls[0].args[0].notes.restaurant_id, 'r-uuid');
    assert.equal(app.cloud.calls.inserts[0].row.restaurant_id, 'r-uuid');
    const seen = await json(await app.get('/subscriptions/current', as('tok-owner')));
    assert.equal(seen.subscription.id, 'sub_NEW', 'and it reads only this restaurant\'s');
  } finally { await app.stop(); }
});

// --- starting one --------------------------------------------------------------------------------------------------------

test('subscribing asks Razorpay for the plan the environment names, records it, and hands back the page where the owner pays', async () => {
  const app = await serve();
  try {
    const res = await app.post('/subscriptions', { plan: 'pro' }, as('tok-hub'));
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.deepEqual([body.subscription.id, body.subscription.status, body.subscription.plan, body.subscription.short_url], ['sub_NEW', 'created', 'pro', 'https://rzp.io/i/new']);

    const [{ name, args: [payload] }] = app.razorpay.calls;
    assert.equal(name, 'createSubscription');
    assert.equal(payload.plan_id, 'plan_pro_1');
    assert.deepEqual(payload.notes, { restaurant_id: 'r-uuid', plan: 'pro' });

    const [{ row }] = app.cloud.calls.inserts;
    assert.deepEqual(
      [row.restaurant_id, row.razorpay_subscription_id, row.razorpay_plan_id, row.plan, row.status, row.short_url],
      ['r-uuid', 'sub_NEW', 'plan_pro_1', 'pro', 'created', 'https://rzp.io/i/new']
    );
    assert.equal(app.cloud.calls.updates.length, 0, 'nothing about the restaurant\'s plan changes until it is paid for');
  } finally { await app.stop(); }
});

test('only a paid plan can be subscribed to, and only one that is on offer', async () => {
  const app = await serve({ env: { RAZORPAY_PLAN_PRO: 'plan_pro_1' } });
  try {
    for (const body of [{ plan: 'starter' }, { plan: 'platinum' }, {}]) {
      const r = await app.post('/subscriptions', body, as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [400, 'INVALID_PLAN'], JSON.stringify(body));
    }
    const notOffered = await app.post('/subscriptions', { plan: 'enterprise' }, as('tok-owner'));
    assert.deepEqual([notOffered.status, (await json(notOffered)).code], [503, 'PLAN_NOT_OFFERED']);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('with no Razorpay keys it says so and asks nothing', async () => {
  const app = await serve({ razorpay: fakeRazorpay({ configured: false }) });
  try {
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED']);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('asking again for a plan whose payment page is already open gives the same page, not a second subscription', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status: 'created', short_url: 'https://rzp.io/i/open', current_end: null })] }) });
  try {
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.deepEqual([body.reused, body.subscription.short_url], [true, 'https://rzp.io/i/open']);
    assert.deepEqual(app.razorpay.calls, [], 'two subscriptions authorised would bill the restaurant twice');
    assert.equal(app.cloud.calls.inserts.length, 0);
  } finally { await app.stop(); }
});

test('a different plan while one is waiting to be paid, or any plan while one is live, is refused', async () => {
  const pending = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status: 'created', short_url: 'https://rzp.io/i/open' })] }) });
  try {
    const r = await pending.post('/subscriptions', { plan: 'enterprise' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).code], [409, 'PENDING_OTHER_PLAN']);
    assert.deepEqual(pending.razorpay.calls, []);
  } finally { await pending.stop(); }
  for (const status of ['authenticated', 'active', 'pending']) {
    const live = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status })] }) });
    try {
      const r = await live.post('/subscriptions', { plan: 'enterprise' }, as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [409, 'ALREADY_SUBSCRIBED'], status);
      assert.deepEqual(live.razorpay.calls, [], status);
    } finally { await live.stop(); }
  }
});

test('a subscription that has ended, or that Razorpay gave up on, can be replaced by a new one', async () => {
  for (const status of ['cancelled', 'completed', 'expired', 'halted']) {
    const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status })] }) });
    try {
      const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
      assert.equal(r.status, 201, status);
      assert.equal(app.razorpay.calls.length, 1, status);
    } finally { await app.stop(); }
  }
});

test('the latest subscription decides, not the oldest', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [
    sub({ razorpay_subscription_id: 'sub_old', status: 'active', created_at: '2026-01-01T00:00:00Z' }),
    sub({ razorpay_subscription_id: 'sub_new', status: 'cancelled', created_at: '2026-09-01T00:00:00Z' })
  ] }) });
  try {
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 201);
  } finally { await app.stop(); }
});

test('when Razorpay refuses, nothing is recorded and the owner is told why; the refusal is not retried at once', async () => {
  const app = await serve({ razorpay: fakeRazorpay({ createSubscription: { ok: false, code: 'RAZORPAY_REFUSED', status: 400, error: 'The plan id is invalid' } }) });
  try {
    const first = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.equal(first.status, 502);
    const body = await json(first);
    assert.deepEqual([body.code, body.error], ['RAZORPAY_REFUSED', 'The plan id is invalid']);
    assert.equal(app.cloud.calls.inserts.length, 0);

    const second = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.deepEqual([second.status, (await json(second)).code], [429, 'TOO_SOON'], 'a stuck button cannot hammer Razorpay');
    assert.equal(app.razorpay.calls.length, 1);
  } finally { await app.stop(); }
});

test('a restaurant waits a few seconds between attempts, and another restaurant is not held up by it', async () => {
  let clock = NOW;
  const app = await serve({ now: () => clock, razorpay: fakeRazorpay({ createSubscription: { ok: false, code: 'RAZORPAY_ERROR', status: 503, error: 'down' } }) });
  try {
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 502);
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 429);
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-other'))).status, 502, 'a different restaurant');
    clock += 6000;
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 502, 'after the wait it is allowed to try again');
  } finally { await app.stop(); }
});

test('if Razorpay made the subscription but it could not be recorded, the owner still gets the page, and the webhook will record it', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, failures: { insert: { subscriptions: { message: 'connection reset' } } } }) });
  try {
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.equal(r.status, 201);
    const body = await json(r);
    assert.deepEqual([body.recorded, body.subscription.short_url], [false, 'https://rzp.io/i/new']);
  } finally { await app.stop(); }
});

test('where the subscription stands is readable, with what is on offer, and only this restaurant\'s', async () => {
  const empty = await serve();
  try {
    const body = await json(await empty.get('/subscriptions/current', as('tok-owner')));
    assert.deepEqual([body.success, body.subscription, body.billing_configured, body.plans], [true, null, true, ['pro', 'enterprise']]);
  } finally { await empty.stop(); }

  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status: 'created', short_url: 'https://rzp.io/i/x' }), sub({ restaurant_id: 'r-other', razorpay_subscription_id: 'sub_other' })] }) });
  try {
    const body = await json(await app.get('/subscriptions/current', as('tok-owner')));
    assert.equal(body.subscription.id, 'sub_1');
    assert.equal(body.subscription.short_url, 'https://rzp.io/i/x');
    assert.doesNotMatch(JSON.stringify(body), /r-uuid|r-other|plan_pro_1/);
  } finally { await app.stop(); }
});

test('a lookup that fails is reported, not answered with "no subscription", which would invite a second one', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, failures: { select: { subscriptions: { message: 'timeout' } } } }) });
  try {
    for (const call of [() => app.get('/subscriptions/current', as('tok-owner')), () => app.post('/subscriptions', { plan: 'pro' }, as('tok-owner')), () => app.post('/subscriptions/cancel', {}, as('tok-owner'))]) {
      const r = await call();
      assert.deepEqual([r.status, (await json(r)).code], [502, 'LOOKUP_FAILED']);
    }
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

// --- cancelling ----------------------------------------------------------------------------------------------------------

test('cancelling asks Razorpay to end it at the end of the period, and records that it was asked', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }) });
  try {
    const r = await app.post('/subscriptions/cancel', {}, as('tok-owner'));
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.subscription.cancel_requested_at, new Date(NOW).toISOString());
    assert.deepEqual(app.razorpay.calls[0], { name: 'cancelSubscription', args: ['sub_1', { atCycleEnd: true }] });
    assert.equal(app.cloud.tables.subscriptions[0].cancel_requested_at, new Date(NOW).toISOString());
    assert.equal(app.cloud.tables.subscriptions[0].status, 'active', 'the status changes when Razorpay says so, at the end of the period');
    assert.equal(app.cloud.tables.restaurants[0].plan_status, undefined, 'the plan runs to the end of what was paid for');
  } finally { await app.stop(); }
});

test('cancelling twice cancels once', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ cancel_requested_at: '2026-10-20T00:00:00Z' })] }) });
  try {
    const r = await app.post('/subscriptions/cancel', {}, as('tok-owner'));
    assert.equal(r.status, 200);
    assert.equal((await json(r)).already, true);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('what cannot be cancelled says why: nothing to cancel, never paid for, already over', async () => {
  const cases = [
    [[], 404, 'NO_SUBSCRIPTION'],
    [[sub({ status: 'created', short_url: 'x' })], 409, 'NOTHING_TO_CANCEL'],
    [[sub({ status: 'cancelled' })], 409, 'NOT_ACTIVE'],
    [[sub({ status: 'halted' })], 409, 'NOT_ACTIVE']
  ];
  for (const [subscriptions, status, code] of cases) {
    const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions }) });
    try {
      const r = await app.post('/subscriptions/cancel', {}, as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [status, code]);
      assert.deepEqual(app.razorpay.calls, []);
    } finally { await app.stop(); }
  }
});

test('when Razorpay will not cancel it, it is not marked cancelled', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }), razorpay: fakeRazorpay({ cancelSubscription: { ok: false, code: 'RAZORPAY_REFUSED', error: 'No can do' } }) });
  try {
    const r = await app.post('/subscriptions/cancel', {}, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).error], [502, 'No can do']);
    assert.equal(app.cloud.tables.subscriptions[0].cancel_requested_at, null);
  } finally { await app.stop(); }
});

// --- changing plan ------------------------------------------------------------------------------------------------------

test('changing plan is scheduled for the end of the period, and recorded as pending until a charge at the new plan arrives', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }) });
  try {
    const r = await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'));
    assert.equal(r.status, 200);
    assert.equal((await json(r)).subscription.plan_change_to, 'enterprise');
    assert.deepEqual(app.razorpay.calls[0], { name: 'changePlan', args: ['sub_1', { planId: 'plan_ent_1', atCycleEnd: true }] });
    const row = app.cloud.tables.subscriptions[0];
    assert.deepEqual([row.plan, row.plan_change_to], ['pro', 'enterprise'], 'the plan itself has not changed yet');
  } finally { await app.stop(); }
});

test('asking for the change that is already scheduled changes nothing', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ plan_change_to: 'enterprise' })] }) });
  try {
    const r = await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'));
    assert.equal(r.status, 200);
    assert.equal((await json(r)).already, true);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('a plan change is refused when it makes no sense, and says why', async () => {
  const cases = [
    [[sub()], { plan: 'pro' }, 409, 'SAME_PLAN'],
    [[sub({ status: 'created' })], { plan: 'enterprise' }, 409, 'NOT_ACTIVE'],
    [[sub({ status: 'authenticated' })], { plan: 'enterprise' }, 409, 'NOT_ACTIVE'],
    [[sub({ cancel_requested_at: '2026-10-20T00:00:00Z' })], { plan: 'enterprise' }, 409, 'CANCELLING'],
    [[], { plan: 'enterprise' }, 404, 'NO_SUBSCRIPTION'],
    [[sub()], { plan: 'starter' }, 400, 'INVALID_PLAN']
  ];
  for (const [subscriptions, body, status, code] of cases) {
    const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions }) });
    try {
      const r = await app.post('/subscriptions/change-plan', body, as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [status, code], `${code}`);
      assert.deepEqual(app.razorpay.calls, [], code);
    } finally { await app.stop(); }
  }
});

test('when Razorpay will not change the plan, nothing is recorded as scheduled', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }), razorpay: fakeRazorpay({ changePlan: { ok: false, code: 'RAZORPAY_REFUSED', error: 'Not allowed on this plan' } }) });
  try {
    const r = await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).error], [502, 'Not allowed on this plan']);
    assert.equal(app.cloud.tables.subscriptions[0].plan_change_to, null);
  } finally { await app.stop(); }
});

// --- webhooks that record what happened ------------------------------------------------------------------------------------

const eventBody = (event, entity = {}, createdAt = 1793000000) => JSON.stringify({
  event, created_at: createdAt,
  payload: { subscription: { entity: { id: 'sub_1', plan_id: 'plan_pro_1', current_start: 1792000000, current_end: 1795000000, notes: { restaurant_id: 'r-uuid', plan: 'pro' }, ...entity } } }
});
const deliver = (app, raw, eventId = 'evt_1') => app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw), ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) });

test('webhook: the first payment puts the restaurant on the plan it paid for, records the subscription and logs the event', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF }) });
  try {
    const raw = eventBody('subscription.activated');
    const r = await deliver(app, raw);
    assert.equal(r.status, 200);

    const [update] = app.cloud.calls.updates;
    assert.deepEqual([update.table, update.val, update.patch.plan, update.patch.plan_status], ['restaurants', 'r-uuid', 'pro', 'active']);

    const [row] = app.cloud.tables.subscriptions;
    assert.deepEqual([row.restaurant_id, row.razorpay_subscription_id, row.razorpay_plan_id, row.plan, row.status], ['r-uuid', 'sub_1', 'plan_pro_1', 'pro', 'active']);
    assert.equal(row.current_end, new Date(1795000000 * 1000).toISOString());
    assert.equal(row.last_event_at, new Date(1793000000 * 1000).toISOString());

    const [logged] = app.cloud.tables.subscription_events;
    assert.deepEqual([logged.razorpay_event_id, logged.event, logged.applied_plan_status, logged.restaurant_id], ['evt_1', 'subscription.activated', 'active', 'r-uuid']);
    assert.equal(logged.payload.event, 'subscription.activated', 'what was said is kept, so a plan status always has an explanation');
  } finally { await app.stop(); }
});

test('webhook: the plan comes from the Razorpay plan that was paid for, even if the notes say otherwise', async () => {
  const app = await serve();
  try {
    await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_ent_1', notes: { restaurant_id: 'r-uuid', plan: 'pro' } }));
    assert.equal(app.cloud.calls.updates[0].patch.plan, 'enterprise');
  } finally { await app.stop(); }
});

test('webhook: a plan nobody recognises leaves the plan alone and only keeps the status honest', async () => {
  const app = await serve();
  try {
    await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_mystery', notes: { restaurant_id: 'r-uuid' } }));
    const { patch } = app.cloud.calls.updates[0];
    assert.equal(patch.plan_status, 'active');
    assert.equal('plan' in patch, false);
  } finally { await app.stop(); }
});

test('webhook: only a paying subscription sets the plan; a failed charge or a cancellation touch the status and nothing else', async () => {
  for (const [event, status] of [['subscription.halted', 'past_due'], ['subscription.pending', 'past_due'], ['subscription.cancelled', 'cancelled'], ['subscription.authenticated', 'trialing']]) {
    const app = await serve();
    try {
      await deliver(app, eventBody(event));
      const { patch } = app.cloud.calls.updates[0];
      assert.equal(patch.plan_status, status, event);
      assert.equal('plan' in patch, false, `${event} must not change the plan`);
    } finally { await app.stop(); }
  }
});

test('webhook: a plan change taking effect updates the plan and clears the pending change', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ plan: 'pro', plan_change_to: 'enterprise', last_event_at: '2026-09-01T00:00:00Z' })] }) });
  try {
    await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_ent_1' }));
    const row = app.cloud.tables.subscriptions[0];
    assert.deepEqual([row.plan, row.plan_change_to], ['enterprise', null]);
    assert.equal(app.cloud.calls.updates[0].patch.plan, 'enterprise');
  } finally { await app.stop(); }
});

test('webhook: a pending change to a different plan survives a charge at the old one', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ plan: 'pro', plan_change_to: 'enterprise', last_event_at: '2026-09-01T00:00:00Z' })] }) });
  try {
    await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_pro_1' }));
    assert.equal(app.cloud.tables.subscriptions[0].plan_change_to, 'enterprise');
  } finally { await app.stop(); }
});

test('webhook: the same event delivered twice is acknowledged and logged once', async () => {
  const app = await serve();
  try {
    const raw = eventBody('subscription.activated');
    assert.equal((await deliver(app, raw, 'evt_dup')).status, 200);
    const again = await deliver(app, raw, 'evt_dup');
    assert.equal(again.status, 200);
    assert.equal((await json(again)).duplicate, true);
    assert.equal(app.cloud.tables.subscription_events.length, 1);
    assert.equal(app.cloud.tables.subscriptions.length, 1);
  } finally { await app.stop(); }
});

test('webhook: news older than what has already been applied is not applied over it', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status: 'active', last_event_at: new Date(1793000000 * 1000).toISOString() })] }) });
  try {
    const stale = await deliver(app, eventBody('subscription.halted', {}, 1792000000), 'evt_old');
    assert.equal(stale.status, 200);
    assert.equal((await json(stale)).ignored, true);
    assert.equal(app.cloud.calls.updates.length, 0, 'the restaurant was not put back to past_due by an old message');
    assert.equal(app.cloud.tables.subscriptions[0].status, 'active');
    assert.equal(app.cloud.tables.subscription_events[0].applied_plan_status, null, 'logged, with nothing applied');
  } finally { await app.stop(); }
});

test('webhook: an event at the same moment as the last one is applied, so a redelivery after a failure is not lost', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ last_event_at: new Date(1793000000 * 1000).toISOString() })] }) });
  try {
    await deliver(app, eventBody('subscription.charged'), 'evt_same');
    assert.equal(app.cloud.calls.updates.length, 1);
  } finally { await app.stop(); }
});

test('webhook: a restaurant that no longer exists is acknowledged, not retried for ever', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, restaurants: [] }) });
  try {
    const r = await deliver(app, eventBody('subscription.charged'));
    assert.equal(r.status, 200);
    assert.equal((await json(r)).reason, 'UNKNOWN_TENANT');
    assert.equal(app.cloud.tables.subscriptions.length, 0);
  } finally { await app.stop(); }
});

test('webhook: if recording fails the answer is 5xx, so Razorpay retries and the sequence is applied again', async () => {
  for (const failures of [{ upsert: { subscriptions: { message: 'down' } } }, { insert: { subscription_events: { message: 'down' } } }, { select: { subscriptions: { message: 'down' } } }]) {
    const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, failures }) });
    try {
      const r = await deliver(app, eventBody('subscription.charged'));
      assert.equal(r.status, 502, JSON.stringify(failures));
    } finally { await app.stop(); }
  }
});

test('webhook: an event with no id header is still applied, and logged without one', async () => {
  const app = await serve();
  try {
    assert.equal((await deliver(app, eventBody('subscription.charged'), null)).status, 200);
    assert.equal(app.cloud.tables.subscription_events[0].razorpay_event_id, null);
  } finally { await app.stop(); }
});

test('the health check says whether billing is configured', async () => {
  const on = await serve();
  const off = await serve({ razorpay: fakeRazorpay({ configured: false }) });
  try {
    assert.equal((await json(await on.get('/health'))).billing, true);
    assert.equal((await json(await off.get('/health'))).billing, false);
  } finally { await on.stop(); await off.stop(); }
});

test('billing is not configured without a database, however good the Razorpay keys are', async () => {
  const app = await serve({ cloud: null });
  try {
    const health = await json(await app.get('/health'));
    assert.deepEqual([health.configured, health.billing], [false, false]);
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).code], [401, 'NOT_SIGNED_IN']);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

// --- closing the gaps the mutation pass found ---------------------------------------------------------------------------------

test('no sign-in at all is refused without asking the cloud anything', async () => {
  const app = await serve();
  try {
    assert.equal((await app.get('/subscriptions/current')).status, 401);
    assert.deepEqual(app.cloud.calls.getUser, [], 'there was nothing to check');
  } finally { await app.stop(); }
});

test('a sign-in is accepted only if the cloud says there is no error AND names a user', async () => {
  const cases = [
    ['an error and no user', { data: { user: null }, error: { message: 'bad' } }],
    ['an error alongside a user', { data: { user: { id: 'u-owner' } }, error: { message: 'expired' } }],
    ['no error and no user', { data: { user: null }, error: null }],
    ['no error and a user with no id', { data: { user: {} }, error: null }]
  ];
  for (const [name, answer] of cases) {
    const cloud = memoryCloud({ users: USERS, staff: STAFF });
    cloud.auth.getUser = async () => answer;
    const app = await serve({ cloud });
    try {
      const r = await app.get('/subscriptions/current', as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [401, 'NOT_SIGNED_IN'], name);
    } finally { await app.stop(); }
  }
});

test('the wait between attempts is exactly the gap: just inside it is refused, the full gap is allowed', async () => {
  let clock = NOW;
  const app = await serve({ now: () => clock, razorpay: fakeRazorpay({ createSubscription: { ok: false, code: 'RAZORPAY_ERROR', status: 503, error: 'down' } }) });
  try {
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 502);
    clock = NOW + 4999;
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 429);
    clock = NOW + 5000;
    assert.equal((await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 502, 'five seconds have passed');
  } finally { await app.stop(); }
});

test('a plan change that Razorpay refused is not retried at once either, and may be after the wait', async () => {
  let clock = NOW;
  const app = await serve({
    now: () => clock,
    cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }),
    razorpay: fakeRazorpay({ changePlan: { ok: false, code: 'RAZORPAY_ERROR', status: 503, error: 'down' } })
  });
  try {
    assert.equal((await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'))).status, 502);
    const again = await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'));
    assert.deepEqual([again.status, (await json(again)).code], [429, 'TOO_SOON']);
    assert.equal(app.razorpay.calls.length, 1);
    clock += 5000;
    assert.equal((await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'))).status, 502);
    assert.equal(app.razorpay.calls.length, 2);
  } finally { await app.stop(); }
});

test('changing plan with no Razorpay keys says so and asks nothing', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()] }), razorpay: fakeRazorpay({ configured: false }) });
  try {
    const r = await app.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED']);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('what is on offer is what is configured, and billing_configured is what the keys say', async () => {
  const some = await serve({ env: { RAZORPAY_PLAN_PRO: 'plan_pro_1' } });
  const keyless = await serve({ razorpay: fakeRazorpay({ configured: false }) });
  try {
    const body = await json(await some.get('/subscriptions/current', as('tok-owner')));
    assert.deepEqual([body.plans, body.billing_configured], [['pro'], true]);
    const none = await json(await keyless.get('/subscriptions/current', as('tok-owner')));
    assert.equal(none.billing_configured, false);
  } finally { await some.stop(); await keyless.stop(); }
});

test('a payment page whose link was not kept is not answered with a second subscription, and says why', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status: 'created', short_url: null })] }) });
  try {
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.deepEqual([r.status, (await json(r)).code], [409, 'PENDING_PAYMENT']);
    assert.deepEqual(app.razorpay.calls, []);
  } finally { await app.stop(); }
});

test('a link left on a subscription that is no longer waiting is never handed back as a payment page', async () => {
  for (const status of ['authenticated', 'active', 'pending']) {
    const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ status, plan: 'pro', short_url: 'https://rzp.io/i/old' })] }) });
    try {
      const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
      assert.deepEqual([r.status, (await json(r)).code], [409, 'ALREADY_SUBSCRIBED'], status);
    } finally { await app.stop(); }
  }
});

test('an answer from Razorpay with no status is recorded as created', async () => {
  const app = await serve({ razorpay: fakeRazorpay({ createSubscription: { ok: true, data: { id: 'sub_NOSTATUS', short_url: 'https://rzp.io/i/n' } } }) });
  try {
    const r = await app.post('/subscriptions', { plan: 'pro' }, as('tok-owner'));
    assert.equal(r.status, 201);
    assert.equal(app.cloud.calls.inserts[0].row.status, 'created');
  } finally { await app.stop(); }
});

test('a subscription made at Razorpay but not recorded, cancelled but not marked, or changed but not marked, is said in the log with its id', async () => {
  const logged = mock.method(console, 'error', () => {});
  try {
    const made = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, failures: { insert: { subscriptions: { message: 'reset' } } } }) });
    try {
      assert.equal((await made.post('/subscriptions', { plan: 'pro' }, as('tok-owner'))).status, 201);
    } finally { await made.stop(); }
    assert.match(logged.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /sub_NEW.*not recorded/);

    const marking = { update: { subscriptions: { message: 'reset' } } };
    const cancelled = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()], failures: marking }) });
    try {
      assert.equal((await cancelled.post('/subscriptions/cancel', {}, as('tok-owner'))).status, 200, 'Razorpay has it, so the owner is told it is done');
    } finally { await cancelled.stop(); }
    assert.match(logged.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /sub_1.*cancelled at Razorpay but not marked/);

    const changed = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub()], failures: marking }) });
    try {
      assert.equal((await changed.post('/subscriptions/change-plan', { plan: 'enterprise' }, as('tok-owner'))).status, 200);
    } finally { await changed.stop(); }
    assert.match(logged.mock.calls.map(c => c.arguments.join(' ')).join('\n'), /sub_1.*changed at Razorpay but not marked/);
  } finally { logged.mock.restore(); }
});

test('webhook: a stale event redelivered is acknowledged as one, not retried; a log that cannot be written is retried', async () => {
  const app = await serve({ cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ last_event_at: new Date(1793000000 * 1000).toISOString() })] }) });
  try {
    const raw = eventBody('subscription.halted', {}, 1792000000);
    const first = await json(await deliver(app, raw, 'evt_stale'));
    assert.deepEqual([first.reason, first.duplicate], ['STALE', undefined]);
    const second = await deliver(app, raw, 'evt_stale');
    assert.equal(second.status, 200);
    const again = await json(second);
    assert.deepEqual([again.reason, again.duplicate], ['STALE', true]);
    assert.equal(app.cloud.tables.subscription_events.length, 1);
  } finally { await app.stop(); }

  const failing = await serve({
    cloud: memoryCloud({ users: USERS, staff: STAFF, subscriptions: [sub({ last_event_at: new Date(1793000000 * 1000).toISOString() })], failures: { insert: { subscription_events: { message: 'down' } } } })
  });
  try {
    const r = await deliver(failing, eventBody('subscription.halted', {}, 1792000000), 'evt_x');
    assert.equal(r.status, 502, 'losing the record of a stale event is not worth a silent 200');
  } finally { await failing.stop(); }
});

test('webhook: with no plan id we know, the plan the subscription was made for is used if it is one of the paid ones, and only then', async () => {
  for (const [noted, expected] of [['enterprise', 'enterprise'], ['pro', 'pro'], ['platinum', undefined], ['starter', undefined], [undefined, undefined]]) {
    const app = await serve();
    try {
      await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_mystery', notes: { restaurant_id: 'r-uuid', ...(noted ? { plan: noted } : {}) } }));
      assert.equal(app.cloud.calls.updates[0].patch.plan, expected, String(noted));
    } finally { await app.stop(); }
  }
});

test('webhook: when the plan id is known it outranks the plan in the notes', async () => {
  const app = await serve();
  try {
    await deliver(app, eventBody('subscription.charged', { plan_id: 'plan_pro_1', notes: { restaurant_id: 'r-uuid', plan: 'enterprise' } }));
    assert.equal(app.cloud.calls.updates[0].patch.plan, 'pro');
  } finally { await app.stop(); }
});

test('webhook: the start of the period is recorded beside its end', async () => {
  const app = await serve();
  try {
    await deliver(app, eventBody('subscription.charged'));
    assert.equal(app.cloud.tables.subscriptions[0].current_start, new Date(1792000000 * 1000).toISOString());
  } finally { await app.stop(); }
});

test('webhook: a signed event with no database to apply it to is refused, not crashed on', async () => {
  const app = await serve({ cloud: null });
  try {
    const r = await deliver(app, eventBody('subscription.charged'));
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED']);
  } finally { await app.stop(); }
});

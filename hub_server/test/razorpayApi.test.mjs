import test from 'node:test';
import assert from 'node:assert/strict';

import { createRazorpayApi } from '../../signup_server/lib/razorpayApi.js';
import {
  planIdFor, planForRazorpayPlanId, offeredPlans, validatePlan, isLive, canCancel, describeSubscription, BILLABLE_PLANS
} from '../../signup_server/lib/billing.js';

// The two halves of creating a subscription that are not the webhook: talking to Razorpay, and deciding what is allowed. The
// client is tested against a stand-in for fetch, never the real API (there are no keys here), so what these tests prove is
// that the REQUESTS are the ones Razorpay documents and that every way it can go wrong becomes an answer, not an exception.

const KEY_ID = 'rzp_test_keyid';
const KEY_SECRET = 'rzp_test_secret_value_xyz';
const basic = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = typeof reply === 'function' ? await reply({ url, init }) : reply;
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { calls, fetchImpl };
}
const api = (reply, over = {}) => {
  const rec = recorder(reply);
  return { ...rec, client: createRazorpayApi({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl: rec.fetchImpl, ...over }) };
};

// --- the client -------------------------------------------------------------------------------------------------------

test('without keys it says so and never calls out', async () => {
  for (const creds of [{}, { keyId: KEY_ID }, { keySecret: KEY_SECRET }, { keyId: '', keySecret: '' }]) {
    const rec = recorder({ status: 200, body: {} });
    const client = createRazorpayApi({ ...creds, fetchImpl: rec.fetchImpl });
    assert.equal(client.configured(), false);
    for (const call of [() => client.createSubscription({}), () => client.cancelSubscription('sub_1'), () => client.changePlan('sub_1', { planId: 'p' }), () => client.fetchSubscription('sub_1')]) {
      const r = await call();
      assert.deepEqual([r.ok, r.code], [false, 'NOT_CONFIGURED']);
    }
    assert.equal(rec.calls.length, 0);
  }
});

test('creating a subscription POSTs the payload to /subscriptions with the account\'s keys', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'sub_NEW1', status: 'created', short_url: 'https://rzp.io/i/abc', plan_id: 'plan_pro' } });
  const payload = { plan_id: 'plan_pro', total_count: 12, customer_notify: 1, notes: { restaurant_id: 'r1', plan: 'pro' } };
  const r = await client.createSubscription(payload);

  assert.equal(r.ok, true);
  assert.deepEqual([r.data.id, r.data.status, r.data.short_url], ['sub_NEW1', 'created', 'https://rzp.io/i/abc']);
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, basic);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, payload);
});

test('cancelling is a POST to the subscription\'s cancel, at the end of the period unless told otherwise', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'sub_1', status: 'active' } });
  assert.equal((await client.cancelSubscription('sub_1')).ok, true);
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions/sub_1/cancel');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, { cancel_at_cycle_end: 1 });
  await client.cancelSubscription('sub_1', { atCycleEnd: false });
  assert.deepEqual(calls[1].body, { cancel_at_cycle_end: 0 });
});

test('changing plan is a PATCH naming the new plan, scheduled for the end of the period unless told otherwise', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'sub_1', status: 'active' } });
  await client.changePlan('sub_1', { planId: 'plan_ent' });
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions/sub_1');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(calls[0].body, { plan_id: 'plan_ent', schedule_change_at: 'cycle_end' });
  await client.changePlan('sub_1', { planId: 'plan_ent', atCycleEnd: false });
  assert.equal(calls[1].body.schedule_change_at, 'now');
});

test('fetching one is a GET with no body', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'sub_1', status: 'active' } });
  assert.equal((await client.fetchSubscription('sub_1')).data.status, 'active');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('a subscription id is escaped into the path, so what is supplied cannot choose another endpoint', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'x' } });
  await client.cancelSubscription('sub_1/../../payments');
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions/sub_1%2F..%2F..%2Fpayments/cancel');
  for (const bad of ['', null, undefined, 42]) {
    const r = await client.fetchSubscription(bad);
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_ID'], String(bad));
  }
});

test('a request Razorpay refuses comes back as its own words, with the status, not an exception', async () => {
  const { client } = api({ status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The plan id is invalid' } } });
  const r = await client.createSubscription({ plan_id: 'nope' });
  assert.deepEqual([r.ok, r.status, r.code, r.razorpayCode, r.error], [false, 400, 'RAZORPAY_REFUSED', 'BAD_REQUEST_ERROR', 'The plan id is invalid']);
});

test('a refusal with no description still says something, and a Razorpay outage is called one', async () => {
  const refused = await api({ status: 401, body: { error: {} } }).client.fetchSubscription('sub_1');
  assert.equal(refused.code, 'RAZORPAY_REFUSED');
  assert.ok(refused.error.length > 10);
  const down = await api({ status: 503, body: 'upstream connect error' }).client.fetchSubscription('sub_1');
  assert.deepEqual([down.ok, down.code, down.status], [false, 'RAZORPAY_ERROR', 503]);
});

test('a 500 is Razorpay\'s fault and a 499 is not; their words are trimmed, and blank words are not used', async () => {
  const at500 = await api({ status: 500, body: 'oops' }).client.fetchSubscription('sub_1');
  assert.deepEqual([at500.code, at500.status], ['RAZORPAY_ERROR', 500]);
  const at499 = await api({ status: 499, body: {} }).client.fetchSubscription('sub_1');
  assert.deepEqual([at499.code, at499.status], ['RAZORPAY_REFUSED', 499]);

  const padded = await api({ status: 400, body: { error: { description: '  The plan id is invalid \n' } } }).client.fetchSubscription('sub_1');
  assert.equal(padded.error, 'The plan id is invalid');
  const blank = await api({ status: 400, body: { error: { description: '   ' } } }).client.fetchSubscription('sub_1');
  assert.equal(blank.error, 'Razorpay did not accept that (status 400).');
});

test('a network failure, a timeout and rubbish in reply are each an answer', async () => {
  const unreachable = await api(new Error('connect ECONNREFUSED')).client.fetchSubscription('sub_1');
  assert.deepEqual([unreachable.ok, unreachable.code], [false, 'RAZORPAY_UNREACHABLE']);
  const garbage = await api({ status: 200, body: '<html>not json</html>' }).client.fetchSubscription('sub_1');
  assert.deepEqual([garbage.ok, garbage.code], [false, 'RAZORPAY_BAD_RESPONSE']);
  for (const body of ['null', '5', '"fine"', 'true']) {
    const odd = await api({ status: 200, body }).client.fetchSubscription('sub_1');
    assert.deepEqual([odd.ok, odd.code], [false, 'RAZORPAY_BAD_RESPONSE'], `a reply of ${body} is JSON, but is not a subscription`);
  }
  const noId = await api({ status: 200, body: { status: 'created' } }).client.createSubscription({ plan_id: 'p' });
  assert.deepEqual([noId.ok, noId.code], [false, 'RAZORPAY_BAD_RESPONSE'], 'a created subscription with no id is not one we can record');
});

test('every request carries a timeout, so a Razorpay that never answers cannot hang the service', async () => {
  const { client, calls } = api({ status: 200, body: { id: 'x' } });
  await client.createSubscription({ plan_id: 'p' });
  await client.fetchSubscription('sub_1');
  for (const c of calls) assert.ok(c.init.signal, 'an abort signal');
});

test('the secret is never in an answer, whatever went wrong', async () => {
  const outcomes = [
    await api(new Error(`failed with Authorization: ${basic} and ${KEY_SECRET}`)).client.fetchSubscription('sub_1'),
    await api({ status: 400, body: { error: { description: 'bad' } } }).client.createSubscription({ plan_id: 'x' }),
    await api({ status: 200, body: '???' }).client.fetchSubscription('sub_1'),
    await api({ status: 502, body: 'x' }).client.cancelSubscription('sub_1')
  ];
  for (const o of outcomes) assert.doesNotMatch(JSON.stringify(o), new RegExp(`${KEY_SECRET}|${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`));
});

// --- which plans can be bought ------------------------------------------------------------------------------------------

const ENV = { RAZORPAY_PLAN_PRO: 'plan_pro_1', RAZORPAY_PLAN_ENTERPRISE: 'plan_ent_1' };

test('only the paid plans can be subscribed to, and each has a Razorpay plan behind it from the environment', () => {
  assert.deepEqual(BILLABLE_PLANS, ['pro', 'enterprise']);
  assert.equal(planIdFor('pro', ENV), 'plan_pro_1');
  assert.equal(planIdFor('enterprise', ENV), 'plan_ent_1');
  for (const bad of ['starter', 'platinum', '', null, undefined, 'PRO']) assert.equal(planIdFor(bad, ENV), null, String(bad));
  assert.equal(planIdFor('pro', {}), null, 'no plan configured: not offered');
  assert.equal(planIdFor('pro', { RAZORPAY_PLAN_PRO: '  ' }), null);
  assert.equal(planIdFor('pro', { RAZORPAY_PLAN_PRO: '  plan_pro_1\n' }), 'plan_pro_1', 'a stray space or newline in an env file is not part of the id');
});

test('which plans are on offer is what is configured, not what exists', () => {
  assert.deepEqual(offeredPlans(ENV), ['pro', 'enterprise']);
  assert.deepEqual(offeredPlans({ RAZORPAY_PLAN_PRO: 'plan_pro_1' }), ['pro']);
  assert.deepEqual(offeredPlans({}), []);
});

test('a Razorpay plan id can be turned back into ours, and an unknown or missing one is not guessed', () => {
  assert.equal(planForRazorpayPlanId('plan_ent_1', ENV), 'enterprise');
  assert.equal(planForRazorpayPlanId('plan_pro_1', ENV), 'pro');
  assert.equal(planForRazorpayPlanId('plan_other', ENV), null);
  assert.equal(planForRazorpayPlanId(null, ENV), null);
  assert.equal(planForRazorpayPlanId('plan_pro_1', {}), null);
});

test('a plan to subscribe to must be one of the paid ones, and the refusal says so', () => {
  assert.deepEqual(validatePlan({ plan: 'pro' }), { ok: true, plan: 'pro' });
  for (const body of [{ plan: 'starter' }, { plan: 'platinum' }, {}, null, 'pro', { plan: 7 }]) {
    const r = validatePlan(body);
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_PLAN'], JSON.stringify(body));
    assert.match(r.error, /pro|enterprise/i);
  }
});

// --- where a subscription is in its life ---------------------------------------------------------------------------------

test('a subscription is live while it can still become, or be, a paying one', () => {
  for (const status of ['created', 'authenticated', 'active', 'pending']) assert.equal(isLive(status), true, status);
  for (const status of ['halted', 'cancelled', 'completed', 'expired', 'something_new', '', null, undefined]) assert.equal(isLive(status), false, String(status));
});

test('only one that has been authorised can be cancelled; one never paid for simply lapses', () => {
  for (const status of ['authenticated', 'active', 'pending']) assert.equal(canCancel(status), true, status);
  for (const status of ['created', 'halted', 'cancelled', 'completed', 'expired', null]) assert.equal(canCancel(status), false, String(status));
});

test('what the hub is told about a subscription is only what it needs, and the payment link only while it is waiting to be paid', () => {
  const row = {
    id: 'uuid-1', restaurant_id: 'r1', razorpay_subscription_id: 'sub_1', razorpay_plan_id: 'plan_pro_1', razorpay_customer_id: 'cust_9',
    plan: 'pro', plan_change_to: 'enterprise', status: 'created', short_url: 'https://rzp.io/i/abc', current_end: '2026-11-23T00:00:00Z',
    cancel_requested_at: null, created_at: '2026-10-23T10:00:00Z'
  };
  const told = describeSubscription(row);
  assert.deepEqual(told, {
    id: 'sub_1', status: 'created', plan: 'pro', plan_change_to: 'enterprise', current_end: '2026-11-23T00:00:00Z',
    cancel_requested_at: null, short_url: 'https://rzp.io/i/abc', created_at: '2026-10-23T10:00:00Z'
  });
  assert.doesNotMatch(JSON.stringify(told), /r1|cust_9|plan_pro_1|uuid-1/, 'no tenant id, customer id or internal ids');
  assert.equal('short_url' in describeSubscription({ ...row, status: 'active' }), false);
  assert.equal(describeSubscription(null), null);
  assert.equal(describeSubscription(undefined), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';
import { validateSignup, provisionArgs, describeProvisioned, newProvisioningSecret, isOperator } from '../../signup_server/lib/provision.js';

// The operator service (§4.4): creating tenants, and reacting to Razorpay. It is the one place in
// this product that holds privileged credentials, so most of what matters here is what it REFUSES.

const TOKEN = 'operator-token-value';
const WEBHOOK_SECRET = 'whsec_value';
const sign = (data, secret = WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(data).digest('hex');

// --- the rules ---------------------------------------------------------------------------------

test('a signup needs a name and a city, and says which is missing', () => {
  const bad = validateSignup({ name: '  ', city: '' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.field), ['name', 'city']);

  const good = validateSignup({ name: '  Spice Garden  ', city: 'Bengaluru' });
  assert.deepEqual(good.signup, { name: 'Spice Garden', city: 'Bengaluru', plan: 'starter' });
});

test('the optional fields are optional, and bounded when given', () => {
  const r = validateSignup({ name: 'A', city: 'B', cuisine: 'North Indian', phone: '+919876543210', address: '12 MG Road' });
  assert.deepEqual(r.signup, { name: 'A', city: 'B', cuisine: 'North Indian', phone: '+919876543210', address: '12 MG Road', plan: 'starter' });
  assert.equal(validateSignup({ name: 'A', city: 'B', phone: 'x'.repeat(21) }).ok, false);
  assert.equal(validateSignup({ name: 'x'.repeat(121), city: 'B' }).ok, false);
});

test('only a plan the database knows is accepted', () => {
  assert.equal(validateSignup({ name: 'A', city: 'B', plan: 'pro' }).signup.plan, 'pro');
  assert.equal(validateSignup({ name: 'A', city: 'B', plan: 'platinum' }).ok, false);
});

test('a provisioning secret is long enough for what migration 007 demands, and never the same twice', () => {
  const a = newProvisioningSecret();
  const b = newProvisioningSecret();
  assert.ok(a.length >= 16, 'migration 007 refuses anything shorter');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]+$/);
});

test('the RPC gets named arguments, and leaves out what was not given', () => {
  const args = provisionArgs({ name: 'A', city: 'B', plan: 'pro' }, 'secret');
  assert.deepEqual(args, { p_name: 'A', p_city: 'B', p_secret: 'secret', p_plan: 'pro' });
  assert.equal('p_phone' in args, false, 'an absent optional is absent, not an empty string');
});

test('what the operator is told includes the secret, and that it will never be shown again', () => {
  const told = describeProvisioned({ restaurant_id: 'r1', pairing_code: 'SPI-4821', slug: 'spice', trial_ends_at: '2026-11-04T00:00:00Z' }, 'the-secret');
  assert.equal(told.hub_provisioning_secret, 'the-secret');
  assert.ok(told.next_steps.some(s => s.includes('HUB_PROVISIONING_SECRET=the-secret')));
  assert.ok(told.next_steps.some(s => s.includes('SPI-4821')));
  assert.ok(told.next_steps.some(s => /shown once/.test(s)));
});

test('a service with no operator token configured refuses everyone, rather than defaulting to open', () => {
  // The failure mode of a forgotten environment variable must not be "anyone may create restaurants".
  assert.equal(isOperator('anything', undefined), false);
  assert.equal(isOperator('anything', ''), false);
  assert.equal(isOperator('', 'configured'), false);
  assert.equal(isOperator('wrong', 'configured'), false);
  assert.equal(isOperator('configured', 'configured'), true);
});

// --- the service ---------------------------------------------------------------------------------

/**
 * A Supabase stand-in that records what it was asked to do. It is the shared in-memory cloud, so the webhook can read, upsert and
 * log as well as update; the assertions in this file are about `calls.rpc` and `calls.updates`, which it records as before.
 */
function fakeCloud({ rpcResult, rpcError = null, updateError = null } = {}) {
  return memoryCloud({ rpcResult, rpcError, failures: updateError ? { update: { restaurants: updateError } } : {} });
}

const PROVISIONED = [{ restaurant_id: 'r-uuid', pairing_code: 'SPI-4821', slug: 'spice-garden', trial_ends_at: '2026-11-04T00:00:00.000Z' }];

/** Start the app on an ephemeral port and return a caller for it. */
async function serve(options) {
  const server = http.createServer(createApp(options));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    stop: () => new Promise(resolve => server.close(resolve)),
    post: (p, body, headers = {}) => fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  };
}

test('signup: the operator creates a tenant and is told the code and the secret', async () => {
  const cloud = fakeCloud({ rpcResult: PROVISIONED });
  const app = await serve({ cloud, operatorToken: TOKEN });
  try {
    const res = await app.post('/signup', { name: 'Spice Garden', city: 'Bengaluru', plan: 'pro' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.equal(body.pairing_code, 'SPI-4821');
    assert.equal(body.restaurant_id, 'r-uuid');
    assert.ok(body.hub_provisioning_secret.length >= 16);
    assert.equal(cloud.calls.rpc[0].fn, 'provision_restaurant');
    assert.equal(cloud.calls.rpc[0].args.p_name, 'Spice Garden');
    assert.equal(cloud.calls.rpc[0].args.p_secret, body.hub_provisioning_secret, 'the secret shown is the one stored');
  } finally {
    await app.stop();
  }
});

test('signup: without the operator token nothing is created, whatever the body says', async () => {
  const cloud = fakeCloud({ rpcResult: PROVISIONED });
  const app = await serve({ cloud, operatorToken: TOKEN });
  try {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: TOKEN }]) {
      const res = await app.post('/signup', { name: 'Intruder', city: 'Nowhere' }, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal((await res.json()).code, 'NOT_OPERATOR');
    }
    assert.deepEqual(cloud.calls.rpc, [], 'the database was never asked');
  } finally {
    await app.stop();
  }
});

test('signup: a service started without a token refuses even a correct-looking request', async () => {
  const cloud = fakeCloud({ rpcResult: PROVISIONED });
  const app = await serve({ cloud, operatorToken: undefined });
  try {
    assert.equal((await app.post('/signup', { name: 'A', city: 'B' }, { Authorization: 'Bearer anything' })).status, 401);
    assert.deepEqual(cloud.calls.rpc, []);
  } finally {
    await app.stop();
  }
});

test('signup: a bad body is refused with the field, before the database is asked', async () => {
  const cloud = fakeCloud({ rpcResult: PROVISIONED });
  const app = await serve({ cloud, operatorToken: TOKEN });
  try {
    const res = await app.post('/signup', { name: '', city: 'B' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_SIGNUP');
    assert.equal(body.errors[0].field, 'name');
    assert.deepEqual(cloud.calls.rpc, []);
  } finally {
    await app.stop();
  }
});

test('signup: a database refusal is reported rather than claiming a tenant exists', async () => {
  const cloud = fakeCloud({ rpcError: { message: 'A restaurant name is required' } });
  const app = await serve({ cloud, operatorToken: TOKEN });
  try {
    const res = await app.post('/signup', { name: 'A', city: 'B' }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'PROVISION_FAILED');
  } finally {
    await app.stop();
  }
});

// --- webhooks --------------------------------------------------------------------------------------

const chargedBody = (restaurantId = 'r-uuid') => JSON.stringify({
  event: 'subscription.charged',
  payload: { subscription: { entity: { id: 'sub_1', current_end: 1793000000, notes: { restaurant_id: restaurantId } } } }
});

test('webhook: a signed charge puts the tenant back to active', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = chargedBody();
    const res = await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(res.status, 200);

    const [update] = cloud.calls.updates;
    assert.equal(update.table, 'restaurants');
    assert.equal(update.val, 'r-uuid');
    assert.equal(update.patch.plan_status, 'active');
    assert.ok(update.patch.current_period_end);
  } finally {
    await app.stop();
  }
});

test('webhook: an unsigned or forged webhook changes nothing -- it is a way to put any tenant on any plan', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = chargedBody();
    for (const headers of [{}, { 'X-Razorpay-Signature': 'nonsense' }, { 'X-Razorpay-Signature': sign(raw, 'forged-secret') }]) {
      const res = await app.post('/webhooks/razorpay', raw, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    // A body changed after signing must fail too, which is why the raw bytes are what is verified.
    const tampered = chargedBody('someone-elses-restaurant');
    assert.equal((await app.post('/webhooks/razorpay', tampered, { 'X-Razorpay-Signature': sign(raw) })).status, 401);
    assert.deepEqual(cloud.calls.updates, []);
  } finally {
    await app.stop();
  }
});

test('webhook: a failed charge becomes past_due, so the restaurant keeps trading through its grace window', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = JSON.stringify({
      event: 'subscription.halted',
      payload: { subscription: { entity: { id: 'sub_1', current_end: 1793000000, notes: { restaurant_id: 'r-uuid' } } } }
    });
    await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(cloud.calls.updates[0].patch.plan_status, 'past_due', 'not suspended');
  } finally {
    await app.stop();
  }
});

test('webhook: an event we do not act on is acknowledged, not retried forever', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = JSON.stringify({ event: 'payment.captured', payload: {} });
    const res = await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(res.status, 200, 'a 4xx would make Razorpay redeliver it for ever');
    assert.equal((await res.json()).ignored, true);
    assert.deepEqual(cloud.calls.updates, []);
  } finally {
    await app.stop();
  }
});

test('webhook: a subscription with no tenant is acknowledged and acted on by nobody', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = JSON.stringify({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_1' } } } });
    const res = await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reason, 'NO_TENANT');
    assert.deepEqual(cloud.calls.updates, []);
  } finally {
    await app.stop();
  }
});

test('webhook: a database failure answers 5xx so Razorpay retries -- losing a payment event strands a paying tenant', async () => {
  const cloud = fakeCloud({ updateError: { message: 'connection reset' } });
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: WEBHOOK_SECRET });
  try {
    const raw = chargedBody();
    const res = await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(res.status, 502);
  } finally {
    await app.stop();
  }
});

test('webhook: with no secret configured it refuses rather than trusting the caller', async () => {
  const cloud = fakeCloud();
  const app = await serve({ cloud, operatorToken: TOKEN, webhookSecret: undefined });
  try {
    const raw = chargedBody();
    const res = await app.post('/webhooks/razorpay', raw, { 'X-Razorpay-Signature': sign(raw) });
    assert.equal(res.status, 503);
    assert.deepEqual(cloud.calls.updates, []);
  } finally {
    await app.stop();
  }
});

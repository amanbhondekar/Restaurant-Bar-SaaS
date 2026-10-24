import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createBillingClient, normalizeOperatorUrl } from '../lib/billingClient.js';
import { billingRoutes } from '../lib/billingRoutes.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// How a hub asks the operator service about its restaurant's subscription. The hub never holds a Razorpay key and never decides
// anything about money: it forwards a request, authenticated by its own cloud session, and reports what came back. So what is
// tested is that it forwards only what it should, that it cannot be made to talk to somewhere unsafe, that every way the
// internet can fail becomes an answer the screen can word, and that only reception can ask.

const TOKEN = 'hub-access-token-value';

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
const client = (reply, over = {}) => {
  const rec = recorder(reply);
  return { ...rec, client: createBillingClient({ baseUrl: 'https://ops.example.com', getToken: async () => TOKEN, fetchImpl: rec.fetchImpl, ...over }) };
};

// --- where it will talk ---------------------------------------------------------------------------------------------------

test('the operator service is an https address, or a local one for trying it out, and nothing else', () => {
  assert.equal(normalizeOperatorUrl('https://ops.example.com'), 'https://ops.example.com');
  assert.equal(normalizeOperatorUrl('  https://ops.example.com/  '), 'https://ops.example.com');
  assert.equal(normalizeOperatorUrl('https://ops.example.com/billing//'), 'https://ops.example.com/billing');
  for (const local of ['http://localhost:4500', 'http://127.0.0.1:4500', 'http://[::1]:4500']) assert.equal(normalizeOperatorUrl(local), local, local);
  for (const bad of ['http://ops.example.com', 'http://192.168.1.50:4500', 'ftp://ops.example.com', 'ftp://localhost:4500', 'ws://127.0.0.1:4500', 'file://localhost/etc/passwd', 'ops.example.com', 'javascript:alert(1)', '', '   ', null, undefined, 42, 'https://', 'https://user:pass@ops.example.com']) {
    assert.equal(normalizeOperatorUrl(bad), null, String(bad));
  }
});

// --- the client -----------------------------------------------------------------------------------------------------------

test('with no address it says billing is not connected, and never calls out', async () => {
  for (const baseUrl of [undefined, '', 'http://ops.example.com']) {
    const rec = recorder({ status: 200, body: {} });
    const c = createBillingClient({ baseUrl, getToken: async () => TOKEN, fetchImpl: rec.fetchImpl });
    assert.equal(c.configured(), false);
    const r = await c.current();
    assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'BILLING_NOT_CONFIGURED']);
    assert.equal(rec.calls.length, 0);
  }
});

test('with no cloud sign-in it says so rather than sending a request that cannot succeed', async () => {
  for (const getToken of [async () => null, async () => '', async () => { throw new Error('offline'); }]) {
    const rec = recorder({ status: 200, body: {} });
    const c = createBillingClient({ baseUrl: 'https://ops.example.com', getToken, fetchImpl: rec.fetchImpl });
    const r = await c.subscribe('pro');
    assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'NO_CLOUD_SESSION']);
    assert.match(r.error, /internet/i);
    assert.equal(rec.calls.length, 0);
  }
});

test('each request goes to the right route with the hub\'s own sign-in, and carries only what it should', async () => {
  const { client: c, calls } = client({ status: 200, body: { success: true } });
  await c.current();
  await c.subscribe('pro');
  await c.changePlan('enterprise');
  await c.cancel();

  assert.deepEqual(calls.map(x => [x.init.method, x.url]), [
    ['GET', 'https://ops.example.com/subscriptions/current'],
    ['POST', 'https://ops.example.com/subscriptions'],
    ['POST', 'https://ops.example.com/subscriptions/change-plan'],
    ['POST', 'https://ops.example.com/subscriptions/cancel']
  ]);
  for (const x of calls) {
    assert.equal(x.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(x.init.signal, 'a timeout');
  }
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(calls[1].body, { plan: 'pro' });
  assert.deepEqual(calls[2].body, { plan: 'enterprise' });
  assert.deepEqual(calls[3].body, {});
});

test('a path prefix on the address is kept', async () => {
  const { client: c, calls } = client({ status: 200, body: {} }, { baseUrl: 'https://ops.example.com/billing/' });
  await c.current();
  assert.equal(calls[0].url, 'https://ops.example.com/billing/subscriptions/current');
});

test('a good answer comes back as its data', async () => {
  const { client: c } = client({ status: 201, body: { success: true, subscription: { id: 'sub_1', short_url: 'https://rzp.io/i/x' } } });
  const r = await c.subscribe('pro');
  assert.equal(r.ok, true);
  assert.equal(r.data.subscription.short_url, 'https://rzp.io/i/x');
});

test('a refusal keeps the service\'s own status, code and words', async () => {
  const { client: c } = client({ status: 409, body: { success: false, code: 'ALREADY_SUBSCRIBED', error: 'This restaurant already has a subscription.' } });
  const r = await c.subscribe('pro');
  assert.deepEqual([r.ok, r.status, r.code, r.error], [false, 409, 'ALREADY_SUBSCRIBED', 'This restaurant already has a subscription.']);
});

test('a refusal with no usable code or words still gets both', async () => {
  for (const body of [{}, { code: 42, error: { nested: true } }, { code: null, error: '' }, { code: ['X'], error: 7 }]) {
    const r = await client({ status: 409, body }).client.subscribe('pro');
    assert.deepEqual([r.ok, r.status, r.code, r.error], [false, 409, 'BILLING_ERROR', 'The billing service did not accept that.'], JSON.stringify(body));
  }
});

test('no internet, a service that is down and a reply that is not JSON are each an answer the screen can word', async () => {
  const offline = await client(new Error('getaddrinfo ENOTFOUND ops.example.com')).client.current();
  assert.deepEqual([offline.ok, offline.status, offline.code], [false, 503, 'OFFLINE']);
  assert.match(offline.error, /internet/i);

  const down = await client({ status: 503, body: 'upstream connect error' }).client.current();
  assert.deepEqual([down.ok, down.status, down.code], [false, 503, 'BILLING_UNAVAILABLE']);

  const garbage = await client({ status: 200, body: '<html>proxy error</html>' }).client.current();
  assert.deepEqual([garbage.ok, garbage.status, garbage.code], [false, 502, 'BILLING_UNAVAILABLE']);
});

test('a status that is not a refusal or a failure is not passed on as one', async () => {
  const redirected = await client({ status: 302, body: { code: 'X', error: 'moved' } }).client.current();
  assert.equal(redirected.ok, false);
  assert.ok(redirected.status >= 400 && redirected.status <= 599, String(redirected.status));
});

test('the hub\'s sign-in never appears in an answer, whatever went wrong', async () => {
  const outcomes = [
    await client(new Error(`failed: Authorization: Bearer ${TOKEN}`)).client.current(),
    await client({ status: 401, body: { code: 'NOT_SIGNED_IN', error: 'nope' } }).client.current(),
    await client({ status: 200, body: 'x' }).client.current(),
    await client({ status: 200, body: { success: true } }).client.current()
  ];
  for (const o of outcomes) assert.doesNotMatch(JSON.stringify(o), new RegExp(TOKEN));
});

// --- the routes -----------------------------------------------------------------------------------------------------------

function fakeClient(over = {}) {
  const calls = [];
  const step = (name, fallback) => async (...args) => { calls.push([name, ...args]); const r = over[name]; return typeof r === 'function' ? r(...args) : (r ?? fallback); };
  return {
    calls,
    configured: () => over.configured !== false,
    current: step('current', { ok: true, data: { success: true, billing_configured: true, plans: ['pro', 'enterprise'], subscription: null } }),
    subscribe: step('subscribe', { ok: true, data: { success: true, subscription: { id: 'sub_1', status: 'created', short_url: 'https://rzp.io/i/x' } } }),
    cancel: step('cancel', { ok: true, data: { success: true, subscription: { id: 'sub_1', status: 'active', cancel_requested_at: '2026-10-23T10:00:00Z' } } }),
    changePlan: step('changePlan', { ok: true, data: { success: true, subscription: { id: 'sub_1', status: 'active', plan_change_to: 'enterprise' } } })
  };
}

async function serve({ client: c = fakeClient(), guard = (req, res, next) => next(), refreshPlan, refreshTimeoutMs } = {}) {
  const app = express();
  app.use(express.json());
  app.use(billingRoutes({ client: c, guard, refreshPlan, refreshTimeoutMs }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { client: c, stop: () => new Promise(resolve => server.close(resolve)), get: p => send('GET', p), post: (p, b) => send('POST', p, b ?? {}) };
}
const json = r => r.json();

test('routes: every one is behind the guard, so a handset gets nothing and the operator service is never asked', async () => {
  const deny = (req, res) => res.status(403).json({ success: false, code: 'RECEPTION_ONLY' });
  const app = await serve({ guard: deny });
  try {
    for (const [method, path] of [['get', '/admin/billing'], ['post', '/admin/billing/subscribe'], ['post', '/admin/billing/cancel'], ['post', '/admin/billing/change-plan']]) {
      const r = await app[method](path);
      assert.deepEqual([r.status, (await json(r)).code], [403, 'RECEPTION_ONLY'], path);
    }
    assert.deepEqual(app.client.calls, []);
  } finally { await app.stop(); }
});

test('routes: with no operator service configured the screen is told, and nothing is called', async () => {
  const app = await serve({ client: fakeClient({ configured: false }) });
  try {
    const seen = await json(await app.get('/admin/billing'));
    assert.deepEqual([seen.success, seen.configured], [true, false]);
    const asked = await app.post('/admin/billing/subscribe', { plan: 'pro' });
    assert.deepEqual([asked.status, (await json(asked)).code], [503, 'BILLING_NOT_CONFIGURED']);
    assert.deepEqual(app.client.calls, []);
  } finally { await app.stop(); }
});

test('routes: where the subscription stands is passed on with what is on offer', async () => {
  const app = await serve({ client: fakeClient({ current: { ok: true, data: { success: true, billing_configured: true, plans: ['pro'], subscription: { id: 'sub_1', status: 'active', plan: 'pro' } } } }) });
  try {
    const body = await json(await app.get('/admin/billing'));
    assert.deepEqual([body.success, body.configured, body.reachable, body.plans, body.subscription.plan], [true, true, true, ['pro'], 'pro']);
  } finally { await app.stop(); }
});

test('routes: if the service cannot be reached the screen still loads, and is told why', async () => {
  for (const [code, error] of [['OFFLINE', 'This needs the internet.'], ['NO_CLOUD_SESSION', 'This hub has not signed in to the cloud yet.'], ['BILLING_UNAVAILABLE', 'The billing service had a problem.']]) {
    const app = await serve({ client: fakeClient({ current: { ok: false, status: 503, code, error } }) });
    try {
      const r = await app.get('/admin/billing');
      assert.equal(r.status, 200, code);
      const body = await json(r);
      assert.deepEqual([body.configured, body.reachable, body.reason, body.message], [true, false, code, error]);
    } finally { await app.stop(); }
  }
});

test('routes: a real refusal on the read is passed on as one', async () => {
  const app = await serve({ client: fakeClient({ current: { ok: false, status: 403, code: 'ROLE_NOT_ALLOWED', error: 'No.' } }) });
  try {
    const r = await app.get('/admin/billing');
    assert.deepEqual([r.status, (await json(r)).code], [403, 'ROLE_NOT_ALLOWED']);
  } finally { await app.stop(); }
});

test('routes: asking to refresh re-reads the plan from the cloud first, and a refresh that fails or hangs does not stop the answer', async () => {
  let refreshed = 0;
  const ok = await serve({ refreshPlan: async () => { refreshed += 1; } });
  const hangs = await serve({ refreshPlan: () => new Promise(() => {}), refreshTimeoutMs: 50 });
  const throws = await serve({ refreshPlan: async () => { throw new Error('cloud down'); } });
  try {
    assert.equal((await ok.get('/admin/billing')).status, 200);
    assert.equal(refreshed, 0, 'not unless asked');
    assert.equal((await ok.get('/admin/billing?refresh=1')).status, 200);
    assert.equal(refreshed, 1);
    assert.equal((await hangs.get('/admin/billing?refresh=1')).status, 200);
    assert.equal((await throws.get('/admin/billing?refresh=1')).status, 200);
  } finally { await ok.stop(); await hangs.stop(); await throws.stop(); }
});

test('routes: subscribing forwards only the plan, and gives back the payment page', async () => {
  const app = await serve();
  try {
    const r = await app.post('/admin/billing/subscribe', { plan: 'pro', restaurant_id: 'someone-else', amount: 1, role: 'owner' });
    assert.equal(r.status, 201);
    assert.equal((await json(r)).subscription.short_url, 'https://rzp.io/i/x');
    assert.deepEqual(app.client.calls, [['subscribe', 'pro']]);
  } finally { await app.stop(); }
});

test('routes: a plan that is not a plain string is forwarded as nothing, so the service refuses it', async () => {
  const app = await serve();
  try {
    for (const plan of [5, { x: 1 }, ['pro'], null]) await app.post('/admin/billing/subscribe', { plan });
    await app.post('/admin/billing/change-plan', { plan: 7 });
    await app.post('/admin/billing/change-plan');
    assert.deepEqual(app.client.calls, [['subscribe', ''], ['subscribe', ''], ['subscribe', ''], ['subscribe', ''], ['changePlan', ''], ['changePlan', '']]);
  } finally { await app.stop(); }
});

test('routes: with no operator service, changing plan and cancelling call nothing either', async () => {
  const app = await serve({ client: fakeClient({ configured: false }) });
  try {
    for (const path of ['/admin/billing/change-plan', '/admin/billing/cancel']) {
      const r = await app.post(path, { plan: 'pro' });
      assert.deepEqual([r.status, (await json(r)).code], [503, 'BILLING_NOT_CONFIGURED'], path);
    }
    assert.deepEqual(app.client.calls, []);
  } finally { await app.stop(); }
});

test('routes: the status the service answered with is passed on, a missing one is 201 for starting and 200 for the rest, and success is always said', async () => {
  const reused = await serve({ client: fakeClient({ subscribe: { ok: true, status: 200, data: { reused: true, subscription: { id: 'sub_1' } } } }) });
  const bare = await serve({ client: fakeClient({
    subscribe: { ok: true, data: { subscription: { id: 'sub_2' } } },
    changePlan: { ok: true, data: { subscription: { id: 'sub_2' } } },
    cancel: { ok: true, data: { subscription: { id: 'sub_2' } } }
  }) });
  try {
    const again = await reused.post('/admin/billing/subscribe', { plan: 'pro' });
    assert.equal(again.status, 200, 'a page that was already open is not a new subscription');
    assert.deepEqual(await json(again), { reused: true, subscription: { id: 'sub_1' }, success: true });

    const seen = [];
    for (const path of ['/admin/billing/subscribe', '/admin/billing/change-plan', '/admin/billing/cancel']) {
      const r = await bare.post(path, { plan: 'pro' });
      seen.push([path, r.status, (await json(r)).success]);
    }
    assert.deepEqual(seen, [['/admin/billing/subscribe', 201, true], ['/admin/billing/change-plan', 200, true], ['/admin/billing/cancel', 200, true]]);
  } finally { await reused.stop(); await bare.stop(); }
});

test('routes: a refusal that carries no status is a 502, not a success', async () => {
  const app = await serve({ client: fakeClient({ cancel: { ok: false, code: 'X', error: 'no' } }) });
  try {
    const r = await app.post('/admin/billing/cancel');
    assert.deepEqual([r.status, (await json(r)).code], [502, 'X']);
  } finally { await app.stop(); }
});

test('routes: changing plan and cancelling are forwarded, and what the service refuses is passed on in its words', async () => {
  const app = await serve({ client: fakeClient({ cancel: { ok: false, status: 409, code: 'NOTHING_TO_CANCEL', error: 'No payment was made on this one.' } }) });
  try {
    const changed = await app.post('/admin/billing/change-plan', { plan: 'enterprise' });
    assert.equal(changed.status, 200);
    assert.equal((await json(changed)).subscription.plan_change_to, 'enterprise');
    const cancelled = await app.post('/admin/billing/cancel');
    const refusal = await json(cancelled);
    assert.deepEqual([cancelled.status, refusal.code, refusal.error], [409, 'NOTHING_TO_CANCEL', 'No payment was made on this one.']);
  } finally { await app.stop(); }
});

// --- a real hub -----------------------------------------------------------------------------------------------------------

const MENU = { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] };
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] };

test('a real hub: the billing routes are reception\'s, and with no operator service they say billing is not connected', async () => {
  const reception = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'BILLREC' });
  const remote = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'BILLREM' });
  try {
    const seen = await (await call(reception, '/admin/billing')).json();
    assert.deepEqual([seen.success, seen.configured], [true, false]);
    const asked = await call(reception, '/admin/billing/subscribe', { method: 'POST', body: { plan: 'pro' } });
    assert.deepEqual([asked.status, (await asked.json()).code], [503, 'BILLING_NOT_CONFIGURED']);

    const handset = (await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'BILLREM', device_label: 'x' } })).json()).device_token;
    for (const [method, path, body] of [['GET', '/admin/billing'], ['POST', '/admin/billing/subscribe', { plan: 'pro' }], ['POST', '/admin/billing/cancel', {}], ['POST', '/admin/billing/change-plan', { plan: 'pro' }]]) {
      const res = await call(remote, path, { method, token: handset, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await res.json()).code, 'RECEPTION_ONLY');
    }
  } finally { reception.stop(); remote.stop(); }
});

test('a real hub told where the operator service is, but not yet signed in to the cloud, says so and sends nothing', async () => {
  let hits = 0;
  const operator = http.createServer((req, res) => { hits += 1; res.writeHead(200).end('{}'); });
  await new Promise(resolve => operator.listen(0, '127.0.0.1', resolve));
  const hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'BILLOP', env: { OPERATOR_SERVICE_URL: `http://127.0.0.1:${operator.address().port}` } });
  try {
    const seen = await (await call(hub, '/admin/billing')).json();
    assert.deepEqual([seen.configured, seen.reachable, seen.reason], [true, false, 'NO_CLOUD_SESSION']);
    const asked = await call(hub, '/admin/billing/subscribe', { method: 'POST', body: { plan: 'pro' } });
    assert.deepEqual([asked.status, (await asked.json()).code], [409, 'NO_CLOUD_SESSION']);
    assert.equal(hits, 0, 'the operator service was never contacted without a sign-in to prove who is asking');
  } finally { hub.stop(); operator.close(); }
});

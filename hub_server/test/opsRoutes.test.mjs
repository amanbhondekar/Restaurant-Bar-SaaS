import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';

// The operator console's API and its page (§4.9). It shows EVERY restaurant at once, so what is tested is mostly who it will not talk to:
// nobody without the console's own token, nobody who has been guessing, and nobody at all while it is not switched on. And that it only
// reads: not one write reaches the database, whatever is sent.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const ahead = ms => new Date(NOW + ms).toISOString();
const TOKEN = 'ops-secret-token-value';
const ID = n => `a0a0a0a0-0000-4000-8000-${String(n).padStart(12, '0')}`;

const view = (n, over = {}) => ({
  restaurant_id: ID(n), name: `Restaurant ${n}`, slug: `restaurant-${n}`, city: 'Nagpur', phone: '9822012345',
  plan: 'pro', plan_status: 'active', trial_ends_at: null, current_period_end: ahead(20 * DAY), created_at: ago((100 - n) * DAY),
  subscription_status: 'active', subscription_plan: 'pro', subscription_cancel_requested_at: null, subscription_plan_change_to: null,
  subscription_period_end: ahead(20 * DAY), subscription_last_event_at: ago(10 * DAY),
  hub_seen_at: ago(2 * MIN), hub_reported_at: ago(2 * MIN), hub_started_at: ago(5 * HOUR), hub_version: '1.0.0',
  hub_queued: 0, hub_quarantined: 0, hub_last_synced_at: ago(3 * MIN), hub_devices: 3, hub_waiters: 5,
  last_invoice_at: ago(20 * MIN), invoices_7d: 140,
  ...over
});
const FLEET = () => [
  view(1, { name: 'Alpha' }),
  view(2, { name: 'Bravo', plan_status: 'past_due', plan: 'starter' }),
  view(3, { name: 'Charlie', hub_queued: 80 })
];
const event = (n, over = {}) => ({ id: `ev-${n}`, restaurant_id: ID(1), restaurant_name: 'Alpha', razorpay_subscription_id: 'sub_1', event: 'subscription.charged', applied_plan_status: 'active', received_at: ago(n * HOUR), ...over });

let dist;
const distDir = () => {
  if (!dist) {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'kullina-ops-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'ops.html'), '<!doctype html><title>Operator console</title><div id="root"></div>');
  }
  return dist;
};
process.on('exit', () => { if (dist) fs.rmSync(dist, { recursive: true, force: true }); });

async function serve(options = {}) {
  const { opsTenants = FLEET(), opsEvents = [], subscriptions = [], cloud, now = () => NOW, build = true, trustProxy, ...rest } = options;
  // An explicit undefined stays undefined: a default parameter would turn it back into the real token.
  const token = 'token' in options ? options.token : TOKEN;
  const db = cloud === undefined ? memoryCloud({ opsTenants, opsEvents, subscriptions }) : cloud;
  const server = http.createServer(createApp({
    cloud: db, razorpay: { configured: () => false }, env: {}, operatorToken: 'op', webhookSecret: 'w', opsToken: token, now,
    distDir: build ? distDir() : path.join(os.tmpdir(), 'kullina-no-such-build'), trustProxy, ...rest
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, p, headers = {}) => fetch(`${base}${p}`, { method, headers });
  const as = (secret = TOKEN, extra = {}) => ({ Authorization: `Bearer ${secret}`, ...extra });
  return {
    cloud: db, stop: () => new Promise(resolve => server.close(resolve)),
    get: (p, headers) => send('GET', p, headers),
    send,
    fleet: (secret, extra) => send('GET', '/ops/api/fleet', as(secret, extra)),
    tenant: (id, secret, extra) => send('GET', `/ops/api/tenants/${id}`, as(secret, extra)),
    as
  };
}
const json = r => r.json();
const quiet = async fn => {
  const lines = [];
  const w = console.warn, l = console.log, e = console.error;
  console.warn = console.log = console.error = (...a) => lines.push(a.join(' '));
  try { return [await fn(), lines]; } finally { console.warn = w; console.log = l; console.error = e; }
};

// --- while it is not switched on ------------------------------------------------------------------------------------------

test('with no token configured the console refuses everyone, whatever they send', async () => {
  for (const token of [undefined, '', null]) {
    const app = await serve({ token });
    try {
      for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: `Bearer ${TOKEN}` }, { Authorization: 'Bearer undefined' }, { Authorization: 'Bearer ' + String(token) }]) {
        const r = await app.get('/ops/api/fleet', headers);
        assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED'], `${String(token)} / ${JSON.stringify(headers)}`);
      }
      assert.equal((await app.get(`/ops/api/tenants/${ID(1)}`, app.as())).status, 503);
    } finally { await app.stop(); }
  }
});

test('with no database the console refuses too, rather than answering from nothing', async () => {
  const app = await serve({ cloud: null });
  try {
    const r = await app.fleet();
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED']);
  } finally { await app.stop(); }
});

test('a token too short to be a secret is no token at all: the console stays off, and the log says why without saying the token', async () => {
  for (const short of ['letmein', 'x'.repeat(19)]) {
    const [app, lines] = await quiet(() => serve({ token: short }));
    try {
      const r = await app.fleet(short);
      assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED'], short);
      assert.equal((await app.get('/ops')).status, 404);
      assert.equal((await json(await app.get('/health'))).ops, false);
      assert.match(lines.join('\n'), /OPS_TOKEN is too short/);
      assert.doesNotMatch(lines.join('\n'), new RegExp(short));
    } finally { await app.stop(); }
  }
  const exact = await serve({ token: 'x'.repeat(20) });
  try {
    assert.equal((await exact.fleet('x'.repeat(20))).status, 200, 'twenty is enough');
  } finally { await exact.stop(); }
});

test('the console\'s token must not be the one that creates restaurants: the same string for both leaves the console off, and the log says why without saying the token', async () => {
  const [app, lines] = await quiet(() => serve({ token: TOKEN, operatorToken: TOKEN }));
  try {
    const r = await app.fleet();
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_CONFIGURED']);
    assert.equal((await app.get('/ops')).status, 404);
    assert.equal((await json(await app.get('/health'))).ops, false);
    assert.match(lines.join('\n'), /OPS_TOKEN is the same as SIGNUP_OPERATOR_TOKEN/);
    assert.doesNotMatch(lines.join('\n'), new RegExp(TOKEN));
  } finally { await app.stop(); }
  const apart = await serve({ token: TOKEN, operatorToken: `${TOKEN}-different` });
  try {
    assert.equal((await apart.fleet()).status, 200, 'different tokens, both long: fine');
  } finally { await apart.stop(); }
});

test('what the log says about the console depends on what was set: nothing when it is on or was never asked for, and a reason when it was asked for and cannot be', async () => {
  const warnings = async options => {
    const [app, lines] = await quiet(() => serve(options));
    await app.stop();
    return lines.filter(line => line.includes('[ops]'));
  };
  assert.deepEqual(await warnings({}), [], 'on, with a good token');
  assert.deepEqual(await warnings({ token: undefined }), [], 'never asked for');
  assert.deepEqual(await warnings({ token: undefined, operatorToken: undefined }), [], 'neither token set');
  assert.deepEqual(await warnings({ token: '' }), [], 'an empty one is not set');
  assert.equal((await warnings({ token: 'short' })).length, 1, 'asked for with a token that is too short');
  assert.equal((await warnings({ token: TOKEN, operatorToken: TOKEN })).length, 1, 'asked for with the signup token');
  assert.deepEqual(await warnings({ cloud: null, token: 'short' }), [], 'with no database every request is refused whatever is said of the console');
  assert.deepEqual(await warnings({ cloud: null, token: TOKEN, operatorToken: TOKEN }), []);
});

test('the console reads OPS_TOKEN from the environment, and the token that creates restaurants does not open it', async () => {
  const statusWith = async env => {
    const server = http.createServer(createApp({ cloud: memoryCloud({ opsTenants: FLEET() }), razorpay: { configured: () => false }, env, operatorToken: 'op', webhookSecret: 'w', now: () => NOW, distDir: distDir() }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      return (await fetch(`http://127.0.0.1:${server.address().port}/ops/api/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status;
    } finally { await new Promise(resolve => server.close(resolve)); }
  };
  assert.equal(await statusWith({ OPS_TOKEN: TOKEN }), 200);
  assert.equal(await statusWith({ SIGNUP_OPERATOR_TOKEN: TOKEN }), 503);
  assert.equal(await statusWith({}), 503);
});

test('while it is switched off its page is not there either, and /health says whether it is on', async () => {
  const off = await serve({ token: undefined });
  const on = await serve();
  try {
    assert.equal((await off.get('/ops')).status, 404);
    assert.equal((await json(await off.get('/health'))).ops, false);
    assert.equal((await json(await on.get('/health'))).ops, true);
  } finally { await off.stop(); await on.stop(); }
});

// --- who is let in ----------------------------------------------------------------------------------------------------------

test('only the console\'s own token opens it: not nothing, not another token, not the operator\'s signup token, not a token in another shape', async () => {
  // Each try comes from an address of its own, so that it is the token being tested and not the lockout.
  const app = await serve({ trustProxy: true });
  let n = 0;
  const elsewhere = headers => ({ ...headers, 'X-Forwarded-For': `10.9.${Math.floor(n / 250)}.${(n += 1) % 250}` });
  try {
    for (const headers of [
      {}, { Authorization: '' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer op' },
      { Authorization: TOKEN }, { Authorization: `Basic ${TOKEN}` }, { Authorization: `x Bearer ${TOKEN}` }, { Authorization: `Bearer${TOKEN}` }, { Authorization: `Basic Bearer ${TOKEN}` }, { Authorization: `Token ${TOKEN}` }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `Bearer x${TOKEN}` },
      { Authorization: `Bearer ${TOKEN.toUpperCase()}` }
    ]) {
      for (const p of ['/ops/api/fleet', `/ops/api/tenants/${ID(1)}`]) {
        const r = await app.get(p, elsewhere(headers));
        assert.deepEqual([r.status, (await json(r)).code], [401, 'NOT_OPERATOR'], `${p} ${JSON.stringify(headers)}`);
      }
    }
  } finally { await app.stop(); }
});

test('a refusal says nothing about any restaurant', async () => {
  const app = await serve({ opsEvents: [event(1)] });
  try {
    const body = JSON.stringify(await json(await app.get('/ops/api/fleet', app.as('wrong'))));
    assert.doesNotMatch(body, /Alpha|Bravo|Restaurant|Nagpur|sub_1|restaurant_id|tenants/);
  } finally { await app.stop(); }
});

test('the right token opens it, and the word "bearer" may be in any case', async () => {
  const app = await serve();
  try {
    assert.equal((await app.fleet()).status, 200);
    assert.equal((await app.get('/ops/api/fleet', { Authorization: `bearer ${TOKEN}` })).status, 200);
    assert.equal((await app.get('/ops/api/fleet', { Authorization: `BEARER ${TOKEN}` })).status, 200);
  } finally { await app.stop(); }
});

test('someone guessing is turned away after ten wrong tries, even if their next try is right, and only they are', async () => {
  let now = NOW;
  const app = await serve({ trustProxy: true, now: () => now });
  try {
    const from = ip => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 10; i += 1) assert.equal((await app.fleet(`guess-${i}`, from('203.0.113.9'))).status, 401, `try ${i + 1}`);
    const blocked = await app.fleet(TOKEN, from('203.0.113.9'));
    assert.deepEqual([blocked.status, (await json(blocked)).code], [429, 'TOO_MANY'], 'the right token, but after ten wrong ones');
    assert.equal((await app.fleet('guess', from('203.0.113.9'))).status, 429, 'and a wrong one is not even looked at');
    assert.equal((await app.fleet(TOKEN, from('198.51.100.7'))).status, 200, 'somebody else is not affected');

    now += 15 * 60 * 1000 - 1;
    assert.equal((await app.fleet(TOKEN, from('203.0.113.9'))).status, 429, 'still, a moment before the window is over');
    now += 1;
    assert.equal((await app.fleet(TOKEN, from('203.0.113.9'))).status, 200, 'and let back in when it is');
  } finally { await app.stop(); }
});

test('the right token never counts as a failure, however often it is used; nine wrong ones and then a right one is still let in', async () => {
  const app = await serve({ trustProxy: true });
  try {
    const me = { 'X-Forwarded-For': '192.0.2.1' };
    for (let i = 0; i < 30; i += 1) assert.equal((await app.fleet(TOKEN, me)).status, 200);
    for (let i = 0; i < 10 - 1; i += 1) await app.fleet('guess', me);
    assert.equal((await app.fleet(TOKEN, me)).status, 200, 'nine wrong ones is not ten');
    assert.equal((await app.fleet('guess', me)).status, 401, 'the tenth is a wrong one like the rest');
    assert.equal((await app.fleet(TOKEN, me)).status, 429, 'and now there have been ten');
  } finally { await app.stop(); }
});

test('whoever the caller claims to be in a header is not believed unless a proxy is trusted', async () => {
  const app = await serve();
  try {
    for (let i = 0; i < 10; i += 1) await app.fleet(`guess-${i}`, { 'X-Forwarded-For': `203.0.113.${i}` });
    assert.equal((await app.fleet(TOKEN, { 'X-Forwarded-For': '198.51.100.99' })).status, 429, 'ten different "addresses" were one caller');
  } finally { await app.stop(); }
});

test('a wrong token is never written down, and neither is the right one', async () => {
  const app = await serve();
  try {
    const [, lines] = await quiet(async () => { await app.fleet('wrong-secret-value'); await app.fleet(TOKEN); });
    assert.doesNotMatch(lines.join('\n'), /wrong-secret-value|ops-secret-token-value/);
  } finally { await app.stop(); }
});

// --- the fleet ---------------------------------------------------------------------------------------------------------------------

test('the fleet: when it was read, how many of each, what needs attention, every restaurant worst first, and what has happened lately', async () => {
  const app = await serve({ opsEvents: [event(3), event(1, { id: 'ev-x', event: 'subscription.halted', applied_plan_status: 'past_due', restaurant_id: ID(2), restaurant_name: 'Bravo' })] });
  try {
    const r = await app.fleet();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await json(r);
    assert.equal(body.success, true);
    assert.equal(body.generated_at, '2026-10-24T12:00:00.000Z');
    assert.equal(body.truncated, false);
    assert.deepEqual(body.summary.by_status, { active: 2, trialing: 0, past_due: 1, suspended: 0, cancelled: 0, other: 0 });
    assert.equal(body.summary.tenants, 3);
    assert.deepEqual(body.summary.attention, { high: 1, medium: 1 });
    assert.deepEqual(body.tenants.map(t => t.name), ['Bravo', 'Charlie', 'Alpha'], 'worst first, then by name');
    assert.deepEqual(body.attention.map(a => [a.name, a.code]), [['Bravo', 'past_due'], ['Charlie', 'sync_backlog']]);
    assert.deepEqual(body.events.map(e => e.id), ['ev-x', 'ev-3'], 'newest first');
    assert.equal(body.events[0].restaurant_name, 'Bravo');
    const bravo = body.tenants[0];
    assert.deepEqual([bravo.id, bravo.plan, bravo.plan_status, bravo.severity, bravo.hub.state], [ID(2), 'starter', 'past_due', 'high', 'live']);
  } finally { await app.stop(); }
});

test('an empty fleet is an empty fleet', async () => {
  const app = await serve({ opsTenants: [] });
  try {
    const body = await json(await app.fleet());
    assert.deepEqual([body.tenants, body.attention, body.events, body.summary.tenants, body.truncated], [[], [], [], 0, false]);
  } finally { await app.stop(); }
});

test('only the columns the console shows leave the service: not a pairing code, a hash, a payment link or an event\'s payload', async () => {
  const app = await serve({
    opsTenants: [view(1, { pairing_code: 'MJW-7492', hub_provisioning_secret_hash: '$2a$secret', settings: { a: 1 }, short_url: 'https://rzp.io/secret' })],
    opsEvents: [event(1, { payload: { customer: { email: 'someone@example.test' } } })]
  });
  try {
    const text = JSON.stringify(await json(await app.fleet()));
    assert.doesNotMatch(text, /MJW-7492|\$2a\$|secret|rzp\.io|someone@example|payload|settings/);
  } finally { await app.stop(); }
});

test('only the newest thirty events come with the fleet', async () => {
  const many = Array.from({ length: 45 }, (_, i) => event(i + 1, { id: `ev-${i + 1}` }));
  const app = await serve({ opsEvents: many });
  try {
    const { events } = await json(await app.fleet());
    assert.equal(events.length, 30);
    assert.equal(events[0].id, 'ev-1');
    assert.equal(events.at(-1).id, 'ev-30');
  } finally { await app.stop(); }
});

test('more restaurants than one answer can hold are cut at the limit, and it says so', async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => view(i + 1));
  const app = await serve({ opsTenants: rows });
  try {
    const body = await json(await app.fleet());
    assert.equal(body.tenants.length, 1000);
    assert.equal(body.truncated, true);
    assert.equal(body.summary.tenants, 1000);
  } finally { await app.stop(); }
  const exact = await serve({ opsTenants: rows.slice(0, 999) });
  try {
    assert.equal((await json(await exact.fleet())).truncated, false, 'one short of the limit is the whole fleet');
  } finally { await exact.stop(); }
  const full = await serve({ opsTenants: rows.slice(0, 1000) });
  try {
    assert.equal((await json(await full.fleet())).truncated, true, 'exactly the limit might be more, so it says so');
  } finally { await full.stop(); }
});

test('when the list is cut it is the oldest restaurants that are left out, not any at random', async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => view(i + 1, { created_at: ago((2000 - i) * DAY) }));
  // Oldest first, so that taking the first thousand as they come would keep the wrong ones.
  const app = await serve({ opsTenants: rows });
  try {
    const names = new Set((await json(await app.fleet())).tenants.map(t => t.name));
    assert.equal(names.has('Restaurant 1005'), true);
    assert.equal(names.has('Restaurant 6'), true);
    assert.equal(names.has('Restaurant 5'), false);
    assert.equal(names.has('Restaurant 1'), false);
  } finally { await app.stop(); }
});

test('the database failing is "try again", in our words and not the database\'s', async () => {
  const failures = { select: { ops_tenants: { message: 'relation "public.ops_tenants" does not exist; password=hunter2', code: '42P01' } } };
  const app = await serve({ cloud: memoryCloud({ opsTenants: FLEET(), failures }) });
  try {
    const [r, lines] = await quiet(() => app.fleet());
    assert.equal(r.status, 502);
    const body = await json(r);
    assert.deepEqual([body.success, body.code], [false, 'CLOUD']);
    assert.doesNotMatch(JSON.stringify(body), /relation|hunter2|ops_tenants/);
    assert.match(lines.join('\n'), /ops_tenants/, 'but the real reason is written down for the operator');
    assert.doesNotMatch(lines.join('\n'), new RegExp(TOKEN));
  } finally { await app.stop(); }
  const eventsDown = await serve({ cloud: memoryCloud({ opsTenants: FLEET(), failures: { select: { ops_events: { message: 'boom', code: 'X' } } } }) });
  try {
    const [r] = await quiet(() => eventsDown.fleet());
    assert.equal(r.status, 502, 'half a picture is not shown as the whole');
  } finally { await eventsDown.stop(); }
});

// --- one restaurant ----------------------------------------------------------------------------------------------------------------

const sub = (n, over = {}) => ({
  restaurant_id: ID(1), razorpay_subscription_id: `sub_${n}`, status: 'active', plan: 'pro', plan_change_to: null, cancel_requested_at: null,
  current_start: ago(10 * DAY), current_end: ahead(20 * DAY), last_event_at: ago(DAY), created_at: ago(n * DAY), short_url: 'https://rzp.io/secret', razorpay_customer_id: 'cust_1', ...over
});

test('one restaurant: its row, its subscriptions newest first, and its own events, and no one else\'s', async () => {
  const app = await serve({
    subscriptions: [sub(5), sub(1), sub(3), sub(2, { restaurant_id: ID(2) })],
    opsEvents: [event(2), event(1, { restaurant_id: ID(2), restaurant_name: 'Bravo', id: 'ev-theirs' }), event(4, { id: 'ev-4' })]
  });
  try {
    const r = await app.tenant(ID(1));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await json(r);
    assert.equal(body.success, true);
    assert.equal(body.generated_at, '2026-10-24T12:00:00.000Z');
    assert.deepEqual([body.tenant.id, body.tenant.name, body.tenant.hub.state], [ID(1), 'Alpha', 'live']);
    assert.deepEqual(body.subscriptions.map(s => s.razorpay_subscription_id), ['sub_1', 'sub_3', 'sub_5'], 'newest first, and not Bravo\'s');
    assert.deepEqual(body.events.map(e => e.id), ['ev-2', 'ev-4'], 'its own, newest first, and not Bravo\'s');
    assert.doesNotMatch(JSON.stringify(body), /rzp\.io|cust_1/, 'no payment link, no customer');
  } finally { await app.stop(); }
});

test('only the newest few subscriptions and events of a restaurant are returned', async () => {
  const app = await serve({
    subscriptions: Array.from({ length: 30 }, (_, i) => sub(i + 1, { razorpay_subscription_id: `sub_${i + 1}` })),
    opsEvents: Array.from({ length: 70 }, (_, i) => event(i + 1, { id: `ev-${i + 1}` }))
  });
  try {
    const body = await json(await app.tenant(ID(1)));
    assert.equal(body.subscriptions.length, 20);
    assert.equal(body.events.length, 50);
    assert.deepEqual([body.subscriptions[0].razorpay_subscription_id, body.subscriptions.at(-1).razorpay_subscription_id], ['sub_1', 'sub_20']);
    assert.deepEqual([body.events[0].id, body.events.at(-1).id], ['ev-1', 'ev-50']);
  } finally { await app.stop(); }
});

test('a restaurant that is not there, and something that is not a restaurant\'s number, are both "not found"', async () => {
  const app = await serve();
  try {
    for (const id of [ID(99), 'abc', 'r-uuid', '..%2Ffleet', `${ID(1)}x`, ID(1).toUpperCase().slice(0, 30), encodeURIComponent("1'; drop table restaurants; --"), '%00']) {
      const r = await app.tenant(id);
      assert.deepEqual([r.status, (await json(r)).code], [404, 'NOT_FOUND'], id);
    }
  } finally { await app.stop(); }
});

test('an id that is not a plain id never reaches the database', async () => {
  const app = await serve();
  try {
    for (const id of ['not-an-id', `${ID(1)}x`, `x${ID(1)}`, 'abcdefabcdefabcdefabcdefabcdefabcdef', '-'.repeat(36), ID(1).replace(/-/g, '').padEnd(36, '0'), ID(1).toUpperCase()]) await app.tenant(id);
    assert.equal(app.cloud.calls.selects.length, 0);
    await app.tenant(ID(99));
    assert.ok(app.cloud.calls.selects.length > 0, 'and a well-formed one does');
  } finally { await app.stop(); }
});

test('it asks the database only for the columns it shows: the payment link and the customer of a subscription are not asked for at all', async () => {
  const app = await serve({ subscriptions: [sub(1)] });
  try {
    await app.tenant(ID(1));
    const asked = app.cloud.calls.selects.find(call => call.table === 'subscriptions').columns;
    assert.doesNotMatch(asked, /\*|short_url|razorpay_customer_id|razorpay_plan_id/);
    assert.match(asked, /razorpay_subscription_id/);
  } finally { await app.stop(); }
});

test('one restaurant\'s page fails whole if any part of it cannot be read: its row, its subscriptions or its events', async () => {
  for (const table of ['ops_tenants', 'subscriptions', 'ops_events']) {
    const app = await serve({ cloud: memoryCloud({ opsTenants: FLEET(), failures: { select: { [table]: { message: 'boom', code: 'X' } } } }) });
    try {
      const [r] = await quiet(() => app.tenant(ID(1)));
      assert.deepEqual([r.status, (await json(r)).code], [502, 'CLOUD'], table);
    } finally { await app.stop(); }
  }
});

// --- it only reads ------------------------------------------------------------------------------------------------------------------

test('it only reads: nothing sent to it, in any way, writes to the database', async () => {
  const app = await serve({ opsEvents: [event(1)], subscriptions: [sub(1)] });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of ['/ops/api/fleet', `/ops/api/tenants/${ID(1)}`, '/ops/api/tenants', '/ops/api']) {
        const r = await app.send(method, p, app.as());
        assert.equal(r.status, 404, `${method} ${p}`);
      }
    }
    await app.fleet(); await app.tenant(ID(1));
    const { inserts, updates, upserts, deletes, rpc } = app.cloud.calls;
    assert.deepEqual([inserts.length, updates.length, upserts.length, deletes.length, rpc.length], [0, 0, 0, 0, 0]);
  } finally { await app.stop(); }
});

test('a request that is not signed in is refused before the method matters', async () => {
  const app = await serve();
  try {
    assert.equal((await app.send('POST', '/ops/api/fleet')).status, 401);
    assert.equal((await app.send('DELETE', `/ops/api/tenants/${ID(1)}`)).status, 401);
  } finally { await app.stop(); }
});

test('what the console answers can be kept by nobody: no caching, no sniffing, on a refusal as on an answer', async () => {
  const app = await serve();
  try {
    for (const r of [await app.fleet(), await app.fleet('wrong'), await app.tenant(ID(1)), await app.tenant('nope')]) {
      assert.equal(r.headers.get('cache-control'), 'no-store', String(r.status));
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', String(r.status));
    }
  } finally { await app.stop(); }
});

// --- the page ----------------------------------------------------------------------------------------------------------------------

test('the page is served at /ops with a policy that allows no inline script, and is kept out of search and out of caches', async () => {
  const app = await serve();
  try {
    for (const p of ['/ops', '/ops/']) {
      const r = await app.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(await r.text(), /Operator console/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
      const csp = r.headers.get('content-security-policy');
      assert.equal(csp.split(';').map(s => s.trim()).find(d => d.startsWith('script-src')), "script-src 'self'", 'no inline script, no outside script');
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
  } finally { await app.stop(); }
});

test('the page is only at /ops: not under it, not by its file name', async () => {
  const app = await serve();
  try {
    for (const p of ['/ops/other', '/ops/api', '/ops.html', '/ops/index.html', '/ops/%2e%2e/etc']) {
      const r = await app.get(p);
      assert.ok([401, 404].includes(r.status), `${p} is ${r.status}`);
      assert.doesNotMatch(await r.text(), /Operator console/, p);
    }
  } finally { await app.stop(); }
});

test('a service whose build is missing says so rather than showing a blank page', async () => {
  const app = await serve({ build: false });
  try {
    const r = await app.get('/ops');
    assert.equal(r.status, 503);
    assert.match(await r.text(), /npm run build/);
  } finally { await app.stop(); }
});

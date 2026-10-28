import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { cloudDb } from './helpers/cloudDb.mjs';
import { createAdminApp, ROUTES, auditFilters } from '../../admin_api/lib/app.js';
import { makeAdminDb } from '../../admin_api/lib/db.js';
import { hsKeys } from '../../admin_api/lib/keys.js';
import { SECURITY_HEADERS } from '../../admin_api/lib/security.js';

// The admin API over HTTP, against the real migration on a real Postgres engine (PGlite). What matters here: nobody gets in without a verified
// token and a second factor; the API does nothing it is not listed as doing; every answer says when it was read; a failed read shows an error
// and not the last answer; and what it returns has nothing in it a restaurant could be impersonated with.

const SECRET = 'k'.repeat(48);
const ORIGIN = 'https://admin.kullina.example';
let clock = Date.parse('2026-10-26T10:00:00Z');
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const F2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let cloud;
let T;
let server;
let base;
let sweepAlertId;

const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function token(sub, over = {}, secret = SECRET) {
  const sec = Math.floor(clock / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, aal: 'aal2', aud: 'authenticated', role: 'authenticated', iat: sec - 10, exp: sec + 900, email: 'x@example.test', ...over });
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const founder = (over) => token(F1, over);

const config = (over = {}) => ({ webOrigins: [ORIGIN], ipAllowlist: [], trustProxy: 0, audience: 'authenticated', issuer: undefined, ...over });
const quiet = { warn() {}, error() {}, log() {} };
const realDb = () => makeAdminDb({ transaction: fn => cloud.pg.transaction(fn) });

async function serve(app) {
  const s = await new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}
const stop = s => new Promise(resolve => s.close(resolve));

async function call(method, path, { tok, headers = {}, url = base, body } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body,
    redirect: 'manual'
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}
const get = (path, opts) => call('GET', path, opts);
const q = (sql, params) => cloud.pg.query(sql, params);
const rows = async (sql, params) => (await q(sql, params)).rows;
const spineCount = async () => (await rows(`SELECT count(*)::int AS n FROM public.tenant_events`))[0].n;

/** An alert, opened the way the worker opens one (as the database's owner here: the worker's own door is tested in alertsSchema and alertWorker). */
const openAlert = async (rule, restaurant, detail = {}, severity = { orders_shelved: 'P1', hub_silent_service: 'P1', sync_backlog: 'P2', payment_past_due: 'P2', service_hours_missing: 'P3' }[rule]) => {
  const item = { restaurant_id: restaurant, rule_key: rule, severity, dedupe_key: `${rule}:${restaurant}`, detail };
  const out = (await q(`SELECT public.alert_apply($1::jsonb, '[]'::jsonb, '[]'::jsonb, 'api-test') AS r`, [JSON.stringify([item])])).rows[0].r;
  return out.opened[0] ?? null;
};
const clearAlerts = () => q(`DELETE FROM public.alerts`);

before(async () => {
  cloud = await cloudDb();
  await q(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  for (const [id, email] of [[F1, 'aman@example.test'], [F2, 'darshil@example.test'], [OWNER_A, 'owner-a@example.test'], [GONE, 'gone@example.test']]) {
    await q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  }
  await q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  await q(`SELECT public.seed_admin_user('aman@example.test', 'Aman')`);
  await q(`SELECT public.seed_admin_user('darshil@example.test', 'Darshil')`);
  await q(`SELECT public.deactivate_admin_user('darshil@example.test', 'left the company, access removed')`);
  await q(`SELECT public.seed_admin_user('gone@example.test', 'Gone')`);
  await q(`SELECT public.deactivate_admin_user('gone@example.test', 'only here to be inactive')`);
  sweepAlertId = (await openAlert('orders_shelved', T.A.restaurant, { count: 1 })).id;
  const served = await serve(createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
  server = served.server;
  base = served.url;
});
after(async () => { if (server) await stop(server); await cloud?.close(); });

// Wrong tries are counted per address in a window; every test starts in a fresh one, so what one test does cannot turn the next away.
const NEW_WINDOW = 16 * 60 * 1000;
beforeEach(() => { clock += NEW_WINDOW; });

const API = ['/api/me', '/api/audit', '/api/audit.csv', '/api/audit/verify', '/api/fleet', `/api/tenants/${'a0a0a0a0-0000-4000-8000-000000000001'}`, '/api/alerts', `/api/tenants/${'a0a0a0a0-0000-4000-8000-000000000001'}/timeline`];

// --- who gets in ---------------------------------------------------------------------------------------------------------------

test('without a token every /api route says to sign in, and says nothing about why', async () => {
  for (const path of API) {
    const r = await get(path);
    assert.equal(r.status, 401, path);
    assert.equal(r.json.code, 'UNAUTHENTICATED');
  }
  assert.equal((await call('POST', '/api/session')).status, 401);
});

test('a bad token of any kind gets the same answer, so a guesser learns nothing from it', async () => {
  const sec = Math.floor(clock / 1000);
  const bad = [
    'garbage', 'a.b.c', token(F1, {}, 'z'.repeat(48)), founder({ exp: sec - 600 }), founder({ aud: 'anon' }), founder({ exp: undefined }),
    `${b64({ alg: 'none' })}.${b64({ sub: F1, aal: 'aal2', aud: 'authenticated', exp: sec + 900 })}.`
  ];
  const bodies = new Set();
  for (const tok of bad) {
    const r = await get('/api/me', { tok });
    assert.equal(r.status, 401, tok.slice(0, 20));
    bodies.add(r.text);
  }
  assert.equal(bodies.size, 1, 'every refusal reads the same');
});

test('a token in the address is never read, only one in the Authorization header', async () => {
  const tok = founder();
  assert.equal((await get(`/api/me?access_token=${tok}`)).status, 401);
  assert.equal((await get(`/api/me?token=${tok}`)).status, 401);
  assert.equal((await get('/api/me', { headers: { Cookie: `sb-access-token=${tok}` } })).status, 401);
  assert.equal((await get('/api/me', { headers: { Authorization: `Basic ${tok}` } })).status, 401);
  assert.equal((await get('/api/me', { headers: { Authorization: `Bearer ${tok} extra` } })).status, 401);
  assert.equal((await get('/api/me', { headers: { Authorization: `bearer ${tok}` } })).status, 200, 'the scheme is not case sensitive');
});

test('a founder who has not used their second factor is told to, and is not let in', async () => {
  for (const aal of ['aal1', undefined, 'AAL2', '']) {
    const r = await get('/api/me', { tok: founder({ aal }) });
    assert.equal(r.status, 403, String(aal));
    assert.equal(r.json.code, 'MFA_REQUIRED');
  }
  assert.equal((await get('/api/fleet', { tok: founder({ aal: 'aal1' }) })).status, 403);
});

test('(a) a tenant\'s owner, a hub and a deactivated founder get "administrators only" from every route, with a valid token and MFA', async () => {
  for (const sub of [OWNER_A, T.A.user, GONE, F2, '99999999-9999-4999-8999-999999999999']) {
    clock += NEW_WINDOW;   // each refusal is a wrong try; this checks every route for each person, so they get a window each
    for (const path of API.slice(0, 3)) {
      const r = await get(path, { tok: token(sub) });
      assert.equal(r.status, 403, `${sub} ${path}`);
      assert.equal(r.json.code, 'ADMIN_ONLY');
    }
    clock += NEW_WINDOW;
    for (const path of API.slice(3)) {
      const r = await get(path, { tok: token(sub) });
      assert.equal(r.status, 403, `${sub} ${path}`);
      assert.equal(r.json.code, 'ADMIN_ONLY');
    }
    assert.equal((await call('POST', '/api/session', { tok: token(sub) })).status, 403);
  }
});

test('a founder is let in and told who they are, and when this was read', async () => {
  const r = await get('/api/me', { tok: founder() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.user, { id: F1, email: 'aman@example.test', display_name: 'Aman', role: 'founder' });
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
});

test('wrong tries from one address turn it away, even with a good token afterwards, and only that address', async () => {
  const app = createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ trustProxy: 1 }), now: () => clock, log: quiet });
  const s = await serve(app);
  try {
    const from = ip => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 10; i++) assert.equal((await get('/api/me', { url: s.url, tok: 'bad', headers: from('203.0.113.50') })).status, 401);
    const blocked = await get('/api/me', { url: s.url, tok: founder(), headers: from('203.0.113.50') });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.code, 'TOO_MANY');
    assert.equal((await get('/api/me', { url: s.url, tok: founder(), headers: from('203.0.113.51') })).status, 200, 'another address is not affected');
    clock += 16 * 60 * 1000;
    assert.equal((await get('/api/me', { url: s.url, tok: founder(), headers: from('203.0.113.50') })).status, 200, 'and a while later it is let back');
  } finally { await stop(s.server); }
});

test('being refused by the database counts as a wrong try too', async () => {
  const app = createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ trustProxy: 1 }), now: () => clock, log: quiet });
  const s = await serve(app);
  try {
    for (let i = 0; i < 10; i++) assert.equal((await get('/api/me', { url: s.url, tok: token(OWNER_A), headers: { 'X-Forwarded-For': '203.0.113.60' } })).status, 403);
    assert.equal((await get('/api/me', { url: s.url, tok: founder(), headers: { 'X-Forwarded-For': '203.0.113.60' } })).status, 429);
  } finally { await stop(s.server); }
});

// --- the address allowlist, headers and origin ---------------------------------------------------------------------------------------

test('with an address allowlist, any other address is told nothing exists, token or not, even at the health check', async () => {
  const app = createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ trustProxy: 1, ipAllowlist: ['203.0.113.7', '198.51.100.0/24'] }), now: () => clock, log: quiet });
  const s = await serve(app);
  try {
    for (const path of ['/healthz', '/api/me', '/']) {
      const r = await get(path, { url: s.url, tok: founder(), headers: { 'X-Forwarded-For': '192.0.2.99' } });
      assert.equal(r.status, 404, path);
      assert.equal(r.json.code, 'NOT_FOUND');
    }
    assert.equal((await get('/api/me', { url: s.url, tok: founder(), headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200);
    assert.equal((await get('/api/me', { url: s.url, tok: founder(), headers: { 'X-Forwarded-For': '198.51.100.200' } })).status, 200);
    assert.equal((await call('OPTIONS', '/api/me', { url: s.url, headers: { Origin: ORIGIN, 'X-Forwarded-For': '192.0.2.99' } })).status, 404, 'not even a preflight');
  } finally { await stop(s.server); }
});

test('a forwarded address is believed only when a proxy is trusted', async () => {
  const app = createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ trustProxy: 0, ipAllowlist: ['203.0.113.7'] }), now: () => clock, log: quiet });
  const s = await serve(app);
  try {
    const r = await get('/api/me', { url: s.url, tok: founder(), headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal(r.status, 404, 'a caller cannot claim to be an allowed address');
  } finally { await stop(s.server); }
});

test('every answer carries the security headers, success or refusal, and a request id', async () => {
  const answers = [
    await get('/healthz'), await get('/api/me'), await get('/api/me', { tok: founder() }), await get('/api/me', { tok: token(OWNER_A) }),
    await get('/nope'), await get('/api/audit?limit=abc', { tok: founder() }), await get('/api/audit.csv', { tok: founder() })
  ];
  for (const r of answers) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, `${r.status} ${k}`);
    assert.match(r.headers.get('x-request-id'), /^[A-Za-z0-9._-]{1,64}$/);
    assert.equal(r.headers.get('x-powered-by'), null);
  }
});

test('a caller\'s request id is kept if it is plain and replaced if not', async () => {
  assert.equal((await get('/healthz', { headers: { 'X-Request-Id': 'req-42' } })).headers.get('x-request-id'), 'req-42');
  const odd = (await get('/healthz', { headers: { 'X-Request-Id': 'has space;<script>' } })).headers.get('x-request-id');
  assert.match(odd, /^[A-Za-z0-9-]{36}$/);
});

test('only the configured web origin may read an answer, and a preflight needs no token', async () => {
  const ok = await get('/api/me', { tok: founder(), headers: { Origin: ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('vary'), 'Origin');
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  for (const origin of ['https://evil.example', 'null', 'http://admin.kullina.example']) {
    const r = await get('/api/me', { tok: founder(), headers: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
  }
  const pre = await call('OPTIONS', '/api/audit', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const evil = await call('OPTIONS', '/api/audit', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 204);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('the health check needs no token and no database', async () => {
  const broken = createAdminApp({ db: { asAdmin: async () => { throw new Error('down'); } }, keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet });
  const s = await serve(broken);
  try {
    const r = await get('/healthz', { url: s.url });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally { await stop(s.server); }
});

// --- default-deny: the pinned list of routes --------------------------------------------------------------------------------------------

test('the routes are exactly the pinned list', () => {
  assert.deepEqual([...ROUTES], [
    'GET /healthz', 'GET /api/me', 'POST /api/session', 'GET /api/audit', 'GET /api/audit.csv', 'GET /api/audit/verify', 'GET /api/fleet', 'GET /api/tenants/:id',
    'GET /api/alerts', 'POST /api/alerts/:id/ack', 'POST /api/alerts/:id/resolve', 'GET /api/tenants/:id/timeline'
  ]);
});

test('every route the app really has is on the list, and nothing else answers', async () => {
  // A restaurant's id is a UUID and an alert's is a number, so each route is asked about the kind of thing it is about.
  const sample = p => p.replace(':id', p.startsWith('/api/alerts') ? String(sweepAlertId) : 'a0a0a0a0-0000-4000-8000-000000000001');
  for (const entry of ROUTES) {
    const [method, path] = entry.split(' ');
    const r = await call(method, sample(path), { tok: founder() });
    assert.notEqual(r.status, 404, `${entry} should exist`);
  }
  // Every other method on every listed path, and a spread of paths that are not listed, are absent for a signed-in founder.
  for (const entry of ROUTES) {
    const [method, path] = entry.split(' ');
    for (const other of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      if (ROUTES.includes(`${other} ${path}`)) continue;
      const r = await call(other, sample(path), { tok: founder(), body: other === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 404, `${other} ${path} should not exist`);
    }
  }
  for (const path of ['/', '/api', '/api/', '/admin', '/ops', '/api/users', '/api/admin', '/api/tenants', '/api/tenants/x/y', '/api/audit/export', '/api/audit/../fleet/x', '/api/commands', '/api/plan', '/.env', '/api/me/../x', '//api/me']) {
    const r = await get(path, { tok: founder() });
    assert.ok([404].includes(r.status), `${path} answered ${r.status}`);
  }
});

test('an unknown /api path asks for a token first, so it cannot be used to find out what exists', async () => {
  assert.equal((await get('/api/commands')).status, 401);
  assert.equal((await get('/api/commands', { tok: token(OWNER_A) })).status, 404, 'a tenant\'s owner gets the same "nothing here" a founder does');
});

test('a request body is never read: a broken one changes nothing', async () => {
  const r = await call('POST', '/api/session', { tok: founder(), headers: { 'Content-Type': 'application/json' }, body: '{this is not json' });
  assert.equal(r.status, 200);
  const big = await call('POST', '/api/session', { tok: founder(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(200000) }) });
  assert.equal(big.status, 200);
});

test('a token must be for the audience the API was set up with', async () => {
  const s = await serve(createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ audience: 'kullina-admin' }), now: () => clock, log: quiet }));
  try {
    assert.equal((await get('/api/me', { url: s.url, tok: founder() })).status, 401, 'an ordinary signed-in token is not for this audience');
    assert.equal((await get('/api/me', { url: s.url, tok: founder({ aud: 'kullina-admin' }) })).status, 200);
  } finally { await stop(s.server); }
});

test('reading changes nothing; the writes are the record that a founder signed in and an alert being acknowledged or resolved, and no restaurant\'s data moves', async () => {
  const before = await spineCount();
  const tok = founder();
  for (const entry of ROUTES.filter(r => r.startsWith('GET') && !r.includes('healthz'))) {
    await get(entry.split(' ')[1].replace(':id', T.A.restaurant), { tok });
  }
  assert.equal(await spineCount(), before, 'reading changes nothing');
  const tenantTables = ['invoices', 'orders', 'menu_items', 'reconciliations', 'restaurants', 'subscriptions'];
  const counts = async () => Promise.all(tenantTables.map(async t => (await rows(`SELECT count(*)::int AS n FROM public.${t}`))[0].n));
  const tenantsBefore = await counts();
  const r = await call('POST', '/api/session', { tok });
  assert.equal(r.status, 200);
  assert.equal(await spineCount(), before + 1);
  assert.deepEqual(await counts(), tenantsBefore, 'and no restaurant data moved');
});

// --- signing in is on the record ---------------------------------------------------------------------------------------------------------

test('signing in is recorded against the person, with the request id, and each sign-in is its own event', async () => {
  const a = await call('POST', '/api/session', { tok: founder(), headers: { 'X-Request-Id': 'signin-1' } });
  const b = await call('POST', '/api/session', { tok: founder() });
  assert.equal(a.status, 200);
  assert.notEqual(a.json.event_id, b.json.event_id);
  const [e] = await rows(`SELECT * FROM public.tenant_events WHERE id = $1`, [a.json.event_id]);
  assert.deepEqual([e.type, e.source, e.actor_type, e.actor_id, e.restaurant_id, e.request_id], ['admin.signin', 'admin', 'admin', F1, null, 'signin-1']);
  const [f] = await rows(`SELECT request_id FROM public.tenant_events WHERE id = $1`, [b.json.event_id]);
  assert.match(f.request_id, /^[A-Za-z0-9-]{36}$/, 'with no id supplied, one was made');
});

test('a refused sign-in is not recorded as one', async () => {
  const before = await spineCount();
  assert.equal((await call('POST', '/api/session', { tok: token(OWNER_A) })).status, 403);
  assert.equal((await call('POST', '/api/session', { tok: founder({ aal: 'aal1' }) })).status, 403);
  assert.equal((await call('POST', '/api/session')).status, 401);
  assert.equal(await spineCount(), before);
});

// --- the audit log -----------------------------------------------------------------------------------------------------------------------

test('the audit log lists events newest first with the person and restaurant named, as of now', async () => {
  await q(`SELECT public.record_tenant_event($1, 'admin', 'audit.api', 'admin', $2, 'r-1', '{"n":1}'::jsonb)`, [T.A.restaurant, F1]);
  const r = await get('/api/audit?limit=5', { tok: founder() });
  assert.equal(r.status, 200);
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  assert.ok(r.json.events.length >= 1 && r.json.events.length <= 5);
  const e = r.json.events.find(x => x.type === 'audit.api');
  assert.deepEqual([e.restaurant_name, e.actor_email, e.request_id, e.payload, e.source], ['Restaurant A', 'aman@example.test', 'r-1', { n: 1 }, 'admin']);
  assert.deepEqual(Object.keys(e).sort(), ['actor_email', 'actor_id', 'actor_type', 'chain_seq', 'id', 'occurred_at', 'payload', 'request_id', 'restaurant_id', 'restaurant_name', 'row_hash', 'source', 'type']);
  assert.equal(typeof e.id, 'number');
  assert.ok(r.json.events.every((x, i, all) => i === 0 || all[i - 1].id > x.id));
});

test('the filters narrow the log', async () => {
  await q(`SELECT public.record_tenant_event($1, 'razorpay', 'audit.filter.b', 'webhook', NULL, NULL, '{}'::jsonb)`, [T.B.restaurant]);
  const tok = founder();
  const byType = await get('/api/audit?type=audit.filter.b', { tok });
  assert.deepEqual(byType.json.events.map(e => e.type), ['audit.filter.b']);
  const byTenant = await get(`/api/audit?restaurant_id=${T.B.restaurant.toUpperCase()}`, { tok });
  assert.ok(byTenant.json.events.length && byTenant.json.events.every(e => e.restaurant_id === T.B.restaurant));
  const bySource = await get('/api/audit?source=razorpay', { tok });
  assert.ok(bySource.json.events.length && bySource.json.events.every(e => e.source === 'razorpay'));
  const byActor = await get(`/api/audit?actor_id=${F1}`, { tok });
  assert.ok(byActor.json.events.length && byActor.json.events.every(e => e.actor_id === F1));
  assert.equal((await get('/api/audit?from=2999-01-01', { tok })).json.events.length, 0);
  assert.equal((await get('/api/audit?to=2000-01-01', { tok })).json.events.length, 0);
  const window = await get(`/api/audit?from=2000-01-01&to=2999-01-01&type=audit.filter.b`, { tok });
  assert.equal(window.json.events.length, 1);
});

test('the log pages: a full page says where the next one starts, and a short one says there is none', async () => {
  const tok = founder();
  const first = await get('/api/audit?limit=3', { tok });
  assert.equal(first.json.events.length, 3);
  assert.equal(first.json.next_before, first.json.events[2].id);
  const second = await get(`/api/audit?limit=3&before=${first.json.next_before}`, { tok });
  assert.ok(second.json.events.every(e => e.id < first.json.next_before));
  const all = await get('/api/audit?limit=500', { tok });
  assert.equal(all.json.next_before, all.json.events.length === 500 ? all.json.events[499].id : null);
  const none = await get('/api/audit?type=no.such.type', { tok });
  assert.deepEqual([none.json.events, none.json.next_before], [[], null]);
});

test('the limit is capped at 500 and defaults to 100, and a repeated parameter uses the last', async () => {
  await q(`SELECT public.record_tenant_event(NULL, 'system', 'cap.many', 'system', NULL, NULL, '{}'::jsonb) FROM generate_series(1, 520)`);
  const tok = founder();
  assert.equal((await get('/api/audit?type=cap.many&limit=100000', { tok })).json.events.length, 500);
  assert.equal((await get('/api/audit?type=cap.many', { tok })).json.events.length, 100);
  assert.equal((await get('/api/audit?type=cap.many&limit=7&limit=2', { tok })).json.events.length, 2);
});

test('a filter that is not understood is a 400 that names it, not a guess', async () => {
  const tok = founder();
  for (const [query, word] of [
    ['restaurant_id=abc', 'restaurant_id'], ['actor_id=1', 'actor_id'], ['type=a%20b', 'type'], ['type=%3Cscript%3E', 'type'], ['source=bogus', 'source'],
    ['from=yesterday', 'from'], ['to=5', 'to'], ['before=0', 'before'], ['before=abc', 'before'], ['before=-1', 'before'], ['limit=0', 'limit'],
    ['limit=abc', 'limit'], ['limit=-5', 'limit'], ['limit=1e3', 'limit']
  ]) {
    const r = await get(`/api/audit?${query}`, { tok });
    assert.equal(r.status, 400, query);
    assert.equal(r.json.code, 'BAD_REQUEST');
    assert.match(r.json.error, new RegExp(word), query);
  }
});

test('the filters are also checked without a server', () => {
  assert.deepEqual(auditFilters({}).filters, { restaurant: null, type: null, source: null, actor: null, from: null, to: null, before: null, limit: 100 });
  assert.equal(auditFilters({}, { defaultLimit: 500 }).filters.limit, 500);
  assert.equal(auditFilters({ limit: '501' }).filters.limit, 500);
  assert.equal(auditFilters({ from: '2026-10-26' }).filters.from, '2026-10-26T00:00:00.000Z');
  assert.ok(auditFilters({ limit: '0' }).error);
});

test('the audit log as a file: a CSV with a name that carries the date, the right columns, and nothing a spreadsheet would run', async () => {
  await q(`UPDATE public.restaurants SET name = '=HYPERLINK("http://evil.example")' WHERE id = $1`, [T.B.restaurant]);
  await q(`SELECT public.record_tenant_event($1, 'admin', 'csv.check', 'admin', $2, NULL, '{"note":"a,b"}'::jsonb)`, [T.B.restaurant, F1]);
  const r = await get('/api/audit.csv?type=csv.check', { tok: founder() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="kullina-audit-2026-10-26.csv"');
  const lines = r.text.split('\r\n');
  assert.equal(lines[0], 'Event,When (UTC),Restaurant,Restaurant id,Source,Type,Actor type,Actor,Actor id,Request,Details');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes(`,"'=HYPERLINK(`), `the name was made safe: ${lines[1]}`);
  assert.ok(lines[1].includes('"{""note"":""a,b""}"'));
  assert.ok(!lines[1].includes(',=HYPERLINK'));
  assert.equal((await get('/api/audit.csv?limit=abc', { tok: founder() })).status, 400);
  assert.equal((await get('/api/audit.csv')).status, 401);
});

test('the file holds up to 500 rows by default, not the 100 of the screen', async () => {
  const r = await get('/api/audit.csv?type=cap.many', { tok: founder() });
  assert.equal(r.text.split('\r\n').length - 2, 500);
  const few = await get('/api/audit.csv?type=cap.many&limit=7', { tok: founder() });
  assert.equal(few.text.split('\r\n').length - 2, 7);
});

test('the chain can be checked from the API, for a restaurant or for the global chain, and a broken one is reported', async () => {
  const tok = founder();
  const global = await get('/api/audit/verify', { tok });
  assert.deepEqual([global.status, global.json.ok, global.json.restaurant_id], [200, true, null]);
  assert.ok(global.json.checked >= 1);
  assert.equal(global.json.generated_at, new Date(clock).toISOString());
  const one = await get(`/api/audit/verify?restaurant_id=${T.A.restaurant}`, { tok });
  assert.deepEqual([one.json.ok, one.json.restaurant_id], [true, T.A.restaurant]);
  assert.equal((await get('/api/audit/verify?restaurant_id=nope', { tok })).status, 400);

  const [victim] = await rows(`SELECT id, chain_seq FROM public.tenant_events WHERE restaurant_id = $1 ORDER BY id LIMIT 1`, [T.A.restaurant]);
  await q('ALTER TABLE public.tenant_events DISABLE TRIGGER USER');
  try { await q(`UPDATE public.tenant_events SET payload = '{"edited": true}' WHERE id = $1`, [victim.id]); } finally { await q('ALTER TABLE public.tenant_events ENABLE TRIGGER USER'); }
  const broken = await get(`/api/audit/verify?restaurant_id=${T.A.restaurant}`, { tok });
  assert.equal(broken.json.ok, false);
  assert.equal(broken.json.broken_at, victim.chain_seq);
  assert.match(broken.json.reason, /hash/);
});

// --- the fleet and a restaurant ------------------------------------------------------------------------------------------------------------

const KEYS_NEVER_SHOWN = ['pairing_code', 'hub_provisioning_secret_hash', 'settings', 'payment_link', 'short_url', 'pin_hash', 'password', 'secret', 'token', 'guest_phone'];
function scan(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => scan(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [...(KEYS_NEVER_SHOWN.includes(k) ? [`${path}.${k}`] : []), ...scan(v, `${path}.${k}`)]);
  return [];
}

test('the fleet is every restaurant, ranked by the same rules the operator console uses, with nothing a restaurant could be acted as', async () => {
  await q(`UPDATE public.restaurants SET plan_status = 'past_due' WHERE id = $1`, [T.B.restaurant]);
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, started_at, version, queued, quarantined, devices, waiters)
           VALUES ($1, now(), now(), '1.4.0', 0, 2, 3, 5)`, [T.A.restaurant]);
  const r = await get('/api/fleet', { tok: founder() });
  assert.equal(r.status, 200);
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  const ids = r.json.tenants.map(t => t.id);
  assert.ok(ids.includes(T.A.restaurant) && ids.includes(T.B.restaurant));
  const b = r.json.tenants.find(t => t.id === T.B.restaurant);
  assert.ok(b.attention.some(a => a.code === 'past_due' && a.severity === 'high'));
  const a = r.json.tenants.find(t => t.id === T.A.restaurant);
  assert.deepEqual([a.hub.queued, a.hub.quarantined, a.hub.devices, a.hub.waiters, a.hub.version], [0, 2, 3, 5, '1.4.0']);
  assert.ok(a.attention.some(x => x.code === 'shelved'));
  assert.ok(r.json.attention.length >= 2);
  assert.equal(r.json.summary.tenants, r.json.tenants.length);
  assert.equal(r.json.truncated, false);
  assert.ok(Array.isArray(r.json.events));
  assert.deepEqual(scan(r.json), [], 'nothing in it that a restaurant could be acted as');
  assert.equal(r.json.tenants[0].severity !== null, true, 'the restaurants that need a look come first');
});

test('the fleet puts the restaurants that need a look first, however recently the others were added', async () => {
  await q(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ('c1c1c1c1-0000-4000-8000-0000000000c1', 'Zed Healthy', 'zed-healthy', 'Nagpur', 'PC-ZED')`);
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, started_at, version, queued, quarantined, devices, waiters) VALUES ('c1c1c1c1-0000-4000-8000-0000000000c1', now(), now(), '1.4.0', 0, 0, 1, 1)`);
  const r = await get('/api/fleet', { tok: founder() });
  const names = r.json.tenants.map(t => t.name);
  assert.equal(names.at(-1), 'Zed Healthy', 'the one with nothing to look at is last, though it was added last');
  assert.ok(r.json.tenants[0].severity !== null);
  const healthy = r.json.tenants.find(t => t.name === 'Zed Healthy');
  assert.equal(healthy.severity, null);
});

test('the fleet says when it is only part of the picture: a cap on restaurants is a cap, and it is said', async () => {
  const s = await serve(createAdminApp({ db: realDb(), keys: hsKeys(SECRET), config: config({ maxTenants: 2 }), now: () => clock, log: quiet }));
  try {
    const r = await get('/api/fleet', { url: s.url, tok: founder() });
    assert.equal(r.json.tenants.length, 2);
    assert.equal(r.json.truncated, true);
    const all = await get('/api/fleet', { tok: founder() });
    assert.equal(all.json.truncated, false);
  } finally { await stop(s.server); }
});

test('the fleet carries the latest subscription events across all restaurants, in the shape the operator console uses', async () => {
  await q(`INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, applied_plan_status, payload, razorpay_event_id) VALUES ($1, 'sub_fleet', 'subscription.charged', 'active', '{"customer": {"email": "g@example.test"}}'::jsonb, 'evt_fleet_1')`, [T.A.restaurant]);
  const r = await get('/api/fleet', { tok: founder() });
  const e = r.json.events.find(x => x.razorpay_subscription_id === 'sub_fleet');
  assert.ok(e, 'the event is there');
  assert.deepEqual([e.event, e.applied_plan_status, e.restaurant_id, e.restaurant_name], ['subscription.charged', 'active', T.A.restaurant, 'Restaurant A']);
  assert.doesNotMatch(JSON.stringify(r.json), /g@example\.test/);
});

test('one restaurant: its state, its subscriptions and its events; an unknown or malformed id is simply not found', async () => {
  const tok = founder();
  await q(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan) VALUES ($1, 'sub_x', 'active', 'pro')`, [T.A.restaurant]);
  const r = await get(`/api/tenants/${T.A.restaurant.toUpperCase()}`, { tok });
  assert.equal(r.status, 200);
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  assert.equal(r.json.tenant.id, T.A.restaurant);
  assert.deepEqual(r.json.subscriptions.map(s => [s.razorpay_subscription_id, s.status]), [['sub_x', 'active']]);
  assert.ok(Array.isArray(r.json.events));
  assert.deepEqual(scan(r.json), []);
  assert.equal((await get('/api/tenants/99999999-9999-4999-8999-999999999999', { tok })).status, 404);
  for (const bad of ['abc', '1', 'a0a0a0a0-0000-4000-8000-00000000000g', '%00']) assert.equal((await get(`/api/tenants/${bad}`, { tok })).status, 404, bad);
});

// --- a failed read is an error, never the last answer ----------------------------------------------------------------------------------------

test('(I8) when the database does not answer the caller gets an error and no data, and a message that says nothing about the cause', async () => {
  let fail = true;
  const real = realDb();
  const flaky = { asAdmin: (claims, fn) => (fail ? Promise.reject(new Error('connection to 10.0.0.5 reset: password authentication failed for user "kullina_admin"')) : real.asAdmin(claims, fn)) };
  const s = await serve(createAdminApp({ db: flaky, keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
  try {
    const tok = founder();
    const good = await get('/api/fleet', { url: s.url, tok });
    assert.equal(good.status, 502);
    assert.equal(good.json.code, 'DATABASE');
    assert.deepEqual(Object.keys(good.json).sort(), ['code', 'error', 'success']);
    assert.doesNotMatch(good.text, /10\.0\.0\.5|password|kullina_admin|reset/);
    fail = false;
    const ok = await get('/api/fleet', { url: s.url, tok });
    assert.equal(ok.status, 200);
    fail = true;
    const again = await get('/api/fleet', { url: s.url, tok });
    assert.equal(again.status, 502, 'a read that worked a moment ago is not shown when this one fails');
    assert.equal(again.json.tenants, undefined);
    for (const path of ['/api/me', '/api/audit', '/api/audit.csv', '/api/audit/verify', `/api/tenants/${T.A.restaurant}`, `/api/tenants/${T.A.restaurant}/timeline`, '/api/alerts']) assert.equal((await get(path, { url: s.url, tok })).status, 502, path);
    for (const path of [`/api/alerts/${sweepAlertId}/ack`, `/api/alerts/${sweepAlertId}/resolve`]) {
      const r = await call('POST', path, { url: s.url, tok, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'a perfectly good reason' }) });
      assert.deepEqual([r.status, r.json.code], [502, 'DATABASE'], path);
    }
  } finally { await stop(s.server); }
});

test('the database\'s own refusals are told apart from its failures: not allowed is 403, a bad argument is 400', async () => {
  const refuse = code => ({ asAdmin: () => Promise.reject(Object.assign(new Error('x'), { code })) });
  for (const [code, status, body] of [['42501', 403, 'ADMIN_ONLY'], ['22023', 400, 'BAD_REQUEST'], ['57P01', 502, 'DATABASE'], [undefined, 502, 'DATABASE']]) {
    const s = await serve(createAdminApp({ db: refuse(code), keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
    try {
      const r = await get('/api/audit', { url: s.url, tok: founder() });
      assert.deepEqual([r.status, r.json.code], [status, body], String(code));
    } finally { await stop(s.server); }
  }
});

test('the caller\'s claims, not their token, are what the database is given: the subject and the level, the ordinary role, nothing else', async () => {
  let seen = null;
  const s = await serve(createAdminApp({ db: { asAdmin: async (claims, fn) => { seen = claims; return fn(async () => ({ rows: [{ user_id: F1, email: 'a', display_name: 'A', role: 'founder' }] })); } }, keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
  try {
    await get('/api/me', { url: s.url, tok: founder({ role: 'service_role', email: 'x@y.z', app_metadata: { admin: true } }) });
    assert.deepEqual(seen, { sub: F1, aal: 'aal2' });
  } finally { await stop(s.server); }
});

// --- the alerts inbox (Phase 2, P2-4) -----------------------------------------------------------------------------------------------------

const json = { 'Content-Type': 'application/json' };
const post = (path, body, { tok = founder(), headers = json, raw } = {}) => call('POST', path, { tok, headers, body: raw ?? JSON.stringify(body) });
const ack = (id, reason, opts) => post(`/api/alerts/${id}/ack`, { reason }, opts);
const resolve = (id, reason, opts) => post(`/api/alerts/${id}/resolve`, { reason }, opts);
const stateOf = async id => (await rows(`SELECT state, acked_by, ack_reason, resolved_by, resolve_reason FROM public.alerts WHERE id = $1`, [id]))[0];
const eventsOf = (id, type) => rows(`SELECT * FROM public.tenant_events WHERE type = $2 AND (payload ->> 'alert_id')::bigint = $1 ORDER BY id`, [id, type]);
const GOOD = 'the owner is ringing them back';

test('the inbox lists what is waiting and what somebody has taken on, worst and longest-waiting first, with the restaurant named and the words said', async () => {
  await clearAlerts();
  const low = await openAlert('sync_backlog', T.B.restaurant, { count: 60 });
  const high = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const taken = await openAlert('payment_past_due', T.A.restaurant);
  await ack(taken.id, GOOD);
  const r = await get('/api/alerts', { tok: founder() });
  assert.equal(r.status, 200);
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  assert.deepEqual(r.json.alerts.map(a => a.id), [high.id, low.id, taken.id], 'waiting first (the worse first), then taken on');
  const a = r.json.alerts[0];
  assert.equal(a.restaurant_name, 'Restaurant A');
  assert.equal(a.what, 'orders shelved');
  assert.match(a.text, /^2 orders were shelved/);
  assert.deepEqual([a.severity, a.state, a.rule_key], ['P1', 'open', 'orders_shelved']);
  assert.deepEqual(r.json.counts, { open: 2, acked: 1, unattended: 0 });
  assert.equal(r.json.truncated, false);
});

test('an alert is shown by a closed list of fields: nothing else that ever lands in its details reaches the page', async () => {
  await clearAlerts();
  const o = await openAlert('hub_silent_service', T.A.restaurant, { last_seen_at: new Date(clock - 3600000).toISOString(), silent_ms: 3600000, phone: '9822012345', token: 'sk_live_x', note: 'private' });
  const [a] = (await get('/api/alerts', { tok: founder() })).json.alerts;
  assert.equal(a.id, o.id);
  assert.deepEqual(Object.keys(a).sort(), [
    'ack_reason', 'acked_at', 'acked_by_email', 'detail', 'escalation_level', 'id', 'last_notified_at', 'opened_at', 'reminders', 'resolve_reason', 'resolved_at',
    'resolved_by', 'restaurant_id', 'restaurant_name', 'rule_key', 'severity', 'state', 'text', 'unattended_at', 'what'
  ]);
  assert.deepEqual(Object.keys(a.detail).sort(), ['last_seen_at', 'silent_ms']);
  const text = JSON.stringify(a);
  for (const leak of ['9822012345', 'sk_live_x', 'private']) assert.ok(!text.includes(leak), leak);
  assert.equal(a.reminders, 3, 'how many reminders there are, so "reminder 2 of 3" can be said');
});

test('who acknowledged is the person, by email; who resolved is "person" or "system", never an id', async () => {
  await clearAlerts();
  const a = await openAlert('orders_shelved', T.A.restaurant, { count: 1 });
  const b = await openAlert('sync_backlog', T.A.restaurant, { count: 60 });
  await ack(a.id, GOOD);
  await q(`SELECT public.alert_apply('[]'::jsonb, $1::jsonb, '[]'::jsonb, 'x')`, [JSON.stringify([{ id: b.id, reason: 'condition_cleared' }])]);
  const taken = (await get('/api/alerts?state=acked', { tok: founder() })).json.alerts;
  assert.equal(taken[0].acked_by_email, 'aman@example.test');
  const closed = (await get('/api/alerts?state=resolved', { tok: founder() })).json.alerts;
  assert.equal(closed[0].resolved_by, 'system');
  assert.equal(closed[0].resolve_reason, 'condition_cleared');
  await resolve(a.id, 'fixed by the owner today');
  const both = (await get('/api/alerts?state=resolved', { tok: founder() })).json.alerts;
  assert.deepEqual(both.map(x => [x.id, x.resolved_by]), [[a.id, 'person'], [b.id, 'system']], 'most recently closed first');
  assert.ok(!JSON.stringify(both).includes(F1));
});

test('the state filter: active (the default), open, acked, resolved; anything else is a 400 that says what is understood', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 1 });
  const t = await openAlert('sync_backlog', T.A.restaurant, { count: 60 });
  const d = await openAlert('payment_past_due', T.A.restaurant);
  await ack(t.id, GOOD);
  await resolve(d.id, 'dealt with by the owner');
  const ids = async s => (await get(`/api/alerts${s}`, { tok: founder() })).json.alerts.map(a => a.id);
  assert.deepEqual(await ids(''), [o.id, t.id]);
  assert.deepEqual(await ids('?state=active'), [o.id, t.id]);
  assert.deepEqual(await ids('?state=open'), [o.id]);
  assert.deepEqual(await ids('?state=acked'), [t.id]);
  assert.deepEqual(await ids('?state=resolved'), [d.id]);
  const bad = await get('/api/alerts?state=snoozed', { tok: founder() });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /state is one of/);
  assert.deepEqual(await ids('?state=open&state=resolved'), [d.id], 'a repeated parameter uses the last, as the audit log does');
});

test('the limit: a number from 1 to 500, defaulting to 100; anything else is a 400, and a cap that cut the list is said', async () => {
  await clearAlerts();
  for (const rule of ['orders_shelved', 'sync_backlog', 'payment_past_due']) await openAlert(rule, T.A.restaurant, { count: 1 });
  const two = (await get('/api/alerts?limit=2', { tok: founder() })).json;
  assert.equal(two.alerts.length, 2);
  assert.equal(two.truncated, true, 'a cap is a cap, and it is said');
  assert.equal((await get('/api/alerts?limit=3', { tok: founder() })).json.truncated, false);
  assert.equal((await get('/api/alerts?limit=100000', { tok: founder() })).status, 200, 'over the cap is the cap');
  assert.equal((await get('/api/alerts?limit=', { tok: founder() })).status, 200, 'an empty one is not given');
  for (const bad of ['0', '-1', 'x', '1.5']) assert.equal((await get(`/api/alerts?limit=${bad}`, { tok: founder() })).status, 400, bad);
});

test('the counts are of what is waiting, what is taken on, and what nobody answered after every reminder; the unattended one is first', async () => {
  await clearAlerts();
  const a = await openAlert('sync_backlog', T.A.restaurant, { count: 60 });
  await openAlert('orders_shelved', T.A.restaurant, { count: 1 });
  await q(`SELECT public.alert_apply('[]'::jsonb, '[]'::jsonb, $1::jsonb, 'x')`, [JSON.stringify([a.id])]);
  const r = (await get('/api/alerts', { tok: founder() })).json;
  assert.deepEqual(r.counts, { open: 2, acked: 0, unattended: 1 });
  assert.equal(r.alerts[0].id, a.id, 'even though it is the lesser alert');
  assert.ok(r.alerts[0].unattended_at);
});

test('the inbox asks who is asking: a tenant\'s owner, a deactivated founder and nobody are refused, and no second factor is told to use one', async () => {
  assert.equal((await get('/api/alerts')).status, 401);
  assert.equal((await get('/api/alerts', { tok: founder({ aal: 'aal1' }) })).json.code, 'MFA_REQUIRED');
  for (const sub of [OWNER_A, GONE, F2]) {
    clock += NEW_WINDOW;
    const r = await get('/api/alerts', { tok: token(sub) });
    assert.deepEqual([r.status, r.json.code], [403, 'ADMIN_ONLY'], sub);
  }
});

// --- acknowledging and resolving ---------------------------------------------------------------------------------------------------------

test('acknowledging records who and why, answers with the event, and moves no restaurant\'s data', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const tables = ['invoices', 'orders', 'menu_items', 'reconciliations', 'restaurants', 'subscriptions'];
  const counts = async () => Promise.all(tables.map(async t => (await rows(`SELECT count(*)::int AS n FROM public.${t}`))[0].n));
  const before = await counts();
  const r = await ack(o.id, `  ${GOOD}  `);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['alert', 'event_id', 'generated_at', 'success']);
  assert.deepEqual(r.json.alert, { id: o.id, state: 'acked' });
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  const s = await stateOf(o.id);
  assert.deepEqual([s.state, s.acked_by, s.ack_reason], ['acked', F1, GOOD]);
  const [e] = await eventsOf(o.id, 'alert.acked');
  assert.equal(Number(e.id), r.json.event_id);
  assert.deepEqual([e.source, e.actor_type, e.actor_id], ['admin', 'admin', F1]);
  assert.deepEqual(await counts(), before);
});

test('acknowledging twice is harmless: the second says so, changes nothing and records nothing; two at once record one', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const [x, y] = await Promise.all([ack(o.id, GOOD), ack(o.id, 'a second founder, a second later')]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal((await eventsOf(o.id, 'alert.acked')).length, 1);
  assert.equal((await stateOf(o.id)).state, 'acked');
  const again = await ack(o.id, 'and once more, for luck, please');
  assert.equal(again.status, 200);
  assert.equal(again.json.event_id, null, 'no new event');
  assert.equal((await eventsOf(o.id, 'alert.acked')).length, 1);
});

test('resolving records who and why, from open or acknowledged, and a person is named as the one who closed it', async () => {
  await clearAlerts();
  const a = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const b = await openAlert('sync_backlog', T.A.restaurant, { count: 60 });
  await ack(b.id, GOOD);
  for (const id of [a.id, b.id]) {
    const r = await resolve(id, 'the owner restarted the hub');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.alert, { id, state: 'resolved' });
    const s = await stateOf(id);
    assert.deepEqual([s.state, s.resolved_by, s.resolve_reason], ['resolved', F1, 'the owner restarted the hub']);
    const [e] = await eventsOf(id, 'alert.resolved');
    assert.deepEqual([e.actor_id, e.payload.by], [F1, 'admin']);
  }
});

test('an alert that is already resolved cannot be acknowledged or resolved again: a 409 that says so; one that does not exist is a 404', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  await resolve(o.id, 'done, thank you very much');
  for (const act of [ack, resolve]) {
    const r = await act(o.id, 'a good enough reason here');
    assert.deepEqual([r.status, r.json.code], [409, 'CONFLICT']);
    assert.match(r.json.error, /already resolved/i);
  }
  assert.equal((await eventsOf(o.id, 'alert.resolved')).length, 1);
  for (const act of [ack, resolve]) {
    const r = await act(999999, 'a good enough reason here');
    assert.deepEqual([r.status, r.json.code], [404, 'NOT_FOUND']);
  }
});

test('an id that is not an alert id is simply not found, with no reading of the body and no trip to the database', async () => {
  const spy = [];
  const s = await serve(createAdminApp({ db: { asAdmin: async (...a) => { spy.push(a); return realDb().asAdmin(...a); } }, keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
  try {
    for (const id of ['0', '-1', 'x', '1.5', '01', '1e3', '99999999999999999', 'a0a0a0a0-0000-4000-8000-000000000001', '%20', '1%2F2']) {
      for (const action of ['ack', 'resolve']) {
        const r = await call('POST', `/api/alerts/${id}/${action}`, { url: s.url, tok: founder(), headers: json, body: JSON.stringify({ reason: GOOD }) });
        assert.deepEqual([r.status, r.json?.code], [404, 'NOT_FOUND'], `${id} ${action}`);
      }
    }
    assert.equal(spy.length, 0);
  } finally { await stop(s.server); }
});

test('the reason: a person\'s words of at least ten characters (after trimming) and at most five hundred; anything else is a 400 that says so, and nothing changes', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const before = await spineCount();
  const bads = [
    ['no body', { raw: '' }], ['not json', { raw: '{nope' }], ['an array', { raw: '[1,2]' }], ['null', { raw: 'null' }], ['a bare string', { raw: '"a good enough reason"' }],
    ['no reason', { raw: '{}' }], ['reason null', { raw: '{"reason":null}' }], ['reason a number', { raw: '{"reason":1234567890123}' }],
    ['reason a list', { raw: '{"reason":["a good enough reason"]}' }], ['too short', { raw: '{"reason":"123456789"}' }],
    ['too short once trimmed', { raw: '{"reason":"   123456789   "}' }], ['blank', { raw: '{"reason":"          "}' }], ['too long', { raw: JSON.stringify({ reason: 'a'.repeat(501) }) }],
    ['a body far too large', { raw: JSON.stringify({ reason: GOOD, padding: 'x'.repeat(50000) }) }]
  ];
  for (const action of ['ack', 'resolve']) {
    for (const [label, opts] of bads) {
      const r = await post(`/api/alerts/${o.id}/${action}`, null, opts);
      assert.equal(r.status, 400, `${action}: ${label}`);
      assert.equal(r.json.code, 'BAD_REQUEST', `${action}: ${label}`);
      assert.ok(r.json.error.length > 10 && r.json.error.length <= 200, `${action}: ${label}`);
    }
    const short = await post(`/api/alerts/${o.id}/${action}`, null, { raw: '{"reason":"123456789"}' });
    assert.match(short.json.error, /at least 10 characters/, 'it says what is wanted');
    const long = await post(`/api/alerts/${o.id}/${action}`, null, { raw: JSON.stringify({ reason: 'a'.repeat(501) }) });
    assert.match(long.json.error, /500/);
  }
  assert.equal((await stateOf(o.id)).state, 'open');
  assert.equal(await spineCount(), before, 'nothing was recorded');
  const wrongType = await post(`/api/alerts/${o.id}/ack`, null, { raw: JSON.stringify({ reason: GOOD }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.status, 400, 'a body that is not declared as JSON is not read');
  assert.equal((await stateOf(o.id)).state, 'open');
  for (const [label, reason] of [['ten', '1234567890'], ['five hundred', 'a'.repeat(500)]]) {
    const fresh = await openAlert('payment_past_due', T.A.restaurant);
    assert.equal((await ack(fresh.id, reason)).status, 200, label);
    await q(`DELETE FROM public.alerts WHERE id = $1`, [fresh.id]);
  }
});

test('the administrator is asked before the body is read: a tenant or a founder without MFA gets a refusal, never a hint about the reason', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  for (const action of ['ack', 'resolve']) {
    assert.equal((await post(`/api/alerts/${o.id}/${action}`, { reason: GOOD }, { tok: null })).status, 401);
    assert.equal((await post(`/api/alerts/${o.id}/${action}`, { reason: GOOD }, { tok: founder({ aal: 'aal1' }) })).json.code, 'MFA_REQUIRED');
    for (const sub of [OWNER_A, GONE, F2]) {
      clock += NEW_WINDOW;
      for (const opts of [{ raw: JSON.stringify({ reason: GOOD }) }, { raw: '{nope' }, { raw: '{}' }, { raw: '' }]) {
        const r = await post(`/api/alerts/${o.id}/${action}`, null, { tok: token(sub), ...opts });
        assert.deepEqual([r.status, r.json.code], [403, 'ADMIN_ONLY'], `${sub} ${action} ${opts.raw}`);
      }
    }
  }
  assert.equal((await stateOf(o.id)).state, 'open', 'and nothing happened');
});

test('a body is read only on these two routes, and only as JSON of a few kilobytes: the sign-in route still reads none', async () => {
  const r = await call('POST', '/api/session', { tok: founder(), headers: json, body: JSON.stringify({ x: 'y'.repeat(200000) }) });
  assert.equal(r.status, 200);
});

test('the database\'s answers on these routes: not allowed is a 403, not there a 404, already resolved a 409, anything else a 502 with no data', async () => {
  const fake = code => ({ asAdmin: () => Promise.reject(Object.assign(new Error('x'), { code })) });
  for (const [code, status, body] of [['42501', 403, 'ADMIN_ONLY'], ['P0002', 404, 'NOT_FOUND'], ['55000', 409, 'CONFLICT'], ['57P01', 502, 'DATABASE']]) {
    const s = await serve(createAdminApp({ db: fake(code), keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
    try {
      const r = await call('POST', '/api/alerts/5/ack', { url: s.url, tok: founder(), headers: json, body: JSON.stringify({ reason: GOOD }) });
      assert.deepEqual([r.status, r.json.code], [status, body], code);
    } finally { await stop(s.server); }
  }
});

// --- details the mutation check pointed at ------------------------------------------------------------------------------------------------

test('the reason is judged on what it says, in the API\'s own words: padding does not count, and a character is a character however it is written', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  for (const action of ['ack', 'resolve']) {
    for (const raw of ['{"reason":"   123456789   "}', JSON.stringify({ reason: '😀😀😀😀😀' })]) {
      const r = await post(`/api/alerts/${o.id}/${action}`, null, { raw });
      assert.equal(r.status, 400, `${action} ${raw}`);
      assert.match(r.json.error, /at least 10 characters/, 'the API says it, not a generic refusal from the database');
    }
  }
  const fresh = await openAlert('payment_past_due', T.A.restaurant);
  assert.equal((await ack(fresh.id, '😀'.repeat(10))).status, 200, 'ten emoji are ten characters');
});

test('a body that is not JSON is told so, in words, for both actions', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  for (const action of ['ack', 'resolve']) {
    const r = await post(`/api/alerts/${o.id}/${action}`, null, { raw: '{nope' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /must be JSON/);
  }
});

test('with no limit given the inbox returns up to a hundred: seven alerts all come back', async () => {
  await clearAlerts();
  for (let i = 0; i < 7; i++) {
    const item = { restaurant_id: T.A.restaurant, rule_key: 'sync_backlog', severity: 'P2', dedupe_key: `sync_backlog:${T.A.restaurant}:${i}`, detail: { count: 60 } };
    await q(`SELECT public.alert_apply($1::jsonb, '[]'::jsonb, '[]'::jsonb, 'many')`, [JSON.stringify([item])]);
  }
  const r = (await get('/api/alerts', { tok: founder() })).json;
  assert.equal(r.alerts.length, 7);
  assert.equal(r.truncated, false);
  assert.equal(r.counts.open, 7);
});

test('an alert that was flagged unattended and then acknowledged is no longer counted as unattended', async () => {
  await clearAlerts();
  const o = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  await q(`SELECT public.alert_apply('[]'::jsonb, '[]'::jsonb, $1::jsonb, 'x')`, [JSON.stringify([o.id])]);
  assert.equal((await get('/api/alerts', { tok: founder() })).json.counts.unattended, 1);
  await ack(o.id, GOOD);
  const r = (await get('/api/alerts', { tok: founder() })).json;
  assert.deepEqual(r.counts, { open: 0, acked: 1, unattended: 0 });
  assert.ok(r.alerts[0].unattended_at, 'it is still marked as having been flagged');
});

test('nobody is named as having closed an alert that is not closed', async () => {
  await clearAlerts();
  const a = await openAlert('orders_shelved', T.A.restaurant, { count: 2 });
  const b = await openAlert('sync_backlog', T.A.restaurant, { count: 60 });
  await ack(b.id, GOOD);
  const list = (await get('/api/alerts', { tok: founder() })).json.alerts;
  assert.equal(list.length, 2);
  for (const alert of list) {
    assert.equal(alert.resolved_by, null, alert.state);
    assert.equal(alert.resolved_at, null);
    assert.equal(alert.resolve_reason, null);
  }
  assert.ok([a.id, b.id].every(id => list.some(x => x.id === id)));
});

// --- one restaurant's timeline (Phase 2, P2-1) ---------------------------------------------------------------------------------------------

const rec = (restaurant, source, type, actorType = 'system', actor = null, payload = {}) =>
  q(`SELECT public.record_tenant_event($1, $2, $3, $4, $5, NULL, $6::jsonb) AS id`, [restaurant, source, type, actorType, actor, JSON.stringify(payload)]).then(r => Number(r.rows[0].id));
const timeline = (id, query = '', opts = { tok: founder() }) => get(`/api/tenants/${id}/timeline${query}`, opts);
let tl;   // the two restaurants made for these tests (so what earlier tests wrote to the others is not in their history) and the ids of the events seeded, by what they are

test('(timeline setup) a restaurant has a history of each kind, and another restaurant has one of its own', async () => {
  const make = async (name, slug, code) => (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ($1, $2, 'Nagpur', $3) RETURNING id`, [name, slug, code])).rows[0].id;
  const R = await make('Timeline One', 'timeline-one', 'PC-TL1');
  const R2 = await make('Timeline Two', 'timeline-two', 'PC-TL2');
  const A = R;
  tl = {
    R, R2,
    activated: await rec(A, 'razorpay', 'subscription.activated', 'webhook', null, { event: 'subscription.activated', applied_plan_status: 'active', razorpay_subscription_id: 'sub_X' }),
    first: await rec(A, 'hub', 'hub.first_report', 'hub', null, { version: '1.0.0' }),
    opened: await rec(A, 'system', 'alert.opened', 'system', null, { alert_id: 1, rule_key: 'orders_shelved', severity: 'P1', detail: { count: 2 } }),
    acked: await rec(A, 'admin', 'alert.acked', 'admin', F1, { alert_id: 1, rule_key: 'orders_shelved', reason: 'looking at it now' }),
    halted: await rec(A, 'razorpay', 'subscription.halted', 'webhook', null, { event: 'subscription.halted', applied_plan_status: 'past_due' }),
    hours: await rec(A, 'system', 'admin.service_hours_set', 'system', null, { timezone: 'Asia/Kolkata' }),
    other: await rec(A, 'support', 'support.note', 'system', null, {})
  };
  tl.theirs = await rec(tl.R2, 'hub', 'hub.first_report', 'hub', null, { version: '9.9.9' });
  assert.ok(tl.activated > 0);
});

test('a restaurant\'s timeline is its own events newest first, with the restaurant named and when it was read', async () => {
  const r = await timeline(tl.R);
  assert.equal(r.status, 200);
  assert.equal(r.json.generated_at, new Date(clock).toISOString());
  assert.deepEqual(r.json.restaurant, { id: tl.R, name: 'Timeline One' });
  assert.equal(r.json.kind, null);
  const ids = r.json.events.map(e => e.id);
  assert.deepEqual(ids.slice(0, 7), [tl.other, tl.hours, tl.halted, tl.acked, tl.opened, tl.first, tl.activated]);
  assert.ok(!ids.includes(tl.theirs), 'nobody else\'s history');
  assert.ok(r.json.events.every(e => e.restaurant_id === tl.R && e.restaurant_name === 'Timeline One'));
});

test('an event is shown by a closed list of fields, with the person named by email', async () => {
  const r = await timeline(tl.R);
  const acked = r.json.events.find(e => e.id === tl.acked);
  assert.deepEqual(Object.keys(acked).sort(), ['actor_email', 'actor_id', 'actor_type', 'chain_seq', 'id', 'occurred_at', 'payload', 'request_id', 'restaurant_id', 'restaurant_name', 'row_hash', 'source', 'type']);
  assert.equal(acked.actor_email, 'aman@example.test');
  assert.equal(acked.occurred_at, new Date(acked.occurred_at).toISOString());
});

test('the kinds each return only their own events, and the four together are everything but "other"', async () => {
  const idsOf = async kind => (await timeline(tl.R, `?kind=${kind}`)).json.events.map(e => e.id);
  assert.deepEqual(await idsOf('billing'), [tl.halted, tl.activated]);
  assert.deepEqual(await idsOf('hub'), [tl.first]);
  assert.deepEqual(await idsOf('alerts'), [tl.acked, tl.opened]);
  assert.deepEqual(await idsOf('admin'), [tl.hours]);
  const filtered = (await timeline(tl.R, '?kind=alerts')).json;
  assert.equal(filtered.kind, 'alerts');
});

test('the database\'s kinds and the words\' kinds agree on every event: what the filter returns is what describeEvent calls it', async () => {
  const { eventKind } = await import('../../common/eventWords.js');
  const all = (await timeline(tl.R, '?limit=500')).json.events;
  const seen = new Set();
  for (const kind of ['billing', 'hub', 'alerts', 'admin']) {
    for (const e of (await timeline(tl.R, `?kind=${kind}&limit=500`)).json.events) {
      assert.equal(eventKind(e), kind, `${e.type} (${e.source})`);
      seen.add(e.id);
    }
  }
  assert.deepEqual(all.filter(e => !seen.has(e.id)).map(e => eventKind(e)), ['other'], 'and what no filter returns is "other"');
});

test('it pages: a full page says where the next begins, and a short one says there is none', async () => {
  const first = (await timeline(tl.R, '?limit=3')).json;
  assert.equal(first.events.length, 3);
  assert.equal(first.next_before, first.events[2].id);
  const second = (await timeline(tl.R, `?limit=3&before=${first.next_before}`)).json;
  assert.ok(second.events.every(e => e.id < first.next_before));
  assert.deepEqual(first.events.map(e => e.id).filter(id => second.events.some(x => x.id === id)), [], 'no event twice');
  const all = (await timeline(tl.R, '?limit=500')).json;
  assert.equal(all.next_before, null, 'fewer than a full page: nothing more');
});

test('the limit defaults to fifty and is capped at five hundred, and a repeated parameter uses the last', async () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(await rec(tl.R2, 'hub', 'hub.restarted', 'hub', null, { started_at: new Date(clock + i).toISOString() }));
  const r = (await timeline(tl.R2)).json;
  assert.equal(r.events.length, 50);
  assert.equal(r.next_before, r.events[49].id);
  assert.equal((await timeline(tl.R2, '?limit=500')).json.events.length, many.length + 1);
  assert.equal((await timeline(tl.R2, '?limit=100000')).status, 200, 'over the cap is the cap');
  assert.equal((await timeline(tl.R2, '?kind=billing&kind=hub&limit=1&limit=2')).json.events.length, 2);
});

test('what is not understood is a 400 that names it, and nothing is guessed', async () => {
  const cases = [['?kind=all', /kind is one of/], ['?kind=ALERTS', /kind is one of/], ['?kind=billing%20', /kind is one of/], ['?limit=0', /limit/], ['?limit=-1', /limit/], ['?limit=x', /limit/], ['?before=0', /before/], ['?before=-3', /before/], ['?before=x', /before/], ['?before=1.5', /before/]];
  for (const [query, pattern] of cases) {
    const r = await timeline(tl.R, query);
    assert.equal(r.status, 400, query);
    assert.equal(r.json.code, 'BAD_REQUEST');
    assert.match(r.json.error, pattern, query);
  }
  assert.equal((await timeline(tl.R, '?kind=')).status, 200, 'an empty one is not given');
});

test('an unknown restaurant, or a malformed id, is simply not found', async () => {
  assert.deepEqual([(await timeline('99999999-9999-4999-8999-999999999999')).status, (await timeline('99999999-9999-4999-8999-999999999999')).json.code], [404, 'NOT_FOUND']);
  for (const bad of ['x', '1', 'a0a0a0a0-0000-4000-8000', 'a0a0a0a0-0000-4000-8000-00000000000g']) assert.equal((await timeline(bad)).status, 404, bad);
});

test('the timeline asks who is asking: nobody, a tenant\'s owner, a deactivated founder, and no second factor are all refused', async () => {
  assert.equal((await timeline(tl.R, '', {})).status, 401);
  assert.equal((await timeline(tl.R, '', { tok: founder({ aal: 'aal1' }) })).json.code, 'MFA_REQUIRED');
  for (const sub of [OWNER_A, GONE, F2]) {
    clock += NEW_WINDOW;
    const r = await timeline(tl.R, '', { tok: token(sub) });
    assert.deepEqual([r.status, r.json.code], [403, 'ADMIN_ONLY'], sub);
  }
});

test('reading a timeline writes nothing', async () => {
  const before = await spineCount();
  await timeline(tl.R); await timeline(tl.R, '?kind=alerts');
  assert.equal(await spineCount(), before);
});

test('(I8) when the database does not answer the caller gets an error and no history', async () => {
  const s = await serve(createAdminApp({ db: { asAdmin: () => Promise.reject(new Error('connection to 10.0.0.5 reset')) }, keys: hsKeys(SECRET), config: config(), now: () => clock, log: quiet }));
  try {
    const r = await timeline(tl.R, '', { url: s.url, tok: founder() });
    assert.deepEqual([r.status, r.json.code], [502, 'DATABASE']);
    assert.equal(r.json.events, undefined);
    assert.doesNotMatch(r.text, /10\.0\.0\.5/);
  } finally { await stop(s.server); }
});

test('what a timeline carries is what is on the spine and nothing else: no tenant data moves into it', async () => {
  const text = JSON.stringify((await timeline(tl.R, '?limit=500')).json);
  for (const leak of ['9822012345', 'invoice', 'guest']) assert.ok(!text.includes(leak), leak);
});

test('the limit is five hundred at most: over that, a full page of five hundred still says there is more', async () => {
  const R = (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ('Busy API', 'busy-api', 'Nagpur', 'PC-BAPI') RETURNING id`)).rows[0].id;
  await q(`SELECT public.record_tenant_event($1, 'hub', 'hub.restarted', 'hub', NULL, NULL, '{}'::jsonb) FROM generate_series(1, 510)`, [R]);
  const r = (await timeline(R, '?limit=100000')).json;
  assert.equal(r.events.length, 500);
  assert.equal(r.next_before, r.events[499].id, 'a full page of the most there can be: there may be more');
});

test('the restaurant is named by its id in lower case, however the address wrote it', async () => {
  const r = await timeline(tl.R.toUpperCase());
  assert.equal(r.status, 200);
  assert.equal(r.json.restaurant.id, tl.R);
  assert.ok(r.json.events.every(e => e.restaurant_id === tl.R));
});

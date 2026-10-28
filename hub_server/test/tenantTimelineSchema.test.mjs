import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { cloudDb } from './helpers/cloudDb.mjs';

// Migration 025: one restaurant's history on the spine (Phase 2, P2-1 of docs/SUPER_ADMIN_BUILD_SHEET.md). Run on a real Postgres engine (PGlite)
// with Supabase's default privileges modelled, as the spine's and the alerts' tests are.
//
// What these tests are for: that the timeline is the history of ONE restaurant and nobody else's; that the kinds are filtered in the database, so a page
// of "alerts" is a page of alerts and paging never mixes them with what was hidden; that it asks who is asking before it answers; that it only reads;
// and that the dedicated console role can run it and nobody else can.

let cloud;
let T;
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const F3 = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const aal2 = sub => ({ sub, aal: 'aal2', role: 'authenticated' });
const q = (sql, params) => cloud.pg.query(sql, params);
const rows = async (sql, params) => (await q(sql, params)).rows;
const asAdmin = (claims, sql, params) => cloud.as('kullina_admin', null, async () => {
  await q(`SELECT set_config('request.jwt.claims', $1, false)`, [claims === null ? '' : JSON.stringify(claims)]);
  try { return await q(sql, params); } finally { await q(`SELECT set_config('request.jwt.claims', '', false)`); }
});
const rejected = async (fn, pattern, label = '') => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected the database to refuse this, and it did not ${label}`);
  if (pattern) assert.match(err.message, pattern, label);
  return err;
};
const DENIED = /admin access denied/i;
const timeline = (restaurant, kind = null, before = null, limit = 50, claims = aal2(F1)) =>
  asAdmin(claims, `SELECT * FROM public.admin_tenant_timeline($1::uuid, $2::text, $3::bigint, $4::integer)`, [restaurant, kind, before, limit]).then(r => r.rows);
const record = (restaurant, source, type, actorType = 'system', actor = null, payload = {}) =>
  q(`SELECT public.record_tenant_event($1, $2, $3, $4, $5, NULL, $6::jsonb) AS id`, [restaurant, source, type, actorType, actor, JSON.stringify(payload)]).then(r => Number(r.rows[0].id));

let ids;   // the events of restaurant A, by what they are

before(async () => {
  cloud = await cloudDb();
  await q(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  for (const [id, email] of [[F1, 'aman@example.test'], [F3, 'third@example.test'], [OWNER_A, 'owner-a@example.test']]) {
    await q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  }
  await q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  await q(`SELECT public.seed_admin_user('aman@example.test', 'Aman')`);

  const A = T.A.restaurant;
  ids = {
    activated: await record(A, 'razorpay', 'subscription.activated', 'webhook', null, { event: 'subscription.activated', applied_plan_status: 'active' }),
    firstReport: await record(A, 'hub', 'hub.first_report', 'hub', null, { version: '1.0.0' }),
    opened: await record(A, 'system', 'alert.opened', 'system', null, { alert_id: 1, rule_key: 'orders_shelved', severity: 'P1', detail: { count: 2 } }),
    acked: await record(A, 'admin', 'alert.acked', 'admin', F1, { alert_id: 1, rule_key: 'orders_shelved', reason: 'looking at it now' }),
    halted: await record(A, 'razorpay', 'subscription.halted', 'webhook', null, { event: 'subscription.halted', applied_plan_status: 'past_due' }),
    shelved: await record(A, 'hub', 'hub.shelved_changed', 'hub', null, { from: 0, to: 2 }),
    hours: await record(A, 'system', 'admin.service_hours_set', 'system', null, { timezone: 'Asia/Kolkata' }),
    resolved: await record(A, 'system', 'alert.resolved', 'system', null, { alert_id: 1, rule_key: 'orders_shelved', reason: 'condition_cleared', by: 'system' })
  };
  ids.other = [await record(T.B.restaurant, 'hub', 'hub.first_report', 'hub', null, { version: '2.0.0' }), await record(T.B.restaurant, 'razorpay', 'subscription.charged', 'webhook')];
  ids.global = await record(null, 'admin', 'admin.signin', 'admin', F1);
});
after(async () => { await cloud?.close(); });

// --- the migration and its door ----------------------------------------------------------------------------------------------------

test('the migration applies on top of the others, and again, and changes nothing the second time', async () => {
  const count = async () => (await rows(`SELECT count(*)::int AS f FROM pg_proc WHERE pronamespace = 'public'::regnamespace`))[0].f;
  const first = await count();
  await cloud.applyAll({ onlyMigrations: true });
  assert.equal(await count(), first);
});

test('the console role can run it, and nobody else can: not anon, a tenant, the service role, or the alert worker', async () => {
  const can = async role => (await rows(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_tenant_timeline'`, [role]))[0].can;
  assert.equal(await can('kullina_admin'), true);
  for (const role of ['anon', 'authenticated', 'service_role', 'kullina_alerts']) assert.equal(await can(role), false, role);
});

test('it asks who is asking: nobody, a tenant\'s owner, a user not on the allowlist, and an administrator without a second factor are all refused', async () => {
  await rejected(() => timeline(T.A.restaurant, null, null, 50, null), DENIED, 'nobody');
  await rejected(() => timeline(T.A.restaurant, null, null, 50, aal2(OWNER_A)), DENIED, 'a tenant owner');
  await rejected(() => timeline(T.A.restaurant, null, null, 50, aal2(F3)), DENIED, 'not on the allowlist');
  await rejected(() => timeline(T.A.restaurant, null, null, 50, { sub: F1, aal: 'aal1' }), DENIED, 'no second factor');
});

// --- what it returns ---------------------------------------------------------------------------------------------------------------

test('it is one restaurant\'s history, newest first, and nobody else\'s: not another restaurant\'s, and not the console\'s own', async () => {
  const got = await timeline(T.A.restaurant);
  assert.deepEqual(got.map(r => Number(r.id)), [ids.resolved, ids.hours, ids.shelved, ids.halted, ids.acked, ids.opened, ids.firstReport, ids.activated]);
  const everyone = new Set(got.map(r => Number(r.id)));
  for (const other of [...ids.other, ids.global]) assert.ok(!everyone.has(other));
});

test('each event carries what the screen needs: when, source, type, who did it (named), the payload, and where it sits in the chain', async () => {
  const [acked] = (await timeline(T.A.restaurant)).filter(r => Number(r.id) === ids.acked);
  assert.deepEqual(Object.keys(acked).sort(), ['actor_email', 'actor_id', 'actor_type', 'chain_seq', 'id', 'occurred_at', 'payload', 'request_id', 'row_hash', 'source', 'type']);
  assert.equal(acked.actor_email, 'aman@example.test');
  assert.equal(acked.actor_id, F1);
  assert.deepEqual(acked.payload, { alert_id: 1, rule_key: 'orders_shelved', reason: 'looking at it now' });
  assert.match(acked.row_hash, /^[0-9a-f]{64}$/);
  const [system] = (await timeline(T.A.restaurant)).filter(r => Number(r.id) === ids.opened);
  assert.equal(system.actor_email, null, 'a system event names nobody');
});

test('a restaurant with no history, or no such restaurant, gives an empty list and not an error', async () => {
  const fresh = (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ('Quiet', 'quiet-r', 'Nagpur', 'PC-Q') RETURNING id`)).rows[0].id;
  assert.deepEqual(await timeline(fresh), []);
  assert.deepEqual(await timeline('99999999-9999-4999-8999-999999999999'), []);
});

// --- kinds -------------------------------------------------------------------------------------------------------------------------

const idsOf = async kind => (await timeline(T.A.restaurant, kind)).map(r => Number(r.id));

test('the kinds are filtered in the database: billing, hub, alerts, and admin actions', async () => {
  assert.deepEqual(await idsOf('billing'), [ids.halted, ids.activated]);
  assert.deepEqual(await idsOf('hub'), [ids.shelved, ids.firstReport]);
  assert.deepEqual(await idsOf('alerts'), [ids.resolved, ids.acked, ids.opened]);
  assert.deepEqual(await idsOf('admin'), [ids.hours]);
  assert.equal((await timeline(T.A.restaurant, null)).length, 8, 'no kind is everything');
});

test('an alert that a person acknowledged is an alert, not an admin action: the kinds do not overlap', async () => {
  const all = new Set();
  for (const kind of ['billing', 'hub', 'alerts', 'admin']) for (const id of await idsOf(kind)) { assert.ok(!all.has(id), `${id} is in two kinds`); all.add(id); }
  assert.equal(all.size, 8, 'and together they are everything here');
});

test('a kind it does not know is refused by name, not treated as "everything"', async () => {
  for (const bad of ['', 'all', 'ALERTS', 'billing ', 'x', "alerts' OR true --"]) await rejected(() => timeline(T.A.restaurant, bad), /kind/i, JSON.stringify(bad));
});

// --- paging ------------------------------------------------------------------------------------------------------------------------

test('it pages: a limit, and "before" an event id, with no event twice and none missed', async () => {
  const seen = [];
  let before = null;
  for (let page = 0; page < 10; page++) {
    const got = await timeline(T.A.restaurant, null, before, 3);
    if (!got.length) break;
    assert.ok(got.length <= 3);
    seen.push(...got.map(r => Number(r.id)));
    before = Number(got[got.length - 1].id);
  }
  assert.deepEqual(seen, [ids.resolved, ids.hours, ids.shelved, ids.halted, ids.acked, ids.opened, ids.firstReport, ids.activated]);
});

test('paging within a kind stays within the kind', async () => {
  const first = await timeline(T.A.restaurant, 'alerts', null, 2);
  assert.deepEqual(first.map(r => Number(r.id)), [ids.resolved, ids.acked]);
  const next = await timeline(T.A.restaurant, 'alerts', Number(first[1].id), 2);
  assert.deepEqual(next.map(r => Number(r.id)), [ids.opened]);
});

test('the limit is at least one and at most five hundred', async () => {
  await rejected(() => timeline(T.A.restaurant, null, null, 0), /limit/i);
  await rejected(() => timeline(T.A.restaurant, null, null, -5), /limit/i);
  await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_tenant_timeline($1::uuid, NULL, NULL, NULL)`, [T.A.restaurant]), /limit/i);
  assert.equal((await timeline(T.A.restaurant, null, null, 100000)).length, 8, 'over the cap is the cap');
});

// --- it only reads -----------------------------------------------------------------------------------------------------------------

test('reading the timeline writes nothing, and the chain still verifies', async () => {
  const count = async () => (await rows(`SELECT count(*)::int AS n FROM public.tenant_events`))[0].n;
  const before = await count();
  await timeline(T.A.restaurant);
  await timeline(T.A.restaurant, 'alerts');
  assert.equal(await count(), before);
  const [v] = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_verify_chain($1)`, [T.A.restaurant])).rows;
  assert.equal(v.ok, true);
});

test('what a hub really does is on the timeline: a first report, a new version, a restart and shelved orders, as the triggers record them', async () => {
  const B = T.B.restaurant;
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, started_at, version, queued, quarantined) VALUES ($1, now(), now(), '2.0.0', 0, 0) ON CONFLICT (restaurant_id) DO NOTHING`, [B]);
  await q(`UPDATE public.hub_status SET version = '2.1.0', quarantined = 3, started_at = now() + interval '1 minute', reported_at = now() WHERE restaurant_id = $1`, [B]);
  const types = (await timeline(B, 'hub')).map(r => r.type).sort();
  assert.deepEqual(types, ['hub.first_report', 'hub.first_report', 'hub.restarted', 'hub.shelved_changed', 'hub.version_changed'].sort());
});

// --- what the mutation check pointed at ---------------------------------------------------------------------------------------------

test('an event whose type says "alert." or "admin." is that kind whatever its source: the kinds do not claim it twice', async () => {
  const R = (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ('Odd', 'odd-r', 'Nagpur', 'PC-ODD') RETURNING id`)).rows[0].id;
  const a = await record(R, 'razorpay', 'alert.odd', 'webhook');
  const b = await record(R, 'hub', 'alert.odd2', 'hub');
  const c = await record(R, 'razorpay', 'admin.odd', 'webhook');
  const d = await record(R, 'hub', 'admin.odd2', 'hub');
  const plain = await record(R, 'razorpay', 'subscription.charged', 'webhook');
  const hubPlain = await record(R, 'hub', 'hub.restarted', 'hub');
  const idsOf2 = async kind => (await timeline(R, kind)).map(r => Number(r.id));
  assert.deepEqual(await idsOf2('billing'), [plain], 'a Razorpay event named like an alert or an admin action is not billing');
  assert.deepEqual(await idsOf2('hub'), [hubPlain], 'nor is a hub event named like one a hub event');
  assert.deepEqual(await idsOf2('alerts'), [b, a]);
  assert.deepEqual(await idsOf2('admin'), [d, c]);
});

test('over five hundred events, the limit is five hundred', async () => {
  const R = (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ('Busy', 'busy-r', 'Nagpur', 'PC-BUSY') RETURNING id`)).rows[0].id;
  await q(`SELECT public.record_tenant_event($1, 'hub', 'hub.restarted', 'hub', NULL, NULL, '{}'::jsonb) FROM generate_series(1, 520)`, [R]);
  assert.equal((await timeline(R, null, null, 100000)).length, 500);
  assert.equal((await timeline(R, null, null, 500)).length, 500);
  assert.equal((await timeline(R, null, null, 501)).length, 500);
});

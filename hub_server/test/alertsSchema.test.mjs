import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { cloudDb } from './helpers/cloudDb.mjs';

// Migration 024: the alert lifecycle in the database (Phase 2, P2-2 of docs/SUPER_ADMIN_BUILD_SHEET.md). Run on a real Postgres engine (PGlite) with
// Supabase's default privileges modelled, the way the spine's tests are.
//
// What these tests are for: that the alert worker gets through a door of its own (`kullina_alerts`) that holds no privilege on any table and can run
// exactly four functions, that the humans' two actions (acknowledge, resolve) ask who is asking first and cannot be done without a reason, that
// every change to an alert leaves an event on the spine and the chain still verifies, and that an alert cannot be in a state its columns contradict.

let cloud;
let T;
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const F2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
const F3 = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// The whole surface the alert worker may call, and the admin functions this migration adds. A function added to either list is a decision.
const ALERT_FUNCTIONS = ['alert_apply', 'alert_notified', 'alert_notify_failed', 'alert_snapshot'];
const NEW_ADMIN_FUNCTIONS = ['admin_ack_alert', 'admin_alerts', 'admin_resolve_alert'];
const OWNER_ONLY = ['set_tenant_service_hours'];

const aal2 = sub => ({ sub, aal: 'aal2', role: 'authenticated' });
const q = (sql, params) => cloud.pg.query(sql, params);
const rows = async (sql, params) => (await q(sql, params)).rows;
const asAdmin = (claims, sql, params) => cloud.as('kullina_admin', null, async () => {
  await q(`SELECT set_config('request.jwt.claims', $1, false)`, [claims === null ? '' : JSON.stringify(claims)]);
  try { return await q(sql, params); } finally { await q(`SELECT set_config('request.jwt.claims', '', false)`); }
});
const asAlerts = (sql, params) => cloud.as('kullina_alerts', null, () => q(sql, params));
const rejected = async (fn, pattern, label = '') => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected the database to refuse this, and it did not ${label}`);
  if (pattern) assert.match(err.message, pattern, label);
  return err;
};
const DENIED = /admin access denied/i;

const cond = (rule_key, restaurant_id, over = {}) => ({
  restaurant_id, rule_key, severity: { orders_shelved: 'P1', hub_silent_service: 'P1', sync_backlog: 'P2', service_hours_missing: 'P3' }[rule_key] ?? 'P2',
  dedupe_key: `${rule_key}:${restaurant_id}`, detail: { count: 2 }, ...over
});
const apply = (open = [], resolve = [], unattended = [], request = 'req-1') =>
  asAlerts(`SELECT public.alert_apply($1::jsonb, $2::jsonb, $3::jsonb, $4) AS r`, [JSON.stringify(open), JSON.stringify(resolve), JSON.stringify(unattended), request]).then(r => r.rows[0].r);
const alertRow = async id => (await rows(`SELECT * FROM public.alerts WHERE id = $1`, [id]))[0];
// The spine keeps everything for good, so a test looks at the events of its own alert (by the alert's id), not at everything earlier tests left.
const eventsFor = (restaurant, type, alertId = null) => rows(
  `SELECT * FROM public.tenant_events WHERE restaurant_id = $1 AND type = $2 AND ($3::bigint IS NULL OR (payload ->> 'alert_id')::bigint = $3::bigint) ORDER BY id`,
  [restaurant, type, alertId]);
const clearAlerts = () => q(`DELETE FROM public.alerts`);

before(async () => {
  cloud = await cloudDb();
  await q(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  for (const [id, email] of [[F1, 'aman@example.test'], [F2, 'darshil@example.test'], [F3, 'third@example.test'], [OWNER_A, 'owner-a@example.test']]) {
    await q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  }
  await q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  await q(`SELECT public.seed_admin_user('aman@example.test', 'Aman')`);
  await q(`SELECT public.seed_admin_user('darshil@example.test', 'Darshil')`);
});
after(async () => { await cloud?.close(); });

// --- the migration ---------------------------------------------------------------------------------------------------------------

test('the migration applies on top of the others, and again, and changes nothing the second time', async () => {
  const count = async () => (await rows(`SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)::int AS f,
                                                (SELECT count(*) FROM pg_indexes WHERE tablename IN ('alerts', 'tenant_admin_meta'))::int AS i,
                                                (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.alerts'::regclass, 'public.tenant_admin_meta'::regclass))::int AS c`))[0];
  const first = await count();
  await cloud.applyAll({ onlyMigrations: true });
  assert.deepEqual(await count(), first);
});

// --- the worker's door -----------------------------------------------------------------------------------------------------------

test('the worker\'s role exists, cannot sign in until a human gives it a password, and owns nothing', async () => {
  const [r] = await rows(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'kullina_alerts'`);
  assert.deepEqual(r, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'kullina_alerts'::regrole`))[0].n, 0);
});

test('the worker\'s role has no privilege on ANY table or view: it reaches data only through its four functions', async () => {
  const offenders = await rows(`
    SELECT c.relname, p.priv
      FROM pg_class c
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND has_table_privilege('kullina_alerts', c.oid, p.priv)`);
  assert.deepEqual(offenders, []);
});

test('the worker\'s role can run exactly the four alert functions, and no other function that acts with its owner\'s rights', async () => {
  const runnable = await rows(`
    SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege('kullina_alerts', p.oid, 'EXECUTE')
     ORDER BY 1`);
  assert.deepEqual(runnable.map(r => r.proname), [...ALERT_FUNCTIONS].sort());
});

test('the admin role runs the admin functions, now including the three for alerts, and none of the worker\'s', async () => {
  const runnable = await rows(`
    SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege('kullina_admin', p.oid, 'EXECUTE')
     ORDER BY 1`);
  const names = runnable.map(r => r.proname);
  for (const f of NEW_ADMIN_FUNCTIONS) assert.ok(names.includes(f), f);
  for (const f of ALERT_FUNCTIONS) assert.ok(!names.includes(f), `${f} is the worker's, not the console's`);
});

test('every function called alert_ is on the list, so a new one cannot appear without being decided', async () => {
  const named = await rows(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'alert\\_%' ORDER BY 1`);
  assert.deepEqual(named.map(r => r.proname), [...ALERT_FUNCTIONS].sort());
});

test('nobody else may run them: not anon, not a tenant, not the service role, and not the other dedicated role', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const f of [...ALERT_FUNCTIONS, ...NEW_ADMIN_FUNCTIONS, ...OWNER_ONLY]) {
      const [r] = await rows(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $2`, [role, f]);
      assert.equal(r.can, false, `${role} must not run ${f}`);
    }
  }
  for (const f of OWNER_ONLY) {
    for (const role of ['kullina_admin', 'kullina_alerts']) {
      const [r] = await rows(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $2`, [role, f]);
      assert.equal(r.can, false, `${role} must not run ${f}`);
    }
  }
  for (const f of NEW_ADMIN_FUNCTIONS) {
    const [r] = await rows(`SELECT has_function_privilege('kullina_alerts', p.oid, 'EXECUTE') AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [f]);
    assert.equal(r.can, false, `the worker must not acknowledge or resolve as a person: ${f}`);
  }
});

test('the new tables are closed to everyone: row-level security on, and no privilege for any role', async () => {
  for (const t of ['alerts', 'tenant_admin_meta']) {
    const [r] = await rows(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`]);
    assert.equal(r.relrowsecurity, true, t);
    for (const role of ['anon', 'authenticated', 'service_role', 'kullina_admin', 'kullina_alerts']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const [p] = await rows(`SELECT has_table_privilege($1, $2::regclass, $3) AS can`, [role, `public.${t}`, priv]);
        assert.equal(p.can, false, `${role} must not ${priv} ${t}`);
      }
    }
  }
});

test('a tenant owner, anon and the service role cannot read an alert even through the API\'s own door', async () => {
  await clearAlerts();
  await apply([cond('orders_shelved', T.A.restaurant)]);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await rejected(() => cloud.as(role, OWNER_A, () => q(`SELECT * FROM public.alerts`)), /permission denied/i, role);
  }
});

// --- the constraints on an alert -------------------------------------------------------------------------------------------------

const insertRaw = (over = {}) => {
  const a = { restaurant_id: T.A.restaurant, rule_key: 'orders_shelved', severity: 'P1', state: 'open', dedupe_key: `orders_shelved:${T.A.restaurant}`, ...over };
  const cols = Object.keys(a);
  return q(`INSERT INTO public.alerts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map(c => a[c]));
};

test('an alert has one of three severities and one of three states, and a rule', async () => {
  await clearAlerts();
  await rejected(() => insertRaw({ severity: 'P0' }), /alerts_severity_check/);
  await rejected(() => insertRaw({ severity: 'high' }), /alerts_severity_check/);
  await rejected(() => insertRaw({ state: 'snoozed' }), /alerts_state_check/);
  await rejected(() => insertRaw({ rule_key: '  ' }), /alerts_rule_check/);
  await rejected(() => insertRaw({ dedupe_key: '' }), /alerts_dedupe_check/);
});

test('an alert cannot be acknowledged by nobody, or resolved at no time: its columns may not contradict its state', async () => {
  await clearAlerts();
  await rejected(() => insertRaw({ state: 'acked' }), /alerts_state_columns/);
  await rejected(() => insertRaw({ state: 'acked', acked_at: new Date().toISOString() }), /alerts_state_columns/);
  await rejected(() => insertRaw({ state: 'resolved' }), /alerts_state_columns/);
  await rejected(() => insertRaw({ state: 'open', acked_by: F1 }), /alerts_state_columns/, 'an open alert has no acknowledger');
  assert.ok((await insertRaw({ state: 'acked', acked_at: new Date().toISOString(), acked_by: F1 })).rows[0].id);
});

test('an escalation level is zero or more, and detail is an object', async () => {
  await clearAlerts();
  await rejected(() => insertRaw({ escalation_level: -1 }), /alerts_level_check/);
  await rejected(() => insertRaw({ detail: JSON.stringify([1]) }), /alerts_detail_check/);
});

test('only one alert that is not resolved can exist for a key, and a resolved one makes room for the next', async () => {
  await clearAlerts();
  const first = (await insertRaw()).rows[0].id;
  await rejected(() => insertRaw(), /alerts_one_unresolved|duplicate key/);
  await rejected(() => insertRaw({ state: 'acked', acked_at: new Date().toISOString(), acked_by: F1 }), /alerts_one_unresolved|duplicate key/, 'acknowledged still counts');
  await q(`UPDATE public.alerts SET state = 'resolved', resolved_at = now() WHERE id = $1`, [first]);
  assert.ok((await insertRaw()).rows[0].id, 'a new alert for the same key');
});

test('an alert goes when its restaurant does, as the restaurant\'s other data does', async () => {
  await clearAlerts();
  const id = (await q(`INSERT INTO public.restaurants (name, slug, city, pairing_code) VALUES ('Gone', 'gone-r', 'Nagpur', 'PC-GONE') RETURNING id`)).rows[0].id;
  await insertRaw({ restaurant_id: id, dedupe_key: `x:${id}` });
  await q(`INSERT INTO public.tenant_admin_meta (restaurant_id, timezone) VALUES ($1, 'Asia/Kolkata')`, [id]);
  await q(`DELETE FROM public.restaurants WHERE id = $1`, [id]);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.alerts WHERE restaurant_id = $1`, [id]))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [id]))[0].n, 0);
});

// --- service hours ---------------------------------------------------------------------------------------------------------------

test('service hours are set by the database\'s owner, checked, and recorded', async () => {
  const hours = { mon: [['11:00', '23:00']], tue: [['11:00', '15:00'], ['18:00', '02:00']] };
  await q(`SELECT public.set_tenant_service_hours($1, 'Asia/Kolkata', $2::jsonb)`, [T.A.restaurant, JSON.stringify(hours)]);
  const [m] = await rows(`SELECT timezone, service_hours FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [T.A.restaurant]);
  assert.equal(m.timezone, 'Asia/Kolkata');
  assert.deepEqual(m.service_hours, hours);
  const ev = await eventsFor(T.A.restaurant, 'admin.service_hours_set');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, 'system');
  assert.equal(ev[0].actor_type, 'system');
});

test('service hours that cannot be read are refused, as is a time zone that does not exist, and nothing is stored', async () => {
  const before = (await rows(`SELECT service_hours FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [T.A.restaurant]))[0];
  const set = (tz, hours) => q(`SELECT public.set_tenant_service_hours($1, $2, $3::jsonb)`, [T.A.restaurant, tz, JSON.stringify(hours)]);
  await rejected(() => set('Not/AZone', { mon: [['11:00', '23:00']] }), /time zone/i);
  // Postgres itself accepts these, but the worker's reader cannot: so a restaurant would be silently "unknown". They are refused here.
  for (const abbreviation of ['IST', 'UTC+5', 'Etc', '', null]) {
    await rejected(() => set(abbreviation, { mon: [['11:00', '23:00']] }), /time zone/i, String(abbreviation));
  }
  await rejected(() => set('Asia/Kolkata', { mon: [['11:00', '25:00']] }), /service hours/i);
  await rejected(() => set('Asia/Kolkata', { mon: [['11:00']] }), /service hours/i);
  await rejected(() => set('Asia/Kolkata', { mon: [['11:00', '11:00']] }), /service hours/i);
  await rejected(() => set('Asia/Kolkata', { someday: [['11:00', '12:00']] }), /service hours/i);
  await rejected(() => set('Asia/Kolkata', { mon: 'all day' }), /service hours/i);
  await rejected(() => set('Asia/Kolkata', {}), /service hours/i, 'a table with no window is no hours');
  await rejected(() => set('Asia/Kolkata', [['11:00', '12:00']]), /service hours/i);
  await rejected(() => q(`SELECT public.set_tenant_service_hours($1, 'Asia/Kolkata', 'null'::jsonb)`, [T.A.restaurant]), /service hours/i);
  assert.deepEqual((await rows(`SELECT service_hours FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [T.A.restaurant]))[0], before);
});

test('setting hours for a restaurant that does not exist is refused', async () => {
  await rejected(() => q(`SELECT public.set_tenant_service_hours('99999999-9999-4999-8999-999999999999', 'Asia/Kolkata', '{"mon":[["11:00","12:00"]]}'::jsonb)`), /restaurant/i);
});

// --- what the worker reads -------------------------------------------------------------------------------------------------------

test('the snapshot is the fleet, each restaurant\'s hours and the alerts not yet resolved: and only the columns the rules need', async () => {
  await clearAlerts();
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, queued, quarantined) VALUES ($1, now(), 7, 2) ON CONFLICT (restaurant_id) DO UPDATE SET queued = 7, quarantined = 2`, [T.A.restaurant]);
  await apply([cond('orders_shelved', T.A.restaurant)]);
  const [{ s }] = (await asAlerts(`SELECT public.alert_snapshot() AS s`)).rows;
  const a = s.tenants.find(t => t.restaurant_id === T.A.restaurant);
  assert.equal(a.name, 'Restaurant A');
  assert.equal(a.hub_quarantined, 2);
  assert.equal(a.hub_queued, 7);
  assert.deepEqual(Object.keys(a).sort(), ['hub_quarantined', 'hub_queued', 'hub_seen_at', 'name', 'plan_status', 'restaurant_id']);
  assert.deepEqual(s.meta[T.A.restaurant].timezone, 'Asia/Kolkata');
  assert.ok(s.meta[T.A.restaurant].service_hours.mon);
  assert.equal(s.meta[T.B.restaurant], undefined, 'a restaurant with no meta has no entry');
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].restaurant_name, 'Restaurant A');
  assert.equal(s.complete, true);
  assert.ok(Date.parse(s.now) > 0, 'the database\'s own clock, so the worker\'s skew cannot move a deadline');
});

test('a snapshot that had to stop early says so, so nothing is resolved on the strength of it', async () => {
  const [{ s }] = (await asAlerts(`SELECT public.alert_snapshot(1) AS s`)).rows;
  assert.equal(s.complete, false);
  assert.equal(s.tenants.length, 1);
});

test('the snapshot does not include resolved alerts', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await apply([], [{ id: opened[0].id, reason: 'condition_cleared' }]);
  const [{ s }] = (await asAlerts(`SELECT public.alert_snapshot() AS s`)).rows;
  assert.deepEqual(s.alerts, []);
});

// --- opening, resolving and flagging ---------------------------------------------------------------------------------------------

test('opening an alert stores it and leaves an event on the restaurant\'s own chain', async () => {
  await clearAlerts();
  const out = await apply([cond('orders_shelved', T.A.restaurant, { detail: { count: 3 } })], [], [], 'req-open');
  assert.equal(out.opened.length, 1);
  const a = await alertRow(out.opened[0].id);
  assert.deepEqual([a.state, a.severity, a.rule_key, a.dedupe_key, a.escalation_level, a.last_notified_at, a.unattended_at],
    ['open', 'P1', 'orders_shelved', `orders_shelved:${T.A.restaurant}`, 0, null, null]);
  assert.deepEqual(a.detail, { count: 3 });
  assert.ok(a.opened_at);
  const [e] = await eventsFor(T.A.restaurant, 'alert.opened', a.id);
  assert.deepEqual([e.source, e.actor_type, e.actor_id, e.request_id], ['system', 'system', null, 'req-open']);
  assert.deepEqual(e.payload, { alert_id: a.id, rule_key: 'orders_shelved', severity: 'P1', detail: { count: 3 } });
});

test('opening the same alert twice opens it once, and records it once', async () => {
  await clearAlerts();
  const first = await apply([cond('orders_shelved', T.A.restaurant)]);
  const again = await apply([cond('orders_shelved', T.A.restaurant)]);
  assert.equal(first.opened.length, 1);
  assert.deepEqual(again.opened, []);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.alerts`))[0].n, 1);
  assert.equal((await eventsFor(T.A.restaurant, 'alert.opened', first.opened[0].id)).length, 1);
});

test('an alert for a restaurant that has gone is skipped, and does not stop the others being opened', async () => {
  await clearAlerts();
  const out = await apply([cond('orders_shelved', '99999999-9999-4999-8999-999999999999'), cond('sync_backlog', T.B.restaurant)]);
  assert.deepEqual(out.opened.map(o => o.dedupe_key), [`sync_backlog:${T.B.restaurant}`]);
});

test('what is sent is checked: a bad severity, an empty rule, or something that is not a list, is refused and nothing is written', async () => {
  await clearAlerts();
  await rejected(() => apply([cond('orders_shelved', T.A.restaurant, { severity: 'P0' })]), /severity/i);
  await rejected(() => apply([cond('orders_shelved', T.A.restaurant, { rule_key: '' })]), /rule/i);
  await rejected(() => apply([cond('orders_shelved', T.A.restaurant, { dedupe_key: '' })]), /key/i);
  await rejected(() => asAlerts(`SELECT public.alert_apply('{"a":1}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'r')`), /list/i);
  await rejected(() => asAlerts(`SELECT public.alert_apply('[]'::jsonb, 'null'::jsonb, '[]'::jsonb, 'r')`), /list/i);
  await rejected(() => apply([cond('orders_shelved', T.A.restaurant), cond('sync_backlog', T.A.restaurant, { severity: 'bad' })]), /severity/i);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.alerts`))[0].n, 0, 'all or nothing');
});

test('an alert a worker opens carries only the detail it was given, as an object', async () => {
  await clearAlerts();
  await rejected(() => apply([cond('orders_shelved', T.A.restaurant, { detail: [1, 2] })]), /detail/i);
  const out = await apply([cond('orders_shelved', T.A.restaurant, { detail: undefined })]);
  assert.deepEqual((await alertRow(out.opened[0].id)).detail, {}, 'no detail is an empty object');
});

test('resolving an alert marks it resolved, says why, and leaves an event; resolving it again does nothing', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  const out = await apply([], [{ id, reason: 'condition_cleared' }], [], 'req-res');
  assert.deepEqual(out.resolved, [id]);
  const a = await alertRow(id);
  assert.equal(a.state, 'resolved');
  assert.ok(a.resolved_at);
  assert.equal(a.resolved_by, null, 'resolved by the system, not by a person');
  assert.equal(a.resolve_reason, 'condition_cleared');
  const [e] = await eventsFor(T.A.restaurant, 'alert.resolved', id);
  assert.deepEqual(e.payload, { alert_id: id, rule_key: 'orders_shelved', reason: 'condition_cleared', by: 'system' });
  assert.deepEqual((await apply([], [{ id, reason: 'condition_cleared' }])).resolved, []);
  assert.equal((await eventsFor(T.A.restaurant, 'alert.resolved', id)).length, 1);
});

test('an acknowledged alert whose condition clears is resolved too', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, 'looking into it')`, [opened[0].id]);
  assert.deepEqual((await apply([], [{ id: opened[0].id, reason: 'condition_cleared' }])).resolved, [opened[0].id]);
});

test('an alert is flagged unattended once, with an event', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  assert.deepEqual((await apply([], [], [id])).flagged, [id]);
  assert.ok((await alertRow(id)).unattended_at);
  assert.deepEqual((await apply([], [], [id])).flagged, [], 'once');
  assert.equal((await eventsFor(T.A.restaurant, 'alert.unattended', id)).length, 1);
});

test('a resolved alert is not flagged unattended', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await apply([], [{ id: opened[0].id, reason: 'condition_cleared' }]);
  assert.deepEqual((await apply([], [], [opened[0].id])).flagged, []);
});

// --- paging ----------------------------------------------------------------------------------------------------------------------

test('a page that went out is recorded, level by level, and a level out of turn is refused', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  const mark = (level, request = 'r') => asAlerts(`SELECT public.alert_notified($1, $2, $3) AS ok`, [id, level, request]).then(r => r.rows[0].ok);
  await rejected(() => mark(1), /level/i, 'the first page is level 0');
  assert.equal(await mark(0), true);
  let a = await alertRow(id);
  assert.equal(a.escalation_level, 0);
  assert.ok(a.last_notified_at);
  await rejected(() => mark(0), /level/i, 'not the same page twice');
  await rejected(() => mark(2), /level/i, 'and not skipping one');
  assert.equal(await mark(1), true);
  a = await alertRow(id);
  assert.equal(a.escalation_level, 1);
  const ev = await eventsFor(T.A.restaurant, 'alert.notified', id);
  assert.deepEqual(ev.map(e => e.payload.level), [0, 1]);
  assert.deepEqual(ev[0].payload, { alert_id: id, level: 0 });
});

test('a page is not recorded for an alert that was acknowledged or resolved while it was being sent: that is not an error', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, 'on it, looking now')`, [id]);
  assert.equal((await asAlerts(`SELECT public.alert_notified($1, 0, 'r') AS ok`, [id])).rows[0].ok, false);
  assert.equal((await alertRow(id)).last_notified_at, null);
  assert.equal((await asAlerts(`SELECT public.alert_notified(999999, 0, 'r') AS ok`)).rows[0].ok, false, 'nor one that does not exist');
});

test('a page that could not be sent is recorded, at most once in ten minutes, and its note is short and is all there is', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  const fail = note => asAlerts(`SELECT public.alert_notify_failed($1, 0, $2, 'r') AS ok`, [id, note]).then(r => r.rows[0].ok);
  assert.equal(await fail('x'.repeat(500)), true);
  assert.equal(await fail('again'), false, 'the second within ten minutes is not recorded');
  const ev = await eventsFor(T.A.restaurant, 'alert.notify_failed', id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.note.length, 200);
  assert.deepEqual(Object.keys(ev[0].payload).sort(), ['alert_id', 'level', 'note']);
  assert.equal((await alertRow(id)).last_notified_at, null, 'and the alert is still due');
  // The throttle's clock is on the alert, so a test can move it: nine minutes on is still too soon, eleven is not.
  await q(`UPDATE public.alerts SET notify_failed_at = now() - interval '9 minutes' WHERE id = $1`, [id]);
  assert.equal(await fail('still failing'), false, 'nine minutes is not ten');
  await q(`UPDATE public.alerts SET notify_failed_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
  assert.equal(await fail('still failing'), true, 'eleven minutes is');
  assert.equal((await eventsFor(T.A.restaurant, 'alert.notify_failed', id)).length, 2);
});

// --- the console's two actions ---------------------------------------------------------------------------------------------------

test('listing alerts asks who is asking: a tenant, an administrator without a second factor, and nobody are all refused', async () => {
  await clearAlerts();
  await apply([cond('orders_shelved', T.A.restaurant)]);
  await rejected(() => asAdmin(null, `SELECT * FROM public.admin_alerts()`), DENIED, 'nobody');
  await rejected(() => asAdmin(aal2(OWNER_A), `SELECT * FROM public.admin_alerts()`), DENIED, 'a tenant owner');
  await rejected(() => asAdmin(aal2(F3), `SELECT * FROM public.admin_alerts()`), DENIED, 'a user not on the allowlist');
  await rejected(() => asAdmin({ sub: F1, aal: 'aal1' }, `SELECT * FROM public.admin_alerts()`), DENIED, 'no second factor');
});

test('an administrator lists alerts newest first, with the restaurant\'s name, and can filter by state', async () => {
  await clearAlerts();
  const a = await apply([cond('orders_shelved', T.A.restaurant)]);
  const b = await apply([cond('sync_backlog', T.B.restaurant)]);
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, 'seen and understood')`, [a.opened[0].id]);
  const all = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_alerts()`)).rows;
  assert.deepEqual(all.map(r => r.id), [b.opened[0].id, a.opened[0].id]);
  assert.equal(all[1].restaurant_name, 'Restaurant A');
  assert.equal(all[1].acked_by_email, 'aman@example.test');
  assert.deepEqual((await asAdmin(aal2(F1), `SELECT id FROM public.admin_alerts('open')`)).rows.map(r => r.id), [b.opened[0].id]);
  assert.deepEqual((await asAdmin(aal2(F1), `SELECT id FROM public.admin_alerts('acked')`)).rows.map(r => r.id), [a.opened[0].id]);
  assert.equal((await asAdmin(aal2(F1), `SELECT * FROM public.admin_alerts(NULL, 1)`)).rows.length, 1);
  await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_alerts('snoozed')`), /state/i);
  await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_alerts(NULL, 0)`), /limit/i);
});

test('acknowledging asks who is asking and needs a reason', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  await rejected(() => asAdmin(null, `SELECT * FROM public.admin_ack_alert($1, 'x')`, [id]), DENIED);
  await rejected(() => asAdmin(aal2(OWNER_A), `SELECT * FROM public.admin_ack_alert($1, 'x')`, [id]), DENIED);
  await rejected(() => asAdmin({ sub: F1, aal: 'aal1' }, `SELECT * FROM public.admin_ack_alert($1, 'x')`, [id]), DENIED);
  // Invariant I4: a reason of at least ten characters, counted after trimming.
  for (const bad of ['', '   ', null, 'x', '123456789', '  123456789  ', 'a'.repeat(501)]) {
    await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, $2)`, [id, bad]), /reason/i, JSON.stringify(bad));
  }
  assert.equal((await alertRow(id)).state, 'open', 'nothing changed');
  const ok = await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, $2)`, [id, '  1234567890  ']);
  assert.equal(ok.rows[0].state, 'acked', 'ten characters is enough, and the padding does not count');
  assert.equal((await alertRow(id)).ack_reason, '1234567890');
  const long = (await apply([cond('sync_backlog', T.A.restaurant)])).opened[0].id;
  assert.equal((await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, $2)`, [long, 'a'.repeat(500)])).rows[0].state, 'acked', 'five hundred is the most');
});

test('acknowledging records who, when and why, and leaves an event naming the person', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  const [r] = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, '  checking with the owner  ')`, [id])).rows;
  assert.equal(r.state, 'acked');
  const a = await alertRow(id);
  assert.deepEqual([a.state, a.acked_by, a.ack_reason], ['acked', F1, 'checking with the owner']);
  assert.ok(a.acked_at);
  const [e] = await eventsFor(T.A.restaurant, 'alert.acked', id);
  assert.deepEqual([e.source, e.actor_type, e.actor_id], ['admin', 'admin', F1]);
  assert.deepEqual(e.payload, { alert_id: id, rule_key: 'orders_shelved', reason: 'checking with the owner' });
  assert.equal(Number(r.event_id), Number(e.id));
});

test('acknowledging twice changes nothing and records nothing; an unknown or resolved alert cannot be acknowledged', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, 'first acknowledgement')`, [id]);
  await asAdmin(aal2(F2), `SELECT * FROM public.admin_ack_alert($1, 'second acknowledgement')`, [id]);
  const a = await alertRow(id);
  assert.deepEqual([a.acked_by, a.ack_reason], [F1, 'first acknowledgement'], 'the first acknowledgement stands');
  assert.equal((await eventsFor(T.A.restaurant, 'alert.acked', id)).length, 1);
  // Told apart by their own error codes, so the API can say 404 and 409 rather than guessing from words.
  const missing = await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert(999999, 'no such alert, truly')`), /not found|no such/i);
  assert.equal(missing.code, 'P0002', 'no_data_found');
  await apply([], [{ id, reason: 'condition_cleared' }]);
  const late = await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_ack_alert($1, 'too late, it cleared')`, [id]), /resolved/i);
  assert.equal(late.code, '55000', 'object_not_in_prerequisite_state');
});

test('resolving asks who is asking and needs a reason; from open or acknowledged; leaves an event naming the person', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant), cond('sync_backlog', T.A.restaurant)]);
  const [a1, a2] = opened.map(o => o.id);
  await rejected(() => asAdmin(null, `SELECT * FROM public.admin_resolve_alert($1, 'x')`, [a1]), DENIED);
  await rejected(() => asAdmin(aal2(OWNER_A), `SELECT * FROM public.admin_resolve_alert($1, 'x')`, [a1]), DENIED);
  await rejected(() => asAdmin({ sub: F1, aal: 'aal1' }, `SELECT * FROM public.admin_resolve_alert($1, 'x')`, [a1]), DENIED);
  for (const bad of [' ', 'x', '123456789', '  123456789  ', 'a'.repeat(501)]) {
    await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, $2)`, [a1, bad]), /reason/i, JSON.stringify(bad));
  }
  await asAdmin(aal2(F2), `SELECT * FROM public.admin_ack_alert($1, 'on it, looking now')`, [a2]);
  const r1 = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'owner restarted the hub')`, [a1])).rows[0];
  const r2 = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'fixed by the owner')`, [a2])).rows[0];
  assert.deepEqual([r1.state, r2.state], ['resolved', 'resolved']);
  const a = await alertRow(a1);
  assert.deepEqual([a.state, a.resolved_by, a.resolve_reason], ['resolved', F1, 'owner restarted the hub']);
  const evs = await eventsFor(T.A.restaurant, 'alert.resolved', a1);
  const e = evs.find(x => x.payload.alert_id === a1);
  assert.deepEqual([e.source, e.actor_type, e.actor_id], ['admin', 'admin', F1]);
  assert.deepEqual(e.payload, { alert_id: a1, rule_key: 'orders_shelved', reason: 'owner restarted the hub', by: 'admin' });
});

test('resolving a resolved or unknown alert is refused', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'done and dusted')`, [opened[0].id]);
  const again = await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'again, in error')`, [opened[0].id]), /already resolved/i);
  assert.equal(again.code, '55000');
  const missing = await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert(999999, 'no such alert, truly')`), /not found|no such/i);
  assert.equal(missing.code, 'P0002');
  const fresh = (await apply([cond('orders_shelved', T.B.restaurant)])).opened[0].id;
  assert.equal((await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, $2)`, [fresh, '  1234567890  '])).rows[0].state, 'resolved', 'ten characters is enough');
  assert.equal((await alertRow(fresh)).resolve_reason, '1234567890');
});

test('a person who resolved an alert that is still true: it can be opened afresh, as a new alert, on the next pass', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'closed by mistake')`, [opened[0].id]);
  const again = await apply([cond('orders_shelved', T.A.restaurant)]);
  assert.equal(again.opened.length, 1);
  assert.notEqual(again.opened[0].id, opened[0].id);
});

// --- the details the mutation check pointed at --------------------------------------------------------------------------------------

test('the person who acknowledges is the person named, whoever they are: the second founder too', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  await asAdmin(aal2(F2), `SELECT * FROM public.admin_ack_alert($1, 'Darshil is calling them')`, [id]);
  const a = await alertRow(id);
  assert.equal(a.acked_by, F2);
  const [e] = await eventsFor(T.A.restaurant, 'alert.acked', id);
  assert.equal(e.actor_id, F2);
  const listed = (await asAdmin(aal2(F1), `SELECT acked_by_email FROM public.admin_alerts('acked')`)).rows.find(r => r.acked_by_email);
  assert.equal(listed.acked_by_email, 'darshil@example.test');
});

test('and the one who resolves is the one named', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  await asAdmin(aal2(F2), `SELECT * FROM public.admin_resolve_alert($1, 'the owner rang back')`, [opened[0].id]);
  assert.equal((await alertRow(opened[0].id)).resolved_by, F2);
});

test('the worker must give a reason for resolving, and the lists it sends must be lists: each of the three, by name', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  for (const bad of [{ id }, { id, reason: '' }, { id, reason: '   ' }]) {
    await rejected(() => apply([], [bad]), /reason/i, JSON.stringify(bad));
  }
  assert.equal((await alertRow(id)).state, 'open', 'and nothing was resolved');
  await rejected(() => asAlerts(`SELECT public.alert_apply('[]'::jsonb, '[]'::jsonb, '{"a":1}'::jsonb, 'r')`), /list/i, 'the third');
  await rejected(() => asAlerts(`SELECT public.alert_apply('[]'::jsonb, '[]'::jsonb, NULL, 'r')`), /list/i, 'a missing third');
  await rejected(() => asAlerts(`SELECT public.alert_apply(NULL, '[]'::jsonb, '[]'::jsonb, 'r')`), /list/i, 'a missing first');
});

test('a failed page is not recorded for an alert that is no longer open', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  await asAdmin(aal2(F1), `SELECT * FROM public.admin_resolve_alert($1, 'closed before the page')`, [id]);
  assert.equal((await asAlerts(`SELECT public.alert_notify_failed($1, 0, 'x', 'r') AS ok`, [id])).rows[0].ok, false);
  assert.equal((await eventsFor(T.A.restaurant, 'alert.notify_failed', id)).length, 0);
  assert.equal((await alertRow(id)).notify_failed_at, null);
});

test('a page that goes out clears the record of a failure, so the next failure is recorded at once', async () => {
  await clearAlerts();
  const { opened } = await apply([cond('orders_shelved', T.A.restaurant)]);
  const id = opened[0].id;
  assert.equal((await asAlerts(`SELECT public.alert_notify_failed($1, 0, 'down', 'r') AS ok`, [id])).rows[0].ok, true);
  assert.ok((await alertRow(id)).notify_failed_at);
  assert.equal((await asAlerts(`SELECT public.alert_notified($1, 0, 'r') AS ok`, [id])).rows[0].ok, true);
  assert.equal((await alertRow(id)).notify_failed_at, null);
  assert.equal((await asAlerts(`SELECT public.alert_notify_failed($1, 1, 'down again', 'r') AS ok`, [id])).rows[0].ok, true, 'not throttled by the old failure');
});

test('setting hours again replaces them, and a restaurant that is not there is said to be so, not left to a constraint', async () => {
  const first = { mon: [['11:00', '15:00']] };
  const second = { sun: [['09:00', '12:00']] };
  await q(`SELECT public.set_tenant_service_hours($1, 'Asia/Kolkata', $2::jsonb)`, [T.B.restaurant, JSON.stringify(first)]);
  await q(`SELECT public.set_tenant_service_hours($1, 'Asia/Dubai', $2::jsonb)`, [T.B.restaurant, JSON.stringify(second)]);
  const [m] = await rows(`SELECT timezone, service_hours FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [T.B.restaurant]);
  assert.deepEqual([m.timezone, m.service_hours], ['Asia/Dubai', second]);
  await rejected(() => q(`SELECT public.set_tenant_service_hours('99999999-9999-4999-8999-999999999999', 'Asia/Kolkata', '{"mon":[["11:00","12:00"]]}'::jsonb)`), /no such restaurant/i);
});

// --- the spine -------------------------------------------------------------------------------------------------------------------

test('after all of that, every restaurant\'s chain of events still verifies', async () => {
  for (const r of [T.A.restaurant, T.B.restaurant]) {
    const [v] = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_verify_chain($1)`, [r])).rows;
    assert.equal(v.ok, true, r);
    assert.ok(v.checked > 0);
  }
});

test('no alert event holds a secret or a person\'s details: only ids, rule names, counts, times and the reasons people typed', async () => {
  const evs = await rows(`SELECT type, payload FROM public.tenant_events WHERE type LIKE 'alert.%'`);
  assert.ok(evs.length > 5);
  const allowed = new Set(['alert_id', 'rule_key', 'severity', 'detail', 'reason', 'by', 'level', 'note']);
  for (const e of evs) for (const k of Object.keys(e.payload)) assert.ok(allowed.has(k), `${e.type} has a payload key ${k}`);
});

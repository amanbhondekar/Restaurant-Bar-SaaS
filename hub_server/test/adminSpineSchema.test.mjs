import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient } from './helpers/pgrest.mjs';

// Migration 023: the super admin console's foundation (Phase 1 of docs/SUPER_ADMIN_BUILD_SHEET.md) -- who may use it, the event spine
// everything is recorded on, and the one door the admin API gets through. Run on a real Postgres engine (PGlite) with Supabase's default
// privileges modelled.
//
// What these tests are for: the sheet's Phase 1 acceptance criteria, (a) a tenant owner calling an admin RPC is denied, (b) an admin
// without MFA is denied, (c) UPDATE and DELETE on the spine fail for every role, (d) tampering with a row breaks the hash chain check, (e)
// an admin event with no actor is rejected -- and the default-deny pin: the dedicated `kullina_admin` role can do EXACTLY the listed things
// and nothing else, so no admin path reaches a tenant's bills, menu or orders (invariant I1).

let cloud;
let T;
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const F2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
const F3 = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
const OWNER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// The whole surface the admin API is allowed to call. A function added to this list is a decision; one that appears without it fails the pin below.
const ADMIN_RPCS = [
  // (migration 024 added the three for alerts: admin_ack_alert, admin_alerts, admin_resolve_alert; their own tests are in alertsSchema.test.mjs)
  'admin_ack_alert', 'admin_alerts', 'admin_fleet', 'admin_list_events', 'admin_ops_events', 'admin_record_signin', 'admin_resolve_alert',
  'admin_tenant', 'admin_tenant_subscriptions', 'admin_verify_chain', 'admin_whoami'
];
// Not callable by anyone but the database's owner (and, where stated, the operator service): they are how the rest is built.
const OWNER_ONLY = ['spine_assert_admin', 'record_tenant_event', 'tenant_events_verify', 'seed_admin_user', 'deactivate_admin_user'];
const SERVICE_ONLY = ['spine_backfill_subscription_events'];

const aal2 = sub => ({ sub, aal: 'aal2', role: 'authenticated' });
const q = (sql, params) => cloud.pg.query(sql, params);
const rows = async (sql, params) => (await q(sql, params)).rows;

/** Run SQL the way the admin API does: as the dedicated role, with the caller's token claims in the request settings. */
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

before(async () => {
  cloud = await cloudDb();
  await q(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  T = await cloud.seedTenants();
  for (const [id, email] of [[F1, 'aman@example.test'], [F2, 'darshil@example.test'], [F3, 'third@example.test'], [OWNER_A, 'owner-a@example.test']]) {
    await q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  }
  await q(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, 'Owner A', 'owner')`, [T.A.restaurant, OWNER_A]);
  await q(`SELECT public.seed_admin_user('aman@example.test', 'Aman')`);
  await q(`SELECT public.seed_admin_user('Darshil@Example.test', 'Darshil')`);
});
after(async () => { await cloud?.close(); });

// --- the migration -----------------------------------------------------------------------------------------------------------

test('the migration applies on top of the others, and again, and changes nothing the second time', async () => {
  const count = async () => (await rows(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.tenant_events'::regclass, 'public.admin_users'::regclass))::int AS t,
                                                (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)::int AS f`))[0];
  const first = await count();
  await cloud.applyAll({ onlyMigrations: true });
  assert.deepEqual(await count(), first);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.admin_users`))[0].n, 2, 'and the founders are still there');
});

// --- default-deny: what the dedicated role can do ------------------------------------------------------------------------------

test('the dedicated role exists, cannot sign in until a human gives it a password, and owns nothing', async () => {
  const [r] = await rows(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = 'kullina_admin'`);
  assert.deepEqual(r, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: true });
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'kullina_admin'::regrole`))[0].n, 0);
});

test('the dedicated role has no privilege on ANY table or view: it reaches data only through the listed functions', async () => {
  const offenders = await rows(`
    SELECT c.relname, p.priv
      FROM pg_class c
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND has_table_privilege('kullina_admin', c.oid, p.priv)`);
  assert.deepEqual(offenders, [], 'the dedicated role must hold nothing on tables');
});

test('the dedicated role can run exactly the listed admin functions, and no other function that acts with its owner\'s rights', async () => {
  const runnable = await rows(`
    SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
       AND has_function_privilege('kullina_admin', p.oid, 'EXECUTE')
     ORDER BY 1`);
  assert.deepEqual(runnable.map(r => r.proname), [...ADMIN_RPCS].sort());
});

test('every function called admin_ is on the list, so a new one cannot appear without being decided', async () => {
  const named = await rows(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'admin\\_%' ORDER BY 1`);
  assert.deepEqual(named.map(r => r.proname), [...ADMIN_RPCS].sort());
});

test('nobody else may run the admin functions, the builders or the seed: not anon, not a tenant, not the service role (bar its one job)', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const name of [...ADMIN_RPCS, ...OWNER_ONLY, ...SERVICE_ONLY]) {
      if (role === 'service_role' && SERVICE_ONLY.includes(name)) continue;
      const [r] = await rows(`SELECT bool_or(has_function_privilege($1, p.oid, 'EXECUTE')) AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $2`, [role, name]);
      assert.equal(r.can, false, `${role} can run ${name}`);
    }
  }
  const [svc] = await rows(`SELECT bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) AS can FROM pg_proc p WHERE p.proname = 'spine_backfill_subscription_events'`);
  assert.equal(svc.can, true, 'the operator service runs the backfill');
  for (const name of OWNER_ONLY) {
    const [r] = await rows(`SELECT bool_or(has_function_privilege('kullina_admin', p.oid, 'EXECUTE')) AS can FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [name]);
    assert.equal(r.can, false, `kullina_admin can run ${name}`);
  }
});

test('no one holds any privilege on the allowlist or the spine: they are read and written only through functions', async () => {
  for (const table of ['admin_users', 'tenant_events']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'kullina_admin']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const [r] = await rows(`SELECT has_table_privilege($1, $2, $3) AS can`, [role, `public.${table}`, priv]);
        assert.equal(r.can, false, `${role} holds ${priv} on ${table}`);
      }
    }
  }
});

test('row-level security is on for the allowlist and the spine, as a second wall behind the missing privileges', async () => {
  const flags = await rows(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('admin_users', 'tenant_events') ORDER BY 1`);
  assert.deepEqual(flags.map(r => [r.relname, r.relrowsecurity]), [['admin_users', true], ['tenant_events', true]]);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('admin_users', 'tenant_events')`))[0].n, 0, 'and no policy: nobody is let in by one');
});

test('the spine\'s id counter cannot be used by anyone but the database\'s owner', async () => {
  for (const role of ['anon', 'authenticated', 'service_role', 'kullina_admin']) {
    for (const priv of ['USAGE', 'SELECT', 'UPDATE']) {
      const [r] = await rows(`SELECT has_sequence_privilege($1, 'public.tenant_events_id_seq', $2) AS can`, [role, priv]);
      assert.equal(r.can, false, `${role} holds ${priv} on the counter`);
    }
  }
});

test('no admin function reaches a tenant\'s bills, cash-ups, menu, orders, guests or bookings (invariant I1)', async () => {
  const forbidden = /\b(invoices|invoice_events|reconciliations|guest_feedback|menu_items|menu_categories|order_items|orders|reservations|walkins|tables|inventory_items|recipes|staff_users|device_pairings)\b/i;
  const defs = await rows(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE 'admin\\_%' OR p.proname IN ('spine_assert_admin', 'record_tenant_event', 'tenant_events_verify', 'seed_admin_user', 'deactivate_admin_user', 'spine_backfill_subscription_events'))`);
  assert.ok(defs.length >= ADMIN_RPCS.length + OWNER_ONLY.length);
  for (const { proname, def } of defs) {
    const body = def.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(body, forbidden, `${proname} touches a tenant table`);
  }
});

// --- who may get in (acceptance a, b) ---------------------------------------------------------------------------------------------

test('(a) a tenant\'s owner, a hub, and anyone not on the allowlist are refused by every admin function, even with MFA', async () => {
  for (const who of [OWNER_A, T.A.user, T.B.user, F3, '99999999-9999-4999-8999-999999999999']) {
    for (const call of [
      `SELECT * FROM public.admin_whoami()`,
      `SELECT public.admin_record_signin('r1')`,
      `SELECT * FROM public.admin_list_events()`,
      `SELECT * FROM public.admin_verify_chain()`,
      `SELECT * FROM public.admin_fleet()`,
      `SELECT * FROM public.admin_tenant('${T.A.restaurant}')`,
      `SELECT * FROM public.admin_ops_events()`,
      `SELECT * FROM public.admin_tenant_subscriptions('${T.A.restaurant}')`
    ]) {
      await rejected(() => asAdmin(aal2(who), call), DENIED);
    }
  }
});

test('(a) the refusal says why, so a tenant\'s owner is not confused with a missing token or a missing second factor', async () => {
  await rejected(() => asAdmin(aal2(OWNER_A), `SELECT * FROM public.admin_whoami()`), /not an active administrator/i);
  await rejected(() => asAdmin(aal2(T.A.user), `SELECT * FROM public.admin_fleet()`), /not an active administrator/i);
});

test('(a) a tenant\'s own login cannot even reach the functions: no privilege to run them', async () => {
  for (const role of ['authenticated', 'anon']) {
    await rejected(() => cloud.as(role, OWNER_A, () => q(`SELECT * FROM public.admin_whoami()`)), /permission denied/i);
    await rejected(() => cloud.as(role, OWNER_A, () => q(`SELECT * FROM public.admin_list_events()`)), /permission denied/i);
  }
});

test('(b) a founder without MFA is refused: a password alone, no MFA claim, or a wrong level', async () => {
  for (const claims of [{ sub: F1, aal: 'aal1' }, { sub: F1 }, { sub: F1, aal: 'AAL2 ' }, { sub: F1, aal: '' }, { sub: F1, aal: null }]) {
    await rejected(() => asAdmin(claims, `SELECT * FROM public.admin_whoami()`), /admin access denied.*(multi-factor|aal2)/i);
  }
});

test('no token at all, an unreadable one, or no subject is refused', async () => {
  const NOBODY = /no signed-in user/i;
  await rejected(() => asAdmin(null, `SELECT * FROM public.admin_whoami()`), NOBODY);
  for (const odd of ['not json', '[1,2]', '"text"', '42', 'null']) {
    await rejected(() => cloud.as('kullina_admin', null, async () => {
      await q(`SELECT set_config('request.jwt.claims', $1, false)`, [odd]);
      try { return await q(`SELECT * FROM public.admin_whoami()`); } finally { await q(`SELECT set_config('request.jwt.claims', '', false)`); }
    }), NOBODY, odd);
  }
  await rejected(() => asAdmin({ aal: 'aal2' }, `SELECT * FROM public.admin_whoami()`), NOBODY);
  await rejected(() => asAdmin({ sub: 'not-a-uuid', aal: 'aal2' }, `SELECT * FROM public.admin_whoami()`), NOBODY);
  await rejected(() => asAdmin({ sub: '', aal: 'aal2' }, `SELECT * FROM public.admin_whoami()`), NOBODY);
});

test('the subject is read from the signed claims, not from the older single-claim setting a caller could set', async () => {
  await rejected(() => cloud.as('kullina_admin', F1, async () => {   // `as` sets request.jwt.claim.sub = F1
    await q(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ aal: 'aal2' })]);
    try { return await q(`SELECT * FROM public.admin_whoami()`); } finally { await q(`SELECT set_config('request.jwt.claims', '', false)`); }
  }), DENIED);
});

test('a founder with MFA is let in and told who they are', async () => {
  const [me] = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_whoami()`)).rows;
  assert.deepEqual([me.user_id, me.email, me.display_name, me.role, me.aal], [F1, 'aman@example.test', 'Aman', 'founder', 'aal2']);
  const [two] = (await asAdmin(aal2(F2), `SELECT * FROM public.admin_whoami()`)).rows;
  assert.equal(two.email, 'darshil@example.test', 'the email is kept as the person\'s own, in lower case');
});

// --- the allowlist ------------------------------------------------------------------------------------------------------------------

test('exactly two founders can be active: a third is refused until one is deactivated, with a reason', async () => {
  await rejected(() => q(`SELECT public.seed_admin_user('third@example.test', 'Third')`), /at most two/i);
  await rejected(() => q(`SELECT public.deactivate_admin_user('darshil@example.test', 'short')`), /reason/i);
  await q(`SELECT public.deactivate_admin_user('darshil@example.test', 'left the company, access removed')`);
  await rejected(() => asAdmin(aal2(F2), `SELECT * FROM public.admin_whoami()`), DENIED);
  await q(`SELECT public.seed_admin_user('third@example.test', 'Third')`);
  await rejected(() => q(`SELECT public.seed_admin_user('darshil@example.test', 'Darshil')`), /at most two/i);
  // put it back the way the other tests expect
  await q(`SELECT public.deactivate_admin_user('third@example.test', 'only here to test the limit')`);
  await q(`SELECT public.seed_admin_user('darshil@example.test', 'Darshil')`);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.admin_users WHERE active`))[0].n, 2);
});

test('seeding an existing founder again changes nothing, and a person who has not signed up to Auth cannot be seeded', async () => {
  const before = (await rows(`SELECT count(*)::int AS n FROM public.tenant_events`))[0].n;
  await q(`SELECT public.seed_admin_user('AMAN@example.test', 'Aman')`);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.admin_users`))[0].n, 3, 'two founders and the deactivated third; nobody twice');
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.tenant_events`))[0].n, before, 'and no event for a no-op');
  await rejected(() => q(`SELECT public.seed_admin_user('nobody@example.test', 'Nobody')`), /sign up|no such user|auth/i);
});

test('the allowlist\'s own checks hold for a row written directly: an email in lower case, a role that exists', async () => {
  await q(`INSERT INTO auth.users (id, email) VALUES ('99999999-9999-4999-8999-999999999991', 'direct@example.test')`);
  await rejected(() => q(`INSERT INTO public.admin_users (user_id, email, display_name, active) VALUES ('99999999-9999-4999-8999-999999999991', 'Direct@Example.test', 'D', false)`), /admin_users_email_lower/);
  await rejected(() => q(`INSERT INTO public.admin_users (user_id, email, display_name, role, active) VALUES ('99999999-9999-4999-8999-999999999991', 'direct@example.test', 'D', 'superadmin', false)`), /admin_users_role_check/);
  await rejected(() => q(`INSERT INTO public.admin_users (user_id, email, display_name, active) VALUES ('99999999-9999-4999-8999-999999999991', 'aman@example.test', 'Dup', false)`), /unique|duplicate/i);
});

test('adding and removing a founder is itself on the record, as the system\'s action', async () => {
  const added = await rows(`SELECT * FROM public.tenant_events WHERE type = 'admin.user_added' ORDER BY id`);
  assert.ok(added.length >= 2);
  assert.ok(added.every(e => e.actor_type === 'system' && e.restaurant_id === null && e.source === 'system'));
  assert.ok(added.some(e => e.payload.email === 'aman@example.test'));
  const removed = await rows(`SELECT * FROM public.tenant_events WHERE type = 'admin.user_deactivated' ORDER BY id`);
  assert.ok(removed.length >= 1);
  assert.ok(removed.every(e => e.actor_type === 'system'));
  assert.ok(removed.some(e => /left the company/.test(e.payload.reason) && e.payload.email === 'darshil@example.test'), 'with the reason it was given');
});

// --- the spine: what an event is ------------------------------------------------------------------------------------------------------

const record = (over = {}) => q(
  `SELECT public.record_tenant_event($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) AS id`,
  [over.restaurant ?? null, over.source ?? 'system', over.type ?? 'test.event', over.actorType ?? 'system', over.actorId ?? null,
    over.requestId ?? null, JSON.stringify(over.payload ?? {}), over.occurredAt ?? null, over.sourceRef ?? null]
).then(r => r.rows[0].id);

test('(e) an admin event with no actor is refused, by the table itself and by the function', async () => {
  await rejected(() => record({ source: 'admin', actorType: 'admin', actorId: null }), /actor|check/i);
  await rejected(() => q(`INSERT INTO public.tenant_events (source, type, actor_type, payload) VALUES ('admin', 'x.y', 'admin', '{}')`), /actor|check/i);
  const id = await record({ source: 'admin', actorType: 'admin', actorId: F1 });
  assert.ok(id);
});

test('the shape of an event is checked: its source, its kind of actor, its type and its payload', async () => {
  await rejected(() => record({ source: 'rumour' }), /check|source/i);
  await rejected(() => record({ actorType: 'ghost' }), /check|actor/i);
  await rejected(() => record({ type: '' }), /check|type/i);
  await rejected(() => q(`SELECT public.record_tenant_event(NULL, 'system', 'x.y', 'system', NULL, NULL, '[1,2]'::jsonb, NULL)`), /check|payload/i);
});

test('events of one restaurant are numbered from 1, chained to the one before, and kept apart from every other restaurant\'s', async () => {
  const a1 = await record({ restaurant: T.A.restaurant, type: 'chain.a1' });
  const a2 = await record({ restaurant: T.A.restaurant, type: 'chain.a2' });
  const b1 = await record({ restaurant: T.B.restaurant, type: 'chain.b1' });
  const [x, y, z] = await Promise.all([a1, a2, b1].map(async id => (await rows(`SELECT * FROM public.tenant_events WHERE id = $1`, [id]))[0]));
  assert.equal(Number(y.chain_seq), Number(x.chain_seq) + 1);
  assert.equal(y.prev_hash, x.row_hash, 'each event names the hash of the one before it');
  assert.equal(z.chain_seq, 1, 'another restaurant starts its own chain');
  assert.equal(z.prev_hash, '0'.repeat(64));
});

test('the first event of a chain chains to the genesis hash, and the global chain is its own', async () => {
  const [first] = await rows(`SELECT * FROM public.tenant_events WHERE restaurant_id IS NULL ORDER BY chain_seq LIMIT 1`);
  assert.equal(first.chain_seq, 1);
  assert.equal(first.prev_hash, '0'.repeat(64));
  const [other] = await rows(`SELECT * FROM public.tenant_events WHERE restaurant_id = $1 ORDER BY chain_seq LIMIT 1`, [T.A.restaurant]);
  assert.equal(other.prev_hash, '0'.repeat(64));
});

test('the hash is SHA-256 over the documented fields, so anyone can recompute it', async () => {
  const id = await record({ restaurant: T.A.restaurant, source: 'admin', type: 'hash.check', actorType: 'admin', actorId: F1, requestId: 'req-1', sourceRef: 'test:ref-1', payload: { b: 2, a: [1, { z: 1 }] } });
  const [e] = await rows(`SELECT *, payload::text AS payload_text, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_text, chain_key::text AS key_text FROM public.tenant_events WHERE id = $1`, [id]);
  const text = [e.prev_hash, e.key_text, e.chain_seq, e.at_text, e.source, e.type, e.actor_type, e.actor_id ?? '', e.request_id ?? '', e.source_ref ?? '', e.payload_text].join('|');
  assert.equal(e.row_hash, crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(e.source_ref, 'test:ref-1', 'and the reference is one of the hashed fields');
});

test('changing any hashed field of an event changes its hash: the chain notices each one', async () => {
  const e = (await rows(`SELECT public.tenant_events_hash(repeat('0', 64), '${T.A.restaurant}'::uuid, 1, '2026-01-01T00:00:00Z'::timestamptz, 'admin', 'x.y', 'admin', '${F1}'::uuid, 'r', 'ref', '{"n": 1}'::jsonb) AS h`))[0].h;
  const variant = async (_n, args) => (await rows(`SELECT public.tenant_events_hash(${args}) AS h`))[0].h !== e;
  const P = (prev = `repeat('0', 64)`, key = `'${T.A.restaurant}'::uuid`, seq = '1', at = `'2026-01-01T00:00:00Z'::timestamptz`, source = `'admin'`, type = `'x.y'`, at2 = `'admin'`, actor = `'${F1}'::uuid`, req = `'r'`, ref = `'ref'`, payload = `'{"n": 1}'::jsonb`) =>
    [prev, key, seq, at, source, type, at2, actor, req, ref, payload].join(', ');
  assert.ok(await variant(0, P(`repeat('1', 64)`)), 'prev_hash');
  assert.ok(await variant(1, P(undefined, `'${T.B.restaurant}'::uuid`)), 'chain key');
  assert.ok(await variant(2, P(undefined, undefined, '2')), 'seq');
  assert.ok(await variant(3, P(undefined, undefined, undefined, `'2026-01-01T00:00:00.000001Z'::timestamptz`)), 'time, to the microsecond');
  assert.ok(await variant(4, P(undefined, undefined, undefined, undefined, `'system'`)), 'source');
  assert.ok(await variant(5, P(undefined, undefined, undefined, undefined, undefined, `'x.z'`)), 'type');
  assert.ok(await variant(6, P(undefined, undefined, undefined, undefined, undefined, undefined, `'system'`)), 'actor type');
  assert.ok(await variant(7, P(undefined, undefined, undefined, undefined, undefined, undefined, undefined, `'${F2}'::uuid`)), 'actor');
  assert.ok(await variant(8, P(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, `'q'`)), 'request id');
  assert.ok(await variant(9, P(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, `'other'`)), 'source reference');
  assert.ok(await variant(10, P(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, `'{"n": 2}'::jsonb`)), 'payload');
  assert.ok(await variant(11, P(undefined, undefined, undefined, undefined, undefined, undefined, undefined, `NULL::uuid`)), 'no actor is not the same as an actor');
});

test('the hashes are checked for their shape even if the trigger that sets them were out of the way', async () => {
  await tamper(async () => {
    for (const [prev, hash] of [['a'.repeat(64), 'xyz'], ['short', 'b'.repeat(64)], ['A'.repeat(64), 'b'.repeat(64)]]) {
      await rejected(() => q(`INSERT INTO public.tenant_events (restaurant_id, source, type, actor_type, payload, chain_seq, prev_hash, row_hash)
                              VALUES (NULL, 'system', 'bad.hash', 'system', '{}', 9000, $1, $2)`, [prev, hash]), /tenant_events_hash_check/);
    }
  });
});

test('one source reference is one event: recording the same one twice is refused', async () => {
  await record({ type: 'ref.once', sourceRef: 'dup:1' });
  await rejected(() => record({ type: 'ref.twice', sourceRef: 'dup:1' }), /unique|duplicate/i);
  await record({ type: 'ref.other.source', source: 'razorpay', actorType: 'webhook', sourceRef: 'dup:1' });
});

test('a caller cannot choose the chain: whatever number or hash a write supplies is replaced', async () => {
  await q(`INSERT INTO public.tenant_events (restaurant_id, source, type, actor_type, payload, chain_seq, prev_hash, row_hash)
           VALUES ($1, 'system', 'forged.chain', 'system', '{}', 999, $2, $3)`, [T.A.restaurant, 'a'.repeat(64), 'b'.repeat(64)]);
  const [e] = await rows(`SELECT * FROM public.tenant_events WHERE type = 'forged.chain'`);
  assert.notEqual(e.chain_seq, 999);
  assert.notEqual(e.row_hash, 'b'.repeat(64));
  assert.equal((await rows(`SELECT * FROM public.tenant_events_verify($1)`, [T.A.restaurant]))[0].ok, true, 'and the chain is still sound');
});

test('the time of an event is the database\'s clock unless an ingest says when it really happened', async () => {
  const before = Date.now();
  const now = await record({ type: 'clock.now' });
  const [n] = await rows(`SELECT occurred_at FROM public.tenant_events WHERE id = $1`, [now]);
  assert.ok(Math.abs(new Date(n.occurred_at).getTime() - before) < 60000);
  const then = await record({ type: 'clock.then', occurredAt: '2026-01-02T03:04:05.678Z' });
  const [t] = await rows(`SELECT occurred_at FROM public.tenant_events WHERE id = $1`, [then]);
  assert.equal(new Date(t.occurred_at).toISOString(), '2026-01-02T03:04:05.678Z');
});

// --- the spine is append-only (acceptance c) -------------------------------------------------------------------------------------------

test('(c) no role can change or remove an event: not the owner, not the service role, not a tenant, not the dedicated role, not anon', async () => {
  const id = await record({ restaurant: T.A.restaurant, type: 'append.only' });
  await rejected(() => q(`UPDATE public.tenant_events SET type = 'edited' WHERE id = $1`, [id]), /append-only/i);
  await rejected(() => q(`DELETE FROM public.tenant_events WHERE id = $1`, [id]), /append-only/i);
  await rejected(() => q(`TRUNCATE public.tenant_events`), /append-only/i);
  for (const role of ['service_role', 'authenticated', 'anon', 'kullina_admin']) {
    await rejected(() => cloud.as(role, F1, () => q(`UPDATE public.tenant_events SET type = 'edited' WHERE id = $1`, [id])), /permission denied|append-only/i);
    await rejected(() => cloud.as(role, F1, () => q(`DELETE FROM public.tenant_events WHERE id = $1`, [id])), /permission denied|append-only/i);
    await rejected(() => cloud.as(role, F1, () => q(`TRUNCATE public.tenant_events`)), /permission denied|append-only/i);
  }
  assert.equal((await rows(`SELECT type FROM public.tenant_events WHERE id = $1`, [id]))[0].type, 'append.only');
});

test('removing a restaurant removes its events with it, and the global chain is untouched', async () => {
  await q(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ('c0c0c0c0-0000-4000-8000-000000000003', 'Gone', 'gone', 'Nagpur', 'PC-C')`);
  await record({ restaurant: 'c0c0c0c0-0000-4000-8000-000000000003', type: 'gone.event' });
  const globalBefore = (await rows(`SELECT count(*)::int AS n FROM public.tenant_events WHERE restaurant_id IS NULL`))[0].n;
  await q(`DELETE FROM public.restaurants WHERE id = 'c0c0c0c0-0000-4000-8000-000000000003'`);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.tenant_events WHERE restaurant_id = 'c0c0c0c0-0000-4000-8000-000000000003'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.tenant_events WHERE restaurant_id IS NULL`))[0].n, globalBefore);
});

// --- the chain can be checked (acceptance d) -------------------------------------------------------------------------------------------

/** Do something the triggers would forbid, as only the database's administrator could, and put the triggers back. */
async function tamper(fn) {
  await q('ALTER TABLE public.tenant_events DISABLE TRIGGER USER');
  try { await fn(); } finally { await q('ALTER TABLE public.tenant_events ENABLE TRIGGER USER'); }
}
const verify = restaurant => rows(`SELECT * FROM public.tenant_events_verify($1)`, [restaurant]).then(r => r[0]);

test('an untouched chain verifies, and says how many events it checked', async () => {
  for (let i = 0; i < 4; i++) await record({ restaurant: T.B.restaurant, type: `verify.${i}` });
  const v = await verify(T.B.restaurant);
  assert.equal(v.ok, true);
  assert.ok(Number(v.checked) >= 5);
  assert.equal(v.broken_at, null);
});

test('(d) editing an event breaks the chain at that event', async () => {
  const id = await record({ restaurant: T.B.restaurant, type: 'tamper.edit', payload: { n: 1 } });
  const [e] = await rows(`SELECT chain_seq FROM public.tenant_events WHERE id = $1`, [id]);
  await record({ restaurant: T.B.restaurant, type: 'tamper.after' });
  await tamper(() => q(`UPDATE public.tenant_events SET payload = '{"n": 2}' WHERE id = $1`, [id]));
  const v = await verify(T.B.restaurant);
  assert.equal(v.ok, false);
  assert.equal(Number(v.broken_at), Number(e.chain_seq));
  assert.match(v.reason, /hash/i);
  const other = await verify(T.A.restaurant);
  assert.equal(other.ok, true, 'another restaurant\'s chain is not affected');
});

test('(d) removing an event from the middle, or changing who did it, is found too', async () => {
  const mk = async restaurant => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await record({ restaurant, type: `t.${i}`, source: 'admin', actorType: 'admin', actorId: F1 }));
    return ids;
  };
  const [r1] = await q(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ('d0d0d0d0-0000-4000-8000-000000000004', 'Chain1', 'chain1', 'Nagpur', 'PC-D1') RETURNING id`).then(r => r.rows);
  const [r2] = await q(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ('e0e0e0e0-0000-4000-8000-000000000005', 'Chain2', 'chain2', 'Nagpur', 'PC-E2') RETURNING id`).then(r => r.rows);
  const ids1 = await mk(r1.id);
  const ids2 = await mk(r2.id);
  await tamper(() => q(`DELETE FROM public.tenant_events WHERE id = $1`, [ids1[1]]));
  const gap = await verify(r1.id);
  assert.equal(gap.ok, false);
  assert.match(gap.reason, /missing|gap|seq/i);
  await tamper(() => q(`UPDATE public.tenant_events SET actor_id = $2 WHERE id = $1`, [ids2[2], F2]));
  const swapped = await verify(r2.id);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /hash/i);
});

test('(d) a rewritten hash that is internally consistent still breaks the link to the next event', async () => {
  const restaurant = 'f0f0f0f0-0000-4000-8000-000000000006';
  await q(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ($1, 'Chain3', 'chain3', 'Nagpur', 'PC-F3')`, [restaurant]);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await record({ restaurant, type: `r.${i}` }));
  await tamper(async () => {
    await q(`UPDATE public.tenant_events SET prev_hash = $2 WHERE id = $1`, [ids[1], 'c'.repeat(64)]);
  });
  const v = await verify(restaurant);
  assert.equal(v.ok, false);
  assert.match(v.reason, /prev|link|chain/i);
});

test('two events cannot share a place in a chain, even by someone who bypasses the triggers', async () => {
  const [last] = await rows(`SELECT chain_seq FROM public.tenant_events WHERE restaurant_id = $1 ORDER BY chain_seq DESC LIMIT 1`, [T.A.restaurant]);
  await tamper(async () => {
    await rejected(() => q(`INSERT INTO public.tenant_events (restaurant_id, source, type, actor_type, payload, chain_seq, prev_hash, row_hash)
                            VALUES ($1, 'system', 'dup.seq', 'system', '{}', $2, $3, $3)`, [T.A.restaurant, last.chain_seq, 'd'.repeat(64)]), /unique|duplicate/i);
  });
});

// --- reading the spine through the admin functions ---------------------------------------------------------------------------------------

test('the audit log is read newest first, with the restaurant\'s name and the actor\'s email, and filters narrow it', async () => {
  await record({ restaurant: T.A.restaurant, source: 'admin', type: 'audit.one', actorType: 'admin', actorId: F1, payload: { n: 1 } });
  await record({ restaurant: T.B.restaurant, source: 'razorpay', type: 'audit.two', actorType: 'webhook' });
  const all = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 500)`)).rows;
  assert.ok(all.length > 5);
  assert.ok(all.every((e, i) => i === 0 || Number(all[i - 1].id) > Number(e.id)), 'newest first');
  const one = all.find(e => e.type === 'audit.one');
  assert.deepEqual([one.restaurant_name, one.actor_email], ['Restaurant A', 'aman@example.test']);

  const byTenant = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events($1)`, [T.B.restaurant])).rows;
  assert.ok(byTenant.length && byTenant.every(e => e.restaurant_id === T.B.restaurant));
  const byType = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, 'audit.two')`)).rows;
  assert.deepEqual(byType.map(e => e.type), ['audit.two']);
  const bySource = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, 'razorpay')`)).rows;
  assert.ok(bySource.length && bySource.every(e => e.source === 'razorpay'));
  const byActor = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, $1)`, [F1])).rows;
  assert.ok(byActor.length && byActor.every(e => e.actor_id === F1));
  const future = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, now() + interval '1 day')`)).rows;
  assert.equal(future.length, 0);
  const past = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, '2000-01-01')`)).rows;
  assert.equal(past.length, 0);
});

test('the audit log pages: a limit, and "before this id" for the next page; the limit is capped', async () => {
  const page1 = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3)`)).rows;
  assert.equal(page1.length, 3);
  const page2 = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, NULL, $1, 3)`, [page1[2].id])).rows;
  assert.equal(page2.length, 3);
  assert.ok(Number(page2[0].id) < Number(page1[2].id));
  for (let i = 0; i < 12; i++) await record({ type: 'bulk.fill' });
  const capped = (await asAdmin(aal2(F1), `SELECT count(*)::int AS n FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 100000)`)).rows[0].n;
  assert.ok(capped <= 500);
  await rejected(() => asAdmin(aal2(F1), `SELECT * FROM public.admin_list_events(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)`), /limit/i);
});

test('the audit log never returns more than 500 events, however many are asked for', async () => {
  await q(`SELECT public.record_tenant_event(NULL, 'system', 'bulk.many', 'system', NULL, NULL, '{}'::jsonb) FROM generate_series(1, 520)`);
  const n = (await asAdmin(aal2(F1), `SELECT count(*)::int AS n FROM public.admin_list_events(NULL, 'bulk.many', NULL, NULL, NULL, NULL, NULL, 100000)`)).rows[0].n;
  assert.equal(n, 500);
  const dflt = (await asAdmin(aal2(F1), `SELECT count(*)::int AS n FROM public.admin_list_events(NULL, 'bulk.many')`)).rows[0].n;
  assert.equal(dflt, 100, 'and 100 by default');
});

test('the chain can be checked through the admin function, for one restaurant or for the global chain', async () => {
  const one = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_verify_chain($1)`, [T.A.restaurant])).rows[0];
  assert.equal(one.ok, true);
  const global = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_verify_chain()`)).rows[0];
  assert.equal(global.ok, true);
  assert.ok(Number(global.checked) >= 4);
});

test('signing in is on the record, attributed to the person, and only a founder with MFA can make it', async () => {
  const id = (await asAdmin(aal2(F1), `SELECT public.admin_record_signin('req-77') AS id`)).rows[0].id;
  const [e] = await rows(`SELECT * FROM public.tenant_events WHERE id = $1`, [id]);
  assert.deepEqual([e.type, e.source, e.actor_type, e.actor_id, e.restaurant_id, e.request_id], ['admin.signin', 'admin', 'admin', F1, null, 'req-77']);
});

test('the fleet, a restaurant\'s events and its subscriptions are readable by a founder, across every restaurant, and show nothing a tenant could act with', async () => {
  const fleet = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_fleet()`)).rows;
  const seen = fleet.map(r => r.restaurant_id);
  assert.ok(seen.includes(T.A.restaurant) && seen.includes(T.B.restaurant), 'a founder sees every restaurant, not just one');
  const forbidden = ['pairing_code', 'hub_provisioning_secret_hash', 'settings', 'payment_link', 'short_url'];
  for (const column of Object.keys(fleet[0])) assert.ok(!forbidden.includes(column), `the fleet shows ${column}`);
  assert.ok('hub_seen_at' in fleet[0] && 'plan_status' in fleet[0]);
  assert.ok(Array.isArray((await asAdmin(aal2(F1), `SELECT * FROM public.admin_ops_events($1, 5)`, [T.A.restaurant])).rows));
  assert.ok(Array.isArray((await asAdmin(aal2(F1), `SELECT * FROM public.admin_tenant_subscriptions($1)`, [T.A.restaurant])).rows));
});

// --- ingest (P1-4) ----------------------------------------------------------------------------------------------------------------------

const subEvent = (over = {}) => q(
  `INSERT INTO public.subscription_events (restaurant_id, razorpay_subscription_id, event, applied_plan_status, payload, received_at, razorpay_event_id)
   VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
  ['restaurant' in over ? over.restaurant : T.A.restaurant, over.sub ?? 'sub_1', over.event ?? 'subscription.charged', over.applied ?? 'active',
    JSON.stringify(over.payload ?? {}), over.at ?? '2026-10-20T10:00:00Z', over.eventId ?? `evt_${Math.random()}`]
).then(r => r.rows[0].id);
const spineOf = id => rows(`SELECT * FROM public.tenant_events WHERE source_ref = $1`, [`subscription_events:${id}`]);

test('a subscription event lands on the spine as it happens, with what the console needs and nothing Razorpay sent', async () => {
  const id = await subEvent({ event: 'subscription.halted', applied: 'past_due', at: '2026-10-21T09:30:00Z', payload: { customer: { email: 'guest@example.test', contact: '9876543210' }, card: '4111' } });
  const [e] = await spineOf(id);
  assert.deepEqual([e.source, e.type, e.actor_type, e.restaurant_id], ['razorpay', 'subscription.halted', 'webhook', T.A.restaurant]);
  assert.deepEqual([e.payload.applied_plan_status, e.payload.razorpay_subscription_id], ['past_due', 'sub_1']);
  assert.equal(new Date(e.occurred_at).toISOString(), '2026-10-21T09:30:00.000Z', 'the time it was received, not the time it was copied');
  const text = JSON.stringify(e.payload);
  assert.doesNotMatch(text, /guest@example|9876543210|4111|customer|card/i);
});

test('an event for a subscription nobody knows is on the global chain, not lost', async () => {
  const id = await subEvent({ restaurant: null, event: 'subscription.activated', applied: null });
  const [e] = await spineOf(id);
  assert.equal(e.restaurant_id, null);
});

test('the backfill carries up events from before the spine, once: running it again adds nothing, and it never copies what the trigger already did', async () => {
  await q('ALTER TABLE public.subscription_events DISABLE TRIGGER USER');
  let old;
  try { old = [await subEvent({ event: 'subscription.charged' }), await subEvent({ event: 'subscription.charged' })]; } finally { await q('ALTER TABLE public.subscription_events ENABLE TRIGGER USER'); }
  const live = await subEvent({ event: 'subscription.charged' });
  assert.equal((await spineOf(old[0])).length, 0);
  const first = await cloud.as('service_role', null, () => q(`SELECT public.spine_backfill_subscription_events() AS n`));
  assert.ok(Number(first.rows[0].n) >= 2);
  for (const id of [...old, live]) assert.equal((await spineOf(id)).length, 1);
  const again = await cloud.as('service_role', null, () => q(`SELECT public.spine_backfill_subscription_events() AS n`));
  assert.equal(Number(again.rows[0].n), 0);
});

test('copying one subscription event twice is a no-op the second time', async () => {
  const id = await subEvent({ event: 'subscription.updated' });
  assert.equal((await spineOf(id)).length, 1);
  const again = await q(`SELECT public.spine_copy_subscription_event($1) AS id`, [id]);
  assert.equal(again.rows[0].id, null);
  assert.equal((await spineOf(id)).length, 1);
  assert.equal((await q(`SELECT public.spine_copy_subscription_event('99999999-9999-4999-8999-999999999992') AS id`)).rows[0].id, null, 'and an id that is not an event is nothing');
});

test('only the operator service can run the backfill', async () => {
  for (const role of ['authenticated', 'anon', 'kullina_admin']) {
    await rejected(() => cloud.as(role, F1, () => q(`SELECT public.spine_backfill_subscription_events()`)), /permission denied/i);
  }
});

test('a failure to write the spine never stops a webhook from being logged', async () => {
  await q(`ALTER TABLE public.tenant_events ADD CONSTRAINT zz_block_all CHECK (false) NOT VALID`);
  let id;
  try { id = await subEvent({ event: 'subscription.cancelled', applied: 'cancelled' }); } finally { await q('ALTER TABLE public.tenant_events DROP CONSTRAINT zz_block_all'); }
  assert.ok(id, 'the event was logged');
  assert.equal((await spineOf(id)).length, 0, 'and the spine simply does not have it yet');
  const n = await cloud.as('service_role', null, () => q(`SELECT public.spine_backfill_subscription_events() AS n`));
  assert.equal(Number(n.rows[0].n), 1, 'and the backfill brings it in later');
});

test('a founder reads the subscription events and subscriptions of one restaurant, and only that one', async () => {
  for (const [rid, sub] of [[T.A.restaurant, 'sub_a'], [T.B.restaurant, 'sub_b']]) {
    await q(`INSERT INTO public.subscriptions (restaurant_id, razorpay_subscription_id, status, plan) VALUES ($1, $2, 'active', 'pro')`, [rid, sub]);
    await subEvent({ restaurant: rid, sub, event: 'subscription.charged' });
  }
  const events = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_ops_events($1, 50)`, [T.A.restaurant])).rows;
  assert.ok(events.length >= 1 && events.every(e => e.restaurant_id === T.A.restaurant));
  const everyone = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_ops_events(NULL, 200)`)).rows;
  assert.ok(new Set(everyone.map(e => e.restaurant_id)).size >= 2, 'with no restaurant named, those of every restaurant');
  const subs = (await asAdmin(aal2(F1), `SELECT * FROM public.admin_tenant_subscriptions($1)`, [T.A.restaurant])).rows;
  assert.deepEqual(subs.map(s => [s.razorpay_subscription_id, s.status, s.plan]), [['sub_a', 'active', 'pro']]);
});

// --- the hub's report (P1-4) --------------------------------------------------------------------------------------------------------------

const beat = (over = {}) => ({
  restaurant_id: T.A.restaurant, reported_at: '2026-10-26T09:00:00Z', started_at: '2026-10-26T06:00:00Z', version: '1.4.0',
  queued: 0, quarantined: 0, last_synced_at: '2026-10-26T08:58:00Z', devices: 2, waiters: 4, ...over
});
const hubEvents = type => rows(`SELECT * FROM public.tenant_events WHERE restaurant_id = $1 AND type = $2 ORDER BY id`, [T.A.restaurant, type]);

test('a hub\'s first report is on the spine, and a report that changes nothing important adds nothing', async () => {
  const hub = pgrestClient(cloud, T.A.user);
  assert.equal((await hub.from('hub_status').upsert(beat(), { onConflict: 'restaurant_id' })).error, null);
  assert.equal((await hubEvents('hub.first_report')).length, 1);
  const [e] = await hubEvents('hub.first_report');
  assert.deepEqual([e.source, e.actor_type, e.actor_id], ['hub', 'hub', null]);
  assert.equal(e.payload.version, '1.4.0');
  const before = (await rows(`SELECT count(*)::int AS n FROM public.tenant_events WHERE restaurant_id = $1`, [T.A.restaurant]))[0].n;
  for (const over of [{}, { reported_at: '2026-10-26T09:05:00Z', queued: 7 }, { devices: 3 }, { last_synced_at: '2026-10-26T09:04:00Z' }]) {
    assert.equal((await hub.from('hub_status').upsert(beat(over), { onConflict: 'restaurant_id' })).error, null);
  }
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.tenant_events WHERE restaurant_id = $1`, [T.A.restaurant]))[0].n, before, 'a queue that grows is not an event');
});

test('a new version, a restart and orders shelved (or freed) each leave one event, with counts and times only', async () => {
  const hub = pgrestClient(cloud, T.A.user);
  await hub.from('hub_status').upsert(beat({ version: '1.5.0' }), { onConflict: 'restaurant_id' });
  await hub.from('hub_status').upsert(beat({ version: '1.5.0', started_at: '2026-10-26T09:10:00Z' }), { onConflict: 'restaurant_id' });
  await hub.from('hub_status').upsert(beat({ version: '1.5.0', started_at: '2026-10-26T09:10:00Z', quarantined: 3 }), { onConflict: 'restaurant_id' });
  await hub.from('hub_status').upsert(beat({ version: '1.5.0', started_at: '2026-10-26T09:10:00Z', quarantined: 0 }), { onConflict: 'restaurant_id' });
  const v = await hubEvents('hub.version_changed');
  assert.deepEqual([v.length, v[0].payload.from, v[0].payload.to], [1, '1.4.0', '1.5.0']);
  const r = await hubEvents('hub.restarted');
  assert.equal(r.length, 1);
  assert.equal(r[0].payload.started_at, '2026-10-26T09:10:00.000Z');
  const s = await hubEvents('hub.shelved_changed');
  assert.deepEqual(s.map(e => [e.payload.from, e.payload.to]), [[0, 3], [3, 0]]);
  for (const e of [...v, ...r, ...s]) assert.doesNotMatch(JSON.stringify(e.payload), /pairing|secret|token|pin|name|phone/i);
});

test('a report with no start time is not a restart', async () => {
  const hub = pgrestClient(cloud, T.A.user);
  const before = (await hubEvents('hub.restarted')).length;
  assert.equal((await hub.from('hub_status').upsert(beat({ version: '1.5.0', started_at: null, quarantined: 0 }), { onConflict: 'restaurant_id' })).error, null);
  assert.equal((await hubEvents('hub.restarted')).length, before);
});

test('the hub still reports when the spine cannot be written to', async () => {
  const hub = pgrestClient(cloud, T.B.user);
  await q(`ALTER TABLE public.tenant_events ADD CONSTRAINT zz_block_all CHECK (false) NOT VALID`);
  try {
    const r = await hub.from('hub_status').upsert(beat({ restaurant_id: T.B.restaurant }), { onConflict: 'restaurant_id' });
    assert.equal(r.error, null, JSON.stringify(r.error));
  } finally { await q('ALTER TABLE public.tenant_events DROP CONSTRAINT zz_block_all'); }
  assert.equal((await rows(`SELECT count(*)::int AS n FROM public.hub_status WHERE restaurant_id = $1`, [T.B.restaurant]))[0].n, 1);
});

test('a hub cannot read the spine, and a tenant\'s login cannot read the allowlist', async () => {
  const hub = pgrestClient(cloud, T.A.user);
  assert.equal((await hub.from('tenant_events').select('*')).error?.code, '42501');
  assert.equal((await hub.from('admin_users').select('*')).error?.code, '42501');
});

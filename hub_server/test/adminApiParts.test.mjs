import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, serviceKeysIn } from '../../admin_api/lib/config.js';
import { ipAllowed, createLimiter, requestIdFrom, corsHeaders, SECURITY_HEADERS } from '../../admin_api/lib/security.js';
import { toCsv } from '../../admin_api/lib/csv.js';
import { makeAdminDb, assertDedicatedRole, poolTransaction } from '../../admin_api/lib/db.js';

// The small rules the admin API is built from, none of which touch a network or a database: what it will start with, who may reach it, what it
// sends back, and how it speaks to the database.

const SECRET = 's'.repeat(40);
const goodEnv = (over = {}) => ({
  ADMIN_DATABASE_URL: 'postgresql://kullina_admin.abcdefgh:pw@aws-0.pooler.supabase.com:6543/postgres',
  ADMIN_JWT_SECRET: SECRET,
  ADMIN_WEB_ORIGIN: 'https://admin.kullina.example',
  ...over
});
const jwtWithRole = role => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;

// --- what the API will start with -----------------------------------------------------------------------------------------------

test('a complete, safe environment gives a configuration and no problems', () => {
  const r = loadConfig(goodEnv({ ADMIN_IP_ALLOWLIST: '203.0.113.7, 198.51.100.0/24', PORT: '4700', ADMIN_JWT_ISSUER: 'https://abc.supabase.co/auth/v1' }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.config.port, 4700);
  assert.deepEqual(r.config.webOrigins, ['https://admin.kullina.example']);
  assert.deepEqual(r.config.ipAllowlist, ['203.0.113.7', '198.51.100.0/24']);
  assert.equal(r.config.audience, 'authenticated');
  assert.equal(r.config.issuer, 'https://abc.supabase.co/auth/v1');
});

test('the defaults: a port, no allowlist, no proxy trusted', () => {
  const { config } = loadConfig(goodEnv());
  assert.deepEqual([config.port, config.ipAllowlist, config.trustProxy], [4600, [], 0]);
});

test('without a database address it will not start', () => {
  const r = loadConfig(goodEnv({ ADMIN_DATABASE_URL: '' }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /ADMIN_DATABASE_URL is not set/);
});

test('the database login must be the dedicated role, not the owner and not the service role', () => {
  for (const url of [
    'postgresql://postgres:pw@db.abc.supabase.co:5432/postgres',
    'postgresql://postgres.abcdefgh:pw@aws-0.pooler.supabase.com:6543/postgres',
    'postgresql://service_role:pw@db.abc.supabase.co:5432/postgres',
    'postgresql://:pw@db.abc.supabase.co:5432/postgres',
    'postgresql://notkullina_admin:pw@db.abc.supabase.co:5432/postgres'
  ]) {
    const r = loadConfig(goodEnv({ ADMIN_DATABASE_URL: url }));
    assert.equal(r.ok, false, url);
    assert.match(r.problems.join(' '), /kullina_admin/);
  }
  assert.equal(loadConfig(goodEnv({ ADMIN_DATABASE_URL: 'postgres://kullina_admin:pw@localhost:5432/postgres' })).ok, true);
});

test('an address that is not a database address is refused, and its password is never repeated in the message', () => {
  const r = loadConfig(goodEnv({ ADMIN_DATABASE_URL: 'https://kullina_admin:hunter2@example.com/x' }));
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  const garbage = loadConfig(goodEnv({ ADMIN_DATABASE_URL: 'not a url hunter2' }));
  assert.equal(garbage.ok, false);
  assert.doesNotMatch(JSON.stringify(garbage), /hunter2/);
});

test('it needs a way to check tokens: a long enough secret or a key set address', () => {
  assert.equal(loadConfig(goodEnv({ ADMIN_JWT_SECRET: '' })).ok, false);
  assert.equal(loadConfig(goodEnv({ ADMIN_JWT_SECRET: 'short' })).ok, false);
  const jwks = loadConfig(goodEnv({ ADMIN_JWT_SECRET: '', ADMIN_JWKS_URL: 'https://abc.supabase.co/auth/v1/.well-known/jwks.json' }));
  assert.equal(jwks.ok, true);
  assert.equal(jwks.config.jwksUrl, 'https://abc.supabase.co/auth/v1/.well-known/jwks.json');
  assert.equal(loadConfig(goodEnv({ ADMIN_JWT_SECRET: '', ADMIN_JWKS_URL: 'http://abc.supabase.co/keys' })).ok, false, 'keys fetched over plain http could be swapped');
});

test('a secret that is too short is a problem even when a key set is also given, and so is a key set on plain http even when a secret is', () => {
  const jwks = 'https://abc.supabase.co/auth/v1/.well-known/jwks.json';
  const short = loadConfig(goodEnv({ ADMIN_JWT_SECRET: 'short', ADMIN_JWKS_URL: jwks }));
  assert.equal(short.ok, false);
  assert.match(short.problems.join(' '), /too short/);
  const plain = loadConfig(goodEnv({ ADMIN_JWKS_URL: 'http://abc.supabase.co/keys' }));
  assert.equal(plain.ok, false);
  assert.match(plain.problems.join(' '), /https/);
  assert.equal(loadConfig(goodEnv({ ADMIN_JWKS_URL: jwks })).ok, true, 'both together are fine');
});

test('the secret is never repeated back in a problem', () => {
  assert.doesNotMatch(JSON.stringify(loadConfig(goodEnv({ ADMIN_JWT_SECRET: 'tooshort-abc' }))), /tooshort-abc/);
});

test('it needs to know which web origin may call it, and that origin has no path and is https (or localhost)', () => {
  assert.equal(loadConfig(goodEnv({ ADMIN_WEB_ORIGIN: '' })).ok, false);
  for (const bad of ['*', 'admin.kullina.example', 'https://admin.kullina.example/app', 'http://admin.kullina.example', 'javascript:alert(1)', 'https://a.example, *']) {
    assert.equal(loadConfig(goodEnv({ ADMIN_WEB_ORIGIN: bad })).ok, false, bad);
  }
  assert.equal(loadConfig(goodEnv({ ADMIN_WEB_ORIGIN: 'http://localhost:5173' })).ok, true);
  const two = loadConfig(goodEnv({ ADMIN_WEB_ORIGIN: 'https://a.example, https://b.example' }));
  assert.deepEqual(two.config.webOrigins, ['https://a.example', 'https://b.example']);
});

test('an address allowlist is checked when it is set: every entry must be an address or a range', () => {
  assert.equal(loadConfig(goodEnv({ ADMIN_IP_ALLOWLIST: '203.0.113.7,2001:db8::1,10.0.0.0/8' })).ok, true);
  for (const bad of ['everyone', '999.1.1.1', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/x', '1.2.3', '2001:db8::/32', '10.0.0.0/8/8']) {
    assert.equal(loadConfig(goodEnv({ ADMIN_IP_ALLOWLIST: bad })).ok, false, bad);
  }
});

test('the port and the proxy setting are numbers or the start is refused', () => {
  for (const bad of ['0', '70000', 'abc', '-1']) assert.equal(loadConfig(goodEnv({ PORT: bad })).ok, false, `PORT ${bad}`);
  assert.equal(loadConfig(goodEnv({ ADMIN_TRUST_PROXY: '1' })).config.trustProxy, 1);
  for (const bad of ['yes', '-1', '9']) assert.equal(loadConfig(goodEnv({ ADMIN_TRUST_PROXY: bad })).ok, false, `proxy ${bad}`);
});

test('(I2) it will not start with a service key anywhere in its environment: by name, or by what the value is', () => {
  for (const env of [
    { SUPABASE_SERVICE_ROLE_KEY: 'whatever' },
    { SUPABASE_SERVICE_KEY: 'whatever' },
    { SERVICE_ROLE_KEY: 'whatever' },
    { SIGNUP_SERVICE_KEY: 'x' },
    { SOMETHING_INNOCENT: jwtWithRole('service_role') }
  ]) {
    const r = loadConfig(goodEnv(env));
    assert.equal(r.ok, false, JSON.stringify(Object.keys(env)));
    assert.match(r.problems.join(' '), /service/i);
  }
  assert.equal(loadConfig(goodEnv({ SOMETHING_ELSE: jwtWithRole('authenticated') })).ok, true, 'a token of an ordinary role is not a service key');
  assert.equal(loadConfig(goodEnv({ SUPABASE_SERVICE_ROLE_KEY: '' })).ok, true, 'and an empty one is not set');
});

test('the offending variable is named but its value never is', () => {
  const r = loadConfig(goodEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sekrit-value-123' }));
  assert.match(r.problems.join(' '), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(JSON.stringify(r), /sekrit-value-123/);
  assert.deepEqual(serviceKeysIn({ A: jwtWithRole('service_role'), B: 'plain', C: jwtWithRole('anon') }), ['A']);
});

// --- who may reach it ---------------------------------------------------------------------------------------------------------------

test('with no allowlist anyone may reach it (it is still behind a token); with one, only those addresses', () => {
  assert.equal(ipAllowed('198.51.100.9', []), true);
  assert.equal(ipAllowed('203.0.113.7', ['203.0.113.7']), true);
  assert.equal(ipAllowed('203.0.113.8', ['203.0.113.7']), false);
  assert.equal(ipAllowed(undefined, ['203.0.113.7']), false);
  assert.equal(ipAllowed('', ['203.0.113.7']), false);
});

test('a range allows every address in it and none outside', () => {
  const list = ['198.51.100.0/24'];
  assert.equal(ipAllowed('198.51.100.0', list), true);
  assert.equal(ipAllowed('198.51.100.255', list), true);
  assert.equal(ipAllowed('198.51.101.0', list), false);
  assert.equal(ipAllowed('198.51.99.255', list), false);
  assert.equal(ipAllowed('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.0.0.0', ['10.0.0.0/8']), false);
  assert.equal(ipAllowed('1.2.3.4', ['0.0.0.0/0']), true);
  assert.equal(ipAllowed('203.0.113.7', ['203.0.113.7/32']), true);
  assert.equal(ipAllowed('203.0.113.6', ['203.0.113.7/32']), false);
});

test('an IPv4 address written the IPv6 way is the same address; an IPv6 address matches exactly', () => {
  assert.equal(ipAllowed('::ffff:203.0.113.7', ['203.0.113.7']), true);
  assert.equal(ipAllowed('::ffff:198.51.100.9', ['198.51.100.0/24']), true);
  assert.equal(ipAllowed('2001:db8::1', ['2001:db8::1']), true);
  assert.equal(ipAllowed('2001:db8::2', ['2001:db8::1']), false);
  assert.equal(ipAllowed('2001:DB8::1', ['2001:db8::1']), true, 'case does not matter');
  assert.equal(ipAllowed('::ffff:203.0.113.8', ['203.0.113.7']), false);
});

// --- guessing ---------------------------------------------------------------------------------------------------------------------------

test('an IPv6 address is the same address however it is written', () => {
  assert.equal(ipAllowed('2001:0db8:0000:0000:0000:0000:0000:0001', ['2001:db8::1']), true);
  assert.equal(ipAllowed('2001:db8::1', ['2001:0db8:0:0:0:0:0:1']), true);
  assert.equal(ipAllowed('2001:db8::1', ['2001:db8::2']), false);
  assert.equal(ipAllowed('not an address', ['2001:db8::1']), false);
  assert.equal(ipAllowed('2001:db8::1', ['not an address']), false);
});

test('wrong tries from one address are counted in a window, and forgotten after it', () => {
  let clock = 1000;
  const limiter = createLimiter({ max: 3, windowMs: 60000, now: () => clock });
  assert.equal(limiter.blocked('a'), false);
  limiter.hit('a'); limiter.hit('a');
  assert.equal(limiter.blocked('a'), false);
  limiter.hit('a');
  assert.equal(limiter.blocked('a'), true, 'the third wrong try turns the address away');
  assert.equal(limiter.blocked('b'), false, 'and only that address');
  clock += 59999;
  assert.equal(limiter.blocked('a'), true);
  clock += 2;
  assert.equal(limiter.blocked('a'), false, 'a window later it is let back');
});

test('the limiter does not grow without bound', () => {
  let clock = 0;
  const limiter = createLimiter({ max: 3, windowMs: 1000, now: () => clock, maxKeys: 50 });
  for (let i = 0; i < 500; i++) { limiter.hit(`ip-${i}`); clock += 1; }
  assert.ok(limiter.size() <= 50 + 1);
});

// --- what it says back --------------------------------------------------------------------------------------------------------------------

test('a request id is kept if it is short and plain, and otherwise replaced', () => {
  assert.equal(requestIdFrom('req-123_abc.4'), 'req-123_abc.4');
  for (const bad of [undefined, '', 'x'.repeat(65), 'has space', 'semi;colon', 'new\nline', '<script>', ['a', 'b']]) {
    const id = requestIdFrom(bad);
    assert.match(id, /^[A-Za-z0-9._-]{1,64}$/);
    assert.notEqual(id, bad);
  }
  assert.notEqual(requestIdFrom(undefined), requestIdFrom(undefined), 'a made-up one is different each time');
});

test('every response carries the security headers: nothing cached, nothing sniffed, no framing, no referrer, no scripts', () => {
  const h = SECURITY_HEADERS;
  assert.equal(h['Cache-Control'], 'no-store');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(h['Content-Security-Policy'], /unsafe-inline|unsafe-eval|\*/);
  assert.match(h['Permissions-Policy'], /camera=\(\)/);
  assert.match(h['Strict-Transport-Security'], /max-age=\d{7,}/);
  assert.equal(h['Cross-Origin-Resource-Policy'], 'same-site');
});

test('only a configured web origin is allowed to read an answer, and the answer is told to vary on it', () => {
  const origins = ['https://admin.kullina.example'];
  const ok = corsHeaders('https://admin.kullina.example', origins);
  assert.equal(ok['Access-Control-Allow-Origin'], 'https://admin.kullina.example');
  assert.equal(ok.Vary, 'Origin');
  assert.match(ok['Access-Control-Allow-Headers'], /authorization/i);
  assert.match(ok['Access-Control-Allow-Methods'], /GET/);
  assert.doesNotMatch(ok['Access-Control-Allow-Methods'], /DELETE|PUT|PATCH/);
  assert.equal(ok['Access-Control-Allow-Credentials'], undefined, 'no cookies: the token is in a header');
  for (const bad of ['https://evil.example', 'https://admin.kullina.example.evil.example', 'null', '', undefined, 'http://admin.kullina.example']) {
    const h = corsHeaders(bad, origins);
    assert.equal(h['Access-Control-Allow-Origin'], undefined, String(bad));
    assert.equal(h.Vary, 'Origin');
  }
});

// --- the audit log as a file --------------------------------------------------------------------------------------------------------------

const COLS = [['id', 'id'], ['type', 'type'], ['payload', 'payload']];

test('a CSV has a header row, one line per row, and quotes what needs quoting', () => {
  const csv = toCsv(COLS, [{ id: 1, type: 'a,b', payload: { n: 1 } }, { id: 2, type: 'say "hi"', payload: null }, { id: 3, type: 'two\nlines', payload: {} }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'id,type,payload');
  assert.equal(lines[1], '1,"a,b","{""n"":1}"');
  assert.equal(lines[2], '2,"say ""hi""",');
  assert.ok(csv.includes('"two\nlines"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('a cell that a spreadsheet would run as a formula is made safe', () => {
  for (const dangerous of ['=1+1', '+SUM(A1)', '-2+3', '@HYPERLINK("x")', '\tcmd', '\rcmd', '=cmd|\' /C calc\'!A0']) {
    const csv = toCsv([['v', 'v']], [{ v: dangerous }]);
    const cell = csv.split('\r\n')[1];
    assert.ok(cell.startsWith("'") || cell.startsWith('"\''), `${JSON.stringify(dangerous)} became ${cell}`);
  }
  assert.equal(toCsv([['v', 'v']], [{ v: 'plain' }]).split('\r\n')[1], 'plain');
  assert.equal(toCsv([['v', 'v']], [{ v: 5 }]).split('\r\n')[1], '5', 'a number is not touched');
  assert.equal(toCsv([['v', 'v']], [{ v: -5 }]).split('\r\n')[1], '-5', 'not even a negative one');
});

test('empty values are empty cells, booleans and dates are written plainly, and no rows is just the header', () => {
  assert.equal(toCsv([['a', 'a'], ['b', 'b'], ['c', 'c']], [{ a: null, b: undefined, c: true }]).split('\r\n')[1], ',,true');
  assert.equal(toCsv([['t', 't']], [{ t: '2026-10-26T10:00:00.000Z' }]).split('\r\n')[1], '2026-10-26T10:00:00.000Z');
  assert.equal(toCsv(COLS, []), 'id,type,payload\r\n');
});

test('the header names come from the columns, not from the data', () => {
  assert.equal(toCsv([['restaurant_name', 'Restaurant'], ['occurred_at', 'When']], [{ restaurant_name: 'A', occurred_at: 'x', secret: 'no' }]),
    'Restaurant,When\r\nA,x\r\n');
});

// --- how it speaks to the database -----------------------------------------------------------------------------------------------------------

function fakeTransaction(log, { fail = null, results = {} } = {}) {
  return async fn => {
    log.push('BEGIN');
    const tx = { query: async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); if (fail && new RegExp(fail).test(sql)) throw new Error('boom'); return { rows: results[sql] ?? [] }; } };
    try { const out = await fn(tx); log.push('COMMIT'); return out; } catch (e) { log.push('ROLLBACK'); throw e; }
  };
}

test('a call to the database is one transaction: the dedicated role first, then the caller\'s claims, then the work', async () => {
  const log = [];
  const db = makeAdminDb({ transaction: fakeTransaction(log) });
  const out = await db.asAdmin({ sub: 'f1', aal: 'aal2' }, async query => { await query('SELECT 1'); return 'done'; });
  assert.equal(out, 'done');
  assert.equal(log[0], 'BEGIN');
  assert.match(log[1].sql, /^SET LOCAL ROLE kullina_admin$/);
  assert.match(log[2].sql, /set_config\('request\.jwt\.claims', \$1, true\)/);
  assert.match(log[2].sql, /set_config\('request\.jwt\.claim\.sub', \$2, true\)/);
  assert.equal(log[3].sql, 'SELECT 1');
  assert.equal(log[4], 'COMMIT');
});

test('only the claims the database checks are passed on, and only for the length of the transaction', async () => {
  const log = [];
  const db = makeAdminDb({ transaction: fakeTransaction(log) });
  await db.asAdmin({ sub: 'f1', aal: 'aal2', email: 'a@b.test', app_metadata: { x: 1 }, role: 'service_role', exp: 1 }, async () => {});
  const [claimsJson, sub] = log[2].params;
  assert.deepEqual(JSON.parse(claimsJson), { sub: 'f1', aal: 'aal2', role: 'authenticated' }, 'the role is always the ordinary one, whatever the token said');
  assert.equal(sub, 'f1');
  assert.match(log[2].sql, /true\)/, 'transaction-local, so it cannot leak to the next request on the same connection');
  assert.doesNotMatch(log[2].sql, /, false\)/);
});

test('a failure rolls the transaction back and reaches the caller', async () => {
  const log = [];
  const db = makeAdminDb({ transaction: fakeTransaction(log) });
  await assert.rejects(() => db.asAdmin({ sub: 'f1', aal: 'aal2' }, async () => { throw new Error('nope'); }), /nope/);
  assert.equal(log.at(-1), 'ROLLBACK');
  const log2 = [];
  const db2 = makeAdminDb({ transaction: fakeTransaction(log2, { fail: 'kullina_admin' }) });
  await assert.rejects(() => db2.asAdmin({ sub: 'f1', aal: 'aal2' }, async () => 'never'), /boom/);
  assert.equal(log2.at(-1), 'ROLLBACK');
  assert.ok(!log2.some(e => typeof e === 'object' && e.sql === 'SELECT 1'), 'and the work was never reached');
});

test('a caller with no subject cannot even begin a transaction', async () => {
  const log = [];
  const db = makeAdminDb({ transaction: fakeTransaction(log) });
  for (const claims of [null, undefined, {}, { aal: 'aal2' }, { sub: '' }, { sub: 42 }]) {
    await assert.rejects(() => db.asAdmin(claims, async () => 'x'), /subject|claims/i);
  }
  assert.deepEqual(log, [], 'nothing was sent to the database');
});

function fakePool({ failOn = null, failRollback = false } = {}) {
  const log = [];
  const client = {
    query: async sql => {
      log.push(sql);
      if (sql === 'ROLLBACK' && failRollback) throw new Error('connection lost');
      if (failOn && sql === failOn) throw new Error(`boom on ${sql}`);
      return { rows: [] };
    },
    release: () => log.push('release')
  };
  return { log, pool: { connect: async () => { log.push('connect'); return client; } } };
}

test('a pool is used one connection at a time: begin, the work, commit, and always give the connection back', async () => {
  const { log, pool } = fakePool();
  const out = await poolTransaction(pool)(async client => { await client.query('SELECT 1'); return 'ok'; });
  assert.equal(out, 'ok');
  assert.deepEqual(log, ['connect', 'BEGIN', 'SELECT 1', 'COMMIT', 'release']);
});

test('when the work fails the transaction is rolled back, the connection is given back, and the original error is the one reported', async () => {
  const { log, pool } = fakePool();
  await assert.rejects(() => poolTransaction(pool)(async () => { throw new Error('the work failed'); }), /the work failed/);
  assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  const lost = fakePool({ failRollback: true });
  await assert.rejects(() => poolTransaction(lost.pool)(async () => { throw new Error('the work failed'); }), /the work failed/, 'a rollback that fails does not hide why');
  assert.equal(lost.log.at(-1), 'release');
  const noCommit = fakePool({ failOn: 'COMMIT' });
  await assert.rejects(() => poolTransaction(noCommit.pool)(async () => 'x'), /boom on COMMIT/);
  assert.deepEqual(noCommit.log, ['connect', 'BEGIN', 'COMMIT', 'ROLLBACK', 'release']);
});

test('the connection is checked at start: it must BE the dedicated role, and not a superuser or one that skips row security', async () => {
  const row = over => async () => ({ rows: [{ who: 'kullina_admin', super: false, bypass: false, ...over }] });
  await assertDedicatedRole(row({}));
  await assert.rejects(() => assertDedicatedRole(row({ who: 'postgres' })), /kullina_admin/);
  await assert.rejects(() => assertDedicatedRole(row({ who: 'service_role' })), /kullina_admin/);
  await assert.rejects(() => assertDedicatedRole(row({ super: true })), /superuser/i);
  await assert.rejects(() => assertDedicatedRole(row({ bypass: true })), /row.level security/i);
  await assert.rejects(() => assertDedicatedRole(async () => ({ rows: [] })), /kullina_admin/);
});

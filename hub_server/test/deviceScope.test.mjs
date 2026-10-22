import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// What a device is allowed to do (§4.7): a tablet at the pass can see tickets and mark them done, and
// cannot place an order, void a bill or touch the staff list. The store's rules first, then a real hub.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
const { deviceAuth, DEVICE_SCOPES } = await import('../lib/deviceAuth.js');
const { hubConfig } = await import('../lib/hubConfig.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const NEVER = '2099-01-01T00:00:00.000Z';
const grantsOnDisk = grants => hubConfig.saveConfig({ ...hubConfig.getPairingInfo(), devices: grants });

// --- the store -------------------------------------------------------------------------------------

test('a device is a full handset unless it says otherwise', () => {
  grantsOnDisk([]);
  const handset = deviceAuth.issueToken('Waiter phone').device_token;
  const screen = deviceAuth.issueToken('Hot screen', 'kitchen').device_token;

  assert.equal(deviceAuth.scopeFor(handset), 'full');
  assert.equal(deviceAuth.scopeFor(screen), 'kitchen');
  assert.deepEqual(DEVICE_SCOPES, ['full', 'kitchen']);
});

test('a token that is not live has no scope at all -- not a default one', () => {
  grantsOnDisk([]);
  const gone = deviceAuth.issueToken('Lost', 'kitchen').device_token;
  deviceAuth.revokeDevice(deviceAuth.listDevicesPublic()[0].id);

  assert.equal(deviceAuth.scopeFor(gone), null, 'revoked');
  assert.equal(deviceAuth.scopeFor('0'.repeat(64)), null, 'never issued');
  assert.equal(deviceAuth.scopeFor(undefined), null);
  assert.equal(deviceAuth.scopeFor({ not: 'a string' }), null);
});

test('an expired token has no scope either, so a kitchen screen cannot outlive its grant', () => {
  grantsOnDisk([]);
  const token = deviceAuth.issueToken('Pass tablet', 'kitchen').device_token;
  assert.equal(deviceAuth.scopeFor(token), 'kitchen');

  // Thirty days on: the same token, the same record, but past its expiry.
  const [grant] = hubConfig.getPairingInfo().devices;
  grantsOnDisk([{ ...grant, expires_at: '2020-01-01T00:00:00.000Z' }]);
  assert.equal(deviceAuth.scopeFor(token), null);
  assert.equal(deviceAuth.verifyToken(token), false);
});

test('a grant enrolled before scopes existed keeps the authority it always had', () => {
  grantsOnDisk([{ token_hash: 'a'.repeat(64), label: 'Old handset', issued_at: '2026-01-01T00:00:00.000Z', expires_at: NEVER }]);
  // Narrowing it silently would stop a waiter's phone in the middle of service.
  assert.equal(deviceAuth.listDevicesPublic()[0].scope, 'full');
});

test('a scope the hub does not recognise is read as the narrower one, never the wider', () => {
  // A hand-edited file, or a value written by a newer hub. When it cannot be understood, the safe
  // reading is the one that can do less.
  grantsOnDisk([{ token_hash: 'b'.repeat(64), label: 'Odd', issued_at: '2026-01-01T00:00:00.000Z', expires_at: NEVER, scope: 'owner' }]);
  assert.equal(deviceAuth.listDevicesPublic()[0].scope, 'kitchen');
});

test('a scope cannot be misspelled into a grant', () => {
  grantsOnDisk([]);
  for (const bad of ['Kitchen', 'KITCHEN', 'admin', '', null]) {
    if (bad === null) continue; // null means "not given" at the route; the store is asked directly below
    assert.throws(() => deviceAuth.issueToken('x', bad), /Unknown device scope/, JSON.stringify(bad));
  }
  assert.deepEqual(deviceAuth.listDevicesPublic(), [], 'and nothing was issued on the way');
});

test('the device list shows each device\'s scope and never a token or its hash', () => {
  grantsOnDisk([]);
  deviceAuth.issueToken('Waiter phone');
  deviceAuth.issueToken('Bar screen', 'kitchen');
  const listed = deviceAuth.listDevicesPublic();

  assert.deepEqual(listed.map(d => [d.label, d.scope]), [['Waiter phone', 'full'], ['Bar screen', 'kitchen']]);
  assert.equal(JSON.stringify(listed).includes('token'), false);
});

test('the kitchen routes are exactly the ones a screen at the pass needs', () => {
  // The whole of what a kitchen token can reach, pinned. Widening it should be a decision someone
  // makes on purpose and reads in a diff, not something a refactor does on the way past.
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
  const routes = [...source.matchAll(/app\.(get|post|put|delete)\('([^']+)',\s*requireKitchenDevice/g)]
    .map(m => `${m[1].toUpperCase()} ${m[2]}`)
    .sort();

  assert.deepEqual(routes, [
    'GET /orders/active',
    'POST /orders/:id/fire',
    'POST /orders/:id/ready',
    'POST /orders/:id/recall',
    'POST /orders/:id/stations/:station/ready'
  ]);
  assert.equal(source.split('requireKitchenDevice').length - 1, routes.length + 1,
    'one mention per route, plus the import -- it is not applied anywhere else, e.g. app.use');
});

// --- a real hub ------------------------------------------------------------------------------------

const FIXTURE = {
  menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
  tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
};
const json = res => res.json();
const enrol = (hub, code, body = {}) =>
  call(hub, '/auth/device', { method: 'POST', body: { enrollment_code: code, device_label: 'Test', ...body } });
const enrolled = async (hub, code, scope) => (await json(await enrol(hub, code, scope ? { scope } : {}))).device_token;

let remote;
let reception;
let handset;   // a full handset's token, on `remote`
let screen;    // a kitchen screen's token, on `remote`
before(async () => {
  remote = await startHub({ trustLoopback: false, ...FIXTURE, enrollmentCode: 'SCOPEONE' });
  reception = await startHub({ trustLoopback: true, ...FIXTURE, enrollmentCode: 'SCOPETWO' });
  handset = await enrolled(remote, 'SCOPEONE');
  screen = await enrolled(remote, 'SCOPEONE', 'kitchen');
});
after(() => { remote?.stop(); reception?.stop(); });

test('hub: a screen enrols as kitchen, and the reception staff list says so', async () => {
  const res = await enrol(reception, 'SCOPETWO', { scope: 'kitchen', device_label: 'Hot screen' });
  assert.equal(res.status, 200);
  const handset = await enrol(reception, 'SCOPETWO', { device_label: 'Waiter phone' });
  assert.equal(handset.status, 200);

  const { devices } = await json(await call(reception, '/admin/staff'));
  assert.deepEqual(devices.map(d => [d.label, d.scope]), [['Hot screen', 'kitchen'], ['Waiter phone', 'full']]);
});

test('hub: an unknown scope is refused and enrols nothing', async () => {
  const before = (await json(await call(reception, '/admin/staff'))).devices.length;
  for (const scope of ['owner', 'KITCHEN', '', 7, {}]) {
    const res = await enrol(reception, 'SCOPETWO', { scope });
    assert.equal(res.status, 400, JSON.stringify(scope));
    assert.equal((await json(res)).code, 'INVALID_SCOPE');
  }
  assert.equal((await json(await call(reception, '/admin/staff'))).devices.length, before);
});

test('hub: asking for kitchen does not get around the enrolment code', async () => {
  const res = await enrol(remote, 'WRONGCODE', { scope: 'kitchen' });
  assert.equal(res.status, 401, 'the scope is a smaller authority, not a different door');
});

const placed = async fullToken => {
  const res = await call(remote, '/orders', { method: 'POST', token: fullToken, body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] } });
  assert.equal(res.status, 201);
  return (await json(res)).ticket;
};

test('hub: a kitchen screen can see the tickets and mark them done', async () => {
  const ticket = await placed(handset);

  const active = await call(remote, '/orders/active', { token: screen });
  assert.equal(active.status, 200);
  assert.ok((await json(active)).tickets.some(t => t.id === ticket.id));

  const done = await call(remote, `/orders/${ticket.id}/ready`, { method: 'POST', token: screen });
  assert.equal(done.status, 200, 'a kitchen screen marks the ticket ready');
});

test('hub: a station can mark its own part done', async () => {
  const ticket = await placed(handset);

  const res = await call(remote, `/orders/${ticket.id}/stations/hot/ready`, { method: 'POST', token: screen });
  assert.equal(res.status, 200);
});

test('hub: fire and recall are not refused as out of scope -- they are the kitchen\'s job', async () => {
  const ticket = await placed(handset);

  for (const p of [`/orders/${ticket.id}/fire`, `/orders/${ticket.id}/recall`]) {
    const res = await call(remote, p, { method: 'POST', token: screen });
    const body = await json(res);
    // Whatever else the hub says (a plan that has no course firing, nothing to recall) is a different
    // question; what matters here is that it is not the scope that stopped it.
    assert.notEqual(body.code, 'DEVICE_SCOPE', p);
    assert.notEqual(res.status, 401, p);
  }
});

// Everything else a device token reaches. Each is a route an enrolled handset really uses, so each is
// one a kitchen screen has no business with.
const OUT_OF_SCOPE = [
  ['POST', '/orders', { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] }],
  ['POST', '/pair', {}],
  ['GET', '/menu'],
  ['GET', '/tables'],
  ['GET', '/tables/layout'],
  ['GET', '/tables/1/invoice'],
  ['POST', '/tables/1/invoice/preview', {}],
  ['POST', '/tables/1/clear', {}],
  ['GET', '/invoices'],
  ['GET', '/invoices/inv_1'],
  ['POST', '/invoices/inv_1/void', { reason: 'x' }],
  ['POST', '/invoices/inv_1/mark-paid', {}],
  ['POST', '/invoices/inv_1/refund', {}],
  ['POST', '/invoices/inv_1/print-receipt', {}],
  ['POST', '/invoices/inv_1/split-by-seats', {}],
  ['POST', '/invoices/inv_1/split-by-items', {}],
  ['POST', '/invoices/inv_1/split-by-amounts', {}],
  ['DELETE', '/invoices/inv_1/splits'],
  ['POST', '/invoices/inv_1/splits/0/mark-paid', {}],
  ['POST', '/orders/t_1/clear', {}],
  ['POST', '/orders/t_1/print-kot', {}],
  ['POST', '/orders/t_1/cancel', { reason: 'x' }],
  ['GET', '/waiters'],
  ['POST', '/waiters/login', {}],
  ['POST', '/waiters/redeem-invite', {}],
  ['GET', '/printers'],
  ['GET', '/plan'],
  ['GET', '/sync-status'],
  ['GET', '/crash-log'],
  ['GET', '/dashboard-data']
];

test('hub: a kitchen screen is refused everything else -- bills, orders, staff, the lot', async () => {
  for (const [method, p, body] of OUT_OF_SCOPE) {
    const res = await call(remote, p, { method, body, token: screen });
    assert.equal(res.status, 403, `${method} ${p} -> ${res.status}`);
    assert.equal((await json(res)).code, 'DEVICE_SCOPE', `${method} ${p}`);
  }
});

test('hub: adding and removing staff is refused to a kitchen screen too -- it is reception\'s, not any device\'s', async () => {
  // Reception-only, so a refusal to every token and not a matter of scope: a kitchen screen gets the same
  // 403 a full handset does (hub.test.mjs covers the handset).
  for (const [method, p, body] of [['POST', '/waiters', { name: 'Intruder', pin: '4821' }], ['DELETE', '/waiters/w_1']]) {
    const res = await call(remote, p, { method, body, token: screen });
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.equal((await json(res)).code, 'RECEPTION_ONLY', `${method} ${p}`);
  }
});

test('hub: the same routes are not refused to a full handset on scope grounds', async () => {
  // The control for the test above: they are refused there because of the scope, and not because the
  // routes are broken, the ids are made up or the body is empty. A handset gets past the scope check
  // (and may then get a 400 or 404 for a made-up id, which is a different matter).
  for (const [method, p, body] of OUT_OF_SCOPE) {
    const res = await call(remote, p, { method, body, token: handset });
    const text = await res.text();
    // The device codes, not the status: /waiters/login answers 401 for a missing PIN, which is the
    // route working, not the handset being turned away.
    assert.equal(text.includes('DEVICE_UNAUTHORISED'), false, `${method} ${p}`);
    assert.equal(text.includes('DEVICE_SCOPE'), false, `${method} ${p}`);
  }
});

test('hub: no token at all is still a 401, whatever the route', async () => {
  for (const [method, p, body] of [['GET', '/orders/active'], ['POST', '/orders/t_1/ready', {}], ...OUT_OF_SCOPE.slice(0, 5)]) {
    const res = await call(remote, p, { method, body });
    assert.equal(res.status, 401, `${method} ${p}`);
    assert.equal((await json(res)).code, 'DEVICE_UNAUTHORISED');
  }
});

test('hub: /pairing-info tells a device its own scope, so a tablet knows what it was enrolled as', async () => {
  const scopeFor = async token => (await json(await call(remote, '/pairing-info', { token }))).device_scope;

  assert.equal(await scopeFor(handset), 'full');
  assert.equal(await scopeFor(screen), 'kitchen');
  assert.equal(await scopeFor(undefined), null, 'no token, no scope');
  assert.equal(await scopeFor('0'.repeat(64)), null, 'a token the hub never issued');
  assert.equal((await json(await call(reception, '/pairing-info'))).device_scope, 'full', 'the reception laptop itself');
});

test('hub: the live feed accepts a kitchen screen, and still refuses a stranger', async () => {
  const url = remote.base.replace(/^http/, 'ws');

  const opened = await new Promise(resolve => {
    const ws = new WebSocket(`${url}/live?station=hot&token=${screen}`);
    ws.once('open', () => { ws.close(); resolve(true); });
    ws.once('error', () => resolve(false));
    ws.once('unexpected-response', () => resolve(false));
  });
  assert.equal(opened, true);

  const refused = await new Promise(resolve => {
    const ws = new WebSocket(`${url}/live?station=hot&token=${'0'.repeat(64)}`);
    ws.once('open', () => { ws.close(); resolve(false); });
    ws.once('error', () => resolve(true));
    ws.once('unexpected-response', () => resolve(true));
  });
  assert.equal(refused, true);
});

test('hub: revoking a kitchen screen locks it out like any other device', async () => {
  // At the store, for the reason given in staffAccess.test.mjs: a hub that trusts its own loopback
  // never checks a token from it.
  grantsOnDisk([]);
  const screen = deviceAuth.issueToken('Pass tablet', 'kitchen').device_token;
  assert.equal(deviceAuth.scopeFor(screen), 'kitchen');
  deviceAuth.revokeDevice(deviceAuth.listDevicesPublic()[0].id);
  assert.equal(deviceAuth.scopeFor(screen), null);
});

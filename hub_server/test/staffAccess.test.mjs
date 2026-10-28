import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Staff and devices (§4.4): who may sign in, how they get a PIN, and which devices may talk to this
// hub at all. The rules first, against a store on a throwaway directory, then a real hub.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
const { waiterStore, ROLES } = await import('../lib/waiterStore.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const reset = () => { waiterStore.waiters = []; };
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false); assert.equal(r.code, code); return r; };
const NOW = new Date('2026-10-21T10:00:00.000Z');
const later = ms => new Date(NOW.getTime() + ms);

// --- invites ---------------------------------------------------------------------------------

test('an invited person cannot sign in until they have set a PIN', () => {
  reset();
  const invited = ok(waiterStore.invite({ name: 'Asha', role: 'waiter' }, NOW));
  const id = invited.waiter.id;

  // There is no hash to compare against, and no PIN may be guessed into one.
  refused(waiterStore.verify(id, '1234'), 'INVALID_CREDENTIALS');
  refused(waiterStore.verify(id, ''), 'INVALID_CREDENTIALS');
  refused(waiterStore.verify(id, undefined), 'INVALID_CREDENTIALS');
  assert.deepEqual(waiterStore.listActive(), [], 'and no handset offers them as a name to pick');
});

test('the invite code is returned once and never again', () => {
  reset();
  const invited = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  assert.match(invited.invite_code, /^[A-Z2-9]{6}$/);
  assert.equal(invited.expires_at, later(7 * 24 * 60 * 60 * 1000).toISOString());

  const listed = waiterStore.listAll(NOW).find(s => s.id === invited.waiter.id);
  assert.equal('invite_code' in listed, false, 'a reception screen left open is not a credential');
  assert.equal(listed.pin_set, false);
  assert.equal(listed.invite_expired, false);
  assert.equal(JSON.stringify(waiterStore.waiters).includes(invited.invite_code), false, 'and it is stored only as a hash');
});

test('redeeming an invite sets the PIN, and the code cannot be used twice', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));

  ok(waiterStore.redeemInvite(invite_code, '7391', NOW));
  assert.equal(ok(waiterStore.verify(waiter.id, '7391')).waiter.name, 'Asha');
  assert.deepEqual(waiterStore.listActive().map(w => w.name), ['Asha'], 'now the handset offers them');

  refused(waiterStore.redeemInvite(invite_code, '2468', NOW), 'INVALID_INVITE');
  assert.equal(ok(waiterStore.verify(waiter.id, '7391')).ok, true, 'and the PIN they chose still works');
});

test('a code is accepted however it is typed, but a wrong one is refused the same way as an unknown one', () => {
  reset();
  const { invite_code } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  ok(waiterStore.redeemInvite(`  ${invite_code.toLowerCase()} `, '7391', NOW));

  reset();
  ok(waiterStore.invite({ name: 'Bhavna' }, NOW));
  const wrong = refused(waiterStore.redeemInvite('ZZZZZZ', '7391', NOW), 'INVALID_INVITE');
  const none = refused(waiterStore.redeemInvite('', '7391', NOW), 'INVALID_INVITE');
  assert.equal(wrong.error, none.error, 'the answer never says which codes exist');
});

test('an expired invite is refused, and reception can issue a fresh one', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  const tooLate = later(8 * 24 * 60 * 60 * 1000);
  refused(waiterStore.redeemInvite(invite_code, '7391', tooLate), 'INVALID_INVITE');
  assert.equal(waiterStore.listAll(tooLate)[0].invite_expired, true);

  const again = ok(waiterStore.reinvite(waiter.id, tooLate));
  assert.notEqual(again.invite_code, invite_code, 'a new code, not the old one re-shown');
  refused(waiterStore.redeemInvite(invite_code, '7391', tooLate), 'INVALID_INVITE');
  ok(waiterStore.redeemInvite(again.invite_code, '7391', tooLate));
});

test('someone who has already set a PIN is not re-invited: that would be a way to take their account', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  ok(waiterStore.redeemInvite(invite_code, '7391', NOW));
  refused(waiterStore.reinvite(waiter.id, NOW), 'ALREADY_SET_UP');
});

test('a PIN chosen at redemption must be four digits, and not one anybody would try first', () => {
  reset();
  const { invite_code } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  for (const bad of ['123', '12345', 'abcd', '', null, '12 4']) refused(waiterStore.redeemInvite(invite_code, bad, NOW), 'INVALID_PIN');
  for (const weak of ['0000', '1234', '1111', '4321']) refused(waiterStore.redeemInvite(invite_code, weak, NOW), 'WEAK_PIN');
  ok(waiterStore.redeemInvite(invite_code, '7391', NOW));
});

test('two people cannot be invited under one name', () => {
  reset();
  ok(waiterStore.invite({ name: 'Asha' }, NOW));
  refused(waiterStore.invite({ name: '  asha  ' }, NOW), 'DUPLICATE_NAME');
  refused(waiterStore.invite({ name: '   ' }, NOW), 'INVALID_NAME');
});

// --- PIN rotation ------------------------------------------------------------------------------

test('rotating a PIN works at once, and the old one stops working', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  ok(waiterStore.redeemInvite(invite_code, '7391', NOW));

  ok(waiterStore.rotatePin(waiter.id, '8502', NOW));
  refused(waiterStore.verify(waiter.id, '7391'), 'INVALID_CREDENTIALS');
  assert.equal(ok(waiterStore.verify(waiter.id, '8502')).waiter.id, waiter.id);
});

test('rotating a PIN for someone still invited sets them up and cancels the invite', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  ok(waiterStore.rotatePin(waiter.id, '8502', NOW));

  assert.equal(ok(waiterStore.verify(waiter.id, '8502')).ok, true);
  refused(waiterStore.redeemInvite(invite_code, '1357', NOW), 'INVALID_INVITE', 'the outstanding code is dead');
  assert.equal(waiterStore.listAll(NOW)[0].pin_set, true);
});

test('a rotation is refused for an unknown person and for a weak PIN', () => {
  reset();
  const { waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  refused(waiterStore.rotatePin('w_nope', '8502', NOW), 'NOT_FOUND');
  refused(waiterStore.rotatePin(waiter.id, '999', NOW), 'INVALID_PIN');
  refused(waiterStore.rotatePin(waiter.id, '1111', NOW), 'WEAK_PIN');
});

// --- roles -------------------------------------------------------------------------------------

test('a role is carried, defaults to waiter, and only a known one is accepted', () => {
  reset();
  assert.equal(ok(waiterStore.invite({ name: 'Asha' }, NOW)).waiter.role, 'waiter');
  const manager = ok(waiterStore.invite({ name: 'Bhavna', role: 'manager' }, NOW));
  assert.equal(manager.waiter.role, 'manager');
  assert.equal(ok(waiterStore.invite({ name: 'Chetan', role: 'wizard' }, NOW)).waiter.role, 'waiter', 'an unknown role is not stored');

  ok(waiterStore.setRole(manager.waiter.id, 'kitchen'));
  assert.equal(waiterStore.listAll(NOW).find(s => s.id === manager.waiter.id).role, 'kitchen');
  refused(waiterStore.setRole(manager.waiter.id, 'wizard'), 'INVALID_ROLE');
  refused(waiterStore.setRole('w_nope', 'manager'), 'NOT_FOUND');
  assert.deepEqual([...ROLES].sort(), ['kitchen', 'manager', 'waiter']);
});

test('a row from before roles existed reads as a waiter rather than as nothing', () => {
  reset();
  waiterStore.waiters = [{ id: 'w_old', name: 'Vikram', pin_hash: 'x'.repeat(64), pin_salt: 'y', active: true }];
  assert.equal(waiterStore.listAll(NOW)[0].role, 'waiter');
  assert.equal(waiterStore.listActive()[0].role, 'waiter');
});

// --- deactivation --------------------------------------------------------------------------------

test('someone deactivated cannot sign in, and is kept on the list rather than erased', () => {
  reset();
  const { invite_code, waiter } = ok(waiterStore.invite({ name: 'Asha' }, NOW));
  ok(waiterStore.redeemInvite(invite_code, '7391', NOW));

  ok(waiterStore.deactivate(waiter.id));
  refused(waiterStore.verify(waiter.id, '7391'), 'INVALID_CREDENTIALS');
  assert.deepEqual(waiterStore.listActive(), []);
  assert.equal(waiterStore.listAll(NOW).length, 1, 'still on record: the bills they took still name them');
});

// --- a real hub ----------------------------------------------------------------------------------

const FIXTURE = {
  menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
  tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
};
let hub;
let remote;
before(async () => {
  hub = await startHub({ trustLoopback: true, ...FIXTURE, enrollmentCode: 'STAFFONE' });
  remote = await startHub({ trustLoopback: false, ...FIXTURE, enrollmentCode: 'STAFFTWO' });
});
after(() => { hub?.stop(); remote?.stop(); });

const call = (h, p, { method = 'GET', body, token } = {}) =>
  fetch(`${h.base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
const api = (p, opts) => call(hub, p, opts);
const json = async res => res.json();

test('hub: reception invites someone, they redeem on a handset, and only then can they sign in', async () => {
  const created = await api('/admin/staff', { method: 'POST', body: { name: 'Asha', role: 'manager' } });
  assert.equal(created.status, 201);
  const { waiter, invite_code } = await json(created);
  assert.equal(waiter.role, 'manager');

  // The handset's name picker does not offer them yet.
  const before = await json(await api('/waiters'));
  assert.equal(before.waiters.some(w => w.id === waiter.id), false);

  const redeemed = await api('/waiters/redeem-invite', { method: 'POST', body: { code: invite_code, pin: '7391' } });
  assert.equal(redeemed.status, 200);

  const after_ = await json(await api('/waiters'));
  assert.equal(after_.waiters.some(w => w.id === waiter.id), true);
  const login = await api('/waiters/login', { method: 'POST', body: { waiter_id: waiter.id, pin: '7391' } });
  assert.equal(login.status, 200);
});

test('hub: a wrong invite code is refused and never says which codes exist', async () => {
  const res = await api('/waiters/redeem-invite', { method: 'POST', body: { code: 'ZZZZZZ', pin: '7391' } });
  assert.equal(res.status, 401);
  const body = await json(res);
  assert.equal(body.code, 'INVALID_INVITE');
  assert.match(body.error, /not valid, or it has expired/);
});

test('hub: reception rotates a PIN and the old one stops working at once', async () => {
  const { waiter, invite_code } = await json(await api('/admin/staff', { method: 'POST', body: { name: 'Bhavna' } }));
  await api('/waiters/redeem-invite', { method: 'POST', body: { code: invite_code, pin: '7391' } });

  assert.equal((await api('/admin/staff/' + waiter.id + '/pin', { method: 'POST', body: { pin: '8502' } })).status, 200);
  assert.equal((await api('/waiters/login', { method: 'POST', body: { waiter_id: waiter.id, pin: '7391' } })).status, 401);
  assert.equal((await api('/waiters/login', { method: 'POST', body: { waiter_id: waiter.id, pin: '8502' } })).status, 200);

  const weak = await api('/admin/staff/' + waiter.id + '/pin', { method: 'POST', body: { pin: '1111' } });
  assert.equal(weak.status, 400);
  assert.equal((await json(weak)).code, 'WEAK_PIN');
});

test('hub: reception changes a role, and the staff list shows who is still to set a PIN', async () => {
  const { waiter } = await json(await api('/admin/staff', { method: 'POST', body: { name: 'Chetan' } }));
  assert.equal((await api(`/admin/staff/${waiter.id}/role`, { method: 'PUT', body: { role: 'kitchen' } })).status, 200);

  const list = await json(await api('/admin/staff'));
  const chetan = list.staff.find(s => s.id === waiter.id);
  assert.equal(chetan.role, 'kitchen');
  assert.equal(chetan.pin_set, false);
  assert.ok(list.roles.some(r => r.id === 'manager' && r.label === 'Manager'));
  assert.equal(JSON.stringify(list).includes('pin_hash'), false, 'no hash ever reaches a screen');
});

// --- devices ---------------------------------------------------------------------------------------

test('a revoked device is refused on its very next request -- there is no session to expire', async () => {
  // Proven against deviceAuth itself rather than over HTTP: a hub that trusts its own loopback never
  // checks a token from it, and a hub that does not trust loopback will not serve the reception-only
  // revoke route. The store is where the two meet.
  const { deviceAuth } = await import("../lib/deviceAuth.js");
  const keep = deviceAuth.issueToken("Kept handset").device_token;
  const lost = deviceAuth.issueToken("Lost phone").device_token;
  assert.equal(deviceAuth.verifyToken(lost), true);

  const listed = deviceAuth.listDevicesPublic().find(d => d.label === "Lost phone");
  assert.ok(listed?.id, "it is listed, with an id to revoke it by");
  assert.equal("token_hash" in listed, false, "and without the only secret in the record");

  const revoked = deviceAuth.revokeDevice(listed.id);
  assert.equal(revoked.ok, true);
  assert.equal(deviceAuth.verifyToken(lost), false, "the lost phone is locked out");
  assert.equal(deviceAuth.verifyToken(keep), true, "and every other handset keeps working");
  assert.deepEqual(deviceAuth.revokeDevice(listed.id), { ok: false, code: "NOT_FOUND", error: "That device is not enrolled on this hub." });
});

test('a device enrolled before ids existed can still be revoked', async () => {
  const { deviceAuth } = await import("../lib/deviceAuth.js");
  const { hubConfig } = await import("../lib/hubConfig.js");
  const cfg = hubConfig.getPairingInfo();
  const legacy = { token_hash: "a".repeat(64), label: "Old handset", issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" };
  hubConfig.saveConfig({ ...cfg, devices: [legacy] });

  const listed = deviceAuth.listDevicesPublic()[0];
  assert.equal(listed.id, "legacy_" + "a".repeat(16), "identified by a prefix of what is already stored");
  assert.equal(deviceAuth.revokeDevice(listed.id).ok, true, "without re-enrolling every device first");
  assert.deepEqual(deviceAuth.listDevicesPublic(), []);
});

test('expired grants are reported as expired, and can be tidied away', async () => {
  const { deviceAuth } = await import("../lib/deviceAuth.js");
  const { hubConfig } = await import("../lib/hubConfig.js");
  const cfg = hubConfig.getPairingInfo();
  hubConfig.saveConfig({ ...cfg, devices: [
    { id: "dev_old", token_hash: "b".repeat(64), label: "Last season", issued_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-02-01T00:00:00.000Z" },
    { id: "dev_now", token_hash: "c".repeat(64), label: "Current", issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" }
  ] });

  const listed = deviceAuth.listDevicesPublic();
  assert.deepEqual(listed.map(d => [d.label, d.expired]), [["Last season", true], ["Current", false]]);
  assert.deepEqual(deviceAuth.pruneExpiredDevices(), { removed: 1 });
  assert.deepEqual(deviceAuth.listDevicesPublic().map(d => d.label), ["Current"]);
  assert.deepEqual(deviceAuth.pruneExpiredDevices(), { removed: 0 }, "and running it again changes nothing");
});

test('hub: revoking an unknown device is a clear 404, not a silent success', async () => {
  const res = await api('/admin/devices/dev_nope', { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.equal((await json(res)).code, 'NOT_FOUND');
});

test('hub: rotating the enrollment code revokes every device, and says how many', async () => {
  await call(hub, '/auth/device', { method: 'POST', body: { enrollment_code: 'STAFFONE', device_label: 'A' } });
  const before = (await json(await api('/admin/staff'))).devices.length;
  assert.ok(before > 0);

  const rotated = await json(await api('/admin/devices/rotate-code', { method: 'POST' }));
  assert.equal(rotated.revoked, before);
  assert.equal((await json(await api('/admin/staff'))).devices.length, 0);
});

test('hub: every staff and device route is reception-only -- an enrolled handset is refused', async () => {
  const enrolled = await json(await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'STAFFTWO', device_label: 'Handset' } }));
  const routes = [
    ['GET', '/admin/staff'],
    ['POST', '/admin/staff', { name: 'Intruder' }],
    ['POST', '/admin/staff/w_1/reinvite'],
    ['POST', '/admin/staff/w_1/pin', { pin: '7391' }],
    ['PUT', '/admin/staff/w_1/role', { role: 'manager' }],
    ['DELETE', '/admin/staff/w_1'],
    ['DELETE', '/admin/devices/dev_1'],
    ['POST', '/admin/devices/prune'],
    ['POST', '/admin/devices/rotate-code']
  ];
  for (const [method, p, body] of routes) {
    for (const token of [undefined, enrolled.device_token]) {
      const res = await call(remote, p, { method, body, token });
      assert.ok([401, 403].includes(res.status), `${method} ${p} ${token ? 'with a token' : 'with none'} -> ${res.status}`);
    }
  }
});

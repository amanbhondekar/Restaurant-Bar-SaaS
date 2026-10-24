import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReservationStore } from '../lib/reservationStore.js';
import { newBookingCode, readPage, enablePage, disablePage, newAddress, pullInbox } from '../lib/bookingInbox.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';

// The hub's side of the public booking page (§4.6): turning the page on and off and giving it a new address, and collecting what guests
// have asked for. The hub reaches the cloud only as its own restaurant, so what is tested is that it touches only its own rows, that
// a failure is an answer and not a crash or a leak, and that collecting is safe to repeat: the hub can be off for days, the cloud can
// fail halfway, and the same inbox will be read again.

const RID = 'r-uuid';
const OTHER = 'r-other';
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const HOUR = 3600 * 1000;
const when = hours => new Date(NOW.getTime() + hours * HOUR).toISOString();
const dirs = [];
const stores = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kullina-inbox-'));
  dirs.push(dir);
  const s = new ReservationStore(path.join(dir, 'reservations.json'));
  s.ensureTenant(RID);
  stores.push(s);
  return s;
};
// A store saves in the background; take the directory away from under it and the write fails.
after(async () => {
  await Promise.all(stores.map(s => s.flush()));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const row = (n, over = {}) => ({ id: `c${n}`, restaurant_id: RID, guest_name: `Guest ${n}`, phone: '919876543210', party_size: 2, requested_for: when(5 + n), note: null, created_at: when(-1), ...over });
const cloudWith = (rows = [], pages = [], failures = {}) => memoryCloud({ restaurants: [{ id: RID }, { id: OTHER }], bookingRequests: rows, bookingPages: pages, failures });

// --- the page's address ------------------------------------------------------------------------------------------------

test('a code is twelve lower-case letters and digits, and not the same twice', () => {
  const codes = new Set(Array.from({ length: 200 }, () => newBookingCode()));
  assert.equal(codes.size, 200);
  for (const c of codes) assert.match(c, /^[a-z0-9]{12}$/);
  assert.equal(newBookingCode(() => 0), 'a'.repeat(12), 'built from the generator it is given, one character at a time');
  const seen = [];
  newBookingCode(n => { seen.push(n); return 35; });
  assert.deepEqual([...new Set(seen)], [36], 'each character is drawn from all 36, without bias');
});

test('with no page there is nothing to read; once switched on it is there, on, with a code', async () => {
  const cloud = cloudWith();
  assert.deepEqual(await readPage(cloud, RID), { ok: true, page: null });
  const made = await enablePage(cloud, RID);
  assert.equal(made.ok, true);
  assert.match(made.page.code, /^[a-z0-9]{12}$/);
  assert.equal(made.page.enabled, true);
  assert.deepEqual(await readPage(cloud, RID), { ok: true, page: { code: made.page.code, enabled: true } });
  assert.deepEqual(cloud.calls.inserts.map(i => [i.table, i.row.restaurant_id]), [['booking_pages', RID]]);
});

test('switching on twice makes one page, and a page switched off comes back on at the same address', async () => {
  const cloud = cloudWith();
  const first = await enablePage(cloud, RID);
  const again = await enablePage(cloud, RID);
  assert.equal(again.page.code, first.page.code);
  assert.equal(cloud.tables.booking_pages.length, 1);

  const off = await disablePage(cloud, RID);
  assert.deepEqual(off.page, { code: first.page.code, enabled: false }, 'off, and the address is kept');
  const on = await enablePage(cloud, RID);
  assert.deepEqual(on.page, { code: first.page.code, enabled: true }, 'the same address, so a printed card still works');
  assert.equal(cloud.tables.booking_pages.length, 1);
});

test('switching off a page that was never on is nothing to do', async () => {
  const cloud = cloudWith();
  assert.deepEqual(await disablePage(cloud, RID), { ok: true, page: null });
  assert.equal(cloud.calls.updates.length, 0);
});

test('a code that is already taken is replaced by another, and the hub gives up rather than looping', async () => {
  const taken = 'a'.repeat(12);
  const cloud = cloudWith([], [{ restaurant_id: OTHER, code: taken, enabled: true }]);
  const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const random = () => draws.shift() ?? 2;
  const ok = await enablePage(cloud, RID, { random });
  assert.equal(ok.ok, true);
  assert.equal(ok.page.code, 'b'.repeat(12), 'the first draw was taken, the second was free');

  const always = cloudWith([], [{ restaurant_id: OTHER, code: taken, enabled: true }]);
  const stuck = await enablePage(always, RID, { random: () => 0 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.code, 'CLOUD');
  assert.ok(always.calls.inserts.length <= 5, `tried ${always.calls.inserts.length} times`);
});

test('a new address replaces the code, keeps the page on or off as it was, and needs a page to exist', async () => {
  const cloud = cloudWith();
  assert.equal((await newAddress(cloud, RID)).code, 'NO_PAGE');
  const first = (await enablePage(cloud, RID)).page;
  const next = await newAddress(cloud, RID);
  assert.equal(next.ok, true);
  assert.notEqual(next.page.code, first.code);
  assert.equal(next.page.enabled, true);
  assert.equal((await readPage(cloud, RID)).page.code, next.page.code, 'and the old address no longer opens anything');

  await disablePage(cloud, RID);
  const stillOff = await newAddress(cloud, RID);
  assert.equal(stillOff.page.enabled, false, 'rotating the address does not switch the page back on');
});

test('another restaurant\'s page is never touched', async () => {
  const cloud = cloudWith([], [{ restaurant_id: OTHER, code: 'otherpage123', enabled: true }]);
  await enablePage(cloud, RID);
  await disablePage(cloud, RID);
  await newAddress(cloud, RID);
  assert.deepEqual(cloud.tables.booking_pages.find(p => p.restaurant_id === OTHER), { restaurant_id: OTHER, code: 'otherpage123', enabled: true });
  for (const u of cloud.calls.updates) assert.equal(u.val, RID, 'every change is filtered to this restaurant');
});

test('when the cloud fails the answer is a plain one, without the database\'s own words', async () => {
  const plain = r => {
    assert.equal(r.ok, false, 'a failure is not an answer of "fine"');
    assert.equal(r.code, 'CLOUD');
    assert.doesNotMatch(r.error, /10\.0\.0\.5|rls violated|refused|timeout/);
    assert.match(r.error, /cloud|internet/i);
  };
  const reading = cloudWith([], [], { select: { booking_pages: { message: 'connection to 10.0.0.5 refused' } } });
  for (const r of [await readPage(reading, RID), await enablePage(reading, RID), await disablePage(reading, RID), await newAddress(reading, RID)]) plain(r);
  assert.equal(reading.calls.inserts.length + reading.calls.updates.length, 0, 'and nothing is written when the page could not even be read');

  const inserting = cloudWith([], [], { insert: { booking_pages: { message: 'rls violated', code: '42501' } } });
  plain(await enablePage(inserting, RID));
  assert.equal(inserting.calls.inserts.length, 1, 'a refusal that is not a clash of codes is not tried again');

  const off = [{ restaurant_id: RID, code: 'abcdefghij12', enabled: false }];
  const on = [{ restaurant_id: RID, code: 'abcdefghij12', enabled: true }];
  const refusing = { update: { booking_pages: { message: 'timeout' } } };
  plain(await enablePage(cloudWith([], off, refusing), RID));
  plain(await disablePage(cloudWith([], on, refusing), RID));
  plain(await newAddress(cloudWith([], on, refusing), RID));
});

// --- collecting what guests asked ---------------------------------------------------------------------------------------

test('what is in the inbox is collected, and stays there until staff have answered', async () => {
  const cloud = cloudWith([row(1), row(2), row(3, { restaurant_id: OTHER })]);
  const s = store();
  const r = await pullInbox(cloud, RID, s, { now: NOW });
  assert.deepEqual([r.ok, r.received, r.cleared], [true, 2, 0]);
  assert.deepEqual(s.pendingRequests(RID, { now: NOW }).map(x => x.guest_name), ['Guest 1', 'Guest 2']);
  assert.equal(cloud.tables.booking_requests.length, 3, 'nothing is removed from the cloud until it has been dealt with');
  assert.deepEqual(cloud.calls.selects.at(-1).filters, [['restaurant_id', RID]], 'only this restaurant\'s inbox is read');
  assert.equal(cloud.calls.deletes.length, 0);
});

test('collecting again takes nothing twice', async () => {
  const cloud = cloudWith([row(1)]);
  const s = store();
  await pullInbox(cloud, RID, s, { now: NOW });
  const revision = s.stateFor(RID).revision;
  const again = await pullInbox(cloud, RID, s, { now: NOW });
  assert.deepEqual([again.received, again.cleared], [0, 0]);
  assert.equal(s.pendingRequests(RID, { now: NOW }).length, 1);
  assert.equal(s.stateFor(RID).revision, revision, 'and the diary was not rewritten for nothing');
});

test('once a request is answered it is cleared from the cloud, and only that one', async () => {
  const cloud = cloudWith([row(1), row(2), row(3), row(4, { restaurant_id: OTHER })]);
  const s = store();
  await pullInbox(cloud, RID, s, { now: NOW });
  const [one, two] = s.pendingRequests(RID, { now: NOW });
  assert.equal(s.declineRequest(RID, one.id, { now: NOW }).ok, true);
  assert.equal(s.acceptRequest(RID, two.id, { now: NOW, tables: [{ id: 1, name: 'T1', capacity: 4 }], seatedWalkIns: 0 }).ok, true);

  const r = await pullInbox(cloud, RID, s, { now: NOW });
  assert.deepEqual([r.received, r.cleared], [0, 2]);
  assert.deepEqual(cloud.tables.booking_requests.map(x => x.id).sort(), ['c3', 'c4'], 'the waiting one, and another restaurant\'s that was never ours to touch');
  assert.deepEqual(cloud.calls.deletes.at(-1).filters.map(f => f[0]), ['restaurant_id', 'id'], 'cleared by id, and only within this restaurant, not by a wide filter');
  const again = await pullInbox(cloud, RID, s, { now: NOW });
  assert.equal(again.cleared, 0);
});

test('a request that came back because the clearing failed is not asked about again', async () => {
  const cloud = cloudWith([row(1)]);
  const s = store();
  await pullInbox(cloud, RID, s, { now: NOW });
  s.declineRequest(RID, s.pendingRequests(RID, { now: NOW })[0].id, { now: NOW });
  const failing = cloudWith([row(1)], [], { delete: { booking_requests: { message: 'timeout' } } });
  const r1 = await pullInbox(failing, RID, s, { now: NOW });
  assert.equal(r1.ok, true, 'a failed clearing is retried next time, not an error');
  assert.equal(r1.cleared, 0);
  assert.equal(failing.tables.booking_requests.length, 1);
  assert.equal(s.pendingRequests(RID, { now: NOW }).length, 0, 'and it did not come back to life as a new request');
  const r2 = await pullInbox(cloud, RID, s, { now: NOW });
  assert.equal(r2.cleared, 1);
});

test('rows the hub cannot use are cleared away rather than left to fill the inbox', async () => {
  const cloud = cloudWith([row(1), row(2, { phone: 'nope' }), row(3, { party_size: 99 })]);
  const s = store();
  const r = await pullInbox(cloud, RID, s, { now: NOW });
  assert.deepEqual([r.received, r.cleared], [1, 2]);
  assert.deepEqual(cloud.tables.booking_requests.map(x => x.id), ['c1']);
});

test('requests whose time went a day ago are let go and cleared', async () => {
  const cloud = cloudWith([row(1, { requested_for: when(-30) }), row(2, { requested_for: when(4) })]);
  const s = store();
  const r = await pullInbox(cloud, RID, s, { now: NOW });
  assert.deepEqual([r.received, r.cleared], [2, 1]);
  assert.deepEqual(s.pendingRequests(RID, { now: NOW }).map(x => x.guest_name), ['Guest 2']);
  assert.deepEqual(cloud.tables.booking_requests.map(x => x.id), ['c2'], 'last night\'s is cleared, tonight\'s is not');
});

test('if the cloud cannot be read the diary is left as it was and the answer says so plainly', async () => {
  const cloud = cloudWith([row(1)], [], { select: { booking_requests: { message: 'connection to 10.0.0.5 refused' } } });
  const s = store();
  const before = s.stateFor(RID).revision;
  const r = await pullInbox(cloud, RID, s, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CLOUD');
  assert.doesNotMatch(r.error, /10\.0\.0\.5|refused/);
  assert.equal(s.stateFor(RID).revision, before);
});

test('what was collected is on disk, so a restart does not lose a request', async () => {
  const cloud = cloudWith([row(1), row(2)]);
  const s = store();
  await pullInbox(cloud, RID, s, { now: NOW });
  await s.flush();
  const reopened = new ReservationStore(s.file);
  reopened.ensureTenant(RID);
  assert.deepEqual(reopened.pendingRequests(RID, { now: NOW }).map(x => x.guest_name), ['Guest 1', 'Guest 2']);
});

// --- what closes the gaps a mutation pass found ----------------------------------------------------------------------------

test('a page row with no clear yes in it is not on', async () => {
  for (const enabled of [null, undefined, 'true', 1, 'yes']) {
    const cloud = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled }]);
    assert.deepEqual((await readPage(cloud, RID)).page, { code: 'abcdefghij12', enabled: false }, String(enabled));
  }
});

test('switching on a page that is already on asks nothing of the cloud', async () => {
  const cloud = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled: true }]);
  const r = await enablePage(cloud, RID);
  assert.deepEqual(r, { ok: true, page: { code: 'abcdefghij12', enabled: true } });
  assert.equal(cloud.calls.updates.length + cloud.calls.inserts.length, 0);
});

test('switching on a page that was off turns on THAT page in the cloud, and no other restaurant\'s', async () => {
  const cloud = cloudWith([], [
    { restaurant_id: RID, code: 'abcdefghij12', enabled: false },
    { restaurant_id: OTHER, code: 'otherpage123', enabled: false }
  ]);
  const r = await enablePage(cloud, RID);
  assert.deepEqual(r.page, { code: 'abcdefghij12', enabled: true });
  assert.deepEqual(cloud.calls.updates, [{ table: 'booking_pages', patch: { enabled: true }, col: 'restaurant_id', val: RID }]);
  assert.deepEqual(cloud.tables.booking_pages.map(p => [p.restaurant_id, p.enabled]), [[RID, true], [OTHER, false]]);
});

test('switching off a page that is already off, or on, behaves', async () => {
  const off = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled: false }]);
  assert.deepEqual(await disablePage(off, RID), { ok: true, page: { code: 'abcdefghij12', enabled: false } });
  assert.equal(off.calls.updates.length, 0, 'nothing to switch off');

  const on = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled: true }, { restaurant_id: OTHER, code: 'otherpage123', enabled: true }]);
  assert.deepEqual((await disablePage(on, RID)).page, { code: 'abcdefghij12', enabled: false });
  assert.deepEqual(on.calls.updates, [{ table: 'booking_pages', patch: { enabled: false }, col: 'restaurant_id', val: RID }]);
  assert.deepEqual(on.tables.booking_pages.map(p => p.enabled), [false, true]);
});

test('a new address is written to this restaurant\'s page only, and the old code is gone', async () => {
  const cloud = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled: true }, { restaurant_id: OTHER, code: 'otherpage123', enabled: true }]);
  const r = await newAddress(cloud, RID);
  assert.deepEqual(cloud.calls.updates.map(u => [u.col, u.val, Object.keys(u.patch)]), [['restaurant_id', RID, ['code']]]);
  assert.equal(cloud.tables.booking_pages[0].code, r.page.code);
  assert.equal(cloud.tables.booking_pages[1].code, 'otherpage123');
});

test('if another run of the hub made the page between the look and the making, that page is the answer', async () => {
  let reads = 0;
  let inserts = 0;
  const raced = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => (reads++ === 0 ? { data: null, error: null } : { data: { code: 'racedcode123', enabled: true }, error: null }) }) }),
      insert: async () => { inserts += 1; return { error: { code: '23505', message: 'duplicate' } }; }
    })
  };
  assert.deepEqual(await enablePage(raced, RID), { ok: true, page: { code: 'racedcode123', enabled: true } });
  assert.equal(inserts, 1, 'it took the page that was there rather than drawing another code');

  const broken = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => (reads++ % 2 === 0 ? { data: null, error: null } : { data: null, error: { message: 'gone' } }) }) }),
      insert: async () => ({ error: { code: '23505', message: 'duplicate' } })
    })
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    reads = 0;
    const r = await enablePage(broken, RID);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CLOUD', 'and if the second look fails too, that is the answer');
  } finally { console.warn = warn; }
});

test('accepting a request counts the walk-ins already sitting down, like any booking', async () => {
  const s = store();
  const tables = [{ id: 1, name: 'T1', capacity: 4 }, { id: 2, name: 'T2', capacity: 4 }];
  s.setTableProvider(() => tables);
  await pullInbox(cloudWith([row(1, { requested_for: when(1), party_size: 2 })]), RID, s, { now: NOW });
  for (const name of ['A', 'B']) {
    const w = s.addWalkIn(RID, { guest_name: name, party_size: 2 }, { now: NOW });
    s.setWaitlistStatus(RID, w.meta.entry.id, 'seated', { now: NOW });
  }
  const [request] = s.pendingRequests(RID, { now: NOW });
  const full = s.acceptRequest(RID, request.id, { now: NOW });
  assert.equal(full.ok, false);
  assert.equal(full.code, 'FULLY_BOOKED', 'both tables have walk-ins at them');
  assert.equal(s.acceptRequest(RID, request.id, { now: NOW, force: true }).ok, true);
});

test('requests are listed for this restaurant only', async () => {
  const s = store();
  await pullInbox(cloudWith([row(1)]), RID, s, { now: NOW });
  assert.equal(s.pendingRequests(RID, { now: NOW }).length, 1);
  assert.deepEqual(s.pendingRequests('another-restaurant', { now: NOW }), [], 'a hub paired to another restaurant shows none of this one\'s');
});

// --- a few more things the mutation pass found --------------------------------------------------------------------------------

test('a refusal to change the address that is not a clash of codes is not tried again', async () => {
  const cloud = cloudWith([], [{ restaurant_id: RID, code: 'abcdefghij12', enabled: true }], { update: { booking_pages: { message: 'denied', code: '42501' } } });
  const r = await newAddress(cloud, RID);
  assert.equal(r.ok, false);
  assert.equal(cloud.calls.updates.length, 1, 'once, not five times');
});

test('an inbox that comes back as nothing at all is an empty inbox', async () => {
  const empty = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: null }) }) }) }) }) };
  const s = store();
  const r = await pullInbox(empty, RID, s, { now: NOW });
  assert.deepEqual([r.ok, r.received, r.cleared], [true, 0, 0]);
});

test('answered requests older than a week are forgotten as the inbox is collected', async () => {
  const cloud = cloudWith([row(1), row(2)]);
  const s = store();
  await pullInbox(cloud, RID, s, { now: NOW });
  const [one, two] = s.pendingRequests(RID, { now: NOW });
  s.declineRequest(RID, one.id, { now: new Date(NOW.getTime() - 8 * 24 * HOUR) });
  s.declineRequest(RID, two.id, { now: new Date(NOW.getTime() - 1 * 24 * HOUR) });
  assert.equal(s.stateFor(RID).requests.length, 2);
  await pullInbox(cloudWith([]), RID, s, { now: NOW });
  assert.deepEqual(s.stateFor(RID).requests.map(r => r.cloud_id), ['c2'], 'the old one is gone, the recent one is remembered');
});

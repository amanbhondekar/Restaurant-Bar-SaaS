import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { guestContact } from '../lib/guestContact.js';
import { requestMessages } from '../lib/bookingRequests.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// What reception does with guests' requests for a table, and with the page they come from (§4.6), on a real hub. The hub here has no
// cloud (that is what a test hub is), so what is seeded is the state a hub is in AFTER it has collected the inbox: the collecting and
// the cloud are tested in bookingInbox.test.mjs. What is tested here is that staff see what is waiting, soonest first; that accepting
// is a booking through the usual check and nothing more; that nothing is decided twice; and that none of it is for a waiter's handset.

const HOUR = 3600 * 1000;
const soon = hours => new Date(Date.now() + hours * HOUR).toISOString();
const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const TABLES = [{ id: 1, name: 'T1', section: 'M', capacity: 4 }, { id: 2, name: 'T2', section: 'M', capacity: 4 }];
const MENU = { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] };
const fixture = { menu: MENU, tables: { restaurant_id: RESTAURANT_ID, tables: TABLES } };

const request = (n, name, hours, party, over = {}) => {
  const contact = guestContact(`98765 4${String(n).padStart(4, '0')}`, RESTAURANT_ID);
  return { id: `rq_${n}`, cloud_id: `cloud-${n}`, guest_name: name, ...contact, party_size: party, at: soon(hours), created_at: soon(-1), received_at: soon(-0.5), status: 'pending', ...over };
};
const seed = requests => ({ 'reservations.json': { restaurant_id: RESTAURANT_ID, revision: 1, reservations: [], waitlist: [], requests } });

const hubs = [];
const hub = async (options = {}) => { const h = await startHub({ trustLoopback: true, ...fixture, ...options }); hubs.push(h); return h; };
after(() => { for (const h of hubs) h.stop(); });
const json = r => r.json();
const pendingNames = async h => (await json(await call(h, '/admin/booking-requests'))).requests.map(r => r.guest_name);

// --- what is waiting -------------------------------------------------------------------------------------------------------

test('hub: the requests waiting are listed soonest first, with whether the time has gone, whether there is a table, and a way to reach the guest', async () => {
  const h = await hub({ files: seed([
    request(1, 'Asha', 3, 2), request(2, 'Bina', 2, 4), request(3, 'Chitra', -1, 2), request(4, 'Dev', 5, 2, { status: 'accepted', decided_at: soon(-2), reservation_id: 'res_x' }),
    request(5, 'Esha', 6, 12, { note: 'Birthday' })
  ]) });
  const body = await json(await call(h, '/admin/booking-requests'));
  assert.equal(body.success, true);
  assert.deepEqual(body.requests.map(r => r.guest_name), ['Chitra', 'Bina', 'Asha', 'Esha'], 'the soonest first, and not the one already answered');
  const [chitra, bina, , esha] = body.requests;
  assert.deepEqual([chitra.past, bina.past], [true, false]);
  assert.deepEqual([bina.availability.ok, bina.availability.free, bina.availability.fitting], [true, 2, 2]);
  assert.equal(esha.availability.ok, false, 'a party of 12 has no table');
  assert.equal(esha.availability.code, 'NO_TABLE_THAT_SIZE');
  assert.equal(esha.note, 'Birthday');
  assert.match(bina.whatsapp, /^https:\/\/wa\.me\/91\d{10}\?text=/);
  assert.match(bina.tel, /^tel:\+91/);
  assert.match(bina.phone_display, /^\+91/);
  assert.match(decodeURIComponent(bina.whatsapp), new RegExp(`Bina.*${h.name}`), 'the opening words name the guest and the restaurant');
  assert.equal('phone_key' in bina, false, 'the hash that recognises a guest is not sent to the screen');
  assert.equal('cloud_id' in bina, false, 'nor the cloud\'s own number for the request');
  assert.equal(body.checked_at, null, 'no cloud, so never checked');
});

test('hub: asking to check the cloud with no cloud says the check did not work, and a plain look at the list does not check at all', async () => {
  const h = await hub({ files: seed([request(1, 'Asha', 3, 2)]) });
  const plain = await json(await call(h, '/admin/booking-requests'));
  assert.deepEqual([plain.checked_at, plain.inbox_ok], [null, null], 'nothing has been tried');
  const checked = await json(await call(h, '/admin/booking-requests?refresh=1'));
  assert.deepEqual([checked.checked_at, checked.inbox_ok], [null, false], 'it was tried, and did not work, and the screen can say so');
  assert.deepEqual(checked.requests.map(r => r.guest_name), ['Asha'], 'and what the hub already held is still shown');
});

test('hub: an empty list is an empty list', async () => {
  const h = await hub();
  assert.deepEqual((await json(await call(h, '/admin/booking-requests'))).requests, []);
});

// --- accepting -------------------------------------------------------------------------------------------------------------

test('hub: accepting books the table, takes the request off the list, and gives the words to confirm it', async () => {
  const h = await hub({ files: seed([request(1, 'Asha', 3, 2, { note: 'Window' }), request(2, 'Bina', 4, 4)]) });
  const asha = (await json(await call(h, '/admin/booking-requests'))).requests.find(r => r.guest_name === 'Asha');
  const r = await call(h, `/admin/booking-requests/${asha.id}/accept`, { method: 'POST', body: {} });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const body = await json(r);
  assert.equal(body.reservation.guest_name, 'Asha');
  assert.equal(body.reservation.note, 'Window');
  assert.equal(body.request.status, 'accepted');
  assert.match(decodeURIComponent(body.reply_whatsapp), /Asha.*confirmed/i);
  assert.match(body.reply_whatsapp, /^https:\/\/wa\.me\/91/);

  assert.deepEqual(await pendingNames(h), ['Bina']);
  const diary = (await json(await call(h, `/admin/bookings?day=${dayOf(asha.at)}`))).reservations;
  assert.deepEqual(diary.filter(x => x.guest_name === 'Asha').map(x => x.status), ['booked'], 'it is in the diary like any booking');
});

test('hub: an accepted request cannot be accepted or declined again, and a request that is not there is not found', async () => {
  const h = await hub({ files: seed([request(1, 'Asha', 3, 2)]) });
  await call(h, '/admin/booking-requests/rq_1/accept', { method: 'POST', body: {} });
  for (const action of ['accept', 'decline']) {
    const again = await call(h, `/admin/booking-requests/rq_1/${action}`, { method: 'POST', body: {} });
    assert.deepEqual([again.status, (await json(again)).code], [409, 'NOT_PENDING'], action);
  }
  for (const action of ['accept', 'decline']) assert.equal((await call(h, `/admin/booking-requests/rq_nope/${action}`, { method: 'POST', body: {} })).status, 404, action);
  const day = (await json(await call(h, '/admin/bookings'))).reservations;
  assert.ok(day.length <= 1, 'accepting twice did not book twice');
});

test('hub: a request is not forced into a table that is not there unless reception says so, and then it says it was overbooked', async () => {
  const h = await hub({ files: seed([request(1, 'Asha', 3, 2), request(2, 'Bina', 3, 2), request(3, 'Chitra', 3, 2)]) });
  assert.equal((await call(h, '/admin/booking-requests/rq_1/accept', { method: 'POST', body: {} })).status, 201);
  assert.equal((await call(h, '/admin/booking-requests/rq_2/accept', { method: 'POST', body: {} })).status, 201);

  const full = await call(h, '/admin/booking-requests/rq_3/accept', { method: 'POST', body: {} });
  const refusal = await json(full);
  assert.deepEqual([full.status, refusal.code, refusal.availability.free], [409, 'FULLY_BOOKED', 0]);
  assert.deepEqual(await pendingNames(h), ['Chitra'], 'a refused request is still waiting');

  const forced = await call(h, '/admin/booking-requests/rq_3/accept', { method: 'POST', body: { force: true } });
  assert.equal(forced.status, 201);
  assert.equal((await json(forced)).reservation.overbooked, true);
  const notForced = await hub({ files: seed([request(1, 'Asha', 3, 2), request(2, 'Bina', 3, 2), request(3, 'Chitra', 3, 2)]) });
  for (const id of ['rq_1', 'rq_2']) await call(notForced, `/admin/booking-requests/${id}/accept`, { method: 'POST', body: {} });
  const truthy = await call(notForced, '/admin/booking-requests/rq_3/accept', { method: 'POST', body: { force: 'yes' } });
  assert.equal(truthy.status, 409, 'only a plain true counts as saying so');
});

test('hub: a request whose time has passed cannot be accepted, and says why', async () => {
  const h = await hub({ files: seed([request(1, 'Chitra', -1, 2)]) });
  const r = await call(h, '/admin/booking-requests/rq_1/accept', { method: 'POST', body: {} });
  const body = await json(r);
  assert.deepEqual([r.status, body.code], [400, 'INVALID_BOOKING']);
  assert.match(body.error, /passed/);
  assert.deepEqual(await pendingNames(h), ['Chitra']);
});

// --- declining -------------------------------------------------------------------------------------------------------------

test('hub: declining books nothing, takes the request off the list, and gives the words to say so kindly', async () => {
  const h = await hub({ files: seed([request(1, 'Asha', 3, 2), request(2, 'Bina', 3, 2)]) });
  const r = await call(h, '/admin/booking-requests/rq_1/decline', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.equal(body.request.status, 'declined');
  assert.match(decodeURIComponent(body.reply_whatsapp), /Asha.*sorry/i);
  assert.deepEqual(await pendingNames(h), ['Bina']);
  assert.deepEqual((await json(await call(h, '/admin/bookings'))).reservations, []);
});

test('the words staff send are written in one place, and name the guest, the party, the time and the restaurant', () => {
  const r = { guest_name: 'Asha', party_size: 4, at: '2026-11-01T13:30:00.000Z' };
  const words = requestMessages('Mejwani');
  for (const [kind, text] of [['asked', words.asked(r)], ['confirmed', words.confirmed(r)], ['declined', words.declined(r)]]) {
    assert.match(text, /Asha/, kind);
    assert.match(text, /Mejwani/, kind);
    assert.match(text, /4/, kind);
    assert.ok(text.length < 300, `${kind} is a message, not a letter`);
  }
  assert.match(words.confirmed(r), /confirmed/);
  assert.match(words.declined(r), /sorry/i);
});

// --- a waiter's handset ----------------------------------------------------------------------------------------------------

test('hub: a waiter\'s handset can neither see the requests, decide them, nor touch the booking page', async () => {
  const remote = await hub({ trustLoopback: false, enrollmentCode: 'REQREM', files: seed([request(1, 'Asha', 3, 2)]) });
  const token = (await json(await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'REQREM', device_label: 'x' } }))).device_token;
  for (const [method, path, body] of [
    ['GET', '/admin/booking-requests'], ['POST', '/admin/booking-requests/rq_1/accept', {}], ['POST', '/admin/booking-requests/rq_1/decline', {}],
    ['GET', '/admin/booking-page'], ['PUT', '/admin/booking-page', { enabled: true }], ['POST', '/admin/booking-page/new-address', {}]
  ]) {
    const r = await call(remote, path, { method, token, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal((await json(r)).code, 'RECEPTION_ONLY');
  }
});

// --- the page ---------------------------------------------------------------------------------------------------------------

const OPS = 'https://ops.example.com';

test('hub: with no operator service and no page, the screen is told so', async () => {
  const h = await hub();
  const body = await json(await call(h, '/admin/booking-page'));
  assert.deepEqual(
    [body.success, body.configured, body.enabled, body.code, body.url, body.reachable],
    [true, false, false, null, null, false]
  );
  assert.match(body.message, /internet|cloud/i, 'and why it cannot say more');
});

test('hub: a page the hub knew about is shown from memory when the cloud cannot be reached, with its address', async () => {
  const h = await hub({ env: { OPERATOR_SERVICE_URL: OPS }, config: { booking_page: { code: 'abcdefghij12', enabled: true } } });
  const body = await json(await call(h, '/admin/booking-page'));
  assert.deepEqual([body.configured, body.enabled, body.code, body.url, body.reachable], [true, true, 'abcdefghij12', `${OPS}/book/abcdefghij12`, false]);
});

test('hub: with a page but no operator service address there is no link to give, and the screen says what is missing', async () => {
  const h = await hub({ config: { booking_page: { code: 'abcdefghij12', enabled: true } } });
  const body = await json(await call(h, '/admin/booking-page'));
  assert.deepEqual([body.configured, body.url, body.needs_operator_url], [false, null, true]);
});

test('hub: a page cannot be switched on with nowhere to serve it from, and with no cloud every change says so', async () => {
  const bare = await hub();
  const noOps = await call(bare, '/admin/booking-page', { method: 'PUT', body: { enabled: true } });
  assert.deepEqual([noOps.status, (await json(noOps)).code], [409, 'NOT_CONFIGURED']);

  const h = await hub({ env: { OPERATOR_SERVICE_URL: OPS } });
  const off = await call(bare, '/admin/booking-page', { method: 'PUT', body: { enabled: false } });
  assert.deepEqual([off.status, (await json(off)).code], [503, 'CLOUD'], 'switching off needs no operator service, only the internet');
  for (const [method, path, body] of [['PUT', '/admin/booking-page', { enabled: true }], ['PUT', '/admin/booking-page', { enabled: false }], ['POST', '/admin/booking-page/new-address', {}]]) {
    const r = await call(h, path, { method, body });
    const answer = await json(r);
    assert.deepEqual([r.status, answer.code], [503, 'CLOUD'], `${method} ${path} ${JSON.stringify(body)}`);
    assert.match(answer.error, /internet|cloud/i);
  }
});

test('hub: what is not a clear yes or no is refused', async () => {
  const h = await hub({ env: { OPERATOR_SERVICE_URL: OPS } });
  for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }, { enabled: [true] }]) {
    const r = await call(h, '/admin/booking-page', { method: 'PUT', body });
    assert.deepEqual([r.status, (await json(r)).code], [400, 'INVALID'], JSON.stringify(body));
  }
});

test('hub: the inbox is checked by itself, soon after the hub starts and then again and again, with nobody asking', async () => {
  const soonOnly = await hub({ env: { HUB_BOOKING_INBOX_FIRST_MS: '50', HUB_BOOKING_INBOX_MS: '3600000' }, files: seed([]) });
  const repeating = await hub({ env: { HUB_BOOKING_INBOX_FIRST_MS: '3600000', HUB_BOOKING_INBOX_MS: '60' }, files: seed([]) });
  const never = await hub({ env: { HUB_BOOKING_INBOX_FIRST_MS: '3600000', HUB_BOOKING_INBOX_MS: '3600000' }, files: seed([]) });
  const failed = async h => {
    for (let i = 0; i < 60; i += 1) {
      if ((await json(await call(h, '/admin/booking-requests'))).inbox_ok === false) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  assert.equal(await failed(soonOnly), true, 'the first look, shortly after start');
  assert.equal(await failed(repeating), true, 'and the looking that goes on');
  assert.equal(await failed(never), false, 'without either, nothing looks until someone asks');
});

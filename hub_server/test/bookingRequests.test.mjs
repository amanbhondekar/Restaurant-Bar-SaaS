import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, normalizeState, normalizeRequests, book, bookingsOn } from '../lib/reservations.js';
import {
  receiveRequests, pendingRequests, acceptRequest, declineRequest, settleLapsed, pruneDecided, REQUEST_STATUSES
} from '../lib/bookingRequests.js';

// A guest's request for a table, once the hub has collected it (§4.6). The hub owns the diary, so a request is only ever a question:
// accepting it books the table through the same check as any booking, declining it books nothing, and neither is done by itself. What
// is tested is that a request cannot be double-counted, cannot jump the availability check, cannot be decided twice, and cannot
// outlive its usefulness.

const RID = 'rest-1';
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const HOUR = 3600 * 1000;
const when = hours => new Date(NOW.getTime() + hours * HOUR).toISOString();
const TABLES = [{ id: 1, name: 'T1', capacity: 4 }, { id: 2, name: 'T2', capacity: 4 }];
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, 'expected a refusal'); assert.equal(r.code, code, JSON.stringify(r)); return r; };

/** What the cloud holds for a request. */
const cloudRow = (n, over = {}) => ({
  id: `cloud-${n}`, restaurant_id: RID, guest_name: `Guest ${n}`, phone: '919876543210', party_size: 4, requested_for: when(5 + n), note: `Note ${n}`, created_at: when(-1), ...over
});
const withRequests = (rows, base = emptyState(RID)) => ok(receiveRequests(base, rows, { now: NOW })).data;
const first = state => state.requests[0];

// --- receiving -----------------------------------------------------------------------------------------------------------

test('a request from the cloud becomes a pending one, with the number in the same shape as every other guest\'s', () => {
  const r = ok(receiveRequests(emptyState(RID), [cloudRow(1)], { now: NOW }));
  const request = first(r.data);
  assert.equal(request.status, 'pending');
  assert.match(request.id, /^rq_[0-9a-f]{10}$/);
  assert.deepEqual(
    [request.cloud_id, request.guest_name, request.phone, request.party_size, request.at, request.note],
    ['cloud-1', 'Guest 1', '919876543210', 4, when(6), 'Note 1']
  );
  assert.match(request.phone_key, /^[0-9a-f]{64}$/, 'so loyalty recognises them like any other guest');
  assert.equal(request.created_at, when(-1), 'when they asked, not when the hub heard');
  assert.equal(request.received_at, NOW.toISOString());
  assert.equal(r.data.revision, 1);
  assert.deepEqual(r.meta.added.map(a => a.cloud_id), ['cloud-1']);
});

test('the same request collected twice is one request', () => {
  const once = withRequests([cloudRow(1), cloudRow(2)]);
  const twice = ok(receiveRequests(once, [cloudRow(1), cloudRow(2), cloudRow(3)], { now: NOW }));
  assert.deepEqual(twice.data.requests.map(r => r.cloud_id), ['cloud-1', 'cloud-2', 'cloud-3']);
  assert.deepEqual(twice.meta.added.map(a => a.cloud_id), ['cloud-3']);
  const nothing = ok(receiveRequests(twice.data, [cloudRow(1)], { now: NOW }));
  assert.equal(nothing.data, twice.data, 'nothing new: nothing changes, not even the revision');
});

test('a request that was already decided stays decided when the cloud still has it', () => {
  let s = withRequests([cloudRow(1)]);
  s = ok(declineRequest(s, first(s).id, { now: NOW })).data;
  const again = ok(receiveRequests(s, [cloudRow(1)], { now: NOW }));
  assert.equal(again.data, s);
  assert.equal(first(again.data).status, 'declined');
});

test('a request the hub cannot use is not kept, and is named so it can be cleared from the cloud', () => {
  const bad = [
    cloudRow(1, { guest_name: '  ' }), cloudRow(2, { phone: 'nope' }), cloudRow(3, { party_size: 0 }), cloudRow(4, { party_size: 41 }),
    cloudRow(5, { requested_for: 'tomorrow' }), cloudRow(6, { requested_for: null }), cloudRow(7, { id: undefined })
  ];
  const r = ok(receiveRequests(emptyState(RID), [...bad, cloudRow(8)], { now: NOW }));
  assert.deepEqual(r.data.requests.map(x => x.cloud_id), ['cloud-8']);
  assert.deepEqual(r.meta.invalid, ['cloud-1', 'cloud-2', 'cloud-3', 'cloud-4', 'cloud-5', 'cloud-6']);
});

test('anything that is not a list of rows is nothing to collect', () => {
  for (const nothing of [null, undefined, 'rows', {}, 5]) {
    const s = emptyState(RID);
    assert.equal(ok(receiveRequests(s, nothing, { now: NOW })).data, s, String(nothing));
  }
});

test('a request carries no note when the guest left none', () => {
  const s = withRequests([cloudRow(1, { note: null }), cloudRow(2, { note: '' })]);
  for (const r of s.requests) assert.equal('note' in r, false);
});

// --- looking at them -----------------------------------------------------------------------------------------------------

test('the pending ones are listed soonest first, and say when their time has passed', () => {
  const s = withRequests([cloudRow(1, { requested_for: when(30) }), cloudRow(2, { requested_for: when(3) }), cloudRow(3, { requested_for: when(-1) }), cloudRow(4, { requested_for: when(8) })]);
  const list = pendingRequests(s, { now: NOW });
  assert.deepEqual(list.map(r => r.cloud_id), ['cloud-3', 'cloud-2', 'cloud-4', 'cloud-1']);
  assert.deepEqual(list.map(r => r.past), [true, false, false, false]);
});

test('decided requests are not listed as pending', () => {
  let s = withRequests([cloudRow(1), cloudRow(2), cloudRow(3)]);
  s = ok(declineRequest(s, s.requests[0].id, { now: NOW })).data;
  s = ok(acceptRequest(s, s.requests[1].id, { now: NOW, tables: TABLES })).data;
  assert.deepEqual(pendingRequests(s, { now: NOW }).map(r => r.cloud_id), ['cloud-3']);
});

// --- accepting -----------------------------------------------------------------------------------------------------------

test('accepting a request books the table through the usual check, and links the two', () => {
  const s = withRequests([cloudRow(1, { requested_for: when(6), party_size: 3, note: 'Window' })]);
  const r = ok(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES }));
  const booking = r.meta.reservation;
  assert.deepEqual([booking.guest_name, booking.party_size, booking.at, booking.note, booking.status], ['Guest 1', 3, when(6), 'Window', 'booked']);
  assert.equal(booking.phone, '919876543210');
  assert.equal(booking.phone_key, first(s).phone_key, 'the same guest as the request');
  assert.equal(r.data.reservations.length, 1);
  const decided = first(r.data);
  assert.deepEqual([decided.status, decided.decided_at, decided.reservation_id], ['accepted', NOW.toISOString(), booking.id]);
  assert.equal(r.data.revision, s.revision + 1, 'one change to the diary, not two');
  assert.equal(first(s).status, 'pending', 'the state it was accepted from is not changed');
});

test('a request cannot be accepted into a table that is not there, unless the restaurant says it knows', () => {
  let s = withRequests([cloudRow(1, { requested_for: when(6) }), cloudRow(2, { requested_for: when(6), phone: '919811122233' }), cloudRow(3, { requested_for: when(6), phone: '919811122244' })]);
  s = ok(acceptRequest(s, s.requests[0].id, { now: NOW, tables: TABLES })).data;
  s = ok(acceptRequest(s, s.requests[1].id, { now: NOW, tables: TABLES })).data;
  const full = refused(acceptRequest(s, s.requests[2].id, { now: NOW, tables: TABLES }), 'FULLY_BOOKED');
  assert.equal(full.status, 409);
  assert.equal(full.availability.free, 0);
  assert.equal(s.requests[2].status, 'pending', 'a refused request is still waiting');
  assert.equal(s.reservations.length, 2);

  const forced = ok(acceptRequest(s, s.requests[2].id, { now: NOW, tables: TABLES, force: true }));
  assert.equal(forced.meta.reservation.overbooked, true, 'and the booking says it was overbooked');
  assert.equal(first(forced.data).status, 'accepted');
});

test('no table of that size is refused as it is for any booking', () => {
  const s = withRequests([cloudRow(1, { party_size: 12 })]);
  refused(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES }), 'NO_TABLE_THAT_SIZE');
});

test('walk-ins already seated are counted, like any booking', () => {
  const s = withRequests([cloudRow(1, { requested_for: when(1) })]);
  refused(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES, seatedWalkIns: 2 }), 'FULLY_BOOKED');
});

test('a request whose time has passed cannot be accepted, and says why', () => {
  const s = withRequests([cloudRow(1, { requested_for: when(-2) })]);
  const r = refused(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES }), 'INVALID_BOOKING');
  assert.match(r.error, /passed/);
  assert.equal(first(s).status, 'pending');
});

test('a request cannot be decided twice, and one that is not there is not found', () => {
  let s = withRequests([cloudRow(1), cloudRow(2)]);
  const id = s.requests[0].id;
  const accepted = ok(acceptRequest(s, id, { now: NOW, tables: TABLES })).data;
  assert.equal(refused(acceptRequest(accepted, id, { now: NOW, tables: TABLES }), 'NOT_PENDING').status, 409);
  assert.equal(accepted.reservations.length, 1, 'accepting it again did not book it again');
  refused(declineRequest(accepted, id, { now: NOW }), 'NOT_PENDING');

  const declined = ok(declineRequest(s, s.requests[1].id, { now: NOW })).data;
  refused(acceptRequest(declined, s.requests[1].id, { now: NOW, tables: TABLES }), 'NOT_PENDING');
  refused(declineRequest(declined, s.requests[1].id, { now: NOW }), 'NOT_PENDING');

  assert.equal(refused(acceptRequest(s, 'rq_nope', { now: NOW, tables: TABLES }), 'NOT_FOUND').status, 404);
  assert.equal(refused(declineRequest(s, 'rq_nope', { now: NOW }), 'NOT_FOUND').status, 404);
});

// --- declining -----------------------------------------------------------------------------------------------------------

test('declining a request books nothing and records when', () => {
  const s = withRequests([cloudRow(1)]);
  const r = ok(declineRequest(s, first(s).id, { now: NOW }));
  assert.equal(r.data.reservations.length, 0);
  assert.deepEqual([first(r.data).status, first(r.data).decided_at], ['declined', NOW.toISOString()]);
  assert.equal(r.data.revision, s.revision + 1);
  assert.equal(r.meta.request.status, 'declined');
});

// --- letting go ----------------------------------------------------------------------------------------------------------

test('a pending request whose time went a day ago is let go, and a more recent one is not', () => {
  const s = withRequests([cloudRow(1, { requested_for: when(-25) }), cloudRow(2, { requested_for: when(-23) }), cloudRow(3, { requested_for: when(4) })]);
  const r = ok(settleLapsed(s, { now: NOW }));
  assert.deepEqual(r.data.requests.map(x => x.status), ['lapsed', 'pending', 'pending']);
  assert.equal(r.data.requests[0].decided_at, NOW.toISOString());
  assert.deepEqual(r.meta.lapsed.map(x => x.cloud_id), ['cloud-1']);
  assert.equal(ok(settleLapsed(r.data, { now: NOW })).data, r.data, 'nothing more to let go: nothing changes');
});

test('decided requests are forgotten after a week, and pending ones never are', () => {
  let s = withRequests([cloudRow(1), cloudRow(2), cloudRow(3)]);
  s = ok(declineRequest(s, s.requests[0].id, { now: new Date(NOW.getTime() - 8 * 24 * HOUR) })).data;
  s = ok(declineRequest(s, s.requests[1].id, { now: new Date(NOW.getTime() - 6 * 24 * HOUR) })).data;
  const pruned = ok(pruneDecided(s, { now: NOW }));
  assert.deepEqual(pruned.data.requests.map(r => r.cloud_id), ['cloud-2', 'cloud-3']);
  assert.equal(ok(pruneDecided(pruned.data, { now: NOW })).data, pruned.data);
});

// --- keeping them ---------------------------------------------------------------------------------------------------------

test('requests survive being written to disk and read back, and a damaged list is dropped without taking the diary with it', () => {
  const s = withRequests([cloudRow(1), cloudRow(2)]);
  const back = normalizeState(JSON.parse(JSON.stringify(s)), RID);
  assert.deepEqual(back.requests, s.requests);
  for (const damaged of ['text', 5, null, { a: 1 }]) assert.deepEqual(normalizeState({ ...s, requests: damaged }, RID).requests, []);
  const junk = normalizeState({ ...s, requests: [null, 'x', { id: 'rq_1' }, { id: 'rq_2', cloud_id: 'c', guest_name: 'A', status: 'what', party_size: 2 }, s.requests[0]] }, RID);
  assert.deepEqual(junk.requests.map(r => r.id), [s.requests[0].id], 'only whole requests with a known status');
  assert.deepEqual(emptyState(RID).requests, []);
  assert.deepEqual(REQUEST_STATUSES, ['pending', 'accepted', 'declined', 'lapsed']);
});

test('an accepted request is a booking in the diary like any other', () => {
  let s = withRequests([cloudRow(1, { requested_for: when(6) })]);
  s = ok(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES })).data;
  const day = `${new Date(when(6)).getFullYear()}-${String(new Date(when(6)).getMonth() + 1).padStart(2, '0')}-${String(new Date(when(6)).getDate()).padStart(2, '0')}`;
  assert.deepEqual(bookingsOn(s, day).map(r => r.guest_name), ['Guest 1']);
  const direct = ok(book(emptyState(RID), { guest_name: 'Guest 1', phone: '919876543210', party_size: 4, at: when(6) }, { now: NOW, tables: TABLES }));
  assert.equal(s.reservations[0].phone_key, direct.meta.reservation.phone_key);
});

// --- what closes the gaps a mutation pass found ----------------------------------------------------------------------------

test('names and parties are taken up to the diary\'s own limits and no further', () => {
  const edge = [cloudRow(1, { guest_name: 'x'.repeat(80) }), cloudRow(2, { party_size: 40, phone: '919811122233' }), cloudRow(3, { party_size: 1, phone: '919811122244' })];
  const r = ok(receiveRequests(emptyState(RID), edge, { now: NOW }));
  assert.equal(r.data.requests.length, 3);
  assert.deepEqual(r.meta.invalid, []);
  const over = ok(receiveRequests(emptyState(RID), [cloudRow(4, { guest_name: 'x'.repeat(81) })], { now: NOW }));
  assert.deepEqual(over.meta.invalid, ['cloud-4']);
});

test('a party that is not a number is not a request, however it is written', () => {
  const rows = ['many', null, undefined, {}, [], 'NaN'].map((party_size, i) => cloudRow(i + 1, { party_size }));
  const r = ok(receiveRequests(emptyState(RID), rows, { now: NOW }));
  assert.deepEqual(r.data.requests, []);
  assert.equal(r.meta.invalid.length, rows.length);
  const text = ok(receiveRequests(emptyState(RID), [cloudRow(9, { party_size: '4' })], { now: NOW }));
  assert.strictEqual(first(text.data).party_size, 4, 'a number that arrives as text is still a number');
});

test('a note is kept as words, trimmed, and anything else is no note', () => {
  const s = withRequests([cloudRow(1, { note: '  Window  ' }), cloudRow(2, { note: 42 }), cloudRow(3, { note: { a: 1 } }), cloudRow(4, { note: ['x'] })]);
  assert.equal(s.requests[0].note, 'Window');
  for (const r of s.requests.slice(1)) assert.equal('note' in r, false);
});

test('a request that appears twice in one collection is one request', () => {
  const r = ok(receiveRequests(emptyState(RID), [cloudRow(1), cloudRow(1), cloudRow(2)], { now: NOW }));
  assert.deepEqual(r.data.requests.map(x => x.cloud_id), ['cloud-1', 'cloud-2']);
  assert.deepEqual(r.meta.added.map(x => x.cloud_id), ['cloud-1', 'cloud-2']);
});

test('a state with no list of requests at all still works', () => {
  const bare = { restaurant_id: RID, revision: 0, reservations: [], waitlist: [] };
  assert.deepEqual(pendingRequests(bare, { now: NOW }), []);
  const r = ok(receiveRequests(bare, [cloudRow(1)], { now: NOW }));
  assert.equal(r.data.requests.length, 1);
  assert.equal(ok(settleLapsed(bare, { now: NOW })).data, bare);
  assert.equal(ok(pruneDecided(bare, { now: NOW })).data, bare);
  refused(declineRequest(bare, 'rq_1', { now: NOW }), 'NOT_FOUND');
});

test('what refuses a second answer says whose request, and what became of it', () => {
  let s = withRequests([cloudRow(1, { guest_name: 'Asha' })]);
  s = ok(declineRequest(s, first(s).id, { now: NOW })).data;
  assert.equal(refused(acceptRequest(s, first(s).id, { now: NOW, tables: TABLES }), 'NOT_PENDING').error, 'Asha\'s request has already been declined.');
  assert.equal(refused(declineRequest(s, first(s).id, { now: NOW }), 'NOT_PENDING').error, 'Asha\'s request has already been declined.');
  assert.equal(refused(acceptRequest(s, 'rq_nope', { now: NOW, tables: TABLES }), 'NOT_FOUND').error, 'That request is not in the list.');
});

test('a request is let go a day after its time exactly, not before and not after', () => {
  const exactly = withRequests([cloudRow(1, { requested_for: new Date(NOW.getTime() - 24 * HOUR).toISOString() })]);
  assert.equal(ok(settleLapsed(exactly, { now: NOW })).data.requests[0].status, 'pending', 'on the dot it is still a day old, not more');
  const later = ok(settleLapsed(exactly, { now: new Date(NOW.getTime() + 1) }));
  assert.equal(later.data.requests[0].status, 'lapsed');
});

test('a decided request is remembered for exactly a week, and a pending one has no age', () => {
  let s = withRequests([cloudRow(1), cloudRow(2), cloudRow(3)]);
  s = ok(declineRequest(s, s.requests[0].id, { now: new Date(NOW.getTime() - 7 * 24 * HOUR) })).data;
  s = ok(declineRequest(s, s.requests[1].id, { now: new Date(NOW.getTime() - 7 * 24 * HOUR - 1) })).data;
  const pruned = ok(pruneDecided(s, { now: NOW })).data;
  assert.deepEqual(pruned.requests.map(r => r.cloud_id), ['cloud-1', 'cloud-3'], 'a week to the millisecond is kept, a millisecond more is not, and the waiting one is not a candidate');
});

test('the requests on disk are only the whole ones, in a shape the rest of the hub can rely on', () => {
  const whole = { id: 'rq_1', cloud_id: 'c1', guest_name: 'Asha', status: 'pending', party_size: 2 };
  const out = normalizeRequests([
    whole,
    { ...whole, id: 'rq_2', cloud_id: undefined },
    { ...whole, id: 'rq_3', cloud_id: 0 },
    { ...whole, id: 'rq_4', guest_name: '   ' },
    { ...whole, id: 'rq_5', guest_name: undefined },
    { ...whole, id: 'rq_6', status: 'lost' },
    { ...whole, id: 7, cloud_id: 8, party_size: 0 },
    { ...whole, id: 'rq_9', party_size: '3' },
    { ...whole, id: 'rq_10', party_size: 'x' }
  ]);
  assert.deepEqual(out.map(r => [r.id, r.cloud_id, r.party_size]), [['rq_1', 'c1', 2], ['7', '8', 1], ['rq_9', 'c1', 3], ['rq_10', 'c1', 1]]);
  assert.deepEqual(normalizeRequests('nonsense'), []);
});

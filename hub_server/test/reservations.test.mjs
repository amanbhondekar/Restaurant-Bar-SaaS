import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhone, formatPhone, phoneKey, guestContact, whatsappLink, telLink } from '../lib/guestContact.js';
import {
  emptyState, normalizeState, book, availability, setReservationStatus, addWalkIn, setWaitlistStatus,
  bookingsOn, queue, seatedWalkInCount, summarize, DEFAULT_DURATION_MINS
} from '../lib/reservations.js';

// Bookings and the walk-in queue (§4.6). The rules on their own: no disk, no clock -- `now` is passed.

const RID = 'rest-1';
const NOW = new Date(2026, 9, 21, 12, 0, 0);
// LOCAL times, not UTC. "Tonight's bookings" means the restaurant's own day, so bookingsOn takes a
// local date -- and a fixture pinned to UTC lands on the wrong side of midnight anywhere east of
// Greenwich, which is where this product runs.
const at = (h, m = 0) => new Date(2026, 9, 21, h, m).toISOString();
const tomorrowAt = (h, m = 0) => new Date(2026, 9, 22, h, m).toISOString();
const TABLES = [
  { id: 1, name: 'T1', capacity: 2 }, { id: 2, name: 'T2', capacity: 2 },
  { id: 3, name: 'T3', capacity: 4 }, { id: 4, name: 'T4', capacity: 6 }
];

const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, 'expected a refusal'); assert.equal(r.code, code); return r; };
const guest = (over = {}) => ({ guest_name: 'Asha', phone: '98765 43210', party_size: 2, at: at(19), ...over });

// --- a guest's phone number ---------------------------------------------------------------------

test('every way staff type an Indian mobile becomes one number', () => {
  // A loyalty history split across three spellings of the same number is worse than none.
  for (const typed of ['9876543210', '98765 43210', '+91 98765-43210', '09876543210', '+919876543210', ' 98765.43210 ']) {
    assert.equal(normalizePhone(typed), '919876543210', typed);
  }
});

test('a number that cannot be one is refused rather than half-stored', () => {
  for (const bad of ['', '   ', '12345', 'ring the bell', null, undefined, {}, '+1234567']) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
});

test('a number typed in full with a country code is kept as typed', () => {
  assert.equal(normalizePhone('+44 7700 900123'), '447700900123');
  assert.equal(normalizePhone('+1 415 555 2671'), '14155552671');
});

test('a number is shown back in a shape staff can read out to check it', () => {
  assert.equal(formatPhone('919876543210'), '+91 98765 43210');
  assert.equal(formatPhone('447700900123'), '+447700900123');
  assert.equal(formatPhone(null), '');
});

test('the key a guest is matched on cannot be read back, and differs per restaurant', () => {
  const key = phoneKey('919876543210', RID);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.includes('9876543210'), false, 'the number is not in it');
  assert.equal(phoneKey('919876543210', RID), key, 'the same guest matches across visits');
  assert.notEqual(phoneKey('919876543210', 'other-restaurant'), key, 'two tenants cannot be joined on it');
  assert.equal(phoneKey(null, RID), null);
});

test('a guest record carries the number to ring and the key to match on', () => {
  assert.deepEqual(guestContact('98765 43210', RID), { phone: '919876543210', phone_key: phoneKey('919876543210', RID) });
  assert.equal(guestContact('nonsense', RID), null);
});

test('a click-to-chat link opens WhatsApp with the message already typed', () => {
  const link = whatsappLink('919876543210', 'Hi Asha, your table at Hotel Mejwani is ready.');
  assert.match(link, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.ok(link.includes(encodeURIComponent('your table at Hotel Mejwani is ready')));
  assert.equal(whatsappLink('919876543210', ''), 'https://wa.me/919876543210', 'no message is still a link');
  assert.equal(whatsappLink(null, 'hi'), null);
  assert.equal(telLink('919876543210'), 'tel:+919876543210');
});

// --- taking a booking -----------------------------------------------------------------------------

test('a booking needs a name, a number, a party size and a time', () => {
  const s = emptyState(RID);
  const r = book(s, { guest_name: '  ', phone: 'nope', party_size: 0, at: 'whenever' }, { now: NOW, tables: TABLES });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['at', 'guest_name', 'party_size', 'phone']);
});

test('a booking in the past, or absurdly far ahead, is refused', () => {
  const s = emptyState(RID);
  refused(book(s, guest({ at: at(9) }), { now: NOW, tables: TABLES }), 'INVALID_BOOKING');
  const farOff = new Date(NOW.getTime() + 200 * 24 * 60 * 60 * 1000).toISOString();
  refused(book(s, guest({ at: farOff }), { now: NOW, tables: TABLES }), 'INVALID_BOOKING');
  // A booking a few minutes ago is someone typing up a party already arriving, not a mistake.
  assert.equal(book(s, guest({ at: new Date(NOW.getTime() - 2 * 60 * 1000).toISOString() }), { now: NOW, tables: TABLES }).ok, true);
});

test('a booking is taken, with the guest matched the same way everywhere else', () => {
  const r = ok(book(emptyState(RID), guest(), { now: NOW, tables: TABLES }));
  const res = r.meta.reservation;
  assert.equal(res.status, 'booked');
  assert.equal(res.phone, '919876543210');
  assert.equal(res.phone_key, phoneKey('919876543210', RID));
  assert.equal(res.duration_mins, DEFAULT_DURATION_MINS);
  assert.equal(r.data.revision, 1);
});

// --- not selling the same table twice --------------------------------------------------------------

test('a party larger than any table is refused, and told why', () => {
  const r = refused(book(emptyState(RID), guest({ party_size: 8 }), { now: NOW, tables: TABLES }), 'NO_TABLE_THAT_SIZE');
  assert.match(r.error, /No table here seats 8/);
});

test('six people compete for the six-tops, and a couple booked at the same time does not block them', () => {
  let s = emptyState(RID);
  s = ok(book(s, guest({ party_size: 2, at: at(19) }), { now: NOW, tables: TABLES })).data;
  // One 6-top exists and nobody large has it.
  assert.equal(ok(book(s, guest({ guest_name: 'Big party', party_size: 6, at: at(19) }), { now: NOW, tables: TABLES })).ok, true);
});

test('the only table that size, booked twice at once, is refused the second time', () => {
  let s = emptyState(RID);
  s = ok(book(s, guest({ party_size: 6, at: at(19) }), { now: NOW, tables: TABLES })).data;
  const second = refused(book(s, guest({ guest_name: 'Also six', party_size: 6, at: at(19, 30) }), { now: NOW, tables: TABLES }), 'FULLY_BOOKED');
  assert.match(second.error, /already booked then/);
  assert.equal(second.availability.fitting, 1);
});

test('bookings that only touch at the edges do not overlap', () => {
  let s = emptyState(RID);
  s = ok(book(s, guest({ party_size: 6, at: at(18), duration_mins: 60 }), { now: NOW, tables: TABLES })).data;
  // 18:00-19:00 then 19:00 onwards: the table has been given back.
  assert.equal(book(s, guest({ guest_name: 'Later six', party_size: 6, at: at(19) }), { now: NOW, tables: TABLES }).ok, true);
  // ...but one minute earlier overlaps.
  refused(book(s, guest({ guest_name: 'Too soon', party_size: 6, at: at(18, 59) }), { now: NOW, tables: TABLES }), 'FULLY_BOOKED');
});

test('a cancelled or no-show booking gives its table back', () => {
  let s = emptyState(RID);
  const first = ok(book(s, guest({ party_size: 6, at: at(19) }), { now: NOW, tables: TABLES }));
  s = first.data;
  refused(book(s, guest({ guest_name: 'Second', party_size: 6, at: at(19) }), { now: NOW, tables: TABLES }), 'FULLY_BOOKED');

  s = ok(setReservationStatus(s, first.meta.reservation.id, 'cancelled', { now: NOW })).data;
  assert.equal(book(s, guest({ guest_name: 'Second', party_size: 6, at: at(19) }), { now: NOW, tables: TABLES }).ok, true);
});

test('walk-ins sitting down are counted, because that is when a booking becomes an apology', () => {
  const s = emptyState(RID);
  // Two 2-tops, one 4-top, one 6-top. A party of two fits all four.
  assert.equal(availability(s, { at: at(19), party_size: 2, tables: TABLES }).free, 4);
  assert.equal(availability(s, { at: at(19), party_size: 2, tables: TABLES, seatedWalkIns: 4 }).ok, false);
  refused(book(s, guest(), { now: NOW, tables: TABLES, seatedWalkIns: 4 }), 'FULLY_BOOKED');
});

test('a restaurant that knows better can overbook, and the booking says it was', () => {
  let s = emptyState(RID);
  s = ok(book(s, guest({ party_size: 6, at: at(19) }), { now: NOW, tables: TABLES })).data;
  const forced = ok(book(s, guest({ guest_name: 'Squeezed in', party_size: 6, at: at(19) }), { now: NOW, tables: TABLES, force: true }));
  assert.equal(forced.meta.reservation.overbooked, true);
  assert.equal(forced.meta.availability.ok, false, 'and it is on record that there was no room');
});

// --- the life of a booking --------------------------------------------------------------------------

test('a booking is seated, marked a no-show, or called off, and stamps when', () => {
  let s = emptyState(RID);
  const made = ok(book(s, guest(), { now: NOW, tables: TABLES }));
  s = made.data;
  const id = made.meta.reservation.id;

  const seated = ok(setReservationStatus(s, id, 'seated', { now: NOW }));
  assert.equal(seated.meta.reservation.status, 'seated');
  assert.equal(seated.meta.reservation.seated_at, NOW.toISOString());

  refused(setReservationStatus(seated.data, id, 'no_show', { now: NOW }), 'ALREADY_SEATED');
  refused(setReservationStatus(s, 'res_nope', 'seated', { now: NOW }), 'NOT_FOUND');
  refused(setReservationStatus(s, id, 'vanished', { now: NOW }), 'INVALID_STATUS');
});

test('setting the status it already has changes nothing, rather than stamping a second time', () => {
  let s = emptyState(RID);
  const made = ok(book(s, guest(), { now: NOW, tables: TABLES }));
  const once = ok(setReservationStatus(made.data, made.meta.reservation.id, 'seated', { now: NOW }));
  const again = ok(setReservationStatus(once.data, made.meta.reservation.id, 'seated', { now: new Date(2026, 9, 21, 13, 0) }));
  assert.equal(again.data, once.data, 'the same state, not a new revision');
});

// --- the walk-in queue ---------------------------------------------------------------------------------

test('a walk-in needs a name and a party size, and a number is optional', () => {
  const s = emptyState(RID);
  // Plenty of people wait in the doorway without leaving a number, and refusing to queue them would
  // be a worse product than one that cannot message them.
  const noPhone = ok(addWalkIn(s, { guest_name: 'Rahul', party_size: 3 }, { now: NOW }));
  assert.equal(noPhone.meta.entry.phone, undefined);
  assert.equal(noPhone.meta.entry.status, 'waiting');

  const withPhone = ok(addWalkIn(s, { guest_name: 'Sara', party_size: 2, phone: '98765 43210', quoted_wait_mins: 20 }, { now: NOW }));
  assert.equal(withPhone.meta.entry.phone, '919876543210');
  assert.equal(withPhone.meta.entry.quoted_wait_mins, 20);

  const bad = addWalkIn(s, { guest_name: '', party_size: 0 }, { now: NOW });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.field).sort(), ['guest_name', 'party_size']);
});

test('a party cannot be marked notified when there is nobody to message', () => {
  let s = emptyState(RID);
  const added = ok(addWalkIn(s, { guest_name: 'Rahul', party_size: 3 }, { now: NOW }));
  const r = refused(setWaitlistStatus(added.data, added.meta.entry.id, 'notified', { now: NOW }), 'NO_PHONE');
  assert.match(r.error, /did not leave a number/);
  assert.equal(setWaitlistStatus(added.data, added.meta.entry.id, 'seated', { now: NOW }).ok, true, 'but they can still be seated');
});

test('the queue is longest wait first, and drops people once they sit or leave', () => {
  let s = emptyState(RID);
  s = ok(addWalkIn(s, { guest_name: 'First', party_size: 2 }, { now: new Date(2026, 9, 21, 12, 0) })).data;
  s = ok(addWalkIn(s, { guest_name: 'Second', party_size: 2 }, { now: new Date(2026, 9, 21, 12, 10) })).data;
  assert.deepEqual(queue(s).map(e => e.guest_name), ['First', 'Second']);

  const first = s.waitlist[0].id;
  s = ok(setWaitlistStatus(s, first, 'seated', { now: NOW })).data;
  assert.deepEqual(queue(s).map(e => e.guest_name), ['Second']);
  assert.equal(seatedWalkInCount(s, { now: NOW }), 1);
});

test('a walk-in seated hours ago no longer holds a table against tonight\'s bookings', () => {
  let s = emptyState(RID);
  const added = ok(addWalkIn(s, { guest_name: 'Lunch', party_size: 2 }, { now: new Date(2026, 9, 21, 8, 0) }));
  s = ok(setWaitlistStatus(added.data, added.meta.entry.id, 'seated', { now: new Date(2026, 9, 21, 8, 5) })).data;
  assert.equal(seatedWalkInCount(s, { now: NOW }), 0, 'they ate and left hours ago');
});

// --- reading ------------------------------------------------------------------------------------------

test('a day shows its own bookings, earliest first', () => {
  let s = emptyState(RID);
  s = ok(book(s, guest({ guest_name: 'Late', at: at(21) }), { now: NOW, tables: TABLES })).data;
  s = ok(book(s, guest({ guest_name: 'Early', at: at(18) }), { now: NOW, tables: TABLES })).data;
  s = ok(book(s, guest({ guest_name: 'Tomorrow', at: tomorrowAt(19) }), { now: NOW, tables: TABLES })).data;

  const day = bookingsOn(s, '2026-10-21');
  assert.deepEqual(day.map(r => r.guest_name), ['Early', 'Late']);
  assert.deepEqual(bookingsOn(s, 'not-a-day'), []);
});

test('the header counts what reception needs at a glance', () => {
  let s = emptyState(RID);
  const made = ok(book(s, guest({ party_size: 4, at: at(19) }), { now: NOW, tables: TABLES }));
  s = ok(book(made.data, guest({ guest_name: 'Two', party_size: 2, at: at(20) }), { now: NOW, tables: TABLES })).data;
  s = ok(setReservationStatus(s, made.meta.reservation.id, 'seated', { now: NOW })).data;
  s = ok(addWalkIn(s, { guest_name: 'Waiting', party_size: 2 }, { now: NOW })).data;

  assert.deepEqual(summarize(s, '2026-10-21', { now: NOW }), { booked: 1, seated: 1, no_show: 0, covers: 6, waiting: 1, seated_walk_ins: 0 });
});

// --- state from disk ------------------------------------------------------------------------------------

test('a state read from disk drops what is unusable and keeps the rest', () => {
  const damaged = {
    restaurant_id: RID, revision: -3,
    reservations: [
      { id: 'res_1', guest_name: 'Good', party_size: 2, at: at(19), status: 'booked' },
      { id: 'res_2', guest_name: '', party_size: 2, status: 'booked' },
      { id: 'res_3', guest_name: 'Odd status', party_size: 2, status: 'vanished' },
      null
    ],
    waitlist: [{ id: 'wl_1', guest_name: 'Queued', party_size: '3', status: 'waiting' }]
  };
  const s = normalizeState(damaged, RID);
  assert.deepEqual(s.reservations.map(r => r.guest_name), ['Good']);
  assert.equal(s.waitlist[0].party_size, 3, 'a party size that arrived as text is a number');
  assert.equal(s.revision, 0, 'a nonsense revision resets rather than propagating');
  assert.deepEqual(normalizeState(null, RID), emptyState(RID));
  assert.deepEqual(normalizeState('garbage', RID), emptyState(RID));
});

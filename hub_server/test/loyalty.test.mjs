import test from 'node:test';
import assert from 'node:assert/strict';

import { guestsFrom, guestByPhone, recognise, regulars } from '../lib/loyalty.js';
import { phoneKey } from '../lib/guestContact.js';

// Recognising a guest who has been here before (§4.5). Built from the booking diary, so there is one
// source of truth and nothing to keep in step.

const RID = 'rest-1';
const NOW = new Date('2026-10-21T20:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const KEY_A = phoneKey('919876543210', RID);
const KEY_B = phoneKey('919876511111', RID);

const booking = (over = {}) => ({
  id: `res_${Math.random().toString(36).slice(2, 7)}`,
  guest_name: 'Asha', phone: '919876543210', phone_key: KEY_A,
  party_size: 2, at: daysAgo(10), status: 'seated', seated_at: daysAgo(10), created_at: daysAgo(11), ...over
});
const walkIn = (over = {}) => ({
  id: `wl_${Math.random().toString(36).slice(2, 7)}`,
  guest_name: 'Asha', phone: '919876543210', phone_key: KEY_A,
  party_size: 2, status: 'seated', seated_at: daysAgo(3), created_at: daysAgo(3), ...over
});
const state = (reservations = [], waitlist = []) => ({ restaurant_id: RID, reservations, waitlist });

// --- what counts as a visit ----------------------------------------------------------------------

test('a visit is someone who actually sat down', () => {
  const s = state([
    booking({ seated_at: daysAgo(10) }),
    booking({ status: 'no_show', seated_at: null, no_show_at: daysAgo(5) }),
    booking({ status: 'cancelled', seated_at: null }),
    booking({ status: 'booked', seated_at: null, at: daysAgo(-1) })
  ], [
    walkIn({ seated_at: daysAgo(3) }),
    walkIn({ status: 'left', seated_at: null }),
    walkIn({ status: 'waiting', seated_at: null })
  ]);
  const [asha] = guestsFrom(s, { now: NOW });
  assert.equal(asha.visits, 2, 'one booking and one walk-in; nobody who failed to turn up or gave up waiting');
  assert.equal(asha.covers, 4);
});

test('a guest with no number cannot be recognised, and is left out rather than lumped together', () => {
  const s = state([booking({ phone_key: null, phone: null }), booking({ phone_key: null, phone: null })]);
  assert.deepEqual(guestsFrom(s, { now: NOW }), [], 'two anonymous parties are not one regular');
});

test('bookings and walk-ins by the same number are the same person', () => {
  const s = state([booking({ seated_at: daysAgo(20) })], [walkIn({ seated_at: daysAgo(2) })]);
  const guests = guestsFrom(s, { now: NOW });
  assert.equal(guests.length, 1);
  assert.equal(guests[0].visits, 2);
  assert.equal(guests[0].first_visit, daysAgo(20));
  assert.equal(guests[0].last_visit, daysAgo(2));
  assert.equal(guests[0].days_since, 2);
});

test('the name comes from the most recent visit, because people correct it', () => {
  const s = state([
    booking({ guest_name: 'Asha', seated_at: daysAgo(30) }),
    booking({ guest_name: 'Asha Deshmukh', seated_at: daysAgo(1) })
  ]);
  assert.equal(guestsFrom(s, { now: NOW })[0].guest_name, 'Asha Deshmukh');
});

test('two guests are two guests, newest visit first', () => {
  const s = state([
    booking({ guest_name: 'Asha', phone_key: KEY_A, seated_at: daysAgo(9) }),
    booking({ guest_name: 'Rahul', phone: '919876511111', phone_key: KEY_B, seated_at: daysAgo(2) })
  ]);
  assert.deepEqual(guestsFrom(s, { now: NOW }).map(g => g.guest_name), ['Rahul', 'Asha']);
});

test('nothing at all is an empty list, not a crash', () => {
  assert.deepEqual(guestsFrom(undefined, { now: NOW }), []);
  assert.deepEqual(guestsFrom(state(), { now: NOW }), []);
  assert.deepEqual(guestsFrom({ reservations: 'nope', waitlist: null }, { now: NOW }), []);
});

// --- looking a guest up ------------------------------------------------------------------------------

test('a guest is found by their number, however it was typed when they booked', () => {
  const s = state([booking(), booking({ seated_at: daysAgo(4) })]);
  const found = guestByPhone(s, '919876543210', RID, { now: NOW });
  assert.equal(found.visits, 2);
  assert.equal(found.guest_name, 'Asha');
});

test('a number nobody here has used, and nonsense, both come back as nobody', () => {
  const s = state([booking()]);
  assert.equal(guestByPhone(s, '919999999999', RID, { now: NOW }), null);
  assert.equal(guestByPhone(s, 'not a number', RID, { now: NOW }), null);
  assert.equal(guestByPhone(s, null, RID, { now: NOW }), null);
});

test('the same number at another restaurant is a different person here', () => {
  // The key is salted with the restaurant id, so one tenant's guest list cannot be joined to another's.
  const s = state([booking()]);
  assert.equal(guestByPhone(s, '919876543210', 'some-other-restaurant', { now: NOW }), null);
});

// --- what a host is told --------------------------------------------------------------------------------

test('a first visit says nothing: "1 visit" on every new booking is noise', () => {
  assert.equal(recognise({ visits: 1, days_since: 0 }), null);
  assert.equal(recognise(null), null);
  assert.equal(recognise(undefined), null);
});

test('a returning guest is announced, with how long it has been', () => {
  assert.equal(recognise({ visits: 2, days_since: 0 }).line, '2nd visit, last earlier today');
  assert.equal(recognise({ visits: 3, days_since: 1 }).line, '3rd visit, last yesterday');
  assert.equal(recognise({ visits: 4, days_since: 9 }).line, '4th visit, last 9 days ago');
  assert.equal(recognise({ visits: 5, days_since: 21 }).line, '5th visit, last 3 weeks ago');
  assert.equal(recognise({ visits: 9, days_since: 95 }).line, '9th visit, last 3 months ago');
});

test('the ordinal is right where English is awkward about it', () => {
  assert.match(recognise({ visits: 11, days_since: 1 }).line, /^11th/);
  assert.match(recognise({ visits: 12, days_since: 1 }).line, /^12th/);
  assert.match(recognise({ visits: 13, days_since: 1 }).line, /^13th/);
  assert.match(recognise({ visits: 21, days_since: 1 }).line, /^21st/);
  assert.match(recognise({ visits: 22, days_since: 1 }).line, /^22nd/);
  assert.match(recognise({ visits: 23, days_since: 1 }).line, /^23rd/);
  assert.match(recognise({ visits: 101, days_since: 1 }).line, /^101st/);
});

// --- the regulars -------------------------------------------------------------------------------------

test('the regulars are those who came back, most visits first', () => {
  const s = state([
    booking({ guest_name: 'Asha', phone_key: KEY_A, seated_at: daysAgo(9) }),
    booking({ guest_name: 'Asha', phone_key: KEY_A, seated_at: daysAgo(5) }),
    booking({ guest_name: 'Asha', phone_key: KEY_A, seated_at: daysAgo(1) }),
    booking({ guest_name: 'Rahul', phone: '919876511111', phone_key: KEY_B, seated_at: daysAgo(2) })
  ]);
  const list = regulars(s, { now: NOW });
  assert.deepEqual(list.map(g => [g.guest_name, g.visits]), [['Asha', 3]], 'Rahul came once, so he is not a regular yet');
  assert.equal(regulars(s, { now: NOW, minVisits: 1 }).length, 2);
  assert.equal(regulars(s, { now: NOW, limit: 1 }).length, 1);
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emptyState, book, addWalkIn, setReservationStatus, setWaitlistStatus, markReminded, giveReward, updateBooking, updateWalkIn
} from '../lib/reservations.js';
import { ReservationStore } from '../lib/reservationStore.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Changing a booking, or someone waiting in the queue (§4.6). Until now the only way to move a booking was to cancel it and take it again,
// which loses its history (the reminder that was sent, the reward that was given) and asks the guest to be a second booking. The rule that
// matters: a change that could cost a table is checked exactly as taking the booking was, a change that cannot (a note, a name) never is,
// and a guest who is late is not refused for being late.

const RID = 'rest-1';
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const HOUR = 3600 * 1000;
const when = hours => new Date(NOW.getTime() + hours * HOUR).toISOString();
const TABLES = [{ id: 1, name: 'T1', capacity: 4 }, { id: 2, name: 'T2', capacity: 4 }];
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, 'expected a refusal'); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const opts = (extra = {}) => ({ now: NOW, tables: TABLES, ...extra });

function diary(...given) {
  const bookings = given.length ? given : [{}];
  let s = emptyState(RID);
  const made = [];
  for (const b of bookings) {
    const r = ok(book(s, { guest_name: 'Asha', phone: '98765 43210', party_size: 2, at: when(5), ...b }, { now: new Date(NOW.getTime() - 24 * HOUR), tables: TABLES, force: true }));
    s = r.data;
    made.push(r.meta.reservation);
  }
  return { s, made };
}
const get = (s, id) => s.reservations.find(r => r.id === id);

// --- a booking ----------------------------------------------------------------------------------------------------------

test('a name, a note or a number can be changed with no question asked about tables, even on an overbooked evening', () => {
  const { s, made } = diary({ at: when(5) }, { at: when(5), phone: '98111 22233' }, { at: when(5), phone: '98111 22244' });
  assert.equal(get(s, made[2].id).overbooked, true, 'the third was overbooked');
  const r = ok(updateBooking(s, made[2].id, { guest_name: 'Asha Rao', note: 'Birthday' }, opts()));
  const changed = get(r.data, made[2].id);
  assert.deepEqual([changed.guest_name, changed.note, changed.overbooked], ['Asha Rao', 'Birthday', true], 'still overbooked, and not refused for it');
  assert.equal(r.data.revision, s.revision + 1);
  assert.equal(r.meta.reservation.id, made[2].id);
  assert.equal(get(s, made[2].id).note, undefined, 'the state it was changed from is not touched');
});

test('a guest who is late can still have their booking changed: only a time that is being moved has to be in the future', () => {
  const { s, made } = diary({ at: when(-0.1) });
  const r = ok(updateBooking(s, made[0].id, { note: 'Running late, holding the table' }, opts()));
  assert.equal(get(r.data, made[0].id).note, 'Running late, holding the table');
  assert.equal(get(r.data, made[0].id).at, made[0].at);
});

test('a booking changed to what it already is changes nothing, not even the revision', () => {
  const { s, made } = diary({ note: 'Window' });
  const r = ok(updateBooking(s, made[0].id, { guest_name: 'Asha', party_size: 2, note: 'Window', at: made[0].at, phone: '98765 43210' }, opts()));
  assert.equal(r.data, s);
  assert.equal(r.meta.unchanged, true);
  assert.equal(ok(updateBooking(s, made[0].id, {}, opts())).data, s);
});

test('a bigger party is checked against the tables, and refused if none that size is free, unless the restaurant says it knows', () => {
  const { s, made } = diary({ at: when(5), party_size: 2 }, { at: when(5), party_size: 4, phone: '98111 22233' }, { at: when(5), party_size: 4, phone: '98111 22244' });
  const noTable = refused(updateBooking(s, made[0].id, { party_size: 6 }, opts()), 'NO_TABLE_THAT_SIZE');
  assert.equal(noTable.status, 409);
  const full = refused(updateBooking(s, made[0].id, { party_size: 4 }, opts()), 'FULLY_BOOKED');
  assert.equal(full.availability.free, 0);
  assert.equal(get(s, made[0].id).party_size, 2, 'a refused change changes nothing');

  const forced = ok(updateBooking(s, made[0].id, { party_size: 4 }, opts({ force: true })));
  assert.deepEqual([get(forced.data, made[0].id).party_size, get(forced.data, made[0].id).overbooked], [4, true]);
});

test('a smaller party is no trouble, and a booking is not counted against itself', () => {
  const { s, made } = diary({ at: when(5), party_size: 4 }, { at: when(5), party_size: 4, phone: '98111 22233' });
  const smaller = ok(updateBooking(s, made[0].id, { party_size: 2 }, opts()));
  assert.equal(get(smaller.data, made[0].id).party_size, 2);
  const same = ok(updateBooking(s, made[1].id, { at: when(5.5) }, opts()));
  assert.equal(get(same.data, made[1].id).at, when(5.5), 'moving half an hour does not clash with its own old slot');
});

test('moving a booking to a time with no table is refused, and to a free time is done', () => {
  const { s, made } = diary({ at: when(5) }, { at: when(8), phone: '98111 22233' }, { at: when(8), phone: '98111 22244' });
  const taken = refused(updateBooking(s, made[0].id, { at: when(8) }, opts()), 'FULLY_BOOKED');
  assert.equal(taken.availability.free, 0);
  const moved = ok(updateBooking(s, made[0].id, { at: when(20) }, opts()));
  assert.equal(get(moved.data, made[0].id).at, when(20));
});

test('a time that is moved has to be a real, future, not-too-far time', () => {
  const { s, made } = diary();
  assert.match(refused(updateBooking(s, made[0].id, { at: when(-2) }, opts()), 'INVALID_BOOKING').error, /passed/);
  refused(updateBooking(s, made[0].id, { at: 'tomorrow' }, opts()), 'INVALID_BOOKING');
  refused(updateBooking(s, made[0].id, { at: when(24 * 181) }, opts()), 'INVALID_BOOKING');
  assert.equal(ok(updateBooking(s, made[0].id, { at: when(24 * 179) }, opts())).meta.reservation.at, when(24 * 179));
});

test('moving a booking forgets that a reminder was sent for the old time, and keeps everything else about it', () => {
  let { s, made } = diary({ at: when(5) });
  s = ok(markReminded(s, made[0].id, { by: 'Asha', now: NOW })).data;
  assert.ok(get(s, made[0].id).reminded_at);
  const note = ok(updateBooking(s, made[0].id, { note: 'x' }, opts()));
  assert.ok(get(note.data, made[0].id).reminded_at, 'a note does not make the reminder wrong');

  const moved = get(ok(updateBooking(s, made[0].id, { at: when(9) }, opts())).data, made[0].id);
  assert.equal('reminded_at' in moved, false);
  assert.equal('reminded_by' in moved, false);
  assert.deepEqual([moved.id, moved.status, moved.created_at, moved.phone_key], [made[0].id, 'booked', made[0].created_at, made[0].phone_key]);
});

test('a booking that was overbooked and is moved to a free time is no longer overbooked', () => {
  const { s, made } = diary({ at: when(5) }, { at: when(5), phone: '98111 22233' }, { at: when(5), phone: '98111 22244' });
  assert.equal(get(s, made[2].id).overbooked, true);
  const moved = get(ok(updateBooking(s, made[2].id, { at: when(30) }, opts())).data, made[2].id);
  assert.equal('overbooked' in moved, false);
});

test('a reward already given stays given when the booking is changed', () => {
  const scheme = { enabled: true, every_n_visits: 2, text: 'a lassi' };
  let { s, made } = diary({ at: when(5) });
  const seated = ok(book(s, { guest_name: 'Asha', phone: '98765 43210', party_size: 2, at: when(-30) }, { now: new Date(NOW.getTime() - 48 * HOUR), tables: TABLES, force: true }));
  s = ok(setReservationStatus(seated.data, seated.meta.reservation.id, 'seated', { now: NOW })).data;
  s = ok(giveReward(s, made[0].id, scheme, { now: NOW })).data;
  const moved = get(ok(updateBooking(s, made[0].id, { at: when(9), note: 'moved' }, opts())).data, made[0].id);
  assert.deepEqual([moved.reward_given_text, moved.reward_visit], ['a lassi', 2]);
});

test('a new number is stored as every number is, and recognises the guest by it', () => {
  const { s, made } = diary();
  const r = get(ok(updateBooking(s, made[0].id, { phone: '+91 98111-22233' }, opts())).data, made[0].id);
  assert.equal(r.phone, '919811122233');
  assert.notEqual(r.phone_key, made[0].phone_key);
  const direct = ok(book(emptyState(RID), { guest_name: 'x', phone: '98111 22233', party_size: 2, at: when(5) }, opts()));
  assert.equal(r.phone_key, direct.meta.reservation.phone_key);
});

test('what is wrong is said by field, as it is when taking a booking, and nothing is changed', () => {
  const { s, made } = diary();
  for (const [patch, field] of [
    [{ guest_name: '  ' }, 'guest_name'], [{ guest_name: 'x'.repeat(81) }, 'guest_name'], [{ phone: 'nope' }, 'phone'], [{ phone: '' }, 'phone'],
    [{ party_size: 0 }, 'party_size'], [{ party_size: 41 }, 'party_size'], [{ party_size: 'many' }, 'party_size'],
    [{ duration_mins: 5 }, 'duration_mins'], [{ duration_mins: 9999 }, 'duration_mins'], [{ note: 'x'.repeat(201) }, 'note']
  ]) {
    const r = refused(updateBooking(s, made[0].id, patch, opts()), 'INVALID_BOOKING');
    assert.equal(r.status, 400);
    assert.equal(r.errors[0].field, field, JSON.stringify(patch));
  }
});

test('a note can be cleared, and a duration changed (and checked)', () => {
  const { s, made } = diary({ note: 'Window' });
  const cleared = get(ok(updateBooking(s, made[0].id, { note: '' }, opts())).data, made[0].id);
  assert.equal('note' in cleared, false);
  const longer = get(ok(updateBooking(s, made[0].id, { duration_mins: 150 }, opts())).data, made[0].id);
  assert.equal(longer.duration_mins, 150);
  const busy = diary({ at: when(5) }, { at: when(6), phone: '98111 22233' }, { at: when(6.5), phone: '98111 22244' });
  refused(updateBooking(busy.s, busy.made[0].id, { duration_mins: 180 }, opts()), 'FULLY_BOOKED');
});

test('only what a person may change is changed: not the status, the id, the times it was made or seated, or the reward', () => {
  const { s, made } = diary();
  const r = get(ok(updateBooking(s, made[0].id, {
    note: 'ok', status: 'seated', id: 'res_forged', created_at: '2000-01-01T00:00:00Z', seated_at: when(1), reward_given_at: when(1), reward_given_text: 'x', phone_key: 'forged', overbooked: true, reminded_at: when(1)
  }, opts())).data, made[0].id);
  assert.deepEqual([r.status, r.id, r.created_at, r.seated_at, r.reward_given_at, r.phone_key, r.overbooked, r.reminded_at], ['booked', made[0].id, made[0].created_at, undefined, undefined, made[0].phone_key, undefined, undefined]);
  assert.equal(r.note, 'ok');
});

test('a booking that is not still to come cannot be changed, and one that is not there is not found', () => {
  let { s, made } = diary({ at: when(5) }, { at: when(6), phone: '98111 22233' }, { at: when(7), phone: '98111 22244' });
  s = ok(setReservationStatus(s, made[0].id, 'seated', { now: NOW })).data;
  s = ok(setReservationStatus(s, made[1].id, 'cancelled', { now: NOW })).data;
  s = ok(setReservationStatus(s, made[2].id, 'no_show', { now: NOW })).data;
  for (const m of made) {
    const r = refused(updateBooking(s, m.id, { note: 'x' }, opts()), 'NOT_BOOKED');
    assert.equal(r.status, 409);
  }
  assert.equal(refused(updateBooking(s, 'res_nope', { note: 'x' }, opts()), 'NOT_FOUND').status, 404);
});

test('a change tolerates a patch that is not an object', () => {
  const { s, made } = diary();
  for (const patch of [null, undefined, 'note', 5, []]) assert.equal(ok(updateBooking(s, made[0].id, patch, opts())).data, s, String(patch));
});

// --- someone in the queue -----------------------------------------------------------------------------------------------

function queue(...entries) {
  let s = emptyState(RID);
  const made = [];
  for (const e of entries) {
    const r = ok(addWalkIn(s, { guest_name: 'Rahul', party_size: 3, quoted_wait_mins: 20, phone: '98765 11111', ...e }, { now: NOW }));
    s = r.data;
    made.push(r.meta.entry);
  }
  return { s, made };
}
const entry = (s, id) => s.waitlist.find(e => e.id === id);

test('a party in the queue can be given a new wait, a bigger party, another name or a note', () => {
  const { s, made } = queue({});
  const r = ok(updateWalkIn(s, made[0].id, { quoted_wait_mins: 35, party_size: 5, guest_name: 'Rahul K', note: 'High chair' }, { now: NOW }));
  const e = entry(r.data, made[0].id);
  assert.deepEqual([e.quoted_wait_mins, e.party_size, e.guest_name, e.note, e.status, e.created_at], [35, 5, 'Rahul K', 'High chair', 'waiting', made[0].created_at], 'and keeps their place: when they joined is unchanged');
  assert.equal(r.data.revision, s.revision + 1);
  assert.equal(entry(s, made[0].id).quoted_wait_mins, 20, 'the state it was changed from is not touched');
});

test('a quoted wait can be taken back, and a number added later is stored like any other', () => {
  const { s, made } = queue({ phone: undefined });
  assert.equal('phone' in entry(s, made[0].id), false);
  const added = entry(ok(updateWalkIn(s, made[0].id, { phone: '98765 22222' }, { now: NOW })).data, made[0].id);
  assert.equal(added.phone, '919876522222');
  assert.match(added.phone_key, /^[0-9a-f]{64}$/);
  const none = entry(ok(updateWalkIn(s, made[0].id, { quoted_wait_mins: null }, { now: NOW })).data, made[0].id);
  assert.equal('quoted_wait_mins' in none, false);
  assert.equal('quoted_wait_mins' in entry(ok(updateWalkIn(s, made[0].id, { quoted_wait_mins: '' }, { now: NOW })).data, made[0].id), false);
});

test('a number can be taken off someone who has not been messaged, and not off someone who has', () => {
  let { s, made } = queue({});
  const cleared = entry(ok(updateWalkIn(s, made[0].id, { phone: '' }, { now: NOW })).data, made[0].id);
  assert.equal('phone' in cleared, false);
  assert.equal('phone_key' in cleared, false);

  s = ok(setWaitlistStatus(s, made[0].id, 'notified', { now: NOW })).data;
  const r = refused(updateWalkIn(s, made[0].id, { phone: '' }, { now: NOW }), 'HAS_BEEN_MESSAGED');
  assert.equal(r.status, 409);
  assert.equal(entry(ok(updateWalkIn(s, made[0].id, { quoted_wait_mins: 45 }, { now: NOW })).data, made[0].id).quoted_wait_mins, 45, 'but their wait can still change');
});

test('a queue change that is wrong is said by field and changes nothing', () => {
  const { s, made } = queue({});
  for (const [patch, field] of [[{ guest_name: ' ' }, 'guest_name'], [{ party_size: 0 }, 'party_size'], [{ party_size: 41 }, 'party_size'], [{ quoted_wait_mins: -1 }, 'quoted_wait_mins'], [{ quoted_wait_mins: 601 }, 'quoted_wait_mins'], [{ phone: 'nope' }, 'phone'], [{ note: 'x'.repeat(201) }, 'note']]) {
    const r = refused(updateWalkIn(s, made[0].id, patch, { now: NOW }), 'INVALID_WALK_IN');
    assert.equal(r.status, 400);
    assert.equal(r.errors[0].field, field, JSON.stringify(patch));
  }
});

test('only someone still in the queue can be changed; one who has gone is not found; nothing but what a person may change is', () => {
  let { s, made } = queue({}, { guest_name: 'B', phone: '98765 33333' });
  s = ok(setWaitlistStatus(s, made[0].id, 'seated', { now: NOW })).data;
  s = ok(setWaitlistStatus(s, made[1].id, 'left', { now: NOW })).data;
  for (const m of made) assert.deepEqual([refused(updateWalkIn(s, m.id, { note: 'x' }, { now: NOW }), 'NOT_WAITING').status], [409]);
  assert.equal(refused(updateWalkIn(s, 'wl_nope', { note: 'x' }, { now: NOW }), 'NOT_FOUND').status, 404);

  const fresh = queue({});
  const e = entry(ok(updateWalkIn(fresh.s, fresh.made[0].id, { note: 'ok', status: 'seated', id: 'wl_forged', created_at: '2000-01-01T00:00:00Z', reward_given_at: when(1) }, { now: NOW })).data, fresh.made[0].id);
  assert.deepEqual([e.status, e.id, e.created_at, e.reward_given_at, e.note], ['waiting', fresh.made[0].id, fresh.made[0].created_at, undefined, 'ok']);
  assert.equal(ok(updateWalkIn(fresh.s, fresh.made[0].id, {}, { now: NOW })).data, fresh.s);
  assert.equal(ok(updateWalkIn(fresh.s, fresh.made[0].id, { quoted_wait_mins: 20, party_size: 3 }, { now: NOW })).data, fresh.s, 'the same again is nothing');
});

// --- what closes the gaps a mutation pass finds -----------------------------------------------------------------------------

test('the same moment written another way is not a move: a late guest is still not refused for it', () => {
  const { s, made } = diary({ at: when(-0.1) });
  const sameMoment = new Date(made[0].at).toISOString().replace('Z', '+00:00');
  const r = ok(updateBooking(s, made[0].id, { at: sameMoment, note: 'x' }, opts()));
  assert.equal(get(r.data, made[0].id).at, made[0].at, 'stored as it was');
  assert.equal(ok(updateBooking(s, made[0].id, { at: sameMoment }, opts())).data, s, 'and the same moment on its own is nothing');
});

test('a change records when it was made', () => {
  const { s, made } = diary();
  assert.equal(get(ok(updateBooking(s, made[0].id, { note: 'x' }, opts())).data, made[0].id).updated_at, NOW.toISOString());
  const q = queue({});
  assert.equal(entry(ok(updateWalkIn(q.s, q.made[0].id, { note: 'x' }, { now: NOW })).data, q.made[0].id).updated_at, NOW.toISOString());
});

test('what is free is handed back with a change that could have cost a table, and not with one that could not', () => {
  const { s, made } = diary({ party_size: 2 });
  assert.equal(ok(updateBooking(s, made[0].id, { party_size: 3 }, opts())).meta.availability.free, 2);
  assert.equal('availability' in ok(updateBooking(s, made[0].id, { note: 'x' }, opts())).meta, false);
});

test('each thing about a booking counts as a change on its own', () => {
  const { s, made } = diary({ note: 'Window' });
  for (const patch of [{ guest_name: 'Asha Rao' }, { phone: '98111 22233' }, { party_size: 3 }, { at: when(9) }, { duration_mins: 120 }, { note: 'Terrace' }, { note: '' }]) {
    const r = ok(updateBooking(s, made[0].id, patch, opts()));
    assert.notEqual(r.data, s, JSON.stringify(patch));
    assert.notEqual(r.meta.unchanged, true, JSON.stringify(patch));
  }
});

test('each thing about someone in the queue counts as a change on its own', () => {
  const { s, made } = queue({ note: 'High chair' });
  for (const patch of [{ guest_name: 'Rahul K' }, { party_size: 4 }, { quoted_wait_mins: 25 }, { quoted_wait_mins: null }, { note: 'Booster seat' }, { note: '' }, { phone: '98765 99999' }, { phone: '' }]) {
    const r = ok(updateWalkIn(s, made[0].id, patch, { now: NOW }));
    assert.notEqual(r.data, s, JSON.stringify(patch));
    assert.notEqual(r.meta.unchanged, true, JSON.stringify(patch));
  }
});

test('changing something about someone in the queue keeps the number they gave, and the rest', () => {
  const { s, made } = queue({ note: 'High chair' });
  const e = entry(ok(updateWalkIn(s, made[0].id, { party_size: 4 }, { now: NOW })).data, made[0].id);
  assert.deepEqual([e.phone, e.phone_key, e.note, e.quoted_wait_mins, e.guest_name], [made[0].phone, made[0].phone_key, 'High chair', 20, 'Rahul']);
});

test('a number cannot be taken off, or a wait taken back, from someone by accident: only what is said changes', () => {
  const { s, made } = queue({});
  const e = entry(ok(updateWalkIn(s, made[0].id, { note: 'x' }, { now: NOW })).data, made[0].id);
  assert.equal(e.phone, made[0].phone);
  assert.equal(e.quoted_wait_mins, 20);
});

test('something said as undefined is not said: a change built from optional values does not wipe what is there', () => {
  const { s, made } = diary({ note: 'Window' });
  const r = get(ok(updateBooking(s, made[0].id, { note: undefined, guest_name: undefined, party_size: 3 }, opts())).data, made[0].id);
  assert.deepEqual([r.note, r.guest_name, r.party_size], ['Window', 'Asha', 3]);
  assert.equal(ok(updateBooking(s, made[0].id, { note: undefined, phone: undefined }, opts())).data, s, 'and said on its own it is nothing');

  const q = queue({ note: 'High chair' });
  const e = entry(ok(updateWalkIn(q.s, q.made[0].id, { note: undefined, quoted_wait_mins: undefined, phone: undefined, party_size: 4 }, { now: NOW })).data, q.made[0].id);
  assert.deepEqual([e.note, e.quoted_wait_mins, e.phone, e.party_size], ['High chair', 20, q.made[0].phone, 4]);
  assert.equal(ok(updateWalkIn(q.s, q.made[0].id, { note: undefined, phone: undefined }, { now: NOW })).data, q.s);
});

test('only what a change holds itself is read: nothing it merely inherits', () => {
  const { s, made } = diary({ note: 'Window' });
  const inherited = Object.create({ guest_name: 'Inherited', note: 'Inherited', party_size: 4, at: when(9) });
  assert.equal(ok(updateBooking(s, made[0].id, inherited, opts())).data, s);
  const q = queue({});
  assert.equal(ok(updateWalkIn(q.s, q.made[0].id, Object.create({ guest_name: 'Inherited', party_size: 4, phone: '' }), { now: NOW })).data, q.s);
});

test('a booking from before stays were recorded is not taken for a longer stay by a change that has nothing to do with it', () => {
  const { s, made } = diary({ at: when(5) });
  const { duration_mins, ...old } = made[0];
  const oldState = { ...s, reservations: [old] };
  // With no tables at all, a change that was taken for a longer stay would be asked about tables and refused.
  const r = ok(updateBooking(oldState, old.id, { guest_name: 'Asha Rao' }, { now: NOW, tables: [] }));
  assert.equal(get(r.data, old.id).guest_name, 'Asha Rao');
  assert.equal('availability' in r.meta, false);
  assert.equal(ok(updateBooking(oldState, old.id, {}, { now: NOW, tables: [] })).data, oldState, 'and asking for nothing is nothing');
});

test('walk-ins already sitting down take tables from a booking being moved, as they do from one being taken', () => {
  const { s, made } = diary({ at: when(5) });
  assert.equal(ok(updateBooking(s, made[0].id, { at: when(8) }, opts({ seatedWalkIns: 1 }))).meta.availability.free, 1);
  const full = refused(updateBooking(s, made[0].id, { at: when(8) }, opts({ seatedWalkIns: 2 })), 'FULLY_BOOKED');
  assert.equal(full.availability.free, 0);
  assert.equal(ok(updateBooking(s, made[0].id, { at: when(8) }, opts({ seatedWalkIns: 2, force: true }))).meta.reservation.overbooked, true);
});

test('a refusal says in words what is wrong, which is what reception reads', () => {
  const { s, made } = diary({ at: when(5), party_size: 4 }, { at: when(5), party_size: 4, phone: '98111 22233' }, { at: when(9), party_size: 4, phone: '98111 22244' });
  assert.equal(refused(updateBooking(s, made[0].id, { party_size: 6 }, opts()), 'NO_TABLE_THAT_SIZE').error, 'No table here seats 6.');
  assert.equal(refused(updateBooking(s, made[2].id, { at: when(5) }, opts()), 'FULLY_BOOKED').error, 'Every table that size is already booked then.');
});

test('who sent the reminder is kept with it through a change that is not a move, and let go of with it when it is', () => {
  let { s, made } = diary({ at: when(5) });
  s = ok(markReminded(s, made[0].id, { by: 'Meera', now: NOW })).data;
  const kept = get(ok(updateBooking(s, made[0].id, { guest_name: 'Asha Rao' }, opts())).data, made[0].id);
  assert.deepEqual([kept.reminded_at, kept.reminded_by], [get(s, made[0].id).reminded_at, 'Meera']);
  const moved = get(ok(updateBooking(s, made[0].id, { at: when(9) }, opts())).data, made[0].id);
  assert.deepEqual([moved.reminded_at, moved.reminded_by], [undefined, undefined]);
});

test('a number is taken off by saying none, as well as by saying nothing', () => {
  let { s, made } = queue({});
  const cleared = entry(ok(updateWalkIn(s, made[0].id, { phone: null }, { now: NOW })).data, made[0].id);
  assert.equal('phone' in cleared, false);
  assert.equal('phone_key' in cleared, false);
  s = ok(setWaitlistStatus(s, made[0].id, 'notified', { now: NOW })).data;
  refused(updateWalkIn(s, made[0].id, { phone: null }, { now: NOW }), 'HAS_BEEN_MESSAGED');
});

test('the diary on disk checks a moved booking against the walk-ins sitting down now', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kullina-edit-'));
  const store = new ReservationStore(path.join(dir, 'reservations.json'));
  try {
    store.ensureTenant(RID);
    store.setTableProvider(() => TABLES);
    const booked = ok(store.book(RID, { guest_name: 'Asha', phone: '98765 43210', party_size: 2, at: when(5) }, { now: NOW })).meta.reservation;
    for (const name of ['Walk A', 'Walk B']) {
      const w = ok(store.addWalkIn(RID, { guest_name: name, party_size: 2 }, { now: NOW })).meta.entry;
      ok(store.setWaitlistStatus(RID, w.id, 'seated', { now: NOW }));
    }
    const refusal = refused(store.updateBooking(RID, booked.id, { at: when(1) }, { now: NOW }), 'FULLY_BOOKED');
    assert.equal(refusal.availability.free, 0, 'both tables have walk-ins at them');
    assert.equal(store.stateFor(RID).reservations[0].at, booked.at, 'and it stayed where it was');
    assert.equal(ok(store.updateBooking(RID, booked.id, { note: 'Window' }, { now: NOW })).meta.reservation.note, 'Window', 'a change that cannot cost a table is not asked about them');
    assert.equal(ok(store.updateBooking(RID, booked.id, { at: when(1) }, { now: NOW, force: true })).meta.reservation.overbooked, true);
  } finally {
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// --- on a real hub -------------------------------------------------------------------------------------------------------

let reception;
let remote;
let handset;
before(async () => {
  const fixture = { menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
    tables: { restaurant_id: RESTAURANT_ID, tables: TABLES.map(t => ({ ...t, section: 'M' })) } };
  reception = await startHub({ trustLoopback: true, ...fixture, enrollmentCode: 'EDITREC' });
  remote = await startHub({ trustLoopback: false, ...fixture, enrollmentCode: 'EDITREM' });
  handset = (await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'EDITREM', device_label: 'x' } })).json()).device_token;
});
after(() => { reception?.stop(); remote?.stop(); });

const soon = h => new Date(Date.now() + h * HOUR).toISOString();
const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const json = r => r.json();
const makeBooking = async (name, phone, hours, over = {}) => {
  const r = await call(reception, '/admin/bookings', { method: 'POST', body: { guest_name: name, phone, party_size: 2, at: soon(hours), force: true, ...over } });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return (await r.json()).reservation;
};
const diaryRow = async b => (await json(await call(reception, `/admin/bookings?day=${dayOf(b.at)}`))).reservations.find(r => r.id === b.id);

test('hub: a booking is changed, the diary shows it, and the answer is the booking as it now is', async () => {
  const b = await makeBooking('Asha', '98765 43210', 30);
  const r = await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { note: 'Window', party_size: 3 } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = await json(r);
  assert.equal(body.success, true);
  assert.deepEqual([body.reservation.note, body.reservation.party_size], ['Window', 3]);
  assert.match(body.reservation.whatsapp, /^https:\/\/wa\.me\/91/);
  const row = await diaryRow(b);
  assert.deepEqual([row.note, row.party_size], ['Window', 3]);
});

test('hub: moving a booking onto a full evening is refused with what is free, and goes through when reception says so', async () => {
  const when1 = 50;
  const a = await makeBooking('A', '98765 40001', when1);
  await makeBooking('B', '98765 40002', when1);
  const c = await makeBooking('C', '98765 40003', 80);
  const refusal = await call(reception, `/admin/bookings/${c.id}`, { method: 'PUT', body: { at: a.at } });
  const body = await json(refusal);
  assert.deepEqual([refusal.status, body.code, body.availability.free], [409, 'FULLY_BOOKED', 0]);
  assert.equal((await diaryRow(c)).at, c.at, 'and it stayed where it was');

  const forced = await call(reception, `/admin/bookings/${c.id}`, { method: 'PUT', body: { at: a.at, force: true } });
  assert.equal(forced.status, 200);
  assert.equal((await json(forced)).reservation.overbooked, true);
  const stringForce = await makeBooking('D', '98765 40004', 120);
  const truthy = await call(reception, `/admin/bookings/${stringForce.id}`, { method: 'PUT', body: { at: a.at, force: 'yes' } });
  assert.equal(truthy.status, 409, 'only a plain true counts');
});

test('hub: a booking that cannot be changed, or is not there, or has a mistake in it, says so', async () => {
  const b = await makeBooking('Asha', '98765 50001', 31);
  const bad = await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { party_size: 0 } });
  const badBody = await json(bad);
  assert.deepEqual([bad.status, badBody.code, badBody.errors[0].field], [400, 'INVALID_BOOKING', 'party_size']);
  assert.equal((await call(reception, '/admin/bookings/res_nope', { method: 'PUT', body: { note: 'x' } })).status, 404);
  await call(reception, `/admin/bookings/${b.id}/status`, { method: 'PUT', body: { status: 'cancelled' } });
  const gone = await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { note: 'x' } });
  assert.deepEqual([gone.status, (await json(gone)).code], [409, 'NOT_BOOKED']);
});

test('hub: someone in the queue is given a new wait, and the queue shows it', async () => {
  const added = await call(reception, '/admin/waitlist', { method: 'POST', body: { guest_name: 'Rahul', party_size: 3, quoted_wait_mins: 20 } });
  const entryId = (await json(added)).entry.id;
  const r = await call(reception, `/admin/waitlist/${entryId}`, { method: 'PUT', body: { quoted_wait_mins: 40, phone: '98765 60001' } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = await json(r);
  assert.deepEqual([body.entry.quoted_wait_mins, body.entry.phone], [40, '919876560001']);
  assert.match(body.entry.whatsapp, /^https:\/\/wa\.me\/919876560001/, 'and now there is someone to message');
  const queueRow = (await json(await call(reception, '/admin/bookings'))).waitlist.find(e => e.id === entryId);
  assert.equal(queueRow.quoted_wait_mins, 40);

  const bad = await call(reception, `/admin/waitlist/${entryId}`, { method: 'PUT', body: { party_size: 0 } });
  assert.deepEqual([bad.status, (await json(bad)).code], [400, 'INVALID_WALK_IN']);
  assert.equal((await call(reception, '/admin/waitlist/wl_nope', { method: 'PUT', body: { note: 'x' } })).status, 404);
  await call(reception, `/admin/waitlist/${entryId}/status`, { method: 'PUT', body: { status: 'seated' } });
  const seated = await call(reception, `/admin/waitlist/${entryId}`, { method: 'PUT', body: { note: 'x' } });
  assert.deepEqual([seated.status, (await json(seated)).code], [409, 'NOT_WAITING']);
});

test('hub: a waiter\'s handset can change neither a booking nor the queue', async () => {
  for (const [path, body] of [['/admin/bookings/res_1', { note: 'x' }], ['/admin/waitlist/wl_1', { note: 'x' }]]) {
    const r = await call(remote, path, { method: 'PUT', token: handset, body });
    assert.equal(r.status, 403, path);
    assert.equal((await json(r)).code, 'RECEPTION_ONLY');
  }
});

test('hub: asking for what is already there says nothing changed, and a change that could cost a table hands back what is free', async () => {
  const b = await makeBooking('Asha', '98765 70001', 33);
  const same = await json(await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { guest_name: 'Asha' } }));
  assert.equal(same.unchanged, true);
  assert.equal('availability' in same, false);
  const note = await json(await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { note: 'x' } }));
  assert.deepEqual([note.unchanged, 'availability' in note], [false, false]);
  const party = await json(await call(reception, `/admin/bookings/${b.id}`, { method: 'PUT', body: { party_size: 3 } }));
  assert.equal(typeof party.availability.free, 'number');
  assert.equal(party.unchanged, false);
  assert.equal(typeof party.revision, 'number');
});

test('hub: the queue says nothing changed when nothing did, and carries the way to reach them', async () => {
  const added = await call(reception, '/admin/waitlist', { method: 'POST', body: { guest_name: 'Rahul', party_size: 3, quoted_wait_mins: 20, phone: '98765 70002' } });
  const entryId = (await json(added)).entry.id;
  const same = await json(await call(reception, `/admin/waitlist/${entryId}`, { method: 'PUT', body: { party_size: 3 } }));
  assert.deepEqual([same.unchanged, same.entry.party_size], [true, 3]);
  const changed = await json(await call(reception, `/admin/waitlist/${entryId}`, { method: 'PUT', body: { party_size: 5 } }));
  assert.deepEqual([changed.unchanged, changed.entry.party_size], [false, 5]);
  assert.match(changed.entry.whatsapp, /^https:\/\/wa\.me\/919876570002/);
  assert.match(changed.entry.tel, /^tel:\+919876570002/);
});

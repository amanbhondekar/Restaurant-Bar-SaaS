import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, normalizeState, book, setReservationStatus, remindersDue, markReminded, unmarkReminded, reminderMessage,
  REMINDER_WINDOW_HOURS
} from '../lib/reservations.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Reminding a guest of a booking. The product sends nothing by itself (the hub has no messaging provider; staff tap a
// WhatsApp link and send from their own phone), so "nothing records whether a message was really sent" is answered
// honestly: the hub records that a PERSON said they sent it, when and who, which is what stops two people ringing the
// same guest and what tells the host who still has to be chased. It cannot know the message was delivered.

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 9, 23, 9, 0, 0);
const TABLES = [{ id: 1, name: 'T1', capacity: 4 }, { id: 2, name: 'T2', capacity: 4 }, { id: 3, name: 'T3', capacity: 4 }];
const inHours = h => new Date(NOW.getTime() + h * HOUR).toISOString();
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false); assert.equal(r.code, code); return r; };

/** A state holding bookings at the given hours from NOW. */
function diary(...hours) {
  let s = emptyState('rest-1');
  const made = [];
  for (const [i, h] of hours.entries()) {
    const r = ok(book(s, { guest_name: `Guest ${i + 1}`, phone: `98765 4321${i}`, party_size: 2, at: inHours(h) }, { now: NOW, tables: TABLES }));
    s = r.data;
    made.push(r.meta.reservation);
  }
  return { s, made };
}

// --- who is due -----------------------------------------------------------------------------------------------------

test('a booking in the next day that has not been reminded is due, earliest first', () => {
  const { s } = diary(20, 3, 12);
  assert.deepEqual(remindersDue(s, { now: NOW }).map(r => r.guest_name), ['Guest 2', 'Guest 3', 'Guest 1']);
});

test('a booking further off than the window is not due yet, and the window can be widened', () => {
  const { s } = diary(3, 30);
  assert.equal(REMINDER_WINDOW_HOURS, 24);
  assert.deepEqual(remindersDue(s, { now: NOW }).map(r => r.guest_name), ['Guest 1']);
  assert.deepEqual(remindersDue(s, { now: NOW, withinHours: 48 }).map(r => r.guest_name), ['Guest 1', 'Guest 2']);
});

test('the edge of the window is in, and a booking already under way or past is not a reminder any more', () => {
  const { s } = diary(24, 0.5);
  assert.deepEqual(remindersDue(s, { now: NOW }).map(r => r.guest_name), ['Guest 2', 'Guest 1']);
  const later = new Date(NOW.getTime() + 1 * HOUR);   // Guest 2's table time (09:30) has gone by
  assert.deepEqual(remindersDue(s, { now: later }).map(r => r.guest_name), ['Guest 1']);
});

test('a booking starting this very minute is under way, not a reminder', () => {
  const { s } = diary(0, 0.01);
  assert.deepEqual(remindersDue(s, { now: NOW }).map(r => r.guest_name), ['Guest 2']);
});

test('a window given as a number in text is read as the number, as it arrives from a query string', () => {
  const { s } = diary(3, 30);
  assert.equal(remindersDue(s, { now: NOW, withinHours: '48' }).length, 2);
  assert.equal(remindersDue(s, { now: NOW, withinHours: '' }).length, 1, 'blank means the default');
});

test('only a booking that is still booked, has a number and was not reminded is due', () => {
  const { s, made } = diary(3, 4, 5, 6);
  let t = ok(setReservationStatus(s, made[0].id, 'cancelled', { now: NOW })).data;
  t = ok(setReservationStatus(t, made[1].id, 'seated', { now: NOW })).data;
  t = ok(markReminded(t, made[2].id, { by: 'Asha', now: NOW })).data;
  assert.deepEqual(remindersDue(t, { now: NOW }).map(r => r.guest_name), ['Guest 4']);
  const noNumber = { ...t, reservations: t.reservations.map(r => (r.id === made[3].id ? { ...r, phone: undefined } : r)) };
  assert.deepEqual(remindersDue(noNumber, { now: NOW }), [], 'with no number there is nobody to message');
});

test('a silly window falls back to the default rather than hiding or flooding the list', () => {
  const { s } = diary(3, 30);
  for (const bad of [0, -5, NaN, 'soon', null, Infinity]) assert.equal(remindersDue(s, { now: NOW, withinHours: bad }).length, 1, String(bad));
  assert.equal(remindersDue(s, { now: NOW, withinHours: 100000 }).length, 2, 'a huge window is capped, not refused');
});

// --- recording that it was sent ---------------------------------------------------------------------------------------

test('marking a reminder sent records when and by whom, and takes the booking off the list', () => {
  const { s, made } = diary(3);
  const r = ok(markReminded(s, made[0].id, { by: '  Asha  ', now: NOW }));
  assert.equal(r.meta.reservation.reminded_at, NOW.toISOString());
  assert.equal(r.meta.reservation.reminded_by, 'Asha');
  assert.equal(r.data.revision, s.revision + 1);
  assert.equal(remindersDue(r.data, { now: NOW }).length, 0);
  assert.equal(s.reservations[0].reminded_at, undefined, 'the state it was given is not changed');
});

test('who sent it is optional, kept short, and nothing is stored for a blank name', () => {
  const { s, made } = diary(3, 4);
  assert.equal('reminded_by' in ok(markReminded(s, made[0].id, { now: NOW })).meta.reservation, false);
  assert.equal('reminded_by' in ok(markReminded(s, made[0].id, { by: '   ', now: NOW })).meta.reservation, false);
  assert.equal(ok(markReminded(s, made[1].id, { by: 'x'.repeat(200), now: NOW })).meta.reservation.reminded_by.length, 60);
});

test('marking it twice keeps the first time and changes nothing', () => {
  const { s, made } = diary(3);
  const first = ok(markReminded(s, made[0].id, { by: 'Asha', now: NOW }));
  const second = ok(markReminded(first.data, made[0].id, { by: 'Ravi', now: new Date(NOW.getTime() + HOUR) }));
  assert.equal(second.data, first.data);
  assert.equal(second.meta.already, true);
  assert.equal(second.meta.reservation.reminded_by, 'Asha');
});

test('an unknown booking, or one that is no longer booked, cannot be marked', () => {
  const { s, made } = diary(3);
  refused(markReminded(s, 'res_nope', { now: NOW }), 'NOT_FOUND');
  const seated = ok(setReservationStatus(s, made[0].id, 'seated', { now: NOW })).data;
  refused(markReminded(seated, made[0].id, { now: NOW }), 'NOT_BOOKED');
});

test('a reminder marked by mistake can be taken back, and the booking is due again', () => {
  const { s, made } = diary(3);
  const marked = ok(markReminded(s, made[0].id, { by: 'Asha', now: NOW })).data;
  const undone = ok(unmarkReminded(marked, made[0].id));
  assert.equal('reminded_at' in undone.meta.reservation, false);
  assert.equal('reminded_by' in undone.meta.reservation, false);
  assert.equal(remindersDue(undone.data, { now: NOW }).length, 1);
  assert.equal(ok(unmarkReminded(s, made[0].id)).data, s, 'nothing to take back: nothing changes');
  refused(unmarkReminded(s, 'res_nope'), 'NOT_FOUND');
});

test('the marks survive being written to disk and read back', () => {
  const { s, made } = diary(3);
  const marked = ok(markReminded(s, made[0].id, { by: 'Asha', now: NOW })).data;
  const back = normalizeState(JSON.parse(JSON.stringify(marked)), 'rest-1');
  assert.equal(back.reservations[0].reminded_at, NOW.toISOString());
  assert.equal(back.reservations[0].reminded_by, 'Asha');
});

test('the message names the guest, the restaurant, the party and the time, and invites a reply', () => {
  const { made } = diary(3);
  const text = reminderMessage(made[0], 'Mejwani');
  assert.match(text, /^Hello Guest 1,/);
  assert.match(text, /Mejwani/);
  assert.match(text, /table for 2/);
  assert.ok(text.includes(new Date(made[0].at).toLocaleString()));
  assert.match(text, /reply/i);
  assert.match(text, /reminder/i);
});

// --- a real hub -----------------------------------------------------------------------------------------------------

let reception;
let remote;
let handset;
before(async () => {
  const fixture = { menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
    tables: { restaurant_id: RESTAURANT_ID, tables: TABLES.map(t => ({ ...t, section: 'M' })) } };
  reception = await startHub({ trustLoopback: true, ...fixture, enrollmentCode: 'REMREC' });
  remote = await startHub({ trustLoopback: false, ...fixture, enrollmentCode: 'REMREM' });
  handset = (await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'REMREM', device_label: 'x' } })).json()).device_token;
});
after(() => { reception?.stop(); remote?.stop(); });

const soon = h => new Date(Date.now() + h * HOUR).toISOString();
const bookAt = async (name, hours) => {
  const r = await call(reception, '/admin/bookings', { method: 'POST', body: { guest_name: name, phone: '98765 43210', party_size: 2, at: soon(hours) } });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return (await r.json()).reservation;
};
const due = async (query = '') => (await (await call(reception, `/admin/bookings/reminders${query}`)).json());

test('hub: the reminders due are listed with a WhatsApp link that carries the reminder, not the confirmation', async () => {
  const near = await bookAt('Near Guest', 3);
  await bookAt('Far Guest', 30);

  const body = await due();
  assert.equal(body.success, true);
  assert.equal(body.window_hours, 24);
  assert.deepEqual(body.reminders.map(r => r.guest_name), ['Near Guest']);
  const r = body.reminders[0];
  assert.equal(r.id, near.id);
  assert.match(r.whatsapp, /^https:\/\/wa\.me\/919876543210\?text=/);
  const sent = decodeURIComponent(r.whatsapp.split('text=')[1]);
  assert.match(sent, /reminder/i);
  assert.match(sent, /Near Guest/);
  assert.equal(r.tel, 'tel:+919876543210');

  assert.deepEqual((await due('?hours=48')).reminders.map(x => x.guest_name), ['Near Guest', 'Far Guest']);
  assert.equal((await due('?hours=48')).window_hours, 48);
});

test('hub: marking one sent takes it off the list, shows on the diary row, and can be taken back', async () => {
  const b = await bookAt('Mark Me', 5);
  const done = await call(reception, `/admin/bookings/${b.id}/reminded`, { method: 'POST', body: { by: 'Asha' } });
  assert.equal(done.status, 200);
  const marked = (await done.json()).reservation;
  assert.equal(marked.reminded_by, 'Asha');
  assert.ok(Date.parse(marked.reminded_at) <= Date.now());

  assert.equal((await due()).reminders.some(r => r.id === b.id), false);
  const day = new Date(b.at);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const listed = (await (await call(reception, `/admin/bookings?day=${ymd}`)).json()).reservations.find(r => r.id === b.id);
  assert.equal(listed.reminded_by, 'Asha');

  const undone = await call(reception, `/admin/bookings/${b.id}/reminded`, { method: 'DELETE' });
  assert.equal(undone.status, 200);
  assert.equal((await due()).reminders.some(r => r.id === b.id), true);
});

test('hub: marking a booking that is cancelled or unknown is refused, in words', async () => {
  const b = await bookAt('Called Off', 6);
  await call(reception, `/admin/bookings/${b.id}/status`, { method: 'PUT', body: { status: 'cancelled' } });
  const refused409 = await call(reception, `/admin/bookings/${b.id}/reminded`, { method: 'POST', body: {} });
  assert.equal(refused409.status, 409);
  assert.equal((await refused409.json()).code, 'NOT_BOOKED');
  const missing = await call(reception, '/admin/bookings/res_nope/reminded', { method: 'POST', body: {} });
  assert.equal(missing.status, 404);
  assert.equal((await call(reception, '/admin/bookings/res_nope/reminded', { method: 'DELETE' })).status, 404);
});

test('hub: a waiter\'s handset cannot read the guests to remind or mark anyone', async () => {
  for (const [method, path] of [['GET', '/admin/bookings/reminders'], ['POST', '/admin/bookings/res_1/reminded'], ['DELETE', '/admin/bookings/res_1/reminded']]) {
    const res = await call(remote, path, { method, token: handset, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).code, 'RECEPTION_ONLY');
  }
});

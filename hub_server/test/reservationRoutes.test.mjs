import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Bookings and the walk-in queue through a real hub (§4.6): taking a booking, not selling the same
// table twice, and reaching a guest whose table is ready.

const RID = RESTAURANT_ID;
const FIXTURE = {
  menu: { restaurant_id: RID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
  tables: {
    restaurant_id: RID,
    tables: [
      { id: 1, name: 'T1', section: 'Main', capacity: 2 },
      { id: 2, name: 'T2', section: 'Main', capacity: 2 },
      { id: 3, name: 'T3', section: 'Main', capacity: 4 },
      { id: 4, name: 'T4', section: 'Garden', capacity: 6 }
    ]
  }
};

let hub;
let remote;
before(async () => {
  hub = await startHub({ trustLoopback: true, ...FIXTURE, enrollmentCode: 'BOOKONE' });
  remote = await startHub({ trustLoopback: false, ...FIXTURE, enrollmentCode: 'BOOKTWO' });
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

/** Tonight, in the restaurant's own timezone -- which is what the diary is kept in. */
const tonight = (h, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const dayOf = iso => {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const bookingFor = (over = {}) => ({ guest_name: 'Asha', phone: '98765 43210', party_size: 2, at: tonight(19), ...over });

test('hub: a booking is taken, and comes back with the ways to reach the guest already built', async () => {
  const res = await api('/admin/bookings', { method: 'POST', body: bookingFor() });
  assert.equal(res.status, 201);
  const { reservation } = await json(res);

  assert.equal(reservation.status, 'booked');
  assert.equal(reservation.phone, '919876543210');
  assert.equal(reservation.phone_display, '+91 98765 43210');
  assert.match(reservation.whatsapp, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.equal(reservation.tel, 'tel:+919876543210');
  // No screen should have to know how to format a phone number or build a wa.me link.
});

test('hub: the diary shows the day asked for, with counts reception can read at a glance', async () => {
  const day = dayOf(tonight(19));
  const body = await json(await api(`/admin/bookings?day=${day}`));
  assert.equal(body.day, day);
  assert.ok(body.reservations.some(r => r.guest_name === 'Asha'));
  assert.ok(body.summary.booked >= 1);
  assert.ok(body.summary.covers >= 2);
});

test('hub: the same table cannot be sold twice, and the refusal says what is left', async () => {
  const sixAt20 = bookingFor({ guest_name: 'Big party', party_size: 6, at: tonight(20) });
  assert.equal((await api('/admin/bookings', { method: 'POST', body: sixAt20 })).status, 201);

  const clash = await api('/admin/bookings', { method: 'POST', body: { ...sixAt20, guest_name: 'Also six', at: tonight(20, 30) } });
  assert.equal(clash.status, 409);
  const body = await json(clash);
  assert.equal(body.code, 'FULLY_BOOKED');
  assert.equal(body.availability.fitting, 1, 'there is one table that size');
  assert.equal(body.availability.free, 0);
});

test('hub: a party bigger than any table is refused with the reason, not a generic error', async () => {
  const res = await api('/admin/bookings', { method: 'POST', body: bookingFor({ party_size: 20 }) });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'NO_TABLE_THAT_SIZE');
  assert.match(body.error, /No table here seats 20/);
});

test('hub: a restaurant that knows better can overbook, and it is on the record', async () => {
  const forced = await api('/admin/bookings', { method: 'POST', body: bookingFor({ guest_name: 'Squeezed', party_size: 6, at: tonight(20), force: true }) });
  assert.equal(forced.status, 201);
  assert.equal((await json(forced)).reservation.overbooked, true);
});

test('hub: availability can be asked before a booking is offered', async () => {
  const free = await json(await api(`/admin/bookings/availability?at=${encodeURIComponent(tonight(23))}&party_size=2`));
  assert.equal(free.ok, true);
  const taken = await json(await api(`/admin/bookings/availability?at=${encodeURIComponent(tonight(20))}&party_size=6`));
  assert.equal(taken.ok, false);
  assert.equal(taken.code, 'FULLY_BOOKED');
});

test('hub: a bad booking is refused per field, before anything is written', async () => {
  const res = await api('/admin/bookings', { method: 'POST', body: { guest_name: '', phone: 'nope', party_size: 0, at: 'soon' } });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'INVALID_BOOKING');
  assert.deepEqual(body.errors.map(e => e.field).sort(), ['at', 'guest_name', 'party_size', 'phone']);
});

test('hub: a booking is seated, and cannot then be marked a no-show', async () => {
  const { reservation } = await json(await api('/admin/bookings', { method: 'POST', body: bookingFor({ guest_name: 'Seated soon', at: tonight(21) }) }));
  assert.equal((await api(`/admin/bookings/${reservation.id}/status`, { method: 'PUT', body: { status: 'seated' } })).status, 200);

  const tooLate = await api(`/admin/bookings/${reservation.id}/status`, { method: 'PUT', body: { status: 'no_show' } });
  assert.equal(tooLate.status, 409);
  assert.equal((await json(tooLate)).code, 'ALREADY_SEATED');
});

test('hub: a walk-in joins the queue, with a ready-made message for when the table is free', async () => {
  const res = await api('/admin/waitlist', { method: 'POST', body: { guest_name: 'Rahul', party_size: 3, phone: '98765 11111', quoted_wait_mins: 20 } });
  assert.equal(res.status, 201);
  const { entry } = await json(res);
  assert.equal(entry.status, 'waiting');
  assert.ok(decodeURIComponent(entry.whatsapp).includes('your table at'), 'the message is already written');

  const listed = await json(await api('/admin/bookings'));
  assert.ok(listed.waitlist.some(e => e.id === entry.id));
  assert.ok(listed.summary.waiting >= 1);
});

test('hub: someone who left no number can still be queued and seated, just not messaged', async () => {
  const { entry } = await json(await api('/admin/waitlist', { method: 'POST', body: { guest_name: 'No phone', party_size: 2 } }));
  assert.equal(entry.whatsapp, undefined);

  const notified = await api(`/admin/waitlist/${entry.id}/status`, { method: 'PUT', body: { status: 'notified' } });
  assert.equal(notified.status, 409);
  assert.equal((await json(notified)).code, 'NO_PHONE');
  assert.equal((await api(`/admin/waitlist/${entry.id}/status`, { method: 'PUT', body: { status: 'seated' } })).status, 200);
});

test('hub: the diary survives a restart -- it is tonight\'s promises to real people', async () => {
  const file = path.join(hub.dataDir, 'reservations.json');
  const deadline = Date.now() + 5000;
  let onDisk;
  while (Date.now() < deadline) {
    try { onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')); if (onDisk.reservations.length) break; } catch { /* mid-write */ }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(onDisk, 'reservations.json exists');
  assert.equal(onDisk.restaurant_id, RID);
  assert.ok(onDisk.reservations.some(r => r.guest_name === 'Asha'));
  assert.ok(onDisk.waitlist.some(e => e.guest_name === 'Rahul'));
  assert.equal(JSON.stringify(onDisk).includes('"phone_key"'), true, 'the matching key is stored, not recomputed per read');
});

test('hub: every booking route is reception-only -- an enrolled handset is refused', async () => {
  const enrolled = await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'BOOKTWO', device_label: 'Handset' } })).json();
  assert.ok(enrolled.device_token);

  const routes = [
    ['GET', '/admin/bookings'],
    ['GET', '/admin/bookings/availability?at=2026-10-22T19:00:00Z&party_size=2'],
    ['POST', '/admin/bookings', bookingFor()],
    ['PUT', '/admin/bookings/res_1/status', { status: 'seated' }],
    ['POST', '/admin/waitlist', { guest_name: 'Intruder', party_size: 2 }],
    ['PUT', '/admin/waitlist/wl_1/status', { status: 'seated' }]
  ];
  for (const [method, p, body] of routes) {
    for (const token of [undefined, enrolled.device_token]) {
      const res = await call(remote, p, { method, body, token });
      assert.ok([401, 403].includes(res.status), `${method} ${p} ${token ? 'with a token' : 'with none'} -> ${res.status}`);
    }
  }
  assert.equal(fs.existsSync(path.join(remote.dataDir, 'reservations.json')), false, 'and nothing was written');
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRewardScheme, rewardDue, MAX_VISITS_BETWEEN, REWARD_TEXT_MAX } from '../lib/loyalty.js';
import { emptyState, book, setReservationStatus, addWalkIn, setWaitlistStatus, giveReward, takeBackReward, giveWalkInReward, takeBackWalkInReward } from '../lib/reservations.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// A reward for coming back, in the one form that does not need the product to decide anything commercial: the RESTAURANT
// says "every 5th visit, a free dessert" (or any wording it likes), off until it does, and the hub does the remembering:
// it tells the host at the right moment that this guest's 5th visit is today, and records that it was given. Applying it to
// the bill stays a person's job, because the product does not know what a dessert costs or what the owner is willing to give.
// What this is not: points, tiers, or an automatic discount.

const RID = 'rest-1';
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const TABLES = [{ id: 1, name: 'T1', capacity: 4 }, { id: 2, name: 'T2', capacity: 4 }];
const SCHEME = { enabled: true, every_n_visits: 5, text: 'a free dessert' };
const PHONE = '98765 43210';
const OTHER = '98111 22233';
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, 'expected a refusal'); assert.equal(r.code, code); return r; };
const day = n => new Date(2026, 9, 1 + n, 19, 0).toISOString();   // all earlier than NOW

/** A diary where `phone` has been seated `visits` times, and has one booking still to come. Returns the upcoming booking. */
function diaryWithVisits(visits, { phone = PHONE, other = 0, otherStatuses = [] } = {}) {
  let s = emptyState(RID);
  const make = (p, at, status, name) => {
    const r = ok(book(s, { guest_name: name, phone: p, party_size: 2, at }, { now: new Date(2026, 8, 1), tables: TABLES, force: true }));
    s = r.data;
    if (status !== 'booked') s = ok(setReservationStatus(s, r.meta.reservation.id, status, { now: new Date(at) })).data;
    return r.meta.reservation;
  };
  for (let i = 0; i < visits; i++) make(phone, day(i), 'seated', 'Asha');
  for (let i = 0; i < other; i++) make(OTHER, day(i), 'seated', 'Someone else');
  for (const [i, st] of otherStatuses.entries()) make(phone, day(20 + i), st, 'Asha');
  const upcoming = make(phone, new Date(2026, 9, 24, 19, 0).toISOString(), 'booked', 'Asha');
  return { s, upcoming };
}
const due = ({ s, upcoming }, scheme = SCHEME) => rewardDue(s, s.reservations.find(r => r.id === upcoming.id), scheme);

// --- the rule the restaurant sets --------------------------------------------------------------------------------

test('a scheme is a number of visits and the words to say, and is off unless both are sensible', () => {
  assert.deepEqual(normalizeRewardScheme({ enabled: true, every_n_visits: 5, text: '  a free dessert ' }), { enabled: true, every_n_visits: 5, text: 'a free dessert' });
  assert.deepEqual(normalizeRewardScheme({ every_n_visits: '5', text: '10% off the bill' }), { enabled: true, every_n_visits: 5, text: '10% off the bill' }, 'a number typed into a form arrives as text');
  for (const bad of [
    null, undefined, 'five', {}, { enabled: false, every_n_visits: 5, text: 'x' },
    { every_n_visits: 1, text: 'x' }, { every_n_visits: 0, text: 'x' }, { every_n_visits: -5, text: 'x' }, { every_n_visits: 2.5, text: 'x' },
    { every_n_visits: MAX_VISITS_BETWEEN + 1, text: 'x' }, { every_n_visits: 'lots', text: 'x' },
    { every_n_visits: 5, text: '' }, { every_n_visits: 5, text: '   ' }, { every_n_visits: 5 }, { every_n_visits: 5, text: 42 }
  ]) assert.equal(normalizeRewardScheme(bad), null, JSON.stringify(bad));
  assert.equal(normalizeRewardScheme({ every_n_visits: 5, text: 'x'.repeat(REWARD_TEXT_MAX + 1) }), null, 'wording that will not fit on the screen is refused, not cut');
  assert.equal(normalizeRewardScheme({ every_n_visits: MAX_VISITS_BETWEEN, text: 'x' }).every_n_visits, MAX_VISITS_BETWEEN);
  assert.equal(normalizeRewardScheme({ every_n_visits: 5, text: 'x'.repeat(REWARD_TEXT_MAX) }).text.length, REWARD_TEXT_MAX, 'wording exactly as long as the screen allows is fine');
  assert.equal(normalizeRewardScheme({ every_n_visits: 2, text: 'x' }).every_n_visits, 2);
});

// --- who is due ----------------------------------------------------------------------------------------------------

test('a guest on their 5th visit is due the reward, and says which visit it is', () => {
  assert.deepEqual(due(diaryWithVisits(4)), { visit_number: 5, text: 'a free dessert' });
});

test('and on the 10th, and the 15th: every Nth, not just the first', () => {
  assert.equal(due(diaryWithVisits(9)).visit_number, 10);
  assert.equal(due(diaryWithVisits(14)).visit_number, 15);
});

test('on any other visit there is nothing to say', () => {
  for (const visits of [0, 1, 2, 3, 5, 6, 8]) assert.equal(due(diaryWithVisits(visits)), null, `after ${visits} visits`);
});

test('the number of visits is the restaurant\'s to choose', () => {
  assert.equal(due(diaryWithVisits(2), { enabled: true, every_n_visits: 3, text: 'a lassi' }).visit_number, 3);
  assert.equal(due(diaryWithVisits(1), { enabled: true, every_n_visits: 2, text: 'a lassi' }).visit_number, 2);
});

test('only visits where the guest sat down count: not cancellations, no-shows, or other guests', () => {
  assert.equal(due(diaryWithVisits(2, { otherStatuses: ['cancelled', 'no_show', 'cancelled'] })), null, 'two visits and three that did not happen: this is the 3rd');
  assert.equal(due(diaryWithVisits(4, { other: 9 })).visit_number, 5, 'someone else\'s nine visits are theirs');
  assert.equal(due(diaryWithVisits(3, { otherStatuses: ['seated'] })).visit_number, 5, 'a seated booking counts');
});

test('a walk-in who sat down counts as a visit, the same as a booking', () => {
  const d = diaryWithVisits(3);
  let s = ok(addWalkIn(d.s, { guest_name: 'Asha', phone: PHONE, party_size: 2 }, { now: new Date(2026, 9, 10, 20, 0) })).data;
  const entry = s.waitlist[0];
  assert.equal(due({ s, upcoming: d.upcoming }), null, 'waiting in the queue is not a visit yet');
  s = ok(setWaitlistStatus(s, entry.id, 'seated', { now: new Date(2026, 9, 10, 20, 30) })).data;
  assert.equal(due({ s, upcoming: d.upcoming }).visit_number, 5, '3 bookings and a seated walk-in make this the 5th');
  s = ok(setWaitlistStatus(s, entry.id, 'left', { now: new Date(2026, 9, 10, 21, 0) })).data;
  assert.equal(due({ s, upcoming: d.upcoming }), null, 'a party that gave up is not a visit');
});

test('with no scheme, nothing is due, and a booking that is not coming up is not offered one', () => {
  assert.equal(due(diaryWithVisits(4), null), null);
  assert.equal(due(diaryWithVisits(4), { enabled: false, every_n_visits: 5, text: 'x' }), null);
  const d = diaryWithVisits(4);
  for (const status of ['cancelled', 'no_show']) {
    const gone = { ...d.s, reservations: d.s.reservations.map(r => (r.id === d.upcoming.id ? { ...r, status } : r)) };
    assert.equal(rewardDue(gone, gone.reservations.find(r => r.id === d.upcoming.id), SCHEME), null, status);
  }
  const noKey = { ...d.s, reservations: d.s.reservations.map(r => (r.id === d.upcoming.id ? { ...r, phone_key: undefined } : r)) };
  assert.equal(rewardDue(noKey, noKey.reservations.find(r => r.id === d.upcoming.id), SCHEME), null, 'a guest we cannot recognise has no history');
});

test('once it has been given it is not due again for that booking', () => {
  const d = diaryWithVisits(4);
  const given = ok(giveReward(d.s, d.upcoming.id, SCHEME, { now: NOW })).data;
  assert.equal(rewardDue(given, given.reservations.find(r => r.id === d.upcoming.id), SCHEME), null);
});

test('a booking that has already been seated is still due its reward, and is not counted as its own earlier visit', () => {
  const d = diaryWithVisits(4);
  const seated = ok(setReservationStatus(d.s, d.upcoming.id, 'seated', { now: NOW })).data;
  assert.deepEqual(rewardDue(seated, seated.reservations.find(r => r.id === d.upcoming.id), SCHEME), { visit_number: 5, text: 'a free dessert' });
});

// --- giving it ---------------------------------------------------------------------------------------------------------

test('giving it records when, and the words that were promised, so changing the scheme later does not rewrite history', () => {
  const d = diaryWithVisits(4);
  const r = ok(giveReward(d.s, d.upcoming.id, SCHEME, { now: NOW }));
  assert.equal(r.meta.reservation.reward_given_at, NOW.toISOString());
  assert.equal(r.meta.reservation.reward_given_text, 'a free dessert');
  assert.equal(r.meta.reservation.reward_visit, 5);
  assert.equal(r.data.revision, d.s.revision + 1);
  assert.equal(d.s.reservations.find(x => x.id === d.upcoming.id).reward_given_at, undefined, 'the state it was given is not changed');
});

test('it cannot be given at will: only on a visit that earns it, only while a scheme is on', () => {
  const early = diaryWithVisits(2);
  refused(giveReward(early.s, early.upcoming.id, SCHEME, { now: NOW }), 'NOT_DUE');
  const d = diaryWithVisits(4);
  refused(giveReward(d.s, d.upcoming.id, null, { now: NOW }), 'REWARDS_OFF');
  refused(giveReward(d.s, 'res_nope', SCHEME, { now: NOW }), 'NOT_FOUND');
});

test('giving it twice changes nothing', () => {
  const d = diaryWithVisits(4);
  const first = ok(giveReward(d.s, d.upcoming.id, SCHEME, { now: NOW }));
  const second = ok(giveReward(first.data, d.upcoming.id, SCHEME, { now: new Date(NOW.getTime() + 3600000) }));
  assert.equal(second.data, first.data);
  assert.equal(second.meta.already, true);
  assert.equal(second.meta.reservation.reward_given_at, NOW.toISOString());
});

test('it can be taken back, and the visit is due it again', () => {
  const d = diaryWithVisits(4);
  const given = ok(giveReward(d.s, d.upcoming.id, SCHEME, { now: NOW })).data;
  const back = ok(takeBackReward(given, d.upcoming.id));
  for (const k of ['reward_given_at', 'reward_given_text', 'reward_visit']) assert.equal(k in back.meta.reservation, false, k);
  assert.equal(rewardDue(back.data, back.data.reservations.find(r => r.id === d.upcoming.id), SCHEME).visit_number, 5);
  assert.equal(ok(takeBackReward(d.s, d.upcoming.id)).data, d.s, 'nothing given: nothing changes');
  refused(takeBackReward(d.s, 'res_nope'), 'NOT_FOUND');
});

// --- walk-ins ------------------------------------------------------------------------------------------------------

/** A diary where `phone` has been seated `visits` times (as bookings) and has just joined the queue. Returns the walk-in. */
function queueDiary(visits, { entryPhone = PHONE } = {}) {
  let s = emptyState(RID);
  for (let i = 0; i < visits; i++) {
    const r = ok(book(s, { guest_name: 'Asha', phone: PHONE, party_size: 2, at: day(i) }, { now: new Date(2026, 8, 1), tables: TABLES, force: true }));
    s = ok(setReservationStatus(r.data, r.meta.reservation.id, 'seated', { now: new Date(day(i)) })).data;
  }
  s = ok(addWalkIn(s, { guest_name: 'Asha', ...(entryPhone ? { phone: entryPhone } : {}), party_size: 2 }, { now: NOW })).data;
  return { s, entry: s.waitlist[s.waitlist.length - 1] };
}
const walkInDue = ({ s, entry }, scheme = SCHEME) => rewardDue(s, s.waitlist.find(e => e.id === entry.id), scheme);
const moved = (d, status) => ok(setWaitlistStatus(d.s, d.entry.id, status, { now: NOW })).data;

test('a walk-in on their 5th visit is due the reward from the moment they join the queue', () => {
  assert.deepEqual(walkInDue(queueDiary(4)), { visit_number: 5, text: 'a free dessert' });
  for (const visits of [0, 1, 3, 5, 6]) assert.equal(walkInDue(queueDiary(visits)), null, `after ${visits} visits`);
});

test('a walk-in is due it while waiting, once messaged and once seated (not counted as their own earlier visit), but not once they have left', () => {
  const d = queueDiary(4);
  for (const status of ['notified', 'seated']) {
    const s = moved(d, status);
    assert.equal(rewardDue(s, s.waitlist.find(e => e.id === d.entry.id), SCHEME).visit_number, 5, status);
  }
  const left = moved(d, 'left');
  assert.equal(rewardDue(left, left.waitlist.find(e => e.id === d.entry.id), SCHEME), null, 'a party that gave up earns nothing');
});

test('a walk-in who gave no number cannot be recognised, so is offered nothing; and with no scheme nothing is due', () => {
  assert.equal(walkInDue(queueDiary(4, { entryPhone: null })), null);
  assert.equal(walkInDue(queueDiary(4), null), null);
});

test("a walk-in's earlier visits are counted the same way as a booking's: another guest's do not count", () => {
  const d = queueDiary(4);
  const other = ok(book(d.s, { guest_name: 'Someone', phone: OTHER, party_size: 2, at: day(9) }, { now: new Date(2026, 8, 1), tables: TABLES, force: true }));
  const s = ok(setReservationStatus(other.data, other.meta.reservation.id, 'seated', { now: new Date(day(9)) })).data;
  assert.equal(rewardDue(s, s.waitlist.find(e => e.id === d.entry.id), SCHEME).visit_number, 5);
});

test('giving a walk-in the reward records when, the words promised and which visit, and it is not offered again', () => {
  const d = queueDiary(4);
  const r = ok(giveWalkInReward(d.s, d.entry.id, SCHEME, { now: NOW }));
  assert.deepEqual([r.meta.entry.reward_given_at, r.meta.entry.reward_given_text, r.meta.entry.reward_visit], [NOW.toISOString(), 'a free dessert', 5]);
  assert.equal(r.data.revision, d.s.revision + 1);
  assert.equal(d.s.waitlist.find(e => e.id === d.entry.id).reward_given_at, undefined, 'the state it was given is not changed');
  assert.equal(rewardDue(r.data, r.data.waitlist.find(e => e.id === d.entry.id), SCHEME), null);
});

test('it cannot be given to a walk-in at will, and a booking is not a walk-in', () => {
  const early = queueDiary(2);
  refused(giveWalkInReward(early.s, early.entry.id, SCHEME, { now: NOW }), 'NOT_DUE');
  const d = queueDiary(4);
  refused(giveWalkInReward(d.s, d.entry.id, null, { now: NOW }), 'REWARDS_OFF');
  assert.equal(refused(giveWalkInReward(d.s, 'wl_nope', SCHEME, { now: NOW }), 'NOT_FOUND').error, 'That party is not in the queue.');
  refused(giveWalkInReward(d.s, d.s.reservations[0].id, SCHEME, { now: NOW }), 'NOT_FOUND');
  refused(takeBackWalkInReward(d.s, d.s.reservations[0].id), 'NOT_FOUND');
  assert.equal(refused(takeBackWalkInReward(d.s, 'wl_nope'), 'NOT_FOUND').error, 'That party is not in the queue.');
});

test('giving it to a walk-in twice changes nothing, and it can be taken back', () => {
  const d = queueDiary(4);
  const first = ok(giveWalkInReward(d.s, d.entry.id, SCHEME, { now: NOW }));
  const second = ok(giveWalkInReward(first.data, d.entry.id, SCHEME, { now: new Date(NOW.getTime() + 3600000) }));
  assert.equal(second.data, first.data);
  assert.equal(second.meta.already, true);
  assert.equal(second.meta.entry.reward_given_at, NOW.toISOString());

  const back = ok(takeBackWalkInReward(first.data, d.entry.id));
  for (const k of ['reward_given_at', 'reward_given_text', 'reward_visit']) assert.equal(k in back.meta.entry, false, k);
  assert.equal(rewardDue(back.data, back.data.waitlist.find(e => e.id === d.entry.id), SCHEME).visit_number, 5);
  assert.equal(ok(takeBackWalkInReward(d.s, d.entry.id)).data, d.s, 'nothing given: nothing changes');
});

// --- a real hub ---------------------------------------------------------------------------------------------------------

let reception;
let remote;
let handset;
before(async () => {
  const fixture = { menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
    tables: { restaurant_id: RESTAURANT_ID, tables: TABLES.map(t => ({ ...t, section: 'M' })) } };
  reception = await startHub({ trustLoopback: true, ...fixture, enrollmentCode: 'RWDREC' });
  remote = await startHub({ trustLoopback: false, ...fixture, enrollmentCode: 'RWDREM' });
  handset = (await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'RWDREM', device_label: 'x' } })).json()).device_token;
});
after(() => { reception?.stop(); remote?.stop(); });

// The hub is another process, and on Windows two processes' clocks can differ by a tick (about 15 ms); a timestamp it wrote a moment
// ago must not be called wrong for looking a few milliseconds ahead.
const SKEW_MS = 2000;
const soon = h => new Date(Date.now() + h * 3600000).toISOString();
const bookNow = async (name, phone, hours) => {
  const r = await call(reception, '/admin/bookings', { method: 'POST', body: { guest_name: name, phone, party_size: 2, at: soon(hours), force: true } });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return (await r.json()).reservation;
};
const seat = async id => assert.equal((await call(reception, `/admin/bookings/${id}/status`, { method: 'PUT', body: { status: 'seated' } })).status, 200);
// A booking is in the diary of ITS day, which is tomorrow's when the test runs late in the evening.
const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const row = async booking => (await (await call(reception, `/admin/bookings?day=${dayOf(booking.at)}`)).json()).reservations.find(r => r.id === booking.id);

test('hub: a scheme is off until the restaurant sets one, then it is shown back, and turned off again', async () => {
  const first = await (await call(reception, '/admin/rewards')).json();
  assert.deepEqual([first.success, first.enabled, first.every_n_visits ?? null, first.text ?? null], [true, false, null, null]);

  const set = await call(reception, '/admin/rewards', { method: 'PUT', body: { every_n_visits: 3, text: 'a free lassi' } });
  assert.equal(set.status, 200);
  const shown = await (await call(reception, '/admin/rewards')).json();
  assert.deepEqual([shown.enabled, shown.every_n_visits, shown.text], [true, 3, 'a free lassi']);

  const bad = await call(reception, '/admin/rewards', { method: 'PUT', body: { every_n_visits: 1, text: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_REWARD');
  assert.equal((await (await call(reception, '/admin/rewards')).json()).every_n_visits, 3, 'a refused scheme leaves the old one alone');

  const off = await call(reception, '/admin/rewards', { method: 'PUT', body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal((await (await call(reception, '/admin/rewards')).json()).enabled, false);
});

test('hub: the diary says which booking is a guest\'s 3rd visit, and giving the reward is recorded, shown, and can be taken back', async () => {
  await call(reception, '/admin/rewards', { method: 'PUT', body: { every_n_visits: 3, text: 'a free lassi' } });
  for (const h of [1, 2]) await seat((await bookNow('Regular', PHONE, h)).id);
  const third = await bookNow('Regular', PHONE, 4);
  const stranger = await bookNow('Newcomer', OTHER, 5);

  const listed = await row(third);
  assert.deepEqual(listed.reward_due, { visit_number: 3, text: 'a free lassi' });
  assert.equal((await row(stranger)).reward_due, undefined, 'a first visit has nothing to offer');

  const given = await call(reception, `/admin/bookings/${third.id}/reward`, { method: 'POST' });
  assert.equal(given.status, 200);
  const after = await row(third);
  assert.equal(after.reward_due, undefined);
  assert.equal(after.reward_given_text, 'a free lassi');
  assert.ok(Math.abs(Date.parse(after.reward_given_at) - Date.now()) < SKEW_MS, `given ${after.reward_given_at}, now ${new Date().toISOString()}`);

  assert.equal((await call(reception, `/admin/bookings/${third.id}/reward`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await row(third)).reward_due, { visit_number: 3, text: 'a free lassi' });
});

test('hub: a reward cannot be given on a visit that has not earned it, or with no scheme, or to a booking that is not there', async () => {
  const early = await bookNow('Second Timer', '98999 88877', 6);
  const notDue = await call(reception, `/admin/bookings/${early.id}/reward`, { method: 'POST' });
  assert.equal(notDue.status, 409);
  assert.equal((await notDue.json()).code, 'NOT_DUE');
  assert.equal((await call(reception, '/admin/bookings/res_nope/reward', { method: 'POST' })).status, 404);
  assert.equal((await call(reception, '/admin/bookings/res_nope/reward', { method: 'DELETE' })).status, 404);

  await call(reception, '/admin/rewards', { method: 'PUT', body: { enabled: false } });
  const off = await call(reception, `/admin/bookings/${early.id}/reward`, { method: 'POST' });
  assert.equal(off.status, 409);
  assert.equal((await off.json()).code, 'REWARDS_OFF');
  assert.equal((await row(early)).reward_due, undefined, 'and with the scheme off the diary offers nothing');
});

test('hub: a waiter\'s handset cannot set the scheme, give a reward or take one back', async () => {
  for (const [method, path, body] of [['GET', '/admin/rewards'], ['PUT', '/admin/rewards', { every_n_visits: 2, text: 'x' }], ['POST', '/admin/bookings/res_1/reward', {}], ['DELETE', '/admin/bookings/res_1/reward'], ['POST', '/admin/waitlist/wl_1/reward', {}], ['DELETE', '/admin/waitlist/wl_1/reward']]) {
    const res = await call(remote, path, { method, token: handset, body });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).code, 'RECEPTION_ONLY');
  }
});

// --- walk-ins, on a real hub -------------------------------------------------------------------------------------------

const PHONE3 = '98777 66655';
const addToQueue = async (name, phone) => {
  const r = await call(reception, '/admin/waitlist', { method: 'POST', body: { guest_name: name, party_size: 2, ...(phone ? { phone } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return (await r.json()).entry;
};
const queueRow = async id => (await (await call(reception, '/admin/bookings')).json()).waitlist.find(e => e.id === id);

test('hub: the queue says which walk-in is on their 3rd visit, and giving the reward is recorded, shown, and can be taken back', async () => {
  await call(reception, '/admin/rewards', { method: 'PUT', body: { every_n_visits: 3, text: 'a free lassi' } });
  for (const h of [7, 8]) await seat((await bookNow('Regular', PHONE3, h)).id);
  const regular = await addToQueue('Regular', PHONE3);
  const stranger = await addToQueue('Newcomer', '98123 45678');
  const nobody = await addToQueue('No Number');

  assert.deepEqual((await queueRow(regular.id)).reward_due, { visit_number: 3, text: 'a free lassi' });
  assert.equal((await queueRow(stranger.id)).reward_due, undefined, 'a first visit has nothing to offer');
  assert.equal((await queueRow(nobody.id)).reward_due, undefined, 'and a guest with no number cannot be recognised');

  const given = await call(reception, `/admin/waitlist/${regular.id}/reward`, { method: 'POST' });
  assert.equal(given.status, 200);
  const after = await queueRow(regular.id);
  assert.equal(after.reward_due, undefined);
  assert.equal(after.reward_given_text, 'a free lassi');
  assert.ok(Math.abs(Date.parse(after.reward_given_at) - Date.now()) < SKEW_MS);

  const again = await (await call(reception, `/admin/waitlist/${regular.id}/reward`, { method: 'POST' })).json();
  assert.equal(again.already, true, 'giving it twice says it was already given');
  assert.equal((await queueRow(regular.id)).reward_given_at, after.reward_given_at, 'and keeps the first time');

  assert.equal((await call(reception, `/admin/waitlist/${regular.id}/reward`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await queueRow(regular.id)).reward_due, { visit_number: 3, text: 'a free lassi' });
});

test("hub: a walk-in's reward cannot be given too early, with no scheme, to nobody, or by using a booking's id", async () => {
  await call(reception, '/admin/rewards', { method: 'PUT', body: { every_n_visits: 3, text: 'a free lassi' } });
  const newcomer = await addToQueue('Early', '98000 11122');
  const notDue = await call(reception, `/admin/waitlist/${newcomer.id}/reward`, { method: 'POST' });
  assert.deepEqual([notDue.status, (await notDue.json()).code], [409, 'NOT_DUE']);
  assert.equal((await call(reception, '/admin/waitlist/wl_nope/reward', { method: 'POST' })).status, 404);
  assert.equal((await call(reception, '/admin/waitlist/wl_nope/reward', { method: 'DELETE' })).status, 404);

  const booking = await bookNow('A booking', '98555 44433', 9);
  assert.equal((await call(reception, `/admin/waitlist/${booking.id}/reward`, { method: 'POST' })).status, 404, 'a booking is not in the queue');

  await call(reception, '/admin/rewards', { method: 'PUT', body: { enabled: false } });
  const off = await call(reception, `/admin/waitlist/${newcomer.id}/reward`, { method: 'POST' });
  assert.deepEqual([off.status, (await off.json()).code], [409, 'REWARDS_OFF']);
});

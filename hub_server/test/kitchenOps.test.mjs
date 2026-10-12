import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startHub } from './helpers/spawnHub.mjs';

import {
  normalizeCourse, groupOf, withCourseState, initCourseState, stationsFor, allGroups, firedItems, heldItems, heldCourses,
  markStationReady, markAllReady, fireCourse, recallTicket, stationView
} from '../lib/courses.js';
import { percentile, stats, collectSamples, prepReport } from '../lib/prepTelemetry.js';
import { renderKot } from '../lib/printer.js';

// ---------------------------------------------------------------------------
// M2 leftovers — course firing, per-station readiness, recall, prep telemetry.
// Fixed timestamps (UTC) so nothing depends on when the suite runs.
// ---------------------------------------------------------------------------

const RID = '11111111-1111-1111-1111-111111111111';
const T = (mm, ss = 0) => `2026-10-02T12:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

const line = (name, station, course, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '_'), name, qty: 1, station, course, ...extra });

function normalTicket(items, over = {}) {
  const t0 = T(0);
  return { id: 't1', ticket_number: 101, restaurant_id: RID, status: 'in_progress', items, created_at: t0, updated_at: t0,
    ...initCourseState(items, { staged: false }, t0), ...over };
}
function stagedTicket(items, over = {}) {
  const t0 = T(0);
  return { id: 't2', ticket_number: 102, restaurant_id: RID, status: 'in_progress', items, created_at: t0, updated_at: t0,
    ...initCourseState(items, { staged: true }, t0), ...over };
}

const MIXED = [line('Dal Tadka', 'hot', 2), line('Masala Chaas', 'bar', 1), line('Veg Crispy', 'hot', 1), line('Gulab Jamun', 'cold', 3)];

test('courses: normalizeCourse accepts 1..9 and defaults everything else to 1', () => {
  assert.equal(normalizeCourse(3), 3);
  assert.equal(normalizeCourse('2'), 2);
  assert.equal(normalizeCourse(2.9), 2);
  for (const bad of [0, 10, -1, 'x', null, undefined, NaN]) assert.equal(normalizeCourse(bad), 1, String(bad));
});

test('courses: a normal ticket is one group fired immediately, whatever the lines\' courses are', () => {
  const t = normalTicket(MIXED);
  assert.equal(t.staged, false);
  assert.deepEqual(t.fired_courses, [1]);
  assert.deepEqual(allGroups(t), [1]);
  assert.equal(firedItems(t).length, 4);
  assert.equal(heldItems(t).length, 0);
  assert.deepEqual(stationsFor(t, 1).sort(), ['bar', 'cold', 'hot']);
});

test('courses: a staged ticket fires only the first course and holds the rest', () => {
  const t = stagedTicket(MIXED);
  assert.equal(t.staged, true);
  assert.deepEqual(t.fired_courses, [1]);
  assert.deepEqual(firedItems(t).map(l => l.name).sort(), ['Masala Chaas', 'Veg Crispy']);
  assert.deepEqual(heldCourses(t).map(h => [h.course, h.items.map(l => l.name)]), [[2, ['Dal Tadka']], [3, ['Gulab Jamun']]]);
  assert.equal(groupOf(t, MIXED[0]), 2);
  // "Serve in courses" on an order with a single course is just a normal ticket.
  const single = initCourseState([line('A', 'hot', 2), line('B', 'hot', 2)], { staged: true }, T(0));
  assert.equal(single.staged, false);
  assert.deepEqual(single.fired_courses, [1]);
  // The first course need not be 1: it is the lowest present.
  const startsAt2 = initCourseState([line('A', 'hot', 2), line('B', 'hot', 3)], { staged: true }, T(0));
  assert.deepEqual(startsAt2.fired_courses, [2]);
});

test('courses: a ticket saved before this feature is filled in without changing its meaning', () => {
  const old = { id: 'o', ticket_number: 1, status: 'ready', items: [line('X', 'hot', 1)], created_at: T(0), updated_at: T(9) };
  const t = withCourseState(old);
  assert.equal(t.staged, false);
  assert.deepEqual(t.fired_courses, [1]);
  assert.equal(t.course_log[1].fired_at, T(0));
  assert.equal(t.course_log[1].ready_at, T(9));
  assert.equal(withCourseState(t), t, 'idempotent');
  const inProgress = withCourseState({ ...old, status: 'in_progress' });
  assert.equal(inProgress.course_log[1].ready_at, undefined);
});

test('stations: the ticket is ready only when every station that has lines on it has reported', () => {
  const t = normalTicket([line('Dal', 'hot', 1), line('Chaas', 'bar', 1)]);

  const bar = markStationReady(t, 'bar', T(5));
  assert.equal(bar.ok, true);
  assert.equal(bar.ticket_ready, false);
  assert.equal(bar.ticket.status, 'in_progress');
  assert.equal(bar.ticket.course_log[1].stations_ready.bar, T(5));

  const again = markStationReady(bar.ticket, 'bar', T(6));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NOTHING_TO_MARK');

  const none = markStationReady(bar.ticket, 'cold', T(6));
  assert.equal(none.code, 'NOTHING_TO_MARK', 'a station with no lines on the ticket has nothing to mark');

  const hot = markStationReady(bar.ticket, 'hot', T(9));
  assert.equal(hot.ticket_ready, true, 'the call that completes the ticket says so, exactly once');
  assert.equal(hot.ticket.status, 'ready');
  assert.equal(hot.ticket.course_log[1].ready_at, T(9));

  assert.equal(markStationReady(hot.ticket, 'hot', T(10)).code, 'ALREADY_READY');
  assert.equal(markStationReady({ ...hot.ticket, status: 'completed' }, 'hot', T(10)).code, 'TICKET_CLOSED');
});

test('stations: a ticket of only hot-line items is ready as soon as the hot line is', () => {
  const t = normalTicket([line('Dal', 'hot', 1), line('Naan', 'hot', 1)]);
  const r = markStationReady(t, 'hot', T(4));
  assert.equal(r.ticket_ready, true);
  assert.equal(r.ticket.status, 'ready');
});

test('stations: the whole-ticket Ready button finishes every station of every fired course', () => {
  const t = stagedTicket(MIXED);
  const r = markAllReady(t, T(7));
  assert.equal(r.ok, true);
  assert.equal(r.ticket.status, 'ready');
  assert.deepEqual(Object.keys(r.ticket.course_log[1].stations_ready).sort(), ['bar', 'hot']);
  assert.equal(r.ticket.course_log[2], undefined, 'held courses are untouched');
  assert.equal(markAllReady({ ...t, status: 'completed' }, T(7)).code, 'TICKET_CLOSED');
  // Idempotent: pressing it again keeps the original ready time.
  assert.equal(markAllReady(r.ticket, T(30)).ticket.course_log[1].ready_at, T(7));
});

test('stations: stationView shows a station only its own fired lines and how many are pending', () => {
  const t = stagedTicket(MIXED);
  assert.deepEqual(stationView(t, 'hot').lines.map(l => l.name), ['Veg Crispy'], 'the held main course is not on the hot screen yet');
  assert.equal(stationView(t, 'bar').pending_count, 1);
  assert.equal(stationView(t, 'cold').lines.length, 0);
  const done = markStationReady(t, 'bar', T(3)).ticket;
  assert.equal(stationView(done, 'bar').done, true);
  assert.equal(stationView(done, 'hot').done, false);
});

test('firing: the next held course is sent, the ticket is cooking again, and the later one stays held', () => {
  let t = stagedTicket(MIXED);
  t = markAllReady(t, T(8)).ticket;
  assert.equal(t.status, 'ready');

  const f = fireCourse(t, undefined, T(15));
  assert.equal(f.ok, true);
  assert.equal(f.fired_course, 2);
  assert.deepEqual(f.fired_items.map(l => l.name), ['Dal Tadka']);
  assert.deepEqual(f.ticket.fired_courses, [1, 2]);
  assert.equal(f.ticket.status, 'in_progress', 'firing a course reopens a ticket that was ready');
  assert.equal(f.ticket.course_log[2].fired_at, T(15));
  assert.deepEqual(heldCourses(f.ticket).map(h => h.course), [3]);

  // Both fired courses must be done before the ticket is ready again.
  const hot = markStationReady(f.ticket, 'hot', T(22));
  assert.equal(hot.ticket_ready, true);
  assert.equal(hot.ticket.course_log[2].ready_at, T(22));
  assert.equal(hot.ticket.course_log[1].ready_at, T(8), 'course 1 keeps its own ready time');

  const last = fireCourse(hot.ticket, 3, T(30));
  assert.equal(last.fired_course, 3);
  assert.equal(fireCourse(last.ticket, undefined, T(31)).code, 'NO_MORE_COURSES');
});

test('firing: refusals are specific', () => {
  const normal = normalTicket(MIXED);
  assert.equal(fireCourse(normal, undefined, T(1)).code, 'NOT_STAGED');
  const t = stagedTicket(MIXED);
  assert.equal(fireCourse(t, 1, T(1)).code, 'ALREADY_FIRED');
  assert.equal(fireCourse(t, 7, T(1)).code, 'UNKNOWN_COURSE');
  assert.equal(fireCourse({ ...t, status: 'completed' }, undefined, T(1)).code, 'TICKET_CLOSED');
  // A specific later course can be fired out of order.
  const skip = fireCourse(t, 3, T(2));
  assert.equal(skip.ok, true);
  assert.deepEqual(skip.ticket.fired_courses, [1, 3]);
  assert.deepEqual(heldCourses(skip.ticket).map(h => h.course), [2]);
});

test('recall: only a ready ticket can be recalled; it reopens just the course made ready last', () => {
  const t = stagedTicket(MIXED);
  assert.equal(recallTicket(t, T(1)).code, 'NOT_READY');

  let s = markAllReady(t, T(8)).ticket;
  s = fireCourse(s, undefined, T(15)).ticket;
  s = markStationReady(s, 'hot', T(22)).ticket;
  assert.equal(s.status, 'ready');

  const r = recallTicket(s, T(23));
  assert.equal(r.ok, true);
  assert.equal(r.recalled_course, 2, 'the main course was the last to be made ready');
  assert.equal(r.ticket.status, 'in_progress');
  assert.equal(r.ticket.course_log[2].ready_at, undefined);
  assert.deepEqual(r.ticket.course_log[2].stations_ready, {});
  assert.equal(r.ticket.course_log[2].recall_count, 1);
  assert.equal(r.ticket.course_log[1].ready_at, T(8), 'the starters stay done');

  const redo = markStationReady(r.ticket, 'hot', T(27));
  assert.equal(redo.ticket_ready, true);
  assert.equal(recallTicket(redo.ticket, T(28)).ticket.course_log[2].recall_count, 2);
  assert.equal(recallTicket({ ...s, status: 'completed' }, T(23)).code, 'TICKET_CLOSED');
});

test('recall: a normal ticket recalls to in_progress and can be marked ready again', () => {
  const t = markAllReady(normalTicket([line('Dal', 'hot', 1)]), T(5)).ticket;
  const r = recallTicket(t, T(6));
  assert.equal(r.ticket.status, 'in_progress');
  assert.equal(markStationReady(r.ticket, 'hot', T(9)).ticket_ready, true);
});

test('printing: a course banner and a held-items note appear on the KOT only when given', () => {
  const t = { ...normalTicket([line('Veg Crispy', 'hot', 1)]), table_name: 'T5' };
  const plain = renderKot(t);
  assert.doesNotMatch(plain.preview_text, /COURSE|On hold/);
  const fired = renderKot(t, {}, { course_label: 'Course 2 - fire now', held_summary: 'On hold: course 3 (1 item)' });
  assert.match(fired.preview_text, /\*\*\* COURSE 2 - FIRE NOW \*\*\*/);
  assert.match(fired.preview_text, /On hold: course 3 \(1 item\)/);
  assert.ok(Buffer.isBuffer(fired.escpos));
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test('telemetry: nearest-rank percentiles and empty input', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 90), 90);
  assert.equal(percentile(v, 100), 100);
  assert.equal(percentile(v, 1), 10);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(stats([]), { n: 0, avg: null, p50: null, p90: null, max: null });
  assert.deepEqual(stats([60, 120, 180, NaN, undefined]), { n: 3, avg: 120, p50: 120, p90: 180, max: 180 });
});

function finishedTicket(id, over, ready) {
  let t = { ...normalTicket([line('Dal Tadka', 'hot', 1), line('Masala Chaas', 'bar', 1)], { id, ticket_number: Number(id.slice(1)) }), ...over };
  for (const [st, at] of Object.entries(ready)) t = markStationReady(t, st, at).ticket;
  return t;
}

test('telemetry: samples are fired-to-ready, overall by the slowest station, per station and per item', () => {
  const t = finishedTicket('t1', {}, { bar: T(4), hot: T(10) }); // fired at T(0): bar 240s, hot 600s
  const s = collectSamples([t], RID);
  assert.deepEqual(s.overall, [600]);
  assert.deepEqual(s.station.bar, [240]);
  assert.deepEqual(s.station.hot, [600]);
  assert.deepEqual([...s.items.values()].map(i => [i.name, i.station, i.secs]).sort(), [['Dal Tadka', 'hot', [600]], ['Masala Chaas', 'bar', [240]]]);
});

test('telemetry: unfinished tickets, other tenants and out-of-window tickets are not counted', () => {
  const done = finishedTicket('t1', {}, { bar: T(4), hot: T(10) });
  const cooking = finishedTicket('t2', {}, { bar: T(4) });            // hot not ready yet
  const other = finishedTicket('t3', { restaurant_id: 'other' }, { bar: T(4), hot: T(10) });
  const lateFire = finishedTicket('t4', { course_log: { 1: { fired_at: T(40), stations_ready: {} } } }, {});
  const r = collectSamples([done, cooking, other, lateFire], RID, { fromMs: Date.parse(T(0)), toMs: Date.parse(T(30)) });
  assert.equal(r.overall.length, 1);
  // A course that is still cooking contributes nothing, not even its finished bar part.
  assert.deepEqual(r.station.bar, [240]);
  assert.deepEqual(r.station.hot, [600]);
});

test('telemetry: report sorts items slowest first, aggregates stations, and counts recalls', () => {
  const a = finishedTicket('t1', {}, { bar: T(2), hot: T(10) });
  const b = finishedTicket('t2', {}, { bar: T(4), hot: T(14) });
  let c = finishedTicket('t3', {}, { bar: T(3), hot: T(6) });
  c = recallTicket(c, T(7)).ticket;
  c = markStationReady(c, 'bar', T(8)).ticket;
  c = markStationReady(c, 'hot', T(9)).ticket;
  const rep = prepReport([a, b, c], RID);
  assert.equal(rep.recalls, 1);
  assert.equal(rep.by_item[0].name, 'Dal Tadka');
  assert.equal(rep.by_item[0].n, 3);
  assert.equal(rep.by_item[0].avg, Math.round((600 + 840 + 540) / 3));
  assert.equal(rep.by_station.hot.max, 840);
  assert.equal(rep.by_station.bar.n, 3);
  assert.equal(rep.overall.n, 3);
});

// ---------------------------------------------------------------------------
// Live hub: staged order, per-station ready, fire, recall, telemetry, printing.
// ---------------------------------------------------------------------------



const MENU = {
  restaurant_id: RID,
  categories: ['Starters', 'Mains', 'Drinks'],
  items: [
    { id: 's1', name: 'Veg Crispy', price: 220, category: 'Starters', isVeg: true, available: true, station: 'hot', course: 1 },
    { id: 'm1', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true, station: 'hot', course: 2 },
    { id: 'd1', name: 'Masala Chaas', price: 50, category: 'Drinks', isVeg: true, available: true, station: 'bar', course: 1 }
  ]
};

let hub;
const sinks = {};
const sink = name => new Promise(resolve => {
  const chunks = [];
  const server = net.createServer(sock => {
    sock.on('data', d => chunks.push(d));
    sock.on('error', () => {}); // the hub is killed at the end of the run; a reset then is expected
  });
  server.listen(0, '127.0.0.1', () => {
    sinks[name] = { server, port: server.address().port, text: () => Buffer.concat(chunks).toString('latin1') };
    resolve();
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));
// Wait for something to happen on the hub (a ticket reaching a printer) instead of sleeping a fixed time,
// which is what made these tests flaky when the machine was busy.
const until = async (check, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 40));
  }
};
const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async res => res.json();

before(async () => {
  await sink('hot');
  await sink('bar');
  // The sinks are already listening, so their ports can go straight into the hub's config.
  hub = await startHub({
    trustLoopback: true,
    menu: MENU,
    tables: { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }, { id: 2, name: 'T2', section: 'M', capacity: 4 }] },
    enrollmentCode: 'KITCODE',
    config: {
      restaurant_id: RID,
      pairing_code: 'KIT-0001',
      printers: [
        { id: 'hot-line', role: 'kot', host: '127.0.0.1', port: sinks.hot.port, station: 'hot' },
        { id: 'bar-line', role: 'kot', host: '127.0.0.1', port: sinks.bar.port, station: 'bar' }
      ]
    }
  });
});

after(() => {
  hub?.stop();
  for (const s of Object.values(sinks)) s.server.close();
});

let staged;
test('hub: an order served in courses fires course 1 only, and the KOTs say so', async () => {
  const res = await call('/orders', {
    method: 'POST',
    body: { table_id: 1, table_name: 'T1', course_service: true, items: [{ id: 's1', qty: 1 }, { id: 'm1', qty: 1 }, { id: 'd1', qty: 2 }] }
  });
  assert.equal(res.status, 201);
  staged = (await json(res)).ticket;
  assert.equal(staged.staged, true);
  assert.deepEqual(staged.fired_courses, [1]);
  assert.deepEqual(staged.items.map(i => [i.name, i.course]).sort(), [['Dal Tadka', 2], ['Masala Chaas', 1], ['Veg Crispy', 1]]);

  await until(() => /Veg Crispy/.test(sinks.hot.text()) && /Masala Chaas/.test(sinks.bar.text()));
  const hot = sinks.hot.text();
  const bar = sinks.bar.text();
  assert.match(hot, /Veg Crispy/);
  assert.doesNotMatch(hot, /Dal Tadka/, 'the main course is held, so it is not on the hot printer yet');
  assert.match(hot, /COURSE 1/);
  assert.match(hot, /On hold: course 2 \(1 item\)/);
  assert.match(bar, /Masala Chaas/);
});

test('hub: the ticket becomes ready only when every station has reported', async () => {
  const barRes = await call(`/orders/${staged.id}/stations/bar/ready`, { method: 'POST' });
  assert.equal(barRes.status, 200);
  const barBody = await json(barRes);
  assert.equal(barBody.ticket_ready, false);
  assert.equal(barBody.ticket.status, 'in_progress');

  assert.equal((await call(`/orders/${staged.id}/stations/bar/ready`, { method: 'POST' })).status, 409, 'bar already reported');

  const hotBody = await json(await call(`/orders/${staged.id}/stations/hot/ready`, { method: 'POST' }));
  assert.equal(hotBody.ticket_ready, true);
  assert.equal(hotBody.ticket.status, 'ready');

  const active = await json(await call('/orders/active'));
  assert.equal(active.tickets.find(t => t.id === staged.id).status, 'ready');
});

test('hub: station endpoint rejects an unknown station and an unknown ticket', async () => {
  const bad = await call(`/orders/${staged.id}/stations/garnish/ready`, { method: 'POST' });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'INVALID_STATION');
  assert.equal((await call('/orders/nope/stations/hot/ready', { method: 'POST' })).status, 404);
});

test('hub: firing the next course sends it to the kitchen and puts the table back to cooking', async () => {
  const before_ = sinks.hot.text().length;
  const res = await call(`/orders/${staged.id}/fire`, { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.fired_course, 2);
  assert.equal(body.ticket.status, 'in_progress');
  assert.deepEqual(body.ticket.fired_courses, [1, 2]);

  await until(() => /COURSE 2 - FIRE NOW/.test(sinks.hot.text().slice(before_)));
  const fresh = sinks.hot.text().slice(before_);
  assert.match(fresh, /Dal Tadka/);
  assert.match(fresh, /COURSE 2 - FIRE NOW/);
  assert.doesNotMatch(fresh, /Veg Crispy/, 'only the newly fired course is printed');

  const tables = await json(await call('/tables'));
  assert.equal(tables.tables.find(t => t.id === 1).status, 'kot', 'the waiter sees the table cooking again');

  const again = await call(`/orders/${staged.id}/fire`, { method: 'POST', body: {} });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'NO_MORE_COURSES');
});

test('hub: recall needs a ready ticket, then puts it back on the board', async () => {
  const notReady = await call(`/orders/${staged.id}/recall`, { method: 'POST' });
  assert.equal(notReady.status, 409);
  assert.equal((await json(notReady)).code, 'NOT_READY');

  const ready = await json(await call(`/orders/${staged.id}/stations/hot/ready`, { method: 'POST' }));
  assert.equal(ready.ticket_ready, true);

  const recall = await call(`/orders/${staged.id}/recall`, { method: 'POST' });
  assert.equal(recall.status, 200);
  const body = await json(recall);
  assert.equal(body.recalled_course, 2);
  assert.equal(body.ticket.status, 'in_progress');
  assert.equal((await call('/orders/nope/recall', { method: 'POST' })).status, 404);

  await call(`/orders/${staged.id}/stations/hot/ready`, { method: 'POST' });
});

test('hub: a normal order is untouched — everything fires at once and the whole-ticket Ready still works', async () => {
  const res = await call('/orders', { method: 'POST', body: { table_id: 2, table_name: 'T2', items: [{ id: 's1', qty: 1 }, { id: 'm1', qty: 1 }, { id: 'd1', qty: 1 }] } });
  assert.equal(res.status, 201);
  const t = (await json(res)).ticket;
  assert.equal(t.staged, false);
  assert.deepEqual(t.fired_courses, [1]);
  assert.equal((await call(`/orders/${t.id}/fire`, { method: 'POST', body: {} })).status, 409, 'not served in courses');

  const ready = await call(`/orders/${t.id}/ready`, { method: 'POST' });
  assert.equal(ready.status, 200);
  assert.equal((await json(ready)).ticket.status, 'ready');
});

test('hub: GET /menu carries each item\'s course', async () => {
  const menu = await json(await call('/menu'));
  assert.equal(menu.items.find(i => i.id === 'm1').course, 2);
});

test('hub: prep telemetry reports the finished courses by station and item, and validates the range', async () => {
  const res = await call('/telemetry/prep');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.ok(body.overall.n >= 2, 'both orders produced finished courses');
  assert.ok(body.by_station.hot && body.by_station.bar);
  assert.ok(body.by_item.some(i => i.name === 'Dal Tadka'));
  assert.equal(body.recalls, 1);

  const empty = await json(await call('/telemetry/prep?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z'));
  assert.equal(empty.overall.n, 0);
  assert.equal((await call('/telemetry/prep?from=garbage')).status, 400);
});

// ---------------------------------------------------------------------------
// The serving course through the catalog: normaliser, admin validation, editor form.
// ---------------------------------------------------------------------------

import { normalizeCloudMenuItem, normalizeCourseField } from '../lib/menuNormalize.js';
import { addItem, updateItem } from '../lib/menuAdmin.js';
import { blankForm, itemToForm, formToPayload, validateForm } from '../../src/admin/lib/itemForm.js';

test('catalog: normalizeCourseField keeps only a whole number from 1 to 9', () => {
  assert.equal(normalizeCourseField(2), 2);
  assert.equal(normalizeCourseField('3'), 3);
  assert.equal(normalizeCourseField(2.7), 2);
  for (const bad of [0, 10, -1, 'x', null, undefined, '', NaN]) assert.equal(normalizeCourseField(bad), undefined, String(bad));
});

test('catalog: a cloud menu row carries its course through to the cache shape, and omits it when unset', () => {
  assert.equal(normalizeCloudMenuItem({ id: 'a', name: 'Soup', price: 100, course: 1 }).course, 1);
  assert.equal(normalizeCloudMenuItem({ id: 'b', name: 'Cake', price: 100, course: 3 }).course, 3);
  assert.equal('course' in normalizeCloudMenuItem({ id: 'c', name: 'Tea', price: 20 }), false);
  assert.equal('course' in normalizeCloudMenuItem({ id: 'd', name: 'Tea', price: 20, course: 99 }), false);
});

test('catalog: the admin API accepts a valid course, rejects an invalid one, and can change it later', () => {
  const menu = () => ({ restaurant_id: 'r', revision: 1, categories: ['Mains'], items: [{ id: 'm1', name: 'Dal', price: 190, category: 'Mains', isVeg: true, available: true }] });
  const ok = addItem(menu(), { name: 'Cake', category: 'Desserts', price: 90, isVeg: true, course: '3' });
  assert.equal(ok.ok, true);
  assert.equal(ok.meta.item.course, 3);

  const bad = addItem(menu(), { name: 'Cake', category: 'Desserts', price: 90, isVeg: true, course: 12 });
  assert.equal(bad.ok, false);
  assert.ok(JSON.stringify(bad).includes('course'));

  const edited = updateItem(menu(), 'm1', { course: 2 });
  assert.equal(edited.ok, true);
  assert.equal(edited.meta.item.course, 2);
});

test('catalog: the editor form round-trips the course and leaves it out when blank', () => {
  assert.equal(blankForm('Mains').course, '');
  const f = itemToForm({ id: 'm1', name: 'Dal', category: 'Mains', price: 190, isVeg: true, available: true, course: 2 });
  assert.equal(f.course, '2');
  assert.equal(formToPayload({ ...f, name: 'Dal', category: 'Mains', price: '190', isVeg: true }).course, 2);

  const legacy = itemToForm({ id: 'm2', name: 'Tea', category: 'Drinks', price: 20, isVeg: true, available: true });
  assert.equal(legacy.course, '');
  assert.equal('course' in formToPayload({ ...legacy, price: '20' }), false);

  const v = validateForm({ ...blankForm('A'), name: 'X', isVeg: true, price: '10', course: '12' });
  assert.ok(JSON.stringify(v).includes('Choose a course from 1 to 9'));
});

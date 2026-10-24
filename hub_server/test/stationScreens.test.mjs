import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocket } from 'ws';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';
import { StationScreens, STATIONS, parseScreen, backlog, snapshot } from '../lib/stationScreens.js';
import { initCourseState, markStationReady, fireCourse } from '../lib/courses.js';

// Station screens: a tablet at the hot line, cold line or bar that has been told which station it is.
// The rules first (what a screen may declare, what counts as waiting), then a real hub.

const url = q => new URL(`/live${q}`, 'http://hub');
const T0 = '2026-10-19T12:00:00.000Z';
const T1 = '2026-10-19T12:05:00.000Z';
const line = (name, station, course = 1, qty = 1) => ({ id: name.toLowerCase().replace(/\W+/g, '_'), name, qty, station, course });
const ticket = (items, { staged = false, id = 't1', over = {} } = {}) => ({
  id, ticket_number: 101, restaurant_id: RESTAURANT_ID, status: 'in_progress', items, created_at: T0, updated_at: T0,
  ...initCourseState(items, { staged }, T0), ...over
});

// --- what a screen may declare ---------------------------------------------------------------

test('parseScreen: a known station is accepted, in any case', () => {
  assert.deepEqual(parseScreen(url('?station=bar')), { station: 'bar', label: '' });
  assert.deepEqual(parseScreen(url('?station=HOT')), { station: 'hot', label: '' });
  assert.deepEqual(parseScreen(url('?station=%20cold%20')), { station: 'cold', label: '' });
});

test('parseScreen: no station, or one the hub does not know, is not a station screen', () => {
  assert.equal(parseScreen(url('')), null, 'the reception Kitchen Display declares nothing');
  assert.equal(parseScreen(url('?token=abc')), null);
  for (const bad of ['garnish', '', 'all', 'hot,bar', '../bar', 'ba r']) assert.equal(parseScreen(url(`?station=${encodeURIComponent(bad)}`)), null, bad);
  assert.equal(parseScreen(null), null);
  assert.equal(parseScreen({}), null);
});

test('parseScreen: a label is tidied and cut short, since reception reads it', () => {
  assert.equal(parseScreen(url('?station=bar&label=Left%20%20bar%20%20tablet')).label, 'Left bar tablet');
  assert.equal(parseScreen(url(`?station=bar&label=${'x'.repeat(200)}`)).label.length, 30);
  assert.equal(parseScreen(url('?station=bar&label=%20%20')).label, '');
});

// --- the registry ----------------------------------------------------------------------------

test('registry: counts every station, at zero where nothing is up', () => {
  const r = new StationScreens();
  assert.deepEqual(r.counts(), { hot: 0, cold: 0, bar: 0 });
  const a = {}; const b = {}; const c = {};
  r.add(a, { station: 'bar', label: 'Left' });
  r.add(b, { station: 'bar', label: 'Right' });
  r.add(c, { station: 'hot', label: '' });
  assert.deepEqual(r.counts(), { hot: 1, cold: 0, bar: 2 });
  assert.equal(r.remove(a), true);
  assert.deepEqual(r.counts(), { hot: 1, cold: 0, bar: 1 });
  assert.equal(r.remove(a), false, 'removing twice is harmless');
});

test('registry: the list says who is connected and since when', () => {
  const r = new StationScreens();
  r.add({}, { station: 'cold', label: 'Salad' }, new Date(T0));
  assert.deepEqual(r.list(), [{ station: 'cold', label: 'Salad', since: T0 }]);
});

test('the stations are exactly the ones the hub routes to', () => {
  assert.deepEqual([...STATIONS].sort(), ['bar', 'cold', 'hot']);
});

// --- what is waiting -------------------------------------------------------------------------

test('backlog: counts tickets and items per station, summing quantities', () => {
  const b = backlog([
    ticket([line('Dal', 'hot', 1, 2), line('Chaas', 'bar', 1, 3)], { id: 'a' }),
    ticket([line('Naan', 'hot')], { id: 'b' })
  ]);
  assert.deepEqual(b.hot, { tickets: 2, items: 3 });
  assert.deepEqual(b.bar, { tickets: 1, items: 3 });
  assert.deepEqual(b.cold, { tickets: 0, items: 0 });
});

test('backlog: a course that has not been fired is not waiting', () => {
  const staged = ticket([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true });
  assert.deepEqual(backlog([staged]).hot, { tickets: 1, items: 1 }, 'only the starter has been sent');
  const fired = fireCourse(staged, 2, T1).ticket;
  assert.deepEqual(backlog([fired]).hot, { tickets: 1, items: 2 }, 'now both are');
});

test('backlog: a station that has reported its part is no longer waiting, the others still are', () => {
  const t = ticket([line('Dal', 'hot'), line('Chaas', 'bar')]);
  const afterBar = markStationReady(t, 'bar', T1).ticket;
  const b = backlog([afterBar]);
  assert.deepEqual(b.bar, { tickets: 0, items: 0 });
  assert.deepEqual(b.hot, { tickets: 1, items: 1 });
});

test('backlog: only that course counts as done when a later one is still being cooked', () => {
  let t = ticket([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true });
  t = markStationReady(t, 'hot', T1).ticket;            // starter done
  assert.deepEqual(backlog([t]).hot, { tickets: 0, items: 0 });
  t = fireCourse(t, 2, T1).ticket;                      // main sent
  assert.deepEqual(backlog([t]).hot, { tickets: 1, items: 1 }, 'the main is waiting even though the starter is done');
});

test('backlog: closed tickets, junk, and tickets from before courses are handled', () => {
  assert.deepEqual(backlog(undefined).hot, { tickets: 0, items: 0 });
  assert.deepEqual(backlog([null, undefined, {}]).hot, { tickets: 0, items: 0 });
  assert.equal(backlog([ticket([line('Dal', 'hot')], { over: { status: 'completed' } })]).hot.tickets, 0);
  const old = { id: 'o', ticket_number: 1, status: 'in_progress', items: [line('Dal', 'hot')], created_at: T0, updated_at: T0 };
  assert.deepEqual(backlog([old]).hot, { tickets: 1, items: 1 });
});

test('snapshot: label, screens up and what is waiting, for every station', () => {
  const r = new StationScreens();
  r.add({}, { station: 'hot', label: '' });
  const s = snapshot(r, [ticket([line('Dal', 'hot'), line('Chaas', 'bar')])]);
  assert.deepEqual(s.hot, { label: 'Hot line', online: 1, waiting_tickets: 1, waiting_items: 1 });
  assert.deepEqual(s.bar, { label: 'Bar', online: 0, waiting_tickets: 1, waiting_items: 1 });
  assert.deepEqual(s.cold, { label: 'Cold line', online: 0, waiting_tickets: 0, waiting_items: 0 });
});

// --- a real hub ------------------------------------------------------------------------------

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Mains', 'Drinks'],
  items: [
    { id: 'd1', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true, station: 'hot' },
    { id: 'b1', name: 'Masala Chaas', price: 90, category: 'Drinks', isVeg: true, available: true, station: 'bar' }
  ]
};
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] };

let reception;     // trustLoopback: this is the reception laptop
let remote;        // trustLoopback false: every caller is a tablet that must carry a token
let distDir;
before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-dist-'));
  fs.writeFileSync(path.join(distDir, 'station.html'), '<!doctype html><title>Station</title><div id="root"></div>');
  // A short heartbeat so the dead-connection test below does not have to wait half a minute.
  reception = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'STATIONCODE', env: { HUB_DIST_DIR: distDir, HUB_WS_HEARTBEAT_MS: '300' } });
  remote = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'TABLETCODE', env: { HUB_DIST_DIR: distDir } });
});
after(() => {
  reception?.stop();
  remote?.stop();
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

const call = (hub, p, { method = 'GET', body, token } = {}) =>
  fetch(`${hub.base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
const screens = async () => (await (await call(reception, '/kds/screens')).json());
const until = async (check, ms = 6000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await new Promise(r => setTimeout(r, 60));
  }
};
const open = (hub, query = '', token) =>
  new Promise((resolve, reject) => {
    const q = [query.replace(/^\?/, ''), token ? `token=${token}` : ''].filter(Boolean).join('&');
    const ws = new WebSocket(`${hub.base.replace('http', 'ws')}/live${q ? `?${q}` : ''}`);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
const close = ws => new Promise(r => { ws.once('close', r); ws.close(); });

test('hub: a screen that declares its station is counted, and one that does not is not', async () => {
  assert.deepEqual((await screens()).stations.bar.online, 0);

  const bar = await open(reception, '?station=bar&label=Left%20bar');
  const plain = await open(reception);                                  // the Kitchen Display on the laptop
  const unknown = await open(reception, '?station=garnish');            // not a station the hub has

  const up = await until(async () => { const s = await screens(); return s.stations.bar.online === 1 ? s : null; });
  assert.ok(up, 'the bar screen shows up');
  assert.deepEqual([up.stations.hot.online, up.stations.cold.online, up.stations.bar.online], [0, 0, 1]);
  assert.deepEqual(up.screens.map(s => [s.station, s.label]), [['bar', 'Left bar']]);

  for (const ws of [bar, plain, unknown]) await close(ws);
});

test('hub: a screen going away stops being counted, and two screens at one station both are', async () => {
  const a = await open(reception, '?station=hot');
  const b = await open(reception, '?station=hot');
  assert.equal((await until(async () => { const s = await screens(); return s.stations.hot.online === 2 ? s : null; }))?.stations.hot.online, 2);

  await close(a);
  assert.equal((await until(async () => { const s = await screens(); return s.stations.hot.online === 1 ? s : null; }))?.stations.hot.online, 1);
  await close(b);
  assert.equal((await until(async () => { const s = await screens(); return s.stations.hot.online === 0 ? s : null; }))?.stations.hot.online, 0);
});

test('hub: a screen that stops answering is dropped, so a tablet that fell off the wifi is not counted as up', async () => {
  // A tablet that vanishes does not say goodbye: its connection just goes quiet. `autoPong: false` is a
  // client that never answers the hub's pings, which is what that looks like from the hub's side.
  const silent = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${reception.base.replace('http', 'ws')}/live?station=cold&label=Asleep`, { autoPong: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const answering = await open(reception, '?station=cold&label=Awake');

  const both = await until(async () => { const s = await screens(); return s.stations.cold.online === 2 ? s : null; });
  assert.ok(both, 'both are counted at first');

  // After a couple of heartbeats the silent one is gone; the one that answers is still there.
  const after = await until(async () => { const s = await screens(); return s.stations.cold.online === 1 ? s : null; });
  assert.ok(after, 'the silent screen was dropped');
  assert.deepEqual(after.screens.filter(s => s.station === 'cold').map(s => s.label), ['Awake']);

  // And it stays: an answering screen is not dropped on a later round either.
  await new Promise(r => setTimeout(r, 900));
  assert.equal((await screens()).stations.cold.online, 1);
  await close(answering);
  silent.terminate();
});

test('hub: reception sees what is waiting at a station with nobody looking at it', async () => {
  const placed = await call(reception, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'd1', qty: 2 }, { id: 'b1', qty: 3 }] } });
  assert.equal(placed.status, 201);
  const t = (await placed.json()).ticket;

  const s = (await screens()).stations;
  assert.deepEqual([s.hot.online, s.hot.waiting_tickets, s.hot.waiting_items], [0, 1, 2], 'hot has work and no screen');
  assert.deepEqual([s.bar.online, s.bar.waiting_tickets, s.bar.waiting_items], [0, 1, 3]);

  assert.equal((await call(reception, `/orders/${t.id}/stations/bar/ready`, { method: 'POST' })).status, 200);
  const after = (await screens()).stations;
  assert.equal(after.bar.waiting_tickets, 0, 'the bar reported its part');
  assert.equal(after.hot.waiting_tickets, 1, 'the hot line has not');

  await call(reception, `/orders/${t.id}/stations/hot/ready`, { method: 'POST' });
});

test('hub: /kds/screens is reception-only -- a stranger and an enrolled tablet are both refused', async () => {
  const enrolled = await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'TABLETCODE', device_label: 'Bar tablet' } })).json();
  assert.ok(enrolled.device_token);
  for (const token of [undefined, enrolled.device_token]) {
    const res = await call(remote, '/kds/screens', { token });
    assert.ok([401, 403].includes(res.status), `status ${res.status}`);
  }
});

// --- the code a tablet scans ----------------------------------------------------------------

test('hub: the station code carries the station page and the enrollment code, and only reception can fetch it', async () => {
  const res = await call(reception, '/qr/station/bar');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.station, 'bar');
  assert.equal(body.label, 'Bar');
  assert.equal(body.enrollment_code, 'STATIONCODE');
  assert.match(body.station_url, /^http:\/\/[\d.]+:\d+\/station\/bar$/);

  // The image has to encode exactly the page plus the enrollment code in its fragment.
  const expected = await QRCode.toDataURL(`${body.station_url}#e=STATIONCODE`, { width: 384, margin: 2, errorCorrectionLevel: 'M' });
  assert.equal(body.qr_code, expected);
  assert.match(body.qr_code, /^data:image\/png;base64,/);

  assert.equal((await call(remote, '/qr/station/bar')).status, 403, 'a stranger gets nothing');
});

test('hub: asking for a station that does not exist is a clear refusal, not a code for nowhere', async () => {
  const res = await call(reception, '/qr/station/garnish');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'UNKNOWN_STATION');
  assert.equal((await call(reception, '/qr/station/BAR')).status, 200, 'case does not matter');
});

// --- the page -------------------------------------------------------------------------------

test('hub: each station has a page, and an unknown one is a plain 404', async () => {
  for (const s of ['hot', 'cold', 'bar', 'BAR']) {
    const res = await call(reception, `/station/${s}`);
    assert.equal(res.status, 200, s);
    assert.match(await res.text(), /<title>Station<\/title>/);
  }
  const no = await call(reception, '/station/garnish');
  assert.equal(no.status, 404);
  assert.match(await no.text(), /No such station/);
});

test('hub: the page itself is public like /waiter -- it carries nothing, the data routes carry the auth', async () => {
  const res = await call(remote, '/station/bar');
  assert.equal(res.status, 200);
});

test('hub: with no build, the page says so rather than serving the wrong thing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'station-empty-'));
  const hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, env: { HUB_DIST_DIR: empty } });
  try {
    const res = await call(hub, '/station/bar');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /has not been built yet/);
  } finally {
    hub.stop();
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// --- the reason this exists -----------------------------------------------------------------

test('hub: a station tablet that is not the reception laptop can load its tickets and mark its part ready -- with a token', async () => {
  // Before station screens, the Kitchen Display sent no token, so on any device other than the
  // reception laptop its first request was a 401 and the live feed was refused.
  const enrolled = await (await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'TABLETCODE', device_label: 'Bar tablet' } })).json();
  const token = enrolled.device_token;

  const placed = await call(remote, '/orders', { method: 'POST', token, body: { table_id: 1, table_name: 'T1', items: [{ id: 'b1', qty: 1 }] } });
  assert.equal(placed.status, 201);
  const t = (await placed.json()).ticket;

  assert.equal((await call(remote, '/orders/active')).status, 401, 'with no token it is refused, as it always was');
  const active = await call(remote, '/orders/active', { token });
  assert.equal(active.status, 200);
  assert.ok((await active.json()).tickets.some(x => x.id === t.id));

  await assert.rejects(() => open(remote, '?station=bar'), e => e.status === 401, 'the live feed is refused without a token');
  const ws = await open(remote, '?station=bar&label=Bar%20tablet', token);
  const heard = [];
  ws.on('message', m => { try { heard.push(JSON.parse(m.toString()).type); } catch { /* ignore */ } });

  const ready = await call(remote, `/orders/${t.id}/stations/bar/ready`, { method: 'POST', token });
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ticket_ready, true, 'the bar was the only station on that ticket');
  await until(() => heard.includes('TICKET_READY'));
  assert.ok(heard.includes('TICKET_READY'), 'and the tablet hears about it over the live feed');
  await close(ws);
});

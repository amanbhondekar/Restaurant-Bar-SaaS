import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, sendReport, createHeartbeatRunner, makeCollector } from '../lib/heartbeat.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// The hub's report on itself (§4.9): every few minutes it tells the cloud it is alive, and how its sync is doing, so that the operator can see
// which restaurants have gone quiet. Until now the only sign of life the cloud had was a bill arriving, which on a quiet day is no sign.
//
// What matters here: the report says only what a screen of counts and times can say (never a name, a token or a bill); what the hub does not
// know is said as nothing rather than as a comfortable zero; a failed report is a failure and is remembered as one, never as success; and
// it can never take the hub down, since it runs from a timer.

const RID = 'r-uuid';
const NOW = new Date('2026-10-24T09:00:00.000Z');
const KNOWN = {
  now: NOW, startedAt: '2026-10-24T06:00:00.000Z', version: '1.0.0',
  sync: { queued: 3, quarantined: 1, last_synced_at: '2026-10-24T08:58:00.000Z' }, devices: 2, waiters: 4
};

// --- the report ------------------------------------------------------------------------------------------------------------

test('the report is the row the cloud keeps: when, since when, which version, what is waiting, and how big the floor is', () => {
  assert.deepEqual(buildReport(KNOWN), {
    reported_at: '2026-10-24T09:00:00.000Z', started_at: '2026-10-24T06:00:00.000Z', version: '1.0.0',
    queued: 3, quarantined: 1, last_synced_at: '2026-10-24T08:58:00.000Z', devices: 2, waiters: 4
  });
});

test('the time is when the report is made, as a moment', () => {
  assert.equal(buildReport({ ...KNOWN, now: new Date('2026-10-24T09:30:15.250Z') }).reported_at, '2026-10-24T09:30:15.250Z');
  assert.ok(Math.abs(Date.parse(buildReport({}).reported_at) - Date.now()) < 5000, 'now, when no time is given');
});

test('what the hub does not know is said as nothing, not as a time that never was', () => {
  const r = buildReport({ now: NOW, sync: {} });
  assert.deepEqual([r.started_at, r.last_synced_at, r.version], [null, null, null]);
  // A bare number is not a time: Date.parse('5') is a day in 2001, and a hub that reported that would be believed.
  for (const bad of [null, undefined, '', 'yesterday', 'x', {}, [], 5, 20261024, 1761307200000, true]) {
    const r2 = buildReport({ now: NOW, startedAt: bad, sync: { last_synced_at: bad } });
    assert.deepEqual([r2.started_at, r2.last_synced_at], [null, null], JSON.stringify(bad));
  }
  assert.deepEqual([buildReport({ now: NOW, sync: null }).queued, buildReport({ now: NOW }).queued], [0, 0], 'a hub with no queue to ask has nothing queued');
});

test('a time given in another way is the same moment', () => {
  const r = buildReport({ now: NOW, startedAt: '2026-10-24T11:30:00+05:30', sync: { last_synced_at: new Date('2026-10-24T08:58:00Z') } });
  assert.deepEqual([r.started_at, r.last_synced_at], ['2026-10-24T06:00:00.000Z', '2026-10-24T08:58:00.000Z']);
});

test('a count is a whole number, never negative: whatever is not one is nothing', () => {
  const counts = value => { const r = buildReport({ now: NOW, sync: { queued: value, quarantined: value }, devices: value, waiters: value }); return [r.queued, r.quarantined, r.devices, r.waiters]; };
  assert.deepEqual(counts(7), [7, 7, 7, 7]);
  assert.deepEqual(counts('5'), [5, 5, 5, 5], 'a number written as text');
  assert.deepEqual(counts(3.9), [3, 3, 3, 3]);
  assert.deepEqual(counts(0), [0, 0, 0, 0]);
  for (const bad of [-1, -0.5, NaN, Infinity, -Infinity, undefined, null, 'many', {}, [], true]) assert.deepEqual(counts(bad), [0, 0, 0, 0], String(bad));
});

test('a version is a short string: trimmed, cut where the cloud cuts it, and nothing at all if it is not one', () => {
  assert.equal(buildReport({ now: NOW, version: '  1.2.3  ' }).version, '1.2.3');
  assert.equal(buildReport({ now: NOW, version: 'v'.repeat(60) }).version, 'v'.repeat(40));
  for (const bad of [undefined, null, '', '   ', 5, {}, ['1.0.0']]) assert.equal(buildReport({ now: NOW, version: bad }).version, null, JSON.stringify(bad));
});

test('the report holds these eight things and no others: what is handed over beyond them is not sent', () => {
  const report = buildReport({ ...KNOWN, token: 'secret', pin: '1234', guest: 'Asha', sync: { ...KNOWN.sync, orders: [{ id: 1 }], online: true } });
  assert.deepEqual(Object.keys(report).sort(), ['devices', 'last_synced_at', 'quarantined', 'queued', 'reported_at', 'started_at', 'version', 'waiters']);
});

// --- sending it --------------------------------------------------------------------------------------------------------------

test('sending writes the hub\'s one row, under the restaurant it is told, and says it worked', async () => {
  const cloud = memoryCloud();
  assert.deepEqual(await sendReport(cloud, RID, buildReport(KNOWN)), { ok: true });
  assert.deepEqual(cloud.calls.upserts.map(u => [u.table, u.onConflict, u.row.restaurant_id]), [['hub_status', 'restaurant_id', RID]]);
  assert.deepEqual(cloud.tables.hub_status[0].queued, 3);
  await sendReport(cloud, RID, buildReport({ ...KNOWN, sync: { ...KNOWN.sync, queued: 9 } }));
  assert.equal(cloud.tables.hub_status.length, 1, 'one row, replaced, however often it reports');
  assert.equal(cloud.tables.hub_status[0].queued, 9);
});

test('the restaurant is the one it is sent for, whatever the report claims', async () => {
  const cloud = memoryCloud();
  await sendReport(cloud, RID, { ...buildReport(KNOWN), restaurant_id: 'someone-else' });
  assert.deepEqual(cloud.tables.hub_status.map(r => r.restaurant_id), [RID]);
});

test('a refusal is an answer, not a crash: the cloud\'s words, and nothing thrown', async () => {
  const refused = memoryCloud({ failures: { upsert: { hub_status: { message: 'permission denied for table hub_status', code: '42501' } } } });
  assert.deepEqual(await sendReport(refused, RID, buildReport(KNOWN)), { ok: false, error: 'permission denied for table hub_status' });
  const broken = { from() { throw new Error('socket hang up'); } };
  assert.deepEqual(await sendReport(broken, RID, buildReport(KNOWN)), { ok: false, error: 'socket hang up' });
  const rejecting = { from: () => ({ upsert: () => Promise.reject(new Error('fetch failed')) }) };
  assert.deepEqual(await sendReport(rejecting, RID, buildReport(KNOWN)), { ok: false, error: 'fetch failed' });
});

// --- the beat ------------------------------------------------------------------------------------------------------------------

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const session = cloud => async () => ({ rid: RID, client: cloud });
const known = (over = {}) => () => ({ ...KNOWN, ...over });

test('a beat reports what the hub knows at that moment, as the restaurant it is signed in as', async () => {
  const cloud = memoryCloud();
  const runner = createHeartbeatRunner({ cloudSession: session(cloud), collect: known(), now: () => NOW });
  assert.deepEqual(await runner.run(), { ok: true, at: '2026-10-24T09:00:00.000Z' });
  assert.deepEqual(cloud.tables.hub_status.map(r => [r.restaurant_id, r.queued, r.reported_at]), [[RID, 3, '2026-10-24T09:00:00.000Z']]);
  assert.deepEqual(runner.last(), { at: '2026-10-24T09:00:00.000Z', ok: true });
});

test('each beat asks the hub afresh, so a queue that grew is reported as grown', async () => {
  const cloud = memoryCloud();
  let queued = 0;
  const clock = [new Date('2026-10-24T09:00:00Z'), new Date('2026-10-24T09:05:00Z')];
  const runner = createHeartbeatRunner({ cloudSession: session(cloud), collect: () => ({ ...KNOWN, sync: { queued: queued += 10 } }), now: () => clock.shift() });
  await runner.run();
  await runner.run();
  assert.deepEqual(cloud.calls.upserts.map(u => u.row.queued), [10, 20]);
  assert.equal(cloud.tables.hub_status[0].reported_at, '2026-10-24T09:05:00.000Z');
});

test('with no cloud session nothing was reported, and that is a failure the screen can see, never a quiet success', async () => {
  const runner = createHeartbeatRunner({ cloudSession: async () => null, collect: known(), now: () => NOW });
  const result = await runner.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAILED');
  assert.match(result.error, /no cloud sign-in/i);
  assert.deepEqual(runner.last(), { at: null, ok: false });
});

test('a refused report is a failure too, and the time of the last one that got through is kept beside it', async () => {
  const healthy = memoryCloud();
  const failing = memoryCloud({ failures: { upsert: { hub_status: { message: 'down', code: 'X' } } } });
  const refusedFirst = createHeartbeatRunner({ cloudSession: session(failing), collect: known(), now: () => NOW });
  const result = await refusedFirst.run();
  assert.deepEqual([result.ok, result.code], [false, 'FAILED']);
  assert.deepEqual(refusedFirst.last(), { at: null, ok: false });

  // The same runner, first well and then not.
  let up = true;
  const flaky = { from: table => (up ? healthy : failing).from(table) };
  const both = createHeartbeatRunner({ cloudSession: session(flaky), collect: known(), now: () => new Date('2026-10-24T10:00:00Z') });
  await both.run();
  up = false;
  await both.run();
  assert.deepEqual(both.last(), { at: '2026-10-24T10:00:00.000Z', ok: false }, 'the last good report was at ten, and the one after it failed');
});

test('two beats at once are one: the second is given the first\'s answer, and the hub is asked once', async () => {
  const gate = deferred();
  let asked = 0;
  const cloud = memoryCloud();
  const runner = createHeartbeatRunner({
    cloudSession: async () => { asked += 1; await gate.promise; return { rid: RID, client: cloud }; },
    collect: known(), now: () => NOW
  });
  const first = runner.run();
  const second = runner.run();
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true, at: '2026-10-24T09:00:00.000Z' }, { ok: true, at: '2026-10-24T09:00:00.000Z' }]);
  assert.equal(asked, 1);
  assert.equal(cloud.calls.upserts.length, 1);
  await runner.run();
  assert.equal(asked, 2, 'and once it has finished, the next is a new one');
});

test('it never throws: a session, a collector or a cloud that fails is a failed beat', async () => {
  const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
  for (const options of [
    { cloudSession: async () => { throw new Error('auth down'); }, collect: known() },
    { cloudSession: session(memoryCloud()), collect: () => { throw new Error('queue unreadable'); } },
    { cloudSession: session({ from: () => { throw new Error('socket'); } }), collect: known() }
  ]) {
    const runner = createHeartbeatRunner({ ...options, now: () => NOW });
    const result = await quiet(() => runner.run());
    assert.deepEqual([result.ok, result.code], [false, 'FAILED']);
    assert.equal(runner.last().ok, false);
  }
});

test('left to itself it uses the time it is, and a clock that fails is a failed beat', async () => {
  const cloud = memoryCloud();
  const runner = createHeartbeatRunner({ cloudSession: session(cloud), collect: known() });
  const result = await runner.run();
  assert.ok(Math.abs(Date.parse(result.at) - Date.now()) < 5000);
  assert.equal(cloud.tables.hub_status[0].reported_at, result.at);
});

test('what the hub collects is asked for afresh each time, from the queue, the handsets and the waiters, and says nothing else', () => {
  let queued = 0;
  const collect = makeCollector({
    startedAt: '2026-10-24T06:00:00.000Z', version: '1.0.0',
    syncQueue: { getStatus: () => ({ queued: (queued += 1), quarantined: 2, last_synced_at: '2026-10-24T08:58:00.000Z', online: true, catalog: {} }) },
    deviceAuth: { activeDeviceCount: () => 3 },
    waiterStore: { listActive: () => [{ id: 1, pin_hash: 'x' }, { id: 2, pin_hash: 'y' }] }
  });
  const first = collect();
  assert.deepEqual(Object.keys(first).sort(), ['devices', 'startedAt', 'sync', 'version', 'waiters']);
  assert.deepEqual([first.startedAt, first.version, first.devices, first.waiters, first.sync.queued], ['2026-10-24T06:00:00.000Z', '1.0.0', 3, 2, 1]);
  assert.equal(collect().sync.queued, 2, 'asked again, not remembered');
  assert.doesNotMatch(JSON.stringify(buildReport({ now: NOW, ...first })), /pin_hash|online|catalog/);
});

test('what it reports on itself is a copy: changing it changes nothing inside', async () => {
  const runner = createHeartbeatRunner({ cloudSession: session(memoryCloud()), collect: known(), now: () => NOW });
  await runner.run();
  runner.last().ok = false;
  assert.equal(runner.last().ok, true);
});

// --- on a real hub -------------------------------------------------------------------------------------------------------------

const fixture = {
  menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
  tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
};
const hubs = [];
const hub = async env => { const h = await startHub({ trustLoopback: true, ...fixture, env }); hubs.push(h); return h; };
after(() => { for (const h of hubs) h.stop(); });
const status = async h => (await call(h, '/sync-status')).json();

test('hub: /sync-status says whether the hub has reported, and nothing of what it reported', async () => {
  const h = await hub({ HUB_HEARTBEAT_FIRST_MS: '3600000', HUB_HEARTBEAT_MS: '3600000' });
  const body = await status(h);
  assert.deepEqual(body.heartbeat, { at: null, ok: null }, 'nothing has been tried yet');
  assert.deepEqual(Object.keys(body.heartbeat).sort(), ['at', 'ok']);

  // With no timing set at all the first report is a good while off: a hub is not in a hurry to say hello before it has finished starting.
  const plain = await hub({});
  assert.deepEqual((await status(plain)).heartbeat, { at: null, ok: null });
});

test('hub: it reports by itself, soon after it starts and then again and again, with nobody asking', async () => {
  const soonOnly = await hub({ HUB_HEARTBEAT_FIRST_MS: '50', HUB_HEARTBEAT_MS: '3600000' });
  const repeating = await hub({ HUB_HEARTBEAT_FIRST_MS: '3600000', HUB_HEARTBEAT_MS: '60' });
  const never = await hub({ HUB_HEARTBEAT_FIRST_MS: '3600000', HUB_HEARTBEAT_MS: '3600000' });
  // A test hub has no cloud, so every report fails: what shows that it was TRIED is `ok` turning from null to false.
  const tried = async h => {
    for (let i = 0; i < 60; i += 1) {
      if ((await status(h)).heartbeat.ok === false) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  assert.equal(await tried(soonOnly), true, 'the first report, shortly after start');
  assert.equal(await tried(repeating), true, 'and the reporting that goes on');
  assert.equal(await tried(never), false, 'without either, nothing is sent until the timer comes round');
});

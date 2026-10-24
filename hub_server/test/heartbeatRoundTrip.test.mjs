import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, sendReport, createHeartbeatRunner } from '../lib/heartbeat.js';
import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient, pgrestServiceClient } from './helpers/pgrest.mjs';

// The hub's report on itself against the REAL schema, signed in as the hub's own `kitchen` identity, so the grants and the row-level
// policies of migration 021 are in the way as they will be in production. heartbeat.test.mjs proves the decisions with a stand-in; this
// proves the report means what the table thinks: one row, replaced each time, stamped by the database, and only ever the hub's own.

const NOW = new Date('2026-10-24T09:00:00.000Z');
const KNOWN = {
  now: NOW, startedAt: '2026-10-24T06:00:00.000Z', version: '1.0.0',
  sync: { queued: 3, quarantined: 1, last_synced_at: '2026-10-24T08:58:00.000Z' }, devices: 2, waiters: 4
};

let cloud;
let T;
let hubA;
let service;

before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  hubA = pgrestClient(cloud, T.A.user);
  service = pgrestServiceClient(cloud);
});
after(async () => { await cloud?.close(); });

const stored = async rid => (await cloud.pg.query('SELECT * FROM public.hub_status WHERE restaurant_id = $1', [rid])).rows;

test('a report the hub builds is accepted by the cloud, and is there as it was sent', async () => {
  assert.deepEqual(await sendReport(hubA, T.A.restaurant, buildReport(KNOWN)), { ok: true });
  const [row] = await stored(T.A.restaurant);
  assert.deepEqual(
    [row.reported_at, row.started_at, row.version, row.queued, row.quarantined, row.last_synced_at, row.devices, row.waiters],
    ['2026-10-24T09:00:00.000Z', '2026-10-24T06:00:00.000Z', '1.0.0', 3, 1, '2026-10-24T08:58:00.000Z', 2, 4]
  );
});

test('a hub that knows nothing yet is accepted too: a report of nothing is still a report', async () => {
  assert.deepEqual(await sendReport(hubA, T.A.restaurant, buildReport({ now: NOW })), { ok: true });
  const [row] = await stored(T.A.restaurant);
  assert.deepEqual([row.started_at, row.version, row.last_synced_at, row.queued, row.devices], [null, null, null, 0, 0]);
});

test('reporting again replaces the one row, and the database says when it heard', async () => {
  await sendReport(hubA, T.A.restaurant, buildReport({ ...KNOWN, sync: { queued: 40 } }));
  const first = (await stored(T.A.restaurant))[0];
  await new Promise(resolve => setTimeout(resolve, 25));
  await sendReport(hubA, T.A.restaurant, buildReport({ ...KNOWN, sync: { queued: 41 } }));
  const rows = await stored(T.A.restaurant);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].queued, 41);
  assert.ok(new Date(rows[0].received_at) > new Date(first.received_at));
  assert.ok(Math.abs(new Date(rows[0].received_at) - Date.now()) < 120000, 'by the database\'s clock, not the report\'s (which says 2026-10-24T09:00)');
});

test('a hub cannot report as another restaurant: it is told so, and nothing is written', async () => {
  const result = await sendReport(hubA, T.B.restaurant, buildReport(KNOWN));
  assert.equal(result.ok, false);
  assert.match(result.error, /row-level security|permission denied/i);
  assert.equal((await stored(T.B.restaurant)).length, 0);
});

test('the runner reports through the real cloud, and what it reports is what the operator then sees', async () => {
  const runner = createHeartbeatRunner({ cloudSession: async () => ({ rid: T.A.restaurant, client: hubA }), collect: () => ({ ...KNOWN, sync: { queued: 12, quarantined: 2 } }), now: () => NOW });
  assert.deepEqual(await runner.run(), { ok: true, at: '2026-10-24T09:00:00.000Z' });
  const seen = (await service.from('ops_tenants').select('*').eq('restaurant_id', T.A.restaurant)).data[0];
  assert.deepEqual([seen.hub_queued, seen.hub_quarantined, seen.hub_version, seen.hub_reported_at], [12, 2, '1.0.0', '2026-10-24T09:00:00.000Z']);
  assert.ok(seen.hub_seen_at, 'and when the database heard');
});

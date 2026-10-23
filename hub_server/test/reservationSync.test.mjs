import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The cloud copy of the booking diary (migration 011): the push, the read-back for a replacement
// laptop, and the rules for when each happens.

const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-sync-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { reservationRow, walkInRow, pushReservations, pullReservations } = await import('../lib/reservationSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { reservationStore } = await import('../lib/reservationStore.js');
const { emptyState, updateBooking, updateWalkIn } = await import('../lib/reservations.js');

after(async () => {
  await reservationStore.flush();
  // The sync queue writes its journal and snapshot into this directory in the background; remove the
  // directory under it and the write fails, or lands mid-removal (ENOTEMPTY).
  await syncQueue._writeChain;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const BOOKING = {
  id: 'res_1', guest_name: 'Asha', phone: '919876543210', phone_key: 'a'.repeat(64),
  party_size: 4, at: '2026-10-22T13:30:00.000Z', duration_mins: 90, status: 'booked',
  note: 'Window table', created_at: '2026-10-21T10:00:00.000Z'
};
const WALKIN = {
  id: 'wl_1', guest_name: 'Rahul', phone: '919876511111', phone_key: 'b'.repeat(64),
  party_size: 3, quoted_wait_mins: 20, status: 'waiting', created_at: '2026-10-21T18:00:00.000Z'
};
const snapshot = (over = {}) => ({ restaurant_id: RID, revision: 5, reservations: [BOOKING], waitlist: [WALKIN], ...over });

/** A cloud that keeps its rows, so a push followed by a pull is a real round trip. */
function fakeCloud(seed = {}, { failWith = null } = {}) {
  const tables = { reservations: [...(seed.reservations || [])], walkins: [...(seed.walkins || [])] };
  const log = [];
  let serial = 0;
  return {
    tables,
    log,
    from(name) {
      return {
        upsert: async rows => {
          log.push(`upsert ${name}`);
          if (failWith) return { error: failWith };
          for (const r of rows) {
            const at = tables[name].findIndex(x => x.restaurant_id === r.restaurant_id && x.hub_ref === r.hub_ref);
            if (at >= 0) tables[name][at] = { ...tables[name][at], ...r };
            else tables[name].push({ id: `uuid-${++serial}`, ...r });
          }
          return { error: null };
        },
        select: () => ({
          eq: async (col, val) => {
            log.push(`select ${name}`);
            return failWith ? { data: null, error: failWith } : { data: tables[name].filter(r => r[col] === val), error: null };
          }
        }),
        delete: () => ({
          eq: (col, val) => ({
            in: async (col2, ids) => {
              log.push(`delete ${name}`);
              if (failWith) return { error: failWith };
              tables[name] = tables[name].filter(r => !(r[col] === val && ids.includes(r[col2])));
              return { error: null };
            }
          })
        })
      };
    }
  };
}

const reset = cloud => {
  syncQueue.saveQueue([]);
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
  syncQueue.isSyncing = true;
  syncQueue.cloud = cloud ?? fakeCloud();
  syncQueue.catalogState = {};
  reservationStore.state = emptyState(RID);
};
const quiet = async fn => {
  const w = console.warn, l = console.log;
  console.warn = console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

// --- mapping -----------------------------------------------------------------------------------

test('a booking becomes the columns migration 011 defines, with `at` as `booked_for`', () => {
  const row = reservationRow(RID, BOOKING);
  assert.equal(row.hub_ref, 'res_1');
  assert.equal(row.booked_for, BOOKING.at, '`at` reads as nothing in a database');
  assert.equal(row.phone_key, 'a'.repeat(64));
  assert.equal(row.overbooked, false, 'explicit, because the column is NOT NULL');
  assert.equal(row.seated_at, null);
});

test('a walk-in carries what it has and nulls what it does not', () => {
  const row = walkInRow(RID, WALKIN);
  assert.equal(row.quoted_wait_mins, 20);
  assert.equal(row.seated_at, null);
  assert.equal(walkInRow(RID, { ...WALKIN, phone: undefined, phone_key: undefined }).phone, null);
});

test('a walk-in that was given the reward carries it up and gets it back', async () => {
  const given = { ...WALKIN, reward_given_at: '2026-10-21T19:00:00.000Z', reward_given_text: 'a free dessert', reward_visit: 5 };
  const row = walkInRow(RID, given);
  assert.deepEqual([row.reward_given_at, row.reward_given_text, row.reward_visit], ['2026-10-21T19:00:00.000Z', 'a free dessert', 5]);
  const plain = walkInRow(RID, WALKIN);
  assert.deepEqual([plain.reward_given_at, plain.reward_given_text, plain.reward_visit], [null, null, null]);
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot({ waitlist: [given] }));
  assert.deepEqual((await pullReservations(cloud, RID)).waitlist[0], given, 'a given reward survives a replacement laptop');
  const asText = fakeCloud({ walkins: [{ ...walkInRow(RID, given), reward_visit: '5' }] });
  assert.strictEqual((await pullReservations(asText, RID)).waitlist[0].reward_visit, 5, 'a number that arrives as text is still a number');
});

// --- the push -----------------------------------------------------------------------------------

test('push: bookings and walk-ins both go, and removals only after everything is written', async () => {
  const cloud = fakeCloud();
  const result = await pushReservations(cloud, RID, snapshot());
  assert.deepEqual(result, { reservations: 1, walkins: 1, removed: 0 });

  const firstDelete = cloud.log.findIndex(l => l.startsWith('delete'));
  const lastUpsert = cloud.log.map(l => l.startsWith('upsert')).lastIndexOf(true);
  assert.ok(firstDelete === -1 || lastUpsert < firstDelete, 'an interrupted push never loses a booking');
});

test('push: a booking that changed updates in place rather than duplicating', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  await pushReservations(cloud, RID, snapshot({ reservations: [{ ...BOOKING, status: 'seated', seated_at: '2026-10-22T13:35:00.000Z' }] }));
  assert.equal(cloud.tables.reservations.length, 1);
  assert.equal(cloud.tables.reservations[0].status, 'seated');
});

test('push: a booking or a place in the queue that was edited arrives in place, with only the columns the cloud has, and comes back as edited', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  const NOW = new Date('2026-10-22T09:00:00.000Z');
  const state = { ...emptyState(RID), reservations: [BOOKING], waitlist: [WALKIN] };

  const moved = updateBooking(state, 'res_1', { at: '2026-10-22T15:00:00.000Z', party_size: 2, note: '', guest_name: 'Asha Rao', phone: '98111 22233' }, { now: NOW, tables: [{ id: 1, name: 'T1', capacity: 4 }] });
  const changed = updateWalkIn(state, 'wl_1', { quoted_wait_mins: null, phone: '', note: 'High chair' }, { now: NOW });
  assert.equal(moved.ok && changed.ok, true, JSON.stringify([moved, changed]));
  assert.ok(moved.meta.reservation.updated_at && changed.meta.entry.updated_at, 'both carry when they were changed');

  await pushReservations(cloud, RID, snapshot({ reservations: [moved.meta.reservation], waitlist: [changed.meta.entry] }));
  assert.equal(cloud.tables.reservations.length, 1, 'in place, not a second booking');
  assert.equal(cloud.tables.walkins.length, 1);
  const [row] = cloud.tables.reservations;
  assert.deepEqual([row.booked_for, row.party_size, row.note, row.guest_name, row.phone], ['2026-10-22T15:00:00.000Z', 2, null, 'Asha Rao', '919811122233']);
  assert.equal('updated_at' in row, false, 'the cloud has no such column, and a column it lacks is a push it refuses');
  assert.equal('updated_at' in cloud.tables.walkins[0], false);
  assert.deepEqual([cloud.tables.walkins[0].quoted_wait_mins, cloud.tables.walkins[0].phone, cloud.tables.walkins[0].phone_key], [null, null, null]);

  const back = await pullReservations(cloud, RID);
  assert.deepEqual([back.reservations[0].at, back.reservations[0].party_size, back.reservations[0].guest_name, 'note' in back.reservations[0]], ['2026-10-22T15:00:00.000Z', 2, 'Asha Rao', false]);
  assert.deepEqual(['phone' in back.waitlist[0], 'quoted_wait_mins' in back.waitlist[0]], [false, false]);
});

test('push: a booking deleted on the hub is deleted in the cloud, and another tenant is untouched', async () => {
  const theirs = { id: 'u-x', restaurant_id: OTHER_RID, hub_ref: 'res_theirs', guest_name: 'Theirs' };
  const cloud = fakeCloud({ reservations: [theirs] });
  await pushReservations(cloud, RID, snapshot());
  const result = await pushReservations(cloud, RID, snapshot({ reservations: [], waitlist: [WALKIN] }));
  assert.equal(result.removed, 1);
  assert.ok(cloud.tables.reservations.some(r => r.hub_ref === 'res_theirs'), 'not deleted as "stale"');
});

test('push: a cloud refusal is thrown so the queue can tell a hub-wide problem from a bad snapshot', async () => {
  const cloud = fakeCloud({}, { failWith: { code: '42501', message: 'permission denied for table reservations' } });
  await assert.rejects(() => pushReservations(cloud, RID, snapshot()), e => e.code === '42501');
});

// --- reading back ------------------------------------------------------------------------------

test('pull: what was pushed comes back in the hub\'s own shapes', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  const back = await pullReservations(cloud, RID);

  assert.deepEqual(back.reservations[0], BOOKING, 'a booking round-trips exactly');
  assert.deepEqual(back.waitlist[0], WALKIN);
});

test('pull: a row with no hub_ref is skipped rather than given an invented id', async () => {
  const cloud = fakeCloud({ reservations: [{ id: 'u1', restaurant_id: RID, hub_ref: null, guest_name: 'Typed in by hand', party_size: 2, booked_for: '2026-10-22T13:30:00.000Z', status: 'booked' }] });
  assert.deepEqual((await pullReservations(cloud, RID)).reservations, []);
});

test('pull: only this restaurant\'s diary, and a cloud error is thrown rather than read as empty', async () => {
  const cloud = fakeCloud({ reservations: [{ id: 'u1', restaurant_id: OTHER_RID, hub_ref: 'res_theirs', guest_name: 'Theirs', party_size: 2, booked_for: '2026-10-22T13:30:00.000Z', status: 'booked' }] });
  assert.deepEqual((await pullReservations(cloud, RID)).reservations, []);
  await assert.rejects(() => pullReservations(fakeCloud({}, { failWith: { code: '42P01', message: 'relation "reservations" does not exist' } }), RID));
});

// --- the queue ------------------------------------------------------------------------------------

test('queue: the diary is a replicated catalog alongside the menu, tables and stock', () => {
  reset();
  assert.deepEqual(Object.keys(syncQueue.getCatalogStatus()).sort(), ['inventory', 'menu', 'reservations', 'tables']);
});

test('queue: several changes collapse into one push carrying the newest diary', () => {
  reset();
  syncQueue.enqueueCatalog('reservations', snapshot({ revision: 3 }));
  syncQueue.enqueueCatalog('reservations', snapshot({ revision: 9 }));
  const pending = syncQueue.queue.filter(q => q.type === 'SYNC_RESERVATIONS');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.revision, 9);
});

test('queue: pushing records how far the cloud has got', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.enqueueCatalog('reservations', snapshot({ revision: 5 }));
  assert.equal(await quiet(() => syncQueue.syncCatalogToSupabase(syncQueue.queue[0])), true);
  assert.equal(cloud.tables.reservations.length, 1);
  assert.equal(syncQueue.getCatalogStatus().reservations.synced_revision, 5);
});

test('backfill: a diary the cloud has not confirmed is queued; one it has is not', () => {
  reset();
  assert.deepEqual(syncQueue.enqueueReservationsIfBehind(RID), { queued: false, reason: 'NOTHING_TO_PUSH' });

  reservationStore.state = { ...snapshot({ revision: 4 }) };
  assert.deepEqual(syncQueue.enqueueReservationsIfBehind(RID), { queued: true, revision: 4 });

  syncQueue.saveQueue([]);
  syncQueue.catalogState = { reservations: { synced_revision: 4 } };
  assert.deepEqual(syncQueue.enqueueReservationsIfBehind(RID), { queued: false, reason: 'UP_TO_DATE' });
});

// --- restoring a replacement laptop ---------------------------------------------------------------

test('restore: an empty hub rebuilds the diary, and does not push it straight back', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  reset(cloud);
  reservationStore.state = emptyState(null);

  const r = await quiet(() => syncQueue.restoreReservationsFromCloud(RID));
  assert.deepEqual(r, { restored: true, reservations: 1, waitlist: 1 });
  assert.equal(reservationStore.state.reservations[0].guest_name, 'Asha');
  assert.deepEqual(syncQueue.enqueueReservationsIfBehind(RID), { queued: false, reason: 'UP_TO_DATE' });
});

test('restore: a hub that already holds a diary is the authority and is left alone', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  reset(cloud);
  reservationStore.state = { ...snapshot({ revision: 12, reservations: [{ ...BOOKING, id: 'res_mine', guest_name: 'Mine' }], waitlist: [] }) };

  assert.deepEqual(await quiet(() => syncQueue.restoreReservationsFromCloud(RID)), { restored: false, reason: 'DIARY_PRESENT' });
  assert.deepEqual(reservationStore.state.reservations.map(r => r.guest_name), ['Mine']);
});

test('restore: a diary deliberately cleared is NOT handed last month\'s no-shows back', async () => {
  const cloud = fakeCloud();
  await pushReservations(cloud, RID, snapshot());
  reset(cloud);
  reservationStore.state = { ...emptyState(RID), revision: 9 };
  assert.deepEqual(await quiet(() => syncQueue.restoreReservationsFromCloud(RID)), { restored: false, reason: 'DIARY_PRESENT' });
});

test('restore: offline, unpaired, and an empty cloud are all reported rather than guessed at', async () => {
  reset(fakeCloud());
  reservationStore.state = emptyState(null);
  syncQueue.checkConnection = async () => ({ online: false });
  assert.deepEqual(await syncQueue.restoreReservationsFromCloud(RID), { restored: false, reason: 'OFFLINE' });

  reset(fakeCloud());
  reservationStore.state = emptyState(null);
  assert.deepEqual(await syncQueue.restoreReservationsFromCloud(RID), { restored: false, reason: 'NOTHING_IN_CLOUD' });
  assert.deepEqual(await syncQueue.restoreReservationsFromCloud(OTHER_RID), { restored: false, reason: 'NOT_PAIRED' });
});

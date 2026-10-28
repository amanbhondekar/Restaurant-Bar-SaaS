import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything here runs against a throwaway data directory, and the cloud is a fake. The Supabase URL is
// forced to the unconfigured placeholder so nothing in this file can reach a real project even if a
// .env is present (dotenv never overrides a variable that is already set).
const RID = '11111111-1111-1111-1111-111111111111';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-catalog-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { syncQueue, MAX_SYNC_ATTEMPTS } = await import('../lib/syncQueue.js');

const menuData = (revision, names = ['a']) => ({
  revision,
  restaurant_id: RID,
  categories: ['Mains'],
  items: names.map(id => ({ id, name: id, price: 10, category: 'Mains', isVeg: true, available: true }))
});
const layoutData = revision => ({
  revision, restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 2 }]
});

/** Counts calls and lets a test hold a push open until it chooses to release it. */
function fakeCloud({ gate } = {}) {
  const log = [];
  const rows = { menu_items: [], menu_categories: [], tables: [] };
  return {
    log,
    from(name) {
      return {
        upsert: async part => {
          log.push(`upsert:${name}`);
          if (gate && name === 'menu_items') await gate;
          rows[name].push(...part);
          return { error: null };
        },
        select: () => ({ eq: async () => ({ data: [], error: null }) }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
      };
    }
  };
}

function reset(cloud) {
  syncQueue.saveQueue([]);
  syncQueue.catalogState = {};
  fs.writeFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), '[]');
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
  syncQueue.cloud = cloud;
}

// enqueueCatalog starts a drain on its own; tests that inspect the queue need it to stay put.
const hold = () => { syncQueue.isSyncing = true; };
const release = () => { syncQueue.isSyncing = false; };

test('enqueueCatalog keeps one pending push per catalog, always the newest', () => {
  reset(fakeCloud());
  hold();
  syncQueue.enqueueCatalog('menu', menuData(1));
  syncQueue.enqueueCatalog('menu', menuData(2));
  syncQueue.enqueueCatalog('menu', menuData(3, ['a', 'b']));
  syncQueue.enqueueCatalog('tables', layoutData(1));
  release();

  const menuOps = syncQueue.queue.filter(q => q.type === 'SYNC_MENU');
  assert.equal(menuOps.length, 1);
  assert.equal(menuOps[0].payload.revision, 3);
  assert.equal(menuOps[0].payload.items.length, 2);
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_TABLES').length, 1);
  assert.equal(syncQueue.getStatus().catalog.menu.pending_revision, 3);
});

test('a drain pushes both catalogs, empties the queue and records the synced revision', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  hold();
  syncQueue.enqueueCatalog('menu', menuData(4));
  syncQueue.enqueueCatalog('tables', layoutData(2));
  release();
  await syncQueue.processQueue();

  assert.equal(syncQueue.queue.length, 0);
  assert.ok(cloud.log.includes('upsert:menu_items') && cloud.log.includes('upsert:tables'));
  const status = syncQueue.getStatus().catalog;
  assert.deepEqual([status.menu.synced_revision, status.menu.pending_revision, status.menu.failed], [4, null, false]);
  assert.equal(status.tables.synced_revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog_sync.json'), 'utf-8')).menu.synced_revision, 4);
});

test('an edit made while a push is in flight is not lost, and neither is a status update', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cloud = fakeCloud({ gate });
  reset(cloud);
  hold();
  syncQueue.enqueueCatalog('menu', menuData(1));
  syncQueue.isSyncing = false;

  const drain = syncQueue.processQueue(); // waits inside the menu push
  while (!cloud.log.includes('upsert:menu_items')) await new Promise(r => setTimeout(r, 5));

  syncQueue.enqueueCatalog('menu', menuData(2, ['a', 'b']));
  syncQueue.enqueueStatusUpdate(101, 'ready', RID);
  release();
  await drain;

  const left = syncQueue.queue;
  assert.ok(left.some(q => q.type === 'SYNC_MENU' && q.payload.revision === 2), 'the newer snapshot is still queued');
  assert.ok(left.some(q => q.type === 'UPDATE_STATUS'), 'the status update is still queued');
  assert.equal(left.some(q => q.type === 'SYNC_MENU' && q.payload.revision === 1), false, 'the pushed snapshot is gone');
  assert.equal(syncQueue.getStatus().catalog.menu.synced_revision, 1);
});

test('a snapshot made for another restaurant is dropped without touching the cloud', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  hold();
  syncQueue.enqueueCatalog('menu', { ...menuData(1), restaurant_id: '22222222-2222-2222-2222-222222222222' });
  release();
  await syncQueue.processQueue();

  assert.equal(syncQueue.queue.length, 0);
  assert.deepEqual(cloud.log, []);
  assert.equal(syncQueue.getStatus().catalog.menu.synced_revision, 0);
});

test('a failing catalog push never blocks an order, and is shelved after the retry limit', async () => {
  const cloud = fakeCloud();
  cloud.from = () => ({
    upsert: async () => ({ error: Object.assign(new Error('column "hub_ref" does not exist'), { code: '42703' }) })
  });
  reset(cloud);
  const synced = [];
  const originalOrder = syncQueue.syncStatusToSupabase;
  syncQueue.syncStatusToSupabase = async p => { synced.push(p.ticketId); return true; };
  try {
    hold();
    syncQueue.enqueueCatalog('menu', menuData(1));
    syncQueue.enqueueStatusUpdate(7, 'ready', RID);
    release();

    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) await syncQueue.processQueue();

    assert.deepEqual(synced, [7], 'the status update went through on the first drain');
    assert.equal(syncQueue.queue.length, 0);
    const status = syncQueue.getStatus();
    assert.equal(status.catalog.menu.failed, true);
    assert.equal(status.quarantined, 0, 'a shelved menu push is not shelved takings');
  } finally {
    syncQueue.syncStatusToSupabase = originalOrder;
  }
});

test('requeueing a shelved snapshot never replaces a newer one', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  fs.writeFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), JSON.stringify([{
    queue_id: 'q_old', type: 'SYNC_MENU', payload: { ...menuData(2), revision: 2 }, attempts: 5,
    quarantined_at: 'x', quarantine_reason: 'y'
  }]));
  hold();
  syncQueue.enqueueCatalog('menu', menuData(5));
  await syncQueue.requeueQuarantined();
  release();

  const menuOps = syncQueue.queue.filter(q => q.type === 'SYNC_MENU');
  assert.equal(menuOps.length, 1);
  assert.equal(menuOps[0].payload.revision, 5);
  assert.equal(syncQueue.getStatus().catalog.menu.failed, false);
});

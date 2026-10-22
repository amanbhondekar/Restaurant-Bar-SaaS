import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Stock and recipes in the cloud (migration 009): the push, the read-back for a replacement hub, and
// the rules for when each one happens. Throwaway data directory and a fake cloud, with SUPABASE_URL
// forced to the unconfigured placeholder so nothing here can reach a real project.

const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-cloud-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { inventoryItemRow, recipeRow, pushInventory, pullInventory } = await import('../lib/inventorySync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { inventoryStore } = await import('../lib/inventoryStore.js');
const { emptyState } = await import('../lib/inventory.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const ING = [
  { id: 'ing_paneer', name: 'Paneer', unit: 'g', on_hand: 800, low_at: 200 },
  { id: 'ing_onion', name: 'Onion', unit: 'kg', on_hand: 1.6, low_at: 0.5 }
];
const REC = [
  { id: 'rec_1', item_id: 'm1', variant_id: null, lines: [{ inventory_item_id: 'ing_paneer', qty: 150 }, { inventory_item_id: 'ing_onion', qty: 0.1 }] },
  { id: 'rec_2', item_id: 'biryani', variant_id: 'full', lines: [{ inventory_item_id: 'ing_onion', qty: 0.4 }] }
];
const snapshot = (over = {}) => ({ restaurant_id: RID, revision: 7, items: ING, recipes: REC, movements: [], ...over });

/**
 * A cloud that keeps its rows, so a push followed by a pull is a real round trip. Records the order of
 * operations so a test can check upserts happen before deletes. `failWith` makes every call fail.
 */
function fakeCloud(seed = {}, { failWith = null } = {}) {
  const tables = { inventory_items: [...(seed.inventory_items || [])], recipes: [...(seed.recipes || [])] };
  const log = [];
  let serial = 0;
  const outcome = rows => (failWith ? { data: null, error: failWith } : { data: rows, error: null });
  return {
    tables,
    log,
    from(name) {
      return {
        upsert: async (rows) => {
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
            return outcome(tables[name].filter(r => r[col] === val));
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

function reset(cloud) {
  syncQueue.saveQueue([]);
  fs.writeFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), '[]');
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
  syncQueue.isSyncing = true;                          // enqueueing starts a drain; tests drive it themselves
  syncQueue.cloud = cloud ?? fakeCloud();
  syncQueue.catalogState = {};
  inventoryStore.state = emptyState(RID);
}
const quiet = async fn => { const w = console.warn, l = console.log, e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; } };

// --- mapping -------------------------------------------------------------------------------

test('rows: an ingredient and a recipe become the columns migration 009 defines', () => {
  assert.deepEqual(inventoryItemRow(RID, ING[0]), { restaurant_id: RID, hub_ref: 'ing_paneer', name: 'Paneer', unit: 'g', on_hand: 800, low_at: 200, par: null, unit_cost: null });
  assert.deepEqual(recipeRow(RID, REC[1]), {
    restaurant_id: RID, hub_ref: 'rec_2', menu_item_ref: 'biryani', variant_ref: 'full', lines: [{ inventory_item_id: 'ing_onion', qty: 0.4 }]
  });
});

test('rows: a dish-wide recipe sends an explicit null variant, so the upsert can clear one', () => {
  const row = recipeRow(RID, REC[0]);
  assert.equal('variant_ref' in row, true);
  assert.equal(row.variant_ref, null);
});

test('rows: numbers are numbers, whatever shape the state held them in', () => {
  const row = inventoryItemRow(RID, { id: 'x', name: 'Salt', unit: 'g', on_hand: '12.5', low_at: undefined });
  assert.equal(row.on_hand, 12.5);
  assert.equal(row.low_at, 0);
});

// --- the push ------------------------------------------------------------------------------

test('push: ingredients first, then recipes, and removals only after everything is written', async () => {
  const cloud = fakeCloud();
  const result = await pushInventory(cloud, RID, snapshot());
  assert.deepEqual(result, { items: 2, recipes: 2, removed: 0 });
  assert.equal(cloud.tables.inventory_items.length, 2);
  assert.equal(cloud.tables.recipes.length, 2);

  const firstDelete = cloud.log.findIndex(l => l.startsWith('delete'));
  const lastUpsert = cloud.log.map(l => l.startsWith('upsert')).lastIndexOf(true);
  assert.ok(firstDelete === -1 || lastUpsert < firstDelete, 'an interrupted push never loses a row');
  assert.ok(cloud.log.indexOf('upsert inventory_items') < cloud.log.indexOf('upsert recipes'), 'a recipe never lands before its ingredients');
});

test('push: pushing again updates in place rather than duplicating', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  await pushInventory(cloud, RID, snapshot({ items: [{ ...ING[0], on_hand: 650 }, ING[1]] }));
  assert.equal(cloud.tables.inventory_items.length, 2);
  assert.equal(cloud.tables.inventory_items.find(r => r.hub_ref === 'ing_paneer').on_hand, 650);
});

test('push: what the owner deleted on the hub is deleted in the cloud, for both ingredients and recipes', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  const result = await pushInventory(cloud, RID, snapshot({ items: [ING[1]], recipes: [REC[1]] }));
  assert.equal(result.removed, 2);
  assert.deepEqual(cloud.tables.inventory_items.map(r => r.hub_ref), ['ing_onion']);
  assert.deepEqual(cloud.tables.recipes.map(r => r.hub_ref), ['rec_2']);
});

test('push: never touches another restaurant\'s rows', async () => {
  const theirs = { id: 'u-x', restaurant_id: OTHER_RID, hub_ref: 'ing_theirs', name: 'Theirs', unit: 'g', on_hand: 5, low_at: 0 };
  const cloud = fakeCloud({ inventory_items: [theirs] });
  await pushInventory(cloud, RID, snapshot());
  assert.ok(cloud.tables.inventory_items.some(r => r.hub_ref === 'ing_theirs'), 'not deleted as "stale"');
});

test('push: a cloud refusal is thrown, so the queue can tell a hub-wide problem from a bad snapshot', async () => {
  const cloud = fakeCloud({}, { failWith: { code: '42501', message: 'permission denied for table inventory_items' } });
  await assert.rejects(() => pushInventory(cloud, RID, snapshot()), e => e.code === '42501');
});

test('push: an empty snapshot clears the cloud copy, which is what an owner who deleted everything wants', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  await pushInventory(cloud, RID, snapshot({ items: [], recipes: [] }));
  assert.equal(cloud.tables.inventory_items.length, 0);
  assert.equal(cloud.tables.recipes.length, 0);
});

// --- reading back --------------------------------------------------------------------------

test('pull: what was pushed comes back in the hub\'s own shapes', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  const back = await pullInventory(cloud, RID);
  assert.deepEqual(back.items.map(i => [i.id, i.name, i.unit, i.on_hand, i.low_at]).sort(), ING.map(i => [i.id, i.name, i.unit, i.on_hand, i.low_at]).sort());
  assert.deepEqual(back.recipes.sort((a, b) => a.id.localeCompare(b.id)), REC);
});

test('pull: numbers that arrive as strings are numbers, and a missing variant is null', async () => {
  const cloud = fakeCloud({
    inventory_items: [{ id: 'u1', restaurant_id: RID, hub_ref: 'ing_a', name: 'Salt', unit: 'g', on_hand: '12.500', low_at: '1.000' }],
    recipes: [{ id: 'u2', restaurant_id: RID, hub_ref: 'rec_a', menu_item_ref: 'dal', variant_ref: null, lines: [{ inventory_item_id: 'ing_a', qty: '2.5' }] }]
  });
  const back = await pullInventory(cloud, RID);
  assert.equal(back.items[0].on_hand, 12.5);
  assert.equal(back.recipes[0].variant_id, null);
  assert.equal(back.recipes[0].lines[0].qty, 2.5);
});

test('pull: a row with no hub_ref (made by hand in the cloud) is skipped, not given an invented id', async () => {
  const cloud = fakeCloud({
    inventory_items: [{ id: 'u1', restaurant_id: RID, hub_ref: null, name: 'Mystery', unit: 'g', on_hand: 1, low_at: 0 }, { id: 'u2', restaurant_id: RID, hub_ref: 'ing_ok', name: 'Fine', unit: 'g', on_hand: 1, low_at: 0 }]
  });
  assert.deepEqual((await pullInventory(cloud, RID)).items.map(i => i.id), ['ing_ok']);
});

test('pull: only this restaurant\'s rows, and a malformed lines column becomes an empty list rather than a crash', async () => {
  const cloud = fakeCloud({
    inventory_items: [{ id: 'u1', restaurant_id: OTHER_RID, hub_ref: 'theirs', name: 'Theirs', unit: 'g', on_hand: 1, low_at: 0 }],
    recipes: [{ id: 'u2', restaurant_id: RID, hub_ref: 'rec_b', menu_item_ref: 'dal', variant_ref: null, lines: 'not an array' }]
  });
  const back = await pullInventory(cloud, RID);
  assert.deepEqual(back.items, []);
  assert.deepEqual(back.recipes[0].lines, []);
});

test('pull: a cloud error is thrown rather than read as an empty cloud', async () => {
  await assert.rejects(() => pullInventory(fakeCloud({}, { failWith: { code: '42P01', message: 'relation "inventory_items" does not exist' } }), RID), e => e.code === '42P01');
});

// --- the queue -----------------------------------------------------------------------------

test('queue: stock is a replicated catalog, reported alongside the menu and tables', () => {
  reset();
  const status = syncQueue.getCatalogStatus();
  // The exact set, so a catalog that stops being reported is caught rather than silently dropped.
  assert.deepEqual(Object.keys(status).sort(), ['inventory', 'menu', 'reservations', 'tables']);
  assert.deepEqual(status.inventory, { synced_revision: 0, pending_revision: null, failed: false });
});

test('queue: several changes collapse into one push carrying the newest snapshot', () => {
  reset();
  syncQueue.enqueueCatalog('inventory', snapshot({ revision: 3 }));
  syncQueue.enqueueCatalog('inventory', snapshot({ revision: 9 }));
  syncQueue.enqueueCatalog('inventory', snapshot({ revision: 5 }));
  const pending = syncQueue.queue.filter(q => q.type === 'SYNC_INVENTORY');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.revision, 9, 'an older snapshot never replaces a newer one');
  assert.equal(syncQueue.getCatalogStatus().inventory.pending_revision, 9);
});

test('queue: an inventory push does not disturb a pending menu push, and is not counted as lost takings', () => {
  reset();
  syncQueue.enqueueCatalog('menu', { restaurant_id: RID, revision: 2, categories: [], items: [] });
  syncQueue.enqueueCatalog('inventory', snapshot());
  assert.deepEqual(syncQueue.queue.map(q => q.type).sort(), ['SYNC_INVENTORY', 'SYNC_MENU']);
  assert.equal(syncQueue.getStatus().quarantined, 0);
});

test('queue: pushing records how far the cloud has got, and the console can say "synced"', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.enqueueCatalog('inventory', snapshot({ revision: 7 }));
  const ok = await quiet(() => syncQueue.syncCatalogToSupabase(syncQueue.queue[0]));

  assert.equal(ok, true);
  assert.equal(cloud.tables.inventory_items.length, 2);
  assert.equal(syncQueue.getCatalogStatus().inventory.synced_revision, 7);
});

test('queue: a snapshot made for another restaurant is dropped, never written to this one', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.enqueueCatalog('inventory', snapshot({ restaurant_id: OTHER_RID }));
  const ok = await quiet(() => syncQueue.syncCatalogToSupabase(syncQueue.queue[0]));
  assert.equal(ok, true, 'dropped counts as handled, or it would block the queue forever');
  assert.equal(cloud.tables.inventory_items.length, 0);
});

test('queue: a refusal by the cloud fails the push, and a permission error holds the queue rather than burning retries', async () => {
  reset(fakeCloud({}, { failWith: { code: '42501', message: 'permission denied for table inventory_items' } }));
  syncQueue.enqueueCatalog('inventory', snapshot());
  const ok = await quiet(() => syncQueue.syncCatalogToSupabase(syncQueue.queue[0]));
  assert.equal(ok, false);
  assert.equal(syncQueue.lastFailureSystemic, true);
});

// --- backfill ------------------------------------------------------------------------------

test('backfill: nothing to push for a hub that has never had stock', () => {
  reset();
  assert.deepEqual(syncQueue.enqueueInventoryIfBehind(RID), { queued: false, reason: 'NOTHING_TO_PUSH' });
  assert.equal(syncQueue.queue.length, 0);
});

test('backfill: stock the cloud has not confirmed is queued; stock it has is not', () => {
  reset();
  inventoryStore.state = { ...snapshot({ revision: 4 }) };
  assert.deepEqual(syncQueue.enqueueInventoryIfBehind(RID), { queued: true, revision: 4 });
  assert.equal(syncQueue.queue.find(q => q.type === 'SYNC_INVENTORY').payload.revision, 4);

  syncQueue.saveQueue([]);
  syncQueue.catalogState = { inventory: { synced_revision: 4 } };
  assert.deepEqual(syncQueue.enqueueInventoryIfBehind(RID), { queued: false, reason: 'UP_TO_DATE' });

  syncQueue.catalogState = { inventory: { synced_revision: 3 } };
  assert.equal(syncQueue.enqueueInventoryIfBehind(RID).queued, true, 'one revision behind is behind');
});

test('backfill: another restaurant\'s stock is never pushed as this one\'s', () => {
  reset();
  inventoryStore.state = { ...snapshot({ revision: 4, restaurant_id: OTHER_RID }) };
  assert.equal(syncQueue.enqueueInventoryIfBehind(RID).queued, false);
});

// --- restoring a replacement hub -----------------------------------------------------------

test('restore: an empty hub rebuilds its ingredients and recipes from the cloud', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  reset(cloud);
  inventoryStore.state = emptyState(null);

  const r = await quiet(() => syncQueue.restoreInventoryFromCloud(RID));
  assert.deepEqual(r, { restored: true, items: 2, recipes: 2 });
  assert.equal(inventoryStore.state.items.length, 2);
  assert.equal(inventoryStore.state.recipes.length, 2);
  assert.equal(inventoryStore.state.restaurant_id, RID);
  assert.equal(inventoryStore.state.items.find(i => i.id === 'ing_paneer').on_hand, 800);
  assert.equal(inventoryStore.state.revision, 1);
});

test('restore: what came FROM the cloud is not pushed straight back', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  reset(cloud);
  inventoryStore.state = emptyState(null);

  await quiet(() => syncQueue.restoreInventoryFromCloud(RID));
  assert.equal(syncQueue.getCatalogStatus().inventory.synced_revision, 1);
  assert.deepEqual(syncQueue.enqueueInventoryIfBehind(RID), { queued: false, reason: 'UP_TO_DATE' });
});

test('restore: it persists, so a restart does not leave the hub empty again', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  reset(cloud);
  inventoryStore.state = emptyState(null);
  await quiet(() => syncQueue.restoreInventoryFromCloud(RID));
  await inventoryStore.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'inventory.json'), 'utf-8'));
  assert.equal(onDisk.items.length, 2);
  assert.equal(onDisk.recipes.length, 2);
});

test('restore: a hub that already holds stock is the authority, and is left alone', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());
  reset(cloud);
  inventoryStore.state = { ...snapshot({ revision: 12, items: [{ id: 'ing_mine', name: 'Mine', unit: 'g', on_hand: 1, low_at: 0 }], recipes: [] }) };

  assert.deepEqual(await quiet(() => syncQueue.restoreInventoryFromCloud(RID)), { restored: false, reason: 'INVENTORY_PRESENT' });
  assert.deepEqual(inventoryStore.state.items.map(i => i.id), ['ing_mine']);
});

test('restore: an owner who deleted everything is NOT given it back -- an empty store with a history is not a new hub', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, snapshot());      // the cloud still holds the old data: the delete never got pushed
  reset(cloud);
  inventoryStore.state = { ...emptyState(RID), revision: 9 };

  assert.deepEqual(await quiet(() => syncQueue.restoreInventoryFromCloud(RID)), { restored: false, reason: 'INVENTORY_PRESENT' });
  assert.equal(inventoryStore.state.items.length, 0, 'what they deleted stays deleted');
});

test('restore: offline, or an unreachable cloud, leaves the hub empty and still starting', async () => {
  reset(fakeCloud());
  inventoryStore.state = emptyState(null);
  syncQueue.checkConnection = async () => ({ online: false });
  assert.deepEqual(await syncQueue.restoreInventoryFromCloud(RID), { restored: false, reason: 'OFFLINE' });

  reset(fakeCloud({}, { failWith: { code: 'PGRST301', message: 'JWT expired' } }));
  inventoryStore.state = emptyState(null);
  const r = await quiet(() => syncQueue.restoreInventoryFromCloud(RID));
  assert.equal(r.restored, false);
  assert.equal(r.reason, 'CLOUD_ERROR');
});

test('restore: nothing in the cloud (a brand-new tenant) is not an error', async () => {
  reset(fakeCloud());
  inventoryStore.state = emptyState(null);
  assert.deepEqual(await syncQueue.restoreInventoryFromCloud(RID), { restored: false, reason: 'NOTHING_IN_CLOUD' });
});

test('restore: refuses unless the hub is paired to exactly this restaurant', async () => {
  reset(fakeCloud());
  inventoryStore.state = emptyState(null);
  assert.deepEqual(await syncQueue.restoreInventoryFromCloud(OTHER_RID), { restored: false, reason: 'NOT_PAIRED' });
  assert.deepEqual(await syncQueue.restoreInventoryFromCloud('not-a-uuid'), { restored: false, reason: 'NOT_PAIRED' });
});

// --- the real hub --------------------------------------------------------------------------

let hub;
before(async () => {
  hub = await startHub({
    trustLoopback: true,
    // Short, so the test is quick. Long enough that a burst of changes lands inside one window.
    env: { HUB_INVENTORY_PUSH_MS: '1200' },
    menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
  });
});
after(() => hub?.stop());

const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function queueUntil(predicate, ms = 15000) {
  const file = path.join(hub.dataDir, 'sync_queue.json');
  const deadline = Date.now() + ms;
  let last = [];
  for (;;) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { last = []; }
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise(r => setTimeout(r, 100));
  }
}
const stockPushes = q => q.filter(x => x.type === 'SYNC_INVENTORY');

test('hub: a burst of stock changes is pushed once, after the burst, carrying the last revision', async () => {
  const ing = (await (await call('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Salt', unit: 'g', on_hand: 100 } } })).json()).item;
  for (let i = 0; i < 6; i++) await call(`/admin/inventory/items/${ing.id}/adjust`, { method: 'POST', body: { kind: 'receive', qty: 1 } });
  const final = (await (await call('/admin/inventory')).json()).revision;

  // Inside the window nothing has been queued yet: pushing per change would have queued one already.
  assert.equal(stockPushes(await queueUntil(() => false, 300)).length, 0, 'nothing queued mid-burst');

  const queue = await queueUntil(q => stockPushes(q).length > 0);
  const pushes = stockPushes(queue);
  assert.equal(pushes.length, 1, 'one push, not one per change');
  assert.equal(pushes[0].payload.revision, final, 'and it carries the last state');
  assert.equal(pushes[0].payload.items.find(i => i.name === 'Salt').on_hand, 106);
  assert.equal(pushes[0].payload.restaurant_id, RESTAURANT_ID);
});

test('hub: the console\'s cloud status includes stock', async () => {
  const status = await (await call('/admin/sync-status')).json();
  assert.ok(status.inventory, 'there is an inventory entry');
  assert.ok(Number.isInteger(status.inventory.revision));
  assert.equal('synced_revision' in status.inventory, true);
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

console.log = () => {};   // the cache logs every save; not what is under test (see catalogStore.test.mjs)

// The menu the hub SHOWS is not the menu the hub STORES. Two overlays sit between them: the plan
// (a tenant whose plan lacks modifiers sees none) and stock (a dish that cannot be made is flagged).
// An edit starts from what is stored. If it started from what is shown, saving any dish would write
// the overlays into the menu for good -- a tenant downgraded to Starter would lose every modifier the
// first time they fixed a typo, and a stock-out would become a permanent 86.

const RID = '11111111-1111-1111-1111-111111111111';
let dir;
let cache;

const MENU = () => ({
  restaurant_id: RID, categories: ['Mains'], uninitialized: false,
  items: [
    {
      id: 'dal', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true, station: 'bar',
      modifier_groups: [{ id: 'g1', label: 'Spice', min: 1, max: 1, options: [{ id: 'o1', label: 'Mild', price_delta: 0 }] }],
      day_parts: [{ id: 'dp1', label: 'Lunch', start: '12:00', end: '15:00', price: 180 }]
    },
    { id: 'chai', name: 'Chai', price: 40, category: 'Mains', isVeg: true, available: true }
  ]
});
const STARTER = { modifiers: false, day_part_pricing: false, multi_station_kot: false };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-overlay-'));
  process.env.HUB_DATA_DIR = dir;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  ({ restaurantCache: cache } = await import('../lib/restaurantCache.js'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function reset() {
  fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'menu_cache.json'), JSON.stringify(MENU()));
  fs.writeFileSync(path.join(dir, 'tables_cache.json'), JSON.stringify({ restaurant_id: RID, count: 0, tables: [], uninitialized: false }));
  cache.isUninitialized = false;
  cache.loadFromDisk();
  cache.setFeatureProvider(() => null);
  cache.setStockProvider(items => items);
}
const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'menu_cache.json'), 'utf-8'));
const rename = (id, name) => menu => ({ ok: true, data: { ...menu, items: menu.items.map(i => (i.id === id ? { ...i, name } : i)) } });

test('what is shown: a Starter-plan tenant does not see modifiers, day-parts or stations', () => {
  reset();
  cache.setFeatureProvider(() => STARTER);
  const dal = cache.getMenuCache(RID).items.find(i => i.id === 'dal');
  assert.equal('modifier_groups' in dal, false);
  assert.equal('day_parts' in dal, false);
  assert.equal('station' in dal, false);
});

test('an edit made while the plan hides modifiers does not delete them', async () => {
  reset();
  cache.setFeatureProvider(() => STARTER);

  const r = await cache.updateCatalog('menu', 0, rename('chai', 'Masala Chai'));
  assert.equal(r.ok, true);

  const dal = stored().items.find(i => i.id === 'dal');
  assert.ok(dal.modifier_groups, 'the modifiers are still stored');
  assert.equal(dal.modifier_groups[0].options[0].label, 'Mild');
  assert.ok(dal.day_parts, 'and the day-part pricing');
  assert.equal(dal.station, 'bar', 'and the station');
  assert.equal(stored().items.find(i => i.id === 'chai').name, 'Masala Chai', 'the edit itself was saved');
});

test('upgrading back after an edit on a lower plan restores everything that was hidden', async () => {
  reset();
  cache.setFeatureProvider(() => STARTER);
  await cache.updateCatalog('menu', 0, rename('chai', 'Masala Chai'));

  cache.setFeatureProvider(() => null);
  const dal = cache.getMenuCache(RID).items.find(i => i.id === 'dal');
  assert.equal(dal.modifier_groups.length, 1);
  assert.equal(dal.day_parts.length, 1);
  assert.equal(dal.station, 'bar');
});

test('a stock flag is shown but is never written into the stored menu by an edit', async () => {
  reset();
  cache.setStockProvider(items => items.map(i => (i.id === 'dal' ? { ...i, stock_out: true } : i)));
  assert.equal(cache.getMenuCache(RID).items.find(i => i.id === 'dal').stock_out, true, 'shown');

  const r = await cache.updateCatalog('menu', 0, rename('chai', 'Masala Chai'));
  assert.equal(r.ok, true);
  assert.equal(stored().items.some(i => 'stock_out' in i), false, 'not stored');
  assert.equal(r.data.items.some(i => 'stock_out' in i), false, 'and not in what the editor is handed back');
});

test('the revision an editor must quote is the stored menu\'s, whatever overlays are on', async () => {
  reset();
  cache.setFeatureProvider(() => STARTER);
  cache.setStockProvider(items => items.map(i => ({ ...i, stock_out: true })));
  assert.equal(cache.getMenuCache(RID).revision, 0);
  assert.equal((await cache.updateCatalog('menu', 0, rename('chai', 'x'))).ok, true);
  assert.equal(cache.getMenuCache(RID).revision, 1);
});

test('reads still get the overlays: the order pricer and the handsets keep seeing the gated, flagged menu', () => {
  reset();
  cache.setFeatureProvider(() => STARTER);
  cache.setStockProvider(items => items.map(i => (i.id === 'chai' ? { ...i, stock_out: true } : i)));
  const shown = cache.getMenuCache(RID);
  assert.equal('modifier_groups' in shown.items.find(i => i.id === 'dal'), false);
  assert.equal(shown.items.find(i => i.id === 'chai').stock_out, true);
});

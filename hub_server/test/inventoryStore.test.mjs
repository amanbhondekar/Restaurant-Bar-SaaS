import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InventoryStore } from '../lib/inventoryStore.js';

// The store around the rules: persistence, tenants, notifications. Each test gets its own directory
// so none of it can touch the repository's hub_server/data.

const MENU = [
  { id: 'paneer', name: 'Paneer Tikka', available: true },
  { id: 'dal', name: 'Dal Tadka', available: true }
];
const RID = 'rest-1';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-store-'));
  const file = path.join(dir, 'inventory.json');
  const store = new InventoryStore(file);
  store.setMenuProvider(() => MENU);
  return { dir, file, store };
}
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };

/** A store with paneer (1000 g) used by the paneer dish at 150 g a portion. */
function withPaneer() {
  const ctx = fresh();
  const ing = ok(ctx.store.addIngredient(RID, { name: 'Paneer', unit: 'g', on_hand: 1000, low_at: 200 })).meta.item;
  ok(ctx.store.setRecipe(RID, { item_id: 'paneer', lines: [{ inventory_item_id: ing.id, qty: 150 }] }, { items: MENU }));
  return { ...ctx, ing };
}

test('store: what is saved is what a restart reads back', async () => {
  const { dir, file, store, ing } = withPaneer();
  ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 50 }, { by: 'Reception' }));
  await store.flush();

  const reopened = new InventoryStore(file);
  assert.equal(reopened.state.restaurant_id, RID);
  assert.equal(reopened.state.items[0].on_hand, 1050);
  assert.equal(reopened.state.recipes.length, 1);
  assert.equal(reopened.state.movements.at(-1).reason, 'receive');
  assert.equal(reopened.state.revision, store.state.revision);
  await store.flush();
  cleanup(dir);
});

test('store: a burst of changes leaves the file holding the last one, not an older snapshot', async () => {
  const { dir, file, store, ing } = withPaneer();
  for (let i = 0; i < 60; i++) ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 1 }));
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).items[0].on_hand, 1060);
  await store.flush();
  cleanup(dir);
});

test('store: no file yet is an empty inventory, not an error', async () => {
  const { dir, store } = fresh();
  assert.equal(store.isEmpty(), true);
  assert.deepEqual(store.snapshot(RID).summary, { ingredients: 0, out: 0, low: 0, reorder: 0, recipes: 0 });
  await store.flush();
  cleanup(dir);
});

test('store: an unreadable file is set aside rather than overwritten, and the hub starts empty', async () => {
  const { dir, file } = fresh();
  fs.writeFileSync(file, '{"items":[{"id":"ing_1","name":"Pan');           // cut off mid-write
  const quiet = console.error; console.error = () => {};
  let store;
  try { store = new InventoryStore(file); } finally { console.error = quiet; }

  assert.equal(store.isEmpty(), true);
  const kept = fs.readdirSync(dir).filter(f => f.startsWith('inventory.corrupt-'));
  assert.equal(kept.length, 1, 'the damaged file is kept');
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf-8'), '{"items":[{"id":"ing_1","name":"Pan', 'byte for byte');
  await store.flush();
  cleanup(dir);
});

test('store: a file with damaged rows loads what is valid', async () => {
  const { dir, file } = fresh();
  fs.writeFileSync(file, JSON.stringify({
    restaurant_id: RID, revision: 3,
    items: [{ id: 'ing_a', name: 'Salt', unit: 'g', on_hand: 10, low_at: 1 }, { id: 'ing_b', name: '', unit: 'g' }],
    recipes: []
  }));
  const store = new InventoryStore(file);
  assert.equal(store.state.items.length, 1);
  assert.equal(store.state.items[0].name, 'Salt');
  await store.flush();
  cleanup(dir);
});

// --- tenants -------------------------------------------------------------------------------

test('tenants: a hub re-paired to another restaurant keeps the old stock aside and starts empty', async () => {
  const { dir, file, store } = withPaneer();
  await store.flush();
  const quiet = console.warn; console.warn = () => {};
  try { ok(store.addIngredient('rest-2', { name: 'Flour', unit: 'kg', on_hand: 5 })); } finally { console.warn = quiet; }

  assert.deepEqual(store.state.items.map(i => i.name), ['Flour'], 'the new tenant sees only its own');
  assert.equal(store.state.restaurant_id, 'rest-2');
  const archived = fs.readdirSync(dir).filter(f => f.startsWith('inventory.rest-1'));
  assert.equal(archived.length, 1, 'rest-1\'s stock is kept under its own name');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, archived[0]), 'utf-8')).items[0].name, 'Paneer');
  await store.flush();
  cleanup(dir);
});

test('tenants: reading as another restaurant sees nothing and changes nothing', async () => {
  const { dir, store } = withPaneer();
  assert.equal(store.snapshot('someone-else').items.length, 0);
  assert.deepEqual(store.check('someone-else', [{ id: 'paneer', qty: 999 }]), [], 'their orders are not held up by ours');
  const items = [{ id: 'paneer', name: 'x' }];
  assert.equal(store.overlay('someone-else', items), items);
  assert.equal(store.state.restaurant_id, RID, 'a read must not re-home the store');
  await store.flush();
  cleanup(dir);
});

test('tenants: a store that has not met a restaurant yet adopts the first one that writes to it', async () => {
  const { dir, store } = fresh();
  assert.equal(store.state.restaurant_id, null);
  ok(store.addIngredient('rest-9', { name: 'Salt', unit: 'g' }));
  assert.equal(store.state.restaurant_id, 'rest-9');
  assert.equal(fs.readdirSync(dir).some(f => f.startsWith('inventory.rest')), false, 'nothing to archive');
  await store.flush();
  cleanup(dir);
});

// --- orders --------------------------------------------------------------------------------

test('orders: check says what is short; consume takes the stock; the next check sees it', async () => {
  const { dir, store } = withPaneer();
  assert.deepEqual(store.check(RID, [{ id: 'paneer', qty: 6 }]), []);
  assert.equal(store.check(RID, [{ id: 'paneer', qty: 7 }]).length, 1);

  ok(store.consume(RID, [{ id: 'paneer', qty: 6 }], { ref: 'T-1' }));
  assert.equal(store.state.items[0].on_hand, 100);
  assert.equal(store.check(RID, [{ id: 'paneer', qty: 1 }]).length, 1, 'only 100 g is left and a portion is 150');
  await store.flush();
  cleanup(dir);
});

test('orders: consuming for an untracked dish saves nothing and tells nobody', async () => {
  const { dir, store } = withPaneer();
  await store.flush();
  const rev = store.state.revision;
  let heard = 0;
  store.onChange(() => { heard++; });
  const r = ok(store.consume(RID, [{ id: 'dal', qty: 4 }], {}));
  assert.equal(store.state.revision, rev);
  assert.equal(heard, 0);
  assert.equal(r.availability_changed, false);
  await store.flush();
  cleanup(dir);
});

// --- notifications -------------------------------------------------------------------------

test('listeners: told when an order pushes a dish out of stock, and when a delivery brings it back', async () => {
  const { dir, store, ing } = withPaneer();
  const heard = [];
  store.onChange(e => heard.push(e));

  ok(store.consume(RID, [{ id: 'paneer', qty: 6 }], {}));          // 1000 -> 100: a portion needs 150
  assert.deepEqual(heard.map(e => e.availability_changed), [true], 'paneer just went out of stock');

  ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 500 }));
  assert.deepEqual(heard.map(e => e.availability_changed), [true, true], 'and now it is back');
  await store.flush();
  cleanup(dir);
});

test('listeners: a change that does not move any dish in or out of stock says so', async () => {
  const { dir, store, ing } = withPaneer();
  const heard = [];
  store.onChange(e => heard.push(e));
  ok(store.consume(RID, [{ id: 'paneer', qty: 1 }], {}));          // 1000 -> 850: still plenty
  ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 10 }));
  ok(store.updateIngredient(RID, ing.id, { low_at: 300 }));
  assert.deepEqual(heard.map(e => e.availability_changed), [false, false, false]);
  assert.ok(heard.every(e => Number.isInteger(e.revision)));
  await store.flush();
  cleanup(dir);
});

test('listeners: told when an EXTRA runs out, though no dish moved -- handsets must refresh their sheet', async () => {
  const { dir, store } = fresh();
  const EXTRAS = { id: 'g_extras', label: 'Extras', min: 0, max: 1, options: [{ id: 'o_cheese', label: 'Extra cheese', price_delta: 30, available: true }] };
  const menu = [{ id: 'toast', name: 'Toast', available: true, modifier_groups: [EXTRAS] }];
  store.setMenuProvider(() => menu);
  const cheese = ok(store.addIngredient(RID, { name: 'Cheese', unit: 'g', on_hand: 50, low_at: 0 }, {})).meta.item;
  ok(store.setRecipe(RID, { item_id: 'toast', lines: [{ inventory_item_id: cheese.id, qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }] }, { items: menu }));

  const heard = [];
  store.onChange(e => heard.push(e));
  ok(store.consume(RID, [{ id: 'toast', qty: 2, modifiers: [{ group_id: 'g_extras', option_id: 'o_cheese' }] }], {}));   // 50 -> 10: an extra needs 20
  assert.deepEqual(heard.map(e => e.availability_changed), [true], 'the extra just went out of stock');

  ok(store.adjust(RID, cheese.id, { kind: 'receive', qty: 100 }));
  assert.deepEqual(heard.map(e => e.availability_changed), [true, true], 'and now it is back');
  ok(store.adjust(RID, cheese.id, { kind: 'receive', qty: 5 }));
  assert.deepEqual(heard.map(e => e.availability_changed), [true, true, false], 'a delivery that changes nothing says so');
  await store.flush();
  cleanup(dir);
});

test('listeners: a refused change tells nobody and saves nothing', async () => {
  const { dir, store, ing } = withPaneer();
  await store.flush();
  const rev = store.state.revision;
  let heard = 0;
  store.onChange(() => { heard++; });
  const r = store.adjust(RID, ing.id, { kind: 'waste', qty: 99999 });
  assert.equal(r.ok, false);
  assert.equal(heard, 0);
  assert.equal(store.state.revision, rev);
  await store.flush();
  cleanup(dir);
});

test('listeners: one that throws does not stop the change or the other listeners', async () => {
  const { dir, store, ing } = withPaneer();
  let second = 0;
  store.onChange(() => { throw new Error('boom'); });
  store.onChange(() => { second++; });
  const quiet = console.error; console.error = () => {};
  try { ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 5 })); } finally { console.error = quiet; }
  assert.equal(second, 1);
  assert.equal(store.state.items[0].on_hand, 1005, 'the stock still changed');
  await store.flush();
  cleanup(dir);
});

test('listeners: can be removed', async () => {
  const { dir, store, ing } = withPaneer();
  let n = 0;
  const off = store.onChange(() => { n++; });
  off();
  ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 5 }));
  assert.equal(n, 0);
  await store.flush();
  cleanup(dir);
});

// --- reading -------------------------------------------------------------------------------

test('snapshot: ingredients carry their level, with counts for the header', async () => {
  const { dir, store, ing } = withPaneer();
  ok(store.adjust(RID, ing.id, { kind: 'count', qty: 150 }));
  const snap = store.snapshot(RID);
  assert.equal(snap.items[0].level, 'low', '150 is at or under the 200 level');
  assert.deepEqual(snap.summary, { ingredients: 1, out: 0, low: 1, reorder: 1, recipes: 1 });
  ok(store.adjust(RID, ing.id, { kind: 'count', qty: 0 }));
  assert.equal(store.snapshot(RID).items[0].level, 'out');
  await store.flush();
  cleanup(dir);
});

test('movements: newest first, filterable by ingredient, and the limit is bounded', async () => {
  const { dir, store, ing } = withPaneer();
  const other = ok(store.addIngredient(RID, { name: 'Salt', unit: 'g', on_hand: 100 })).meta.item;
  ok(store.adjust(RID, ing.id, { kind: 'receive', qty: 1 }));
  ok(store.adjust(RID, other.id, { kind: 'waste', qty: 5 }));

  const all = store.movements(RID);
  assert.equal(all[0].reason, 'waste', 'most recent first');
  assert.deepEqual(store.movements(RID, { itemId: ing.id }).map(m => m.reason), ['receive', 'opening']);
  assert.equal(store.movements(RID, { limit: 1 }).length, 1);
  assert.equal(store.movements(RID, { limit: 'lots' }).length, all.length, 'a junk limit falls back to the default');
  assert.equal(store.movements(RID, { limit: -5 }).length, 1, 'and a negative one to the minimum');
  await store.flush();
  cleanup(dir);
});

test('overlay: dishes that cannot be made are flagged, and the menu itself is not touched', async () => {
  const { dir, store } = withPaneer();
  ok(store.consume(RID, [{ id: 'paneer', qty: 6 }], {}));
  const out = store.overlay(RID, MENU);
  assert.equal(out.find(i => i.id === 'paneer').stock_out, true);
  assert.equal(out.find(i => i.id === 'paneer').available, true);
  assert.equal(MENU[0].stock_out, undefined);
  await store.flush();
  cleanup(dir);
});

test('restore: replaces everything for a tenant and normalises what it was given', async () => {
  const { dir, file, store } = fresh();
  store.replaceAll(RID, {
    revision: 7,
    items: [{ id: 'ing_a', name: 'Salt', unit: 'g', on_hand: 10 }, { id: 'bad', name: '', unit: 'g' }],
    recipes: [{ id: 'rec_a', item_id: 'dal', variant_id: null, lines: [{ inventory_item_id: 'ing_a', qty: 2 }] }]
  });
  await store.flush();
  const back = new InventoryStore(file);
  assert.equal(back.state.restaurant_id, RID);
  assert.equal(back.state.items.length, 1);
  assert.equal(back.state.recipes.length, 1);
  assert.equal(back.state.revision, 7);
  await store.flush();
  cleanup(dir);
});

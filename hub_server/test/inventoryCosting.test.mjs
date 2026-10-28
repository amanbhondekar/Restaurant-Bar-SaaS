import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, normalizeState, addIngredient, updateIngredient, setRecipe, recipeCost, reorderList, summarize, validateIngredientInput
} from '../lib/inventory.js';
import { inventoryItemRow, pushInventory, pullInventory, isMissingPricingColumn } from '../lib/inventorySync.js';
import { cloudSchema } from '../lib/sqlSchema.js';
import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Costing, "stock up to" levels and the shopping list (§3 inventory limits). The principle the cost rules
// keep: an uncosted ingredient is an UNKNOWN cost, not a free one, and a figure that is only part of the
// truth is said to be.

const ctx = { now: new Date('2026-10-22T12:00:00.000Z') };
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
const refused = (r, code) => { assert.equal(r.ok, false, 'expected a refusal'); if (code) assert.equal(r.code, code); return r; };
const MENU = { items: [{ id: 'biryani', name: 'Biryani', price: 260, modifier_groups: [{ id: 'g', label: 'Extras', options: [{ id: 'cheese', label: 'Extra cheese', price_delta: 30 }] }] }] };

function kitchen(figures = {}) {
  let s = emptyState('r');
  const ids = {};
  for (const [key, name, unit, on_hand, extra] of [
    ['rice', 'Rice', 'kg', 5, figures.rice ?? { unit_cost: 90 }],
    ['cheese', 'Cheese', 'g', 100, figures.cheese ?? { unit_cost: 0.5 }],
    ['oil', 'Oil', 'l', 3, figures.oil ?? {}]
  ]) {
    const r = addIngredient(s, { name, unit, on_hand, low_at: 0, ...extra }, ctx);
    s = ok(r);
    ids[key] = r.meta.item.id;
  }
  return { s, ids };
}

// --- the figures themselves --------------------------------------------------------------------------

test('cost and stock-up-to are optional, and an ingredient without them is exactly what it always was', () => {
  const s = ok(addIngredient(emptyState('r'), { name: 'Salt', unit: 'kg', on_hand: 2 }, ctx));
  assert.deepEqual([s.items[0].par, s.items[0].unit_cost], [0, null]);
});

test('a cost is zero or more, in rupees, with at most four decimals; null clears it', () => {
  for (const unit_cost of [0, 90, 0.4567, 999999.9999]) assert.equal(validateIngredientInput({ name: 'x', unit: 'g', unit_cost }).ok, true, String(unit_cost));
  for (const unit_cost of [-1, 0.00001, 'cheap', NaN, Infinity, 1e7]) assert.equal(validateIngredientInput({ name: 'x', unit: 'g', unit_cost }).ok, false, String(unit_cost));
  assert.equal(validateIngredientInput({ unit_cost: null }, { partial: true }).ok, true);
});

test('a free ingredient (cost 0) is not the same as one that has not been costed', () => {
  const { s, ids } = kitchen({ rice: { unit_cost: 0 }, cheese: {} });
  assert.equal(s.items.find(i => i.id === ids.rice).unit_cost, 0);
  assert.equal(s.items.find(i => i.id === ids.cheese).unit_cost, null);
  const withRecipe = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 1 }] }, MENU));
  assert.deepEqual(recipeCost(withRecipe, withRecipe.recipes[0]), { cost: 0, complete: true, extras: {} }, 'free is known');
});

test('the stock-up-to level has to be above the warning level, whichever of them is edited', () => {
  const { s, ids } = kitchen();
  refused(addIngredient(s, { name: 'Flour', unit: 'kg', low_at: 5, par: 5 }, ctx), 'INVALID_INGREDIENT');
  refused(addIngredient(s, { name: 'Flour', unit: 'kg', low_at: 5, par: 2 }, ctx), 'INVALID_INGREDIENT');
  ok(addIngredient(s, { name: 'Flour', unit: 'kg', low_at: 5, par: 20 }, ctx));
  ok(addIngredient(s, { name: 'Sugar', unit: 'kg', low_at: 5 }, ctx));                      // no par: fine

  let t = ok(updateIngredient(s, ids.rice, { low_at: 2, par: 10 }));
  refused(updateIngredient(t, ids.rice, { low_at: 10 }), 'INVALID_INGREDIENT');             // raising the warning past par
  refused(updateIngredient(t, ids.rice, { par: 1 }), 'INVALID_INGREDIENT');                 // lowering par below the warning
  t = ok(updateIngredient(t, ids.rice, { par: 0 }));                                         // clearing par
  assert.equal(t.items.find(i => i.id === ids.rice).par, 0);
});

test('a cost can be changed or cleared later without touching stock', () => {
  const { s, ids } = kitchen();
  const t = ok(updateIngredient(s, ids.rice, { unit_cost: 110 }));
  assert.equal(t.items.find(i => i.id === ids.rice).unit_cost, 110);
  assert.equal(t.items.find(i => i.id === ids.rice).on_hand, 5);
  assert.equal(ok(updateIngredient(t, ids.rice, { unit_cost: null })).items.find(i => i.id === ids.rice).unit_cost, null);
});

test('figures survive a read from disk, and damaged ones fall back rather than being trusted', () => {
  const raw = { items: [
    { id: 'a', name: 'A', unit: 'g', on_hand: 1, low_at: 0, par: 10, unit_cost: 2.5 },
    { id: 'b', name: 'B', unit: 'g', on_hand: 1, low_at: 0, par: -3, unit_cost: -1 },
    { id: 'c', name: 'C', unit: 'g', on_hand: 1, low_at: 0, par: 'lots', unit_cost: 'cheap' },
    { id: 'd', name: 'D', unit: 'g', on_hand: 1, low_at: 0 },
    { id: 'e', name: 'E', unit: 'g', on_hand: 1, low_at: 0, unit_cost: null, par: null }
  ] };
  assert.deepEqual(normalizeState(raw).items.map(i => [i.par, i.unit_cost]), [[10, 2.5], [0, null], [0, null], [0, null], [0, null]]);
});

// --- what a dish costs -------------------------------------------------------------------------------

test('a dish costs what its ingredients cost, per portion', () => {
  const { s, ids } = kitchen();
  const t = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 0.3 }, { inventory_item_id: ids.cheese, qty: 10 }] }, MENU));
  // 0.3 kg x 90 + 10 g x 0.5 = 27 + 5
  assert.deepEqual(recipeCost(t, t.recipes[0]), { cost: 32, complete: true, extras: {} });
});

test('an uncosted ingredient makes the cost INCOMPLETE -- a floor, never presented as the cost', () => {
  const { s, ids } = kitchen();
  const t = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 0.3 }, { inventory_item_id: ids.oil, qty: 0.05 }] }, MENU));
  assert.deepEqual(recipeCost(t, t.recipes[0]), { cost: 27, complete: false, extras: {} });
});

test('an extra is costed on its own and never folded into the dish', () => {
  const { s, ids } = kitchen();
  const t = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 0.3 }, { inventory_item_id: ids.cheese, qty: 20, group_id: 'g', option_id: 'cheese' }] }, MENU));
  assert.deepEqual(recipeCost(t, t.recipes[0]), { cost: 27, complete: true, extras: { 'g|cheese': { cost: 10, complete: true } } });
});

test('costs are rounded to the paisa, so a long chain of grams does not show floating-point dust', () => {
  const { s, ids } = kitchen({ rice: { unit_cost: 0.1 }, cheese: { unit_cost: 0.2 } });
  const t = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 3 }, { inventory_item_id: ids.cheese, qty: 3 }] }, MENU));
  assert.equal(recipeCost(t, t.recipes[0]).cost, 0.9);
});

// --- the shopping list -------------------------------------------------------------------------------

function shelf() {
  let s = emptyState('r');
  const add = (name, unit, on_hand, low_at, par, unit_cost) => { s = ok(addIngredient(s, { name, unit, on_hand, low_at, ...(par ? { par } : {}), ...(unit_cost !== undefined ? { unit_cost } : {}) }, ctx)); };
  add('Paneer', 'kg', 0.5, 2, 10, 300);     // low: wants 9.5 kg = 2850
  add('Onion', 'kg', 0, 3, 12, 40);          // out: wants 12 kg = 480
  add('Oil', 'l', 1, 2);                      // low, no par, no cost
  add('Salt', 'kg', 9, 1, 5, 20);             // fine
  add('Tea', 'g', 400, 500, 2000);           // low: wants 1600 g, uncosted
  return s;
}

test('the list holds everything at or below its warning level, and nothing else', () => {
  assert.deepEqual(reorderList(shelf()).items.map(i => i.name).sort(), ['Oil', 'Onion', 'Paneer', 'Tea']);
});

test('what is out comes before what is merely low, and within the low the furthest below its warning level comes first', () => {
  // Paneer is at 25% of its warning level, Oil at 50%, Tea at 80%.
  assert.deepEqual(reorderList(shelf()).items.map(i => [i.name, i.level]), [['Onion', 'out'], ['Paneer', 'low'], ['Oil', 'low'], ['Tea', 'low']]);
});

test('with a stock-up-to level the suggestion is how much brings it back there', () => {
  const byName = Object.fromEntries(reorderList(shelf()).items.map(i => [i.name, i]));
  assert.deepEqual([byName.Paneer.suggested, byName.Onion.suggested, byName.Tea.suggested], [9.5, 12, 1600]);
});

test('without one the item is still listed -- the warning was set -- but no quantity is invented', () => {
  const oil = reorderList(shelf()).items.find(i => i.name === 'Oil');
  assert.deepEqual([oil.suggested, oil.estimated_cost], [null, null]);
});

test('an estimate exists only where there is a cost, and the total says how many items it leaves out', () => {
  const list = reorderList(shelf());
  const byName = Object.fromEntries(list.items.map(i => [i.name, i]));
  assert.deepEqual([byName.Paneer.estimated_cost, byName.Onion.estimated_cost, byName.Tea.estimated_cost, byName.Oil.estimated_cost], [2850, 480, null, null]);
  assert.equal(list.estimated_total, 3330);
  assert.equal(list.unpriced, 2, 'Tea has no cost and Oil has no quantity: the total is not the whole bill');
});

test('an ingredient already above its stock-up-to level suggests nothing rather than a negative', () => {
  let s = emptyState('r');
  s = ok(addIngredient(s, { name: 'Rice', unit: 'kg', on_hand: 1, low_at: 2, par: 5 }, ctx));
  assert.equal(reorderList(s).items[0].suggested, 4, '5 - 1');
  const full = { ...s, items: [{ ...s.items[0], on_hand: 1, par: 5, low_at: 9 }] };      // hand-edited file: warning above par
  assert.equal(reorderList(full).items[0].suggested, 4);
  const over = { ...s, items: [{ ...s.items[0], on_hand: 9, par: 5, low_at: 9 }] };
  assert.equal(reorderList(over).items[0].suggested, 0, 'never negative');
});

test('an empty shelf gives an empty list, not an error', () => {
  assert.deepEqual(reorderList(emptyState('r')), { items: [], estimated_total: 0, unpriced: 0 });
});

test('the header counts what is on the list', () => {
  assert.equal(summarize(shelf()).reorder, 4);
});

// --- the cloud copy, with and without migration 012 ----------------------------------------------------

const RID = RESTAURANT_ID;
const COSTED = { id: 'ing_1', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10, par: 500, unit_cost: 0.45 };

function fakeCloud({ migrated012 = true } = {}) {
  const rows = { inventory_items: [], recipes: [] };
  const log = [];
  const missing = row => !migrated012 && ('par' in row || 'unit_cost' in row);
  return {
    rows, log,
    from(table) {
      return {
        upsert: async batch => {
          log.push(`upsert ${table}`);
          if (batch.some(missing)) return { error: { code: 'PGRST204', message: "Could not find the 'par' column of 'inventory_items' in the schema cache" } };
          for (const r of batch) {
            const at = rows[table].findIndex(x => x.hub_ref === r.hub_ref);
            if (at >= 0) rows[table][at] = r; else rows[table].push({ ...r });
          }
          return { error: null };
        },
        select: list => ({
          eq: async () => {
            log.push(`select ${table}: ${list}`);
            if (!migrated012 && /\bpar\b|unit_cost/.test(list)) return { data: null, error: { code: '42703', message: 'column inventory_items.par does not exist' } };
            return { data: rows[table], error: null };
          }
        }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
      };
    }
  };
}

test('the cloud row carries cost and level, as explicit nulls when they are not set', () => {
  assert.deepEqual(inventoryItemRow(RID, COSTED), { restaurant_id: RID, hub_ref: 'ing_1', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10, par: 500, unit_cost: 0.45 });
  const plain = inventoryItemRow(RID, { id: 'x', name: 'Salt', unit: 'kg', on_hand: 1, low_at: 0, par: 0, unit_cost: null });
  assert.deepEqual([plain.par, plain.unit_cost, 'par' in plain, 'unit_cost' in plain], [null, null, true, true], 'present and null, so an upsert can clear them');
  assert.equal(inventoryItemRow(RID, { id: 'z', name: 'Z', unit: 'g', on_hand: 1, low_at: 0, unit_cost: 0 }).unit_cost, 0, 'free is not null');
});

test('cloud: costs and levels go up and come back whole on a migrated project', async () => {
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, { items: [COSTED], recipes: [] });
  const back = await pullInventory(cloud, RID);
  assert.deepEqual([back.items[0].par, back.items[0].unit_cost], [500, 0.45]);
});

test('cloud: a project that has not run 012 still gets the stock, just without the two figures', async () => {
  const cloud = fakeCloud({ migrated012: false });
  const result = await pushInventory(cloud, RID, { items: [COSTED], recipes: [] });
  assert.equal(result.items, 1);
  assert.deepEqual(Object.keys(cloud.rows.inventory_items[0]).sort(), ['hub_ref', 'low_at', 'name', 'on_hand', 'restaurant_id', 'unit']);
  assert.equal(cloud.log.filter(l => l === 'upsert inventory_items').length, 2, 'tried with, then without');
});

test('cloud: restoring from a project without 012 works too, with the figures simply absent', async () => {
  const cloud = fakeCloud({ migrated012: false });
  cloud.rows.inventory_items.push({ hub_ref: 'ing_1', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10 });
  const back = await pullInventory(cloud, RID);
  assert.deepEqual([back.items[0].name, back.items[0].par, back.items[0].unit_cost], ['Cheese', 0, null]);
});

test('cloud: only a missing PRICING column triggers the fallback -- any other refusal still stops the push', async () => {
  assert.equal(isMissingPricingColumn({ code: 'PGRST204', message: "Could not find the 'par' column of 'inventory_items'" }), true);
  assert.equal(isMissingPricingColumn({ code: '42703', message: 'column "unit_cost" of relation "inventory_items" does not exist' }), true);
  assert.equal(isMissingPricingColumn({ code: 'PGRST204', message: "Could not find the 'name' column of 'inventory_items'" }), false);
  assert.equal(isMissingPricingColumn({ code: '42501', message: 'permission denied for table inventory_items (par)' }), false);
  assert.equal(isMissingPricingColumn({ code: 'PGRST204', message: "Could not find the 'parity' column" }), false, 'a column that merely contains the letters');
  assert.equal(isMissingPricingColumn(null), false);

  const cloud = fakeCloud();
  cloud.from = () => ({ upsert: async () => ({ error: { code: '42501', message: 'permission denied' } }) });
  // The Supabase error is thrown as it came, not wrapped.
  await assert.rejects(() => pushInventory(cloud, RID, { items: [COSTED], recipes: [] }), e => e.code === '42501');
});

test('migration 012 adds exactly the two columns the hub now pushes', () => {
  const before = cloudSchema(11).inventory_items.columns;
  const after = cloudSchema(12).inventory_items.columns;
  assert.deepEqual([...after.keys()].filter(c => !before.has(c)).sort(), ['par', 'unit_cost']);
  assert.equal(after.get('par').source, '012_inventory_costing.sql');
  assert.equal(after.get('unit_cost').notNull, false, 'both are optional, so an older row is still valid');
});

// --- a real hub --------------------------------------------------------------------------------------

const HUB_MENU = { restaurant_id: RID, categories: ['Mains'], items: [{ id: 'dal', name: 'Dal', price: 200, category: 'Mains', isVeg: true, available: true }] };
let hub;
before(async () => {
  hub = await startHub({ trustLoopback: true, menu: HUB_MENU, tables: { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }, enrollmentCode: 'COSTCODE' });
});
after(() => hub?.stop());

const api = (p, { method = 'GET', body } = {}) => fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = r => r.json();

test('hub: cost and level are set when adding, edited later, and read back with the list and the costs', async () => {
  const lentils = (await json(await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Lentils', unit: 'kg', on_hand: 1, low_at: 2, par: 10, unit_cost: 120 } } }))).item;
  assert.deepEqual([lentils.par, lentils.unit_cost], [10, 120]);
  await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id: 'dal', lines: [{ inventory_item_id: lentils.id, qty: 0.1 }] } });

  const snap = await json(await api('/admin/inventory'));
  assert.deepEqual(snap.recipes[0].cost, { cost: 12, complete: true, extras: {} });
  assert.deepEqual(snap.reorder.items.map(i => [i.name, i.suggested, i.estimated_cost]), [['Lentils', 9, 1080]]);
  assert.equal(snap.reorder.estimated_total, 1080);
  assert.equal(snap.summary.reorder, 1);

  const edited = await api(`/admin/inventory/items/${lentils.id}`, { method: 'PUT', body: { item: { unit_cost: 150 } } });
  assert.equal(edited.status, 200);
  assert.equal((await json(await api('/admin/inventory'))).recipes[0].cost.cost, 15);
});

test('hub: a stock-up-to level at or below the warning level is refused with the reason', async () => {
  const res = await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Bad', unit: 'kg', low_at: 5, par: 3 } } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await json(res)), /stock-up-to level must be more than the low-stock level/);
});

test('hub: a delivery that brings stock back up takes the item off the list', async () => {
  const snap = await json(await api('/admin/inventory'));
  const id = snap.items.find(i => i.name === 'Lentils').id;
  await api(`/admin/inventory/items/${id}/adjust`, { method: 'POST', body: { kind: 'receive', qty: 9 } });
  const after_ = await json(await api('/admin/inventory'));
  assert.deepEqual(after_.reorder.items, []);
  assert.equal(after_.summary.reorder, 0);
});

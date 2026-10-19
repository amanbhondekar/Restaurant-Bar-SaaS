import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNITS, emptyState, normalizeState, validateIngredientInput, addIngredient, updateIngredient, deleteIngredient,
  adjustStock, setRecipe, recipeFor, needsFor, shortagesFor, consume, levelOf, stockOutKeys, overlayMenuItems, summarize
} from '../lib/inventory.js';

// Stock and recipes: the pure rules. Everything here is plain data in, plain data out.

const NOW = new Date('2026-10-19T12:00:00.000Z');
const ctx = { now: NOW, by: 'Reception' };

/** Applies an operation that must succeed and returns the new state. */
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const refused = (result, code, status) => {
  assert.equal(result.ok, false, 'expected a refusal');
  assert.equal(result.code, code);
  if (status) assert.equal(result.status, status);
  return result;
};

const MENU = {
  items: [
    { id: 'paneer', name: 'Paneer Tikka', price: 280, available: true },
    { id: 'dal', name: 'Dal Tadka', price: 220, available: true },
    {
      id: 'biryani', name: 'Biryani', price: 260, available: true,
      variants: [{ id: 'half', label: 'Half', price: 260, available: true }, { id: 'full', label: 'Full', price: 480, available: true }]
    }
  ]
};

/** A small kitchen: paneer 1000 g, onion 2 kg, rice 5 kg, oil 3 l. Returns the state and the ids. */
function kitchen() {
  let s = emptyState('rest-1');
  const ids = {};
  for (const [key, name, unit, on_hand, low_at] of [
    ['paneer', 'Paneer', 'g', 1000, 200], ['onion', 'Onion', 'kg', 2, 0.5], ['rice', 'Rice', 'kg', 5, 1], ['oil', 'Oil', 'l', 3, 0]
  ]) {
    const r = addIngredient(s, { name, unit, on_hand, low_at }, ctx);
    s = ok(r);
    ids[key] = r.meta.item.id;
  }
  return { s, ids };
}

// --- ingredients ---------------------------------------------------------------------------

test('ingredient input: name, unit and quantities are all checked, and every problem is reported', () => {
  const bad = validateIngredientInput({ name: '   ', unit: 'cups', on_hand: -1, low_at: 'lots' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.field).sort(), ['low_at', 'name', 'on_hand', 'unit']);

  assert.equal(validateIngredientInput({ name: 'x'.repeat(81), unit: 'g' }).ok, false, 'name too long');
  assert.equal(validateIngredientInput({ name: 'Salt', unit: 'g', on_hand: 0.0001 }).ok, false, 'finer than a gram-thousandth');
  assert.equal(validateIngredientInput({ name: 'Salt', unit: 'g', on_hand: Infinity }).ok, false);
  assert.equal(validateIngredientInput({ name: 'Salt', unit: 'g', on_hand: NaN }).ok, false);
  assert.equal(validateIngredientInput({ name: 'Salt', unit: 'g', on_hand: '5' }).ok, false, 'a string is not a quantity');
  assert.equal(validateIngredientInput(null).ok, false);
  assert.equal(validateIngredientInput([]).ok, false);
  for (const unit of UNITS) assert.equal(validateIngredientInput({ name: 'x', unit }).ok, true, unit);
});

test('adding an ingredient: defaults to nothing on hand, and opening stock is logged as such', () => {
  let s = emptyState('r');
  const empty = addIngredient(s, { name: 'Salt', unit: 'kg' }, ctx);
  assert.equal(empty.meta.item.on_hand, 0);
  assert.equal(empty.data.movements.length, 0, 'nothing to log for nothing');

  const stocked = addIngredient(s, { name: 'Flour', unit: 'kg', on_hand: 10 }, ctx);
  assert.equal(stocked.data.movements.length, 1);
  assert.deepEqual(
    { reason: stocked.data.movements[0].reason, delta: stocked.data.movements[0].delta, after: stocked.data.movements[0].on_hand_after, by: stocked.data.movements[0].by },
    { reason: 'opening', delta: 10, after: 10, by: 'Reception' }
  );
});

test('adding an ingredient: a name already used, in any case, is refused', () => {
  const { s } = kitchen();
  refused(addIngredient(s, { name: '  PANEER ', unit: 'g' }), 'DUPLICATE_INGREDIENT', 409);
});

test('the revision moves on every successful change and never on a refused one', () => {
  const { s, ids } = kitchen();
  const before = s.revision;
  refused(addIngredient(s, { name: 'Paneer', unit: 'g' }), 'DUPLICATE_INGREDIENT');
  refused(adjustStock(s, ids.paneer, { kind: 'waste', qty: 99999 }), 'EXCEEDS_STOCK');
  assert.equal(s.revision, before);
  assert.equal(ok(adjustStock(s, ids.paneer, { kind: 'receive', qty: 1 })).revision, before + 1);
});

test('editing an ingredient: name and level change; stock on hand does not', () => {
  const { s, ids } = kitchen();
  const renamed = ok(updateIngredient(s, ids.paneer, { name: 'Cottage cheese', low_at: 300 }));
  const item = renamed.items.find(i => i.id === ids.paneer);
  assert.equal(item.name, 'Cottage cheese');
  assert.equal(item.low_at, 300);
  assert.equal(item.on_hand, 1000, 'untouched');

  // Changing the amount has to say why, or the audit log would stop adding up.
  refused(updateIngredient(s, ids.paneer, { on_hand: 5 }), 'USE_ADJUSTMENT', 400);
  refused(updateIngredient(s, 'nope', { name: 'x' }), 'INGREDIENT_NOT_FOUND', 404);
  refused(updateIngredient(s, ids.paneer, { name: 'onion' }), 'DUPLICATE_INGREDIENT', 409);
  // Keeping its own name (with different case) is not a duplicate of itself.
  assert.equal(updateIngredient(s, ids.paneer, { name: 'PANEER' }).ok, true);
});

test('editing an ingredient: its unit cannot change under a recipe written in the old one', () => {
  let { s, ids } = kitchen();
  s = ok(setRecipe(s, { item_id: 'paneer', lines: [{ inventory_item_id: ids.paneer, qty: 150 }] }, MENU));
  // 150 "g" would silently become 150 "kg".
  refused(updateIngredient(s, ids.paneer, { unit: 'kg' }), 'UNIT_IN_USE', 409);
  // Unused, the unit is free to change.
  assert.equal(updateIngredient(s, ids.oil, { unit: 'ml' }).ok, true);
});

test('deleting an ingredient: refused while a recipe uses it, and its log goes with it', () => {
  let { s, ids } = kitchen();
  s = ok(setRecipe(s, { item_id: 'paneer', lines: [{ inventory_item_id: ids.paneer, qty: 150 }] }, MENU));
  refused(deleteIngredient(s, ids.paneer), 'INGREDIENT_IN_USE', 409);

  const gone = ok(deleteIngredient(s, ids.oil));
  assert.equal(gone.items.some(i => i.id === ids.oil), false);
  assert.equal(gone.movements.some(m => m.inventory_item_id === ids.oil), false);
  refused(deleteIngredient(s, 'nope'), 'INGREDIENT_NOT_FOUND', 404);
});

// --- adjustments ---------------------------------------------------------------------------

test('adjustments: a delivery adds, waste subtracts, a count sets -- each leaving a movement', () => {
  const { s, ids } = kitchen();
  const received = adjustStock(s, ids.paneer, { kind: 'receive', qty: 500, note: 'Tuesday delivery' }, ctx);
  assert.equal(received.meta.item.on_hand, 1500);
  const last = received.data.movements.at(-1);
  assert.deepEqual([last.reason, last.delta, last.on_hand_after, last.note], ['receive', 500, 1500, 'Tuesday delivery']);

  const wasted = adjustStock(received.data, ids.paneer, { kind: 'waste', qty: 250 }, ctx);
  assert.equal(wasted.meta.item.on_hand, 1250);
  assert.equal(wasted.data.movements.at(-1).delta, -250);

  const counted = adjustStock(wasted.data, ids.paneer, { kind: 'count', qty: 900 }, ctx);
  assert.equal(counted.meta.item.on_hand, 900);
  assert.equal(counted.data.movements.at(-1).delta, -350, 'the movement records the correction, not the count');
});

test('adjustments: waste cannot take stock below zero, but a count can say there is none', () => {
  const { s, ids } = kitchen();
  const r = refused(adjustStock(s, ids.paneer, { kind: 'waste', qty: 1001 }), 'EXCEEDS_STOCK', 409);
  assert.match(r.error, /Only 1000 g of Paneer is on hand/);
  assert.equal(ok(adjustStock(s, ids.paneer, { kind: 'waste', qty: 1000 })).items.find(i => i.id === ids.paneer).on_hand, 0);
  assert.equal(ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 0 })).items.find(i => i.id === ids.paneer).on_hand, 0);
});

test('adjustments: nonsense is refused with a reason', () => {
  const { s, ids } = kitchen();
  for (const input of [
    { kind: 'receive', qty: 0 }, { kind: 'receive', qty: -5 }, { kind: 'receive', qty: 'ten' }, { kind: 'receive', qty: 0.0004 },
    { kind: 'count', qty: -1 }, { kind: 'steal', qty: 5 }, {}, { kind: 'receive', qty: 5, note: 'x'.repeat(201) }
  ]) {
    refused(adjustStock(s, ids.paneer, input), 'INVALID_ADJUSTMENT', 400);
  }
  refused(adjustStock(s, 'nope', { kind: 'receive', qty: 1 }), 'INGREDIENT_NOT_FOUND', 404);
});

test('adjustments: a count that matches what the system thought logs nothing', () => {
  const { s, ids } = kitchen();
  const r = adjustStock(s, ids.paneer, { kind: 'count', qty: 1000 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.meta.delta, 0);
  assert.equal(r.data.movements.length, s.movements.length);
});

test('adjustments: fractions do not drift (0.1 + 0.2 is 0.3 here, not 0.30000000000000004)', () => {
  let { s, ids } = kitchen();
  s = ok(adjustStock(s, ids.oil, { kind: 'count', qty: 0.1 }));
  s = ok(adjustStock(s, ids.oil, { kind: 'receive', qty: 0.2 }));
  assert.equal(s.items.find(i => i.id === ids.oil).on_hand, 0.3);
});

test('the movement log keeps only the most recent entries', () => {
  let { s, ids } = kitchen();
  for (let i = 0; i < 2100; i++) s = ok(adjustStock(s, ids.rice, { kind: 'receive', qty: 1 }));
  assert.equal(s.movements.length, 2000);
  assert.equal(s.items.find(i => i.id === ids.rice).on_hand, 5 + 2100, 'the stock itself is not capped, only the log');
});

// --- recipes -------------------------------------------------------------------------------

test('recipes: set, replace in place (keeping the id), and remove with an empty list', () => {
  let { s, ids } = kitchen();
  const first = setRecipe(s, { item_id: 'paneer', lines: [{ inventory_item_id: ids.paneer, qty: 150 }] }, MENU);
  assert.equal(first.ok, true);
  const id = first.meta.recipe.id;

  s = ok(setRecipe(first.data, { item_id: 'paneer', lines: [{ inventory_item_id: ids.paneer, qty: 180 }, { inventory_item_id: ids.onion, qty: 0.05 }] }, MENU));
  assert.equal(s.recipes.length, 1, 'replaced, not added');
  assert.equal(s.recipes[0].id, id);
  assert.equal(s.recipes[0].lines.length, 2);

  s = ok(setRecipe(s, { item_id: 'paneer', lines: [] }, MENU));
  assert.equal(s.recipes.length, 0, 'an empty recipe un-tracks the dish');
});

test('recipes: the dish, the size, every ingredient and every quantity are checked', () => {
  const { s, ids } = kitchen();
  refused(setRecipe(s, { item_id: 'ghost', lines: [] }, MENU), 'ITEM_NOT_FOUND', 404);
  refused(setRecipe(s, { item_id: 'dal', variant_id: 'half', lines: [] }, MENU), 'VARIANT_NOT_FOUND', 404);
  refused(setRecipe(s, { item_id: 'dal', lines: 'rice' }, MENU), 'INVALID_RECIPE', 400);
  refused(setRecipe(s, null, MENU), 'INVALID_RECIPE', 400);

  const bad = refused(setRecipe(s, {
    item_id: 'dal',
    lines: [
      { inventory_item_id: 'ing_nope', qty: 1 },
      { inventory_item_id: ids.rice, qty: 0 },
      { inventory_item_id: ids.onion, qty: 0.0001 },
      { inventory_item_id: ids.oil, qty: 0.1 },
      { inventory_item_id: ids.oil, qty: 0.1 }
    ]
  }, MENU), 'INVALID_RECIPE', 400);
  assert.equal(bad.errors.length, 4, 'unknown, zero, too-fine, and the repeated ingredient');
  assert.ok(bad.errors.some(e => /once/.test(e.message)));

  const tooMany = Array.from({ length: 31 }, () => ({ inventory_item_id: ids.rice, qty: 1 }));
  refused(setRecipe(s, { item_id: 'dal', lines: tooMany }, MENU), 'INVALID_RECIPE', 400);
});

test('recipes: a size\'s own recipe wins over the dish-wide one, which covers any size without its own', () => {
  let { s, ids } = kitchen();
  s = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 0.2 }] }, MENU));
  s = ok(setRecipe(s, { item_id: 'biryani', variant_id: 'full', lines: [{ inventory_item_id: ids.rice, qty: 0.4 }] }, MENU));

  assert.equal(recipeFor(s, 'biryani', 'full').lines[0].qty, 0.4, 'Full has its own');
  assert.equal(recipeFor(s, 'biryani', 'half').lines[0].qty, 0.2, 'Half falls back to the dish-wide recipe');
  assert.equal(recipeFor(s, 'biryani', null).lines[0].qty, 0.2);
  assert.equal(recipeFor(s, 'dal', null), null, 'no recipe means not tracked');
});

// --- what an order needs -------------------------------------------------------------------

function stocked() {
  let { s, ids } = kitchen();
  s = ok(setRecipe(s, { item_id: 'paneer', lines: [{ inventory_item_id: ids.paneer, qty: 150 }, { inventory_item_id: ids.onion, qty: 0.1 }] }, MENU));
  s = ok(setRecipe(s, { item_id: 'dal', lines: [{ inventory_item_id: ids.onion, qty: 0.2 }, { inventory_item_id: ids.oil, qty: 0.05 }] }, MENU));
  s = ok(setRecipe(s, { item_id: 'biryani', variant_id: 'half', lines: [{ inventory_item_id: ids.rice, qty: 0.2 }] }, MENU));
  s = ok(setRecipe(s, { item_id: 'biryani', variant_id: 'full', lines: [{ inventory_item_id: ids.rice, qty: 0.4 }] }, MENU));
  return { s, ids };
}

test('needs: quantities multiply by the line, and add across lines that share an ingredient', () => {
  const { s, ids } = stocked();
  const needs = needsFor(s, [{ id: 'paneer', qty: 2 }, { id: 'dal', qty: 3 }]);
  assert.equal(needs.get(ids.paneer).needed, 300);
  assert.equal(needs.get(ids.onion).needed, 0.8, '2 x 0.1 + 3 x 0.2, summed');
  assert.equal(needs.get(ids.oil).needed, 0.15);
  assert.deepEqual(needs.get(ids.onion).lines, [0, 1]);
});

test('needs: a dish with no recipe needs nothing, so it can never block an order', () => {
  const { s } = stocked();
  assert.equal(needsFor(s, [{ id: 'mystery', qty: 5 }]).size, 0);
  assert.deepEqual(shortagesFor(s, [{ id: 'mystery', qty: 5 }]), []);
  assert.deepEqual(shortagesFor(s, []), []);
  assert.deepEqual(shortagesFor(s, undefined), []);
});

test('shortages: two dishes that each fit alone but not together are caught together', () => {
  const { s, ids } = stocked();
  // Onion on hand: 2 kg. 6 paneer need 0.6 kg of it (and 900 g of the 1000 g of paneer), 8 dal need
  // 1.6 kg. Each fits; the order needs 2.2 kg.
  const alone1 = shortagesFor(s, [{ id: 'paneer', qty: 6 }]);
  const alone2 = shortagesFor(s, [{ id: 'dal', qty: 8 }]);
  assert.deepEqual([alone1.length, alone2.length], [0, 0]);

  const together = shortagesFor(s, [{ id: 'paneer', qty: 6 }, { id: 'dal', qty: 8 }]);
  assert.equal(together.length, 1);
  assert.deepEqual(
    { name: together[0].name, unit: together[0].unit, needed: together[0].needed, on_hand: together[0].on_hand, lines: together[0].lines },
    { name: 'Onion', unit: 'kg', needed: 2.2, on_hand: 2, lines: [0, 1] }
  );
  assert.equal(together[0].inventory_item_id, ids.onion);
});

test('shortages: exactly enough is enough', () => {
  let { s, ids } = stocked();
  assert.deepEqual(shortagesFor(s, [{ id: 'paneer', qty: 6 }]), [], '6 x 150 g = 900 of 1000');
  s = ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 900 }));
  assert.deepEqual(shortagesFor(s, [{ id: 'paneer', qty: 6 }]), [], '6 x 150 g = 900 of exactly 900');
});

test('shortages: one gram over is short', () => {
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 899 }));
  assert.equal(shortagesFor(s, [{ id: 'paneer', qty: 6 }]).length, 1, '6 x 150 g = 900 of 899');
  assert.equal(shortagesFor(s, [{ id: 'paneer', qty: 5 }]).length, 0);
});

// --- consuming -----------------------------------------------------------------------------

test('consume: takes the order out of stock and logs one movement per ingredient, with the ticket', () => {
  const { s, ids } = stocked();
  const r = consume(s, [{ id: 'paneer', qty: 2 }, { id: 'dal', qty: 1 }], { ...ctx, ref: 'T-142' });
  const stock = id => r.data.items.find(i => i.id === id).on_hand;
  assert.equal(stock(ids.paneer), 700);
  assert.equal(stock(ids.onion), 1.6, '2 kg - 0.2 - 0.2');
  assert.equal(stock(ids.oil), 2.95);
  assert.equal(stock(ids.rice), 5, 'untouched');

  assert.equal(r.meta.movements.length, 3, 'paneer, onion, oil -- one each');
  assert.ok(r.meta.movements.every(m => m.reason === 'sale' && m.ref === 'T-142'));
  assert.equal(r.data.revision, s.revision + 1);
});

test('consume: never goes below zero, even if asked to (the order check is what refuses)', () => {
  const { s, ids } = stocked();
  const r = consume(s, [{ id: 'paneer', qty: 50 }], ctx);
  assert.equal(r.data.items.find(i => i.id === ids.paneer).on_hand, 0);
  assert.equal(r.meta.movements.find(m => m.inventory_item_id === ids.paneer).delta, -1000, 'the log records what actually left');
});

test('consume: an order with nothing tracked changes nothing, including the revision', () => {
  const { s } = stocked();
  const r = consume(s, [{ id: 'mystery', qty: 3 }], ctx);
  assert.equal(r.data, s);
  assert.deepEqual(r.meta.movements, []);
});

test('consume: a size uses its own recipe', () => {
  const { s, ids } = stocked();
  const half = consume(s, [{ id: 'biryani', variant_id: 'half', qty: 1 }], ctx).data.items.find(i => i.id === ids.rice).on_hand;
  const full = consume(s, [{ id: 'biryani', variant_id: 'full', qty: 1 }], ctx).data.items.find(i => i.id === ids.rice).on_hand;
  assert.deepEqual([half, full], [4.8, 4.6]);
});

// --- levels --------------------------------------------------------------------------------

test('levels: out at zero, low at or below the level reception set, and never low when no level is set', () => {
  assert.equal(levelOf({ on_hand: 0, low_at: 5 }), 'out');
  assert.equal(levelOf({ on_hand: 5, low_at: 5 }), 'low', 'at the level counts');
  assert.equal(levelOf({ on_hand: 5.001, low_at: 5 }), 'ok');
  assert.equal(levelOf({ on_hand: 1, low_at: 0 }), 'ok', 'no level set means no warning');
  assert.deepEqual(summarize(stocked().s), { ingredients: 4, out: 0, low: 0, recipes: 4 });
});

// --- the menu overlay ----------------------------------------------------------------------

test('overlay: a dish that cannot be made from what is on hand is flagged; one that can is left alone', () => {
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 100 }));      // a portion needs 150
  const out = overlayMenuItems(s, MENU.items);

  assert.equal(out.find(i => i.id === 'paneer').stock_out, true);
  assert.equal(out.find(i => i.id === 'dal').stock_out, undefined);
  assert.equal(out.find(i => i.id === 'dal'), MENU.items.find(i => i.id === 'dal'), 'unchanged items are the same object');
});

test('overlay: `available` is never written -- a stock-out is not a hand 86, so restocking undoes it cleanly', () => {
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 0 }));
  const flagged = overlayMenuItems(s, MENU.items).find(i => i.id === 'paneer');
  assert.equal(flagged.available, true, 'still available as far as the menu is concerned');
  assert.equal(MENU.items.find(i => i.id === 'paneer').stock_out, undefined, 'the input is not mutated');

  s = ok(adjustStock(s, ids.paneer, { kind: 'receive', qty: 500 }));
  assert.equal(overlayMenuItems(s, MENU.items).find(i => i.id === 'paneer').stock_out, undefined);
});

test('overlay: a hand-86\'d dish stays 86\'d through a restock, because the two are separate', () => {
  const menu = [{ id: 'paneer', name: 'Paneer Tikka', available: false }];
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.paneer, { kind: 'receive', qty: 1 }));
  const out = overlayMenuItems(s, menu)[0];
  assert.equal(out.available, false);
  assert.equal(out.stock_out, undefined);
});

test('overlay: sizes are judged on their own recipes, and the dish is out only when every size is', () => {
  let { s, ids } = stocked();
  // 0.3 kg of rice: Half needs 0.2 (fine), Full needs 0.4 (not).
  s = ok(adjustStock(s, ids.rice, { kind: 'count', qty: 0.3 }));
  let out = overlayMenuItems(s, MENU.items).find(i => i.id === 'biryani');
  assert.equal(out.variants.find(v => v.id === 'full').stock_out, true);
  assert.equal(out.variants.find(v => v.id === 'half').stock_out, undefined);
  assert.equal(out.stock_out, undefined, 'Half can still be sold, so the dish is not out');

  s = ok(adjustStock(s, ids.rice, { kind: 'count', qty: 0.1 }));
  out = overlayMenuItems(s, MENU.items).find(i => i.id === 'biryani');
  assert.equal(out.stock_out, true, 'now neither size can be made');
});

test('overlay: a dish is out when one size is out of stock and the other is 86\'d by hand', () => {
  const menu = [{ id: 'biryani', name: 'Biryani', variants: [{ id: 'half', available: false }, { id: 'full', available: true }] }];
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.rice, { kind: 'count', qty: 0.1 }));
  const out = overlayMenuItems(s, menu)[0];
  assert.equal(out.variants[1].stock_out, true);
  assert.equal(out.stock_out, true, 'nothing at all can be ordered, and stock is part of why');
});

test('overlay: with no recipes at all the menu comes back untouched, the same array', () => {
  const s = emptyState('r');
  assert.equal(overlayMenuItems(s, MENU.items), MENU.items);
  assert.equal(overlayMenuItems(s, undefined), undefined);
  assert.equal(stockOutKeys(s, MENU.items).size, 0);
});

test('overlay: a dish-wide recipe on a dish with sizes applies to every size', () => {
  let { s, ids } = kitchen();
  s = ok(setRecipe(s, { item_id: 'biryani', lines: [{ inventory_item_id: ids.rice, qty: 6 }] }, MENU));   // 6 kg per portion: 5 on hand
  const keys = stockOutKeys(s, MENU.items);
  assert.deepEqual([...keys].sort(), ['biryani', 'biryani|full', 'biryani|half']);
});

test('overlay: one portion is the test -- stock for one but not for three does not hide the dish', () => {
  let { s, ids } = stocked();
  s = ok(adjustStock(s, ids.paneer, { kind: 'count', qty: 200 }));
  assert.equal(stockOutKeys(s, MENU.items).has('paneer'), false);
  assert.equal(shortagesFor(s, [{ id: 'paneer', qty: 3 }]).length, 1, 'the order check is what stops three');
});

// --- state read from disk ------------------------------------------------------------------

test('normalising a state from disk: junk is dropped, valid rows kept, nothing throws', () => {
  const { s } = stocked();
  assert.deepEqual(normalizeState(null, 'r'), emptyState('r'));
  assert.deepEqual(normalizeState('garbage', 'r'), emptyState('r'));
  assert.deepEqual(normalizeState([], 'r'), emptyState('r'));

  const damaged = {
    ...s,
    revision: -4,
    items: [...s.items, { id: 'bad1', name: '', unit: 'g' }, { id: 'bad2', name: 'Salt', unit: 'cups' }, null, 'x'],
    recipes: [...s.recipes, { id: 'r_orphan', item_id: 'dal', lines: [{ inventory_item_id: 'gone', qty: 1 }] }, { item_id: 'dal' }]
  };
  const n = normalizeState(damaged, 'r');
  assert.equal(n.items.length, s.items.length, 'rows with no name or an unknown unit are dropped');
  assert.equal(n.recipes.length, s.recipes.length, 'a recipe left with no valid lines is dropped');
  assert.equal(n.revision, 0, 'a nonsense revision resets rather than propagating');
  assert.deepEqual(normalizeState(s, 'other'), { ...s, restaurant_id: 'rest-1' }, 'a good state round-trips, keeping its own tenant');
});

test('normalising: stock that was negative on disk becomes zero rather than propagating', () => {
  const n = normalizeState({ items: [{ id: 'i', name: 'Salt', unit: 'g', on_hand: -40, low_at: 'x' }] }, 'r');
  assert.equal(n.items[0].on_hand, 0);
  assert.equal(n.items[0].low_at, 0);
});

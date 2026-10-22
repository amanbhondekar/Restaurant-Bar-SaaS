import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, normalizeState, addIngredient, setRecipe, needsFor, shortagesFor, consume, stockOutKeys, overlayMenuItems, cleanLine
} from '../lib/inventory.js';
import { recipeRow, pushInventory, pullInventory } from '../lib/inventorySync.js';
import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Modifier choices that use stock (§4.2): "extra cheese" takes 20 g of cheese out of the kitchen, but
// only for the portions that chose it. The rules first, then the cloud copy, then a real hub.

const ctx = { now: new Date('2026-10-22T12:00:00.000Z'), by: 'Reception' };
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const refused = (result, code) => { assert.equal(result.ok, false, 'expected a refusal'); assert.equal(result.code, code); return result; };

const EXTRAS = {
  id: 'g_extras', label: 'Extras', min: 0, max: 2,
  options: [
    { id: 'o_cheese', label: 'Extra cheese', price_delta: 30, available: true },
    { id: 'o_egg', label: 'Egg', price_delta: 20, available: true }
  ]
};
const SPICE = { id: 'g_spice', label: 'Spice', min: 0, max: 1, options: [{ id: 'o_cheese', label: 'Cheesy hot', price_delta: 0, available: true }] };
const MENU = {
  items: [
    { id: 'biryani', name: 'Biryani', price: 260, available: true, modifier_groups: [EXTRAS, SPICE], variants: [{ id: 'half', label: 'Half', price: 260, available: true }, { id: 'full', label: 'Full', price: 480, available: true }] },
    { id: 'toast', name: 'Toast', price: 80, available: true, modifier_groups: [EXTRAS] },
    { id: 'plain', name: 'Plain rice', price: 90, available: true }
  ]
};
const pick = (group, option) => ({ group_id: group, option_id: option });

function kitchen() {
  let s = emptyState('rest-1');
  const ids = {};
  for (const [key, name, unit, on_hand, low_at] of [
    ['rice', 'Rice', 'kg', 5, 1], ['cheese', 'Cheese', 'g', 100, 0], ['egg', 'Egg', 'pcs', 6, 0]
  ]) {
    const r = addIngredient(s, { name, unit, on_hand, low_at }, ctx);
    s = ok(r);
    ids[key] = r.meta.item.id;
  }
  return { s, ids };
}

/** Biryani: 0.3 kg of rice a portion, plus 20 g of cheese for the extra cheese and an egg for the egg. */
function withRecipe(variantId) {
  const { s, ids } = kitchen();
  const lines = [
    { inventory_item_id: ids.rice, qty: 0.3 },
    { inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') },
    { inventory_item_id: ids.egg, qty: 1, ...pick('g_extras', 'o_egg') }
  ];
  return { s: ok(setRecipe(s, { item_id: 'biryani', ...(variantId ? { variant_id: variantId } : {}), lines }, MENU)), ids };
}
const need = (s, lines, id) => needsFor(s, lines).get(id)?.needed;

// --- what an order needs ---------------------------------------------------------------------------

test('an extra counts only for the portions that chose it', () => {
  const { s, ids } = withRecipe();
  assert.equal(need(s, [{ id: 'biryani', qty: 3 }], ids.rice), 0.9);
  assert.equal(need(s, [{ id: 'biryani', qty: 3 }], ids.cheese), undefined, 'nobody asked for cheese');

  const cheesy = { id: 'biryani', qty: 3, modifiers: [pick('g_extras', 'o_cheese')] };
  assert.equal(need(s, [cheesy], ids.cheese), 60, '3 portions x 20 g');
  assert.equal(need(s, [cheesy], ids.egg), undefined, 'and the other extra is not counted');
  assert.equal(need(s, [cheesy], ids.rice), 0.9, 'the dish itself is unchanged by the extra');
});

test('two lines of one dish are counted separately: one with the extra, one without', () => {
  const { s, ids } = withRecipe();
  const lines = [{ id: 'biryani', qty: 2, modifiers: [pick('g_extras', 'o_cheese')] }, { id: 'biryani', qty: 5 }];
  assert.equal(need(s, lines, ids.cheese), 40, 'only the two that asked');
  assert.equal(need(s, lines, ids.rice), 2.1, 'all seven portions');
});

test('several extras on one portion each count', () => {
  const { s, ids } = withRecipe();
  const both = [{ id: 'biryani', qty: 2, modifiers: [pick('g_extras', 'o_cheese'), pick('g_extras', 'o_egg')] }];
  assert.deepEqual([need(s, both, ids.cheese), need(s, both, ids.egg)], [40, 2]);
});

test('a choice is identified by its group AND its option: the same option id in another group is not it', () => {
  const { s, ids } = withRecipe();
  // SPICE also has an option called o_cheese. Picking that one is not picking the extra cheese.
  const other = [{ id: 'biryani', qty: 1, modifiers: [pick('g_spice', 'o_cheese')] }];
  assert.equal(need(s, other, ids.cheese), undefined);
});

test('nonsense in a line\'s modifiers adds nothing and does not throw', () => {
  const { s, ids } = withRecipe();
  for (const modifiers of [null, 'x', 7, [null], [{}], [{ group_id: 'g_extras' }], [{ option_id: 'o_cheese' }]]) {
    assert.equal(need(s, [{ id: 'biryani', qty: 1, modifiers }], ids.cheese), undefined, JSON.stringify(modifiers));
  }
});

test('the same ingredient can be in the dish and in an extra, and the two add up', () => {
  const { s, ids } = kitchen();
  const lines = [
    { inventory_item_id: ids.cheese, qty: 30 },
    { inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') }
  ];
  const s2 = ok(setRecipe(s, { item_id: 'toast', lines }, MENU));
  assert.equal(need(s2, [{ id: 'toast', qty: 2, modifiers: [pick('g_extras', 'o_cheese')] }], ids.cheese), 100, '2 x (30 + 20)');
  assert.equal(need(s2, [{ id: 'toast', qty: 2 }], ids.cheese), 60, 'without the extra, just the dish');
});

test('an extra uses the recipe for the size that was ordered', () => {
  const { s, ids } = kitchen();
  let s2 = ok(setRecipe(s, { item_id: 'biryani', variant_id: 'full', lines: [{ inventory_item_id: ids.rice, qty: 0.5 }, { inventory_item_id: ids.cheese, qty: 25, ...pick('g_extras', 'o_cheese') }] }, MENU));
  s2 = ok(setRecipe(s2, { item_id: 'biryani', variant_id: 'half', lines: [{ inventory_item_id: ids.rice, qty: 0.3 }, { inventory_item_id: ids.cheese, qty: 15, ...pick('g_extras', 'o_cheese') }] }, MENU));
  const cheese = size => need(s2, [{ id: 'biryani', variant_id: size, qty: 1, modifiers: [pick('g_extras', 'o_cheese')] }], ids.cheese);
  assert.deepEqual([cheese('full'), cheese('half')], [25, 15]);
});

// --- running short -----------------------------------------------------------------------------------

test('an extra that has run out holds up the order that asks for it, and nothing else', () => {
  const { s, ids } = withRecipe();
  const low = ok(consume(s, [{ id: 'biryani', qty: 5, modifiers: [pick('g_extras', 'o_cheese')] }], ctx)); // 100 g - 100 g = 0 g cheese
  assert.equal(low.items.find(i => i.id === ids.cheese).on_hand, 0);

  const withCheese = shortagesFor(low, [{ id: 'biryani', qty: 1, modifiers: [pick('g_extras', 'o_cheese')] }]);
  assert.deepEqual(withCheese.map(x => [x.name, x.needed, x.on_hand]), [['Cheese', 20, 0]]);
  assert.deepEqual(shortagesFor(low, [{ id: 'biryani', qty: 1 }]), [], 'the biryani itself can still be made');
});

test('a dish is not out of stock because an extra is -- nobody should lose the biryani for the cheese', () => {
  const { s } = withRecipe();
  const dry = ok(consume(s, [{ id: 'biryani', qty: 5, modifiers: [pick('g_extras', 'o_cheese')] }], ctx));
  assert.equal(stockOutKeys(dry, MENU.items).size, 0);
  const shown = overlayMenuItems(dry, MENU.items).find(i => i.id === 'biryani');
  assert.equal(shown.stock_out, undefined, 'the dish stays on the menu');
  assert.deepEqual(shown.modifier_groups.find(g => g.id === 'g_extras').options.filter(o => o.stock_out).map(o => o.id), ['o_cheese'], 'and says which extra is gone');
});

test('but a dish IS out when its own ingredient is, whatever the extras', () => {
  const { s, ids } = withRecipe();
  const dry = ok(consume(s, [{ id: 'biryani', qty: 17, variant_id: undefined }], ctx));   // 5 kg of rice, 17 x 0.3 = 5.1 -> 0
  assert.equal(dry.items.find(i => i.id === ids.rice).on_hand, 0);
  assert.equal(stockOutKeys(dry, MENU.items).has('biryani'), true);
});

test('taking an order takes the extras out, once, and records each movement', () => {
  const { s, ids } = withRecipe();
  const after_ = ok(consume(s, [{ id: 'biryani', qty: 2, modifiers: [pick('g_extras', 'o_cheese')] }], { ...ctx, ref: '#14' }));
  const on = id => after_.items.find(i => i.id === id).on_hand;
  assert.deepEqual([on(ids.rice), on(ids.cheese), on(ids.egg)], [4.4, 60, 6]);
  assert.deepEqual(after_.movements.filter(m => m.ref === '#14').map(m => [m.inventory_item_id, m.delta, m.reason]).sort(),
    [[ids.cheese, -40, 'sale'], [ids.rice, -0.6, 'sale']].sort());
});

test('a recipe can be only extras: the dish is untracked, and the extras still count', () => {
  const { s, ids } = kitchen();
  const s2 = ok(setRecipe(s, { item_id: 'toast', lines: [{ inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') }] }, MENU));
  assert.equal(stockOutKeys(s2, MENU.items).size, 0, 'with no ingredients of its own, nothing can make the dish "out"');
  assert.equal(need(s2, [{ id: 'toast', qty: 1, modifiers: [pick('g_extras', 'o_cheese')] }], ids.cheese), 20);
});

// --- writing a recipe -------------------------------------------------------------------------------

test('a recipe line cannot name an extra the dish does not offer', () => {
  const { s, ids } = kitchen();
  const r = refused(setRecipe(s, { item_id: 'plain', lines: [{ inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') }] }, MENU), 'INVALID_RECIPE');
  assert.match(r.error, /does not offer that choice/);
  refused(setRecipe(s, { item_id: 'toast', lines: [{ inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_nothing') }] }, MENU), 'INVALID_RECIPE');
  refused(setRecipe(s, { item_id: 'toast', lines: [{ inventory_item_id: ids.cheese, qty: 20, ...pick('g_nothing', 'o_cheese') }] }, MENU), 'INVALID_RECIPE');
});

test('an extra needs both its group and its choice -- one alone is refused, not read as part of the dish', () => {
  const { s, ids } = kitchen();
  for (const half of [{ group_id: 'g_extras' }, { option_id: 'o_cheese' }]) {
    const r = refused(setRecipe(s, { item_id: 'toast', lines: [{ inventory_item_id: ids.cheese, qty: 20, ...half }] }, MENU), 'INVALID_RECIPE');
    assert.match(r.error, /needs both its group and its choice/);
  }
});

test('an ingredient can be listed once for the dish and once per extra, and no more', () => {
  const { s, ids } = kitchen();
  const dup = [
    { inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') },
    { inventory_item_id: ids.cheese, qty: 10, ...pick('g_extras', 'o_cheese') }
  ];
  assert.match(refused(setRecipe(s, { item_id: 'toast', lines: dup }, MENU), 'INVALID_RECIPE').error, /already listed for this extra/);
  const twoDishLines = [{ inventory_item_id: ids.cheese, qty: 20 }, { inventory_item_id: ids.cheese, qty: 10 }];
  assert.match(refused(setRecipe(s, { item_id: 'toast', lines: twoDishLines }, MENU), 'INVALID_RECIPE').error, /each ingredient can appear once/);
});

test('every problem with a recipe is still reported together, extras included', () => {
  const { s, ids } = kitchen();
  const r = refused(setRecipe(s, { item_id: 'toast', lines: [
    { inventory_item_id: 'ing_nope', qty: 5 },
    { inventory_item_id: ids.cheese, qty: -1, ...pick('g_extras', 'o_cheese') },
    { inventory_item_id: ids.egg, qty: 1, ...pick('g_extras', 'o_gone') }
  ] }, MENU), 'INVALID_RECIPE');
  assert.equal(r.errors.length, 3);
});

// --- a recipe read from disk or from the cloud ----------------------------------------------------------

test('a stored recipe keeps its extras; a half-named extra is dropped rather than read as part of the dish', () => {
  const raw = {
    items: [{ id: 'c', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 0 }],
    recipes: [{
      id: 'r1', item_id: 'toast', variant_id: null,
      lines: [
        { inventory_item_id: 'c', qty: 30 },
        { inventory_item_id: 'c', qty: 20, group_id: 'g_extras', option_id: 'o_cheese' },
        { inventory_item_id: 'c', qty: 99, group_id: 'g_extras' },
        { inventory_item_id: 'c', qty: 99, option_id: 'o_cheese' }
      ]
    }]
  };
  const [recipe] = normalizeState(raw).recipes;
  assert.deepEqual(recipe.lines, [{ inventory_item_id: 'c', qty: 30 }, { inventory_item_id: 'c', qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }]);
});

test('recipes written before extras existed are read exactly as they were', () => {
  const raw = { items: [{ id: 'c', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 0 }], recipes: [{ id: 'r1', item_id: 'toast', lines: [{ inventory_item_id: 'c', qty: 30 }] }] };
  assert.deepEqual(normalizeState(raw).recipes[0].lines, [{ inventory_item_id: 'c', qty: 30 }]);
  assert.deepEqual(cleanLine({ inventory_item_id: 'c', qty: 30 }), { inventory_item_id: 'c', qty: 30 });
  assert.equal(cleanLine({ inventory_item_id: 'c', qty: 0 }), null);
  assert.equal(cleanLine(null), null);
});

// --- the cloud copy ---------------------------------------------------------------------------------------

const RID = RESTAURANT_ID;
function fakeCloud() {
  const tables = { inventory_items: [], recipes: [] };
  return {
    tables,
    from(name) {
      return {
        upsert: async rows => {
          for (const r of rows) {
            const at = tables[name].findIndex(x => x.restaurant_id === r.restaurant_id && x.hub_ref === r.hub_ref);
            if (at >= 0) tables[name][at] = { ...tables[name][at], ...r }; else tables[name].push({ ...r });
          }
          return { error: null };
        },
        select: () => ({ eq: async (col, val) => ({ data: tables[name].filter(r => r[col] === val), error: null }) }),
        delete: () => ({ eq: (col, val) => ({ in: async (col2, ids) => { tables[name] = tables[name].filter(r => !(r[col] === val && ids.includes(r[col2]))); return { error: null }; } }) })
      };
    }
  };
}

test('cloud: an extra goes up with its recipe and comes back whole -- it is not lost, and not turned into a second recipe', async () => {
  const { s } = withRecipe();
  const cloud = fakeCloud();
  await pushInventory(cloud, RID, s);

  assert.equal(cloud.tables.recipes.length, 1, 'one row: the extras live inside the dish\'s own recipe');
  const lines = cloud.tables.recipes[0].lines;
  assert.deepEqual(lines.filter(l => l.option_id).map(l => [l.group_id, l.option_id, l.qty]), [['g_extras', 'o_cheese', 20], ['g_extras', 'o_egg', 1]]);

  const back = await pullInventory(cloud, RID);
  assert.deepEqual(back.recipes[0].lines, s.recipes[0].lines, 'a replacement hub gets exactly what the old one had');
});

test('cloud: a recipe with no extras is the row it always was', () => {
  const row = recipeRow(RID, { id: 'rec_1', item_id: 'm1', variant_id: null, lines: [{ inventory_item_id: 'ing_a', qty: 150 }] });
  assert.deepEqual(row.lines, [{ inventory_item_id: 'ing_a', qty: 150 }]);
  assert.equal(JSON.stringify(row).includes('option_id'), false, 'no new keys for a restaurant that does not use extras');
});

// --- an extra that has run out is flagged on the menu ----------------------------------------------------------

// A kitchen with exactly this much of each thing, and a recipe per size if asked. The extras are the ones the
// menu offers: cheese on the extras group, the same option id on the spice group (to prove identity is by group
// AND option), and an egg.
function shelf({ rice = 5, cheese = 100, egg = 6 } = {}, recipes = [{ lines: 'all' }]) {
  let s = emptyState('rest-1');
  const ids = {};
  for (const [key, name, unit, on_hand] of [['rice', 'Rice', 'kg', rice], ['cheese', 'Cheese', 'g', cheese], ['egg', 'Egg', 'pcs', egg]]) {
    const r = addIngredient(s, { name, unit, on_hand, low_at: 0 }, ctx);
    s = ok(r);
    ids[key] = r.meta.item.id;
  }
  const all = [
    { inventory_item_id: ids.rice, qty: 0.3 },
    { inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') },
    { inventory_item_id: ids.egg, qty: 1, ...pick('g_extras', 'o_egg') }
  ];
  for (const r of recipes) s = ok(setRecipe(s, { item_id: 'biryani', ...(r.variant_id ? { variant_id: r.variant_id } : {}), lines: r.lines === 'all' ? all : r.lines(ids) }, MENU));
  return { s, ids };
}
const optionsOf = (items, id = 'biryani', group = 'g_extras') => items.find(i => i.id === id).modifier_groups.find(g => g.id === group).options;
const outOptions = (state, items = MENU.items) => optionsOf(overlayMenuItems(state, items)).filter(o => o.stock_out).map(o => o.id);
const cheeseExtra = ids => ({ inventory_item_id: ids.cheese, qty: 20, ...pick('g_extras', 'o_cheese') });

test('an extra whose ingredient has run out is flagged, and the others are not', () => {
  const { s } = shelf({ cheese: 0 });
  assert.deepEqual(outOptions(s), ['o_cheese']);
  const flagged = optionsOf(overlayMenuItems(s, MENU.items));
  assert.equal(flagged.find(o => o.id === 'o_egg').stock_out, undefined);
  assert.equal(flagged.find(o => o.id === 'o_cheese').available, true, "reception's own switch is never touched");
});

test('one portion is the test: exactly enough is fine, a gram short is not', () => {
  assert.deepEqual(outOptions(shelf({ cheese: 20 }).s), []);
  assert.deepEqual(outOptions(shelf({ cheese: 19.9 }).s), ['o_cheese']);
});

test('where the dish and the extra share an ingredient, the portion needs both', () => {
  // Cheese 10 g in the dish itself and 20 g more for the extra: a portion with the extra needs 30 g.
  const both = ids => [{ inventory_item_id: ids.cheese, qty: 10 }, cheeseExtra(ids)];
  assert.deepEqual(outOptions(shelf({ cheese: 25 }, [{ lines: both }]).s), ['o_cheese']);
  assert.deepEqual(outOptions(shelf({ cheese: 30 }, [{ lines: both }]).s), []);
});

test("a choice is identified by its group AND its option: the spice group's o_cheese is not the extras'", () => {
  const { s } = shelf({ cheese: 0 });
  const out = overlayMenuItems(s, MENU.items);
  assert.deepEqual(optionsOf(out, 'biryani', 'g_spice').filter(o => o.stock_out), []);
});

test('an ingredient deleted since the recipe was written counts as gone', () => {
  const { s, ids } = shelf();
  const without = { ...s, items: s.items.filter(i => i.id !== ids.cheese) };
  assert.deepEqual(outOptions(without), ['o_cheese']);
});

test('an extra that nothing in stock backs is never flagged: no recipe, or no line for it', () => {
  const onlyBase = shelf({ cheese: 0 }, [{ lines: ids => [{ inventory_item_id: ids.rice, qty: 0.3 }] }]);
  assert.deepEqual(outOptions(onlyBase.s), []);
  const noRecipes = ok(addIngredient(emptyState('rest-1'), { name: 'Cheese', unit: 'g', on_hand: 0, low_at: 0 }, ctx));
  assert.deepEqual(outOptions(noRecipes), []);
  assert.deepEqual(optionsOf(overlayMenuItems(shelf({ cheese: 0 }).s, MENU.items), 'toast').filter(o => o.stock_out), [], 'a dish with no recipe');
});

test('with sizes, an extra is out only when NO size can take it', () => {
  const plain = ids => [{ inventory_item_id: ids.rice, qty: 0.3 }];
  const withCheese = ids => [{ inventory_item_id: ids.rice, qty: 0.3 }, cheeseExtra(ids)];
  // Only the Full size's recipe uses cheese for the extra: the Half takes the extra without it, so it stays on offer.
  const oneSize = shelf({ cheese: 0 }, [{ variant_id: 'half', lines: plain }, { variant_id: 'full', lines: withCheese }]);
  assert.deepEqual(outOptions(oneSize.s), []);
  // Both sizes need cheese for it and there is none: out.
  const bothSizes = shelf({ cheese: 0 }, [{ variant_id: 'half', lines: withCheese }, { variant_id: 'full', lines: withCheese }]);
  assert.deepEqual(outOptions(bothSizes.s), ['o_cheese']);
});

test("a size reception has 86'd by hand cannot take an order, so it does not keep an extra on offer", () => {
  const plain = ids => [{ inventory_item_id: ids.rice, qty: 0.3 }];
  const withCheese = ids => [{ inventory_item_id: ids.rice, qty: 0.3 }, cheeseExtra(ids)];
  const { s } = shelf({ cheese: 0 }, [{ variant_id: 'half', lines: plain }, { variant_id: 'full', lines: withCheese }]);
  const items = MENU.items.map(i => (i.id === 'biryani' ? { ...i, variants: i.variants.map(v => (v.id === 'half' ? { ...v, available: false } : v)) } : i));
  assert.deepEqual(outOptions(s, items), ['o_cheese'], 'only Full can be ordered, and Full cannot take it');
});

test('restocking clears the flag', () => {
  const { s, ids } = shelf({ cheese: 0 });
  assert.deepEqual(outOptions(s), ['o_cheese']);
  const stocked = { ...s, items: s.items.map(i => (i.id === ids.cheese ? { ...i, on_hand: 50 } : i)) };
  assert.deepEqual(outOptions(stocked), []);
});

test('the overlay changes nothing it does not need to, and never the menu it was given', () => {
  assert.equal(overlayMenuItems(shelf({ cheese: 100 }).s, MENU.items), MENU.items, 'nothing out: the very same array');
  const before = JSON.stringify(MENU.items);
  const flagged = overlayMenuItems(shelf({ cheese: 0 }).s, MENU.items);
  assert.equal(JSON.stringify(MENU.items), before, 'the stored menu is not written to');
  assert.equal(flagged.find(i => i.id === 'plain'), MENU.items.find(i => i.id === 'plain'), 'untouched dishes keep their identity');
});

test('a dish that is itself out of stock keeps its own flag, and its extras are flagged in the same pass', () => {
  const { s } = shelf({ rice: 0, cheese: 0 });
  const out = overlayMenuItems(s, MENU.items).find(i => i.id === 'biryani');
  assert.equal(out.stock_out, true);
  assert.deepEqual(out.modifier_groups.find(g => g.id === 'g_extras').options.filter(o => o.stock_out).map(o => o.id), ['o_cheese']);
});

// A required choice whose every option is out leaves a dish nobody can complete the sheet for.
const requiredSpice = options => ({ id: 'g_spice', label: 'Spice', min: 1, max: 1, options });
const dishWith = groups => [{ id: 'curry', name: 'Curry', price: 200, available: true, modifier_groups: groups }];
function curryShelf(cheeseOnHand, groups) {
  let s = emptyState('rest-1');
  const cheese = addIngredient(s, { name: 'Cheese', unit: 'g', on_hand: cheeseOnHand, low_at: 0 }, ctx);
  s = ok(cheese);
  const lines = groups.flatMap(g => g.options.filter(o => o.uses).map(o => ({ inventory_item_id: cheese.meta.item.id, qty: 20, ...pick(g.id, o.id) })));
  const menu = { items: dishWith(groups) };
  return { s: ok(setRecipe(s, { item_id: 'curry', lines }, menu)), items: menu.items };
}

test('a dish is out when a REQUIRED choice has no option left that stock allows', () => {
  const groups = [requiredSpice([{ id: 'a', label: 'Cheesy mild', price_delta: 0, available: true, uses: true }, { id: 'b', label: 'Cheesy hot', price_delta: 0, available: true, uses: true }])];
  const { s, items } = curryShelf(0, groups);
  const out = overlayMenuItems(s, items)[0];
  assert.equal(out.stock_out, true, 'nobody could finish the sheet, so the dish says so rather than offering it');
  assert.deepEqual(out.modifier_groups[0].options.map(o => o.stock_out), [true, true]);
});

test('...but not while one option still works, not for an optional choice, and not for a hand 86 alone', () => {
  const both = [{ id: 'a', label: 'Cheesy mild', price_delta: 0, available: true, uses: true }, { id: 'b', label: 'Plain', price_delta: 0, available: true }];
  assert.equal(overlayMenuItems(...Object.values(curryShelf(0, [requiredSpice(both)])))[0].stock_out, undefined, 'Plain is still on');

  const optional = [{ id: 'g_extra', label: 'Extra', min: 0, max: 1, options: [{ id: 'a', label: 'Cheesy', price_delta: 10, available: true, uses: true }] }];
  assert.equal(overlayMenuItems(...Object.values(curryShelf(0, optional)))[0].stock_out, undefined, 'an optional choice never holds the dish up');

  const handOnly = [requiredSpice([{ id: 'a', label: 'Mild', price_delta: 0, available: false }, { id: 'b', label: 'Hot', price_delta: 0, available: false }])];
  assert.equal(overlayMenuItems(...Object.values(curryShelf(100, handOnly)))[0].stock_out, undefined, 'stock is not the reason, so stock does not claim it');
});

test("an unrelated extra running out does not make stock claim a dish whose required choice reception 86'd", () => {
  const groups = [
    requiredSpice([{ id: 'a', label: 'Mild', price_delta: 0, available: false }, { id: 'b', label: 'Hot', price_delta: 0, available: false }]),
    { id: 'g_extra', label: 'Extra', min: 0, max: 1, options: [{ id: 'c', label: 'Cheesy', price_delta: 10, available: true, uses: true }] }
  ];
  const { s, items } = curryShelf(0, groups);
  const out = overlayMenuItems(s, items)[0];
  assert.equal(out.stock_out, undefined, 'the required choice is empty because of a hand 86, not stock');
  assert.deepEqual(out.modifier_groups[1].options.map(o => o.stock_out), [true], 'though the extra itself is flagged');
});

test('a required choice with one hand-86d option and one out of stock is out, and the stock is the cause', () => {
  const groups = [requiredSpice([{ id: 'a', label: 'Mild', price_delta: 0, available: false }, { id: 'b', label: 'Cheesy hot', price_delta: 0, available: true, uses: true }])];
  const { s, items } = curryShelf(0, groups);
  assert.equal(overlayMenuItems(s, items)[0].stock_out, true);
});

// --- a real hub ---------------------------------------------------------------------------------------------

const HUB_MENU = {
  restaurant_id: RID, categories: ['Mains'],
  items: [
    { id: 'biryani', name: 'Biryani', price: 260, category: 'Mains', isVeg: false, available: true, modifier_groups: [EXTRAS] },
    { id: 'plain', name: 'Plain rice', price: 90, category: 'Mains', isVeg: true, available: true }
  ]
};
let hub;
before(async () => {
  hub = await startHub({ trustLoopback: true, menu: HUB_MENU, tables: { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }, enrollmentCode: 'MODCODE' });
});
after(() => hub?.stop());

const api = (p, { method = 'GET', body } = {}) => fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = res => res.json();
const stock = async id => (await json(await api('/admin/inventory'))).items.find(i => i.id === id).on_hand;
const orderOf = (modifiers, qty = 1) => api('/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'biryani', qty, ...(modifiers ? { modifiers } : {}) }] } });

let rice;
let cheese;
test('hub: reception sets a recipe with an extra, and reads it back with the extra intact', async () => {
  rice = (await json(await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Rice', unit: 'kg', on_hand: 5, low_at: 0 } } }))).item;
  cheese = (await json(await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Cheese', unit: 'g', on_hand: 100, low_at: 0 } } }))).item;

  const res = await api('/admin/inventory/recipes', {
    method: 'PUT',
    body: { item_id: 'biryani', lines: [{ inventory_item_id: rice.id, qty: 0.3 }, { inventory_item_id: cheese.id, qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }] }
  });
  assert.equal(res.status, 200);
  const recipe = (await json(await api('/admin/inventory'))).recipes.find(r => r.item_id === 'biryani');
  assert.deepEqual(recipe.lines.map(l => [l.qty, l.group_id ?? null, l.option_id ?? null]), [[0.3, null, null], [20, 'g_extras', 'o_cheese']]);
});

test('hub: a recipe naming an extra the dish does not have is refused with the reason', async () => {
  const res = await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id: 'plain', lines: [{ inventory_item_id: cheese.id, qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }] } });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /does not offer that choice/);
});

test('hub: an order with the extra takes the cheese out; one without does not', async () => {
  assert.equal((await orderOf([pick('g_extras', 'o_cheese')], 2)).status, 201);
  assert.equal(await stock(cheese.id), 60, '100 g - 2 x 20 g');
  assert.equal(await stock(rice.id), 4.4);

  assert.equal((await orderOf(null, 1)).status, 201);
  assert.equal(await stock(cheese.id), 60, 'a plain biryani leaves the cheese alone');
  assert.equal(await stock(rice.id), 4.1);
});

test('hub: with the cheese gone, the extra is refused by name and the biryani itself can still be ordered', async () => {
  assert.equal((await orderOf([pick('g_extras', 'o_cheese')], 3)).status, 201);   // 60 g -> 0 g
  assert.equal(await stock(cheese.id), 0);

  const withExtra = await orderOf([pick('g_extras', 'o_cheese')]);
  assert.equal(withExtra.status, 409);
  const body = await json(withExtra);
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.match(body.error, /Biryani: no Cheese left/);

  assert.equal((await orderOf(null)).status, 201, 'the dish is not held up by its extra');
  const menu = (await json(await api('/menu'))).items.find(i => i.id === 'biryani');
  assert.equal(menu.stock_out, undefined, 'and the menu still offers it');
});

test('hub: once the cheese is gone, the menu says the extra is out of stock, and a guest is not offered it', async () => {
  const menu = (await json(await api('/menu'))).items.find(i => i.id === 'biryani');
  const options = menu.modifier_groups.find(g => g.id === 'g_extras').options;
  assert.equal(options.find(o => o.id === 'o_cheese').stock_out, true);
  assert.equal(options.find(o => o.id === 'o_cheese').available, true, 'not a hand 86');
  assert.equal(menu.stock_out, undefined, 'the biryani itself is still on');

  const diner = await json(await fetch(`${hub.base}/public/menu`));
  const text = JSON.stringify(diner);
  assert.ok(text.includes('Biryani'), 'the dish is on the guest menu');
  assert.ok(!text.includes('Extra cheese'), 'a guest cannot ask for what the kitchen will refuse');
  assert.ok(text.includes('Egg'), 'while the extra that is in stock is');
});

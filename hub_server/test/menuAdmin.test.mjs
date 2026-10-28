import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem, updateItem, deleteItem,
  addCategory, renameCategory, reorderCategories, deleteCategory,
  findCategory
} from '../lib/menuAdmin.js';

const menu = () => ({
  restaurant_id: 'r', revision: 3,
  categories: ['Starters', 'Mains'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    {
      id: 'm2', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true,
      variants: [{ id: 'v_half', label: 'Half', price: 120, available: true }],
      modifier_groups: [{ id: 'g1', label: 'Spice', min: 1, max: 1, options: [{ id: 'o1', label: 'Mild', price_delta: 0, available: true }] }]
    }
  ]
});

test('addItem creates an item with a generated id and registers its category', () => {
  const r = addItem(menu(), { name: ' Masala Chaas ', category: 'Beverages', price: 50, isVeg: true, station: 'BAR' });
  assert.equal(r.ok, true);
  assert.match(r.meta.item.id, /^m_[0-9a-f]{8}$/);
  assert.equal(r.meta.item.name, 'Masala Chaas');
  assert.equal(r.meta.item.station, 'bar');
  assert.equal(r.meta.item.available, true);
  assert.deepEqual(r.data.categories, ['Starters', 'Mains', 'Beverages']);
  assert.equal(r.data.items.length, 3);
});

test('addItem reuses the existing spelling of a category', () => {
  const r = addItem(menu(), { name: 'Soup', category: 'starters', price: 80, isVeg: true });
  assert.equal(r.meta.item.category, 'Starters');
  assert.deepEqual(r.data.categories, ['Starters', 'Mains']);
});

test('addItem defaults the price to the first variant when none is given', () => {
  const r = addItem(menu(), {
    name: 'Chai', category: 'Mains', isVeg: true,
    variants: [{ id: 'v_c', label: 'Cutting', price: 20 }, { id: 'v_f', label: 'Full', price: 40 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.price, 20);
});

test('addItem requires a price when there are no variants', () => {
  const r = addItem(menu(), { name: 'Chai', category: 'Mains', isVeg: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'price');
});

test('addItem rejects bad input with field-level errors', () => {
  const r = addItem(menu(), { name: '', category: 'Starters', price: 0, isVeg: 'yes' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_ITEM');
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['isVeg', 'name', 'price']);
});

test('addItem rejects prices with more than 2 decimals and unknown stations', () => {
  const r = addItem(menu(), { name: 'X', category: 'Starters', price: 10.555, isVeg: true, station: 'grill' });
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['price', 'station']);
});

test('addItem rejects duplicates (same name + category, case-insensitive)', () => {
  const r = addItem(menu(), { name: 'paneer tikka', category: 'STARTERS', price: 10, isVeg: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'DUPLICATE_ITEM');
});

test('addItem rejects malformed variants, modifier groups and day-parts', () => {
  const base = { name: 'X', category: 'Starters', price: 10, isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });

  assert.equal(bad({ variants: [{ id: 'v', label: 'Half', price: 0 }] }).errors[0].field, 'variants');
  assert.equal(bad({ variants: [{ id: 'v', label: 'A', price: 1 }, { id: 'v', label: 'B', price: 2 }] }).errors[0].field, 'variants');
  assert.equal(bad({ variants: [{ label: 'No id', price: 1 }] }).errors[0].field, 'variants');
  assert.equal(
    bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 2, max: 2, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field,
    'modifier_groups',
    'a minimum above the option count can never be satisfied'
  );
  assert.equal(
    bad({ modifier_groups: [{ id: 'g', label: 'Pick', options: [{ id: 'o', label: 'A', price_delta: 'x' }] }] }).errors[0].field,
    'modifier_groups'
  );
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'Lunch', starts_at: '25:00', ends_at: '15:00', price: 1 }] }).errors[0].field, 'day_parts');
});

test('addItem accepts valid variants, modifier groups and day-parts', () => {
  const r = addItem(menu(), {
    name: 'Biryani', category: 'Mains', isVeg: false, price: 300,
    variants: [{ id: 'v_h', label: 'Half', price: 180 }],
    modifier_groups: [{ id: 'g', label: 'Spice', min: 1, max: 1, options: [{ id: 'o', label: 'Hot', price_delta: 0 }] }],
    day_parts: [{ id: 'd', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', price: 250 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.variants[0].available, true);
  assert.equal(r.meta.item.day_parts[0].price, 250);
});

test('updateItem merges only the provided keys', () => {
  const r = updateItem(menu(), 'm2', { price: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.price, 200);
  assert.equal(r.meta.item.variants.length, 1, 'variants preserved');
  assert.equal(r.meta.item.modifier_groups.length, 1, 'modifier groups preserved');
});

test('updateItem clears variants / modifier groups when sent an empty array', () => {
  const r = updateItem(menu(), 'm2', { variants: [], modifier_groups: [] });
  assert.equal(r.ok, true);
  assert.equal('variants' in r.meta.item, false);
  assert.equal('modifier_groups' in r.meta.item, false);
});

test('updateItem can 86 an item and move it to another category', () => {
  const r = updateItem(menu(), 'm1', { available: false, category: 'mains' });
  assert.equal(r.meta.item.available, false);
  assert.equal(r.meta.item.category, 'Mains');
});

test('updateItem 404s on an unknown id and blocks renames that collide', () => {
  assert.equal(updateItem(menu(), 'nope', { price: 1 }).code, 'ITEM_NOT_FOUND');
  const clash = updateItem(menu(), 'm1', { name: 'Dal Tadka', category: 'Mains' });
  assert.equal(clash.status, 409);
  assert.equal(clash.code, 'DUPLICATE_ITEM');
});

test('deleteItem removes the item; unknown id 404s', () => {
  const r = deleteItem(menu(), 'm1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.items.map(i => i.id), ['m2']);
  assert.equal(deleteItem(menu(), 'nope').status, 404);
});

test('categories: add, rename (relabels items), reorder, delete-only-when-empty', () => {
  const added = addCategory(menu(), ' Desserts ');
  assert.deepEqual(added.data.categories, ['Starters', 'Mains', 'Desserts']);
  assert.equal(addCategory(menu(), 'starters').code, 'CATEGORY_EXISTS');
  assert.equal(addCategory(menu(), '   ').code, 'INVALID_CATEGORY');

  const renamed = renameCategory(menu(), 'Starters', 'Appetisers');
  assert.deepEqual(renamed.data.categories, ['Appetisers', 'Mains']);
  assert.equal(renamed.data.items.find(i => i.id === 'm1').category, 'Appetisers');
  assert.equal(renameCategory(menu(), 'Starters', 'mains').code, 'CATEGORY_EXISTS');
  assert.equal(renameCategory(menu(), 'Nope', 'X').code, 'CATEGORY_NOT_FOUND');
  assert.equal(renameCategory(menu(), 'Starters', 'starters').ok, true, 'a case-only rename of itself is allowed');

  assert.deepEqual(reorderCategories(menu(), ['Mains', 'Starters']).data.categories, ['Mains', 'Starters']);
  assert.equal(reorderCategories(menu(), ['Mains']).code, 'INVALID_ORDER');
  assert.equal(reorderCategories(menu(), ['Mains', 'Mains']).code, 'INVALID_ORDER');

  assert.equal(deleteCategory(menu(), 'Starters').code, 'CATEGORY_NOT_EMPTY');
  const withEmpty = addCategory(menu(), 'Desserts').data;
  assert.deepEqual(deleteCategory(withEmpty, 'Desserts').data.categories, ['Starters', 'Mains']);
  assert.equal(deleteCategory(menu(), 'Nope').status, 404);
});

// Fix round 1 tests for defect coverage

test('(a) Top-level and variant prices: null, "", " ", 0, -1, 3-decimal reject', () => {
  const base = { name: 'X', category: 'Starters', isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });

  assert.equal(bad({ price: null }).errors[0].field, 'price');
  assert.equal(bad({ price: '' }).errors[0].field, 'price');
  assert.equal(bad({ price: ' ' }).errors[0].field, 'price');
  assert.equal(bad({ price: 0 }).errors[0].field, 'price');
  assert.equal(bad({ price: -1 }).errors[0].field, 'price');
  assert.equal(bad({ price: 1.005 }).errors[0].field, 'price');

  const badVar = (v) => bad({ variants: [{ id: 'v', label: 'X', price: v }] });
  assert.equal(badVar(null).errors[0].field, 'variants');
  assert.equal(badVar('').errors[0].field, 'variants');
  assert.equal(badVar(0).errors[0].field, 'variants');
  assert.equal(badVar(-5).errors[0].field, 'variants');
  assert.equal(badVar(2.555).errors[0].field, 'variants');
});

test('(b) Day-part prices and variant_prices strict validation', () => {
  const base = { name: 'X', category: 'Starters', price: 10, isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });

  // Day-part price validation
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: null }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: '' }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 0 }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: -1 }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 12.345 }] }).errors[0].field, 'day_parts');

  // variant_prices validation
  assert.equal(bad({ variants: [{ id: 'v_h', label: 'H', price: 100 }, { id: 'v_f', label: 'F', price: 200 }], day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', variant_prices: { v_h: null } }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ variants: [{ id: 'v_h', label: 'H', price: 100 }], day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', variant_prices: { v_h: 0 } }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ variants: [{ id: 'v_h', label: 'H', price: 100 }], day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', variant_prices: { v_h: -1 } }] }).errors[0].field, 'day_parts');

  // days validation
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 50, days: [9] }] }).errors[0].field, 'day_parts');
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 50, days: [1.5] }] }).errors[0].field, 'day_parts');

  // Half/Full probe: a day-part with null price should be rejected
  assert.equal(bad({
    variants: [{ id: 'v_h', label: 'Half', price: 120 }, { id: 'v_f', label: 'Full', price: 200 }],
    day_parts: [{ id: 'd', label: 'Lunch', starts_at: '00:00', ends_at: '23:59', price: null, variant_prices: { v_h: 160 } }]
  }).errors[0].field, 'day_parts');

  // Valid day-part should pass
  const valid = addItem(menu(), {
    name: 'Test', category: 'Starters', price: 10, isVeg: true,
    variants: [{ id: 'v_h', label: 'Half', price: 120 }, { id: 'v_f', label: 'Full', price: 200 }],
    day_parts: [{ id: 'd', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', price: 250 }]
  });
  assert.equal(valid.ok, true);

  // Valid variant_prices-only window
  const validVar = addItem(menu(), {
    name: 'Test2', category: 'Starters', price: 10, isVeg: true,
    variants: [{ id: 'v_h', label: 'Half', price: 120 }],
    day_parts: [{ id: 'd', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', variant_prices: { v_h: 160 } }]
  });
  assert.equal(validVar.ok, true);
});

test('(c) Modifier group min/max and option price_delta validation', () => {
  const base = { name: 'X', category: 'Starters', price: 10, isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });

  // max validation: '', null, 0, 0.5 should be rejected
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', max: '', options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', max: null, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', max: 0, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', max: 0.5, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');

  // min -1 should be rejected
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: -1, max: 2, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');

  // max < min should be rejected
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 2, max: 1, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');

  // option price_delta validation: null, '', '5', true should be rejected
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: 'A', price_delta: null }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: 'A', price_delta: '' }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: 'A', price_delta: '5' }] }] }).errors[0].field, 'modifier_groups');
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: 'A', price_delta: true }] }] }).errors[0].field, 'modifier_groups');

  // Negative and 0 price_delta should be accepted
  const valid = addItem(menu(), {
    name: 'Test', category: 'Starters', price: 10, isVeg: true,
    modifier_groups: [{ id: 'g', label: 'Pick', min: 0, max: 2, options: [{ id: 'o1', label: 'Add', price_delta: 10 }, { id: 'o2', label: 'Free', price_delta: 0 }, { id: 'o3', label: 'Discount', price_delta: -5 }] }]
  });
  assert.equal(valid.ok, true);

  // Existing valid group from brief should still pass
  const briefValid = addItem(menu(), {
    name: 'Biryani', category: 'Starters', price: 300, isVeg: false,
    modifier_groups: [{ id: 'g', label: 'Spice', min: 1, max: 1, options: [{ id: 'o', label: 'Hot', price_delta: 0 }] }]
  });
  assert.equal(briefValid.ok, true);
});

test('(d) Label length limit: 40-char accepted, 41-char rejected', () => {
  const base = { name: 'X', category: 'Starters', price: 10, isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });
  const long40 = 'a'.repeat(40);
  const long41 = 'a'.repeat(41);

  // Variant label
  const variantOk = addItem(menu(), { ...base, variants: [{ id: 'v', label: long40, price: 50 }] });
  assert.equal(variantOk.ok, true);
  assert.equal(bad({ variants: [{ id: 'v', label: long41, price: 50 }] }).errors[0].field, 'variants');

  // Modifier group label
  const groupOk = addItem(menu(), { ...base, modifier_groups: [{ id: 'g', label: long40, min: 1, max: 1, options: [{ id: 'o', label: 'X', price_delta: 0 }] }] });
  assert.equal(groupOk.ok, true);
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: long41, min: 1, max: 1, options: [{ id: 'o', label: 'X', price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');

  // Option label
  const optionOk = addItem(menu(), { ...base, modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: long40, price_delta: 0 }] }] });
  assert.equal(optionOk.ok, true);
  assert.equal(bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 1, max: 1, options: [{ id: 'o', label: long41, price_delta: 0 }] }] }).errors[0].field, 'modifier_groups');

  // Day-part label
  const dpOk = addItem(menu(), { ...base, day_parts: [{ id: 'd', label: long40, starts_at: '10:00', ends_at: '15:00', price: 50 }] });
  assert.equal(dpOk.ok, true);
  assert.equal(bad({ day_parts: [{ id: 'd', label: long41, starts_at: '10:00', ends_at: '15:00', price: 50 }] }).errors[0].field, 'day_parts');
});

test('(e) updateItem with duplicate pair: non-key changes succeed, renames collide', () => {
  // Create a menu with two items with the same (name, category)
  const m = menu();
  m.items.push({ id: 'm3', name: 'Paneer Tikka', price: 250, category: 'Starters', isVeg: true, available: false });

  // Change availability on a duplicate - should succeed (key unchanged)
  const avail = updateItem(m, 'm1', { available: false });
  assert.equal(avail.ok, true);
  assert.equal(avail.meta.item.available, false);

  // Change price on a duplicate - should succeed (key unchanged)
  const price = updateItem(m, 'm1', { price: 300 });
  assert.equal(price.ok, true);
  assert.equal(price.meta.item.price, 300);

  // Renaming m1 to collide with m2 should fail (key changed, collision)
  const clash = updateItem(m, 'm1', { name: 'Dal Tadka', category: 'Mains' });
  assert.equal(clash.status, 409);
  assert.equal(clash.code, 'DUPLICATE_ITEM');
});

test('(f) Categories: case-insensitive matching and relabeling', () => {
  // Original spec: list entry 'Starters' (canonical), item stored as 'starters' (lowercase)
  const m = menu();
  m.items[0].category = 'starters';  // item stored as lowercase, list stays 'Starters'

  // renameCategory should relabel items regardless of stored case
  const renamed = renameCategory(m, 'Starters', 'Appetisers');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.data.items.find(i => i.id === 'm1').category, 'Appetisers', 'item was relabeled');

  // deleteCategory('Starters') should see the item and reject
  const deleteAttempt = deleteCategory(m, 'Starters');
  assert.equal(deleteAttempt.code, 'CATEGORY_NOT_EMPTY');

  // reorderCategories should accept different-case names and store canonical spellings (from the menu)
  const reordered = reorderCategories(m, ['Mains', 'Starters']);
  assert.equal(reordered.ok, true);
  assert.deepEqual(reordered.data.categories, ['Mains', 'Starters'], 'canonical spellings from the menu');

  // findCategory should work: exact match first, then case-insensitive
  assert.equal(findCategory(['Starters', 'Mains'], 'Starters'), 'Starters', 'exact match');
  assert.equal(findCategory(['Starters', 'Mains'], 'starters'), 'Starters', 'case-insensitive match');
  assert.equal(findCategory(['Starters', 'Mains'], 'STARTERS'), 'Starters', 'case-insensitive match');
});

test('(f2) reorderCategories rejects duplicate input after canonicalization', () => {
  // ['Mains', 'mains'] both resolve to 'Mains', creating a duplicate - should reject INVALID_ORDER
  const r1 = reorderCategories(menu(), ['Mains', 'mains']);
  assert.equal(r1.code, 'INVALID_ORDER');

  // ['Mains', 'Mains '] both resolve to 'Mains', creating a duplicate - should reject
  const r2 = reorderCategories(menu(), ['Mains', 'Mains ']);
  assert.equal(r2.code, 'INVALID_ORDER');

  // Input menu should not be modified
  const original = menu();
  const snapshot = JSON.parse(JSON.stringify(original));
  reorderCategories(original, ['Mains', 'mains']);
  assert.deepEqual(original, snapshot, 'input menu unchanged after failed reorder');
});

test('(f3) addItem and updateItem do not throw on day-parts with hasOwnProperty key', () => {
  // Regression test for hasOwnProperty pollution: should not throw TypeError when key is present
  const valid = {
    name: 'Test', category: 'Starters', price: 10, isVeg: true,
    day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 50, hasOwnProperty: 'polluted' }]
  };

  // Should complete without throwing TypeError; hasOwnProperty key is just extra data on the object
  const addResult = addItem(menu(), valid);
  assert.equal(addResult.ok, true, 'addItem should accept day-part with hasOwnProperty key');

  const updateResult = updateItem(menu(), 'm1', { day_parts: [{ id: 'd', label: 'L', starts_at: '10:00', ends_at: '15:00', price: 50, hasOwnProperty: 'polluted' }] });
  assert.equal(updateResult.ok, true, 'updateItem should accept day-part with hasOwnProperty key');
});

test('(g) Non-mutation: operations do not modify input menu', () => {
  const original = menu();
  const snapshot = JSON.parse(JSON.stringify(original));

  // addItem
  const add = addItem(original, { name: 'New', category: 'Starters', price: 100, isVeg: true });
  assert.deepEqual(original, snapshot, 'original menu unchanged after addItem');

  // updateItem
  const update = updateItem(original, 'm1', { price: 999 });
  assert.deepEqual(original, snapshot, 'original menu unchanged after updateItem');

  // renameCategory
  const rename = renameCategory(original, 'Starters', 'Appetisers');
  assert.deepEqual(original, snapshot, 'original menu unchanged after renameCategory');
});

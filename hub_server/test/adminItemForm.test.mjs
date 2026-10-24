import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankForm, itemToForm, formToPayload, createPayload, changedPayload, validateForm, makeId, STATIONS
} from '../../src/admin/lib/itemForm.js';
import { addItem, updateItem, validateItemInput } from '../lib/menuAdmin.js';

// The item editor's form model: how a hub item becomes form fields, what a save sends, and what the
// editor checks first. The hub's own item rules (menuAdmin) are the oracle for "will it be accepted".

const richItem = () => ({
  id: 'm3', name: 'Chicken Tikka Masala', category: 'Main Course', price: 340, isVeg: false, available: true, station: 'hot',
  variants: [
    { id: 'v_half', label: 'Half', price: 220, available: true },
    { id: 'v_full', label: 'Full', price: 340, available: false }
  ],
  modifier_groups: [
    { id: 'mg_spice', label: 'Spice level', min: 1, max: 1, options: [
      { id: 'mild', label: 'Mild', price_delta: 0, available: true },
      { id: 'hot', label: 'Hot', price_delta: 0, available: false }
    ] },
    { id: 'mg_extras', label: 'Extras', min: 0, max: 3, options: [
      { id: 'cheese', label: 'Extra cheese', price_delta: 40, available: true },
      { id: 'light', label: 'Light gravy', price_delta: -10, available: true }
    ] }
  ],
  day_parts: [
    { id: 'dp_lunch', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', days: [1, 2, 3, 4, 5], variant_prices: { v_half: 199, v_full: 299 } },
    { id: 'dp_late', label: 'Late', starts_at: '22:00', ends_at: '02:00', price: 250 }
  ]
});
const menuWith = item => ({
  restaurant_id: 'r', revision: 1, categories: ['Main Course', 'Starters'],
  items: [item, { id: 'm9', name: 'Veg Crispy', category: 'Starters', price: 220, isVeg: true, available: true }]
});
const saved = (menu, id, payload) => {
  const r = updateItem(menu, id, payload);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data.items.find(i => i.id === id);
};
// What the hub keeps: the hub's own normalisation of the same item, so a legacy item compares fairly.
const form = item => itemToForm(item);

// ---------------------------------------------------------------- the form model

test('itemToForm then formToPayload gives the item back, in the shape the hub stores', () => {
  const item = richItem();
  const { id, ...expected } = item;
  assert.deepEqual(formToPayload(itemToForm(item)), expected);
});

test('itemToForm copes with a legacy item: no station, variants without available, a price of 0', () => {
  const f = itemToForm({
    id: 'm1', name: 'Paneer', category: 'Main', price: 0, isVeg: true,
    variants: [{ id: 'v1', label: 'Half', price: 90 }]
  });
  assert.equal(f.price, '');
  assert.equal(f.station, '');
  assert.equal(f.available, true);
  assert.deepEqual(f.variants, [{ id: 'v1', label: 'Half', price: '90', available: true }]);
});

test('blankForm starts a new item with no veg choice, so a non-veg dish is never silently labelled veg', () => {
  const f = blankForm('Starters');
  assert.equal(f.category, 'Starters');
  assert.equal(f.isVeg, null);
  assert.equal(f.available, true);
  assert.deepEqual([f.variants, f.modifier_groups, f.day_parts], [[], [], []]);
});

test('formToPayload drops a day-part\'s per-variant price for a variant that no longer exists', () => {
  const f = form(richItem());
  f.variants = f.variants.filter(v => v.id !== 'v_full');
  const dp = formToPayload(f).day_parts[0];
  assert.deepEqual(dp.variant_prices, { v_half: 199 });
});

// ---------------------------------------------------------------- saving a basic edit never drops the nested data

test('changedPayload sends only what changed: a price edit is just { price }', () => {
  const item = richItem();
  const f = form(item);
  f.price = '360';
  assert.deepEqual(changedPayload(item, f), { price: 360 });
  f.name = '  Chicken Tikka  ';
  f.available = false;
  assert.deepEqual(changedPayload(item, f), { name: 'Chicken Tikka', price: 360, available: false });
  assert.deepEqual(changedPayload(item, form(item)), {}, 'nothing edited, nothing to send');
});

test('a basic edit saved through the hub keeps the variants, modifier groups and day-parts exactly', () => {
  const item = richItem();
  const menu = menuWith(item);
  const f = form(item);
  f.price = '360';
  f.available = false;
  f.name = 'Chicken Tikka Masala (large)';
  f.station = 'bar';
  const after = saved(menu, 'm3', changedPayload(item, f));
  assert.equal(after.price, 360);
  assert.equal(after.available, false);
  assert.equal(after.station, 'bar');
  assert.deepEqual(after.variants, item.variants);
  assert.deepEqual(after.modifier_groups, item.modifier_groups);
  assert.deepEqual(after.day_parts, item.day_parts);
});

test('toggling 86\'d (available) on its own changes nothing else', () => {
  const item = richItem();
  const f = form(item);
  f.available = false;
  const payload = changedPayload(item, f);
  assert.deepEqual(payload, { available: false });
  const after = saved(menuWith(item), 'm3', payload);
  assert.deepEqual({ ...after, available: true }, item);
});

test('adding a variant sends the whole variants list and leaves modifier groups and day-parts alone', () => {
  const item = richItem();
  const f = form(item);
  f.variants.push({ id: makeId('v', f.variants.map(v => v.id)), label: 'Family', price: '620', available: true });
  const payload = changedPayload(item, f);
  assert.deepEqual(Object.keys(payload), ['variants']);
  assert.equal(payload.variants.length, 3);
  const after = saved(menuWith(item), 'm3', payload);
  assert.deepEqual(after.variants.slice(0, 2), item.variants);
  assert.equal(after.variants[2].label, 'Family');
  assert.deepEqual(after.modifier_groups, item.modifier_groups);
  assert.deepEqual(after.day_parts, item.day_parts);
});

test('removing every variant sends an empty list, which the hub treats as "clear"', () => {
  const item = richItem();
  const f = form(item);
  f.variants = [];
  f.day_parts[0].variant_prices = {};
  f.day_parts[0].price = '210';
  const payload = changedPayload(item, f);
  assert.deepEqual(payload.variants, []);
  const after = saved(menuWith(item), 'm3', payload);
  assert.equal('variants' in after, false);
  assert.deepEqual(after.modifier_groups, item.modifier_groups);
});

test('editing one option of one modifier group sends the whole modifier_groups list and only that', () => {
  const item = richItem();
  const f = form(item);
  f.modifier_groups[1].options[0].price_delta = '45';
  const payload = changedPayload(item, f);
  assert.deepEqual(Object.keys(payload), ['modifier_groups']);
  const after = saved(menuWith(item), 'm3', payload);
  assert.equal(after.modifier_groups[1].options[0].price_delta, 45);
  assert.deepEqual(after.modifier_groups[0], item.modifier_groups[0]);
  assert.deepEqual(after.variants, item.variants);
  assert.deepEqual(after.day_parts, item.day_parts);
});

test('a blank price on an item with variants is left out, so the stored price is kept', () => {
  const item = richItem();
  const f = form(item);
  f.price = '';
  assert.deepEqual(changedPayload(item, f), {});
});

test('an untouched section that is invalid in old data does not block an unrelated edit', () => {
  const legacy = {
    id: 'm1', name: 'Paneer', category: 'Main Course', price: 280, isVeg: true, available: true,
    variants: [{ id: 'v1', label: 'Half', price: 0 }, { id: 'v2', label: 'Full', price: 99.999 }]
  };
  const f = form(legacy);
  f.available = false;
  assert.equal(validateForm(f, { original: legacy }).ok, true);
  assert.deepEqual(changedPayload(legacy, f), { available: false });
  // ...but once the variants are touched, they are checked like any new input.
  f.variants[0].label = 'Small';
  assert.equal(validateForm(f, { original: legacy }).ok, false);
});

// ---------------------------------------------------------------- new items

test('createPayload leaves out empty variant, modifier and day-part lists, and the hub accepts it', () => {
  const f = blankForm('Starters');
  Object.assign(f, { name: ' Veg Crispy ', price: '220', isVeg: true, station: 'hot' });
  const payload = createPayload(f);
  assert.deepEqual(payload, { name: 'Veg Crispy', category: 'Starters', price: 220, isVeg: true, available: true, station: 'hot' });
  const r = addItem({ categories: ['Starters'], items: [] }, payload);
  assert.equal(r.ok, true);
});

test('createPayload carries the nested lists a new item was given, and the hub accepts them', () => {
  const f = form(richItem());
  f.id = null;
  const r = addItem({ categories: ['Main Course'], items: [] }, createPayload(f));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.items[0].variants.length, 2);
});

test('makeId gives prefix_ plus 8 hex digits, never one already taken', () => {
  const id = makeId('v', []);
  assert.match(id, /^v_[0-9a-f]{8}$/);
  assert.equal(new Set(Array.from({ length: 200 }, () => makeId('o', []))).size, 200);
  const taken = new Set();
  for (let i = 0; i < 50; i++) taken.add(makeId('g', [...taken]));
  assert.equal(taken.size, 50);
  assert.deepEqual(STATIONS, ['hot', 'cold', 'bar']);
});

// ---------------------------------------------------------------- the editor's own checks

const errorsOf = (mutate, { original = null, start } = {}) => {
  const f = start ?? form(richItem());
  mutate(f);
  return validateForm(f, { original });
};

test('validateForm accepts the rich item and a minimal new one', () => {
  assert.deepEqual(validateForm(form(richItem())), { ok: true, errors: {} });
  const f = blankForm('Starters');
  Object.assign(f, { name: 'Soup', price: '99.5', isVeg: false });
  assert.deepEqual(validateForm(f), { ok: true, errors: {} });
});

test('validateForm checks the basics of a new item: name, category, veg choice, price', () => {
  const v = validateForm(blankForm(''));
  assert.equal(v.ok, false);
  assert.match(v.errors.name, /required/);
  assert.match(v.errors.category, /required/);
  assert.match(v.errors.isVeg, /Veg or Non-veg/);
  assert.match(v.errors.price, /price/i);
  for (const bad of ['0', '-5', '12.345', 'abc', '1e3', '12,5', '  ']) {
    const f = Object.assign(blankForm('A'), { name: 'X', isVeg: true, price: bad });
    assert.match(validateForm(f).errors.price ?? '', /price/i, `price ${JSON.stringify(bad)}`);
  }
  for (const good of ['1', '12.5', '12.50', '0.99', ' 40 ']) {
    const f = Object.assign(blankForm('A'), { name: 'X', isVeg: true, price: good });
    assert.equal(validateForm(f).errors.price, undefined, `price ${JSON.stringify(good)}`);
  }
  assert.match(errorsOf(f => { f.name = 'x'.repeat(121); }).errors.name, /120/);
  assert.match(errorsOf(f => { f.category = 'x'.repeat(61); }).errors.category, /60/);
});

test('validateForm: an item with variants may leave the price blank, one without may not', () => {
  assert.equal(errorsOf(f => { f.price = ''; }).ok, true);
  assert.match(errorsOf(f => { f.price = ''; f.variants = []; }).errors.price, /price/i);
});

test('validateForm checks variants: label, price, no repeated label', () => {
  const v = errorsOf(f => {
    f.variants[0].label = '  ';
    f.variants[1].price = '0';
  });
  assert.match(v.errors['variants.0.label'], /name/i);
  assert.match(v.errors['variants.1.price'], /price/i);
  assert.match(errorsOf(f => { f.variants[1].label = ' half '; }).errors['variants.1.label'], /different/i);
  assert.match(errorsOf(f => { f.variants[0].label = 'x'.repeat(41); }).errors['variants.0.label'], /40/);
});

test('validateForm checks modifier groups: label, min/max, option count and option fields', () => {
  assert.match(errorsOf(f => { f.modifier_groups[0].label = ''; }).errors['modifier_groups.0.label'], /name/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].min = '-1'; }).errors['modifier_groups.0.min'], /whole number/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].max = '0'; }).errors['modifier_groups.0.max'], /at least 1/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].min = '2'; f.modifier_groups[0].max = '1'; }).errors['modifier_groups.0.max'], /at least the minimum|at least min|not less than/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].min = '3'; f.modifier_groups[0].max = '3'; }).errors['modifier_groups.0.min'], /options/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].options = []; }).errors['modifier_groups.0.options'], /at least one option/i);
  assert.match(errorsOf(f => { f.modifier_groups[0].options[0].label = ''; }).errors['modifier_groups.0.options.0.label'], /name/i);
  assert.match(errorsOf(f => { f.modifier_groups[1].options[0].price_delta = 'abc'; }).errors['modifier_groups.1.options.0.price_delta'], /number/i);
  assert.equal(errorsOf(f => { f.modifier_groups[1].options[1].price_delta = '-10.5'; }).ok, true, 'a discount is fine');
  assert.equal(errorsOf(f => { f.modifier_groups[1].options[1].price_delta = '0'; }).ok, true, 'free is fine');
});

test('validateForm checks day-parts: label, times, a window with a length, and some price', () => {
  assert.match(errorsOf(f => { f.day_parts[0].label = ''; }).errors['day_parts.0.label'], /name/i);
  assert.match(errorsOf(f => { f.day_parts[0].starts_at = ''; }).errors['day_parts.0.starts_at'], /time/i);
  assert.match(errorsOf(f => { f.day_parts[0].ends_at = '25:00'; }).errors['day_parts.0.ends_at'], /time/i);
  assert.match(errorsOf(f => { f.day_parts[0].ends_at = '12:00'; }).errors['day_parts.0.ends_at'], /differ|same/i);
  assert.match(errorsOf(f => { f.day_parts[1].price = ''; }).errors['day_parts.1.price'], /price/i);
  assert.match(errorsOf(f => { f.day_parts[1].price = '0'; }).errors['day_parts.1.price'], /price/i);
  assert.match(errorsOf(f => { f.day_parts[0].variant_prices.v_half = '-3'; }).errors['day_parts.0.variant_prices.v_half'], /price/i);
  assert.equal(errorsOf(f => { f.day_parts[1].starts_at = '22:00'; f.day_parts[1].ends_at = '02:00'; }).ok, true, 'a window past midnight is fine');
  assert.equal(errorsOf(f => { f.day_parts[0].variant_prices = {}; f.day_parts[0].price = '210'; }).ok, true, 'one flat price is enough');
});

test('validateForm agrees with the hub about what it will accept', () => {
  const rich = richItem();
  const cases = [
    f => f,
    f => { f.name = ''; },
    f => { f.price = '0'; },
    f => { f.price = '12.345'; },
    f => { f.variants[0].price = '0'; },
    f => { f.variants[0].label = 'x'.repeat(41); },
    f => { f.modifier_groups[0].max = '0'; },
    f => { f.modifier_groups[0].min = '3'; f.modifier_groups[0].max = '3'; },
    f => { f.modifier_groups[0].options = []; },
    f => { f.modifier_groups[1].options[0].price_delta = 'x'; },
    f => { f.day_parts[0].starts_at = '9:61'; },
    f => { f.day_parts[0].label = ''; },
    f => { f.day_parts[1].price = ''; },
    f => { f.day_parts[0].days = [1, 9]; },
    f => { f.variants = []; f.day_parts[0].variant_prices = {}; f.day_parts[0].price = '100'; },
    f => { f.station = 'grill'; }
  ];
  for (const [i, mutate] of cases.entries()) {
    const f = form(rich);
    mutate(f);
    const client = validateForm(f, { original: rich }).ok;
    const payload = changedPayload(rich, f);
    const hub = validateItemInput(payload, { partial: true }).ok;
    // A client "ok" must be a hub "ok"; the client may be stricter, never looser.
    if (client) assert.equal(hub, true, `case ${i}: the editor let through ${JSON.stringify(payload)}`);
    // And the cases the hub refuses are all ones the editor catches.
    if (!hub) assert.equal(client, false, `case ${i}: the hub refuses ${JSON.stringify(payload)} but the editor did not`);
  }
});

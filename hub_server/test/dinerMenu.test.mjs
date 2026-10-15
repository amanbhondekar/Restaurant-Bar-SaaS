import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publicItem, publicMenu } from '../lib/dinerMenu.js';

// The menu a guest sees (M4 · diner QR menu). This is the hub's only unauthenticated read, so
// most of what matters here is what does NOT come out.

// A day-part window is wall-clock time in the restaurant's own timezone: resolveActiveDayPart
// compares against getHours(). So these have to be built as LOCAL times, not pinned to an offset
// -- "17:30+05:30" is 12:00 in CI's UTC and falls outside a 16:00-19:00 happy hour, which is
// exactly how the first version of these two tests passed here and failed there.
const at = (hh, mm = 0) => new Date(2026, 9, 16, hh, mm, 0, 0);

const dish = (over = {}) => ({
  id: 'm1',
  name: 'Paneer Tikka',
  category: 'Starters',
  price: 230,
  isVeg: true,
  available: true,
  station: 'hot',
  ...over
});

const cache = (items, categories = ['Starters', 'Mains']) => ({
  restaurant_id: 'r', revision: 4, categories, items
});

// --- what must never reach a guest ---------------------------------------------------------

test('diner menu: kitchen routing never reaches the guest', () => {
  const out = publicItem(dish());
  assert.equal(out.station, undefined, 'which station cooks a dish is the restaurant\'s business');
});

test('diner menu: the day-part schedule never reaches the guest', () => {
  // The guest sees today's price. The schedule that produces it -- when happy hour starts, what
  // the late-night markup is -- is pricing strategy and stays inside.
  const out = publicItem(dish({
    day_parts: [{ id: 'dp_hh', label: 'Happy hour', starts_at: '16:00', ends_at: '19:00', price: 150 }]
  }), at(12));
  assert.equal(out.day_parts, undefined);
  assert.equal(out.price, 230);
});

test('diner menu: the projection is an allow-list, so a new cache field does not leak by default', () => {
  // The real risk is not a field someone forgot to delete today; it is the one added next year.
  const out = publicItem(dish({
    cost_price: 90,
    supplier_note: 'call Ramesh',
    internal_margin: 0.61
  }));
  assert.deepEqual(
    Object.keys(out).sort(),
    ['category', 'id', 'is_veg', 'name', 'price']
  );
});

// --- availability -----------------------------------------------------------------------------

test('diner menu: an 86\'d dish is hidden, not greyed out', () => {
  // A guest cannot order from this screen, so showing something unavailable only invites them
  // to ask for it.
  assert.equal(publicItem(dish({ available: false })), null);
});

test('diner menu: 86\'d sizes drop out, and a dish with none left is hidden', () => {
  const half = { id: 'v_h', label: 'Half', price: 140, available: true };
  const full = { id: 'v_f', label: 'Full', price: 230, available: false };

  const out = publicItem(dish({ price: undefined, variants: [half, full] }));
  assert.deepEqual(out.variants.map(v => v.label), ['Half']);
  assert.equal(out.price, undefined, 'a dish priced by size has no single price');

  assert.equal(publicItem(dish({ variants: [{ ...half, available: false }, full] })), null);
});

test('diner menu: a dish with no usable price is hidden rather than shown as free', () => {
  assert.equal(publicItem(dish({ price: 0 })), null);
  assert.equal(publicItem(dish({ price: undefined })), null);
  assert.equal(publicItem(dish({ price: 'ask' })), null);
});

// --- prices -------------------------------------------------------------------------------

test('diner menu: the price shown is the one that would be charged right now', () => {
  // Showing the base price during happy hour would quote a guest a number the kitchen would not
  // honour, which is worse than showing nothing.
  const happyHour = dish({
    day_parts: [{ id: 'dp_hh', label: 'Happy hour', starts_at: '16:00', ends_at: '19:00', price: 150 }]
  });
  assert.equal(publicItem(happyHour, at(17, 30)).price, 150);
  assert.equal(publicItem(happyHour, at(12)).price, 230);
});

test('diner menu: a day-part price applies to sizes too', () => {
  const item = dish({
    price: undefined,
    variants: [{ id: 'v_h', label: 'Half', price: 140 }, { id: 'v_f', label: 'Full', price: 230 }],
    day_parts: [{
      id: 'dp_hh', label: 'Happy hour', starts_at: '16:00', ends_at: '19:00',
      price: 150, variant_prices: { v_h: 90, v_f: 150 }
    }]
  });
  assert.deepEqual(publicItem(item, at(17, 30)).variants.map(v => v.price), [90, 150]);
});

// --- options ------------------------------------------------------------------------------

test('diner menu: options show what they add, and a free choice still shows', () => {
  const out = publicItem(dish({
    modifier_groups: [{
      id: 'mg_spice', label: 'Spice', min: 1, max: 1,
      options: [
        { id: 'hot', label: 'Hot', price_delta: 0 },
        { id: 'cheese', label: 'Extra cheese', price_delta: 40 }
      ]
    }]
  }));
  assert.deepEqual(out.options[0].options.map(o => [o.label, o.price_delta]),
    [['Hot', 0], ['Extra cheese', 40]]);
});

test('diner menu: an 86\'d option drops out, and a group with none left disappears', () => {
  const group = opts => dish({ modifier_groups: [{ id: 'g', label: 'Add-ons', options: opts }] });

  const partial = publicItem(group([
    { id: 'a', label: 'Cheese', price_delta: 40 },
    { id: 'b', label: 'Truffle', price_delta: 300, available: false }
  ]));
  assert.deepEqual(partial.options[0].options.map(o => o.label), ['Cheese']);

  const empty = publicItem(group([{ id: 'b', label: 'Truffle', price_delta: 300, available: false }]));
  assert.equal(empty.options, undefined, 'an empty choice would be a dead end on screen');
});

// --- the whole menu ---------------------------------------------------------------------------

test('diner menu: categories keep the restaurant\'s order and empty ones are dropped', () => {
  const out = publicMenu(cache(
    [dish({ id: 'a', category: 'Mains' }), dish({ id: 'b', category: 'Starters' })],
    ['Starters', 'Mains', 'Desserts']
  ));
  assert.deepEqual(out.categories.map(c => c.name), ['Starters', 'Mains'],
    'Desserts has nothing in it tonight');
  assert.equal(out.item_count, 2);
});

test('diner menu: a category only an item mentions is still shown, after the declared ones', () => {
  const out = publicMenu(cache(
    [dish({ id: 'a', category: 'Specials' }), dish({ id: 'b', category: 'Starters' })],
    ['Starters']
  ));
  assert.deepEqual(out.categories.map(c => c.name), ['Starters', 'Specials']);
});

test('diner menu: an empty or malformed cache is an empty menu, not a crash', () => {
  for (const bad of [null, undefined, {}, { items: null }, { items: 'nope' }]) {
    const out = publicMenu(bad);
    assert.deepEqual(out.categories, []);
    assert.equal(out.item_count, 0);
  }
});

test('diner menu: a menu where everything is 86\'d comes back empty rather than half-built', () => {
  const out = publicMenu(cache([dish({ id: 'a', available: false }), dish({ id: 'b', available: false })]));
  assert.deepEqual(out.categories, []);
  assert.equal(out.item_count, 0);
});

// --- through the route ------------------------------------------------------------------------

test('hub: GET /public/menu needs no device token, and still leaks nothing', async () => {
  const { startHub, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    // trustLoopback false: this request is treated as coming from a stranger's phone, not from
    // the reception laptop, which is exactly what a guest on the wifi is.
    trustLoopback: false,
    menu: {
      restaurant_id: RESTAURANT_ID,
      categories: ['Starters'],
      items: [
        { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true, station: 'hot' },
        { id: 'm2', name: 'Sold Out Dish', price: 100, category: 'Starters', isVeg: true, available: false, station: 'cold' }
      ]
    },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    // No Authorization header at all.
    const res = await fetch(`${hub.base}/public/menu`);
    assert.equal(res.status, 200, 'a guest is not enrolled and must not need to be');
    const body = await res.json();

    assert.equal(body.item_count, 1, 'the 86\'d dish is not offered');
    assert.equal(body.categories[0].items[0].name, 'Paneer Tikka');

    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('station'), 'kitchen routing must not be in the response');
    assert.ok(!raw.includes('Sold Out Dish'));
    assert.ok(!raw.includes('enrollment'), 'and nothing that would let a guest enrol a device');
    assert.ok(!raw.includes('pairing_code'));

    // The authenticated menu is still protected -- making one route public did not open another.
    const staff = await fetch(`${hub.base}/menu`);
    assert.equal(staff.status, 401);
  } finally {
    hub.stop();
  }
});

test('hub: the table QR is reception-only, even though the menu behind it is public', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const MENU = {
    restaurant_id: RESTAURANT_ID, categories: ['Starters'],
    items: [{ id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true }]
  };
  const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] };

  const reception = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES });
  const handset = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES });

  try {
    // A guest's phone can read the menu but must not be told where the hub lives.
    assert.equal((await fetch(`${handset.base}/public/menu`)).status, 200);
    const refused = await fetch(`${handset.base}/qr/diner?table=4`);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'RECEPTION_ONLY');

    const res = await hubCall(reception, '/qr/diner?table=4');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.table, '4');
    assert.match(body.diner_url, /\/diner\?t=4$/);
    assert.match(body.qr_code, /^data:image\/png;base64,/);

    // No table is a perfectly good code: one menu for the whole room.
    const plain = await (await hubCall(reception, '/qr/diner')).json();
    assert.equal(plain.table, null);
    assert.match(plain.diner_url, /\/diner$/);

    // A table label is carried, not trusted -- anything that would not survive a URL is dropped.
    const hostile = await (await hubCall(reception, '/qr/diner?table=' + encodeURIComponent('<script>x</script>'))).json();
    assert.equal(hostile.table, null);
    assert.match(hostile.diner_url, /\/diner$/);
  } finally {
    reception.stop();
    handset.stop();
  }
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Stock and recipes through a real hub: set a dish's recipe, take orders, watch the dish leave and
// rejoin every menu, and check that none of it can be done by someone who is not reception.

const RID = RESTAURANT_ID;
const MENU = {
  restaurant_id: RID,
  categories: ['Starters', 'Mains'],
  items: [
    { id: 'paneer', name: 'Paneer Tikka', price: 280, category: 'Starters', isVeg: true, available: true },
    { id: 'dal', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true },
    { id: 'chai', name: 'Masala Chai', price: 40, category: 'Mains', isVeg: true, available: true },     // never given a recipe
    {
      id: 'biryani', name: 'Biryani', price: 260, category: 'Mains', isVeg: false, available: true,
      variants: [{ id: 'half', label: 'Half', price: 260, available: true }, { id: 'full', label: 'Full', price: 480, available: true }]
    }
  ]
};
const TABLES = { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] };

let hub;
let strangerHub;
before(async () => {
  hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'STOCKCODE' });
  strangerHub = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'STRANGER' });
});
after(() => { hub?.stop(); strangerHub?.stop(); });

const call = (h, p, { method = 'GET', body, token } = {}) =>
  fetch(`${h.base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
const api = (p, opts) => call(hub, p, opts);
const json = async res => res.json();
const order = items => api('/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items } });
const menuItem = async id => (await json(await api('/menu'))).items.find(i => i.id === id);

async function addIngredient(item) {
  const res = await api('/admin/inventory/items', { method: 'POST', body: { item } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await json(res)).item;
}
async function setRecipe(item_id, lines, variant_id) {
  const res = await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id, ...(variant_id ? { variant_id } : {}), lines } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
}
const stockOf = async id => (await json(await api('/admin/inventory'))).items.find(i => i.id === id).on_hand;

let paneer;
let onion;

test('inventory: an ingredient and a recipe can be set up, and the console sees them with their level', async () => {
  paneer = await addIngredient({ name: 'Paneer', unit: 'g', on_hand: 1000, low_at: 200 });
  onion = await addIngredient({ name: 'Onion', unit: 'kg', on_hand: 2, low_at: 0.5 });
  await setRecipe('paneer', [{ inventory_item_id: paneer.id, qty: 150 }, { inventory_item_id: onion.id, qty: 0.1 }]);
  await setRecipe('dal', [{ inventory_item_id: onion.id, qty: 0.2 }]);

  const snap = await json(await api('/admin/inventory'));
  assert.equal(snap.success, true);
  assert.deepEqual(snap.items.map(i => [i.name, i.on_hand, i.level]), [['Paneer', 1000, 'ok'], ['Onion', 2, 'ok']]);
  assert.deepEqual(snap.recipes.map(r => [r.item_name, r.on_menu]).sort(), [['Dal Tadka', true], ['Paneer Tikka', true]]);
  assert.deepEqual(snap.summary, { ingredients: 2, out: 0, low: 0, reorder: 0, recipes: 2 });
  assert.ok(snap.units.includes('g'));

  assert.equal((await menuItem('paneer')).stock_out, undefined, 'plenty on hand: nothing flagged');
});

test('inventory: an order takes its ingredients out of stock and records why', async () => {
  const res = await order([{ id: 'paneer', qty: 2 }, { id: 'dal', qty: 1 }]);
  assert.equal(res.status, 201);
  const ticket = (await json(res)).ticket;

  assert.equal(await stockOf(paneer.id), 700);
  assert.equal(await stockOf(onion.id), 1.6, '2 kg - 2 x 0.1 - 0.2');

  const moves = (await json(await api(`/admin/inventory/movements?item_id=${paneer.id}`))).movements;
  assert.deepEqual([moves[0].reason, moves[0].delta, moves[0].ref], ['sale', -300, `#${ticket.ticket_number}`]);
});

test('inventory: a dish with no recipe is never held up by stock', async () => {
  assert.equal((await order([{ id: 'chai', qty: 40 }])).status, 201);
});

test('inventory: an order that needs more than is on hand is refused, whole, with a reason the waiter can read', async () => {
  const before = await stockOf(paneer.id);
  const activeBefore = (await json(await api('/orders/active'))).tickets.length;

  // 700 g on hand; 5 x 150 g = 750 g.
  const res = await order([{ id: 'paneer', qty: 5 }]);
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.match(body.error, /Not enough stock for this order\. Paneer Tikka: needs 750 g of Paneer, 700 g left\./);
  assert.deepEqual(body.details.map(d => [d.id, d.reason]), [['paneer', 'OUT_OF_STOCK']]);
  assert.deepEqual(body.details[0].short[0], { ingredient: 'Paneer', unit: 'g', needed: 750, on_hand: 700 });

  assert.equal(await stockOf(paneer.id), before, 'nothing was taken');
  assert.equal((await json(await api('/orders/active'))).tickets.length, activeBefore, 'and no ticket was created');
});

test('inventory: two dishes that share an ingredient are checked against it together', async () => {
  // Onion: 1.6 kg left. 6 paneer need 0.6 kg, 8 dal need 1.6 kg. Each fits alone (paneer also needs 900 g of 700 -- so use 4).
  // 4 paneer = 600 g paneer (fine) + 0.4 kg onion; 7 dal = 1.4 kg onion. Alone: fine. Together: 1.8 kg > 1.6 kg.
  const alonePaneer = await order([{ id: 'paneer', qty: 4 }]);
  assert.equal(alonePaneer.status, 201, 'that fits on its own');
  // The stock has now moved; reset the onion so the together-case is judged on a known figure.
  await api(`/admin/inventory/items/${onion.id}/adjust`, { method: 'POST', body: { kind: 'count', qty: 1.6 } });
  await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'count', qty: 1000 } });

  const dalAlone = await order([{ id: 'dal', qty: 7 }]);
  assert.equal(dalAlone.status, 201, '7 dal = 1.4 kg of 1.6 kg');
  await api(`/admin/inventory/items/${onion.id}/adjust`, { method: 'POST', body: { kind: 'count', qty: 1.6 } });

  const together = await order([{ id: 'paneer', qty: 4 }, { id: 'dal', qty: 7 }]);
  assert.equal(together.status, 409, 'together they need 1.8 kg of onion');
  const body = await json(together);
  assert.match(body.error, /Onion/);
  assert.equal(body.details.length, 2, 'both dishes are named, since both use it');
  assert.equal(await stockOf(onion.id), 1.6);
});

test('inventory: a dish that can no longer be made leaves the waiter\'s menu grid flagged and the diner\'s menu entirely', async () => {
  await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'count', qty: 100 } });   // a portion needs 150

  const waiter = await menuItem('paneer');
  assert.equal(waiter.stock_out, true);
  assert.equal(waiter.available, true, 'the flag is separate: this is not a hand 86');
  assert.equal((await menuItem('dal')).stock_out, undefined, 'dal can still be made');

  const diner = await json(await call(hub, '/public/menu'));
  const names = diner.categories.flatMap(c => c.items.map(i => i.name));
  assert.equal(names.includes('Paneer Tikka'), false, 'a guest is not shown what cannot be served');
  assert.equal(names.includes('Dal Tadka'), true);
});

test('inventory: even a stale handset that still shows the dish is refused by the hub', async () => {
  const res = await order([{ id: 'paneer', qty: 1 }]);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'OUT_OF_STOCK');
});

test('inventory: a delivery brings the dish back everywhere, by itself', async () => {
  await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'receive', qty: 900 } });
  assert.equal((await menuItem('paneer')).stock_out, undefined);
  const names = (await json(await call(hub, '/public/menu'))).categories.flatMap(c => c.items.map(i => i.name));
  assert.equal(names.includes('Paneer Tikka'), true);
  assert.equal((await order([{ id: 'paneer', qty: 1 }])).status, 201);
});

test('inventory: a stock-out is never saved into the menu, so editing a dish while it is out does not 86 it for good', async () => {
  await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'count', qty: 0 } });
  assert.equal((await menuItem('paneer')).stock_out, true);

  // What the menu editor does: it loads the dish, changes something, and saves.
  const current = await menuItem('paneer');
  const rev = (await json(await api('/menu'))).revision;
  const saved = await api('/admin/menu/items/paneer', { method: 'PUT', body: { base_revision: rev, item: { name: 'Paneer Tikka Special', available: current.available } } });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

  await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'receive', qty: 1000 } });
  const back = await menuItem('paneer');
  assert.equal(back.name, 'Paneer Tikka Special');
  assert.equal(back.available, true, 'it came back with the stock: nothing had marked it unavailable');
  assert.equal(back.stock_out, undefined);
});

test('inventory: sizes are judged on their own recipes', async () => {
  const rice = await addIngredient({ name: 'Rice', unit: 'kg', on_hand: 0.3, low_at: 0 });
  await setRecipe('biryani', [{ inventory_item_id: rice.id, qty: 0.2 }], 'half');
  await setRecipe('biryani', [{ inventory_item_id: rice.id, qty: 0.4 }], 'full');

  const b = await menuItem('biryani');
  assert.equal(b.variants.find(v => v.id === 'full').stock_out, true, '0.4 kg of 0.3 kg');
  assert.equal(b.variants.find(v => v.id === 'half').stock_out, undefined);
  assert.equal(b.stock_out, undefined, 'Half can still be sold');

  assert.equal((await order([{ id: 'biryani', variant_id: 'full', qty: 1 }])).status, 409);
  assert.equal((await order([{ id: 'biryani', variant_id: 'half', qty: 1 }])).status, 201);
});

test('inventory: a change that moves a dish in or out of stock is broadcast to every handset', async () => {
  const lime = await addIngredient({ name: 'Lime', unit: 'pcs', on_hand: 2 });
  await setRecipe('chai', [{ inventory_item_id: lime.id, qty: 1 }]);

  const heard = [];
  const ws = new WebSocket(hub.base.replace('http', 'ws') + '/live');
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', m => { try { heard.push(JSON.parse(m.toString()).type); } catch { /* ignore */ } });

  assert.equal((await order([{ id: 'chai', qty: 2 }])).status, 201);       // takes both limes: chai is now out
  const deadline = Date.now() + 5000;
  while (!heard.includes('STOCK_CHANGED') && Date.now() < deadline) await new Promise(r => setTimeout(r, 40));
  ws.close();

  assert.ok(heard.includes('menu_updated'), 'handsets re-read the menu');
  assert.ok(heard.includes('STOCK_CHANGED'));
});

// --- validation and refusals ---------------------------------------------------------------

test('inventory: bad input is refused with a reason, and a refusal changes nothing', async () => {
  const bad = await api('/admin/inventory/items', { method: 'POST', body: { item: { name: '', unit: 'cups', on_hand: -2 } } });
  assert.equal(bad.status, 400);
  const body = await json(bad);
  assert.equal(body.code, 'INVALID_INGREDIENT');
  assert.deepEqual(body.errors.map(e => e.field).sort(), ['name', 'on_hand', 'unit']);

  const dup = await api('/admin/inventory/items', { method: 'POST', body: { item: { name: ' paneer ', unit: 'g' } } });
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).code, 'DUPLICATE_INGREDIENT');

  assert.equal((await api('/admin/inventory/items', { method: 'POST', body: {} })).status, 400, 'no item at all');
  assert.equal((await api(`/admin/inventory/items/${paneer.id}/adjust`, { method: 'POST', body: { kind: 'waste', qty: 99999 } })).status, 409);
  assert.equal((await api(`/admin/inventory/items/ing_nope/adjust`, { method: 'POST', body: { kind: 'receive', qty: 1 } })).status, 404);
  assert.equal((await api(`/admin/inventory/items/${paneer.id}`, { method: 'PUT', body: { item: { on_hand: 5 } } })).status, 400, 'the amount is changed by an adjustment');
  assert.equal((await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id: 'ghost', lines: [] } })).status, 404);
});

test('inventory: an ingredient a recipe uses cannot be deleted until it is taken out of the recipe', async () => {
  const del = await api(`/admin/inventory/items/${paneer.id}`, { method: 'DELETE' });
  assert.equal(del.status, 409);
  assert.equal((await json(del)).code, 'INGREDIENT_IN_USE');

  await setRecipe('paneer', [{ inventory_item_id: onion.id, qty: 0.1 }]);          // no longer uses paneer
  assert.equal((await api(`/admin/inventory/items/${paneer.id}`, { method: 'DELETE' })).status, 200);
});

test('inventory: a recipe for a dish that left the menu is kept and flagged, not silently hidden', async () => {
  const del = await api('/admin/menu/items/dal?base_revision=' + (await json(await api('/menu'))).revision, { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(await del.clone().json()));
  const snap = await json(await api('/admin/inventory'));
  const orphan = snap.recipes.find(r => r.item_id === 'dal');
  assert.ok(orphan);
  assert.equal(orphan.on_menu, false);
  assert.equal(orphan.item_name, null);
});

test('inventory: every route is reception-only -- a stranger, and an enrolled handset, are both refused', async () => {
  const enrolled = await (await call(strangerHub, '/auth/device', { method: 'POST', body: { enrollment_code: 'STRANGER', device_label: 'Handset' } })).json();
  assert.ok(enrolled.device_token, 'the fixture handset is enrolled');

  const routes = [
    ['GET', '/admin/inventory'], ['GET', '/admin/inventory/movements'],
    ['POST', '/admin/inventory/items', { item: { name: 'X', unit: 'g' } }],
    ['PUT', '/admin/inventory/items/x', { item: { name: 'Y' } }],
    ['DELETE', '/admin/inventory/items/x'],
    ['POST', '/admin/inventory/items/x/adjust', { kind: 'receive', qty: 1 }],
    ['PUT', '/admin/inventory/recipes', { item_id: 'paneer', lines: [] }]
  ];
  for (const [method, p, body] of routes) {
    for (const token of [undefined, enrolled.device_token]) {
      const res = await call(strangerHub, p, { method, body, token });
      assert.ok([401, 403].includes(res.status), `${method} ${p} ${token ? 'with a handset token' : 'with no token'} -> ${res.status}`);
    }
  }
  // And nothing was written: the stranger hub still has no ingredients.
  const file = path.join(strangerHub.dataDir, 'inventory.json');
  assert.equal(fs.existsSync(file), false, 'no inventory file was ever created');
});

test('inventory: it survives a hub restart (what is on disk is what the hub reads back)', async () => {
  const file = path.join(hub.dataDir, 'inventory.json');
  const deadline = Date.now() + 5000;
  let onDisk;
  while (Date.now() < deadline) {
    try { onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')); if (onDisk.items.length >= 3) break; } catch { /* mid-write */ }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(onDisk, 'inventory.json exists');
  assert.equal(onDisk.restaurant_id, RID);
  assert.deepEqual(onDisk.items.map(i => i.name).sort(), ['Lime', 'Onion', 'Paneer', 'Rice'].filter(n => onDisk.items.some(i => i.name === n)).sort());
  assert.ok(onDisk.recipes.length >= 3);
  assert.ok(onDisk.movements.some(m => m.reason === 'sale'));
});

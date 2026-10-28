import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import { cancelTicket, anyCooked, initCourseState, markStationReady, markAllReady, recallTicket } from '../lib/courses.js';
import { emptyState, addIngredient, restock, consume } from '../lib/inventory.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Cancelling an order (§3 inventory limits). The rule first, then a real hub. The policy being tested, in one
// sentence: before anything is cooked the ingredients go back on the shelf; after, they stay consumed.

const T0 = '2026-10-22T12:00:00.000Z';
const T1 = '2026-10-22T12:05:00.000Z';
const ITEMS = [{ id: 'dal', name: 'Dal', qty: 1, price: 100, station: 'hot', course: 1 }, { id: 'tea', name: 'Chai', qty: 1, price: 40, station: 'bar', course: 1 }];
const ticket = (over = {}) => ({ id: 't_1', ticket_number: 142, status: 'in_progress', items: ITEMS, created_at: T0, updated_at: T0, ...initCourseState(ITEMS, {}, T0), ...over });

// --- the rule ------------------------------------------------------------------------------------

test('nothing has been cooked until a station says so, the ticket is ready, or it was ready once', () => {
  assert.equal(anyCooked(ticket()), false);
  assert.equal(anyCooked(markStationReady(ticket(), 'bar', T1).ticket), true, 'one station reported its part');
  assert.equal(anyCooked(markAllReady(ticket(), T1).ticket), true);
  assert.equal(anyCooked(ticket({ status: 'ready' })), true, 'a ticket that SAYS it is ready is cooked, whatever its log says (older tickets)');
  const recalled = recallTicket(markAllReady(ticket(), T1).ticket, T1).ticket;
  assert.equal(recalled.status, 'in_progress');
  assert.equal(anyCooked(recalled), true, 'recalled: the food was made once and is being made again');
});

test('an order on the board can be cancelled, and the ticket says when, why, by whom and whether it was cooked', () => {
  const r = cancelTicket(ticket(), T1, { reason: 'guest left', by: 'Asha' });
  assert.equal(r.ok, true);
  assert.equal(r.cooked, false);
  assert.deepEqual([r.ticket.status, r.ticket.cancelled_at, r.ticket.cancel_reason, r.ticket.cancelled_by, r.ticket.cancel_cooked], ['cancelled', T1, 'guest left', 'Asha', false]);
});

test('a cancelled-after-cooking ticket is marked so', () => {
  const r = cancelTicket(markAllReady(ticket(), T1).ticket, T1);
  assert.deepEqual([r.ok, r.cooked, r.ticket.cancel_cooked], [true, true, true]);
});

test('a billed order cannot be cancelled -- void the bill -- and nothing is cancelled twice', () => {
  assert.equal(cancelTicket(ticket({ status: 'completed' }), T1).code, 'TICKET_CLOSED');
  assert.match(cancelTicket(ticket({ status: 'completed' }), T1).error, /Void the bill/);
  assert.equal(cancelTicket(ticket({ status: 'cancelled' }), T1).code, 'ALREADY_CANCELLED');
});

test('the reason is capped and the cancelling person kept short, whatever was sent', () => {
  const r = cancelTicket(ticket(), T1, { reason: 'x'.repeat(500), by: 'y'.repeat(200) });
  assert.equal(r.ticket.cancel_reason.length, 140);
  assert.equal(r.ticket.cancelled_by.length, 60);
});

test('putting stock back returns exactly what was taken, records each movement, and skips an ingredient since deleted', () => {
  let s = emptyState('r');
  const add = (name, qty) => { const r = addIngredient(s, { name, unit: 'g', on_hand: qty, low_at: 0 }, {}); s = r.data; return r.meta.item.id; };
  const cheese = add('Cheese', 100);
  const rice = add('Rice', 500);
  const back = restock(s, [{ inventory_item_id: cheese, qty: 40 }, { inventory_item_id: rice, qty: 60.5 }, { inventory_item_id: 'ing_gone', qty: 9 }], { ref: '#142', note: 'order cancelled', by: 'Asha' });

  assert.equal(back.ok, true);
  assert.deepEqual(back.data.items.map(i => [i.name, i.on_hand]), [['Cheese', 140], ['Rice', 560.5]]);
  assert.deepEqual(back.meta.movements.map(m => [m.reason, m.delta, m.ref]), [['return', 40, '#142'], ['return', 60.5, '#142']]);
  assert.equal(back.data.revision, s.revision + 1);
});

test('putting back nothing changes nothing, and nonsense is not put back', () => {
  const s = emptyState('r');
  assert.equal(restock(s, [], {}).data, s);
  assert.equal(restock(s, undefined, {}).data, s);
  assert.equal(restock(s, [{ inventory_item_id: 'x', qty: -5 }, { inventory_item_id: 'y', qty: 'lots' }, null], {}).data, s);
});

// --- a real hub --------------------------------------------------------------------------------------

const MENU = {
  restaurant_id: RESTAURANT_ID, categories: ['Mains'],
  items: [
    {
      id: 'biryani', name: 'Biryani', price: 260, category: 'Mains', isVeg: false, available: true, station: 'hot',
      modifier_groups: [{ id: 'g', label: 'Extras', min: 0, max: 2, options: [{ id: 'cheese', label: 'Extra cheese', price_delta: 30, available: true }] }]
    },
    { id: 'tea', name: 'Chai', price: 40, category: 'Mains', isVeg: true, available: true, station: 'bar' }
  ]
};
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }, { id: 2, name: 'T2', section: 'Main', capacity: 4 }] };

let hub;
let remote;
before(async () => {
  hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'CANCELCODE' });
  remote = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'CANCELREMOTE' });
});
after(() => { hub?.stop(); remote?.stop(); });

const api = (p, opts) => call(hub, p, opts);
const json = r => r.json();
const stock = async () => Object.fromEntries((await json(await api('/admin/inventory'))).items.map(i => [i.name, i.on_hand]));
const moves = async name => {
  const inv = await json(await api('/admin/inventory'));
  const ing = inv.items.find(i => i.name === name);
  return (await json(await api(`/admin/inventory/movements?item_id=${ing.id}`))).movements;
};
const order = async (items, table = 1) => {
  const res = await api('/orders', { method: 'POST', body: { table_id: table, table_name: `T${table}`, items, order_request_id: `req-${Math.random()}` } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await json(res)).ticket;
};
const cancel = (id, body = {}, h = hub, token) => call(h, `/orders/${id}/cancel`, { method: 'POST', body, token });
const active = async () => (await json(await api('/orders/active'))).tickets;

let rice;
let cheese;
test('hub: set up stock and a recipe with an extra', async () => {
  rice = (await json(await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Rice', unit: 'kg', on_hand: 10, low_at: 0 } } }))).item;
  cheese = (await json(await api('/admin/inventory/items', { method: 'POST', body: { item: { name: 'Cheese', unit: 'g', on_hand: 200, low_at: 0 } } }))).item;
  const res = await api('/admin/inventory/recipes', {
    method: 'PUT',
    body: { item_id: 'biryani', lines: [{ inventory_item_id: rice.id, qty: 0.3 }, { inventory_item_id: cheese.id, qty: 20, group_id: 'g', option_id: 'cheese' }] }
  });
  assert.equal(res.status, 200);
});

test('hub: an order is recorded with exactly what it took out of stock', async () => {
  const t = await order([{ id: 'biryani', qty: 2, modifiers: [{ group_id: 'g', option_id: 'cheese' }] }]);
  const stored = (await active()).find(x => x.id === t.id);
  assert.deepEqual(stored.stock_used.map(u => [u.inventory_item_id, u.qty]).sort(), [[cheese.id, 40], [rice.id, 0.6]].sort());
  await cancel(t.id);   // tidy: the next tests start from full stock
  assert.deepEqual(await stock(), { Rice: 10, Cheese: 200 });
});

test('hub: cancelling before anything is cooked takes the order off the board and puts every ingredient back', async () => {
  const t = await order([{ id: 'biryani', qty: 3, modifiers: [{ group_id: 'g', option_id: 'cheese' }] }]);
  assert.deepEqual(await stock(), { Rice: 9.1, Cheese: 140 });

  const res = await cancel(t.id, { reason: 'guest left', by: 'Asha' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual([body.cooked, body.stock_returned, body.ticket.status, body.ticket.cancel_reason, body.ticket.cancelled_by], [false, true, 'cancelled', 'guest left', 'Asha']);

  assert.deepEqual(await stock(), { Rice: 10, Cheese: 200 }, 'every gram, the extra included');
  assert.equal((await active()).some(x => x.id === t.id), false, 'off the board');
  const m = (await moves('Cheese')).find(x => x.reason === 'return');
  assert.deepEqual([m.delta, m.ref, m.note], [60, `#${t.ticket_number}`, 'order cancelled']);
});

test('hub: once any of it is cooked the ingredients stay used, and the ticket says it was cancelled after cooking', async () => {
  const t = await order([{ id: 'biryani', qty: 1 }, { id: 'tea', qty: 1 }]);
  const before = await stock();
  assert.equal((await api(`/orders/${t.id}/stations/bar/ready`, { method: 'POST' })).status, 200);

  const body = await json(await cancel(t.id, { reason: 'wrong table' }));
  assert.deepEqual([body.cooked, body.stock_returned, body.ticket.cancel_cooked], [true, false, true]);
  assert.deepEqual(await stock(), before, 'nothing came back');
});

test('hub: a ticket marked ready can be cancelled, and is treated as cooked', async () => {
  const t = await order([{ id: 'biryani', qty: 1 }]);
  await api(`/orders/${t.id}/ready`, { method: 'POST' });
  const before = await stock();
  const body = await json(await cancel(t.id));
  assert.deepEqual([body.cooked, body.stock_returned], [true, false]);
  assert.deepEqual(await stock(), before);
});

test('hub: what comes back is what THAT order took, even if the recipe has changed since', async () => {
  const t = await order([{ id: 'biryani', qty: 1 }]);          // took 0.3 kg of rice
  const before = await stock();
  await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id: 'biryani', lines: [{ inventory_item_id: rice.id, qty: 5 }] } });
  await cancel(t.id);
  assert.equal((await stock()).Rice, Math.round((before.Rice + 0.3) * 1000) / 1000, 'not 5 kg, which is what the recipe says now');
  await api('/admin/inventory/recipes', { method: 'PUT', body: { item_id: 'biryani', lines: [{ inventory_item_id: rice.id, qty: 0.3 }, { inventory_item_id: cheese.id, qty: 20, group_id: 'g', option_id: 'cheese' }] } });
});

test('hub: cancelling twice returns the stock once', async () => {
  const t = await order([{ id: 'biryani', qty: 1 }]);
  const first = await cancel(t.id);
  const afterFirst = await stock();
  const second = await cancel(t.id);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal((await json(second)).code, 'ALREADY_CANCELLED');
  assert.deepEqual(await stock(), afterFirst);
});

test('hub: an unknown order is a 404, not a quiet success', async () => {
  const res = await cancel('t_nope');
  assert.equal(res.status, 404);
  assert.equal((await json(res)).code, 'NOT_FOUND');
});

test('hub: a billed order cannot be cancelled; the bill is voided instead', async () => {
  const t = await order([{ id: 'tea', qty: 1 }], 2);
  assert.equal((await api('/tables/2/clear', { method: 'POST' })).status, 200);
  const res = await cancel(t.id);
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'TICKET_CLOSED');
  assert.match(body.error, /Void the bill/);
});

test('hub: a cancelled order is not on the bill', async () => {
  const keep = await order([{ id: 'tea', qty: 2 }]);
  const drop = await order([{ id: 'biryani', qty: 1 }]);
  await cancel(drop.id);
  const preview = await json(await api('/tables/1/invoice'));
  assert.deepEqual(preview.invoice.items.map(i => [i.name, i.qty]), [['Chai', 2]]);
  assert.equal(preview.invoice.grand_total > 0, true);
  await cancel(keep.id);
});

test('hub: a table with nothing left on it reads as free again', async () => {
  const t = await order([{ id: 'tea', qty: 1 }], 2);
  const busy = (await json(await api('/tables'))).tables.find(x => String(x.id) === '2');
  assert.notEqual(busy.status, 'available');
  await cancel(t.id);
  const free = (await json(await api('/tables'))).tables.find(x => String(x.id) === '2');
  assert.equal(free.status, 'available');
});

test('hub: the cancellation is queued for the cloud against the order\'s own request id', async () => {
  const t = await order([{ id: 'tea', qty: 1 }]);
  await cancel(t.id);
  // The queue is written to disk in the background, so look until it is there rather than after a fixed wait: on a busy machine
  // a fixed wait is a coin toss.
  const find = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'sync_queue.json'), 'utf8'))
        .find(q => q.type === 'UPDATE_STATUS' && q.payload.status === 'cancelled' && q.payload.requestId === t.order_request_id);
    } catch { return undefined; }   // caught mid-write
  };
  let item = find();
  for (let waited = 0; !item && waited < 5000; waited += 50) { await new Promise(r => setTimeout(r, 50)); item = find(); }
  assert.ok(item, 'a cancelled status for this order is waiting to go up');
  assert.equal(item.payload.restaurantId, RESTAURANT_ID);
});

test('hub: every screen is told, so the kitchen stops cooking it', async () => {
  const ws = new WebSocket(hub.base.replace(/^http/, 'ws') + '/live');
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const seen = new Promise(resolve => ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'TICKET_CANCELLED') resolve(m); }));
  const t = await order([{ id: 'tea', qty: 1 }]);
  await cancel(t.id);
  const msg = await Promise.race([seen, new Promise(r => setTimeout(() => r(null), 3000))]);
  ws.close();
  assert.ok(msg, 'TICKET_CANCELLED arrived');
  assert.deepEqual([msg.payload.ticket_id, msg.payload.table_name, msg.payload.ticket.status], [t.id, 'T1', 'cancelled']);
});

test('hub: a ticket from before stock was recorded on tickets cancels, and says nothing came back', async () => {
  const legacy = await startHub({
    trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'LEGACY',
    files: { 'tickets.json': [{ id: 't_old', ticket_number: 101, restaurant_id: RESTAURANT_ID, table_id: 1, table_name: 'T1', status: 'in_progress', items: [{ id: 'tea', name: 'Chai', qty: 1, price: 40 }], total_amount: 40, created_at: T0, updated_at: T0 }] }
  });
  try {
    const res = await call(legacy, '/orders/t_old/cancel', { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual([body.ticket.status, body.stock_returned], ['cancelled', false]);
  } finally { legacy.stop(); }
});

test('hub: a screen at the pass cannot withdraw an order; a handset can; nobody unenrolled can', async () => {
  const enrol = async scope => (await json(await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'CANCELREMOTE', device_label: scope, ...(scope === 'kitchen' ? { scope } : {}) } }))).device_token;
  const handset = await enrol('handset');
  const screen = await enrol('kitchen');
  const placed = await json(await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: 1, table_name: 'T1', items: [{ id: 'tea', qty: 1 }] } }));
  const id = placed.ticket.id;

  const refused = await cancel(id, {}, remote, screen);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'DEVICE_SCOPE');
  assert.equal((await cancel(id, {}, remote)).status, 401);
  assert.equal((await cancel(id, { reason: 'changed mind' }, remote, handset)).status, 200);
});

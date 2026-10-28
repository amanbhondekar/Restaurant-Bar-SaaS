import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { feedFor, connectedFor, kitchenTicket, TICKET_FIELDS, KITCHEN_EVENTS } from '../lib/liveFeed.js';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// What a kitchen screen is told. It needs the board -- tickets, courses, who is cooking what -- and has no use for
// what a table owes, what a dish costs, or whether a bill was voided. The feed used to send every event to every
// connection, so a screen enrolled with the narrow `kitchen` scope still heard every bill. These tests pin the rule
// (unit), then check it on a real hub with a kitchen socket and a handset socket side by side.

const TICKET = {
  id: 't_1', ticket_number: 7, table_id: 1, table_name: 'T1', status: 'in_progress', total_amount: 230, note: 'no onion',
  items: [{ id: 'm1', name: 'Dal', qty: 2, price: 115, station: 'hot', modifiers: [{ group_id: 'g', option_id: 'cheese', group_label: 'Extras', option_label: 'Cheese', price_delta: 15 }] }]
};

// --- the rule ------------------------------------------------------------------------------------------

test('a ticket is shown to a kitchen as what it needs to cook it: no total, no prices, and nothing that was not listed', () => {
  const t = kitchenTicket(TICKET);
  assert.equal(t.total_amount, undefined);
  assert.equal(t.items[0].price, undefined);
  assert.equal(t.items[0].modifiers[0].price_delta, undefined);
  assert.deepEqual([t.id, t.ticket_number, t.table_name, t.note, t.items[0].name, t.items[0].qty, t.items[0].station, t.items[0].modifiers[0].option_label, t.items[0].modifiers[0].group_label],
    ['t_1', 7, 'T1', 'no onion', 'Dal', 2, 'hot', 'Cheese', 'Extras']);
  assert.equal(TICKET.total_amount, 230, "the hub's own ticket is not touched");
  assert.equal(TICKET.items[0].price, 115);
});

test('a field nobody listed never reaches a kitchen, so one added to tickets later cannot leak by default', () => {
  const rich = {
    ...TICKET,
    restaurant_id: 'r-1', order_request_id: 'req-9', synced_to_cloud: false,
    stock_used: [{ inventory_item_id: 'rice', qty: 0.6 }],
    guest_phone: '919876543210', payment_ref: 'TXN42', discount_total: 20, customer_name: 'Asha K',
    items: [{ ...TICKET.items[0], cost: 31, margin: 0.4, internal_note: 'comp', recipe_id: 'r1' }]
  };
  const t = kitchenTicket(rich);
  for (const k of ['restaurant_id', 'order_request_id', 'synced_to_cloud', 'stock_used', 'guest_phone', 'payment_ref', 'discount_total', 'customer_name']) {
    assert.equal(k in t, false, k);
  }
  for (const k of ['cost', 'margin', 'internal_note', 'recipe_id']) assert.equal(k in t.items[0], false, k);
  assert.doesNotMatch(JSON.stringify(t), /9876543210|TXN42|Asha K|req-9/);
});

test('what a screen draws is kept: the course state, the cancellation, the waiter, the times and every line detail', () => {
  const full = {
    ...TICKET, status: 'cancelled', staged: true, fired_courses: [1, 2], course_log: { 1: { fired_at: 'x', stations_ready: { hot: 'y' }, ready_at: 'z' } },
    created_by_waiter: 'Asha', created_at: 'a', updated_at: 'b', cancelled_at: 'c', cancel_reason: 'guest left', cancel_cooked: false,
    items: [{ id: 'm1', name: 'Dal', qty: 2, station: 'hot', course: 2, variant_id: 'half', variant_label: 'Half', day_part_label: 'Lunch', modifiers: [] }]
  };
  const t = kitchenTicket(full);
  for (const k of ['status', 'staged', 'fired_courses', 'course_log', 'created_by_waiter', 'created_at', 'updated_at', 'cancelled_at', 'cancel_reason', 'cancel_cooked']) assert.deepEqual(t[k], full[k], k);
  assert.deepEqual(t.items[0], full.items[0]);
  assert.deepEqual(Object.keys(t).sort(), Object.keys(full).filter(k => TICKET_FIELDS.includes(k)).sort());
});

test('nothing, or something that is not a ticket, comes back as it was; items that are not a list are dropped', () => {
  assert.equal(kitchenTicket(null), null);
  assert.equal(kitchenTicket(undefined), undefined);
  assert.deepEqual(kitchenTicket({ id: 'x' }), { id: 'x' });
  assert.equal('items' in kitchenTicket({ id: 'x', items: 'nonsense' }), false);
  assert.deepEqual(kitchenTicket({ id: 'x', items: [null, 'str', { name: 'A', qty: 1, price: 5 }] }).items, [null, 'str', { name: 'A', qty: 1 }]);
});

test('a full-scope connection is sent everything, untouched', () => {
  const payload = { grand_total: 483, invoice_number: 'INV-000001', ticket: TICKET };
  const r = feedFor('full', 'INVOICE_ISSUED', payload);
  assert.deepEqual(r, { payload });
});

test('a kitchen connection is sent the board events with the money taken off, and only those', () => {
  for (const type of KITCHEN_EVENTS) {
    const r = feedFor('kitchen', type, { ticket_id: 't_1', table_name: 'T1', total_amount: 230, ticket: TICKET });
    assert.ok(r, `${type} reaches a kitchen screen`);
    assert.equal(r.payload.total_amount, undefined, `${type}: no total`);
    assert.equal(r.payload.ticket.items[0].price, undefined, `${type}: no prices in the ticket`);
    assert.equal(r.payload.ticket_id, 't_1');
  }
  assert.deepEqual([...KITCHEN_EVENTS].sort(), [
    'COURSE_FIRED', 'NEW_ORDER', 'STATION_READY', 'TICKET_CANCELLED', 'TICKET_READY', 'TICKET_RECALLED', 'TICKET_UPDATED',
    'bill_cleared', 'order_cleared', 'order_created', 'order_ready', 'CLEAR_TABLE'
  ].sort());
});

test('NEW_ORDER carries the ticket itself as its payload, and that is narrowed too', () => {
  const r = feedFor('kitchen', 'NEW_ORDER', { ...TICKET, stock_used: [{ qty: 1 }], restaurant_id: 'r-1' });
  assert.equal(r.payload.total_amount, undefined);
  assert.equal(r.payload.items[0].price, undefined);
  assert.equal(r.payload.items[0].name, 'Dal');
  assert.equal('stock_used' in r.payload, false);
  assert.equal('restaurant_id' in r.payload, false);
  // The board finds the ticket by its own id, number and table: a payload that lost them would be ignored as no ticket at all.
  assert.deepEqual([r.payload.id, r.payload.ticket_number, r.payload.table_name, r.payload.status], ['t_1', 7, 'T1', 'in_progress']);
});

test('a payload that has an id and lines AND a ticket inside is an event around a ticket, not a ticket', () => {
  const r = feedFor('kitchen', 'order_created', { id: 'evt', items: TICKET.items, ticket: TICKET, extra: 1 });
  assert.equal('id' in r.payload, false, 'event keys only');
  assert.equal(r.payload.ticket.id, 't_1');
  assert.equal('extra' in r.payload, false);
});

test('lines that are not a list are dropped from an event, not passed through', () => {
  const r = feedFor('kitchen', 'order_created', { ticket_id: 't_1', items: 'nonsense', ticket: { ...TICKET, items: 'nonsense' } });
  assert.equal('items' in r.payload, false);
  assert.equal('items' in r.payload.ticket, false);
});

test('the event around a ticket is narrowed as well: a key nobody listed does not get through', () => {
  const r = feedFor('kitchen', 'order_created', {
    order_id: 't_1', ticket_id: 't_1', ticket_number: 7, table_id: 1, table_name: 'T1', status: 'in_progress', created_at: 'a',
    items: TICKET.items, total_amount: 230, ticket: { ...TICKET, guest_phone: '919876543210' }, guest_phone: '919876543210', payment_ref: 'TXN42'
  });
  assert.deepEqual(Object.keys(r.payload).sort(), ['created_at', 'items', 'order_id', 'status', 'table_id', 'table_name', 'ticket', 'ticket_id', 'ticket_number'].sort());
  assert.equal('guest_phone' in r.payload.ticket, false);
  assert.equal(r.payload.items[0].price, undefined);
  assert.doesNotMatch(JSON.stringify(r), /9876543210|TXN42/);
  const fired = feedFor('kitchen', 'COURSE_FIRED', { ticket_id: 't_1', course: 2, station: 'hot', ticket: TICKET, secret: 'x' });
  assert.deepEqual(Object.keys(fired.payload).sort(), ['course', 'station', 'ticket', 'ticket_id']);
});

test('when a table is cleared the screen is told which, and not what it came to', () => {
  const r = feedFor('kitchen', 'CLEAR_TABLE', { table_id: 1, order_id: '1', cleared_count: 2, status: 'available', invoice_number: 'INV-000009', grand_total: 483 });
  assert.deepEqual(r.payload, { table_id: 1, order_id: '1', cleared_count: 2, status: 'available' });
});

test('bills, sync, stock, menu, feedback, cash-ups and pairing are not sent to a kitchen screen', () => {
  for (const type of ['INVOICE_ISSUED', 'INVOICE_PAID', 'INVOICE_VOIDED', 'INVOICE_REFUNDED', 'INVOICE_SPLIT', 'INVOICE_UNSPLIT', 'INVOICE_SPLIT_PAID',
    'RECONCILIATION_CLOSED', 'SYNC_STATUS_CHANGE', 'menu_updated', 'tables_updated', 'STOCK_CHANGED', 'FEEDBACK_RECEIVED', 'PAIRING_UPDATED']) {
    assert.equal(feedFor('kitchen', type, { grand_total: 1 }), null, type);
  }
});

test('an unknown scope, or an event nobody has heard of, gets nothing -- the feed is default-deny for a narrow connection', () => {
  assert.equal(feedFor('kitchen', 'SOMETHING_NEW', { total_amount: 5 }), null);
  assert.equal(feedFor(null, 'NEW_ORDER', TICKET), null);
  assert.equal(feedFor('garbage', 'NEW_ORDER', TICKET), null);
});

test('the greeting a kitchen screen gets on connecting has no menu prices, no sync detail and no table list', () => {
  const full = { pairing: { name: 'Kitchen', city: 'Nagpur' }, sync: { pending: 4 }, active_tickets_count: 3, menu: { items: [{ price: 100 }] }, tables_layout: { tables: [] } };
  assert.deepEqual(connectedFor('kitchen', full), { pairing: { name: 'Kitchen', city: 'Nagpur' }, active_tickets_count: 3 });
  assert.equal(connectedFor('full', full), full);
});

// --- a real hub --------------------------------------------------------------------------------------------

const FIXTURE = {
  menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [
    { id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true, station: 'hot' },
    { id: 'm2', name: 'Kheer', price: 80, category: 'M', isVeg: true, available: true, station: 'cold', course: 2 }
  ] },
  tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }, { id: 2, name: 'T2', section: 'M', capacity: 4 }] }
};
const json = r => r.json();
const enrolled = async (hub, scope) =>
  (await json(await call(hub, '/auth/device', { method: 'POST', body: { enrollment_code: 'FEEDCODE', device_label: 'x', ...(scope ? { scope } : {}) } }))).device_token;

let remote;
let handset;
let screen;
before(async () => {
  remote = await startHub({ trustLoopback: false, ...FIXTURE, enrollmentCode: 'FEEDCODE', config: { plan: 'enterprise' } });
  handset = await enrolled(remote);
  screen = await enrolled(remote, 'kitchen');
});
after(() => remote?.stop());

/** Opens the live feed and keeps every message it is sent. Resolves once the greeting has arrived. */
function listen(token, query = '') {
  const url = `${remote.base.replace(/^http/, 'ws')}/live?token=${token}${query}`;
  const ws = new WebSocket(url);
  const messages = [];
  const ready = new Promise((resolve, reject) => {
    ws.on('message', data => {
      const m = JSON.parse(data.toString());
      messages.push(m);
      if (m.type === 'CONNECTED') resolve();
    });
    ws.once('error', reject);
  });
  return { ws, messages, ready, types: () => messages.map(m => m.type) };
}
const settle = () => new Promise(r => setTimeout(r, 250));

test('hub: a kitchen screen is sent the board and not the bill; a handset on the same hub is sent both', async () => {
  const kitchen = listen(screen, '&station=hot');
  const waiter = listen(handset);
  await Promise.all([kitchen.ready, waiter.ready]);

  const order = await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 2 }], order_request_id: 'feed-1' } });
  assert.equal(order.status, 201);
  const ticket = (await json(order)).ticket;
  await call(remote, `/orders/${ticket.id}/stations/hot/ready`, { method: 'POST', token: screen });
  const cleared = await call(remote, '/tables/1/clear', { method: 'POST', token: handset });
  assert.equal((await json(cleared)).invoice.grand_total, 210);
  await settle();
  kitchen.ws.close(); waiter.ws.close();

  // The handset hears everything, bill included.
  assert.ok(waiter.types().includes('INVOICE_ISSUED'), 'a handset hears the bill');
  const billed = waiter.messages.find(m => m.type === 'CLEAR_TABLE');
  assert.equal(billed.payload.grand_total, 210);
  assert.equal(waiter.messages.find(m => m.type === 'NEW_ORDER').payload.total_amount, 200);

  // The kitchen screen hears the board...
  assert.ok(kitchen.types().includes('NEW_ORDER'));
  assert.ok(kitchen.types().includes('TICKET_READY'));
  assert.ok(kitchen.types().includes('CLEAR_TABLE'), 'it still learns a table was cleared, to take the tickets off the board');

  // ...and not one rupee of it.
  const heard = JSON.stringify(kitchen.messages);
  assert.equal(kitchen.types().some(t => t.startsWith('INVOICE_')), false);
  assert.equal(kitchen.types().includes('SYNC_STATUS_CHANGE'), false);
  assert.equal(/grand_total|invoice_number|total_amount|"price"|price_delta/.test(heard), false, `leaked money: ${heard.match(/.{20}(grand_total|invoice_number|total_amount|"price"|price_delta).{20}/)?.[0]}`);
  const greeting = kitchen.messages.find(m => m.type === 'CONNECTED').payload;
  assert.equal(greeting.menu, undefined);
  assert.equal(greeting.tables_layout, undefined);
  assert.equal(greeting.sync, undefined);
});

test('hub: what a kitchen screen reads over HTTP has no prices either, though it does have the lines to cook', async () => {
  const o = await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: 2, table_name: 'T2', items: [{ id: 'm1', qty: 3 }], order_request_id: 'feed-2' } });
  const ticketId = (await json(o)).ticket.id;

  const active = await json(await call(remote, '/orders/active', { token: screen }));
  const t = active.tickets.find(x => x.id === ticketId);
  assert.equal(t.items[0].name, 'Dal');
  assert.equal(t.items[0].qty, 3);
  assert.equal(t.total_amount, undefined);
  assert.equal(t.items[0].price, undefined);
  for (const k of ['restaurant_id', 'order_request_id', 'synced_to_cloud', 'stock_used']) assert.equal(k in t, false, `${k} reached a kitchen token`);

  const marked = await json(await call(remote, `/orders/${ticketId}/stations/hot/ready`, { method: 'POST', token: screen }));
  assert.equal(marked.ticket.total_amount, undefined);
  assert.equal(marked.ticket.items[0].price, undefined);

  const readied = await json(await call(remote, `/orders/${ticketId}/ready`, { method: 'POST', token: screen }));
  assert.equal(readied.ticket.total_amount, undefined);
  assert.equal(readied.ticket.items[0].price, undefined);

  const recalled = await json(await call(remote, `/orders/${ticketId}/recall`, { method: 'POST', token: screen }));
  assert.equal(recalled.ticket.items[0].price, undefined);

  // A handset still sees prices: the waiter's app shows what an order comes to.
  const asHandset = (await json(await call(remote, '/orders/active', { token: handset }))).tickets.find(x => x.id === ticketId);
  assert.equal(asHandset.total_amount, 300);
  assert.equal(asHandset.items[0].price, 100);
  assert.equal(asHandset.restaurant_id, RESTAURANT_ID, 'and the rest of the ticket');
});

test('hub: firing the next course answers a kitchen screen without prices too', async () => {
  const o = await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: 1, table_name: 'T1', course_service: true, items: [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }], order_request_id: 'feed-fire' } });
  const ticket = (await json(o)).ticket;
  const fired = await call(remote, `/orders/${ticket.id}/fire`, { method: 'POST', token: screen, body: {} });
  assert.equal(fired.status, 200, JSON.stringify(await fired.clone().json()));
  const body = await json(fired);
  assert.equal(body.ticket.items.length, 2);
  assert.equal(body.ticket.total_amount, undefined);
  assert.equal(body.ticket.items.some(i => i.price !== undefined), false);
});

test('hub: the reception laptop\'s own kitchen display still gets full tickets', async () => {
  const reception = await startHub({ trustLoopback: true, ...FIXTURE, enrollmentCode: 'FEEDREC' });
  try {
    await call(reception, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }], order_request_id: 'feed-3' } });
    const t = (await json(await call(reception, '/orders/active'))).tickets[0];
    assert.equal(t.total_amount, 100);
    assert.equal(t.items[0].price, 100);
  } finally {
    reception.stop();
  }
});

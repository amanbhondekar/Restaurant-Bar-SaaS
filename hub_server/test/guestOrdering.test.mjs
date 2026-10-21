import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';
import { validateGuestOrder, isCoolingDown, guestOrderReceipt, LIMITS } from '../lib/guestOrdering.js';

// A guest ordering from the code on their table (§4.5). This is the hub's second unauthenticated
// write and by far the more consequential, so most of what matters is what it REFUSES.

const RID = RESTAURANT_ID;
const TABLES = [
  { id: 1, name: 'T1', section: 'Main', capacity: 2 },
  { id: 2, name: 'T2', section: 'Main', capacity: 4 },
  // A table kept out of the happy-path tests, so the ones below are not answered by the cooldown
  // from an earlier order instead of the reason they are checking.
  { id: 3, name: 'T3', section: 'Main', capacity: 4 }
];

// --- what a guest's phone may send ----------------------------------------------------------------

test('an order must name a table that actually exists here', () => {
  const items = [{ id: 'm1', qty: 1 }];
  assert.equal(validateGuestOrder({ table: 'T1', items }, { tables: TABLES }).ok, true);
  assert.match(validateGuestOrder({ table: '', items }, { tables: TABLES }).errors[0].message, /Scan the code/);
  assert.match(validateGuestOrder({ table: 'T99', items }, { tables: TABLES }).errors[0].message, /not one of ours/);
  assert.equal(validateGuestOrder({ table: '1', items }, { tables: TABLES }).ok, true, 'the id works as well as the name');
});

test('only the fields the pricer needs are passed on -- nothing else a body carries', () => {
  const { order } = validateGuestOrder({
    table: 'T1',
    items: [{ id: 'm1', qty: 2, variant_id: 'v1', price: 1, name: 'Free lunch', station: 'bar', course: 9 }],
    note: 'No chilli'
  }, { tables: TABLES });

  assert.deepEqual(order.items, [{ id: 'm1', qty: 2, variant_id: 'v1' }]);
  assert.equal(order.note, 'No chilli');
  // A price, a name, a station or a course from outside must never reach the pricer: that is how a
  // field it gains later becomes settable by a stranger.
});

test('modifiers are reduced to the two ids the hub resolves itself', () => {
  const { order } = validateGuestOrder({
    table: 'T1',
    items: [{ id: 'm1', qty: 1, modifiers: [{ group_id: 'g1', option_id: 'o1', price_delta: -500, option_label: 'Free' }] }]
  }, { tables: TABLES });
  assert.deepEqual(order.items[0].modifiers, [{ group_id: 'g1', option_id: 'o1' }]);
});

test('an empty order, an absurd one, and a malformed line are all refused', () => {
  assert.match(validateGuestOrder({ table: 'T1', items: [] }, { tables: TABLES }).errors[0].message, /Nothing has been chosen/);
  const many = Array.from({ length: LIMITS.lines + 1 }, () => ({ id: 'm1', qty: 1 }));
  assert.match(validateGuestOrder({ table: 'T1', items: many }, { tables: TABLES }).errors[0].message, /more than 20 different dishes/);

  for (const bad of [{ id: '', qty: 1 }, { id: 'm1', qty: 0 }, { id: 'm1', qty: 999 }, { id: 'm1', qty: 'two' }, {}]) {
    assert.equal(validateGuestOrder({ table: 'T1', items: [bad] }, { tables: TABLES }).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateGuestOrder({ table: 'T1', items: 'nope' }, { tables: TABLES }).ok, false);
  assert.equal(validateGuestOrder(null, { tables: TABLES }).ok, false);
});

test('a note is bounded, because it is printed on a ticket in a kitchen', () => {
  const { order } = validateGuestOrder({ table: 'T1', items: [{ id: 'm1', qty: 1 }], note: 'x'.repeat(500) }, { tables: TABLES });
  assert.equal(order.note.length, LIMITS.note);
});

test('a table that has just ordered is cooling down, and one that has not is not', () => {
  const now = Date.now();
  assert.equal(isCoolingDown(new Date(now - 5000).toISOString(), now), true);
  assert.equal(isCoolingDown(new Date(now - 61000).toISOString(), now), false);
  assert.equal(isCoolingDown(null, now), false);
  assert.equal(isCoolingDown('not a time', now), false);
});

test('what a guest is told back is the ticket number and nothing else', () => {
  const receipt = guestOrderReceipt({ ticket_number: 142, total_amount: 1480, items: [{ name: 'Dal' }], table_name: 'T4' });
  assert.deepEqual(Object.keys(receipt).sort(), ['message', 'success', 'ticket_number']);
  // A guest who can read a total can read another table's by guessing, and the menu already tells
  // them the prices.
  assert.equal(JSON.stringify(receipt).includes('1480'), false);
});

// --- a real hub ---------------------------------------------------------------------------------

const MENU = {
  restaurant_id: RID,
  categories: ['Mains'],
  items: [
    { id: 'm1', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true },
    { id: 'm2', name: 'Paneer Tikka', price: 280, category: 'Mains', isVeg: true, available: true }
  ]
};
let hub;
before(async () => { hub = await startHub({ trustLoopback: true, menu: MENU, tables: { restaurant_id: RID, tables: TABLES } }); });
after(() => hub?.stop());

const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async res => res.json();
const setOrdering = on => call('/admin/guest-ordering', { method: 'PUT', body: { ordering: on } });

test('hub: guest ordering is OFF until the restaurant turns it on', async () => {
  const state = await json(await call('/public/ordering'));
  assert.equal(state.ordering, false, 'a kitchen must not start taking tickets because a hub updated');

  const refused = await call('/public/order', { method: 'POST', body: { table: 'T1', items: [{ id: 'm1', qty: 1 }] } });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'ORDERING_OFF');
});

test('hub: once on, a guest order reaches the kitchen as a ticket', async () => {
  assert.equal((await setOrdering(true)).status, 200);
  assert.equal((await json(await call('/public/ordering'))).ordering, true);

  const res = await call('/public/order', { method: 'POST', body: { table: 'T1', items: [{ id: 'm1', qty: 2 }], note: 'No chilli' } });
  assert.equal(res.status, 201);
  const receipt = await json(res);
  assert.ok(receipt.ticket_number);
  assert.equal(receipt.message, 'Sent to the kitchen.');

  const active = await json(await call('/orders/active'));
  const ticket = active.tickets.find(t => t.ticket_number === receipt.ticket_number);
  assert.ok(ticket, 'it is on the kitchen board');
  assert.equal(ticket.table_name, 'T1');
  assert.equal(ticket.created_by_waiter, 'Guest (QR)', 'the kitchen can see it came from a phone');
  assert.equal(ticket.note, 'No chilli');
  assert.equal(ticket.total_amount, 440, 'priced by the hub');
});

test('hub: a price sent by a guest is ignored -- the hub prices it', async () => {
  await setOrdering(true);
  await new Promise(r => setTimeout(r, 0));
  const res = await call('/public/order', { method: 'POST', body: { table: 'T2', items: [{ id: 'm2', qty: 1, price: 1, name: 'Free' }] } });
  assert.equal(res.status, 201);
  const { ticket_number } = await json(res);

  const active = await json(await call('/orders/active'));
  const ticket = active.tickets.find(t => t.ticket_number === ticket_number);
  assert.equal(ticket.total_amount, 280, 'the menu price, not the one that was sent');
  assert.equal(ticket.items[0].name, 'Paneer Tikka', 'and the menu name');
});

test('hub: the same table cannot order again straight away', async () => {
  await setOrdering(true);
  const again = await call('/public/order', { method: 'POST', body: { table: 'T2', items: [{ id: 'm1', qty: 1 }] } });
  assert.equal(again.status, 429);
  assert.equal((await json(again)).code, 'TOO_SOON');
});

test('hub: a table that is not ours, and a dish that is not on the menu, are both refused', async () => {
  await setOrdering(true);
  const noTable = await call('/public/order', { method: 'POST', body: { table: 'T99', items: [{ id: 'm1', qty: 1 }] } });
  assert.equal(noTable.status, 400);
  assert.equal((await json(noTable)).code, 'INVALID_ORDER');

  const noDish = await call('/public/order', { method: 'POST', body: { table: 'T3', items: [{ id: 'ghost', qty: 1 }] } });
  assert.equal(noDish.status, 400);
  assert.match((await json(noDish)).error, /no longer available/);
});

test('hub: turning it off again stops orders at once', async () => {
  assert.equal((await setOrdering(false)).status, 200);
  const refused = await call('/public/order', { method: 'POST', body: { table: 'T3', items: [{ id: 'm1', qty: 1 }] } });
  assert.equal(refused.status, 403);
});

test('hub: only reception may switch guest ordering on', async () => {
  const remote = await startHub({ trustLoopback: false, menu: MENU, tables: { restaurant_id: RID, tables: TABLES }, enrollmentCode: 'GUESTONE' });
  try {
    const enrolled = await (await fetch(`${remote.base}/auth/device`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment_code: 'GUESTONE', device_label: 'Handset' })
    })).json();

    for (const token of [undefined, enrolled.device_token]) {
      const res = await fetch(`${remote.base}/admin/guest-ordering`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ordering: true })
      });
      assert.ok([401, 403].includes(res.status), `status ${res.status}`);
    }
    // And a guest cannot turn it on for themselves.
    assert.equal((await json(await fetch(`${remote.base}/public/ordering`))).ordering, false);
  } finally {
    remote.stop();
  }
});

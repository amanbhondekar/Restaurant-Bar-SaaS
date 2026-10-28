import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Who may touch a bill. A waiter's handset takes orders and closes a table into a bill; reopening, voiding,
// refunding, settling and splitting that bill is the reception laptop's job, and a discount or a service-charge
// override is a money decision too. Before this, any enrolled handset could do all of it with its ordinary token.

const MENU = {
  restaurant_id: RESTAURANT_ID, categories: ['Mains'],
  items: [{ id: 'dal', name: 'Dal', price: 200, category: 'Mains', isVeg: true, available: true, station: 'hot' }]
};
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ id, name: `T${id}`, section: 'Main', capacity: 4 })) };

let reception;   // trusts loopback: acts as the reception laptop
let remote;      // does not: everything is a handset that must present a token
let handset;
before(async () => {
  reception = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'MONEYREC', config: { plan: 'enterprise' } });
  remote = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'MONEYREM', config: { plan: 'enterprise' } });
  const res = await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'MONEYREM', device_label: 'Waiter 1' } });
  handset = (await res.json()).device_token;
  assert.ok(handset, 'the handset enrolled');
});
after(() => { reception?.stop(); remote?.stop(); });

const json = r => r.json();
let nextTable = 0;

/** Seats a table with one order and closes it into a bill, the way a waiter does: no adjustments. */
async function bill(hub, token) {
  const table = ++nextTable;
  const o = await call(hub, '/orders', { method: 'POST', token, body: { table_id: table, table_name: `T${table}`, items: [{ id: 'dal', qty: 1 }], order_request_id: `req-${Math.random()}` } });
  assert.equal(o.status, 201, JSON.stringify(await o.clone().json()));
  const cleared = await call(hub, `/tables/${table}/clear`, { method: 'POST', token });
  assert.equal(cleared.status, 200, JSON.stringify(await cleared.clone().json()));
  return { table, invoice: (await json(cleared)).invoice };
}
const invoiceOf = async (hub, id, token) => (await json(await call(hub, `/invoices/${id}`, { token }))).invoice;

const refused = async res => {
  const body = await json(res);
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.code, 'RECEPTION_ONLY');
  assert.match(body.error, /reception laptop/);
};

// --- a handset can still do its own job ----------------------------------------------------------

test('a handset can still close a table into a bill and read it', async () => {
  const { invoice } = await bill(remote, handset);
  assert.equal(invoice.grand_total, 210, '200 plus the default 5% tax');
  assert.equal((await invoiceOf(remote, invoice.id, handset)).id, invoice.id);
});

// --- ...but not settle, void, refund or split it -------------------------------------------------

test('a handset cannot void a bill, and the bill is left exactly as it was', async () => {
  const { invoice } = await bill(remote, handset);
  await refused(await call(remote, `/invoices/${invoice.id}/void`, { method: 'POST', token: handset, body: { reason: 'mistake' } }));
  const after = await invoiceOf(remote, invoice.id, handset);
  assert.equal(after.payment_status, 'pending');
  assert.equal(after.voided_at ?? null, null);
});

test('a handset cannot mark a bill paid', async () => {
  const { invoice } = await bill(remote, handset);
  await refused(await call(remote, `/invoices/${invoice.id}/mark-paid`, { method: 'POST', token: handset, body: { payment_method: 'cash' } }));
  assert.equal((await invoiceOf(remote, invoice.id, handset)).payment_status, 'pending');
});

test('a handset cannot refund a bill', async () => {
  const { invoice } = await bill(remote, handset);
  await refused(await call(remote, `/invoices/${invoice.id}/refund`, { method: 'POST', token: handset, body: { reason: 'x' } }));
});

for (const [name, path, body] of [
  ['split by seats', 'split-by-seats', { count: 2 }],
  ['split by items', 'split-by-items', { splits: [{ items: [] }] }],
  ['split by amounts', 'split-by-amounts', { splits: [{ share_amount: 100 }, { share_amount: 110 }] }]
]) {
  test(`a handset cannot ${name}`, async () => {
    const { invoice } = await bill(remote, handset);
    await refused(await call(remote, `/invoices/${invoice.id}/${path}`, { method: 'POST', token: handset, body }));
    assert.equal((await invoiceOf(remote, invoice.id, handset)).splits ?? null, null, 'nothing was split');
  });
}

test('a handset cannot undo a split or settle one share', async () => {
  const { invoice } = await bill(remote, handset);
  await refused(await call(remote, `/invoices/${invoice.id}/splits`, { method: 'DELETE', token: handset }));
  await refused(await call(remote, `/invoices/${invoice.id}/splits/0/mark-paid`, { method: 'POST', token: handset, body: { payment_method: 'cash' } }));
});

test('an unknown bill is still refused as reception-only for a handset: it learns nothing about which ids exist', async () => {
  await refused(await call(remote, '/invoices/inv_nope/void', { method: 'POST', token: handset, body: {} }));
});

// --- a discount is a money decision too ------------------------------------------------------------

test('a handset cannot close a table with a discount, and the table is NOT closed by the attempt', async () => {
  const table = ++nextTable;
  await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: table, table_name: `T${table}`, items: [{ id: 'dal', qty: 1 }], order_request_id: `req-${Math.random()}` } });
  await refused(await call(remote, `/tables/${table}/clear`, { method: 'POST', token: handset, body: { discounts: [{ type: 'percent', value: 100, reason: 'friend' }] } }));
  const active = (await json(await call(remote, '/orders/active', { token: handset }))).tickets;
  assert.ok(active.some(t => t.table_id === table), 'the order is still on the board');
  const cleared = await call(remote, `/tables/${table}/clear`, { method: 'POST', token: handset });
  assert.equal((await json(cleared)).invoice.grand_total, 210, 'and a plain close still bills the full amount');
});

test('a handset cannot override the service charge either, not even to the same number', async () => {
  const table = ++nextTable;
  await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: table, table_name: `T${table}`, items: [{ id: 'dal', qty: 1 }], order_request_id: `req-${Math.random()}` } });
  await refused(await call(remote, `/tables/${table}/clear`, { method: 'POST', token: handset, body: { service_charge_percent: 0 } }));
  await refused(await call(remote, `/tables/${table}/clear`, { method: 'POST', token: handset, body: { service_charge_percent: 5 } }));
});

test('an empty list of discounts is not a discount: a handset sending one is let through', async () => {
  const table = ++nextTable;
  await call(remote, '/orders', { method: 'POST', token: handset, body: { table_id: table, table_name: `T${table}`, items: [{ id: 'dal', qty: 1 }], order_request_id: `req-${Math.random()}` } });
  const res = await call(remote, `/tables/${table}/clear`, { method: 'POST', token: handset, body: { discounts: [] } });
  assert.equal(res.status, 200);
});

// --- the reception laptop is unchanged ---------------------------------------------------------------

test('reception can close a table with a discount and a service-charge override', async () => {
  const table = ++nextTable;
  await call(reception, '/orders', { method: 'POST', body: { table_id: table, table_name: `T${table}`, items: [{ id: 'dal', qty: 1 }], order_request_id: `req-${Math.random()}` } });
  const res = await call(reception, `/tables/${table}/clear`, { method: 'POST', body: { discounts: [{ type: 'percent', value: 10, reason: 'regular' }], service_charge_percent: 0 } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const inv = (await json(res)).invoice;
  assert.equal(inv.discount_total, 20);
  assert.equal(inv.service_charge_amount, 0);
});

test('reception can settle, split, undo, void and refund', async () => {
  const a = (await bill(reception)).invoice;
  assert.equal((await call(reception, `/invoices/${a.id}/split-by-seats`, { method: 'POST', body: { count: 2 } })).status, 200);
  assert.equal((await call(reception, `/invoices/${a.id}/splits/0/mark-paid`, { method: 'POST', body: { payment_method: 'cash' } })).status, 200);
  assert.equal((await call(reception, `/invoices/${a.id}/splits/1/mark-paid`, { method: 'POST', body: { payment_method: 'upi' } })).status, 200);
  assert.equal((await call(reception, `/invoices/${a.id}/refund`, { method: 'POST', body: { reason: 'wrong order' } })).status, 200);

  const b = (await bill(reception)).invoice;
  assert.equal((await call(reception, `/invoices/${b.id}/split-by-seats`, { method: 'POST', body: { count: 2 } })).status, 200);
  assert.equal((await call(reception, `/invoices/${b.id}/splits`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(reception, `/invoices/${b.id}/mark-paid`, { method: 'POST', body: { payment_method: 'cash' } })).status, 200);

  const c = (await bill(reception)).invoice;
  assert.equal((await call(reception, `/invoices/${c.id}/void`, { method: 'POST', body: { reason: 'mistake' } })).status, 200);
});

test('reception can still split by amounts', async () => {
  const a = (await bill(reception)).invoice;
  const res = await call(reception, `/invoices/${a.id}/split-by-amounts`, { method: 'POST', body: { splits: [{ share_amount: 100 }, { share_amount: 110 }] } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
});

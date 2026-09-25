/**
 * Hub server security & billing-integrity regression suite.
 *
 * Run with: npm test
 *
 * Each of these tests corresponds to a vulnerability that was live in the hub:
 * unauthenticated order entry, unauthenticated bill clearing, unauthenticated
 * revenue disclosure, wildcard CORS, and client-controlled pricing. They exist so
 * those cannot silently come back.
 *
 * The suite boots a real hub against a throwaway data directory -- it never
 * touches hub_server/data.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const ENROLLMENT_CODE = 'TESTCODE';
const RESTAURANT_ID = '11111111-1111-1111-1111-111111111111';

let child;
let dataDir;
let token;

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Starters'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    { id: 'm2', name: 'Chicken Sukka', price: 220, category: 'Starters', isVeg: false, available: true },
    { id: 'm3', name: 'Sold Out Dish', price: 100, category: 'Starters', isVeg: true, available: false },
    // m4/m5 exist so item-split tests can exercise the three-way case with
    // three distinct prices for a rounding-remainder scenario.
    { id: 'm4', name: 'Mutton Saoji', price: 340, category: 'Starters', isVeg: false, available: true }
  ]
};

const TABLES = {
  restaurant_id: RESTAURANT_ID,
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }
  ]
};

function api(pathname, { auth = false, ...opts } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${pathname}`, { ...opts, headers });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  fs.writeFileSync(path.join(dataDir, 'menu_cache.json'), JSON.stringify(MENU));
  fs.writeFileSync(path.join(dataDir, 'tables_cache.json'), JSON.stringify(TABLES));
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'sync_queue.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
    paired: true,
    restaurant_id: RESTAURANT_ID,
    name: 'Test Kitchen',
    pairing_code: 'TST-0001',
    city: 'Nagpur',
    enrollment_code: ENROLLMENT_CODE,
    devices: []
  }));

  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HUB_DATA_DIR: dataDir,
      // Act as a remote handset rather than the trusted local KDS.
      HUB_TRUST_LOOPBACK: 'false',
      SUPABASE_URL: 'https://example.supabase.co'
    },
    stdio: 'ignore'
  });

  // Wait for the port to accept connections.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fetch(`${BASE}/pairing-info`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('hub server did not start');
      await new Promise(r => setTimeout(r, 200));
    }
  }
});

after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// C2 — device authentication
// ---------------------------------------------------------------------------

test('C2: unauthenticated order entry is refused', async () => {
  const res = await api('/orders', {
    method: 'POST',
    body: JSON.stringify({ table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] })
  });
  assert.equal(res.status, 401);
});

test('C2: unauthenticated bill clearing is refused', async () => {
  const res = await api('/tables/1/clear', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('C2: unauthenticated revenue disclosure is refused', async () => {
  const res = await api('/dashboard-data');
  assert.equal(res.status, 401);
});

test('C2: /pairing-info stays public but leaks no credentials', async () => {
  const res = await api('/pairing-info');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'Test Kitchen');
  assert.equal(body.enrollment_code, undefined, 'enrollment code must not be served over the LAN');
  assert.equal(body.pairing_code, undefined, 'pairing code must not be served over the LAN');
  assert.equal(body.devices, undefined, 'device tokens must not be served over the LAN');
});

test('C2: a wrong enrollment code is refused', async () => {
  const res = await api('/auth/device', {
    method: 'POST',
    body: JSON.stringify({ enrollment_code: 'WRONGCODE' })
  });
  assert.equal(res.status, 401);
});

test('C2: the correct enrollment code issues a working token', async () => {
  const res = await api('/auth/device', {
    method: 'POST',
    body: JSON.stringify({ enrollment_code: ENROLLMENT_CODE, device_label: 'Test handset' })
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(body.device_token, 'expected a device token');
  token = body.device_token;

  const authed = await api('/dashboard-data', { auth: true });
  assert.equal(authed.status, 200, 'token should unlock protected endpoints');
});

test('C2: CORS does not allow arbitrary web origins', async () => {
  const res = await api('/pairing-info', { headers: { Origin: 'https://evil.example' } });
  assert.notEqual(
    res.headers.get('access-control-allow-origin'),
    '*',
    'wildcard CORS lets any website drive the POS'
  );
  assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example');
});

// ---------------------------------------------------------------------------
// C3 — billing integrity
// ---------------------------------------------------------------------------

test('C3: client-supplied prices are ignored in favour of the hub menu', async () => {
  const res = await api('/orders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      table_id: 1,
      table_name: 'T1',
      items: [{ id: 'm1', name: 'Free Lunch', qty: 2, price: 0.01 }]
    })
  });

  assert.equal(res.status, 201);
  const { ticket } = await res.json();

  assert.equal(ticket.items[0].price, 230, 'price must come from the hub menu');
  assert.equal(ticket.items[0].name, 'Paneer Tikka', 'name must come from the hub menu');
  assert.equal(ticket.total_amount, 460, 'total must be recomputed server-side');
});

test('C3: items that are not on the menu are rejected', async () => {
  const res = await api('/orders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      table_id: 1,
      table_name: 'T1',
      items: [{ id: 'not-a-real-item', name: 'Injected', qty: 1, price: 5 }]
    })
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_ITEMS');
});

test('C3: unavailable items are rejected', async () => {
  const res = await api('/orders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ table_id: 1, table_name: 'T1', items: [{ id: 'm3', qty: 1 }] })
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.details[0].reason, 'ITEM_UNAVAILABLE');
});

test('C3: invalid quantities are rejected', async () => {
  for (const qty of [0, -5, 1000, 'abc']) {
    const res = await api('/orders', {
      auth: true,
      method: 'POST',
      body: JSON.stringify({ table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty }] })
    });
    assert.equal(res.status, 400, `qty ${qty} should be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Regression — the happy path still works end to end
// ---------------------------------------------------------------------------

test('order -> ready -> clear still works for an enrolled device', async () => {
  const created = await api('/orders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ table_id: 2, table_name: 'T2', items: [{ id: 'm2', qty: 3 }] })
  });
  assert.equal(created.status, 201);
  const { ticket } = await created.json();
  assert.equal(ticket.total_amount, 660);

  const ready = await api(`/orders/${ticket.id}/ready`, { auth: true, method: 'POST' });
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ticket.status, 'ready');

  const cleared = await api('/tables/2/clear', { auth: true, method: 'POST' });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).cleared_count, 1);
});

test('idempotency still returns the original ticket for a repeated request id', async () => {
  const payload = JSON.stringify({
    order_request_id: 'req_fixed_for_test',
    table_id: 1,
    table_name: 'T1',
    items: [{ id: 'm1', qty: 1 }]
  });

  const first = await api('/orders', { auth: true, method: 'POST', body: payload });
  const second = await api('/orders', { auth: true, method: 'POST', body: payload });

  const a = await first.json();
  const b = await second.json();

  assert.equal(b.duplicate, true);
  assert.equal(b.ticket.ticket_number, a.ticket.ticket_number);
});

// ---------------------------------------------------------------------------
// M1 — billing foundation
// ---------------------------------------------------------------------------

async function createOrder(tableId, items, opts = {}) {
  return api('/orders', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      order_request_id: opts.reqId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      table_id: tableId,
      table_name: `T${tableId}`,
      items
    })
  });
}

test('M1: /tables/:id/invoice requires auth', async () => {
  const res = await api('/tables/9/invoice');
  assert.equal(res.status, 401);
});

test('M1: /invoices/:id requires auth', async () => {
  const res = await api('/invoices/inv_anything');
  assert.equal(res.status, 401);
});

test('M1: invoice preview 404s when the table has no open tickets', async () => {
  const res = await api('/tables/9/invoice', { auth: true });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'NO_OPEN_TICKETS');
});

test('M1: invoice preview folds every open ticket for the table into one bill with default 5% GST', async () => {
  // T3 gets two separate tickets — the bill must cover both.
  const t1 = await createOrder(3, [{ id: 'm1', qty: 2 }]); // Paneer Tikka 230 x 2 = 460
  const t2 = await createOrder(3, [{ id: 'm2', qty: 1 }]); // Chicken Sukka 220 x 1 = 220
  assert.equal(t1.status, 201);
  assert.equal(t2.status, 201);

  const res = await api('/tables/3/invoice', { auth: true });
  assert.equal(res.status, 200);
  const { invoice } = await res.json();

  assert.equal(invoice.items.length, 2, 'both tickets should contribute lines');
  assert.equal(invoice.subtotal, 680, 'subtotal must equal 460 + 220');

  // Default rules are CGST 2.5% + SGST 2.5% on the whole subtotal.
  const cgst = invoice.tax_rows.find(r => r.label === 'CGST');
  const sgst = invoice.tax_rows.find(r => r.label === 'SGST');
  assert.ok(cgst && sgst, 'both default tax rows must be present');
  assert.equal(cgst.amount, 17, 'CGST 2.5% of 680');
  assert.equal(sgst.amount, 17, 'SGST 2.5% of 680');
  assert.equal(invoice.tax_total, 34);
  assert.equal(invoice.grand_total, 714, '680 subtotal + 34 tax, rupee-rounded');
});

test('M1: closing the bill issues an invoice number, persists it, and returns it', async () => {
  const preview = await api('/tables/3/invoice', { auth: true });
  const previewInvoice = (await preview.json()).invoice;

  const cleared = await api('/tables/3/clear', { auth: true, method: 'POST' });
  assert.equal(cleared.status, 200);
  const body = await cleared.json();
  assert.equal(body.cleared_count, 2);
  assert.ok(body.invoice, 'clear response should carry the issued invoice');
  assert.match(body.invoice.invoice_number, /^INV-\d{6}$/, 'invoice number must be tenant-sequential');
  assert.equal(body.invoice.grand_total, previewInvoice.grand_total, 'issued total must match the preview');

  // Retrieval by both id and invoice_number
  const byId = await api(`/invoices/${body.invoice.id}`, { auth: true });
  assert.equal(byId.status, 200);
  const byNumber = await api(`/invoices/${body.invoice.invoice_number}`, { auth: true });
  assert.equal(byNumber.status, 200);
});

test('M1: a network-retry double-close does not double-charge', async () => {
  await createOrder(1, [{ id: 'm1', qty: 1 }]); // 230 + 5% = 242
  const first = await api('/tables/1/clear', { auth: true, method: 'POST' });
  const firstBody = await first.json();
  assert.ok(firstBody.invoice);

  // Second clear with the tickets already completed must not issue another invoice
  const second = await api('/tables/1/clear', { auth: true, method: 'POST' });
  const secondBody = await second.json();
  assert.equal(secondBody.cleared_count, 0);
  assert.equal(secondBody.invoice, null, 'no open tickets remain, so no new invoice');
});

// ---------------------------------------------------------------------------
// M1 — bill-level discounts + service charge
// ---------------------------------------------------------------------------

test('M1: flat bill discount is subtracted before tax', async () => {
  // 460 subtotal (m1×2), ₹60 flat off => 400 taxable, 5% GST = 20 => 420
  await createOrder(4, [{ id: 'm1', qty: 2 }]);
  const res = await api('/tables/4/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ discounts: [{ type: 'flat', value: 60, reason: 'Loyalty' }] })
  });
  assert.equal(res.status, 200);
  const { invoice } = await res.json();

  assert.equal(invoice.subtotal, 460);
  assert.equal(invoice.discount_total, 60);
  assert.equal(invoice.subtotal_after_discount, 400);
  assert.equal(invoice.tax_total, 20, '5% GST on 400');
  assert.equal(invoice.grand_total, 420);
  assert.equal(invoice.discount_rows[0].reason, 'Loyalty');
});

test('M1: percent bill discount is subtracted before tax', async () => {
  // 440 subtotal (m2×2), 10% off => 44 discount => 396 taxable, 5% = 19.8 => 416
  await createOrder(5, [{ id: 'm2', qty: 2 }]);
  const res = await api('/tables/5/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ discounts: [{ type: 'percent', value: 10 }] })
  });
  assert.equal(res.status, 200);
  const { invoice } = await res.json();

  assert.equal(invoice.subtotal, 440);
  assert.equal(invoice.discount_total, 44);
  assert.equal(invoice.subtotal_after_discount, 396);
  assert.equal(invoice.grand_total, 416);
});

test('M1: service charge is added before tax and both are tenant-configurable per bill', async () => {
  // 230 subtotal (m1×1), 10% service = 23 => 253 taxable, 5% GST = 12.65 => 266
  await createOrder(6, [{ id: 'm1', qty: 1 }]);
  const res = await api('/tables/6/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ service_charge_percent: 10 })
  });
  assert.equal(res.status, 200);
  const { invoice } = await res.json();

  assert.equal(invoice.subtotal, 230);
  assert.equal(invoice.discount_total, 0);
  assert.equal(invoice.service_charge_percent, 10);
  assert.equal(invoice.service_charge_amount, 23);
  assert.equal(invoice.taxable_base, 253);
  assert.equal(invoice.grand_total, 266);
});

test('M1: discount + service charge compose in the right order', async () => {
  // 460 subtotal, 10% off (46) => 414, +5% service (20.7) => 434.7 taxable,
  // 5% GST = 21.74 (rounded to 21.74 by 2dp = 21.74; grand rupee-rounded)
  await createOrder(7, [{ id: 'm1', qty: 2 }]);
  const res = await api('/tables/7/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      discounts: [{ type: 'percent', value: 10 }],
      service_charge_percent: 5
    })
  });
  assert.equal(res.status, 200);
  const { invoice } = await res.json();

  assert.equal(invoice.subtotal, 460);
  assert.equal(invoice.discount_total, 46);
  assert.equal(invoice.subtotal_after_discount, 414);
  assert.equal(invoice.service_charge_amount, 20.7);
  assert.equal(invoice.taxable_base, 434.7);
  // CGST 2.5% of 434.7 = 10.87, SGST 2.5% = 10.87 => 21.74; grand = 434.7 + 21.74 = 456.44 => 456
  assert.equal(invoice.tax_total, 21.74);
  assert.equal(invoice.grand_total, 456);
});

test('M1: adjustments carry through to the persisted invoice', async () => {
  await createOrder(8, [{ id: 'm1', qty: 2 }]);
  const cleared = await api('/tables/8/clear', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({
      discounts: [{ type: 'flat', value: 60, reason: 'Loyalty' }],
      service_charge_percent: 5
    })
  });
  assert.equal(cleared.status, 200);
  const { invoice } = await cleared.json();

  assert.ok(invoice.invoice_number);
  assert.equal(invoice.discount_total, 60);
  assert.equal(invoice.service_charge_percent, 5);
  assert.equal(invoice.service_charge_amount, 20);
  assert.equal(invoice.taxable_base, 420);
  assert.equal(invoice.grand_total, 441);

  const retrieved = await api(`/invoices/${invoice.invoice_number}`, { auth: true });
  const body = await retrieved.json();
  assert.equal(body.invoice.discount_rows[0].reason, 'Loyalty');
  assert.equal(body.invoice.grand_total, 441);
});

test('M1: discount larger than subtotal is refused', async () => {
  await createOrder(9, [{ id: 'm1', qty: 1 }]); // 230
  const res = await api('/tables/9/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ discounts: [{ type: 'flat', value: 500 }] })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_ADJUSTMENTS');
});

test('M1: negative discount is refused', async () => {
  await createOrder(10, [{ id: 'm1', qty: 1 }]);
  const res = await api('/tables/10/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ discounts: [{ type: 'flat', value: -10 }] })
  });
  assert.equal(res.status, 400);
});

test('M1: percent discount over 100 is refused', async () => {
  await createOrder(11, [{ id: 'm1', qty: 1 }]);
  const res = await api('/tables/11/invoice/preview', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ discounts: [{ type: 'percent', value: 150 }] })
  });
  assert.equal(res.status, 400);
});

test('M1: invalid adjustments on /clear refuse the close (tickets stay open)', async () => {
  await createOrder(12, [{ id: 'm1', qty: 1 }]);
  const bad = await api('/tables/12/clear', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ service_charge_percent: 50 }) // over the 25% cap
  });
  assert.equal(bad.status, 400);

  // Tickets must remain openable, so a successful retry produces an invoice.
  const good = await api('/tables/12/clear', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.ok(body.invoice, 'close after fixing adjustments must issue an invoice');
});

// ---------------------------------------------------------------------------
// M1 — invoice lifecycle: void + mark-paid
// ---------------------------------------------------------------------------

async function closeTable(tableId) {
  const res = await api(`/tables/${tableId}/clear`, {
    auth: true, method: 'POST', body: JSON.stringify({})
  });
  const body = await res.json();
  return { res, body, invoice: body.invoice };
}

test('M1: void requires auth', async () => {
  const res = await api('/invoices/inv_anything/void', {
    method: 'POST',
    body: JSON.stringify({ reason: 'x' })
  });
  assert.equal(res.status, 401);
});

test('M1: void of an unknown invoice returns 404', async () => {
  const res = await api('/invoices/inv_does_not_exist/void', {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'x' })
  });
  assert.equal(res.status, 404);
});

test('M1: void without a reason is refused', async () => {
  await createOrder(20, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(20);
  const res = await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'REASON_REQUIRED');
});

test('M1: voiding an invoice reopens the underlying tickets', async () => {
  await createOrder(21, [{ id: 'm1', qty: 2 }]); // 460
  const { invoice } = await closeTable(21);
  assert.equal(invoice.grand_total, 483);

  // Post-close: no active tickets on T21.
  const preview1 = await api('/tables/21/invoice', { auth: true });
  assert.equal(preview1.status, 404);

  const voided = await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'Wrong table' })
  });
  assert.equal(voided.status, 200);
  const voidBody = await voided.json();
  assert.equal(voidBody.invoice.payment_status, 'voided');
  assert.equal(voidBody.invoice.voided_reason, 'Wrong table');
  assert.equal(voidBody.reopened_ticket_ids.length, 1);

  // Post-void: the table has an active bill again with the same total.
  const preview2 = await api('/tables/21/invoice', { auth: true });
  assert.equal(preview2.status, 200);
  const preview2Body = await preview2.json();
  assert.equal(preview2Body.invoice.grand_total, invoice.grand_total);
});

test('M1: double-void is refused', async () => {
  await createOrder(22, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(22);
  await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'Wrong table' })
  });
  const second = await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'again' })
  });
  assert.equal(second.status, 400);
  const body = await second.json();
  assert.equal(body.code, 'ALREADY_VOIDED');
});

test('M1: mark-paid records method and transitions payment_status', async () => {
  await createOrder(23, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(23);
  assert.equal(invoice.payment_status, 'pending');

  const paid = await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  assert.equal(paid.status, 200);
  const body = await paid.json();
  assert.equal(body.invoice.payment_status, 'paid');
  assert.equal(body.invoice.payment_method, 'upi');
  assert.ok(body.invoice.paid_at);
});

test('M1: mark-paid rejects an unknown method', async () => {
  await createOrder(24, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(24);
  const res = await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'crypto' })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_METHOD');
});

test('M1: voiding a paid invoice is refused (must be refunded instead)', async () => {
  await createOrder(25, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(25);
  await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  const res = await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'oops' })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'ALREADY_PAID');
});

test('M1: mark-paid on a voided invoice is refused', async () => {
  await createOrder(26, [{ id: 'm1', qty: 1 }]);
  const { invoice } = await closeTable(26);
  await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'x' })
  });
  const res = await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'ALREADY_VOIDED');
});

// ---------------------------------------------------------------------------
// M1 — split-bill by seats
// ---------------------------------------------------------------------------

async function issueInvoiceForTable(tableId, items = [{ id: 'm1', qty: 1 }]) {
  await createOrder(tableId, items);
  const { invoice } = await closeTable(tableId);
  return invoice;
}

test('M1: split-by-seats requires auth', async () => {
  const res = await api('/invoices/inv_x/split-by-seats', {
    method: 'POST', body: JSON.stringify({ count: 2 })
  });
  assert.equal(res.status, 401);
});

test('M1: split divides grand_total exactly across N seats (rupee-fair)', async () => {
  // 460 subtotal + 5% GST = 483 grand. Split 4 ways: 483 / 4 = 120.75 →
  // shares must be integers summing to 483. Rupee-fair: three seats @ 121, one @ 120.
  const invoice = await issueInvoiceForTable(30, [{ id: 'm1', qty: 2 }]);
  assert.equal(invoice.grand_total, 483);

  const res = await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 4 })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.splits.length, 4);
  const shares = body.invoice.splits.map(s => s.share_amount);
  assert.equal(shares.reduce((s, x) => s + x, 0), 483, 'shares must sum to grand_total');
  // rupee-fair: values differ by at most 1
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
  assert.equal(body.invoice.splits[0].payment_status, 'pending');
});

test('M1: split rejects out-of-range seat counts', async () => {
  const invoice = await issueInvoiceForTable(31);
  for (const count of [1, 0, -3, 999, 'x', null]) {
    const res = await api(`/invoices/${invoice.id}/split-by-seats`, {
      auth: true, method: 'POST', body: JSON.stringify({ count })
    });
    assert.equal(res.status, 400, `count=${count} must be rejected`);
  }
});

test('M1: re-splitting an already split invoice is refused', async () => {
  const invoice = await issueInvoiceForTable(32);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  const res = await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 3 })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'ALREADY_SPLIT');
});

test('M1: mark-paid on parent is refused once split; each split settles individually', async () => {
  const invoice = await issueInvoiceForTable(33);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  const parentPaid = await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  assert.equal(parentPaid.status, 400);
  assert.equal((await parentPaid.json()).code, 'INVOICE_SPLIT');

  const splitPaid = await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  assert.equal(splitPaid.status, 200);
  const body = await splitPaid.json();
  assert.equal(body.invoice.splits[0].payment_status, 'paid');
  assert.equal(body.invoice.splits[0].payment_method, 'upi');
  assert.equal(body.invoice.payment_status, 'pending', 'parent stays pending until all splits paid');
});

test('M1: all-splits-paid rolls parent invoice to paid with method=split', async () => {
  const invoice = await issueInvoiceForTable(34);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 3 })
  });
  for (let i = 0; i < 3; i++) {
    const res = await api(`/invoices/${invoice.id}/splits/${i}/mark-paid`, {
      auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.parent_settled, i === 2, 'parent settles on the last split only');
    if (i < 2) assert.equal(body.invoice.payment_status, 'pending');
    else {
      assert.equal(body.invoice.payment_status, 'paid');
      assert.equal(body.invoice.payment_method, 'split');
    }
  }
});

test('M1: double-paying the same split is refused', async () => {
  const invoice = await issueInvoiceForTable(35);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  const dup = await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  assert.equal(dup.status, 400);
  assert.equal((await dup.json()).code, 'ALREADY_PAID');
});

test('M1: unknown split index is refused', async () => {
  const invoice = await issueInvoiceForTable(36);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  const res = await api(`/invoices/${invoice.id}/splits/9/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'UNKNOWN_SPLIT');
});

test('M1: unsplit works while all splits pending, refused after any split paid', async () => {
  const invoice = await issueInvoiceForTable(37);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 3 })
  });

  const undo = await api(`/invoices/${invoice.id}/splits`, { auth: true, method: 'DELETE' });
  assert.equal(undo.status, 200);
  assert.equal((await undo.json()).invoice.splits, undefined);

  // Re-split, pay one, then try to unsplit — refused.
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  const undo2 = await api(`/invoices/${invoice.id}/splits`, { auth: true, method: 'DELETE' });
  assert.equal(undo2.status, 400);
  assert.equal((await undo2.json()).code, 'SPLIT_PAID');
});

test('M1: voiding a split invoice with a paid share is refused', async () => {
  const invoice = await issueInvoiceForTable(38);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  const res = await api(`/invoices/${invoice.id}/void`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'oops' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'SPLIT_PAID');
});

// ---------------------------------------------------------------------------
// M1 — split-bill by amounts (custom amount per split)
// ---------------------------------------------------------------------------

test('M1: split-by-amounts requires auth', async () => {
  const res = await api('/invoices/inv_x/split-by-amounts', {
    method: 'POST', body: JSON.stringify({ splits: [{ share_amount: 100 }, { share_amount: 100 }] })
  });
  assert.equal(res.status, 401);
});

test('M1: split-by-amounts accepts custom labelled shares summing to grand_total', async () => {
  // m1 x2 = 460 + 5% GST = 483 grand
  const invoice = await issueInvoiceForTable(40, [{ id: 'm1', qty: 2 }]);
  assert.equal(invoice.grand_total, 483);

  const res = await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [
        { label: 'Rohit', share_amount: 200 },
        { label: 'Priya', share_amount: 183 },
        { label: 'Ankit', share_amount: 100 }
      ]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.split_mode, 'amounts');
  assert.equal(body.invoice.splits.length, 3);
  assert.equal(body.invoice.splits[0].label, 'Rohit');
  assert.equal(body.invoice.splits[0].share_amount, 200);
  const sum = body.invoice.splits.reduce((s, x) => s + x.share_amount, 0);
  assert.equal(sum, invoice.grand_total, 'amounts must sum to grand_total');
});

test('M1: split-by-amounts uses default labels when caller omits them', async () => {
  const invoice = await issueInvoiceForTable(41, [{ id: 'm1', qty: 2 }]);
  const res = await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ share_amount: 250 }, { share_amount: 233 }]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.splits[0].label, 'Split 1');
  assert.equal(body.invoice.splits[1].label, 'Split 2');
});

test('M1: split-by-amounts refuses when sum ≠ grand_total (short and over)', async () => {
  const invoice = await issueInvoiceForTable(42, [{ id: 'm1', qty: 2 }]);

  const short = await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ share_amount: 100 }, { share_amount: 100 }]
    })
  });
  assert.equal(short.status, 400);
  const shortBody = await short.json();
  assert.equal(shortBody.code, 'INVALID_AMOUNTS');
  assert.match(shortBody.error, /short by ₹283/);

  const over = await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ share_amount: 300 }, { share_amount: 300 }]
    })
  });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /over by ₹117/);
});

test('M1: split-by-amounts rejects negative, zero, non-integer, and single-split payloads', async () => {
  const invoice = await issueInvoiceForTable(43, [{ id: 'm1', qty: 2 }]);

  const cases = [
    { splits: [{ share_amount: -50 }, { share_amount: 533 }] },  // negative
    { splits: [{ share_amount: 0 }, { share_amount: 483 }] },     // zero
    { splits: [{ share_amount: 100.5 }, { share_amount: 382.5 }] }, // non-integer
    { splits: [{ share_amount: 483 }] },                          // single split (< min 2)
    { splits: 'not-an-array' }                                    // wrong type
  ];
  for (const body of cases) {
    const res = await api(`/invoices/${invoice.id}/split-by-amounts`, {
      auth: true, method: 'POST', body: JSON.stringify(body)
    });
    assert.equal(res.status, 400, `payload ${JSON.stringify(body).slice(0, 60)} must be rejected`);
  }
});

test('M1: split-by-amounts refuses on already-split invoice', async () => {
  const invoice = await issueInvoiceForTable(44, [{ id: 'm1', qty: 2 }]);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  const res = await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ share_amount: 250 }, { share_amount: 233 }]
    })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'ALREADY_SPLIT');
});

test('M1: amount-split shares settle the same way as seat splits', async () => {
  const invoice = await issueInvoiceForTable(45, [{ id: 'm1', qty: 2 }]);
  await api(`/invoices/${invoice.id}/split-by-amounts`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ share_amount: 200 }, { share_amount: 283 }]
    })
  });

  const first = await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).invoice.payment_status, 'pending');

  const second = await api(`/invoices/${invoice.id}/splits/1/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.parent_settled, true);
  assert.equal(body.invoice.payment_status, 'paid');
  assert.equal(body.invoice.payment_method, 'split');
});

// ---------------------------------------------------------------------------
// M1 — split-bill by items (per-line assignment)
// ---------------------------------------------------------------------------

test('M1: split-by-items requires auth', async () => {
  const res = await api('/invoices/inv_x/split-by-items', {
    method: 'POST', body: JSON.stringify({ splits: [{ item_indices: [0] }, { item_indices: [1] }] })
  });
  assert.equal(res.status, 401);
});

test('M1: split-by-items assigns proportional shares that sum exactly to grand_total', async () => {
  // Two lines: m1 x2 (460) + m2 x1 (220) = 680 subtotal; +5% GST = 714 grand.
  // Split into two: {items:[0]} → 460/680 * 714 = 483.0, {items:[1]} → 220/680 * 714 = 231.0.
  // Both are integers already so no rounding contest.
  await createOrder(50, [{ id: 'm1', qty: 2 }]);
  await createOrder(50, [{ id: 'm2', qty: 1 }], { reqId: 'req_50_b' });
  const { invoice } = await closeTable(50);
  assert.equal(invoice.subtotal, 680);
  assert.equal(invoice.grand_total, 714);

  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [
        { label: 'Veg only', item_indices: [0] },
        { label: 'Non-veg only', item_indices: [1] }
      ]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.split_mode, 'items');
  assert.equal(body.invoice.splits.length, 2);
  assert.equal(body.invoice.splits[0].item_indices[0], 0);
  assert.equal(body.invoice.splits[0].split_subtotal, 460);
  assert.equal(body.invoice.splits[0].share_amount, 483, '460/680 * 714 = 483');
  assert.equal(body.invoice.splits[1].split_subtotal, 220);
  assert.equal(body.invoice.splits[1].share_amount, 231, '220/680 * 714 = 231');
  const sum = body.invoice.splits.reduce((s, x) => s + x.share_amount, 0);
  assert.equal(sum, 714, 'shares must sum to grand_total');
});

test('M1: item-split allocates rounding remainder without breaking the sum invariant', async () => {
  // Rounding-sensitive: m1 (230) + m2 (220) + m4 (340) = 790 subtotal,
  // +5% GST = 830 grand. Split three ways one item each:
  //   230/790 * 830 = 241.6456…  floor 241  frac .6456
  //   220/790 * 830 = 231.1392…  floor 231  frac .1392
  //   340/790 * 830 = 357.2151…  floor 357  frac .2151
  //   floors sum 829, remainder 1 → +1 to the split with the largest frac (idx 0).
  await createOrder(51, [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }, { id: 'm4', qty: 1 }]);
  const { invoice } = await closeTable(51);
  assert.equal(invoice.subtotal, 790);
  assert.equal(invoice.grand_total, 830);

  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [
        { item_indices: [0] },
        { item_indices: [1] },
        { item_indices: [2] }
      ]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const shares = body.invoice.splits.map(s => s.share_amount);
  const sum = shares.reduce((s, x) => s + x, 0);
  assert.equal(sum, 830, 'shares must sum to grand_total exactly');
  assert.equal(shares[0], 242, 'largest fractional part gets the +1');
});

test('M1: split-by-items rejects orphan items', async () => {
  await createOrder(52, [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }]);
  const { invoice } = await closeTable(52);
  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [
        { item_indices: [0] },
        { item_indices: [0] } // duplicate assignment, item 1 orphaned
      ]
    })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_ITEM_SPLITS');
  assert.match(body.error, /assigned to both split/);
});

test('M1: split-by-items rejects an empty split', async () => {
  await createOrder(53, [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }]);
  const { invoice } = await closeTable(53);
  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ item_indices: [0, 1] }, { item_indices: [] }]
    })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /non-empty array/);
});

test('M1: split-by-items rejects unassigned items with a helpful message', async () => {
  await createOrder(54, [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }, { id: 'm4', qty: 1 }]);
  const { invoice } = await closeTable(54);
  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ item_indices: [0] }, { item_indices: [1] }] // item 2 dropped
    })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Item 2 not assigned/);
});

test('M1: split-by-items rejects out-of-range indices', async () => {
  await createOrder(55, [{ id: 'm1', qty: 1 }, { id: 'm2', qty: 1 }]);
  const { invoice } = await closeTable(55);
  const res = await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ item_indices: [0] }, { item_indices: [99] }]
    })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /out of range/);
});

// ---------------------------------------------------------------------------
// M1 — refund + payment reference
// ---------------------------------------------------------------------------

test('M1: refund requires auth', async () => {
  const res = await api('/invoices/inv_x/refund', {
    method: 'POST', body: JSON.stringify({ reason: 'x' })
  });
  assert.equal(res.status, 401);
});

test('M1: refund on an unpaid invoice is refused', async () => {
  const invoice = await issueInvoiceForTable(60);
  const res = await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'oops' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NOT_PAID');
});

test('M1: refund without a reason is refused', async () => {
  const invoice = await issueInvoiceForTable(61);
  await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  const res = await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'REASON_REQUIRED');
});

test('M1: refund flips paid → refunded and records reason + timestamp', async () => {
  const invoice = await issueInvoiceForTable(62);
  await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'card', payment_ref: 'auth_98765' })
  });
  const res = await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'Customer complaint' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.payment_status, 'refunded');
  assert.equal(body.invoice.refund_reason, 'Customer complaint');
  assert.ok(body.invoice.refund_at);
  // Original payment metadata stays put for audit
  assert.equal(body.invoice.payment_method, 'card');
  assert.equal(body.invoice.payment_ref, 'auth_98765');
});

test('M1: double refund is refused', async () => {
  const invoice = await issueInvoiceForTable(63);
  await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'x' })
  });
  const second = await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'x' })
  });
  assert.equal(second.status, 400);
  assert.equal((await second.json()).code, 'ALREADY_REFUNDED');
});

test('M1: refunding a split invoice reverses every paid share', async () => {
  const invoice = await issueInvoiceForTable(64, [{ id: 'm1', qty: 2 }]);
  await api(`/invoices/${invoice.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'cash' })
  });
  await api(`/invoices/${invoice.id}/splits/1/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });

  const res = await api(`/invoices/${invoice.id}/refund`, {
    auth: true, method: 'POST', body: JSON.stringify({ reason: 'Card rejected in reconcile' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.payment_status, 'refunded');
  assert.equal(body.invoice.splits[0].payment_status, 'refunded');
  assert.equal(body.invoice.splits[0].payment_method, 'cash', 'original method stays for audit');
  assert.equal(body.invoice.splits[0].refund_reason, 'Card rejected in reconcile');
  assert.equal(body.invoice.splits[1].payment_status, 'refunded');
});

test('M1: payment_ref survives mark-paid → refund roundtrip on both parent and split', async () => {
  // Parent
  const invoiceA = await issueInvoiceForTable(65);
  const paid = await api(`/invoices/${invoiceA.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi', payment_ref: 'UPI/2026/xyz' })
  });
  assert.equal((await paid.json()).invoice.payment_ref, 'UPI/2026/xyz');

  // Split
  const invoiceB = await issueInvoiceForTable(66);
  await api(`/invoices/${invoiceB.id}/split-by-seats`, {
    auth: true, method: 'POST', body: JSON.stringify({ count: 2 })
  });
  const splitPaid = await api(`/invoices/${invoiceB.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'card', payment_ref: 'auth_abc123' })
  });
  assert.equal((await splitPaid.json()).invoice.splits[0].payment_ref, 'auth_abc123');
});

test('M1: payment_ref longer than 80 chars is trimmed', async () => {
  const invoice = await issueInvoiceForTable(67);
  const long = 'x'.repeat(200);
  const paid = await api(`/invoices/${invoice.id}/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi', payment_ref: long })
  });
  const body = await paid.json();
  assert.equal(body.invoice.payment_ref.length, 80);
});

test('M1: item-split shares settle and roll up parent identically', async () => {
  await createOrder(56, [{ id: 'm1', qty: 2 }, { id: 'm2', qty: 1 }]);
  const { invoice } = await closeTable(56);
  await api(`/invoices/${invoice.id}/split-by-items`, {
    auth: true, method: 'POST', body: JSON.stringify({
      splits: [{ item_indices: [0] }, { item_indices: [1] }]
    })
  });
  const first = await api(`/invoices/${invoice.id}/splits/0/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'upi' })
  });
  assert.equal((await first.json()).invoice.payment_status, 'pending');

  const second = await api(`/invoices/${invoice.id}/splits/1/mark-paid`, {
    auth: true, method: 'POST', body: JSON.stringify({ payment_method: 'card' })
  });
  const body = await second.json();
  assert.equal(body.parent_settled, true);
  assert.equal(body.invoice.payment_status, 'paid');
  assert.equal(body.invoice.payment_method, 'split');
});

// ---------------------------------------------------------------------------
// M1 — ESC/POS thermal printing (KOT + receipt)
// ---------------------------------------------------------------------------

// Pure encoder / renderer tests — run in-process without hitting the child hub.
import { init, alignCenter, bold, cut, size, sanitiseForPrinter, build } from '../lib/escpos.js';
import { renderKot, renderReceipt, sendToPrinter } from '../lib/printer.js';

test('escpos: init and cut emit the documented ESC @ and GS V 0 sequences', () => {
  assert.deepEqual([...init()], [0x1B, 0x40]);
  assert.deepEqual([...cut()], [0x1D, 0x56, 0x00]);
});

test('escpos: alignCenter, bold(true), size(2,2) match ESC/POS reference bytes', () => {
  assert.deepEqual([...alignCenter()], [0x1B, 0x61, 0x01]);
  assert.deepEqual([...bold(true)], [0x1B, 0x45, 0x01]);
  assert.deepEqual([...size(2, 2)], [0x1D, 0x21, 0x11]);
});

test('escpos: sanitiseForPrinter rewrites Rupee and other CP437-unsafe characters', () => {
  assert.equal(sanitiseForPrinter('₹500'), 'Rs 500');
  assert.equal(sanitiseForPrinter('a–b—c'), 'a-b-c');
});

test('escpos: build concatenates commands and strings in order', () => {
  const buf = build(init(), 'X', cut());
  assert.deepEqual([...buf], [0x1B, 0x40, 0x58, 0x1D, 0x56, 0x00]);
});

test('renderKot contains table, ticket number, waiter, and every item in preview_text', () => {
  const ticket = {
    id: 't_x',
    ticket_number: 42,
    table_name: 'T8',
    created_by_waiter: 'Vikram (W1)',
    created_at: '2026-09-25T12:30:00.000Z',
    items: [
      { name: 'Paneer Tikka', qty: 2, price: 230 },
      { name: 'Chicken Sukka', qty: 1, price: 220 }
    ],
    note: 'Extra spicy'
  };
  const { escpos: bytes, preview_text } = renderKot(ticket, { name: 'Hotel Mejwani' });
  assert.match(preview_text, /KITCHEN ORDER TICKET/);
  assert.match(preview_text, /T8.*#42/);
  assert.match(preview_text, /Vikram \(W1\)/);
  assert.match(preview_text, /2x Paneer Tikka/);
  assert.match(preview_text, /1x Chicken Sukka/);
  assert.match(preview_text, /Note: Extra spicy/);
  assert.equal(bytes[0], 0x1B); assert.equal(bytes[1], 0x40);
  assert.deepEqual([...bytes.subarray(-3)], [0x1D, 0x56, 0x00]);
});

test('renderReceipt shows tenant name, invoice number, discount/service/tax rows, and grand total', () => {
  const tenant = { name: 'Hotel Mejwani', city: 'Nagpur', phone: '+91-9422133445' };
  const invoice = {
    invoice_number: 'INV-000042',
    table_name: 'T8',
    currency: '₹',
    issued_at: '2026-09-25T12:45:00.000Z',
    subtotal: 833,
    discount_rows: [{ type: 'percent', value: 10, reason: 'Loyalty', amount: 83.3 }],
    discount_total: 83.3,
    subtotal_after_discount: 749.7,
    service_charge_percent: 5,
    service_charge_amount: 37.49,
    taxable_base: 787.19,
    tax_rows: [
      { label: 'CGST', rate_percent: 2.5, taxable_amount: 787.19, amount: 19.68 },
      { label: 'SGST', rate_percent: 2.5, taxable_amount: 787.19, amount: 19.68 }
    ],
    tax_total: 39.36,
    grand_total: 827,
    items: [
      { name: 'Paneer Tikka', qty: 1, price: 230, line_total: 230, ticket_number: 133 },
      { name: 'Chicken Sukka', qty: 1, price: 220, line_total: 220, ticket_number: 133 }
    ],
    payment_status: 'paid',
    payment_method: 'upi',
    payment_ref: 'UPI/2026/9F82AB'
  };
  const { preview_text, escpos: bytes } = renderReceipt(invoice, tenant);
  assert.match(preview_text, /Hotel Mejwani/);
  assert.match(preview_text, /Nagpur/);
  assert.match(preview_text, /INV-000042/);
  assert.match(preview_text, /Paneer Tikka/);
  assert.match(preview_text, /Discount \(10%\)/);
  assert.match(preview_text, /Service charge \(5%\)/);
  assert.match(preview_text, /CGST \(2\.5%\)/);
  assert.match(preview_text, /SGST \(2\.5%\)/);
  assert.match(preview_text, /GRAND TOTAL/);
  // preview_text keeps the ₹ glyph so reception's monospace view reads naturally.
  assert.match(preview_text, /₹827/);
  assert.match(preview_text, /Paid: UPI/);
  assert.match(preview_text, /Ref: UPI\/2026\/9F82AB/);
  // The ESC/POS byte stream, on the other hand, MUST rewrite ₹ to Rs so a
  // CP437 printer doesn't emit `?`s.
  const asString = bytes.toString('binary');
  assert.ok(asString.includes('Rs 827'), 'escpos bytes must rewrite ₹ to Rs for CP437 printers');
});

test('renderReceipt banners unpaid preview and refunded receipts differently', () => {
  const base = { invoice_number: 'X', items: [{name:'a', qty:1, price:1, line_total:1}], subtotal:1, grand_total:1, tax_rows:[], currency:'₹' };
  assert.match(renderReceipt({ ...base, payment_status: 'pending' }, {}).preview_text, /UNPAID/);
  assert.match(renderReceipt({ ...base, payment_status: 'refunded' }, {}).preview_text, /REFUNDED/);
});

test('sendToPrinter in preview mode returns ok without dialling out', async () => {
  const job = renderKot({ ticket_number: 1, table_name: 'T1', created_at: new Date().toISOString(), items: [{ name: 'X', qty: 1 }] });
  const res = await sendToPrinter(job, { mode: 'preview' });
  assert.equal(res.ok, true);
  assert.equal(res.preview, true);
});

test('sendToPrinter surfaces a network error for an unreachable host', async () => {
  const job = renderKot({ ticket_number: 1, table_name: 'T1', created_at: new Date().toISOString(), items: [{ name: 'X', qty: 1 }] });
  const res = await sendToPrinter(job, { host: '127.0.0.1', port: 1 });
  assert.equal(res.ok, false);
  assert.ok(['CONNECT_FAILED', 'WRITE_FAILED', 'TIMEOUT'].includes(res.code));
});

test('M1: /orders/:id/print-kot returns preview text for a known ticket', async () => {
  const created = await api('/orders', {
    auth: true, method: 'POST',
    body: JSON.stringify({ table_id: 80, table_name: 'T80', items: [{ id: 'm1', qty: 1 }] })
  });
  const { ticket } = await created.json();
  const res = await api(`/orders/${ticket.id}/print-kot`, { auth: true, method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.preview_text);
  assert.match(body.preview_text, /KITCHEN ORDER TICKET/);
  assert.match(body.preview_text, new RegExp(`T80.*#${ticket.ticket_number}`));
  assert.equal(body.results[0].preview, true, 'no printer configured → preview target');
});

test('M1: /orders/:id/print-kot 404s on unknown ticket', async () => {
  const res = await api('/orders/t_missing/print-kot', { auth: true, method: 'POST' });
  assert.equal(res.status, 404);
});

test('M1: /invoices/:id/print-receipt returns preview text for the issued invoice', async () => {
  const invoice = await issueInvoiceForTable(81);
  const res = await api(`/invoices/${invoice.id}/print-receipt`, { auth: true, method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.preview_text, /Test Kitchen/);
  assert.match(body.preview_text, new RegExp(invoice.invoice_number));
  assert.match(body.preview_text, /GRAND TOTAL/);
});

test('M1: /printers requires auth and lists nothing when no printers are configured', async () => {
  const un = await api('/printers');
  assert.equal(un.status, 401);
  const ok = await api('/printers', { auth: true });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).printers, []);
});

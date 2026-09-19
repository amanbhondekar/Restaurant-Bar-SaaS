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
    { id: 'm3', name: 'Sold Out Dish', price: 100, category: 'Starters', isVeg: true, available: false }
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

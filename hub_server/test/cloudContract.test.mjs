import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudSchema, migrationFiles } from '../lib/sqlSchema.js';
import { RESTAURANT_ID } from './helpers/spawnHub.mjs';

// The cloud copy has never run against a real Supabase project, so its tests prove the hub's logic against
// fakes. A fake cannot catch the failure that matters most: the hub writing a column the cloud does not
// have, leaving out one it requires, or upserting on a key no unique index backs. Each of those is a
// push the cloud refuses on the first day, and each is knowable from the SQL alone.
//
// So this reads the schema out of database/*.sql and holds every row the hub builds against it.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-contract-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { invoiceRow } = await import('../lib/invoiceSync.js');
const { reconciliationRow } = await import('../lib/reconciliationSync.js');
const { inventoryItemRow, recipeRow } = await import('../lib/inventorySync.js');
const { reservationRow, walkInRow } = await import('../lib/reservationSync.js');
const { categoryRow, menuItemRow, tableRow } = await import('../lib/catalogSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { initCourseState } = await import('../lib/courses.js');

import { after } from 'node:test';
after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const SCHEMA = cloudSchema();
const RID = RESTAURANT_ID;
const T = '2026-10-22T10:00:00.000Z';

/** Columns every insert must name: NOT NULL, no default, not the generated id. */
const required = table => [...SCHEMA[table].columns.values()].filter(c => c.notNull && !c.hasDefault && c.name !== 'id').map(c => c.name);

/** What is wrong with `row` as an insert into `table`. Empty when it is fine. */
function problems(table, row) {
  const t = SCHEMA[table];
  if (!t) return [`there is no table "${table}" in the migrations`];
  const out = [];
  for (const key of Object.keys(row)) if (!t.columns.has(key)) out.push(`"${key}" is not a column of ${table}`);
  for (const name of required(table)) if (row[name] === undefined || row[name] === null) out.push(`${table}.${name} is required and the row leaves it out`);
  for (const { column, allowed } of t.checks) {
    if (row[column] !== undefined && row[column] !== null && !allowed.includes(row[column])) out.push(`${table}.${column} = ${JSON.stringify(row[column])} breaks its CHECK (${allowed.join(', ')})`);
  }
  return out;
}
const fits = (table, row) => assert.deepEqual(problems(table, row), [], `${table}: ${JSON.stringify(problems(table, row))}`);

// --- the reader itself -------------------------------------------------------------------------------

test('the schema reader understands the real migrations -- and would notice if it did not', () => {
  assert.ok(migrationFiles.length >= 11, 'every migration was read');
  for (const t of ['orders', 'order_items', 'menu_items', 'invoices', 'reconciliations', 'inventory_items', 'recipes', 'reservations', 'walkins', 'subscriptions']) {
    assert.ok(SCHEMA[t]?.columns.size > 3, `${t} was read with its columns`);
  }
  // Columns added by ALTER TABLE across several migrations are all there.
  assert.ok(SCHEMA.orders.columns.has('order_request_id'), '002');
  assert.ok(SCHEMA.orders.columns.has('course_log'), '008');
  assert.ok(SCHEMA.menu_items.columns.has('modifier_groups'), '003');
  // And one that is not there is reported, not waved through.
  assert.deepEqual(problems('invoices', { restaurant_id: RID, not_a_column: 1 }).filter(p => p.includes('not_a_column')), ['"not_a_column" is not a column of invoices']);
});

// --- bills and cash-ups ------------------------------------------------------------------------------

const INVOICE = {
  id: 'inv_1', invoice_number: 'INV-000001', table_id: 4, table_name: 'T4', currency: '₹',
  subtotal: 500, discount_total: 50, subtotal_after_discount: 450, service_charge_percent: 5, service_charge_amount: 22.5,
  taxable_base: 472.5, tax_total: 23.63, grand_total: 496, payment_status: 'paid', payment_method: 'upi', payment_ref: 'x',
  paid_at: T, voided_at: null, void_reason: null, refunded_at: null, refund_reason: null,
  tickets: [{ id: 't1' }], ticket_ids: ['t1'], items: [{ name: 'Dal', qty: 2 }], tax_rows: [{ rate: 5 }], discount_rows: [{ kind: 'flat' }], splits: [], issued_at: T
};

test('an invoice row fits the invoices table, in every state a bill can be in', () => {
  for (const payment_status of ['pending', 'paid', 'void', 'refunded', 'split']) {
    fits('invoices', invoiceRow(RID, { ...INVOICE, payment_status }));
  }
});

test('an invoice upserts on (restaurant_id, hub_ref), which a unique index backs', () => {
  assert.ok(SCHEMA.invoices.unique.some(u => u.join() === 'restaurant_id,hub_ref'));
});

const RECORD = {
  id: 'rec_1', seq: 3, number: 'REC-0003', period_start: T, period_end: T, opening_float: 1000, counted_cash: 5800, cash_removed: 4000,
  closing_float: 1800, expected_cash: 5800, cash_variance: 0, status: 'balanced', has_variance: false,
  methods: { cash: {} }, totals: {}, voided: {}, unpaid_at_close: {}, notes: 'n', closed_by: 'Asha'
};

test('a cash-up row fits the reconciliations table, balanced or with a variance', () => {
  fits('reconciliations', reconciliationRow(RID, RECORD));
  fits('reconciliations', reconciliationRow(RID, { ...RECORD, status: 'variance', has_variance: true, cash_variance: -100 }));
});

test('a cash-up upserts on (restaurant_id, hub_ref), backed by a unique index', () => {
  assert.ok(SCHEMA.reconciliations.unique.some(u => u.join() === 'restaurant_id,hub_ref'));
});

// --- the catalogs the hub owns -----------------------------------------------------------------------

test('menu, category and table rows fit their tables', () => {
  fits('menu_categories', categoryRow(RID, 'Mains', 1));
  fits('menu_items', menuItemRow(RID, { id: 'm1', name: 'Dal', price: 220, category: 'Mains', isVeg: true, available: true, variants: [], modifier_groups: [], day_parts: [], station: 'hot' }));
  fits('tables', tableRow(RID, { id: 1, name: 'T1', section: 'Main', capacity: 4 }, 0));
});

test('stock and recipe rows fit, including a recipe that carries an extra', () => {
  fits('inventory_items', inventoryItemRow(RID, { id: 'ing_1', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10 }));
  fits('inventory_items', inventoryItemRow(RID, { id: 'ing_1', name: 'Cheese', unit: 'g', on_hand: 100, low_at: 10, par: 500, unit_cost: 0.45 }));
  fits('recipes', recipeRow(RID, { id: 'rec_1', item_id: 'm1', variant_id: null, lines: [{ inventory_item_id: 'ing_1', qty: 20, group_id: 'g', option_id: 'o' }] }));
});

test('booking and queue rows fit, in every status', () => {
  for (const status of ['booked', 'seated', 'no_show', 'cancelled']) {
    fits('reservations', reservationRow(RID, { id: 'r1', guest_name: 'Asha', phone: '919876543210', phone_key: 'k', party_size: 4, at: T, duration_mins: 90, status, overbooked: false, note: 'n', created_at: T }));
  }
  for (const status of ['waiting', 'notified', 'seated', 'left']) {
    fits('walkins', walkInRow(RID, { id: 'w1', guest_name: 'Dev', phone: null, phone_key: null, party_size: 2, quoted_wait_mins: 15, status, created_at: T }));
  }
});

test('every catalog the hub upserts on (restaurant_id, hub_ref) has a unique index to match', () => {
  // Without one the cloud answers "no unique or exclusion constraint matching the ON CONFLICT
  // specification" and the whole push fails -- on every attempt, for ever.
  for (const t of ['menu_categories', 'menu_items', 'tables', 'inventory_items', 'recipes', 'reservations', 'walkins']) {
    assert.ok(SCHEMA[t].unique.some(u => u.join() === 'restaurant_id,hub_ref'), `${t} has no unique index on (restaurant_id, hub_ref)`);
  }
});

// --- what the hub reads back -------------------------------------------------------------------------

test('every column the hub names when reading the cloud exists', () => {
  const named = [
    ['inventory_items', 'hub_ref, name, unit, on_hand, low_at'],
    ['inventory_items', 'par, unit_cost'],
    ['recipes', 'hub_ref, menu_item_ref, variant_ref, lines'],
    ['restaurants', 'plan, plan_status, trial_ends_at, current_period_end'],
    ['staff_users', 'id, restaurant_id, role']
  ];
  for (const [table, list] of named) {
    for (const col of list.split(',').map(s => s.trim())) assert.ok(SCHEMA[table]?.columns.has(col), `${table}.${col}`);
  }
});

test('what the source asks the cloud for is what this test checks: no read goes unlisted', () => {
  // If someone adds a .select('a, b') somewhere, this fails until the column list above is extended.
  const libDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'lib');
  const explicit = new Set();
  for (const f of fs.readdirSync(libDir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(libDir, f), 'utf8');
    for (const m of src.matchAll(/\.select\('([^'*]+)'\s*(?:,|\))/g)) explicit.add(`${f}: ${m[1].trim()}`);
  }
  const known = new Set([
    'catalogSync.js: id, hub_ref',
    'hubConfig.js: plan, plan_status, trial_ends_at, current_period_end',
    'inventorySync.js: hub_ref, name, unit, on_hand, low_at',
    'inventorySync.js: hub_ref, name, unit, on_hand, low_at, par, unit_cost',
    'inventorySync.js: hub_ref, menu_item_ref, variant_ref, lines',
    'supabaseClient.js: id, restaurant_id, role',
    'invoiceSync.js: id', 'reconciliationSync.js: id', 'syncQueue.js: id',
    // cloud:check's own probe asks whether its bill landed once
    'cloudCheck.js: hub_ref'
  ]);
  assert.deepEqual([...explicit].filter(x => !known.has(x)), [], 'a read the contract test does not know about');
});

// --- orders and their status -------------------------------------------------------------------------

const ITEMS = [{ id: 'dal', name: 'Dal', qty: 1, price: 100, station: 'hot', course: 1 }, { id: 'tea', name: 'Chai', qty: 2, price: 40, station: 'bar', course: 1 }];
const TICKET = {
  id: 't_1', ticket_number: 142, restaurant_id: RID, table_id: '22222222-2222-2222-2222-222222222222', table_name: 'T4',
  status: 'in_progress', total_amount: 180, note: 'less spicy', created_by_waiter: 'Asha', order_request_id: 'req-1',
  items: ITEMS, created_at: T, updated_at: T, ...initCourseState(ITEMS, { staged: true }, T)
};

/** A cloud that keeps what it is sent, per table, and the updates it is asked to make. */
function recordingCloud() {
  const inserts = { orders: [], order_items: [] };
  const updates = [];
  return {
    inserts, updates,
    auth: { getUser: async () => ({ data: { user: null } }) },
    from(table) {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert(record) {
          const rows = Array.isArray(record) ? record : [record];
          inserts[table].push(...rows);
          return { select: () => ({ single: async () => ({ data: { id: 'db-1' }, error: null }) }), then: (ok, no) => Promise.resolve({ error: null }).then(ok, no) };
        },
        update(patch) {
          const filters = [];
          const chain = { eq(col, val) { filters.push([col, val]); return chain; }, then: (ok, no) => { updates.push({ table, patch, filters }); return Promise.resolve({ error: null }).then(ok, no); } };
          return chain;
        }
      };
    }
  };
}
const quiet = async fn => { const w = console.warn, l = console.log, e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; } };

test('an order and its lines fit the orders and order_items tables, with the course columns of migration 008', async () => {
  const cloud = recordingCloud();
  syncQueue.cloud = cloud;
  assert.equal(await quiet(() => syncQueue.syncOrderToSupabase(TICKET)), true);

  assert.equal(cloud.inserts.orders.length, 1);
  fits('orders', cloud.inserts.orders[0]);
  assert.equal(cloud.inserts.order_items.length, 2);
  // order_items.order_id is the cloud's own id for the order, which the cloud hands back; it is the one
  // required column the hub fills in from that answer.
  for (const row of cloud.inserts.order_items) fits('order_items', { ...row, order_id: row.order_id });
});

test('a ticket sent before migration 008 still fits: only the 008 columns are optional', () => {
  const before008 = cloudSchema(7);
  assert.equal(before008.orders.columns.has('course_log'), false);
  assert.equal(before008.order_items.columns.has('course'), false);
  const withoutCourse = Object.keys(recordingRowKeys()).filter(k => !['staged', 'course_log'].includes(k));
  for (const k of withoutCourse) assert.ok(before008.orders.columns.has(k), `${k} must exist before 008, or an unmigrated cloud cannot take any order`);
});

function recordingRowKeys() {
  const row = {
    restaurant_id: RID, table_name: 'T', ticket_number: 1, status: 'in_progress', total_amount: 1, note: '', created_by_waiter: 'w',
    order_request_id: 'r', synced_to_cloud: true, created_at: T
  };
  return row;
}

test('a status change only touches columns that exist, and course state only ones from 008', async () => {
  const cloud = recordingCloud();
  syncQueue.cloud = cloud;
  await quiet(() => syncQueue.syncStatusToSupabase({ ticketId: 142, status: 'ready', restaurantId: RID, requestId: 'req-1', course: { staged: false, course_log: {} } }));
  const [u] = cloud.updates;
  assert.equal(u.table, 'orders');
  for (const key of Object.keys(u.patch)) assert.ok(SCHEMA.orders.columns.has(key), `orders.${key}`);
  for (const status of ['in_progress', 'ready', 'completed']) {
    assert.ok(SCHEMA.orders.checks.find(c => c.column === 'status').allowed.includes(status), status);
  }
});

test('a status change is aimed at ONE order of THIS restaurant, not at every order that ever had that number', async () => {
  // Ticket numbers restart at 101 on a hub whose data directory was lost or reinstalled. An update keyed on
  // the number alone then rewrites the status of every old order with that number, in history the owner
  // already closed. The request id is what the order was inserted under; the restaurant stops it crossing.
  const cloud = recordingCloud();
  syncQueue.cloud = cloud;
  await quiet(() => syncQueue.syncStatusToSupabase({ ticketId: 142, status: 'ready', restaurantId: RID, requestId: 'req-1' }));
  const filters = Object.fromEntries(cloud.updates[0].filters);
  assert.equal(filters.restaurant_id, RID);
  assert.equal(filters.order_request_id, 'req-1');
  assert.equal(filters.ticket_number, undefined, 'the number is not what identifies the order');
});

test('a status change queued before this fix, with no request id, still reaches its order', async () => {
  // Items already in a hub's queue were written with the number only. They must still drain.
  const cloud = recordingCloud();
  syncQueue.cloud = cloud;
  await quiet(() => syncQueue.syncStatusToSupabase({ ticketId: 142, status: 'ready', restaurantId: RID }));
  const filters = Object.fromEntries(cloud.updates[0].filters);
  assert.equal(filters.ticket_number, 142);
  assert.equal(filters.restaurant_id, RID, 'and it is still kept inside the restaurant');
});

test('queueing a status change records the order\'s request id alongside its number', () => {
  const saved = syncQueue.saveQueue;
  const kept = [];
  syncQueue.saveQueue = q => { kept.push(...q); };
  const process = syncQueue.processQueue;
  syncQueue.processQueue = () => {};
  try {
    syncQueue.queue = [];
    syncQueue.enqueueStatusUpdate(142, 'ready', RID, TICKET);
    syncQueue.enqueueStatusUpdate(142, 'completed', RID, undefined, { requestId: 'req-9' });
  } finally {
    syncQueue.saveQueue = saved;
    syncQueue.processQueue = process;
    syncQueue.queue = [];
  }
  assert.equal(kept.find(q => q.payload.status === 'ready').payload.requestId, 'req-1');
  assert.equal(kept.find(q => q.payload.status === 'completed').payload.requestId, 'req-9');
});

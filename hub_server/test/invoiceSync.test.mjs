import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cloud replication of bills (migration 005). Everything here runs against a throwaway data
// directory with a fake cloud, and SUPABASE_URL is forced to the unconfigured placeholder so
// nothing in this file can reach a real project even if a .env is present (dotenv never
// overrides a variable that is already set).
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-invoice-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { invoiceRow, pushInvoice } = await import('../lib/invoiceSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');

const bill = (over = {}) => ({
  id: 'inv_1',
  restaurant_id: RID,
  invoice_number: 'INV-000001',
  table_id: 4,
  table_name: 'T4',
  currency: '₹',
  subtotal: 1000,
  discount_total: 100,
  subtotal_after_discount: 900,
  service_charge_percent: 5,
  service_charge_amount: 45,
  taxable_base: 945,
  tax_total: 47.25,
  grand_total: 992.25,
  payment_status: 'pending',
  tickets: [{ id: 't1', ticket_number: 1 }],
  ticket_ids: ['t1'],
  items: [{ name: 'Dal', qty: 1, line_total: 1000 }],
  tax_rows: [{ label: 'GST 5%', amount: 47.25 }],
  discount_rows: [{ label: 'Regular', amount: 100 }],
  issued_at: '2026-10-13T10:00:00.000Z',
  synced_to_cloud: false,
  ...over
});

/** Records every upsert so a test can assert on what the cloud was actually sent. */
function fakeCloud({ fail = false, error } = {}) {
  const rows = [];
  // The default failure is what an unapplied migration 005 looks like.
  const rejection = error || { message: 'permission denied for table invoices', code: '42501' };
  return {
    rows,
    from(name) {
      return {
        upsert: async (part, opts) => {
          if (fail) return { error: rejection };
          rows.push({ table: name, part, opts });
          return { error: null };
        }
      };
    }
  };
}

function reset(cloud) {
  syncQueue.saveQueue([]);
  fs.writeFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), '[]');
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
  syncQueue.cloud = cloud;
  invoiceStore.invoices = [];
  invoiceStore.save();
}

// enqueueInvoice starts a drain on its own; tests need it to stay put until they say so.

/**
 * The hub writes its queue asynchronously, so reading the file once can be too early. Waits for
 * the queue to hold what the test expects rather than assuming it already does.
 */
async function queueUntil(hub, predicate, ms = 15000) {
  const file = path.join(hub.dataDir, 'sync_queue.json');
  const deadline = Date.now() + ms;
  let last = [];
  for (;;) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { last = []; }
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    // 150ms, not tighter: the hub writes this file, and ten test processes share the CPU.
    await new Promise(r => setTimeout(r, 150));
  }
}

const hold = () => { syncQueue.isSyncing = true; };
const release = () => { syncQueue.isSyncing = false; };

// --- the row ---------------------------------------------------------------------------------

test('invoice row: the hub id becomes hub_ref, so a bill keeps its identity across pushes', () => {
  const row = invoiceRow(RID, bill());
  assert.equal(row.hub_ref, 'inv_1');
  assert.equal(row.restaurant_id, RID);
  assert.equal(row.invoice_number, 'INV-000001');
  // table_id is TEXT in the migration: the hub's ids are numbers today and strings elsewhere.
  assert.equal(row.table_id, '4');
});

test('invoice row: money is rounded to paise, never passed through as a float artefact', () => {
  const row = invoiceRow(RID, bill({ grand_total: 992.2500000001, tax_total: 47.249999 }));
  assert.equal(row.grand_total, 992.25);
  assert.equal(row.tax_total, 47.25);
});

test('invoice row: unusable money becomes 0 rather than NaN or null', () => {
  const row = invoiceRow(RID, bill({ subtotal: undefined, tax_total: 'abc', grand_total: null }));
  assert.equal(row.subtotal, 0);
  assert.equal(row.tax_total, 0);
  assert.equal(row.grand_total, 0);
});

test('invoice row: timestamps are ISO or null, never an empty string', () => {
  const row = invoiceRow(RID, bill({ paid_at: '', voided_at: 'not a date', refunded_at: undefined }));
  assert.equal(row.paid_at, null);
  assert.equal(row.voided_at, null);
  assert.equal(row.refunded_at, null);
  assert.equal(row.issued_at, '2026-10-13T10:00:00.000Z');
});

test('invoice row: a settled bill carries its method and reference', () => {
  const row = invoiceRow(RID, bill({
    payment_status: 'paid', payment_method: 'upi', payment_ref: 'UPI123', paid_at: '2026-10-13T11:00:00.000Z'
  }));
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.payment_method, 'upi');
  assert.equal(row.payment_ref, 'UPI123');
  assert.equal(row.paid_at, '2026-10-13T11:00:00.000Z');
});

test('invoice row: the printed breakdown is kept whole, and absent parts are null', () => {
  const row = invoiceRow(RID, bill());
  assert.deepEqual(row.items, [{ name: 'Dal', qty: 1, line_total: 1000 }]);
  assert.deepEqual(row.tax_rows, [{ label: 'GST 5%', amount: 47.25 }]);
  // No split was made, so the column stays null rather than an empty array.
  assert.equal(row.splits, null);
});

// --- the push --------------------------------------------------------------------------------

test('push: upserts on (restaurant_id, hub_ref) so paying a bill updates it instead of duplicating', async () => {
  const cloud = fakeCloud();
  await pushInvoice(cloud, RID, bill());
  await pushInvoice(cloud, RID, bill({ payment_status: 'paid', payment_method: 'cash' }));

  assert.equal(cloud.rows.length, 2);
  assert.equal(cloud.rows[0].table, 'invoices');
  assert.equal(cloud.rows[0].opts.onConflict, 'restaurant_id,hub_ref');
  // Same bill both times; the cloud resolves them to one row.
  assert.equal(cloud.rows[0].part[0].hub_ref, cloud.rows[1].part[0].hub_ref);
  assert.equal(cloud.rows[1].part[0].payment_status, 'paid');
});

test('push: a rejection throws with the cloud code, so the queue can count the attempt', async () => {
  const cloud = fakeCloud({ fail: true });
  await assert.rejects(() => pushInvoice(cloud, RID, bill()), err => {
    assert.match(err.message, /permission denied/);
    assert.equal(err.code, '42501');
    return true;
  });
});

// --- the queue -------------------------------------------------------------------------------

test('queue: a bill is pushed and then recorded as synced on disk', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  invoiceStore.invoices = [bill()];
  invoiceStore.save();

  hold();
  syncQueue.enqueueInvoice(bill());
  release();
  await syncQueue.processQueue();

  assert.equal(syncQueue.queue.length, 0, 'the push left the queue');
  assert.equal(cloud.rows.length, 1);
  assert.equal(invoiceStore.invoices[0].synced_to_cloud, true, 'the bill is recorded as replicated');
});

test('queue: edits to one bill while offline collapse to a single push carrying the final state', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });

  // Issued, then paid, then refunded, all before the cloud was reachable.
  hold();
  syncQueue.enqueueInvoice(bill());
  syncQueue.enqueueInvoice(bill({ payment_status: 'paid' }));
  syncQueue.enqueueInvoice(bill({ payment_status: 'refunded', refund_reason: 'spoiled' }));
  release();

  const queued = syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE');
  assert.equal(queued.length, 1, 'three edits to one bill are one queued push');
  assert.equal(queued[0].payload.invoice.payment_status, 'refunded', 'and it carries the newest state');
});

test('queue: two different bills are two pushes', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });

  hold();
  syncQueue.enqueueInvoice(bill({ id: 'inv_1' }));
  syncQueue.enqueueInvoice(bill({ id: 'inv_2', invoice_number: 'INV-000002' }));
  release();

  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE').length, 2);
});

test('queue: a bill raised for another tenant is dropped, not written to this one', async () => {
  const cloud = fakeCloud();
  reset(cloud);

  // A hub re-paired between issuing and pushing must not write the old tenant's revenue here.
  hold();
  syncQueue.enqueueInvoice(bill({ restaurant_id: OTHER_RID }));
  release();
  await syncQueue.processQueue();

  assert.equal(cloud.rows.length, 0, 'nothing reached the cloud');
  assert.equal(syncQueue.queue.length, 0, 'and it was dropped rather than retried forever');
});

test('queue: migration 005 not applied holds the bills intact, it does not quarantine revenue', async () => {
  // 42501 is how an unapplied migration or a bad RLS policy reads, and isSystemicFailure treats
  // it as hub-wide. That matters most here: if invoice pushes burned their retry budget against
  // a missing table, five cycles would shelve a restaurant's takings for an admin's omission.
  const cloud = fakeCloud({ fail: true });
  reset(cloud);
  invoiceStore.invoices = [bill()];
  invoiceStore.save();

  hold();
  syncQueue.enqueueInvoice(bill());
  release();
  await syncQueue.processQueue();

  const queued = syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE');
  assert.equal(queued.length, 1, 'the bill is still waiting');
  assert.equal(queued[0].attempts || 0, 0, 'and no retry was burned on a hub-wide fault');
  assert.equal(invoiceStore.invoices[0].synced_to_cloud, false, 'it is not recorded as replicated');

  const shelved = JSON.parse(fs.readFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), 'utf-8'));
  assert.equal(shelved.length, 0, 'nothing was shelved');
});

test('queue: a fault specific to one bill does count an attempt', async () => {
  // A constraint violation is about this row, not the hub, so it burns the retry budget normally.
  const cloud = fakeCloud({ fail: true, error: { message: 'duplicate key value', code: '23505' } });
  reset(cloud);
  invoiceStore.invoices = [bill()];
  invoiceStore.save();

  hold();
  syncQueue.enqueueInvoice(bill());
  release();
  await syncQueue.processQueue();

  const queued = syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE');
  assert.equal(queued.length, 1, 'the bill is still waiting');
  assert.ok(queued[0].attempts >= 1, 'and the attempt was counted');
});

// --- the on-disk flag ------------------------------------------------------------------------

test('store: markSynced and markPending only move the flag when it actually changes', () => {
  invoiceStore.invoices = [bill()];
  invoiceStore.save();

  assert.equal(invoiceStore.markSynced('inv_1', RID), true);
  assert.equal(invoiceStore.invoices[0].synced_to_cloud, true);
  assert.equal(invoiceStore.markSynced('inv_1', RID), false, 'already synced: nothing to write');

  assert.equal(invoiceStore.markPending('inv_1', RID), true);
  assert.equal(invoiceStore.invoices[0].synced_to_cloud, false);
  assert.equal(invoiceStore.markPending('inv_1', RID), false, 'already pending: nothing to write');
});

test('store: the flag is never moved on another tenant\'s bill, or on nothing', () => {
  invoiceStore.invoices = [bill()];
  invoiceStore.save();
  assert.equal(invoiceStore.markSynced('inv_1', OTHER_RID), false);
  assert.equal(invoiceStore.markSynced('inv_missing', RID), false);
  assert.equal(invoiceStore.markSynced(undefined, RID), false);
  assert.equal(invoiceStore.invoices[0].synced_to_cloud, false);
});

// --- through the real routes -----------------------------------------------------------------

// The unit tests above drive the queue directly. This one proves the wiring in server.js: that
// closing a bill over HTTP actually reaches enqueueInvoice, and that paying it afterwards
// collapses onto the same queued push instead of adding a second one.
test('hub: closing and then paying a bill leaves exactly one queued push, carrying "paid"', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: {
      restaurant_id: RESTAURANT_ID,
      categories: ['Mains'],
      items: [{ id: 'm1', name: 'Dal', price: 200, category: 'Mains', isVeg: true, available: true }]
    },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    const ordered = await hubCall(hub, '/orders', {
      method: 'POST',
      body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 2 }] }
    });
    assert.equal(ordered.status, 201, 'the order was accepted');

    const cleared = await hubCall(hub, '/tables/1/clear', { method: 'POST' });
    assert.equal(cleared.status, 200);
    const invoice = (await cleared.json()).invoice;
    assert.ok(invoice?.id, 'closing the table issued a bill');

    const afterIssue = (await queueUntil(hub, q => q.some(x => x.type === 'SYNC_INVOICE')))
      .filter(q => q.type === 'SYNC_INVOICE');
    assert.equal(afterIssue.length, 1, 'closing the bill queued it for the cloud');
    assert.equal(afterIssue[0].payload.invoice.id, invoice.id);
    assert.equal(afterIssue[0].payload.invoice.payment_status, 'pending');

    const paid = await hubCall(hub, `/invoices/${invoice.id}/mark-paid`, {
      method: 'POST',
      body: { payment_method: 'cash' }
    });
    assert.equal(paid.status, 200);

    const afterPay = (await queueUntil(hub, q =>
      q.some(x => x.type === 'SYNC_INVOICE' && x.payload?.invoice?.payment_status === 'paid')))
      .filter(q => q.type === 'SYNC_INVOICE');
    assert.equal(afterPay.length, 1, 'paying it did not add a second push for the same bill');
    assert.equal(afterPay[0].payload.invoice.payment_status, 'paid', 'the queued push carries the settled state');
  } finally {
    hub.stop();
  }
});

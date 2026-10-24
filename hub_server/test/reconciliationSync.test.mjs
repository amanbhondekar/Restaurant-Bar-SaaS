import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cash-up replication (migration 006) and the boot backfill that carries an existing ledger up.
// Throwaway data directory, fake cloud, and SUPABASE_URL forced to the unconfigured placeholder
// so nothing here can reach a real project even if a .env is present.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cashup-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { reconciliationRow, pushReconciliation } = await import('../lib/reconciliationSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { reconciliationStore } = await import('../lib/reconciliationStore.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');

const cashup = (over = {}) => ({
  id: 'rec_abc_1',
  seq: 1,
  number: 'REC-000001',
  restaurant_id: RID,
  period_start: '2026-10-13T06:00:00.000Z',
  period_end: '2026-10-13T18:00:00.000Z',
  opening_float: 2000,
  counted_cash: 7450.5,
  cash_removed: 5000,
  closing_float: 2450.5,
  expected_cash: 7450,
  cash_variance: 0.5,
  status: 'variance',
  has_variance: true,
  methods: { cash: { net: 5450, expected: 7450, counted: 7450.5, variance: 0.5 } },
  totals: { net: 9000 },
  voided: { count: 1, total: 200 },
  unpaid_at_close: { count: 0, total: 0 },
  notes: 'short by 50p',
  closed_by: 'Priya',
  synced_to_cloud: false,
  ...over
});

const bill = (over = {}) => ({
  id: 'inv_1', restaurant_id: RID, invoice_number: 'INV-000001', grand_total: 100,
  payment_status: 'paid', issued_at: '2026-10-13T10:00:00.000Z', synced_to_cloud: false, ...over
});

function fakeCloud({ fail = false, error } = {}) {
  const rows = [];
  const rejection = error || { message: 'permission denied for table reconciliations', code: '42501' };
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
  reconciliationStore.records = [];
  reconciliationStore.persist();
  invoiceStore.invoices = [];
  invoiceStore.save();
}


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

test('cash-up row: the hub id becomes hub_ref and the shift number is carried', () => {
  const row = reconciliationRow(RID, cashup());
  assert.equal(row.hub_ref, 'rec_abc_1');
  assert.equal(row.number, 'REC-000001');
  assert.equal(row.seq, 1);
  assert.equal(row.restaurant_id, RID);
});

test('cash-up row: a part-rupee variance survives intact', () => {
  // The whole point of a cash-up is the variance; rounding it away would defeat the record.
  const row = reconciliationRow(RID, cashup());
  assert.equal(row.cash_variance, 0.5);
  assert.equal(row.counted_cash, 7450.5);
  assert.equal(row.has_variance, true);
  assert.equal(row.status, 'variance');
});

test('cash-up row: an unknown status falls back to balanced rather than failing the CHECK', () => {
  assert.equal(reconciliationRow(RID, cashup({ status: 'weird' })).status, 'balanced');
  assert.equal(reconciliationRow(RID, cashup({ status: 'balanced', has_variance: false })).status, 'balanced');
});

test('cash-up row: an open-ended first period keeps a null start', () => {
  const row = reconciliationRow(RID, cashup({ period_start: null }));
  assert.equal(row.period_start, null);
  assert.equal(row.period_end, '2026-10-13T18:00:00.000Z');
});

test('cash-up row: the computed breakdown is kept whole, and absent parts are null', () => {
  const row = reconciliationRow(RID, cashup());
  assert.equal(row.methods.cash.variance, 0.5);
  assert.deepEqual(row.voided, { count: 1, total: 200 });
  assert.equal(reconciliationRow(RID, cashup({ totals: undefined })).totals, null);
});

// --- the push --------------------------------------------------------------------------------

test('push: a closed shift is inserted, never updated', async () => {
  const cloud = fakeCloud();
  await pushReconciliation(cloud, RID, cashup());

  assert.equal(cloud.rows[0].table, 'reconciliations');
  assert.equal(cloud.rows[0].opts.onConflict, 'restaurant_id,hub_ref');
  // DO NOTHING, not DO UPDATE: the record is immutable and the table has no UPDATE grant,
  // so a retry after an unconfirmed success must be a no-op rather than a permission error.
  assert.equal(cloud.rows[0].opts.ignoreDuplicates, true);
});

test('push: a rejection throws with the cloud code', async () => {
  const cloud = fakeCloud({ fail: true });
  await assert.rejects(() => pushReconciliation(cloud, RID, cashup()), err => {
    assert.equal(err.code, '42501');
    return true;
  });
});

// --- the queue -------------------------------------------------------------------------------

test('queue: a closed shift is pushed and recorded as synced on disk', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  reconciliationStore.records = [cashup()];
  reconciliationStore.persist();

  hold();
  syncQueue.enqueueReconciliation(cashup());
  release();
  await syncQueue.processQueue();

  assert.equal(syncQueue.queue.length, 0);
  assert.equal(cloud.rows.length, 1);
  assert.equal(reconciliationStore.records[0].synced_to_cloud, true);
});

test('queue: the same shift is never queued twice', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });

  hold();
  syncQueue.enqueueReconciliation(cashup());
  syncQueue.enqueueReconciliation(cashup());
  release();

  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_RECONCILIATION').length, 1);
});

test('queue: a shift closed for another tenant is dropped, not written to this one', async () => {
  const cloud = fakeCloud();
  reset(cloud);

  hold();
  syncQueue.enqueueReconciliation(cashup({ restaurant_id: OTHER_RID }));
  release();
  await syncQueue.processQueue();

  assert.equal(cloud.rows.length, 0);
  assert.equal(syncQueue.queue.length, 0);
});

// --- the backfill ----------------------------------------------------------------------------

test('backfill: bills that predate migration 005 are queued, in the order they were written', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });
  // invoices are stored newest-first; a backfill must replicate oldest-first.
  invoiceStore.invoices = [
    bill({ id: 'inv_3', invoice_number: 'INV-000003' }),
    bill({ id: 'inv_2', invoice_number: 'INV-000002' }),
    bill({ id: 'inv_1', invoice_number: 'INV-000001' })
  ];
  invoiceStore.save();

  hold();
  const result = syncQueue.enqueueUnsyncedInvoices(RID);
  release();

  assert.equal(result.queued, 3);
  const queued = syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE');
  assert.deepEqual(queued.map(q => q.payload.invoice.id), ['inv_1', 'inv_2', 'inv_3']);
});

test('backfill: a bill the cloud already holds is left alone', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });
  invoiceStore.invoices = [bill({ id: 'inv_1', synced_to_cloud: true }), bill({ id: 'inv_2' })];
  invoiceStore.save();

  hold();
  const result = syncQueue.enqueueUnsyncedInvoices(RID);
  release();

  assert.equal(result.queued, 1);
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE')[0].payload.invoice.id, 'inv_2');
});

test('backfill: a fully replicated ledger queues nothing', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  invoiceStore.invoices = [bill({ synced_to_cloud: true })];
  invoiceStore.save();
  reconciliationStore.records = [cashup({ synced_to_cloud: true })];
  reconciliationStore.persist();

  assert.equal(syncQueue.enqueueUnsyncedInvoices(RID).queued, 0);
  assert.equal(syncQueue.enqueueUnsyncedReconciliations(RID).queued, 0);
  assert.equal(syncQueue.queue.length, 0);
});

test('backfill: another tenant\'s records are never carried up by this hub', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });
  invoiceStore.invoices = [bill({ id: 'inv_other', restaurant_id: OTHER_RID })];
  invoiceStore.save();
  reconciliationStore.records = [cashup({ id: 'rec_other', restaurant_id: OTHER_RID })];
  reconciliationStore.persist();

  hold();
  assert.equal(syncQueue.enqueueUnsyncedInvoices(RID).queued, 0);
  assert.equal(syncQueue.enqueueUnsyncedReconciliations(RID).queued, 0);
  release();
  assert.equal(syncQueue.queue.length, 0);
});

test('backfill: running twice does not double-queue anything', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  syncQueue.checkConnection = async () => ({ online: false });
  invoiceStore.invoices = [bill()];
  invoiceStore.save();
  reconciliationStore.records = [cashup()];
  reconciliationStore.persist();

  hold();
  syncQueue.enqueueUnsyncedInvoices(RID);
  syncQueue.enqueueUnsyncedInvoices(RID);
  syncQueue.enqueueUnsyncedReconciliations(RID);
  syncQueue.enqueueUnsyncedReconciliations(RID);
  release();

  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE').length, 1);
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_RECONCILIATION').length, 1);
});

test('backfill: a queued ledger drains and every record is marked replicated', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  invoiceStore.invoices = [bill({ id: 'inv_1' }), bill({ id: 'inv_2', invoice_number: 'INV-000002' })];
  invoiceStore.save();
  reconciliationStore.records = [cashup()];
  reconciliationStore.persist();

  hold();
  syncQueue.enqueueUnsyncedInvoices(RID);
  syncQueue.enqueueUnsyncedReconciliations(RID);
  release();
  await syncQueue.processQueue();

  assert.equal(syncQueue.queue.length, 0, 'the whole ledger went up');
  assert.equal(cloud.rows.length, 3, 'two bills and one cash-up');
  assert.ok(invoiceStore.invoices.every(i => i.synced_to_cloud === true));
  assert.equal(reconciliationStore.records[0].synced_to_cloud, true);
});

// --- through the real routes -----------------------------------------------------------------

test('hub: closing a shift over HTTP queues it for the cloud', async () => {
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
    // A bill has to exist and be settled before there is anything to count.
    await hubCall(hub, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] } });
    const cleared = await hubCall(hub, '/tables/1/clear', { method: 'POST' });
    const invoice = (await cleared.json()).invoice;
    await hubCall(hub, `/invoices/${invoice.id}/mark-paid`, { method: 'POST', body: { payment_method: 'cash' } });

    const closed = await hubCall(hub, '/reconciliation/close', {
      method: 'POST',
      body: { opening_float: 0, counted_cash: invoice.grand_total, cash_removed: 0, closed_by: 'Priya' }
    });
    assert.equal(closed.status, 201, 'the shift closed');
    const record = (await closed.json()).record;

    const queue = await queueUntil(hub, q => q.some(x => x.type === 'SYNC_RECONCILIATION'));
    const cashups = queue.filter(q => q.type === 'SYNC_RECONCILIATION');
    assert.equal(cashups.length, 1, 'closing the shift queued it for the cloud');
    assert.equal(cashups[0].payload.record.id, record.id);
    assert.equal(cashups[0].payload.record.number, record.number);
  } finally {
    hub.stop();
  }
});

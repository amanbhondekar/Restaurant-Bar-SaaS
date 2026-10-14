import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reading the ledger back from the cloud, for a reinstalled or replaced reception laptop.
// Throwaway data directory, fake cloud, SUPABASE_URL forced to the unconfigured placeholder.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-restore-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { invoiceRow, invoiceFromCloud } = await import('../lib/invoiceSync.js');
const { reconciliationRow, reconciliationFromCloud } = await import('../lib/reconciliationSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationStore } = await import('../lib/reconciliationStore.js');

const bill = (n, over = {}) => ({
  id: `inv_${n}`,
  restaurant_id: RID,
  invoice_number: `INV-${String(n).padStart(6, '0')}`,
  table_id: 4,
  table_name: 'T4',
  currency: '₹',
  subtotal: 1000, discount_total: 0, subtotal_after_discount: 1000,
  service_charge_percent: 0, service_charge_amount: 0,
  taxable_base: 1000, tax_total: 50, grand_total: 1050,
  payment_status: 'paid', payment_method: 'cash', paid_at: '2026-10-14T11:00:00.000Z',
  tickets: [{ id: `t${n}`, ticket_number: n }],
  ticket_ids: [`t${n}`],
  items: [{ name: 'Dal', qty: 1, line_total: 1000 }],
  tax_rows: [{ label: 'GST 5%', amount: 50 }],
  discount_rows: [],
  issued_at: `2026-10-14T1${n}:00:00.000Z`,
  synced_to_cloud: true,
  ...over
});

const cashup = (n, over = {}) => ({
  id: `rec_${n}`, seq: n, number: `REC-${String(n).padStart(6, '0')}`, restaurant_id: RID,
  period_start: null, period_end: `2026-10-1${n}T18:00:00.000Z`,
  opening_float: 2000, counted_cash: 5000, cash_removed: 0, closing_float: 5000,
  expected_cash: 5000, cash_variance: 0, status: 'balanced', has_variance: false,
  methods: { cash: { net: 3000 } }, totals: { net: 3000 },
  voided: { count: 0, total: 0 }, unpaid_at_close: { count: 0, total: 0 },
  notes: null, closed_by: 'Priya', synced_to_cloud: true, ...over
});

/** A cloud holding exactly the rows a hub would have pushed for these records. */
function fakeCloud({ invoices = [], cashups = [], failOn = null } = {}) {
  const tables = {
    invoices: invoices.map(i => invoiceRow(RID, i)),
    reconciliations: cashups.map(c => reconciliationRow(RID, c))
  };
  return {
    tables,
    from(name) {
      return {
        select: () => ({
          eq: (_col, value) => {
            const run = async () => {
              if (failOn === name) return { data: null, error: { message: 'permission denied', code: '42501' } };
              return { data: tables[name].filter(r => r.restaurant_id === value), error: null };
            };
            // The real client is thenable after .eq() and also offers .order().
            return { order: run, then: (res, rej) => run().then(res, rej) };
          }
        }),
        upsert: async () => ({ error: null })
      };
    }
  };
}

function reset(cloud, { online = true } = {}) {
  syncQueue.saveQueue([]);
  syncQueue.checkConnection = async () => ({ online });
  syncQueue.isOnline = online;
  syncQueue.cloud = cloud;
  invoiceStore.invoices = [];
  invoiceStore.save();
  reconciliationStore.records = [];
  reconciliationStore.persist();
}

// --- numbering ---------------------------------------------------------------------------------

test('numbering: the next invoice number comes from the highest used, not the count', () => {
  invoiceStore.invoices = [];
  invoiceStore.save();
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000001');

  // A ledger with a gap -- exactly what an incomplete restore leaves behind. Counting would
  // reissue INV-000003, which migration 005's unique index rejects, so that bill could never
  // sync for as long as the hub ran.
  invoiceStore.invoices = [bill(1), bill(2), bill(4)];
  invoiceStore.save();
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000005');
});

test('numbering: another tenant\'s bills never advance this one\'s counter', () => {
  invoiceStore.invoices = [bill(9, { restaurant_id: OTHER_RID })];
  invoiceStore.save();
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000001');
});

test('numbering: an unparseable invoice number is ignored rather than poisoning the counter', () => {
  invoiceStore.invoices = [bill(2), bill(3, { invoice_number: 'LEGACY' })];
  invoiceStore.save();
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000003');
});

// --- the mapping back ---------------------------------------------------------------------------

test('round trip: a bill pushed and read back is the same bill', () => {
  const original = bill(7);
  const restored = invoiceFromCloud(invoiceRow(RID, original));

  assert.equal(restored.id, 'inv_7', 'hub_ref carries the hub id, so tickets still resolve');
  assert.equal(restored.invoice_number, 'INV-000007');
  assert.equal(restored.grand_total, 1050);
  assert.equal(restored.payment_status, 'paid');
  assert.equal(restored.payment_method, 'cash');
  assert.deepEqual(restored.items, original.items);
  assert.deepEqual(restored.ticket_ids, ['t7']);
  assert.equal(restored.synced_to_cloud, true, 'it came from the cloud, so the cloud has it');
});

test('round trip: a cash-up pushed and read back keeps its variance and shift number', () => {
  const restored = reconciliationFromCloud(reconciliationRow(RID, cashup(2, {
    cash_variance: -1.5, status: 'variance', has_variance: true, counted_cash: 4998.5
  })));
  assert.equal(restored.id, 'rec_2');
  assert.equal(restored.number, 'REC-000002');
  assert.equal(restored.seq, 2);
  assert.equal(restored.cash_variance, -1.5);
  assert.equal(restored.status, 'variance');
  assert.equal(restored.synced_to_cloud, true);
});

test('round trip: an unsettled bill does not gain settlement fields it never had', () => {
  const restored = invoiceFromCloud(invoiceRow(RID, bill(1, {
    payment_status: 'pending', payment_method: undefined, paid_at: undefined
  })));
  assert.equal(restored.payment_status, 'pending');
  assert.ok(!('payment_method' in restored), 'absent stays absent rather than becoming null');
  assert.ok(!('paid_at' in restored));
});

// --- the restore -------------------------------------------------------------------------------

test('restore: an empty hub gets its whole financial history back', async () => {
  const cloud = fakeCloud({ invoices: [bill(1), bill(2)], cashups: [cashup(1)] });
  reset(cloud);

  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.deepEqual([result.restored, result.invoices, result.cashups], [true, 2, 1]);
  assert.equal(invoiceStore.listInvoices(RID).length, 2);
  assert.equal(reconciliationStore.list(RID).length, 1);
});

test('restore: numbering continues from the restored ledger, it does not start again', async () => {
  const cloud = fakeCloud({ invoices: [bill(1), bill(2), bill(3)] });
  reset(cloud);
  await syncQueue.restoreLedgerFromCloud(RID);

  // Without the restore this hub would have issued INV-000001 and collided in the cloud.
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000004');
});

test('restore: a restored ledger is already replicated, so the backfill queues nothing', async () => {
  const cloud = fakeCloud({ invoices: [bill(1), bill(2)], cashups: [cashup(1)] });
  reset(cloud);
  await syncQueue.restoreLedgerFromCloud(RID);

  // Boot order is restore then backfill; reversing it would push the whole ledger straight back.
  assert.equal(syncQueue.enqueueUnsyncedInvoices(RID).queued, 0);
  assert.equal(syncQueue.enqueueUnsyncedReconciliations(RID).queued, 0);
  assert.equal(syncQueue.queue.length, 0);
});

test('restore: a hub that already holds bills is left alone', async () => {
  const cloud = fakeCloud({ invoices: [bill(1), bill(2), bill(3)] });
  reset(cloud);
  // A local bill the cloud has never seen -- pulling over the top would lose it.
  invoiceStore.invoices = [bill(9, { synced_to_cloud: false, grand_total: 7777 })];
  invoiceStore.save();
  // Both halves present, so the whole restore short-circuits without reaching the cloud.
  reconciliationStore.records = [cashup(1)];
  reconciliationStore.persist();

  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'LEDGER_PRESENT');
  assert.equal(invoiceStore.listInvoices(RID).length, 1);
  assert.equal(invoiceStore.listInvoices(RID)[0].grand_total, 7777, 'the local bill survived');
});

test('restore: offline is a no-op that can be retried, not a failure that empties anything', async () => {
  const cloud = fakeCloud({ invoices: [bill(1)] });
  reset(cloud, { online: false });

  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'OFFLINE');
  assert.equal(invoiceStore.listInvoices(RID).length, 0);
});

test('restore: a cloud that refuses the read fails soft rather than stopping the hub', async () => {
  const cloud = fakeCloud({ invoices: [bill(1)], failOn: 'invoices' });
  reset(cloud);

  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'CLOUD_ERROR');
  assert.match(result.detail, /permission denied/);
});

test('restore: an empty cloud leaves an empty hub, and reports nothing restored', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(invoiceStore.listInvoices(RID).length, 0);
});

test('restore: a hub paired to another tenant restores nothing', async () => {
  const cloud = fakeCloud({ invoices: [bill(1)] });
  reset(cloud);
  const result = await syncQueue.restoreLedgerFromCloud(OTHER_RID);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'NOT_PAIRED');
  assert.equal(invoiceStore.listInvoices(RID).length, 0);
});

test('restore: bills and cash-ups are considered separately', async () => {
  // A hub with bills but no shift history still gets the cash-ups back.
  const cloud = fakeCloud({ invoices: [bill(1), bill(2)], cashups: [cashup(1), cashup(2)] });
  reset(cloud);
  invoiceStore.invoices = [bill(5)];
  invoiceStore.save();

  const result = await syncQueue.restoreLedgerFromCloud(RID);
  assert.equal(result.cashups, 2, 'the missing half is restored');
  assert.equal(result.invoices, 0, 'the half the hub already has is untouched');
  assert.equal(invoiceStore.listInvoices(RID).length, 1);
});

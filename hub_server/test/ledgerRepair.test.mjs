import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Repairing a PARTIAL ledger (§4.1): some bills on the hub, the rest only in the cloud. The restore
// refuses that case by design, so without this a short ledger stays short and nobody finds out.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-repair-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { mergeById, byIssuedDesc, bySeqAsc, describeRepair, ledgerGap } = await import('../lib/ledgerRepair.js');
const { invoiceRow } = await import('../lib/invoiceSync.js');
const { reconciliationRow } = await import('../lib/reconciliationSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationStore } = await import('../lib/reconciliationStore.js');

after(async () => {
  // The stores write asynchronously; removing the directory under a pending write is a test bug,
  // not a product one.
  await syncQueue._writeChain;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const bill = (n, over = {}) => ({
  id: `inv_${n}`, restaurant_id: RID, invoice_number: `INV-${String(n).padStart(6, '0')}`,
  table_id: 4, table_name: 'T4', currency: '₹',
  subtotal: 1000, discount_total: 0, subtotal_after_discount: 1000,
  service_charge_percent: 0, service_charge_amount: 0, taxable_base: 1000, tax_total: 50, grand_total: 1050,
  payment_status: 'paid', payment_method: 'cash', paid_at: `2026-10-1${n}T11:00:00.000Z`,
  tickets: [{ id: `t${n}`, ticket_number: n }], ticket_ids: [`t${n}`],
  items: [{ name: 'Dal', qty: 1, line_total: 1000 }], tax_rows: [{ label: 'GST 5%', amount: 50 }], discount_rows: [],
  issued_at: `2026-10-1${n}T10:00:00.000Z`, synced_to_cloud: true, ...over
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

// --- the merge rule --------------------------------------------------------------------------

test('a record the hub already holds is never changed, whatever the cloud says about it', () => {
  const mine = bill(1, { payment_status: 'void', voided_at: '2026-10-11T12:00:00.000Z', void_reason: 'Wrong table' });
  const theirs = bill(1);                                    // the cloud still thinks it is paid
  const { merged, added } = mergeById([mine], [theirs], byIssuedDesc);
  assert.equal(added.length, 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].payment_status, 'void', 'the void stands: the hub is the authority');
});

test('a record only the cloud has is added -- that is the repair', () => {
  const { merged, added } = mergeById([bill(3)], [bill(1), bill(2), bill(3)], byIssuedDesc);
  assert.deepEqual(added.map(b => b.id).sort(), ['inv_1', 'inv_2']);
  assert.equal(merged.length, 3);
});

test('a record only the hub has is kept, not deleted for being absent from the cloud', () => {
  // A bill issued while the hub was offline has not been pushed yet. Treating the cloud as complete
  // would delete a real, unsynced bill.
  const { merged, added } = mergeById([bill(1), bill(9, { synced_to_cloud: false })], [bill(1)], byIssuedDesc);
  assert.equal(added.length, 0);
  assert.deepEqual(merged.map(b => b.id).sort(), ['inv_1', 'inv_9']);
});

test('the merged ledger is in the order the store keeps it', () => {
  const { merged } = mergeById([bill(2)], [bill(1), bill(3)], byIssuedDesc);
  assert.deepEqual(merged.map(b => b.invoice_number), ['INV-000003', 'INV-000002', 'INV-000001'], 'newest first');
  const cash = mergeById([cashup(3)], [cashup(1), cashup(2)], bySeqAsc);
  assert.deepEqual(cash.merged.map(c => c.seq), [1, 2, 3], 'shifts in order');
});

test('a record with no id cannot be matched, so it is left out rather than duplicated blindly', () => {
  const { merged, added } = mergeById([bill(1)], [{ invoice_number: 'INV-000099' }, null, bill(2)], byIssuedDesc);
  assert.deepEqual(added.map(b => b.id), ['inv_2']);
  assert.equal(merged.length, 2);
});

test('nothing on either side is handled without a special case', () => {
  assert.deepEqual(mergeById([], [], byIssuedDesc), { merged: [], added: [] });
  assert.deepEqual(mergeById(undefined, undefined, byIssuedDesc), { merged: [], added: [] });
  assert.equal(mergeById([bill(1)], [], byIssuedDesc).merged.length, 1);
});

// --- what it says it will do -----------------------------------------------------------------

test('a repair that would change nothing says so plainly', () => {
  const d = describeRepair({ invoices: [], cashups: [] });
  assert.equal(d.changed, false);
  assert.match(d.summary, /Nothing is missing/);
});

test('a repair names what it would add, over what range, and that nothing here is touched', () => {
  const d = describeRepair({ invoices: [bill(1), bill(2), bill(3)], cashups: [cashup(1)] });
  assert.equal(d.changed, true);
  assert.match(d.summary, /3 bills \(INV-000001 to INV-000003\)/);
  assert.match(d.summary, /1 cash-up/);
  assert.match(d.summary, /changes nothing that is already here/);
});

test('one of a thing reads as one, not "1 bills"', () => {
  assert.match(describeRepair({ invoices: [bill(5)] }).summary, /1 bill \(INV-000005\)/);
  assert.match(describeRepair({ cashups: [cashup(1), cashup(2)] }).summary, /2 cash-ups/);
});

// --- noticing a gap from counts alone ---------------------------------------------------------

test('a gap is only ever reported when the CLOUD has more -- a hub behind on pushing has none', () => {
  assert.deepEqual(ledgerGap({ localInvoices: 10, cloudInvoices: 14, localCashups: 2, cloudCashups: 2 }), { invoices: 4, cashups: 0, short: true });
  // The hub holds bills it has not pushed. That is the ordinary offline case, not a gap.
  assert.deepEqual(ledgerGap({ localInvoices: 20, cloudInvoices: 14, localCashups: 3, cloudCashups: 1 }), { invoices: 0, cashups: 0, short: false });
  assert.equal(ledgerGap({ localInvoices: 5, cloudInvoices: 5, localCashups: 1, cloudCashups: 1 }).short, false);
  assert.equal(ledgerGap({}).short, false);
});

// --- the real queue against a fake cloud -------------------------------------------------------

function fakeCloud({ invoices = [], cashups = [], failWith = null } = {}) {
  const rows = { invoices: invoices.map(i => invoiceRow(RID, i)), reconciliations: cashups.map(c => reconciliationRow(RID, c)) };
  return {
    from(table) {
      return {
        select: (_cols, opts) => ({
          eq: (col, val) => {
            const matching = rows[table].filter(r => r[col] === val);
            if (opts?.head) return Promise.resolve(failWith ? { count: null, error: failWith } : { count: matching.length, error: null });
            const answer = failWith ? { data: null, error: failWith } : { data: matching, error: null };
            return Object.assign(Promise.resolve(answer), { order: () => Promise.resolve(answer) });
          }
        })
      };
    }
  };
}
const withLedger = ({ local = [], localCashups = [], cloud = [], cloudCashups = [], failWith = null } = {}) => {
  invoiceStore.invoices = local;
  invoiceStore.save();
  reconciliationStore.records = localCashups;
  reconciliationStore.persist();
  syncQueue.cloud = fakeCloud({ invoices: cloud, cashups: cloudCashups, failWith });
  syncQueue.checkConnection = async () => ({ online: true });
};
const quiet = async fn => {
  const w = console.warn, l = console.log;
  console.warn = console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

test('repair: a dry run reports the gap and changes nothing on disk', async () => {
  withLedger({ local: [bill(3)], cloud: [bill(1), bill(2), bill(3)], cloudCashups: [cashup(1)] });
  const result = await quiet(() => syncQueue.repairLedgerFromCloud(RID));

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.deepEqual(result.added, { invoices: 2, cashups: 1 });
  assert.deepEqual(result.invoice_numbers, ['INV-000001', 'INV-000002']);
  assert.equal(invoiceStore.listInvoices(RID).length, 1, 'the ledger is untouched until it is asked for');
});

test('repair: applying it fills the gap and leaves what was already here exactly as it was', async () => {
  const mine = bill(3, { payment_status: 'refunded', refunded_at: '2026-10-13T20:00:00.000Z', refund_reason: 'Spilled' });
  withLedger({ local: [mine], cloud: [bill(1), bill(2), bill(3)], cloudCashups: [cashup(1)] });

  const result = await quiet(() => syncQueue.repairLedgerFromCloud(RID, { apply: true }));
  assert.equal(result.applied, true);

  const ledger = invoiceStore.listInvoices(RID);
  assert.deepEqual(ledger.map(b => b.invoice_number), ['INV-000003', 'INV-000002', 'INV-000001']);
  assert.equal(ledger.find(b => b.id === 'inv_3').payment_status, 'refunded', 'the local refund stands');
  assert.equal(reconciliationStore.list(RID).length, 1);
});

test('repair: numbering continues above the restored bills, so the next bill cannot collide', async () => {
  withLedger({ local: [bill(2)], cloud: [bill(1), bill(2), bill(7)] });
  await quiet(() => syncQueue.repairLedgerFromCloud(RID, { apply: true }));
  // The bill after a repair must clear every restored number, or migration 005's unique index
  // rejects it and those takings never sync.
  assert.equal(invoiceStore.nextInvoiceNumber(RID), 'INV-000008', 'the highest restored number wins, not the count');
});

test('repair: what came from the cloud is already replicated, so the backfill does not push it back', async () => {
  withLedger({ local: [bill(2)], cloud: [bill(1), bill(2)] });
  await quiet(() => syncQueue.repairLedgerFromCloud(RID, { apply: true }));
  syncQueue.saveQueue([]);
  assert.deepEqual(syncQueue.enqueueUnsyncedInvoices(RID), { queued: 0 });
});

test('repair: a hub that is not short is told so, and nothing is written', async () => {
  withLedger({ local: [bill(1), bill(2)], cloud: [bill(1), bill(2)] });
  const result = await quiet(() => syncQueue.repairLedgerFromCloud(RID, { apply: true }));
  assert.equal(result.changed, false);
  assert.equal(result.applied, false, 'there is nothing to apply');
  assert.match(result.summary, /Nothing is missing/);
});

test('repair: offline, unpaired or refused by the cloud, it reports why and touches nothing', async () => {
  withLedger({ local: [bill(1)], cloud: [bill(1), bill(2)] });
  syncQueue.checkConnection = async () => ({ online: false });
  assert.deepEqual(await syncQueue.repairLedgerFromCloud(RID, { apply: true }), { ok: false, reason: 'OFFLINE' });

  syncQueue.checkConnection = async () => ({ online: true });
  assert.deepEqual(await syncQueue.repairLedgerFromCloud(OTHER_RID, { apply: true }), { ok: false, reason: 'NOT_PAIRED' });

  withLedger({ local: [bill(1)], cloud: [bill(1), bill(2)], failWith: { code: '42501', message: 'permission denied for table invoices' } });
  const refused = await quiet(() => syncQueue.repairLedgerFromCloud(RID, { apply: true }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'CLOUD_ERROR');
  assert.equal(invoiceStore.listInvoices(RID).length, 1, 'still exactly what the hub had');
});

test('gap check: a short ledger is noticed, and a hub merely behind on pushing is not', async () => {
  withLedger({ local: [bill(1)], cloud: [bill(1), bill(2), bill(3)], cloudCashups: [cashup(1)] });
  const short = await quiet(() => syncQueue.checkLedgerGap(RID));
  assert.deepEqual(short, { checked: true, invoices: 2, cashups: 1, short: true });

  withLedger({ local: [bill(1), bill(2), bill(3)], cloud: [bill(1)] });
  assert.equal((await quiet(() => syncQueue.checkLedgerGap(RID))).short, false);
});

test('gap check: it never holds up a boot -- offline and a cloud refusal are both soft', async () => {
  withLedger({ local: [bill(1)], cloud: [bill(1), bill(2)] });
  syncQueue.checkConnection = async () => ({ online: false });
  assert.deepEqual(await syncQueue.checkLedgerGap(RID), { checked: false, reason: 'OFFLINE' });

  withLedger({ local: [bill(1)], cloud: [], failWith: { code: 'PGRST301', message: 'JWT expired' } });
  assert.equal((await quiet(() => syncQueue.checkLedgerGap(RID))).checked, false);
});

// --- the routes on a real hub ------------------------------------------------------------------
// This hub has no Supabase project (SUPABASE_URL is the unconfigured placeholder), so the cloud is
// unreachable -- which is the case that must not be mistaken for a healthy ledger.

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

const FIXTURE = {
  menu: { restaurant_id: RESTAURANT_ID, categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] },
  tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
};

test('routes: the ledger check and repair are reception-only, and an unreachable cloud is said so', async () => {
  const reception = await startHub({ trustLoopback: true, ...FIXTURE });
  const stranger = await startHub({ trustLoopback: false, enrollmentCode: 'LEDGER1', ...FIXTURE });
  try {
    const gap = await fetch(`${reception.base}/reconciliation/ledger-gap`);
    assert.equal(gap.status, 200);
    const body = await gap.json();
    assert.equal(body.checked, false, 'it cannot know, and says so rather than reporting no gap');
    assert.equal(body.reason, 'OFFLINE');

    const repair = await fetch(`${reception.base}/reconciliation/ledger-repair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true })
    });
    assert.equal(repair.status, 503);
    const refusal = await repair.json();
    assert.equal(refusal.code, 'OFFLINE');
    assert.match(refusal.error, /cannot reach the internet/);

    // A handset with a valid token is still not reception: this is the owner's financial history.
    const enrolled = await (await fetch(`${stranger.base}/auth/device`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment_code: 'LEDGER1', device_label: 'Handset' })
    })).json();
    for (const token of [undefined, enrolled.device_token]) {
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      assert.ok([401, 403].includes((await fetch(`${stranger.base}/reconciliation/ledger-gap`, { headers })).status));
      assert.ok([401, 403].includes((await fetch(`${stranger.base}/reconciliation/ledger-repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: '{"apply":true}'
      })).status));
    }
  } finally {
    reception.stop();
    stranger.stop();
  }
});

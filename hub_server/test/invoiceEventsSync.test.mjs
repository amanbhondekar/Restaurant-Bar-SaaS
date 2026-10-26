import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Replicating a bill's event history to the cloud (migration 022): the row, the push, the queue, the boot backfill and the restore.
// A throwaway data directory and a fake cloud, with SUPABASE_URL forced to the placeholder so nothing here can reach a real project.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-invoice-events-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { eventRow, eventFromCloud, pushInvoiceEvents, pullInvoiceEvents } = await import('../lib/invoiceEventsSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { invoiceEventStore } = await import('../lib/invoiceEventStore.js');
const { verifyChain } = await import('../lib/invoiceEvents.js');

const EVENTS_FILE = path.join(dataDir, 'invoice_events.jsonl');
const OP = 'SYNC_INVOICE_EVENTS';

const add = (over = {}) => invoiceEventStore.append({
  restaurantId: RID, invoiceRef: 'inv_1', type: 'paid', actor: 'Priya', occurredAt: '2026-10-26T10:00:00.000Z',
  payload: { changes: { payment_status: { from: 'pending', to: 'paid' } } }, ...over
});

function fakeCloud({ fail = false, stored = [] } = {}) {
  const calls = [];
  const rejection = { message: 'permission denied for table invoice_events', code: '42501' };
  return {
    calls,
    from(name) {
      return {
        upsert: async (rows, opts) => {
          if (fail) return { error: rejection };
          calls.push({ table: name, rows, opts });
          return { error: null };
        },
        select() {
          const answer = fail ? { data: null, error: rejection } : { data: stored, error: null };
          const chain = { eq: () => chain, order: () => chain, range: () => chain, then: (ok, no) => Promise.resolve(answer).then(ok, no) };
          return chain;
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
  fs.rmSync(EVENTS_FILE, { force: true });
  invoiceEventStore.reload();
}
const hold = () => { syncQueue.isSyncing = true; };
const release = () => { syncQueue.isSyncing = false; };
const opsOf = () => syncQueue.queue.filter(q => q.type === OP);

// --- the row -------------------------------------------------------------------------------------

test('row: the bill is invoice_hub_ref, the kind is event_type, and the hash chain travels whole', () => {
  reset(fakeCloud());
  const e = add();
  const row = eventRow(RID, e);
  assert.deepEqual(
    [row.restaurant_id, row.invoice_hub_ref, row.seq, row.event_type, row.actor, row.occurred_at, row.prev_hash, row.hash],
    [RID, 'inv_1', 1, 'paid', 'Priya', '2026-10-26T10:00:00.000Z', e.prev_hash, e.hash]
  );
  assert.deepEqual(row.payload, e.payload);
});

test('row: it carries nothing but the cloud\'s columns', () => {
  reset(fakeCloud());
  assert.deepEqual(Object.keys(eventRow(RID, add())).sort(),
    ['actor', 'event_type', 'hash', 'invoice_hub_ref', 'occurred_at', 'payload', 'prev_hash', 'restaurant_id', 'seq', 'synced_at']);
});

test('row: it comes back as the same event, marked as already in the cloud, and still verifies', () => {
  reset(fakeCloud());
  const e = add();
  const back = eventFromCloud({ ...eventRow(RID, e), id: 'uuid-1' });
  assert.deepEqual(back, e);
  assert.equal(verifyChain([back]).ok, true);
});

test('row: an event for a restaurant other than the one named is refused, not relabelled', () => {
  reset(fakeCloud());
  assert.throws(() => eventRow(OTHER_RID, add()), /restaurant/i);
});

// --- the push ------------------------------------------------------------------------------------

test('push: a bill\'s events go up in order, in one call, inserted and never updated', async () => {
  reset(fakeCloud());
  const events = [add(), add({ type: 'refunded' })];
  const cloud = fakeCloud();
  const r = await pushInvoiceEvents(cloud, RID, events);
  assert.equal(cloud.calls.length, 1);
  assert.equal(cloud.calls[0].table, 'invoice_events');
  assert.deepEqual(cloud.calls[0].rows.map(x => x.seq), [1, 2]);
  assert.equal(cloud.calls[0].opts.onConflict, 'restaurant_id,invoice_hub_ref,seq');
  assert.equal(cloud.calls[0].opts.ignoreDuplicates, true);
  assert.deepEqual(r.ids, events.map(e => e.id));
});

test('push: nothing to push is not a call', async () => {
  const cloud = fakeCloud();
  assert.deepEqual((await pushInvoiceEvents(cloud, RID, [])).ids, []);
  assert.equal(cloud.calls.length, 0);
});

test('push: a rejection throws with the cloud code', async () => {
  reset(fakeCloud());
  await assert.rejects(() => pushInvoiceEvents(fakeCloud({ fail: true }), RID, [add()]), err => err.code === '42501');
});

test('pull: reads this tenant\'s events back in the hub\'s own shape, a bill at a time, in order', async () => {
  reset(fakeCloud());
  const a = add(); const b = add({ type: 'refunded' }); const c = add({ invoiceRef: 'inv_2', type: 'voided' });
  const stored = [c, a, b].map((e, i) => ({ ...eventRow(RID, e), id: `u${i}` }));
  const pulled = await pullInvoiceEvents(fakeCloud({ stored }), RID);
  assert.deepEqual(pulled.map(e => e.id), ['inv_1#1', 'inv_1#2', 'inv_2#1']);
  await assert.rejects(() => pullInvoiceEvents(fakeCloud({ fail: true }), RID), err => err.code === '42501');
});

test('row: an event with no actor at all is sent with a null one', () => {
  reset(fakeCloud());
  const { actor: _gone, ...bare } = add();
  assert.equal(eventRow(RID, bare).actor, null);
});

test('pull: more events than one response can hold are all read, a page at a time', async () => {
  const N = 2500;
  const all = Array.from({ length: N }, (_, i) => ({
    id: `u${i}`, restaurant_id: RID, invoice_hub_ref: `inv_${String(i).padStart(5, '0')}`, seq: 1, event_type: 'issued', actor: null,
    occurred_at: '2026-10-26T10:00:00.000Z', payload: {}, prev_hash: '0'.repeat(64), hash: 'a'.repeat(64)
  }));
  const pages = [];
  const cloud = {
    from: () => ({
      select: () => {
        let lo = 0; let hi = Infinity;
        const chain = {
          eq: () => chain, order: () => chain,
          range: (a, b) => { lo = a; hi = b; pages.push([a, b]); return chain; },
          then: (ok, no) => Promise.resolve({ data: all.slice(lo, hi + 1), error: null }).then(ok, no)
        };
        return chain;
      }
    })
  };
  const pulled = await pullInvoiceEvents(cloud, RID);
  assert.equal(pulled.length, N);
  assert.equal(pages.length, 3);
});

// --- the queue -----------------------------------------------------------------------------------

test('queue: a bill\'s events are pushed together and recorded as in the cloud', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  add(); add({ type: 'refunded' });
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  release();
  await syncQueue.processQueue();
  assert.equal(syncQueue.queue.length, 0);
  assert.equal(cloud.calls.length, 1);
  assert.equal(cloud.calls[0].rows.length, 2);
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 0);
});

test('queue: only events the cloud has not confirmed are sent', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  const first = add(); add({ type: 'refunded' });
  invoiceEventStore.markSynced([first.id]);
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  release();
  await syncQueue.processQueue();
  assert.deepEqual(cloud.calls[0].rows.map(r => r.seq), [2]);
});

test('queue: events recorded after the push was queued ride along with it', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  add();
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  add({ type: 'refunded' });
  release();
  await syncQueue.processQueue();
  assert.deepEqual(cloud.calls[0].rows.map(r => r.seq), [1, 2]);
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 0);
});

test('queue: a push the cloud refuses stays queued and the events stay unsynced', async () => {
  reset(fakeCloud({ fail: true }));
  add();
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  release();
  await syncQueue.processQueue();
  assert.equal(opsOf().length, 1);
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 1);
});

test('queue: one push per bill, however many times it is asked for', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  add();
  add({ invoiceRef: 'inv_2' });
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  syncQueue.enqueueInvoiceEvents('inv_1', RID);
  syncQueue.enqueueInvoiceEvents('inv_2', RID);
  release();
  assert.equal(opsOf().length, 2);
});

test('queue: a bill with nothing to send is not queued', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  hold();
  syncQueue.enqueueInvoiceEvents('inv_none', RID);
  release();
  assert.equal(opsOf().length, 0);
});

test('queue: a push left for another tenant is dropped, not written to this one', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  add({ restaurantId: OTHER_RID });
  hold();
  syncQueue.enqueueInvoiceEvents('inv_1', OTHER_RID);
  release();
  await syncQueue.processQueue();
  assert.equal(cloud.calls.length, 0);
  assert.equal(syncQueue.queue.length, 0);
});

test('queue: queueing a bill for the cloud also queues the events behind its change', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  const issued = invoiceStore.issueInvoice({
    tickets: [{ id: 't1', ticket_number: 101, created_at: '2026-10-26T10:00:00.000Z', items: [{ id: 'dal', name: 'Dal', qty: 1, price: 100 }] }],
    tableId: 3, tableName: 'T3', restaurantId: RID, currency: '₹', taxConfig: {}
  });
  hold();
  syncQueue.enqueueInvoice(issued.invoice);
  release();
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_INVOICE').length, 1);
  assert.equal(opsOf().length, 1);
  assert.equal(opsOf()[0].payload.invoice_ref, issued.invoice.id);
});

// --- the backfill --------------------------------------------------------------------------------

test('backfill: every bill with unsent events is queued once, and bills with none are not', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  const a = add({ invoiceRef: 'inv_a' });
  add({ invoiceRef: 'inv_b' });
  add({ invoiceRef: 'inv_c' });
  invoiceEventStore.markSynced([a.id]);
  hold();
  const r = syncQueue.enqueueUnsyncedInvoiceEvents(RID);
  release();
  assert.equal(r.queued, 2);
  assert.deepEqual(opsOf().map(q => q.payload.invoice_ref).sort(), ['inv_b', 'inv_c']);
});

test('backfill: bills from before events are given a baseline first, so they reach the cloud too', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  invoiceStore.invoices = [{ id: 'inv_old', restaurant_id: RID, invoice_number: 'INV-000001', payment_status: 'paid', items: [], tax_rows: [] }];
  hold();
  const r = syncQueue.enqueueUnsyncedInvoiceEvents(RID);
  release();
  assert.equal(r.baselines, 1);
  assert.equal(r.queued, 1);
  assert.equal(invoiceEventStore.list(RID, 'inv_old')[0].type, 'baseline');
});

// --- the restore ---------------------------------------------------------------------------------

test('restore: a replacement laptop gets its bills\' histories back, as already in the cloud', async () => {
  reset(fakeCloud());
  const a = add(); const b = add({ type: 'refunded' });
  const stored = [a, b].map((e, i) => ({ ...eventRow(RID, e), id: `u${i}` }));
  reset(fakeCloud({ stored }));
  const r = await syncQueue.restoreInvoiceEventsFromCloud(RID);
  assert.equal(r.restored, true);
  assert.equal(invoiceEventStore.list(RID, 'inv_1').length, 2);
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 0);
  assert.equal(verifyChain(invoiceEventStore.list(RID, 'inv_1')).ok, true);
});

test('restore: a hub that already holds events is the authority and takes nothing', async () => {
  reset(fakeCloud());
  const stored = [{ ...eventRow(RID, add({ invoiceRef: 'inv_x' })), id: 'u1' }];
  reset(fakeCloud({ stored }));
  add({ invoiceRef: 'inv_other' });
  const r = await syncQueue.restoreInvoiceEventsFromCloud(RID);
  assert.equal(r.restored, false);
  assert.equal(r.reason, 'EVENTS_PRESENT');
  assert.equal(invoiceEventStore.list(RID, 'inv_x').length, 0);
});

test('restore: offline, or a cloud that refuses, leaves the store empty and says why', async () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  assert.equal((await syncQueue.restoreInvoiceEventsFromCloud(RID)).reason, 'OFFLINE');
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.cloud = fakeCloud({ fail: true });
  assert.equal((await syncQueue.restoreInvoiceEventsFromCloud(RID)).reason, 'CLOUD_ERROR');
  assert.equal(invoiceEventStore.isEmpty(RID), true);
});

test('restore: a restaurant that is not this hub\'s is refused', async () => {
  reset(fakeCloud());
  assert.equal((await syncQueue.restoreInvoiceEventsFromCloud(OTHER_RID)).reason, 'NOT_PAIRED');
});

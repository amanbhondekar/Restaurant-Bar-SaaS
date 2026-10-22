import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guest feedback replication (migration 013): the row, the push, the queue, the boot backfill and the restore.
// A throwaway data directory and a fake cloud, with SUPABASE_URL forced to the placeholder so nothing here can
// reach a real project.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER_RID = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-feedback-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { feedbackRow, feedbackFromCloud, pushFeedback, pullFeedback } = await import('../lib/feedbackSync.js');
const { syncQueue } = await import('../lib/syncQueue.js');
const { feedbackStore } = await import('../lib/feedbackStore.js');

const entry = (over = {}) => ({
  id: 'fb_a_1', restaurant_id: RID, table: 'T4', rating: 4, comment: 'Lovely dal', invoice_number: 'INV-000007', invoice_id: 'inv_7',
  created_at: '2026-10-22T13:00:00.000Z', synced_to_cloud: false, ...over
});

function fakeCloud({ fail = false, stored = [] } = {}) {
  const rows = [];
  const rejection = { message: 'permission denied for table guest_feedback', code: '42501' };
  return {
    rows,
    from(name) {
      return {
        upsert: async (part, opts) => {
          if (fail) return { error: rejection };
          rows.push({ table: name, part, opts });
          return { error: null };
        },
        select() {
          const answer = fail ? { data: null, error: rejection } : { data: stored, error: null };
          const chain = { eq: () => chain, order: () => chain, then: (ok, no) => Promise.resolve(answer).then(ok, no) };
          return chain;
        }
      };
    }
  };
}

function reset(cloud, entries = []) {
  syncQueue.saveQueue([]);
  fs.writeFileSync(path.join(dataDir, 'quarantine_sync_queue.json'), '[]');
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
  syncQueue.cloud = cloud;
  feedbackStore.entries = entries;
  feedbackStore.save();
}
const hold = () => { syncQueue.isSyncing = true; };
const release = () => { syncQueue.isSyncing = false; };

// --- the row -------------------------------------------------------------------------------------

test('row: the hub id is hub_ref, the table is table_label, and the bill the hub stamped is carried', () => {
  const row = feedbackRow(RID, entry());
  assert.deepEqual(
    [row.restaurant_id, row.hub_ref, row.rating, row.comment, row.table_label, row.invoice_number, row.invoice_ref, row.created_at],
    [RID, 'fb_a_1', 4, 'Lovely dal', 'T4', 'INV-000007', 'inv_7', '2026-10-22T13:00:00.000Z']
  );
});

test('row: feedback about the place, with no table, no bill and no comment, carries nulls rather than gaps', () => {
  const row = feedbackRow(RID, entry({ table: null, comment: null, invoice_number: null, invoice_id: null }));
  assert.deepEqual([row.table_label, row.comment, row.invoice_number, row.invoice_ref], [null, null, null, null]);
});

test('row: nothing about the guest travels, because nothing about the guest is kept', () => {
  const row = feedbackRow(RID, entry({ name: 'Asha', phone: '9876543210', ip: '10.0.0.4' }));
  assert.deepEqual(Object.keys(row).sort(), ['comment', 'created_at', 'hub_ref', 'invoice_number', 'invoice_ref', 'rating', 'restaurant_id', 'synced_at', 'table_label']);
});

test('row: it comes back as the same entry, marked as already in the cloud', () => {
  const back = feedbackFromCloud({ ...feedbackRow(RID, entry()), id: 'uuid-1' });
  assert.deepEqual(back, { ...entry(), synced_to_cloud: true });
});

// --- the push ------------------------------------------------------------------------------------

test('push: an entry is inserted and never updated -- a guest\'s statement is not edited', async () => {
  const cloud = fakeCloud();
  await pushFeedback(cloud, RID, entry());
  assert.equal(cloud.rows[0].table, 'guest_feedback');
  assert.equal(cloud.rows[0].opts.onConflict, 'restaurant_id,hub_ref');
  assert.equal(cloud.rows[0].opts.ignoreDuplicates, true);   // the table has no UPDATE grant: a retry must be a no-op
});

test('push: a rejection throws with the cloud code', async () => {
  await assert.rejects(() => pushFeedback(fakeCloud({ fail: true }), RID, entry()), err => err.code === '42501');
});

test('pull: reads this tenant\'s entries back in the hub\'s own shape, and skips a row with no hub_ref', async () => {
  const stored = [{ ...feedbackRow(RID, entry()), id: 'u1' }, { ...feedbackRow(RID, entry({ id: 'fb_x' })), id: 'u2', hub_ref: null }];
  const pulled = await pullFeedback(fakeCloud({ stored }), RID);
  assert.deepEqual(pulled.map(e => e.id), ['fb_a_1']);
  await assert.rejects(() => pullFeedback(fakeCloud({ fail: true }), RID), err => err.code === '42501');
});

// --- the store -----------------------------------------------------------------------------------

test('store: a new entry starts as not yet in the cloud, and is marked once it is', () => {
  reset(fakeCloud());
  const added = feedbackStore.add({ restaurantId: RID, table: 'T1', rating: 5, comment: 'x' });
  assert.equal(added.synced_to_cloud, false);
  assert.equal(feedbackStore.listUnsynced(RID).length, 1);
  assert.equal(feedbackStore.markSynced(added.id, RID), true);
  assert.equal(feedbackStore.markSynced(added.id, RID), false, 'already marked');
  assert.equal(feedbackStore.listUnsynced(RID).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'feedback.json'), 'utf-8'))[0].synced_to_cloud, true, 'on disk');
});

test('store: another restaurant\'s entry is neither listed as unsynced nor marked', () => {
  reset(fakeCloud(), [entry({ restaurant_id: OTHER_RID })]);
  assert.equal(feedbackStore.listUnsynced(RID).length, 0);
  assert.equal(feedbackStore.markSynced('fb_a_1', RID), false);
});

// --- the queue -----------------------------------------------------------------------------------

test('queue: an entry is pushed and recorded as synced on disk', async () => {
  const cloud = fakeCloud();
  reset(cloud, [entry()]);
  hold();
  syncQueue.enqueueFeedback(entry());
  release();
  await syncQueue.processQueue();
  assert.equal(syncQueue.queue.length, 0);
  assert.equal(cloud.rows.length, 1);
  assert.equal(feedbackStore.entries[0].synced_to_cloud, true);
});

test('queue: a push the cloud refuses stays queued and the entry stays unsynced', async () => {
  const cloud = fakeCloud({ fail: true });
  reset(cloud, [entry()]);
  hold();
  syncQueue.enqueueFeedback(entry());
  release();
  await syncQueue.processQueue();
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_FEEDBACK').length, 1);
  assert.equal(feedbackStore.entries[0].synced_to_cloud, false);
});

test('queue: the same entry is never queued twice', () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  hold();
  syncQueue.enqueueFeedback(entry());
  syncQueue.enqueueFeedback(entry());
  release();
  assert.equal(syncQueue.queue.filter(q => q.type === 'SYNC_FEEDBACK').length, 1);
});

test('queue: an entry left for another tenant is dropped, not written to this one', async () => {
  const cloud = fakeCloud();
  reset(cloud);
  hold();
  syncQueue.enqueueFeedback(entry({ restaurant_id: OTHER_RID }));
  release();
  await syncQueue.processQueue();
  assert.equal(cloud.rows.length, 0);
  assert.equal(syncQueue.queue.length, 0);
});

// --- the backfill --------------------------------------------------------------------------------

test('backfill: feedback from before migration 013 -- no flag at all -- is carried up, oldest first', () => {
  reset(fakeCloud(), [
    entry({ id: 'fb_1', synced_to_cloud: undefined }),
    entry({ id: 'fb_2', synced_to_cloud: true }),
    entry({ id: 'fb_3' })
  ]);
  syncQueue.checkConnection = async () => ({ online: false });
  hold();
  const result = syncQueue.enqueueUnsyncedFeedback(RID);
  release();
  assert.equal(result.queued, 2);
  assert.deepEqual(syncQueue.queue.filter(q => q.type === 'SYNC_FEEDBACK').map(q => q.payload.entry.id), ['fb_1', 'fb_3']);
});

test('backfill: a fully replicated store, and another tenant\'s entries, queue nothing', () => {
  reset(fakeCloud(), [entry({ synced_to_cloud: true }), entry({ id: 'fb_o', restaurant_id: OTHER_RID })]);
  assert.equal(syncQueue.enqueueUnsyncedFeedback(RID).queued, 0);
  assert.equal(syncQueue.queue.length, 0);
});

// --- the restore ---------------------------------------------------------------------------------

test('restore: a hub with no feedback gets its ratings back, already marked as replicated', async () => {
  const stored = [{ ...feedbackRow(RID, entry()), id: 'u1' }, { ...feedbackRow(RID, entry({ id: 'fb_b', rating: 2, comment: 'Slow' })), id: 'u2' }];
  reset(fakeCloud({ stored }));
  const result = await syncQueue.restoreFeedbackFromCloud(RID);
  assert.deepEqual([result.restored, result.count], [true, 2]);
  assert.deepEqual(feedbackStore.list(RID).map(e => e.id).sort(), ['fb_a_1', 'fb_b']);
  assert.equal(feedbackStore.listUnsynced(RID).length, 0, 'so the backfill that follows pushes none of it back');
});

test('restore: a hub that already holds feedback is left alone, and the cloud is not even asked', async () => {
  let asked = false;
  const cloud = fakeCloud({ stored: [{ ...feedbackRow(RID, entry({ id: 'fb_cloud' })), id: 'u9' }] });
  const from = cloud.from.bind(cloud);
  cloud.from = name => { asked = true; return from(name); };
  reset(cloud, [entry({ id: 'fb_local' })]);
  const result = await syncQueue.restoreFeedbackFromCloud(RID);
  assert.deepEqual([result.restored, result.reason], [false, 'FEEDBACK_PRESENT']);
  assert.equal(asked, false);
  assert.deepEqual(feedbackStore.list(RID).map(e => e.id), ['fb_local']);
});

test('restore: it does not run offline, for another tenant, or when the cloud errors, and never throws', async () => {
  reset(fakeCloud());
  syncQueue.checkConnection = async () => ({ online: false });
  assert.equal((await syncQueue.restoreFeedbackFromCloud(RID)).reason, 'OFFLINE');
  assert.equal((await syncQueue.restoreFeedbackFromCloud(OTHER_RID)).reason, 'NOT_PAIRED');

  reset(fakeCloud({ fail: true }));
  assert.equal((await syncQueue.restoreFeedbackFromCloud(RID)).reason, 'CLOUD_ERROR');
  assert.equal(feedbackStore.entries.length, 0);

  reset(fakeCloud({ stored: [] }));
  assert.equal((await syncQueue.restoreFeedbackFromCloud(RID)).reason, 'NOTHING_IN_CLOUD');
});

test('restore: entries for another restaurant in the cloud answer are not taken in', async () => {
  reset(fakeCloud({ stored: [{ ...feedbackRow(OTHER_RID, entry({ id: 'fb_o' })), id: 'u1' }] }));
  const result = await syncQueue.restoreFeedbackFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(feedbackStore.entries.length, 0);
});

test('restore: a guest who answers while the cloud is being read keeps the hub\'s own record, and nothing is merged in', async () => {
  const stored = [{ ...feedbackRow(RID, entry({ id: 'fb_cloud' })), id: 'u1' }];
  const cloud = fakeCloud({ stored });
  reset(cloud);
  // The cloud answers, but by then someone has left feedback on this hub.
  const from = cloud.from.bind(cloud);
  cloud.from = name => {
    const t = from(name);
    const select = t.select.bind(t);
    t.select = () => { feedbackStore.add({ restaurantId: RID, table: 'T2', rating: 5, comment: 'new' }); return select(); };
    return t;
  };
  const result = await syncQueue.restoreFeedbackFromCloud(RID);
  assert.equal(result.restored, false);
  assert.equal(feedbackStore.entries.length, 1, 'the live entry is the only one: the hub is the authority');
  assert.equal(feedbackStore.entries[0].comment, 'new');
});

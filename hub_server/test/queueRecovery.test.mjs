import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What happens to a queue file that will not parse. This is the file holding orders and bills
// that never reached the cloud, so the old behaviour -- warn, return an empty queue, overwrite on
// the next save -- destroyed a restaurant's unsent takings on a single torn write.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-recover-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { salvageQueue, syncQueue } = await import('../lib/syncQueue.js');

const QUEUE_FILE = path.join(dataDir, 'sync_queue.json');

const item = (n, type = 'CREATE_ORDER') => ({
  queue_id: `q_${n}`,
  type,
  ticket: { id: `t${n}`, ticket_number: 900 + n, total_amount: 100 * n },
  queued_at: '2026-10-14T10:00:00.000Z',
  attempts: 0
});

/** The file exactly as saveQueue writes it. */
const written = items => JSON.stringify(items, null, 2);

const corruptFiles = () => fs.readdirSync(dataDir).filter(f => f.startsWith('sync_queue.corrupt-'));

function clean() {
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { force: true });
}

// --- salvage, as a pure function ---------------------------------------------------------------

test('salvage: a file cut off mid-entry keeps every entry that was complete', () => {
  const full = written([item(1), item(2), item(3)]);
  // A crash during the write leaves the leading bytes only.
  const torn = full.slice(0, full.indexOf('"q_3"') + 4);

  const recovered = salvageQueue(torn);
  assert.equal(recovered.length, 2, 'the two complete entries survive');
  assert.deepEqual(recovered.map(q => q.queue_id), ['q_1', 'q_2']);
  assert.equal(recovered[1].ticket.ticket_number, 902, 'and they are intact, not just counted');
});

test('salvage: a file cut off before the first entry closes recovers nothing', () => {
  const full = written([item(1), item(2)]);
  const torn = full.slice(0, 20);
  assert.equal(salvageQueue(torn), null);
});

test('salvage: truncation exactly on an entry boundary loses nothing', () => {
  const full = written([item(1), item(2), item(3)]);
  const torn = full.slice(0, full.lastIndexOf('\n  },') + 4);
  const recovered = salvageQueue(torn);
  assert.equal(recovered.length, 2);
});

test('salvage: a single complete entry is recovered', () => {
  const full = written([item(1), item(2)]);
  const torn = full.slice(0, full.indexOf('"q_2"'));
  const recovered = salvageQueue(torn);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].queue_id, 'q_1');
});

test('salvage: nonsense in, null out -- never a half-built object', () => {
  assert.equal(salvageQueue(''), null);
  assert.equal(salvageQueue('not json at all'), null);
  assert.equal(salvageQueue(null), null);
  assert.equal(salvageQueue(undefined), null);
  assert.equal(salvageQueue('{ "not": "a list" }'), null);
});

// --- the load path -----------------------------------------------------------------------------

test('load: a healthy queue file is read as it always was', () => {
  clean();
  fs.writeFileSync(QUEUE_FILE, written([item(1), item(2)]), 'utf-8');
  const loaded = syncQueue.loadQueue();
  assert.equal(loaded.length, 2);
  assert.equal(corruptFiles().length, 0, 'nothing was set aside');
});

test('load: a missing file is an empty queue, not a recovery', () => {
  clean();
  assert.deepEqual(syncQueue.loadQueue(), []);
  assert.equal(corruptFiles().length, 0);
});

test('load: a torn file is salvaged AND the original is kept for recovery by hand', () => {
  clean();
  const full = written([item(1), item(2), item(3)]);
  const torn = full.slice(0, full.indexOf('"q_3"') + 4);
  fs.writeFileSync(QUEUE_FILE, torn, 'utf-8');

  const loaded = syncQueue.loadQueue();
  assert.equal(loaded.length, 2, 'the complete orders are back in the queue');

  const kept = corruptFiles();
  assert.equal(kept.length, 1, 'the file as found is preserved');
  assert.equal(fs.readFileSync(path.join(dataDir, kept[0]), 'utf-8'), torn,
    'byte for byte, so the lost tail can still be read by a human');
});

test('load: an unsalvageable file still preserves what was there instead of discarding it', () => {
  clean();
  fs.writeFileSync(QUEUE_FILE, '[ this is not json', 'utf-8');

  const loaded = syncQueue.loadQueue();
  assert.deepEqual(loaded, [], 'nothing could be recovered');
  assert.equal(corruptFiles().length, 1, 'but the evidence is kept, not overwritten');
});

test('load: a file holding something other than a list is treated as corrupt, not trusted', () => {
  clean();
  // Valid JSON, wrong shape. The old code returned it and every consumer then misbehaved.
  fs.writeFileSync(QUEUE_FILE, '{"queue_id":"q_1"}', 'utf-8');

  assert.deepEqual(syncQueue.loadQueue(), []);
  assert.equal(corruptFiles().length, 1);
});

test('load: each recovery is kept separately rather than overwriting the last', () => {
  clean();
  fs.writeFileSync(QUEUE_FILE, '[ broken', 'utf-8');
  syncQueue.loadQueue();
  // A distinct timestamp is not guaranteed within the same millisecond, so write a different
  // body and assert on the count of distinct files rather than on the names.
  fs.writeFileSync(QUEUE_FILE, '[ broken differently', 'utf-8');
  syncQueue.loadQueue();
  assert.ok(corruptFiles().length >= 1, 'at least one preserved copy exists');
});

// --- the coupling between writer and salvager --------------------------------------------------

// salvageQueue depends on the exact shape saveQueue writes (entries at two-space indent). If that
// write is ever changed to compact JSON, salvage silently stops recovering anything and the old
// total-loss behaviour returns. This ties the two together so that change breaks a test instead.
test('salvage: the boundary it relies on is the one saveQueue actually writes', async () => {
  clean();
  syncQueue.saveQueue([item(1), item(2)]);
  await syncQueue._writeChain;

  const onDisk = fs.readFileSync(QUEUE_FILE, 'utf-8');
  assert.ok(onDisk.includes('\n  }'), 'saveQueue must keep writing entries at two-space indent');

  // And the round trip holds on what it really wrote, not on a hand-built string.
  const torn = onDisk.slice(0, onDisk.indexOf('"q_2"'));
  const recovered = salvageQueue(torn);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].queue_id, 'q_1');
});

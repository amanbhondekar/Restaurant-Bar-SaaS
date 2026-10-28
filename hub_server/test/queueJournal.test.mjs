import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeRecord, lastCompleteRecord, countRecords } from '../lib/queueJournal.js';

// The queue's write surviving a crash (§4.1). The rules first, then the real SyncQueue against each
// of the places a crash can land.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-journal-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
const QUEUE_FILE = path.join(dataDir, 'sync_queue.json');
const JOURNAL = path.join(dataDir, 'sync_queue.wal');

const { syncQueue } = await import('../lib/syncQueue.js');

const item = n => ({ queue_id: `q_${n}`, type: 'CREATE_ORDER', ticket: { id: `t${n}`, ticket_number: 100 + n, total_amount: n * 10 }, attempts: 0 });
const reset = () => {
  for (const f of [QUEUE_FILE, JOURNAL]) fs.rmSync(f, { force: true });
};
const quiet = async fn => {
  const w = console.warn, e = console.error;
  console.warn = console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

// --- the rules -------------------------------------------------------------------------------

test('a record round-trips, and carries when it was committed', () => {
  const raw = encodeRecord([item(1), item(2)]);
  assert.ok(raw.endsWith('\n'), 'one line, newline-terminated');
  const back = lastCompleteRecord(raw);
  assert.deepEqual(back.queue.map(q => q.queue_id), ['q_1', 'q_2']);
  assert.match(back.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a record never contains a raw newline, whatever is inside the queue', () => {
  const raw = encodeRecord([{ ...item(1), note: 'line one\nline two\r\nand three' }]);
  assert.equal(raw.split('\n').length, 2, 'the only newline is the separator');
  assert.equal(lastCompleteRecord(raw).queue[0].note, 'line one\nline two\r\nand three');
});

test('the newest complete state wins, because every line is a whole state', () => {
  const raw = encodeRecord([item(1)]) + encodeRecord([item(1), item(2)]) + encodeRecord([item(3)]);
  assert.deepEqual(lastCompleteRecord(raw).queue.map(q => q.queue_id), ['q_3']);
  assert.equal(countRecords(raw), 3);
});

test('a line torn by a crash is skipped for the whole state before it', () => {
  const good = encodeRecord([item(1), item(2)]);
  const torn = encodeRecord([item(3)]).slice(0, 40);        // the hub died mid-append
  const back = lastCompleteRecord(good + torn);
  assert.deepEqual(back.queue.map(q => q.queue_id), ['q_1', 'q_2'], 'the last committed state');
  assert.equal(countRecords(good + torn), 1);
});

test('an empty queue is a state like any other -- it is not "nothing to recover"', () => {
  const raw = encodeRecord([item(1)]) + encodeRecord([]);
  assert.deepEqual(lastCompleteRecord(raw).queue, [], 'everything drained, and that is committed');
});

test('nothing usable gives null rather than an empty queue, so the snapshot is still consulted', () => {
  assert.equal(lastCompleteRecord(''), null);
  assert.equal(lastCompleteRecord('\n\n'), null);
  assert.equal(lastCompleteRecord('{ cut off mid-record'), null);
  assert.equal(lastCompleteRecord(null), null);
  assert.equal(lastCompleteRecord(undefined), null);
  assert.equal(countRecords(''), 0);
});

test('a line that parses but is not a queue state is not mistaken for one', () => {
  assert.equal(lastCompleteRecord('{"at":"2026-01-01","queue":"not a list"}\n'), null);
  assert.equal(lastCompleteRecord('{"at":"2026-01-01","queue":[null,3]}\n'), null);
  assert.equal(lastCompleteRecord('"just a string"\n'), null);
  // ...but a good line further up is still found.
  const raw = encodeRecord([item(1)]) + '{"queue":"not a list"}\n';
  assert.deepEqual(lastCompleteRecord(raw).queue.map(q => q.queue_id), ['q_1']);
});

// --- the real queue, at each place a crash can land ------------------------------------------

test('in the ordinary case the journal is emptied, so it does not grow', async () => {
  reset();
  syncQueue.saveQueue([item(1)]);
  syncQueue.saveQueue([item(1), item(2)]);
  await syncQueue._writeChain;

  assert.equal(fs.readFileSync(JOURNAL, 'utf-8'), '', 'nothing left to protect once the snapshot is written');
  assert.deepEqual(JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')).map(q => q.queue_id), ['q_1', 'q_2']);
});

test('CRASH DURING THE SNAPSHOT: the state is recovered from the journal -- this is the bug fixed', async () => {
  reset();
  // The hub committed two items, then died with the snapshot half written. The old file is
  // destroyed before the new one is complete, which is exactly what makes an overwrite unsafe.
  fs.writeFileSync(JOURNAL, encodeRecord([item(1), item(2)]), 'utf-8');
  fs.writeFileSync(QUEUE_FILE, '[\n  {\n    "queue_id": "q_1",\n    "type": "CREA', 'utf-8');

  const recovered = await quiet(() => syncQueue.loadQueue());
  assert.deepEqual(recovered.map(q => q.queue_id), ['q_1', 'q_2'], 'both items survive');
  assert.equal(recovered[1].ticket.total_amount, 20, 'and they are whole, not half-parsed');
});

test('CRASH DURING THE SNAPSHOT, on an empty journal line: the snapshot is salvaged as before', async () => {
  reset();
  // No journal at all (a hub from before this change, or one whose journal was lost). The older
  // salvage path still recovers the complete leading entries rather than answering with nothing.
  const written = JSON.stringify([item(1), item(2)], null, 2);
  fs.writeFileSync(QUEUE_FILE, written.slice(0, written.lastIndexOf('\n  }') + 4) + '\n  {\n    "queue_', 'utf-8');

  const recovered = await quiet(() => syncQueue.loadQueue());
  assert.ok(recovered.length >= 1, 'something is recovered rather than the file being thrown away');
  assert.equal(recovered[0].queue_id, 'q_1');
  assert.ok(fs.readdirSync(dataDir).some(f => f.startsWith('sync_queue.corrupt-')), 'and the file as found is kept');
});

test('CRASH BETWEEN COMMIT AND SNAPSHOT: the journal is ahead, and it wins', async () => {
  reset();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify([item(1)], null, 2), 'utf-8');     // yesterday's state
  fs.writeFileSync(JOURNAL, encodeRecord([item(1), item(2), item(3)]), 'utf-8'); // committed, never snapshotted

  const recovered = await quiet(() => syncQueue.loadQueue());
  assert.deepEqual(recovered.map(q => q.queue_id), ['q_1', 'q_2', 'q_3']);
});

test('CRASH DURING THE JOURNAL APPEND: the torn line is ignored and nothing is lost', async () => {
  reset();
  const committed = encodeRecord([item(1), item(2)]);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify([item(1), item(2)], null, 2), 'utf-8');
  fs.writeFileSync(JOURNAL, committed + encodeRecord([item(1), item(2), item(3)]).slice(0, 30), 'utf-8');

  const recovered = await quiet(() => syncQueue.loadQueue());
  assert.deepEqual(recovered.map(q => q.queue_id), ['q_1', 'q_2'], 'the save that was in flight simply did not happen');
});

test('CRASH AFTER THE SNAPSHOT: journal and snapshot agree, so either answer is the same', async () => {
  reset();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify([item(7)], null, 2), 'utf-8');
  fs.writeFileSync(JOURNAL, encodeRecord([item(7)]), 'utf-8');     // not yet truncated
  assert.deepEqual((await quiet(() => syncQueue.loadQueue())).map(q => q.queue_id), ['q_7']);
});

test('a clean hub with neither file starts with an empty queue, not an error', async () => {
  reset();
  assert.deepEqual(await quiet(() => syncQueue.loadQueue()), []);
});

test('a drained queue stays drained across a crash: the journal does not resurrect sent work', async () => {
  reset();
  // The last thing the hub committed was "everything went". If the journal were only consulted for
  // non-empty states, a crash would put already-synced orders back and push them to the cloud twice.
  fs.writeFileSync(QUEUE_FILE, JSON.stringify([item(1), item(2)], null, 2), 'utf-8');
  fs.writeFileSync(JOURNAL, encodeRecord([item(1), item(2)]) + encodeRecord([]), 'utf-8');
  assert.deepEqual(await quiet(() => syncQueue.loadQueue()), []);
});

test('the queue survives a save and a reload with everything it was carrying', async () => {
  reset();
  const invoice = { queue_id: 'q_inv', type: 'SYNC_INVOICE', payload: { restaurant_id: 'r', invoice: { id: 'inv_1', grand_total: 992.25, items: [{ name: 'Dal', qty: 1 }] } }, attempts: 2 };
  syncQueue.saveQueue([item(1), invoice]);
  await syncQueue._writeChain;

  const reloaded = await quiet(() => syncQueue.loadQueue());
  assert.deepEqual(reloaded[1].payload.invoice, invoice.payload.invoice, 'a bill comes back exactly as it went in');
  assert.equal(reloaded[1].attempts, 2, 'including how many times it has been tried');
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

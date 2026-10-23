import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendRecord, fsyncEnabled, SLOW_SYNC_MS } from '../lib/queueJournal.js';

// A power cut. The journal (lib/queueJournal.js) survives a crash of the program, but a power cut can still lose an
// append the operating system had buffered and never written. Syncing the journal closes that. It was once refused
// because syncing the big snapshot cost seconds on the order path; the journal line is small, the write chain is not
// on the order path (saveQueue returns at once), and what it costs is measured below rather than assumed.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-fsync-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
const JOURNAL = path.join(dataDir, 'sync_queue.wal');
after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** A stand-in for fs.promises that records what was done to the file, in order. */
function fakeFsp({ syncError } = {}) {
  const log = [];
  return {
    log,
    appendFile: async (file, data) => { log.push(['appendFile', file, data]); },
    open: async (file, flags) => {
      log.push(['open', file, flags]);
      return {
        appendFile: async data => { log.push(['handle.appendFile', data]); },
        sync: async () => { log.push(['handle.sync']); if (syncError) throw syncError; },
        close: async () => { log.push(['handle.close']); }
      };
    }
  };
}

// --- the rule ----------------------------------------------------------------------------------------

test('the record is appended and then synced to disk, on the one handle, and the handle is always closed', async () => {
  const fsp = fakeFsp();
  await appendRecord('/x/j.wal', 'RECORD\n', { fsp });
  assert.deepEqual(fsp.log.map(e => e[0]), ['open', 'handle.appendFile', 'handle.sync', 'handle.close']);
  assert.equal(fsp.log[0][2], 'a', 'opened for append: it never touches bytes already on disk');
  assert.equal(fsp.log[1][1], 'RECORD\n');
});

test('with syncing off it is the plain append it always was, and nothing is opened', async () => {
  const fsp = fakeFsp();
  await appendRecord('/x/j.wal', 'RECORD\n', { fsp, fsync: false });
  assert.deepEqual(fsp.log.map(e => e[0]), ['appendFile']);
});

test('a filesystem that refuses to sync does not lose the write: the record is still appended, and the error is reported', async () => {
  const fsp = fakeFsp({ syncError: Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' }) });
  const seen = [];
  await appendRecord('/x/j.wal', 'RECORD\n', { fsp, onSyncError: e => seen.push(e.code) });
  assert.deepEqual(fsp.log.map(e => e[0]), ['open', 'handle.appendFile', 'handle.sync', 'handle.close']);
  assert.deepEqual(seen, ['EINVAL']);
});

test('a failed append is still a failure, and still closes the handle', async () => {
  const fsp = fakeFsp();
  const open = fsp.open;
  fsp.open = async (...a) => { const h = await open(...a); h.appendFile = async () => { throw new Error('ENOSPC'); }; return h; };
  await assert.rejects(() => appendRecord('/x/j.wal', 'R\n', { fsp }), /ENOSPC/);
  assert.ok(fsp.log.some(e => e[0] === 'handle.close'));
});

test('it reports how long the sync took, and none when there was none', async () => {
  const synced = await appendRecord('/x/j.wal', 'R\n', { fsp: fakeFsp() });
  assert.equal(typeof synced.syncMs, 'number');
  assert.ok(synced.syncMs >= 0);
  assert.equal((await appendRecord('/x/j.wal', 'R\n', { fsp: fakeFsp(), fsync: false })).syncMs, null);
});

test('syncing is on unless it is switched off: 0, false and off turn it off, nothing else does', () => {
  assert.equal(fsyncEnabled({}), true);
  assert.equal(fsyncEnabled({ HUB_QUEUE_FSYNC: '1' }), true);
  assert.equal(fsyncEnabled({ HUB_QUEUE_FSYNC: 'yes' }), true);
  assert.equal(fsyncEnabled({ HUB_QUEUE_FSYNC: '' }), true);
  for (const off of ['0', 'false', 'FALSE', 'off', ' Off ']) assert.equal(fsyncEnabled({ HUB_QUEUE_FSYNC: off }), false, JSON.stringify(off));
});

test('a sync slower than a quarter of a second is called slow', () => {
  assert.equal(SLOW_SYNC_MS, 250);
});

// --- the real thing ----------------------------------------------------------------------------------------

test('a real file ends up holding exactly the records appended, whether or not they were synced', async () => {
  const file = path.join(dataDir, 'direct.wal');
  await appendRecord(file, 'one\n');
  await appendRecord(file, 'two\n', { fsync: false });
  await appendRecord(file, 'three\n');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'one\ntwo\nthree\n');
});

const { syncQueue } = await import('../lib/syncQueue.js');
const item = n => ({ queue_id: `q_${n}`, type: 'CREATE_ORDER', ticket: { id: `t${n}`, ticket_number: 100 + n, total_amount: n * 10 }, attempts: 0 });

test('the real queue syncs its journal on every save, before it touches the snapshot, and the save still returns at once', async () => {
  const events = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  const realWrite = fs.promises.writeFile.bind(fs.promises);
  mock.method(fs.promises, 'open', async (file, flags) => {
    const handle = await realOpen(file, flags);
    if (path.basename(String(file)) === 'sync_queue.wal') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push('journal.sync'); return sync(); };
    }
    return handle;
  });
  mock.method(fs.promises, 'writeFile', async (file, ...rest) => {
    if (path.basename(String(file)) === 'sync_queue.json') events.push('snapshot.write');
    return realWrite(file, ...rest);
  });
  try {
    const started = Date.now();
    syncQueue.saveQueue([item(1)]);
    const returnedAfter = Date.now() - started;
    await syncQueue._writeChain;

    assert.deepEqual(events, ['journal.sync', 'snapshot.write'], 'durable first, readable second');
    assert.ok(returnedAfter < 50, `saveQueue did not wait for the disk (${returnedAfter}ms)`);
    assert.equal(fs.readFileSync(JOURNAL, 'utf-8'), '', 'and the journal is still emptied afterwards');
  } finally {
    mock.restoreAll();
  }
});

test('the real queue can be told not to sync', async () => {
  process.env.HUB_QUEUE_FSYNC = '0';
  const opened = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  mock.method(fs.promises, 'open', async (file, flags) => { opened.push(path.basename(String(file))); return realOpen(file, flags); });
  try {
    syncQueue.saveQueue([item(2)]);
    await syncQueue._writeChain;
    assert.equal(opened.includes('sync_queue.wal'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'sync_queue.json'), 'utf-8')).map(q => q.queue_id), ['q_2']);
  } finally {
    delete process.env.HUB_QUEUE_FSYNC;
    mock.restoreAll();
  }
});

test('what a sync costs here, measured: a hundred journal appends, with and without', async () => {
  const file = path.join(dataDir, 'cost.wal');
  const record = 'x'.repeat(4000) + '\n';
  const time = async opts => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) await appendRecord(file, record, opts);
    return Number(process.hrtime.bigint() - t) / 1e6 / 100;
  };
  const plain = await time({ fsync: false });
  const synced = await time({ fsync: true });
  console.log(`# journal append: ${plain.toFixed(2)} ms plain, ${synced.toFixed(2)} ms synced (mean of 100, 4 KB)`);
  // A generous ceiling, not a benchmark: it fails only if syncing has become the multi-second cost that got the
  // snapshot version reverted, and it is the number to read when someone asks what this costs on their disk.
  assert.ok(synced < 250, `a synced journal append took ${synced.toFixed(1)} ms on average`);
});

// --- saying so when the disk is the problem ---------------------------------------------------------------

/** Runs `n` saves with the journal's sync replaced, collecting what the queue printed as warnings. */
async function savesWithSync(syncImpl, n = 2) {
  const warnings = [];
  const realOpen = fs.promises.open.bind(fs.promises);
  mock.method(fs.promises, 'open', async (file, flags) => {
    const handle = await realOpen(file, flags);
    if (path.basename(String(file)) === 'sync_queue.wal') handle.sync = syncImpl;
    return handle;
  });
  mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  syncQueue._lastJournalWarning = 0;
  try {
    for (let i = 1; i <= n; i++) { syncQueue.saveQueue([item(i)]); await syncQueue._writeChain; }
  } finally {
    mock.restoreAll();
  }
  return warnings.filter(w => /sync_queue\.wal/.test(w));
}

test('a disk that refuses to sync is said once, not on every save, and the saves still succeed', async () => {
  const warnings = await savesWithSync(async () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); }, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not sync sync_queue\.wal to disk \(EPERM\)/);
  assert.match(warnings[0], /power cut/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'sync_queue.json'), 'utf-8')).map(q => q.queue_id), ['q_3']);
});

test('a slow disk is said once, with the way to turn syncing off', async () => {
  const warnings = await savesWithSync(() => new Promise(r => setTimeout(r, SLOW_SYNC_MS + 60)), 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /took \d+ ms/);
  assert.match(warnings[0], /HUB_QUEUE_FSYNC=0/);
});

test('a fast disk says nothing', async () => {
  assert.deepEqual(await savesWithSync(async () => {}, 2), []);
});

test('it speaks again after a minute', async () => {
  const warnings = [];
  mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  const realOpen = fs.promises.open.bind(fs.promises);
  mock.method(fs.promises, 'open', async (file, flags) => {
    const handle = await realOpen(file, flags);
    if (path.basename(String(file)) === 'sync_queue.wal') handle.sync = async () => { throw Object.assign(new Error('x'), { code: 'EINVAL' }); };
    return handle;
  });
  try {
    syncQueue._lastJournalWarning = 0;
    syncQueue.saveQueue([item(1)]); await syncQueue._writeChain;
    syncQueue._lastJournalWarning = Date.now() - 61000;
    syncQueue.saveQueue([item(2)]); await syncQueue._writeChain;
  } finally {
    mock.restoreAll();
  }
  assert.equal(warnings.filter(w => /sync_queue\.wal/.test(w)).length, 2);
});

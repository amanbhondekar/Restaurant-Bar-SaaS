// Making the sync queue's disk write survive a crash (§4.1).
//
// The queue holds orders, bills and cash-ups that have not reached the cloud. It was written by
// overwriting sync_queue.json on every change, which is not atomic: a crash part-way through
// destroys the old contents before the new ones are complete. `salvageQueue` recovers the complete
// entries at the START of a torn file, so what is lost is whatever came after the tear -- and since
// the queue is written in order, that is the NEWEST entries. The most recent unsent takings are
// exactly the ones a torn write eats.
//
// Writing to a temp file and renaming was tried and reverted (see the git history): `fsync` cost
// seconds on a path that runs on every order, and on Windows the rename contends with readers.
// The journal line IS synced (see appendRecord): it is a few kilobytes, the write chain is not on the order
// path, and it is what turns "survives the program crashing" into "survives the power going".
//
// So instead of trying to make one overwrite atomic, the state is first APPENDED to a journal. An
// append never touches bytes that are already on disk, so a crash can only ever damage the line
// being written -- every earlier line is still exactly as it was. The last line that parses is the
// last state the hub committed.
//
// The order of a save is:
//
//   1. append the new queue to sync_queue.wal      <- the durable record
//   2. overwrite sync_queue.json with it           <- the readable snapshot
//   3. truncate the journal                        <- only once (2) is safely on disk
//
// Crash during (1): the torn last line is ignored and the one before it is the previous state,
//   which is also what the snapshot still holds. Consistent, and the in-flight save simply did not
//   happen.
// Crash between (1) and (2): the journal is ahead of the snapshot and wins. The save counts.
// Crash during (2): the snapshot is torn -- and this is the case that used to lose data. The
//   journal still holds the whole state.
// Crash between (2) and (3): both agree.
//
// The journal is emptied after every successful snapshot, so in the normal case it holds one line.

import fs from 'node:fs';

/** A sync slower than this is worth telling someone about: the disk, not the program, is the bottleneck. */
export const SLOW_SYNC_MS = 250;

/** Syncing the journal is on unless HUB_QUEUE_FSYNC is 0, false or off (a disk where it is genuinely too slow). */
export function fsyncEnabled(env = process.env) {
  return !['0', 'false', 'off'].includes(String(env.HUB_QUEUE_FSYNC ?? '').trim().toLowerCase());
}

/**
 * Append one record to the journal and, unless told not to, make the operating system write it to the disk
 * before returning. Without the sync an append can sit in the OS's cache, so a power cut loses the newest unsent
 * takings even though the program never crashed. Resolves to `{ syncMs }`: how long the sync took, or null when
 * there was none.
 *
 * A filesystem that refuses to sync (some network and virtual drives answer EINVAL or EPERM) must not cost the
 * write: the record is already appended, so the error is passed to `onSyncError` and swallowed.
 */
export async function appendRecord(file, record, { fsync = true, fsp = fs.promises, onSyncError } = {}) {
  if (!fsync) {
    await fsp.appendFile(file, record, 'utf-8');
    return { syncMs: null };
  }
  const handle = await fsp.open(file, 'a');
  try {
    await handle.appendFile(record, 'utf-8');
    const started = process.hrtime.bigint();
    try {
      await handle.sync();
    } catch (err) {
      onSyncError?.(err);
    }
    return { syncMs: Number(process.hrtime.bigint() - started) / 1e6 };
  } finally {
    await handle.close();
  }
}

/** One line per state. `\n` is the record separator, so no state may contain a raw newline. */
export const RECORD_SEPARATOR = '\n';

/** A queue state as one journal line. JSON.stringify never emits a raw newline, so this is safe. */
export function encodeRecord(queue) {
  return JSON.stringify({ at: new Date().toISOString(), queue }) + RECORD_SEPARATOR;
}

/**
 * The most recent complete state in a journal, or null if there is none.
 *
 * Lines are read from the end, because the last complete one is the newest state and an incomplete
 * line can only ever be the last. A line that does not parse, or that does not carry a list, is
 * skipped rather than trusted: the next one down is an older but whole state, which is always a
 * better answer than nothing.
 */
export function lastCompleteRecord(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const lines = raw.split(RECORD_SEPARATOR);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && Array.isArray(parsed.queue) && parsed.queue.every(item => item && typeof item === 'object')) {
        return { queue: parsed.queue, at: typeof parsed.at === 'string' ? parsed.at : null, line: i };
      }
    } catch {
      // Torn (the crash landed here) or not a record at all. An older line may still be whole.
    }
  }
  return null;
}

/** How many complete states a journal holds. Only used to report an unusually long one. */
export function countRecords(raw) {
  if (typeof raw !== 'string' || raw === '') return 0;
  let n = 0;
  for (const line of raw.split(RECORD_SEPARATOR)) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && Array.isArray(parsed.queue)) n += 1;
    } catch {
      // not a complete record
    }
  }
  return n;
}

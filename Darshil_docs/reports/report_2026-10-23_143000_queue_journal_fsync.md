# The queue's journal is synced to disk

**Date:** 2026-10-23T14:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The sync queue holds orders, bills and cash-ups that have not reached the cloud. Its write order (journal append, snapshot, truncate)
survives the program crashing, but nothing called `fsync`, so a **power cut** could still lose an append the operating system had
buffered and never written: exactly the newest unsent takings. The roadmap carried this as "the cost the earlier measurement rejected".

That rejection was about syncing the large snapshot (and a rename) on a path that runs on every order. The journal line is a few
kilobytes, and `saveQueue` does not wait for the disk (the write is chained in the background), so the cost lands on the chain, not on
a waiter's order.

## MEASURED, NOT ASSUMED
30 appends of 4 KB each, on this machine's SSD (temp directory and the repo drive agree):

| | median | p90 | max |
|---|---|---|---|
| append only | 0.31 ms | 0.46 ms | 2.5 ms |
| append + fsync | 0.7 ms | 1.0 ms | 6 ms |
| fsync alone | 1.1 ms | 1.2 ms | 1.4 ms |

`queueFsync.test.mjs` prints the same number on whatever machine runs it (a hundred appends, plain vs synced) and fails only if a
synced append averages over 250 ms. **Not measured on a spinning disk or a network drive**, which is where the earlier "seconds" most
likely came from; for those, the log warns when a sync passes 250 ms and `HUB_QUEUE_FSYNC=0` turns it off.

## WHAT CHANGED
- `lib/queueJournal.js`: `appendRecord(file, record, { fsync, fsp, onSyncError })` opens the journal for append, appends, syncs, and
  always closes the handle; it returns how long the sync took. `fsyncEnabled(env)` (on unless `HUB_QUEUE_FSYNC` is 0, false or off).
  A filesystem that refuses to sync (some network and virtual drives answer EINVAL or EPERM) does **not** cost the write: the record
  is already appended, so the error is passed on and swallowed.
- `lib/syncQueue.js`: the chain's journal step is `appendToJournal`, which says so (once a minute, not on every save) when a disk
  refuses to sync or takes over 250 ms, naming the switch.
- The snapshot and the truncate are not synced: the journal protects the snapshot, which is the whole point of the order.

## TESTS (`hub_server/test/queueFsync.test.mjs`, 15)
Written first (the module did not export them: failed). The rule against a fake filesystem (append then sync on one handle, handle
always closed, off-switch is the plain append, a refusing disk still appends and is reported, a failed append still closes the
handle, the timing is reported); the switch (0, false, FALSE, off and " Off " turn it off; 1, yes and blank do not); and the real
queue: journal synced **before** the snapshot is written, `saveQueue` returns in under 50 ms regardless, the journal still emptied
afterwards, the off-switch really does not open the journal, and the warnings (refusing disk once, slow disk once, fast disk silent,
speaks again after a minute).

**Mutation check:** 21 mutations (the plain-append branch, the open mode, dropping the append or the sync, throwing or silencing the
sync error, leaking the handle, the timing, the slow threshold, each spelling of the switch and its case and negation, the
once-a-minute rule three ways, the slow warning two ways, the switch not being read, the chain not using the new step, the error
callback). All 21 caught.

## COUNTS
Hub **1255 passing** across 64 files (1240 before). Frontend unchanged at 841.

## NOT DONE
- A power cut is not something a test can cause. The tests prove the sync is *requested*, in the right order, and that its failure
  is survivable; that the disk then honours it is the operating system's promise. (Some consumer drives lie about flushes.)
- Not measured on a spinning disk; that is the machine where the setting matters.

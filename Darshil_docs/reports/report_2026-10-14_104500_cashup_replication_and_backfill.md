# M1 tail — Cash-up replication, ledger backfill, and a queue write-ordering bug

**Date:** 2026-10-14T10:45:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M1 carry-over (§4.1), continuing the 2026-10-13 invoice replication

---

## WHY

Migration 005 carried invoices to the cloud but left three things open in §4.1, two of which
made the feature only half-true:

1. **Pre-005 bills were never replicated.** Pushes are triggered by a bill *changing*, and a bill
   settled last week has no change coming. An existing ledger would have stayed on the laptop
   forever while only new takings went up.
2. **Cash-up records were still hub-local.** Every shift close, counted-cash variance and the name
   of whoever closed the till lived only in `hub_server/data/reconciliations.json`.

Chasing those two turned up a third problem in the queue itself, described below.

## WHAT

### Migration 006 + `reconciliationSync.js` + `SYNC_RECONCILIATION`

A `reconciliations` table, built like `invoices` but for an **append-only** record. The difference
worth reviewing: these are pushed with `ON CONFLICT DO NOTHING`, not `DO UPDATE`.

A first draft granted `INSERT` only and still used a normal upsert. That combination is broken:
`ON CONFLICT DO UPDATE` needs the UPDATE privilege, so a retry after a push that succeeded but was
never confirmed would have failed with `42501` — which `isSystemicFailure` classifies as hub-wide,
so the queue would have wedged permanently rather than retried. `ignoreDuplicates: true` makes the
retry a no-op and keeps the table honestly insert-only.

### Backfill

`invoiceStore.listUnsynced()` and `reconciliationStore.listUnsynced()` return what the cloud has
not confirmed, oldest first, and `syncQueue.enqueueUnsyncedInvoices()` /
`enqueueUnsyncedReconciliations()` queue them in one pass. Both run at boot, after the plan sync.
A fully replicated ledger queues nothing, and running twice does not double-queue.

### The queue write-ordering bug (the real find)

`saveQueue` fired `fs.promises.writeFile` with no serialisation. Clearing a table saves the queue
several times in quick succession — the ticket updates, then the bill — and unchained writes
complete in whatever order the OS returns them. **The file could end up holding an older snapshot
than memory**, so a hub that stopped at that moment would lose the newest queued orders and bills:
exactly the data this work exists to protect.

Fixed by serialising through a `_writeChain`, the same mechanism `restaurantCache` already uses for
catalog writes. The JSON is captured at call time, not inside the chain, so each link writes the
queue as it was when that save was asked for.

This surfaced as an intermittent integration-test failure and was initially mistaken for the known
fixture-port race. It is not: it is a hub bug that predates this branch and would have been equally
capable of losing orders before invoices existed.

### A change tried and reverted

Making the queue write atomic (temp file + rename, as `restaurantCache` does) looked like the
obvious companion fix: without it a crash mid-write leaves a truncated file, and `loadQueue`
answers a parse failure with an **empty queue**, silently discarding everything unsent.

It was reverted for two measured reasons:

- With `fsync`, latency became seconds under load. A catalog is written when someone edits the
  menu; `saveQueue` runs on every order and every ticket status change.
- Without `fsync`, the rename still contends with readers on Windows. A test polling the file at
  50 ms intervals could stall the hub's rename past a 5-second deadline — reproduced
  deterministically, then confirmed by the same test passing with a plain sleep in place of the
  poll.

So the truncation exposure remains, and is now documented in a `NOTE` at the call site rather than
being silently carried. It needs a durability design — a journal, or a write the reader can
validate — not a drive-by swap of one write call.

### Files

| File | Change |
|---|---|
| `database/migrations/006_reconciliation_cloud_replication.sql` | New — `reconciliations` table, RLS, insert-only grant |
| `hub_server/lib/reconciliationSync.js` | New — row mapping + `pushReconciliation` (DO NOTHING) |
| `hub_server/lib/syncQueue.js` | `SYNC_RECONCILIATION` op, both backfills, `invoiceOp()` extracted, **serialised writes** |
| `hub_server/lib/invoiceStore.js`, `reconciliationStore.js` | `listUnsynced`, `markSynced`, `synced_to_cloud` on new records |
| `hub_server/server.js` | Enqueue on shift close; both backfills at boot |
| `hub_server/test/reconciliationSync.test.mjs` | New — 17 tests |
| `hub_server/test/invoiceSync.test.mjs`, `catalogRoutes.test.mjs` | Queue reads wait for the expected state instead of reading once |
| `hub_server/test/helpers/spawnHub.mjs` | 8 start attempts rather than 5 |

## TEST CASES (`hub_server/test/reconciliationSync.test.mjs`, 17 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| RS-1 | Row identity | Hub id → `hub_ref`, shift number carried | Pass |
| RS-2 | Part-rupee variance | `0.5` survives intact — the point of a cash-up | Pass |
| RS-3 | Unknown status | Falls back to `balanced` rather than failing the CHECK | Pass |
| RS-4 | Open-ended first period | `period_start` stays null | Pass |
| RS-5 | Breakdown | `methods` / `voided` whole; absent → null | Pass |
| RS-6 | **Insert, never update** | `ignoreDuplicates: true` on the push | Pass |
| RS-7 | Rejection | Throws carrying the cloud's code | Pass |
| RS-8 | Push + record | Drains, `synced_to_cloud` true on disk | Pass |
| RS-9 | Idempotent enqueue | Same shift never queued twice | Pass |
| RS-10 | Wrong tenant | Dropped, nothing reaches the cloud | Pass |
| RS-11 | **Backfill order** | Three pre-005 bills queue oldest-first | Pass |
| RS-12 | Already replicated | Left alone | Pass |
| RS-13 | Clean ledger | Queues nothing | Pass |
| RS-14 | Other tenant | Never carried up by this hub | Pass |
| RS-15 | Run twice | No double-queue | Pass |
| RS-16 | Full drain | Two bills + one cash-up go up, all marked | Pass |
| RS-17 | **Through real HTTP routes** | Order → clear → pay → close queues the shift | Pass |

```bash
npm test       # 472 + 17 = 489
npm run build  # clean
```

## NOT DONE / LIMITS

- **Nothing has run against a real Supabase project.** Same as 005: no credentials here, so 006 is
  unexecuted and every push went to a recording fake.
- **The queue write is still not atomic.** Described above. A crash inside the write still costs
  the whole unsent queue.
- **Replication is still one-way.** Neither bills nor cash-ups are read back, so a reinstalled hub
  starts empty regardless of what the cloud holds.
- **Suite stability regressed slightly.** It was 0 bad runs in 25 before this work; it is now
  roughly 1 in 16, and the failure is the known `startHub` port race, not a new fault. The cause
  is this slice adding two more hub-spawning test files, so ten fixtures now start at once.
  Raising the retry count from 5 to 8 is a mitigation, not a fix — the race-free answer is still
  to let the hub bind `:0` and report its port. **The final retry-count change was verified by a
  single clean full run, not by a repeat-run measurement.**
- The `splits` path on an invoice and a variance-bearing cash-up are both covered by unit tests but
  not end-to-end through the routes.

## STATUS

✅ VERIFIED — 489/489, build clean. Cloud side unexecuted; see limits.

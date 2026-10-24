# 4.1 Billing & payments — the last two open items

**Date:** 2026-10-21T11:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.1 Billing & payments — partial-ledger repair, and a queue write that survives a crash

---

## WHY

Two items were open in §4.1, both about money that exists in one place and not the other.

1. **The queue's disk write was not atomic.** `sync_queue.json` was overwritten on every change, which
   destroys the old contents before the new ones are complete. `salvageQueue` recovers the entries at
   the *start* of a torn file, so what a crash eats is everything after the tear — and since the queue
   is written in order, that is the **newest** entries: the most recent unsent takings.
2. **A partial ledger was not repaired.** `restoreLedgerFromCloud` deliberately refuses a hub that
   holds anything, because a hub with bills is the authority on them. Right rule, real gap: a hub
   restored from a backup older than the cloud, or missing part of its data directory, has *some*
   bills, so restore refuses — and is quietly short of the rest for good, with nobody to tell it.

The roadmap said the first "needs a transactional design, not a swapped call", and the second "needs a
per-bill merge rule". Both now have one.

## WHAT

### A write-ahead journal, not a rename (`lib/queueJournal.js`)

Making one overwrite atomic was tried before and reverted: `fsync` cost seconds on a path that runs on
every order, and on Windows the rename contends with readers. So the fix does not try again. Instead
the state is **appended** to `sync_queue.wal` before the snapshot is touched. An append cannot damage
bytes already on disk, so a crash can only ever tear the line being written; every earlier line is
exactly as it was, and the last line that parses is the last state the hub committed.

A save is now three steps, in this order:

1. append the new queue to the journal — the durable record
2. overwrite `sync_queue.json` with it — the readable snapshot
3. truncate the journal — only once (2) is safely on disk

| Crash lands | What happens |
|---|---|
| During (1) | The torn line is skipped; the line before it is the previous state, which the snapshot also still holds. The in-flight save simply did not happen. |
| Between (1) and (2) | The journal is ahead and wins. The save counts. |
| **During (2)** | The snapshot is torn — **this is the case that used to lose data**. The journal holds the whole state. |
| Between (2) and (3) | Both agree. |

The journal is emptied after every successful snapshot, so it normally holds one line, and `sync_queue.json`
is still written every time and still readable — nothing that reads it had to change. On load the
journal wins whenever it holds a complete state, and says so loudly, because a journal that survived a
restart is the one moment this machinery exists for.

One subtlety worth naming: an **empty** queue is a state like any other. If the journal were only
consulted for non-empty states, a crash just after a drain would put already-synced orders back and
push them to the cloud twice. There is a test for exactly that.

### Repairing a partial ledger (`lib/ledgerRepair.js`)

The merge rule is the narrowest one that is safe — a union keyed on the hub's own id, where **the hub
wins every conflict**:

- a record the hub holds is never changed, whatever the cloud says about it (a local void or refund
  stands);
- a record only the cloud has is added — that is the repair;
- a record only the hub has is kept, not deleted for being absent from the cloud (it is a bill issued
  offline and not yet pushed; treating the cloud as complete would delete it).

Nothing is overwritten and nothing is removed, so the worst a repair can do is add a bill that was
already settled — which is what being short of it was. Restored records arrive marked replicated, so
the backfill does not push them straight back. Numbering continues above them, so the next bill cannot
collide with migration 005's unique index.

**It is not automatic.** It reads the whole cloud ledger, and a hub merely behind on pushing looks much
the same at a glance. Reception asks for it, is shown exactly what it would add (how many bills, over
what invoice-number range) and confirms. What *is* automatic is noticing: at boot — in the branch where
restore refuses because the ledger is not empty — the hub counts both sides and warns if the cloud has
more. Two counting queries, every failure soft.

That count check is a **tripwire, not a reconciliation**, and the code says so: equal counts do not mean
equal ledgers (a hub holding bills 1 and 2 while the cloud holds 2 and 3 counts the same and is still
missing one). Only comparing ids finds that, which is what the repair itself does — so the **Check
against the cloud** button is always offered, never hidden behind the warning.

### Files

| File | Change |
|---|---|
| `hub_server/lib/queueJournal.js` | New — the record format and reading the last complete state |
| `hub_server/lib/ledgerRepair.js` | New — the merge rule, what a repair would do in words, the gap tripwire |
| `hub_server/lib/syncQueue.js` | Journal-first load and save; `checkLedgerGap`, `repairLedgerFromCloud` |
| `hub_server/lib/invoiceSync.js`, `reconciliationSync.js` | `countInvoices` / `countReconciliations` (`head: true`, no rows) |
| `hub_server/server.js` | `GET /reconciliation/ledger-gap`, `POST /reconciliation/ledger-repair`; the boot check |
| `src/admin/LedgerRepair.jsx`, `CashTab.jsx` | Reception's panel |
| `.gitignore` | `hub_server/data/sync_queue.wal` |

## TEST CASES (43 new)

| File | N | Covers |
|---|---|---|
| `queueJournal.test.mjs` | 16 | Round-trip; no raw newline whatever the queue holds; newest complete state wins; a torn line skipped for the whole state before it; **an empty queue is a committed state**; nothing usable → the snapshot is still consulted; a line that parses but is not a state. Then the real queue at **each crash point**, including the snapshot-torn case, and that a drained queue stays drained |
| `ledgerRepair.test.mjs` | 19 | The merge rule (local void stands over a cloud "paid"; cloud-only added; hub-only kept; order; no id; empty); what a repair says it will do; the tripwire's asymmetry (behind-on-pushing is not a gap); then the queue against a fake cloud: dry run changes nothing, applying fills gaps and leaves local records alone, numbering continues, restored records are not pushed back, offline / unpaired / refused all report and touch nothing; and the routes on a real hub (reception-only; an unreachable cloud says so rather than reporting a healthy ledger) |
| `src/test/admin/LedgerRepair.test.jsx` | 9 | Quiet on a healthy hub; warns by itself; the real check always available; a check never changes anything; adding is confirmed with the detail repeated; cancel; nothing-missing offers nothing; offline explained |

**Shown to be able to fail:** with the journal no longer consulted on load, exactly the three crash
tests failed (13 passed, 3 failed) and were restored.

```bash
npm run test:hub   # 776 (741 + 35)
npm run test:web   # 207 (198 + 9)
npm run build      # clean
```

## NOT DONE / LIMITS

- **The gap tripwire can miss.** Equal counts with different ledgers report no gap (see above). The
  manual check is exact; the automatic one is cheap. Making detection exact means comparing ids at
  boot, which for a restaurant with years of bills is a real download on every start.
- **The journal makes a crash survivable, not a power cut.** Nothing calls `fsync`, so the OS may still
  be holding the append in a buffer when the machine loses power. That is the trade the earlier
  measurement already settled; a fully durable write would need the cost that was reverted.
- **The repair trusts the cloud's copy of a bill the hub lacks.** There is no way to check it against
  anything — that is what missing means.
- **Migrations 004–009 are still unrun.** The repair was verified against a fake cloud that answers as
  PostgREST does, not against a real project. It is the same caveat as the restore it sits beside, and
  the restore remains the least-proven path here.
- **No concurrent-hub rule.** Two hubs paired to one tenant would both think they were the authority.
  Out of scope, and the product has never supported it.

## STATUS

✅ VERIFIED — 776 hub + 207 frontend, build clean; the crash cases shown to fail without the fix.
⚠ The cloud side is still unexercised against a real Supabase project.

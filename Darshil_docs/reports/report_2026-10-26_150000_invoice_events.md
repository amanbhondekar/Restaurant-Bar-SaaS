# The history of a bill: `invoice_events` (G0-4, built)

**Date:** 2026-10-26T15:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 0 gate G0-4 (approved by Aman after the analysis in `report_2026-10-26_134500_ledger_analysis.md`)

---

## WHAT CHANGED

A bill used to be overwritten in place, on the hub and in the cloud. Every change to one now also leaves an **event**, the events of a bill form a
**hash chain**, and they are kept on the hub and replicated to an append-only cloud table.

- `database/migrations/022_invoice_events.sql`: the table, its constraints, row-level security, and three triggers.
- `hub_server/lib/invoiceEvents.js`: the pure rules. How an event is hashed (SHA-256 over a canonical encoding of the event and the previous hash), how a
  chain is verified, and how a change to a bill is described (`diffInvoice`: for each field that differs, what it was and what it became).
- `hub_server/lib/invoiceEventStore.js`: the hub's copy, `hub_server/data/invoice_events.jsonl`: one JSON line per event, only ever appended to. Which
  events the cloud has confirmed is a line too (`{"mark":"synced","ids":[...]}`), so nothing already written is rewritten and a crash can tear only the last line.
- `hub_server/lib/invoiceEventsSync.js` and `syncQueue.js`: one queued push per bill (it reads what is unsent when it runs, so events recorded meanwhile ride
  along), a boot backfill, and a restore for a replacement laptop. Changing a bill queues its events with it.
- `hub_server/lib/invoiceStore.js`: every transition records an event (`issued`, `split`, `unsplit`, `paid`, `split_paid`, `voided`, `refunded`). A bill
  with no history yet gets a `baseline` first, so the history starts from the state before its first change. `unsplit` now takes an optional actor, and the
  route passes it.
- `hub_server/server.js`: the boot sequence restores the history, then baselines and carries up what the cloud has not confirmed.
- `.gitignore`: the events file.

## WHAT IT RECORDS THAT THE CLOUD COPY NEVER HELD

`paid_by`, `voided_by`, `refund_by`, `split_mode`, `split_at`, `split_by`, and everything an undone split destroyed (the shares, the mode, who split it and when).
Replaying a bill's events from its issue gives back the bill as it stands, which a test checks for a paid, a voided, a refunded and a split-undone-and-resplit bill.

## WHAT THE CLOUD REFUSES

- UPDATE, DELETE and TRUNCATE, for every role including the service role and the table's owner (a trigger as well as explicit privileges, because 014 showed that a
  Supabase project grants a new table to every role by default). The one deletion allowed is the cascade from removing a restaurant, which is how a tenant is erased.
- A history that skips an event, does not chain to the one before, or does not start at the genesis hash. A **different** event under a number already used is an
  error, not a silent no-op: a BEFORE trigger sees it before `ON CONFLICT DO NOTHING` would swallow it. An identical one passes and is skipped, so a retry is harmless.
- Anyone but the hub adding events: only a `kitchen` staff login of the same restaurant may insert; any staff login of the restaurant may read.
- The database checks the **links**, not the hashes: recomputing a hash in SQL would mean encoding JSON byte for byte as the hub does. Whoever reads a chain verifies it.

## TESTS (written first)

Five new files, 119 tests: `invoiceEvents` (the rules), `invoiceEventStore` (the file, torn lines, restore), `invoiceLedgerEvents` (the real invoice store through a
bill's life, including that a refused change leaves no event and that a failing history never stops a bill), `invoiceEventsSync` (rows, push, queue, backfill, restore,
paging past 1,000 rows), `invoiceEventsSchema` (the migration on a real Postgres engine, PGlite, with Supabase's default privileges modelled).
The whole hub suite: **1871 tests, all passing** (was 1752). The frontend suite was not run; nothing in the frontend changed.

**Mutation checking:** 115 mutants of the rules, the store, the invoice store, the sync code, the queue and the migration, each of which the tests must notice. 104 were
caught at first; the 11 that survived were each dealt with: seven were gaps in the tests (a torn line's successor not read back, a restore handed events out of order,
a change that changed nothing, a failing history stopping a bill, paging past one response, an event with no actor, an insert for another restaurant), two were checks
that were only ever redundant behind the guard trigger (the column CHECKs, now tested with the trigger switched off), one was an error message that a later error
would have produced anyway (the test now asks for the explicit message), and one was a redundant `?? null` in `diffInvoice`, removed. All caught on the second run.

## ALSO FIXED

`cloudContract.test.mjs` built a path from `import.meta.url` without decoding it, so its "no read goes unlisted" test failed in any checkout whose path contains a space
(this one is under `Other Projects`). It failed identically before this change. It now uses `fileURLToPath`.

## DECIDED ALONG THE WAY

- **Migration number 022**, not 023: the next free number was 022, and the admin console's tables (build sheet) now start at 023. The roadmap and the sheet say so.
- **The event file is written before the bill's file**, synchronously and flushed to the operating system. A process crash loses nothing; a power cut may lose the newest line.
- **A failure to record an event never stops a bill.** It is logged loudly. The consequence is a history with a hole that nothing detects; the next change still chains
  onto the last event written.

## HONEST LIMITS

- The hub writes the chain. It shows an edit, a deletion in the middle, a reordering or an inserted event, but **not events cut off the end**, and it cannot stop whoever
  controls the hub's cloud login from rewriting a whole chain from the start. Keeping each bill's latest hash somewhere the hub cannot write to (the operator service,
  say) would close that, and is not built. `verifyChain` already returns the head hash to anchor.
- `actor` is the label the till sends, not a verified identity. The hub's issue of a bill records none: the close-table route has no actor to give.
- The **bill's own cloud row can still be edited** by the hub's login. A freeze trigger on the money columns of an issued bill was the optional second step and is not done.
- **Nothing shows the history to a person yet**: no route, no screen. It is there for a dispute, an audit or a restore.
- Migration 022 and the events have never run against a hosted project (G0-1). Everything above is proven on PGlite and stand-ins.
- A bill restored from the cloud after the boot backfill ran has no history until it next changes (it then gets a baseline first).

## NOT DONE

The anchor for each bill's head hash; the freeze trigger; a route or screen to read a history; an actor on issue; running any of it on a hosted project.

Status: ✅ built and proven on a real Postgres engine and stand-ins; 🟡 never run against a hosted Supabase project; ⬜ the anchor and the freeze.

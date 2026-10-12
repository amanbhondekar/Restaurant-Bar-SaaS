# M1 tail — Invoice cloud replication

**Date:** 2026-10-13T19:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M1 carry-over (§4.1), surfaced by the 2026-10-13 roadmap reconciliation

---

## WHY

Reconciling the roadmap against the code turned up a gap nothing in the repository
recorded: **invoices had no cloud representation at all.**

- `database/supabase_schema.sql` defines nine tables. None of them is an invoice.
- `invoiceStore` writes bills to `hub_server/data/invoices.json`.
- The sync queue replicated `CREATE_ORDER`, `UPDATE_STATUS`, `SYNC_MENU` and
  `SYNC_TABLES` — orders, not bills.

So a tenant's entire revenue history lived on one reception laptop. A failed disk, a
stolen laptop or a reinstall took every invoice, every settlement and every refund with
it, and no cloud-side reporting could ever be built on top. M1 was called
"payments-ready" with that hole in it.

The design had clearly anticipated this and stopped short: `issueInvoice` stamps every
bill `synced_to_cloud: false` and comments that the on-disk shape "matches what the
modal / cloud replica consumes" — but **nothing ever set that flag true**, because
nothing ever pushed a bill. It was a placeholder for work that was never done.

## WHAT

The catalog write-through (migration 003) is the template: the hub is the single
writer, each push is a full snapshot upserted on `(restaurant_id, hub_ref)`.

### `database/migrations/005_invoice_cloud_replication.sql` (new)

An `invoices` table keyed on the hub's own invoice id as `hub_ref`, so a bill that is
later paid, voided, refunded or split updates in place rather than duplicating.

Decisions worth reviewing:

- **Money is `NUMERIC(12,2)`, not float.** These are rupee amounts that have to add up;
  the hub already does largest-remainder rounding before they get here.
- **Breakdown rows are JSONB, not child tables.** Items, taxes, discounts and splits are
  an immutable record of what was printed, never queried relationally. Child tables
  would need their own delete-stale pass on every push, which is exactly the complexity
  the catalog's snapshot model exists to avoid.
- **No `DELETE` grant.** A bill is a financial record; a void is a state transition the
  hub pushes as an update, never a removal.
- RLS mirrors every other tenant table: one `FOR ALL` policy on
  `current_restaurant_id()`.

### `hub_server/lib/invoiceSync.js` (new, pure)

`invoiceRow()` maps one on-disk bill to the row, coercing money to paise, timestamps to
ISO-or-null (never `''`, which the column would reject) and absent breakdowns to null.
`pushInvoice()` upserts and throws on rejection so the queue can count the attempt.
`client` is a parameter, so tests hand in a recording fake.

### `hub_server/lib/syncQueue.js`

New `SYNC_INVOICE` op with `enqueueInvoice()`, `mergeInvoiceOp()` and
`syncInvoiceToSupabase()`, dispatched alongside the catalog ops.

`mergeInvoiceOp` collapses queued pushes **per bill**: a restaurant that issues, pays
and then refunds one bill during an outage leaves a single queued push carrying the
final state, not three carrying a history the cloud never needed.

A bill whose `restaurant_id` does not match the hub's current pairing is **dropped, not
retried** — same rule as the catalog. A hub re-paired between issuing and pushing must
never write the old tenant's revenue into the new tenant's books.

### `hub_server/lib/invoiceStore.js`

`markSynced()` and `markPending()` — the counterparts that finally make
`synced_to_cloud` mean something. Enqueueing marks the bill pending, because the cloud's
copy is stale from the moment the bill changes, not from when a push fails.

### `hub_server/server.js`

`replicateInvoice()` beside `broadcast()`, called once per handler at all ten places a
bill is created or changes state: issue (both clear paths), void, mark-paid, refund, the
three splits, unsplit, and split-mark-paid. Once per handler rather than per broadcast —
the split-paid handler broadcasts twice for one bill.

## TEST CASES (`hub_server/test/invoiceSync.test.mjs`, 17 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| IS-1 | Hub id becomes `hub_ref` | Bill keeps its identity across pushes | Pass |
| IS-2 | Money rounded to paise | `992.2500000001` → `992.25` | Pass |
| IS-3 | Unusable money | `undefined` / `'abc'` / `null` → `0`, never NaN | Pass |
| IS-4 | Timestamps | `''` and garbage → null; valid ISO preserved | Pass |
| IS-5 | Settled bill | Method, reference and `paid_at` carried | Pass |
| IS-6 | Breakdown | Items and tax rows whole; absent splits → null | Pass |
| IS-7 | Upsert key | `onConflict: restaurant_id,hub_ref`; paying updates, not duplicates | Pass |
| IS-8 | Rejection | Throws carrying the cloud's code | Pass |
| IS-9 | Push + record | Queue drains, `synced_to_cloud` true on disk | Pass |
| IS-10 | Offline edits | Issue → pay → refund collapses to **one** push carrying `refunded` | Pass |
| IS-11 | Two bills | Two pushes, not merged | Pass |
| IS-12 | Wrong tenant | Dropped; nothing reaches the cloud | Pass |
| IS-13 | **Migration not applied** | Queue held intact, no retry burned, nothing shelved | Pass |
| IS-14 | Row-specific fault | Attempt counted normally | Pass |
| IS-15/16 | Flag transitions | Only move on real change; never another tenant's bill | Pass |
| IS-17 | **Through real HTTP routes** | Closing a bill queues it; paying collapses onto the same push, carrying `paid` | Pass |

IS-13 is the one worth reading. `42501` is how an unapplied migration 005 or a bad RLS
policy reads, and `isSystemicFailure` already classifies it as hub-wide, so the queue is
held rather than counted against. Without that, five retry cycles would quarantine a
restaurant's entire takings because an admin had not run a SQL file. The first draft of
this test asserted the opposite — that an attempt was counted — and the code was right
and the test wrong.

IS-17 exercises `server.js` itself through a real hub fixture, which the other sixteen
do not: they drive the queue directly and would all still pass if the ten call sites had
been wired to nothing.

```bash
npm test       # 455 existing + 17 new = 472
npm run build  # clean
```

The live pilot hub was restarted on the new `server.js` and serves `/` and `/admin`
with no errors. **No demo data was touched** — the end-to-end check runs against a
throwaway fixture, not the pilot's invoices.

## NOT DONE / LIMITS

- **Nothing has been run against a real Supabase project.** There are no cloud
  credentials on this machine, so migration 005 is unapplied and every push in this work
  went to a recording fake. The SQL is written to the same conventions as 001–004 but
  has not been executed; the first real run should be against a scratch project.
- **Replication is one-way.** The hub pushes; it never reads bills back. A reinstalled
  hub still starts with an empty ledger even though the cloud now holds its history.
  Restore is a separate slice.
- **Reconciliation records are still hub-local.** `reconciliations.json` has no table.
  Cash-up history is still laptop-bound; this slice covers invoices only.
- **No backfill.** Bills issued before this lands stay `synced_to_cloud: false` and are
  never pushed, because replication is triggered by a state change and they have none
  coming. A one-off enqueue-all would fix it and is not written.
- **`invoice_number` is unique per restaurant in the migration**, which matches the
  hub's counter. Two hubs paired to one tenant would collide on that index — not a
  configuration the product supports today, but the constraint makes it fail loudly
  rather than silently interleave.
- The `splits` column is written but no test asserts a split bill's shape end-to-end;
  split state is covered by `split.js`'s own suite, not by the replication path.

## STATUS

✅ VERIFIED — 472/472, build clean, hub boots and serves. Cloud side unexecuted (no
credentials); see limits.

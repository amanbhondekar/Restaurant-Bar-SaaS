# G0-4: does the cloud copy of a bill lose earlier content? (analysis and proposal)

**Date:** 2026-10-26T13:45:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 0 gate G0-4

---

## WHAT CHANGED

A read-only analysis. **No code, migration or test changed**, and the proposal below is not implemented; it needs approval first.

Read: `hub_server/lib/invoiceSync.js`, `invoiceStore.js` (issue, void, split, unsplit, pay, refund), `database/migrations/005_invoice_cloud_replication.sql` and `014_explicit_privileges.sql`. Not read: `ledgerRepair.js`, `cloudCheck.js`, the tests. Nothing was run, and nothing was checked against a hosted project.

## ANSWER

**Yes. Both the hub and the cloud keep only the latest state of a bill, and some of what the hub knows never reaches the cloud.** The build sheet's worry was plausible; from the code it is now confirmed.

### 1. A bill is overwritten in place, on both sides

- **Cloud:** every push is a full snapshot upserted on `(restaurant_id, hub_ref)` (`pushInvoice`). Each push replaces every column. There is no history table.
- **Hub:** every transition (void, split, unsplit, pay, split-pay, refund) replaces the invoice object in `invoices.json` with a modified copy. `unsplit` deletes `splits`, `split_mode`, `split_at` and `split_by` outright (it is allowed until a share is paid).
- So the sequence "split by seats, unsplit, split by items" leaves no trace of the first split. Paid-then-refunded keeps `paid_at`, `payment_method`, `refund_at` and `refund_reason`, because those are stamped onto the same object, but not anything in between.

### 2. Hub fields with no cloud column

`invoiceRow` sends a fixed set of columns. The hub also stamps these, and they are **never sent**: `paid_by`, `voided_by`, `refund_by`, `split_mode`, `split_at`, `split_by`. Who took the payment, who voided or refunded a bill, and how it was split are therefore on the reception laptop only. `invoiceFromCloud` cannot return them, so **a hub restored from the cloud loses them permanently.** (Per-share fields inside `splits` do travel, because `splits` is sent whole as JSONB.)

### 3. The cloud copy is not protected against edits

Migration 014 grants `SELECT, INSERT, UPDATE` on `invoices` to `authenticated`, which is the identity the hub writes as. I found no trigger and no column restriction in 005 or 014. So any column of an issued bill (items, totals, tax rows, even the invoice number) can be rewritten by a later push or by anyone holding that identity. Nothing records what a bill said before.

## WHY IT MATTERS

- A refund or void can be explained only by the latest state: who did it and what the bill looked like before are not recoverable from the cloud.
- The tamper-evidence the product may want to claim (decision D8, out of scope for the console) has no basis today.
- This does not touch the console's invariants: I1 forbids any admin path to bills, and the console shows counts only (I9). The finding is about the tenant's own ledger.

## PROPOSAL (not implemented): an append-only `invoice_events` table

- **Columns:** `restaurant_id`, `invoice_hub_ref`, `seq` (per invoice, from 1), `event_type` (`issued`, `split`, `unsplit`, `paid`, `split_paid`, `voided`, `refunded`), `actor` (the staff label the hub already has; it is not an authenticated identity), `occurred_at` (the hub's clock), `payload` JSONB (the fields that changed, and for `issued` the whole bill), `prev_hash`, `hash`.
- **Integrity:** unique `(restaurant_id, invoice_hub_ref, seq)`; `hash` = SHA-256 over `prev_hash` and a canonical encoding of the event; INSERT only (UPDATE and DELETE revoked and blocked by trigger), the same pattern the build sheet specifies for `tenant_events`.
- **Hub side:** each transition appends one event to the existing crash-safe sync queue; a retried push is a no-op on `(restaurant_id, invoice_hub_ref, seq)`. The hub's own file would also keep the events, so a restore can rebuild both.
- **Optional second step:** a trigger that rejects changes to the money and breakdown columns of an issued bill (items, totals, tax rows, invoice number), allowing only settlement columns to change.
- **Honest limit:** the hub writes the chain, so whoever controls the hub's cloud identity could rewrite the whole chain. It shows an edit only if the latest hash is also kept somewhere the hub cannot write (for example anchored periodically by the operator service). That anchoring is a further decision.
- **Migration number:** 022 is expected to be taken by the admin console (build sheet); this would follow it.

## NOT DONE

The table, the hub changes, the freeze trigger and their tests; reading `ledgerRepair.js` and the tests to see what they already pin; any check against a hosted project (G0-1). Approval is needed before any of it starts.

Status: ✅ the question is answered from the code; ⬜ the proposal; ❌ not proven on a hosted project.

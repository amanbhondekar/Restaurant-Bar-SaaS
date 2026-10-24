# M1 tail — Reading the ledger back, and an invoice-numbering bug it exposed

**Date:** 2026-10-14T21:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M1 carry-over (§4.1), closing the last open item from the 005/006 work

---

## WHY

Replication had been one-way since migration 005. The hub pushed bills and cash-ups and never read
them back, so a reinstalled or replaced reception laptop started with **no financial history at
all** even though the cloud held every bill it had ever issued.

Investigating that turned up something worse than an empty screen.

### The numbering bug

`invoiceStore.nextInvoiceNumber` derived the next number from the **count** of a tenant's bills:

```js
const nextSeq = tenantInvoices.length + 1;
```

While the ledger is whole and nothing is ever removed, count and maximum agree, so this has been
harmless. They stop agreeing the moment the ledger has a gap — which is precisely what a restore
produces if even one bill failed to replicate.

Migration 005 then makes that fatal rather than untidy. It puts a unique index on
`(restaurant_id, invoice_number)`, so a hub that reissues `INV-000003` gets `23505` on every push.
That is *not* a systemic failure, so it burns the retry budget and the bill is quarantined — and
the next bill collides too, and the one after that. **A fresh hub would have issued a run of bills
that could never reach the cloud, silently, for as long as it ran.** The index I added last slice
is what turns a dormant weakness into live data loss, so this is a bug this work created the
conditions for.

Fixed by deriving from the highest number used, which is what `reconciliationStore` already did
for `seq`.

## WHAT

### `invoiceFromCloud` / `reconciliationFromCloud` — the inverse mappings

`hub_ref` carries the hub's own id, so a restored bill keeps the identity its tickets and splits
referred to. Everything restored is marked `synced_to_cloud: true` by construction — it came from
the cloud, so the cloud has it. Settlement fields absent on an unpaid bill stay absent rather than
becoming null.

### `pullInvoices` / `pullReconciliations`

Straight reads filtered by `restaurant_id`, ordered so bills arrive newest-first (how the hub
stores them) and cash-ups oldest-first (so `seq` reads in order).

### `syncQueue.restoreLedgerFromCloud(restaurantId)`

**Only ever fills, never merges.** A hub that already holds bills is the authority on them;
pulling the cloud's copy over the top could resurrect a locally voided bill or overwrite a
settlement that has not been pushed yet. If a store has anything, that store is left alone. Bills
and cash-ups are judged separately, so a hub with bills but no shift history still gets the
cash-ups back.

Offline is a no-op that can be retried, and a cloud that refuses the read fails soft — an empty
ledger is bad, but refusing to boot because the cloud is unreachable would be worse.

### Boot order

Restore runs **before** the backfill. Everything restored arrives already marked as replicated, so
the backfill that follows correctly finds nothing. Reversing the order would queue the entire
restored ledger straight back to the cloud.

### Files

| File | Change |
|---|---|
| `hub_server/lib/invoiceStore.js` | `nextInvoiceNumber` from the maximum, not the count |
| `hub_server/lib/invoiceSync.js` | `invoiceFromCloud`, `pullInvoices` |
| `hub_server/lib/reconciliationSync.js` | `reconciliationFromCloud`, `pullReconciliations` |
| `hub_server/lib/syncQueue.js` | `restoreLedgerFromCloud` |
| `hub_server/server.js` | Restore at boot, before the backfill |
| `hub_server/test/ledgerRestore.test.mjs` | New — 15 tests |

## TEST CASES (`hub_server/test/ledgerRestore.test.mjs`, 15 new)

The fake cloud is built by running real records through `invoiceRow` / `reconciliationRow`, so the
restore is tested against what the hub would actually have pushed rather than hand-written rows.

| ID | Title | Expected | Actual |
|---|---|---|---|
| LR-1 | **Numbering from the maximum** | A ledger `1,2,4` yields `INV-000005`, not `INV-000004` | Pass |
| LR-2 | Tenant isolation | Another tenant's bills never advance this counter | Pass |
| LR-3 | Unparseable number | Ignored rather than poisoning the counter | Pass |
| LR-4 | **Invoice round trip** | Pushed and read back is the same bill, id included | Pass |
| LR-5 | Cash-up round trip | Variance and shift number survive | Pass |
| LR-6 | Unsettled bill | Absent settlement fields stay absent, not null | Pass |
| LR-7 | Empty hub | Whole history comes back | Pass |
| LR-8 | **Numbering after restore** | Continues at `INV-000004`, does not restart | Pass |
| LR-9 | **Restore then backfill** | A restored ledger queues nothing | Pass |
| LR-10 | Hub already holds bills | Left alone; the unpushed local bill survives | Pass |
| LR-11 | Offline | No-op, retryable, nothing emptied | Pass |
| LR-12 | Cloud refuses the read | Fails soft with the reason | Pass |
| LR-13 | Empty cloud | Empty hub, reports nothing restored | Pass |
| LR-14 | Wrong tenant | Restores nothing | Pass |
| LR-15 | Halves judged separately | Missing cash-ups restored, existing bills untouched | Pass |

```bash
npm test       # 501 + 15 = 516
npm run build  # clean
```

The live pilot hub was restarted on this code. Its ledger is empty and it is offline, which is the
exact path that matters: restore reported no-op, created no `invoices.json` or
`reconciliations.json`, logged nothing, and `/`, `/admin` and `/dashboard` all serve.

## NOT DONE / LIMITS

- **Nothing has run against a real Supabase project.** Still no credentials here, so 005 and 006
  remain unapplied and every read and write in this work went to a fake. **The restore path is the
  least proven thing in the branch**: a push that is wrong fails loudly and retries, whereas a read
  that is wrong quietly produces a plausible but incorrect ledger. It should be exercised against a
  scratch project before any hub is reinstalled in anger.
- **Restore is all-or-nothing per store, and only into an empty one.** A hub that holds *some*
  bills and is missing others is not repaired; it is left exactly as it is. Reconciling a partial
  ledger means deciding which side wins per bill, which is a merge design this deliberately avoids.
- **No restore of tickets or the catalog**, so a reinstalled hub still needs its menu and tables
  from the existing boot sync. Only the financial record is covered.
- **The numbering fix changes behaviour on a ledger with gaps**, which no existing hub should have.
  If one somehow does, the next bill will jump rather than fill the gap — correct, but worth
  knowing before someone reports it as a bug.
- Restore runs at boot **and on reconnect**, so a hub reinstalled while the internet was down no
  longer waits for a restart. Repeating it is cheap because it short-circuits once the ledger is
  present, but the reconnect path is covered only by that reasoning and the existing unit tests —
  there is no test that drives an offline-to-online transition end to end.

- **The fixture-port race is getting worse as fixtures accumulate.** It was 0 bad runs in 25
  before the replication work, roughly 1 in 16 after the cash-up slice, and 1 in 3 across the
  three runs taken here (two clean at 516/516, one losing catalogRoutes to an exhausted start
  retry). Nothing about the race changed; there are simply about eleven hubs starting at once
  now. Raising the retry count has stopped buying much. The race-free fix is still to let the
  hub bind port 0 and report the port it got, which is a small production change and is the
  thing worth doing next rather than another round of retries.

## STATUS

✅ VERIFIED — 516/516, build clean, hub boots and serves. Cloud side unexecuted; see limits.

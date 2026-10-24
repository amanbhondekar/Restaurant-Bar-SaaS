# M3 · Landing PR 16 on the M1+M2 line

**Date:** 2026-10-12T11:15:00+05:30
**Branch:** `integration/m3-land` (from `feat/m2-kitchen-ops`)
**Commit:** `4546168`
**Milestone:** M3 — Self-serve tenant (integration of slice 1)

---

## WHY

PR 16 (plan entitlements + hub enforcement) was finished on 2026-10-02 and left unmerged
while M1 completion and M2 kitchen ops landed. By 2026-10-08 the two lines had diverged
by six days of work over the same integration points — `server.js`, `hubConfig.js`,
`restaurantCache.js`, `deviceAuth.js` — and M3's own leftover ("fire is not plan-gated")
could not be closed until it landed.

Landed on a dedicated integration branch rather than directly on `feat/m2-kitchen-ops`,
which is pushed: a bad merge there would have needed a force-push to undo.

## WHAT

### Conflicts (4 files, 9 hunks)

Three were additive on both sides and both sides were kept: imports in `hubConfig.js` and
`server.js`; `parsePrinter()` (ours) alongside `planFieldsFrom()` (theirs); `_writeChain` /
`_backupSeq` alongside `featureProvider` / `setFeatureProvider()`; our reconnect-resubscribe
hook alongside their 15-minute plan sync; and in `getMenuCache()`'s returned object our
`revision` alongside their plan-gated `items` override — different keys, no interaction.

**One was a real semantic conflict and is the part worth reviewing.** Both sides had
rewritten `hubConfig.getPrinters()`:

- **Ours (M1):** `raw.map(p => parsePrinter(p))` — the validating parser that understands
  `tcp`, `usb` (OS print queue) and `device` (`/dev/usb/lp0`) transports plus station
  routing.
- **Theirs (M3):** an inline `.filter(p => p.host)` parser — the *pre-M1* TCP-only shape —
  plus the new plan cap on printer count.

Taking M3's side wholesale would have silently reverted USB and device-path printing from
M1 completion, with no test failure to catch it: M3's branch predates those transports, so
nothing on that side exercises them. Resolved by keeping `parsePrinter()` and layering the
plan cap on top:

```js
const cleaned = raw.map(p => parsePrinter(p)).filter(r => r.ok).map(r => r.printer);
// Plan cap (M3 · PR 16): only the first N configured printers are used.
const cap = getLimits(this.getEffectivePlan().plan).printers;
const allowed = cap === null ? cleaned : cleaned.slice(0, cap);
```

`Darshil_docs/README.md` conflicted too: the log is newest-first, so M3's 2026-10-02 row
belongs *below* the existing 2026-10-03 row, not where git put it.

### Integration defects — neither visible in either branch alone

**1. Migration number collision.** M3 added `database/migrations/002_plan_status.sql`
while this line already had a different `002_online_rls_and_order_items.sql` and an `003`.
Two different migration 002s would have been applied in undefined order. Renumbered to
`004_plan_status.sql`, with the in-file header comment and the reference in PR 16's own
report updated.

**2. Test fixture port collision.** 8 of M3's plans tests failed with 404s and wrong status
codes in the full suite while passing in isolation. `hub_server/test/plans.test.mjs:164`
binds port 4598; `hub_server/test/catalogRoutes.test.mjs:27` (from the menu/tables work)
binds 4598 as well. The runner executes test *files* in parallel, so the two fixtures raced
and whichever lost sent every request to the other hub.

This was slow to diagnose because `plans.test.mjs` hand-rolls its fixture with
`stdio: 'ignore'` and waits only for `/pairing-info` to answer — a hub on that port answers
it, whichever hub it is. The newer `hub_server/test/helpers/spawnHub.mjs` guards exactly
this with a per-boot nonce ("a stale hub already holding the port can never pass for this
one"), but it has no option for M3's plan config, so `plans.test.mjs` cannot use it as-is.
Moved the M3 fixture to **4594**, the only free port in 4591–4599.

### Files

| File | Change |
|---|---|
| `hub_server/lib/hubConfig.js` | Merged `getPrinters()` (our parser + their cap); `planFieldsFrom()`, `getEffectivePlan()`, `syncPlanFromCloud()` from M3 |
| `hub_server/lib/restaurantCache.js` | `featureProvider` / `setFeatureProvider()`; plan-gated `items` in `getMenuCache()` |
| `hub_server/server.js` | `requireFeature()`, `/plan`, device + waiter limit gates, 15-min plan sync |
| `hub_server/lib/plans.js`, `hub_server/test/plans.test.mjs` | New from M3; test moved to port 4594 |
| `database/migrations/004_plan_status.sql` | Renamed from `002_plan_status.sql`, header updated |
| `Darshil_docs/README.md`, PR 16's report | Row ordering; migration filename reference |

## TEST CASES

| ID | Title | Steps | Expected | Actual |
|---|---|---|---|---|
| M3I-1 | Full suite after merge | `npm test` | 438/438 | Pass |
| M3I-2 | Plans tests no longer race | `npm test` repeatedly | Same result as `node --test hub_server/test/plans.test.mjs` alone | Pass |
| M3I-3 | USB/device printing survived the merge | Inspect merged `getPrinters()`; `printers.test.mjs` | `parsePrinter()` retained, all transports valid, cap applied after | Pass |
| M3I-4 | Migrations are uniquely numbered | `ls database/migrations` | 001, 002, 003, 004 | Pass |
| M3I-5 | Pilot tenant not degraded | Boot hub, `GET /plan` | `pro`, `degraded: false`, all features on | Pass |
| M3I-6 | KDS unchanged | Load `/`, check console | Ticket list, station filters, no errors | Pass |

M3I-5 is the one that mattered operationally: this hub's `hub_config.json` has no `plan`
field, and PR 16's deliberate fail-safe resolves that to `pro`, not `starter`, so landing
plan enforcement does not silently strip features from the live pilot restaurant.

```
{ "plan": "pro", "degraded": false,
  "features": { "split_bill": true, "refunds": true, "modifiers": true,
                "day_part_pricing": true, "multi_station_kot": true } }
```

## NOT DONE / LIMITS

- `integration/m3-land` is **local only**; `feat/m2-kitchen-ops` has not been
  fast-forwarded to it and nothing is pushed.
- Migration `004_plan_status.sql` has **not been applied to a real Supabase project** —
  there are no cloud credentials on this machine. Only the file was renumbered.
- `syncPlanFromCloud()` was exercised offline only (fail-soft path). The online path that
  actually reads `plan_status` from `restaurants` is untested here.
- The port-collision class of bug remains possible: fixture ports are still hardcoded
  per-file with no central registry. Migrating `plans.test.mjs` to `spawnHub.mjs` would
  need that helper to accept plan config.
- "Fire is not plan-gated" (the M2 leftover) is now **unblocked but still open**.

## STATUS

✅ VERIFIED & COMMITTED — 438/438, hub boots, KDS and `/plan` verified in the browser.

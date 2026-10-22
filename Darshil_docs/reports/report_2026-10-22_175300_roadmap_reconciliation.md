# Roadmap reconciled against the code (2026-10-22)

**Date:** 2026-10-22T17:53:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Scope:** `docs/ROADMAP.md` only — no code changed

---

## WHY

§6 says the roadmap changes in the same commit as the work, and since 2026-10-19 it had: each of the last
dozen commits updated the sections it touched. What that rule does not catch is the *rest* of the document
drifting — the parts no single commit owned. Reading it end to end against the code found a good deal that was
simply out of date, and one thing that was wrong.

## WHAT CHANGED

**Stale, now current**

- **Header** said "last reconciled 2026-10-13, M3 in progress". Now 2026-10-22, with M3 and M4 described as
  mostly built.
- **§2 Data:** migrations were listed as `001`–`007`. They are `001`–`011`, and the entry now says plainly that
  **`004`–`011` have never been run against a real Supabase project**. The schema list gains `inventory_items`,
  `recipes`, `subscriptions`, `subscription_events`, `reservations` and `walkins`.
- **§2 Process:** "Hub regression suite: 527 tests, 10 consecutive clean runs" is now the current count, and
  says the safety rules are mutation-checked — which is how this suite is now actually written.
- **§2 Security / Billing / Menu depth / Tenant lifecycle / Frontend surfaces** each gain what shipped since:
  device scope, invite-based staff onboarding, per-tenant guest hashing, Razorpay signature checking, ledger
  restore/repair and the crash-safe queue, modifier choices using stock, the Staff & devices tab and the operator
  service, and the admin tabs and surfaces that did not exist when those lists were written.
- **§3 Inventory limits** was hard-wrapped mid-sentence by an earlier edit; re-flowed, and it now records that the
  waiter's modifier sheet does not grey out an extra whose ingredient has run out.
- **Milestones:** M2 gains the modifier-stock line; M3 gains the staff/device line; M4's §4.6 entry is no longer
  a clean ✅ (below).

**One thing that was wrong**

§4.6 said the hub's walk-in queue was **"replacing the browser-localStorage one"**. It does not replace it. The
server-laptop app still has its original **Waitlist tab** (`WaitlistView`, backed by `PosContext`'s
`all_waitlist` in `localStorage`, seeded with demo rows). It shares nothing with the hub queue in the admin
Bookings tab, so someone opening the wrong tab sees an unrelated list. The claim is corrected and the
leftover is recorded as an open item: retire the old tab, or point it at the hub's queue. M4's §4.6 line drops
from ✅ to 🟡 for the same reason.

## WHAT IS NOT DONE

- The old Waitlist tab is **recorded, not removed.** Whether to delete it or rewire it is a product call.
- Nothing here was re-verified by running it; every figure is the one from the last full run (hub 965,
  frontend 452) and every statement about code was checked against the file it describes.

---

**Verification:** documentation only. `git diff` touches `docs/ROADMAP.md`, this report and the README index.

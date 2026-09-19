# Engineering & Test Audit Report — Invoice Lifecycle (Void + Mark Paid)

- **Timestamp**: `2026-09-19T16:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Third slice of milestone M1 (Payments-ready). Turns the
  invoice from a one-way write into a lifecycle: reception can void
  an invoice issued in error (reopening the underlying tickets so the
  guest's KOTs come back to the KDS), and can mark an invoice paid
  against a payment method. This is the seam that PR 4 (payment
  capture) will hook into. Stacked on `feat/billing-adjustments`
  (PR 2), which is stacked on `feat/billing-foundation` (PR 1).
- **Related Files**:
  - `hub_server/lib/ticketStore.js` [MODIFY]
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

---

## 1. Rationale (Why)

PR 1 and PR 2 gave reception the ability to compute, itemise and
close a bill. What they didn't give was any way to undo a close, or
any way to record that the guest actually paid.

Both matter operationally:

- **Void**: reception routinely closes the wrong table (T3 instead of
  T8) or fat-fingers a discount. Without void, the fix is to write off
  the phantom invoice and re-key every ticket by hand — the same
  parallel bill-book problem PR 1 was meant to end. Void needs to (a)
  refuse silently mangled workflows (voiding a paid bill), (b) require
  a reason, and (c) put the tickets *back on the KDS* so the kitchen
  isn't confused about a "completed" table that suddenly has more
  orders coming.
- **Mark paid**: `payment_status: 'pending'` from PR 1 was a
  placeholder. Even before real payment capture (PR 4), reception
  needs to record which method was used, when, so the daily reconcile
  works. The `mark-paid` call also gives PR 4 a clean seam — it will
  replace direct calls with the outcome of an actual payment
  integration without changing the invoice contract.

State transitions locked in:

    pending → paid      (mark-paid)
    pending → voided    (void, tickets reopen)
    paid    → refunded  (future PR)
    * → same state      (refused)
    paid    → voided    (refused; must be refunded instead)
    voided  → paid      (refused)

Every illegal transition returns a specific `code` so the UI can
render the right refusal, and no server state changes on refusal.

---

## 2. What (Code & Endpoints)

### Modified

1. **`hub_server/lib/ticketStore.js`**
   - `clearTableTickets(...)` now stamps `pre_clear_status` on each
     cleared ticket so a later void can restore its exact prior state
     (`in_progress` vs `ready`).
   - New `reopenTickets(ticketIds, restaurantId)` — filters to the
     tenant's tickets whose current status is `completed`, restores
     `pre_clear_status`, strips the marker, and returns the ids of
     tickets actually reopened.

2. **`hub_server/lib/invoiceStore.js`**
   - `voidInvoice(id, restaurantId, { reason, actor })` —
     refuses unknown id (`NOT_FOUND`), already voided (`ALREADY_VOIDED`),
     already paid (`ALREADY_PAID` — must be refunded instead), already
     refunded (`ALREADY_REFUNDED`), and missing / blank reason
     (`REASON_REQUIRED`). Records `voided_at`, `voided_reason`
     (240-char cap), `voided_by`.
   - `markPaid(id, restaurantId, { method, actor })` — refuses
     unknown id, illegal transitions from voided/refunded/paid, and
     unknown methods (`INVALID_METHOD`; allowed: `cash` / `upi` /
     `card` / `other`). Records `payment_status: 'paid'`,
     `payment_method`, `paid_at`, `paid_by`.

3. **`hub_server/server.js`**
   - New `POST /invoices/:id/void` — auth'd, reads
     `{ reason, actor? }`, invokes `voidInvoice`, then calls
     `ticketStore.reopenTickets(...)` for the invoice's `ticket_ids`.
     Broadcasts `INVOICE_VOIDED` over WS with the reopened ticket ids
     so waiter handsets can refresh their floor grid immediately.
     Response also carries updated `tables`.
   - New `POST /invoices/:id/mark-paid` — auth'd, reads
     `{ payment_method, actor? }`, invokes `markPaid`, broadcasts
     `INVOICE_PAID`.
   - Error handling matches the M1 convention: 404 on `NOT_FOUND`,
     400 with `code` on every other refusal.

4. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - Once an invoice is issued, the modal now shows a status pill that
     colour-codes the current `payment_status`:
     `⏳ INV-000001 · Awaiting payment` (amber),
     `✓ INV-000001 · Paid · UPI` (green),
     `✕ INV-000001 · Voided` (rust, with reason line).
   - `Mark paid` row of four buttons (`CASH` / `UPI` / `CARD` /
     `OTHER`), each calling `POST /invoices/:id/mark-paid`.
   - `Void bill (reopens tickets)` button — uses `window.prompt` for
     the required reason, then calls `POST /invoices/:id/void`. On
     success it closes the modal and refetches active tickets so the
     reopened KOTs appear on the rail immediately.
   - Modal actions are disabled while a request is in flight to avoid
     double-firing state transitions.

5. **`supabase_schema.sql`** — `invoices` gains lifecycle columns.
   - `payment_method` (`cash|upi|card|other`, populated on mark-paid).
   - `paid_at`, `paid_by`.
   - `voided_at`, `voided_reason` (TEXT), `voided_by`.
   - `payment_status` `CHECK` constraint from PR 1 already accepts
     `'voided'` and `'refunded'`, so no constraint change is needed.

---

## 3. Test Cases

All 37 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-16 | Void requires auth | 401 without bearer | ✅ |
| M1-17 | Void of unknown invoice | 404 | ✅ |
| M1-18 | Void without a reason | 400 with `REASON_REQUIRED` | ✅ |
| M1-19 | Void reopens the underlying tickets | Preview 404 → 200, invoice.grand_total preserved | ✅ |
| M1-20 | Double-void | 400 with `ALREADY_VOIDED` | ✅ |
| M1-21 | Mark-paid transitions status + records method | `payment_status: 'paid'`, `payment_method: 'upi'`, `paid_at` set | ✅ |
| M1-22 | Mark-paid with unknown method | 400 with `INVALID_METHOD` | ✅ |
| M1-23 | Voiding a paid invoice | 400 with `ALREADY_PAID` | ✅ |
| M1-24 | Mark-paid on a voided invoice | 400 with `ALREADY_VOIDED` | ✅ |

### Live smoke test

Modal against seed T8 (₹833 subtotal → ₹875 with 5% GST):

```
[Close Bill · ₹875]   → ⏳ INV-000001 · Awaiting payment
[click UPI]           → ✓ INV-000001 · Paid · UPI
```

Voiding an issued (unpaid) invoice reopens the tickets — verified
end-to-end via the tests and via the WS broadcast fired by the route.

Screenshots captured:
- `bill-lifecycle-issued.png` — modal in the "Awaiting payment" state
  with the four method buttons and the Void action.
- `bill-lifecycle-paid.png` — modal after clicking UPI.

---

## 4. Explicitly out of scope

- **Refund** — will land alongside PR 4 (payment capture). Once a
  payment is real (not just marked), refund becomes the mirror of
  mark-paid and can compose with the same code paths.
- **Line-level discounts** and **split-bill** — separate follow-up
  PR, unchanged from the PR 2 plan.
- **Thermal printing** — the paid / voided pill in the modal is the
  affordance a "print receipt" action will attach to.
- **Waiter PIN + CI + crash reporting** — separate follow-up PRs.

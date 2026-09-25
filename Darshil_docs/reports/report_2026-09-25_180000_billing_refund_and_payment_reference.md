# Engineering & Test Audit Report — Refund + Payment Reference

- **Timestamp**: `2026-09-25T18:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Seventh slice of milestone M1 (Payments-ready). Ships the
  two invoice-side pieces a future payment-provider integration will
  hook into: full refund (parent + all paid splits) and an optional
  `payment_ref` on every mark-paid so reception can record the UPI
  txn id or card auth code returned by whatever terminal took the
  payment. Provider SDK glue (Razorpay, PhonePe, Pine Labs, Ezetap)
  belongs in a separate PR once a tenant picks a provider and shares
  credentials — this PR gives that PR a clean hook.
- **Related Files**:
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

Stacks on `feat/billing-split-items` (PR 6).

---

## 1. Rationale (Why)

Two operational gaps kept the M1 stack from being usable end-to-end
by a real restaurant:

1. **Nothing tied a settled invoice back to the actual money movement.**
   Reception marked an invoice "Paid · UPI" but the UPI ledger from
   the bank showed a wall of transactions with no PR-1..PR-6 handle
   to reconcile against. This PR adds `payment_ref` — an opaque
   80-char string reception (or a provider integration, later) pastes
   in alongside the method. Stored verbatim on the invoice (and per
   split), surfaced in the modal as "Ref: …", replicated to Supabase.
2. **Refund had no path.** Void was only legal before the guest paid.
   Once paid, the only options were leave-it or double-void-then-
   re-issue — both audit-trail nightmares. This PR closes it with a
   dedicated refund transition that preserves the original payment
   metadata (method, ref, timestamps) so the reconcile can still see
   what came in *and* what went back out.

State transitions locked in for M1 lifecycle:

    pending → paid       (mark-paid)
    pending → voided     (void, tickets reopen)
    paid    → refunded   (refund, this PR)
    paid    → voided     (refused; must refund instead)
    voided  → paid       (refused)
    voided  → refunded   (refused)
    refunded → *         (refused)

Refund of a split invoice is atomic: every paid share flips to
`refunded` with the same reason and timestamp; the parent flips to
`refunded` too. Partial-share refund is out of scope — it composes
cleanly on top of this on a follow-up if a pilot actually needs it.

---

## 2. What (Code & Endpoints)

### Modified

1. **`hub_server/lib/invoiceStore.js`**
   - `markPaid(...)` and `markSplitPaid(...)` accept an optional
     `payment_ref` and persist it (nullable, 80-char cap) on the
     paid record.
   - New `cleanPaymentRef(raw)` helper — string-only, trim, truncate;
     everything else becomes `null` so a bad payload never leaks into
     the invoice JSON.
   - New `refund(id, restaurantId, { reason, actor })` — refuses
     unknown id (`NOT_FOUND`), already refunded (`ALREADY_REFUNDED`),
     voided (`ALREADY_VOIDED`), non-paid (`NOT_PAID`), missing /
     blank reason (`REASON_REQUIRED`). Sets `payment_status:
     'refunded'`, records `refund_at`, `refund_reason` (240-char
     cap), `refund_by`. For split invoices, mirrors the transition
     onto every already-paid share (`payment_status: 'refunded'`,
     `refund_at`, `refund_reason`, `refund_by`) so a per-share audit
     ledger still shows which method + reference actually needs
     reversing at the payment provider.

2. **`hub_server/server.js`**
   - New `POST /invoices/:id/refund` (auth'd, `requireDevice`). Body:
     `{ reason, actor? }`. Returns 404 on `NOT_FOUND`, 400 on
     everything else. Broadcasts `INVOICE_REFUNDED` over WS so
     waiter handsets can update the floor grid.
   - Existing `POST /invoices/:id/mark-paid` and `POST
     /invoices/:id/splits/:index/mark-paid` now pass through
     `body.payment_ref` — additive, no change to accepted payloads.

3. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - New `paymentRef` state (string). Shown as a monospace text
     input above the method buttons in both the single-mark-paid
     section and the per-split section. Placeholder makes the
     intended contents explicit ("UPI txn id", "for next split").
     Cleared automatically after any mark-paid call so the next
     settlement starts blank.
   - `refundInvoice()` handler prompts with `window.prompt` for a
     required reason (identical UX to the void prompt from PR 3),
     then POSTs the refund route. On success, the modal updates to
     the refunded state.
   - Paid pill for `payment_status: 'paid'` now shows the payment
     reference on a second line (`Ref: UPI/2026/9F82AB`) when one
     was captured.
   - New `↩ INV-000001 · Refunded` pill for `payment_status:
     'refunded'`, with the refund reason on a following line.
   - `Refund invoice` button surfaces only when the invoice is
     `paid`, and is disabled while a request is in flight.

4. **`supabase_schema.sql`** — `invoices` gains
   `payment_ref VARCHAR(80)`, `refund_at TIMESTAMPTZ`,
   `refund_reason TEXT`, `refund_by VARCHAR(60)`. The
   `payment_status` `CHECK` constraint from PR 1 already accepts
   `'refunded'`, so no constraint change is needed.

---

## 3. Test Cases

All 70 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 PR 5 + 8 PR 6 + 8 new). Run:
`npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-50 | Refund requires auth | 401 | ✅ |
| M1-51 | Refund on an unpaid invoice → 400 `NOT_PAID` | ✅ |
| M1-52 | Refund without a reason → 400 `REASON_REQUIRED` | ✅ |
| M1-53 | Refund flips paid → refunded, records reason + timestamp, preserves original method + payment_ref for audit | ✅ |
| M1-54 | Double refund → 400 `ALREADY_REFUNDED` | ✅ |
| M1-55 | Refunding a split invoice flips every paid share to refunded (each keeps its method for audit); parent flips to refunded | ✅ |
| M1-56 | `payment_ref` survives mark-paid roundtrip on both parent and split | ✅ |
| M1-57 | `payment_ref` longer than 80 chars is trimmed to 80 | ✅ |

### Live smoke test

Seed T8 (₹875 grand). Modal → type `UPI/2026/9F82AB` into the
Payment reference input → tap UPI:

```
✓ INV-000001 · Paid · UPI
Ref: UPI/2026/9F82AB
[Refund invoice]
```

Screenshot saved to `bill-refund-flow.png`.

---

## 4. Explicitly out of scope

- **Real payment provider integrations** (Razorpay, PhonePe, Pine
  Labs, Ezetap, Stripe). This PR gives them the seam — reception
  types the txn ref today, the provider will write it tomorrow.
- **Partial refund** (refund only some of a bill after a dish is
  comped post-payment). Composes on the same `refund_reason` +
  `refund_at` fields; not needed for M1.
- **Per-split refund** (reverse one paid share, leave the others
  settled). Same story — same fields, gated behind a per-share
  route when a pilot needs it.
- **Line-level discounts, thermal printing, waiter PIN, CI** — later
  M1 PRs.

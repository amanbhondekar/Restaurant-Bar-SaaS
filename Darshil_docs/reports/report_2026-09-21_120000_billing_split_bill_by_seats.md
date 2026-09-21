# Engineering & Test Audit Report — Split-Bill by Seats

- **Timestamp**: `2026-09-21T12:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Fourth slice of milestone M1 (Payments-ready). Adds seat-based
  splitting of a single issued invoice into N equal shares that settle
  independently, plus the state guardrails that keep split, void, and
  parent-level mark-paid from stepping on each other. Stacks on PR 3
  (`feat/billing-lifecycle`). Item-level and amount-based splits are
  explicit follow-ups — same data model, different subset math.
- **Related Files**:
  - `hub_server/lib/split.js` [NEW]
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

---

## 1. Rationale (Why)

Reception routinely watches a table of six split the bill 3–4 ways when
paying — one card, one UPI, cash for the rest. Without server-side
splits, the workflow degenerates back to a bill book: reception writes
the total on paper, does the math on a phone calculator, and settles
each portion by hand. That's precisely the parallel-book problem PR 1
was meant to end for full-table payments, and PR 3 for single-method
payments. This PR closes it for multi-payer settlements.

The design keeps the invoice as a single source of truth (one table →
one bill from the kitchen's perspective) and adds a lightweight
`splits[]` array riding on the same document. Each split has its own
`payment_status`, `payment_method`, and `paid_at`. When every split is
paid, the parent invoice flips to `paid` with `payment_method: 'split'`
so the daily reconcile can distinguish a split settlement from a
single-method one.

Rupee-fair rounding is non-negotiable: shares must be integers and
must sum EXACTLY to `grand_total`. `computeSeatSplits(total, n)` hands
`floor(total/n)` to each seat and distributes the leftover rupees as
`+1` to the first `remainder` seats (never to the last, so the printed
share list reads with the "biggest first"). The invariant is asserted
in the split module and again in the parent-settled test.

State guardrails locked in:

- Splitting a voided / refunded / already-paid invoice — refused.
- Re-splitting an already-split invoice — refused (`ALREADY_SPLIT`);
  reception must `Undo split` first.
- Undoing a split after any share is paid — refused (`SPLIT_PAID`);
  that money belongs to a settled record.
- Voiding a split invoice with a paid share — refused
  (`SPLIT_PAID`).
- `POST /invoices/:id/mark-paid` on a split invoice — refused
  (`INVOICE_SPLIT`); reception must settle each split individually.
- Paying the same split twice — refused (`ALREADY_PAID`).
- Unknown split index — refused (`UNKNOWN_SPLIT`).
- Unknown payment method — refused (`INVALID_METHOD`).

---

## 2. What (Code & Endpoints)

### New

1. **`hub_server/lib/split.js`** — pure math module.
   - `validateSeatCount(raw, { min = 2, max = 40 })`: whole number in
     range or `{ ok: false, error }`.
   - `computeSeatSplits(grandTotal, count)`: returns an array of
     `{ index, label, share_amount, payment_status: 'pending',
     payment_method: null, paid_at: null }`. Asserts
     `sum(share_amount) === grandTotal`.

### Modified

2. **`hub_server/lib/invoiceStore.js`**
   - `splitBySeats(id, restaurantId, { count, actor })`: validates state,
     calls `computeSeatSplits`, persists `splits`, `split_mode: 'seats'`,
     `split_at`, `split_by`.
   - `unsplit(id, restaurantId)`: strips all split fields when nothing
     is paid; refused (`SPLIT_PAID`) once any share is paid.
   - `markSplitPaid(id, restaurantId, { splitIndex, method, actor })`:
     marks one share paid, flips parent to `paid` /
     `payment_method: 'split'` when every share is paid, returns
     `parent_settled: true|false`.
   - `markPaid(...)` now refuses (`INVOICE_SPLIT`) once an invoice is
     split.
   - `voidInvoice(...)` now refuses (`SPLIT_PAID`) once any share is paid.

3. **`hub_server/server.js`**
   - `POST /invoices/:id/split-by-seats` (auth'd) — `{ count, actor? }`.
   - `DELETE /invoices/:id/splits` (auth'd).
   - `POST /invoices/:id/splits/:index/mark-paid` (auth'd) —
     `{ payment_method, actor? }`.
   - WS broadcasts: `INVOICE_SPLIT`, `INVOICE_UNSPLIT`,
     `INVOICE_SPLIT_PAID` (with `parent_settled`), plus an additional
     `INVOICE_PAID` when the last share flips the parent.

4. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - Pending, unsplit invoice now shows a `Split by seats` row of
     `2 / 3 / 4 / 5 / 6` buttons alongside the existing method
     buttons.
   - Split invoices render one row per share: `Seat N`, share amount
     in `--font-mono`, and inline `CASH / UPI / CARD` buttons. A row
     flips green with `✓ <method>` once its share is settled.
   - `Undo split` button visible only while every share is still
     pending; disappears the moment any share is paid.

5. **`supabase_schema.sql`** — `invoices` gains
   `splits JSONB`, `split_mode VARCHAR(20)`, `split_at TIMESTAMPTZ`,
   `split_by VARCHAR(60)`. `payment_method` comment updated to include
   `'split'`.

---

## 3. Test Cases

All 47 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-25 | Split-by-seats requires auth | 401 | ✅ |
| M1-26 | 460 subtotal + 5% GST = 483 grand, split 4 → shares [121, 121, 121, 120] sum 483, max-min ≤ 1 | ✅ |
| M1-27 | count in {1, 0, -3, 999, 'x', null} → 400 | ✅ |
| M1-28 | Re-splitting rejected with `ALREADY_SPLIT` | ✅ |
| M1-29 | `mark-paid` on split parent refused (`INVOICE_SPLIT`); `splits/0/mark-paid` succeeds, parent stays pending | ✅ |
| M1-30 | All 3 splits paid → last flips parent to `paid` / method `split`; `parent_settled: true` only on the last | ✅ |
| M1-31 | Double-paying same split → 400 `ALREADY_PAID` | ✅ |
| M1-32 | Unknown split index → 400 `UNKNOWN_SPLIT` | ✅ |
| M1-33 | `DELETE /splits` works with all pending; refused (`SPLIT_PAID`) after any pay | ✅ |
| M1-34 | Voiding a split with a paid share → 400 `SPLIT_PAID` | ✅ |

### Live smoke test

Seed T8 (₹833 subtotal → ₹875 grand). Modal → tap `4`:

```
SPLIT INTO 4 SEATS                       (Undo split)
Seat 1   ₹219   [CASH] [UPI] [CARD]
Seat 2   ₹219   [CASH] [UPI] [CARD]
Seat 3   ₹219   [CASH] [UPI] [CARD]
Seat 4   ₹218   [CASH] [UPI] [CARD]
```

Sum = 219 × 3 + 218 = 875 (rupee-fair). Screenshot saved to
`bill-split-seats.png` for the PR body.

---

## 4. Explicitly out of scope (composes cleanly onto this data model)

- **Item-level split**. Same `splits[]` shape with per-split
  `item_indices: [n, ...]` and per-split tax redistribution — new PR.
- **Amount-based split**. Same shape with reception-supplied
  `share_amount` per split; server validates the sum still equals
  `grand_total` — new PR.
- **Refund** (composes with real payment capture, PR 5).
- **Line-level discounts, thermal printing, waiter PIN, CI** — later
  M1 PRs.

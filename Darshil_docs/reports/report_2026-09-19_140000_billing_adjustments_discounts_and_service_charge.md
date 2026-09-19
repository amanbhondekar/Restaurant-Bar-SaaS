# Engineering & Test Audit Report — Billing Adjustments (Discounts + Service Charge)

- **Timestamp**: `2026-09-19T14:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Second slice of milestone M1 (Payments-ready). Adds
  bill-level discounts (flat or percent) and service charge (percent)
  to the invoice math, wires them through a new preview endpoint, and
  extends the KDS Bill Preview modal so reception can apply them at
  bill-close. Stacked on `feat/billing-foundation` (PR 1). Split-bill
  and void / refund are separate follow-up PRs.
- **Related Files**:
  - `hub_server/lib/adjustments.js` [NEW]
  - `hub_server/lib/tax.js` [MODIFY]
  - `hub_server/lib/invoice.js` [MODIFY]
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

---

## 1. Rationale (Why)

PR 1 gave the hub a bill, a tax breakdown, and an idempotent close.
What it did not give was any way to actually reflect real-world
settlement variations: comping a table, a loyalty discount, or the
Indian restaurant convention of a service charge added on top of the
subtotal but taxed as part of the base.

This PR closes those three holes with the smallest addition that gets
the math right and preserves PR 1's contracts. The invoice's public
shape gains four new fields (`discount_rows`, `discount_total`,
`subtotal_after_discount`, `service_charge_*`, `taxable_base`), but the
old fields (`subtotal`, `tax_rows`, `tax_total`, `grand_total`) keep
their PR 1 semantics when no adjustments are applied — every PR 1 test
still passes byte-for-byte.

### Order of operations

Locked-in for downstream printing and payment code:

    subtotal          = sum(line_totals)
    – discount_total  (bill-level, flat or percent)
    = subtotal_after_discount
    + service_charge  (percent of the discounted subtotal)
    = taxable_base
    + tax             (rules × taxable_base, distributed proportionally)
    = grand_total     (rupee-rounded)

Discounts and service charge fail closed — the whole adjustment set is
validated up front and either the invoice is built with the full set,
or a 400 comes back untouched. There is no partial application.

---

## 2. What (Code & Endpoints)

### New

1. **`hub_server/lib/adjustments.js`** — pure module.
   - `resolveAdjustments({ subtotal, discounts, service_charge_percent })`
     validates each discount row, ensures total discount does not exceed
     subtotal, clamps service charge to `[0, MAX_SERVICE_CHARGE_PERCENT]`
     (`25%`, a sanity cap — no realistic restaurant charges more), and
     returns `{ ok: true, discount_rows, discount_total, subtotal_after_discount,
     service_charge_percent, service_charge_amount, taxable_base }`.
   - Rejects:
     - non-object rows
     - unknown `type`
     - non-numeric or negative `value`
     - `percent > 100`
     - `sum(discounts) > subtotal`
     - `service_charge_percent < 0` or `> 25`

### Modified

2. **`hub_server/lib/tax.js`**
   - `computeTax(items, rules, { taxableBase })`: when a caller passes a
     pre-computed `taxableBase` (i.e. discounts and service charge have
     already been applied), each rule's `taxable_amount` scales
     proportionally from its unscoped per-line contribution. This keeps
     scoped rules (`veg` / `non_veg` / `category`) directionally
     correct once they land: a category-only rule still taxes only that
     category's share of the base. The plain no-adjustment path is
     bit-for-bit identical to PR 1.

3. **`hub_server/lib/invoice.js`**
   - `buildInvoicePreview` now takes `adjustments` and threads it
     through `resolveAdjustments` before `computeTax`.
   - Return shape switched to `{ ok: true, ...invoice }` /
     `{ ok: false, error }` so validation errors propagate cleanly.
   - Tenant default for service charge is read from
     `taxConfig.service_charge_percent`. A caller can override per
     invoice by passing `adjustments.service_charge_percent`.

4. **`hub_server/lib/invoiceStore.js`**
   - `issueInvoice(...)` accepts `adjustments`, forwards it to the
     preview builder, and refuses to persist when validation fails
     (returns the same `error` up to the route). The idempotency check
     for double-clears is unchanged.

5. **`hub_server/server.js`**
   - New `POST /tables/:id/invoice/preview` — auth'd, accepts
     `{ discounts?, service_charge_percent? }`, returns the recomputed
     preview. Returns `400` with `code: 'INVALID_ADJUSTMENTS'` on
     validation failure.
   - `POST /tables/:id/clear` and `POST /orders/:id/clear` now read the
     same body shape and pass it through to `issueInvoiceForTable`. A
     validation failure fails the whole request; tickets stay open so
     reception can fix the input and retry. Preserves PR 1's
     idempotency for the no-adjustments case.
   - Shared `buildPreviewForTable()` helper factored so `GET
     /tables/:id/invoice` and the new `POST` reuse identical error
     handling.

6. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - New adjustment form with:
     - Discount type dropdown (`Discount %` / `Discount ₹`)
     - Discount value (numeric)
     - Optional reason (free text, 120 char cap enforced server-side)
     - Service charge percent (numeric)
   - Debounced (~220 ms) recompute against `POST
     /tables/:id/invoice/preview` while reception types.
   - Modal now shows discount rows (green, minus-signed) and a service
     charge row before the tax rows.
   - "Close Bill · ₹XXX" button now the primary action; on success it
     shows the issued invoice number instead of the input form.

7. **`supabase_schema.sql`** — `invoices` table gains matching columns:
   `discount_total`, `discount_rows` (JSONB), `subtotal_after_discount`,
   `service_charge_percent`, `service_charge_amount`, `taxable_base`.
   Existing constraints, RLS, and `UNIQUE(restaurant_id, invoice_number)`
   unchanged.

---

## 3. Test Cases

All 28 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-07 | Flat bill discount subtracted before tax | 460 − 60 = 400 taxable, 5% GST = 20 → 420 | ✅ |
| M1-08 | Percent bill discount subtracted before tax | 440 − 10% = 396 taxable, 5% GST → 416 | ✅ |
| M1-09 | Service charge added before tax | 230 + 10% = 253 taxable, 5% GST = 12.65 → 266 | ✅ |
| M1-10 | Discount + service charge compose in correct order | 460 → −46 → 414 → +5% (20.7) → 434.7 taxable → 456 grand | ✅ |
| M1-11 | Adjustments persist onto the issued invoice, retrievable by invoice number | ✅ |
| M1-12 | Discount larger than subtotal → 400 `INVALID_ADJUSTMENTS` | ✅ |
| M1-13 | Negative discount → 400 | ✅ |
| M1-14 | Percent discount > 100 → 400 | ✅ |
| M1-15 | Invalid adjustments on `/clear` refuse the close and leave tickets openable; retry with valid body issues an invoice | ✅ |

### Live smoke test

Against seed T8 (ticket #133, subtotal ₹833) with a 10% discount
(reason "Loyalty") and 5% service charge, via the modal:

```
Subtotal            ₹833
Discount (10%) · Loyalty   −₹83.30
Service charge (5%)  ₹37.49
CGST (2.5%)          ₹19.68
SGST (2.5%)          ₹19.68
Grand Total          ₹827
```

Modal recomputes on each keystroke via the debounced POST preview call.
Screenshot captured for the PR body.

---

## 4. Explicitly out of scope

- **Line-level discounts** ("comp Chicken Tikka"). The line-level scope
  is already reserved in `adjustments.js` (`scope: 'bill'` on every
  row), so a follow-up can add `scope: 'line'` without breaking clients.
- **Split-bill** (by seat / by items / by amount). Next M1 PR.
- **Void / refund** — separate PR. The `payment_status` enum already
  reserves `'refunded'` and `'voided'`.
- **Payment capture** (UPI / cash / card).
- **Thermal printing** — the invoice JSON is already the source of truth
  a printer template will consume.

# Engineering & Test Audit Report — Split-Bill by Items

- **Timestamp**: `2026-09-25T12:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Sixth slice of milestone M1 (Payments-ready). Third and
  final split mode: reception assigns each line item to exactly one
  split, and the server distributes `grand_total` proportionally to
  each split's item subtotal, using largest-remainder allocation so
  every share is an integer rupee and the shares still sum exactly to
  `grand_total`. Downstream per-split settlement + parent roll-up +
  undo-split + void guardrails from PRs 4-5 are inherited unchanged.
  Stacks on `feat/billing-split-amounts` (PR 5).
- **Related Files**:
  - `hub_server/lib/split.js` [MODIFY]
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

---

## 1. Rationale (Why)

Seat splits (PR 4) cover "divide equally". Amount splits (PR 5) cover
"one person pays this much, another pays that much, we did the math on
a phone". Item splits are the third real workflow: at a mixed table,
one couple wants to pay for their own dishes, and the other couple
theirs. Without item-level splits, reception has to look up unit prices
from the printed bill and type the amounts into the amount-split
form — accurate but slow, and error-prone once you multiply by qty and
add a share of tax.

The design is deliberately the minimum lift over PR 5:

- Same `splits[]` array on the invoice.
- Same per-share `mark-paid` route (PR 4).
- Same parent-settled roll-up: when every share is paid the parent
  flips to `paid` / `payment_method: 'split'` (PR 4).
- Same undo-split guardrails (PR 4).
- Same rejection code posture as PR 5 — a specific `INVALID_ITEM_SPLITS`
  code with an actionable error string.

Two things are genuinely new:

1. **`item_indices` on every split**: an array of 0-based positions
   into `invoice.items`. Every index in `0..items.length-1` must
   appear in exactly one split. Empty splits are refused (an empty
   share has nothing to charge for).
2. **Proportional share allocation with rupee-fair rounding**. The
   raw share is `split_subtotal / invoice.subtotal * grand_total`.
   Floor each, sum the floors, and hand out the leftover rupees to
   the splits with the largest fractional parts. Ties broken by
   original index so the allocation is deterministic. Invariant
   asserted: shares sum to `grand_total` to the rupee.

---

## 2. What (Code & Endpoints)

### Modified

1. **`hub_server/lib/split.js`**
   - Adds `MIN_ITEM_SPLITS = 2` / `MAX_ITEM_SPLITS = 40` (matches seat
     and amount caps).
   - Adds `validateItemSplits(rawSplits, invoice)` — refuses:
     non-array, out-of-range length, non-object rows, empty
     `item_indices`, non-integer / out-of-range indices, duplicate
     indices *inside* one split, duplicate indices *across* splits,
     unassigned items ("Item 2 not assigned to any split"). Persists
     each split's `split_subtotal` for the UI/receipt to display and
     computes `share_amount` via largest-remainder allocation.

2. **`hub_server/lib/invoiceStore.js`**
   - New `splitByItems(id, restaurantId, { splits, actor })`. Shares
     every state guardrail with `splitBySeats` / `splitByAmounts` —
     same rejection codes for paid / voided / refunded /
     already-split parents. Persists `split_mode: 'items'` alongside
     the finalised split rows.

3. **`hub_server/server.js`**
   - New `POST /invoices/:id/split-by-items` (auth'd). Body: `{ splits:
     [{ label?, item_indices: [n, n, ...] }], actor? }`. Broadcasts
     the same `INVOICE_SPLIT` WS event as the other modes so
     listeners don't have to switch on `split_mode`.

4. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - New `By items…` button next to `Custom amounts…`.
   - Inline picker: one row per invoice line, showing `qty × name` +
     line total on the left and a pill row of `1..N` on the right
     (assign this line to split N). Every line starts on split 1.
   - Header row lets reception grow / shrink the number of splits
     (2..6 in the UI, server enforces up to 40). Shrinking clamps any
     out-of-range assignment back to split 1.
   - Live per-split subtotal readout. Any empty split shows in rust
     with an "empty" label and a footer warning
     `Every split needs at least one item (N empty)`; Apply is
     disabled until every split has ≥ 1 item.
   - Split-mode-aware heading updated to render `N SHARES` for both
     `amounts` and `items` splits (only `seats` shows `SEATS`).

5. **`supabase_schema.sql`** — `splits` JSONB comment updated to note
   item-mode entries also carry `item_indices` and `split_subtotal`;
   `split_mode` comment expanded to include `'items'`.

---

## 3. Test Cases

All 62 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 PR 5 + 8 new). The test-menu
fixture gains one available `m4` item so a three-way rounding case can
be exercised. Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-42 | Split-by-items requires auth | 401 | ✅ |
| M1-43 | Two lines (m1×2 = 460, m2×1 = 220), split one-line-each on ₹714 grand → shares [483, 231] sum 714 with matching split_subtotal | ✅ |
| M1-44 | Three lines (230, 220, 340) on ₹830 grand → largest fractional part (idx 0) receives the +1 rupee remainder; shares sum 830 exact | ✅ |
| M1-45 | Assigning one item to two splits → 400 `INVALID_ITEM_SPLITS` with `assigned to both split` | ✅ |
| M1-46 | Empty split (`item_indices: []`) → 400 with `non-empty array` | ✅ |
| M1-47 | Unassigned item → 400 with `Item 2 not assigned` | ✅ |
| M1-48 | Out-of-range index → 400 with `out of range` | ✅ |
| M1-49 | Item-split shares settle via `POST /splits/:i/mark-paid`; parent flips to `paid` / method `split` on the last share (same route path as seat + amount splits) | ✅ |

### Live smoke test

Seed T8 (₹833 subtotal, ₹875 grand, 4 lines). Modal → `By items…` →
default 2 splits with everything on split 1 → footer warning
"Every split needs at least one item (1 empty)", Apply disabled.

Assign the two chicken items to split 2 by clicking their `2` pill:

```
BY ITEMS · 2 SPLITS                     [+ split] [− split]
1× Veg Manchow Soup   ₹143   ⚫ 1  ○ 2
1× Chicken Sukka      ₹220   ○ 1  ⚫ 2
1× Chicken Lollipop   ₹240   ○ 1  ⚫ 2
1× Paneer Tikka       ₹230   ⚫ 1  ○ 2

Split 1 subtotal            ₹373
Split 2 subtotal            ₹460

[Cancel]        [Apply split]
```

Apply → per-share row list:

```
SPLIT INTO 2 SHARES                             Undo split
Split 1  ₹392   [CASH] [UPI] [CARD]   ← 373/833 × 875 = 391.7…, +1 rupee remainder
Split 2  ₹483   [CASH] [UPI] [CARD]   ← 460/833 × 875 = 483.2… floor
                                        ─────
                                        875 exact
```

Screenshots: `bill-split-items-picker.png` (picker mid-assignment)
and `bill-split-items-applied.png` (settled row list).

---

## 4. Explicitly out of scope

- **Refund** — composes with real payment capture, PR 7.
- **Line-level discounts, thermal printing, waiter PIN, CI** — later
  M1 PRs.

With PR 6 the three split modes (seats, amounts, items) M1 needs to
run a paid pilot are all in place. Remaining M1 work is: real payment
capture with refund (PR 7), ESC/POS thermal printing (PR 8), waiter
PIN login (PR 9), and CI + crash reporting (PR 10).

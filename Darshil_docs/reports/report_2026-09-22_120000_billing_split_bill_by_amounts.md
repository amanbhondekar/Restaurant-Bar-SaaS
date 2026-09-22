# Engineering & Test Audit Report — Split-Bill by Amounts

- **Timestamp**: `2026-09-22T12:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Fifth slice of milestone M1 (Payments-ready). Adds a second
  split mode alongside PR 4's equal seat splits: reception supplies a
  labelled amount per split, and the server enforces that the amounts
  sum EXACTLY to `grand_total`. Downstream per-split settlement,
  parent-settled roll-up, undo-split, and void guardrails from PR 4
  are unchanged and inherited unchanged. Stacks on
  `feat/billing-split-seats` (PR 4). Item-level splits are the next
  PR and land on the same data model.
- **Related Files**:
  - `hub_server/lib/split.js` [MODIFY]
  - `hub_server/lib/invoiceStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]

---

## 1. Rationale (Why)

Seat splits from PR 4 cover the common "divide equally" case, but
real payments rarely land that way. When one guest picks up more of
the bill, or a specific person is paying for exactly the vegetarian
share, or three people want it split ₹500 / ₹200 / ₹175 for reasons
that live outside the POS's model, reception needs to type the
amounts in directly.

The design is the smallest useful addition on top of PR 4. Same
`splits[]` shape on the invoice. Same per-share `mark-paid` route.
Same parent-settled roll-up. Only two things are new: a
`validateAmountSplits` pass that rejects everything except a strict
positive-integer set summing to `grand_total`, and a small inline
UI in the modal.

**No partial-application, no rounding, no tolerance.** The server
either accepts the whole payload (sum matches exactly) or refuses
with a specific `short by ₹X` / `over by ₹X` diagnostic. A "close
enough" tolerance would hide shorted totals until the day-end
reconcile — better to catch them at the register.

The custom-amounts form seeds itself with an equal split so
reception can either edit from a sensible starting point or wipe
each row and type from scratch. A live `Target: ₹X · ✓ Balanced /
Short by ₹Y / Over by ₹Y` line gives immediate feedback without a
round trip.

---

## 2. What (Code & Endpoints)

### Modified

1. **`hub_server/lib/split.js`**
   - Adds `MIN_AMOUNT_SPLITS = 2`, `MAX_AMOUNT_SPLITS = 40` (matches
     seat range).
   - Adds `validateAmountSplits(rawSplits, grandTotal)` — refuses
     non-array, out-of-range length, non-object row, non-integer or
     non-positive `share_amount`, `share_amount > grand_total`, or
     `sum !== grandTotal`. On mismatch the error carries `short by
     ₹X` / `over by ₹X` so both UI and audit log read cleanly.
   - Emits `label` defaulted to `Split N` when the caller omits it,
     trimmed and truncated to 40 chars otherwise.

2. **`hub_server/lib/invoiceStore.js`**
   - New `splitByAmounts(id, restaurantId, { splits, actor })`.
     Shares every state guardrail with `splitBySeats` — same
     rejection codes for paid / voided / refunded / already-split
     parents. On success persists `split_mode: 'amounts'` alongside
     the validated share rows.

3. **`hub_server/server.js`**
   - New `POST /invoices/:id/split-by-amounts` (auth'd,
     `requireDevice`). Body: `{ splits: [{ label?, share_amount },
     ...], actor? }`. Broadcasts the same `INVOICE_SPLIT` WS event
     PR 4 already emits so listeners don't have to switch on
     `split_mode`.

4. **`src/kitchen_main.jsx`** — KDS Bill Preview modal.
   - New "Custom amounts…" button next to the seat-count row.
     Opens an inline form with two rows seeded to an equal split
     (uses the same rupee-fair math as `computeSeatSplits`).
   - Rows: optional label input + rupee amount input. `+ row` and
     `− row` buttons on the header adjust the row count (clamped
     to 2–40 client-side; server enforces the same bounds).
   - Live status line: `Target: ₹X` with `✓ Balanced` (green) or
     `Short by ₹X` / `Over by ₹X` (rust). Apply button disabled
     until balanced, all amounts positive, and no non-integers.
   - Split-mode-aware heading: `SPLIT INTO N SHARES` for amount
     splits vs `SPLIT INTO N SEATS` for seat splits.
   - Per-share settlement (CASH / UPI / CARD row per split) reuses
     PR 4's UI verbatim; nothing had to change there.
   - Panel state resets on modal close so a draft from one bill
     never leaks into the next.

---

## 3. Test Cases

All 54 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-35 | Split-by-amounts requires auth | 401 | ✅ |
| M1-36 | Labelled shares [Rohit ₹200, Priya ₹183, Ankit ₹100] on ₹483 grand — accepted, `split_mode: 'amounts'`, sum matches | ✅ |
| M1-37 | Missing labels default to `Split 1` / `Split 2` | ✅ |
| M1-38 | Short-sum → 400 with error text `short by ₹283`; over-sum → 400 with `over by ₹117` | ✅ |
| M1-39 | Negative / zero / non-integer / single-split / non-array payloads → 400 | ✅ |
| M1-40 | Split-by-amounts refused on already-split invoice → 400 `ALREADY_SPLIT` | ✅ |
| M1-41 | Amount-split shares settle via `POST /splits/:i/mark-paid` identically to seat splits; parent rolls to `paid` / method `split` on the last share | ✅ |

### Live smoke test

Seed T8 (₹875 grand). Modal → `Custom amounts…` → the equal-split
seed appears (2 rows @ ₹438, ₹437). Add a third row, then type:

```
Rohit  ₹500
Priya  ₹200
Ankit  ₹175
Target: ₹875   ✓ Balanced   [Apply split]
```

Apply → per-share row list:

```
SPLIT INTO 3 SHARES                          Undo split
Rohit   ₹500   [CASH] [UPI] [CARD]
Priya   ₹200   [CASH] [UPI] [CARD]
Ankit   ₹175   [CASH] [UPI] [CARD]
```

Screenshot captured (`bill-split-amounts-form.png`) showing the
balanced form state before submit.

---

## 4. Explicitly out of scope

- **Item-level split** — next PR. Same `splits[]` model with an
  additional `item_indices: [...]` per split and proportional
  redistribution of tax / discount / service charge.
- **Refund** — composes with real payment capture, PR 6.
- **Line-level discounts, thermal printing, waiter PIN, CI** — later
  M1 PRs.

# Engineering & Test Audit Report — Billing Foundation (Invoice + Tax)

- **Timestamp**: `2026-09-19T12:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: First slice of milestone M1 (Payments-ready). Adds a
  tenant-configurable tax module, a server-side invoice generator, a
  persistent invoice ledger, three new hub endpoints, an on-close
  invoice issue step wired into both `/tables/:id/clear` and
  `/orders/:id/clear`, a `Bill Preview` modal in the Kitchen Display,
  Supabase schema for cloud replication, and six new regression tests.
- **Related Files**:
  - `hub_server/lib/tax.js` [NEW]
  - `hub_server/lib/invoice.js` [NEW]
  - `hub_server/lib/invoiceStore.js` [NEW]
  - `hub_server/lib/ticketStore.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `supabase_schema.sql` [MODIFY]

---

## 1. Architectural Rationale & Root Cause Analysis (Why)

Everything shipped so far reliably captures orders and pushes them to the
kitchen; nothing on the hub understands the *bill*. Every tenant that has
piloted the system has run a parallel manual bill book at the register,
because the platform has no notion of tax, no notion of an issued invoice
number, and no on-record artefact of "this table paid ₹X on this date".
That is the gate that has to close before any restaurant can settle
customer payments end-to-end through the platform, and it is the reason
milestone M1 (Payments-ready) exists in `docs/ROADMAP.md`.

The design deliberately keeps this PR narrow. Downstream milestones
(split-bill, discounts, service charge, void / refund, payment capture,
thermal printing, waiter PIN, CI) each add their own file and their own
tests. What is landing here is the smallest addition that lets the hub
answer three questions authoritatively:

1. "What does the guest at Table X owe right now?"
2. "Break that down by tax head."
3. "Issue an invoice number when they settle and remember it forever."

Two invariants shaped the code:

- **Billing must fail closed.** `lib/pricing.js` already refuses to trust
  handset-supplied prices; the new invoice generator inherits that
  posture — item names, prices, tax rates and totals are all computed
  server-side from the hub's menu cache and the tenant's tax config, not
  from anything a caller can inject.
- **No double-charge on a retry.** Networks flake. `/tables/:id/clear`
  is one POST, and it is entirely reasonable for a shaky handset to send
  it twice. `invoiceStore.issueInvoice()` is idempotent per
  `(restaurant_id, table_id, ticket ids)`: the second call gets the
  original invoice back, not a second charge.

---

## 2. Comprehensive Code & Endpoint Audit (What)

### Files Created

1. **`hub_server/lib/tax.js`** — pure module.
   - `DEFAULT_TAX_RULES`: `CGST 2.5% + SGST 2.5%` (the standard Indian GST
     split for restaurants), applied when the tenant has no config.
   - `resolveTaxRules(config)`: reads from `config.tax_rules`,
     `config.settings.tax`, or `config.tax` in that order; falls back to
     defaults when the tenant supplies nothing valid.
   - `computeTax(items, rules)`: returns
     `{ subtotal, tax_rows, tax_total, grand_total }`. Each `tax_row` has
     `{ label, rate_percent, taxable_amount, amount }`.
   - Rounding: line amounts to 2dp (half-up); final `grand_total`
     rupee-rounded so the printed bill never carries paise.
   - Scoping: `matchesScope()` supports `'all'`, `'veg'`, `'non_veg'`,
     and `'category:<id>'`. Only `'all'` is exercised in this PR; the
     others are unblocked for follow-ups without changing the invoice
     contract.

2. **`hub_server/lib/invoice.js`** — pure module.
   - `buildInvoicePreview({ tickets, tableId, tableName, restaurantId, currency, taxConfig })`:
     folds every open ticket for one table into a single itemised
     invoice preview, enriches each line with `isVeg` / `category` from
     the live menu cache (so scoped tax rules will just work later), and
     runs it through `computeTax`. Does **not** persist.

3. **`hub_server/lib/invoiceStore.js`** — persistent ledger.
   - JSON-file store at `hub_server/data/invoices.json`, matching the
     existing `ticketStore` pattern.
   - `nextInvoiceNumber(restaurantId)` → `INV-000001`, `INV-000002`, …
     tenant-sequential and zero-padded.
   - `issueInvoice(...)` is idempotent by ticket-id fingerprint (see
     Invariants). Returns `{ ok, invoice, duplicate }`.
   - Also stores `payment_status: 'pending'`, `synced_to_cloud: false`
     as forward hooks for the payment-capture PR and cloud-sync PR.

### Files Modified

4. **`hub_server/lib/ticketStore.js`**
   - New helper `getActiveTicketsForTable(tableId, restaurantId)` so the
     invoice generator does not re-implement the same table-name /
     table-id matching that already lives in `getLiveTables`.

5. **`hub_server/server.js`**
   - Imports `buildInvoicePreview` and `invoiceStore`.
   - New `GET /tables/:id/invoice` — auth'd, returns a preview invoice
     for whatever the table currently owes. 404 with
     `code: 'NO_OPEN_TICKETS'` when nothing is open.
   - New `GET /invoices/:id` — auth'd, retrieves an issued invoice by
     its internal id or its `invoice_number`.
   - New `GET /invoices` — auth'd, lists this tenant's issued invoices.
   - `POST /tables/:id/clear` and `POST /orders/:id/clear` now call a
     shared `issueInvoiceForTable(tableId, pairing)` helper **before**
     clearing the tickets (they need to be queryable to be billed).
     Responses now carry the issued invoice, WS clients receive a new
     `INVOICE_ISSUED` broadcast alongside the existing `CLEAR_TABLE`
     event, and console logs now show the invoice number and total on
     successful settlement.

6. **`hub_server/test/hub.test.mjs`** — six new tests:
   - `M1: /tables/:id/invoice requires auth`
   - `M1: /invoices/:id requires auth`
   - `M1: invoice preview 404s when the table has no open tickets`
   - `M1: invoice preview folds every open ticket for the table into one bill with default 5% GST`
     — creates two separate tickets on the same table (Paneer Tikka ×2
     = 460 + Chicken Sukka ×1 = 220), asserts one folded invoice with
     `subtotal 680`, `CGST 17`, `SGST 17`, `grand_total 714`.
   - `M1: closing the bill issues an invoice number, persists it, and returns it`
     — asserts `invoice_number` matches `/^INV-\d{6}$/`, matches the
     preview total, and is retrievable by both internal id and by
     invoice number.
   - `M1: a network-retry double-close does not double-charge` — asserts
     the second POST returns `cleared_count: 0` and `invoice: null`.

7. **`src/kitchen_main.jsx`** — the live KDS served by the hub.
   - New `Receipt` and `X` icon imports.
   - New state: `billTableId`, `billInvoice`, `billLoading`, `billError`.
   - New handlers `openBill(tableId)` (calls `/tables/:id/invoice`) and
     `closeBill()`.
   - Per-ticket "Bill" button next to "Mark Ready", disabled only if
     the ticket has no `table_id`.
   - New `Bill Preview` modal component with:
     - itemised lines (name, qty, unit price, line total, source ticket
       number)
     - `Subtotal` row
     - one row per tax rule (label + rate + amount)
     - `Grand Total` in the display display-mono style
     - a "not yet issued" disclaimer so reception knows the modal is a
       preview and not a closed bill

8. **`supabase_schema.sql`** — cloud target for a future replication PR.
   - New `public.invoices` table with `hub_invoice_id`
     (unique, mirrors `invoiceStore` id for idempotent replication),
     `invoice_number`, `subtotal`, `tax_total`, `grand_total`,
     `tax_rows` (JSONB), `ticket_ids` (JSONB), `payment_status` check
     constraint, `UNIQUE(restaurant_id, invoice_number)`, and indexes on
     tenant, table, and `issued_at DESC`.
   - New `public.invoice_lines` table with FK to `invoices` and
     `restaurant_id` denorm for RLS.
   - RLS enabled on both, with `Tenant isolation for invoices` and
     `Tenant isolation for invoice_lines` policies mirroring the
     established `current_restaurant_id()` pattern.

---

## 3. Test Cases

All 19 tests in `hub_server/test/hub.test.mjs` pass in the current
tree (13 pre-existing + 6 new). Run: `npm test`.

| ID | Title | Steps | Expected | Actual |
|----|-------|-------|----------|--------|
| M1-01 | Auth required on invoice preview | GET `/tables/9/invoice` without bearer | 401 | 401 ✅ |
| M1-02 | Auth required on invoice retrieval | GET `/invoices/inv_anything` without bearer | 401 | 401 ✅ |
| M1-03 | 404 when no open tickets | GET `/tables/9/invoice` (nothing open) auth'd | 404 with `code: 'NO_OPEN_TICKETS'` | 404 matching ✅ |
| M1-04 | Two tickets fold into one bill with default GST | POST two orders on T3 (m1×2, m2×1), GET `/tables/3/invoice` | subtotal 680, CGST 17, SGST 17, grand_total 714 | Exact match ✅ |
| M1-05 | Close issues invoice, persists, retrievable | Preview → POST clear → GET by id + by invoice_number | Same total as preview; both retrievals 200 | ✅ |
| M1-06 | Double-close is idempotent | Order → clear → clear again | Second: `cleared_count: 0`, `invoice: null` | ✅ |

Additionally, a live smoke test against the running hub against seed
ticket #133 on T8 (₹833 subtotal) returned:

```
subtotal    833
CGST 2.5%   20.83
SGST 2.5%   20.83
tax_total   41.66
grand_total 875     (rupee-rounded)
```

The Bill Preview modal in the KDS renders each figure verbatim from that
JSON.

---

## 4. Follow-up work explicitly out of scope for this PR

Called out here so the roadmap stays honest:

- **Split-bill, discounts, service charge, void / refund** — next M1
  PR. The invoice shape is already stable enough to attach a
  `discount_rows` array without breaking anything.
- **Payment capture (UPI, cash, card)** — separate M1 PR. The
  `payment_status: 'pending'` field is the hook.
- **ESC/POS thermal printing** — separate M1 PR. The invoice JSON is
  already the source of truth a printer template can consume.
- **Cloud replication of invoices** — the Supabase schema is in place
  but no `syncQueue` enqueue path was added yet. Follow-up.
- **Waiter PWA tax display** — the cart is a draft (not yet sent);
  showing tax there would be a lie until we track a per-tenant "tax
  inclusive vs exclusive" flag. Deferring to the payment-capture PR.

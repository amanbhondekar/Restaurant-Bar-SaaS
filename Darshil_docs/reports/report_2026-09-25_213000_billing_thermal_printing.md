# Engineering & Test Audit Report — Thermal Printing (KOT + Receipt)

- **Timestamp**: `2026-09-25T21:30:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Eighth slice of milestone M1 (Payments-ready). Adds ESC/POS
  thermal printing on both ends of the flow: KOT to the kitchen printer
  the moment an order posts, and a customer receipt reception can hit
  Print on when a bill closes. Ships with a preview-mode fallback so
  the full flow works end-to-end (including tests) without any
  hardware — hooking up a real printer is one JSON entry in
  hub_config.json. Stacks on `feat/billing-refund` (PR 7).
- **Related Files**:
  - `hub_server/lib/escpos.js` [NEW]
  - `hub_server/lib/printer.js` [NEW]
  - `hub_server/lib/hubConfig.js` [MODIFY]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]

---

## 1. Rationale (Why)

The M1 stack now understands bills, splits, refunds, and payment
references — everything reception needs to run a paid pilot at the
register. What it still could not do was put paper in a customer's
hand or an order in front of the cook. Restaurants live and die on
paper: the KOT is what the kitchen brigade actually cooks from, and
the printed receipt is what the guest carries out. This PR closes
that gap.

Design constraints:

1. **No native dependencies.** The hub already runs on a plain
   `node hub_server/server.js` — adding `node-escpos` or the like
   would require a native USB build step and drive the deployment
   complexity way up. The 200-line encoder in `lib/escpos.js`
   covers everything our layout needs (init, align, bold, size,
   cut, feed) and leaves the door open for a real dep later.
2. **Network TCP transport** (`host:9100`). Standard for every
   modern thermal receipt printer; no drivers on the reception
   laptop. USB via a helper daemon is a follow-up.
3. **Fail-soft everywhere.** A stuck printer must not lose the
   order in the kitchen or block reception from settling a bill.
   Auto-KOT is fire-and-forget; explicit reprints and receipts
   surface the printer error as JSON but don't touch invoice /
   ticket state.
4. **Preview-mode fallback.** When no printer is configured for a
   role, the routes still return the fully rendered `preview_text`
   so reception (and CI, and demos, and Darshil's review) sees
   exactly what would print. Same code path — no divergent
   "simulated" mode.
5. **Rupee-safe encoding.** CP437 (the default codepage on almost
   every thermal printer) lacks `₹`. The encoder rewrites it
   to `Rs ` on the byte stream so a real print never emits `?`,
   while the preview_text keeps `₹` so reception's monospace
   modal reads naturally.

---

## 2. What (Code & Endpoints)

### New

1. **`hub_server/lib/escpos.js`** — pure encoder.
   - Commands: `init()`, `feed(n)`, `cut()`, `alignLeft/Center/Right`,
     `bold(on)`, `size(widthMul, heightMul)`, `rule(width, ch)`,
     `line(s)`, `text(s, { raw })`, `build(...parts)`.
   - Character sanitiser rewrites `₹`, en/em dashes, curly
     quotes, ellipsis, ` `, and the emoji-glyph symbols we use
     in the app (`✅`, `✖`, `↩`) to CP437-safe
     replacements. Unknown characters degrade to `?` rather than
     blowing up.

2. **`hub_server/lib/printer.js`** — renderers + transport.
   - `renderKot(ticket, tenant)` returns
     `{ escpos: Buffer, preview_text: string }` for a kitchen
     ticket: bold heading, table + ticket number at 2× width,
     timestamp, waiter, checklist items, optional note, feed + cut.
   - `renderReceipt(invoice, tenant)` returns the same shape for
     a customer receipt: tenant block (name + city + phone),
     invoice number, table + timestamp, itemised lines with
     right-aligned totals, per-row summary of subtotal + every
     discount (PR 2) + service charge (PR 2) + every tax row
     (PR 1) + GRAND TOTAL at 1x2, payment method + `Ref: …` if
     captured (PR 7), UNPAID/REFUNDED banners for non-paid states.
   - `sendToPrinter(job, target)` opens raw TCP to `host:port`
     (default `9100`), 4 s connect + 4 s write timeout, closes on
     success or first error. Returns `{ ok, preview?, sent_bytes,
     error?, code? }`. `code` is one of `INVALID_JOB`,
     `CONNECT_FAILED`, `WRITE_FAILED`, `TIMEOUT`.

### Modified

3. **`hub_server/lib/hubConfig.js`** — new `getPrinters(role?)`.
   Reads `config.printers` and normalises each entry into
   `{ id, role: 'kot'|'receipt', host, port, name }`. Empty on
   default configs (which is exactly what triggers preview mode
   downstream).

4. **`hub_server/server.js`**
   - New auth'd routes:
     - `GET /printers` — list configured printers.
     - `POST /orders/:id/print-kot` — explicit KOT reprint. 404 on
       unknown ticket; per-printer results in the response;
       `preview_text` always included.
     - `POST /invoices/:id/print-receipt` — customer receipt.
       Same shape.
   - `POST /orders` now calls `autoPrintKot(newTicket, pairing)`
     fire-and-forget after the response is sent. If no KOT
     printer is configured this is a silent no-op; if the printer
     is unreachable the error is logged with the printer id and
     ticket number and reception can retry via the explicit
     reprint route.

5. **`src/kitchen_main.jsx`**
   - New `Print receipt` button on paid + refunded invoices
     (green, primary style — reception's most-used post-payment
     action).
   - New `printPreview` overlay: monospace modal showing the
     full `preview_text` returned by the hub, with a header line
     indicating whether the bytes were "Sent to printer",
     "Preview only · no printer configured", or "Printer error:
     …". Backdrop-click dismisses.
   - `X` icon reused from `lucide-react` (already imported for
     the void modal and bill preview close).

---

## 3. Test Cases

All 83 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 PR 5 + 8 PR 6 + 8 PR 7 + 13
new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-58 | ESC/POS `init` → `1B 40`, `cut` → `1D 56 00` | ✅ |
| M1-59 | `alignCenter` `1B 61 01`, `bold(true)` `1B 45 01`, `size(2,2)` `1D 21 11` | ✅ |
| M1-60 | Sanitiser rewrites `₹` → `Rs `, en/em dashes → `-` | ✅ |
| M1-61 | `build(init, 'X', cut)` concatenates in order | ✅ |
| M1-62 | `renderKot` `preview_text` contains table + `#N`, waiter, every item, note; bytes start with `1B 40` and end with `1D 56 00` | ✅ |
| M1-63 | `renderReceipt` `preview_text` contains tenant, invoice number, every line, discount row, service charge row, both tax rows, GRAND TOTAL, `Paid: UPI`, `Ref: …`; escpos bytes rewrite `₹` → `Rs ` | ✅ |
| M1-64 | Unpaid invoice preview shows `*** UNPAID — NOT A RECEIPT ***`; refunded shows `*** REFUNDED ***` | ✅ |
| M1-65 | `sendToPrinter({ mode: 'preview' })` returns `{ ok: true, preview: true }` without opening a socket | ✅ |
| M1-66 | `sendToPrinter` to a closed port surfaces `CONNECT_FAILED` / `TIMEOUT` | ✅ |
| M1-67 | `POST /orders/:id/print-kot` on a known ticket returns 200 + `preview_text` with the ticket's `T80` + `#N`; result flagged `preview: true` when no printer configured | ✅ |
| M1-68 | `POST /orders/:id/print-kot` on an unknown ticket → 404 | ✅ |
| M1-69 | `POST /invoices/:id/print-receipt` returns 200 + `preview_text` containing tenant name + invoice number + GRAND TOTAL | ✅ |
| M1-70 | `GET /printers` requires auth; empty when unconfigured | ✅ |

### Live smoke test

Seed T8, ₹875. Modal → type `UPI/2026/9F82AB` → tap UPI →
`✓ INV-000001 · Paid · UPI · Ref: UPI/2026/9F82AB` → tap
**Print receipt**. Overlay renders:

```
Receipt · INV-000001
👁 Preview only · no printer configured
==========================================
              Hotel Mejwani
                  Nagpur
                INV-000001
          T8 · 25/09/2026 21:14
==========================================
Item                 Qty   Price    Total
------------------------------------------
Veg Manchow Soup       1     143      143
Chicken Sukka          1     220      220
Chicken Lollipop       1     240      240
Paneer Tikka           1     230      230
------------------------------------------
                            Subtotal  ₹833
                       CGST (2.5%)  ₹20.83
                       SGST (2.5%)  ₹20.83
==========================================
                         GRAND TOTAL  ₹875
==========================================
     Paid: UPI · Ref: UPI/2026/9F82AB
       Thank you for dining with us
```

Screenshot: `receipt-preview.png`.

---

## 4. Configuring a real printer (one-liner)

Add a `printers` array to `hub_server/data/hub_config.json`:

```json
{
  "paired": true,
  "restaurant_id": "…",
  "name": "Hotel Mejwani",
  "printers": [
    { "id": "kot-1", "role": "kot", "host": "192.168.1.60", "port": 9100 },
    { "id": "receipt-1", "role": "receipt", "host": "192.168.1.61", "port": 9100 }
  ]
}
```

Restart the hub. Auto-KOT prints on every new order; the KDS
`Print receipt` button now hits the receipt printer directly and
falls back to the preview overlay only if the printer errors.

---

## 5. Explicitly out of scope

- **USB / serial transport.** TCP covers ~every modern printer;
  legacy USB-only Epson TM-T20 style units need a small helper
  daemon on the reception laptop and can compose on the same
  `sendToPrinter` interface.
- **Cash drawer kick** (`ESC p m t1 t2`). Trivial addition on top
  of the encoder if a pilot needs it.
- **Multiple KOT printers per station** (hot / bar / cold). The
  `printers` array already supports N entries; adding a
  `station: 'bar'` field per item is a follow-up.
- **Waiter PIN, CI + crash reporting** — final M1 PRs.

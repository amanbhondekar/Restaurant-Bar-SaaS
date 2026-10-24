# M1 completion — USB thermal printing, printer setup, payment reconciliation

**Date:** 2026-10-05T22:00:00+05:30
**Branch:** `feat/m1-completion` (on top of Darshil's latest `main`, `473a5c5`)
**Milestone:** M1 — Payments-ready (closes the two open items in the roadmap's 4.1)

---

## WHY

M1 shipped invoices, tax, discounts, void/refund, three split modes, payment capture, network
thermal printing, PIN login and CI. Two roadmap items under 4.1 were still open:

1. **ESC/POS thermal-printer driver "(network + USB)"**: only network (TCP) printers worked, but
   most small restaurants have a USB receipt printer plugged into the reception laptop.
2. **Payment capture "with reconciliation records"**: payments were recorded but nothing compared
   them with the cash drawer or the card/UPI statements, and there was no end-of-shift record.

Not in this change: a live UPI/card **gateway** (processing money). The roadmap asks for capture
plus reconciliation, which is what this delivers. A gateway needs a provider decision and belongs
with M3 billing.

---

## A BUG FOUND IN EARLIER WORK (M2 · PR 15), FIXED HERE

`hubConfig.getPrinters()` dropped every printer field except host, port and role. A printer's
`station` setting therefore never reached the KOT router, so **every printer received every
station's tickets** and the per-station routing shipped in PR 15 did not actually route. The unit
tests for PR 15 passed because they exercised the splitter, not the config-to-printer path.

Fix: printers are now parsed by one function (`parsePrinter`) that keeps `station`. A regression
test boots a real hub with two fake TCP printers (`hot` and `bar`) and a mixed order, and asserts
each printer receives only its own station's ticket.

---

## WHAT

### 1. USB thermal printing (`hub_server/lib/usbPrinter.js`, new)

A USB printer is an installed print queue to the OS. Raw ESC/POS bytes go through the OS spooler,
so there is no native Node addon and no vendor SDK.

| Platform | Mechanism |
|---|---|
| Windows | winspool.drv `OpenPrinter` / `WritePrinter`, datatype `RAW`, driven by a fixed PowerShell script |
| Linux / macOS | `lp -d <queue> -o raw` |
| Linux kiosk | write to `/dev/usb/lpN` (no CUPS) |

Safety: the printer name is untrusted (config / admin API). It is **never** interpolated into a
command or script. The Windows script is a constant passed with `-EncodedCommand`; the name and
spool-file path travel in environment variables, and `lp` receives the name as a separate argv
entry. Names with control characters are refused; device paths are limited to printer device nodes
(`/dev/usb/lpN`, `/dev/lpN`, `/dev/ttyUSBN`, `/dev/ttyACMN`).

Verified for real on Windows: the embedded C# compiles and binds to winspool, and sending to a
non-existent printer returns a clean `OpenPrinter failed (error 1801)` message. Discovery lists the
installed printers (`Get-Printer`).

`sendToPrinter(job, target)` now routes by `target.transport` (`tcp` default, `usb`, `device`);
legacy host-only targets and preview mode behave exactly as before.

### 2. Printer setup (hub routes + admin tab)

Reception laptop only (`requireReceptionFor`), so no enrolled handset can add printers.

| Route | Purpose |
|---|---|
| `GET /printers/system` | print queues the OS knows about (USB printers appear here) |
| `POST /printers` | add a network, USB or device printer (validated, duplicate ids refused with 409) |
| `DELETE /printers/:id` | remove |
| `POST /printers/:id/test` | print a test page; a failing printer returns `502` with a reason and never crashes the hub |

Printers accept an optional `station` (`hot` / `cold` / `bar`) for KOT routing. New admin tab
**Printers** lists configured printers, test-prints, removes, and adds (choosing from discovered
printers, or an IP, or a device path).

### 3. Payment reconciliation

`lib/reconciliation.js` (pure) derives a **ledger of payment events** from invoices: each paid
invoice, each paid split share individually, and each refund (dated when the refund happened and
returned through the method the sale used). Periods are half-open `[from, to)`, so no payment can
be counted in two closes.

`lib/reconciliationStore.js` stores closed shifts: append-only, sequentially numbered
(`REC-000001`), written atomically (temp file + rename). The period starts at the last close.

| Route (reception only) | Purpose |
|---|---|
| `GET /reconciliation/preview` | current period per method (payments, refunds, net), unpaid bills, voids, suggested opening float |
| `POST /reconciliation/close` | count the drawer, compare, store the record |
| `GET /reconciliations`, `/:id` | history (newest first), by id or `REC-000001` |
| `GET /reconciliation/ledger.csv` | every payment and refund in a period, for the accountant |

How a close works: the **server** recomputes everything for the period; reception supplies only
what they counted. Expected cash = opening float + net cash. Variance = counted − expected.
Optional statement totals for UPI and card give a variance per method. If anything is off, a
note (3+ characters) is **required**; the record stores the status `balanced` or `variance`.
`closing_float` (counted − cash taken out) is offered as the next shift's opening float.

Guards: invalid amounts report every problem at once; cash removed cannot exceed cash counted; a
clock earlier than the last close is refused (`CLOCK_BEHIND_LAST_CLOSE`); unpaid bills are warned
about but not counted.

CSV export neutralises spreadsheet formulas in user-typed text (references, table names). A bug
was caught here during testing: the guard also changed refund amounts like `-400.00` to
`'-400.00`; it now applies only to typed text, not computed numbers.

New admin tab **Cash & payments**: the period by method, a live expected-vs-counted figure with a
variance badge, the close form with a confirm step, closed-shift history, and CSV download.

### Files

| File | Change |
|---|---|
| `hub_server/lib/usbPrinter.js` | **New.** USB / device transport, discovery |
| `hub_server/lib/printer.js` | transport routing; `renderTestPage` |
| `hub_server/lib/hubConfig.js` | `parsePrinter`, `addPrinter`, `removePrinter`; keeps `station` (bug fix) |
| `hub_server/lib/deviceAuth.js` | `requireReceptionFor(what)` |
| `hub_server/lib/reconciliation.js`, `reconciliationStore.js` | **New.** |
| `hub_server/server.js` | printer and reconciliation routes; printers sent as full descriptors |
| `src/admin/CashTab.jsx`, `PrintersTab.jsx` | **New.** |
| `src/admin/AdminApp.jsx` | two new tabs; catalog pills shown only on Menu / Tables |
| `hub_server/test/printers.test.mjs` | **New.** 18 tests |
| `hub_server/test/reconciliation.test.mjs` | **New.** 15 tests |

---

## TEST CASES

**Printers (18):** name and device-path validation; Windows script is the constant script, a
hostile name appears nowhere in it or the command line, the spool file holds the exact bytes and
is removed; failing script / timeout / missing PowerShell give clean errors; `lp` argv; unsupported
platform; discovery parsing; transport routing and legacy behaviour; test page; `parsePrinter` per
transport; live hub: `GET /printers` keeps stations and drops invalid entries, **mixed order splits
by station across two fake TCP printers**, add / reject / duplicate / delete (persisted), test page
reaches the printer, a failing USB printer returns 502 and the hub survives, OS printer listing.

**Reconciliation (15):** ledger derivation (split shares individually, refunds, other tenants
excluded, voided and unpaid not counted); a refund reduces the day it happens; half-open window
boundary counted once; void and unpaid notes; validation reports every problem; record maths for
balanced, short and statement-variance; rounding; CSV safety (formulas, quotes, negative refunds);
live hub: preview stores nothing, mismatch requires a note and saves nothing, a balanced close is
persisted and starts an empty next period with the float carried over, a later payment lands only
in the next record, contiguous periods, list/get/404, CSV download and range filtering.

**Manual (browser, real hub with seeded invoices):** the cash tab figures match the seed
(cash 1240 + 700 + 450 − 450 refund = 1940, UPI 1660, card 2310); a ₹40 shortfall shows a live
"Short ₹40" badge and is refused without a note; with a note REC-000001 is stored and the next
period starts at zero with the float pre-filled; the Printers tab lists configured printers, shows
the real Windows printers in the USB dropdown, and adds one.

```bash
npm test      # 383 tests; 382 pass
npm run build
```

The one failure is the existing `SyncQueue: head-of-line blocking` test, which needs a configured
Supabase URL (see the pull report); it is unrelated to this change.

---

## NOT DONE / LIMITS

- **No live UPI or card gateway.** Payments are recorded by reception, not processed. Provider
  decision needed (M3 billing).
- **Reconciliation records stay on the hub**; they are not yet replicated to Supabase.
- **USB printing was verified on Windows with a missing printer, not with physical hardware.** The
  raw-write path (`WritePrinter`) is exercised only when a real printer is present; try the
  **Test page** button on the first real installation. Linux and macOS paths are tested with a
  fake runner only.
- Cash drawer kick (ESC/POS pulse) is not sent.
- Plan limits on the number of printers (PR 16, separate branch) are not applied here.

## STATUS

Verified locally; not yet merged.

# Changelog

All notable changes to Kullina are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

There are no tagged releases yet, so everything since the first commit is grouped by the milestone it belongs to, newest
first, and the work not yet merged to `main` is under **Unreleased**. Each entry points at the report in
`Darshil_docs/reports/` that has the reasoning, the tests and the numbers; `docs/ROADMAP.md` is the map of what is shipped
and what is not.

## [Unreleased]

Everything on `feat/m2-kitchen-ops` (pull request #1) that is not yet on `main`.

### Added
- **Booking reminders**: the Bookings tab lists tomorrow's bookings that nobody has reminded, each with a ready-written WhatsApp
  link; the host presses "I sent it" and the hub records that, and when (migration 016). The hub still sends nothing by itself.
- **Remote owner view** (`owner.html`, `src/owner/`): sign in and see sales against the period before, the till, stock, guest
  feedback and how long ago the hub last synced. The database enforces that it is read-only (migration 015).
- **Sales analytics**: a reception Sales tab (today / week / month / custom, each against the same stretch before it), guests
  new vs returning, cohorts, and daily and weekly summaries the hub prepares and freezes.
- **Guest feedback replication** to the cloud (migration 013), insert-only, with a boot backfill and restore.
- **Order cancellation**, with ingredients returned only if nothing was cooked; costing, stock-up-to levels and a shopping
  list (migration 012); out-of-stock extras said before the order, not after it.
- **Customer surfaces**: read-only QR diner menu, opt-in guest ordering, recognised repeat visits, reservations and a walk-in
  queue with WhatsApp click-to-chat (migration 011).
- **Role-scoped devices**: a `kitchen` device token reaches five routes only; the live feed now tells it the board and not the
  bill (`hub_server/lib/liveFeed.js`).
- **SQL on a real Postgres engine** (PGlite) in the test suite: migrations 001–016, privileges, pairing, the owner's access, and
  the hub's own push and restore code round-tripped against the schema.
- **Tests for every reception surface**: the frontend suite grew from none to 841 tests, including the whole Kitchen Display
  rendered against a fake hub and socket (`src/test/kitchen/`).

### Changed
- The Kitchen Display is no longer one 1,950-line file: `src/kitchen_main.jsx` is 360 lines and the rest is in `src/kitchen/`
  (a `useBill` hook and seven components), with 100+ tests behind it.
- A kitchen token is sent only what a station screen draws: an allow-list of event keys, ticket fields and line fields, not a
  list of the fields to hide.
- Structured logging (`HUB_LOG_FORMAT=json`) and an optional OpenTelemetry export of logs (`OTEL_EXPORTER_OTLP_ENDPOINT`), both off by
  default; records are redacted at the source. See `docs/LOGGING.md`.
- The sync queue's journal line is synced to disk before the snapshot is written, so a power cut no longer loses the newest unsent
  takings (`HUB_QUEUE_FSYNC=0` turns it off).
- **Money decisions are reception's alone.** Void, refund, mark-paid, the three splits, undo split and settle share, and closing
  a table with a discount or service-charge override, are refused (`403 RECEPTION_ONLY`) from a waiter's handset.
- The Kitchen Display's billing logic and board are plain functions (`src/lib/kitchenBill.js`, `src/lib/kitchenBoard.js`).
- Migration 014 states each role's table privileges explicitly instead of relying on Supabase defaults.

### Fixed
- A freshly provisioned restaurant's hub could never pair (migration 015, `restaurant_for_pairing_code()`).
- A tenant's own login could set its plan, or edit and delete its cash-ups and feedback (migration 014).
- Voided bills, and a refund's time and a void's reason, never reached the cloud.
- A handset could close a table with a 100% discount and get a zero bill.
- Closing a bill straight after typing a discount could wipe the issued invoice from the Kitchen Display.
- The menu importer could stay on Replace over a merge's numbers when the hub failed to answer.
- A waiter's order retry made a second ticket; the floor grid's draft badge was never drawn; a reconnecting handset could leak a
  socket, read the floor out of order, and show double totals.
- A queue file that would not parse was answered with an empty queue and overwritten; it is now salvaged and kept.

### Known gaps
- Migrations 004–016 have not run against a hosted Supabase project (no credentials on the build machine).
- The owner view is not deployed; the waiter's QR scanner needs a camera and is untested; nothing drives a real browser in CI.

## M4 — Customer surfaces (2026-10-16 → 2026-10-22)
- Diner QR menu, printable table codes, guest feedback at bill-close, ordering from the table code, regulars recognised by phone.
- Reservations, walk-in queue and "your table is ready" by WhatsApp click-to-chat.

## M3 — Self-serve tenant (2026-10-02 → 2026-10-21)
- Plan entitlements enforced in the hub; owner console Plan tab; staff invites, roles, PIN rotation and device revocation.
- One-call restaurant provisioning (migration 007) and an operator service for signup and Razorpay webhooks.

## M2 — Menu depth (2026-10-01 → 2026-10-14)
- Variants, modifiers, day-part pricing, 86'd items, station routing; per-station kitchen screens, course firing, recall and
  prep telemetry; stock, recipes and stock-driven 86'd (migration 009); course state reaches the cloud (migration 008).
- The reception admin console: menu and table editing with a CSV and Excel importer, revision-guarded and atomic.

## M1 — Payments-ready (2026-09-30)
- Invoices with tax breakdown, discounts and service charge, split bills, refunds, USB thermal printing, payment
  reconciliation, waiter PIN login, device-token auth on every mutating hub route, server-side pricing, CI.
- Invoices and cash-ups replicate to the cloud (migrations 005, 006) and restore onto an empty hub.

## Foundations (2026-08-17 → 2026-09-21)
- LAN-first Node hub with an offline queue and Supabase cloud sync; waiter PWA, kitchen display and dashboard; the Kullina
  design system and shadcn/ui components.
- Security: the cross-tenant takeover closed, hub device authentication, and server-side pricing.

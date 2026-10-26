# Changelog

All notable changes to Kullina are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

There are no tagged releases yet, so everything since the first commit is grouped by the milestone it belongs to, newest
first, and the work not yet merged to `main` is under **Unreleased**. Each entry points at the report in
`Darshil_docs/reports/` that has the reasoning, the tests and the numbers; `docs/ROADMAP.md` is the map of what is shipped
and what is not.

## [Unreleased]

Everything on `feat/m2-kitchen-ops` (pull request #1) that is not yet on `main`.

### Added
- **Two read-only audits** (documentation only; `report_2026-10-26_133000_gst_audit.md` and `report_2026-10-26_134500_ledger_analysis.md`): the invoice generator's GST gaps, and how a bill is overwritten in place with an append-only `invoice_events` proposal. No code changed.
- **Roadmap status, 2026-10-26** (documentation only; `Darshil_docs/reports/report_2026-10-26_125000_roadmap_status.md`): Supabase and Razorpay test credentials are in progress (G0-1 and G0-2 have not run), the LICENSE is deferred, and Cabinet Grotesk + Instrument Sans with `lucide-react` is reconfirmed.
- **The plan for the super admin console** (`docs/SUPER_ADMIN_BUILD_SHEET.md`, summarised in ROADMAP §4.9a and milestone M5): named MFA access, an append-only event spine, push alerting, attributed and reasoned tenant writes, hub commands with acknowledgement, billing operations, onboarding and a compliance desk, in phases, with invariants and a never-build list. **Nothing is built yet.** It keeps the product's fonts (Cabinet Grotesk, Instrument Sans) and `lucide-react`.
- **The operator console, read-only** (`/ops` on the operator service, `src/ops/`): where the person running Kullina looks at every
  restaurant at once. Counts (active, on trial, overdue or suspended, hubs live), a list of who to look at and why (ten rules: payment
  overdue, suspended, trial ended or ending, asked to cancel, hub never reported, hub silent for 36 hours and for a week, orders shelved, a
  long sync backlog, a wrong clock), every restaurant in a searchable table, the latest subscription events, and one restaurant's whole
  picture. It sits behind its own token (`OPS_TOKEN`, off unless set, kept in memory only, ten wrong tries turn an address away) and
  cannot change anything. A hub now tells the cloud it is alive every five minutes (`hub_status`, counts and times only, stamped with the
  database's clock) and two views that span every restaurant are readable by the service role alone (migration 021). Runbook:
  `docs/OPERATOR_SERVICE.md`. Not run against a hosted project.
- **A public page where a guest asks for a table** (`/book/<code>`, served by the operator service). A restaurant switches it on in the
  Bookings tab and gets an address for a card or a screen. The guest only *asks* (name, number, how many, when, an optional note); the
  request waits in the cloud (migration 020, closed to `anon`) until the hub collects it, and reception accepts it (booked through the
  usual check against the real layout, asking before overbooking) or declines it, then tells the guest from their own phone. The
  service is where a stranger can write, so it is where abuse is dealt with: a trap field, limits per address and per number, a cap
  per restaurant, a small body, no inline script. No captcha, no check that the number is the guest's, and no opening hours yet.
  Runbook: `docs/OPERATOR_SERVICE.md`.
- **Changing a booking, or someone in the queue** (rules and routes; no screen yet): a booking still to come can be moved, resized,
  renamed or given a note without being cancelled and taken again, and someone waiting can be given a new wait. A change that could
  cost a table is checked as taking the booking was (and refused unless reception says it knows); a name or a note never is; moving a
  booking forgets the reminder that was for the old time and keeps the reward. `PUT /admin/bookings/:id`, `PUT /admin/waitlist/:id`.
- **The reward for coming back, for a guest at the door**: a walk-in who left a number and has been here before is offered the same reward as a booking, under the same rule, in the queue ("3rd visit: a free lassi"); the host records that it was given, and can take it back (migration 019). A guest who gave no number cannot be recognised and is offered nothing.
- **Subscribing from the Plan tab**: the owner starts a subscription (and is sent to Razorpay's page to authorise payment; nothing
  is charged until they do), switches plan or cancels, the last two after an "are you sure" and at the end of the paid period. The
  hub only forwards (`/admin/billing…`, reception only); the operator service decides and calls Razorpay, and the restaurant comes
  from the hub's own cloud sign-in, never from a request. Webhooks are now applied in order and once (migration 018), and the
  `subscriptions` and `subscription_events` tables from migration 010 are finally written to. Runbook: `docs/OPERATOR_SERVICE.md`.
  Built against stand-ins; Razorpay has never been called for real.
- **A reward for coming back**, set by the restaurant: "every Nth visit, <what the guest gets>", off until set (Rewards panel in the
  Bookings tab). The booking says when a visit earns it and the host records that it was given (migration 017). No points, no tiers,
  nothing taken off the bill automatically.
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
- **SQL on a real Postgres engine** (PGlite) in the test suite: migrations 001–021, privileges, pairing, the owner's access, and
  the hub's own push and restore code round-tripped against the schema.
- **Tests for every reception surface**: the frontend suite grew from none to 1,112 tests, including the whole Kitchen Display
  rendered against a fake hub and socket (`src/test/kitchen/`).

### Changed
- The demo-era waitlist that lived in the browser (its state, demo rows and two operations in `PosContext`) is deleted; the hub queue replaced it long ago.
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
- Migrations 004–021 have not run against a hosted Supabase project (no credentials on the build machine), and the Razorpay calls
  have never been made against Razorpay itself (no keys). A subscription runs for 12 billing periods and then ends; whether that
  is the right length is undecided.
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

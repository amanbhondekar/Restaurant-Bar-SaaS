# Product Roadmap — Restaurant POS & KDS SaaS

Living document. Reflects the state of the working line as of the latest
commit and the work planned beyond it. This is a **multi-tenant SaaS product** —
pilot restaurants are validation partners, not the product itself. Nothing in
this roadmap is scoped to any single tenant.

Legend: ✅ shipped · 🟡 partial · ⬜ not started

**Last reconciled against the code:** 2026-10-23 (M1 and M2 complete, M3 mostly
built, M4 mostly built). Between 2026-09-19 and 2026-10-13 the file lived on an
unmerged `docs/roadmap` branch, so §6's maintenance rule could not be followed and
the document fell a full two milestones behind. It is on the working line now, and
every change since has updated it in the same commit.

**Under review:** the working line (`feat/m2-kitchen-ops`) is open as
[PR #1](https://github.com/amanbhondekar/Restaurant-Bar-SaaS/pull/1) against
`main`. Until it merges, `main` does not have anything described here.

---

## 1. Where we are today

The platform is a LAN-first, offline-capable Point of Sale and Kitchen
Display System with a cloud-synced multi-tenant backend. Each tenant runs a
local hub (a reception laptop on the restaurant's Wi-Fi) that owns the live
operational state and asynchronously reconciles to Supabase.

Four surfaces are functional end-to-end and have been field-validated with
early pilots:

- **Kitchen Hub Display** — live KOT ticket rail with pairing QR, connection
  telemetry, sync status, per-station filtering and billing actions.
- **Waiter Handset PWA** — installable, LAN-paired, floor grid + menu +
  cart, PIN sign-in, works while WAN is down.
- **Reception admin console** (`/admin`) — menu, table layout, bookings and the
  walk-in queue, cash and payments, stock and recipes, kitchen performance,
  printers, staff and devices, guest feedback, subscription plan.
- **Station screens** (`/station/hot`, `/cold`, `/bar`) — a tablet at one
  kitchen station: that station's tickets only, a Ready button, a chime for new
  work. Enrolled once by scanning a code from the admin Kitchen tab, as a
  kitchen device: it can mark tickets done and nothing else.
- **Diner menu** (`/diner`) — no sign-in, opened from a table code. Read-only
  unless reception switches guest ordering on, which lets a guest send an order
  to the kitchen (§4.5).
- **Reception / server-laptop app** — the older shell. Its demo-era waitlist and
  sales views are retired: those tabs now point at the admin console's Bookings
  and Sales tabs.
- **Operator service** (`signup_server/`) — not part of a restaurant's
  installation. Holds the Supabase service key and the Razorpay keys and
  webhook secret: creates tenants, starts, switches and cancels their
  subscriptions, and keeps `plan_status` honest (`docs/OPERATOR_SERVICE.md`).

M1 (payments-ready) and M2 (menu depth) are complete. M3 — self-serve tenant —
is mostly built: plan enforcement, the owner console, staff and device
management, and an operator service for signup, Razorpay webhooks and the
subscription itself (the owner starts, switches and cancels it from the Plan tab).
What is left is everything that needs a real Supabase project or Razorpay keys:
migrations 004–019 have never run on a hosted project, and the Razorpay calls have
only ever been made against a stand-in, because there are no credentials on the
machine this was built on. M4 — customer surfaces — has
guest ordering, repeat-visit recognition, reservations with staff-sent reminders,
and a reward for coming back that the restaurant sets itself.

Automated coverage is **1454 hub tests across 71 files** (pure rules plus live
hub fixtures that boot a real server against a throwaway data directory) and
**916 frontend tests** (Vitest + Testing Library in jsdom) on the diner page and
its basket, the station screens, device enrolment, every reception admin tab
(Menu and its item editor, the menu importer, Tables, Bookings, Cash, Sales,
Stock, Kitchen, Printers, Staff, Feedback, Plan, ledger repair, guest ordering),
the waiter app (login, floor grid, modifier sheet, menu grid, order drawer, and
how it keeps hold of the hub), and the reception Kitchen Display itself: the
board, station tabs, held courses, the connection light, and the bill from
preview to paid, split, voided and refunded, against a fake hub and socket. Only
the waiter's QR scanner (it needs a camera) is still verified by hand, and nothing
drives a real browser in CI.

---

## 2. Shipped capabilities

### Architecture & platform
- ✅ LAN-first hub gateway (`hub_server/`) on Node/Express + `ws`, bound to
  `0.0.0.0:4000`, serves the built KDS, admin console and waiter PWA
  statically.
- ✅ Async cloud sync worker with disk-persisted queue
  (`hub_server/data/tickets.json`), idempotent by `order_request_id`,
  perpetual-retry loop with terminal-state logging and quarantine for
  items that exhaust their retry budget.
- ✅ Boot-time cloud reconciliation and disk-persisted menu / table cache
  so the hub survives cold starts without WAN.
- ✅ Hub-authoritative catalog: revision-guarded local writes that cloud
  pulls cannot overwrite, rolling backups, atomic temp-file-then-rename.
- ✅ Non-blocking I/O across the hub, live `/dashboard-data` and
  `/dashboard` operational view.

### Data & multi-tenancy (Supabase)
- ✅ Schema: `restaurants`, `staff_users`, `tables`, `menu_categories`,
  `menu_items`, `orders`, `order_items`, `waitlist_entries`,
  `device_pairings`, `invoices` (005), `reconciliations` (006),
  `inventory_items` and `recipes` (009), `subscriptions` and
  `subscription_events` (010, service role only), `reservations` and `walkins`
  (011).
- ✅ Row Level Security on every tenant-scoped table; `current_restaurant_id()`
  resolved from `auth.uid()` via `staff_users`.
- ✅ `provision_kitchen_staff` `SECURITY DEFINER` RPC, `pin_hash` via
  `pgcrypto`, per-tenant bcrypt provisioning secret.
- ✅ Migrations `001`–`012` written: secure hub provisioning, online RLS and order
  items, hub-authoritative menu and tables, subscription plan status, invoice and
  cash-up cloud replication, tenant provisioning, order course state, inventory,
  subscriptions, reservations, ingredient costing. **`004`–`012` have never been run against a real
  Supabase project** (no credentials on the build machine); the cloud round trips
  are proven against fakes that keep their rows.
- ✅ `plan` on `restaurants` (`starter` / `pro` / `enterprise`) **enforced in
  product**, not just modelled — see §2 Tenant lifecycle.

### Security
- ✅ Cross-tenant takeover closed (RPC no longer accepts arbitrary
  `p_user_id`, EXECUTE revoked from `anon`).
- ✅ Bearer device-token auth on every mutating hub route; tokens hashed at
  rest, rate-limited enrollment, constant-time compare.
- ✅ Reception-only guard on catalog writes and admin routes; enrolled
  handsets get 403 `RECEPTION_ONLY`.
- ✅ **Money decisions are reception's alone.** Voiding, refunding, settling, splitting
  (by seats, items or amounts), undoing a split and settling a share used to take
  any enrolled handset's token, and so did closing a table *with a discount or a
  service-charge override*: a handset could close a table with a 100% discount
  and get a ₹0 bill (shown by a test before the fix). All of those are now 403
  `RECEPTION_ONLY` from a handset. A handset still closes a table at the full price
  and reads the bill. Pinned by `moneyRoutes.test.mjs` (15 tests, 11 mutations).
- ✅ The hub's server-rendered fallback page escapes the restaurant name,
  pairing code, table name and item names it prints. Table names come
  straight off an order body from a handset, so this was reachable by staff,
  not only by an admin. That page is also reception-only now: it used to
  print the pairing code and the live tickets to any caller, against the
  decision `/pairing-info` had already made about the same code.
- ✅ CORS locked to LAN / loopback; `/qr` and `/toggle-outage` restricted
  to the reception laptop.
- ✅ WebSocket `/live` authorised (token in query string).
- ✅ Server-side pricing — waiter clients no longer submit totals. The same
  pricing runs for orders a guest sends from a table code.
- ✅ Device scope: a station tablet holds a `kitchen` token that can mark
  tickets done and nothing else; default-deny, with the open routes pinned by a
  test (§4.7). Adding or removing staff is reception-only.
- ✅ New staff are invited rather than given a PIN: reception sends a one-time
  invite code and the person chooses their own. PINs and invite codes are hashed,
  and a single device can be revoked without re-enrolling the rest.
- ✅ Guest data: a phone number is stored hashed per tenant for matching, so two
  restaurants on one cloud cannot tell they share a guest, and in plain only where
  staff must ring it back. Guest ordering is off until reception turns it on.
- ✅ The operator service verifies Razorpay's signatures over the raw request body
  and refuses every signup if no token is configured.

### Billing & payments (M1)
- ✅ Invoice generator with itemised tax breakdown, persistent ledger with
  sequential numbers, on-close issue.
- ✅ Bill-level flat and percent discounts, percent service charge.
- ✅ Invoice lifecycle: void with ticket reopen, mark-paid with method
  capture, state-transition validation.
- ✅ Split-bill by seats, by amounts and by items, with rupee-fair
  largest-remainder rounding and per-share settlement rolling up to the
  parent.
- ✅ Full refund on paid invoices, optional payment reference on every
  settlement.
- ✅ ESC/POS thermal printing for KOT and receipt over network TCP, USB
  (OS print queue) and device path, with preview mode so it works without
  hardware.
- ✅ Payment reconciliation: period close, immutable numbered records, CSV
  ledger export.
- ✅ Cloud replication, restore and repair of the ledger (§4.1); the sync queue is
  written crash-safely, with a test at each crash point.

### Menu depth (M2)
- ✅ First-class item variants (half / full, bone-in) with distinct
  server-side refusal codes.
- ✅ Modifier groups (spice, extras, prep instructions) with min/max
  validation and price deltas.
- ✅ Day-part pricing (breakfast, happy hour, late night).
- ✅ Per-variant and per-option availability (86'd).
- ✅ Hub write layer for menu and tables: validated, revision-guarded,
  reception-only, with CSV row import.
- ✅ Admin console tabs for menu, tables and import.
- ✅ Stock and recipes: ingredients with one unit each, per-dish and per-size
  recipes, deliveries / waste / counts with an audit log. Orders are checked
  against stock as a whole and refused with a readable reason; a dish that
  cannot be made is flagged `stock_out` on the waiter grid and hidden from the
  diner menu, and returns by itself on a delivery. The flag is separate from
  the hand 86, so the two never undo each other. Cloud copy: migration 009.
  A modifier choice (extra cheese) can use stock too, counted only for the
  portions that chose it.
- ✅ Menu edits start from the stored menu, not the plan- or stock-overlaid
  one. Before, a tenant whose plan hides modifiers lost them for good the first
  time they edited any dish.

### Kitchen operations (M2)
- ✅ Multi-station routing (hot / cold / bar) with per-station KDS filtering
  and station-scoped KOTs.
- ✅ Course firing and hold-and-fire.
- ✅ Prep-time telemetry per item and per station, surfaced in the admin
  console's Kitchen tab.
- ✅ Ticket recall.
- ✅ Per-station screens: a tablet at the hot line, cold line or bar is its own
  authenticated page, tells the hub which station it is, and shows reception
  when a station has work and nobody looking at it. Dead connections are
  dropped by a heartbeat, so a tablet that fell off the wifi stops counting.

### Tenant lifecycle (M3, mostly built)
- ✅ Plan entitlements as one authoritative answer to "what may this tenant
  do right now?" (`hub_server/lib/plans.js`): limits on devices, waiters,
  tables and printers; feature flags for split-bill, refunds, modifiers,
  day-part pricing and multi-station KOT.
- ✅ Enforcement at the hub, **degrading rather than blocking**: trialing,
  past-due (7-day grace), suspended and cancelled tenants fall back to
  Starter. Orders, billing and the kitchen display are never switched off.
- ✅ `GET /plan` exposing effective plan, limits, features and usage; cloud
  plan sync at boot and every 15 minutes, fail-soft when offline.
- ✅ Owner console Plan tab: degradation banner naming the reason, limits
  vs live usage, per-feature entitlements, cloud-staleness line.
- ✅ Owner console Staff & devices tab: invites, roles, PIN reset, removal, and
  per-device revocation (§4.4).
- ✅ Operator service (`signup_server/`): creates tenants and applies Razorpay
  subscription events to `plan_status`; a payment problem is `past_due`, never
  `suspended` (§4.4).
- ✅ Subscribing from the Plan tab (§4.4): the owner starts a subscription and is
  sent to Razorpay's page to authorise payment (nothing is charged until they do),
  switches plan or cancels, each at the end of the paid period and each after an
  "are you sure". The hub only forwards; the operator service decides and calls
  Razorpay. Built against stand-ins, never run against Razorpay.

### Frontend surfaces
- ✅ Kitchen KDS (`src/kitchen_main.jsx`, the page the hub serves at `/`): live
  ticket rail, pairing QR + enrollment code, connection badge grace states,
  Framer Motion ticket-printer moment, kitchen summary counters, station chips,
  bill preview and settlement. It was one 1,950-line component; it is now a
  360-line parent (the socket, the board state and the layout) and `src/kitchen/`:
  `useBill` (the bill's state and everything done to it), `BillModal`,
  `PrintPreview`, `TicketCard`, `ReadyTickets`, `KdsHeader`, `PairingPanel` and
  `StationTabs`. Two pieces are also pure functions: the billing
  logic (turning the adjustment form into what the hub understands, seeding an
  equal split that adds up exactly, building the split requests, merging a
  ticket) in `src/lib/kitchenBill.js`, and the board (what each live message does
  to the tickets on screen, marking a ticket ready, and when the connection light
  goes from connecting to disconnected) in `src/lib/kitchenBoard.js`. The whole
  component is now also tested as it renders (`src/test/kitchen/`, 58 tests): the
  page no longer mounts itself when there is no `#root`, and exports
  `KitchenHubApp`. Writing those tests found a real bug: typing a discount and
  pressing Close Bill within about a fifth of a second let the delayed preview
  recalculation run after the bill was issued, get "no open tickets" from the hub,
  and wipe the issued invoice from the screen. An issued bill is no longer
  recalculated. The split itself was done by a script that moves the code
  verbatim, and it dropped the stylesheet import: found only by opening the page in
  a real browser (the tests run without CSS), now pinned by a test. A bill's
  preview is asked for once when it opens (it used to be asked twice), and the
  ticket card forwards its ref, which the rail's pop-layout animation needs.
  (An earlier version of this line named `src/server_laptop/KitchenKdsView.jsx`;
  that is a smaller view in the old shell, not this.)
- ✅ Admin console (`src/admin/`): menu, tables, bookings and the walk-in queue
  (with reminders to send and the reward panel, §4.5 and §4.6), cash & payments, sales analytics, stock and recipes, kitchen performance and
  station screens, printers, staff and devices, guest feedback, plan.
- ✅ Reception: the `ServerLaptopApp` shell. Its demo-era `WaitlistView` and
  `SalesAnalyticsView` are deleted; the Bookings and Sales tabs there link to the
  admin console's, which are the real ones (the console opens on `/admin#bookings`
  and `/admin#sales`).
- ✅ Station screens (`src/station/`) and the diner page with its optional basket
  (`src/diner/`).
- ✅ Waiter PWA (`src/waiter_mobile/`): floor grid with live table state,
  category-filtered menu grid, order draft drawer, rapid order builder,
  LAN dispatcher, in-app camera QR scanner, PIN sign-in, connection badge,
  service worker + manifest.

### Design system
- ✅ Centralised token architecture (`design-system/css/tokens.css`,
  `typography.css`, `ts/tokens.ts`).
- ✅ Kullina light theme; unified typography scale exposed under both
  `.type-*` and `.typography-*` class aliases; status colour palettes
  (green / amber / blue / rust); JetBrains Mono for numerics.
- ✅ 40+ restaurant-oriented UI components.

### Documentation & process
- ✅ `docs/ARCHITECTURE.md`, `docs/API_SPECIFICATION.md`,
  `docs/DEPLOYMENT_GUIDE.md`, `docs/OWNER_VIEW.md`, `docs/LOGGING.md`, this roadmap;
  `CHANGELOG.md`, `CONTRIBUTING.md` and `docs/pilot-report-template.md` (§4.10).
- ✅ Timestamped audit log in `Darshil_docs/reports/` (per-change what/why
  + test cases; every change lands with a report).
- ✅ Hub regression suite (1454 tests at the last count, §1): fixtures on
  hub-chosen ports with a stale-hub guard. Safety rules are mutation-checked:
  each is broken on purpose and the suite must notice.
- ✅ CI (GitHub Actions): `npm test` + `npm run build` on Node 20/22 for
  every push and PR.
- ✅ Crash reporting from the hub and both PWAs into a rolling log.

---

## 3. In-flight / partial

- 🟡 **Owner console**: plan and usage, staff invites, role management, PIN
  rotation and per-device revocation have all shipped (§4.4), and there is now a
  **remote, read-only owner view** (`owner.html`, `src/owner/`, runbook in
  `docs/OWNER_VIEW.md`): sign in with an email and password and see sales against
  the period before (the hub's own report code, so the numbers match the
  reception Sales tab), the till, stock, and what guests said, with how long ago
  the hub last sent anything. The database makes it read-only, not the page:
  migration 015 lets any staff login of a restaurant READ its rows and only the
  hub's own identity write them, hides the secret hash and PIN hashes from every
  login, and adds `provision_owner()` for the operator. Proven on a real Postgres
  engine, including that an owner reads their own restaurant and nothing of
  another's and changes nothing. **What is still open:** it is not deployed (it
  needs a hosted Supabase project and a static host); bookings are not on it;
  password reset and SSO are not built; a login belongs to one restaurant; and on
  the reception laptop a person's role is still stored but not enforced (§4.7).
  Building it found that **a freshly provisioned restaurant's hub could never
  pair**: it looked the restaurant up before it was bound and row-level security
  hid the row. Fixed in 015 (`restaurant_for_pairing_code()`), with the hub
  falling back to the old read if the function is not there yet.
- 🟡 **Inventory limits** (what is left): nothing in the code. Costing, stock-up-to
  levels, the shopping list (§4.2), order cancellation (§4.3) and an out-of-stock
  extra greyed out on the waiter's sheet and hidden from guests have all shipped.
  Migrations 009 and 012 apply on a real Postgres engine, the hub's stock rows
  fit their constraints, and the stock and recipe restore (par, costs, a recipe
  per size, an extra's own line) is proven round-trip against it (§3, Billing
  replication); what is open is outside the code: none of it has run on a hosted
  project. Not plan-gated: whether stock is a paid feature is a pricing call.
- ✅ **Station screens are role-scoped**: a station tablet enrols with a
  `kitchen` device token, which can read the board and mark tickets and stations
  done and is refused everything else -- placing orders, every bill route, staff,
  the plan. Default-deny: a route is closed to it until someone opens it, and the
  five that are open are pinned by a test. Devices enrolled before this keep full
  authority. What remains is in §4.7. The reception Kitchen Display still sends no
  token, so it only works on the reception laptop itself.
- 🟡 **Billing replication is proven as far as it can be without a cloud**: bills
  and cash-ups push to the cloud (005, 006), a boot backfill carries up anything
  the cloud has not confirmed, and a hub with an empty or partial ledger restores
  or repairs it (§4.1). A contract test reads the schema out of the migrations
  and holds every row the hub builds against it: columns, required columns,
  CHECK values, the unique index behind every upsert, every column read back --
  for bills made by the REAL invoice store, not states copied from the SQL.
  `npm run cloud:check` (read-only; `--probe
  <restaurant>` writes one voided probe bill, reads it back and deletes it) is
  how it gets proven against a real project, and names the migration to run for
  anything missing. **The SQL has now been run, on a real Postgres engine** (PGlite, in
  the test suite, with Supabase's default privileges modelled): every migration
  applies and re-applies, tenants cannot see or write each other's rows, every row
  the hub builds fits the real constraints, and onboarding and the hub's secret
  binding behave as designed. That run found that the "insert-only" and "service
  role only" table claims protected nothing under those defaults -- a tenant's own
  login could set its plan to enterprise, edit or delete its cash-ups and feedback,
  and rewrite its staff rows -- so migration 014 states each role's privileges
  explicitly. The hub's own push and restore code (the ledger, stock, bookings,
  feedback, menu and layout) has also been run round-trip against that real
  database, with the stores wiped as a new laptop would be: bills come back in
  every state with the cash screen's figures identical, cash-ups with their
  variances, a short ledger is found and repaired, and a push removes only its own
  restaurant's stale rows. **What is still open:** none of it has run on a *hosted* Supabase
  project (PostgREST, the auth service and the project's real defaults are not in
  PGlite), and whether the hosted defaults are what the stub assumes is unchecked.
  Building it found and fixed two real bugs: status updates were keyed on the ticket number alone (so
  after a hub reinstall, numbers restarting at 101, they rewrote every older
  order with that number), and **a voided bill could never reach the cloud** --
  the hub writes `voided`, the table's CHECK allows `void`, so a bill the cloud
  held as paid would have stayed there counted as revenue. The first version of
  the contract test missed that because its sample bills were hand-written from
  the SQL; they now come from the real invoice store. Round-tripping those bills
  then found two more: a refund's time and a void's reason were read under the
  cloud's column names, so they never replicated, and a restored hub would have
  lost its refunds from the cash reconciliation. Fixed.
- ✅ **Waitlist**: moved out of this section. The walk-in queue is on the hub,
  with "your table is ready" by WhatsApp click-to-chat, and time-slot
  reservations are checked against the real layout (§4.6). A public booking page
  is the part still open, and it needs hosting.
- ✅ **Analytics** (reception Sales tab): today, this week, this month or a
  chosen range, each set against the same stretch of the period before it --
  "today so far" against yesterday up to the same time, never against all of
  yesterday -- in the restaurant's local time. Takings are the cash screen's own
  definition (payments less refunds, by method; one function, not a second one
  that can drift), bills raised and the average bill, voided bills, best sellers,
  busy hours, guests new and returning, how many of last period's new guests came
  back, and cohorts by month of first visit. The hub prepares a daily summary the
  morning after and a weekly one on Mondays and keeps them frozen; sending is a
  tap that opens WhatsApp with the message written (the same click-to-chat
  decision as bookings -- no provider, no per-message fee), to the owner's number
  if one is saved. **Not done:** a hub cannot send a message on its own, so
  "scheduled" means prepared, not delivered; guests are counted only where a phone
  number was given (seated bookings and walk-ins), so it is not every diner; no
  per-waiter or per-table view; no CSV export of sales. Found in a real browser,
  not by a test: the comparison period had no wording, so the screen read "set
  against ." and a summary read "up 5% on undefined". Fixed, with the test written
  first. The older `SalesAnalyticsView` in the server-laptop shell, which added
  up every ticket in the browser's storage with no regard for voids or refunds, has
  been deleted; that tab now links here.
- ✅ **Operational dashboard** (`/dashboard`): the 2026-09-19 revision of
  this file flagged flaky hydration. Re-checked on 2026-10-13 against a
  running hub — sales, floor grid, active KOTs and billed orders all render
  with no console errors. Moved out of this section.
- 🟡 **Test coverage**: the hub is well covered. A frontend runner covers the
  diner page and its basket, the station screens, device enrolment, every
  reception admin tab (including the Menu tab and its
  item editor, Tables, Cash and Sales, which handle prices, the floor, the till
  and the owner's figures, Printers, Plan and the menu importer), the waiter
  login, floor grid, modifier sheet, menu grid, order drawer and connection
  handling, and the reception Kitchen Display (its billing logic and board as pure
  functions, and the whole component as it renders: the board, station tabs, held
  courses, the connection light, and the bill from preview to paid, split, voided
  and refunded). The waiter's QR scanner (it needs a camera) is still verified by
  hand, and nothing drives a real browser in CI. Things found only by looking past a passing build or by checking
  the tests themselves: a cross-page flow (the device-scope report), a
  screen-reader bug in the 86 switches (the admin-tab report), in the importer a
  Replace mode that stayed selected over a merge's numbers ("0 items will be
  removed") when the hub failed to answer, and in the order drawer a retry that
  minted a new request id, so a waiter whose reply was lost could put the same
  order in the kitchen twice, and in the floor grid a "pieces in the draft" badge
  that had never once been drawn, because it added up the lines' rows instead of
  their quantities, and in the connection handling a reconnect timer that opened a
  socket after the app had gone, floor reads that could land out of order, and a
  new order that showed double its total until the next read, and in the Kitchen
  Display a bill closed right after typing a discount that was then wiped from the
  screen by the delayed recalculation, a split of the file that silently dropped the
  stylesheet import (every test green, the page unstyled), and, from mutation
  checking, a kitchen-feed payload that lost its `id` so the board would have
  ignored new orders. Two flakes were root-caused rather than retried: a test
  cleaning up a directory the sync queue was still writing into, and timestamps
  compared across two Windows processes whose clocks differ by a tick.

---

## 4. Backlog — grouped by theme

Ordered within each theme by rough priority. No dates; dates go on
milestones (§5) when a theme is pulled into a release.

### 4.1 Billing & payments  🟡
- ✅ Invoice + tax breakdown, discounts and service charge, lifecycle,
  split-bill, refunds, thermal printing, reconciliation — all shipped in M1.
- ✅ Cloud replication of invoices (migration 005): every issue, settlement,
  void, refund and split is pushed as a full snapshot, upserted on the hub's
  own invoice id. **Run on a real Postgres engine, not yet on a hosted Supabase project.**
- ✅ Restore: a hub with an empty ledger pulls its bills and cash-ups back
  from the cloud at boot and on reconnect. Only ever fills, never merges —
  a hub that holds bills is the authority on them.
- ✅ Repairing a *partial* ledger: a union keyed on the hub's own id where the
  hub wins every conflict, so a local void or refund stands and a bill issued
  offline is never deleted for being absent from the cloud. Reception is shown
  what it would add and confirms; the hub counts both sides at boot and warns
  when the cloud has more.
- ✅ Cloud replication of cash-up records (migration 006), inserted rather
  than upserted: a closed shift is immutable.
- ✅ Backfill at boot for bills and cash-ups the cloud has not confirmed,
  so an existing ledger replicates rather than only new takings.
- ✅ A sync queue file that will not parse is salvaged, preserved for
  recovery by hand and reported loudly, instead of being answered with an
  empty queue and overwritten.
- ✅ The queue's write survives a crash: the state is appended to a journal
  before the snapshot is touched, so a torn snapshot no longer loses the
  newest unsent takings. An append cannot damage what is already on disk,
  which is why this works where a rename was reverted on measurement.
- ✅ The journal line is synced to disk (`fsync`) before the snapshot is touched, so
  a power cut no longer loses the newest unsent takings. The earlier refusal was
  about syncing the big snapshot on the order path; this is a few-kilobyte append
  in the background write chain, measured at about 0.3 ms plain and 0.8 ms synced
  on an SSD. A disk that refuses to sync, or is slow at it, is said once a minute;
  `HUB_QUEUE_FSYNC=0` turns it off. Not measured on a spinning disk: the test
  prints the cost on whatever it runs on, and the log warns past 250 ms.

### 4.2 Inventory & menu depth  🟡
- ✅ `menu_item_variants`, modifiers and day-part scheduling, surfaced in
  the order draft drawer.
- ✅ `inventory_items` and `recipes` (migration 009): hub-authoritative, pushed
  as a debounced snapshot, restorable onto an empty replacement laptop.
- ✅ Stock-out propagates to the waiter grid and the diner menu as a `stock_out`
  flag over the menu, never a write to `available`; the order check is the
  backstop for a stale handset.
- ✅ Modifier choices that use stock: an "extra cheese" takes 20 g of cheese out of
  stock, for the portions that picked it. Set on the dish's own recipe, so it
  travels in the same cloud row (no migration) and a restore cannot turn it into a
  second dish-wide recipe. An extra that has run out holds up the order that asks
  for it, not the dish, and the menu now says so before the order is taken: the
  extra carries `stock_out`, the waiter's sheet greys it out as OUT OF STOCK (told
  apart from a hand 86, which outranks it), and the diner menu does not offer it.
  One portion is the test, counting what the dish itself uses of the same
  ingredient. An extra is out only when no size that can be ordered could take it
  (a Half whose recipe does not use the cheese still offers it; the Full is refused
  with the ingredient named), and a dish whose REQUIRED choice has nothing left that
  stock allows is flagged as a whole, since nobody could finish the sheet. Handsets
  are told to refresh when an extra runs out, which needed its own check: no dish
  moves when an extra does. An extra belongs to the recipe for the size ordered,
  so a dish with a recipe per size sets it per size.
- ✅ Costing, stock-up-to levels and a shopping list (migration 012, optional columns).
  An uncosted ingredient is an UNKNOWN cost, not a small one: a recipe's cost says
  "at least" and gives no percentage until every ingredient is costed. The list is
  everything at or below its warning level, furthest below first, suggesting how
  much brings it back to its stock-up-to level (and inventing no quantity where none
  is set); it is sent as a WhatsApp message to whichever supplier reception picks.
  A project that has not run 012 keeps replicating stock without the two figures.
  Not done: day-part prices in the food-cost share, and purchase-order records.

### 4.3 Kitchen operations  🟡
- ✅ Multi-station routing, course firing / hold-and-fire, prep-time
  telemetry, ticket recall.
- ✅ Reprint on recall, banner-marked so a reprint cannot be mistaken for a new order.
- ✅ Cancelling an order (`POST /orders/:id/cancel`, from reception's Kitchen tab or
  a handset). Policy: before anything has been cooked its ingredients go back on
  the shelf -- exactly what THAT order took, recorded on the ticket, not today's
  recipe -- and once any of it is made they stay used and the ticket says it was
  cancelled after cooking. A billed order is voided, not cancelled. The kitchen
  screens, the handset and the cloud are all told, and it leaves the bill. Not
  done: cancelling one line of an order, and recording post-cooking waste.
- ✅ Per-station KDS instances: `/station/<station>`, its own authenticated page
  rather than a filter on the reception display (which could not run on any
  other device: it sent no token). The hub knows which stations have a screen
  up; reception sees what is waiting at one that has none. A station tablet
  enrols as a kitchen device, which can mark tickets done and nothing else (§4.7).
- ✅ Course state replicated to the cloud (migration 008): `staged` and a
  per-course log of when each was fired and each station finished, plus each
  line's course and station. A cloud without 008 still gets the order and its
  status; only the course detail waits. Also fixed: a station finishing its
  part before the ticket was ready used to enqueue nothing.

### 4.4 Tenant lifecycle  🟡
- ✅ Plan model and enforcement against `restaurants.plan`.
- ✅ Owner console: plan, limits, usage, entitlements.
- ✅ Tenant provisioning end to end: `provision_restaurant()` (migration 007) is
  deliberately unreachable by `anon` and `authenticated`, so nothing in this
  product could call it. `signup_server/` is the trusted operator service its
  own comment asked for: it holds the service key, validates a signup, and
  hands back the pairing code and a one-time hub secret (M3 · PR 17).
- ✅ Owner console: staff invites, role management, PIN rotation and hub device
  revocation. Reception never types someone else's PIN: they add a person with
  a role and read out a one-time invite code, and the staff member chooses
  their own PIN on a handset. An invited person has no hash at all until they
  do, so they cannot sign in with anything. A single device can be revoked and
  is refused on its next request, instead of rotating the code and making every
  handset in the restaurant re-enrol mid-service.
- 🟡 Razorpay subscriptions (M3 · PR 19): the operator service verifies
  Razorpay's webhooks against the raw body and keeps `plan_status` honest. A
  payment problem becomes `past_due`, never `suspended`, so a card that expires
  on a Friday night does not take the till down mid-service. Migration 010
  created the `subscriptions` and `subscription_events` tables, but **nothing
  wrote to them until migration 018 and this flow**: they now record which
  subscription belongs to which tenant, and log every applied event once (a
  redelivery of the same event id is acknowledged, not logged twice; an event
  older than the last applied is logged and left alone, so a late "payment
  failed" cannot put a restaurant back to past_due after it paid).
- ✅ The owner can start, switch and cancel a subscription (2026-10-23). Plan tab →
  Subscription panel → hub (`/admin/billing…`, reception only) → operator service
  → Razorpay. The restaurant is read from the hub's own cloud sign-in, never from a
  request. Only an `active` subscription sets `restaurants.plan`. Starting needs no
  confirmation (it only opens Razorpay's page); switching and cancelling ask first
  and take effect at the end of the paid period. See `docs/OPERATOR_SERVICE.md`.
- ⬜ **Still open here, and why.** Razorpay has never been called for real: the
  requests follow its published Subscriptions API and are tested against a stand-in,
  so the first run in test mode will probably find something. No keys or plan ids
  exist. Migrations 010–018 have not run on a hosted project. A subscription is
  created for 12 billing periods, then completes and the restaurant falls back to
  Starter: the length is a commercial decision nobody has made. A payment page that
  was never used cannot be cancelled (nothing was authorised); it lapses. A plan can
  be switched only once the first payment has gone through. Anyone at the reception
  laptop can start or cancel, because the hub speaks as the restaurant's `kitchen`
  identity and there is no manager PIN in front of it. There is no public signup page
  (needs a captcha, email verification and a host).

### 4.5 Customer-facing surfaces  🟡
- ✅ Diner QR menu, view-only: a table code opens a read-only menu served
  by the hub over the restaurant's own wifi. Effective (day-part) prices,
  86'd dishes hidden, built from an allow-list so the cache cannot leak
  into it. Reception prints a sheet of one code per table from the Tables
  tab.
- ✅ Ordering from that menu, off by default. Reception turns it on from the
  Tables tab, beside the codes it affects; until then the code shows the menu
  only. A guest's basket sends ids and quantities and nothing else -- the hub
  prices the order from its own menu, checks stock, and stamps the ticket
  "Guest (QR)" so the kitchen and the floor can see where it came from. One
  order per table per minute. The guest is told a ticket number, never a total.
- ⬜ Paying from that menu is still open: it needs Razorpay keys and a public
  address for the callback, neither of which exists yet. The bill is settled
  with a member of staff, and the diner page says so.
- ✅ Repeat visits recognised by phone number, the one thing a guest gives up
  willingly. Reception sees "third visit, last here in March" while taking a
  booking, and a Regulars list. Stored hashed per tenant for matching, so two
  restaurants on the same cloud cannot work out that they share a guest, and
  in plain only where staff need to ring the number back.
- ✅ A reward for coming back, in the one form that does not need the product to decide
  anything commercial: the **restaurant** sets the rule ("every 5th visit, a free
  dessert": a number from 2 to 50 and its own words), off until it does, from the
  Rewards panel in the Bookings tab. On a guest's Nth visit the booking says so and
  offers "Reward given", which records when, the words that were promised and which
  visit it was (so changing the rule later does not rewrite what a guest was told),
  and can be taken back. The hub refuses to record one on a visit that has not
  earned it. Only seated visits count (bookings and walk-ins; not cancellations,
  no-shows or other guests), and the booking is not counted as its own earlier
  visit. The record replicates (migration 017: three nullable columns on
  `reservations`) and is restored with the diary. 18 hub tests, 17 on the tab and
  panel, a row of the real-database round trip; 47 + 36 mutations, the gaps closed.
- ✅ The same reward for a guest at the door (2026-10-23). A walk-in who left a number
  and has been here before is offered it in the queue, under the same rule: the queue
  row says "3rd visit: a free lassi" and offers "Reward given", which records when, the
  words and which visit, and can be taken back. It is offered while they wait, once they
  are messaged and once they are seated, never once they have left, and a walk-in is
  not counted as their own earlier visit. A guest who gave no number cannot be
  recognised, so is offered nothing. The record replicates (migration 019: the same
  three nullable columns on `walkins`) and is restored with the diary. 10 hub tests,
  5 on the tab, a row of the real-database round trip; 44 mutations, the gaps closed.
- ⬜ Not built: **points, tiers, and any automatic discount.** The reward is applied on
  the bill by a person, because the product does not know what a dessert costs or how
  much the owner will give. The rule itself is a setting on the hub (like guest
  ordering) and is not replicated.
- ✅ Feedback at bill-close: a guest rates their meal on the diner page and
  the hub attaches it to that table's own settled bill server-side, so
  reception knows which meal it is about without the guest ever seeing a
  bill. Reception reads it in the admin console's Feedback tab (average,
  rating split, low ratings flagged). Replicated to the cloud (migration 013,
  `guest_feedback`): insert-only, like a cash-up, so a retried push is a no-op and
  a guest's statement is never edited; restored onto a replacement laptop only
  when it holds none of its own; entries from before the migration are carried up
  by the boot backfill. Nothing identifying the guest is kept to copy. Unrun
  against a real project, like the rest.

### 4.6 Reservations & waitlist  🟡
- ✅ Time-slot reservations, checked against the real table layout: a party needs a
  table at least its own size and competes for those tables with every overlapping
  booking for a party at least as big. Walk-ins already seated are counted. A
  restaurant can overbook anyway, and the booking records that it did.
- ✅ A walk-in queue on the hub, in the admin Bookings tab. A number is optional
  there and required for a booking, because a booking is a promise you may have to
  chase.
- ✅ **The old Waitlist tab is retired.** The server-laptop shell's `WaitlistView`
  was a browser-`localStorage` list seeded with demo rows that shared nothing with
  the hub queue, so a restaurant that opened the wrong tab saw an unrelated,
  empty-looking list. It is deleted; the tab now says where bookings and the queue
  are and links to the admin console's Bookings tab. (The unused waitlist state in
  `PosContext`, its demo data and its two operations are deleted too.)
- ✅ "Your table is ready" by WhatsApp click-to-chat: the hub writes the message and
  staff tap to send from their own phone. No Meta approval, no provider, no
  per-message fee, and it works with the line down.
- ✅ Cloud copy (migration 011), as the fourth replicated catalog.
- ⬜ A public reservation page per tenant. The model and the replication are in
  place for one; the page itself needs hosting this product does not have.
- ✅ Booking reminders, staff-sent like the rest: the Bookings tab lists the next day's
  bookings that nobody has reminded ("Reminders to send"), each with a WhatsApp link
  that already carries the reminder and a number to ring. Opening the link is not
  sending, so the host presses "I sent it", and the hub records **that a person said
  they sent it, and when** (and who, if told), which stops two people ringing the
  same guest. It is a person's word, not a delivery receipt: nothing here knows the
  message arrived. A mark can be taken back. The mark replicates (migration 016: two
  nullable columns on `reservations`) and is restored with the diary. 18 hub tests,
  7 on the tab, a row of the real-database round trip; 53 mutations, the survivors
  closed.
- ⬜ Sending anything *automatically*: still nothing goes out by itself. The hub has no
  messaging provider, by design (no approval, no per-message fee, works with the line
  down), so a message always needs a person to press send.

### 4.7 Auth & access control  🟡
- ✅ Waiter PIN login wired into the PWA, session bound to a device token.
- 🟡 Role UIs for owner / manager / waiter / kitchen. Roles are STORED per
  staff member and shown to reception, **the cloud enforces them for owners and
  managers** (read-only; only the hub's `kitchen` identity writes, migration
  015), and **the hub now keeps every money decision off the waiters' handsets**
  (void, refund, settle, split, discount: reception only). What is not done is a
  role *at* the reception laptop: whoever is signed in there can still void or
  refund, with no manager PIN and no cashier/manager split.
- ✅ Role-scoped device tokens: a station tablet enrols with a `kitchen` token
  that can read the board and mark tickets and stations done, and is refused
  everything else with 403 `DEVICE_SCOPE`. Default-deny -- `requireDevice` refuses
  it everywhere and five routes are opened on purpose, pinned by a test. Grants
  from before this keep full authority, and an unrecognised stored scope reads as
  the narrower one. It limits what a mishandled tablet can do; the scope is the
  device's own choice at enrolment, so it is not a barrier against anyone who
  has the enrolment code.
- ✅ A kitchen token is told the board and not the bill. The live feed used to
  send every event to every connection, so a screen enrolled with the narrow
  `kitchen` scope still heard every invoice, void, refund, cash-up and sync
  status, and every ticket it was sent (live or over HTTP) carried the order
  total and each line's price. Now `lib/liveFeed.js` decides, default-deny: a
  kitchen connection is sent only the ticket and table-cleared events, and a
  greeting without the menu, table list or sync detail; `/orders/active` and the
  ready, fire and recall answers are narrowed the same way. The narrowing is an
  **allow-list at every level** (the event's keys, the ticket's fields, a line's and
  an extra's fields), so a field added to tickets later (a guest's phone, a payment
  reference) reaches a kitchen only when someone lists it; an earlier version
  stripped money and let everything else through. Handsets and the reception
  laptop are unchanged. 18 tests (`liveFeed.test.mjs`), 47 mutations all caught.
- ✅ `POST /waiters` and `DELETE /waiters/:id` are reception-only. They were
  commented "reception / admin" but needed only a device token, so any enrolled
  handset could add a waiter with a PIN of its own or lock another waiter out
  mid-shift. Nothing in the app called them (reception's Staff tab uses
  `/admin/staff`), so nothing needed changing but the four tests that drove them.
- ⬜ Password reset + optional SSO for owner accounts.

### 4.8 Reliability & observability  🟡
- ✅ CI pipeline (GitHub Actions): hub tests + build on Node 20/22.
- ✅ Crash / error reporting from the hub and both PWAs.
- 🟡 Frontend test suite: Vitest + Testing Library runs in CI as its own step.
  First surfaces are the diner page, the admin Feedback tab and the waiter
  modifier sheet, including a contract test that feeds the sheet's output to
  the hub's real `priceOrder`. Since extended to every reception admin tab
  (Printers, Plan and the menu importer included), and the waiter app (all of it
  but the QR scanner) and the reception KDS. Still to do: the QR scanner, and a
  Playwright smoke run in a real browser.
- ✅ Structured logging and an optional OpenTelemetry export (`docs/LOGGING.md`):
  `HUB_LOG_FORMAT=json` turns every log line into one JSON line, and
  `OTEL_EXPORTER_OTLP_ENDPOINT` also ships them to a collector as OTLP/HTTP JSON. Off
  unless asked for, no call site edited (the console is wrapped). Records are
  redacted as they are made (tokens, enrolment codes, PINs, JWTs), the request log
  never records a query string, and the exporter is bounded and cannot hurt the hub
  when the collector is down. Logs only: no gRPC or protobuf exporter, no traces, no
  metrics. 37 tests, 55 mutations all caught.
- ✅ Stable fixture ports: the hub binds `:0` and reports the port it got, so
  there is no window between choosing a port and holding it. Runner
  concurrency capped so the suite stops oversubscribing the machine.
- ✅ Hermetic test runs: a before/after snapshot of `hub_server/data/` shows the
  suite touching nothing there. (It used to fill the real crash log with test
  records, displacing any genuine crash.)

### 4.9 Deployment & fleet  ⬜
- One-click hub installer for Windows (auto-start service, firewall rule,
  update channel) — M3 · PR 20.
- Signed auto-updates for the hub binary.
- Remote fleet view: which tenants' hubs are online / behind on sync.

### 4.10 Documentation  🟡
- ✅ `CHANGELOG.md` following Keep a Changelog: no releases are tagged, so it is grouped by milestone, with the unmerged work under Unreleased.
- ✅ `CONTRIBUTING.md` capturing the `Darshil_docs` audit-report SOP, tests-first and mutation checking, and the default-deny rules.
- ✅ `docs/pilot-report-template.md`, and the README no longer lists the missing
  `docs/mejwani-pos-progress-report.md`.
- ⬜ `LICENSE`: not written. Which licence this product is released under is the owner's decision, not an engineering one; the
  README still says only "maintained by Darshil & Engineering Team".

---

## 5. Milestones

Milestones are named, unversioned buckets. Each pulls in a slice of §4.
Dates land on a milestone when it's actively being planned.

### M1 — Payments-ready  ✅
Enough billing + printing to run a paid pilot end-to-end without a
parallel manual bill book. **Complete 2026-10-05.**
- ✅ 4.1 invoice + tax breakdown, split-bill, cash/UPI capture, thermal
  printer, reconciliation.
- ✅ 4.7 waiter PIN login on the PWA.
- ✅ 4.8 CI pipeline + hub error reporting.
- 🟡 Carried to 4.1: bills and reconciliation records now replicate (005, 006)
  and can be restored, but replication is one-way and unproven against a real
  Supabase project (§3).

### M2 — Menu depth  ✅
Enough menu modelling to onboard restaurants beyond a flat item list.
**Complete 2026-10-07**; the inventory tail closed 2026-10-19.
- ✅ 4.2 modifiers, variants, per-variant 86'd, day-part pricing.
- ✅ 4.3 multi-station KDS routing and course firing.
- ✅ 4.2 stock-driven 86'd and inventory tables.
- ✅ 4.2 modifier choices that use stock, order cancellation, costing, stock-up-to
  levels, a shopping list, and an out-of-stock extra greyed out on the waiter's
  sheet (2026-10-22).

### M3 — Self-serve tenant  🟡
The product can onboard a new restaurant without engineering.
- ✅ PR 16 — plan model + enforcement in the hub.
- ✅ PR 18 — owner console plan view.
- ✅ 4.4 staff invites, role management, PIN rotation and per-device
  revocation.
- 🟡 PR 17 — provisioning (007) and the operator service that calls it are built
  and tested; there is no public signup page in front of it, and none of it has
  run against a real project.
- 🟡 PR 19 — Razorpay chosen; the webhooks, plan status and the owner's start /
  switch / cancel flow are built and tested against stand-ins (2026-10-23). There
  are no keys, and Razorpay has never been called for real.
- ⬜ PR 20 — Windows installer + fleet view.
- 🟡 4.10 CHANGELOG and CONTRIBUTING are written; LICENSE is the owner's call.

### M4 — Customer surfaces  🟡
- ✅ Sales analytics for reception (2026-10-22): period comparisons, guests new
  and returning, cohorts, and daily/weekly summaries sent by WhatsApp tap (§3).
- 🟡 4.5 diner QR menu, guest ordering (opt-in), repeat-visit recognition and
  feedback (now replicated, migration 013) shipped. Open, and not for want of
  code: paying from the phone needs Razorpay keys and a public callback address.
  A reward for coming back shipped in the one form that needs no commercial
  decision from the product: the restaurant sets "every Nth visit, <words>" and the
  hub reminds and records (migration 017), for bookings and for guests at
  the door (migration 019). Points, tiers and an automatic discount are not built.
- 🟡 4.6 reservations, the walk-in queue and WhatsApp click-to-chat; the old
  browser-local Waitlist tab is retired. Reminders are staff-sent: the hub lists who
  to remind, builds the message and records that a person sent it (migration 016); it
  sends nothing by itself. A public booking page is still open and needs hosting.

---

## 6. How this document is maintained

Every change that closes or reshapes a bullet lands with a report in
[Darshil_docs/reports/](../Darshil_docs/reports/) and a diff to this file
in the same commit. Priorities and milestone contents change; the shape
of §2 (shipped) only grows.

This rule only works while the file is on the branch the work lands on.
It sat on an unmerged `docs/roadmap` branch from 2026-09-19 to 2026-10-13
and went two milestones stale, which is the failure mode to watch for.

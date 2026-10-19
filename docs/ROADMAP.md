# Product Roadmap — Restaurant POS & KDS SaaS

Living document. Reflects the state of the working line as of the latest
commit and the work planned beyond it. This is a **multi-tenant SaaS product** —
pilot restaurants are validation partners, not the product itself. Nothing in
this roadmap is scoped to any single tenant.

Legend: ✅ shipped · 🟡 partial · ⬜ not started

**Last reconciled against the code:** 2026-10-13 (M1 and M2 complete, M3 in
progress). Between 2026-09-19 and this revision the file lived on an unmerged
`docs/roadmap` branch, so §6's maintenance rule could not be followed and the
document fell a full two milestones behind. It is now on the working line.

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
- **Reception admin console** (`/admin`) — menu, table layout, cash and
  payments, kitchen performance, printers, subscription plan.
- **Diner menu** (`/diner`) — read-only, no sign-in, opened from a table code.
- **Reception / server-laptop app** — sales analytics, waitlist.

M1 (payments-ready) and M2 (menu depth) are complete. The current focus is
M3 — self-serve tenant — of which plan enforcement and the owner console's
plan view have shipped.

Automated coverage is **589 hub tests across 31 files** (pure rules plus live
hub fixtures that boot a real server against a throwaway data directory) and
**49 frontend tests** (Vitest + Testing Library in jsdom) on the diner page,
the admin Feedback tab and the waiter modifier sheet. The KDS, the rest of the
admin console and the rest of the waiter PWA are still verified by hand.

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
  `device_pairings`, `invoices` (005), `reconciliations` (006).
- ✅ Row Level Security on every tenant-scoped table; `current_restaurant_id()`
  resolved from `auth.uid()` via `staff_users`.
- ✅ `provision_kitchen_staff` `SECURITY DEFINER` RPC, `pin_hash` via
  `pgcrypto`, per-tenant bcrypt provisioning secret.
- ✅ Migrations `001`–`007`: secure hub provisioning, online RLS and order
  items, hub-authoritative menu and tables, subscription plan status, invoice and
  cash-up cloud replication, tenant provisioning.
- ✅ `plan` on `restaurants` (`starter` / `pro` / `enterprise`) **enforced in
  product**, not just modelled — see §2 Tenant lifecycle.

### Security
- ✅ Cross-tenant takeover closed (RPC no longer accepts arbitrary
  `p_user_id`, EXECUTE revoked from `anon`).
- ✅ Bearer device-token auth on every mutating hub route; tokens hashed at
  rest, rate-limited enrollment, constant-time compare.
- ✅ Reception-only guard on catalog writes and admin routes; enrolled
  handsets get 403 `RECEPTION_ONLY`.
- ✅ The hub's server-rendered fallback page escapes the restaurant name,
  pairing code, table name and item names it prints. Table names come
  straight off an order body from a handset, so this was reachable by staff,
  not only by an admin. That page is also reception-only now: it used to
  print the pairing code and the live tickets to any caller, against the
  decision `/pairing-info` had already made about the same code.
- ✅ CORS locked to LAN / loopback; `/qr` and `/toggle-outage` restricted
  to the reception laptop.
- ✅ WebSocket `/live` authorised (token in query string).
- ✅ Server-side pricing — waiter clients no longer submit totals.

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

### Kitchen operations (M2)
- ✅ Multi-station routing (hot / cold / bar) with per-station KDS filtering
  and station-scoped KOTs.
- ✅ Course firing and hold-and-fire.
- ✅ Prep-time telemetry per item and per station, surfaced in the admin
  console's Kitchen tab.
- ✅ Ticket recall.

### Tenant lifecycle (M3, in progress)
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

### Frontend surfaces
- ✅ Kitchen KDS (`src/server_laptop/KitchenKdsView.jsx`): live ticket rail,
  pairing QR + enrollment code, connection badge grace states, Framer
  Motion ticket-printer moment, kitchen summary counters, station chips,
  bill preview and settlement.
- ✅ Admin console (`src/admin/`): menu, tables, cash & payments, kitchen
  performance, printers, plan.
- ✅ Reception: `SalesAnalyticsView`, `WaitlistView`, `ServerLaptopApp` shell.
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
  `docs/DEPLOYMENT_GUIDE.md`, this roadmap.
- ✅ Timestamped audit log in `Darshil_docs/reports/` (per-change what/why
  + test cases; every change lands with a report).
- ✅ Hub regression suite: 527 tests, fixtures on hub-chosen ports with a
  stale-hub guard, 10 consecutive clean runs.
- ✅ CI (GitHub Actions): `npm test` + `npm run build` on Node 20/22 for
  every push and PR.
- ✅ Crash reporting from the hub and both PWAs into a rolling log.

---

## 3. In-flight / partial

- 🟡 **Owner console**: plan and usage have shipped; staff invites, role
  management, PIN rotation and hub device revocation have not. The console
  is reception-only — there is no remote owner view.
- 🟡 **Inventory**: the M2 leftover. There are no `inventory_items` or
  `recipes` tables, so 86'd is set by hand in the editor rather than driven
  by stock-out.
- 🟡 **Kitchen operations tail**: course state is still not replicated to
  Supabase (only ticket status is), and station screens are a filter on one
  display rather than per-station KDS instances. Recall now reprints, firing
  is plan-gated, and the CSV carries course.
- 🟡 **Billing replication is one-way and unproven**: bills and cash-ups now
  push to the cloud (005, 006) and a boot backfill carries up anything the
  cloud has not confirmed, but nothing has run against a real Supabase
  project and the hub never reads either back, so a reinstalled hub still
  starts with an empty ledger.
- 🟡 **Waitlist**: `waitlist_entries` table + `WaitlistView` exist; no
  guest notification (SMS / WhatsApp), no configurable time-slot
  reservations.
- 🟡 **Analytics**: real-time revenue + orders panel is live and cash
  reconciliation exports a CSV ledger; no period comparison, cohorting or
  scheduled reports.
- ✅ **Operational dashboard** (`/dashboard`): the 2026-09-19 revision of
  this file flagged flaky hydration. Re-checked on 2026-10-13 against a
  running hub — sales, floor grid, active KOTs and billed orders all render
  with no console errors. Moved out of this section.
- 🟡 **Test coverage**: the hub is well covered. A frontend runner now exists
  and covers the diner page, the admin Feedback tab and the waiter modifier
  sheet; the KDS, the other admin tabs, order entry and login are still
  verified by hand, and nothing yet drives a real browser.

---

## 4. Backlog — grouped by theme

Ordered within each theme by rough priority. No dates; dates go on
milestones (§5) when a theme is pulled into a release.

### 4.1 Billing & payments  🟡
- ✅ Invoice + tax breakdown, discounts and service charge, lifecycle,
  split-bill, refunds, thermal printing, reconciliation — all shipped in M1.
- ✅ Cloud replication of invoices (migration 005): every issue, settlement,
  void, refund and split is pushed as a full snapshot, upserted on the hub's
  own invoice id. **Not yet run against a real Supabase project.**
- ✅ Restore: a hub with an empty ledger pulls its bills and cash-ups back
  from the cloud at boot and on reconnect. Only ever fills, never merges —
  a hub that holds bills is the authority on them.
- ⬜ Repairing a *partial* ledger (some bills present, others missing) is
  not attempted; that needs a per-bill merge rule.
- ✅ Cloud replication of cash-up records (migration 006), inserted rather
  than upserted: a closed shift is immutable.
- ✅ Backfill at boot for bills and cash-ups the cloud has not confirmed,
  so an existing ledger replicates rather than only new takings.
- ✅ A sync queue file that will not parse is salvaged, preserved for
  recovery by hand and reported loudly, instead of being answered with an
  empty queue and overwritten.
- ⬜ The queue's disk write is still not atomic, so the entry being written
  when a hub crashes is still lost. Making it atomic was tried and reverted
  on measurement; it needs a transactional design, not a swapped call.

### 4.2 Inventory & menu depth  🟡
- ✅ `menu_item_variants`, modifiers and day-part scheduling, surfaced in
  the order draft drawer.
- ⬜ `inventory_items` and `recipes` tables.
- ⬜ 86'd-item propagation from stock-out to the waiter menu grid
  (per-variant 86'd exists, but it is set by hand).

### 4.3 Kitchen operations  🟡
- ✅ Multi-station routing, course firing / hold-and-fire, prep-time
  telemetry, ticket recall.
- ✅ Reprint on recall, banner-marked so a reprint cannot be mistaken for a new order.
- ⬜ Per-station KDS *instances* (today a station screen is a filter on the
  one display, reached as `/?station=bar`).
- ✅ Course state replicated to the cloud (migration 008): `staged` and a
  per-course log of when each was fired and each station finished, plus each
  line's course and station. A cloud without 008 still gets the order and its
  status; only the course detail waits. Also fixed: a station finishing its
  part before the ticket was ready used to enqueue nothing.

### 4.4 Tenant lifecycle  🟡
- ✅ Plan model and enforcement against `restaurants.plan`.
- ✅ Owner console: plan, limits, usage, entitlements.
- 🟡 Tenant provisioning: `provision_restaurant()` (migration 007) creates a
  complete trialing tenant in one call, replacing four manual SQL steps.
  There is still no signup surface in front of it (M3 · PR 17).
- ⬜ Owner console: staff invites, role management, PIN rotation, hub device
  revocation (M3 · PR 18 follow-up).
- ⬜ Billing integration (Razorpay / Stripe) for subscription (M3 · PR 19) —
  **blocked on a payment-provider decision**.

### 4.5 Customer-facing surfaces  🟡
- ✅ Diner QR menu, view-only: a table code opens a read-only menu served
  by the hub over the restaurant's own wifi. Effective (day-part) prices,
  86'd dishes hidden, built from an allow-list so the cache cannot leak
  into it. Reception prints a sheet of one code per table from the Tables
  tab.
- ⬜ Order-and-pay from that menu (blocked with PR 19 on the payment
  provider decision).
- ⬜ Loyalty / repeat-visit identifier.
- ✅ Feedback at bill-close: a guest rates their meal on the diner page and
  the hub attaches it to that table's own settled bill server-side, so
  reception knows which meal it is about without the guest ever seeing a
  bill. Reception reads it in the admin console's Feedback tab (average,
  rating split, low ratings flagged); it is not replicated to the cloud.

### 4.6 Reservations & waitlist  ⬜
- Time-slot reservations independent of walk-in waitlist.
- SMS / WhatsApp notifications ("your table is ready").
- Public reservation page per tenant.

### 4.7 Auth & access control  🟡
- ✅ Waiter PIN login wired into the PWA, session bound to a device token.
- ⬜ Role UIs for owner / manager / waiter / kitchen.
- ⬜ Password reset + optional SSO for owner accounts.

### 4.8 Reliability & observability  🟡
- ✅ CI pipeline (GitHub Actions): hub tests + build on Node 20/22.
- ✅ Crash / error reporting from the hub and both PWAs.
- 🟡 Frontend test suite: Vitest + Testing Library runs in CI as its own step.
  First surfaces are the diner page, the admin Feedback tab and the waiter
  modifier sheet, including a contract test that feeds the sheet's output to
  the hub's real `priceOrder`. Still to do: the KDS, order entry, login, the
  other admin tabs, and a Playwright smoke run in a real browser.
- ⬜ Structured logging + optional OpenTelemetry export from the hub.
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

### 4.10 Documentation  ⬜
- `CHANGELOG.md` following Keep a Changelog.
- `LICENSE` file (README references licensing but no file is present).
- `CONTRIBUTING.md` capturing the `Darshil_docs` audit-report SOP.
- A generic `docs/pilot-report-template.md` in place of the referenced
  `docs/mejwani-pos-progress-report.md`, which is not in the tree.

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
- 🟡 Carried to 4.1: replication is one-way and unproven against a real
  Supabase project; reconciliation records are still hub-local.

### M2 — Menu depth  ✅
Enough menu modelling to onboard restaurants beyond a flat item list.
**Complete 2026-10-07**, less the inventory tail.
- ✅ 4.2 modifiers, variants, per-variant 86'd, day-part pricing.
- ✅ 4.3 multi-station KDS routing and course firing.
- 🟡 Carried to 4.2: stock-driven 86'd and inventory tables.

### M3 — Self-serve tenant  🟡
The product can onboard a new restaurant without engineering.
- ✅ PR 16 — plan model + enforcement in the hub.
- ✅ PR 18 — owner console plan view.
- 🟡 PR 17 — provisioning done (007); the signup surface is not.
- ⬜ PR 19 — subscription billing (blocked on a payment-provider decision).
- ⬜ PR 20 — Windows installer + fleet view.
- ⬜ 4.10 CHANGELOG, LICENSE, CONTRIBUTING.

### M4 — Customer surfaces  🟡
- 🟡 4.5 diner QR menu shipped view-only; order-and-pay and loyalty open.
- 4.6 reservations + WhatsApp notifications.

---

## 6. How this document is maintained

Every change that closes or reshapes a bullet lands with a report in
[Darshil_docs/reports/](../Darshil_docs/reports/) and a diff to this file
in the same commit. Priorities and milestone contents change; the shape
of §2 (shipped) only grows.

This rule only works while the file is on the branch the work lands on.
It sat on an unmerged `docs/roadmap` branch from 2026-09-19 to 2026-10-13
and went two milestones stale, which is the failure mode to watch for.

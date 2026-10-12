# Product Roadmap — Restaurant POS & KDS SaaS

Living document. Reflects the state of `main` as of the latest commit and the
work planned beyond it. This is a **multi-tenant SaaS product** — pilot
restaurants are validation partners, not the product itself. Nothing in this
roadmap is scoped to any single tenant.

Legend: ✅ shipped · 🟡 partial · ⬜ not started

---

## 1. Where we are today

The platform is a LAN-first, offline-capable Point of Sale and Kitchen
Display System with a cloud-synced multi-tenant backend. Each tenant runs a
local hub (a reception laptop on the restaurant's Wi-Fi) that owns the live
operational state and asynchronously reconciles to Supabase.

Three surfaces are functional end-to-end and have been field-validated with
early pilots:

- **Kitchen Hub Display** — live KOT ticket rail with pairing QR, connection
  telemetry, and sync status.
- **Waiter Handset PWA** — installable, LAN-paired, floor grid + menu +
  cart, works while WAN is down.
- **Reception / server-laptop admin** — self-serve menu, table layout, sales
  analytics, waitlist.

The current release focus has been reliability and security hardening
(offline queue, idempotency, RLS isolation, hub device auth, server-side
pricing). Formal automated coverage is limited to the hub gateway.

---

## 2. Shipped capabilities

### Architecture & platform
- ✅ LAN-first hub gateway (`hub_server/`) on Node/Express + `ws`, bound to
  `0.0.0.0:4000`, serves the built KDS and waiter PWA statically.
- ✅ Async cloud sync worker with disk-persisted queue
  (`hub_server/data/tickets.json`), idempotent by `order_request_id`,
  perpetual-retry loop with terminal-state logging.
- ✅ Boot-time cloud reconciliation and disk-persisted menu / table cache
  so the hub survives cold starts without WAN.
- ✅ Non-blocking I/O across the hub, live `/dashboard-data` and
  `/dashboard` operational view.

### Data & multi-tenancy (Supabase)
- ✅ Schema: `restaurants`, `staff_users`, `tables`, `menu_categories`,
  `menu_items`, `orders`, `order_items`, `waitlist_entries`,
  `device_pairings`.
- ✅ Row Level Security on every tenant-scoped table; `current_restaurant_id()`
  resolved from `auth.uid()` via `staff_users`.
- ✅ `provision_kitchen_staff` `SECURITY DEFINER` RPC, `pin_hash` via
  `pgcrypto`, per-tenant bcrypt provisioning secret.
- ✅ `plan` column on `restaurants` (`starter` / `pro` / `enterprise`) —
  wired at the data layer, not yet enforced in product.

### Security
- ✅ Cross-tenant takeover closed (RPC no longer accepts arbitrary
  `p_user_id`, EXECUTE revoked from `anon`).
- ✅ Bearer device-token auth on every mutating hub route; tokens hashed at
  rest, rate-limited enrollment, constant-time compare.
- ✅ CORS locked to LAN / loopback; `/qr` and `/toggle-outage` restricted
  to the reception laptop.
- ✅ WebSocket `/live` authorised (token in query string).
- ✅ Server-side pricing — waiter clients no longer submit totals.

### Frontend surfaces
- ✅ Kitchen KDS (`src/server_laptop/KitchenKdsView.jsx`): live ticket rail,
  pairing QR + enrollment code, connection badge grace states, Framer
  Motion ticket-printer moment, kitchen summary counters.
- ✅ Reception admin: `SelfServeAdminView` (menu / pricing / table layout),
  `SalesAnalyticsView`, `WaitlistView`, `ServerLaptopApp` shell.
- ✅ Waiter PWA (`src/waiter_mobile/`): floor grid with live table state,
  category-filtered menu grid, order draft drawer, rapid order builder,
  LAN dispatcher, connection badge, service worker + manifest.

### Design system
- ✅ Centralised token architecture (`design-system/css/tokens.css`,
  `typography.css`, `ts/tokens.ts`).
- ✅ Kullina light theme; unified typography scale exposed under both
  `.type-*` and `.typography-*` class aliases; status colour palettes
  (green / amber / blue / rust); JetBrains Mono for numerics.
- ✅ 40+ restaurant-oriented UI components.

### Documentation & process
- ✅ `docs/ARCHITECTURE.md`, `docs/API_SPECIFICATION.md`,
  `docs/DEPLOYMENT_GUIDE.md`.
- ✅ Timestamped audit log in `Darshil_docs/reports/` (per-change what/why
  + test cases; every change lands with a report).
- ✅ First regression suite: `hub_server/test/hub.test.mjs` (security
  fixes covered).

---

## 3. In-flight / partial

- 🟡 **Waitlist**: `waitlist_entries` table + `WaitlistView` exist; no
  guest notification (SMS / WhatsApp), no configurable time-slot
  reservations.
- 🟡 **Analytics**: real-time revenue + orders panel is live; no period
  comparison, cohorting, exports, or scheduled reports.
- 🟡 **Auth surface**: hub device tokens + kitchen-staff RPC are in place;
  no owner / manager login UI, no waiter PIN login integrated into the
  PWA (a standalone `misc/demos/pin-login-flow-tester.html` prototype
  exists but is not wired into the app).
- 🟡 **Operational dashboard** (`/dashboard`): serves the built React app;
  hydration was flaky in the last spot check — needs a follow-up pass.

---

## 4. Backlog — grouped by theme

Ordered within each theme by rough priority. No dates; dates go on
milestones (§5) when a theme is pulled into a release.

### 4.1 Billing & payments  ⬜
- Invoice generation with itemised tax / GST breakdown, discounts,
  service charge, and rounding rules.
- Split-bill (by seat, by items, by amount).
- Payment method capture — UPI, cash, card — with reconciliation records.
- Void / refund flow with audit trail.
- ESC/POS thermal-printer driver for KOT and customer bill (network + USB).

### 4.2 Inventory & menu depth  ⬜
- `inventory_items`, `recipes`, `modifiers`, `menu_item_variants` tables.
- 86'd-item propagation from stock-out to waiter menu grid.
- Menu scheduling (time-of-day availability, day-part pricing).
- Modifier groups (spice level, size, add-ons) surfaced in the order
  draft drawer.

### 4.3 Kitchen operations  ⬜
- Multi-station routing (hot kitchen / bar / cold / dessert) with
  per-station KDS instances.
- Course firing / hold-and-fire.
- Prep-time telemetry per item and per station.
- Ticket recall + reprint.

### 4.4 Tenant lifecycle  ⬜
- Self-serve tenant signup + restaurant creation flow.
- Plan selection and enforcement against `restaurants.plan`
  (`starter` / `pro` / `enterprise`).
- Owner / manager console (staff invites, role management, PIN rotation,
  hub device revocation).
- Billing integration (Razorpay / Stripe) for subscription.

### 4.5 Customer-facing surfaces  ⬜
- Diner QR menu (view-only, then order-and-pay).
- Loyalty / repeat-visit identifier.
- Feedback capture at bill-close.

### 4.6 Reservations & waitlist  ⬜
- Time-slot reservations independent of walk-in waitlist.
- SMS / WhatsApp notifications ("your table is ready").
- Public reservation page per tenant.

### 4.7 Auth & access control  ⬜
- Waiter PIN login wired into the PWA; session bound to a device token.
- Role UIs for owner / manager / waiter / kitchen.
- Password reset + optional SSO for owner accounts.

### 4.8 Reliability & observability  ⬜
- Frontend test suite (Vitest + Playwright smoke on KDS and PWA).
- CI pipeline (GitHub Actions): lint + unit + hub tests + build.
- Structured logging + optional OpenTelemetry export from the hub.
- Crash / error reporting from the hub and both PWAs.

### 4.9 Deployment & fleet  ⬜
- One-click hub installer for Windows (auto-start service, firewall rule,
  update channel).
- Signed auto-updates for the hub binary.
- Remote fleet view: which tenants' hubs are online / behind on sync.

### 4.10 Documentation  ⬜
- `CHANGELOG.md` following Keep a Changelog.
- `LICENSE` file (README references licensing but no file is present).
- `CONTRIBUTING.md` capturing the `Darshil_docs` audit-report SOP.
- Restore or rewrite the referenced `docs/mejwani-pos-progress-report.md`
  as a generic `docs/pilot-report-template.md`.

---

## 5. Milestones

Milestones are named, unversioned buckets. Each pulls in a slice of §4.
Dates land on a milestone when it's actively being planned.

### M1 — Payments-ready
Enough billing + printing to run a paid pilot end-to-end without a
parallel manual bill book.
- 4.1 invoice + tax breakdown, split-bill, cash/UPI capture, thermal
  printer.
- 4.7 waiter PIN login on the PWA.
- 4.8 CI pipeline + hub error reporting.

### M2 — Menu depth
Enough menu modelling to onboard restaurants beyond a flat item list.
- 4.2 modifiers, variants, 86'd-item propagation, day-part pricing.
- 4.3 multi-station KDS routing and course firing.

### M3 — Self-serve tenant
The product can onboard a new restaurant without engineering.
- 4.4 tenant signup, owner console, plan enforcement, subscription
  billing.
- 4.9 Windows installer + fleet view.
- 4.10 CHANGELOG, LICENSE, CONTRIBUTING.

### M4 — Customer surfaces
- 4.5 diner QR menu → order-and-pay → loyalty.
- 4.6 reservations + WhatsApp notifications.

---

## 6. How this document is maintained

Every change that closes or reshapes a bullet lands with a report in
[Darshil_docs/reports/](../Darshil_docs/reports/) and a diff to this file
in the same commit. Priorities and milestone contents change; the shape
of §2 (shipped) only grows.

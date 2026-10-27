# Super Admin Console — Build Sheet

**Audience:** AI coding agent working in the Kullina monorepo (Restaurant-Bar-SaaS).
**Owners:** Aman (product), Darshil (engineering). **Drafted:** 2026-10-24.
**Suggested location:** `docs/SUPER_ADMIN_BUILD_SHEET.md`. Once Phase 1 starts, split a living `docs/SUPER_ADMIN.md` from this sheet and keep this sheet as the plan of record.

**Status legend (use exactly these):** ✅ Built | 🔄 In Progress | 🚧 Planned | 🔬 R&D | ❌ Blocked

**Fact labels:** **[CONFIRMED]** = stated in `ROADMAP.md` or retrieved from a cited source. **[INFERRED]** = reasoned, not verified. **[VERIFY]** = check in the repo before relying on it. Never promote an inference to a fact in code comments, docs or reports.

---

## 0. Agent protocol (read first)

1. Read before coding: `ROADMAP.md` (§3, §4.4, §4.7, §4.9), `CONTRIBUTING.md`, `docs/OPERATOR_SERVICE.md`, `docs/ARCHITECTURE.md`, `hub_server/lib/plans.js`, `signup_server/`, and migrations `001`–`021`. Complete the checklist in §14 and write down what you found.
2. **Tests first.** Every rule gets a failing test, then code, then a mutation check (break the rule on purpose; the suite must notice). This is the repo's existing standard.
3. **Default-deny everywhere.** New routes, RPCs, commands and table privileges are closed until explicitly opened. Open routes and commands are listed in a pinned test, like the existing device-scope test.
4. **One phase per PR series.** Do not start phase N+1 until phase N's acceptance criteria pass.
5. **You have no hosted credentials.** Never invent or request Supabase service keys, Razorpay keys, or alert-channel tokens. Build and test against PGlite (real Postgres engine) and stand-ins, as the repo already does. Deploying is a human step (see Gate G0-1).
6. **Stop and ask** (do not choose) when you reach a decision in §12 marked **HUMAN**, when a task would require a destructive or irreversible change, or when a repo fact contradicts this sheet.
7. **Every change lands with:** a report in `Darshil_docs/reports/` (what/why + test cases), a diff to `ROADMAP.md` §4.9 in the same commit, a `CHANGELOG.md` Unreleased entry, and doc updates. Use the status badges above.
8. **Report honestly.** If something is only proven against a stand-in, say so, as the roadmap does today.

---

## 1. Goal and non-goals

**Goal:** a back-office for the two founders to run Kullina as a business. Today only a read-only fleet view exists (`/ops`, ✅, §4.9). This sheet adds: named secure access, an immutable event spine, push alerting, safe tenant writes, hub commands with acknowledgement, billing operations, onboarding tooling, and a compliance desk.

**Non-goals (see §13 for the full never-build list):** a CRM, a ticketing system, tenant-revenue analytics, impersonation, editing any tenant's bills, role-based access beyond two founders, fleet-wide release rollout.

---

## 2. Ground truth

**[CONFIRMED] from `ROADMAP.md`**
- Operator service `signup_server/` holds the Supabase service key and Razorpay secrets, is already public (webhooks, booking page), and serves `/ops` behind one shared `OPS_TOKEN`.
- `/ops` is read-only: fleet counts, ten attention rules, per-restaurant detail, latest subscription events. Migration `021` adds a 5-minute hub heartbeat (counts and times only) and two cross-tenant views readable by the service role alone.
- Plans degrade, never block: past-due (7-day grace), suspended and cancelled tenants fall back to Starter; orders, billing and KDS are never switched off.
- `restaurants.plan` is set only by an `active` subscription. `plan_status` is kept by Razorpay webhooks. A payment problem becomes `past_due`, never `suspended`.
- Hub pulls plan state at boot and every 15 minutes, fail-soft offline.
- Migrations `004`–`022` have **never run on a hosted Supabase project.** Razorpay has never been called for real.
- Migration `014` sets each role's privileges explicitly because default privileges leaked write access. Follow that pattern.
- A restaurant's money is its own: the console shows hub-reported counts and times, not revenue.
- Invoice snapshots replicate to the cloud as full-snapshot upserts keyed on the hub's invoice id; cash-ups and feedback are insert-only.

**[CONFIRMED] from market research (cited in the research summary):** Petpooja sells an on-premise offline POS, so offline-first is table stakes. Tax authorities are reportedly investigating post-billing edits and bulk deletions in POS systems (reported allegations, not proven). A CA's write-up recommends restricted bulk deletion and a documented audit trail for modifications.

**[INFERRED] — verify before relying**
- The cloud invoice copy cannot prove what a bill said before an edit, because snapshots are upserted. Needs an append-only history (task LEDGER-1).
- GSTIN, HSN/SAC, CGST/SGST split and GST-compliant invoice numbering may be missing from the hub invoice generator; `ROADMAP.md` mentions only an "itemised tax breakdown".
- Detection latency for a dead hub is at least 10–15 minutes because heartbeats are every 5 minutes.
- Competitors score well on support in aggregate review sites, so support is table stakes until owner interviews say otherwise.

---

## 3. Invariants (violating any is a bug)

| # | Invariant |
|---|---|
| I1 | **No admin write path touches a tenant's bills, invoices, cash-ups, guests, menu or order state.** Not through the UI, an RPC, a command, or a SQL helper. Pinned by a test that enumerates every admin RPC/command and asserts none reach those tables. |
| I2 | **Service key never leaves the operator service environment.** Not in the admin frontend, repo, logs, or either founder's laptop. |
| I3 | **Every admin action is attributed.** `actor_id` is non-null for `actor_type = 'admin'`, enforced by a CHECK constraint. No shared tokens or accounts. |
| I4 | **Every admin write requires a reason** (min 10 chars) and writes an event in the **same transaction**. No event, no write. |
| I5 | **Events are append-only.** UPDATE and DELETE revoked from every role and blocked by trigger. |
| I6 | **LAN-first / honest degradation.** The cloud cannot reach a hub. Every action that affects a hub is a *request* with visible state `requested → delivered → acked` (or `failed` / `expired`). Never show an effect as applied before the hub acknowledges it. |
| I7 | **Never block a restaurant.** Admin actions may degrade a tenant to Starter at most. Nothing the console does may stop orders, billing or KDS. |
| I8 | **No silent staleness.** Every figure shows "as of HH:MM". If a read fails, show an error, never the last cached value as if current. |
| I9 | **Privacy minimum.** The console shows counts and times only. No PIN hashes, hub secrets, pairing codes, guest phone numbers, or bill contents. |
| I10 | **Admin surface is separate** from the public operator service (separate deploy, separate credentials, MFA-gated). |

---

## 4. Target architecture

```
Founder browser ── (Supabase Auth + TOTP, email allowlist, optional IP allowlist)
        │
   admin_web  (static SPA, separate Vercel project; no secrets)
        │  JWT (aal2)
   admin_api  (new small service; DB role `kullina_admin`, NOT the service key)
        │  calls SECURITY DEFINER RPCs only
   Supabase Postgres ── tenant_events (spine) · admin_commands · alerts · plan_overrides · …
        ▲                         ▲
   hub heartbeat (5 min)     operator service (webhooks, Razorpay, existing /ops)
   returns pending commands   writes events into the same spine
        │
   Alert worker (scheduled) ── push channel (§8) ── founders' phones
```

- **[INFERRED] design choice:** a dedicated Postgres role plus RPC-only access shrinks the blast radius versus giving the admin API the service key. Razorpay calls stay in the operator service, reached by `admin_api` through an internal, signed service-to-service route (Phase 5). Raise as decision D1 if you disagree.
- Reuse the existing `/ops` rules and constants (do not fork them). Move shared rule definitions into one module imported by both.
- Exact module and directory names: **[VERIFY]**. Suggested: `admin_web/`, `admin_api/`, shared rules in a common lib.

---

## 5. Data model (new migrations; confirm next free number, expected `023`+: `022` is `invoice_events`, the bill history built on 2026-10-26)

State privileges explicitly for every table and function (migration `014` pattern): `REVOKE ALL … FROM anon, authenticated, public;` then grant only what is listed.

| Table | Purpose | Key columns / rules |
|---|---|---|
| `admin_users` | Allowlist of console users | `user_id` PK → `auth.users`, `email` unique, `display_name`, `role text default 'founder'`, `active`, `created_at`, `created_by`. RBAC deferred; keep the column to avoid a later migration. |
| `tenant_events` | **The spine.** Append-only log of everything | `id` bigint identity, `restaurant_id` nullable (null only for global admin events), `occurred_at` (DB clock), `source` ∈ {hub, razorpay, admin, system, support}, `type`, `actor_type` ∈ {admin, hub, system, webhook}, `actor_id` nullable, CHECK (actor_type='admin' ⇒ actor_id NOT NULL), `request_id`, `payload jsonb`, `prev_hash`, `row_hash` (sha256 over prev_hash + canonical row, per restaurant chain). UPDATE/DELETE blocked. |
| `admin_commands` | Hub command requests | `id`, `restaurant_id`, `type` (allowlist enum), `params jsonb`, `status` ∈ {requested, delivered, acked, failed, expired, cancelled}, `requested_by` NOT NULL, `reason`, `requested_at`, `delivered_at`, `acked_at`, `expires_at`, `result jsonb`. |
| `alerts` | Alert lifecycle | `id`, `restaurant_id` nullable, `rule_key`, `severity`, `state` ∈ {open, acked, resolved}, `opened_at`, `acked_at`, `acked_by`, `resolved_at`, `escalation_level`, `last_notified_at`, `dedupe_key` (unique while not resolved). |
| `plan_overrides` | Comp/extension grants | `id`, `restaurant_id`, `plan`, `expires_at` NOT NULL, `reason`, `created_by`, `created_at`, `revoked_at`, `revoked_by`. |
| `tenant_admin_meta` | Admin-only tenant metadata | `restaurant_id` PK, `timezone`, `service_hours jsonb` (for alert quiet hours), `referred_by`, `contact_person`, `contact_phone`. Not readable by tenants. |
| `tenant_notes` | Support notes | immutable rows: `id`, `restaurant_id`, `author_id` NOT NULL, `body`, `created_at`, `pinned`. |
| `tenant_onboarding_steps` | Per-tenant go-live checklist | `restaurant_id`, `step_key`, `status`, `done_at`, `done_by`, `note`. |

Existing `subscription_events` and the migration `021` heartbeat tables stay as they are. Expose them through a **view or ingest job** into the spine (decide in task P1-4); do not rewrite history. Table names in `021`: **[VERIFY]**.

**RPCs** (all `SECURITY DEFINER`, `EXECUTE` revoked from `anon`; each begins by checking the caller is an active `admin_users` row **and** the JWT is `aal2`; each writes its event in-transaction):
`admin_extend_trial`, `admin_set_plan_status`, `admin_grant_comp_plan`, `admin_revoke_comp_plan`, `admin_add_note`, `admin_request_command`, `admin_cancel_command`, `admin_ack_alert`, `admin_resolve_alert`, `admin_set_onboarding_step`, `admin_update_tenant_meta`.

**Plan-override race (must be tested):** Razorpay webhooks set `restaurants.plan`. A comp grant is allowed only when the tenant has no `active` paid subscription, and the webhook handler must not overwrite while an unexpired override exists. A scheduled job reverts at expiry and writes an event.

---

## 6. Phases and tasks

Size: S (≤½ day), M (1–2 days), L (3+ days). Phases 1–4 can be built and tested locally; **deploying any phase is gated on G0-1.**

### Phase 0 — Gates (before deploy / in parallel with Phase 1) · ❌ Blocked on humans unless noted

| ID | Task | Owner |
|---|---|---|
| G0-1 | Run migrations `004`–`022` on a hosted Supabase project; run `npm run cloud:check`; record results. **In progress (2026-10-26): Aman is setting up the hosted project and credentials; not yet run.** | Human |
| G0-2 | Razorpay test-mode run of start/switch/cancel and webhooks. **In progress (2026-10-26): Aman is setting up test-mode credentials; not yet run.** | Human |
| G0-3 | **GST audit (🚧, agent, read-only):** check the invoice generator for GSTIN, HSN/SAC per line, CGST/SGST vs IGST split, sequential invoice numbers (≤16 chars, FY-aware), and a tax summary. Output a gap report; fix is a separate PR. Constraint #4 is unverified until this passes. **Done 2026-10-26: `Darshil_docs/reports/report_2026-10-26_133000_gst_audit.md`; constraint #4 is not satisfied today (no GSTIN, no HSN/SAC, no IGST path, no FY-aware series, no credit note).** | Agent |
| G0-4 | **LEDGER-1 analysis (🚧, agent, read-only):** confirm whether cloud invoice upserts lose prior content. Propose an append-only `invoice_events` with hash chain. Report only; do not implement without approval. **Done 2026-10-26: `Darshil_docs/reports/report_2026-10-26_134500_ledger_analysis.md`; cloud upserts do overwrite, and six hub fields are never sent. The `invoice_events` proposal was approved and built the same day: migration 022 (`Darshil_docs/reports/report_2026-10-26_150000_invoice_events.md`), so the admin console's tables start at `023`.** | Agent |
| G0-5 | Answer decisions D1–D5 (§12). | Human |

### Phase 1 — Foundation · 🟡 built 2026-10-26 (database, API and page; not yet run on a hosted project) · acceptance: two named founders sign in with MFA; every action is attributed

| ID | Task | Size |
|---|---|---|
| P1-1 | Migration: `admin_users`, `tenant_events` (+ hash chain, append-only triggers), privilege statements. **✅ 2026-10-26: migration `023_admin_spine.sql`, proven on PGlite** | M |
| P1-2 | Auth: Supabase Auth TOTP, allowlist check, `aal2` enforcement in every RPC. Seed script for exactly two founders (emails supplied by humans). **✅ database side 2026-10-26 (`seed_admin_user`, `aal2` in every `admin_*` function); the page enrols and answers a second factor (`admin_web`) ✅; never met a real Supabase Auth** | M |
| P1-3 | `admin_api` + `admin_web` skeleton, separate deploy config, security headers (CSP, no inline script), optional IP allowlist hook. **🟡 2026-10-26: `admin_api/` built (default-deny routes, headers, IP allowlist, limiter, the service-key guard); `admin_web` ✅ (its own build and host config, an exact content-security policy, no inline script; looked at in a real browser)** | L |
| P1-4 | Ingest existing `subscription_events` and heartbeat data into the spine (view or job); idempotent. **✅ 2026-10-26: triggers as events happen plus a backfill function, idempotent by source reference** | M |
| P1-5 | Audit log viewer (filter by actor, tenant, type, time; export CSV). **🟡 API ✅ (`/api/audit`, `/api/audit.csv`, `/api/audit/verify`); the page ✅** | M |
| P1-6 | Port `/ops` read views into the new shell; retire `OPS_TOKEN` access once parity is proven (keep a documented break-glass). **🟡 API ✅ (`/api/fleet`, `/api/tenants/:id` on the shared rules); the page ✅ (the operator console's screens, now behind a login with a second factor); `OPS_TOKEN` is not retired until the page has run against a real project** | M |

**Acceptance tests:** (a) non-admin tenant owner calling any admin RPC is denied; (b) admin without `aal2` is denied; (c) `UPDATE`/`DELETE` on `tenant_events` fails for every role including service role; (d) tampering a row breaks the hash chain check; (e) `actor_id` null with `actor_type='admin'` is rejected.

### Phase 2 — Alerting and tenant timeline · 🟡 started 2026-10-27 (the engine is built; nothing sends yet)

| ID | Task | Size |
|---|---|---|
| P2-1 | Tenant detail page: unified timeline over the spine (subscription, heartbeat anomalies, alerts, admin actions, notes), with "as of" stamps. | L |
| P2-2 | Alert engine per §8 (rules, dedupe, state machine, escalation). **✅ 2026-10-27: `common/alertRules.js`, `common/alertEngine.js`, migration `024_alerts.sql`, `alert_worker/lib/` (`report_2026-10-27_120000_alert_engine.md`). Six of the nine §8 rules are built; webhook failures, service/worker down, login anomaly and migration drift need data that does not exist yet. On PGlite and stand-ins; no entry point, nothing sends.** | L |
| P2-3 | Push channel adapter + acknowledgement links (§8). **🚧 next. Needs a decision first: a one-tap link has no room for the 10-character reason I4 asks for (`docs/SUPER_ADMIN.md` §9).** | M |
| P2-4 | Alerts inbox UI. **✅ 2026-10-27: `GET /api/alerts`, `POST /api/alerts/:id/ack` and `/resolve`, the page's Alerts place (`report_2026-10-27_160000_alerts_inbox.md`). Reason of 10+ characters at every layer (I4); looked at in a real browser. Not run against a hosted project.** | M |
| P2-5 | Watcher-of-the-watcher: the alert worker itself emits a heartbeat to an external uptime monitor. | S |

### Phase 3 — Safe cloud writes · 🚧

| ID | Task | Size |
|---|---|---|
| P3-1 | RPCs + UI: extend trial, set `plan_status` (with reason), grant/revoke comp plan with mandatory expiry, add note. | L |
| P3-2 | Expiry job for comp plans and the webhook-race test (§5). | M |
| P3-3 | Write-dialog pattern (§7): shows "effect: applied at hub's next plan pull (≤15 min)", reason field, type-the-restaurant-name for suspend. | M |

### Phase 4 — Hub commands with acknowledgement · 🚧

| ID | Task | Size |
|---|---|---|
| P4-1 | Migration `admin_commands` + RPCs. Extend the heartbeat response to carry pending commands; add ack call. | M |
| P4-2 | Hub-side executor with a **hub-local allowlist** (default-deny, pinned by test): `force_resync`, `request_diagnostics`. Anything else is rejected and acked as `failed`. | L |
| P4-3 | Diagnostics bundle: version, uptime, queue depth, shelved-order count, sync status, config flags, last N redacted log lines (use existing redaction). No bills, guests, PINs, secrets (I9). Stored privately; link expires. | M |
| P4-4 | Command center UI with state timeline and honest "hub silent since …, command cannot be delivered" banner. | M |
| P4-5 | `rotate_pairing_code`: **optional, 🔬**. Impact is that every handset re-enrols. Build only after human sign-off; warn if inside service hours. | M |

### Phase 5 — Billing ops · 🚧 (partly ❌ on G0-2)

| ID | Task | Size |
|---|---|---|
| P5-1 | Metrics from `subscriptions` + `subscription_events`: MRR, active/trial/past-due/suspended counts, churn, trial→paid conversion. Define each metric in the doc; show the formula. | M |
| P5-2 | Dunning queue: tenants in `past_due` with days-in-grace, last payment event, next action. | M |
| P5-3 | Internal signed route in the operator service for admin-initiated subscription actions. `admin_api` never calls Razorpay itself. | M |
| P5-4 | **Kullina's own GST invoicing to restaurants** — 🚧 gated on a CA's answer (D5): entity GSTIN, SAC code, rate, place of supply, e-invoicing applicability, invoice-number series. Do not guess any of these. | L |

### Phase 6 — Onboarding · 🚧

| ID | Task | Size |
|---|---|---|
| P6-1 | Provisioning screen replacing signup-by-script (calls the existing provisioning path in the operator service). | M |
| P6-2 | Go-live checklist per tenant: hub installed, pairing done, menu imported, printers mapped (kitchen vs bar KOT routing verified), GST config verified, test bill, staff invited, owner trained. | M |
| P6-3 | Per-tenant KOT-routing diagnostic (surface mapped stations/printers from hub-reported counts; wrong-kitchen mapping is a known failure mode). | M |
| P6-4 | `referred_by` field and a simple partner report (no commissions engine until a first partner signs). | S |

### Phase 7 — Compliance desk · 🚧

| ID | Task | Size |
|---|---|---|
| P7-1 | Guest-data request log (erasure/access, DPDP-style) with per-tenant workflow; **execution is by the tenant/hub**, the console tracks status only. Legal basis and scope: human + counsel. | M |
| P7-2 | Legal/authority request register (date, authority, scope, who handled, outcome). Records only; handling procedure is human-defined. | S |
| P7-3 | Quarterly access review screen (who has admin access, last login, MFA state). | S |
| P7-4 | Backup/restore status per environment (reads only what exists; flag unknowns). | S |

---

## 7. Screens (design system: **Cabinet Grotesk + Instrument Sans**, icons from the repo's existing **`lucide-react`** (^0.475), tokens from `design-system/css/tokens.css`, Kullina light theme)

> **Decided 2026-10-25, reconfirmed 2026-10-26 (Aman):** keep the product's own fonts and the `lucide-react` library already in the repo. This replaces the earlier "Fraunces + DM Sans, Lucide v0.263.1" wording; do not add either.

1. **Sign-in + TOTP**
2. **Fleet** (port of `/ops`): counts, attention list, filterable table; "as of" on everything.
3. **Tenant detail:** header (plan, plan_status, hub last seen, version), timeline, notes, actions, commands, onboarding.
4. **Alerts inbox:** open/acked, severity, age, ack/resolve with reason.
5. **Command center** (per tenant and global).
6. **Billing ops:** metrics, dunning queue, subscription events.
7. **Onboarding board:** tenants × checklist.
8. **Audit log** and **Admin users** (read-only list, MFA state).
9. **Compliance desk.**

**Write-dialog contract:** reason textarea (required), plain statement of *when and how* it takes effect, what the hub will do, and what it will **not** do (never blocks orders/billing). Destructive-ish actions (suspend, revoke) require typing the restaurant name. On success show the event id and a link to the timeline entry.

**UI tests:** Vitest + Testing Library against a fake API. Add one real-browser smoke test (login screen renders styled) because a past split dropped the stylesheet import with every test green.

---

## 8. Alerting spec

**Rules** (reuse the ten existing `/ops` rules and their constants; add the following).

| Rule | Condition | Severity |
|---|---|---|
| `hub_silent_service` | ≥3 missed heartbeats (≥15 min) during the tenant's service hours | P1 |
| `hub_silent_long` | existing 36 h / 1 week rules | P2 |
| `orders_shelved` | shelved orders > 0 | P1 |
| `sync_backlog` | existing threshold | P2 |
| `payment_past_due` | `plan_status = past_due` | P2 |
| `webhook_signature_failures` | spike in Razorpay signature failures | P1 |
| `operator_service_down` / `alert_worker_stale` | self and external checks | P1 |
| `admin_login_anomaly` | repeated failed admin sign-ins | P1 |
| `migration_drift` | hosted schema behind repo | P2 |

**Quiet hours:** a P2 never pages overnight; P1 `hub_silent_service` only fires inside the tenant's `service_hours` (default if unset: flag the tenant as "service hours missing" instead of guessing).

**State machine:** `open → acked → resolved`; dedupe by `dedupe_key`; auto-resolve when the condition clears (write an event).

**Escalation (default, HUMAN may change in D4):** notify both founders at once; if unacked after 10 minutes, re-notify with higher urgency and repeat every 10 minutes up to 3 times, then flag in the console.

**Channel (decision D3, HUMAN):** build an adapter interface with a Telegram or ntfy implementation first **[INFERRED: no approval needed, free]**; WhatsApp Business and SMS in India need provider approval/registration, so treat them as later adapters. Alerts must include restaurant name, rule, since-when, and a signed one-tap acknowledge link. **Never** put secrets or guest data in an alert.

**Honest limit to document:** detection of a dead hub is no faster than 3 × 5 minutes while heartbeats are 5 minutes apart.

---

## 9. Hub command protocol

1. Admin RPC creates `admin_commands` row (`requested`) + event.
2. Hub heartbeat response includes non-expired commands for that restaurant → status `delivered`.
3. Hub executes **only** allowlisted types, idempotent by command id, then posts an ack with `result` → `acked` or `failed`.
4. Unacked past `expires_at` → `expired` + event. Default expiry 1 h (diagnostics 24 h).
5. Delivery is at-least-once; the executor must tolerate duplicates.
6. The hub rejects unknown types and logs loudly; the rejection itself is acked as `failed`.
7. Test matrix: duplicate delivery, hub offline during expiry, malicious unknown type, command referencing another tenant, ack replay.

---

## 10. Quality gates (all must pass per PR)

- `npm test` and `npm run build` on Node 20/22 (existing CI).
- PGlite tests with a **role matrix** against every new table and RPC: `anon`, tenant staff, tenant owner, hub (`kitchen`) identity, admin without MFA, admin with MFA, service role.
- Default-deny pinned tests: list of open admin RPCs, list of allowed hub commands, I1 test.
- Mutation checks on: attribution constraint, reason requirement, append-only triggers, hash chain, `aal2` check, plan-override race, hub command allowlist, alert dedupe and escalation timing. Survivors must be closed or justified as equivalent in the report.
- Hermetic runs: tests must not touch `hub_server/data/`.
- Any figure shown in the UI has a test for its "as of" stamp and failure state (I8).

---

## 11. Documentation deliverables

- `docs/SUPER_ADMIN.md` (living): architecture, roles, runbooks (alert response, command usage, break-glass), metric definitions.
- Update `docs/OPERATOR_SERVICE.md` where the operator service gains the internal admin route.
- `ROADMAP.md` §4.9: replace "read-only console" bullets with per-phase status as work ships; keep "still open" lists honest.
- `CHANGELOG.md` Unreleased; one `Darshil_docs/reports/` entry per change.

---

## 12. Decision register

| ID | Decision | Default if unanswered | Who |
|---|---|---|---|
| D1 | Admin API uses a dedicated DB role + RPCs (not the service key) | Yes, per §4 | **Confirmed by Aman, 2026-10-26** |
| D2 | What may the hub report to the cloud (heartbeat fields, diagnostics)? | Counts, times, versions only (current policy) | **Confirmed by Aman, 2026-10-26** |
| D3 | Alert channel(s) | Telegram/ntfy adapter first | **Confirmed by Aman, 2026-10-26** (takes effect in Phase 2) |
| D4 | Who is paged, and escalation | Both founders; re-notify every 10 min | **Confirmed by Aman, 2026-10-26** (takes effect in Phase 2) |
| D5 | Kullina entity GST facts (GSTIN, SAC, rate, e-invoicing) | **No default. Phase 5-4 stays blocked** | HUMAN + CA |
| D6 | Is `rotate_pairing_code` worth building? | No (stays 🔬) | HUMAN |
| D7 | Subscription length (12 billing periods today) | Out of scope for the console | HUMAN |
| D8 | Positioning on tamper-evident ledger | Out of scope for the console | HUMAN |

---

## 13. Never build (without a new written decision)

- Anything that edits, deletes, voids or reissues a tenant's bills, invoices, cash-ups or guests (I1).
- Impersonation or "log in as tenant."
- Tenant revenue/sales dashboards or cross-tenant benchmarking.
- Bulk operations on tenant financial data.
- Shared admin accounts or static tokens as the long-term auth.
- Auto-suspension that blocks service (I7).
- A CRM, ticket inbox, or status page. Use Notion/Sheets, a support tool, and a hosted status page until a real pain appears.
- Fleet-wide hub release rollout (depends on the installer and auto-update, still ⬜ in the roadmap).

---

## 14. Verify before coding (answer in your first report)

> **Answered 2026-10-26** in `Darshil_docs/reports/report_2026-10-26_173000_admin_console_phase1_foundation.md`.

1. Actual table and view names introduced by migration `021`; heartbeat payload fields.
2. Where trial end and `plan_status` live; how `hub_server/lib/plans.js` reads them; what exactly the Razorpay webhook handler overwrites.
3. How `/ops` rules are defined (constants file) and whether they can be shared.
4. Whether any existing RPC or route could, even indirectly, modify bills (I1 audit).
5. How the hub authenticates to the cloud (`kitchen` identity) and where the heartbeat is sent from, to design command delivery.
6. The next free migration number and the migration test harness (PGlite) conventions.
7. Existing redaction helpers for logs (reuse for diagnostics).
8. Findings of G0-3 (GST) and G0-4 (ledger) as separate reports.

---

## 15. Definition of done (whole console)

Two named founders sign in with MFA; a dead hub at a pilot restaurant reaches both phones within ~15 minutes and can be acknowledged; every plan change, note and command is in an immutable, attributed, hash-chained timeline; no code path lets an admin alter a tenant's bills; every number shows how fresh it is; and every claim in the docs says whether it was proven against a real hosted project or only a stand-in.

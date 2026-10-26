# Super admin console, Phase 1 (foundation): the database spine and the admin API

**Date:** 2026-10-26T17:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 1 (P1-1, P1-2, P1-3 API side, P1-4, P1-5 API side, P1-6 API side)

---

## WHAT CHANGED

Decisions D1-D4 were confirmed by Aman on 2026-10-26 (dedicated database role; hubs report counts, times and versions only; Telegram or ntfy first; both founders paged). Phase 1 was then started, tests first.

**Built:**

- **Migration 023 `admin_spine`** (`database/migrations/023_admin_spine.sql`):
  - the dedicated role `kullina_admin` (cannot log in until a human gives it a password; holds no privilege on any table or view);
  - `admin_users`, the allowlist (at most two active, enforced by a trigger);
  - `tenant_events`, the append-only spine, one SHA-256 hash chain per restaurant and one for events that belong to none; the chain is written by a trigger whatever the caller supplies, and `tenant_events_verify()` checks it;
  - `spine_assert_admin()`: every admin function begins by checking that the token's claims name an *active* administrator and carry `aal2`;
  - eight `admin_*` functions (whoami, record sign-in, list events, verify chain, fleet, tenant, ops events, tenant subscriptions), the only thing `kullina_admin` may run;
  - `seed_admin_user` / `deactivate_admin_user` (owner only, from the SQL editor; both leave an event);
  - ingest (P1-4): triggers copy each subscription event, and each notable hub change (first report, new version, restart, orders shelved or freed), onto the spine as it happens, plus `spine_backfill_subscription_events()` for older ones.
- **`admin_api/`** (a new service, its own entry point):
  - `lib/jwt.js` and `lib/keys.js`: token verification with `node:crypto` (HS256, RS256, ES256; a public key can never act as a secret; JWKS cached and refetched safely);
  - `lib/config.js`: refuses to start without a safe configuration, including the invariant I2 guard (no service key in its environment; the database login must be `kullina_admin`);
  - `lib/security.js`, `lib/csv.js`, `lib/db.js`;
  - `lib/app.js`: eight routes, pinned by a test, and everything else absent.
- **`common/opsRules.js`**: the operator console's pure rules (the ten attention rules and their constants) moved here so the operator service and the admin API share one copy; `signup_server/lib/ops.js` re-exports it, so nothing that imported it changed.
- **`docs/SUPER_ADMIN.md`**: the living document the build sheet asks for.
- `package.json`: the `pg` driver and an `admin` script.

**Not built:** `admin_web` (sign-in, second-factor enrolment, the audit page, the fleet and tenant pages). Phase 1's acceptance, "two named founders sign in with MFA", is therefore **not met**. `OPS_TOKEN` is not retired.

## THE BUILD SHEET'S SECTION 14, ANSWERED

1. **Migration 021:** the table `hub_status` (one row per restaurant: `reported_at`, `started_at`, `version`, `queued`, `quarantined`, `last_synced_at`, `devices`, `waiters`, and `received_at` stamped by the database), and the views `ops_tenants` and `ops_events` (readable by the service role only). The heartbeat carries those eight things and nothing else.
2. **Trial end and plan status** live on `restaurants` (`trial_ends_at`, `plan_status`, `current_period_end`); the hub's `plans.js` derives the effective plan from `{plan, plan_status, trial_ends_at, current_period_end}`. The Razorpay webhook handler updates `restaurants.plan_status` always, `plan` only when the subscription is `active`, `current_period_end` when it has one, and then upserts the `subscriptions` row. **It does not know about overrides**: that is the plan-override race of Phase 3.
3. **The `/ops` rules** were pure functions with named constants in `signup_server/lib/ops.js`; they are now shared from `common/opsRules.js`.
4. **Could any existing path touch bills?** The operator service (the only holder of the service key) touches `subscriptions`, `subscription_events`, `restaurants` (plan and status), `booking_requests`, `booking_pages`, `staff_users` (a read, to authenticate), the two ops views, and calls `provision_restaurant`. It does not read or write invoices, orders or menus. The service role *could*, because it can do anything: which is why the admin API is not given it.
5. **How the hub authenticates:** it signs in to Supabase as its `kitchen` staff user, and its heartbeat is an upsert to `hub_status` every five minutes. **There is no response payload today**, so Phase 4's command delivery cannot "ride on the heartbeat response" as the sheet imagined: it will need a read of its own commands (a policy for the `kitchen` role, or a function) alongside the upsert.
6. **Next free migration:** 023 (022 is the bill history, `invoice_events`). The harness is `hub_server/test/helpers/cloudDb.mjs` (PGlite with Supabase's default privileges modelled), which applies every file in `database/` in order.
7. **Redaction helpers:** `redact()` in `hub_server/lib/log.js`, to be reused for Phase 4's diagnostics.
8. **G0-3 and G0-4:** `report_2026-10-26_133000_gst_audit.md` and `report_2026-10-26_134500_ledger_analysis.md` (the latter built as `invoice_events`, `report_2026-10-26_150000_invoice_events.md`).

## WHAT THE TESTS PROVE

Written first. 156 new tests in four files (the hub suite is now **2027 passing**, was 1871):

- `adminSpineSchema` (56, on a real Postgres engine): the Phase 1 acceptance criteria, (a) a tenant's owner, a hub or anyone off the allowlist is refused by every admin function even with MFA, (b) a founder without `aal2` is refused, (c) UPDATE, DELETE and TRUNCATE fail for every role including the owner and the service role, (d) editing, removing or re-hashing an event breaks the chain check at the right event, (e) an admin event with no actor is rejected; plus the role matrix (the dedicated role holds no table privilege and can run *exactly* the listed functions; no other role can run any of them), invariant I1 (a scan of every admin function's text for a tenant table), the hash recomputed independently in the test, ingest (idempotent, nothing Razorpay sent, a fault never fails the webhook or the heartbeat).
- `adminJwt` (28): forged, expired, wrong-audience and `alg: none` tokens; algorithm confusion; unknown key ids; the clock leeway to the second; a key set that is cached, refetched once for a new key id, and never replaced by a bad answer.
- `adminApiParts` (33): configuration, the service-key guard, address allowlist and ranges, the limiter, headers, CORS, CSV formula safety, the database wrapper and the connection pool.
- `adminApi` (39, over HTTP against the real migration): who gets in; the pinned route list and that every other path and method is absent; headers on every answer; the allowlist and forwarded addresses; sign-in recorded and attributed; the audit log's filters, paging, cap and CSV; the chain check reporting a tampered chain; the fleet ranked and carrying nothing a restaurant could be acted as; a failed read returning an error and no data.

**Mutation checking: 262 mutants** (96 of the migration, 166 of the API), each breaking one rule on purpose. At first 12 and 27 survived. Those were dealt with: 24 were gaps in the tests (closed), 3 were redundant lines (removed: the first branch of `spine_assert_admin`, an `alg` type check and an empty-token check in `jwt.js`), and **6 are equivalent, and left**: the backfill's `WHERE NOT EXISTS` (the copy dedupes anyway; it only saves work); the explicit `REVOKE ... FROM kullina_admin` on the tables (no default privilege grants that role anything, so it states intent); the length check before `timingSafeEqual` (which would throw and be caught to the same result); the algorithm filter in `jwkKeys` (the same filter is applied again in `fits`); the guard for an address that does not parse in `ipAllowed` (it falls through to `false`); and the bearer pattern allowing spaces in a token (such a token cannot verify).

## DECIDED ALONG THE WAY

- **Hash computed in the database**, not by a caller: the trigger replaces any chain number or hash supplied, so even a bug in the API cannot fork a chain.
- **Admin functions in `public`, prefixed `admin_`**, with a test that the `admin_` prefix is exactly the callable surface (so a helper cannot be named like one).
- **The API reads a token only from the `Authorization` header** and answers every bad token identically; the reason goes to the log.
- **The tenant cap is a config value** (`maxTenants`, default 1000) so the "truncated" flag can be tested without a thousand restaurants.
- **A third person cannot be seeded** while two founders are active; changing the founders is deactivate-then-seed, each with an event.
- Existing test `cloudSql.test.mjs` now lists `tenant_events` among the console-only tables (row-level security on, no policy), as it already did for the operator's.

## HONEST LIMITS

- **Nothing has run against a hosted Supabase project** (G0-1). The `pg` adapter (`poolTransaction`) is proven only against a fake pool; the real connection, the pooler's `user.projectref` login and TLS have never been exercised.
- **`admin_web` is not built**, so a founder cannot yet enrol a second factor or use the console in a browser.
- **Verifying a hash chain written by the database shows an edit, a removal from the middle, a reordering or an inserted event; not events cut off the end**, and a database administrator can drop the triggers. Keeping each chain's head somewhere else would close both; it is not built.
- **The ingest hooks swallow their errors by design**, so the spine can lack an event the hook missed; the backfill covers subscription events. Hub changes have no backfill: a missed change is simply not on the spine.
- Order in a chain is the order events were *recorded*, not when they happened.
- The sign-in record is written in its own transaction and is not an "admin write" under I4 (no reason is asked); real writes arrive in Phase 3.
- Invariant I6 (hub commands as requests) and the alerting spec are untouched: Phases 2-4.
- JWKS verification supports RSA and P-256 keys, which is what a Supabase project issues; other key types are refused.

## NOT DONE

`admin_web`; retiring `OPS_TOKEN`; anything in Phases 2-7; the anchor for each chain's head; running any of it on a hosted project.

Status: ✅ database spine, ingest and API built and proven on a real Postgres engine and stand-ins; 🟡 never run against a hosted project; ⬜ `admin_web`.

# Super Admin Console: how it works and how to run it

**Living document.** The plan of record is [SUPER_ADMIN_BUILD_SHEET.md](./SUPER_ADMIN_BUILD_SHEET.md); this file says what is built, how it fits together, and how to set it up. Every claim says whether it was proven against a real hosted project or only against a stand-in. **Nothing here has run against a hosted Supabase project** (gate G0-1): it is proven on a real Postgres engine (PGlite) and on stand-ins.

Status legend: ✅ built · 🟡 partial · 🚧 planned · ❌ blocked.

## 1. Where it stands (Phase 1, started 2026-10-26)

| Task | What | Status |
|---|---|---|
| P1-1 | `admin_users`, the event spine `tenant_events` with a hash chain per restaurant, append-only, privileges stated (migration 023) | ✅ on PGlite |
| P1-2 | Sign-in checks in the database: allowlist plus `aal2` in every admin function; `seed_admin_user` for the two founders; enrolling and answering a second factor in the page | ✅ on PGlite and stand-ins; the page's sign-in has never met a real Supabase Auth |
| P1-3 | `admin_api`: JWT verification, default-deny routes, security headers, optional IP allowlist, rate limit on wrong tries; `admin_web`: the page, its own build and host config | ✅ on stand-ins; the page also checked in a real browser (styled, no policy violations) |
| P1-4 | Ingest: subscription events and hub changes land on the spine as they happen; a backfill for older events | ✅ on PGlite |
| P1-5 | Audit log: the API (filter, page, CSV, chain check) and the page | ✅ |
| P1-6 | Port the `/ops` read views | 🟡 The page shows the same fleet and restaurant views, from the same rules and the same screens (`common/opsRules.js`, `src/ops/`), served by `admin_api`. **`OPS_TOKEN` is not retired**: it stays as the break-glass until the page has run against a real project |

Phase 1's acceptance, "two named founders sign in with MFA; every action is attributed", is **built but not yet proven**: everything it needs exists (the page enrols and answers a second factor, the API and the database each refuse a session without one, every sign-in is recorded), and every piece is tested, but none of it has met a hosted Supabase project, so no real founder has signed in.

## 2. The shape

```
Founder's browser ── Supabase Auth (password + TOTP) ──► JWT with aal2
        │
   admin_web   (static page; no secrets)                     ✅
        │  Authorization: Bearer <JWT>
   admin_api   (admin_api/; its own deploy and credentials)  ✅
        │  connects as the Postgres role `kullina_admin`, never the service key
        │  per request: BEGIN; SET LOCAL ROLE kullina_admin; set the caller's claims; call admin_* ; COMMIT
   Postgres ── admin_* functions ─► spine_assert_admin() ─► tenant_events (hash chain)
```

* **The service key never reaches `admin_api`** (invariant I2). It refuses to start if a variable named like a service key, or holding a service-role token, is in its environment, and it refuses a database login that is not `kullina_admin`.
* **`kullina_admin` holds no privilege on any table or view.** It can run exactly the `admin_*` functions (a test pins the list). So a compromised API could read what the console reads and nothing else: not a bill, a menu or an order (invariant I1; a test also checks that no admin function mentions those tables).
* **Two checks, on purpose.** The API verifies the token's signature, lifetime, audience and `aal2`; then the database checks again that the caller is an *active* administrator with `aal2`. Either would hold if the other had a bug.
* **Reads only, plus one write.** The only thing any route writes is the record that a founder signed in.

## 3. Setting it up (a human, once, in the Supabase SQL editor)

1. Run migrations `004`-`023` (gate G0-1). `023` creates the role `kullina_admin` with no ability to log in.
2. Give the two founders accounts in **Supabase Auth** (Dashboard → Authentication → Users), with TOTP multi-factor enabled for the project.
3. Put them on the allowlist, from the editor (it runs as the database's owner; nothing else can):
   ```sql
   select public.seed_admin_user('founder-one@example.com', 'Founder One');
   select public.seed_admin_user('founder-two@example.com', 'Founder Two');
   ```
   At most two administrators can be active at a time. To change who: `select public.deactivate_admin_user('someone@example.com', 'a reason of at least ten characters');` and then seed the new person. Both leave an event.
4. Give the dedicated role a password. **Never put it in the repository or in chat**:
   ```sql
   alter role kullina_admin login password '<a long random password>';
   ```
   Supabase's connection pooler writes the user as `kullina_admin.<project-ref>`; the API accepts that.
5. In Supabase Auth, make sure multi-factor (TOTP) is enabled for the project; the page enrols each founder's authenticator app the first time they sign in.
6. Deploy `admin_api/` somewhere that is **not** where the operator service runs, with:

   | Variable | Meaning |
   |---|---|
   | `ADMIN_DATABASE_URL` | `postgresql://kullina_admin:...@host:5432/postgres` (required) |
   | `ADMIN_JWT_SECRET` and/or `ADMIN_JWKS_URL` | how to check tokens: the project's JWT secret (32+ characters), or its published key set (`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`) |
   | `ADMIN_WEB_ORIGIN` | the one web origin allowed to call it, `https://admin.example.com` (required; no path, no `*`) |
   | `ADMIN_IP_ALLOWLIST` | optional, comma separated addresses or IPv4 ranges. Anything else is told nothing exists |
   | `ADMIN_TRUST_PROXY` | optional, how many proxies sit in front (0-3). Needed for the allowlist behind one |
   | `ADMIN_JWT_ISSUER` | optional, the exact `iss` to require |
   | `PORT` | default 4600 |

   `npm run admin` (that is `node admin_api/server.js`). It prints every problem it finds and exits rather than start with one.
7. Build and host the page (see "The page" above) with `VITE_ADMIN_API_URL` set to the API's address and `ADMIN_WEB_ORIGIN` on the API set to the page's.

### The page (`admin_web/`)

A static page with its own build and its own host (invariant I10). It reuses the product's design tokens and fonts (Cabinet Grotesk, Instrument Sans) and two screens of the operator console, so it looks like the same product.

**What a founder sees, in order:** sign in with an email and password; set up an authenticator app (first time: a QR code and a setup key) or enter a code; the API is asked who they are and whether they are an administrator (if not: "This account is not an administrator", and nothing else); the sign-in is recorded; and only then the console, with **Fleet** (every restaurant, ranked by the same ten rules, read again every minute) and **Audit log** (filter by restaurant, event type, source and dates; page back; export a CSV; check that the history has not been tampered with). One restaurant opens from the fleet. **There is no control on the page that changes anything.**

**What it keeps:** nothing. The session lives in the page's memory (no storage, no cookie, nothing in the address), so a refresh asks for the password and a code again. A password or a code is held only while it is being typed and is cleared after a failure.

**What it never does:** show a figure without when it was read (`as of 14:38`, with the day when it is not today); show an old answer as current (when a read fails it says so and marks what is still shown as older, and when the very first read fails it shows nothing); trust text from the API (everything is drawn as text); or go on after the session ends anywhere (it returns to sign-in and says so).

**Settings (build time, all public):** `VITE_ADMIN_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The build **refuses** to run if any is missing, if an address is not https (the API may be http on this machine), or if anything in the settings looks like a service key, by its name or by what the value says it is (invariant I2). It writes a content-security policy into the page that allows scripts, styles and fonts from the page's own host only, images from it and `data:` (for the QR code), and connections to exactly the two addresses above and nowhere else.

**Building and hosting:** `npm run build:admin` makes `admin_web/dist` (the page and the product's fonts, and nothing else of the product). `admin_web/vercel.json` is the host's side: a Vercel project with its root directory set to `admin_web` and "include source files outside the root directory" on, which adds the headers a page like this needs (no framing, no sniffing, no referrer, HSTS, a permissions policy, never cached). `npm run admin:web` runs it for development on :5174; `ADMIN_WEB_ORIGIN` on the API must be that origin.

**Tested** by 165 tests of the page (Vitest and Testing Library), 13 build-level tests that run the real production build and look at what comes out (it is styled; no inline script; the exact policy; the right fonts; no other page of the product; no service key), and a look at it in a real browser, because the unit tests run without CSS and cannot see styling. That look found a real fault in the product's design system, not in the page: a base reset for `button` sat outside Tailwind's `base` layer and so beat every Tailwind utility, which left the default `Button` (and the existing operator console's "Open console") unfilled. It is fixed at the source, in its own commit with its own test and report (`report_2026-10-26_190000_design_system_button_layer.md`); it changes default buttons across the product, which has been looked at on two pages only.

The settings are in `admin_web/.env.example`. **Mutation-checked:** 179 mutants of the page's code, the build config and the stylesheet, all caught after the survivors were closed.

## 4. The event spine

`tenant_events` is one append-only log. Each restaurant has its own hash chain, and events that belong to none (a founder signing in) have another.

* **Writing.** Only `record_tenant_event()`, which no role but the owner can run. A trigger numbers each event, links it to the one before and hashes it, **whatever the caller supplied**. Time is the database's clock, unless an ingest says when the thing really happened.
* **The hash** is SHA-256 over: `prev_hash | chain_key | chain_seq | occurred_at (UTC, microseconds) | source | type | actor_type | actor_id | request_id | source_ref | payload::text`. Anyone with a copy of the rows can recompute it.
* **Append only.** UPDATE, DELETE and TRUNCATE are refused for every role, the owner and the service role included. The one deletion allowed is the cascade from removing a restaurant, which is how a tenant is erased.
* **Attribution.** An event with `actor_type = 'admin'` must have an `actor_id` (a CHECK).
* **Checking it.** `GET /api/audit/verify` (or `tenant_events_verify(restaurant)` in SQL) walks a chain and reports where it first breaks: a missing event, a broken link, or a hash that does not match its contents.

What flows in today: the founders' sign-ins; additions and removals of founders; every subscription event the operator service logs (what happened, what it did to the plan, which subscription; **not** what Razorpay sent); and a hub's first report, a new version, a restart, and orders shelved or freed (counts, versions and times only). A queue that grows and shrinks is not an event.

**Both hooks swallow their own errors**, so a fault in the spine can never fail a webhook or a hub's heartbeat (invariant I7). The cost is that the spine can lack an event the hook missed; `spine_backfill_subscription_events()` brings in subscription events from before the spine and any a hook missed, and is safe to run again.

### Honest limits

* A chain the database writes shows an edit, a removal from the middle, a reordering or an inserted event. It does **not** show events cut off the **end**, and a database administrator can drop the triggers. Keeping each chain's head hash somewhere else is the answer to both, and is not built.
* Order in a chain is the order events were *recorded*, not when they happened: a backfilled event gets a later place but keeps its real time.
* The spine does not hold anything about a restaurant's money, menu, guests or orders, and no admin function reads them (invariant I1).

## 5. The API

Default-deny. These are all the routes there are (pinned by a test); any other path, or the wrong method on a listed path, is "not here".

| Route | What |
|---|---|
| `GET /healthz` | Liveness. No token, no database |
| `GET /api/me` | Who the token's owner is |
| `POST /api/session` | Records a sign-in. The only write |
| `GET /api/audit` | The audit log. Filters: `restaurant_id`, `type`, `source`, `actor_id`, `from`, `to`; paging: `before` (an event id), `limit` (1-500, default 100) |
| `GET /api/audit.csv` | The same, as a file (up to 500 rows). Cells a spreadsheet would run as formulas are neutralised |
| `GET /api/audit/verify` | Checks a hash chain (`restaurant_id`, or the global chain) |
| `GET /api/fleet` | Every restaurant, ranked by the same ten rules as the operator console (`common/opsRules.js`) |
| `GET /api/tenants/:id` | One restaurant: its state, subscriptions and events |

Behaviour worth knowing:

* A token is read **only** from the `Authorization` header. A bad token of any kind gets the same answer, so a guesser learns nothing; the log knows the reason.
* No second factor: `403 MFA_REQUIRED`. Valid token, not an administrator: `403 ADMIN_ONLY`. Ten wrong tries (bad tokens or refusals) from one address in 15 minutes: `429` until the window passes.
* Every answer carries the security headers (no caching, no framing, no scripts, no referrer) and an `X-Request-Id` (the caller's if it is short and plain, otherwise a fresh one; it ends up in the log).
* **Every figure says when it was read** (`generated_at`), and **a failed read is an error with no data** (`502 DATABASE`), never the last answer (invariant I8).
* Only `ADMIN_WEB_ORIGIN` may read an answer. No cookies are used.

## 6. Invariants and where each is pinned

| | Invariant | Pinned by |
|---|---|---|
| I1 | No admin path touches a tenant's bills, menu, orders, guests | The role holds no table privilege; the runnable-function list; a scan of every admin function's text; the route sweep that counts tenant rows |
| I2 | The service key never leaves the operator service | `loadConfig` refuses to start with one, by name or by what a value is; the connection must be `kullina_admin` |
| I3 | Every admin action is attributed | A CHECK on the spine |
| I4 | Every admin write needs a reason of 10+ characters and an event in the same transaction | Applies from Phase 3, when there are writes. Today: `deactivate_admin_user` needs a reason; sign-in writes its event in its own transaction |
| I5 | Events are append-only | Triggers and privileges, tested for every role |
| I6 | An action on a hub is a request until the hub acknowledges | Phase 4 |
| I7 | Never block a restaurant | The two ingest hooks cannot fail what they watch |
| I8 | No silent staleness | `generated_at` on every answer; a failed read returns no data |
| I9 | Counts and times only | The ingest keeps no Razorpay payload; the fleet carries no pairing code, secret hash, settings or payment link |
| I10 | Separate surface | `admin_api/` is its own entry point and refuses the service key |

## 7. Break-glass

The operator console (`/ops` on the operator service, behind `OPS_TOKEN`) still works and is **not** retired. If the admin console is down or locked out, that is the way to look at the fleet. Retiring it waits for the admin page to reach parity.

## 8. Not built yet

Everything in Phases 2-7 of the build sheet (alerting, tenant writes, hub commands, billing operations, onboarding, the compliance desk); running any of it on a hosted project.

## 9. Decisions recorded

Confirmed by Aman on 2026-10-26: **D1** the admin API uses a dedicated database role and functions, not the service key; **D2** hubs report counts, times and versions only; **D3** the first alert channel is Telegram or ntfy; **D4** both founders are paged (re-notified every 10 minutes). D3 and D4 take effect in Phase 2. **D5** (Kullina's own GST facts) is still open and blocks Phase 5 invoicing.

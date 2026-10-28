# Super Admin Console: how it works and how to run it

**Living document.** The plan of record is [SUPER_ADMIN_BUILD_SHEET.md](./SUPER_ADMIN_BUILD_SHEET.md); this file says what is built, how it fits together, and how to set it up. Every claim says whether it was proven against a real hosted project or only against a stand-in. **Nothing here has run against a hosted Supabase project** (gate G0-1): it is proven on a real Postgres engine (PGlite) and on stand-ins.

Status legend: ✅ built · 🟡 partial · 🚧 planned · ❌ blocked.

## 1. Where it stands (Phase 1 built 2026-10-26; Phase 2 started 2026-10-27)

| Task | What | Status |
|---|---|---|
| P1-1 | `admin_users`, the event spine `tenant_events` with a hash chain per restaurant, append-only, privileges stated (migration 023) | ✅ on PGlite |
| P1-2 | Sign-in checks in the database: allowlist plus `aal2` in every admin function; `seed_admin_user` for the two founders; enrolling and answering a second factor in the page | ✅ on PGlite and stand-ins; the page's sign-in has never met a real Supabase Auth |
| P1-3 | `admin_api`: JWT verification, default-deny routes, security headers, optional IP allowlist, rate limit on wrong tries; `admin_web`: the page, its own build and host config | ✅ on stand-ins; the page also checked in a real browser (styled, no policy violations) |
| P1-4 | Ingest: subscription events and hub changes land on the spine as they happen; a backfill for older events | ✅ on PGlite |
| P1-5 | Audit log: the API (filter, page, CSV, chain check) and the page | ✅ |
| P1-6 | Port the `/ops` read views | 🟡 The page shows the same fleet and restaurant views, from the same rules and the same screens (`common/opsRules.js`, `src/ops/`), served by `admin_api`. **`OPS_TOKEN` is not retired**: it stays as the break-glass until the page has run against a real project |

### Phase 2: alerting

| Task | What | Status |
|---|---|---|
| P2-1 | One restaurant's timeline: migration `025` (`admin_tenant_timeline`), `GET /api/tenants/:id/timeline`, the words (`common/eventWords.js`) and the page's Timeline under a restaurant | ✅ on PGlite and stand-ins, and looked at in a real browser (desktop, phone, dark). Never met a real Supabase project |
| P2-2 | The alert engine: the rules (`common/alertRules.js`), the lifecycle and escalation (`common/alertEngine.js`), the database (migration `024_alerts.sql`), and the worker's pass (`alert_worker/`) | ✅ on PGlite and stand-ins. **Nothing sends a message yet and there is no entry point to run the worker**; both arrive with P2-3 |
| P2-3 | A push channel (Telegram or ntfy) and the signed acknowledge link | 🚧 next |
| P2-4 | The alerts inbox: the API routes (`GET /api/alerts`, acknowledge, resolve) and the page's **Alerts** place | ✅ on PGlite and stand-ins, and looked at in a real browser (desktop, phone, dark). Never met a real Supabase project |
| P2-5 | A watcher for the watcher: the worker reports to an outside uptime monitor | 🚧 |

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
        ▲
   alert_worker (alert_worker/; its own deploy and credentials)   ✅ the pass; ⬜ entry point and channel (P2-3)
        connects as the Postgres role `kullina_alerts`: four functions, no table
        a pass: read the fleet ─► which conditions are true ─► open / resolve / flag alerts ─► page whoever is due
```

* **The service key never reaches `admin_api`** (invariant I2). It refuses to start if a variable named like a service key, or holding a service-role token, is in its environment, and it refuses a database login that is not `kullina_admin`.
* **`kullina_admin` holds no privilege on any table or view.** It can run exactly the `admin_*` functions (a test pins the list). So a compromised API could read what the console reads and nothing else: not a bill, a menu or an order (invariant I1; a test also checks that no admin function mentions those tables).
* **Two checks, on purpose.** The API verifies the token's signature, lifetime, audience and `aal2`; then the database checks again that the caller is an *active* administrator with `aal2`. Either would hold if the other had a bug.
* **Reads, plus three writes, and no write touches a restaurant.** A route writes only the record that a founder signed in, and an alert being acknowledged or resolved. Each of the last two needs a reason of at least ten characters in a person's words and leaves an event naming the person (invariants I3 and I4). The administrator is asked **before** the body of a write is read, so a tenant or a founder without a second factor is refused the same way whatever they send.

## 3. Setting it up (a human, once, in the Supabase SQL editor)

1. Run migrations `004`-`025` (gate G0-1). `023` creates the role `kullina_admin` and `024` the role `kullina_alerts`, neither with the ability to log in; `025` adds one read-only function for the timeline.
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
8. **For alerts (Phase 2):** tell the console when each restaurant is open, or it cannot tell a silent hub from a shut restaurant. From the editor, for each restaurant (time zone an IANA name; each day a list of `[open, close]`; a close before the open runs past midnight; a day left out is shut):
   ```sql
   select public.set_tenant_service_hours('<restaurant id>', 'Asia/Kolkata',
     '{"mon":[["11:00","15:00"],["18:00","23:30"]],"tue":[["11:00","23:30"]],"wed":[["11:00","23:30"]],"thu":[["11:00","23:30"]],"fri":[["11:00","23:30"]],"sat":[["11:00","23:59"]],"sun":[["11:00","23:30"]]}'::jsonb);
   ```
   It refuses hours it cannot read and a time zone the worker could not, and leaves an event. A restaurant with no readable hours is **flagged "service hours missing"** and is never paged about a silent hub (the rule does not guess).
9. Give the alert worker's role a password the same way (`alter role kullina_alerts login password '...';`, by hand, never in the repository). Its entry point and channel settings arrive with P2-3.

### The page (`admin_web/`)

A static page with its own build and its own host (invariant I10). It reuses the product's design tokens and fonts (Cabinet Grotesk, Instrument Sans) and two screens of the operator console, so it looks like the same product.

**What a founder sees, in order:** sign in with an email and password; set up an authenticator app (first time: a QR code and a setup key) or enter a code; the API is asked who they are and whether they are an administrator (if not: "This account is not an administrator", and nothing else); the sign-in is recorded; and only then the console, with **Fleet** (every restaurant, ranked by the same ten rules, read again every minute) and **Audit log** (filter by restaurant, event type, source and dates; page back; export a CSV; check that the history has not been tampered with). One restaurant opens from the fleet, or from an alert's restaurant name in the inbox, and shows its state and its **Timeline** (below). **Alerts** (what is waiting, what somebody has taken on, what is closed; each can be acknowledged or resolved with a reason). **The only controls on the page that change anything are those two actions on an alert: nothing about a restaurant, a plan or a person can be changed from it.**

**What it keeps:** nothing. The session lives in the page's memory (no storage, no cookie, nothing in the address), so a refresh asks for the password and a code again. A password or a code is held only while it is being typed and is cleared after a failure.

**What it never does:** show a figure without when it was read (`as of 14:38`, with the day when it is not today); show an old answer as current (when a read fails it says so and marks what is still shown as older, and when the very first read fails it shows nothing); trust text from the API (everything is drawn as text); or go on after the session ends anywhere (it returns to sign-in and says so).

**Settings (build time, all public):** `VITE_ADMIN_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The build **refuses** to run if any is missing, if an address is not https (the API may be http on this machine), or if anything in the settings looks like a service key, by its name or by what the value says it is (invariant I2). It writes a content-security policy into the page that allows scripts, styles and fonts from the page's own host only, images from it and `data:` (for the QR code), and connections to exactly the two addresses above and nowhere else.

**Building and hosting:** `npm run build:admin` makes `admin_web/dist` (the page and the product's fonts, and nothing else of the product). `admin_web/vercel.json` is the host's side: a Vercel project with its root directory set to `admin_web` and "include source files outside the root directory" on, which adds the headers a page like this needs (no framing, no sniffing, no referrer, HSTS, a permissions policy, never cached). `npm run admin:web` runs it for development on :5174; `ADMIN_WEB_ORIGIN` on the API must be that origin.

**Tested** by 286 tests of the page (Vitest and Testing Library), 13 build-level tests that run the real production build and look at what comes out (it is styled; no inline script; the exact policy; the right fonts; no other page of the product; no service key), and a look at it in a real browser, because the unit tests run without CSS and cannot see styling. That look found a real fault in the product's design system, not in the page: a base reset for `button` sat outside Tailwind's `base` layer and so beat every Tailwind utility, which left the default `Button` (and the existing operator console's "Open console") unfilled. It is fixed at the source, in its own commit with its own test and report (`report_2026-10-26_190000_design_system_button_layer.md`); it changes default buttons across the product, which was then looked at in a real browser on every screen that loads the stylesheet (see the same report: only the operator console's "Open console" and the station sound toggle change visibly).

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
| `POST /api/session` | Records a sign-in. One of the three writes |
| `GET /api/audit` | The audit log. Filters: `restaurant_id`, `type`, `source`, `actor_id`, `from`, `to`; paging: `before` (an event id), `limit` (1-500, default 100) |
| `GET /api/audit.csv` | The same, as a file (up to 500 rows). Cells a spreadsheet would run as formulas are neutralised |
| `GET /api/audit/verify` | Checks a hash chain (`restaurant_id`, or the global chain) |
| `GET /api/fleet` | Every restaurant, ranked by the same ten rules as the operator console (`common/opsRules.js`) |
| `GET /api/tenants/:id` | One restaurant: its state, subscriptions and events |
| `GET /api/tenants/:id/timeline` | One restaurant's history on the spine, newest first. `kind` (`billing`, `hub`, `alerts` or `admin`, filtered in the database), `before` (an event id), `limit` (1-500, default 50). Names the restaurant; a full page says where the next begins (`next_before`) |
| `GET /api/alerts` | The inbox: `state` (`active`, the default, is waiting plus taken on; or `open`, `acked`, `resolved`), `limit` (1-500, default 100). Ranked: what nobody answered after every reminder, then the worse, then the longest-waiting. Each alert says what is wrong in words, names its restaurant and carries a closed list of fields. `truncated` says when the list was cut |
| `POST /api/alerts/:id/ack` | Acknowledge ("I know": stops the paging). Body `{ "reason": "..." }`, 10 to 500 characters after trimming. A second acknowledgement changes nothing and says so |
| `POST /api/alerts/:id/resolve` | Resolve ("it is dealt with"). Same body. `409` if it is already resolved, `404` if there is no such alert |

Behaviour worth knowing:

* A token is read **only** from the `Authorization` header. A bad token of any kind gets the same answer, so a guesser learns nothing; the log knows the reason.
* No second factor: `403 MFA_REQUIRED`. Valid token, not an administrator: `403 ADMIN_ONLY`. Ten wrong tries (bad tokens or refusals) from one address in 15 minutes: `429` until the window passes.
* Every answer carries the security headers (no caching, no framing, no scripts, no referrer) and an `X-Request-Id` (the caller's if it is short and plain, otherwise a fresh one; it ends up in the log).
* **Every figure says when it was read** (`generated_at`), and **a failed read is an error with no data** (`502 DATABASE`), never the last answer (invariant I8).
* Only `ADMIN_WEB_ORIGIN` may read an answer. No cookies are used.

## 5a. Alerts (Phase 2)

An alert is a condition that is true now, kept as one row that moves **open → acknowledged → resolved**. The worker looks every minute or so (the interval is set when the entry point arrives), and every change leaves an event on the restaurant's own chain.

**The rules built** (all in `common/alertRules.js`, reusing the operator console's own thresholds, so a hub the console calls "live" is never one an alert calls silent):

| Rule | True when | Severity |
|---|---|---|
| `hub_silent_service` | the hub has said nothing for **more than 15 minutes** while the restaurant is open (counted from the restaurant's opening if the hub last spoke before it, so a hub switched on at opening time is not "silent") | P1 |
| `orders_shelved` | one or more orders are shelved (taken but not accepted by the cloud), whatever the plan | P1 |
| `hub_silent_long` | no word for more than 36 hours, any hour | P2 |
| `sync_backlog` | 50 or more bills waiting to reach the cloud | P2 |
| `payment_past_due` | the plan status is `past_due` | P2 |
| `service_hours_missing` | the restaurant's hub reports but its hours are not set or not readable | P3: shown, never sent |

A cancelled restaurant's hub is meant to be off, so only `orders_shelved` and `payment_past_due` apply to it. The build sheet says "3 missed reports (≥15 min)"; this reads it as "**more than** 15", the same line the console already draws between "live" and "quiet", so the two never disagree. **Not built, because the data does not exist yet:** webhook signature failures, the operator service or the worker being down, repeated failed admin sign-ins, and the hosted schema being behind the repository. The console's other attention items (trial ending, cancel requested, clock skew, never seen) stay on the screen and are not paged.

**Who is paged and when (decisions D3 and D4):** both founders at once. If nobody has acknowledged it ten minutes after the last page, a reminder at higher urgency, every ten minutes, **three** times; ten minutes after the third it is flagged **unattended** in the console. An acknowledged alert is never paged again. A **P2 never pages between 22:00 and 08:00 India time** (the founders' clock, not the restaurant's): it waits, visible in the console, and goes out when they wake as a first page. A P1 pages at any hour. A page carries the restaurant's name, the rule in words, and how long, never a secret or a guest (invariant I9): only the fields a rule names are used.

**What can go wrong, said plainly**
* **Paging is at-least-once.** A page that went out but could not be recorded is sent again on the next pass: better twice than never.
* A page that could not be sent is recorded as failed (at most once in ten minutes per alert, and only the *kind* of failure, never the channel's message, which can carry a token), is not marked sent, and is tried again on the next pass.
* **A pass that cannot see the whole fleet resolves nothing**, and one that cannot read the database does nothing, so a truncated or failed read is never mistaken for a healthy fleet.
* **Resolving by hand an alert whose condition is still true opens a fresh one on the next pass.** Acknowledge is the way to say "I know".
* Detection of a dead hub is no faster than the 15 minutes plus the worker's interval.
* The alert's details are as they were when it opened (a count that has grown since is on the restaurant's page, not the alert).
* **Never run on a hosted project**, with no channel to send through yet.

### The inbox (P2-4)

The console's **Alerts** place lists what is waiting, what somebody has taken on, and (by a filter) what is closed, read again every minute and on Refresh, with "as of" on it and the same rule as everywhere else: a read that fails never leaves the old list looking current. Each alert names its restaurant, says what is wrong in words, says when it opened, how far the paging has got ("Not paged yet", "Paged 12 min ago", "reminder 2 of 3", or for a P3 that it is shown here only), and whether nobody answered after every reminder. A form opens under the alert for either action: it says in plain words what the action does and does not do, wants a reason (at least ten characters, counted in characters not bytes; the box takes focus), sends **one** request however many times the button is tapped, keeps what was typed when it is refused, and says so if the alert changed meanwhile (already resolved: the list is read again). Everything the API sends is drawn as text.

**Runbook (alert response):** an alert is paged → open the console → **Alerts** → acknowledge it with a reason of at least ten characters (that stops the paging and records who) → look at the restaurant → when it is dealt with the alert resolves by itself once the condition clears. Use **Resolve** only when it is truly done: resolving an alert whose problem is still there opens a fresh one within a minute or so. If the page said the hub is silent and the restaurant is open, ring them first.

### The timeline (P2-1)

A restaurant's page ends with its **Timeline**: what happened to it, in words, newest first, grouped by day (Today, Yesterday, then the date with its year, in the viewer's time zone). It is the spine's history of that one restaurant, the same events the audit log lists, said for a person: "Subscription halted: the payment could not be collected", "The hub was updated (From 1.4.2 to 1.5.0)", "Alert acknowledged by someone@example.com (orders shelved): “ringing the owner now”". Each event has its time and a chip for its kind, and its raw details in an expander for an administrator.

* **Kinds**, filtered in the database (migration 025) so that a filtered page is a page of that kind and paging stays in it: *Billing* (Razorpay's events), *Hub* (first report, a new version, a restart, shelved orders changing), *Alerts* (everything `alert.*`, even an alert a person acknowledged), *Admin actions* (`admin.*`, such as service hours being set). They do not overlap, and a test pins that the database's kinds and the words' kinds agree on real events.
* **Going back in time** with "Show older events": no event twice, none lost; the kind is kept. A read that comes by itself (every minute, or Refresh) puts what is new above what is shown and keeps what was paged back to, unless more than a page happened meanwhile, in which case the list starts again from the newest page rather than show a gap as if there were none.
* **What is not on it:** heartbeats (only changes worth knowing), restaurant data of any kind (invariant I1), and notes (Phase 3). A type of event it has no words for is shown as `Event “type”`: it says what it is rather than guessing.

## 6. Invariants and where each is pinned

| | Invariant | Pinned by |
|---|---|---|
| I1 | No admin path touches a tenant's bills, menu, orders, guests | The role holds no table privilege; the runnable-function list; a scan of every admin function's text; the route sweep that counts tenant rows |
| I2 | The service key never leaves the operator service | `loadConfig` refuses to start with one, by name or by what a value is; the connection must be `kullina_admin` |
| I3 | Every admin action is attributed | A CHECK on the spine |
| I4 | Every admin write needs a reason of 10+ characters and an event in the same transaction | `admin_ack_alert` and `admin_resolve_alert` refuse a reason under 10 characters (after trimming) and write their event in the same transaction, the API says so in words before it asks the database, and the page will not send fewer; `deactivate_admin_user` the same; the worker's own writes are the system's and say so. Sign-in writes its event in its own transaction |
| I5 | Events are append-only | Triggers and privileges, tested for every role |
| I6 | An action on a hub is a request until the hub acknowledges | Phase 4 |
| I7 | Never block a restaurant | The two ingest hooks cannot fail what they watch |
| I8 | No silent staleness | `generated_at` on every answer; a failed read returns no data |
| I9 | Counts and times only | The ingest keeps no Razorpay payload; the fleet carries no pairing code, secret hash, settings or payment link; the worker reads six columns of the fleet and sends a page made of a closed list of fields (tested with a phone number and a token planted in the row) |
| I10 | Separate surface | `admin_api/` is its own entry point and refuses the service key; `alert_worker/` connects as its own role and never holds one |

## 7. Break-glass

The operator console (`/ops` on the operator service, behind `OPS_TOKEN`) still works and is **not** retired. If the admin console is down or locked out, that is the way to look at the fleet. Retiring it waits for the admin page to reach parity.

## 8. Not built yet

From Phase 2: a channel to page through and the worker's entry point (P2-3), the watcher for the watcher (P2-5). Phases 3-7 of the build sheet (tenant writes, hub commands, billing operations, onboarding, the compliance desk). Running any of it on a hosted project.

## 9. Decisions recorded

Confirmed by Aman on 2026-10-26: **D1** the admin API uses a dedicated database role and functions, not the service key; **D2** hubs report counts, times and versions only; **D3** the first alert channel is Telegram or ntfy; **D4** both founders are paged (re-notified every 10 minutes). D3 and D4 take effect in Phase 2. **D5** (Kullina's own GST facts) is still open and blocks Phase 5 invoicing.

**Made while building P2-2, for Aman to confirm or change:** (1) the alert worker connects as its own database role, `kullina_alerts`, on the same reasoning as D1 (no table privilege, four functions), rather than reusing `kullina_admin` or the service key; (2) quiet hours are 22:00 to 08:00 on the **founders'** clock (India), not each restaurant's; (3) "three missed reports" is read as more than 15 minutes, matching the console. **Open question for P2-3:** the build sheet asks for a "signed one-tap acknowledge link", and invariant I4 asks for a reason of at least ten characters on every admin write. A one-tap link cannot ask for a reason. The simplest honest answer is that the link supplies a fixed, visible reason ("Acknowledged from the alert link") attributed to the founder the signed link names; that satisfies the letter of I4 but not its spirit, so it needs a decision.

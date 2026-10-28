# The operator console: every restaurant at once, read-only

**Date:** 2026-10-24T02:45:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.9 Deployment & fleet: "Remote fleet view: which tenants' hubs are online / behind on sync", and the question that prompted it ("where is the super admin panel?")

---

## WHAT WAS MISSING

There was no single place to look. The person running Kullina had three surfaces, and none of them was the one asked about: the reception
console (`/admin`, one restaurant, on its own laptop), the owner view (`owner.html`, one restaurant, for its owner) and the operator service
(an API with no screen). Which restaurants had not paid, whose trial was about to end, whose laptop had been off for three days: each answer
was a different table, the Supabase dashboard, or a phone call. And the cloud had no way to know a hub was alive at all: its only sign of life
was a bill arriving, which on a quiet day is no sign.

Asked for as "read only first". This is that: it can look at everything and change nothing.

## THE SHAPE OF IT, AND WHY

```
a restaurant's hub  ──every 5 min──▶  cloud (hub_status)  ◀──reads── operator service ◀── /ops (the operator's browser)
  counts and times only               stamped by the database       the service key         one token, kept in memory
```

- **A hub now says it is alive** (`hub_status`, one row per restaurant, written with the hub's own login): its version, since when it has run, how many
  bills are waiting and how many orders were shelved, when it last got something through, and how many handsets and waiters it has. Counts and times
  only: never a name, a token, a PIN, a bill or a guest. The **database** stamps when it heard, whatever the hub claims, and the hub's own clock is kept
  beside it, because the gap between the two is how a laptop with the wrong time is found. What the hub does not know is said as nothing, never as zero.
- **Two views span every restaurant** (`ops_tenants`, `ops_events`), so *who may read them* is the whole point: the service role alone. Not `anon`, not a
  restaurant's own login, not its owner; and the service role itself has no privilege to write to them. They leave out the pairing code, the hash of a hub's
  provisioning secret, the restaurant's settings, a subscription's payment link and the payload Razorpay sent (which carries a customer's details).
- **The operator service serves the console and its API** (`GET /ops`, `GET /ops/api/fleet`, `GET /ops/api/tenants/:id`), behind **its own token**
  (`OPS_TOKEN`), not the one that creates restaurants, so that looking can be given to someone without giving them the power to provision. Unset, shorter
  than 20 characters, or the same string as `SIGNUP_OPERATOR_TOKEN`, and the console is **off** (the page is not there, the API refuses everyone, `/health` says
  so, and the log says why without saying the token). Ten wrong tries from one address in fifteen minutes turn that address away, even if its next try is right; a
  right token never counts against it. It writes nothing: there is no route that writes, and no other method is answered.
- **What the page does.** It asks for the token and keeps it **in memory only** (not in storage, a cookie or an address; a refresh asks again). It shows
  counts (restaurants, active, on trial, overdue or suspended, hubs live, needing attention), **a list of who to look at and why**, every restaurant in a table with
  a search and five filters, the latest subscription events across all of them, and for one restaurant its billing, its hub, its week's bills, its subscriptions and
  its events. It reads again every minute and says how old what it shows is; a read that fails keeps what is on the screen and says so.
- **What counts as "look at this"** is ten rules, each a named constant pinned to the millisecond on both sides in the tests: payment overdue (high), suspended (high),
  trial ended with nobody subscribed (high), trial ending within 3 days (medium), asked to cancel (medium), hub never reported after a day (medium), hub silent for 36
  hours (medium; **high after a week**), orders shelved (high), 50 or more bills waiting (medium), and a hub clock more than 5 minutes out (medium). A restaurant that has
  cancelled asks for nothing, except that shelved orders are always flagged: they are takings that never reached the cloud, whoever they belong to.

## WHAT CHANGED

**Cloud**: migration `021_ops_console.sql`: `hub_status` (with a trigger that stamps `received_at`), the views `ops_tenants` and `ops_events`, and their privileges.
A bill counts by when it was *issued*, which the existing index is on, so the newest bill is an index lookup and the week's count a range scan however many bills a restaurant
has issued.

**Hub**: `lib/heartbeat.js` (the report, sending it, the runner that does it one at a time and never throws, and the collector); a `heartbeat` field on `/sync-status`;
timers (`HUB_HEARTBEAT_MS`, `HUB_HEARTBEAT_FIRST_MS`).

**Operator service**: `lib/ops.js` (the rules and the shaping: pure functions of a row and a moment), `lib/opsRoutes.js` (the token check, the lockout, the routes and the page),
wired in `server.js`; `createLimiter` gained `count` (so that someone can be turned away before they are let to try again); the built `/fonts` are served too (the product's stylesheet
names them, and the console is drawn with it).

**Screens**: `ops.html`, `src/ops_main.jsx` and `src/ops/` (`OpsApp`, `SignIn`, `FleetView`, `TenantView`, `parts`, `lib/api.js`, `lib/format.js`), a build input, a dev proxy.

**Docs**: `docs/OPERATOR_SERVICE.md` (the console, `OPS_TOKEN`, the rules as a table, what it never shows), ROADMAP §4.9, M3, CHANGELOG.

## TESTS

Written first: each file was run and seen failing (the table, the module or the component it tests did not exist) before the code was written. In all, **103 tests on the hub and
operator side** (against stand-ins and the real schema), **110 on the screens**, plus one in the cloud contract and one on the limiter.

| File | Tests | What it pins |
| --- | --- | --- |
| `opsSchema.test.mjs` | 15 | on the **real schema** (PGlite): the hub writes its own report and no one else's (by upsert and by plain insert); the database stamps when it heard, on a first report and on later ones; counts cannot be negative or missing; an owner reads and writes nothing; `anon` nothing; the stamping function is nobody's to call; **only the service role reads the two views**, and it cannot write to them; one row per restaurant; the newest subscription, the week's bills, never another restaurant's; no pairing code, secret, setting, payment link or payload; the migration runs twice |
| `heartbeat.test.mjs` | 21 | the report (eight things and no others; unknown is nothing, not zero; a bare number is not a time), sending it, the runner (one at a time, a failure is a failure, the last good time is kept, it never throws), the collector, and on a real hub: `/sync-status` and the timers |
| `heartbeatRoundTrip.test.mjs` | 5 | the same on the real schema, as the hub's own identity, and what the operator then sees |
| `opsLib.test.mjs` | 24 | the ten rules, each to the millisecond on both sides; the shaping; counting; ordering; what is passed on and what is not |
| `opsRoutes.test.mjs` | 33 | off unless set (unset, too short, the same as the signup token); only the console's token; ten wrong tries and the lockout; never logged; the fleet, the cap and which restaurants are cut; one restaurant needs all three of its parts; read-only; the page and its headers; what columns are asked for |
| `opsRoundTrip.test.mjs` | 5 | the routes over the real views as the service role |
| `format.test.js` / `api.test.js` | 28 / 14 | how the console says things; what it asks and what it makes of each way an answer fails |
| `OpsApp.test.jsx` | 68 | signing in, the fleet, finding a restaurant, one restaurant, staying current, and "it only reads" (no form, no field but a search, no button that writes) |

## MUTATION CHECKS

About **540 mutants** over the migration, the hub, the operator rules and routes, and the screens.

| Layer | Mutants | First pass | What happened |
| --- | --- | --- | --- |
| Migration 021 | 65 | 50 caught | 3 real gaps closed (the first report was not tested for being stamped; a plain insert for another restaurant; one restaurant's subscription shown on another); **12 equivalent and kept**: the explicit `REVOKE`s (migration 014 already resets the defaults), policy conditions the tenant-read policy also enforces, a default the trigger overrides, an aggregate join that always has a row, a column in a sub-select that is never exposed, a boundary that cannot be hit |
| Hub heartbeat and wiring | 63 | 56 caught | 2 real gaps closed (a bare number taken for a time; the first report's default delay), 1 redundant clause removed; **4 kept**: `n > 0` / `n >= 0` (the same), the default interval (a test would have to wait five seconds), and two lines of wiring in the composition root |
| Operator rules (`ops.js`) | 100 | 76 caught | 24 survivors, all closed: several were **tests that quoted the constant they were testing** (true of any constant), now literal numbers; the rest were boundaries (exactly two hours, a skew counted down, an unknown sign-up time, a blank count, timestamps in the database's own format) and a dead `Date` branch, removed |
| Operator routes, wiring, limiter, fonts | 89 | 75 caught | 14 survivors, all closed: the shape of an id and of a bearer header, which restaurants are left out when the list is cut, each of the three parts of a restaurant's page, the log lines for each way the console can be off, the environment variable it reads, and that the payment link is never even asked for |
| Screens | 210 | about 160 caught | about 50 survivors, all closed or shown equivalent: colours (now a `data-tone` the tests can read), a timer left running after sign-out, a double submit, a trimmed token, the billing rows that belong to a trial and those that belong to a period, a phone link, stale and late answers, the one-read-at-a-time guard; **3 kept**: `diff <= 0` (the case never gets there), `restaurant_id` against `restaurant_name` on an event (one is null exactly when the other is) and a dependency that cannot change without the screen being replaced |

Two of my own tools misled me and were fixed: a stand-in whose default parameter turned an explicit "no token" back into the real token (the "off" tests passed for the wrong reason until they failed), and a mutation run that, being serial, would have taken two hours; it was stopped safely, the file it left mutated was put back, and the rest ran on separate copies.

## WHAT THE WORK FOUND

- `Number(true)` is 1 and `Date.parse('5')` is a day in 2001: a hub's report and the operator's rules each would have believed a boolean or a bare number. Both now say "not known".
- "Renews in 2 weeks" for a renewal 20 days away was useless; the day/week switch moved from 14 to 45 days.
- Reading the product's stylesheet before opening the page showed it names its fonts under `/fonts`, which the service did not serve: the console would have loaded in a fallback font. Served now (with a test).
- In the real browser an event the service ignores (`subscription.updated`) was shown as its raw name; it now has a plain label.
- A read slower than the polling interval would have stacked reads on a slow line; reads are now one at a time.
- Tests that quote the constant under test (the caps, the lockout, the token length) cannot fail. They now say the numbers.
- A refusal to write to a view that joins tables comes back as "cannot be written" (55000), not "permission denied": a test's assumption, corrected.
- The earlier two failures seen in the full frontend run (a kitchen live-feed test and an owner-view test) were load: four mutation runs were using the machine; both pass in the quiet final run.

## CHECKED IN A REAL BROWSER

The real operator service code over an in-memory cloud holding fourteen restaurants in every kind of trouble (one named `<script>alert("not run")</script> Test`, in a city
`<b>Pune</b>`): a wrong token was refused in words and then the right one opened the console; the counts, the nine reasons to look, the table, the events and the filters were as expected;
a restaurant opened to its billing, hub, subscriptions and events; **Hub silent** and a search narrowed the table; signing out left no data, no storage, no cookie and no change to the address.
The browser console had no errors but the deliberate 401; the product's fonts loaded; at 375 pixels nothing outside the table overflowed the page (the table scrolls inside itself).
It was drawn in dark mode, following the system. The hostile restaurant name was text.

## NOT DONE

- **It cannot do anything.** No suspending, no extending a trial, no changing a plan, no message to a restaurant: those are writes, and the instruction was read-only first. Each would
  need its own route, its own confirmation and an audit trail, none of which exists.
- **One token and no names.** Nothing says who looked, and a token that leaks has to be changed on the server. There is no per-person login.
- **No alerting.** It tells you when you look. Nothing rings you when a restaurant goes quiet.
- **At most 1,000 restaurants** in one answer (and it says so). More needs paging.
- **It shows what hubs report and the bills that reached the cloud, not revenue.** A restaurant's money is its own.
- **The owner view's "last synced" still comes from the latest bill.** It could now use `hub_status`; it does not.
- **Nothing has run against a hosted Supabase project or a public address**, and migration 021 has not run on one. Behind a proxy `TRUST_PROXY` must be set, or every caller is one address and the lockout turns away everyone together.
- **On a phone the table scrolls sideways** instead of becoming cards.
- The hub's default timings (the first report at 15 seconds, then every 5 minutes) are not exercised by a test; the timers are tested through the environment variables that change them.

Status: ✅ VERIFIED against stand-ins, the real schema and a real browser; ⚠ unrun on a hosted Supabase project or a public address.

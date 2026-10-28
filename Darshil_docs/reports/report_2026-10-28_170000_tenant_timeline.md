# Super admin console, Phase 2: one restaurant's timeline (P2-1)

**Date:** 2026-10-28T17:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 2, task P2-1 of `docs/SUPER_ADMIN_BUILD_SHEET.md` (with P2-2 `report_2026-10-27_120000_alert_engine.md` and P2-4 `report_2026-10-27_160000_alerts_inbox.md`, this completes what Phase 2 can do without a channel)

---

## WHAT CHANGED

A restaurant's page in the console now carries its **timeline**: what happened to it, told in words, newest first, grouped by day. Until now the history was only in the audit log, as event types and JSON.

- **Migration 025** (`database/migrations/025_tenant_timeline.sql`): one read-only function, `admin_tenant_timeline(restaurant, kind, before, limit)`. It asks `spine_assert_admin()` first, reads only the spine (and the allowlist's emails), writes nothing, and is runnable by the console's role alone. **The kinds are filtered in the database, not hidden by the page afterwards**, so a page of "alerts" is a page of alerts and paging never mixes in or skips what a filter would have hidden. They do not overlap: *alerts* (the type starts `alert.`, including one a person acknowledged), *admin actions* (`admin.`), *billing* (Razorpay's events), *hub* (the hub's own reports). Type wins over source.
- **`GET /api/tenants/:id/timeline`**: `kind`, `before`, `limit` (1 to 500, default 50), each checked and named when wrong; an unknown or malformed restaurant is "not found"; the restaurant is named; "as of" is on it; a full page says where the next begins. Read-only.
- **`common/eventWords.js`** (pure): an event in, `{ kind, title, text }` out. "Subscription halted: the payment could not be collected", "Orders were shelved. Now 2 (was 0).", "Alert acknowledged by aman@example.test (orders shelved): “ringing the owner now”". Only the fields each event type is known to carry are used, by name, so nothing else that ever lands in a payload (a Razorpay customer or subscription id, the service hours themselves) becomes words; a payload that is missing or has a field of the wrong type says less and never breaks the screen. It uses the inbox's own words for alerts.
- **The page's Timeline** (`admin_web/src/screens/Timeline.jsx`), under a restaurant: a filter by kind, day headings (Today, Yesterday, then the date with its year, in the viewer's time zone), a kind chip and the time on each event, the details as text in an expander, **Show older events** paging, read again every minute and on Refresh. What is new goes above what is shown and what was paged back to is kept; if more than a page happened meanwhile the list starts again from the new page rather than show a gap as if there were none. A failed read never leaves the old list looking current.
- **The inbox's restaurant names open that restaurant's page** (with its timeline). That closes a limit the inbox report listed.
- **Also fixed, found while running the suites:** `hub_server/test/pairing.test.mjs` hard-coded a trial end date of `2026-10-28`; when that day came, a "live trial" became a Starter and the test failed (and would have failed CI). It is now 14 days from whenever the test runs.

## WHAT THE TESTS PROVE

Written first. **59 new hub tests and 46 new frontend tests** (the hub suite is now 2288 in 104 files; the frontend suite 1398, of which 286 are the console page's).

- `tenantTimelineSchema` (real Postgres engine): the migration is idempotent; only the console's role can run the function (not anon, a tenant, the service role, or the alert worker); a tenant, someone off the allowlist, a founder without a second factor and nobody are all refused; it is one restaurant's history newest first and nobody else's, nor the console's own; each kind returns only its own and **together they are everything and overlap nowhere, including a Razorpay event named like an alert**; an unknown kind is refused by name (not treated as "everything"); paging, including paging within a kind; the limit's floor and the **500 cap** (tested with 520 events); reading writes nothing and the chain still verifies; what the hub's own triggers record is on the timeline.
- `adminApi`: the route pinned in the default-deny list; closed field list, restaurant named, as-of; kinds, paging, defaults and caps (**also tested with 510 events**), every bad parameter named; unknown and malformed ids not found; an upper-case id answered by its lower-case form; refusals for a tenant, a deactivated founder and no second factor; no writes; a database failure is a 502 with no history. **A test runs the database's kinds and the words' kinds against the same real events and requires them to agree.**
- `eventWords` (28): every Razorpay event, hub event, alert event and admin action; the kind rules; payloads of the wrong type; titles on one line whatever they are built from; nothing planted in a payload reaches the words.
- `Timeline` (35) and the console's: the sentences, grouping by day in the zone given (including a day that differs between Los Angeles and UTC); order kept as the API gave it; text never markup; the filter and a superseded answer being dropped; paging back (no repeats, kind kept, double tap including two taps in the same instant); refresh merging and the gap rule; failures; polling one read at a time and stopping with the page; the latest `onLeave` and a new function each draw not causing a re-read.

**Mutation checking: 117 mutants** across the SQL filter and its grants, the query parser and route, the words module, the formatting, the Timeline component and the wiring. **93 were caught at first; 24 survived.** Of those, **21 were gaps in the tests, now closed** (the 500 cap on both layers; an event whose type disagrees with its source; the lower-casing of the id; a count that did not change; a resolution for another reason; a level that is a string or a fraction; an alert with no rule; titles on one line; the viewer's time zone for a day; the gap rule; where paging back resumes after a refresh; reading while paging back; same-instant double taps; the latest callback; a kind chosen after the restaurant changed; and others), and one mutant was aimed at the wrong function. **3 are equivalent and left** (a redundant `REVOKE` from the alert worker's role, which was never granted anything; a list used as a payload has no named fields; and the "kind merges into the old list" branch, which the effect makes unreachable by emptying the list first). On the re-run every mutant that is not equivalent was caught.

## LOOKED AT IN A REAL BROWSER

A throwaway harness with fake data (deleted), on a real Vite server: the timeline styled with the product's fonts and colours; kind chips; day groups; paging back to five day groups; the Details block wrapping cleanly; and a phone at 375 px in the dark theme with **no horizontal overflow**.

## FOUND ON THE WAY

- **A date bomb in a test** (`pairing.test.mjs`), above. Not caught by CI before because CI last ran on the 27th.
- **A slip of mine, caught by the tests:** the query parser's regexes lost their backslashes when I patched the file (`/^d{1,6}$/`), so every explicit `limit` was refused. Found by three failing tests before anything was committed.
- **Intermittent failures on this machine under parallel load, not caused by this change:** in the full runs, the tests that spawn real hubs (`kitchenOps`) failed in 3 of 6 hub runs (a spawned hub exited, or lost a port), and the frontend suite failed 4 to 5 timing-sensitive tests in 2 of 5 runs (import dialog, menu categories, kitchen display). Each passes alone and the suites then passed three (frontend) and two (hub) times in a row, with the machine otherwise idle. The kitchen display one was already noted in an earlier report; I have not tried to fix any of them. If CI turns red on one of these, that is what it is.

## HONEST LIMITS

- **Never run against a hosted project.** Proven on a real Postgres engine and stand-ins.
- The timeline shows the **spine**: Razorpay events, the hub's changes, alerts and administrators' actions. It does **not** show heartbeats (only changes worth knowing), nor restaurant data (invariant I1), and notes do not exist yet (Phase 3).
- A hub that reported before the spine existed has no "first report" on it; subscription events before it come in through the backfill.
- Event words are for the types that exist today. A new type shows as `Event “type”` until it is given words, which is deliberate: it says what it is rather than guessing.
- The details expander shows the raw payload (as the audit log does); that is for an administrator, not a restaurant.
- Refreshing while several older pages are open keeps them, but if more than a page of new events arrived meanwhile the older pages are dropped (and it says nothing about it beyond showing the new page).

## NOT DONE

P2-3 (a channel, the signed acknowledge link and the worker's entry point: **still waiting on the decision about how a one-tap link meets the 10-character reason rule**), P2-5 (the watcher for the watcher), a count badge on the Alerts tab, notes on a restaurant (Phase 3); running any of it on a hosted project.

Status: ✅ built, tested and looked at in a real browser; 🟡 never run against a hosted Supabase project or the real API; 🚧 nothing sends yet.

# Super admin console, Phase 2: the alerts inbox (P2-4)

**Date:** 2026-10-27T16:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 2, task P2-4 of `docs/SUPER_ADMIN_BUILD_SHEET.md` (builds on P2-2, `report_2026-10-27_120000_alert_engine.md`)

---

## WHAT CHANGED

Until now an alert could open, be paged about (once there is a channel) and resolve itself, but **no person could see one**. The console now has an **Alerts** place, and the admin API has the three routes behind it.

- **`GET /api/alerts`**: what is waiting and what somebody has taken on (`state=active`, the default), or `open`, `acked`, `resolved`; `limit` 1 to 500, default 100. Ranked by the engine's `rankAlerts`: what nobody answered after every reminder first, then the worse, then the one that has waited longest; closed ones most recently closed first. Each alert carries a **closed list of fields** (details are cut to the three a rule's words need), names its restaurant, says what is wrong in words, says how many reminders there are, and says who closed it as a *kind* ("person" or "system"), never an id. `counts` and `truncated` say what was waiting and whether the list was cut.
- **`POST /api/alerts/:id/ack` and `/resolve`**: the first writes the API has that a person chooses. A body of `{ "reason": "..." }`, **at least 10 and at most 500 characters after trimming, counted in characters** (invariant I4). **The administrator is asked before the body is read**, so a tenant or a founder without a second factor gets the same refusal whatever they send; the body is read only as JSON of at most 4 KB; a bad id is simply "not found" without a trip to the database; the API says what is wrong with a reason in words a person can act on; "already resolved" is a **409** and "not there" a **404** (migration 024 now gives those two their own error codes, `55000` and `P0002`).
- **The page's Alerts place** (`admin_web/src/screens/AlertsPage.jsx`): the list as cards (how bad, which restaurant, what is wrong, when it opened, how far the paging has got, who has taken it on and what they said), a filter (waiting and taken on, waiting, taken on, closed), read again every minute and on Refresh, "as of" on it, and a failed read never leaves the old list looking current. Acknowledge and Resolve each open a form under the alert that says in plain words what the action does and does not do, takes focus in the reason box, counts the reason as a person would, sends **one request** however many times it is tapped, **keeps the words when it is refused**, and says so if the alert changed meanwhile.
- **Client** (`admin_web/src/lib/api.js`): `alerts`, `acknowledgeAlert`, `resolveAlert`; the token still goes in a header and nowhere else (never in the body); a 409 is its own kind with the page's own words.
- `common/alertEngine.js` gained `alertWords` (the one set of words for pages and the inbox) and `rankAlerts`.
- The page's rule that it "can change nothing" is replaced, deliberately, by a narrower one that is tested: **the only controls that change anything are those two actions on an alert**.

## WHAT THE TESTS PROVE

Written first. **31 new hub tests and 75 new page tests**; the hub suite is now 2229 (102 files) and the frontend suite 1352, of which 240 are the console page's.

- **API** (`adminApi`): the pinned route list (default-deny, the sweep now asks each route about the kind of id it takes); ranking, state filter, limit, `truncated` and `counts`; the closed field list with a phone number and a token planted in an alert's details; who closed it; both writes record who and why on the right chain; **a reason of 9 refused and 10 accepted, 500 accepted and 501 refused, padding not counted, five emoji refused and ten accepted**; a body that is not JSON, not declared as JSON, too large, an array, a number, null; **a tenant, a deactivated founder and a founder without MFA are refused before the body is read, whatever it holds**; a second acknowledgement records nothing and two at once record one; already resolved is 409 and unknown is 404; a database failure is a 502 with no data.
- **Client** (`api`): each route, header and failure kind; the id encoded; a body only on the two writes; the token in neither the address nor the body.
- **Page** (`AlertsPage`, plus the console's): what is shown for each state and severity; order kept as the API ranked it; text never markup; the form's words; ten characters, five hundred, padding, emoji; a double tap and **two submissions in the same instant** are one request; a refusal keeps the words; a connection failure can be retried; a conflict or a missing alert closes the form and reads again; a session that ends is the console's to handle; a late answer after closing changes nothing; a superseded search is dropped; polling is one read at a time and stops with the page.
- `adminWebBuild` (13): the real production build still passes, styled, with the exact policy and no inline script.

**Mutation checking: 96 mutants** across the API, the client, the engine helpers, the page and the console wiring. **70 were caught at first; 25 survived.** Of those, **21 were gaps in the tests, now closed** (the reason's trimming and its character counting; a body that is not JSON told so in words; the default limit; an acknowledged alert still counted as unattended; "who closed it" on an open alert; ties in the ranking and a list sorted in place; same-instant double submits; a form submitted too short; a missing alert; the timer stopping with the page; answers after closing; the counts on the closed list; a form left open when the filter changes; a repeat that recorded nothing; the latest `onLeave`), and **one was a real bug found by a survivor**. **4 are equivalent and left** (the API passes the reason untrimmed to the database, which trims it again; a list as a body has no `.reason`; a list as an alert's details has no `count`; `JSON.stringify(undefined)` is `undefined`, so a GET never had a body). On the re-run every mutant that is not equivalent was caught.

## FOUND ON THE WAY

- **A real bug, found because a mutant survived.** The page read its list through a function that depended on `onLeave`, so a parent that hands over a *new* `onLeave` each time it draws would have made it **read again, empty its list and close a form somebody was writing in** on every draw. Fixed by keeping the latest `api` and `onLeave` in refs so reading no longer depends on them, pinned by a test that re-renders with a new function three times with a half-written reason in the box.
- The first look in a real browser found that the reason box did not take focus when the form opened; fixed, pinned.
- A test of mine raced the first read on a slow machine (it passed alone and failed under the full suite's load); the helper now waits for the first read to settle.

## LOOKED AT IN A REAL BROWSER

A throwaway harness with fake data (deleted), on a real Vite server: the inbox styled with the product's fonts and colours; the acknowledge form with its ring on the focused box and the filled (disabled) primary button, which is the earlier button-layer fix working; the form on a phone at 375 px in the dark theme, with **no horizontal overflow**. The component tests run without CSS, so this is the only look at how it appears.

## HONEST LIMITS

- **Never run against a hosted project.** The routes are proven on a real Postgres engine (PGlite) and the page against fakes of the API.
- **Nothing pages anyone yet** (P2-3: a channel and the worker's entry point). The inbox is the only way an alert is seen today.
- The counts are of what the list holds: if it was cut (`truncated`), they are lower bounds.
- The inbox links nowhere: an alert names its restaurant in words and does not yet open that restaurant's page (that comes with the tenant timeline, P2-1).
- A resolved alert whose problem is still there reappears within a minute or so as a **new** alert: the form says so, and Acknowledge is the way to say "I know".
- An alert's details are as they were when it opened.
- There is no badge on the Alerts tab with the number waiting.

## NOT DONE

P2-1 (the tenant timeline page), P2-3 (a channel, the signed acknowledge link and the worker's entry point; **still waiting on the decision about how a one-tap link meets the 10-character reason rule**), P2-5 (the watcher for the watcher), a count badge on the tab; running any of it on a hosted project.

Status: ✅ built, tested and looked at in a real browser; 🟡 never run against a hosted Supabase project or the real API; 🚧 nothing sends yet.

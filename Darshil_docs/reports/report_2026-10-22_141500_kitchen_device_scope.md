# 4.7 Role-scoped device tokens — a kitchen screen can mark tickets done, and nothing else

**Date:** 2026-10-22T14:15:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Station screens are not role-scoped" / §4.7 "Role-scoped device tokens"

---

## WHY

A station tablet — the screen at the bar or the hot line — carried exactly the same device token as a
waiter's handset. That token could do anything an enrolled device can: place orders, raise and void
bills, mark them paid, refund, clear a table, and add or remove staff. A tablet on the pass is the
device in the restaurant most likely to be handled by someone who is not the person it was set up for
(cooks, dishwashers, a delivery rider waiting by the window), and until now a curious tap on the wrong
screen could void a bill.

The roadmap recorded this twice (§3 and §4.7) and the answer is the one it already named: a kitchen
tablet should be able to mark tickets ready and not void a bill.

**What this is not.** The enrolment code is one shared code, shown on the reception screen. A device
*chooses* its scope when it enrols, so this limits the damage a tablet can do if it is mishandled or
lost; it does **not** stop someone who has the code from enrolling as a full handset, which they could
always do. That is a different threat (who can see the code) and the answer to it is rotating the code,
which already exists.

## WHAT

### Two scopes, and the safe one is the default for new routes

A device is `full` (every enrolled handset's authority today) or `kitchen`.

The design decision that matters: **`requireDevice` — the guard on every existing route — now refuses a
kitchen token (403 `DEVICE_SCOPE`)**, and a second guard, `requireKitchenDevice`, admits both. Only five
routes use it:

| Route | Why a screen at the pass needs it |
| --- | --- |
| `GET /orders/active` | the board itself |
| `POST /orders/:id/ready` | mark a ticket ready |
| `POST /orders/:id/stations/:station/ready` | a station marks its own part done |
| `POST /orders/:id/fire` | fire a held course |
| `POST /orders/:id/recall` | recall a ticket |

The live feed (`/live`) accepts any valid token, as before, so the board updates.

This is **default-deny**: a route added next year is closed to a pass tablet until someone decides
otherwise. The other shape — a list of routes a kitchen token is kept *out* of — fails open the first
time somebody forgets to add one.

### Old devices keep working

A grant stored without a scope is `full`: every device enrolled before this existed had that authority,
and narrowing it silently would stop a waiter's phone in the middle of service. A grant whose scope is
present but **unrecognised** (a hand-edited file, a value from a newer hub) is read as `kitchen`, the
narrower of the two — when the file cannot be understood, the safe reading is the one that can do less.

`issueToken` throws on an unknown scope, and `/auth/device` answers 400 `INVALID_SCOPE`, rather than
falling back: a typo should not hand a tablet more than it asked for. That check says nothing about the
enrolment code, so it can come first without telling a guesser anything.

### The pieces around it

- **Station page** asks for `kitchen` when it enrols, by typed code and by scanned QR.
  `enrollWithCode(…, { scope })` sends `scope` only when asked, so a waiter's phone sends exactly what
  it always did.
- **`/pairing-info` reports `device_scope`** — the caller's *own* authority (`full` for the reception
  laptop, `null` with no live token). `authorised` is true for any live token, and a waiter app that
  took that to mean "I am a handset" went on to a sign-in screen the hub then refused.
- **Waiter app**: a tablet set up as a kitchen screen shares this browser's storage, so it can open the
  waiter app holding a token that is no use there. It now shows the existing "Handset not enrolled"
  prompt, and entering the code replaces the token.
- **Reception's Staff & devices list** labels a kitchen screen ("Kitchen screen — shows tickets and
  marks them done. Cannot take orders or touch bills."). An ordinary handset is left unlabelled.

## A DEAD END FOUND IN THE BROWSER, AND FIXED

The first version of the waiter-app change compiled, passed every test, and was wrong. Checked against
a real hub in the browser, a kitchen tablet that opened the waiter app landed on the **sign-in** screen
with a red message ("Enrol it as a handset…") and **no way to do so** — the hub's `/pairing-info` said
`authorised: true`, so the app believed it was enrolled, proceeded to sign-in, and `/waiters` refused it.
Before this change a kitchen token and a handset token were the same, so the dead end did not exist; it
was created by the scoping. The fix is the `device_scope` field above, and the flow was re-verified:
station enrols as `kitchen` → waiter app shows the enrol prompt → entering the code replaces the token →
`device_scope` is `full`, `/menu` returns 200 and the sign-in lists staff. (No PIN was entered.)

## FILES

**New**

| File | What it is |
| --- | --- |
| `hub_server/test/deviceScope.test.mjs` | 20 tests: the store's rules, then a real hub |
| `src/test/services/hubAuth.test.js` | 4 tests: what an enrolment request says |

**Changed**

| File | What changed |
| --- | --- |
| `hub_server/lib/deviceAuth.js` | `DEVICE_SCOPES`, `scopeOf`, `lookup`, `scopeFor`, scope on `issueToken`/`enroll`/`listDevicesPublic`; `requireDevice` refuses kitchen; new `requireKitchenDevice` |
| `hub_server/server.js` | `/auth/device` validates and passes `scope`; five routes opened to `requireKitchenDevice`; `/pairing-info` reports `device_scope` |
| `src/services/hubAuth.js` | `enrollWithCode(…, { scope })` |
| `src/station/StationScreen.jsx` | enrols as `kitchen` (typed code and QR) |
| `src/waiter_mobile/WaiterApp.jsx` | treats a kitchen scope, and a 403 on tables/menu, as "not enrolled as a handset" |
| `src/admin/StaffTab.jsx`, `src/admin/lib/staff.js` | `deviceKind` and the "Kitchen screen" label |
| `src/test/station/StationScreen.test.jsx`, `src/test/admin/StaffTab.test.jsx` | assertions for the above |

## TESTS

`deviceScope.test.mjs` (hub, 20):

- the store: handset by default; no scope for a revoked, never-issued, **expired** or malformed token;
  a pre-scope grant stays `full`; an unrecognised stored scope reads as `kitchen`; a misspelt scope
  cannot be issued; the device list shows scope and never a token or hash;
- **the kitchen route set is pinned** — the test reads `server.js` and asserts the five routes, and
  that `requireKitchenDevice` appears nowhere else, so widening it is a decision made in a diff;
- a real hub: a screen enrols as kitchen and reception's list says so; an unknown scope is refused and
  enrols nothing; asking for `kitchen` does not get around the enrolment code; a kitchen token reads the
  board and marks tickets/stations done; fire and recall are not stopped on scope grounds;
- **31 routes a handset really uses are each refused to a kitchen token** (403 `DEVICE_SCOPE`) —
  placing orders, every bill route, staff, plan, crash log, dashboard — with a **control** that the same
  31 are not refused on scope grounds to a full handset, so the refusals are the scope and not made-up
  ids or empty bodies; no token at all is still a 401; `/pairing-info` reports each device's own scope;
  the live feed takes a kitchen token and still refuses a stranger.

**Mutation-checked:** eight deliberate breakages (the guard admitting a kitchen token; an unrecognised
scope reading as `full`; a missing scope reading as `kitchen`; enrolment ignoring the requested scope;
enrolment accepting any scope string; a bill route opened to kitchen; `issueToken` accepting a
misspelt scope; an expired token keeping a scope) — **one survived the first time** (nothing tested an
expired token), a test was added, and all eight are now caught.

**Full suites:** hub `939 passed`, frontend `290 passed`, `npm run build` clean.

**In a browser** (a scratch hub on :4100 with its own data directory, loopback untrusted so the browser
had to enrol): the station page enrolled by typed code and loaded its board over the live socket;
`GET /orders/active` was 200 and `/menu`, `/tables`, `/invoices` and `POST /waiters` were each 403
`DEVICE_SCOPE`; the waiter-app flow above.

## WHAT IS NOT DONE

- **The live feed still carries table totals to a kitchen token.** It is read-only and the same feed the
  board needs, but a kitchen screen can in principle see a total it has no reason to.
- **A full handset can still add or deactivate staff.** `POST /waiters` and `DELETE /waiters/:id` are
  commented "reception / admin flow" but are guarded only by a device token, so any enrolled phone can
  create a waiter with a PIN or lock another waiter out. Reception's own Staff tab uses the `/admin/staff`
  routes, which are reception-only, and nothing in the app calls the old ones. They were left alone here
  because three existing tests (`hub.test.mjs` ×3, `plans.test.mjs` ×1) drive them with a device token and
  moving them to reception-only means rewriting those; recorded in §4.7 rather than done in passing.
- **Signed-in roles are still not enforced** (waiter / manager / kitchen on a *person*). This scopes a
  *device*; §4.7's role UIs are separate.
- **Scope is the device's own choice at enrolment** — see WHY.

---

**Verification:** both suites green, the build clean, eight mutations caught, and the cross-page flow
checked in a real browser against a scratch hub (restored afterwards; the pilot's `hub_server/data` was
not touched).

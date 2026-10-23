# The reward for coming back, for a guest at the door

**Date:** 2026-10-23T22:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.5 Customer-facing surfaces (the roadmap's "only bookings are offered the reward, not walk-ins"), and a leftover in §4.6

---

## WHAT WAS MISSING

Migration 017 let a restaurant set "every Nth visit, <words>" and recorded, on a **booking**, that the reward had been given.
A guest who walked in and queued was never offered it, even though their earlier visits (seated bookings and seated walk-ins)
already counted towards the next one. The roadmap said so: "Only bookings are offered the reward, not walk-ins."

## WHAT CHANGED

- `hub_server/lib/loyalty.js`: `rewardDue` now accepts a queue entry. A visit can earn the reward while it is `booked`, `waiting`,
  `notified` or `seated`, and never once the party has `left`, been a `no_show` or `cancelled`. The visit is excluded from its own
  earlier visits in **both** lists (before, only the bookings list was filtered, which would have counted a seated walk-in as its own
  previous visit and put every reward one visit late).
- `hub_server/lib/reservations.js`: giving and taking back a reward are one piece of code (`giveRewardIn` / `takeBackRewardIn`)
  over either list, exported as `giveReward` / `takeBackReward` (bookings, unchanged) and `giveWalkInReward` /
  `takeBackWalkInReward`. A booking's id is not found in the queue and the other way round.
- `hub_server/lib/reservationStore.js`, `server.js`: `POST` and `DELETE /admin/waitlist/:id/reward` (reception only), and the
  queue rows in `GET /admin/bookings` now carry `reward_due`, from the same `rewardOffer` the bookings use.
- Migration `019_walkin_rewards.sql`: the same three nullable columns on `walkins` that 017 put on `reservations`.
  `reservationSync.js` pushes them and `pullReservations` restores them, so a replacement laptop does not offer the same guest the
  same reward again.
- `src/admin/BookingsTab.jsx`: the queue row says "3rd visit: a free lassi" and offers "Reward given"; once given it says "Reward
  given: a free lassi" with "Take back". The buttons are disabled while the hub is being asked.

A guest who gave **no number cannot be recognised** (there is nothing to match their earlier visits on), so is offered nothing.

## ALSO: A LEFTOVER REMOVED

§4.6 noted that the retired Waitlist tab's state was "still there" in `PosContext`. It was: browser-`localStorage` state with demo rows
for two restaurants, a LAN-bus handler, and two operations that nothing called. Deleted (82 lines across `PosContext.jsx` and
`services/db.js`); nothing referenced them.

## ALSO: A FLAKY TEST ROOT-CAUSED

`orderCancel.test.mjs` ("the cancellation is queued for the cloud...") waited a fixed 300 ms for the hub's queue file to be written
in the background. On a busy machine that lost the race (1 run in 3 while another program held the CPU). It now looks until the entry is there,
with a 5-second deadline; 5 runs in a row passed.

## TESTS

Written first and run failing (the rewards file could not even import `giveWalkInReward`; the cloud round trip refused the new columns;
the four queue tests on the tab failed).

| File | New | What it pins |
| --- | --- | --- |
| `rewards.test.mjs` | 10 | a walk-in on the 5th visit is due it; due while waiting, messaged or seated (not counted as their own earlier visit), not once left; no number, no recognition; another guest's visits do not count; giving records when, the words and which visit; refused too early, with no scheme, for a missing id or a booking's id; twice changes nothing, keeps the first time, says `already`; taken back; the same on a real hub, and a handset is refused on both new routes |
| `reservationSync.test.mjs` | 1 | the reward carries up as the three columns and comes back, including a number that arrives as text |
| `cloudRoundTrip.test.mjs` | 0 (extended) | a given walk-in reward goes through the **real schema** (PGlite, migration 019) and back |
| `BookingsTab.test.jsx` | 5 | the badge and button in the queue; giving posts to the **queue's** route (not the bookings'), says so and reads again; taking it back; a refusal in the hub's words; buttons disabled while the hub is asked |

Suites at this commit: **hub 1444 → 1454 (71 files); frontend 911 → 916 (43 files)**; the build passes.

## MUTATION CHECKS

44 mutations over the rule, the pure give/take-back, the store, the routes, the sync mapping and the screen: **first pass 40 caught, 4
survived**, all real gaps (the "not in the queue" wording, the route's `already` flag, the pulled number coerced from text, and the buttons
being disabled while a request is out). All closed with tests; **final 44 of 44 caught, none equivalent**.

## NOT DONE

- **Points, tiers and any automatic discount** stay unbuilt: the reward is applied on the bill by a person, because the product does not
  know what a dessert costs or how much the owner will give. That is a commercial decision.
- **The rule itself is still a setting on the hub** (like guest ordering) and is not replicated; a replacement laptop restores what was
  given but not the rule, so the owner sets it again.
- **Migration 019 has not run on a hosted Supabase project**, like 004–018. It has run on the real schema in the test database.
- Not seen in a real browser: the queue row is covered by component tests, and the screen was not changed in layout, only given
  one more badge and button in the same pattern as the booking row.

Status: ✅ VERIFIED (real schema in PGlite; hosted project unrun)

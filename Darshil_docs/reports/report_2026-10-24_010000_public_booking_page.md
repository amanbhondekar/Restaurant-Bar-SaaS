# A public page where a guest asks for a table

**Date:** 2026-10-24T01:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.6 Reservations & waitlist: the last open item ("a public reservation page per tenant, which needs hosting")

---

## WHAT WAS MISSING

Every booking came through reception: by phone, at the door, typed in by staff. The model, the replication and the availability check were
all there for a public page, but nothing took a request from a stranger, and the roadmap said the page "needs hosting this product does not
have". It does: the operator service has to be public anyway, for Razorpay's webhooks.

## THE SHAPE OF IT, AND WHY

```
guest's phone  →  operator service  →  cloud (booking_requests)  →  the restaurant's hub  →  Bookings tab
   the form         checks, limits        waits, closed to anon       collects, holds         accept / decline
```

- **A guest only asks.** The page says it is a request and that the restaurant will answer by WhatsApp or phone. The hub owns the diary and checks
  every booking against the real table layout, so the page cannot promise a table the restaurant has not agreed to. Accepting a request books it
  through the same check as any booking (and asks before overbooking); declining books nothing; a person tells the guest from their own phone.
- **The operator service serves the page and takes the request.** It is the one place a stranger can write something that reaches a restaurant, so
  it is the one place that has to be able to say no. Writing happens with the service key on the guest's behalf, and **the database stays closed to
  `anon`**, as it has been since migration 014. The page is served from the same address as the API, so there is no cross-origin access to allow
  and no separate host to run.
- **Nothing is cleared from the cloud until a person has answered.** A request the hub has collected stays in the cloud until staff accept or decline
  it, so a hub that is lost between collecting and answering loses nothing: the replacement collects the same inbox.

## WHAT CHANGED

**Cloud**: migration `020_booking_requests.sql`: `booking_pages` (one per restaurant: a random public code, on or off) and `booking_requests` (the inbox).
Both are closed to `anon`; the hub (`kitchen` role) switches its page on and off and clears its inbox; an owner or manager may read; only the service role
writes a guest's request.

**Operator service** (`signup_server/`): `lib/bookingPage.js` (the rules for a request, and a bounded rate limiter), `lib/publicBooking.js` (`GET /public/booking/:code`,
`POST /public/booking/:code/requests`, the page at `/book/:code` with a policy that allows no inline script, `no-referrer`, `nosniff`), wired in `server.js` with `TRUST_PROXY`.
What it does to stop abuse: a field no person sees (filling it looks like success and stores nothing); at most 5 requests per address per 10 minutes (30 counting
mistakes); 3 per number per hour per restaurant; at most 50 waiting per restaurant; a 4 KB body; requests whose time went a day ago are cleared out.

**Hub**: `lib/bookingRequests.js` (the rules for a collected request: receive without duplicating, accept through the diary's check, decline, let go of a lapsed one,
forget a decided one after a week), `lib/bookingInbox.js` (collect and clear, and the page's address), `lib/bookingInboxRunner.js` (one check at a time, never
throws), `lib/bookingPageRoutes.js`; routes `/admin/booking-requests` (list, accept, decline) and `/admin/booking-page`, all reception only. The inbox is collected at boot,
every two minutes and when reception presses *Check for new requests*.

**Screens**: `reserve.html` and `src/reserve/` (the guest's form: plain, in the diner's style, nothing from the staff app); `BookingRequests.jsx` and
`OnlineBookingPanel.jsx` in the Bookings tab.

**Docs**: `docs/OPERATOR_SERVICE.md` (the page, `TRUST_PROXY`, what it protects and what it does not), ROADMAP §1, §3, §4.5, §4.6, M4, CHANGELOG.

## TESTS

Written first: each file was run and seen failing (the module, the table or the component it tests did not exist) before the code was written. In all, **153 hub tests** (against a stand-in cloud and the real schema)
and **86 on the screens** (41 + 20 + 22, and 3 more in the Bookings tab's own tests).

| File | Tests | What it pins |
| --- | --- | --- |
| `bookingRequestsSchema.test.mjs` | 10 | on the **real schema** (PGlite): anon can do nothing; the hub sees and clears only its own inbox, cannot put a request in it or edit one; an owner may read and write nothing; the privileges are exactly these; constraints; cascade; the migration runs twice |
| `publicBooking.test.mjs` | 33 | what the page is told; unknown, switched-off and malformed codes look the same and the malformed ones never reach the database; every refusal names its field; boundaries; the trap; the limits, to the millisecond; the cap; lapsed requests cleared; a failure never leaks the database's words; the page's headers; only the page and its assets are served |
| `publicBookingRoundTrip.test.mjs` | 4 | the same on the real schema: the service role's grants, the count and the delete the service relies on |
| `bookingRequests.test.mjs` | 28 | the rules for a collected request |
| `bookingInbox.test.mjs` / `…RoundTrip.test.mjs` | 27 / 4 | the page's address and collecting the inbox, on a stand-in and on the real schema as the hub's own identity |
| `bookingInboxRunner.test.mjs`, `bookingPageRoutes.test.mjs`, `bookingRequestRoutes.test.mjs` | 15 / 16 / 16 | the runner, the page routes (with the cloud faked) and the requests routes on a real hub |
| `ReservePage.test.jsx` | 41 | the guest's form: says it is a request, names what is wrong, keeps what was typed, cannot be sent twice |
| `BookingRequests.test.jsx`, `OnlineBookingPanel.test.jsx` | 20 / 22 | the staff screens; the Bookings tab's integration |

## MUTATION CHECKS

| Layer | Mutants | First pass | What happened |
| --- | --- | --- | --- |
| Migration 020 | 35 | 29 caught | **6 equivalent and kept**: two `REVOKE`s (migration 014 already resets the defaults) and four policy conditions that the tenant-read policy also enforces, because Postgres applies it to the new row and the target row of an `UPDATE`/`DELETE` |
| Operator service: the page | 84 + 17 | 60 + 16 caught | all survivors closed or removed (below) |
| Hub: rules, inbox, runner, routes | 156, then 189, then 26 | 110, then 171, then 26 caught | survivors closed; **2 equivalent and kept**: the prune filter's `pending` clause (a pending request has no `decided_at`, so is never old), and the one-line wiring of the real pull in `server.js` |
| Screens | 169, then 33 | 139 caught, then 33 | 29 survivors closed with 20 tests |

Survivors were real gaps unless said otherwise: control-character boundaries, time normalisation, party parsing, the code pattern never reaching the database, the lapsed-request cutoff,
`TRUST_PROXY` parsing, the limiter's window and recency, a failure being asserted as a failure rather than skipped, the page's state transitions, the timers (made observable by two env knobs,
`HUB_BOOKING_INBOX_FIRST_MS` and `HUB_BOOKING_INBOX_MS`). A few mutants were **mine to fix, not the tests'**: one of my mutation strings had hit the first of three identical `{ force: … }`
lines, which is the manual booking route and not the accept route.

## WHAT THE TESTS FOUND IN THE CODE

- A note's control characters were only replaced once, because the regex was not global (a global one is stateful with `.test`, so there are now two).
- A payment page with no link on file was answered with "a page for *another* plan is open"; it now says its link was not kept.
- A hub with no cloud answered a manual "check now" with "no new requests". It now says the check did not work.
- Four tests of mine passed for the wrong reason (a failure skipped instead of asserted; a forged insert refused by a duplicate key, not by the policy). Fixed.
- Collecting and clearing the inbox needed two modules extracted from `server.js` (the runner and the page routes) before they could be tested properly.

## CHECKED IN A REAL BROWSER

On a scratch hub and a stand-in operator service (the real service code over an in-memory cloud): the guest's form was filled and sent, the service stored it for the
right restaurant with the number normalised, and the browser console and the page's security policy were clean. The staff screens were seen with seeded requests: a
free table, one fully booked, one for a party no table seats, one whose time had passed.

## NOT DONE

- **No captcha, and no check that the number is the guest's.** A determined person can fill a restaurant's inbox up to its cap of 50. Put the service behind a proxy that rate-limits
  (and set `TRUST_PROXY`) before publishing the address widely. Guests on one wifi or mobile network share an address and so the limits.
- **The page does not know opening hours or closed days**, so a guest can ask for a time the restaurant is shut. Not built.
- **Nothing has run against the real cloud**, and migration 020 has not run on a hosted project.
- **Nothing is sent automatically**, by design: the product has no messaging provider.

Status: ✅ VERIFIED against stand-ins and the real schema; ⚠ unrun against a hosted Supabase project.

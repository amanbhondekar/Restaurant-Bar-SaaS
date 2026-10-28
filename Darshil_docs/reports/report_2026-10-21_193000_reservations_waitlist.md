# 4.6 Reservations & waitlist

**Date:** 2026-10-21T19:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.6 Reservations & waitlist — the whole module

---

## WHY

§4.6 was entirely unbuilt: time-slot reservations, "your table is ready" notifications, and a public
booking page. What existed was a **waitlist in browser localStorage** (`PosContext`, seeded with demo
rows) — not on the hub, not shared between devices, gone when someone cleared their browser.

Two decisions shaped this, both taken before any code was written:

**Where a booking lives.** A genuinely public booking page cannot be served by a LAN hub — someone
booking a table is not in the restaurant yet. Hub-first with a cloud seam was chosen: reception takes
bookings on the hub, and they replicate, so a public page can be added later without reworking the
model. The hub also has to keep working with the line down; a restaurant that cannot read tonight's
bookings because its internet is out has a worse problem than one without a cloud.

**How a guest is reached.** **WhatsApp click-to-chat**, over the Business API. The hub builds a
`wa.me` link with the message already written and a member of staff taps it to send from their own
phone. No Meta approval, no provider, no template approval, no per-message fee — and it works on a hub
with no internet at all. The cost is that a person presses send, which when a table is about to be
given away is not really a cost.

## WHAT

### The guest's number (`lib/guestContact.js`)

Shared by reservations, the waitlist and (next) loyalty, because in a restaurant they are the same
person and the number is the only thing tying the three together.

Every way staff type an Indian mobile — `98765 43210`, `+91 98765-43210`, `09876543210` — becomes one
number. A loyalty history split across three spellings of the same number is worse than none.

What is stored is deliberately split:

- **`phone`**, the number, because staff have to be able to ring someone whose table is ready;
- **`phone_key`**, a hash **salted with the restaurant's own id**, which is what loyalty *matches* on.

Loyalty never needs to read a number back, only to know it is the same person — so the thing that
accumulates a visit history keys on something that cannot be read out of a stolen copy, and one
tenant's guest list can never be joined against another's.

### Not selling the same table twice (`lib/reservations.js`)

The rule, in one sentence: **a party needs a table at least its own size, and competes for those
tables with every overlapping booking for a party at least as big.** Smaller parties are assumed to
take smaller tables, which is what a restaurant actually does — so six people compete with other fives
and sixes for the six-tops, and a couple booked at the same time does not block them.

Tables are deliberately **not assigned** at booking time: a restaurant shuffles tables on the night and
would resent being told which one to use. What is checked is that a table *could* be found, which is
the promise being made.

**Walk-ins already sitting down are counted**, because a floor full of walk-ins is exactly when an
accepted booking turns into an apology. And because the rule is an assumption rather than a guarantee,
`force` exists: a restaurant that knows it can squeeze one more in should not be argued with by its own
till — but it has to say so, and the booking records that it was an overbooking.

Bookings that merely touch at the edges do not overlap; a cancelled or no-show booking gives its table
back.

### The two lists

A **booking** is a promise about a future time and needs a phone number — it is a promise you may have
to chase. A **walk-in** is a queue for right now, and a number is optional: plenty of people wait in
the doorway, and refusing to queue someone who will not leave one would be a worse product than one
that cannot message them. Such a party can still be seated; only "mark messaged" is refused, with the
reason.

### Reception's tab

One day at a time, steppable, defaulting to today. The queue at the door shows how long each party has
waited and flags anyone **past the wait they were told** — the one thing on the screen worth a colour,
because it is the moment a guest starts to feel lied to and it is invisible otherwise.

A clash is not a dead end: the refusal says how many tables that size exist and offers **Book it
anyway**.

### Migration 011 and the cloud seam

`reservations` and `walkins`, hub-authoritative, pushed as a debounced snapshot — the **fourth**
replicated catalog, so it inherits the existing coalescing, status reporting and shelving. A
replacement laptop rebuilds the diary; a diary deliberately cleared is *not* handed last month's
no-shows back (same revision-0 rule as stock).

### Files

| File | Change |
|---|---|
| `hub_server/lib/guestContact.js` | New — numbers, matching keys, wa.me and tel links |
| `hub_server/lib/reservations.js` | New — the booking and queue rules |
| `hub_server/lib/reservationStore.js`, `reservationSync.js` | New — disk, and the cloud copy |
| `database/migrations/011_reservations.sql` | New |
| `hub_server/server.js`, `lib/syncQueue.js` | Routes, the fourth catalog, boot restore + backfill |
| `src/admin/BookingsTab.jsx`, `lib/bookings.js`, `AdminApp.jsx` | Reception's tab |
| `src/admin/api.js` | `HubError` carries the whole body, so a route can refuse with detail |

## TEST CASES (76 new)

| File | N | Covers |
|---|---|---|
| `reservations.test.mjs` | 26 | Every spelling of a number becoming one; a key that cannot be read back and differs per tenant; wa.me links; validation; past and far-future bookings; **six competing with sixes while a couple does not block them**; the only table that size booked twice; edges that touch not overlapping; cancelled giving its table back; **seated walk-ins counted**; forced overbooking recorded; the life of a booking; a walk-in without a number; the queue; state from disk |
| `reservationRoutes.test.mjs` | 12 | A real hub: a booking with contact links already built; the diary by day; **the same table not sold twice, with what is free in the refusal**; a party too big; forcing; asking availability first; per-field refusals; seated-then-no-show refused; a walk-in with a ready-made message; no-number handled; survives a restart; **every route reception-only, with nothing written on refusal** |
| `reservationSync.test.mjs` | 17 | Mapping (`at` → `booked_for`); upserts before deletes; update in place; deletes not touching another tenant; a round trip; rows with no `hub_ref`; the queue as a fourth catalog; coalescing; backfill; restore, including **a cleared diary not being refilled** |
| `src/test/admin/BookingsTab.test.jsx` | 21 | Day stepping and labels; waits and the overdue flag; both forms' checks; the list; **links the hub built**; no-number showing no link rather than a dead one; taking a booking; **a clash offering to book anyway**; seating and queue actions; an unreachable hub |

**A real bug the tests caught:** the booking form defaulted to 7pm on the day being viewed — which is
*already past* if reception opens it at 9pm, so the form could never be submitted. It now opens on the
next half hour when dinner service has gone by. A second, smaller one: a clash was explained twice, by
the conflict notice and the generic error, which reads as two faults.

```bash
npm run test:hub   # 892 (837 + 55)
npm run test:web   # 252 (231 + 21)
npm run build      # clean
```

## NOT DONE / LIMITS

- **No public booking page.** The decision was hub-first with a cloud seam, and the seam is what
  exists: bookings replicate, so a page can read them later. Nothing public has been built, and it
  would need hosting this product does not have.
- **Notifications are a link, not a send.** Staff tap WhatsApp or the phone number. Nothing is sent
  automatically, nothing is scheduled, and no reminder goes out the morning of a booking.
- **Nothing is recorded about whether a message was actually sent** — "mark messaged" is reception
  saying so, not the hub knowing.
- **The capacity rule is an assumption.** Smaller parties are assumed to take smaller tables. A
  restaurant that seats two people on its only six-top will find the rule optimistic; `force` is the
  answer, and it is recorded.
- **No service hours, no shifts, no turn times per table.** A booking can be taken for 3am.
- **The old `PosContext` waitlist is still there** and still in localStorage, used by the
  server-laptop app. The two are unrelated and the old one should go, but removing it touches a
  surface this slice did not otherwise open.
- **Migration 011 is unrun**, like 004–010. The push and pull were verified against a stateful fake
  cloud, not PostgREST.
- **The guest's number is stored in plain text on the hub** (hashed only for matching). That is
  deliberate — staff must be able to ring people — but it is personal data on a reception laptop, and
  nothing here encrypts the file or expires old entries.
- Nothing was driven in a browser this slice; it is covered by component tests against a fake hub.

## STATUS

✅ VERIFIED — 892 hub + 252 frontend, build clean. ⚠ Migration 011 unrun; no public page.

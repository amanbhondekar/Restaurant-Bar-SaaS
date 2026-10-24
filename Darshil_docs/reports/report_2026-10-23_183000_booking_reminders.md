# Booking reminders

**Date:** 2026-10-23T18:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
Roadmap §4.6 carried two open lines under "sending anything automatically": no reminder the morning of a booking, and nothing records
whether a message was really sent. The hub has no messaging provider on purpose (no approval, no per-message fee, it works with the
line down), so a message always needs a person to press send. What it can do is **tell the host who to remind, build the message, and
remember that a person said they sent it**, so two people do not ring the same guest and the host can see who still has to be chased.
Not done, deliberately: anything that sends by itself.

## WHAT CHANGED
- `lib/reservations.js`: `remindersDue(state, { now, withinHours })`: bookings still booked, with a number, not yet reminded, starting
  within the window (default 24 h, capped at two weeks, a bad value falls back to the default) and not already under way; earliest first.
  `markReminded` records when and (optionally) by whom, trimmed to 60 characters; marking twice keeps the first time and changes nothing;
  a booking that is no longer booked is refused (`NOT_BOOKED`); `unmarkReminded` takes a mark back. `reminderMessage` is the words, kept
  with the other messages.
- `lib/reservationStore.js`, `server.js` (all reception-only): `GET /admin/bookings/reminders?hours=`, `POST` and `DELETE`
  `/admin/bookings/:id/reminded`, and the diary list now carries `reminder_whatsapp` for a booking that can still be reminded.
- **Cloud**: migration `016_reservation_reminders.sql` (two nullable columns on `reservations`; the privileges of migration 014 are
  table-level, so they cover them), pushed in `reservationRow` and restored in `pullReservations`, so a replacement laptop that restores
  the diary does not offer to remind everybody a second time.
- **Bookings tab** (`src/admin/BookingsTab.jsx`): a "Reminders to send (n)" section, shown only when someone is due, each row with the day
  and time, a WhatsApp link that already carries the reminder, a number to ring and **"I sent it"**; a "Reminded 10:05 · name" badge on the
  diary row with **"Not sent"** to take it back. The reminders are read independently of the diary: if they cannot be read the diary still
  shows and the section is simply not offered.
- Opening the link is not sending. Nothing is recorded until a person says so.

## TESTS
- `reservationReminders.test.mjs` (18): the window and its edges (a booking at exactly now is under way, not a reminder), the
  statuses, no number, a silly window, a window as text from a query string, marking (when, who, trimmed, twice, refused, undone), the
  marks surviving a write to disk, the message; and on real hubs the list with a link that carries the **reminder** not the
  confirmation, marking taking it off the list and showing on the diary row, undo, the refusals, and a handset getting `RECEPTION_ONLY`
  on all three routes.
- `cloudRoundTrip.test.mjs`: a reminded booking goes to the real database engine and comes back identical.
- `BookingsTab.test.jsx` (7 new): no empty box, the list, "I sent it" and that opening the link is not sending, a refused mark said in the
  hub's words, the badge and undo, no undo for a cancelled booking, and the diary surviving an unreadable reminders list.

**Mutation check:** 35 on the hub (rules, window and its edges, the sort, each filter condition, the message, the routes' guards and
mapping, the cloud row and restore, the store) and 18 on the tab. First pass left three on the hub: a booking at exactly the moment (an
edge, now pinned), a redundant string check in the window parsing (simplified, and a numeric string now explicitly accepted), and a
redundant status mapping (removed). All caught afterwards; 18 of 18 on the tab.

## COUNTS
Hub **1315 passing** across 66 files (1297 before); frontend **858** (851); build clean.

## NOT DONE
- A reminder is never sent by the product. A person always presses send in WhatsApp.
- "I sent it" is a person's word: the hub cannot know the message arrived or was read.
- The tab does not ask who is pressing, so `reminded_by` is only filled by the API; the reception UI records when, not who. (There is no
  signed-in staff identity at the reception laptop to take it from; that is the manager-PIN question again.)
- Only bookings are reminded, not walk-ins in the queue (they are standing at the door).
- Migration 016 has not run on a hosted project, like 004 to 015; it has run on the real Postgres engine in the tests, twice.

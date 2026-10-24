# Changing a booking, or someone in the queue

**Date:** 2026-10-24T01:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.6 Reservations & waitlist: a booking could only be cancelled and taken again

---

## WHAT WAS MISSING

A guest rings to say they will be six, not four, or an hour later; or a note is wanted, or the number was wrong. The only way to do it was to cancel the
booking and take a new one, which throws away what has happened to the first (the reminder that was sent, the reward that was given) and, for a
guest, makes them a second booking in the book. Someone waiting in the queue had no way to be given a new wait at all.

## THE RULES, AND WHY

- **A change that could cost a table is checked exactly as taking the booking was.** A different time, a bigger party or a longer stay goes through the
  same check against the real table layout and the walk-ins already sitting down, **without counting the booking against itself** (moving it half an hour
  does not clash with its own old slot). If there is no table it is refused with what is free, unless reception says it knows (`force`), and then it is
  recorded as an overbooking, as it would have been when taken.
- **A change that cannot cost a table is never asked about tables.** A name, a note or a number is changed on a full evening, on an evening that is already
  overbooked, and for a booking whose stay was never recorded. Nobody should be told "no table" for fixing a typo.
- **A guest who is late is not refused for being late.** Only a time that is being *set* has to be real, in the future and not too far ahead. A note on a
  booking whose time has passed by ten minutes goes through.
- **Moving a booking forgets that a reminder was sent**, because it was for the old time; the guest is due one again. A note or a name does not.
  Everything else that happened to the booking is kept: who it is, the reward, when it was made.
- **Only what a person may change is changed**: name, number, party, time, stay, note (and, in the queue, the wait they were told). Not the status, the id, when it
  was made or seated, the reward, or the overbooked mark; a forged field in the request is ignored.
- **Changing something to what it already is changes nothing**, not even the revision, and says so (`unchanged`).
- **In the queue**, a party keeps its place (when they joined is not touched). A number given later is stored like any other; a number can be taken off
  (by `''` or `null`), but not off someone who has already been messaged, whose number is how they were told. A wait taken back arrives as `null` or as nothing
  and means "no wait quoted", not "a wait of no minutes".

`PUT /admin/bookings/:id` and `PUT /admin/waitlist/:id`, reception only; the answer is the booking or the queue entry as it now is, with its WhatsApp and
tel links, and, for a booking whose change could have cost a table, what is free.

## TESTS

`reservationEdits.test.mjs`: **43 tests**, written first and shown failing before any rule existed: the pure rules for a booking and for the queue (the table check, a
change that is not one, lateness, reminders, rewards, the allow-list, bad input said by field, a patch that is not an object), the diary on disk with walk-ins
sitting down, and a real hub (the routes, `force` only when it is a plain `true`, 404/409/400/403, a waiter's handset refused). One more in `reservationSync.test.mjs`:
an edited booking and an edited queue entry reach the cloud in place, with only the columns the cloud has, and come back from it as edited.

## MUTATION CHECKS

108 mutants over the rules, the diary and the two routes. **93 were caught on the first pass; 15 survived.** What each was:

| Survivors | What they were | What was done |
| --- | --- | --- |
| 8 | **real gaps in the tests**: a field present but `undefined` wiping what was there; properties a request merely *inherits* being read; a booking from before stays were recorded being taken for a longer stay by a name change; walk-ins sitting down not counting when a booking is moved (in the rules, and again in the diary's wiring); the two refusal messages; who sent a reminder being lost by a change that is not a move; `null` as a way to take a number off | a test for each (8 tests); all caught on the re-run |
| 4 | **redundant code**: a guard in `pick` that `hasOwnProperty` already makes unnecessary (two mutants of it), and `?? ''` on a note that both validators already read as empty (two) | removed; the code is shorter and behaves as before |
| 2 | **equivalent, kept**: adding `status` to the list of fields a change may carry. The list is the first of two things that keep a forged status out; the second (the stored row is built from the old row and the validated fields, never from the request) is what holds, so the first cannot be seen from outside | the property itself is pinned end to end by *only what a person may change is changed*; kept as defence in depth |
| 1 | **my mutation spec's own whitespace edit** (a blank line removed), not a behaviour change | dropped |

Re-run on the changed code: 18 targeted mutants (13 caught; the 2 equivalents above survive as expected; 3 did not apply because of a mistake in my anchors), then the 3 again with
the right anchors, plus 2 more for the messages: **5 of 5 caught**.

## WHAT THE WORK FOUND

- `Number(null)` is `0`: a wait taken back as `null` was a wait of no minutes. It is now said as "no wait".
- A mutation string of mine matched the first of three identical `{ force: … }` lines, which is the manual booking route, not this one: three survivors that were not survivors. Anchors are now long enough to be unique.

## NOT DONE

- **The Bookings tab has no "Change" buttons.** The rules, the routes and the diary are built and tested; no screen calls them yet. That is the next piece, and the
  only way a person can use any of this.
- **A queue note is not copied to the cloud** (the cloud's `walkins` table has no such column; it never had). A replacement laptop gets the queue back without notes. This was so
  before changes existed; it is now more visible because a note can be added later.
- Nothing has run against a real cloud; there is no new migration, and a change reaches the cloud by the same push as any other.

Status: ✅ VERIFIED at the rules, the routes and the push; ⬜ no screen yet.

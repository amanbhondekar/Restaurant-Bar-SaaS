# Kitchen Display: the whole component tested as it renders, and a bill that could vanish

**Date:** 2026-10-23T13:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The first two slices lifted the pure logic (billing, the board and the connection light) out of `src/kitchen_main.jsx`. What was left
was the rendering and the modals: the ticket cards, the station tabs, held courses, and the bill from preview to paid, split, voided
and refunded. That is the screen reception actually uses to take money. It mounted itself on import, so it could not be rendered in a
test. Rather than split a 1,950-line component blind, the page now exports `KitchenHubApp` and only mounts when there is a `#root`, and
the tests render the real component against a fake hub and a fake socket, the way the waiter app is tested.

## WHAT IS TESTED (`src/test/kitchen/KitchenDisplay.test.jsx`, 48 tests)
- **The board:** pairing name and code, the QR and enrolment code, tickets with lines, notes and waiter, the counters; "Tick All" until
  every line is ticked, then "Mark Ready", which moves the ticket to Ready to Serve; un-ticking; Recall; a ticket with no table has a
  disabled Bill button.
- **Station screens:** a station tab shows only its lines and counts; "Bar ready" posts to that station; the choice is remembered and
  put in the address; `?station=bar` starts on the bar.
- **Courses:** what is on hold, Fire only on the all-stations view, a hub refusal shown and the board re-read, an unreachable hub.
- **The live feed:** a new order appears, a cancelled one goes, a cleared table re-reads, an order is never shown twice, a station
  update merges without a re-read, the sync badge (queued, synced, local only).
- **The connection light** with a fake clock: connecting, active, still "connecting" for a first failure, red after a second or after
  the grace period, recovering when it reconnects; the ten-second fallback poll.
- **The bill:** the preview (lines, tax, grand total, nothing issued); the hub's own words when there is no bill or it is unreachable;
  a percentage or flat discount and a service charge (including 0 = waive) sent to the hub to be priced; Close Bill sends the same
  adjustments, or an empty body; a refused close stays open with the reason; paying with each method and a trimmed reference; a
  refused payment; split by seats, settling one share (with or without a reference), undo split; custom amounts (seeded equal, Apply
  waits for a total that adds up, sent as typed); by items (every line starts on split 1, an empty split is refused, the assignment
  is what is sent); void and refund with a required reason (blank or cancelled sends nothing; a refusal shows the hub's reason);
  print receipt (preview or printer error).

## A REAL BUG, FOUND BY THE TESTS
The page recalculates the bill preview a fifth of a second after the last keystroke in the discount box. If reception typed a
discount and pressed **Close Bill** inside that window, the bill was issued, and then the delayed recalculation ran against a table
that no longer had open tickets. The hub answered "no open tickets", and the page replaced the issued invoice with an error. The
invoice existed in the hub, but the screen showed no invoice number and no payment buttons, which invites closing it again.
A test written first reproduced it on the old code. An issued bill (it has an invoice number) is now never recalculated.
Along the way I reasoned about the other order of events, a preview already in flight when Close is pressed, and found it cannot
happen: the Close button is disabled while a preview is loading. I had written guards for it and two tests to reach it; the tests could
not pass, which is how I found out, and both the guards and the tests are gone.

## MUTATION CHECK
33 mutations of the component (the tick gate, the ready and fire routing, the station-screen rules, every request body, trimming of
references and reasons, the void and refund prompts, the undo-split rule, receipt status, the poll interval, the remembered station,
the held-course buttons, the adjustment form shown only before issue, the refund button shown only when paid). 32 caught at first.
The survivor was real: nothing checked that a reference typed for a split share is sent. A test now does, and the mutant is caught.
The guard added for the bug above was checked on its own: its two parts are caught; I removed three further lines that mutation showed
were redundant (the effect already resets the flag when a bill is closed or a new one opened).

## ONE FLAKE, ROOT-CAUSED
Two bill tests failed intermittently at first. They were not slow: they were waiting for text that never came, because the page asks
for the preview twice when a bill is opened (once on the click, once from the delayed effect), and the second answer could land over
a bill the test had just paid. The fix for the real bug above stops that, and the file has now run clean repeatedly. I also raised the
file's wait limit to four seconds (a render of the whole page under load is slow), which was not the cause but is a sensible margin.

## COUNTS
Frontend **841 passing** (793 before). Build clean. Hub unchanged at 1240.

## NOT DONE
- The page still asks for the preview twice on open (the click and the delayed effect). It is harmless now, but wasteful; folding them
  into one is a small follow-up.
- It is still one 1,950-line file. Splitting it into components can now be done with these tests as a net.
- The fix was proven by a test, not by pressing the buttons fast in a real browser: the timing is too tight to do by hand.
- The waiter's QR scanner needs a camera, and nothing drives a real browser in CI.

# Kitchen Display: the billing logic lifted out and tested

**Date:** 2026-10-23T05:45:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
`src/kitchen_main.jsx` is the page the hub serves at `/`: the ticket board, and the bill and its splits. It is one component of
about 2,000 lines mixing a socket, state and rendering, and it had no tests because nothing in it could be reached without
rendering all of it. The roadmap said it had to be split first. This is the first slice: the parts that are plain functions and
that handle money.

## WHAT MOVED (`src/lib/kitchenBill.js`, 24 tests)
- `buildAdjustmentBody`: the adjustment form to the body the hub understands. A blank input means "no adjustment on this axis"; a
  service charge of 0 is an explicit "waive it"; a blank, zero, negative or non-numeric discount adds none.
- `equalSplitRows`: the seed for "split by custom amounts". Equal shares that add up to the bill **exactly**, with the odd units to
  the first rows. A bill in whole rupees is split in whole rupees (it matches the old arithmetic for every case I compared); a total
  with a fraction is split in paise so it cannot drift. Nothing to split for a bill of nothing or a party that is not a whole number
  of people.
- `amountSplitPayload`, `itemSplitPayload`, `initialItemAssignments`: the requests for the two kinds of split. A line assigned to a
  split that does not exist ends up in none (the hub then refuses a split that does not cover the bill), never quietly under another.
- `ticketKey`, `mergeTicketInto`: the id a ticket is called by (escaped for a path), and merging the hub's copy of a ticket into the
  board without adding one the board is not showing.

The component now calls these; it is 44 lines shorter and behaves the same. Nothing here is a wrong-bill risk on its own (the hub
re-validates every discount and split), but each is how a person's intent becomes a request.

## A WRONG TURN, CAUGHT BY A TEST I WROTE FIRST
My first `equalSplitRows` always worked in paise, which turns a 497 bill into 248.50 each. It adds up, but it is not what the screen
showed (249 and 248) and nobody hands over 248.50 in cash. The test comparing it with the old arithmetic failed; the fix is to count
in rupees when the total is a whole number and in paise only when it has a fraction. I also checked first whether the old arithmetic
was actually wrong: the hub rounds every grand total to a whole rupee, so it was not.

## CHECKED IN A REAL BROWSER
A scratch hub (its own data directory, on port 4000 because that page hardcodes it) with a real three-dish order on a table: the bill
opens at 1764; a 10% discount recalculates through the new function to 1588; closing the bill and choosing custom amounts seeds 794 +
794 against a 1588 target ("Balanced") and applies; "Undo split" removes it; "By items" starts with every line on split 1 (and says a
split with nothing in it is not allowed), moving the third dish to split 2 applies as 624 + 964 = 1588. The scratch server was stopped
and the launch config restored.

## MUTATION CHECK
19 mutations of the module: 17 caught. The two survivors are equivalent for real form values (a blank discount already fails the
`> 0` test, and a service charge typed as `'0'` is a truthy string).

## COUNTS
Frontend **772 passing** (748 before). Build clean. Hub unchanged at 1208.

## NOT DONE
The rest of `kitchen_main.jsx`: the socket and its reconnect logic, the ticket board and station filter, the pairing QR, and the modals
are still one component and still verified by hand. The next slice would be the socket and the board (the same kind of lift the
waiter app's connection handling got tests for), then the modals. The waiter's QR scanner needs a camera and is untested, and nothing
drives a real browser in CI.

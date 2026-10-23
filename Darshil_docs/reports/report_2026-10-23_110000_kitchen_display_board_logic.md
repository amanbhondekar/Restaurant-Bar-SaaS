# Kitchen Display: the board and the connection light lifted out and tested

**Date:** 2026-10-23T11:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The first slice of `src/kitchen_main.jsx` (the billing logic) left the half that matters while the restaurant is open: what each
live message from the hub does to the tickets on screen. That was a 40-line `if / else if` chain inside a socket callback inside a
`useEffect`, with no way to run it short of opening the page. It decides whether a new order shows up, whether a cancelled one
comes off, and when the screen says the hub is gone. A mistake there is a kitchen cooking from a board that is wrong.

## WHAT MOVED (`src/lib/kitchenBoard.js`, 21 tests)
- `applyLiveMessage(tickets, message)` returns `{ tickets, refetch, sync }`:
  - a new order goes to the top, and is not added twice (the hub sends both `NEW_ORDER` and `order_created` for one order; a ticket is
    recognised by id, or by number even when the number arrives as text); one with neither an id nor a number is ignored;
  - `TICKET_READY` / `order_ready` marks the named ticket ready (matched by id or number) and takes the hub's whole ticket when it
    sent one, so course and station state are current; an old-style event naming only the ticket still works; one naming nobody does nothing;
  - `TICKET_UPDATED` replaces the ticket with the hub's copy, matched by id, and does not add a ticket the screen is not showing;
  - `TICKET_CANCELLED` takes it off at once and asks for a re-read; `CLEAR_TABLE` / `bill_cleared` / `order_cleared` ask for a re-read;
  - `SYNC_STATUS_CHANGE` hands back the status to show and asks for a re-read;
  - anything it does not know, no message, no payload: the board is untouched.
- `markedReady(tickets, ticket, reply)`: the board after the hub accepted "mark ready".
- `statusAfterClose` and `statusAfterGrace`: a socket that closes in the first seconds after the page opens reads "connecting" rather
  than red, unless it has already failed twice; after that a close is red at once.

The component now calls these. The socket handler reads the board from a ref (it outlives any one render), and the connection light
uses the two functions. The behaviour is meant to be identical, and the inline code's quirks were kept rather than tidied (for example
a ticket with no number matching another with none).

## CHECKED IN A REAL BROWSER
A scratch hub (its own data directory, on :4000 because the page hardcodes that port), the Kitchen Display open, and a script playing
the waiter and the station from outside:
- two orders placed: both appeared on the board at once, newest first (#102, #101), before the page's 10-second poll could have fired;
- #101 marked ready and #102 cancelled: #102 left, #101 moved to "Ready to Serve (1)";
- table 1 billed and cleared: "Ready to Serve" went to 0 and the board to "Kitchen Rail Clear";
- the hub stopped: the badge changed to "LAN Disconnected" within five seconds.
(One screenshot taken right after the clear still showed the old frame; the pane lags a few seconds after a write, as noted before. The
DOM read and a second screenshot agreed with the hub.) The scratch hub was stopped and the launch config restored.

## MUTATION CHECK
25 mutations of the module (every case label dropped, each guard removed, the order of insertion flipped, id-only matching, number
matching without the string conversion, losing the hub's ticket on ready, each refetch flag and the sync value, each threshold in the
connection light). 24 caught. The survivor is equivalent: dropping the "no ticket" guard on `TICKET_UPDATED` still returns the board
unchanged because `mergeTicketInto` already ignores a missing ticket.

## COUNTS
Frontend **793 passing** (772 before). Build clean. Hub unchanged at 1240. `kitchen_main.jsx` is 1,953 lines (was 1,991).

## ALSO IN THIS STRETCH
The first push of the money-route and live-feed commits failed CI on Node 22 in `reservationSync.test.mjs`: its cleanup removed the
temp directory while the sync queue was still writing its journal into it (ENOTEMPTY). It passed on Node 20 and locally. The hook now
awaits the queue's write chain first, as the queue tests do. Both jobs are green on the pushed head.

## NOT DONE
The rest of the component is still untested: the modals (bill preview, split, receipt), the ticket cards and station filter
rendering, and the pairing QR. Those need rendering tests rather than pure functions, and the component does not export itself
(it mounts on import), so the next step is to split the render into components before testing it. The waiter's QR scanner needs a
camera, and nothing drives a real browser in CI.

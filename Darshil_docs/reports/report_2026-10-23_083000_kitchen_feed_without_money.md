# The kitchen is told the board, not the bill

**Date:** 2026-10-23T08:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
Roadmap §4.7 carried an open item: "the live feed still carries table totals to a kitchen token". A station tablet is enrolled with
the narrow `kitchen` scope precisely because it is the device most likely to be mishandled (propped on a pass, wiped by a cook,
borrowed). Every HTTP route already refuses it except five. But the live feed (`/live`) accepted the token and then sent that
connection **every event the hub broadcasts**, and the tickets in those events, and the tickets the kitchen routes answered with,
all carried the order total and each line's price.

What a kitchen token was told that it had no use for: every `INVOICE_ISSUED` / `PAID` / `VOIDED` / `REFUNDED` / `SPLIT` (with
invoice numbers and grand totals), `CLEAR_TABLE` with the amount, `RECONCILIATION_CLOSED` (cash-up figures), `SYNC_STATUS_CHANGE`,
`FEEDBACK_RECEIVED`, `STOCK_CHANGED`, and on connecting the whole menu with prices and the table layout.

## WHAT CHANGED
- `hub_server/lib/liveFeed.js` (new, pure): `feedFor(scope, type, payload)` decides what a connection is sent.
  - A `full` connection (a handset, or the reception laptop) is sent everything untouched, as before.
  - A `kitchen` connection is sent only the events in `KITCHEN_EVENTS`: the ticket events (`NEW_ORDER`, `order_created`,
    `TICKET_UPDATED`, `COURSE_FIRED`, `STATION_READY`, `TICKET_RECALLED`, `TICKET_READY`, `order_ready`, `TICKET_CANCELLED`) and the
    three table-cleared events, so the board still empties when a table is billed. Those payloads have the total, each line's price,
    each extra's price, the invoice number and the grand total taken off; the hub's own ticket is never mutated.
  - **Default-deny**: an event type nobody has listed, and any unknown scope, is sent nothing. A new event added to the hub tells a
    kitchen nothing until someone decides it should.
  - `connectedFor` slims the greeting for a kitchen connection to who it is connected to and how many tickets are open.
  - `withoutMoney(ticket)` is the same stripping, used for HTTP.
- `server.js`: the scope is worked out once, when the socket upgrades (loopback is `full`, otherwise the token's scope), kept on the
  connection, and `broadcast` builds one message per scope however many screens are connected. `/orders/active` and the answers of
  `/orders/:id/ready`, `/stations/:station/ready`, `/fire` and `/recall` strip prices when the caller is a kitchen token. The station
  screen reads no price anywhere (searched `src/station` and `src/lib/ticketView.js`), so nothing it shows changes.

## TESTS (`hub_server/test/liveFeed.test.mjs`, 13)
Written first. The 9 unit tests pass against the new module; the two real-hub tests failed against the old wiring (a kitchen socket
heard `INVOICE_ISSUED`) and pass now.
- unit: money off a ticket and nothing else changes; odd or missing tickets pass through; full is untouched; every kitchen event
  loses its money and the set is exactly the list above; the table-cleared notice is reduced to which table; no bill, sync, stock,
  menu, feedback, cash-up or pairing event reaches a kitchen connection; unknown events and unknown scopes get nothing; the greeting.
- real hub, two sockets side by side: a handset socket and a `kitchen`-scope socket on one hub while a handset takes an order, a
  station marks it ready, and the table is billed. The handset hears the bill (grand total 210) and the order total (200). The kitchen
  socket hears the order, the ready, and the table cleared, and the whole transcript it received contains none of `grand_total`,
  `invoice_number`, `total_amount`, `price`, `price_delta`, no `INVOICE_*`, no sync status, and a greeting without menu, layout or sync.
- real hub, HTTP: `/orders/active`, mark ready, station ready, recall and fire answer a kitchen token without prices and with the
  lines, quantities and station intact; the same `/orders/active` still gives a handset prices; the reception laptop's own display
  still gets full tickets.

**Mutation check:** 19 mutations (each allow-list condition, each stripped key, the ticket-inside-payload strip, the greeting, the full
passthrough, the scope stored on the connection and at upgrade, the loopback rule, the per-scope message choice, and each of the five
REST answers). The first run left one alive, the `/orders/:id/ready` answer, and a missing course-fire case; both tests were added and
all 19 are now caught.

## COUNTS
Hub **1240 passing** across 63 files (1227 before). Frontend unchanged at 772. A full-suite run once failed `spawnHub.test.mjs` (a
test that deliberately provokes a port clash); it passes alone and the next full run passed.

## NOT DONE, STATED PLAINLY
- It limits what a mishandled tablet is told. The scope is still the device's own choice at enrolment, so it is not a barrier against
  anyone who holds the enrolment code (unchanged, and noted in §4.7).
- A kitchen token still gets the dish names, quantities, notes, table names and the waiter's name: that is the job.
- Not checked in a real browser: the change is on the wire and the station screen reads none of the removed fields, so the real-hub
  socket test is the verification; a browser run of the station screen against a scratch hub is cheap if you want one.

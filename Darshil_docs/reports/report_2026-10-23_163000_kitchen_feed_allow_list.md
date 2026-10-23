# The kitchen feed narrows tickets by an allow-list

**Date:** 2026-10-23T16:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The first version of the kitchen narrowing (the report "the kitchen is told the board, not the bill") took the order total, each
line's price and each extra's price **off** a ticket and sent the rest. That protects against the fields we thought of. The ticket
has others (`stock_used`, the tenant id, the request id, the sync flag), and any field added later, a guest's phone number, a payment
reference, a discount, would have flowed to every kitchen token automatically. For the one device scope that exists because the device
is the likeliest to be mishandled, the safe default is the other way round.

## WHAT CHANGED (`hub_server/lib/liveFeed.js`, `server.js`)
Default-deny at every level, for a kitchen connection and for the kitchen routes' answers (`/orders/active`, mark ready, station ready,
fire, recall):
- an event reaches a kitchen only if it is in `KITCHEN_EVENTS` (as before);
- within an event, only `EVENT_FIELDS` (which ticket and table, what happened, the lines and the ticket);
- within a ticket, only `TICKET_FIELDS`: what the station screens and the board read (id, number, table, status, note, waiter,
  lines, course state, times, the cancellation);
- within a line, `ITEM_FIELDS`; within an extra, `MODIFIER_FIELDS` (ids and labels, never the price).
`withoutMoney` is gone; `kitchenTicket` replaces it. A payload that **is** a ticket (NEW_ORDER sends one) is narrowed as a ticket;
one that is an event around a ticket is narrowed as an event. The fields were chosen from what `src/station`, `src/lib/ticketView.js` and
the board actually read (checked with a search, not remembered).

## TESTS (`liveFeed.test.mjs`, 18, five more)
A field nobody listed (guest phone, payment reference, discount, tenant and request ids, stock used, and on a line: cost, margin, an
internal note) never reaches a kitchen; what a screen draws is kept exactly (course state, cancellation, waiter, times, every line detail);
an event key nobody listed is dropped; NEW_ORDER keeps the id, number, table and status the board finds it by; malformed items are
dropped rather than passed through; and on a real hub a kitchen token reading `/orders/active` gets no `restaurant_id`,
`order_request_id`, `synced_to_cloud` or `stock_used` while a handset still gets the whole ticket.

**Mutation check:** 28 mutations (each field dropped from each list, money and internals added to each list, each branch of the
payload and the items handling, the server's use of it two ways). 25 caught first time. The three survivors: one was **real and
serious**: if a NEW_ORDER payload were treated as an ordinary event its `id` would be dropped and the station board would ignore
new orders, and the test only checked what had been removed, not that the essentials survived; the other two were an event with both an
id and a ticket, and non-list items on an event. All three now have tests and are caught.

## COUNTS
Hub **1297 passing** across 65 files (1292 before).

## NOT DONE
- A kitchen token still sees dish names, quantities, notes, table names and the waiter's name. That is the job.
- The lists are maintained by hand: a station screen that starts to draw a new field needs it added to `TICKET_FIELDS` or it will
  silently not appear. That is the cost of default-deny, and the real-hub test of the board fails loudly if an essential field goes.

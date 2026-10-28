# Waiter order drawer: a retry could make a second ticket

**Date:** 2026-10-22T22:05:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## THE BUG
The hub remembers an `order_request_id` for 60 seconds and answers a repeat with the ticket it already made
(`recentRequests` in `server.js`). That exists for exactly one case: a waiter on flaky WiFi whose reply was lost. The
order may well have been made; tapping Send again must not make it twice.

The drawer defeated it. Every tap of Send minted a **new** id, so after "Hub unreachable at … Check WiFi network." the
natural next move, tapping again, sent the same order under a different id, and the kitchen got two tickets (two sets of
food, two lines on the bill, the stock taken twice). The hub only records an id after it has made the ticket, so a refused
order (out of stock, bad item) is never remembered and is safe to resend under the same id.

## THE FIX
An order keeps its id until it is answered. The drawer remembers the last unanswered order (the id and the order it was
for); a retry of the **same** order, same table, lines, note and course setting, carries the same id, and anything
changed since is a different order and gets a new one. A successful send retires the id. Hub-side the 60-second window
is unchanged, so a retry after a minute is treated as new, which is the hub's limit and not something this page can fix.

## TESTS (`OrderDraftDrawer.test.jsx`, 30)
Written first: the retry test failed on the old code (a different id on the second attempt) and passes now. The rest pin
the screen the waiter sends orders from, which had no tests:
- before an order: no table, empty draft, nothing to send;
- the draft: quantities, line prices for the quantity, pieces, total; a size, a part-of-day label; modifiers (a choice with
  no price by its group, an extra with its price for the quantity, a discount as one); remove-one; clearing asks first;
- what is sent: the table, the lines, the note trimmed; a size by id and a modifier **by its two ids only** (the hub
  prices from its own menu), no variant or modifier keys for a plain dish; who took it, with a fallback; the hub address
  without a trailing slash, and this machine when none is given;
- courses: offered only when the order spans more than one (a dish with no course is course 1); "the rest wait" for more
  than two; sent only when ticked and still applicable (a box ticked and then orphaned by a draft that has shrunk to one
  course sends nothing); unticked for the next order;
- after the hub answers: success clears the draft and the note and names the ticket, then the drawer returns; a refusal
  shows the hub's reason and keeps the draft and the note; an empty refusal and an unreachable hub are each reported,
  the latter with the address; the old error goes the moment the next attempt starts;
- when it must not send: no connection says so on a button that cannot be pressed; a second tap while one is in flight
  sends nothing more;
- retries: same id after a failure; new id after a success; new id for a changed draft, note or table.

## MUTATION CHECK
25 mutations of the drawer: 23 caught first time. Four survived: two were real gaps (a course flag orphaned by a shrunken
draft; a stale error staying on screen while a retry is in flight), now covered and caught; two are equivalent (the table id
in the retry key, because the table's name also changes with it, and the handler's guards, which duplicate the disabled
button). One mutant (trailing slash) could not be applied by the script and is covered by construction: without the
normalisation the request would go to `…:4000////orders`, which the fake hub has no route for.

## COUNTS
Frontend **667 passing** (637 before). Build clean. Hub unchanged.

## NOT DONE
The rest of the waiter app: the floor grid, the sign-in flow beyond what `WaiterLogin.test.jsx` covers, the QR scanner,
the connection and reconnect handling in `WaiterApp.jsx`, and the sent-orders list. The reception Kitchen Display, and a
Playwright run in a real browser, are also still verified by hand or not at all. A waiter whose reply was lost for longer
than the hub's 60-second memory can still double-order; closing that needs the hub to remember longer or to dedupe by
content, which is a hub change.

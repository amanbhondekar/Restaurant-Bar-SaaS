# Waiter app connection handling: tests, and three defects they found

**Date:** 2026-10-23T01:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHAT WAS UNTESTED
`WaiterApp.jsx` (about 890 lines) is how a handset keeps hold of the hub: the first look, the grace period before it says
"Off", recovery, being turned away, and the live socket that tells it a ticket is ready or an order has arrived. It had no
tests. It is covered now by rendering the real app against a fake hub, a fake clock and a fake socket, with a waiter already
signed in so the floor is what is on screen.

## THREE DEFECTS FOUND (each with the test written first, failing on the old code)
1. **A reconnect timer outlives the app.** When the socket closes the app schedules a reconnect four seconds later. If the
   app unmounts, or the hub's address changes, before that fires, the timer still ran `connectWs`, which opened a new socket
   that nothing ever closed. Fixed: `connectWs` returns if the effect has been cleaned up.
2. **Two reads of the floor could land out of order.** Every socket event starts a fresh read of the floor, so two can be on
   their way at once, and nothing says they arrive in the order they left. The older one, landing last, put the screen back as
   it was. Fixed: only the most recently *started* read is applied, and the bodies are parsed before that check, because
   parsing is itself asynchronous. (My first theory was worse and wrong: that a "bill ready" could be lost for good. Every event
   also re-reads the floor, so the hub's answer wins in the end. The real risk is a wrong screen for as long as a stale read
   takes to land, and I rewrote the fix once I saw that.)
3. **Every new order showed double its total for a moment.** The hub announces each order twice (`NEW_ORDER` and
   `order_created`), and the handler added the order's total to the table on each, while the orders *list* was already
   de-duplicated. The next read corrected it, so it flashed `₹480` for a `₹240` order. Fixed: an order is counted into a table's
   total once, and orders the floor read already includes are not counted again by their event.

## TESTS (`WaiterApp.connection.test.jsx`, 26)
Reaching the hub (LAN, the floor filled from it, the five-second check that does not re-read the floor each time); going quiet
(the grace period and two failures before "Off" at start-up, one missed check being enough afterwards, coming back by itself and
re-reading the floor, a miss forgiven the moment the hub answers); being turned away (never enrolled, a kitchen-screen tablet,
403 and 401 on the floor, 401 on the orders, and a handset with a token not turned away on the pairing answer alone); the live
socket (right address, reads the floor on open, a ready ticket, a new order and its total, the same order twice, a ready table
staying ready, clearing a table including its total and time, junk messages ignored, reconnect after exactly four seconds, no
new socket after the app goes away, each event starting a fresh read, older reads ignored).

Because each event starts a read and the hub's answer wins, the event tests hold that read open so they see what the event
itself did, then release it and check the hub has the last word.

## MUTATION CHECK
22 mutations of the connection logic: 21 caught. The survivor is the edge where two failed checks land inside the three-second
grace window and the end of the window then marks Off; it needs a second check inside that window, which I could not provoke
without driving the pairing screen. An earlier survivor (the active-orders list de-duplication) was a real gap and is covered.

## COUNTS
Frontend **724 passing** (698 before). Build clean. Hub unchanged at 1143.

## NOT DONE
The QR scanner (it needs a camera) is still verified by hand, as is the reception Kitchen Display, and nothing drives a real
browser in CI.

# Waiter floor grid: tests, and a draft badge that was never drawn

**Date:** 2026-10-23T00:20:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## THE BUG
Each table card on the waiter's floor is meant to show a small badge with how many pieces are sitting in that table's
draft, so a waiter can see at a glance which tables have an order half-built. The grid computed it as

    Object.values(drafts[t.id]).reduce((s, q) => s + q, 0)

but `drafts[tableId]` maps a line key to the **row** (`{ item_id, name, price, qty, ... }`), not to a number. Adding objects
produces the string `"0[object Object]"`, and `"0[object Object]" > 0` is false, so **the badge was never drawn**. No error,
no warning, just a feature that did not exist. It will have stopped working when draft lines changed from quantities to rows
(variants and modifiers), and nothing noticed because the screen had no tests.

## THE FIX
Add up each row's `qty` (a missing or non-numeric quantity counts as 0). Test first: it failed on the old code (no badge) and
passes now.

## TESTS (`FloorGrid.test.jsx`, 20)
- Each table with its capacity and state (Open, Dining, In Kitchen, Bill Ready); a state it does not know reads as open;
  tapping selects, the selected one is marked; an open bill's total and the time seated ("Just in", "25m"), and nothing for an
  empty bill.
- The draft badge: quantities added up across lines, nothing for no draft or an emptied one, a line that lost its quantity
  ignored rather than NaN.
- Sections: All plus each section the tables use, filtering, the hub's own section list (including an empty section just
  added), "no tables in this section" without a connect button, and a section removed while selected falling back to All.
- Empty states: a handset that is not enrolled, a hub that refused the token even though the handset thinks it is enrolled,
  a hub that cannot be reached, no button when there is nothing to open, and placeholders (not a message) while loading.
- Clearing a settled bill: offered only on a ready table, asks first and does nothing on no, clears that table on yes without
  also selecting it, shows "Clearing…" and cannot be started twice, and comes back afterwards.

I dropped one test I wrote for a clear that fails: the real handler in `WaiterApp` catches its own errors, so a rejecting
prop is not a case that happens.

## MUTATION CHECK
16 mutations, 15 caught. The survivor is equivalent: ignoring a second tap while a clear is in flight is guarded twice, by the
state check and by the button being disabled. Two earlier survivors were real gaps (the loading test never checked that the
grid itself shows the skeleton, and a zero total was not covered) and are closed.

## COUNTS
Frontend **698 passing** (678 before). Build clean. Hub unchanged at 1143.

## NOT DONE
The QR scanner (needs a camera) and `WaiterApp`'s connection handling (a socket, polling and reconnects in one 888-line
component) are still verified by hand, and nothing drives a real browser in CI.

# Cancelling an order, and what happens to the ingredients

**Date:** 2026-10-22T18:16:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Inventory limits" — "a cancelled order does not return stock"

---

## WHY

The roadmap said a cancelled order did not return its stock. It was describing a feature that did not exist:
there was **no way to cancel an order at all**. A ticket could be marked ready, fired, recalled and cleared
(at billing), never withdrawn. A waiter who rang in the wrong table, or a guest who left, left a ticket
cooking, on the bill, and out of stock.

The open question was policy: a cancelled order may already be cooking. That is decided here, once, and the
screen says it **before** the tap rather than after.

## THE POLICY

> **Before anything has been cooked, the ingredients go back on the shelf. Once any of it has been made, they
> stay consumed — the food exists — and the ticket records that it was cancelled after cooking.**

"Cooked" is any of: a station reported its part ready; the whole ticket was marked ready; or it was ready once
and recalled (made, and being made again). A **billed** order cannot be cancelled: it is reversed by voiding
the bill, and the hub says so. Nothing is cancelled twice.

## WHAT

### Hub

- **`POST /orders/:id/cancel`** `{ reason, by }` — full-scope devices and reception only. A screen at the pass
  marks tickets done; it does not withdraw them (default-deny already keeps it out, and a test now pins it).
  Answers `{ ticket, cooked, stock_returned }`. 404 for an unknown order, 409 `TICKET_CLOSED` (billed) or
  `ALREADY_CANCELLED`.
- **`lib/courses.js`:** `anyCooked` and `cancelTicket` (pure). The ticket keeps `cancelled_at`, a reason capped
  at 140 characters, who cancelled it, and `cancel_cooked`.
- **Stock goes back by what *that order took*, not by today's recipe.** Every order now records what it
  consumed (`stock_used`) at the moment it takes it. A recipe may have changed since, and returning a different
  amount than was taken would quietly corrupt the count. The return is a new movement kind (`return`), so
  history reads *sale −40 · return +40 · "order cancelled"*. An ingredient deleted in the meantime is skipped.
  A ticket from before this existed has no record, cancels, and says nothing came back — no false promise.
- **A stock write can never undo a cancellation** the kitchen has already been told about.
- **The cloud is told** (`orders.status = 'cancelled'`, which the base schema's CHECK already allows), aimed at
  the order by its request id — the fix from the billing-replication report.
- **Every screen drops it:** `TICKET_CANCELLED` is broadcast and handled by the station board, the Kitchen
  Display, the waiter handset (which re-reads which tables are still busy) and the dashboard. A cancelled order
  is off `/orders/active`, off the table's bill preview, and its table reads free again if it was the only one.

### Screens

- **Reception — Kitchen tab, "Open orders":** the board's orders, oldest first (the one most likely to be
  stuck), with table, items, age and who took it. Cancel asks, **says what will happen to the ingredients for
  that order**, takes a reason (a short list or its own words — an empty one cannot be sent), and afterwards
  reports what the hub *actually* did.
- **Waiter handset — "Sent orders" under the floor grid** for the selected table, with an inline confirm that
  says the same thing. The result survives the order leaving the list.

## TESTS

- **Hub `orderCancel.test.mjs` (22):** the rule (cooked / not, incl. recalled and legacy-ready tickets);
  caps; `restock` returns exactly what was taken and skips a deleted ingredient; a real hub — every ingredient
  back for an uncooked order **including an extra's**, nothing back once cooked, ready counts as cooked, **the
  original amounts come back even after the recipe changed**, twice returns once, unknown 404, billed 409,
  **a cancelled order is not on the bill**, the table reads free, the **cloud queue holds a cancelled status
  against the order's request id**, the **live event** arrives, a pre-feature ticket cancels with nothing
  returned, and **a kitchen screen is refused (403) while a handset is allowed and the unenrolled get 401**.
- **Frontend `OpenOrders.test.jsx` (25):** the wording and the cooked rule (mirrors the hub), the reception
  panel (list, empty, unreachable, asks first, reason sent, custom reason, refusal kept, no double send), the
  waiter block, and the station board dropping a cancelled order.
- **Mutation-checked:** 12 on the hub, 15 on the screens. **One survived** (a ticket whose status says "ready"
  but whose course log does not — an older ticket — must count as cooked); a test now covers it. All others
  caught first time.
- **In a browser** against a scratch hub: an order with an extra took 40 g cheese / 0.6 kg rice; reception
  opened Cancel, read *"Nothing has been cooked yet, so its ingredients go back into stock"*, confirmed, and the
  board emptied; stock read exactly 10 kg / 200 g, and the history showed `return +40 #101 order cancelled`.

Full suites: hub `1016`, frontend `477`, build clean.

## WHAT IS NOT DONE

- **No partial cancellation.** The whole order goes; removing one line of a sent order is not offered.
- **No cancel on the Kitchen Display itself** (the reception laptop's board): reception cancels from the admin
  Kitchen tab. The display drops a cancelled order when told.
- **Waste is not recorded** for an order cancelled after cooking: the ingredients stay "used", which is what
  they are, but it is not entered as waste. Whether it should be is an accounting choice.
- The handset's cancel block is covered by component tests and by the hub's tests, not by a run of the waiter
  PWA itself.

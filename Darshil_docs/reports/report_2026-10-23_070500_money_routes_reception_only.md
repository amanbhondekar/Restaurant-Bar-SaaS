# Money decisions are reception's alone

**Date:** 2026-10-23T07:05:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The roadmap said roles were stored but nothing enforced them on the reception laptop, "anyone signed in can still void a bill".
Looking at the routes, the problem was wider than the laptop: the bill routes took `requireDevice`, which accepts **any enrolled
full-scope handset token**. So a waiter's phone, with the token it uses to take orders, could void a bill, refund it, mark it paid,
split it, and close a table with any discount.

## SHOWN BEFORE IT WAS FIXED
The test I wrote first closed a table from a handset with `{ discounts: [{ type: 'percent', value: 100, reason: 'friend' }] }`. On the
old code the hub answered 200 with an invoice whose grand total was **₹0**, and the table was cleared. The same handset could void
and refund that bill afterwards.

## WHAT CHANGED (`hub_server/server.js`)
- `POST /invoices/:id/void`, `/mark-paid`, `/refund`, `/split-by-seats`, `/split-by-items`, `/split-by-amounts`,
  `DELETE /invoices/:id/splits` and `POST /invoices/:id/splits/:index/mark-paid` now go through `requireReceptionFor(...)`: a handset
  gets `403 RECEPTION_ONLY`, naming the action ("Voiding a bill is only available on the reception laptop."). The check runs before
  the plan-feature gate, so a handset learns nothing about the plan or about which invoice ids exist.
- `POST /tables/:id/clear` stays open to handsets, because the waiter app's "Clear Bill" button uses it, but a request that sets the
  price is refused for a handset **before anything is billed or cleared**: any non-empty `discounts`, or any `service_charge_percent`
  (even one equal to the default, since "the same number" is not something the hub should have to guess about). An empty `discounts`
  list is not a discount and is let through. The refused attempt leaves the order on the board, and a plain close afterwards bills the
  full amount.
- Nothing the waiter app does is affected: it only calls `/tables/:id/clear`, with no body. The reception Kitchen Display
  (`src/kitchen_main.jsx`) calls the rest, from the laptop itself.

## TESTS
`hub_server/test/moneyRoutes.test.mjs`, 15 tests against a real hub of each kind (one that treats its loopback as the reception
laptop, one that does not, with an enrolled handset token on it):
- a handset can still close a table and read the bill;
- a handset gets `RECEPTION_ONLY` on void, mark-paid, refund, the three splits, undo split and settle share, and the bill is shown
  to be unchanged afterwards; an unknown bill id gets the same answer;
- a handset cannot close with a discount or with a service-charge override (two values), the table is not closed by the attempt, and an
  empty discount list is accepted;
- reception can close with a discount and an override and gets the right numbers (₹20 off, no service charge), and can settle, split,
  undo, void and refund, and split by amounts.

**Mutation check:** 11 mutations (each gate removed in turn, the "only if not reception" condition dropped and inverted, the
empty-list case, the service-charge half) and all 11 were caught.

## EXISTING TESTS THAT ENCODED THE OLD BEHAVIOUR
- `hub.test.mjs`: the "M1" billing tests (104 calls) drove void, settle, split and refund with a handset token. They now send their
  authenticated billing calls to the hub that acts as reception through a small `billApi` helper; the "requires auth" tests still go to
  the remote hub and still expect 401.
- `plans.test.mjs`: the plan gate for split-bill and refund was exercised as a handset. It now runs from a reception hub on the same
  degraded plan (a handset would be refused earlier, as `RECEPTION_ONLY`). Course firing, which a handset may still do, got its own
  test.

## COUNTS
Hub **1227 passing** across 62 files (1211 → 1227: the 15 new tests, plus the split plan test). Frontend unchanged at 772. One run of
the full suite failed `orderCancel`'s "cancellation is queued for the cloud against the order's own request id" (a 325 ms timing test)
and then passed on three further runs of the file and one of the whole suite; I did not touch that code and am treating it as a load
flake, not a fix.

## NOT DONE
This closes the hole at the handsets. It does not give the reception laptop roles: whoever is at that screen can still void, refund
or discount, with no manager PIN and no cashier/manager split. `waiterStore` already holds staff with roles, so a manager PIN on
void and refund is the next step, but it needs a decision on whether a refund should be blocked or merely recorded against a name.
Also unchanged: the reception check rests on the request arriving on loopback with a local Host/Origin, the same as every other
reception-only route, so a reception laptop opened by machine name rather than `localhost` or its LAN IP is refused too.

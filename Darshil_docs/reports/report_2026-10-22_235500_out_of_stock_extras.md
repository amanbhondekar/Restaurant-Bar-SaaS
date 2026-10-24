# Out-of-stock extras: said before the order, not after it

**Date:** 2026-10-22T23:55:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHAT WAS OPEN
Roadmap §3, "Inventory limits": when the cheese ran out, "extra cheese" still showed as pickable on the waiter's modifier
sheet and on the diner menu, and the order was refused afterwards, naming the ingredient. The diner menu already hid options
flagged `stock_out`, but nothing ever set the flag on an option.

## WHAT WAS DONE
**The hub's stock overlay flags extras** (`hub_server/lib/inventory.js`). An option inside a dish's modifier groups gets
`stock_out: true` when it cannot be had. The rules:
- **One portion is the test**, and where the dish and the extra use the same ingredient the two are added (10 g in the dish
  plus 20 g for the extra needs 30 g, not 20).
- **Identity is the group AND the option**: the spice group's `o_cheese` is not the extras group's.
- **An extra is out only when no size that can be ordered could take it.** A Half whose recipe does not use the cheese still
  offers the extra; the Full is refused with the ingredient named. A size reception has 86'd by hand cannot be ordered, so it
  does not keep an extra on offer.
- **A required choice left with nothing stock allows** (every option 86'd by hand or out of stock, at least one for stock)
  flags the dish as a whole, because nobody could finish the sheet. A required choice emptied by a hand 86 alone is reception's
  doing and is not claimed by stock, and an unrelated extra running out does not change that.
- `available` is never touched; an untouched menu is returned as the very same array.

**The waiter's sheet** greys the extra out with an OUT OF STOCK chip and the existing "the kitchen has run out of something
this needs" explanation, shows no price on it, and cannot pick it. It is told apart from an 86, and a hand 86 outranks it when
both hold, because that is the switch that needs undoing. **The diner menu** needed no change: it already hid flagged options.

## FOUND ON THE WAY (a bug this change would have introduced)
The store tells handsets to refresh the menu when `stockOutKeys` changes, and that set holds only dishes and sizes. An extra
running out moves no dish, so the menu would have changed on the hub with **no broadcast**, and waiters would have kept the
stale sheet until something else refreshed it. A new `stockSignature` (dish and size keys plus one entry per extra that is out)
is what the store compares now. Written first; the test failed on the code as it stood.

A smaller one: an old test asserted that the menu comes back "untouched" when only an extra is out. That was the behaviour
this change exists to replace, so it now asserts what it meant: the dish is not flagged and the extra is.

## TESTS
- `inventoryModifiers.test.mjs` (+16): the rules above, restocking clearing the flag, the stored menu never written to, a
  dish that is itself out keeping its flag with its extras flagged in the same pass, the required-choice cases, and on a real
  hub the menu showing `stock_out` on the option (not `available: false`) while the guest menu omits it and still offers the egg.
- `inventoryStore.test.mjs` (+1): handsets are told when an extra runs out, again when it is back, and not when a delivery
  changes nothing.
- `ModifierSheet.test.jsx` (+2): the chip, the disabled button, no price, the explanation, the running total unchanged; the
  other extras stay pickable; a hand 86 reads as 86 when both hold.
- Mutations: 15 on the hub logic and 5 on the sheet. All caught; two survivors on the way were an equivalent entry (a "blocked
  dish" signature entry that is redundant because the last option going out already changes the signature, removed rather than
  kept as dead code) and a real gap (an unrelated extra out while a required choice is entirely hand-86'd), now covered.

## COUNTS
Hub **1143 passing** (1126 before), frontend **678** (676 before), build clean. CI was green on the previous commit
(`66be377`, Node 20 and 22).

## NOT DONE
Not looked at in a real browser: the sheet is covered by component tests and the hub path by a real-hub test, but I did not
enrol a handset against a scratch hub and watch it. Migrations 009 and 012 are still unrun against a real project, and an
extra that is out for every size but whose required group still has options is the dish's own call, as before.

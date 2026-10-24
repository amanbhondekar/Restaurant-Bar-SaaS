# Costing, stock-up-to levels and the shopping list

**Date:** 2026-10-22T18:35:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Inventory limits" / §4.2 "Costing and par levels; reorder prompts"

---

## WHY

Stock told a restaurant what it had. It could not say what a dish *costs*, what to *buy*, or how much — the
three questions a kitchen actually asks of it. The roadmap listed all three as unbuilt, noting that par levels
needed "a decision about what *reorder up to* means". That decision is made here, in the plainest terms: each
ingredient may carry a **warning level** (already there), a **stock-up-to level** (what a delivery should bring
it back to), and a **cost per unit**. All three are optional, and a restaurant that sets none of them sees
nothing change.

## WHAT

### One principle: an unknown cost is not a small cost

`unit_cost` is `null` when it has not been entered, and `0` only when the ingredient is genuinely free. A dish
with an uncosted ingredient has an **unknown** cost, not a smaller one, so:

- the hub reports every recipe's cost as `{ cost, complete }`, and extras are costed **separately** — what a
  choice adds — and never folded into the dish;
- the screen says **"At least ₹27 a portion (some ingredients have no cost)"** and gives **no percentage**,
  because a food-cost share built on a missing cost would flatter the dish. A complete cost reads *"Costs ₹65 a
  portion · 25% of the ₹260 price"*. A dish with nothing costed says so, not "₹0".
- costs round to the paisa, so a chain of grams shows no floating-point dust.

### The shopping list

Everything at or below its warning level, **furthest below it first** (what is out is at 0% and leads). With a
stock-up-to level the suggestion is how much brings it back there (never negative); **without one the item is
still listed** — the warning was set — but **no quantity is invented**: it asks for a level. An estimated cost
appears only where there is both a quantity and a cost, and the total says **how many items it leaves out**, so it
is never mistaken for the whole bill.

A stock-up-to level must be **above** the warning level (or empty), whichever of the two is edited — otherwise the
list would ask for nothing.

### Screens (Stock tab)

- The ingredient form gains **Stock up to** and **Cost per {unit} (₹)**, labelled in the ingredient's own unit;
  emptying the cost on an edit sends `null`, which is how one is taken away.
- Each ingredient shows *"₹90 per kg · stocks up to 20 kg"*; each recipe shows its cost line.
- A third view, **Reorder (n)**, lists what to buy with **Copy list** and **Send on WhatsApp**: the list is written
  into a message and reception picks the supplier, the same click-to-chat approach as bookings — no provider,
  no number stored.

### The cloud copy — migration 012, and a safe way to not have run it

`012_inventory_costing.sql` adds `par` and `unit_cost` to `inventory_items` (additive, nullable, CHECK ≥ 0). The
hub pushes both as **explicit nulls** when unset (so an upsert can clear one). A project that has **not run 012**
must not lose stock replication over a cost, so a push that is refused for exactly those two columns is retried
without them, and a restore falls back to the older column list. Only a missing *pricing* column triggers this —
any other refusal still stops the push (a test pins that, including a column that merely contains the letters).
Until 012 runs, a replacement hub restored from the cloud gets its stock back without costs and levels; the
migration's header says so.

`cloud:check` and the contract test pick the new columns up from the SQL, so the "does the project have 012" question
is answered by the same tool as the rest.

## TESTS

- **Hub `inventoryCosting.test.mjs` (27):** figures optional and defaults unchanged; cost validation (≥ 0, 4
  decimals, null clears); **free ≠ uncosted**; the stock-up-to rule on add and on either edit; damaged figures on
  disk fall back; recipe cost complete / incomplete / extras separate / rounded; the list — what is on it, order,
  suggestions, no invented quantity, estimates only where priced, never negative, empty is not an error; **the
  cloud row and both fallbacks** (migrated, unmigrated push, unmigrated restore, the narrow trigger); migration
  012 adds exactly the two columns and both are optional; and a real hub end to end.
- **Frontend `InventoryCosting.test.jsx` (38):** parsing and wording, the form, the cost line, the shopping text
  and total, and the screen (figures shown, form sends them, refusals shown, Reorder view, WhatsApp link, copy and
  failed copy).
- **Mutation-checked:** 13 on the hub, 18 on the screens. **One survived** on the hub — and it was an
  *equivalent* mutant: an explicit "out first" rank was dead code, since an item with nothing on hand is already at
  0% of its warning level. The dead rank was removed instead of testing a no-op. All others caught first time.
- Existing tests updated only where they asserted whole shapes that now carry two more fields (the summary's
  `reorder` count, the ingredient payload, the cloud row).

Full suites: hub `1043`, frontend `515`, build clean.

## WHAT IS NOT DONE

- **Day-part and modifier prices are not in the food-cost share.** It compares cost to the dish's (or size's) base
  price; a happy-hour price would change the share.
- **No purchase-order or supplier records.** The list is a message, not a ledger; a delivery is still recorded the
  way it was.
- **Not run against a real project** — migration 012 included. `npm run cloud:check` will say whether it is there.

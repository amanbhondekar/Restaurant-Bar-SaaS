# M2 tail — stock, recipes and stock-driven 86'd (migration 009)

**Date:** 2026-10-19T23:45:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M2 · §4.2 Inventory & menu depth — `inventory_items` and `recipes` tables; 86'd propagation from stock-out

---

## WHY

Two roadmap items were open: the `inventory_items` / `recipes` tables, and "86'd-item propagation from
stock-out to the waiter menu grid (per-variant 86'd exists, but it is set by hand)". They are one
feature: you cannot propagate a stock-out until something knows what is in stock.

Today a kitchen that runs out of chicken finds out when a guest orders it. Reception 86s a dish by
hand, and has to remember to un-86 it when the delivery comes.

## WHAT

### The model (`hub_server/lib/inventory.js`, pure)

- **Ingredients**: a name, **one unit** (`g`, `kg`, `ml`, `l`, `pcs`), how much is on hand, and a "warn
  me at" level. One unit per ingredient and recipes written in it, so there is no conversion to get
  wrong.
- **Recipes**: what ONE portion of a dish — or of one size of it — uses. A size's own recipe wins; a
  dish-wide recipe covers any size without one.
- **Movements**: every change to a figure, with why (`opening`, `receive`, `waste`, `count`, `sale`)
  and, for a sale, the ticket. Capped at the latest 2,000.
- Quantities have at most three decimals and are rounded after every operation, so `0.1 + 0.2` is
  `0.3` and a running total cannot drift.
- **A dish with no recipe is not tracked at all.** A restaurant that never sets this up sees no change
  anywhere, and the pilot is exactly that until reception adds a recipe.

### Stock-out is a flag layered over the menu, never a write to it

This is the decision most worth reviewing. The hub marks a dish `stock_out: true` in the same read
point the plan gating uses (`restaurantCache.getMenuCache`), so the waiter grid, the diner menu and the
order check all agree. It never touches `available`, which stays exactly what reception set by hand.

That keeps two different things apart: a hand 86 stays until a person undoes it; a stock-out clears by
itself when stock is recorded. Writing stock into `available` would have meant a delivery quietly
un-86ing something the chef had pulled for another reason — or never coming back.

The check is **per order, not per dish**: needs are summed across the order's lines first, so two
dishes that each fit alone but share an ingredient are checked against it together. A dish is hidden
when there is not enough for **one** portion; whether the order as a whole fits is the order check's
business.

### Enforcement

`POST /orders` checks the priced order before anything is created. A shortage is refused whole with
`409 OUT_OF_STOCK`, a sentence a waiter can read (*"Not enough stock for this order. Paneer Tikka:
needs 750 g of Paneer, 700 g left."*) and per-line details. No ticket is made and nothing is deducted.
It is also the backstop for a stale handset that still shows the dish. After the ticket is created the
ingredients come out of stock; a failure there is logged and **never fails the order**.

When a change moves a dish in or out of stock the hub broadcasts `menu_updated`; handsets also re-read
`/menu` every 4 s, so a waiter's grid follows within about that.

### Surfaces

| Where | What |
|---|---|
| Admin **Stock** tab (new) | Ingredients with level badges; Delivery / Waste / Count (each previews "after this: …"); History; add/edit/delete; a **Recipes** view and a recipe editor (dish or one size, per-portion lines). A banner names dishes that cannot be ordered right now |
| Admin Menu tab | An "Out of stock" badge, so reception sees *why* a dish is greyed |
| Waiter grid | The row stays, disabled, with an **OUT OF STOCK** chip — told apart from a hand **86'D**, and a size 86'd by hand reads as 86'd |
| Diner menu | Hidden, the same as an 86'd dish |
| Console cloud pill | Follows stock as it does the menu and tables |

All routes are reception-only (`/admin/inventory/*`); a stranger and an enrolled handset are both
refused. Stock changes with every order, so unlike the menu there is no `base_revision` guard (it would
conflict constantly); adjustments are deltas except a count, which is absolute by design.

### A pre-existing data-loss bug, found by this work

Testing "editing a dish while it is out of stock must not 86 it for good" showed the flag **being
saved into the stored menu**. The cause was not my overlay: `updateCatalog` fed the editor's mutator
`getMenuCache()` — the *shown* menu. The **M3 plan gating** is an overlay on that same read: it strips
`modifier_groups`, `day_parts` and `station` for plans without them. So:

> A tenant on a plan without modifiers — a lapsed trial, a past-due grace period, a downgrade to
> Starter — who edited **any** dish saved the stripped menu back, permanently deleting every modifier,
> day-part price and station on **every** dish, and pushing that to the cloud.

Reproduced first with a failing test (3 of 6 failed against the unfixed code), then fixed:
`restaurantCache.getStoredMenu()` returns the menu as stored with no overlay, and **edits start from
it**; reads keep the overlays. The CSV-import preview was aligned to it so a preview and its commit
agree. Six tests pin it (`catalogOverlays.test.mjs`), including "upgrading back after an edit on a
lower plan restores everything that was hidden."

**Impact:** the pilot is on Pro and is unaffected. Any tenant that was degraded and edited a dish
before this fix has lost those fields from their stored menu. `restaurantCache` keeps timestamped
copies in `hub_server/data/backups/` before each write, so recent data can be recovered by hand.

### The cloud (migration 009, `lib/inventorySync.js`)

`inventory_items` (`NUMERIC(14,3)`, `hub_ref` upsert key) and `recipes` (lines as JSONB), with RLS on
`current_restaurant_id()` and `DELETE` granted because a snapshot push removes what the owner deleted.
Stock is the **third replicated catalog** next to the menu and tables, so it inherits their coalescing
(one pending push, always the newest), status reporting and shelving.

- **Pushed debounced** (5 s, `HUB_INVENTORY_PUSH_MS`), because stock changes with every order and each
  push is a full snapshot. Anything unflushed at shutdown is carried up by the boot backfill.
- **Restore for a replacement laptop**, only when the store has **never held anything** (revision 0). An
  owner who deleted every ingredient is also "empty" but has a history, and restoring would resurrect
  what they deleted. What returns is the cloud's last snapshot, so a recount is the honest next step.
  Restore runs before the backfill, and what came *from* the cloud is not pushed back.
- **A defect in my own migration, caught before it ran:** the first draft had a unique index on
  `(restaurant_id, menu_item_ref, variant_ref)`. Clear a dish's recipe and set it again offline and the
  hub gives the new one a fresh id, so the upsert would meet the old row for the same dish before the
  stale-row delete ran — a `23505`, which is not a systemic error, so the push would burn its retries
  and be shelved. The hub already guarantees one recipe per dish-and-size; the index is now a plain one.

Also: stock is kept per restaurant. A hub re-paired to another tenant keeps the old file aside as
`inventory.<id>.json` and starts empty, and reading as another tenant sees nothing. An unreadable
`inventory.json` is kept as `inventory.corrupt-<ts>.json`, not overwritten (counting stock takes hours).

### Files

| File | Change |
|---|---|
| `hub_server/lib/inventory.js`, `inventoryStore.js`, `inventorySync.js` | New — rules, the store, cloud push/pull |
| `database/migrations/009_inventory_cloud.sql` | New |
| `hub_server/lib/restaurantCache.js` | `stockProvider` overlay; **`getStoredMenu()` and edits start from it** |
| `hub_server/lib/syncQueue.js`, `catalogSync.js` | Third catalog kind; `enqueueInventoryIfBehind`, `restoreInventoryFromCloud` |
| `hub_server/lib/dinerMenu.js` | Hides `stock_out` |
| `hub_server/server.js` | Order check/deduct, `/admin/inventory/*`, wiring, debounce, boot restore + backfill |
| `src/admin/InventoryTab.jsx`, `lib/inventory.js`, `AdminApp.jsx`, `MenuTab.jsx` | The tab, the logic, the badge, the pill |
| `src/waiter_mobile/RapidOrderBuilder.jsx` | OUT OF STOCK row |
| `.gitignore` | `hub_server/data/inventory*.json` |
| `hub_server/test/helpers/spawnHub.mjs` | A hub that exits while a test is using it now prints its last output and exit code |

## TEST CASES (113 hub + 67 frontend, all new)

| File | N | Covers |
|---|---|---|
| `inventory.test.mjs` | 36 | Validation; add/edit/delete rules; unit locked under a recipe; adjustments and refusals; no float drift; recipes (size beats dish-wide); **shared ingredients checked together**; never below zero; overlay, `available` untouched, hand-86 survives a restock; state from disk |
| `inventoryStore.test.mjs` | 19 | Persistence; burst writes end at the last value; corrupt file preserved byte-for-byte; **tenant isolation**; listeners fire on availability changes only; a throwing listener harms nothing |
| `inventoryRoutes.test.mjs` | 16 | Real hub: order deducts and logs; refused whole with a readable reason and no ticket; **a stale handset is refused**; delivery restores every menu; **editing while out does not 86 for good**; sizes; broadcast; reception-only (stranger and handset); survives restart |
| `inventoryCloud.test.mjs` | 33 | Push order (ingredients before recipes, upserts before deletes); round trip; other tenants untouched; **restore rules**; backfill; **debounce on a real hub** |
| `catalogOverlays.test.mjs` | 6 | The data-loss bug, both overlays |
| `dinerMenu.test.mjs` | +3 | A stock-out is hidden and never leaks the flag |
| `src/test/admin/inventoryLib.test.js` | 34 | What a person types: quantities, forms, recipe lines, wording |
| `src/test/admin/InventoryTab.test.jsx` | 25 | The tab: exact request bodies, refusals shown in the dialog, previews, recipes |
| `src/test/waiter/RapidOrderBuilder.test.jsx` | 8 | OUT OF STOCK vs 86'D, sizes independent |

**Shown to be able to fail** (each caught by exactly the test meant to catch it, then restored):
removing the waste-exceeds-stock rule; making restore ignore the revision; removing the debounce; and
the data-loss bug failing 3 of 6 before its fix.

Driven in a browser against a **scratch hub on a copy of the pilot's menu** (its own port and data
directory; the pilot's `hub_server/data` was never touched): Chicken Tikka Masala flagged out of stock
at 200 g against 250 g, banner and Menu badge correct, a 3,000 g delivery previewed as "3,200 g",
and afterwards the banner cleared, the waiter's `/menu` flag cleared and the diner menu listed the dish
again — with `available` true throughout.

```bash
npm run test:hub   # 718 (605 + 113)
npm run test:web   # 116 (49 + 67)
npm run build      # clean
```

## NOT DONE / LIMITS

- **Migration 009 is unrun**, like 004–008. The push, read-back and restore were verified against a
  stateful fake cloud, not PostgREST. Restore is the least proven part.
- **Modifier choices do not use stock** ("extra cheese" does not take cheese out). A recipe is per dish
  or size.
- **No unit conversion, costing, par levels, supplier orders or reorder alerts.** The level badge and
  the Stock tab are the only prompts, and nothing notifies anyone.
- **A cancelled or voided order does not return stock** — there is no order-cancel route, and food that
  was cooked is not coming back. Waste and count are how it is put right.
- **Stock is taken when the order is placed**, including courses not fired yet.
- **The movement log is not replicated** and is capped at 2,000 on the hub.
- **A recipe for a dish later deleted from the menu is kept** and shown as "Not on the menu".
- **Not plan-gated.** Whether stock is a paid feature is a pricing call, not a technical one, and it is
  one entry in `plans.js` if wanted.
- Handsets learn of a stock-out within ~4 s (their poll); between that and the next poll the hub's order
  check is the backstop, and it is tested.
- The Kitchen Display page hardcodes port 4000 when not served from it, which is why a hub on any other
  port shows connection errors on `/`. Unrelated to this work; seen only on the scratch hub.
- **An intermittent test-hub exit is still unexplained** (see the course-state report). It hit
  `kitchenOps.test.mjs` three times over this work, never in the new inventory files. This slice adds
  diagnostics to the test fixture so the next occurrence says why, and 8 consecutive full runs passed.
  I do not know that it is unrelated to the hub changes made today, only that nothing points at them.

## STATUS

✅ VERIFIED — 718 hub + 116 frontend, build clean, driven in a browser. ⚠ Migration 009 unrun.

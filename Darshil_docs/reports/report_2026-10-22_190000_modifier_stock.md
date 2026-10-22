# 4.2 Modifier choices that use stock

**Date:** 2026-10-22T19:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Inventory limits" / §4.2 "Modifier choices that use stock"

---

## WHY

A recipe said what one portion of a dish uses. A modifier choice — *extra cheese*, *add an egg* — changes
what the portion uses, and nothing recorded it. A kitchen that sold forty extra cheeses a week took none of
it out of stock, so the figure on the Stock screen drifted away from the shelf, and a dish could be
"in stock" while the cheese it was being sold with was gone.

## WHAT

### A recipe line may name a choice

A recipe line is an ingredient and a quantity. It may also carry a `group_id` and an `option_id`: it is then
what **one portion that picked that choice adds on top of the dish**, and it is counted only for the
portions that did.

- *Biryani:* rice 0.3 kg — and, **for extra cheese**, cheese 20 g.
- An order of three biryani, two of them with extra cheese, takes 0.9 kg of rice and **40 g** of cheese.

A choice is identified by its **group and its option together**. Option ids repeat across groups (a "spice"
group and an "extras" group can both have an option called `o_cheese`); matching on the option alone would
charge the wrong one.

### Why it lives inside the dish's recipe, not as a recipe of its own

The obvious shape is a second recipe row for each choice. It is the wrong one. The cloud's `recipes` table
(migration 009) has columns for the dish and the size, and **none for an option**. A row for "extra cheese"
would go up and come back as a recipe with no option on it — that is, as a **second dish-wide recipe** for the
biryani — and a replacement hub restored from it would then charge every portion for the extra cheese. That is
worse than never tracking extras at all.

Keeping the choice's lines inside the dish's own recipe means the cloud row already holds it (`lines` is
JSONB), a restore brings it back whole, and **no migration is needed**. A restaurant that does not use extras
sends exactly the row it always did; the test asserts no new keys appear.

### The rules

- **An extra counts only for the portions that chose it.** Two lines of one dish — two with the extra, five
  without — are counted separately.
- **A dish is not out of stock because an extra is.** `recipeShort` considers only the dish's own
  ingredients. An extra that has run out holds up the *order that asks for it*, naming the ingredient
  (*"Biryani: no Cheese left"*), and the plain biryani can still be ordered and is still on the menu. Nobody
  should lose the biryani for the cheese.
- **A half-named extra is dropped, not read as part of the dish.** A line with a group but no option (or the
  reverse) would otherwise silently become a base line and charge *every* portion for an extra only *some*
  have. `cleanLine` is the one place a line's shape is decided, used when reading from disk, from the cloud and
  when writing.
- **A recipe cannot name a choice the dish does not offer**, and one ingredient may appear once for the dish
  and once *per extra* — the same cheese in the base and in "extra cheese" is exactly the point.
- **A recipe may be only extras** (a drink with no base recipe whose "extra shot" uses coffee): the dish is
  untracked, the extra still counts.
- An extra belongs to the recipe **for the size ordered**, so a dish with a recipe per size sets the extra per
  size.

### The Stock tab

The recipe dialog gains an **Extras** section: one collapsible block per choice the dish offers, named as
reception named it (*Extra cheese · Extras*), open only when it already uses stock. The recipes list reads
*"Rice 0.3 kg · With Extra cheese: Cheese 20 g"*. The dialog was refactored so the dish's rows and each
extra's rows share one component; the dish's own labels are unchanged, so existing screen-reader behaviour and
every existing test is untouched.

## FILES

| File | What changed |
| --- | --- |
| `hub_server/lib/inventory.js` | `isOptionLine`, `cleanLine`; `normalizeState`, `setRecipe`, `needsFor`, `recipeShort` understand a choice |
| `hub_server/lib/inventorySync.js` | the line shape goes up and comes back through `cleanLine` |
| `src/admin/lib/inventory.js` | `extraKey`, `dishExtras`, `recipeToExtras`, `validateRecipe`; subjects carry the dish's extras; `recipeSummary` names them |
| `src/admin/InventoryTab.jsx` | `RecipeLines` (shared rows), the Extras section |
| `hub_server/test/inventoryModifiers.test.mjs` | **new** — 24 tests |
| `src/test/admin/InventoryExtras.test.jsx` | **new** — 26 tests |

## TESTS

**Hub (24):** an extra counts only for the portions that chose it; per-line separation; several extras on one
portion; group + option identity; hostile `modifiers` values add nothing and do not throw; dish + extra of the
same ingredient add up; per-size recipes; an extra running out refuses that order and nothing else; a dish is
not out of stock because an extra is, but *is* when its own ingredient is; consumption records each movement;
an extras-only recipe; writing — unknown extra, half-named extra, duplicate within one extra, every problem
reported together; reading — extras kept, half-named dropped, pre-extras recipes unchanged; **cloud** — an
extra goes up with its recipe and comes back whole, and is not turned into a second recipe; a real hub —
reception sets a recipe with an extra and reads it back, an unknown extra is refused with the reason, orders
with and without the extra move stock correctly, and with the cheese gone the extra is refused by name while
the dish still sells and stays on the menu.

**UI (26):** the helpers (extras a dish offers, reading a recipe into the editor, the one-line summary,
validation across dish + extras including the 30-line limit), and the dialog — closed until it has something
in it, absent for a dish with no choices, the payload carries group and choice, an extras-only recipe,
mistakes shown on the extra's own row with nothing sent, editing opens the extras that already use stock,
no false "this removes the recipe" warning while an extra still has rows, and switching dishes does not carry
the first dish's extras over.

**Mutation-checked:** 11 on the hub (counting an extra whether or not it was picked; matching on option alone;
an extra taking the dish out of stock; a half-named extra read as part of the dish; extras lost on read, on
write, on push and on pull; an unoffered extra accepted; duplicates accepted; the same ingredient refused in
dish and extra; a half-named extra accepted on write) — **all caught**. 9 on the UI — **one survived the
first time**: switching dish kept the previous dish's extras. That matters more than it sounds, because dishes
commonly share the same extras group, so the second dish would have silently inherited the first's rows.
A test now covers it, with two dishes that offer the identical group and options.

**Full suites:** hub `965 passed`, frontend `316 passed`, `npm run build` clean.

**In a browser** (a scratch hub on :4100 with its own data, the menu a copy with an Extras group on two
dishes): the dialog renders and saves; the stored recipe holds the extra with its group and option; editing
rehydrates it (Rice 0.3, *Extra cheese* open with Cheese 20, *Egg* closed). Against that real hub process,
from Node: an order of two with the extra took 0.6 kg of rice and 40 g of cheese, one without took only rice,
the order that would have used the last cheese was refused (409, *"Paneer Butter Masala: no Cheese left"*),
and the plain dish still sold with no `stock_out` on the menu.

*A note on the browser run, for whoever repeats it:* the in-app browser returned stale reads for a few seconds
after writes (including `cache: 'no-store'`), and a screenshot showed a frame from before a state change. The
hub itself was right and immediate when asked from Node. Check state with a direct request, not the pane.

## WHAT IS NOT DONE

- **The waiter's modifier sheet does not grey out an extra that has run out.** The order is refused with the
  ingredient named, which is safe but arrives after the waiter has built the order. Showing it earlier means
  an overlay flag on the option, the same way a dish gets `stock_out`.
- **An extra is set per size** for a dish that has a recipe per size, so "extra cheese" is entered once per
  size. Sharing it across sizes would need a way to say "for every size", which the schema does not have.
- **Costing, par levels and reorder prompts** are untouched. Par levels in particular need a decision about
  what "reorder up to" means for the restaurant.
- **Cancelling an order** does not exist (there is no cancel route), so there is nothing yet to return stock
  from. Whether a cancelled order gives its ingredients back (it may already be cooking) is a policy for
  whoever adds cancellation.
- **Not run against a real Supabase project.** Like migrations 004–011, nothing here has touched one; the
  cloud round trip is proven against a fake that keeps its rows.

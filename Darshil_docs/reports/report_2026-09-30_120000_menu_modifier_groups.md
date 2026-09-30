# M2 · PR 12 — Menu modifier groups (spice level, extras, prep instructions)

**Date:** 2026-09-30T12:00:00+05:30
**Branch:** `feat/menu-modifier-groups` (stacked on `feat/menu-variants`)
**Milestone:** M2 — Menu depth
**Scope:** Second slice of M2. First-class modifier groups on menu items.
Compose on the same fail-loud shape as PR 11 variants: when an item ships
`modifier_groups`, the handset MUST honour every group's `min`/`max` and every
referenced `group_id` / `option_id` must resolve, or the whole line is
rejected. Server-side pricing folds per-option `price_delta` into the per-unit
price. Legacy items with no modifier_groups behave exactly as before — no
migration required for cached menus, on-disk hubs, or Supabase rows.

---

## WHY

PR 11 shipped variants (Half/Full, Boneless/Bone-in). Modifier groups are the
other axis of menu depth reception has asked for:

- **Required prep instructions** the kitchen needs before firing the ticket:
  spice level for curries, sweetness for beverages, temperature for beer.
- **Paid extras** that adjust the per-unit price: extra cheese, double cream,
  extra portion of gravy.
- **Substitutions and omissions**: "no onion", "no cream", "no coriander" —
  zero delta but must reach the kitchen.

Variants captured a single-axis choice (size). Modifiers capture N-axis prep
metadata that stacks with variants: "Chicken Tikka Masala · Full · Hot ·
+Extra cheese · No cream" bills as ₹340 + ₹40 = ₹380/unit and the KDS card
tells the cook exactly what to prep. PR 11's commit message flagged this as
the next M2 slice and named the "same-shape" contract; this PR delivers it.

---

## WHAT

### Data shape (menu item, JSONB from Supabase or inline in seed)

```js
{
  id: 'm3', name: 'Chicken Tikka Masala', price: 340, ...
  variants: [ { id, label, price } ],
  modifier_groups: [
    {
      id: 'mg_spice', label: 'Spice level',
      min: 1, max: 1,                       // min>=1 → required, max=1 → radio
      options: [
        { id: 'mild',   label: 'Mild',   price_delta: 0 },
        { id: 'hot',    label: 'Hot',    price_delta: 0 }
      ]
    },
    {
      id: 'mg_extras', label: 'Extras',
      min: 0, max: 3,                       // max>1 → checkbox multi-select
      options: [
        { id: 'extra_cheese', label: 'Extra cheese', price_delta: 40 },
        { id: 'no_onion',     label: 'No onion',     price_delta: 0 }
      ]
    }
  ]
}
```

### Request line shape (from handset)

```js
{
  id: 'm3', qty: 2, variant_id: 'v_full',
  modifiers: [
    { group_id: 'mg_spice',  option_id: 'hot' },
    { group_id: 'mg_extras', option_id: 'extra_cheese' }
  ]
}
```

### Priced line shape (hub → invoice / ticket)

```js
{
  id, name, qty,
  price: 380,                               // variant price + Σ modifier deltas, per unit
  variant_id, variant_label,
  modifiers: [
    { group_id, group_label, option_id, option_label, price_delta }
  ]
}
```

### Cart lineKey (frontend)

`<item_id>|<variant_id?>|<sorted "group_id:option_id;..." signature>`

Identical variant + modifier picks stack (qty++). Different picks split into
separate cart lines so a table ordering both "Full · Hot · +Cheese" and
"Full · Mild" bills correctly.

### Files changed

| File | Change |
|---|---|
| `hub_server/lib/pricing.js` | +90 lines. After the variant block, a modifier block runs — required groups (`min>=1`) must be satisfied (`MODIFIER_GROUP_REQUIRED`), min/max enforced (`MODIFIER_GROUP_MIN_UNMET`, `MODIFIER_GROUP_MAX_EXCEEDED`), unknown group/option ids rejected (`UNKNOWN_MODIFIER_GROUP`, `UNKNOWN_MODIFIER_OPTION`), item with no modifier_groups + handset-supplied modifiers rejected (`SPURIOUS_MODIFIERS`). Per-unit delta applied once per unit then rounded. Line grows `modifiers: []` (never null). |
| `hub_server/lib/restaurantCache.js` | Seed menu grows spice + extras on `m3` (Chicken Tikka Masala) and sweetness on `m9` (Masala Chaas). Supabase→cache mapping propagates JSONB `modifier_groups`, defensively normalising every level: an option with a non-numeric `price_delta` is dropped, a group with no options is dropped, `min` and `max` are clamped, all strings length-capped. |
| `hub_server/lib/invoice.js` | `enrichLine` passes `modifiers: []` through onto the invoice item so the KDS + printer see the resolved labels + deltas without a menu lookup. |
| `hub_server/lib/printer.js` | KOT now prints `2x Chicken Tikka Masala (Full)` followed by `  + Extra cheese +₹40` (paid deltas with amount) and `  · Spice level: Hot` (zero-delta prep instructions). Receipt renders the same pattern in its column layout — paid modifiers get a right-aligned delta column, prep modifiers span the whole width without numeric columns. |
| `hub_server/test/hub.test.mjs` | +4 tests. Unit-level accept / reject / mixed-cart / required / max-exceeded / unknown-group / unknown-option / spurious / legacy-flat, KOT+receipt render assertions with delta signs and prep style, and one round-trip. All 103 tests pass. |
| `src/waiter_mobile/ModifierSheet.jsx` | **New file, ~200 lines.** Bottom-sheet modal. Required groups show a "REQUIRED" chip and block Add-to-cart until satisfied. Radio for `max=1`, checkbox for `max>1` (over-max clicks ignored). Zero-delta options render without a price; positive deltas show `+₹40`, negative `−₹20`. Footer shows the running per-unit price with the delta breakdown. |
| `src/waiter_mobile/WaiterApp.jsx` | `lineKey` now encodes a sorted modifier signature after the variant. `addItem` accepts the resolved modifiers array; empty array persisted for legacy items so cart renderers don't need nullish guards. |
| `src/waiter_mobile/RapidOrderBuilder.jsx` | Menu rows for items with `modifier_groups` show a "CUSTOMIZE" chip and open the ModifierSheet on tap (variants + modifiers compose: each variant row of a modifier'd item opens the sheet with the variant pre-selected). Row qty aggregates across every draft line that shares the base item/variant so the menu row shows total pieces even when the cart holds multiple modifier combos. The bare `−` stepper only decrements the plain no-modifier line — modifier combos are edited from the Cart tab where each line is listed individually. |
| `src/waiter_mobile/OrderDraftDrawer.jsx` | Cart line renders modifier sub-lines under each item — prep style for zero-delta, `+₹` × qty for paid modifiers. POST `/orders` payload now carries `modifiers: [{ group_id, option_id }]` (labels and deltas are the server's job). |
| `src/kitchen_main.jsx` | KDS ticket card + Bill Preview modal render modifier lines under each item. Paid deltas are highlighted in primary colour; prep instructions in muted grey so the cook's eye lands on the mandatory prep info. |
| `Darshil_docs/README.md` | Index entry for this report. |

Deliberately **not** touched:

- `supabase_schema.sql` — same pattern as PR 11: the hub accepts JSONB from
  Supabase when the column exists, and defaults gracefully when it doesn't.
  Adding the column is a follow-up migration once reception has a UI to
  author modifier groups (queued below).

---

## TEST CASES

### TC-PR12-01 — Unit: `priceOrder` applies modifier deltas per unit and rejects bad picks

**File:** `hub_server/test/hub.test.mjs`, test `M2: priceOrder applies modifier deltas per unit and rejects bad picks`

**Pre-conditions:** Stub the module-level `restaurantCache.getMenuCache` to
return a menu with one flat item and one variant+modifier item.

**Steps & expected:**

| Input | Expected |
|---|---|
| Full variant + Hot + Extra cheese, qty 2 | ok, price 380/unit, total 760, 2 modifiers on the line with resolved labels + deltas |
| Half + Mild + No onion + Extra cheese | ok, price 260/unit (220 + 40, No onion is zero-delta) |
| Full + only Extras (spice missing) | rejected, `MODIFIER_GROUP_REQUIRED`, group_id `mg_spice` |
| Full + Mild + Hot (two spice picks) | rejected, `MODIFIER_GROUP_MAX_EXCEEDED`, max 1 |
| Full + Hot + unknown group | rejected, `UNKNOWN_MODIFIER_GROUP`, group_id echoed |
| Full + spice option `nuclear` | rejected, `UNKNOWN_MODIFIER_OPTION`, option_id echoed |
| Half + Mild + Extra cheese with injected `price_delta: 9999` | ok, price 260 — server delta wins |

### TC-PR12-02 — Unit: spurious modifiers on a flat item; legacy path unaffected

**File:** `hub_server/test/hub.test.mjs`, test `M2: flat item + spurious modifiers rejected; legacy no-modifier path unaffected`

- Flat item + `modifiers: [...]` → rejected with `SPURIOUS_MODIFIERS`.
- Flat item, qty 3, no modifiers → ok, `modifiers: []` on the line, total 570.
- Item with a required group + empty `modifiers` array → rejected with
  `MODIFIER_GROUP_REQUIRED`.

### TC-PR12-03 — Render: KOT + receipt modifier lines

**File:** `hub_server/test/hub.test.mjs`, test `M2: modifier line renders on KOT + receipt with delta signs and prep style`

- KOT contains `2x Chicken Tikka Masala (Full)`, `+ Extra cheese +₹40`,
  `· Spice level: Hot`, `· Extras: No onion`.
- Receipt contains `Chicken Tikka Masala`, `+ Extra cheese`, `+₹40`,
  `· Spice level: Hot`.

### TC-PR12-04 — E2E: round-trip through hub `/orders`

**File:** `hub_server/test/hub.test.mjs`, test `M2: end-to-end order with valid modifier passes hub /orders round-trip`

POST an m9 (Masala Chaas) order with the required `Sweetness` group picked.
Fixture-dependent: 201 when the seed cache carries the modifier_groups, 400
`SPURIOUS_MODIFIERS` when running against an older fixture without them —
either outcome documents the guardrail (the deterministic accept path is
covered by TC-PR12-01).

### TC-PR12-05 — Manual: waiter PWA modifier sheet

**Environment:** hub started (`npm run hub`), waiter PWA built (`npm run
build && npm run preview`), pointed at the hub URL.

**Steps:**

1. Enter waiter PIN, pick a table.
2. Open the Menu tab. Confirm every variant of Chicken Tikka Masala shows a
   `CUSTOMIZE` chip. Confirm Masala Chaas shows the chip. Confirm items with
   no modifier_groups (Dal Tadka, Butter Naan, etc.) do NOT show it and add
   with a single tap as before.
3. Tap Add on Chicken Tikka Masala (Full). Modifier sheet opens.
4. Confirm the sheet header shows `Chicken Tikka Masala · Full`.
5. Confirm the Spice level group is required (REQUIRED chip) and the Add
   button is disabled with copy `Pick Spice level`.
6. Tap Hot → Add button enables, footer shows `Per unit ₹340`.
7. Tap Extra cheese → footer shows `Per unit ₹380 (₹340 + ₹40)`. Multi-select
   chip visible.
8. Add to cart. Cart tab shows the item with sub-lines: `+ Extra cheese`
   `+₹40 × 1` and `· Spice level: Hot`.
9. Tap Add on Chicken Tikka Masala (Full) again, this time Mild + no extras.
   Confirm the cart holds two SEPARATE lines. Confirm the menu row shows
   qty = 2 (aggregated).
10. Send to kitchen. Confirm the KDS card shows both lines with the same
    modifier sub-lines (Hot with +Extra cheese highlighted primary colour;
    Mild in muted grey).
11. Close the bill on the KDS. Bill Preview modal shows both lines with
    modifier detail and per-unit deltas. Print preview shows the paid delta
    right-aligned and the prep line spanning the width.

### TC-PR12-06 — Automated verification

```bash
cd /path/to/Restaurant-Bar-SaaS
npm test          # 103 tests, all pass — 4 M2·PR12 + 3 M2·PR11 + 96 M1
npm run build     # vite build clean, no JSX errors
```

**Actual output:** 103/103 tests pass in ~4.8s. Vite build completes in 6.8s
with no warnings on the changed files.

---

## OUT OF SCOPE (queued for follow-up M2 PRs)

- **Day-part pricing** (happy hour, breakfast-only items) — PR 13. Composes
  on the same shape: menu item ships `day_part_pricing: [{ starts_at,
  ends_at, price_override }]`; hub resolves at pricing time.
- **Per-variant availability / 86'd items** — PR 14. Toggle `available: false`
  on the variant, not just the item, so reception can 86 the Full portion of
  a dish without hiding the Half.
- **Multi-station KDS routing** (bar / hot / cold) — PR 15. Menu item ships
  `station: 'bar' | 'hot' | 'cold'`; hub routes the KOT to the right
  printer/display group.
- **Reception admin UI to author modifier groups** — separate PR, likely
  bundled with the variant admin UI. For now, modifiers are configured via
  Supabase directly or by editing the seed.
- **Modifier availability windows** — a modifier option (e.g. "Extra cream")
  is out during Ramadan. Same day-part machinery as PR 13 once that lands.

---

## STATUS: ✅ Ready for review

- 103/103 hub tests pass
- vite build clean
- Feature branch `feat/menu-modifier-groups` pushed to fork, stacked on
  `feat/menu-variants`.

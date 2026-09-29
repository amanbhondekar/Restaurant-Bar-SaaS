# Engineering & Test Audit Report — Menu Variants (M2 · PR 11)

- **Timestamp**: `2026-09-29T12:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: First slice of milestone M2 (Menu depth). Menu items can now
  ship a `variants: [{ id, label, price }]` array — portion sizes on
  rice + curries, bone-in vs boneless on chicken items, half vs full
  on biryani. Server-side pricing validates the variant selection,
  the KOT and receipt render `Item — Variant`, and the waiter PWA
  expands each variant into its own row on the menu list so reception
  taps it directly instead of navigating a picker. Modifier groups,
  day-part pricing, and multi-station KDS routing land as follow-up
  M2 PRs on this same shape. Stacks on `feat/ci-and-crash-reporting`
  (PR 10, last M1 slice).
- **Related Files**:
  - `hub_server/lib/pricing.js` [MODIFY]
  - `hub_server/lib/restaurantCache.js` [MODIFY] (Supabase + seed shape)
  - `hub_server/lib/invoice.js` [MODIFY]
  - `hub_server/lib/printer.js` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/waiter_mobile/WaiterApp.jsx` [MODIFY]
  - `src/waiter_mobile/RapidOrderBuilder.jsx` [MODIFY]
  - `src/waiter_mobile/OrderDraftDrawer.jsx` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]

---

## 1. Rationale (Why)

Every real menu we've onboarded so far has hit the same wall in the
first 30 minutes: reception says "we sell this in half and full", or
"the chicken can be boneless or bone-in", or "small / regular / large
on the biryani". PR 1's pricer only knew about a single per-item
price. Every workaround (duplicate the item as "Paneer Butter Masala
Half" and "Paneer Butter Masala Full" in the menu list) has three
downstream costs — cluttered menu, split reporting, and a menu-admin
UX that grows quadratic with variety.

This PR closes the gap with the smallest useful addition on top of PR
10's invoice/print stack:

1. **`variants` is a first-class array on the menu item**, not a
   convention on top of duplicated names. When present, the handset
   MUST pick one; the item's own top-level `price` is a display
   fallback only. When absent, everything behaves exactly as before
   (backwards-compatible with the seed menu, with the on-disk cache
   from earlier hubs, and with any pilot tenant's Supabase rows that
   don't yet ship a `variants` column — they render as flat items).
2. **Server never trusts the handset's variant price.** `pricing.js`
   looks the variant up on the hub's own cached menu and uses its
   price — same posture as PR 1's item-level price rejection. A
   handset can't ship `variant_id: v_full, price: 1` and get away
   with a half-price bill.
3. **Reception sees one row per variant on the menu screen**, not a
   modal. On a 375 px phone every extra tap costs seconds of shift
   time; a pre-expanded list is one glance vs. one tap + one radio
   choice + one confirm. Category / veg / search filters all still
   work because the expansion happens before filtering, so
   "half-price veg items" and "search for 'jeera'" both cover
   variants naturally.
4. **Cart draft shape becomes richer** (`{ [lineKey]: {
   item_id, variant_id?, variant_label?, name, price, isVeg, qty
   } }`) so the drawer can render `Paneer Butter Masala · Half` with
   its own qty without re-querying the menu (which would return the
   base item, not the variant). Old shape (`{ [itemId]: qty }`) is
   dead — every callsite updated in this PR.

State-machine invariant kept from PR 1: pricing fails closed. If the
handset supplies a variant on an item that has none, or a variant_id
that doesn't match any variant, or omits the variant_id on an item
that has variants — the whole order line is rejected with a specific
reason (`VARIANT_REQUIRED` / `UNKNOWN_VARIANT` / `VARIANT_NOT_PRICED`).
Silent fallback would risk pricing a stale menu at the wrong amount.

---

## 2. What (Code & Endpoints)

### Modified

1. **`hub_server/lib/pricing.js`**
   - After the existing name / availability / qty / price checks, a
     new variant block runs:
     - Item has variants + handset didn't pick one → `VARIANT_REQUIRED`.
     - Handset picked a `variant_id` that doesn't match → `UNKNOWN_VARIANT`.
     - Variant's own `price` invalid → `VARIANT_NOT_PRICED`.
     - Item has no variants but handset supplied one → `UNKNOWN_VARIANT`
       (fail-loud so a stale phone menu is caught).
   - `priced` line grows two new fields — `variant_id`,
     `variant_label` — always present, `null` for flat items so
     downstream serialisation stays uniform.

2. **`hub_server/lib/restaurantCache.js`**
   - Three seed items get `variants` (Paneer Butter Masala,
     Chicken Tikka Masala, Jeera Rice — Half / Full) and a fourth
     (Chicken 65) gets a Boneless / Bone-in split so both patterns
     are covered.
   - Supabase→cache mapping now propagates `variants` from JSONB,
     filtering rows to only well-formed `{ id, label, price }`
     entries and dropping the field entirely when nothing valid
     comes through (so a legacy hub with a `variants: null` column
     still loads without breaking).

3. **`hub_server/lib/invoice.js`** — `enrichLine` passes
   `variant_id` / `variant_label` through unchanged from the ticket
   line onto the invoice item. Every downstream renderer (bill
   preview modal, receipt printer, KDS ticket card) reads from
   this field.

4. **`hub_server/lib/printer.js`**
   - KOT: each item line reads `${qty}x Name` for flat items and
     `${qty}x Name (Variant)` when a variant_label is present, so
     the kitchen brigade sees at a glance which portion they're
     cooking.
   - Receipt: the 20-char `Item` column takes an em-dash suffix —
     `Chicken 65 — Boneless` — and trims once. Right-hand
     Qty/Price/Total columns are untouched.

5. **`src/waiter_mobile/WaiterApp.jsx`** — cart draft shape
   swapped from `{ id: qty }` to `{ lineKey: { item_id,
   variant_id?, variant_label?, name, price, isVeg, qty } }`.
   `addItem(row)` takes a full row (built by `RapidOrderBuilder`)
   and increments qty by lineKey; `removeItem(key)` decrements or
   drops the row.

6. **`src/waiter_mobile/RapidOrderBuilder.jsx`** — menu items with
   variants expand into one visible row per variant at render
   time, each with its own `lineKey`, price, and add/remove qty
   pill. Filters (category / veg / search) run over the expanded
   list so "Half" and "Full" both show up when the user searches
   "paneer", and search on "half" turns up every half-portion item
   at once.

7. **`src/waiter_mobile/OrderDraftDrawer.jsx`** — iterates
   `Object.entries(draftItems)` values (each already resolved),
   drops the previous `menu.find(m => m.id === id)` lookup entirely,
   renders `Name · Variant` in the cart.

8. **`src/kitchen_main.jsx`** — KDS ticket card and Bill Preview
   modal both show `· Variant` next to the item name.

---

## 3. Test Cases

All 99 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
86 M1 + 3 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M2-01 | Flat item with no variant_id → 190×2 = 380 total, `variant_id: null` on the line | ✅ |
| M2-01 | Variant item with correct variant_id → 220 at v_half, 340 at v_full; `variant_label` on the line | ✅ |
| M2-01 | Handset-supplied price ignored — variant price wins | ✅ |
| M2-01 | Variant item without variant_id → 400 `INVALID_ITEMS` + line reason `VARIANT_REQUIRED` | ✅ |
| M2-01 | Variant item with unknown variant_id → 400 + reason `UNKNOWN_VARIANT` | ✅ |
| M2-01 | Flat item with a spurious variant_id → 400 + reason `UNKNOWN_VARIANT` | ✅ |
| M2-02 | Mixed cart (flat line + variant line) prices each independently | ✅ |
| M2-03 | Legacy order without any variant_id still succeeds end-to-end via `POST /orders` (m1 in the fixture) | ✅ |

### Live smoke test

Local hub + waiter PWA at `http://localhost:3000/waiter.html`. Menu
tab renders every variant as its own row (screenshot):

```
🟢 Paneer Butter Masala · Half   ₹180   [Add]
🟢 Paneer Butter Masala · Full   ₹280   [Add]
🟢 Dal Tadka                     ₹190   [Add]
🔴 Chicken Tikka Masala · Half   ₹220   [Add]
🔴 Chicken Tikka Masala · Full   ₹340   [Add]
🟢 Butter Naan                    ₹45   [Add]
🟢 Jeera Rice · Half              ₹90   [Add]
🟢 Jeera Rice · Full             ₹140   [Add]
🟢 Veg Crispy                    ₹220   [Add]
🔴 Chicken 65 · Boneless         ₹320   [Add]
🔴 Chicken 65 · Bone-in          ₹290   [Add]
🟢 Gulab Jamun (2 pcs)            ₹90   [Add]
🟢 Masala Chaas                   ₹50   [Add]
```

Screenshot: `menu-with-variants.png`.

---

## 4. Explicitly out of scope

- **Modifier groups** ("Extra cheese +₹30", "No onions", spice level
  radio). Same-shape follow-up: item ships `modifier_groups: [{ id,
  label, required, min, max, options: [{ id, label, price_delta }]
  }]`; pricer sums deltas onto the base/variant price. Naturally
  composes with variants: a `Full Chicken 65 with Extra Chilli`
  line still has one `variant_id` and a list of `modifier_option_ids`.
- **Day-part pricing** (`happy_hour_price` on beverages between
  4-7 pm). Composes on the variant/modifier shape via a
  `pricing_windows: [{ from, to, delta_percent }]` field.
- **86'd-item propagation** — `available: false` today only hides
  the whole item; per-variant availability (`Boneless is 86'd but
  Bone-in still on`) is a small follow-up.
- **Multi-station KOT routing** (bar / hot / cold). Every item
  grows a `station` field; PR 8's printer array already supports
  N entries per role, so this is a config change plus a pricer
  passthrough.
- **Reception admin UI to author variants** — today the menu comes
  from Supabase (JSONB) or the hardcoded seed. A per-item variant
  editor slots into the existing `SelfServeAdminView`.

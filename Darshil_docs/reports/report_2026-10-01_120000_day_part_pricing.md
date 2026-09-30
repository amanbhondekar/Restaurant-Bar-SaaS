# M2 · PR 13 — Day-part pricing (breakfast, happy hour, late-night)

**Date:** 2026-10-01T12:00:00+05:30
**Branch:** `feat/day-part-pricing` (stacked on `feat/menu-modifier-groups`)
**Milestone:** M2 — Menu depth
**Scope:** Third slice of M2. First-class time-window pricing on menu items.

---

## WHY

M2's first two slices layered structural options onto the menu row —
variants (PR 11) and modifier groups (PR 12). Day-part pricing captures
the temporal axis reception owners have been asking for:

- **Breakfast prices** on breads and beverages until 11 AM.
- **Happy hour** on drinks between 4-6 PM, weekdays only.
- **Late-night** premium on the bar 10 PM - 2 AM (overnight wrap).

Same fail-loud contract as PR 11/12, but no handset validation is needed
here — the resolver is server-authoritative and pure. The handset just
displays what the hub says the current price is.

---

## WHAT

### Data shape (menu item)

```js
{
  id: 'm4', name: 'Butter Naan', price: 45, ...,
  day_parts: [
    {
      id: 'dp_breakfast', label: 'Breakfast',
      starts_at: '07:00', ends_at: '11:00',   // HH:MM local, `[starts, ends)`
      days: [0,1,2,3,4,5,6],                  // Sun..Sat; omit = every day
      price: 35,                              // overrides base during window
      variant_prices: { v_half: 30, v_full: 45 }  // optional per-variant map
    }
  ]
}
```

Windows are first-match: authors list a narrower promotion before a
broader default. Overnight ranges (`starts_at >= ends_at`) wrap across
midnight — `22:00 → 02:00` means `[22:00, 24:00) ∪ [00:00, 02:00)`.

### Resolution rules (lib/dayParts.js)

Priority (highest first):
1. Active window + `variant_prices[variant_id]` (per-variant override)
2. Active window + flat `price` (overrides variants + base uniformly)
3. Variant's own `variant.price`
4. Item's base `item.price`

Modifier deltas (PR 12) still stack on top per unit. Rounding matches
PR 11/12: `Math.round(x * 100) / 100`.

### Files changed

| File | Change |
|---|---|
| `hub_server/lib/dayParts.js` | **New file.** Pure `resolveActiveDayPart(dayParts, now)` and `resolveEffectivePrice(item, variant?, now?)`. Handles HH:MM parse, day-of-week filter, overnight wrap, and malformed-window drop-through. |
| `hub_server/lib/pricing.js` | Consults `resolveEffectivePrice` when picking unitPrice (both variant and flat paths). Priced line grows `day_part_id` + `day_part_label` (both null when no window active). |
| `hub_server/lib/restaurantCache.js` | Seed grows breakfast on m4 (Butter Naan ₹45→₹35, everyday 07:00-11:00) and happy hour on m9 (Masala Chaas ₹50→₹40, weekdays 16:00-18:00). Supabase→cache JSONB mapping normalises every level — bad HH:MM dropped, negative prices dropped, DOW values outside 0-6 filtered, windows with neither `price` nor `variant_prices` dropped. |
| `hub_server/lib/invoice.js` | `enrichLine` passes `day_part_id` + `day_part_label` through. |
| `hub_server/lib/printer.js` | KOT head line grows a `· Happy hour` suffix after the variant. Receipt renders a `  · Breakfast` sub-line under paid items (no numeric columns — the price already reflects the override; the line just attributes it). |
| `hub_server/server.js` | GET /menu enriches each item + variant with `effective_price` and `active_day_part: { id, label }` at request time so the handset shows the currently-effective price without duplicating the resolver client-side. |
| `hub_server/test/hub.test.mjs` | +4 tests: HH:MM range + day filter + overnight wrap resolution, per-variant vs flat override precedence, priceOrder folds day-part + modifier delta, KOT + receipt annotate on the item line. 107/107 pass. |
| `src/waiter_mobile/RapidOrderBuilder.jsx` | Menu row reads `effective_price` from the hub. Active windows badge the row (`BREAKFAST`, `HAPPY HOUR`) in status-green and show the discounted price with the base struck through. |
| `src/waiter_mobile/WaiterApp.jsx` | Cart lineKey now includes `dp_<id>` so a table sitting across a day-part boundary (15:59 → 16:01) generates two cart lines at their respective prices, rather than stacking wrongly at the older price. |
| `src/waiter_mobile/OrderDraftDrawer.jsx` | Cart line surfaces the active-day-part chip. |
| `src/kitchen_main.jsx` | KDS ticket card + Bill Preview modal show the same green day-part chip inline with the item name. |
| `Darshil_docs/README.md` | Index entry for this report. |

Deliberately **not** touched:

- `supabase_schema.sql` — same pattern as PR 11/12: JSONB is accepted if
  the column exists, and defaults gracefully when it doesn't. Migration
  is queued with the admin UI for authoring day-parts.
- No new handset request field. Handsets don't send `day_part_id`; the
  hub resolves independently at pricing time from its own clock.

---

## TEST CASES

### TC-PR13-01 — `resolveActiveDayPart` — HH:MM range, DOW, overnight

**File:** `hub_server/test/hub.test.mjs`

Fixed clock via a `dowDate(dow, hh, mm)` helper (2026-06-01..07 gives a
stable Mon-Sun so `getDay()` is DST-invariant).

| Now | Windows | Expected |
|---|---|---|
| Wed 13:00 | Lunch 12-15, Happy 16-18 [Mon-Fri] | `lunch` |
| Wed 17:00 | (same) | `happy` |
| Sun 17:00 | (same) | null (DOW filter) |
| Wed 23:30 | Late 22-02 | `late` (wrap) |
| Wed 01:00 | (same) | `late` (wrap) |
| Wed 12:00 | Lunch 12-15 | `lunch` (start inclusive) |
| Wed 15:00 | (same) | null (end exclusive) |
| Wed 21:00 | (all above) | null (dead zone) |
| Wed 10:00 | Bad window (`25:00`) | null (dropped) |

### TC-PR13-02 — `resolveEffectivePrice` — flat, variant, override map

| Item | Variant | Now | Expected |
|---|---|---|---|
| Naan ₹45 + `bfast:35` 07-11 | – | Wed 09:00 | 35 + `bfast` attribution |
| Naan | – | Wed 14:00 | 45, no attribution |
| Rice `variant_prices:{v_half:60,v_full:100}` bfast | v_half | Wed 09:00 | 60 + `dp_bfast` |
| Rice | v_full | Wed 09:00 | 100 + `dp_bfast` |
| Rice + flat window `price:80` 16-18 | v_half | Wed 17:00 | 80 + `dp_flat` |
| Rice + flat window | v_full | Wed 17:00 | 80 + `dp_flat` |
| Rice | v_half | Wed 14:00 | 90 (base variant) |

### TC-PR13-03 — `priceOrder` folds day-part into priced line + modifier delta

An always-on window (00:00-23:59) is used so the test is deterministic
across suite invocations. Verifies:

- Flat item + always-on window: `price = 35`, `day_part_id` populated,
  `total_amount = 70` for qty 2.
- Modifier + day-part: window base ₹40, +Large +₹20 → per-unit ₹60,
  `day_part_label` set, modifier arrives resolved.

### TC-PR13-04 — KOT + receipt annotate the active day-part

- KOT: `2x Butter Naan · Breakfast` and `1x Chicken Tikka Masala (Full)
  · Happy hour` (compose with variant + modifier). Modifier sub-line
  from PR 12 still prints under the head.
- Receipt: `Butter Naan` head line unchanged, then `· Breakfast`
  sub-line spanning the width (no numeric columns).

### TC-PR13-05 — Manual: handset live badge

Set the hub clock into a day-part window (or wait for one). Confirm on
the Menu tab that:

- Items in an active window show a green chip (`BREAKFAST`, `HAPPY
  HOUR`) inline with the name.
- The row shows the discounted price in status-green with the base
  price struck through beside it.
- Adding one before and one after a day-part boundary (e.g. tap Chaas
  at 15:59, take a phone call, tap again at 16:01) produces TWO cart
  lines with their respective prices, not one line at the wrong
  price.
- KDS card + Bill Preview modal show the same green chip.

### TC-PR13-06 — Automated verification

```bash
cd /path/to/Restaurant-Bar-SaaS
npm test          # 107 tests, all pass — 4 M2·PR13 + 4 PR12 + 3 PR11 + 96 M1
npm run build     # vite build clean
```

Actual: 107/107 pass in ~1s; vite build clean in 2.5s.

---

## OUT OF SCOPE (queued for follow-up M2 PRs)

- **Per-variant availability (86'd)** — PR 14. Toggle `available: false`
  on a specific variant so reception can 86 the Full portion without
  hiding Half. Can also gate individual modifier options by availability.
- **Multi-station KDS routing** (bar / hot / cold) — PR 15. Route each
  line to the appropriate station display + printer group.
- **Reception admin UI to author day-parts** — separate PR, likely
  bundled with the variant + modifier admin UI.
- **Timezone handling** — the resolver uses the hub's local time. A
  multi-tenant deployment with reception in multiple TZs would need
  `restaurant.timezone` passed through — deferred until we have a
  cross-TZ tenant.
- **Countdown chip** — "Happy hour ends in 24 min" would need a
  handset-side clock; deferred.

---

## STATUS: ✅ Ready for review

- 107/107 hub tests pass
- vite build clean
- Feature branch `feat/day-part-pricing` pushed to fork, stacked on
  `feat/menu-modifier-groups`.

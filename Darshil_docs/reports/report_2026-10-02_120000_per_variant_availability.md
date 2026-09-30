# M2 · PR 14 — Per-variant + per-option availability (86'd)

**Date:** 2026-10-02T12:00:00+05:30
**Branch:** `feat/86-per-variant` (stacked on `feat/day-part-pricing`)
**Milestone:** M2 — Menu depth
**Scope:** Fourth slice of M2. Mid-service 86'd handling at the leaf level.

---

## WHY

Menu items already carry `available: true/false`. Reception can 86 a
whole dish today, but not a specific size or a specific extra. Real
kitchens run out of the Full-portion braise while still able to serve
Half, or run out of extra cream while every other prep is fine. Hiding
the whole item is heavy-handed and loses revenue on takeable variants.

This PR lifts `available` down to the variant and the modifier option:
one 86'd variant doesn't disable its siblings, and one 86'd extra
doesn't disable the whole modifier group.

Same fail-loud contract as PR 11-13. Legacy items and their variants/
options default to available — nothing needs to change to keep working.

---

## WHAT

### Data shape

Variants (`item.variants[]`) and modifier options
(`item.modifier_groups[].options[]`) both grow an optional
`available: boolean` field. Only an explicit `false` marks them 86'd;
omitted or `true` keeps the pre-existing behaviour.

```js
variants: [
  { id: 'v_boneless', label: 'Boneless', price: 320, available: false },
  { id: 'v_bone_in',  label: 'Bone-in',  price: 290 }
]

modifier_groups: [{
  id: 'mg_extras', label: 'Extras', min: 0, max: 3,
  options: [
    { id: 'extra_cheese', label: 'Extra cheese', price_delta: 40 },
    { id: 'extra_gravy',  label: 'Extra gravy',  price_delta: 30, available: false }
  ]
}]
```

### Pricing rejection codes (new)

- `VARIANT_UNAVAILABLE` — handset picked a variant flagged 86'd. Details
  carry `variant_id` and `variant_label` so the toast can name it.
- `MODIFIER_OPTION_UNAVAILABLE` — handset picked an option flagged 86'd.
  Details carry `group_id`, `option_id`, `option_label`.

Both are distinct from `UNKNOWN_*` because the id IS known to the menu
— the UI should surface "Boneless is 86'd tonight" rather than a
generic "unknown variant".

### Files changed

| File | Change |
|---|---|
| `hub_server/lib/pricing.js` | After the existing "variant found + priced" checks, `variant.available === false` rejects with `VARIANT_UNAVAILABLE`. Inside the modifier loop, `option.available === false` rejects with `MODIFIER_OPTION_UNAVAILABLE`. Both codes ride on `details[]` with resolved labels so the handset can toast the exact culprit. |
| `hub_server/lib/restaurantCache.js` | Supabase→cache normalisation carries the `available` flag on both variants and options, defaulting to true (`v.available !== false`). Seed marks Chicken 65 Boneless variant 86'd and Extra gravy option 86'd so the demo shows both surfaces. |
| `hub_server/test/hub.test.mjs` | +1 test. 86'd variant rejected with distinct code; sibling available variant still succeeds. 86'd option rejected; sibling available option in same group still succeeds. Legacy no-`available` field means available. 108/108 pass. |
| `src/waiter_mobile/RapidOrderBuilder.jsx` | 86'd variant rows keep their place on the menu but render dimmed with an `86'D` chip (rust status colour) inline with the name; the Add button is replaced with an "Unavailable" label so the row can't be tapped. |
| `src/waiter_mobile/ModifierSheet.jsx` | 86'd modifier options render greyed with an `86'D` chip and disabled click. Delta is hidden (the price won't apply anyway). Groups with all options 86'd remain visible so reception sees "Nothing available in Extras" rather than a silently-empty group. |
| `Darshil_docs/README.md` | Index entry for this report. |

Not touched: KOT / receipt / KDS renderers. An 86'd line never reaches
them by construction — the hub rejects on POST /orders. If somehow it
does (fixture bug, direct DB write), the existing renderers pass the
line through unchanged, which is safer than throwing.

---

## TEST CASES

### TC-PR14-01 — Unit: 86'd variant + 86'd option pricing rejects

**File:** `hub_server/test/hub.test.mjs`

| Cart | Expected |
|---|---|
| Chicken 65, `variant_id: 'v_boneless'` (86'd) | reject `VARIANT_UNAVAILABLE`, details carry id + label |
| Chicken 65, `variant_id: 'v_bone_in'` × 2 | ok, total 580 (sibling variant unaffected) |
| Tikka + `mg_extras: extra_gravy` (86'd) | reject `MODIFIER_OPTION_UNAVAILABLE`, details carry group + option + label |
| Tikka + `mg_extras: extra_cheese` | ok, per-unit 380 (sibling option unaffected) |

### TC-PR14-02 — Manual: handset renders 86'd with a clear affordance

**Steps:**

1. Boot the hub with the updated seed.
2. Load the waiter PWA, sign in, pick a table.
3. Menu tab, Starters category. Confirm:
   - Chicken 65 (Bone-in) is takeable at ₹290 as usual.
   - Chicken 65 (Boneless) renders greyed with an `86'D` chip and the
     right column says "Unavailable" — no Add or Customize button.
4. Menu tab, Main Course category. Tap Chicken Tikka Masala (Full)
   to open the modifier sheet.
5. Confirm Extras group shows:
   - Extra cheese — clickable, `+₹40` badge.
   - Extra gravy — greyed, `86'D` chip, no `+₹30` shown, disabled click.
   - No onion, No cream — clickable as before.
6. Complete the required Spice pick, hit Add. Cart shows the line
   without extra gravy.

### TC-PR14-03 — Manual: stale-menu safety

Simulate a stale handset by editing the seed to bring Boneless back
online, boot the hub, load the waiter, then edit the seed back to
`available: false` and restart the hub WITHOUT refreshing the handset.
The old menu is cached client-side.

1. Try to add Boneless from the stale menu.
2. Confirm the /orders POST fails with 400 and `VARIANT_UNAVAILABLE`.
3. Confirm the waiter's error toast names "Boneless".

### TC-PR14-04 — Automated verification

```bash
cd /path/to/Restaurant-Bar-SaaS
npm test          # 108 tests, all pass — 1 M2·PR14 + 4 PR13 + 4 PR12 + 3 PR11 + 96 M1
npm run build     # vite build clean
```

Actual: 108/108 pass in ~1s; vite build clean in 2.5s.

---

## OUT OF SCOPE (queued for follow-up M2 PRs)

- **Multi-station KDS routing** (bar / hot / cold) — PR 15. Menu item
  ships `station: 'bar' | 'hot' | 'cold'`; hub routes the KOT to the
  right printer/display group.
- **Reception admin UI to toggle 86 without editing the seed** —
  separate PR, bundled with the variant/modifier/day-part admin UI.
- **Auto-un-86 timer** — "back in 30 min" scheduling. Deferred.
- **Group-level 86** — for now, 86 every option in a group individually.
  A group-level flag is a two-line follow-up when it becomes worth it.

---

## STATUS: ✅ Ready for review

- 108/108 hub tests pass
- vite build clean
- Feature branch `feat/86-per-variant` pushed to fork, stacked on
  `feat/day-part-pricing`.

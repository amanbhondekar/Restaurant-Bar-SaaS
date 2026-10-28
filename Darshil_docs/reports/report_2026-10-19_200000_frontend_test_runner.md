# Reliability — a frontend test runner, and the first three surfaces under it

**Date:** 2026-10-19T20:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.8 Reliability & observability — "Frontend test suite"

---

## WHY

The hub has 589 tests. The five things people actually touch — the KDS, the admin console, the
waiter PWA, the diner page and the dashboard — had none. Every UI claim in every report on this
branch was checked by hand in a browser, once, on the day it was written, and nothing would notice
if a later change broke it. The roadmap has listed this as open since it was written.

## WHAT

### The runner

| Piece | Choice | Why |
|---|---|---|
| Runner | **Vitest 3.2.4** | Reuses Vite's transform and the `@` alias, so components import exactly as the app does |
| DOM | **jsdom 26.1.0** | Runs on Node 20, which CI still tests |
| Queries | **Testing Library** (react 16.3, dom 10.4, jest-dom 6.6, user-event 14.6) | Tests find things the way a person does — by role and label — so they double as an accessibility check |

All pinned to exact versions in `devDependencies`. Nothing in `dependencies` changed, so the hub
and the production bundle are unaffected — confirmed by `npm run build` bundling no test files.

- **`vitest.config.js` is separate from `vite.config.js`**, so the production build is untouched
  and tests skip Tailwind and CSS: they check behaviour and words, not styling.
- **`src/test/helpers/fakeHub.js`** stands in for `fetch()` per route and records every call, so a
  test can assert on *exactly what the page sent*. A request for a route the test did not declare
  throws, rather than quietly answering — a page asking for something unexpected is itself a
  finding.
- **Scripts:** `npm test` now runs both suites; `npm run test:hub` and `npm run test:web` run one.
  The hub script is unchanged, only renamed.
- **CI:** the frontend suite is its **own step**, after the hub suite, so a red run says which side
  broke. Same Node 20/22 matrix, same `TZ=UTC`.

### What is covered first, and why these

The surfaces where a bug costs most, not the easiest ones:

**The diner page (23 tests).** It is the first thing a stranger sees of the product, on their own
phone, and it posts to the hub's only unauthenticated write. The menu fixture is built with the
**hub's own `publicMenu()`** from a menu cache in the hub's shape, so the tests break if the hub and
the page ever disagree about a field name. Covered: category order, 86'd dishes hidden, Indian
digit grouping, size ranges (and a single price when every size costs the same, not
"₹200 – ₹200"), choices with what they add, veg marks, the scanned table, empty and failed menus
and recovery, `no-store` so an 86 reaches a guest who reloads, and names rendered as text.
Feedback: no send without a rating, the exact body (`table`, `rating`, `comment` — nothing that
names a bill), **one request however impatiently the guest taps**, the cooldown thanked rather than
shown as an error, the hub's reason shown and the guest's text kept on refusal, and the wifi hint
when the request fails outright.

**The admin Feedback tab (10 tests).** The summary, the split, bill and table labels, both
filters, the capped-list note, the empty state, the reception-only explanation, a failed refresh
keeping the last answer, and a hostile comment shown verbatim — with `&` not turned into `&amp;`.

**The waiter modifier sheet (16 tests).** This is where a waiter's number can disagree with the
bill. Eleven tests cover the rules (required groups block adding and name themselves, pick-one
replaces, pick-several stops at its maximum and disables rather than hides, 86'd options can't be
picked, money-off choices, no floating-point pennies on `0.1 + 0.2`).

The other five are **a contract test against the hub's real pricing**. The sheet's output is mapped
exactly the way `OrderDraftDrawer` builds an order line and handed to `hub_server/lib/pricing.js`'s
`priceOrder()`, which must accept it at the price the waiter was shown. It loads the hub modules
with `HUB_DATA_DIR` pointed at a temporary directory first, and uses the same
`restaurantCache.getMenuCache` seam the hub's own pricing tests use.

### Tests that were shown to be able to fail

A test that passes is only evidence if it could have failed:

- **Double-send:** with both of `Feedback`'s guards against a second tap removed, exactly the
  "sends once" test failed (9 passed, 1 failed). The component was then restored with
  `git checkout` and confirmed unchanged.
- **Pricing contract:** with the hub's copy of the menu changed so Extra ghee costs ₹40 while the
  handset still shows ₹30, exactly the two cases that pick ghee failed. Restored.

### A comment that was wrong

`DinerMenu.jsx` said the scanned table code "is never sent anywhere and nothing is decided by it."
It was true when written, and stopped being true when guest feedback landed: `Feedback` sends it,
and the hub uses it to find which bill the rating belongs to. The comment now says that, and that
the hub treats it as guest-supplied input. A test pins the behaviour.

### Files

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | Six exact-pinned dev dependencies; `test` / `test:hub` / `test:web` |
| `vitest.config.js` | New |
| `src/test/setup.js`, `src/test/helpers/fakeHub.js` | New — cleanup between tests; the fake hub |
| `src/test/diner/DinerMenu.test.jsx`, `Feedback.test.jsx` | New — 13 + 10 |
| `src/test/admin/FeedbackTab.test.jsx` | New — 10 |
| `src/test/waiter/ModifierSheet.test.jsx`, `modifierPricingContract.test.jsx` | New — 11 + 5 |
| `src/diner/DinerMenu.jsx` | The stale comment corrected; no behaviour change |
| `.github/workflows/ci.yml` | Frontend suite as its own step |
| `docs/ROADMAP.md` | §1 coverage paragraph (it still said 455 tests), §3 coverage item, §4.8 |

```bash
npm run test:hub   # 589, unchanged
npm run test:web   # 49 across 5 files, ~3 s
npm run build      # clean; no test files in dist/
```

A before/after listing of `hub_server/data/` is identical: neither suite writes there.

## NOT DONE / LIMITS

- **Most of the UI is still uncovered.** The KDS, order entry (`RapidOrderBuilder`,
  `OrderDraftDrawer`), waiter login, the floor grid and the other six admin tabs. Those depend on
  `PosContext`, `hubAuth` and the LAN socket; testing them well needs a small provider harness,
  which is the next piece of work, not something to improvise per test.
- **No real browser.** jsdom has no layout, so nothing here can catch a button pushed off-screen on
  a small phone or a stacking bug. The roadmap's Playwright smoke run is still open; it needs a
  browser download in CI, which is a bigger change to the pipeline.
- **The fake hub is hand-written for the admin tab.** The diner fixture comes from the hub's real
  builder and the pricing contract runs the hub's real code, but the Feedback tab's fixture is
  written by hand to the shape `feedbackStore` returns. The hub suite pins that shape from its side.
- **A latent inconsistency, recorded rather than changed.** A modifier group with no `max` is read
  three ways: the waiter sheet treats it as pick-one, `pricing.js` as pick-one if required and up
  to 99 otherwise, and `menuNormalize` as up to the number of options. It is not reachable today:
  cloud menus pass through `normalizeCloudMenuItem` and the editor always writes `max`, and the
  pilot has no modifier groups at all. But a future path that skips normalisation would have the
  waiter and the bill disagree. Worth one shared default.
- `whatwg-encoding`, pulled in by jsdom, prints a deprecation warning on install. Dev-only.

## STATUS

✅ VERIFIED — 589 hub + 49 frontend under TZ=UTC, build clean; two of the new tests shown to fail
against a deliberately broken component and a drifted hub menu.

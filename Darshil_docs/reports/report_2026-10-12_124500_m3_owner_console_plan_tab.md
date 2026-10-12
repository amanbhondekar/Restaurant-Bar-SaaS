# M3 · PR 18 — Owner console: Plan tab

**Date:** 2026-10-12T12:45:00+05:30
**Branch:** `integration/m3-land`
**Milestone:** M3 — Self-serve tenant (slice 2 of 5)

---

## WHY

PR 16 built `GET /plan` and ended with "feeds the owner console", but nothing consumed it.
The restaurant owner had no way to see which plan they were on, how close they were to a
limit, or — most importantly — **that they had been degraded to Starter and why**. A
degradation is silent by design (service is never interrupted), so without a screen that
says so, a cancelled subscription shows up as features mysteriously disappearing.

### Design rules

1. **Read-only.** Nothing on this tab writes. Changing a plan is PR 19 (billing) and needs
   a payment-provider decision; inventing a half-write here would pre-empt it.
2. **Answers from the hub, not the cloud.** `GET /plan` is served from the hub's own
   config, so the tab works during an internet outage and reports staleness
   ("Checked with the cloud: never") rather than failing.
3. **Degradation is the headline.** When a tenant is on a lower plan than they asked for,
   that is the first thing on screen, it names the reason in the owner's words, and it says
   plainly that service is not interrupted.
4. **Wording and arithmetic are not in the component.** They sit in a plain `.js` module so
   they are unit-testable, matching `cloudStatus.js` / `itemForm.js` / `csv.js`.
5. **The hub is the oracle.** The page must be able to name every feature and limit
   `hub_server/lib/plans.js` defines; a drift guard fails the build if a new one is added
   without a label.

## WHAT

### `src/admin/lib/plan.js` (new, pure)

- `PLAN_LABEL` / `FEATURE_LABEL` / `LIMIT_LABEL`, and `planLabel()` which falls back to the
  raw key so an unknown plan from a newer cloud schema still renders.
- `planBanner(plan)` → `{ tone, title, body } | null`. **Degradation outranks the grace
  period**: on a degraded plan, "everything still works" would be a lie. Each reason
  (`TRIAL_EXPIRED`, `PAYMENT_OVERDUE`, `SUSPENDED`, `CANCELLED`) gets its own sentence, with
  a fallback for reasons added later, and every degraded message ends with "Orders, billing
  and the kitchen display are never switched off."
- `usageTone(current, limit)` → `green` / `amber` (one short) / `rust` (at or over) /
  `none` (uncapped or uncounted), so proximity to a limit is visible without reading digits.
- `limitRows(plan)` / `featureRows(plan)` — the rows the tab draws, in the hub's own key
  order, tolerant of a missing `limits` / `features` / `usage`.

### `src/admin/PlanTab.jsx` (new)

Loads `/plan` on mount with a manual Refresh; renders the banner, a current-plan header with
the last cloud check, a limits grid and a features list. On a failed reload it keeps the last
answer and adds a warning rather than blanking the page.

`tables` is the one limit the hub caps but does not count — PR 16 enforces it at provisioning
because truncating a live floor plan mid-service would be an outage — so that row shows the
cap with no bar and the line "Checked when the restaurant is set up, not on this hub."

### `src/admin/AdminApp.jsx`

Sixth tab, `plan`, mounted on demand like Cash / Kitchen / Printers (not `keepMounted`), so
opening the console costs nothing extra. The saved-revision and cloud pills stay scoped to
the menu and tables tabs.

### Files

| File | Change |
|---|---|
| `src/admin/lib/plan.js` | New — labels, banner, tones, row builders |
| `src/admin/PlanTab.jsx` | New — the tab |
| `src/admin/AdminApp.jsx` | Import, `TabsTrigger`, `TabsContent` (+5 lines) |
| `hub_server/test/adminPlan.test.mjs` | New — 17 tests |

No hub or server change: `GET /plan` already returned everything needed.

## TEST CASES (`hub_server/test/adminPlan.test.mjs`)

Driven through the hub's real `resolveEffectivePlan` / `getLimits` / `getFeatures`, with a
`planResponse()` helper that assembles the body the same way `server.js` does — so these
fail if the hub's semantics change, not just if the view does.

| ID | Title | Expected | Actual |
|---|---|---|---|
| PL-1 | Drift guard | Every plan, feature and limit in `PLANS` has a label | Pass |
| PL-2 | Unknown keys | Fall back to the raw key, no crash | Pass |
| PL-3 | Healthy subscription | No banner (active, trialing, legacy no-plan hub) | Pass |
| PL-4 | Each degradation | Correct reason from the hub + matching sentence + "never switched off" | Pass |
| PL-5 | Past-due grace | Warning tone, not error; names the end date | Pass |
| PL-6 | Grace, no period end | In grace, reads without a date | Pass |
| PL-7 | Degraded **and** in grace | Error wins | Pass |
| PL-8 | Unrecognised reason | Still degrades, usable sentence | Pass |
| PL-9 | `usageTone` thresholds | 0/3 green · 2/3 amber · 3/3 rust · 9/3 rust · uncapped/uncounted none | Pass |
| PL-10 | Counted limits | "3 of 3", rust, 100% | Pass |
| PL-11 | Tables | Uncapped count: "– of 15", no bar, explanatory line | Pass |
| PL-12 | Enterprise | "42 of unlimited", no bar, no tone | Pass |
| PL-13 | Row order | Matches `PLANS.pro.limits` key order | Pass |
| PL-14 | Features by plan | Starter all off; Pro all on; **cancelled Pro shows Starter's**, not what was paid for | Pass |
| PL-15 | Missing data | `[]`, no throw, incl. `null` / `undefined` | Pass |
| PL-16 | Never synced | `null` / `''` / garbage → "never" | Pass |
| PL-17 | Real timestamp | Rendered, raw ISO never reaches the page | Pass |

```bash
npm test      # 438 existing + 17 new = 455
npm run build # clean
```

### Browser verification (`http://localhost:4000/admin` → Plan)

1. **Healthy (the live pilot hub).** Pro · active; handsets 0 of 10, waiters 3 of 25,
   tables – of 60, printers 0 of 4; all five features "Included"; "Checked with the cloud:
   never" (no `.env` on this machine). No console errors.
2. **Degraded.** Set `plan: pro`, `plan_status: cancelled` in `hub_server/data/hub_config.json`
   and restarted the hub: red banner "Running on Starter, not Pro — This subscription was
   cancelled… Orders, billing and the kitchen display are never switched off."; header reads
   Starter · cancelled; limits drop to 0 of 3 / 3 of 5 / – of 15 / 0 of 1; all five features
   flip to "Not on this plan". **`hub_config.json` was restored afterwards.**

That second case is also an end-to-end check of PR 16's enforcement, not just of this view.

## NOT DONE / LIMITS

- **No upgrade path.** The banner explains the degradation but offers no way to fix it;
  that is PR 19 and is blocked on the payment-provider decision.
- **No devices or staff list.** PR 16 scoped the owner console as
  "plan/usage/devices/staff"; this slice ships plan and usage. Per-device and per-waiter
  listings are not here.
- **No live refresh.** The tab loads on mount and on Refresh. It does not poll or listen on
  the WebSocket, so a plan change synced in the background (every 15 min) is not reflected
  until the owner reloads. Deliberate — plan changes are rare and polling the hub for them
  would be noise.
- `formatWhen()` uses the browser locale, so the rendered string is machine-dependent; the
  tests assert on behaviour ("never", no raw ISO, contains the year) rather than an exact
  format.
- Verified on a desktop viewport only — not on a reception laptop at its real resolution,
  and not on a tablet.
- **The suite is intermittently flaky, and this slice does not fix it.** Across 12
  consecutive runs, 10 were 455/455 and 2 failed inside hub-fixture tests (once 3 failures,
  once a file that did not finish, reporting 427 of 455). This is *not* the deterministic
  4598 collision fixed in the merge — that one failed every parallel run and never failed in
  isolation. Six test files still hardcode their fixture port, so a hub left in `TIME_WAIT`
  by a previous run, or a slow start under load, can still make one fail. Fixing it properly
  means giving `spawnHub.mjs` dynamic port allocation and migrating the two hand-rolled
  fixtures (`plans.test.mjs`, and the others predating the helper) onto it.
- The tab is reachable by anything that can reach `/admin` (loopback / trusted local
  address). It exposes plan and usage, not billing identifiers.

## STATUS

✅ VERIFIED — 455/455, build clean, both states confirmed in the browser. Not yet committed
at the time of writing.

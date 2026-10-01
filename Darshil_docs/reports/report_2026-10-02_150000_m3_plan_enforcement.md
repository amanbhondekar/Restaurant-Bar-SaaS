# M3 · PR 16 — Plan model + enforcement in the hub

**Date:** 2026-10-02T15:00:00+05:30
**Branch:** `feat/m3-plan-enforcement`
**Milestone:** M3 — Self-serve tenant (slice 1 of 5)

---

## WHY

`restaurants.plan` (`starter` / `pro` / `enterprise`) has existed since the first
schema, but nothing enforced it, so every tenant effectively got everything. Self-serve
signup, billing and the owner console (PR 17-19) all need one authoritative answer to
"what is this tenant allowed to do right now?". This PR builds that answer once, in a
pure module, and enforces it at the hub.

### Design rules (the part worth reviewing)

1. **Never take a restaurant offline over a plan or payment problem.** Suspended,
   cancelled, trial-expired or past-grace tenants *degrade to Starter limits and
   features*. Order entry, KOT printing and bill preview keep working (tested).
2. **Limits gate only NEW additions.** A tenant over a limit after a downgrade keeps
   existing devices/staff/history; they just can't add more.
3. **Legacy hubs are treated as `pro`.** A hub with no `plan` in its config (it predates
   plan sync) resolves to `pro`, so updating the hub software never silently strips
   features from the pilot tenant.
4. **Fail-soft sync.** Offline or erroring Supabase keeps the last synced plan; a LAN-only
   restaurant keeps the entitlements it last had.
5. **Plan checks never run before authentication.** The device-limit check happens only
   after the enrollment code is verified, so an unauthenticated caller can't probe plan data.

## WHAT

### Entitlements (`hub_server/lib/plans.js`, new, pure)

| | Starter | Pro | Enterprise |
|---|---|---|---|
| Devices / Waiters / Tables / Printers | 3 / 5 / 15 / 1 | 10 / 25 / 60 / 4 | unlimited |
| Split-bill, Refunds | no | yes | yes |
| Modifier groups, Day-part pricing, Multi-station KOT | no | yes | yes |
| Variants, 86'd availability, billing, KOT/receipt printing, PIN login | yes | yes | yes |

`resolveEffectivePlan(tenant, now)`:

| `plan_status` | Effective plan |
|---|---|
| `active` | requested plan |
| `trialing` | requested plan until `trial_ends_at`, then Starter (`TRIAL_EXPIRED`) |
| `past_due` | requested plan for 7 days after `current_period_end` (grace), then Starter (`PAYMENT_OVERDUE`) |
| `suspended` / `cancelled` | Starter (`SUSPENDED` / `CANCELLED`) |
| unknown | requested plan (a newer cloud schema must not punish the tenant) |

### Enforcement points

| Where | Behaviour |
|---|---|
| `POST /auth/device` | After code verification: refuse with `403 PLAN_LIMIT_REACHED` (`limit_key`, `limit`, `current`, `plan`, `upgrade_to`) when active devices ≥ limit. Expired tokens don't count. |
| `POST /waiters` | Same structured refusal when active waiters ≥ limit. |
| `POST /invoices/:id/split-by-{seats,items,amounts}` | `403 PLAN_FEATURE_UNAVAILABLE` (`split_bill`). Settling/un-splitting an already-split invoice is **not** gated. |
| `POST /invoices/:id/refund` | `403 PLAN_FEATURE_UNAVAILABLE` (`refunds`). |
| `restaurantCache.getMenuCache` | Strips `modifier_groups` / `day_parts` / `station` the plan lacks. Single read point shared by `GET /menu` and the pricer, so handsets and billing always agree. Variants and 86'd flags are never stripped. |
| `hubConfig.getPrinters` | Only the first N configured printers are used; extras stay in config and return on upgrade. |
| `GET /plan` (new, device-auth) | Effective plan, requested plan, status, degradation reason, grace window, limits, features, usage, last sync. Feeds the owner console (PR 18). |

A stale handset that still sends `modifiers[]` for an item whose modifiers are gated is refused
with `SPURIOUS_MODIFIERS` (the PR 12 fail-loud rule) rather than silently mispriced.

### Files

| File | Change |
|---|---|
| `hub_server/lib/plans.js` | **New.** Pure entitlement rules. |
| `hub_server/lib/hubConfig.js` | `getEffectivePlan()`, `syncPlanFromCloud()` (fail-soft), plan fields copied at pairing, printer cap. |
| `hub_server/lib/restaurantCache.js` | `setFeatureProvider()` hook + gating in `getMenuCache`; default provider grants everything so standalone use/tests are unchanged. |
| `hub_server/lib/deviceAuth.js` | `activeDeviceCount()`; `enroll()` takes a post-verification `guard`. |
| `hub_server/server.js` | `requireFeature()` middleware, enforcement points above, `GET /plan`, plan sync at boot and every 15 min. |
| `database/migrations/002_plan_status.sql`, both `supabase_schema.sql` copies | `plan_status`, `trial_ends_at`, `current_period_end` + CHECK constraints. |
| `hub_server/test/plans.test.mjs` | **New.** 18 tests. |

No frontend change was needed: handset enrollment already surfaces the server's `error`
text, so the plan message appears in the pairing modal.

## TEST CASES (`hub_server/test/plans.test.mjs`)

Pure rules: plan-id whitelisting; tier monotonicity (a higher plan never loses a feature or
gets a lower limit — guards future edits to `PLANS`); status matrix incl. legacy/unknown;
past_due grace boundary; suspended/cancelled; `checkLimit` incl. already-over-limit and
unlimited; `featureRefusal`; menu stripping (no mutation, no needless copies, per-flag).

Live hub (second child process on :4598, subscribed to **Pro** but status **cancelled**):
wrong code → 401 with no plan leak; 3 devices enroll, 4th → 403 with limit details;
`GET /plan` reports the degraded plan; waiter limit; `/menu` stripped but variants kept and
day-part price not applied; order priced at base with station `hot`; stale-modifier refusal;
split/refund → 403; **core flows (order entry, bill preview, KOT reprint) still work**.

```bash
npm test      # 112 existing + 18 new
```

## OUT OF SCOPE (next M3 slices)

- **PR 17** signup + tenant provisioning (creates the `restaurants` row with a trial).
- **PR 18** owner console (consumes `GET /plan`; plan/usage/devices/staff).
- **PR 19** subscription billing (writes `plan`, `plan_status`, `current_period_end`) — needs a
  payment-provider decision.
- **PR 20** Windows installer + docs.
- `tables` limit is defined but enforced at provisioning time (cloud side), not by the hub:
  truncating a live floor plan mid-service would be a service outage.

## STATUS

Verified locally; see test output above. Not yet pushed or merged.

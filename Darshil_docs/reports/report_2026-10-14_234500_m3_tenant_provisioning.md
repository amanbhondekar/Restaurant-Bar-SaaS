# M3 · PR 17 — Tenant provisioning, and a pairing trap it exposed

**Date:** 2026-10-14T23:45:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M3 — Self-serve tenant (slice 3 of 5)

---

## WHY

M3's goal is that the product can onboard a restaurant **without engineering**. Onboarding today
is four manual steps in the Supabase SQL editor:

1. hand-write a `restaurants` row,
2. invent a `pairing_code` nothing has checked for uniqueness,
3. run `set_hub_provisioning_secret()`,
4. paste the plaintext secret into that hub's `.env`.

Every one is a chance to create a tenant that is subtly wrong — a duplicate pairing code, a plan
with no trial end, or the common one: **a restaurant row with no provisioning secret at all**,
which produces a tenant that looks fine, pairs fine, and can never sync a single order.

## WHAT

### `provision_restaurant()` — migration 007

One call that either produces a complete, usable tenant or changes nothing:

```sql
SELECT * FROM public.provision_restaurant(
    p_name   => 'Spice Garden Bistro',
    p_city   => 'Bengaluru',
    p_secret => '<a long random secret for this hub>'
);
```

Returns the restaurant id, the pairing code to type into the hub, the slug and the trial end. The
secret is never returned or stored in plaintext — the caller already has it.

Decisions worth reviewing:

- **It refuses a secret shorter than 16 characters** rather than creating the tenant. A tenant
  that cannot bind a hub is worse than no tenant, because it fails silently much later.
- **New tenants start on `pro` / `trialing`**, not `starter`. A restaurant evaluating the product
  should see what it is buying, and `lib/plans.js` already degrades a trial to Starter the moment
  `trial_ends_at` passes, without interrupting service. Fourteen days, in one named function.
- **Pairing codes avoid `I` and `O`** and are generated in a uniqueness loop. This string gets
  dictated down a phone line to a noisy kitchen; `I`/`1` and `O`/`0` are the obvious hazard.
- **Not reachable from the API.** `REVOKE`d from `anon` and `authenticated`, the same posture as
  `set_hub_provisioning_secret`. Creating tenants is an operator action; exposing it to `anon`
  would let anyone fill the table with restaurants.

Slug and pairing-code generation are separate functions so the next slice (a signup surface) can
reuse them.

### The pairing trap

Reading the hub side turned up a real defect. `pairWithCode` looked the code up in the cloud and,
if that produced nothing **for any reason**, fell through to a hardcoded `DEMO_RESTAURANTS` list:

```js
} catch (err) {
  console.warn('ℹ️ Supabase lookup failed during pairing, falling back to local database:', err.message);
}
// 2. Fallback check against local demo restaurants list
```

Two ways that is wrong for a self-serve product:

- A real restaurant pairing **while its internet was down** would be bound to whatever demo tenant
  happened to share its code — and told it had succeeded. It would then take orders against the
  wrong `restaurant_id`.
- A configured cloud positively answering *"no such code"* was overruled by a hardcoded list.

A configured cloud is now the authority on which codes exist. An unreachable one refuses with
`CLOUD_UNREACHABLE` and says to connect to the internet, rather than guessing. The demo tenants
still work on a hub with **no cloud configured at all** — "there is no cloud" is a different
situation from "the cloud does not know this code", and the offline demo is a real use of this
product.

Pairing also now reports the plan it joined on, so a trial is visible at the moment it starts
rather than discovered when features begin disappearing.

### Files

| File | Change |
|---|---|
| `database/migrations/007_tenant_provisioning.sql` | New — `provision_restaurant`, `generate_pairing_code`, `generate_restaurant_slug`, `default_trial_days` |
| `hub_server/lib/hubConfig.js` | `cloud` test seam, `cloudConfigured()`, authoritative-cloud pairing, trial reported on pair |
| `hub_server/test/pairing.test.mjs` | New — 11 tests |

## TEST CASES (`hub_server/test/pairing.test.mjs`, 11 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| PR-1 | Known code | Binds the hub to that tenant | Pass |
| PR-2 | Whitespace and case | Matched however it is typed | Pass |
| PR-3 | **Trial reported** | `trialing`, on `pro`, with the end date | Pass |
| PR-4 | Expired trial | Reported as the Starter it degraded to; pairing still succeeds | Pass |
| PR-5 | **Cloud says no** | Final — the demo list does not overrule it; hub left unpaired | Pass |
| PR-6 | **Cloud unreachable** | `CLOUD_UNREACHABLE`, says to connect; hub left unpaired | Pass |
| PR-7 | Cloud errors | Treated as unreachable, not as an empty answer | Pass |
| PR-8 | No cloud configured | Demo tenants still pair | Pass |
| PR-9 | No cloud, unknown code | Still refused | Pass |
| PR-10 | Malformed input | Refused before the cloud is asked | Pass |
| PR-11 | `cloudConfigured` | The placeholder project is not a cloud | Pass |

```bash
npm test       # 516 + 11 = 527
npm run build  # clean
```

The pilot hub was restarted on this code: `/`, `/admin` and `/dashboard` serve, and it is still
paired to Hotel Mejwani — the change affects how a hub *becomes* paired, not one that already is.

## NOT DONE / LIMITS

- **Migration 007 has never been executed.** Same as 005 and 006. It is the one piece of this
  slice with no test at all behind it — the SQL was reviewed by reading, and one bug was caught
  that way (a name with no usable letters produced a NULL pairing code, because `NULL || '-'` is
  NULL), which is a fair indication there may be others. **Run it against a scratch project before
  provisioning anything real.**
- **There is still no signup surface.** This replaces four manual SQL steps with one; it does not
  put a form in front of a restaurant owner. That is the rest of PR 17 and needs a decision about
  where signup lives — a page on the dashboard, or an operator tool.
- **The secret is still handled by a human.** `provision_restaurant` takes it and hashes it, but
  someone still has to generate it and paste it into that hub's `.env`. Automating that means a
  hub that can fetch its own credentials, which is a security design, not a refactor.
- **Pairing still does not verify the tenant is provisioned.** A hub can pair to a restaurant whose
  `hub_provisioning_secret_hash` is null and will fail to sync later with no hint at pairing time.
  007 makes such tenants impossible to *create*, but any that already exist are unchanged, and the
  hub cannot read that column under RLS to check.
- `DEMO_RESTAURANTS` still ships in the hub binary. It is now reachable only with no cloud
  configured, but it is still a hardcoded tenant list in a multi-tenant product.

## STATUS

✅ VERIFIED — 527/527, build clean, hub boots and stays paired. Migration unexecuted; see limits.

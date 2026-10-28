# 4.4 Tenant lifecycle — the signup surface and Razorpay subscriptions

**Date:** 2026-10-21T16:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.4 Tenant lifecycle — the last two items (M3 · PR 17 signup surface, PR 19 subscription billing)

---

## WHY, AND THE THING THAT BLOCKED BOTH

Two items were open, and they looked unrelated. Reading the code showed they were the same problem.

**Migration 007 revokes `provision_restaurant()` from `anon` and `authenticated`**, with a comment
saying it is for "a trusted signup service with its own credentials — never by anon, which could
otherwise fill the table with restaurants". That is the right posture. It also means **no part of this
product could call it**: not the hub (it sits on a restaurant's wifi and must never hold a service
key), not the admin console (it is the hub), not a guest.

Razorpay has the same shape from the other end. A subscription's state arrives as a **webhook to a
public address**, and a hub has none. Nor should a hub hold the Razorpay secret.

So both items needed one thing that did not exist: a small service that holds privileged credentials
and is not part of any restaurant's installation. The payment provider was settled as **Razorpay**
(India-first; UPI is how restaurant bills get paid here).

## WHAT

### `signup_server/` — the operator service

One deliberately tiny service, holding exactly two secrets nothing else may hold: the Supabase
**service key** and the **Razorpay webhook secret**. It is run by whoever operates Kullina — not
something a restaurant installs. `npm run signup`.

**`POST /signup`** validates against the same rules `provision_restaurant()` enforces (so a mistake is
a sentence beside a field, not a Postgres exception), generates the hub provisioning secret, calls the
RPC, and tells the operator the pairing code, the trial end, and the secret to paste into that hub's
`.env`.

The secret appears there and nowhere else, ever. The database keeps a bcrypt hash; the hub keeps it in
its own `.env`. There is deliberately no third copy, and the response says so.

Access is `Authorization: Bearer <token>`, compared in constant time. Two choices worth reviewing:

- **A service with no token configured refuses every request.** The failure mode of a forgotten
  environment variable must not be "anyone may create restaurants".
- **The `Bearer` scheme is required strictly.** My first version also accepted a bare token, which is
  friendlier to an operator with `curl` at the price of one more shape an auth path has to be reasoned
  about in. On this route that trade goes the other way. A test caught the leniency.

**`POST /webhooks/razorpay`** verifies the signature **against the raw bytes** before anything else —
without that, the endpoint is a way for anyone to put any tenant on any plan. It then maps the event
to a plan status and writes it to `restaurants`.

Express's JSON parser would have made this impossible to get right, because re-serialising a parsed
body changes the bytes Razorpay signed; the route takes `express.raw` and everything else takes JSON.

### `hub_server/lib/razorpay.js` — the parts that are ours

No network calls: the signing and the meaning are what is worth owning and testing.

- **Verifying a Checkout result** (`order_id|payment_id` HMAC). This is what makes §4.5's order-and-pay
  possible on a hub with no public address: the guest's phone returns the signature and the hub checks
  it locally. No callback needed.
- **Verifying a webhook** against the raw body.
- **`toPaise` / `fromPaise`**, because Razorpay counts integer paise.
- **What a subscription state means.** The rule that matters: a payment problem becomes `past_due`,
  **never `suspended`**. `past_due` runs the grace window in `plans.js`, so a card that expires on a
  Friday night does not take the till down mid-service.
- Razorpay counts **seconds**; everything here counts **milliseconds**. Getting that wrong puts every
  past-due tenant either instantly out of grace or in it until the year 58000 — and both look like
  working billing until someone reads a date. There is a test that pins the year.

### Migration 010 — `subscriptions`, `subscription_events`

A **record**, not a source of truth for entitlement: which Razorpay subscription belongs to which
restaurant, and an append-only log of applied events, so "why is this tenant past_due" has an answer
that is not somebody's Razorpay dashboard. Entitlement already works off `restaurants.plan_status`,
which migration 004 added and the hub already syncs — so the webhook's write lands end-to-end with no
new plumbing.

RLS is on with **no policy for anon or authenticated**, unlike every other tenant table. A hub never
needs these rows: it learns what it is entitled to from `plan_status`. A hub that could read its own
billing could also write it.

### Files

| File | Change |
|---|---|
| `signup_server/server.js`, `lib/provision.js` | New — the operator service |
| `hub_server/lib/razorpay.js` | New — signatures, money, event meaning |
| `database/migrations/010_subscriptions.sql` | New |
| `package.json` | `npm run signup` |

## TEST CASES (37 new)

| File | N | Covers |
|---|---|---|
| `razorpay.test.mjs` | 18 | A genuine Checkout result verifies; **a signature replayed from a cheaper bill does not**; missing fields refused rather than thrown at a guest; webhooks verified against raw bytes (a trailing space fails); rupees → integer paise with no float drift; a bill with nothing to collect refused before Razorpay is asked; **a payment problem is past_due, not suspended**; **seconds vs milliseconds**; unknown events ignored rather than guessed at |
| `signupService.test.mjs` | 19 | The validation rules; a secret long enough for migration 007 and never repeated; named RPC args omitting absent optionals; the operator told the secret once. Then the service: a tenant created; **without the token nothing is created and the database is never asked**; **no token configured refuses everyone**; a bad body refused before the RPC; a database refusal reported rather than claiming success. Webhooks: a signed charge applies; **unsigned, forged, and tampered-after-signing all change nothing**; a failed charge is past_due; unknown events acknowledged (a 4xx would make Razorpay redeliver forever); **a database failure answers 5xx so Razorpay retries** — losing a "paid" event would strand a paying restaurant past_due; no secret configured refuses |

**Two real bugs my own tests caught**, both in `razorpay.js`:

- `Number(null)` is `0`, so a bill with a missing amount became an order for **₹0** instead of a
  refusal.
- `verifyPaymentSignature` destructured its argument in the signature, so a `null` body from a guest's
  phone **threw** instead of returning false.

```bash
npm run test:hub   # 837 (800 + 37)
npm run build      # clean
```

## NOT DONE / LIMITS

- **Nothing here has run against Razorpay or a real Supabase project.** Signatures are verified
  against HMACs this suite generates, which is exactly how Razorpay generates them, but no live key
  has been used. Migrations 004–010 remain unrun.
- **Nothing creates a subscription yet.** `subscriptionPayload()` builds the body; the three lines of
  HTTP that post it, and the owner-facing "start a subscription" flow, are not written. A tenant's
  plan is still set by hand.
- **The operator service has no UI** — it is two JSON endpoints. Signup is `curl` with a token.
- **`subscriptions` and `subscription_events` are not written yet.** The webhook updates
  `restaurants.plan_status`, which is what gates the product; filling the record tables is a second
  pass.
- **No idempotency on webhooks.** Razorpay redelivers, and replaying `subscription.charged` is
  harmless (it sets the same state), but a strict implementation would record the event id and skip
  duplicates. The `subscription_events` table exists for that.
- **The service is unauthenticated apart from one shared token**, with no rate limiting and no audit
  of who used it. For an operator-run service behind a firewall that is proportionate; exposed on the
  internet it is not.
- **Deployment is undecided** — §4.9 territory. Where this runs, and how Razorpay reaches it, is an
  open question this slice does not answer.

## STATUS

✅ VERIFIED — 837 hub tests, build clean; two bugs found and fixed by the tests.
⚠ Unrun against Razorpay and Supabase. Nothing creates a subscription yet.

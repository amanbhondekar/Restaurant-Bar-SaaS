# Starting, switching and cancelling a subscription

**Date:** 2026-10-23T21:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.4 Tenant lifecycle: the last open item ("nothing CREATES a subscription; a tenant's plan is still set by hand")

---

## WHAT WAS MISSING, AND WHAT TURNED UP ON THE WAY

The operator service could already *receive* Razorpay's webhooks and keep `plan_status` honest. Nothing could *start* a
subscription, so a restaurant's plan was set by hand, and there was no screen on which an owner could pay, switch or stop.

Reading the code to plan this turned up something the roadmap had wrong. §4.4 said migration 010 "records which
subscription belongs to which tenant and logs every applied event". **It did not.** The `subscriptions` and
`subscription_events` tables existed, and nothing in the product wrote to either. The roadmap now says so, and the flow
below is the first thing that does.

## HOW IT WORKS

```
Plan tab (reception laptop)  →  hub  →  operator service  →  Razorpay
   buttons and wording          forwards    decides, holds the keys     hosted payment page
```

- **The owner presses "Subscribe to Pro".** The service asks Razorpay to create the subscription and hands back Razorpay's
  hosted page. **Nothing is charged until the owner authorises payment on that page**, and the panel says so.
- **Razorpay's webhooks** then move the subscription along. Only an `active` subscription sets `restaurants.plan`. A payment
  problem stays `past_due`, so the hub's 7-day grace applies and **a restaurant is never switched off for one**.
- **Switching plan and cancelling** both take effect at the end of the paid period, never today, and both ask first.
- The hub never holds a Razorpay key. **Which restaurant it is comes from the hub's own cloud sign-in** (`auth.getUser`, then the
  `staff_users` row), never from the request: a body that names another restaurant is not looked at. A waiter's login is
  refused; an owner, a manager and the hub's own `kitchen` identity are allowed.

## WHAT CHANGED

**Operator service** (`signup_server/`)
- `lib/razorpayApi.js` (new): the four calls to Razorpay (create, cancel, change plan, read). Every failure is an *answer*, never an
  exception; the secret is never in one; ids are escaped into the path; every call has a timeout.
- `lib/billing.js` (new): the rules that are ours: which plans can be bought (`pro`, `enterprise`, each named by an env
  variable, no price anywhere), which statuses are live, which can be cancelled, and what a hub may be told about a subscription
  (no tenant id, no customer or plan id; the payment link only while it is waiting to be paid).
- `server.js`: `GET /subscriptions/current`, `POST /subscriptions`, `/subscriptions/cancel`, `/subscriptions/change-plan`; a few
  seconds' wait between attempts per restaurant; the webhook now applies events in order and once.

**Database**: `database/migrations/018_subscription_flow.sql` adds `plan`, `short_url`, `cancel_requested_at`,
`plan_change_to`, `last_event_at` to `subscriptions` and `razorpay_event_id` (unique) to `subscription_events`.

**Hub**: `lib/billingClient.js` (https only, or localhost; no credentials in the address; the token is never in an answer),
`lib/billingRoutes.js` (`/admin/billing…`, reception only, forwards only `plan`), wired in `server.js`.
`lib/razorpay.js`: `subscriptionPayload` carries our plan name in `notes`; `readSubscriptionEvent` also returns the plan id, the
period start and when Razorpay says the event happened.

**Owner console**: `src/admin/lib/subscription.js` (what each state says and offers), `src/admin/SubscriptionPanel.jsx`,
`PlanTab.jsx` (reads billing first, so a Refresh re-reads the plan from the cloud before showing it; a billing read that fails
never stops the plan from showing), `AdminApp.jsx` (passes `notify`), `ui.jsx` (`ConfirmDialog` takes a `cancelLabel`).

**Docs**: new `docs/OPERATOR_SERVICE.md` (environment, Razorpay dashboard setup, what happens step by step, limits);
ROADMAP §1, §3, §4.4 and M3, CHANGELOG, `OWNER_VIEW.md`; migrations are now "001–018" throughout.

## WHAT THE OWNER SEES

Every state is worded in `describeBilling`, and each was tested: *not connected* (no billing service on this hub); *unavailable*
(no internet, or the hub has not signed in to the cloud yet, or the service is not answering); *not subscribed* (one button per
plan on offer); *waiting for payment* (a link that opens on its own tab, https only, and the words "nothing is charged until you
do"); *running* (renews on, switch, cancel); *set up but not yet charged*; *last payment failed* (warns, does not claim the plan is
lost); *ending* (when, and that it keeps working until then); *ended* and *payments stopped* (start a new one).

## TESTS

Written first, and run failing before the code existed at each layer (the panel's first run failed on the missing module). The tests
that close mutation gaps were added afterwards and passed on their first run, as they should: the code was right and the tests
were missing; the mutation pass below is what shows they bite.

| File | Tests | What it pins |
| --- | --- | --- |
| `razorpay.test.mjs` | 21 (+3) | the plan in `notes`; the event's plan id, period start and time read from a webhook |
| `razorpayApi.test.mjs` | 19 | the requests are the ones Razorpay documents; every failure is an answer; the secret is never in one; the plan rules |
| `subscriptionService.test.mjs` | 52 | who may ask (no session, forged, no restaurant, waiter, other tenant); the restaurant is never read from the body; reuse of an open payment page; a second subscription refused while one is live; cancel and change rules; the wait between attempts to the millisecond; webhook order, redelivery, stale events, plan from the plan id, failures answered 5xx |
| `subscriptionRoundTrip.test.mjs` | 11 | the same writes against the **real SQL schema** (PGlite): grants, the unique indexes, the service role |
| `billing.test.mjs` | 25 | the hub's client (address rules, no token in any answer, every failure an answer) and routes (reception only; only `plan` forwarded; status passed through), including real spawned hubs |
| `signupService.test.mjs` | 19 | unchanged assertions, now on the shared in-memory cloud |
| `SubscriptionPanel.test.jsx` | 36 | each state's words and buttons; asking before switching or cancelling; sending only the plan; buttons disabled while a request is out; a refusal said in the service's words |
| `PlanTab.test.jsx` | 18 | the plan still shows when billing cannot be read; a stale billing read is replaced, not left up |

Suites: **hub 1333 → 1444 tests (67 → 71 files); frontend 875 → 911 (43 files)**; `npm run build` passes.

## MUTATION CHECKS

Each rule was broken on purpose; the suite must notice.

- **Plan tab** (50 mutants): 45 caught, **5 survived**: one redundant fallback (a `HubError`'s message already is its `error`;
  simplified), and four real gaps, closed with tests: the confirm dialog's busy state, the switch dialog's title, the status dot's
  colour, and `notify` not being passed through the Plan tab. The re-run (8 mutants, including the cancel dialog's title) was all
  caught. Two things are **not** observable in jsdom and are not tested: the cancel button's destructive *colour*, and keeping the
  dialog's text while it fades out.
- **Server and hub** (179 mutants over the Razorpay client, the billing rules, the subscription routes, the webhook, the hub's client
  and routes): 132 caught, **47 survived**. Sorted:
  - 8 were my mistake: the rules in `billing.js` are tested in `razorpayApi.test.mjs`, which that group had not been given.
  - 3 were code that did nothing (a flag and two guards that could not change an answer): **removed**.
  - 2 are equivalent and kept (below).
  - **34 were real gaps**: among them a `500` not being Razorpay's fault, whitespace in an env-file plan id, a JSON reply of `null`
    being accepted as a subscription, a stale event redelivered being retried instead of acknowledged, the boundary of the
    wait between attempts, a plan change with no keys, a health check that claimed billing without a database, and error
    paths that were only logged. All closed with tests.
  - Final: **172 caught, 2 equivalent** (5 earlier mutants no longer exist after the change below).
- The two that stand: `read.event_at &&` in the stale-event check is redundant because `Date.parse(null)` is `NaN` and
  `NaN` compares false; and `body: JSON.stringify(body)` on a GET is `body: undefined`, which `fetch` ignores.

**One survivor found a real defect.** A payment page for the *same* plan with no link on file fell through to "a payment page for
*another* plan is already open", which would have sent the owner looking for the wrong thing. It now answers
`PENDING_PAYMENT` and says the link was not kept and the page lapses by itself.

## CHECKED IN A REAL BROWSER

On a scratch hub (a copy of the pilot's data; the pilot's `hub_server/data` was not touched and the preview config was
restored): the Plan tab with no operator service says "Online billing is not connected", and with an operator service address but
no cloud sign-in says "Billing is unavailable right now. This hub has not signed in to the cloud yet." Layout, theme and an empty
console were as expected. **The states with a live subscription were not seen in a browser**: they need a signed-in hub and a
service, so they are covered by the component tests only.

## WHAT IS NOT DONE

- **Razorpay has never been called for real.** The requests follow its published Subscriptions API and run against a stand-in.
  No keys or plan ids exist on this machine. The first run in test mode will probably find something.
- **Migrations 010–018 have not run on a hosted Supabase project.** Without 018 a new subscription is not recorded and every
  webhook is answered `502`.
- **A subscription is created for 12 billing periods** (`total_count`). After the twelfth it completes and the restaurant falls
  back to Starter. Whether 12 is right is a commercial decision nobody has made.
- A payment page that was never used **cannot be cancelled** (nothing was authorised); it lapses. A plan can be switched only
  once the first payment has gone through.
- **Anyone at the reception laptop can start or cancel**: the hub speaks as the restaurant's `kitchen` identity, so the service
  cannot tell the owner from whoever is there. There is no manager PIN in front of it.
- **No public signup page.** `POST /signup` is still for the operator; a page a stranger can use needs a captcha, email
  verification and a host, none of which are decided.
- The Windows installer and fleet view (§4.9) are not part of this.

Status: ✅ VERIFIED against stand-ins and the real SQL schema; ⚠ unrun against Razorpay and a hosted Supabase project.

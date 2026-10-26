# The operator service

`signup_server/` is the one part of Kullina that is **not** installed at a restaurant. Whoever operates Kullina runs it, somewhere
with a public address, because it holds the credentials a hub must never hold: the Supabase **service key** and the **Razorpay
keys**. It is small, keeps no state of its own beyond rate limits held in memory, and every tenant's data lives in Supabase.

It does five jobs:

| Job | Route | Who may call it |
| --- | --- | --- |
| Create a restaurant | `POST /signup` | the operator (`Authorization: Bearer <SIGNUP_OPERATOR_TOKEN>`) |
| Keep a restaurant's plan honest | `POST /webhooks/razorpay` | Razorpay, proved by a signature over the raw body |
| Start, change and cancel a restaurant's subscription | `GET /subscriptions/current`, `POST /subscriptions`, `/subscriptions/change-plan`, `/subscriptions/cancel` | a restaurant's owner, a manager, or its own hub (the `kitchen` identity), proved by a Supabase access token |
| Serve the public booking page, and take a guest's request for a table | `GET /book/:code`, `GET /public/booking/:code`, `POST /public/booking/:code/requests` | anyone, checked and rate-limited (below) |
| Show the operator every restaurant at once, read-only | `GET /ops`, `GET /ops/api/fleet`, `GET /ops/api/tenants/:id` | the operator (`Authorization: Bearer <OPS_TOKEN>`), and off unless that is set |

`GET /health` answers `{ ok, configured, billing, ops }` and reveals no secret.

> **Status, said plainly.** None of this has run against Razorpay or a hosted Supabase project; no credentials exist on the
> machine it was built on. It has run against stand-ins for both, and against the real SQL schema in a Postgres engine
> (PGlite). Expect the first run against Razorpay's **test mode** to find something. Do it before any real money moves.

## Environment

| Variable | What it is |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | The hosted project and its service key. Without them every request is refused. |
| `SIGNUP_OPERATOR_TOKEN` | A long random string. Without it signup refuses every request. |
| `OPS_TOKEN` | The operator console's own token: at least 20 characters, and a different one from `SIGNUP_OPERATOR_TOKEN` (the same string for both leaves it **off**). Unset, or shorter than that, the console is **off**: its page is not there and its API refuses everyone. |
| `SIGNUP_PORT` | Default `4500`. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | The API keys. Use the **test mode** pair first. Without them subscriptions cannot be started. |
| `RAZORPAY_WEBHOOK_SECRET` | The secret set on the webhook in Razorpay's dashboard. Without it the webhook refuses everything. |
| `RAZORPAY_PLAN_PRO`, `RAZORPAY_PLAN_ENTERPRISE` | The Razorpay **plan ids** (`plan_…`) behind our Pro and Enterprise. A plan with no id is simply not offered. |
| `TRUST_PROXY` | Set it when the service sits behind a proxy or CDN, or every guest looks like one caller and is limited together. `true`, a number of hops (`1`), or a name (`loopback`). Unset means nobody's `X-Forwarded-For` is believed, which is right when nothing is in front of it. |

On each hub, one variable: **`OPERATOR_SERVICE_URL`**, the service's address. It must be `https`, except for `localhost` while
trying it out. Without it the hub's Plan tab says online billing is not connected and offers nothing.

Start it with `npm run signup`. It warns at start about every missing variable above.

## Setting it up (once, in Razorpay's dashboard)

1. **Create two plans** (Pro and Enterprise) with their price and billing period. What a plan costs is Razorpay's to say; nothing
   in Kullina knows a price. Put their ids in `RAZORPAY_PLAN_PRO` / `RAZORPAY_PLAN_ENTERPRISE`.
2. **Add a webhook** pointing at `https://<the service>/webhooks/razorpay`, with a secret of your choosing (that is
   `RAZORPAY_WEBHOOK_SECRET`), for these events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
   `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.cancelled`, `subscription.completed`.
   Any other event is acknowledged and ignored.
3. **Apply migrations 001–021** to the hosted project. Migration 018 adds the columns and the unique index the subscription flow
   writes to. Without it a new subscription is not recorded, and every webhook is answered `502` (Razorpay keeps retrying) because
   the service cannot write what it received. Migration 020 adds the two tables behind the booking page, and 021 the hub's report on itself and the two views behind
   the operator console.
4. **Build the pages** where the service runs: `npm run build` puts `reserve.html`, `ops.html` and their assets in `dist/`, and the service serves
   them from there. Until it has been built, `/book/<code>` and `/ops` answer `503` and say so.

## What happens, step by step

- **The owner presses "Subscribe to Pro"** on the Plan tab at the reception laptop. The hub asks the service, proving which
  restaurant it is with its own Supabase sign-in. The service creates the subscription at Razorpay and returns the **hosted
  payment page**. **Nothing is charged until the owner authorises payment on that page.**
- **Razorpay tells the service** (`subscription.authenticated`, then `subscription.charged`…). Each event is checked against the
  signature, then applied once: an older event than the last applied is left alone, a redelivered event id is acknowledged and
  not logged twice, and a failure answers `502` so Razorpay retries. Only an `active` subscription sets `restaurants.plan`;
  a payment problem is `past_due` and the hub's 7-day grace applies; **a restaurant is never switched off for a payment problem.**
- **The owner presses Refresh** on the Plan tab: the hub re-reads the plan from the cloud before answering, so the new plan shows
  without waiting for the next scheduled check.
- **Switching plan and cancelling** both take effect at the end of the paid period. A cancelled subscription keeps working until
  then; the restaurant then falls back to Starter. Orders, billing and the kitchen display are never switched off.

## The public booking page

A restaurant can switch on a page where a guest asks for a table (Bookings tab → Online booking requests). The hub makes the page, gives it a
random address, and shows it to copy: `https://<the service>/book/<code>`. The service serves that page and takes what the guest sends.

- **A guest only asks.** The request waits in the cloud (`booking_requests`) until the restaurant's hub collects it, every two minutes or when
  reception presses *Check for new requests*. Reception accepts (which books the table through the hub's usual check against the real
  layout, and asks before overbooking) or declines, and tells the guest from their own phone by WhatsApp link. Nothing is sent by the product.
- **The database stays closed to `anon`.** A guest never talks to Supabase: the service checks the request and writes it with the service key.
  Page lookups and requests are answered identically for a page that does not exist, one that is switched off and a code that is not a code.
- **What it does to stop abuse**, all in the service and all tested: a form field a person never sees (filling it looks like success and stores
  nothing); at most 5 requests per address per 10 minutes (30 attempts counting mistakes); at most 3 per phone number per hour per restaurant;
  at most 50 waiting in one restaurant's inbox (then it says the restaurant is not taking requests); a 4 KB body; requests for a time that went a
  day ago are cleared out. The page is served with `no-referrer` (the code is in the address), `nosniff`, no inline script and a policy that
  lets it talk only to the service that served it.
- **What it does not do.** There is **no captcha and no email or phone verification**: a determined person with many addresses and numbers can
  still fill a restaurant's inbox up to the cap, and a guest can give someone else's number. Put the service behind a proxy or CDN that rate
  limits (and set `TRUST_PROXY`) before pointing the public at it, and decide whether a captcha is wanted: it is not built.
- **What it keeps.** A guest's name, number, party, time and note, in the cloud, until the hub clears it when staff answer, or the service does
  a day after the time asked for. The service stores no address and no browser details.
- **A restaurant that is offline** simply sees its requests when it is next online. A request is not lost with the laptop: nothing is cleared
  from the cloud until a person has answered it, so a replacement hub collects the same inbox.

## The operator console

`https://<the service>/ops` is the one place to look at every restaurant at once: how many there are, who has not paid, whose trial is about to
end, whose laptop has gone quiet. It is **read-only** (there is nothing in it that can change anything), and it is for the operator alone.
Before it, "where do I look" was a different table, the Supabase dashboard, or a phone call.

- **Switching it on.** Set `OPS_TOKEN` to a long random string (`openssl rand -hex 32`) where the service runs, run `npm run build` there (the
  console is a page of the build), and apply migration `021_ops_console.sql`. The token is **its own**, not the one that creates restaurants, so
  that looking can be given to someone without giving them the power to provision. Unset or shorter than 20 characters the console is off, and
  the log says so without saying the token.
- **Signing in.** The page asks for the token and keeps it **in memory only**: not in storage, not in a cookie, not in an address. Refreshing
  the page asks for it again. It is sent as `Authorization: Bearer` and compared in constant time. Ten wrong tries from one address in fifteen
  minutes turn that address away (even if its next try is right); a right token never counts against it. Behind a proxy, set `TRUST_PROXY`, or
  everyone looks like one address.
- **What it shows.** Counts (restaurants, active, on trial, overdue or suspended, hubs live, needing attention); **a list of who to look at and
  why**; every restaurant (plan, billing, hub, queue, the week's bills) with a search and filters; the latest subscription events across all of
  them; and, for one restaurant, its subscriptions, its events and everything its hub says. It reads again every minute and says how long ago
  it last did. A figure it did not have is shown as not known, never as zero.
- **What it never shows.** Pairing codes, the hash of a hub's provisioning secret, restaurant settings, a subscription's payment link, the payload
  Razorpay sent (which carries a customer's details), a guest, a bill, a menu, a staff name or a PIN. It is told how the restaurants are doing,
  not what they hold.
- **What counts as "look at this".** Each rule is a constant in `common/opsRules.js` (`OPS_LIMITS`; `signup_server/lib/ops.js` re-exports it, and the admin API shares it), pinned to the millisecond in the tests.
  A restaurant that has cancelled asks for nothing, except that shelved orders are always flagged.

| Rule | Severity | When |
| --- | --- | --- |
| Payment overdue | high | `plan_status` is `past_due` |
| Suspended | high | `plan_status` is `suspended` |
| Trial ended | high | on trial, and the trial's end has passed |
| Trial ending | medium | on trial, ending within 3 days |
| Asked to cancel | medium | the subscription has a cancel request, and the restaurant has not left |
| Hub never reported | medium | no report at all, and the restaurant signed up more than a day ago |
| Hub silent | medium, **high after 7 days** | no report for more than 36 hours (a restaurant shut for a day is "quiet", not "silent") |
| Orders shelved | high | the hub has shelved orders the cloud refused: takings that never reached it |
| Sync backlog | medium | 50 or more bills waiting to reach the cloud |
| Clock out | medium | the hub's clock differs from the database's by more than 5 minutes (a wrong clock moves a trial's end and a period's end on that hub) |

- **How a hub is "heard from".** Every five minutes (and 15 seconds after it starts) each hub tells the cloud it is alive: its version, since when
  it has been running, how many bills are waiting and how many were shelved, when it last got something through, and how many handsets and
  waiters it has (`hub_status`, one row per restaurant, written with the hub's own login; counts and times only). The **database** stamps when it
  heard, whatever the hub claims. A hub that is off, or has no internet, simply stops reporting. `/sync-status` on the hub says whether its last
  report got through. `HUB_HEARTBEAT_MS` and `HUB_HEARTBEAT_FIRST_MS` change the timing.
- **What the database does.** The two views the service reads (`ops_tenants`, `ops_events`) span every restaurant, so they are readable by the
  **service role only**: not `anon`, not a restaurant's own login, not its owner, and the service role itself has no privilege to write to them.
- **What it does not do.** It cannot suspend, extend a trial, change a plan or message anyone: those are writes, and this is read-only first.
  There is **one token and no names**: the log cannot say who looked. It shows at most 1,000 restaurants (and says so). It has not run against
  a hosted Supabase project or a public address; migration 021 has not run on a hosted project. On a phone the table scrolls sideways.

## Limits worth knowing

- **Never run against Razorpay.** The request shapes follow Razorpay's published Subscriptions API (Basic auth; `POST
  /subscriptions`; `POST /subscriptions/:id/cancel` with `cancel_at_cycle_end`; `PATCH /subscriptions/:id` with
  `schedule_change_at`). Check them against test mode.
- **A subscription is created for 12 billing periods** (`total_count`, in `hub_server/lib/razorpay.js`). After the twelfth it
  becomes `completed`, the restaurant falls back to Starter, and the Plan tab offers a new subscription. Whether that is the
  right length is a commercial decision that has not been made.
- **A payment page that was never used cannot be cancelled** (nothing was authorised). It lapses by itself, and until it does a
  different plan cannot be chosen; the same plan's page is simply offered again.
- **A plan can be changed only once the first payment has gone through.**
- **Anyone at the reception laptop can start or cancel.** A hub speaks as the restaurant's `kitchen` identity, so the service
  cannot tell the owner from whoever is at that laptop. There is no manager PIN in front of it yet.
- **No public signup page.** `POST /signup` is for the operator. A page a stranger can use needs a captcha, email verification and
  a host, none of which are decided.

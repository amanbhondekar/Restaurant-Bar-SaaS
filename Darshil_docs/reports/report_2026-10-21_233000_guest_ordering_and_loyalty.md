# 4.5 Customer-facing surfaces — ordering from the table, and recognising a regular

**Date:** 2026-10-21T23:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.5 Customer-facing surfaces — the two open items (order-from-menu, loyalty)

---

## WHY

§4.5 had the diner QR menu shipped view-only and two items open: **ordering** from that menu
(recorded as blocked on the payment-provider decision) and a **loyalty / repeat-visit identifier**.

Both are now unblocked, but not in the way the roadmap assumed.

**Ordering did not need payments.** The entry said order-**and**-pay, and treated the pair as one
thing, so the whole item sat behind Razorpay keys that do not exist on this machine. They are two
things. A guest sending their order to the kitchen and then settling with a member of staff at the end
is the entire workflow of every restaurant that has ever handed out a menu — it needs no provider, no
public address and no callback. Paying from the phone is what needs those, and it is still open and
written down as such. Splitting them shipped the useful half tonight.

**Loyalty needed a decision, not a scheme.** The identifier is the **phone number**, agreed before
any code was written: it is the one thing already collected for a booking or a place in the queue, so
a guest carries nothing new and staff ask for nothing new. What was deliberately **not** built is a
reward scheme — points, tiers, free dishes. Those are a pricing decision nobody has made, and
inventing one would be a guess baked into a database. What a host actually asks is "have we seen them
before?", and that is the part that cannot be added later, because it needs the history.

## WHAT

### Ordering is off until a restaurant turns it on

`GET /public/ordering` answers `false` unless `pairing.guest_ordering === true`, and `POST
/public/order` refuses with that flag off. A kitchen must not start receiving tickets from guests'
phones because a hub updated itself overnight; a restaurant that has not decided to do this is not
doing it.

Reception's switch (`src/admin/GuestOrderingSwitch.jsx`) sits in the **Tables tab, beside the
printable table QR codes** — the thing it is about — and `PUT /admin/guest-ordering` is
reception-only. The wording says plainly what turning it on means, and a hub that cannot answer shows
**no switch at all** rather than one reading "off": showing it off would invite reception to "turn it
on" against a hub that never heard them.

### What a guest's phone is allowed to say (`lib/guestOrdering.js`)

A basket sends **ids and quantities, and nothing else**. `validateGuestOrder` strips every field
except `id`, `qty`, `variant_id` and `modifiers`, and the hub then prices the order from its own menu
with the same `priceOrder` the waiter app goes through, checks stock, and applies day-part prices.
A price arriving from a guest's phone is not a price — it is a suggestion from a device the restaurant
does not control.

The other limits, all deliberately boring: at most 20 lines, 20 per line, a 140-character note, and
**one order per table per minute** (`GUEST_ORDER_COOLDOWN_MS`), held in memory on the hub. The
cooldown is what stops a bored child at table 4 printing forty tickets.

Each ticket is stamped `created_by_waiter: 'Guest (QR)'`, so the kitchen screen and the floor can see
where it came from without being told.

### What the guest is told back

A **ticket number, and never a total** (`guestOrderReceipt`). The basket's own figure is labelled
"About", with a line saying tax and any service charge are added when the bill is raised. A total
presented as final on a phone is one the guest is then charged more than, and that argument lands on
a waiter.

No payment is offered or implied anywhere on the page: "You pay a member of staff at the end, as
usual."

### Recognising a regular (`lib/loyalty.js`)

Visits are **derived from the booking diary**, not stored separately, so there is one source of truth
and nothing to keep in step. A visit is a booking or a queue entry that was **seated** — a no-show is
not a visit, and neither is a party that gave up waiting. A guest's name comes from their **most
recent** visit, because people correct a misspelling the second time.

Matching is on `phone_key`, the per-tenant salted hash from §4.6, so this never reads a number back,
and two restaurants on the same cloud cannot work out that they share a guest. The plain number is
kept only where staff need to ring it.

Two places use it:

- **While a booking is being taken** — `GET /admin/guests/lookup`, debounced as the number is typed,
  so the host knows before the booking is made rather than after. `recognise()` is **silent on a
  first visit**: "1 visit" on every new booking is noise, and noise is how the useful line gets
  ignored.
- **A Regulars list** (`src/admin/Regulars.jsx`) under the diary: who, how often, how long ago, and a
  button to ring them. No spend, no rank, no "VIP" badge — the hub does not know which bill belonged
  to which booking, and a number presented as a guest's worth is a number staff would act on.

## FILES

**New**

| File | What it is |
| --- | --- |
| `hub_server/lib/guestOrdering.js` | The rules for an order from a guest's phone: cooldown, limits, field allow-list, what is told back |
| `hub_server/lib/loyalty.js` | Visits from the diary, one guest by number, what to tell a host, the regulars |
| `src/diner/lib/basket.js` | The basket's arithmetic and what it sends |
| `src/diner/Basket.jsx` | The basket on the guest's phone |
| `src/admin/GuestOrderingSwitch.jsx` | Reception's on/off switch, in the Tables tab |
| `src/admin/Regulars.jsx` | The regulars list |

**Changed**

| File | What changed |
| --- | --- |
| `hub_server/server.js` | `GET /public/ordering`, `POST /public/order`, `PUT /admin/guest-ordering`, `GET /admin/guests`, `GET /admin/guests/lookup` |
| `src/diner/DinerMenu.jsx` | Asks whether ordering is on; add buttons and the basket only when it is **and** a table was scanned |
| `src/diner/diner.css` | `.add`, `.basket*` |
| `src/admin/TablesTab.jsx` | The switch, beside the table QR codes |
| `src/admin/BookingsTab.jsx` | Guest lookup as the number is typed; the Regulars list below the diary |
| `src/test/setup.js` | A `PointerEvent` polyfill — jsdom has none and the switch component dispatches one |

## TESTS

| Suite | Tests | Covers |
| --- | --- | --- |
| `hub_server/test/guestOrdering.test.mjs` | 14 | Off by default; only reception may switch it on; field stripping; cooldown; limits; the hub's own pricing; stock refusals |
| `hub_server/test/loyalty.test.mjs` | 13 | What counts as a visit; naming from the newest visit; silence on a first visit; the regulars order; per-tenant hashing; damaged input |
| `src/test/diner/Basket.test.jsx` | 15 | The basket's arithmetic; ids-and-quantities only; "About"; no basket with ordering off or without a table; the hub's refusal shown and the basket kept |
| `src/test/admin/GuestOrderingSwitch.test.jsx` | 6 | Reads off until the hub says otherwise; no switch when the hub cannot answer; sends `{ ordering }`; a refused change leaves it where it was |
| `src/test/admin/Regulars.test.jsx` | 9 | No-shows and parties that left are not visits; first-visit silence; the list's wording; no spend or badge; empty and unreachable |
| `src/test/admin/BookingsTab.test.jsx` | 23 | Recognition while the number is typed, and no announcement for a first-timer |

**Full suites:** hub `919 passed`, frontend `284 passed`, `npm run build` clean.
Run under `TZ=UTC`; the loyalty fixtures are relative to now, so they do not care.

## WHAT IS NOT DONE

- **Paying from the phone.** Needs Razorpay keys and a public address for the callback, neither of
  which exists yet. The diner page says the bill is settled with staff, and means it.
- **No reward scheme.** Deliberate, and recorded in the roadmap as deliberate rather than pending.
- **No guest-facing order history.** A guest sees the ticket number for the order they just sent and
  nothing more; tying a phone to a bill would mean trusting the phone.

---

**Verification:** both suites green and the production build clean on this machine. The migrations
this touches are §4.6's `011_reservations.sql` (unrun, like 004–011 — there are no cloud credentials
here), so the loyalty history is hub-local until those are applied.

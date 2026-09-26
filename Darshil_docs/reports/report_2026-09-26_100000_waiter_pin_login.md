# Engineering & Test Audit Report — Waiter PIN Login

- **Timestamp**: `2026-09-26T10:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Ninth slice of milestone M1 (Payments-ready). Gives every
  handset a per-shift identity — reception (or the waiter themselves)
  picks a name from a list and confirms with a 4-digit PIN before the
  floor grid loads. From then on, every ticket the handset sends is
  stamped server-side with the waiter's actual name (not a
  handset-supplied string reception can lie about) so the daily
  reconcile knows who booked what. Stacks on `feat/billing-thermal-print`
  (PR 8). Also fixes a pre-existing sub-millisecond tiebreaker flake in
  the invoice fold spotted while running the new test suite.
- **Related Files**:
  - `hub_server/lib/waiterStore.js` [NEW]
  - `hub_server/server.js` [MODIFY]
  - `hub_server/lib/invoice.js` [MODIFY] (determinism fix)
  - `hub_server/test/hub.test.mjs` [MODIFY]
  - `src/waiter_mobile/WaiterLogin.jsx` [NEW]
  - `src/waiter_mobile/WaiterApp.jsx` [MODIFY]
  - `src/waiter_mobile/OrderDraftDrawer.jsx` [MODIFY]

---

## 1. Rationale (Why)

Earlier PRs stamped every ticket with `created_by_waiter: 'Waiter
Handset (PWA)'` — a string the handset supplied and the server
trusted. Reception saw one identical byline on every KOT in the
kitchen and could not tell whose section a table belonged to. Worse,
a compromised or nosy handset could impersonate anyone by dropping a
different string in the payload.

This PR closes the gap with the smallest useful addition on top of PR 7
(device auth) and PR 8 (printing):

1. **`waiter_id` becomes the source of truth.** When the handset sends
   `waiter_id: 'w_…'`, the server ignores whatever `created_by_waiter`
   string the payload carries and looks the waiter up in
   `waiterStore`. If the id is unknown or deactivated the whole
   request is refused (`UNKNOWN_WAITER`). The old
   `created_by_waiter`-only path stays as a compatibility mode for
   pre-PR-9 handsets and the seeded demo tickets.
2. **PIN check runs on the hub, in constant time.** Scrypt (Node
   stdlib, no new deps) with a random per-waiter salt makes the
   4-digit PIN offline-brute-force-expensive if the file ever leaks.
   `crypto.timingSafeEqual` on the hash-hex prevents a timing side
   channel. The rejection code is a single generic
   `INVALID_CREDENTIALS` for every failure — wrong id, wrong PIN,
   deactivated waiter — so the response never tells an attacker
   which axis the failure was on.
3. **Login screen runs the moment the hub is reachable.** Enrolment
   (device token, PR 7) is orthogonal — the reception laptop's own
   KDS is trusted-local and never enrols, but its waiter still needs
   to identify themselves. The gate condition is
   `hubConnected && !waiterSession` — no `isEnrolled` requirement.
4. **Session persists on the device.** localStorage keeps
   `waiterSession` across reloads so a shift change is one tap, not
   a fresh scan. Explicit `Sign out` link on the header wipes it.

### Determinism fix (`hub_server/lib/invoice.js`)

Discovered while running the new suite: `buildInvoicePreview` sorted
tickets by `created_at` ascending, and two orders on the same table
that happened in the same millisecond compared equal. `Array.sort` is
stable, but the input order came from `ticketStore` (newest-first, via
`unshift`) so the invoice fold was non-deterministic across runs and
platforms.

Fixed by adding `ticket_number` (per-tenant, monotonic) as the tiebreaker:

    if (at !== bt) return at - bt;
    return (Number(a.ticket_number) || 0) - (Number(b.ticket_number) || 0);

Verified with 5 back-to-back clean runs (`for i in 1..5; do npm test`)
after the fix — 93/93 each. Same test flaked 1-in-N before.

---

## 2. What (Code & Endpoints)

### New

1. **`hub_server/lib/waiterStore.js`**
   - Persists `{ id, name, pin_hash, pin_salt, active, created_at }`
     per waiter to `hub_server/data/waiters.json`. `pin_hash` and
     `pin_salt` never leave the module.
   - Seeds three waiters (Vikram/1111, Sanjay/2222, Priya/3333) on a
     fresh hub so the demo works out of the box.
   - `listActive()` → `[{ id, name, active }]` (safe for the PWA).
   - `verify(id, pin)` → constant-time hash compare with a generic
     rejection object for every failure mode.
   - `addWaiter({ name, pin })` — refuses non-4-digit PIN
     (`INVALID_PIN`), blank name (`INVALID_NAME`), duplicate active
     name (`DUPLICATE_NAME`).
   - `deactivate(id)` — soft delete so historical tickets keep their
     attribution.
   - `getById(id)` — public shape lookup used by the order-post path.

2. **`src/waiter_mobile/WaiterLogin.jsx`**
   - Screen that fetches `/waiters` on mount, renders a name-picker,
     then a 4-digit PIN pad. Auto-submits the moment the fourth digit
     is typed (fewer taps per shift). Generic error text
     (`Wrong PIN.`) — never says "no such waiter" or "wrong id".

### Modified

3. **`hub_server/server.js`**
   - Imports `waiterStore`.
   - `POST /orders` now looks up `waiter_id` (when present) against
     the store. Sets `orderData.created_by_waiter = waiter.name` and
     `orderData.waiter_id = waiter.id` server-side; the handset's
     original string is ignored. Unknown or inactive id → 400 with
     `UNKNOWN_WAITER`.
   - New auth'd routes:
     - `GET /waiters` — public shape only, PIN hashes never emitted.
     - `POST /waiters/login` `{ waiter_id, pin }` → 200 `{ waiter }`
       or 401 `INVALID_CREDENTIALS`.
     - `POST /waiters` `{ name, pin }` — add a waiter (401 refusals
       covered above).
     - `DELETE /waiters/:id` — soft-deactivate.

4. **`src/waiter_mobile/WaiterApp.jsx`**
   - Imports `WaiterLogin` and reads `kullina_waiter_session` from
     localStorage on first render.
   - Renders the login screen while `hubConnected && !waiterSession`.
   - Header now shows the waiter's initial in the avatar, their name
     next to the hub URL, and a compact Sign-out affordance
     (`LogOut` icon) beside it.
   - Passes `waiter={waiterSession}` down to both
     `<OrderDraftDrawer>` mounts.

5. **`src/waiter_mobile/OrderDraftDrawer.jsx`**
   - Accepts `waiter` prop. When present, sends
     `waiter_id: waiter.id` in the POST /orders body and stamps the
     display fallback `created_by_waiter: 'Vikram (PWA)'` (server
     overwrites it anyway).

---

## 3. Test Cases

All 93 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 PR 5 + 8 PR 6 + 8 PR 7 + 13
PR 8 + 10 new). Run: `npm test`. Determinism verified with 5 back-to-
back clean runs.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-71 | `GET /waiters` requires auth; every row omits `pin_hash` / `pin_salt` | ✅ |
| M1-72 | Wrong PIN → 401 `INVALID_CREDENTIALS` | ✅ |
| M1-73 | Correct PIN for seeded Vikram → 200 with `{ waiter }` | ✅ |
| M1-74 | Unknown waiter_id → same 401 `INVALID_CREDENTIALS` (no id-vs-pin leak) | ✅ |
| M1-75 | `POST /waiters` adds; duplicate active name → 400 `DUPLICATE_NAME` | ✅ |
| M1-76 | Non-4-digit PIN payloads (`'abc'`, `'123'`, `'12345'`, `''`, `null`) → 400 | ✅ |
| M1-77 | `DELETE /waiters/:id` removes them from the active listing | ✅ |
| M1-78 | `POST /orders` with a valid `waiter_id` stamps waiter name server-side even when the handset supplies a lying `created_by_waiter` | ✅ |
| M1-79 | `POST /orders` with an unknown `waiter_id` → 400 `UNKNOWN_WAITER` | ✅ |
| M1-80 | Legacy `POST /orders` without `waiter_id` still works (backwards-compat) | ✅ |

### Live smoke test

Seed T8 hub, fresh device. Load `/waiter.html` → login screen renders
`🍽 Hotel Mejwani — Sign in as your waiter to start taking orders`
with three cards: Vikram / Sanjay / Priya. Tap Vikram → PIN pad,
auto-submits on the fourth digit. Auth roundtrip <20 ms LAN. After
success, floor grid loads with `V` in the avatar and `👤 Vikram`
next to the hub URL. Sending an order stamps `created_by_waiter:
'Vikram'` server-side; the KDS shows "By Vikram" on the ticket card.

Screenshots: `waiter-login-picker.png` (name picker),
`waiter-login-pin.png` (PIN entry).

---

## 4. Explicitly out of scope

- **Reception waiter-management UI**. Hub already has the CRUD
  routes (`GET/POST /waiters`, `DELETE /waiters/:id`) — the
  reception admin screen (add/deactivate waiters) is a follow-up
  PR. Today, `waiters.json` is edited by hand or via curl.
- **Per-waiter permissions** (approve discounts, void invoices,
  etc.). All waiters currently see the same UI; role gating is a
  follow-up.
- **Idle timeout** (auto-signout after N minutes). Not needed for
  M1 but easy to add on top of the session-in-localStorage design.
- **CI, crash reporting** — PR 10.

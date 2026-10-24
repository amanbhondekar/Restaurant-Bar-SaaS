# 4.4 Tenant lifecycle — staff, roles, PIN rotation and device revocation

**Date:** 2026-10-21T14:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.4 Tenant lifecycle — "Owner console: staff invites, role management, PIN rotation, hub device revocation"

---

## WHY

Everything about who may take money in a restaurant was either missing or wrong:

- **Reception had to type someone else's PIN for them.** `POST /waiters` took `{ name, pin }`, so
  every PIN was one the owner knew and the staff member could not really change. For a credential
  that stamps a name on every ticket and bill, that is the wrong shape.
- **There were no roles at all.** A waiter, a manager and a kitchen hand were the same record.
- **A PIN could never be rotated.** Not after it was shared around, not after someone left. The only
  option was to deactivate the person and create them again under a new name.
- **A lost handset could not be locked out.** `rotateEnrollmentCode()` revoked *every* device at once
  — correct for a leaked code, and badly wrong for one missing phone, because every other handset in
  the restaurant has to re-enrol in the middle of service. There was no way to revoke just one.
- Three seeded demo waiters (`Vikram/1111`, `Sanjay/2222`, `Priya/3333`) were the only way onto a
  fresh hub, and nothing had ever replaced them.

## WHAT

### Invites: reception never knows the PIN

Reception adds a person with a **name and a role**, and gets a 6-character code shown **once**. The
staff member types it on a handset and chooses their own PIN.

Until they do, the row has **no hash at all** — an invited person is not yet a credential. They do not
appear in the handset's name picker and no PIN can be guessed into their account, because there is
nothing to compare against. The code is stored only as a SHA-256 hash, so a reception screen left open
and a leaked `waiters.json` are both worthless; losing it means sending a new one.

Codes last seven days. An expired one is refused exactly like an unknown one — the answer never says
which codes exist. Redeeming is the one staff route a handset may call without being reception: it
needs a device token, and it shares the rate-limit bucket with enrollment, because it is a second
place where a short code gets guessed at.

A re-invite is refused for someone who has already set a PIN (that would be a way to take over their
account); reception resets the PIN instead.

### Roles, carried honestly

`waiter`, `manager` and `kitchen`, defaulting to `waiter`, which is also what every pre-existing row
reads as. Reception sets one from the list and it saves immediately.

**What a role may *do* is not enforced**, and the code says so: that is §4.7's job (role-scoped UIs and
tokens). Today everyone signed in can do what the handset allows. Storing the answer now is what makes
the §4.7 work possible; pretending it were enforcement would be worse than not having it.

### PIN rotation

Reception sets a new PIN; it takes effect at once and the old one stops working. Rotating for someone
still invited sets them up and cancels the outstanding code. Four digits, and a short list of PINs
nobody should be allowed (`0000`, `1234`, `1111`, `2580`…) is refused — deliberately short, because a
long list starts refusing PINs people have a reason for.

### Revoking one device

Devices now carry an `id` at enrollment, so a single one can be removed; that handset is refused on its
very next request, because there is no session to expire. Every other device keeps working.

Devices enrolled **before ids existed** get one derived from a 16-character prefix of their stored
token hash — stable, already on disk, and not enough to reconstruct the token. Without that, the first
thing a hub would have to do to revoke an old handset is re-enrol every device in the restaurant.

Reception's list shows label, when it joined and when the grant lapses, never the hash. Expired grants
are marked and can be tidied away. Rotating the enrollment code is still there, kept deliberately
separate, and its confirmation says plainly that every device must join again and that removing one is
what you want for a lost phone.

### Files

| File | Change |
|---|---|
| `hub_server/lib/waiterStore.js` | Roles, invites, redemption, PIN rotation, re-invite; `verify` refuses a person with no PIN |
| `hub_server/lib/deviceAuth.js` | Device ids, `listDevicesPublic`, `revokeDevice`, `pruneExpiredDevices` |
| `hub_server/server.js` | `/admin/staff*`, `/admin/devices*`, `POST /waiters/redeem-invite` |
| `src/admin/StaffTab.jsx`, `lib/staff.js`, `AdminApp.jsx` | Reception's tab |
| `src/waiter_mobile/WaiterLogin.jsx` | "I have an invite code" → code → choose a PIN |

## TEST CASES (48 new)

| File | N | Covers |
|---|---|---|
| `staffAccess.test.mjs` | 24 | **An invited person cannot sign in with anything**; the code is returned once and stored hashed; redeeming once only; whitespace/case tolerated but a wrong code answered identically to an unknown one; expiry and re-invite; re-invite refused for someone set up; PIN rules; duplicate names; rotation (incl. cancelling an outstanding invite); roles, unknown roles, pre-roles rows; deactivation keeps the record. Then a real hub: invite → redeem → sign in; rotation locking out the old PIN; no hash reaches a screen; **a revoked device is refused and others keep working**; legacy device ids; expiry and pruning; **every route reception-only, with an enrolled handset refused** |
| `src/test/admin/StaffTab.test.jsx` | 17 | The wording rules; the list; **no PIN field exists when adding someone**; the code shown once; duplicate caught before the hub; reset refuses a weak PIN locally; invited people offered a new invite, not a reset; role change; removal confirmed; devices listed and revoked; rotation warns what it costs; an unreachable hub |
| `src/test/waiter/WaiterLogin.test.jsx` | 7 | Sign-in on the fourth digit; a wrong PIN; the invite flow end to end; nothing sent until both halves are whole; a bad code returns to the code step and a bad PIN does not |

**A bug this found in my own work:** the role dropdown read `e.target.value` *after* the await, and the
select is controlled by `person.role` — so by then it had snapped back and the toast said the wrong
role. Caught by the test that asserts the message; fixed by reading the value before the request.

```bash
npm run test:hub   # 800 (776 + 24)
npm run test:web   # 231 (207 + 24)
npm run build      # clean
```

## NOT DONE / LIMITS

- **Roles are stored, not enforced.** Any signed-in person can still do anything the handset allows,
  including voids and refunds. §4.7 owns that, and the roadmap now carries it.
- **The three seeded demo waiters are untouched** (`Vikram/1111` and friends) and still seed a fresh
  hub. Removing them would break the demo path; they should go before a real tenant opens.
- **No audit trail.** Nothing records who rotated a PIN or revoked a device, only that it is now so.
- **No "last seen" per device**, so telling two handsets apart rests on the label each chose at
  enrollment. In a restaurant with four devices all labelled "Waiter handset" that is thin.
- **Staff are hub-local**, like waiters have always been: not replicated, so they are lost with the
  laptop and are not shared with a second hub.
- **Invite codes are not rate-limited per code**, only per IP, sharing enrollment's bucket. 31^6 is
  large enough that this is comfortable, but it is a shared bucket, not a dedicated one.
- Nothing here was driven in a browser this slice; it is covered by component tests against a fake hub.

## STATUS

✅ VERIFIED — 800 hub + 231 frontend, build clean.

# 4.7 Adding and removing staff is reception's, not any phone's

**Date:** 2026-10-22T16:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.7 Auth & access control — the follow-up recorded in
[`report_2026-10-22_141500_kitchen_device_scope.md`](./report_2026-10-22_141500_kitchen_device_scope.md)

---

## WHY

While scoping kitchen tokens, listing every route a device token reaches turned up two that should not
be there. `POST /waiters` and `DELETE /waiters/:id` are commented *"reception / admin flow"*, and were
guarded only by `requireDevice` — a device token, which every enrolled handset holds.

So any phone on the restaurant's wifi that had enrolled could:

- **create a waiter with a PIN of its own choosing**, and then sign in as them; and
- **deactivate another waiter**, locking them out of the app in the middle of a shift.

The comment and the guard disagreed, and the guard is what runs. It was recorded in the previous report
and the roadmap rather than fixed in that change, because four existing tests drive these routes with a
device token and rewriting them is its own change. This is that change.

## WHAT

Both routes now use `requireReceptionFor(...)`: the request has to come from the reception laptop itself
(loopback, addressed to this machine), the same rule as every `/admin` route. A device token — of any
scope — is not enough.

Nothing had to change in the product: no screen calls them. Reception's Staff tab goes through
`/admin/staff`, which was already reception-only and sends an invite instead of a typed PIN, and the
waiter app uses only `GET /waiters`, `POST /waiters/login` and `POST /waiters/redeem-invite`, which are
unchanged. Only the tests that drove the old routes needed to move.

### Tests

| File | Change |
| --- | --- |
| `hub_server/test/hub.test.mjs` | A second hub that trusts its loopback (the reception laptop). The three tests that add and remove a waiter now run against it. **New:** an enrolled handset gets 403 `RECEPTION_ONLY` on both routes, and the hub it talked to is unchanged afterwards (the waiter is still there; nobody called `Intruder` was added). |
| `hub_server/test/plans.test.mjs` | The waiter-limit test spawns a reception-capable hub with the same degraded-plan config, because the limit is enforced on the same route. |
| `hub_server/test/deviceScope.test.mjs` | The two routes moved out of the "refused to a kitchen screen by scope" list — they are refused to every token, so a kitchen screen gets `RECEPTION_ONLY` rather than `DEVICE_SCOPE`. A separate test asserts it. |

**Mutation-checked:** each guard put back to `requireDevice` in turn; both are caught.

**Full suites:** hub `941 passed` (was 939), `npm run build` unaffected (no frontend change).

## WHAT IS NOT DONE

- A **signed-in** waiter's role is still not enforced. This closes a *device* hole; the person using a
  handset can still do whatever a handset can, bills and voids included (§4.7's role UIs).
- `GET /waiters` is still open to any enrolled handset, as it has to be: the sign-in screen lists names.
  It returns the public shape only, with no PIN hashes (asserted in `hub.test.mjs`).

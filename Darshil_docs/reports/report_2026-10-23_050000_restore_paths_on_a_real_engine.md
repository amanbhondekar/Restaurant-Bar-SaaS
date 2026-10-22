# The restore paths, run against a real database

**Date:** 2026-10-23T05:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
The roadmap's recurring caveat: "the restore path is the least proven thing here. A bad push fails loudly and retries; a bad
*read* quietly produces a plausible but wrong ledger." Every replication and restore test used a fake cloud that kept whatever it
was given, so none could notice a column the real table lacks, a CHECK it refuses, a unique index missing for an upsert, a
privilege the hub's login does not hold, or a value that comes back in a different shape. With a real Postgres in the suite
(previous reports) the hub's own code can be run against it.

## WHAT WAS BUILT
`hub_server/test/cloudRoundTrip.test.mjs` (8 tests) runs the hub's **own** push functions and its **own** `restore*FromCloud`,
`checkLedgerGap` and `repairLedgerFromCloud` methods against the real schema, constraints, indexes, row-level security and
privileges, signed in as the hub's `kitchen` login, with the stores wiped in between the way a new laptop would be.
`helpers/pgrest.mjs` grew from read-only to a real client: `upsert` (with `onConflict` and `ignoreDuplicates`), `delete().eq().in()`,
counted selects and `maybeSingle`; and the database now returns numbers as numbers and timestamps as ISO strings, as PostgREST does.

## WHAT IT PROVED (nothing failed)
- **The ledger.** Bills in every state the real invoice store produces (pending, paid, refunded, voided, split) go up and come back
  with their statuses (including the `voided` the cloud's CHECK once refused), the voided bill's reason and the refund's reason, and
  **the cash screen's payment events identical to what they were before the trip**; cash-ups come back with their variances; nothing
  restored is queued to be pushed straight back. A ledger that is only short is found by counting and filled by the repair (and
  looking first changes nothing).
- **Updates and isolation.** Pushing a bill again, changed, updates it rather than adding a row; one tenant cannot count or read
  another's bills.
- **Feedback.** Comes back with its bill reference; a retried push does not double it.
- **Stock.** Ingredients with par and cost (an unknown cost stays unknown, not free), a recipe per size, and an extra's own line (it
  comes back as the extra's, not as part of the dish) all survive; a push removes what the hub no longer holds, in its own restaurant
  only, which also proves the hub's login holds the `DELETE` it needs on those tables under migration 014.
- **Bookings.** Reservations in every status (with overbooked, notes and every timestamp) and the walk-in queue in every status.
- **Menu and layout.** Nested modifier groups and sizes survive as the JSON they are; a removed dish and category are removed; the
  table layout comes back in the order the hub pushed.

## MUTATION CHECK
13 mutations, including three of this project's own past bugs (void reason never replicated, refund time never replicated, refund
lost on restore) and the grant-dependent ones (a cash-up or feedback push that updates instead of ignoring duplicates would be
refused). Four survived at first and each was a gap in what the tests asserted (the void reason, a walk-in's left time, the
feedback's bill reference, none of which a total would show); the assertions were tightened and all four are now caught. One survivor
remains and is equivalent: the stale-row scan in `deleteStale` filters by restaurant, but row-level security already scopes the hub's
login to its own, so removing the filter changes nothing for that login. It is kept as defence in depth, because the same function
run with the service key would otherwise read every tenant's rows.

## COUNTS
Hub **1208 passing** (1200 before). Frontend unchanged at 748.

## NOT DONE
Same limit as before: this is a real Postgres engine, not a hosted Supabase project. PostgREST's own behaviour (its exact error
codes, how it renders types and handles `Prefer` headers), the auth service and the project's real default privileges are not
exercised. The adapter models the subset of the client these functions use.

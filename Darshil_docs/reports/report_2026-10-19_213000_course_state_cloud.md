# M2 tail — course state reaches the cloud (migration 008)

**Date:** 2026-10-19T21:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M2 · §4.3 Kitchen operations — "Course state replicated to the cloud"

---

## WHY

The hub tracks, per ticket, whether it is served in courses, which courses have been fired and when,
and when each kitchen station finished each course. The cloud copy of an order held none of it: only
a coarse status (`in_progress` / `ready`), and `order_items` had no course or station either. An
owner reading the cloud could not tell a ticket that was slow from one the waiter had deliberately
held back for the main course — and could not measure either.

Reading the sync path to add this turned up a second, related gap: **a station marking its part
ready, when the ticket as a whole was not ready yet, enqueued nothing.** Only the last station's
click (which made the ticket ready), fire and recall reached the queue. So even the coarse picture of
"the bar has finished, the hot line has not" was never replicated.

## WHAT

### Migration 008 — `database/migrations/008_order_course_state.sql`

| Column | Type | Holds |
|---|---|---|
| `orders.staged` | `BOOLEAN NOT NULL DEFAULT FALSE` | the waiter chose "serve in courses" |
| `orders.course_log` | `JSONB` | one entry per fired course: `fired_at`, `stations_ready`, `ready_at`, `recall_count` |
| `order_items.course` | `SMALLINT NOT NULL DEFAULT 1`, check 1–9 | the line's serving course |
| `order_items.station` | `VARCHAR(10)`, check `hot`/`cold`/`bar` | where the line routes |

`course_log` is JSONB rather than a child table: it is a short log of one ticket's own history, never
queried relationally, and the hub rewrites it whole on every change. A held course has no entry, so
`fired_courses` is simply its keys and is not stored twice. All `ADD COLUMN IF NOT EXISTS`; the two
constraints are added inside a `DO` block that checks `pg_constraint` first, so the file is safe to
re-run. RLS and grants are untouched — these are new columns on rows the hub already writes.

### The hub

- **`lib/courseSync.js`** (new): `orderCourseColumns(ticket)`, `itemCourseColumns(item)`, and the
  missing-column detection. A ticket that predates courses is filled in by `withCourseState` rather
  than sent as null.
- **`syncQueue.enqueueStatusUpdate(..., ticket)`**: an optional fourth argument; when given, the
  ticket's course state rides in the queued payload. Items queued before this change have no such
  field and sync exactly as they did.
- **`server.js`**: whole-ticket Ready, last-station Ready, fire and recall now pass the ticket, and
  **a partial station-ready now enqueues** an `in_progress` update carrying the state.
- **`syncOrderToSupabase` / `syncStatusToSupabase`** now go through `this.cloud`, the seam invoices
  already used, instead of the global client. That is what lets them be tested against a fake cloud;
  behaviour against the real client is unchanged.

### An unmigrated cloud must not cost an order

This is the part worth reviewing. The cloud schema has been behind the hub before (migration 002's
`order_request_id` already has a fallback), and no migration here has been run. So a write that names
a course column the cloud lacks is **retried without those columns**: the order, its lines and the
status all still arrive, and only the course detail is missing until 008 is run.

The detection is deliberately narrow. It matches only when the error is an unknown-column error
(`PGRST204` or Postgres `42703`) **and** the message names one of *our four columns* as a whole word.
A permission error, a constraint failure, or an unknown column belonging to something else is still a
failure — retrying those without data would hide a real problem. `restaurant_stationery` and
`staged_at` are tested not to match.

Half-migrated is handled too: if `orders` has the columns but `order_items` does not, the order keeps
its state and the lines are retried plain.

## TEST CASES (16 new, `hub_server/test/courseSync.test.mjs`)

| # | What it proves | Result |
|---|---|---|
| 1 | A staged ticket sends its flag and a log with only the fired course (a held course has no entry) | Pass |
| 2 | The log records which stations have finished, so a slow line is told from a held one | Pass |
| 3 | A ticket from before courses is filled in, not sent as null | Pass |
| 4 | A line's course and station default sensibly when missing or invalid (`42`, `garnish` → 1, hot) | Pass |
| 5–6 | Missing-column detection: ours match; someone else's column, `42501`, a check-constraint failure, `staged_at`, `restaurant_stationery` do not | Pass |
| 7 | `withoutCourseColumns` strips ours and nothing else | Pass |
| 8 | **Migrated cloud:** the order arrives with `staged`, `course_log`, and each line's course/station | Pass |
| 9 | **Unmigrated cloud:** the order, its request id and every line still arrive, without the detail | Pass |
| 10 | **Half-migrated:** the order keeps its state; the lines go plain | Pass |
| 11 | **An unrelated failure is not retried as a missing column** — one attempt, still systemic | Pass |
| 12 | A status change carries the course state | Pass |
| 13 | On an unmigrated cloud the status still goes through alone | Pass |
| 14 | A status item queued before this feature (no `course`) is unchanged | Pass |
| 15 | **Real hub:** a station finishing before the ticket is ready queues the state | Pass |
| 16 | **Real hub:** fire and recall each queue the state as it now stands; the final `ready` carries when it finished | Pass |

Tests 8–14 run against a fake cloud that rejects exactly as PostgREST does and records what it
accepts. Tests 15–16 boot a real hub and read its `sync_queue.json`.

**Shown to be able to fail:** with the new enqueue on the partial station-ready path removed, exactly
test 15 failed (15 passed, 1 failed). The file was restored from a backup and the suite re-run green.

One test of mine was wrong, not the code: it took the *first* `ready` op, but finishing course 1
alone already makes a one-course ticket ready, so it asserted on the wrong one. Fixed to wait for
the second.

```bash
npm run test:hub   # 605 (589 + 16), green under TZ=UTC
```

## NOT DONE / LIMITS

- **Migration 008 has not been run**, like 004–007: there are no Supabase credentials on this
  machine. Everything above was verified against a fake cloud that mimics PostgREST's errors, not
  against PostgREST. The fallback path is the safety net for exactly that.
- **No coalescing.** Each state change is its own queue item, so a long outage queues several per
  ticket (three stations plus ready, say). They are small and applied in order; only the last matters.
  Coalescing like the catalog ops do is possible but changes queue semantics, so it was left.
- **Variant and modifiers are still not in the cloud.** `order_items` still lacks `variant_label` and
  `modifiers`, so a cloud "Biryani" does not say Half or Full. Related, found while here, and not part
  of this item.
- **Nothing reads it yet.** This puts the data in the cloud; there is no cloud-side report or view
  that uses `course_log`.
- **One unexplained transient failure.** The first full-suite run after this change failed 5 tests in
  `kitchenOps.test.mjs`, all in the second half of that file. Run alone it passes (31/31), and two
  further full runs passed (605/605). I could not reproduce it and have not found a cause; the change
  under test does not touch those paths (`recall` does enqueue with the new argument, so I looked
  there first). Recorded rather than dismissed.

## STATUS

✅ VERIFIED against a fake cloud and a real hub — 605/605 on the last two runs. ⚠ Migration 008 unrun.

# Customer-facing surfaces: guest feedback reaches the cloud, and the stale reception tabs are retired

**Date:** 2026-10-22T23:15:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHAT WAS OPEN (roadmap §4.5 and §4.6)
- Guest feedback lived only in `hub_server/data/feedback.json`: a tenant could lose every rating and comment with the laptop.
- The reception shell still had its demo-era Waitlist tab (a browser-`localStorage` list that shares nothing with the hub's
  queue) and a Sales view that added up every ticket in the browser's storage with no regard for voids or refunds.
- Paying from the diner page, and a reward scheme.

## WHAT WAS DONE
**Feedback replication (migration 013, `guest_feedback`).** Insert-only like a cash-up: pushes are `ON CONFLICT DO NOTHING`, the
table has no UPDATE or DELETE grant, so a retry after an unconfirmed success is a no-op and a guest's statement is never edited.
Each submission is queued when it is made; the boot backfill carries up entries from before the migration (they have no flag,
which reads as "not yet"); a replacement laptop with no feedback gets its history back, marked as already replicated so the
backfill does not push it straight back. Restore never merges into feedback the hub holds, and re-checks emptiness after the cloud
read, so a guest who answers while it is in flight keeps the hub's own record. Nothing identifying the guest is stored, so
nothing is copied. `cloud:check` picks the new table up from the migrations automatically.

**Stale reception tabs retired.** `WaitlistView` and `SalesAnalyticsView` are deleted. The shell's tabs are now Bookings and
Sales and each says where the real thing is, with a link. The admin console now opens on the tab named in the URL
(`/admin#bookings`, `/admin#sales`); a fragment it does not recognise lands on Menu.

## NOT DONE, AND WHY
- **Paying from the diner page** needs Razorpay keys and a public address for the callback. Neither exists, and a payment flow
  that cannot be run against the provider is not something to ship on a guess.
- **A reward scheme** is a pricing decision, not a technical one.
- **A public booking page** (§4.6) needs hosting.
- Migration 013, like 004-012, has not run against a real Supabase project, and row-level security is proven by nothing. The
  contract test holds every row the hub builds against the SQL, but only a real project proves the SQL.
- The unused waitlist state in `PosContext` is still there.

## A MISTAKE CAUGHT BY A TEST RUN
My first edit of the shell put a backslash-escaped quote inside a JSX attribute, which is not valid JSX: the page would not
have built. The new shell test failed to transform it and it was fixed before anything was committed.

## TESTS
- `feedbackSync.test.mjs` (20): the row (hub id to `hub_ref`, table to `table_label`, nulls for feedback about the place, nothing
  about the guest travels), the inverse, insert-not-update, rejection carries the cloud code, pull; the store's sync marks and
  tenant scoping; the queue (pushed and marked on disk, a refused push stays queued and unsynced, never queued twice, another
  tenant's entry dropped); the backfill (legacy entries with no flag, oldest first, nothing for a replicated store); the restore
  (fills only an empty store, never asks the cloud otherwise, offline / wrong tenant / cloud error / empty cloud, other tenants'
  rows refused, and the in-flight race).
- `cloudContract.test.mjs` (+2): rows built by the real `feedbackStore` for every rating and the longest comment fit the SQL; what
  is written is what a restored hub reads; the unique index the upsert needs exists.
- `feedback.test.mjs` (+1): on a real hub a submission is queued for the cloud and a refused rating is not.
- `AdminApp.test.jsx` (6) and `ServerLaptopApp.test.jsx` (3): the hash picks the tab (any case; nonsense, `__proto__`, path tricks
  and markup fall back to Menu), the list of tab ids is pinned to the tabs the console shows, and the retired tabs link to tabs that
  exist.
- Mutations: 14 on feedback replication, 13 caught at once; the one survivor (the guard inside `restoreAll`) was a real gap, now
  covered by the in-flight test. 6 on the tab links, all caught.

## COUNTS
Hub **1126 passing** (1103 before), frontend **676** (667 before), build clean.

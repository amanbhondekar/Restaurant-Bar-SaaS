# Billing replication: proving what can be proven without a cloud

**Date:** 2026-10-22T18:06:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Billing replication is unproven"

---

## WHY

Every cloud copy in this product — bills, cash-ups, stock, reservations, orders — has been tested against
**fakes that keep their rows**. That proves the hub's logic. It cannot prove the thing that decides whether
the first real push works: that the hub writes only columns the cloud has, names every column the cloud
requires, upserts on a key a unique index backs, and reads back columns that exist. Each of those is a
refusal on day one, and every one of them is knowable from the SQL alone.

The honest limit stays: nothing here has touched a real Supabase project, because there are no credentials
on this machine. What follows closes the gap **to** that line and builds the tool that closes the rest of it
the moment a project exists.

## WHAT

### 1. A contract test against the migrations (`cloudContract.test.mjs`, 15 tests)

`lib/sqlSchema.js` reads the schema out of `database/supabase_schema.sql` and every migration (CREATE TABLE,
ALTER TABLE … ADD COLUMN, unique indexes, `CHECK … IN (…)`), failing loudly on any form it does not
understand. The test then holds **every row the hub builds** against it:

- bills in all five payment states, cash-ups balanced and with a variance, menu / category / table rows, stock
  and recipes (including a recipe carrying an extra), bookings and queue entries in every status, and orders
  with their lines and the course columns of 008;
- **keys ⊆ columns**, **NOT NULL columns without a default are present**, **CHECK enumerations are respected**;
- every `ON CONFLICT (restaurant_id, hub_ref)` target has a **unique index** behind it (without one the cloud
  answers "no unique constraint matching the ON CONFLICT specification" on every attempt, for ever);
- every column named in a read exists, and a guard fails when someone adds a `.select('…')` the test does not
  know about;
- a ticket sent before migration 008 still fits, so an unmigrated cloud can still take orders.

**Result on the code as it stood: every row matched.** That is a real answer, and the one hoped for.

> **Correction, same day:** this was true of the states the test was given and **not** of the cloud. Its sample bills were
> hand-written from the SQL, which hid that the hub writes `voided` where the table's CHECK allows `void`: every voided
> bill's push would have been refused. Found and fixed in
> [`report_2026-10-22_185500_voided_bills_never_reached_the_cloud.md`](./report_2026-10-22_185500_voided_bills_never_reached_the_cloud.md);
> the test now builds bills with the real invoice store.

### 2. A real bug it led to: status updates keyed on the ticket number

Listing the cloud writes turned up that an order's status change was `UPDATE orders … WHERE ticket_number = n`
— with **no restaurant and no request id**. Ticket numbers restart at 101 whenever a hub's data directory is
lost or reinstalled. After that, marking new ticket 101 *ready* rewrote the status of **every older order that
ever had number 101** in that tenant's history, and clearing a table marked them *completed*.

Now the update is aimed at **one order of one restaurant**: `restaurant_id` and the `order_request_id` the
order was inserted under. A status item already sitting in a hub's queue from before this change carries only
the number; it still drains, still inside the restaurant. The two call sites that mark tickets completed on a
table clear now pass the request id too.

### 3. `npm run cloud:check` for the day there is a project

`lib/cloudCheck.js` + `scripts/cloud-check.mjs`:

- **Read-only by default.** Asks the project for every column the migrations define, table by table, and
  reports *missing table*, *missing column*, *permission refused* or *other*, naming **every** absent column
  (not only the first PostgREST complains about) and **the migration file to run**. A base-schema table is
  never answered with "run a migration".
- **`--probe <restaurant-uuid>`** writes one voided, clearly-named probe bill for that restaurant with the hub's
  own push, writes it again (the upsert updates in place and does not duplicate), reads it back through the
  hub's own restore path, and deletes it. It only ever touches the restaurant it was asked about, clears a probe
  left by a crashed earlier run, and says so if it cannot delete itself.
- It **refuses to run** against the placeholder URL or without a service key ("Nothing was contacted") and never
  prints the key.

It states what it cannot see: row-level-security policies (PostgREST does not expose them; the service role
bypasses them anyway) and indexes (those are checked against the SQL by the contract test).

## FILES

| File | |
| --- | --- |
| `hub_server/lib/sqlSchema.js` | new — reads the schema out of the SQL, tracking which file defined each table and column |
| `hub_server/lib/cloudCheck.js` | new — `classify`, `checkTables`, `migrationsToRun`, `roundTrip` |
| `hub_server/scripts/cloud-check.mjs` | new — the CLI; `package.json` gains `cloud:check` |
| `hub_server/lib/syncQueue.js` | status updates aimed at one order of one restaurant; `enqueueStatusUpdate` records the request id |
| `hub_server/server.js` | the two table-clear call sites pass the request id |
| `hub_server/test/cloudContract.test.mjs` | new — 15 tests |
| `hub_server/test/cloudCheck.test.mjs` | new — 12 tests |
| `hub_server/test/courseSync.test.mjs` | its fake cloud's `update()` is now chainable like PostgREST's builder; one assertion names the full filter |

## TESTS

27 new. **Mutation-checked, 12 breakages:** a column the table lacks; a required column left out (reservation
time, recipe restaurant); a status the table's CHECK refuses; a status change aimed at the number alone again;
a status change not kept inside the restaurant; the request id not recorded when queueing; a missing table
reported as a missing column; only the first missing column reported; the probe never deleting its bill; the
probe not checking for a duplicate; the probe deleting across restaurants. **One survived first time** (the
message-text fallback masked the error-code path in `classify`); code-only cases were added and it is caught.

Full hub suite: `994 passed`.

## WHAT IS NOT DONE — stated plainly

- **Nothing has run against a real Supabase project.** `cloud:check` is the way to find out, and it is written
  and tested against a fake that answers as PostgREST does. Its first real run may still find something a fake
  cannot (policy behaviour, a project that is not on the version these error codes come from).
- **Row-level security is not proven** — by this or by anything else. Policies need a signed-in tenant probe.
- Migrations 004–011 remain unrun. The roadmap now says what proves them and what is still open, rather than
  leaving the whole thing as "unproven".

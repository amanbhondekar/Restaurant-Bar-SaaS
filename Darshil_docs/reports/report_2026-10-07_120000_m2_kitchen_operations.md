# M2 leftovers — kitchen operations: station screens, course firing, recall, prep telemetry

**Date:** 2026-10-07T12:00:00+05:30
**Branch:** `feat/m2-kitchen-ops` (on top of `feat/m1-completion`)
**Milestone:** M2 — Menu depth (4.3 Kitchen operations, the items left open after PR 15)

---

## WHY

PR 15 routed kitchen tickets to per-station printers, but four roadmap items under 4.3 were still open:

1. **Per-station KDS screens.** The kitchen display showed every ticket to everyone; a bar tablet had to scan past the food.
2. **Course firing (hold and fire).** Everything was sent to the kitchen at once; there was no way to hold mains until the starters were done.
3. **Ticket recall.** "Ready" could not be undone; a mistaken tap or a dish sent back had no remedy.
4. **Prep-time telemetry.** No data on how long dishes take.

## ALSO FIXED

The Kitchen Display's **Enrollment Code** block appeared **twice**. This was introduced by my own merge resolution (the M1 squash had one block, the M2 squash two) and is on Darshil's `main` today. Removed.

---

## WHAT

### Model (`hub_server/lib/courses.js`, new, pure)

A ticket's lines belong to **groups**; a group is what gets fired and later marked ready.

- **Normal ticket (default, and every ticket from before this change):** one group, fired when the order is placed. Behaviour is exactly as before.
- **Served in courses:** groups follow each line's `course` (1 starters, 2 mains, 3 desserts, up to 9). Only the first course is fired at order time; the rest are **held** until fired.

State on the ticket: `staged`, `fired_courses`, and `course_log: { [group]: { fired_at, stations_ready: { hot|cold|bar: iso }, ready_at?, recall_count? } }`. `status` keeps its existing vocabulary (`in_progress` / `ready` / `completed`), so the waiter app, tables, billing and cloud sync need no changes.

A ticket is **ready when every fired group has every station that has lines in it ready** (a curry-only ticket waits on the hot line alone; a mixed ticket waits on all three). Firing another course puts it back to `in_progress`. Tickets saved before this feature are filled in on read (`withCourseState`), never rewritten.

### Station screens

The kitchen display has a station selector (All / Hot line / Cold line / Bar) with live counts. A bar tablet opens `/?station=bar`; the choice is remembered on the device. On a station screen a ticket shows only that station's fired lines, appears only while that station still has something to cook, and its button becomes **"Bar ready"**. When every station has reported, the ticket turns ready and the waiter is notified, exactly once. Each ticket card shows chips for every station on it and whether it is done. Firing is hidden on station screens (it is a front-of-house decision) but the "on hold" note stays.

`POST /orders/:id/stations/:station/ready` (404 unknown ticket, 400 unknown station, 409 when there is nothing to mark).

### Course firing

- Menu items have an optional `course` (editor field "Serving course"; default 1). The pricer stamps it onto each line like `station`.
- The waiter's cart shows **"Serve in courses"** only when the order spans more than one course; ticking it sends `course_service: true`. Single-course orders and unticked orders are normal tickets.
- `POST /orders/:id/fire` sends the next held course (or `body.course`). Refusals: `NOT_STAGED`, `NO_MORE_COURSES`, `ALREADY_FIRED`, `UNKNOWN_COURSE`, `TICKET_CLOSED`.
- Firing prints a KOT for the newly fired lines only, headed `*** COURSE 2 - FIRE NOW ***`; the first KOT of a staged order carries `COURSE 1` and an `On hold: course 2 (3 items)` line so the kitchen knows more is coming.
- Where it is triggered: a **Fire course N** button on the kitchen display (ticket card and the Ready list) and on the waiter app's Tables tab for the selected table.
- The table goes back to "cooking" on the waiter app because table state is derived from ticket status.

### Recall

`POST /orders/:id/recall` puts a ready ticket back on the board and reopens only the course that was made ready last (earlier courses stay done); `recall_count` is kept. Button on the Ready list. Cloud status is synced back to `in_progress`.

### Prep-time telemetry

`lib/prepTelemetry.js` (pure) derives samples from `course_log`: fired to ready, overall (slowest station decides), per station, and per dish. A recalled course counts with its full time since firing, remake included. `GET /telemetry/prep?from&to` (reception only, default last 24 h) returns average, median, 90th percentile and maximum, slowest dishes first, and a recall count. New admin tab **Kitchen**.

### Files

| File | Change |
|---|---|
| `hub_server/lib/courses.js`, `prepTelemetry.js` | **New.** Pure logic. |
| `hub_server/lib/ticketStore.js` | course state at creation; `transition()`, `markStationReady`, `fireCourse`, `recall`; active tickets filled in on read |
| `hub_server/lib/printer.js` | KOT course banner and held-items note |
| `hub_server/lib/pricing.js`, `menuNormalize.js`, `menuAdmin.js`, `restaurantCache.js` | `course` on menu items, priced lines and the cache; seed tagged (starters 1, mains 2, desserts 3) |
| `hub_server/server.js` | station-ready, fire, recall, telemetry routes; KOT printing is course-aware |
| `src/lib/ticketView.js` | **New.** The screen's view logic, pure and tested |
| `src/kitchen_main.jsx` | station selector, station-aware cards, held courses, Fire, Recall; duplicate enrollment block removed |
| `src/waiter_mobile/OrderDraftDrawer.jsx`, `WaiterApp.jsx` | "Serve in courses" switch; Fire panel for held courses |
| `src/admin/KitchenTab.jsx`, `AdminApp.jsx`, `ItemEditor.jsx`, `lib/itemForm.js` | Kitchen tab; Serving course field |
| `hub_server/test/kitchenOps.test.mjs`, `ticketView.test.mjs` | **New.** 37 tests |

---

## TEST CASES

**Course logic (pure):** course normalisation; normal vs staged vs single-course staged; legacy tickets; a ticket is ready only when every station on it has reported (once, with `ticket_ready`); the whole-ticket Ready; firing (next, specific, out of order, refusals); recall (only when ready, reopens the last-ready course, recall count, re-ready); KOT banner/held note.

**Telemetry (pure):** nearest-rank percentiles; fired-to-ready samples per overall/station/dish; unfinished, other-tenant and out-of-window tickets excluded; report ordering; recalls.

**Live hub (real process, two fake kitchen printers tagged hot and bar):** a staged order fires course 1 only and the printers say so; the ticket turns ready only when both stations report; unknown station / ticket; fire prints only the new course and puts the table back to cooking; recall needs a ready ticket; a normal order is untouched; `/menu` carries the course; telemetry and range validation.

**Screen logic (`ticketView`):** which lines each station sees; held groups; station chips; board membership; chip counts; station from the address, storage, or all.

**Catalog:** `course` through the normaliser, the admin API (valid, invalid, change) and the editor form.

**Manual (browser, real hub, seeded orders):** station chips with counts; a Bar screen showing only drinks (`?station=bar`); Bar-ready removes the ticket from the bar screen and turns its chip green; firing course 2 adds the mains and leaves course 3 held; Recall puts a ready ticket back (Ready 1 to 0, Active 2 to 3); the Kitchen tab shows 4 courses, average 1m 32s and 1 recall. Waiter app (driven through the page, as the browser pane stopped painting): the switch appears with the right hint, order sent as course 1 only, the Fire panel appears, and clicking it fires course 2 on the hub.

```bash
npm test      # 420 tests; 419 pass
npm run build
```

The one failure is the existing `SyncQueue: head-of-line blocking` test (needs a configured Supabase URL). My live-hub tests failed once under load during development; they now wait for the printer output instead of sleeping a fixed time, and four consecutive full runs were clean.

---

## NOT DONE / LIMITS

- **Station screens are a filter on the same display, not separate hub instances.** A bar tablet opens `/?station=bar` against the one hub.
- **Not tried on a real tablet or a real KOT printer.**
- **Recall does not reprint a ticket.**
- **Course state is not replicated to Supabase**, only the ticket status (as before).
- **Fire is not plan-gated** and not limited to particular staff.
- **CSV import/export has no course column.** Courses are set in the editor; an import keeps an existing dish's course and gives new dishes the default.
- **Stock-driven 86'd and inventory** (the other M2 leftover) are not part of this change.
- The waiter-side flow was checked by driving the page's DOM rather than by screenshots.

## STATUS

Verified locally; not yet merged.

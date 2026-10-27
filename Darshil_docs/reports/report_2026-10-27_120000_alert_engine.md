# Super admin console, Phase 2: the alert engine (P2-2)

**Date:** 2026-10-27T12:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 · Phase 2, task P2-2 (rules, dedupe, state machine, escalation) of `docs/SUPER_ADMIN_BUILD_SHEET.md`

---

## WHAT CHANGED

The part of alerting that decides: **which problems are real right now, which alerts are open, who is due a page and how urgent it is.** It does not send anything. A channel (Telegram or ntfy, decision D3) and the worker's entry point are P2-3.

- **The rules** (`common/alertRules.js`, pure): given a row of the fleet view, what the console knows about the restaurant's service hours, and the moment it is read in, which conditions are true. Six rules: `hub_silent_service` (P1), `orders_shelved` (P1), `hub_silent_long` (P2), `sync_backlog` (P2), `payment_past_due` (P2), and `service_hours_missing` (P3, shown and never sent). They reuse the operator console's own constants, so a hub the console calls "live" is never one an alert calls silent.
- **Service hours**: a restaurant's opening hours in its own time zone, with two windows a day and windows past midnight. A hub silent for more than 15 minutes is an emergency only **while the restaurant is open**, and only the silence since it opened counts, so a laptop switched on at opening time is not "silent". Hours that are missing or unreadable are **unknown, never guessed**: the restaurant is flagged instead.
- **The lifecycle** (`common/alertEngine.js`, pure): open → acknowledged → resolved; one alert per key however often the worker looks; resolved by itself when the condition clears (acknowledged or not); **nothing is resolved on a read of the fleet that stopped early**. Paging: both founders at once; a reminder every 10 minutes at higher urgency, three times; ten minutes after the last it is flagged **unattended**; an acknowledged alert is never paged again. **A P2 never pages 22:00 to 08:00 India time**; it waits and goes out as a first page when the founders wake. A P1 pages at any hour. The words of a page use only the fields each rule names.
- **The database** (`database/migrations/024_alerts.sql`): a role for the worker, **`kullina_alerts`, with no privilege on any table and four functions** (`alert_snapshot`, `alert_apply`, `alert_notified`, `alert_notify_failed`), the same pattern as `kullina_admin` (decision D1). Tables `alerts` (its columns cannot contradict its state; one unresolved alert per key) and `tenant_admin_meta`; the owner's `set_tenant_service_hours` (checks the hours and the time zone, leaves an event); and for people `admin_alerts`, `admin_ack_alert` and `admin_resolve_alert`, which ask `spine_assert_admin()` first, need a reason of **at least 10 characters (invariant I4)**, and write their event in the same transaction. Every change to an alert leaves an event on the restaurant's own chain, naming the person for what a person did and the system for what the worker did.
- **The worker's pass** (`alert_worker/lib/worker.js`, `db.js`): read, evaluate, apply, page, record. A page that could not be sent is recorded as failed (only its *kind*, never the channel's message, which can carry a token) and tried again; a page that went out but could not be recorded is sent again (**at-least-once**); a pass that cannot read the database does nothing.
- `common/opsRules.js` now also exports its two readers (`readTime`, `readCount`) so the new rules share them. Existing tests pin the pin-lists for the new `admin_*` functions and the new console-only tables (`adminSpineSchema`, `cloudSql`).

## WHAT THE TESTS PROVE

Written first. **157 new tests in four files**, and the hub suite is now 2198 tests in 102 files (2041 + 157) (the frontend suite is untouched).

- `alertRules` (38): every threshold to the millisecond on both sides (15 minutes of silence is still live and 15 minutes and a millisecond is not; 50 queued bills is a backlog and 49 is not; 36 hours); service hours read in the restaurant's own zone, the opening and closing minute, two windows a day, windows past midnight on both sides of midnight; unreadable hours are unknown; a cancelled restaurant's hub is not chased; nothing a rule says holds a phone number.
- `alertEngine` (40): opening, deduplicating and resolving; an incomplete read resolves nothing; a reminder is due at exactly ten minutes and not at nine minutes fifty-nine seconds; three reminders and no fourth; flagged ten minutes after the last; acknowledged and resolved alerts never paged; P2 held overnight and sent on waking, P1 sent at any hour; quiet-hour boundaries to the millisecond; what a page says, and what it never does.
- `alertsSchema` (48, real Postgres engine): the worker's role can run exactly four functions and holds no table; nobody else can run them; the new tables are closed to every role; an alert cannot be acknowledged by nobody or resolved at no time; one unresolved alert per key; every event lands on the right chain with the right actor and the chain still verifies; reasons are required and trimmed; a second acknowledgement changes nothing; payloads carry only ids, rule names, counts, times and reasons.
- `alertWorker` (31): the whole pass against a fake database and channel with a clock that moves to the minute (reminder cadence, unattended flag, quiet hours, a failing channel retried, a token in an error never kept, a page acknowledged mid-send), and **three end-to-end passes through the real SQL functions on PGlite**.

**Mutation checking: 163 mutants** across the rules, the engine, the worker and the migration. **130 were caught at first; 26 survived.** Of those, **18 were gaps in the tests, now closed** (the evening half of a window that runs past midnight, an unknown weekday, a window of three times, the moment a window opened when the question has seconds in it, how a silence is worded around two hours, a resolved alert in the input, a page that was acknowledged while it was being sent, stopping the worker between passes, the worker's own reasons and lists, a failed page for a resolved alert, the second founder acknowledging, hours replaced on a second set, the 500-character cap), and the I4 length boundary was added in both directions. **8 are equivalent and left:** a shut restaurant entering the 'open' branch changes nothing (its start is undefined, so the silence is NaN, which is never over 15 minutes); the array check on the hours table is already covered by the weekday-key check; three REVOKEs from the new roles are belt and braces (those roles were never granted anything, and PUBLIC is already revoked); and three checks in lert_apply (severity, rule, detail) are repeated by the table's own CHECK constraints with the same words. On the re-run **every mutant that is not equivalent was caught.**

## FOUND ON THE WAY

- **Invariant I4 (a reason of 10+ characters on every admin write)**: my first version of `admin_ack_alert` and `admin_resolve_alert` accepted any non-blank reason (the tests used `'x'`). Found by reading the build sheet's invariants against the finished code, **before** any commit; fixed in the SQL and pinned to the character (9 refused, 10 accepted).
- The living doc said the button fix had been looked at "on two pages only". It had since been reviewed on every screen; the doc is corrected.

## HONEST LIMITS

- **Nothing sends a message.** There is no channel and no entry point to run the worker; both are P2-3. Until then an alert opens, is visible to the database and the (not yet built) inbox, and nobody is paged.
- **Never run against a hosted project** (gate G0-1): proven on a real Postgres engine (PGlite) and stand-ins.
- Six of the nine rules in the build sheet. Webhook signature failures, the operator service or the worker being down, repeated failed admin sign-ins, and migration drift need data that does not exist yet.
- "Three missed reports (≥15 minutes)" is read as **more than** 15 minutes, matching the line the console already draws between "live" and "quiet".
- Paging is **at-least-once**: a crash between sending and recording sends the page again.
- Resolving by hand an alert whose condition is still true opens a fresh one on the next pass (acknowledge is "I know").
- An alert's details are as at the moment it opened.
- Service hours are set by the database's owner from the SQL editor; there is no screen for it (Phase 3 brings `admin_update_tenant_meta`).

## DECISIONS I MADE, FOR AMAN TO CONFIRM OR CHANGE

1. The worker has its **own role** (`kullina_alerts`), on D1's reasoning, rather than reusing `kullina_admin` or holding the service key.
2. Quiet hours are on the **founders'** clock (22:00 to 08:00 India), not each restaurant's.
3. "Three missed reports" means more than 15 minutes.

**Open question before P2-3:** the sheet asks for a "signed one-tap acknowledge link" and I4 asks for a reason of at least ten characters on every admin write. A one-tap link cannot ask for a reason. The simplest answer is a fixed, visible reason ("Acknowledged from the alert link") attributed to the founder the signed link names, which meets the letter of I4 but not its spirit. It needs a decision, not a guess.

## NOT DONE

P2-1 (tenant timeline page), P2-3 (the channel, the signed link and the worker's entry point), P2-4 (the inbox and the API routes for acknowledge/resolve), P2-5 (the watcher for the watcher); the unbuilt rules above; running any of it on a hosted project; retiring `OPS_TOKEN`.

Status: ✅ built and tested; 🟡 never run against a hosted Supabase project; 🚧 nothing sends yet.

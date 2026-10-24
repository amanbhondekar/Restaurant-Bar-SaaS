# Docs — ROADMAP.md merged onto the working line and reconciled with the code

**Date:** 2026-10-13T17:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** Documentation (§4.10 adjacent; unblocks §6's maintenance rule)

---

## WHY

`docs/ROADMAP.md` — the document that defines M1–M4, and therefore every
`feat/m*` branch name in this repository — was authored on 2026-09-19 on a branch
called `docs/roadmap` and never merged. It surfaced only while auditing branches for
deletion; it was the single unmerged commit on an otherwise redundant branch and
would have been destroyed by a careless cleanup.

Two consequences:

1. **Nobody working on the code could see it.** A roadmap question had to be answered
   by reconstructing milestones from plan files, branch topology and the "NOT DONE"
   sections of reports. That reconstruction happened to match, but the authoritative
   source was sitting one branch away.
2. **Its own maintenance rule was unfollowable.** §6 asks that every change closing a
   bullet "lands with a report … and a diff to this file in the same commit." No commit
   on the working line could diff a file that was not on the working line. The rule was
   broken from the moment it was written on a side branch, and the document went two
   full milestones stale as a result.

## WHAT

### Merged

`git merge origin/docs/roadmap` — one commit, one file, no conflicts. The branch's
history was already contained in this line; only `docs/ROADMAP.md` was new.

### Reconciled against the code

Every claim was checked against the tree rather than from memory. The 2026-09-19 text
described a state before M1 and M2 existed, so whole themes marked ⬜ were in fact
complete.

| §4 theme | Was | Now | Evidence |
|---|---|---|---|
| 4.1 Billing & payments | ⬜ | 🟡 | `invoice.js`, `tax.js`, `split.js`, `printer.js`, `escpos.js`, `reconciliation.js` — but see the gap below |
| 4.2 Inventory & menu depth | ⬜ | 🟡 | `dayParts.js`, `menuNormalize.js`, modifiers/variants shipped; no `inventory_items` or `recipes` anywhere |
| 4.3 Kitchen operations | ⬜ | 🟡 | `kotRouting.js`, `prepTelemetry.js`, `POST /orders/:id/fire`, `POST /orders/:id/recall` |
| 4.4 Tenant lifecycle | ⬜ | 🟡 | `plans.js`, `GET /plan`, admin `PlanTab.jsx` |
| 4.7 Auth & access | ⬜ | 🟡 | `waiterStore.js`, PIN sign-in verified in the PWA |
| 4.8 Reliability | ⬜ | 🟡 | `ci.yml` (Node 20/22), `crashReporter.js`, 455 tests / 22 files |
| 4.10 Documentation | ⬜ | ⬜ | `CHANGELOG.md`, `LICENSE`, `CONTRIBUTING.md` all confirmed absent |

Milestones: **M1 ✅ complete 2026-10-05**, **M2 ✅ complete 2026-10-07** less the
inventory tail, **M3 🟡** with PR 16 and PR 18 shipped and PR 17/19/20 open.

### Two corrections the audit forced

**A gap the roadmap did not record.** Writing the §2 schema bullet from memory
produced the claim that invoices and reconciliation records were among the Supabase
tables. Checking `database/supabase_schema.sql` showed nine tables and **no invoice or
reconciliation table at all**. Billing is written to `hub_server/data/` and the sync
queue replicates orders, not bills.

That means a tenant's entire revenue history lives on one reception laptop and is lost
with it, and no cloud-side reporting is possible. It is the largest gap behind M1 being
called complete, and nothing in the repository said so. 4.1 is now 🟡 rather than ✅,
with cloud replication of invoices as its open bullet, and §3 carries it as a named
risk.

**A stale claim retired.** The old §3 said `/dashboard` hydration "was flaky in the
last spot check". Re-checked against a running hub: sales, floor grid, active KOTs and
billed orders all render, no console errors. Moved to ✅ with the date of the check,
rather than carried forward on the strength of a month-old note.

### Files

| File | Change |
|---|---|
| `docs/ROADMAP.md` | Merged in, then +193/−90: §1 current state, §2 four new shipped sections (billing, menu depth, kitchen ops, tenant lifecycle), §3 rewritten, §4 statuses corrected, §5 milestones marked |
| `Darshil_docs/README.md`, this report | The SOP entry §6 asks for |

## TEST CASES

Documentation, so the test is whether each statement matches the tree.

| ID | Claim checked | Method | Result |
|---|---|---|---|
| RM-1 | Billing modules exist | `ls hub_server/lib` | 6 of 6 present |
| RM-2 | Kitchen ops routes exist | `grep` `server.js` for fire/recall/telemetry | all 3 present |
| RM-3 | Inventory absent | `grep -rl inventory_items recipes` | 0 files |
| RM-4 | Doc files absent | `ls` CHANGELOG/LICENSE/CONTRIBUTING | 0 of 3 present |
| RM-5 | No frontend test runner | `package.json` for vitest/playwright | none |
| RM-6 | Test count | `npm test` | 455 across 22 files |
| RM-7 | Migrations 001–004 | `ls database/migrations` | 4 present |
| RM-8 | **Invoices not in schema** | `grep -c 'create table.*invoice'` | **0 — claim corrected** |
| RM-9 | `/dashboard` hydrates | Loaded against the running hub | renders, no console errors |

No code changed, so the suite was unaffected; `npm test` remains 455/455.

## NOT DONE / LIMITS

- **§2 was audited by presence, not by behaviour.** A module existing is evidence a
  feature shipped, not that it works correctly; the regression suite is what covers
  that, and it is hub-only. Frontend claims rest on hand-verification.
- **Cloud bill replication is now recorded, not fixed.** It needs a schema migration,
  sync-queue op types and an RLS policy — a real slice, not a doc edit.
- **Dates on M1 and M2 are taken from the completion reports** (2026-10-05, 2026-10-07),
  not from when the last related commit landed.
- **§4.5 and §4.6 were not re-audited in depth** — both were ⬜ before and nothing in
  the tree suggests otherwise, but they were checked by grep rather than by reading
  the surfaces.
- The roadmap now lives on `feat/m2-kitchen-ops`, not on `main`. §6's rule holds for
  work on this line; a reader on `main` still will not see it until this branch lands.

## STATUS

✅ VERIFIED — merged, reconciled, 455/455 unaffected.

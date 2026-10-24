# M2 leftovers — recall reprints, the CSV carries course, and firing is plan-gated

**Date:** 2026-10-15T04:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M2 tail (§4.2, §4.3), unblocked by M3 · PR 16

---

## WHY

Three items the 2026-10-07 M2 report listed under "NOT DONE / LIMITS" and left open. All three are
small, local and fully testable; none needs cloud credentials.

## WHAT

### 1. Recall reprints the KOT

A course's paper KOT is spiked when the course is marked ready. Recalling it put the ticket back
on the board **and nothing on paper**, so the kitchen was asked to cook again from memory. Fire
already reprinted; recall now matches it.

The part worth reviewing is not the reprint but the banner. An identical second KOT landing on the
pass is exactly how a course gets cooked twice, so a recalled ticket prints

```
*** RECALL - COURSE 2 - REPRINT ***
```

where a fired one says `COURSE 2 - FIRE NOW`. `recallTicket` now also returns `recalled_items`,
derived the same way `fireCourse` derives `fired_items`, so a reprint carries exactly the lines
that were fired.

### 2. The CSV carries the serving course

`course` was editable in the item editor but absent from import and export, so a restaurant that
manages its menu by spreadsheet could not set it and a round-trip silently dropped it.

`course` is now a column between `station` and `variants`. It follows the conventions the other
columns already established, which is most of the work:

- **A blank cell means "leave it alone"**, never "reset to 1" — the same rule as every other
  column, so a file written before this column still imports cleanly.
- **Export writes blank for course 1**, and `VIEW.course` defaults to 1, so exporting and
  re-importing reports every row unchanged. Getting this wrong would have made every row in a
  round-trip look edited.
- **Out of range, zero, decimal and non-numeric are errors**, not silent defaults. Quietly
  coercing a typo to course 1 would reorder a restaurant's service without telling anyone.

Adding it to `VIEW` was not optional: without that the importer applied a course change but the
preview reported the row `unchanged`, so an operator would have approved an edit the review table
told them was a no-op. The test caught it.

### 3. Firing a course is plan-gated

Every other M2 depth feature is gated; this one was not. `FEATURES.COURSE_FIRING` is now on
`pro` and `enterprise`.

**Recall is deliberately not gated.** Firing is menu depth; recall undoes a mistake on a ticket
already on the pass, and refusing it would strand a kitchen mid-service — the one thing PR 16's
design says plan enforcement must never do. There is a test asserting recall is never refused over
a plan, so that asymmetry is recorded rather than incidental.

### Files

| File | Change |
|---|---|
| `hub_server/lib/courses.js` | `recallTicket` returns `recalled_items` |
| `hub_server/server.js` | Recall reprints with a RECALL banner; fire gated on `COURSE_FIRING` |
| `hub_server/lib/plans.js` | `COURSE_FIRING` feature |
| `src/admin/lib/plan.js` | Label for it |
| `src/admin/lib/csv.js` | `course` column in `MENU_COLUMNS` and the export |
| `hub_server/lib/menuImport.js` | Course cell parsed, validated, and in `VIEW` |
| `hub_server/test/{kitchenOps,menuImport,adminCsv,plans}.test.mjs` | 8 new tests; CSV expectations updated |

## TEST CASES (8 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| ML-1 | `recalled_items` | Only the recalled course's lines, matching `fired_items` | Pass |
| ML-2 | **Recall reprint, end to end** | A second KOT reaches the station sink carrying the lines and saying RECALL / REPRINT | Pass |
| ML-3 | Course applied to a new dish | `course: 3` | Pass |
| ML-4 | **Course change is reported** | Preview says `updated`, not `unchanged` | Pass |
| ML-5 | Blank cell | Leaves an existing dish's course alone | Pass |
| ML-6 | Bad values | `0`, `10`, `-1`, `2.5`, `main`, `' '` are errors | Pass |
| ML-7 | Column optional | A pre-column file still imports | Pass |
| ML-8 | **Fire is gated** | 403 `PLAN_FEATURE_UNAVAILABLE`, feature `course_firing` | Pass |
| ML-9 | **Recall is not gated** | Never 403 over a plan, on a degraded tenant | Pass |

Existing coverage did real work here: the PR 18 drift guard failed immediately because the owner
console had no label for the new feature, and the CSV round-trip test failed until the export and
`VIEW` agreed on what course 1 looks like.

```bash
npm test       # 527 + 8 = 535
npm run build  # clean
```

Verified in the browser against the pilot hub: the Plan tab shows "Serve in courses (hold and
fire) — Included", `GET /plan` reports `course_firing: true` on `pro`, and the CSV header is
`id,name,category,price,veg,available,station,course,variants`.

## NOT DONE / LIMITS

- **Gating firing removes it from Starter.** That is a product decision, not a technical one, and
  it is one line in `plans.js` to reverse. Nothing is affected today — the pilot resolves to `pro`
  and keeps the feature, and there are no Starter tenants — but a restaurant that later lands on
  Starter will lose hold-and-fire, and nothing warns them before it happens.
- **The reprint is not marked on screen**, only on paper. The KDS shows a recalled ticket back on
  the board exactly as before, so a kitchen working from the screen rather than the pass sees no
  "this was recalled" signal.
- **Reprint has no retry.** It is fire-and-forget like the original KOT, so a printer that is
  offline at the moment of recall loses the reprint silently; the existing print-failure warning
  in the log is the only trace.
- **Course is still absent from `menuToCsv`'s sibling path in the admin ImportDialog preview
  columns** only insofar as it is rendered generically — it was not separately styled or
  explained in the UI, so an operator meets the column first in a downloaded file.
- The remaining M2 leftovers are untouched: course state is still not replicated to the cloud, and
  station screens are still a filter on one display rather than per-station KDS instances.

## STATUS

✅ VERIFIED — 535/535, build clean, confirmed in the browser on the pilot hub.

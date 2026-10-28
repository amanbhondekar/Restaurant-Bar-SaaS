# CHANGELOG, CONTRIBUTING and a pilot report template

**Date:** 2026-10-23T14:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
Roadmap §4.10 listed four missing documents. The README pointed at a progress report that is not in the tree, nothing
recorded what had changed between the first commit and now except 142 commit subjects, and the rules the work follows (a report
per change, tests first, mutation checks, default-deny) lived in `Darshil_docs/README.md` and in habit.

## WHAT
- `CHANGELOG.md` (Keep a Changelog). There are no tagged releases, so it is grouped by milestone with the unmerged work under
  Unreleased, each section a few lines and pointing at the reports for the detail. Written from the commit history and the reports.
- `CONTRIBUTING.md`: setup, the audit-report SOP (carried over from `Darshil_docs/README.md`), tests-first with the failing run
  shown, mutation checks and what to do with a survivor, the house rules (default-deny, the hub prices, money moves on the day it
  moved, offline first, additive migrations, say what you did not verify), commit and PR conventions, and a map of the repo.
- `docs/pilot-report-template.md`: the generic template, in place of the missing Mejwani report; the README tree now lists the files
  that exist.

## NOT DONE
`LICENSE`. Which licence the product is released under is the owner's decision, so I did not pick one; it stays open in §4.10.

## VERIFIED
Documentation only. Links and paths in `CONTRIBUTING.md` were checked against the tree; the changelog's milestone dates are the first
and last commit dates of each stretch.

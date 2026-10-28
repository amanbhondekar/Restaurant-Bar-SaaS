# Menu importer: tests, and a Replace mode that could be left on over the wrong numbers

**Date:** 2026-10-22T21:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## THE BUG
The importer's review belongs to the mode it was worked out for. Switching from Merge to **Replace entire menu** selects
the Replace radio immediately and then asks the hub what a replace would do. If that request failed (a network blip, a
hub restarting), the radio stayed on Replace while the review underneath was still the **merge's**: the page said
"**0 items will be removed**", showed a box that would accept REPLACE, and offered "Replace menu (n)". Someone who
typed REPLACE was confirming the removal of a number the page had not worked out, and the hub would then remove every
dish the file leaves out.

Found by mutation-checking the new tests (a mutant that always returned to the review after a failed preview survived).
Fixed: a failed preview for a new mode puts the old mode back, with the hub's reason shown; the old review, which still
matches the old mode, stays importable. The test was written first and shown failing on the old code (the Merge radio was
not checked after the failure).

## TESTS (`ImportDialog.test.jsx`, 33)
Files are read in the browser and the hub is asked what it would do: CSV rows arrive with their row numbers in the FILE
(so the review matches the spreadsheet); a CSV saved by older Excel (windows-1252) keeps its "Café"; a workbook goes through
the same path; ignored columns are named; a wrong file type, an empty file, a missing name column, more than 2000 rows and a
file over 8 MB are each explained without troubling the hub.
Review: what each row would do, filters, paging 200 at a time (and back to the first page when the filter changes),
variants and availability shown in words.
Merge: sends the reviewed revision and never carries `confirm_replace`; nothing to import is not importable; errors block
until "Import valid rows only" is ticked; no valid rows can never be imported.
**Replace:** every file starts as a merge, and again for the next file; typing does not carry across modes; the box takes
exactly REPLACE (not "replace", not "REPLAC"); the button counts the removals; the mode and the confirmation are both sent;
with no valid row it says nothing will be removed and offers no way to; the modes cannot be switched mid-request.
Refusals: a menu that changed under the reviewer is not imported, the review is refreshed, and the retry goes against the new
revision (7, then 9) and works; a refused commit returns to the review; a refused first preview returns to choosing; an
unreachable hub is explained. Leaving: Cancel, the corner button and Escape are all dead while the hub is working and alive
otherwise. The template download is a `menu.csv` of the current menu.

jsdom has no `Blob.arrayBuffer()` or `text()`, which every real browser does; the test file gives the environment those two
methods. That is a limit of the test environment, not a defect in the page.

## MUTATION CHECK
27 mutations of the dialog. On the first run 20 were caught and 6 survived. Three of those are equivalent: the mode-switch guard
that duplicates the radios' `disabled`, and the two "no valid rows" guards that cover each other, so removing either alone changes
nothing (they stay as defence in depth). Three were real gaps: Escape closing the dialog mid-commit, the page not returning to
the first page on a filter change, and a refused first preview leaving the choose phase, which led to the bug above. Each is now
caught. One more mutant (the confirmation carrying across modes) could not be applied after the code it targets was edited and was
checked by hand: caught.

## COUNTS
Frontend **637 passing** (604 before). Build clean. Hub unchanged.

## NOT DONE
The reception Kitchen Display, the waiter app's order entry and connection handling, and a Playwright run in a real browser.
Nothing here proves the hub's importer is right: that is `menuImport.test.mjs`.

# Test coverage: the Printers and Plan admin tabs

**Date:** 2026-10-22T20:45:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHAT WAS ADDED
Two reception tabs that were verified by hand now have tests. No production code changed.

- **Plan** (`PlanTab.test.jsx`, 18 tests): the banner rules (a healthy plan says nothing; a dropped plan names what the
  restaurant is running on and why, in the owner's words, with a safe sentence for a reason it does not know;
  **degradation outranks the grace period**, so "everything still works" is never said to a restaurant that has already
  dropped to Starter); limit rows (green, amber one below the cap, rust at it, none when uncapped; bar capped at 100 and
  never a divide by a zero limit; a count the hub does not keep is a dash with a note, not a zero); features; the
  error-toned notice is an alert, the grace notice a status; the usage bars are decoration; an unreachable hub, and a
  refresh that fails keeping the last answer on screen with a note.
- **Printers** (`PrintersTab.test.jsx`, 24 tests): what is configured and how each is described; what the page SENDS
  for each transport (USB queue name, network host trimmed with port 9100 as the fallback for anything not a number,
  device path, blank label left out); the station is sent only with kitchen tickets, and **a station chosen and then
  abandoned by switching back to receipts is not sent**; Add is disabled until the transport has what it needs; the
  form clears and the list is re-read after an add; the hub's refusal is shown beside the form, the typed text kept and
  the message cleared when the person edits; test pages (success, a named failure as an error, nothing else startable
  while one is in flight, ids that need URL-escaping); removal (asks first, cancel removes nothing, confirm removes and
  the dialog closes, a refusal leaves the printer); the "look for printers again" button and the USB-only warning.

## MUTATION CHECK
- Plan: 11 mutations, all caught.
- Printers: 19 mutations. 16 caught at once; **3 survived and each was a real gap**: the delete URL not being escaped
  (the test used a plain id), the removal dialog staying open after the removal (the test did not look), and the
  USB-only "no print spooler" warning showing on network printers. Three assertions added; all 19 now caught.

## COUNTS
Frontend: **604 passing** (562 before this). Hub unchanged at 1103.

## NOT DONE
The menu importer, the reception Kitchen Display, the waiter app's order entry and connection handling, and a
Playwright run in a real browser are still verified by hand or not at all. The Printers tests prove what the page asks
the hub for; they cannot prove a physical printer prints.

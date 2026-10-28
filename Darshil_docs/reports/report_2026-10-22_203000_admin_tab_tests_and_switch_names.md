# Tests for the Menu, item editor, Tables and Cash screens — and a screen-reader bug they found

**Date:** 2026-10-22T20:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §3 "Test coverage" / §4.8 "Frontend test suite"

---

## WHY

The roadmap's test-coverage entry listed what was "still verified by hand": the reception Menu, Tables and
Cash tabs among them. Those are three of the four screens where a mistake costs money or service — the Menu
tab sets what guests are charged and what is 86'd, Tables is the floor every handset works from, and Cash
closes the till. The hub behind them is thoroughly covered; the screens that drive it were not, so a change to
what a screen *sends* (the revision, an id in an address, an irreversible close without asking) could ship
unnoticed.

## WHAT

136 frontend tests across four new files, each mutation-checked.

| File | Tests | What it pins |
| --- | --- | --- |
| `src/test/admin/MenuTab.test.jsx` | 36 | loading / error / no-menu states; the item table (price ranges, what is configured on a dish, stock-out badge); categories and search; **the 86 switch** — what it sends, the revision, encoded ids, writes serialised so two cannot race on one revision, a stale revision handed to the reload banner, any other refusal shown and dismissible; add / rename / reorder / delete a category with their validation; opening the editors |
| `src/test/admin/ItemEditor.test.jsx` | 23 | **only what changed is sent** (editing a price cannot drop variants, modifiers or day-parts); nothing to save until something changes; validation before asking, and not shown until the first attempt; stale revision, duplicate name (on the *field*), field-by-field refusals; no double save; a new item sent without empty lists; discard-changes and delete both ask first |
| `src/test/admin/TablesTab.test.jsx` | 38 | the save payload (whole floor, against the revision on screen, new tables without an id); rename / reseat / move / reorder / delete for tables and sections; **an open bill locks rename and delete but not seats or moves**; the hub's `tables[i]` errors found on the right row; open-bill refusal names the tables and refreshes the floor view; Discard asks; leaving the page with unsaved work is stopped; a fresh layout replaces the draft |
| `src/test/admin/CashTab.test.jsx` | 39 | the preview (expected = opening float + what cash took; Short / Over / Balanced with the sign right; a UPI or card difference makes the note required); **closing the shift** — blocked until the drawer is counted, asks first and says it is permanent, sends exactly what was typed (blanks as zero or left out), reports "balanced" or "with a difference" as a warning, cannot be sent twice, a failed close keeps what was typed; closed shifts and their per-period ledger links |

## A BUG THE TESTS FOUND

Writing the Menu tab's switch tests, nine of them failed to find a switch by the name the code gives it. That
was not the test being wrong.

Each 86 switch carries `aria-label="Dal Tadka: available"`. But the `Switch` component, when it sits inside a
`<label>`, also wires `aria-labelledby` to that label — and `aria-labelledby` takes precedence over
`aria-label`. The label's text was just "Available". So the accessible name of **every** switch was
**"Available"**, and a screen-reader user heard *"Available, switch"* on every row with no way to tell which
dish it was. The same pattern was in the item editor's `AvailableSwitch`, used for every size and every modifier
option.

**Fix.** The name has to be in the label's text, because that is what names the switch:

- Menu tab: the label now contains a visually hidden `<span>` with the dish name, so a row reads *"Dal Tadka:
  Available"*. The ineffective `aria-label` is gone.
- Item editor: the `label` prop goes into a hidden span in the label (*"Variant 1 available"*, *"Group 1 option 2
  available"*), and the visible Available / 86'd is `aria-hidden` because `aria-checked` already says it.

**Checked in a real browser** against the live DOM of a scratch hub: each Menu row's switch resolves to its own
name (*"Paneer Butter Masala: Available"*, *"Dal Tadka: Available"*, …) with no stale `aria-label`, and the
editor's three switches resolve to *"Available"*, *"Group 1 option 1 available"*, *"Group 1 option 2
available"*. (The pane's own accessibility dump does not resolve `aria-labelledby` and printed no name at all, so
the check resolved it the way the spec does.)

The guest-ordering switch added earlier in this session uses the same wrapper but its label text is itself the
description, so it was never affected.

## MUTATION CHECKING

63 deliberate breakages across the four screens (a revision left off a write; an unencoded id in an address; a
stale revision shown as an error; a switch left live while a write is in flight; the opening float left out of
what is expected; the variance sign flipped; a UPI difference not requiring a note; close without asking; the
form not cleared / cleared on failure; a section renamed onto another's name; a saved table deleted without
asking; leaving the page not stopped; and so on).

**One survived the first time**, and it was a gap in *my* tests, not in the screen: *moving a section down
moves it up* (Tables) — only "up" was exercised. A test for "down" now covers it, and the mutation is
caught. Everything else was caught on the first run.

## OTHER THINGS LEARNED

- **A table's accessible label is its name**, so clearing the field changes the label under any test that looks
  it up twice. The helper holds the element instead. Worth knowing for anyone writing tests here.
- **base-ui's `Switch` is a `span role="switch"`**, so "disabled" is `aria-disabled`, not the native attribute;
  the tests assert that.

## WHAT IS NOT DONE

Still verified by hand: the reception **Kitchen Display**, the **Printers** and **Plan** tabs, the **menu
importer**, and the waiter app's order entry and connection handling. Nothing drives a real browser in CI —
this session's two real defects in this area (the cross-page enrolment dead end and this switch name) were both
found by looking at the running product, which a Playwright smoke run would be the way to make repeatable.

---

**Verification:** frontend `452 passed` (was 316), hub `965 passed`, `npm run build` clean; the labelling fix
checked in a real browser against a scratch hub, removed afterwards.

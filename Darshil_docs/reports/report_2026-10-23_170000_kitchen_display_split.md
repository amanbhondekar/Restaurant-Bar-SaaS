# The Kitchen Display split into files

**Date:** 2026-10-23T17:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
`src/kitchen_main.jsx` was one 1,950-line component: the socket, the board state, the bill (about 360 lines of state and handlers), and
the rendering of a header, a pairing panel, station tabs, ticket cards, an 800-line bill modal, a print overlay and a ready list. With
51 tests behind it (the report "the whole Kitchen Display tested as it renders") the split could be done without guessing.

## WHAT CHANGED
- `src/kitchen_main.jsx`: **360 lines**: the socket, the board state, the kitchen actions and the layout.
- `src/kitchen/useBill.js` (430): everything about the bill, moved out unchanged: its state, the preview and its delayed recalculation,
  close, pay, split (three ways), undo, void, refund, print. It takes the hub's address and a way to re-read the board, and returns only
  what its consumers use.
- `BillModal.jsx` (820), `PrintPreview.jsx`, `TicketCard.jsx`, `ReadyTickets.jsx`, `KdsHeader.jsx`, `PairingPanel.jsx`, `StationTabs.jsx`.
  The bill components take one prop, `bill`; the others take what they draw.
- **How it was done.** Not by hand: a script parsed the file with Babel and moved the text of each region verbatim into its new file,
  worked out each piece's free names from the parse (so each component gets exactly the props it uses and a missing one is an error, not
  a guess), and a second check found no unresolved name in any file. It was tried on a copy first.
- `TicketCard` hands its `ref` to the card: the rail animates tickets with `AnimatePresence mode="popLayout"`, which measures the
  element through that ref.
- The bill preview is now asked for **once** when a bill opens. Before, the click fetched it and the delayed recalculation fetched the
  same thing 220 ms later. The recalculation skips what the screen was last asked for, so changing an adjustment, or clearing it back to
  nothing, still asks again.

## WHAT THE BROWSER FOUND
The script's cleanup of the parent's imports **deleted `import './index.css'`**. All 95 Kitchen tests, the full suite and the build were
green, because the tests run with CSS off. Opening the page on a scratch hub showed unstyled text. It is restored, and a test now reads
the source and fails without the import (it also checks that every `./kitchen/...` import names a file that exists).
Then, in a real browser: tickets animate in and finish at full opacity, ticking two lines unlocked Mark Ready, which moved the ticket to
Ready to Serve and removed it from the rail (the pop-layout exit works), the bill opened, a 10% discount typed into the real input
recalculated the bill through the new hook from ₹788 to ₹709, Close Bill issued INV-001073, and paying by UPI with a reference showed
"Paid · UPI" and "Ref: REAL-BROWSER-1". The hub, asked directly, agreed: paid, UPI, that reference, ₹750 less 10% = ₹709. No console
errors after a reload. The scratch hub was stopped and `launch.json` restored.

## TESTS
51 in `KitchenDisplay.test.jsx` (new: the stylesheet and the files it names, the preview asked once, changing and clearing an adjustment,
the strike-through on a ticked line, no Ready section when nothing is ready, Refresh reading board and sync, Fire from the Ready list)
and 3 in `TicketCard.test.jsx` (the ref reaches the card, it works as a popLayout child without a warning, it draws what a cook
needs and reports the right table).

**Mutation check of the wiring:** 22 mutations (each component left out or fed the wrong prop, the hook's collaborators, the key, the
ref). 15 caught first time. The seven survivors: four were real gaps (Fire from the Ready list was wired to Recall and nothing noticed;
the strike-through; the Refresh button; the empty Ready section) and one a contract worth its own test (the ref); all six are now caught.
Two remain and are not worth a test: the card's `key` falling back to the ticket number (real tickets always have an id), and the
header's `ThemeToggle`, which the tests replace with a stub.

## COUNTS
Frontend **851 passing** across 41 files (841 before). Build clean. Hub unchanged by this change.

## NOT DONE
- `BillModal.jsx` is itself 820 lines of JSX. It is one screen, but it holds the adjustment form, the payment buttons, three split
  editors and the void and refund buttons; splitting it further (a component per split editor) is now cheap but was not done.
- `kitchen_main.jsx` still owns the socket and the board state; a `useKitchenBoard` hook would follow the same pattern.
- The generated indentation of the moved JSX is the original's, dedented; I did not reformat anything.

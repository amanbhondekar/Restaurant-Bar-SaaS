# M2 tail — per-station KDS screens

**Date:** 2026-10-20T01:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M2 · §4.3 Kitchen operations — "Per-station KDS *instances*"

---

## WHY

The roadmap described this as: "today a station screen is a filter on the one display, reached as
`/?station=bar`." Reading the code to build the fix showed the real position was worse, and I confirmed
it against a running hub before building anything:

> `kitchen_main.jsx` sends **no device token** — plain `fetch` and a bare `WebSocket`. The hub requires a
> token from anything that is not the reception laptop. So on a separate tablet, `GET /orders/active`
> answers **401** and the live feed is **refused** with 401. Verified: with the hub treating callers as
> remote, `/orders/active` → 401, `/sync-status` → 401, `WS /live` → refused.

So there was no such thing as a station tablet: only the reception laptop could host a Kitchen Display at
all, and a "station screen" was a second browser tab on that laptop. A bar with its own tablet — the
whole point of a station — could not work.

## WHAT

A station tablet is its own page, `/station/hot`, `/station/cold` or `/station/bar`, rather than a
patch to the 2,000-line Kitchen Display. That display does billing, table-clearing and a station
switcher; a station should have one button.

### The screen (`src/station/`)

- **Only that station's tickets, and on each only its lines.** A ticket leaves a station's board when
  that station reports its part, and stays on the others'.
- **A big Ready button** → `POST /orders/:id/stations/:station/ready`, one request however hard it is
  tapped.
- **Oldest first**, with how long it has waited, going amber at 10 minutes and red at 15. A course fired
  later starts **its own clock**, not the ticket's.
- **Held courses stay off the board** until fired, and a finished course is not shown beside the next.
  Notes, size, chosen options and the course are printed on the card.
- **A chime for new work** — a new order, or a held course just fired — and not for the backlog the
  screen opens with, nor for another station's tickets. Browsers only allow audio after a tap, so it is
  an on/off button, remembered on the tablet.
- **Says so when it loses the hub**, keeps the last board up marked out of date, reconnects, and reads
  everything again.
- **Connects by scanning a code once.** The code is the same enrollment code the waiters use, in the
  page address; the page enrols the tablet and strips the code from the address bar. Without a camera,
  it asks for the code instead. A revoked device is sent back to enrol rather than failing on every tap.

### The hub

- It learns which station a screen is when the screen opens its live connection
  (`/live?station=bar`), and keeps a count of screens up per station (`lib/stationScreens.js`). An
  unknown station is ignored, a label is tidied and cut to 30 characters.
- `GET /kds/screens` (reception only): per station, screens up and what is **waiting** — tickets and
  items, counting only lines that are fired and not yet reported ready.
- `GET /qr/station/:station` (reception only): the QR a tablet scans, and the fallback URL and code.
- `GET /station/:station`: the static page. Public like `/waiter`; everything it shows comes through the
  authenticated routes.
- **A heartbeat.** Presence is per open connection, and a tablet that drops off the wifi or goes to sleep
  often does not close it, so it would have counted as "1 screen up" over an unwatched bar until the OS
  gave up. Every connection is now pinged every 30 s and one that missed the last ping is terminated.
  Browsers answer pings by themselves, so no client changed.

### Reception's panel (admin Kitchen tab)

Three cards — hot, cold, bar — each with screens up, what is waiting, **Add a tablet** (the QR, the
URL and the code, for a tablet with no camera) and **Open here**. It sits above the performance report
and shows even when that report fails to load.

**One deliberate restraint.** The hub cannot see whether the reception Kitchen Display is being watched,
and for a restaurant that never uses station screens it shows every station's tickets. If "no screen,
tickets waiting" appeared for them all day it would train reception to ignore the panel. So the
unwatched warning is only raised **once at least one station screen is connected**: from then on a
station without one is the odd one out. Before that the cards say "shown on the Kitchen Display".

### Found while building it — two bugs in my own first draft, both caught by tests

1. **A re-read could undo a live message.** When the live feed (re)connects, the screen reads the whole
   ticket list again. That answer can predate a message that arrived while it was in flight — the hub
   answered, then took an order, and the message beat the answer to the tablet — so a plain replace
   would silently lose a new order until the next refresh. `mergeFetched` keeps whichever copy of a
   ticket the hub touched last (`updated_at`), and keeps a ticket a message brought in during the read.
   Four tests failed against the plain replace; the dedicated race test is one of them.
2. **A refusal reason vanished.** After the hub refused a Ready, the screen re-read the tickets, and the
   successful re-read cleared the message line — so the cook never saw *why*. It now reads first, then
   says why.

A third was caught in review rather than by a test: I had put a chime and further state updates inside a
React state updater, which React may run twice or later than expected. Replaced with a ref holding the
latest list and an effect that works out new work once per change.

### Files

| File | Change |
|---|---|
| `hub_server/lib/stationScreens.js` | New — what a screen may declare, the registry, the backlog |
| `hub_server/server.js` | Registry on connect/close; `/kds/screens`, `/qr/station/:s`, `/station/:s`; the heartbeat |
| `hub_server/lib/crashReporter.js` | `station` accepted as a crash source (it would have been filed as `hub`) |
| `station.html`, `src/station_main.jsx`, `vite.config.js` | The page and its build entry |
| `src/station/StationScreen.jsx`, `lib/board.js`, `lib/chime.js` | The screen, its pure logic, the chime |
| `src/admin/StationScreensPanel.jsx`, `lib/stations.js`, `KitchenTab.jsx` | Reception's panel |

## TEST CASES (104 new)

| File | N | Covers |
|---|---|---|
| `hub_server/test/stationScreens.test.mjs` | 23 | What a screen may declare; the registry; what counts as waiting (held courses, finished stations, quantities); presence against a real hub; **a screen that stops answering is dropped**; reception-only routes; the QR encodes exactly the page plus the enrollment code; the page, and its absence before a build; **a tablet that is not the reception laptop can load tickets and mark ready with a token, and is refused without one** |
| `src/test/station/board.test.js` | 35 | Station from the address; what is pending; the board and its order; waiting time and its thresholds; every live event; the merge that fixes the race; what counts as new work |
| `src/test/station/StationScreen.test.jsx` | 31 | What is shown per station; the live feed declares its station and carries the token; new work, fired courses, ready elsewhere; **a message during a re-read is not undone**; reconnect; Ready once; refusals and an unreachable hub; sound only for new work on this station; enrolling by typing and by scanning; a revoked device |
| `src/test/admin/StationScreensPanel.test.jsx` | 16 | The wording and the "don't cry wolf" rule; the panel, the QR dialog, errors; the panel shows while the report fails |

Tickets in the frontend tests are built with **the hub's own `courses.js`** (`initCourseState`,
`markStationReady`, `fireCourse`), so a change there breaks these tests rather than leaving the screen
quietly reading a shape the hub no longer sends.

**Shown to be able to fail** (each caught, then restored): removing the cleanup when a screen
disconnects (2 tests fail — a dead tablet kept counting); replacing the merge with a plain overwrite (4
fail, including the race test); removing the heartbeat's terminate (the dead-connection test fails).

Driven in a browser against **two scratch hubs on copies of the pilot's menu** (own ports and data
directories; the pilot's was never touched). On the first, reception's panel read "no screen … shown on
the Kitchen Display"; opening `/station/bar` showed only drinks, the allergy note highlighted, T2's drink
tagged "Course 1" with its main and dessert held; marking a ticket ready dropped the bar's backlog 3 → 2
at the hub; a new order appeared on the open screen with a "new" ring; and the panel changed to "Hot line
and Cold line have work waiting and no screen connected" with the Bar at "1 screen up".

On the second, started with `HUB_TRUST_LOOPBACK=false` so that **the browser behaves like a real
tablet**: an unauthenticated request was a 401; the page asked for the code once; a lower-case code was
accepted; the hot line board loaded with its urgency colours. Then, with the token cleared and a genuinely
fresh page load, opening the QR's address enrolled automatically, removed the code from the address bar
and showed the board. (My first attempt at that last check was **invalid**: navigating to the same page
with only a new `#fragment` does not reload it, so the page still held its token in memory. I caught it
and redid it with a real reload.)

```bash
npm run test:hub   # 741 (718 + 23)
npm run test:web   # 198 (116 + 82)
npm run build      # clean; station.html and a 14 kB bundle
```

## NOT DONE / LIMITS

- **A station tablet is not role-scoped.** It carries the same device token as a waiter's handset, which
  can do anything an enrolled device can — including billing and voids. A tablet on a kitchen pass is the
  kind of device most likely to be handled by many people or lost. This is the existing device-token
  model, not something new, but this feature makes the exposure more concrete; added to §4.7.
- **The reception Kitchen Display is unchanged.** It still sends no token, so it still only works on the
  reception laptop, still has its own station filter, and does not show which screens are up.
- **No server-side filtering.** Every screen receives every ticket and filters itself; a bar tablet can
  read the hot line's tickets over the API. Cooperative, not a security boundary — a screen says which
  station it is and the hub believes it. It could also mark another station's part ready.
- **Presence is as good as the heartbeat**: up to ~60 s (two missed 30 s rounds) before a vanished tablet
  stops being counted.
- **No Playwright run in a real browser in CI.** The browser checks above were by hand.
- The chime is two sine notes; there is no volume control, and a tablet that blocks audio simply shows
  the ticket.
- **The first station-screen load depends on the hub address.** `hubBase()` is the page's own origin, as
  it is for the admin page; a station page opened through Vite's dev server needs
  `localStorage.mejwani_hub_url`.

## STATUS

✅ VERIFIED — 741 hub + 198 frontend, build clean; driven in a browser on scratch hubs including one that
trusts no one.
